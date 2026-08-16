from fastapi.testclient import TestClient
import os
import sys

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from main import app

def test_trajectory_endpoint():
    client = TestClient(app)
    response = client.get("/api/trajectory")
    print(f"Status Code: {response.status_code}")
    print(f"Response JSON: {response.json()}")
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    print("API trajectory response summary:")
    print(f"  Pitcher: {data.get('pitcher')}")
    print(f"  Pitch Type: {data.get('pitch_type')}")
    print(f"  Spin Efficiency (this pitch): {data.get('spin_efficiency')}")
    if data.get('spin_efficiency') is not None:
        print(f"  ({data.get('spin_efficiency')*100:.1f}%)")
    print(f"  Active Spin (rpm): {data.get('active_spin_rpm')}")
    print(f"  Trajectory steps simulated: {len(data.get('trajectory', []))}")
    print(f"  Sim params backspin_rpm: {data.get('sim_params', {}).get('backspin_rpm')}")
    print(f"  Sim params sidespin_rpm: {data.get('sim_params', {}).get('sidespin_rpm')}")
    print(f"  Sim params wg_rpm (gyrospin): {data.get('sim_params', {}).get('wg_rpm')}")

if __name__ == "__main__":
    test_trajectory_endpoint()
