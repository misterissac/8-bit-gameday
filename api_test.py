import os
import sys
import requests

# Add trajectory simulator paths
sim_dir = os.path.join(os.path.dirname(__file__), "skill-vis:MyTrajectorySimulator-main")
sys.path.insert(0, sim_dir)
sys.path.insert(0, os.path.join(sim_dir, "API"))

from MyBallTrajectorySim import BallTrajectorySimulator2, IntegrationMethod, PitchParameters, EnvironmentParameters
from statcast_to_sim import statcast_to_sim_params

# Let's define the target game (You will grab a live gamePk from the MLB schedule endpoint)
# We will use a placeholder gamePk for demonstration
game_pk = '823425'
url = f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"

def fetch_pitch_data():
    print(f"LOADING LEVEL... Polling game {game_pk}")
    response = requests.get(url)

    if response.status_code == 200:
        data = response.json()

        # Drill down into the live payload (navigating the JSON labyrinth)
        try:
            all_plays = data['liveData']['plays']['allPlays']
            if not all_plays:
                print("Game hasn't started yet!")
                return

            # Grab the most recent play
            last_play = all_plays[-1]
            play_events = last_play.get('playEvents', [])

            # Filter the events to find actual pitches
            pitches = [event for event in play_events if event.get('isPitch')]

            if pitches:
                # Grab the last pitch thrown
                last_pitch = pitches[-1]
                pitch_data = last_pitch.get('pitchData', {})

                coordinates = pitch_data.get('coordinates', {})
                breaks = pitch_data.get('breaks', {})

                print("\n--- ⚾ PITCH DATA ACQUIRED! ---")

                pitcher = last_play.get('matchup', {}).get('pitcher', {}).get('fullName', 'N/A')
                count = last_pitch.get('count', {})
                balls = count.get('balls', 0)
                strikes = count.get('strikes', 0)

                print(f"Pitcher: {pitcher}")
                print(f"Count: {balls}-{strikes}")

                # The 9-Parameter Cheat Code
                print("\n[ KINEMATIC VECTORS ]")
                print(f"Release (x, y, z): {coordinates.get('x0')}, {coordinates.get('y0')}, {coordinates.get('z0')}")
                print(f"Velocity (vX0, vY0, vZ0): {coordinates.get('vX0')}, {coordinates.get('vY0')}, {coordinates.get('vZ0')}")
                print(f"Acceleration (aX, aY, aZ): {coordinates.get('aX')}, {coordinates.get('aY')}, {coordinates.get('aZ')}")
                print(f"Start Speed: {coordinates.get('startSpeed')} MPH")

                # The Spin Power-Up
                print("\n[ SPIN METRICS ]")
                print(f"Spin Rate: {breaks.get('spinRate')} RPM")
                print(f"Spin Direction (Axis): {breaks.get('spinDirection')} Degrees")

                print("\n--- 🚀 SIMULATING TRAJECTORY ---")
                
                # Statcast expects dict with specific keys for conversion
                # We need to map y0 which is at y=50ft to release_extension
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
                    "pitch_type": "FF", # Fallback if unavailable
                    "p_throws": last_play.get('matchup', {}).get('pitcherHand', {}).get('code', 'R')
                }
                
                try:
                    sim_params = statcast_to_sim_params(statcast_data, spin_method="bsg", accel_method=True)
                    valid_keys = ['x0', 'y0', 'z0', 'v0_mps', 'theta_deg', 'phi_deg', 'backspin_rpm', 'sidespin_rpm', 'wg_rpm', 'batter_hand']
                    pitch_kwargs = {k: v for k, v in sim_params.items() if k in valid_keys}
                    
                    # Batter hand fallback
                    if 'batter_hand' not in pitch_kwargs:
                        pitch_kwargs['batter_hand'] = last_play.get('matchup', {}).get('batterHand', {}).get('code', 'R')
                        
                    pitch = PitchParameters(**pitch_kwargs)
                    env = EnvironmentParameters() # Default environment
                    
                    sim = BallTrajectorySimulator2(integration_method=IntegrationMethod.RK4)
                    sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
                    
                    print(f"Generated {len(sim.trajectory)} trajectory points.")
                    print("First 5 points (x, y, z) in meters:")
                    for p in sim.trajectory[:5]:
                        print(f"  t={p['t']:.3f}s: ({p['x']:.3f}, {p['y']:.3f}, {p['z']:.3f})")
                        
                    if sim.trajectory:
                        last_p = sim.trajectory[-1]
                        print(f"Last point (x, y, z) at t={last_p['t']:.3f}s: ({last_p['x']:.3f}, {last_p['y']:.3f}, {last_p['z']:.3f})")
                except Exception as e:
                    print(f"Failed to simulate trajectory: {e}")

            else:
                print("No pitches thrown yet in this at-bat.")

        except KeyError as e:
            print(f"Glitch in the matrix! Missing expected data key: {e}")
    else:
        print(f"GAME OVER. API returned status code: {response.status_code}")

if __name__ == "__main__":
    fetch_pitch_data()
