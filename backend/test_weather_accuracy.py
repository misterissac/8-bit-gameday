"""A/B test: live-weather trajectory engine vs default weather params.

For every pitch in a game's live feed (with Statcast pX/pZ available), run the
RK4 trajectory simulation twice:

  * live    - environment from the weather engine (fetch_environment_params:
              venue elevation-derived station pressure + sky-condition humidity,
              plus MLB feed temp — no Open-Meteo call; the observed P/RH
              refinement was measured to add <=0.01 in of plate accuracy)
  * default - DEFAULT_ENV neutral baseline (70 F, 15 ft elev, 50% RH, 760 mmHg)

Compare each simulated front-of-plate crossing to Statcast pX/pZ (inches) and
report whether the live-weather engine lands closer to the Statcast position at
home plate than the default-weather run.

Usage:
    python test_weather_accuracy.py [--game 822777] [--limit 200] [--seed 0]
"""

import argparse
import math
import os
import random
import statistics
import sys

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

FT_PER_M = 1 / 0.3048
IN_PER_FT = 12.0


def crossing(sim):
    """Return the first available plate-crossing dict (front, then mid, then last step)."""
    for attr in ("home_plate_crossing_front", "home_plate_crossing_mid"):
        c = getattr(sim, attr)
        if c:
            return c
    return sim.trajectory[-1] if sim.trajectory else None


def simulate(pitch, env):
    sim = FullBallTrajectorySimulator(integration_method=IntegrationMethod.RK4)
    sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
    return crossing(sim)


def plate_error(c, pX, pZ):
    """Euclidean distance (inches) between sim crossing and Statcast pX/pZ (both feet)."""
    err_x_ft = c["x"] * FT_PER_M - pX
    err_z_ft = c["z"] * FT_PER_M - pZ
    return math.hypot(err_x_ft, err_z_ft) * IN_PER_FT


def arm_air_densities(live_env):
    """Return ``(live_rho, default_rho)`` — the air density each A/B arm
    recovers spin from and integrates through.

    Both must come from ``_air_density_from_env`` so spin recovery matches the
    air the forward model actually integrates. The default arm uses
    ``DEFAULT_ENV``'s density (~1.19 kg/m^3), NOT the hardcoded sea-level
    standard (1.225 kg/m^3) — recovering spin at 1.225 while integrating with
    DEFAULT_ENV made the default arm internally inconsistent and confounded
    the A/B comparison.
    """
    return _air_density_from_env(live_env), _air_density_from_env(DEFAULT_ENV)


def run_game(game_pk, limit=0, seed=0, verbose=True):
    """Run the live-vs-default A/B comparison for one game.

    Returns a dict with means, medians, win counts, env metadata, or None on failure.
    """
    url = f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"
    resp = requests.get(url, timeout=30)
    if resp.status_code != 200:
        return None
    data = resp.json()
    game_data = data.get("gameData", {})
    all_plays = data.get("liveData", {}).get("plays", {}).get("allPlays", [])

    live_env, live_meta = fetch_environment_params(game_data, observed=False)
    live_rho, default_rho = arm_air_densities(live_env)

    events = []
    for play in all_plays:
        for event in play.get("playEvents", []):
            if not (event.get("isPitch") and event.get("pitchData")):
                continue
            coords = event.get("pitchData", {}).get("coordinates", {})
            if coords.get("pX") is None or coords.get("pZ") is None:
                continue
            events.append((play, event))
    if limit and len(events) > limit:
        rng = random.Random(seed)
        events = rng.sample(events, limit)

    live_errs, default_errs = [], []
    live_x, live_z = [], []
    default_x, default_z = [], []
    skipped = 0

    for play, event in events:
        try:
            # Each engine recovers spin from pfx with its own air-density
            # assumption, then integrates with that same air: the live engine
            # uses the game density (elevation-derived env), the default engine
            # uses the neutral DEFAULT_ENV density (so a roof-closed game, which
            # the weather engine now maps to neutral conditions, is an exact tie).
            parsed_live = _pitch_parameters_from_event(play, event, air_density_kg_m3=live_rho)
            parsed_default = _pitch_parameters_from_event(play, event, air_density_kg_m3=default_rho)
        except Exception:
            skipped += 1
            continue
        pitch_live = parsed_live["pitch"]
        pitch_default = parsed_default["pitch"]
        coords = event.get("pitchData", {}).get("coordinates", {})
        pX, pZ = coords.get("pX"), coords.get("pZ")

        c_live = simulate(pitch_live, live_env)
        c_default = simulate(pitch_default, DEFAULT_ENV)
        if c_live is None or c_default is None:
            skipped += 1
            continue

        e_live = plate_error(c_live, pX, pZ)
        e_default = plate_error(c_default, pX, pZ)
        live_errs.append(e_live)
        default_errs.append(e_default)
        live_x.append((c_live["x"] * FT_PER_M - pX) * IN_PER_FT)
        live_z.append((c_live["z"] * FT_PER_M - pZ) * IN_PER_FT)
        default_x.append((c_default["x"] * FT_PER_M - pX) * IN_PER_FT)
        default_z.append((c_default["z"] * FT_PER_M - pZ) * IN_PER_FT)

    n = len(live_errs)
    if n == 0:
        return None

    mean_live = statistics.fmean(live_errs)
    mean_default = statistics.fmean(default_errs)
    better = sum(1 for a, b in zip(live_errs, default_errs) if a < b)
    worse = sum(1 for a, b in zip(live_errs, default_errs) if a > b)

    if verbose:
        print("=" * 76)
        print(f"Game {game_pk}  @ {live_meta.get('venue_name')}  ({live_meta.get('condition')})  n={n}"
              f"{f' (skipped {skipped})' if skipped else ''}")
        print("-" * 76)
        print(f"  live   : P = {live_env.pressure_mmHg:7.2f} mmHg  RH = {live_env.relative_humidity:5.1f}%  "
              f"T = {live_env.temp_F:5.1f} F   ({live_meta.get('pressure_source')} / {live_meta.get('humidity_source')})")
        print(f"  default: P = {DEFAULT_ENV.pressure_mmHg:7.2f} mmHg  RH = {DEFAULT_ENV.relative_humidity:5.1f}%  "
              f"T = {DEFAULT_ENV.temp_F:5.1f} F   ({DEFAULT_ENV_META.get('condition')})")
        print("=" * 76)

        def row(label, vals):
            vals = [abs(v) for v in vals]
            print(f"  {label:<24} mean {statistics.fmean(vals):6.3f}   median {statistics.median(vals):6.3f}   "
                  f"p95 {sorted(vals)[int(n * 0.95) - 1]:6.3f}   max {max(vals):6.3f}")

        print("\nTotal plate error vs Statcast (|Δx,Δz| inches):")
        row("live   (elevation-derived)", live_errs)
        row("default (baseline)", default_errs)

        print("\nSigned x error (sim − pX, inches):")
        print(f"  {'live   (elevation-derived)':<24} mean {statistics.fmean(live_x):+6.3f}   median {statistics.median(live_x):+6.3f}")
        print(f"  {'default (baseline)':<24} mean {statistics.fmean(default_x):+6.3f}   median {statistics.median(default_x):+6.3f}")
        print("Signed z error (sim − pZ, inches):")
        print(f"  {'live   (elevation-derived)':<24} mean {statistics.fmean(live_z):+6.3f}   median {statistics.median(live_z):+6.3f}")
        print(f"  {'default (baseline)':<24} mean {statistics.fmean(default_z):+6.3f}   median {statistics.median(default_z):+6.3f}")

        print(f"\nLive weather closer to Statcast: {better}/{n} pitches "
              f"({100 * better / n:.1f}%), default closer: {worse}/{n} ({100 * worse / n:.1f}%)")

        d = mean_default - mean_live
        print(f"\nMean total error: live {mean_live:.3f} in vs default {mean_default:.3f} in "
              f"(Δ {d:+.3f} in, live {'better' if d > 0 else 'worse'})")

        if d > 0:
            print(f"VERIFIED: the weather-parameter trajectory engine is more accurate "
                  f"than the default-weather baseline by {d:.3f} in on average.")
        else:
            print("NOTE: live-weather engine did NOT beat the default baseline on this sample.")

    return {
        "game_pk": game_pk,
        "venue": live_meta.get("venue_name"),
        "condition": live_meta.get("condition"),
        "n": n,
        "skipped": skipped,
        "live_mean": mean_live,
        "default_mean": mean_default,
        "live_median": statistics.median(live_errs),
        "default_median": statistics.median(default_errs),
        "live_better": better,
        "default_better": worse,
        "live_env": {"P": live_env.pressure_mmHg, "RH": live_env.relative_humidity, "T": live_env.temp_F},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", default=GAME_PK, help="MLB gamePk (default: backend placeholder game)")
    parser.add_argument("--limit", type=int, default=0, help="Max pitches to test (0 = all pitches in the feed)")
    parser.add_argument("--seed", type=int, default=0, help="Random seed for sampling when --limit < available")
    args = parser.parse_args()

    result = run_game(args.game, limit=args.limit, seed=args.seed)
    if result is None:
        sys.exit("No usable pitches found.")
    return 0 if result["live_mean"] < result["default_mean"] else 1


if __name__ == "__main__":
    sys.exit(main())
