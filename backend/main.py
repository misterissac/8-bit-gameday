import os
import sys
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Add trajectory simulator paths relative to this backend script
# The simulator is in the parent directory
parent_dir = os.path.dirname(os.path.dirname(__file__))
sim_dir = os.path.join(parent_dir, "skill-vis:MyTrajectorySimulator-main")
sys.path.insert(0, sim_dir)
sys.path.insert(0, os.path.join(sim_dir, "API"))

from MyBallTrajectorySim import BallTrajectorySimulator2, IntegrationMethod, PitchParameters, EnvironmentParameters
from statcast_to_sim import statcast_to_sim_params

app = FastAPI()

# Allow CORS for local frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In production, restrict this!
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Using the placeholder gamePk
GAME_PK = '823425'
URL = f"https://statsapi.mlb.com/api/v1.1/game/{GAME_PK}/feed/live"

@app.get("/api/trajectory")
def get_trajectory():
    print(f"LOADING LEVEL... Polling game {GAME_PK}")
    response = requests.get(URL)

    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch from MLB API")

    data = response.json()

    try:
        all_plays = data['liveData']['plays']['allPlays']
        if not all_plays:
            raise HTTPException(status_code=404, detail="Game hasn't started yet!")

        # Grab the most recent play
        last_play = all_plays[-1]
        play_events = last_play.get('playEvents', [])

        # Filter the events to find actual pitches
        pitches = [event for event in play_events if event.get('isPitch')]

        if not pitches:
            raise HTTPException(status_code=404, detail="No pitches thrown yet in this at-bat.")

        # Grab the last pitch thrown
        last_pitch = pitches[-1]
        pitch_data = last_pitch.get('pitchData', {})

        coordinates = pitch_data.get('coordinates', {})
        breaks = pitch_data.get('breaks', {})

        y0_ft = coordinates.get('y0', 50.0)
        release_ext = 60.5 - y0_ft
        
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
            "release_spin_rate": breaks.get('spinRate'),
            "spin_axis": breaks.get('spinDirection'),
            "pitch_type": "FF", # Fallback if unavailable
            "p_throws": last_play.get('matchup', {}).get('pitcherHand', {}).get('code', 'R')
        }
        
        sim_params = statcast_to_sim_params(statcast_data, spin_method="bsg", accel_method=False)
        valid_keys = ['x0', 'y0', 'z0', 'v0_mps', 'theta_deg', 'phi_deg', 'backspin_rpm', 'sidespin_rpm', 'wg_rpm', 'batter_hand']
        pitch_kwargs = {k: v for k, v in sim_params.items() if k in valid_keys}
        
        # Batter hand fallback
        if 'batter_hand' not in pitch_kwargs:
            pitch_kwargs['batter_hand'] = last_play.get('matchup', {}).get('batterHand', {}).get('code', 'R')
            
        pitch = PitchParameters(**pitch_kwargs)
        env = EnvironmentParameters() # Default environment
        
        sim = BallTrajectorySimulator2(integration_method=IntegrationMethod.RK4)
        sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
        
        # Build the payload
        pitcher = last_play.get('matchup', {}).get('pitcher', {}).get('fullName', 'N/A')
        pitch_type_code = last_pitch.get('details', {}).get('type', {}).get('code', 'UNK')
        start_speed = coordinates.get('startSpeed', 0)

        # The trajectory is a list of dicts with x, y, z, t etc.
        
        return {
            "success": True,
            "pitcher": pitcher,
            "pitch_type": pitch_type_code,
            "speed_mph": start_speed,
            "trajectory": sim.trajectory
        }

    except KeyError as e:
        raise HTTPException(status_code=500, detail=f"Data parsing error: {e}")
    except Exception as e:
         raise HTTPException(status_code=500, detail=f"Simulation failed: {e}")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
