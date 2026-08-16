"""Fit SIDESPIN_SCALE (horizontal/sidespin calibration) across venues.

Sweeps ``FullBallTrajectorySimulator.SIDESPIN_SCALE`` and reports the aggregate
mean signed horizontal error (sim x - Statcast pX, inches) for the live-weather
arm across a fixed multi-venue set, so the scale can be chosen to zero the
systematic horizontal bias (analogous to the vertical LIFT_SCALE calibration).

Usage:
    python fit_sidespin_scale.py [--games ...] [--limit 100] [--scales ...]
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
    fetch_environment_params,
    _air_density_from_env,
    _pitch_parameters_from_event,
)
from venues import DEFAULT_GAME_PKS as DEFAULT_GAMES  # noqa: E402

FT_PER_M = 1 / 0.3048
IN = 12.0


def load(game_pks, limit, seed):
    """Fetch live-arm pitches once; return (pitch, env, pX, pZ) tuples."""
    pitches = []
    for pk in game_pks:
        data = requests.get(
            f"https://statsapi.mlb.com/api/v1.1/game/{pk}/feed/live", timeout=30
        ).json()
        gd = data.get("gameData", {})
        all_plays = data.get("liveData", {}).get("plays", {}).get("allPlays", [])
        env, _ = fetch_environment_params(gd, observed=True)
        rho = _air_density_from_env(env)
        events = []
        for play in all_plays:
            for ev in play.get("playEvents", []):
                if ev.get("isPitch") and ev.get("pitchData"):
                    c = ev["pitchData"].get("coordinates", {})
                    if c.get("pX") is not None and c.get("pZ") is not None:
                        events.append((play, ev))
        if limit and len(events) > limit:
            events = random.Random(seed).sample(events, limit)
        for play, ev in events:
            c = ev["pitchData"]["coordinates"]
            try:
                pitch = _pitch_parameters_from_event(
                    play, ev, air_density_kg_m3=rho
                )["pitch"]
            except Exception:
                continue
            pitches.append((pitch, env, c["pX"], c["pZ"]))
    return pitches


def simulate(pitch, env):
    sim = FullBallTrajectorySimulator(integration_method=IntegrationMethod.RK4)
    sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
    return sim.home_plate_crossing_front or sim.home_plate_crossing_mid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", nargs="+", type=int, default=DEFAULT_GAMES)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--scales", nargs="+", type=float,
        default=[0.80, 0.85, 0.90, 0.95, 1.00],
    )
    args = parser.parse_args()

    pitches = load(args.games, args.limit, args.seed)
    print(f"loaded {len(pitches)} pitches across {len(args.games)} games\n")
    print(f"{'SIDESPIN_SCALE':>14} {'mean x':>9} {'mean |x|':>9} "
          f"{'mean z':>9} {'mean |tot|':>10}")

    best = None
    for s in args.scales:
        FullBallTrajectorySimulator.SIDESPIN_SCALE = s
        xs, zs = [], []
        for pitch, env, pX, pZ in pitches:
            c = simulate(pitch, env)
            if c is None:
                continue
            xs.append((c["x"] * FT_PER_M - pX) * IN)
            zs.append((c["z"] * FT_PER_M - pZ) * IN)
        mean_x = statistics.fmean(xs)
        mean_z = statistics.fmean(zs)
        mad_x = statistics.fmean(abs(v) for v in xs)
        tot = statistics.fmean(math.hypot(x, z) for x, z in zip(xs, zs))
        print(f"{s:>14.2f} {mean_x:+9.3f} {mad_x:9.3f} {mean_z:+9.3f} {tot:10.3f}")
        if best is None or abs(mean_x) < abs(best[1]):
            best = (s, mean_x, mad_x, mean_z, tot)

    print(f"\nBest (zero signed x bias): SIDESPIN_SCALE={best[0]:.3f} "
          f"(mean x {best[1]:+.3f} in, mean |x| {best[2]:.3f} in, "
          f"mean z {best[3]:+.3f} in, |tot| {best[4]:.3f} in)")


if __name__ == "__main__":
    main()
