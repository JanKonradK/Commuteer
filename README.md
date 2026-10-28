# Commuteer

Public transport planning that works from how reliable each train *actually* is, not just the timetable. It's built for commuters in Ireland, starting with the Midlands.

Instead of "arrives 09:58", Commuteer says **"arrives around 10:05; 80% likely between 09:57 and 10:17"**. That range comes from a model trained on 8 weeks of real Irish Rail journeys, and it runs on the phone.

Three parts:

| Part | What it does | Stack |
|---|---|---|
| [Data collector](#1-data-collector-aws) | Records live train and bus feeds 24/7 to build a delay history | Python, AWS Lambda, EventBridge Scheduler, S3, Terraform |
| [Delay models](#2-delay-models) | Predict a train's arrival-delay range from where it is now | PyTorch, scikit-learn, MLflow, conformal prediction |
| [Android app](#3-android-app) | Trains with predicted arrival ranges, live buses, your own shuttle timetables, and two-leg commutes | TypeScript, React, Capacitor; model runs on-device |

## 1. Data collector (AWS)

No public source keeps a record of how late Irish trains and buses actually run, so Commuteer builds that history itself.

| Feed | Source | How often | What it gives |
|---|---|---|---|
| Train positions | Irish Rail realtime API (no key) | every 30 s | every running train, where it is, how late |
| Train movements | Irish Rail realtime API | nightly | scheduled **and actual** times at every stop: exact delay data |
| Bus trip updates | Transport for Ireland GTFS-Realtime (free key) | every 60 s | predicted delays for Bus Éireann and other operators |
| Vehicle positions | Transport for Ireland GTFS-Realtime | every 60 s | where every bus is |
| Timetable | Transport for Ireland GTFS (national) | daily, kept when it changes | the schedule each delay is measured against |

```
EventBridge Scheduler (Europe/Dublin)
  ├─ every minute ─► Lambda: poller ──────────┐
  ├─ 02:30 nightly ─► Lambda: rail_movements ─┼─► S3  bronze/<source>/date=YYYY-MM-DD/...
  └─ 05:00 daily ──► Lambda: gtfs_snapshot ───┘       (raw, gzipped, partitioned by date)

SSM Parameter Store ─► API key (never in code, git or Terraform state)
CloudWatch ─► alarms (collector silent, feed failing, nightly job failed) ─► SNS email
AWS Budgets ─► email at 80% of the monthly budget
```

- **Standard library only:** the Lambda code has no dependencies, so the package is a few KB.
- **ARM (Graviton) Lambdas:** about 20% cheaper than x86.
- **Raw responses kept as-is:** parsing can be improved later and re-run over the full history.
- **Cost:** about $1–3 a month.
- **Deployed with Terraform:** 28 resources in eu-north-1.

**Backfill.** Irish Rail also serves past days' stop-by-stop times, so `commuteer-collect backfill` builds a history immediately instead of waiting months. It uses train codes from the national timetable. 8 weeks covered **41,206 train runs** with no failed requests.

## 2. Delay models

**Task:** a train has just left a stop. Predict the range of its arrival delay (10th, 50th and 90th percentile) at each of the next 12 stops.

**Data:** 56 days (2 Sep – 27 Oct 2026), 41,847 train runs and 523,399 stop records. That gives 2.0M training examples, 0.43M for calibration and 0.74M for testing. **The split is by date:** models train on older weeks and are tested on the most recent 14 days, so the test data comes strictly after the training data, as it would in real use.

**Features:** current delay and whether it's growing or shrinking, scheduled minutes remaining, stops in between, time of day (cyclical), weekday, the two stations, the route and the service type.

**Models**, each tracked in MLflow:

| Model | What it is | Average error (min) | Pinball loss | 80% range covers | Range width (min) |
|---|---|---|---|---|---|
| Timetable | assumes no delay | 4.02 | 1.479 | 71.6% | 9.40 |
| Persistence | current delay stays the same | 1.85 | 0.654 | 78.6% | 4.80 |
| Historical | past delay changes for the same route and stops | 1.48 | 0.514 | 78.4% | 3.76 |
| Gradient boosting | scikit-learn, one model per percentile | 1.35 | 0.467 | 78.2% | 3.44 |
| **PyTorch network** | embeddings + MLP, quantile loss | **1.35** | **0.461** | 77.9% | **3.38** |

**The PyTorch network:**
- **Inputs:** learned embeddings for stations, routes, service types and weekdays, joined with the scaled numeric features.
- **Body:** a 3-layer GELU MLP, trained with pinball loss on the *change* in delay.
- **Output:** the median plus two positive gaps (via softplus), so the 10th ≤ 50th ≤ 90th percentile always holds.

**Calibration.** Conformalized quantile regression (Romano et al., 2019) adjusts each model's range on a held-out week so that it targets 80% coverage.

**Limits, stated plainly:**
- **Mostly DART data.** DART is two-thirds of the test set, and the model does best there (1.05 min error). For **InterCity trains (code A) the error is 4.45 min, and ranges cover 70%, not 80%**: longer journeys, more variable delays and fewer examples. Calibrating separately per service type ("Mondrian" conformal) is the next step.
- **Coverage slightly under target (77.9%).** Conformal guarantees assume the test weeks behave like the calibration week, and delays drift over time. Recalibrating weekly on the live collector's data would fix this.
- **Accuracy drops with distance.** Error grows from 0.57 min one stop ahead to 2.01 min twelve stops ahead.

Full breakdown: [`reports/delay_model_results.md`](reports/delay_model_results.md).

## 3. Android app

Pick your commute (for example Athlone → Dublin Heuston). Each train shows **departure → predicted arrival**, with timetable times struck through when they've changed, and a bar that draws the arrival window:

- **band:** where the train is 80% likely to arrive;
- **dot:** the best guess;
- **white tick:** the timetable;
- **colour:** green = very likely within 5 min of the timetable, amber = uncertain, red = probably late.

- **No server:** the app calls Irish Rail directly through Android's native networking (Capacitor HTTP).
- **On-device model:** the trained PyTorch network is exported to JSON (450 KB) and its forward pass is reimplemented in TypeScript. A test checks it reproduces PyTorch's outputs on 25 held-out cases.
- **Reliable:** requests time out and retry; the last results stay on screen with a warning when there's no signal; the station list is cached; it refreshes every minute while open.
- **Tested:** 12 tests (Vitest) cover parsing, the midnight crossover, the model's match with PyTorch, and journey logic. It has also been run on an Android emulator, both online and offline.

### Buses, shuttles and commutes

- **🚌 Buses.** `commuteer-buses pack` cuts the 200 MB national timetable down to the Midlands: stops within 40 km of Athlone, 58 routes, 5,027 trips, with each trip's running days resolved over 120 days. That's 1.4 MB (129 KB gzipped), bundled in the app so it works offline.
- **Live bus delays.** A Lambda function URL (`bus_live`) returns delays for the trips a phone asks about. It reads the snapshot the collector already saved, so phones never see the Transport for Ireland key and TFI gets no extra traffic. It decodes the GTFS-Realtime protobuf with a small standard-library decoder, which is tested against Google's official bindings on 3,565 real trips. Responses take about 160 ms.
- **🚐 Your own timetables.** Paste times as plain text (`07:45 Inny Kayak Club`, with `*` for drop-off only); they're stored on the phone. Private timetables, like an employer's staff shuttle, go in `app/src/local/*.shuttles.json`. That folder is git-ignored and built into your own APK only.
- **⭐ Commutes.** Two legs with a walk between them (e.g. bus 466 Athlone → Ballymahon, walk, shuttle → work). Each option shows **Leave / Arrive** with a countdown, plain-language chips ("2 min to spare", "On time", "Timetable only"), and a step-by-step timeline: time, place, and what you do next. The next trip opens by default; later ones expand on tap. Live bus delays feed the connection. When several first legs reach the same second leg, only the latest is shown (least waiting), and shuttle runs end at shift changes. ⇄ reverses it for the trip home.
- **Bus delay model (in progress).** See below.

## 4. Bus delay model

TFI's live bus estimates are decent near the start of a route but drift further out, and on some routes (e.g. 466) a plain timetable beats them. A bus model needs **actual** times, which no feed publishes, so Commuteer reconstructs them:

- **Actual stop times from GPS** (`commuteer.buses.history`). Every Bus Éireann vehicle reports its position each minute. For each trip, each stop is projected onto the path between consecutive GPS fixes, in route order, and the passage time is interpolated at the closest approach. Stops the bus never came within 300 m of stay unknown. One morning (85 minutes) gave **59,656 actual stop times across 2,797 trips**. The vehicle decoder is tested against Google's bindings, and stop matching on synthetic and out-and-back routes.
- **Scoring TFI** (1.57 M live predictions, same morning). Average error is 1.4 min ten minutes ahead, rising to 4.1 min 40–90 minutes ahead, which is barely better than the timetable (4.1). On route 466 the timetable (1.57 min) beat TFI (2.10).
- **Model.** The train model's classes (PyTorch quantile network, gradient boosting, conformal calibration, MLflow), now configurable by feature set, predict the **correction to TFI's estimate**. Inputs: TFI's estimate, the GPS-measured delay and its trend, timetabled minutes to the stop, time since the last stop, stops ahead, time of day, weekday, route and stop. A test guards against a leak caught during development: "minutes until arrival" uses the actual arrival, so only the *timetabled* minutes are allowed as an input.
- **First result (one morning, split by trip, so optimistic):** TFI 2.46 min average error → gradient boosting **1.87 min (−24%)**, PyTorch network 2.16 min, with ranges calibrated to ~80% coverage and narrower than TFI's (5.3 vs 7.1 min). On route 466 alone the sample is too small to call: timetable 2.47, gradient boosting 2.55, TFI 2.90. Full table: [`reports/bus_model_results.md`](reports/bus_model_results.md).
- **What's next.** A nightly Lambda (`bus_history`, 04:00) adds each day's actual stop times and scored predictions to S3 (`silver/`). After about a week, the split switches to *by date* (train on the past, test on the newest days). The model goes into the app only if it still beats TFI there.

## Development

Requires [uv](https://docs.astral.sh/uv/) and Node.js.

```sh
# Collector + models (Python)
uv sync --extra ml
uv run pytest                                    # 44 tests (AWS mocked with moto)
uv run ruff check . && uv run mypy src tests     # lint + strict types

uv run commuteer-collect poll --loop             # collect live feeds into ./data
uv run commuteer-collect backfill --days 56 --gtfs data/gtfs/GTFS_All.zip
uv run commuteer-train                           # train, compare, log to MLflow, export app model
uv run commuteer-buses pack --gtfs data/gtfs/GTFS_All.zip   # Midlands bus timetable for the app
uv run commuteer-buses history --date 2026-10-28 --gtfs data/gtfs/GTFS_All.zip   # actual bus times
uv run commuteer-buses train                     # bus models vs TFI's live estimate
uv run mlflow ui --backend-store-uri sqlite:///mlflow.db

# Android app
cd app
npm install
npm test                                         # 22 tests
npm run dev                                      # browser preview at localhost:5173
npm run build:android                            # signed APK + SHA256SUMS.txt (needs JDK 21, Android SDK)
```

## Releases and in-app updates

The app updates itself from GitHub Releases, the same way as [Memoria](https://github.com/JanKonradK/Memoria):

1. Bump `version` in `app/package.json` and write notes in `docs/releases/v<version>.md`.
2. Push a tag `v<version>`. The **Release** workflow tests the app, refuses a tag that doesn't match `package.json`, builds the APK signed with the key from the `ANDROID_KEYSTORE_BASE64` secret, and publishes it with `SHA256SUMS.txt`.
3. Installed apps check GitHub on launch and twice a day and show a banner. **Install** downloads the APK, verifies its SHA-256 against the release, and opens Android's installer (`AppUpdaterPlugin.java`).

Android only accepts an update signed with the same key as the installed app, and with a higher version code (from `package.json`: 0.2.0 → 200). Saved trips and timetables live in the app's storage and are kept across updates. Personal presets from `app/src/local/` are saved to that storage on first launch, so updates built on GitHub, which don't include them, keep them.

## Deploy the collector (AWS, eu-north-1)

Requires Terraform ≥ 1.10 and the AWS CLI, signed in.

```sh
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars    # set alert_email
terraform init && terraform apply

# Add the Transport for Ireland key (https://developer.nationaltransport.ie):
aws ssm put-parameter --name /commuteer/nta_api_key --type SecureString --overwrite --value <key>
```

## Roadmap

- **Per-service-type calibration**, so InterCity ranges hit 80% coverage.
- **Weekly retraining** from the live collector's data, with drift checks.
- **Transfers:** the chance of making a connection, and "get off early and switch" suggestions.
- **Bus delay model** once the collector has a few weeks of bus history; then "chance you make the shuttle" instead of minutes to spare.
- **Nightly timetable refresh** for the bus pack, built by the existing `gtfs_snapshot` Lambda.
