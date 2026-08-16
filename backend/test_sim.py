import sys
import os
import requests
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../skill-vis:MyTrajectorySimulator-main'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../skill-vis:MyTrajectorySimulator-main/API'))

from MyBallTrajectorySim import BallTrajectorySimulator2, IntegrationMethod, PitchParameters, EnvironmentParameters
from statcast_to_sim import statcast_to_sim_params

GAME_PK = '822778'
URL = f"https://statsapi.mlb.com/api/v1.1/game/{GAME_PK}/feed/live"
response = requests.get(URL)
data = response.json()

all_plays = data['liveData']['plays']['allPlays']
pitches = [event for play in all_plays for event in play.get('playEvents', []) if event.get('isPitch')]
last_pitch = pitches[-1]
pitch_data = last_pitch.get('pitchData', {})
coordinates = pitch_data.get('coordinates', {})
breaks = pitch_data.get('breaks', {})

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
    "p_throws": "R"
}

sim_params = statcast_to_sim_params(statcast_data, spin_method="bsg", accel_method=True)
valid_keys = ['x0', 'y0', 'z0', 'v0_mps', 'theta_deg', 'phi_deg', 'backspin_rpm', 'sidespin_rpm', 'wg_rpm', 'batter_hand']
pitch_kwargs = {k: v for k, v in sim_params.items() if k in valid_keys}
pitch_kwargs['batter_hand'] = 'R'

pitch = PitchParameters(**pitch_kwargs)
env = EnvironmentParameters()
sim = BallTrajectorySimulator2(integration_method=IntegrationMethod.RK4)
sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)

traj = sim.trajectory
front_of_plate = [p for p in traj if p['y'] <= 1.417]
cross_sim = front_of_plate[0] if front_of_plate else traj[-1]

print("Sim pZ (meters):", cross_sim['z'] * 0.3048)
print("Statcast pZ (meters):", coordinates.get('pZ') * 0.3048)
print("Sim pZ (feet):", cross_sim['z'])
print("Statcast pZ (feet):", coordinates.get('pZ'))

