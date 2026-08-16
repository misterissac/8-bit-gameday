"""Diagnose the systematic vertical bias (sim below Statcast pZ).

Compares the RK4 sim against the 9P constant-acceleration fit on:
  * flight time to the front of home plate
  * plate speed
  * vertical position
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
MPH_PER_MPS = 2.23694
FPS_TO_MS = 0.3048
FRONT_Y_FT = 17.0 / 12.0


def interp_at_y(sim, y_target_m):
    traj = sim.trajectory
    for i in range(len(traj) - 1):
        a, b = traj[i], traj[i + 1]
        if (a["y"] - y_target_m) * (b["y"] - y_target_m) <= 0:
            if b["y"] == a["y"]:
                continue
            frac = (y_target_m - a["y"]) / (b["y"] - a["y"])
            out = {}
            for k in ("t", "vx", "vy", "vz"):
                out[k] = a[k] + frac * (b[k] - a[k])
            return out
    return None


def quad_front(coords):
    y0 = float(coords.get("y0", 50.0))
    vy0 = float(coords.get("vY0", 0.0))
    ay = float(coords.get("aY", 0.0))
    a = 0.5 * ay
    b = vy0
    c = y0 - FRONT_Y_FT
    disc = b * b - 4 * a * c
    if a == 0 or disc < 0:
        return None
    t = (-b - math.sqrt(disc)) / (2 * a)
    if t < 0:
        t = (-b + math.sqrt(disc)) / (2 * a)
    if t < 0:
        return None
    x = float(coords.get("x0", 0.0)) + float(coords.get("vX0", 0.0)) * t + 0.5 * float(coords.get("aX", 0.0)) * t * t
    z = float(coords.get("z0", 0.0)) + float(coords.get("vZ0", 0.0)) * t + 0.5 * float(coords.get("aZ", 0.0)) * t * t
    vx = float(coords.get("vX0", 0.0)) + float(coords.get("aX", 0.0)) * t
    vy = float(coords.get("vY0", 0.0)) + float(coords.get("aY", 0.0)) * t
    vz = float(coords.get("vZ0", 0.0)) + float(coords.get("aZ", 0.0)) * t
    speed = math.sqrt(vx * vx + vy * vy + vz * vz) * FPS_TO_MS * MPH_PER_MPS
    return x, z, t, speed


def main():
    url = f"https://statsapi.mlb.com/api/v1.1/game/{GAME_PK}/feed/live"
    data = requests.get(url, timeout=30).json()
    game_data = data.get("gameData", {})
    all_plays = data.get("liveData", {}).get("plays", {}).get("allPlays", [])
    env, _ = fetch_environment_params(game_data, observed=True)

    rows = []
    for play in all_plays:
        for event in play.get("playEvents", []):
            if not (event.get("isPitch") and event.get("pitchData")):
                continue
            coords = event.get("pitchData", {}).get("coordinates", {})
            pZ = coords.get("pZ")
            if pZ is None:
                continue
            try:
                parsed = _pitch_parameters_from_event(play, event)
            except Exception:
                continue
            pitch = parsed["pitch"]
            sim = FullBallTrajectorySimulator(integration_method=IntegrationMethod.RK4)
            sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
            c = sim.home_plate_crossing_front or sim.home_plate_crossing_mid
            if c is None:
                continue
            q = quad_front(coords)
            if q is None:
                continue
            y50 = interp_at_y(sim, 50.0 * 0.3048)
            if y50 is None:
                continue
            sim_speed = math.sqrt(c["vx"] ** 2 + c["vy"] ** 2 + c["vz"] ** 2) * MPH_PER_MPS
            t50 = q[2]  # 9P time from y=50ft to front of plate
            rows.append({
                "type": event.get("details", {}).get("type", {}).get("code", "?"),
                "sim_t50": (c["t"] - y50["t"]) * 1000.0,  # sim time 50ft -> plate
                "quad_t50": t50 * 1000.0,
                "dt_ms": ((c["t"] - y50["t"]) - t50) * 1000.0,
                "sim_speed": sim_speed,
                "quad_speed": q[3],
                "dspeed": sim_speed - q[3],
                "z_err": (c["z"] * FT_PER_M - pZ) * 12.0,
            })

    n = len(rows)
    print(f"n = {n}")
    dt = [r["dt_ms"] for r in rows]
    ds = [r["dspeed"] for r in rows]
    ze = [r["z_err"] for r in rows]
    print(f"\n50ft->plate time diff (sim − 9P), ms:  mean {statistics.fmean(dt):+7.2f}  median {statistics.median(dt):+7.2f}  "
          f"min {min(dt):+7.2f}  max {max(dt):+7.2f}")
    print(f"plate-speed diff (sim − 9P), mph:  mean {statistics.fmean(ds):+7.2f}  median {statistics.median(ds):+7.2f}  "
          f"min {min(ds):+7.2f}  max {max(ds):+7.2f}")
    print(f"z error (sim − pZ), in:              mean {statistics.fmean(ze):+7.2f}  median {statistics.median(ze):+7.2f}")

    print("\nper type (mean):")
    print(f"  {'type':>6} {'n':>4} {'dt_ms':>8} {'dspeed':>8} {'z_err':>8}")
    for t in sorted({r["type"] for r in rows}):
        tr = [r for r in rows if r["type"] == t]
        print(f"  {t:>6} {len(tr):>4} "
              f"{statistics.fmean(r['dt_ms'] for r in tr):+8.2f} "
              f"{statistics.fmean(r['dspeed'] for r in tr):+8.2f} "
              f"{statistics.fmean(r['z_err'] for r in tr):+8.2f}")


if __name__ == "__main__":
    main()
