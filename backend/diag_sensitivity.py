"""Grid search over drag coefficients to minimize plate error vs Statcast.

Reports signed and absolute x/z error (inches) for cd0 x cdspin combos, so a
drag retune can be chosen that reduces the ~0.7in vertical low bias without
wrecking horizontal accuracy.
"""
import os
import sys
import math
import statistics

import requests

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from main import (  # noqa: E402
    FullBallTrajectorySimulator,
    IntegrationMethod,
    GAME_PK,
    fetch_environment_params,
    _pitch_parameters_from_event,
)

FT_PER_M = 1 / 0.3048


class TunedSim(FullBallTrajectorySimulator):
    def __init__(self, cd0=None, cdspin=None):
        super().__init__(integration_method=IntegrationMethod.RK4)
        if cd0 is not None:
            self.cd0 = cd0
        if cdspin is not None:
            self.cdspin = cdspin


def load_pitches():
    url = f"https://statsapi.mlb.com/api/v1.1/game/{GAME_PK}/feed/live"
    data = requests.get(url, timeout=30).json()
    game_data = data.get("gameData", {})
    all_plays = data.get("liveData", {}).get("plays", {}).get("allPlays", [])
    env, _ = fetch_environment_params(game_data, observed=True)
    out = []
    for play in all_plays:
        for event in play.get("playEvents", []):
            if not (event.get("isPitch") and event.get("pitchData")):
                continue
            coords = event.get("pitchData", {}).get("coordinates", {})
            pX, pZ = coords.get("pX"), coords.get("pZ")
            if pX is None or pZ is None:
                continue
            try:
                parsed = _pitch_parameters_from_event(play, event)
            except Exception:
                continue
            out.append((parsed["pitch"], pX, pZ))
    return env, out


def run(pitches, env, **kw):
    sim = TunedSim(**kw)
    ex, ez = [], []
    for pitch, pX, pZ in pitches:
        sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
        c = sim.home_plate_crossing_front or sim.home_plate_crossing_mid
        if c is None:
            continue
        ex.append((c["x"] * FT_PER_M - pX) * 12.0)
        ez.append((c["z"] * FT_PER_M - pZ) * 12.0)
    return ex, ez


def main():
    env, pitches = load_pitches()
    pitches = pitches[::4]  # subsample for speed
    print(f"loaded {len(pitches)} pitches\n")
    print(f"{'cd0':>6} {'cdspin':>8} {'ex_mean':>9} {'ez_mean':>9} {'|ex|':>7} {'|ez|':>7} {'|e|':>7}")
    combos = [
        (0.297, 0.0292), (0.28, 0.0292), (0.27, 0.0292),
        (0.297, 0.02), (0.297, 0.01), (0.297, 0.0),
        (0.28, 0.0), (0.27, 0.0), (0.28, 0.01), (0.27, 0.01),
    ]
    for cd0, cdspin in combos:
        ex, ez = run(pitches, env, cd0=cd0, cdspin=cdspin)
        mex = statistics.fmean(ex)
        mez = statistics.fmean(ez)
        aex = statistics.fmean(abs(v) for v in ex)
        aez = statistics.fmean(abs(v) for v in ez)
        ae = statistics.fmean(math.hypot(x, z) for x, z in zip(ex, ez))
        print(f"{cd0:>6.3f} {cdspin:>8.4f} {mex:+9.3f} {mez:+9.3f} {aex:7.3f} {aez:7.3f} {ae:7.3f}")


if __name__ == "__main__":
    main()
