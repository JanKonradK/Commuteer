# Bus delay model results

Task: predict a bus's delay at a stop it hasn't reached yet, 5-60 minutes ahead.
Actual delays come from GPS positions (when the bus really passed the stop), not
from TFI's estimates. All models' ranges are calibrated to cover ~80%.

Data: by trip (1 day(s) only: optimistic until a week of history exists); 103,136 / 32,896 / 33,825 examples (train / calibration / test), 2,330 trips, 320 routes.

| Model | Error of middle estimate (min) | Pinball loss | Coverage | Range width (min) |
|---|---|---|---|---|
| tfi_live_estimate | 2.46 | 0.872 | 79.7% | 7.07 |
| timetable | 3.79 | 1.368 | 79.5% | 11.07 |
| gps_delay_carried_forward | 2.82 | 1.029 | 80.7% | 8.28 |
| gradient_boosting | 1.87 | 0.630 | 79.9% | 5.30 |
| pytorch_quantile_net | 2.16 | 0.711 | 80.6% | 6.50 |

## Error (min) by how far ahead, and on route 466

| model                     |   5 min |   10 min |   20 min |   30 min |   45 min |   60 min |   route 466 |
|:--------------------------|--------:|---------:|---------:|---------:|---------:|---------:|------------:|
| tfi_live_estimate         |    1.53 |     2.15 |     2.93 |     3.56 |     3.81 |     3.77 |        2.90 |
| timetable                 |    3.56 |     3.69 |     3.88 |     4.09 |     4.09 |     4.25 |        2.47 |
| gps_delay_carried_forward |    1.72 |     2.46 |     3.47 |     3.99 |     4.43 |     4.43 |        3.44 |
| gradient_boosting         |    1.06 |     1.61 |     2.21 |     2.81 |     3.13 |     3.19 |        2.55 |
| pytorch_quantile_net      |    1.10 |     1.86 |     2.68 |     3.30 |     3.55 |     4.00 |        2.65 |
