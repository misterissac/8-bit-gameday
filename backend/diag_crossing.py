#!/usr/bin/env python3
"""Quick diagnostic to compare Statcast pX/pZ with simulator crossing values."""
import os, sys

parent_dir = os.path.dirname(os.path.dirname(__file__))
sim_dir = os.path.join(parent_dir, "skill-vis:MyTrajectorySimulator-main")
sys.path.insert(0, sim_dir)
sys.path.insert(0, os.path.join(sim_dir, "API"))

import requests
import math
from MyBallTrajectorySim import BallTrajectorySimulator2, IntegrationMethod, PitchParameters, EnvironmentParameters
from statcast_to_sim import statcast_to_sim_params

GAME_PK = '824080'
URL = f"https://statsapi.mlb.com/api/v1.1/game/{GAME_PK}/feed/live"

response = requests.get(URL)
data = response.json()
all_plays = data['liveData']['plays']['allPlays']
last_play = all_plays[-1]
play_events = last_play.get('playEvents', [])
pitches = [event for event in play_events if event.get('isPitch')]

for idx, pitch_event in enumerate(pitches):
    pitch_data = pitch_event.get('pitchData', {})
    coordinates = pitch_data.get('coordinates', {})
    breaks = pitch_data.get('breaks', {})
    
    pX = coordinates.get('pX')
    pZ = coordinates.get('pZ')
    
    if pX is None or pZ is None:
        continue
    
    extension_ft = pitch_data.get('extension')
    if extension_ft is not None:
        release_ext = float(extension_ft)
    else:
        y0_ft = float(coordinates.get('y0', 54.5))
        release_ext = 60.5 - y0_ft
    
    pfx_x_in = coordinates.get('pfxX')
    pfx_z_in = coordinates.get('pfxZ')
    
    statcast_data = {
        "release_pos_x": coordinates.get('x0'),
        "release_extension": release_ext,
        "release_pos_z": coordinates.get('z0'),
        "vx0": coordinates.get('vX0'),
        "vy0": coordinates.get('vY0'),
        "vz0": coordinates.get('vZ0'),
        "ax": coordinates.get('aX'),
        "ay": coordinates.get('aY'),
        "az": coordinates.get('aZ'),
        "pfx_x": float(pfx_x_in) / 12.0 if pfx_x_in is not None else None,
        "pfx_z": float(pfx_z_in) / 12.0 if pfx_z_in is not None else None,
        "release_spin_rate": breaks.get('spinRate'),
        "spin_axis": breaks.get('spinDirection'),
        "pitch_type": "FF",
        "p_throws": last_play.get('matchup', {}).get('pitcherHand', {}).get('code', 'R')
    }
    
    sim_params = statcast_to_sim_params(statcast_data, spin_method="bsg", accel_method=True)
    valid_keys = ['x0', 'y0', 'z0', 'v0_mps', 'theta_deg', 'phi_deg', 'backspin_rpm', 'sidespin_rpm', 'wg_rpm', 'batter_hand']
    pitch_kwargs = {k: v for k, v in sim_params.items() if k in valid_keys}
    if 'batter_hand' not in pitch_kwargs:
        pitch_kwargs['batter_hand'] = 'R'
    
    pitch = PitchParameters(**pitch_kwargs)
    env = EnvironmentParameters()
    sim = BallTrajectorySimulator2(integration_method=IntegrationMethod.RK4)
    sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
    
    # Sim crossing
    hpc = sim.home_plate_crossing
    if hpc:
        sim_x_ft = hpc['x'] / 0.3048
        sim_z_ft = hpc['z'] / 0.3048
    else:
        sim_x_ft = sim_z_ft = None
    
    # Quadratic crossing (what the backend also sends)
    x0_ft = coordinates.get('x0', 0)
    y0_ft_q = coordinates.get('y0', 50)
    z0_ft = coordinates.get('z0', 0)
    vx0 = coordinates.get('vX0', 0)
    vy0 = coordinates.get('vY0', 0)
    vz0 = coordinates.get('vZ0', 0)
    ax = coordinates.get('aX', 0)
    ay = coordinates.get('aY', 0)
    az = coordinates.get('aZ', 0)
    
    # Find time when y reaches front of plate (1.417 ft)
    t = 0
    dt = 0.001
    quad_x_ft = quad_z_ft = None
    while t < 1.0:
        y_q = y0_ft_q + vy0 * t + 0.5 * ay * t**2
        if y_q <= 1.417:
            x_q = x0_ft + vx0 * t + 0.5 * ax * t**2
            z_q = z0_ft + vz0 * t + 0.5 * az * t**2
            quad_x_ft = x_q
            quad_z_ft = z_q
            break
        t += dt
    
    print(f"--- Pitch {idx+1} ---")
    print(f"  Statcast pX={pX:.4f} ft, pZ={pZ:.4f} ft")
    print(f"  Quadratic pX={quad_x_ft:.4f} ft, pZ={quad_z_ft:.4f} ft" if quad_x_ft else "  Quadratic: N/A")
    if sim_x_ft:
        print(f"  Sim cross  x={sim_x_ft:.4f} ft, z={sim_z_ft:.4f} ft")
        print(f"  Diff (Sim-pX): x={sim_x_ft - pX:.4f} ft ({(sim_x_ft - pX)*12:.2f} in), z={sim_z_ft - pZ:.4f} ft ({(sim_z_ft - pZ)*12:.2f} in)")
    if quad_x_ft:
        print(f"  Diff (Quad-pX): x={quad_x_ft - pX:.4f} ft ({(quad_x_ft - pX)*12:.2f} in), z={quad_z_ft - pZ:.4f} ft ({(quad_z_ft - pZ)*12:.2f} in)")
    print()
