"""
Quantify how much weather/venue conditions move a pitch at the plate.

For every pitch in a game's live feed (capped by --limit), run the RK4 trajectory
simulation three times:

  * "observed"  — Open-Meteo surface pressure + relative humidity (live path)
  * "estimated" — elevation-derived station pressure + sky-condition humidity
                  (the pre-Open-Meteo fallback)
  * "neutral"   — DEFAULT_ENV baseline (70 °F, 15 ft elev, 50 % RH, 760 mmHg)

and compare the front-of-plate crossing position (x, z in inches) and speed.

Reported comparisons:
  * observed vs estimated    — how much the live Open-Meteo path changes the pitch
  * observed vs neutral      — the absolute weather effect vs a neutral baseline
  * observed sim vs Statcast — at-plate accuracy against Hawk-Eye pX/pZ

Usage:
    python quantify_env_impact.py [--game 822777] [--limit 200] [--min-pitches 30] [--min-per-type 30]
"""

import argparse
import math
import os
import statistics
import sys
from collections import defaultdict

import requests

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from main import (  # noqa: E402
    FullBallTrajectorySimulator,
    IntegrationMethod,
    GAME_PK,
    DEFAULT_ENV,
    DEFAULT_ENV_META,
    fetch_environment_params,
    _air_density_from_env,
    _pitch_parameters_from_event,
)

IN_PER_M = 39.3700787
FT_PER_M = 1 / 0.3048
IN_PER_FT = 12.0
MPH_PER_MPS = 2.23694


def crossing(sim: FullBallTrajectorySimulator):
    """Return the first available plate-crossing dict (front, then mid, then last step)."""
    for attr in ("home_plate_crossing_front", "home_plate_crossing_mid"):
        c = getattr(sim, attr)
        if c:
            return c
    return sim.trajectory[-1] if sim.trajectory else None


def speed_mph(c: dict) -> float:
    vx, vy, vz = c.get("vx", 0.0), c.get("vy", 0.0), c.get("vz", 0.0)
    return math.sqrt(vx * vx + vy * vy + vz * vz) * MPH_PER_MPS


def simulate(pitch, env):
    sim = FullBallTrajectorySimulator(integration_method=IntegrationMethod.RK4)
    sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
    return crossing(sim)


def summarize(name, values):
    values = [abs(v) for v in values]
    n = len(values)
    mean = statistics.fmean(values)
    median = statistics.median(values)
    p95 = sorted(values)[int(n * 0.95) - 1] if n >= 20 else max(values) if n else 0.0
    return mean, median, p95, max(values) if n else 0.0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", default=GAME_PK, help="MLB gamePk (default: backend placeholder game)")
    parser.add_argument("--limit", type=int, default=0, help="Max pitches to simulate (0 = all pitches in the feed)")
    parser.add_argument("--min-pitches", type=int, default=30, help="Warn if fewer than this many pitches are available")
    parser.add_argument("--min-per-type", type=int, default=30, help="Only show per-pitch-type tables for types with at least this many pitches")
    parser.add_argument("--top", type=int, default=10, help="Number of largest-movement pitches to list")
    args = parser.parse_args()

    url = f"https://statsapi.mlb.com/api/v1.1/game/{args.game}/feed/live"
    resp = requests.get(url, timeout=30)
    if resp.status_code != 200:
        sys.exit(f"Failed to fetch game feed (status {resp.status_code})")
    data = resp.json()
    game_data = data.get("gameData", {})
    all_plays = data.get("liveData", {}).get("plays", {}).get("allPlays", [])

    observed_env, observed_meta = fetch_environment_params(game_data, observed=True)
    estimated_env, estimated_meta = fetch_environment_params(game_data, observed=False)
    observed_rho = _air_density_from_env(observed_env)

    print("=" * 78)
    print(f"Game {args.game}  @ {observed_meta.get('venue_name')}  ({observed_meta.get('condition')})")
    print("-" * 78)
    print(f"  observed : P = {observed_env.pressure_mmHg:7.2f} mmHg   RH = {observed_env.relative_humidity:5.1f}%   "
          f"(source: {observed_meta.get('pressure_source')})")
    print(f"  estimated: P = {estimated_env.pressure_mmHg:7.2f} mmHg   RH = {estimated_env.relative_humidity:5.1f}%   "
          f"(source: {estimated_meta.get('pressure_source')})")
    print(f"  neutral  : P = {DEFAULT_ENV.pressure_mmHg:7.2f} mmHg   RH = {DEFAULT_ENV.relative_humidity:5.1f}%   "
          f"(source: {DEFAULT_ENV_META.get('wind_note', 'default baseline')})")
    print(f"  dP = {observed_env.pressure_mmHg - estimated_env.pressure_mmHg:+.2f} mmHg   "
          f"dRH = {observed_env.relative_humidity - estimated_env.relative_humidity:+.1f} pp")
    print("=" * 78)

    # Collect pitch events across all plays.
    events = []
    for play in all_plays:
        for event in play.get("playEvents", []):
            if event.get("isPitch") and event.get("pitchData"):
                events.append((play, event))
    if args.limit:
        events = events[: args.limit]

    if len(events) < args.min_pitches:
        print(f"WARNING: only {len(events)} pitches available (asked for >= {args.min_pitches}).")

    dxs, dzs, dvs = [], [], []      # observed − estimated
    wxs, wzs, wvs = [], [], []      # observed − neutral (absolute weather effect)
    erxs, erzs = [], []             # observed sim − Statcast pX/pZ (inches)
    rows = []  # (displacement_in, pitch_type, speed_mph, dx_in, dz_in)
    weather_rows = []  # (displacement_in, pitch_type, speed_mph, dx_in, dz_in)
    weather_by_type = defaultdict(list)   # pitch_type -> [(wx_in, wz_in, wv_mph), ...]
    accuracy_by_type = defaultdict(list)  # pitch_type -> [(err_x_in, err_z_in), ...]
    skipped = 0
    skipped_statcast = 0

    for play, event in events:
        try:
            parsed = _pitch_parameters_from_event(play, event, air_density_kg_m3=observed_rho)
        except Exception:
            skipped += 1
            continue
        pitch = parsed["pitch"]
        c_obs = simulate(pitch, observed_env)
        c_est = simulate(pitch, estimated_env)
        c_neu = simulate(pitch, DEFAULT_ENV)
        if c_obs is None or c_est is None or c_neu is None:
            skipped += 1
            continue

        dx_in = (c_obs["x"] - c_est["x"]) * IN_PER_M
        dz_in = (c_obs["z"] - c_est["z"]) * IN_PER_M
        dv_mph = speed_mph(c_obs) - speed_mph(c_est)
        disp_in = math.hypot(dx_in, dz_in)

        dxs.append(dx_in)
        dzs.append(dz_in)
        dvs.append(dv_mph)

        wx_in = (c_obs["x"] - c_neu["x"]) * IN_PER_M
        wz_in = (c_obs["z"] - c_neu["z"]) * IN_PER_M
        wv_mph = speed_mph(c_obs) - speed_mph(c_neu)
        wxs.append(wx_in)
        wzs.append(wz_in)
        wvs.append(wv_mph)

        pitch_type = event.get("details", {}).get("type", {}).get("code", "?")
        v0 = speed_mph(c_obs)
        rows.append((disp_in, pitch_type, v0, dx_in, dz_in))
        weather_rows.append((math.hypot(wx_in, wz_in), pitch_type, v0, wx_in, wz_in))
        weather_by_type[pitch_type].append((wx_in, wz_in, wv_mph))

        coordinates = event.get("pitchData", {}).get("coordinates", {})
        pX = coordinates.get("pX")
        pZ = coordinates.get("pZ")
        if pX is not None and pZ is not None:
            err_x_in = (c_obs["x"] * FT_PER_M - pX) * IN_PER_FT
            err_z_in = (c_obs["z"] * FT_PER_M - pZ) * IN_PER_FT
            erxs.append(err_x_in)
            erzs.append(err_z_in)
            accuracy_by_type[pitch_type].append((err_x_in, err_z_in))
        else:
            skipped_statcast += 1

    n = len(rows)
    if n == 0:
        sys.exit("No usable pitches found.")

    skip_note = f", {skipped_statcast} without Statcast pX/pZ" if skipped_statcast else ""
    print(f"\nSimulated {n} pitches (skipped {skipped}{skip_note}). Δ = observed − estimated, at front of plate.\n")

    def row(label, vals):
        mean, median, p95, mx = summarize(label, vals)
        print(f"  {label:<22} mean {mean:6.3f}   median {median:6.3f}   p95 {p95:6.3f}   max {mx:6.3f}")

    print("Signed deltas (inches / mph):")
    print(f"  {'Δx (horizontal)':<22} mean {statistics.fmean(dxs):+6.3f}   min {min(dxs):+6.3f}   max {max(dxs):+6.3f}")
    print(f"  {'Δz (vertical)':<22} mean {statistics.fmean(dzs):+6.3f}   min {min(dzs):+6.3f}   max {max(dzs):+6.3f}")
    print(f"  {'Δspeed (mph)':<22} mean {statistics.fmean(dvs):+6.3f}   min {min(dvs):+6.3f}   max {max(dvs):+6.3f}")

    print("\nAbsolute deltas (inches):")
    row("|Δx| horizontal", dxs)
    row("|Δz| vertical", dzs)
    disp = [math.hypot(dxs[i], dzs[i]) for i in range(n)]
    row("|Δ| total", disp)

    for threshold in (0.25, 0.5, 1.0, 2.0):
        count = sum(1 for d in disp if d >= threshold)
        print(f"  pitches moved >= {threshold:.2f} in: {count:3d} ({100 * count / n:5.1f}%)")

    print(f"\nLargest |Δ| pitches (of {n}):")
    print(f"  {'|Δ| (in)':>8}  {'Δx':>7}  {'Δz':>7}  {'type':>5}  {'v0 (mph)':>8}")
    for disp_in, pitch_type, v0, dx_in, dz_in in sorted(rows, reverse=True)[: args.top]:
        print(f"  {disp_in:8.3f}  {dx_in:+7.3f}  {dz_in:+7.3f}  {pitch_type:>5}  {v0:8.1f}")

    # --- Third comparison: absolute weather effect vs the neutral baseline. ---
    n_w = len(wxs)
    print(f"\nWeather effect vs neutral baseline (observed − neutral, {n_w} pitches):")
    print(f"  {'Δx (horizontal)':<22} mean {statistics.fmean(wxs):+6.3f}   min {min(wxs):+6.3f}   max {max(wxs):+6.3f}")
    print(f"  {'Δz (vertical)':<22} mean {statistics.fmean(wzs):+6.3f}   min {min(wzs):+6.3f}   max {max(wzs):+6.3f}")
    print(f"  {'Δspeed (mph)':<22} mean {statistics.fmean(wvs):+6.3f}   min {min(wvs):+6.3f}   max {max(wvs):+6.3f}")

    print("\nAbsolute weather effect (inches):")
    row("|Δx| horizontal", wxs)
    row("|Δz| vertical", wzs)
    wdisp = [math.hypot(wxs[i], wzs[i]) for i in range(n_w)]
    row("|Δ| total", wdisp)

    print(f"\nLargest weather-effect pitches (of {n_w}):")
    print(f"  {'|Δ| (in)':>8}  {'Δx':>7}  {'Δz':>7}  {'type':>5}  {'v0 (mph)':>8}")
    for wdisp_in, pitch_type, v0, wx_in, wz_in in sorted(weather_rows, reverse=True)[: args.top]:
        print(f"  {wdisp_in:8.3f}  {wx_in:+7.3f}  {wz_in:+7.3f}  {pitch_type:>5}  {v0:8.1f}")

    # --- Accuracy: observed sim vs Statcast at-plate position (Hawk-Eye pX/pZ). ---
    n_a = len(erxs)
    if n_a == 0:
        print("\nNo Statcast pX/pZ data available for accuracy comparison.")
    else:
        print(f"\nSimulation accuracy vs Statcast at-plate (observed sim − pX/pZ, {n_a} pitches, inches):")
        print(f"  {'Δx (horizontal)':<22} mean {statistics.fmean(erxs):+6.3f}   min {min(erxs):+6.3f}   max {max(erxs):+6.3f}")
        print(f"  {'Δz (vertical)':<22} mean {statistics.fmean(erzs):+6.3f}   min {min(erzs):+6.3f}   max {max(erzs):+6.3f}")

        print("\nAbsolute accuracy (inches):")
        row("|Δx| horizontal", erxs)
        row("|Δz| vertical", erzs)
        edisp = [math.hypot(erxs[i], erzs[i]) for i in range(n_a)]
        row("|Δ| total", edisp)

    # --- Per-pitch-type breakdown (weather effect + accuracy). ---
    print("\n" + "=" * 78)
    print(f"Per-pitch-type breakdown (types with >= {args.min_per_type} pitches)")
    print("=" * 78)

    def type_total_mean(vals, x_idx=0, z_idx=1):
        return statistics.fmean(math.hypot(v[x_idx], v[z_idx]) for v in vals)

    # Weather effect by pitch type (observed − neutral).
    weather_counts = {t: len(v) for t, v in weather_by_type.items()}
    w_order = sorted(weather_counts, key=weather_counts.get, reverse=True)
    print(f"\nWeather effect by pitch type (observed − neutral, inches / mph):")
    print(f"  {'type':>6}  {'n':>4}  {'Δx mean':>9}  {'Δz mean':>9}  {'|Δ| mean':>9}  {'Δspeed (mph)':>13}")
    for ptype in w_order:
        vals = weather_by_type[ptype]
        if len(vals) < args.min_per_type:
            continue
        print(f"  {ptype:>6}  {len(vals):>4}  "
              f"{statistics.fmean(v[0] for v in vals):+9.3f}  "
              f"{statistics.fmean(v[1] for v in vals):+9.3f}  "
              f"{type_total_mean(vals):9.3f}  "
              f"{statistics.fmean(v[2] for v in vals):+13.3f}")
    w_below = [f"{t}={weather_counts[t]}" for t in w_order if weather_counts[t] < args.min_per_type]
    if w_below:
        print(f"  (excluded, <{args.min_per_type} pitches: {', '.join(w_below)})")

    # Accuracy by pitch type (observed sim − Statcast pX/pZ).
    accuracy_counts = {t: len(v) for t, v in accuracy_by_type.items()}
    a_order = sorted(accuracy_counts, key=accuracy_counts.get, reverse=True)
    print(f"\nAccuracy by pitch type (observed sim − Statcast pX/pZ, inches):")
    print(f"  {'type':>6}  {'n':>4}  {'Δx mean':>9}  {'Δz mean':>9}  {'|Δ| mean':>9}")
    for ptype in a_order:
        vals = accuracy_by_type[ptype]
        if len(vals) < args.min_per_type:
            continue
        print(f"  {ptype:>6}  {len(vals):>4}  "
              f"{statistics.fmean(v[0] for v in vals):+9.3f}  "
              f"{statistics.fmean(v[1] for v in vals):+9.3f}  "
              f"{type_total_mean(vals):9.3f}")
    a_below = [f"{t}={accuracy_counts[t]}" for t in a_order if accuracy_counts[t] < args.min_per_type]
    if a_below:
        print(f"  (excluded, <{args.min_per_type} pitches: {', '.join(a_below)})")


if __name__ == "__main__":
    main()
