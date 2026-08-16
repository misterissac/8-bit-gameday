import requests
import json

def fetch_pitch_debug(game_pk='823425'):
    url = f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"
    print(f"Fetching data for game {game_pk}...\n")
    
    response = requests.get(url)
    if response.status_code != 200:
        print(f"Failed to fetch data, status code: {response.status_code}")
        return

    data = response.json()
    
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

        if not pitches:
            print("No pitches thrown yet in this at-bat.")
            return
            
        last_pitch = pitches[-1]
        pitch_data = last_pitch.get('pitchData', {})
        
        coordinates = pitch_data.get('coordinates', {})
        breaks = pitch_data.get('breaks', {})
        
        # Extract Pitching Info
        pitcher = last_play.get('matchup', {}).get('pitcher', {}).get('fullName', 'N/A')
        batter = last_play.get('matchup', {}).get('batter', {}).get('fullName', 'N/A')
        pitch_type = last_pitch.get('details', {}).get('type', {}).get('description', 'Unknown')
        
        print(f"Pitcher: {pitcher} vs Batter: {batter}")
        print(f"Pitch Type: {pitch_type}")
        print("-" * 40)
        
        # 1. Speed
        start_speed = pitch_data.get('startSpeed')
        end_speed = pitch_data.get('endSpeed')
        print("--- SPEED ---")
        print(f"Start Speed: {start_speed} mph")
        print(f"End Speed:   {end_speed} mph\n")
        
        # 2. Release Position
        x0 = coordinates.get('x0')
        y0 = coordinates.get('y0')
        z0 = coordinates.get('z0')
        print("--- RELEASE POSITION ---")
        print(f"x0: {x0} ft")
        print(f"y0: {y0} ft")
        print(f"z0: {z0} ft\n")
        
        # 3. Release Velocity (v0)
        vx0 = coordinates.get('vX0')
        vy0 = coordinates.get('vY0')
        vz0 = coordinates.get('vZ0')
        print("--- RELEASE VELOCITY (v0) ---")
        print(f"vX0: {vx0} ft/s")
        print(f"vY0: {vy0} ft/s")
        print(f"vZ0: {vz0} ft/s\n")
        
        # 4. Acceleration
        ax = coordinates.get('aX')
        ay = coordinates.get('aY')
        az = coordinates.get('aZ')
        print("--- ACCELERATION ---")
        print(f"aX: {ax} ft/s^2")
        print(f"aY: {ay} ft/s^2")
        print(f"aZ: {az} ft/s^2\n")
        
        # 5. Spin Components
        spin_rate = breaks.get('spinRate')
        spin_axis = breaks.get('spinDirection')
        print("--- SPIN COMPONENTS ---")
        print(f"Spin Rate: {spin_rate} rpm")
        print(f"Spin Axis (Direction): {spin_axis} degrees\n")
        
        # 6. Position at Plate
        px = coordinates.get('pX')
        pz = coordinates.get('pZ')
        print("--- POSITION AT PLATE ---")
        print(f"pX (horizontal): {px} ft")
        print(f"pZ (vertical):   {pz} ft\n")
        
        # 7. Breaks
        break_y = breaks.get('breakY')
        break_angle = breaks.get('breakAngle')
        break_length = breaks.get('breakLength')
        print("--- BREAKS ---")
        print(f"Break Y: {break_y}")
        print(f"Break Angle: {break_angle}")
        print(f"Break Length: {break_length}\n")

    except KeyError as e:
        print(f"Missing expected data key in API response: {e}")

if __name__ == "__main__":
    import sys
    game = sys.argv[1] if len(sys.argv) > 1 else '823425'
    fetch_pitch_debug(game)
