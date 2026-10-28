# Train delay model results

Task: a train has just left a stop. Predict the range (10th-90th percentile) of its
arrival delay at each later stop, up to 12 stops ahead. Ranges are calibrated with
conformal prediction to contain the real delay 80% of the time.

- **Train-days of data:** 56
- **Date range:** 2026-09-02 to 2026-10-27
- **Trains (train-days):** 41,847
- **Stop records:** 523,399
- **Examples (train / calibration / test):** 2,000,000 / 426,938 / 735,463

Scores on the held-out test period (most recent days, never seen in training).
MAE = average error of the middle prediction, in minutes. Coverage should be ~80%.
Narrower ranges at the same coverage are better.

| Model | MAE (min) | Pinball loss | Coverage (raw) | Coverage (calibrated) | Range width (min) | Fit time (s) |
|---|---|---|---|---|---|---|
| timetable | 4.02 | 1.479 | 2.0% | 71.6% | 9.40 | 0 |
| persistence | 1.85 | 0.654 | 2.0% | 78.6% | 4.80 | 0 |
| historical | 1.48 | 0.514 | 74.6% | 78.4% | 3.76 | 0 |
| gradient_boosting | 1.35 | 0.467 | 75.9% | 78.2% | 3.44 | 58 |
| pytorch_quantile_net | 1.35 | 0.461 | 77.9% | 77.9% | 3.38 | 70 |

## Best model (pytorch_quantile_net) by service type

Code letter: A/P/D = InterCity and Commuter, E = DART (full list in the README).

| service_type   |   examples |   mae_min |   pinball |   coverage |   width_min |
|:---------------|-----------:|----------:|----------:|-----------:|------------:|
| E              |     496124 |      1.05 |      0.36 |       0.78 |        2.63 |
| P              |      96751 |      1.38 |      0.46 |       0.78 |        3.69 |
| D              |      93504 |      1.28 |      0.43 |       0.79 |        3.42 |
| A              |      49024 |      4.45 |      1.52 |       0.70 |       10.21 |
| B              |         60 |     10.25 |      3.06 |       0.57 |       23.35 |

## Best model (pytorch_quantile_net) by stops ahead

|   ahead |   examples |   mae_min |   pinball |   coverage |   width_min |
|--------:|-----------:|----------:|----------:|-----------:|------------:|
|    1.00 |   95372.00 |      0.57 |      0.20 |       0.83 |        1.56 |
|    2.00 |   88020.00 |      0.82 |      0.28 |       0.79 |        2.20 |
|    3.00 |   81212.00 |      1.06 |      0.36 |       0.78 |        2.79 |
|    4.00 |   74469.00 |      1.26 |      0.43 |       0.78 |        3.27 |
|    5.00 |   68572.00 |      1.45 |      0.49 |       0.77 |        3.67 |
|    6.00 |   62342.00 |      1.57 |      0.53 |       0.77 |        3.95 |
|    7.00 |   56894.00 |      1.69 |      0.57 |       0.77 |        4.17 |
|    8.00 |   51339.00 |      1.76 |      0.60 |       0.76 |        4.28 |
|    9.00 |   46278.00 |      1.86 |      0.64 |       0.76 |        4.46 |
|   10.00 |   41259.00 |      1.90 |      0.65 |       0.76 |        4.49 |
|   11.00 |   36978.00 |      1.99 |      0.68 |       0.75 |        4.64 |
|   12.00 |   32728.00 |      2.01 |      0.69 |       0.75 |        4.65 |
