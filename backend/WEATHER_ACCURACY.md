# Live-weather vs default-parameter trajectory accuracy

Findings from the A/B comparison of trajectory simulation accuracy at home
plate, and the decision to drop the Open-Meteo weather API call from the live
path.

## Question

The backend can simulate a pitch with two environment sources:

- **live** — venue weather assembled from the MLB Stats API feed **plus** an
  Open-Meteo archive API call (observed surface pressure + relative humidity)
- **default** — the neutral `DEFAULT_ENV` baseline (70 °F, 15 ft elevation,
  50 % RH, 760 mmHg)

How much closer to the Statcast (Hawk-Eye) pX/pZ position at home plate does
the live path land, and is the extra Open-Meteo API call worth it?

## Method

`backend/test_weather_accuracy_multi.py` runs the A/B across 30 completed 2025
games (one per venue, spanning elevation 0–5190 ft, game temps 54–86 °F, and
open / retractable / roof-closed). For each pitch with Statcast pX/pZ the RK4
trajectory is simulated twice (live env + default env, each recovering spin
from pfx at its own air density) and the error is the Euclidean distance
between the simulated front-of-plate crossing and Statcast pX/pZ, in inches.

```
cd backend
../venv/bin/python test_weather_accuracy.py --game 777616 --limit 200      # one game
../venv/bin/python test_weather_accuracy_multi.py --limit 200              # 30-game sweep
../venv/bin/python quantify_env_impact.py --game 777616 --limit 200        # obs vs est vs neutral
```

## Results — live vs default (6,000 pitches)

| Metric | Live | Default |
|---|---|---|
| Mean plate error vs Statcast | **0.983 in** | 1.000 in |
| Games won / lost / tied | 17 / 6 / 7 | |

- Live is more accurate by **+0.018 in mean** overall — real but tiny (~0.5 mm).
- Gains concentrate where conditions diverge from the 70 °F / 760 mmHg baseline:
  **Coors +0.156 in**, Dodger +0.070, PNC +0.064, Truist +0.062, Target +0.057.
- Losses are small: Oracle −0.021, Citi −0.007, T-Mobile −0.006,
  Comerica −0.005, American Family −0.005, Yankee −0.001.
- 5 of the 7 "ties" are roof-closed games, where the live engine deliberately
  maps to neutral conditions — an exact tie with default by design.

## Where the gain comes from

The live path has three inputs: **MLB-feed temperature**, **venue elevation**
(via station pressure), and **Open-Meteo observed P/RH**. The first two are
free (already in the MLB feed); Open-Meteo is the only extra API call.

Isolating the marginal value of the Open-Meteo call — comparing accuracy of
the no-API elevation-derived estimate (`observed=False`) vs the observed path
(`observed=True`) directly against Statcast pX/pZ:

| Venue | live (observed) | est (no API) | default | est−live | default−live |
|---|---|---|---|---|---|
| Coors (n=60) | 0.724 | 0.720 | 0.904 | −0.004 | +0.180 |
| Dodger (n=80) | 1.452 | 1.452 | 1.526 | ±0.000 | +0.074 |
| Busch (n=80) | 1.073 | 1.075 | 1.099 | +0.002 | +0.026 |
| Oracle (n=80) | 0.853 | 0.856 | 0.829 | +0.002 | −0.025 |

The Open-Meteo call changes plate error by **≤ 0.004 in — noise**. The
elevation estimate alone captures essentially all of the live-vs-default gain
(+0.180 of the +0.184 at Coors). Consistent with `quantify_env_impact.py`:
at Coors, observed-vs-estimated moves the plate crossing by only 0.075 in mean
(max 0.168), vs a 1.629 in mean absolute weather effect vs the neutral
baseline. RH and a few mmHg of pressure barely move air density, and wind is
zeroed in both paths.

## Cost of the API call

- Open-Meteo archive API: **free, no key**, one HTTP GET per request
  (~100–300 ms; 10 s timeout worst case when unreachable).
- Un-cached in `backend/main.py` — re-fetched on every
  `/api/trajectory?env=live` and `/api/trajectory/compare` request.
- Fails gracefully back to the same elevation-derived values, so the only real
  cost is latency.

## Decision

The extra Open-Meteo API calls are **not worth it for trajectory accuracy**:
they buy ≤ 0.01 in at the plate. The entire live-vs-default accuracy gain comes
from venue elevation + game temperature, both free from the MLB feed.

Implemented in `backend/main.py`:

- `/api/trajectory?env=live` and `/api/trajectory/compare` now call
  `fetch_environment_params(..., observed=False)` — elevation-derived station
  pressure + sky-condition humidity + MLB-feed temp, **no Open-Meteo call**.
- The A/B sweep (`test_weather_accuracy.py`) tests the shipped path
  (`observed=False`), and its output labels the arm "live (elevation-derived)".
- Diagnostics that intentionally compare the two paths
  (`quantify_env_impact.py`, `diag_*`, `fit_*`) still pass `observed=True`
  explicitly; `fetch_environment_params` keeps both code paths.

## Parity confirmation (30 games × 200 pitches, same seed)

| Metric | Observed arm (old) | Elevation arm (new) |
|---|---|---|
| Mean plate error, avg of 30 game means | 0.9826 in | 0.9820 in |
| Default arm (unchanged) | 1.0004 in | 1.0004 in |
| Games beating default | 16/30 | 15/30 (7 ties) |

- Per-game live-arm means differ by **≤ 0.009 in**; mean Δ over 30 games is
  **−0.0006 in** — pure noise.
- Roof-closed games remain exact ties; the wins-vs-default pattern is
  unchanged.
- Offline regression tests (`python -m unittest test_weather_regressions -v`)
  pass: roof-closed games map to neutral (no network), and both A/B arms
  recover spin at their own integration density.

## Per-game detail

Mean plate error in inches; `live(obs)` = Open-Meteo arm, `live(est)` = shipped
elevation-derived arm, `Δ(est−obs)` = difference between the two live arms
(parity check).

| Venue | live (obs) | live (est) | Δ(est−obs) | default | live win% (obs → est) |
|---|---|---|---|---|---|
| Coors | 0.604 | 0.600 | −0.004 | 0.760 | 71.5 → 71.5 |
| Chase (roof closed) | 0.998 | 0.998 | ±0.000 | 0.998 | 0 → 0 |
| Truist | 1.475 | 1.472 | −0.003 | 1.537 | 61.5 → 62.0 |
| Kauffman | 0.982 | 0.980 | −0.002 | 1.028 | 65.5 → 65.5 |
| Target | 0.980 | 0.978 | −0.002 | 1.037 | 60.0 → 60.0 |
| PNC | 0.799 | 0.790 | −0.009 | 0.863 | 84.5 → 84.5 |
| Progressive | 0.886 | 0.887 | +0.001 | 0.887 | 69.5 → 30.5 |
| Comerica | 1.079 | 1.079 | ±0.000 | 1.074 | 30.5 → 30.5 |
| American Family | 0.818 | 0.817 | −0.001 | 0.813 | 40.0 → 39.5 |
| Rate | 0.693 | 0.690 | −0.003 | 0.725 | 64.5 → 64.5 |
| Wrigley | 0.970 | 0.970 | ±0.000 | 0.970 | 50.0 → 50.0 |
| Globe Life (roof closed) | 0.784 | 0.784 | ±0.000 | 0.784 | 0 → 0 |
| Great American | 0.976 | 0.970 | −0.006 | 1.011 | 63.5 → 63.5 |
| Dodger | 1.108 | 1.108 | ±0.000 | 1.177 | 74.0 → 74.0 |
| Busch | 0.842 | 0.845 | +0.003 | 0.875 | 60.5 → 60.5 |
| Rogers (roof closed) | 0.925 | 0.925 | ±0.000 | 0.925 | 0 → 0 |
| Angel | 0.944 | 0.945 | +0.001 | 0.948 | 61.0 → 61.0 |
| Yankee | 1.109 | 1.100 | −0.009 | 1.107 | 47.0 → 53.0 |
| Daikin (roof closed) | 1.321 | 1.321 | ±0.000 | 1.321 | 0 → 0 |
| Nationals | 0.781 | 0.780 | −0.001 | 0.784 | 57.5 → 57.5 |
| Steinbrenner | 0.827 | 0.827 | ±0.000 | 0.831 | 52.0 → 52.0 |
| Camden | 1.275 | 1.280 | +0.005 | 1.279 | 73.5 → 26.5 |
| Sutter | 0.951 | 0.954 | +0.003 | 0.961 | 52.5 → 52.5 |
| Petco | 1.048 | 1.048 | ±0.000 | 1.049 | 53.0 → 53.0 |
| Fenway | 0.972 | 0.971 | −0.001 | 0.972 | 48.0 → 52.0 |
| Citizens Bank | 1.164 | 1.168 | +0.004 | 1.164 | 63.5 → 36.5 |
| Citi | 0.943 | 0.950 | +0.007 | 0.936 | 36.0 → 36.0 |
| T-Mobile | 1.036 | 1.033 | −0.003 | 1.029 | 44.5 → 43.0 |
| loanDepot (roof closed) | 1.165 | 1.165 | ±0.000 | 1.165 | 0 → 0 |
| Oracle | 1.022 | 1.024 | +0.002 | 1.001 | 26.0 → 25.5 |

Notes:
- `Δ(est−obs)` is ≤ 0.009 in everywhere — the two live arms are equivalent.
- Win% flips at Progressive / Camden / Citizens Bank (despite nearly identical
  means) are knife-edge cases where live ≈ default to 0.005 in; the per-pitch
  win count is hypersensitive there and carries no signal.
