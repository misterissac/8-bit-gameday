"""Re-fit LIFT_SCALE (vertical) and SIDESPIN_SCALE (horizontal) across venues.

The two Magnus calibration knobs act on orthogonal axes
(``SIDESPIN_SCALE`` -> ``magnus_x``, ``LIFT_SCALE`` -> ``magnus_z``), so they are
swept as two independent 1-D scans over a fixed multi-venue set. The script loads
every live-arm pitch once and then re-simulates per scale, reporting the signed
bias and absolute error for each candidate so the optimal value can be chosen.

Usage:
    python fit_calibration.py [--games ...] [--limit 100] [--seed 0]
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


def run_pitches(pitches):
    """Simulate every pitch once and return (xs, zs) signed errors in inches."""
    xs, zs = [], []
    for pitch, env, pX, pZ in pitches:
        c = simulate(pitch, env)
        if c is None:
            continue
        xs.append((c["x"] * FT_PER_M - pX) * IN)
        zs.append((c["z"] * FT_PER_M - pZ) * IN)
    return xs, zs


def report(label, xs, zs):
    mean_x = statistics.fmean(xs)
    mean_z = statistics.fmean(zs)
    mad_x = statistics.fmean(abs(v) for v in xs)
    mad_z = statistics.fmean(abs(v) for v in zs)
    tot = statistics.fmean(math.hypot(x, z) for x, z in zip(xs, zs))
    print(f"  {label:<16} mean x {mean_x:+8.3f}  |x| {mad_x:6.3f}  "
          f"mean z {mean_z:+8.3f}  |z| {mad_z:6.3f}  |tot| {tot:6.3f}")
    return mean_x, mad_x, mean_z, mad_z, tot


def sweep(axis, grid, pitches, current_sidespin, current_lift):
    print(f"\n--- {axis} sweep ---")
    print(f"  {'scale':<16} {'mean x':>8} {'|x|':>7} {'mean z':>8} {'|z|':>7} {'|tot|':>7}")
    best = None
    best_key = None
    for s in grid:
        FullBallTrajectorySimulator.SIDESPIN_SCALE = (
            s if axis == "SIDESPIN_SCALE" else current_sidespin
        )
        FullBallTrajectorySimulator.LIFT_SCALE = (
            s if axis == "LIFT_SCALE" else current_lift
        )
        xs, zs = run_pitches(pitches)
        mean_x = statistics.fmean(xs)
        mean_z = statistics.fmean(zs)
        mad_x = statistics.fmean(abs(v) for v in xs)
        mad_z = statistics.fmean(abs(v) for v in zs)
        tot = statistics.fmean(math.hypot(x, z) for x, z in zip(xs, zs))
        print(f"  {s:<16.3f} {mean_x:+8.3f} {mad_x:7.3f} {mean_z:+8.3f} {mad_z:7.3f} {tot:7.3f}")
        key = abs(mean_x) if axis == "SIDESPIN_SCALE" else abs(mean_z)
        if best is None or key < best_key:
            best = (s, mean_x, mad_x, mean_z, mad_z, tot)
            best_key = key
    return best


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", nargs="+", type=int, default=DEFAULT_GAMES)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    pitches = load(args.games, args.limit, args.seed)
    print(f"loaded {len(pitches)} pitches across {len(args.games)} games")

    cur_sidespin = FullBallTrajectorySimulator.SIDESPIN_SCALE
    cur_lift = FullBallTrajectorySimulator.LIFT_SCALE
    print(f"\nCurrent: SIDESPIN_SCALE={cur_sidespin:.3f}, LIFT_SCALE={cur_lift:.3f}")
    report("current", *run_pitches(pitches))

    sidespin_grid = [0.85, 0.90, 0.95, 1.00, 1.05, 1.10]
    best_ss = sweep("SIDESPIN_SCALE", sidespin_grid, pitches, cur_sidespin, cur_lift)
    s_ss = best_ss[0]

    lift_grid = [0.95, 0.975, 1.00, 1.025, 1.05, 1.075, 1.10]
    best_lift = sweep("LIFT_SCALE", lift_grid, pitches, s_ss, cur_lift)

    print("\n" + "=" * 68)
    print(f"Best SIDESPIN_SCALE = {s_ss:.3f}  (mean x {best_ss[1]:+.3f} in, "
          f"|x| {best_ss[2]:.3f} in)")
    print(f"Best LIFT_SCALE     = {best_lift[0]:.3f}  (mean z {best_lift[3]:+.3f} in, "
          f"|z| {best_lift[4]:.3f} in)")
    print(f"Suggested constants: LIFT_SCALE={best_lift[0]:.3f}, "
          f"SIDESPIN_SCALE={s_ss:.3f}")


if __name__ == "__main__":
    main()
