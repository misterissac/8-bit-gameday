import { useState, useEffect } from 'react';
import axios from 'axios';
import { Scene } from './components/Scene';
import './App.css';

function App() {
  const [pitchData, setPitchData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchTrajectory = async () => {
      try {
        setLoading(true);
        // Ensure your FastAPI backend is running on port 8000
        const response = await axios.get('http://localhost:8000/api/trajectory');
        setPitchData(response.data);
      } catch (err) {
        console.error("Failed to fetch trajectory", err);
        setError("Failed to fetch trajectory data from backend.");
      } finally {
        setLoading(false);
      }
    };

    fetchTrajectory();
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <div style={{
        position: 'absolute',
        top: 20,
        left: 20,
        zIndex: 10,
        background: 'rgba(0,0,0,0.7)',
        color: 'white',
        padding: '10px 20px',
        borderRadius: '8px',
        fontFamily: 'monospace'
      }}>
        <h2>8-Bit Pitch Visualizer</h2>
        {loading && <p>Loading data...</p>}
        {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
        {pitchData && (
          <div>
            <p>Pitcher: {pitchData.pitcher}</p>
            <p>Type: {pitchData.pitch_type}</p>
            <p>Speed: {pitchData.speed_mph.toFixed(1)} MPH</p>
          </div>
        )}
      </div>

      <Scene trajectoryData={pitchData ? pitchData.trajectory : null} />
    </div>
  );
}

export default App;
