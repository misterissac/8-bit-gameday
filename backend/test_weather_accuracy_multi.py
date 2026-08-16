"""Run the live-weather vs default-weather accuracy comparison across many games.

Picks games at diverse venues (elevation, temperature, roof type) and aggregates
whether the live-weather trajectory engine lands closer to Statcast pX/pZ at
home plate than the default-weather baseline.

Usage:
    python test_weather_accuracy_multi.py [--limit 100] [--seed 0] [--games ...]
"""

import argparse
import os
import statistics
import sys

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from test_weather_accuracy import run_game  # noqa: E402
from venues import DEFAULT_GAME_PKS  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=200,
                        help="Max pitches sampled per game (0 = all)")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--games", nargs="+", type=int, default=None,
                        help="Explicit gamePk list (default: curated diverse set)")
    args = parser.parse_args()

    # Shared 30-venue set (backend/venues.py): elevation 0-5190 ft, temps 54-86 F,
    # open / retractable / roof-closed. Pass --games to run a subset.
    default_games = DEFAULT_GAME_PKS
    games = args.games or default_games

    results = []
    print(f"Sampling up to {args.limit or 'all'} pitches per game (seed={args.seed})...\n")
    for pk in games:
        try:
            r = run_game(pk, limit=args.limit, seed=args.seed, verbose=True)
        except Exception as e:
            print(f"\n  ! Game {pk} failed: {e}\n")
            r = None
        if r:
            results.append(r)
        print()

    if not results:
        sys.exit("No games produced results.")

    print("=" * 76)
    print("AGGREGATE")
    print("=" * 76)
    print(f"{'gamePk':>8} {'venue':<22} {'n':>4} {'live mean':>9} {'def mean':>9} "
          f"{'Δ(mean)':>8} {'live med':>8} {'def med':>8} {'live win%':>9}")
    wins = losses = ties = 0
    total_n = 0
    live_all, def_all = [], []
    for r in results:
        d = r["default_mean"] - r["live_mean"]
        if d > 0.0001:
            wins += 1
        elif d < -0.0001:
            losses += 1
        else:
            ties += 1
        total_n += r["n"]
        live_all += [r["live_mean"]] * r["n"]
        def_all += [r["default_mean"]] * r["n"]
        print(f"{r['game_pk']:>8} {r['venue']:<22} {r['n']:>4} {r['live_mean']:9.3f} "
              f"{r['default_mean']:9.3f} {d:+8.3f} {r['live_median']:8.3f} "
              f"{r['default_median']:8.3f} {100 * r['live_better'] / r['n']:8.1f}%")

    print("-" * 76)
    print(f"Games where live weather is more accurate: {wins}/{len(results)} "
          f"({100 * wins / len(results):.0f}%)  [worse: {losses}, tie: {ties}]")
    print(f"Total pitches: {total_n}")
    print(f"Overall mean plate error: live {statistics.fmean(live_all):.3f} in vs "
          f"default {statistics.fmean(def_all):.3f} in "
          f"(Δ {statistics.fmean(def_all) - statistics.fmean(live_all):+.3f} in)")

    if losses == 0:
        print("\nVERIFIED across all sampled games: the weather-parameter trajectory "
              "engine is consistently more accurate than the default baseline.")
    elif wins > losses:
        print(f"\nLive weather won {wins}/{len(results)} games, lost {losses}. "
              "Mostly, but not universally, more accurate.")
    else:
        print("\nLive weather did NOT consistently beat the default baseline.")


if __name__ == "__main__":
    main()
