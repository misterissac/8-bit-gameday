"""Validate the LIFT_SCALE=1.05 calibration across multiple games.

For each completed game, measure the mean/median vertical plate error
(sim z - Statcast pZ, inches) with the original Nathan lift (scale=1.0) and
with the calibrated lift (scale=1.05). If the calibration generalizes, the
calibrated bias should be closer to zero than the baseline on every game,
not just the game it was fit on (822777).
"""
import argparse
import os
import sys
import statistics

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

FT_PER_M = 1 / 0.3048


def schedule_games(date):
    """Return [(gamePk, away, home), ...] for completed games on a date."""
    url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={date}"
    data = requests.get(url, timeout=30).json()
    games = []
    for d in data.get("dates", []):
        for g in d.get("games", []):
            if g.get("status", {}).get("abstractGameState") != "Final":
                continue
            teams = g.get("teams", {})
            away = teams.get("away", {}).get("team", {}).get("name", "?")
            home = teams.get("home", {}).get("team", {}).get("name", "?")
            games.append((g["gamePk"], away, home))
    return games


def measure(game_pk, lift_scale):
    """Simulate every pitch with the given lift scale; return z errors (in)."""
    FullBallTrajectorySimulator.LIFT_SCALE = lift_scale
    url = f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"
    resp = requests.get(url, timeout=30)
    if resp.status_code != 200:
        return None
    data = resp.json()
    game_data = data.get("gameData", {})
    all_plays = data.get("liveData", {}).get("plays", {}).get("allPlays", [])
    try:
        env, _ = fetch_environment_params(game_data, observed=True)
        rho = _air_density_from_env(env)
    except Exception:
        env = None
        rho = None

    errs = []
    for play in all_plays:
        for event in play.get("playEvents", []):
            if not (event.get("isPitch") and event.get("pitchData")):
                continue
            pZ = event.get("pitchData", {}).get("coordinates", {}).get("pZ")
            if pZ is None:
                continue
            try:
                parsed = _pitch_parameters_from_event(play, event, air_density_kg_m3=rho)
            except Exception:
                continue
            pitch = parsed["pitch"]
            sim = FullBallTrajectorySimulator(integration_method=IntegrationMethod.RK4)
            sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
            c = sim.home_plate_crossing_front or sim.home_plate_crossing_mid
            if c is None:
                continue
            errs.append((c["z"] * FT_PER_M - pZ) * 12.0)
    return errs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dates", nargs="+",
                        default=["2025-06-10", "2025-06-15", "2025-06-20"],
                        help="Dates to pull completed games from")
    parser.add_argument("--max-games", type=int, default=6)
    args = parser.parse_args()

    games = []
    seen = set()
    for date in args.dates:
        for pk, away, home in schedule_games(date):
            if pk not in seen:
                seen.add(pk)
                games.append((pk, away, home))
        if len(games) >= args.max_games:
            break
    games = games[: args.max_games]

    print(f"{'gamePk':>8}  {'n':>4}  {'Δz base':>8}  {'Δz cal':>8}  {'med base':>9}  {'med cal':>9}  matchup")
    all_base, all_cal = [], []
    for pk, away, home in games:
        base = measure(pk, 1.0)
        cal = measure(pk, 1.05)
        if not base or not cal:
            print(f"{pk:>8}  skipped (no data)")
            continue
        mb = statistics.fmean(base)
        mc = statistics.fmean(cal)
        mdb = statistics.median(base)
        mdc = statistics.median(cal)
        print(f"{pk:>8}  {len(base):>4}  {mb:+8.3f}  {mc:+8.3f}  {mdb:+9.3f}  {mdc:+9.3f}  {away} @ {home}")
        all_base.extend(base)
        all_cal.extend(cal)

    if all_base:
        print("\nAggregate across all games:")
        print(f"  baseline   Δz mean {statistics.fmean(all_base):+.3f} in, median {statistics.median(all_base):+.3f} in, n={len(all_base)}")
        print(f"  calibrated Δz mean {statistics.fmean(all_cal):+.3f} in, median {statistics.median(all_cal):+.3f} in, n={len(all_cal)}")


if __name__ == "__main__":
    main()
