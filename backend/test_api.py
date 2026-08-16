import requests

GAME_PK = '824401'
URL = f"https://statsapi.mlb.com/api/v1.1/game/{GAME_PK}/feed/live"
response = requests.get(URL)
data = response.json()
for play in data['liveData']['plays']['allPlays']:
    for event in play.get('playEvents', []):
        if event.get('isPitch'):
            coord = event['pitchData']['coordinates']
            print(f"pX: {coord.get('pX')}, x0: {coord.get('x0')}, vX0: {coord.get('vX0')}, aX: {coord.get('aX')}")
            break
    break
