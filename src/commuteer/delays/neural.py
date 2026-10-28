"""PyTorch delay-range model.

Architecture:
- each categorical feature (stations, route, service type, weekday) gets a
  learned embedding, so similar stations end up with similar vectors;
- embeddings + scaled numeric features go through an MLP;
- the head outputs the median plus two positive gaps (softplus), so the
  10th percentile <= median <= 90th percentile by construction;
- trained with pinball (quantile) loss on the change in delay.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import torch
from torch import nn

from commuteer.delays.dataset import FEATURES_CATEGORICAL, FEATURES_NUMERIC
from commuteer.delays.metrics import QUANTILES

UNKNOWN = 0  # index reserved for categories not seen in training


@dataclass
class NeuralConfig:
    embed_dim: int = 8
    hidden: int = 128
    layers: int = 3
    dropout: float = 0.1
    lr: float = 2e-3
    weight_decay: float = 1e-5
    batch_size: int = 4096
    epochs: int = 8
    seed: int = 0


class QuantileNet(nn.Module):
    def __init__(self, cardinalities: list[int], n_numeric: int, cfg: NeuralConfig) -> None:
        super().__init__()
        self.embeddings = nn.ModuleList(nn.Embedding(n + 1, cfg.embed_dim) for n in cardinalities)
        width = cfg.embed_dim * len(cardinalities) + n_numeric
        blocks: list[nn.Module] = []
        for _ in range(cfg.layers):
            blocks += [nn.Linear(width, cfg.hidden), nn.GELU(), nn.Dropout(cfg.dropout)]
            width = cfg.hidden
        self.body = nn.Sequential(*blocks)
        self.head = nn.Linear(width, 3)

    def forward(self, cats: torch.Tensor, nums: torch.Tensor) -> torch.Tensor:
        emb = [e(cats[:, i]) for i, e in enumerate(self.embeddings)]
        h = self.body(torch.cat([*emb, nums], dim=1))
        mid, gap_lo, gap_hi = self.head(h).unbind(dim=1)
        f = nn.functional.softplus
        return torch.stack([mid - f(gap_lo), mid, mid + f(gap_hi)], dim=1)


def pinball(pred: torch.Tensor, y: torch.Tensor) -> torch.Tensor:
    q = torch.tensor(QUANTILES, dtype=pred.dtype, device=pred.device)
    err = y.unsqueeze(1) - pred
    return torch.maximum(q * err, (q - 1) * err).mean()


class NeuralQuantile:
    name = "pytorch_quantile_net"

    def __init__(
        self,
        cfg: NeuralConfig | None = None,
        numeric: list[str] = FEATURES_NUMERIC,
        categorical: list[str] = FEATURES_CATEGORICAL,
        target: str = "delay_change_min",
    ) -> None:
        self.cfg = cfg or NeuralConfig()
        self.numeric, self.categorical, self.target = numeric, categorical, target
        self.history: list[float] = []

    def _encode(self, df: pd.DataFrame) -> tuple[torch.Tensor, torch.Tensor]:
        cats = np.column_stack(
            [
                df[c].map(self.vocab[c]).fillna(UNKNOWN).to_numpy(dtype=np.int64)
                for c in self.categorical
            ]
        )
        nums = (df[self.numeric].to_numpy(dtype=np.float32) - self.mean) / self.std
        return torch.from_numpy(cats), torch.from_numpy(nums.astype(np.float32))

    def fit(self, train: pd.DataFrame) -> NeuralQuantile:
        torch.manual_seed(self.cfg.seed)
        self.vocab = {
            c: {v: i + 1 for i, v in enumerate(sorted(train[c].unique()))} for c in self.categorical
        }
        x_num = train[self.numeric].to_numpy(dtype=np.float32)
        self.mean, self.std = x_num.mean(axis=0), x_num.std(axis=0) + 1e-6
        cats, nums = self._encode(train)
        y = torch.from_numpy(train[self.target].to_numpy(dtype=np.float32))

        self.model = QuantileNet(
            [len(self.vocab[c]) for c in self.categorical], len(self.numeric), self.cfg
        )
        opt = torch.optim.AdamW(
            self.model.parameters(), lr=self.cfg.lr, weight_decay=self.cfg.weight_decay
        )
        steps = self.cfg.epochs * ((len(y) + self.cfg.batch_size - 1) // self.cfg.batch_size)
        sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=self.cfg.lr, total_steps=steps)
        gen = torch.Generator().manual_seed(self.cfg.seed)
        self.model.train()
        for _ in range(self.cfg.epochs):
            order = torch.randperm(len(y), generator=gen)
            total = 0.0
            for start in range(0, len(y), self.cfg.batch_size):
                idx = order[start : start + self.cfg.batch_size]
                loss = pinball(self.model(cats[idx], nums[idx]), y[idx])
                opt.zero_grad()
                loss.backward()  # type: ignore[no-untyped-call]
                opt.step()
                sched.step()
                total += loss.item() * len(idx)
            self.history.append(total / len(y))
        return self

    def export(self, conformal_margin_min: float) -> dict[str, object]:
        """Everything the phone app needs to run the network, as plain JSON.

        The app reimplements the forward pass in TypeScript, so predictions
        run on the device with no server.
        """

        def arr(t: torch.Tensor) -> object:
            return np.round(t.detach().numpy().astype(np.float64), 6).tolist()

        linears = [m for m in self.model.body if isinstance(m, nn.Linear)]
        return {
            "format": "commuteer-quantile-net/1",
            "quantiles": list(QUANTILES),
            "conformal_margin_min": round(conformal_margin_min, 4),
            "categorical": self.categorical,
            "numeric": self.numeric,
            "vocab": self.vocab,
            "numeric_mean": np.round(self.mean.astype(np.float64), 6).tolist(),
            "numeric_std": np.round(self.std.astype(np.float64), 6).tolist(),
            "embeddings": [
                arr(e.weight) for e in self.model.embeddings if isinstance(e, nn.Embedding)
            ],
            "layers": [{"weight": arr(m.weight), "bias": arr(m.bias)} for m in linears],
            "head": {"weight": arr(self.model.head.weight), "bias": arr(self.model.head.bias)},
        }

    @torch.no_grad()
    def predict_change(self, df: pd.DataFrame) -> np.ndarray:
        self.model.eval()
        cats, nums = self._encode(df)
        out = [
            self.model(cats[s : s + 65536], nums[s : s + 65536]) for s in range(0, len(df), 65536)
        ]
        return torch.cat(out).numpy().astype(np.float64)
