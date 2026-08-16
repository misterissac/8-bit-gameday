import React, { useState, useEffect, useRef, Component } from 'react';
import axios from 'axios';
import { Scene } from './components/Scene';
import './App.css';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          width: '100vw',
          height: '100vh',
          background: '#111',
          color: '#ff6b6b',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'monospace',
          padding: '20px'
        }}>
          <h2>⚠️ Visualization Encountered an Error</h2>
          <pre style={{ background: '#222', padding: '15px', borderRadius: '6px', maxWidth: '800px', overflowX: 'auto' }}>
            {this.state.error?.toString()}
          </pre>
          <button 
            onClick={() => window.location.reload()} 
            style={{ marginTop: '20px', padding: '8px 16px', background: '#0066cc', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const [pitchData, setPitchData] = useState(null);
  const [defaultPitchData, setDefaultPitchData] = useState(null);
  const [compareMode, setCompareMode] = useState(false);
  const [crossingPlane, setCrossingPlane] = useState('mid'); // 'mid' | 'front'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [snapTrigger, setSnapTrigger] = useState(0);
  const [crossings, setCrossings] = useState(null);
  const canvasRef = useRef(null);

  // Draw 2D strike zone on canvas (Gameday-style, catcher's perspective)
  // pX positive = catcher's right = viewer's right (same convention as Gameday).
  // The API's coordinates.x/y are for a different view (field diagram), NOT the strike zone widget.
  useEffect(() => {
    if (!canvasRef.current || !pitchData) return;
    if (pitchData.statcast_px == null || pitchData.statcast_pz == null) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const szTop = pitchData.strike_zone_top || 3.5;
    const szBot = pitchData.strike_zone_bottom || 1.5;
    const plateWidthFt = 17 / 12; // 1.4167 ft

    // Use uniform scale: show the zone with padding, 1:1 aspect ratio
    const zoneH_ft = szTop - szBot;
    const zoneW_ft = plateWidthFt;
    const padding = 0.8; // ft of padding around the zone
    const viewW_ft = zoneW_ft + 2 * padding;
    const viewH_ft = zoneH_ft + 2 * padding;

    // Uniform scale: fit both dimensions, pick the tighter one
    const scale = Math.min(W / viewW_ft, H / viewH_ft);
    const offsetX = (W - viewW_ft * scale) / 2;
    const offsetY = (H - viewH_ft * scale) / 2;

    // Center of view = center of zone
    const zoneCenterX = 0; // pX=0 is center
    const zoneCenterZ = (szTop + szBot) / 2;

    // Map from feet to canvas pixels (uniform scale, catcher's perspective)
    const ftToPixelX = (ft) => offsetX + ((ft - zoneCenterX) + viewW_ft / 2) * scale;
    const ftToPixelY = (ft) => offsetY + (-(ft - zoneCenterZ) + viewH_ft / 2) * scale;

    // Draw zone background
    ctx.fillStyle = 'rgba(30,30,30,1)';
    ctx.fillRect(0, 0, W, H);

    // Draw zone box
    const zoneLeft = ftToPixelX(-plateWidthFt / 2);
    const zoneRight = ftToPixelX(plateWidthFt / 2);
    const zoneTop = ftToPixelY(szTop);
    const zoneBottom = ftToPixelY(szBot);
    const zoneW = zoneRight - zoneLeft;
    const zoneH_px = zoneBottom - zoneTop;

    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(zoneLeft, zoneTop, zoneW, zoneH_px);

    // Inner lines (thirds)
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    const thirdW = zoneW / 3;
    const thirdH = zoneH_px / 3;
    ctx.beginPath();
    // Vertical
    ctx.moveTo(zoneLeft + thirdW, zoneTop); ctx.lineTo(zoneLeft + thirdW, zoneBottom);
    ctx.moveTo(zoneLeft + 2 * thirdW, zoneTop); ctx.lineTo(zoneLeft + 2 * thirdW, zoneBottom);
    // Horizontal
    ctx.moveTo(zoneLeft, zoneTop + thirdH); ctx.lineTo(zoneRight, zoneTop + thirdH);
    ctx.moveTo(zoneLeft, zoneTop + 2 * thirdH); ctx.lineTo(zoneRight, zoneTop + 2 * thirdH);
    ctx.stroke();

    // Draw pitch location dot (blue = mid-plate crossing, 2026 ABS convention)
    const dotPx = pitchData.statcast_px_mid ?? pitchData.statcast_px;
    const dotPz = pitchData.statcast_pz_mid ?? pitchData.statcast_pz;
    const dotX = ftToPixelX(dotPx);
    const dotY = ftToPixelY(dotPz);
    ctx.fillStyle = '#00aaff';
    ctx.beginPath();
    ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Labels
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '9px monospace';
    ctx.fillText(`pX: ${dotPx.toFixed(2)} pZ: ${dotPz.toFixed(2)}`, 4, H - 4);
  }, [pitchData]);

  const fetchTrajectory = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await axios.get('http://localhost:8000/api/trajectory');
      setPitchData(response.data);
      // Clear compare data when refreshing in normal mode
      if (!compareMode) setDefaultPitchData(null);
    } catch (err) {
      console.error("Failed to fetch trajectory", err);
      setError("Failed to fetch trajectory data from backend.");
    } finally {
      setLoading(false);
    }
  };

  const fetchCompare = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await axios.get('http://localhost:8000/api/trajectory/compare');
      setPitchData(response.data.live);
      setDefaultPitchData(response.data.default);
    } catch (err) {
      console.error("Failed to fetch comparison", err);
      setError("Failed to fetch comparison data from backend.");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleCompare = () => {
    const next = !compareMode;
    setCompareMode(next);
    if (next) {
      fetchCompare();
    } else {
      setDefaultPitchData(null);
      fetchTrajectory();
    }
  };

  useEffect(() => {
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
        fontFamily: 'monospace',
        minWidth: '250px'
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px'
        }}>
          <h2 style={{ margin: '0' }}>8-Bit Pitch</h2>
          <button 
            onClick={compareMode ? fetchCompare : fetchTrajectory} 
            disabled={loading}
            style={{ padding: '4px 8px', cursor: 'pointer', background: '#444', color: 'white', border: 'none', borderRadius: '4px' }}
          >
            Refresh
          </button>
        </div>
        
        <button 
          onClick={() => setSnapTrigger(prev => prev + 1)}
          style={{ width: '100%', padding: '6px 8px', marginBottom: '6px', cursor: 'pointer', background: '#0066cc', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}
        >
          Snap to Strike Zone
        </button>

        {/* ── ENV TOGGLE ─────────────────────────────────── */}
        <button
          id="env-toggle-btn"
          onClick={handleToggleCompare}
          disabled={loading}
          title={compareMode
            ? 'Currently comparing live weather vs default — click to return to live-only mode'
            : 'Overlay a second (default env) trajectory to compare against live weather'}
          style={{
            width: '100%',
            padding: '7px 8px',
            marginBottom: '6px',
            cursor: 'pointer',
            background: compareMode
              ? 'linear-gradient(90deg, #7722bb 0%, #cc44ff 100%)'
              : 'linear-gradient(90deg, #1a6640 0%, #22aa55 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontWeight: 'bold',
            fontSize: '11px',
            letterSpacing: '0.03em',
            transition: 'background 0.3s',
            boxShadow: compareMode ? '0 0 8px #cc44ff88' : '0 0 8px #22aa5544',
          }}
        >
          {compareMode ? '🟣 Compare ON — Live vs Default' : '🟢 Live Weather Mode'}
        </button>

        {/* ── CROSSING PLANE TOGGLE ─────────────────────── */}
        <button
          id="crossing-plane-btn"
          onClick={() => setCrossingPlane(p => p === 'mid' ? 'front' : 'mid')}
          title={crossingPlane === 'mid'
            ? 'Dots are at mid-plate (ABS convention) — click to switch to front-of-plate'
            : 'Dots are at front-of-plate — click to switch to mid-plate (ABS convention)'}
          style={{
            width: '100%',
            padding: '6px 8px',
            marginBottom: '10px',
            cursor: 'pointer',
            background: crossingPlane === 'mid'
              ? 'linear-gradient(90deg, #1a3a6a 0%, #1e6abf 100%)'
              : 'linear-gradient(90deg, #4a2000 0%, #cc6600 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontWeight: 'bold',
            fontSize: '11px',
            letterSpacing: '0.03em',
            transition: 'background 0.3s',
          }}
        >
          {crossingPlane === 'mid' ? '📍 Plane: Mid-Plate (ABS)' : '📍 Plane: Front-of-Plate'}
        </button>

        {loading && <p>Loading data...</p>}
        {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
        {pitchData && !loading && (
          <div>
            <p><strong>Date:</strong> {pitchData.game_date}</p>
            <p><strong>Pitches Thrown:</strong> {pitchData.total_pitches}</p>
            <hr style={{ borderColor: '#444', margin: '10px 0' }} />
            <p><strong>Pitcher:</strong> {pitchData.pitcher}</p>
            <p><strong>Type:</strong> {pitchData.pitch_type}</p>
            <p><strong>Speed:</strong> {pitchData.speed_mph != null ? pitchData.speed_mph.toFixed(1) : '—'} MPH</p>
            <hr style={{ borderColor: '#444', margin: '10px 0' }} />
            <p style={{ margin: '5px 0' }}><strong>Backspin:</strong> {Math.round(pitchData.sim_params?.backspin_rpm || 0)} RPM</p>
            <p style={{ margin: '5px 0' }}><strong>Sidespin:</strong> {Math.round(pitchData.sim_params?.sidespin_rpm || 0)} RPM</p>
            <p style={{ margin: '5px 0' }}><strong>Gyrospin:</strong> {Math.round(pitchData.sim_params?.wg_rpm || 0)} RPM</p>
            
            {pitchData.statcast_px != null && pitchData.statcast_pz != null && (
              <div style={{ marginTop: '10px', padding: '8px', background: 'rgba(0,100,200,0.3)', borderRadius: '4px', fontSize: '11px' }}>
                <p style={{ margin: '2px 0' }}><strong>pX (mid):</strong> {(pitchData.statcast_px_mid ?? pitchData.statcast_px) != null ? (pitchData.statcast_px_mid ?? pitchData.statcast_px).toFixed(3) : '—'} ft</p>
                <p style={{ margin: '2px 0' }}><strong>pZ (mid):</strong> {(pitchData.statcast_pz_mid ?? pitchData.statcast_pz) != null ? (pitchData.statcast_pz_mid ?? pitchData.statcast_pz).toFixed(3) : '—'} ft</p>
                <p style={{ margin: '2px 0', opacity: 0.6 }}><strong>pX (front):</strong> {pitchData.statcast_px != null ? pitchData.statcast_px.toFixed(3) : '—'} ft</p>
                <p style={{ margin: '2px 0', opacity: 0.6 }}><strong>pZ (front):</strong> {pitchData.statcast_pz != null ? pitchData.statcast_pz.toFixed(3) : '—'} ft</p>
                <p style={{ margin: '2px 0' }}><strong>Zone:</strong> [{(pitchData.strike_zone_bottom || 1.5).toFixed(2)}, {(pitchData.strike_zone_top || 3.5).toFixed(2)}] ft</p>
              </div>
            )}

            {/* ── ENV COMPARISON CARD ─────────────────────────── */}
            {compareMode && defaultPitchData && (() => {
              const live = pitchData.environment || {};
              const def  = defaultPitchData.environment || {};
              const rows = [
                { label: 'Temp', live: `${live.temp_F ?? '—'}°F`, def: `${def.temp_F ?? '—'}°F`,
                  diff: live.temp_F != null && def.temp_F != null ? (live.temp_F - def.temp_F).toFixed(1) : null, unit: '°F' },
                { label: 'Elevation', live: `${live.elev_ft ?? '—'} ft`, def: `${def.elev_ft ?? '—'} ft`,
                  diff: live.elev_ft != null && def.elev_ft != null ? (live.elev_ft - def.elev_ft).toFixed(0) : null, unit: ' ft' },
                { label: 'Humidity', live: `${live.relative_humidity_pct ?? '—'}%`, def: `${def.relative_humidity_pct ?? '—'}%`,
                  diff: live.relative_humidity_pct != null && def.relative_humidity_pct != null ? (live.relative_humidity_pct - def.relative_humidity_pct).toFixed(0) : null, unit: '%' },
                { label: 'Condition', live: live.condition ?? '—', def: def.condition ?? '—', diff: null },
                { label: 'Venue', live: live.venue_name ?? '—', def: def.venue_name ?? '—', diff: null },
              ];
              return (
                <div style={{ marginTop: '10px', padding: '8px', background: 'rgba(100,0,180,0.25)', border: '1px solid #cc44ff55', borderRadius: '6px', fontSize: '10px' }}>
                  <p style={{ margin: '0 0 6px 0', fontWeight: 'bold', color: '#cc44ff', fontSize: '11px' }}>🔬 Env Comparison</p>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ opacity: 0.6 }}>
                        <th style={{ textAlign: 'left', paddingBottom: '4px' }}>Param</th>
                        <th style={{ textAlign: 'right', color: '#ff6666' }}>🔴 Live</th>
                        <th style={{ textAlign: 'right', color: '#cc44ff' }}>🟣 Default</th>
                        <th style={{ textAlign: 'right' }}>Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.label} style={{ borderTop: '1px solid #ffffff11' }}>
                          <td style={{ paddingTop: '3px', opacity: 0.75 }}>{r.label}</td>
                          <td style={{ textAlign: 'right', color: '#ff8888', paddingTop: '3px' }}>{r.live}</td>
                          <td style={{ textAlign: 'right', color: '#cc88ff', paddingTop: '3px' }}>{r.def}</td>
                          <td style={{ textAlign: 'right', paddingTop: '3px', color: r.diff != null && parseFloat(r.diff) !== 0 ? '#ffdd44' : '#888' }}>
                            {r.diff != null ? (parseFloat(r.diff) > 0 ? `+${r.diff}` : r.diff) + r.unit : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={{ margin: '6px 0 0 0', opacity: 0.55, fontSize: '9px' }}>
                    🔴 red line = live weather &nbsp;|&nbsp; 🟣 purple = default baseline
                  </p>
                </div>
              );
            })()}
            
            <details style={{ marginTop: '10px', fontSize: '10px' }}>
              <summary style={{ cursor: 'pointer', opacity: 0.8 }}>Simulator Params</summary>
              <pre style={{ 
                background: 'rgba(0,0,0,0.5)', 
                padding: '5px', 
                borderRadius: '4px',
                overflowX: 'auto',
                maxHeight: '150px',
                overflowY: 'auto'
              }}>
                {JSON.stringify(pitchData.sim_params, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>

      {/* 2D Strike Zone Mini-Map (Gameday-style, for debugging) */}
      {pitchData && pitchData.statcast_px != null && pitchData.statcast_pz != null && (
        <div style={{
          position: 'absolute',
          bottom: 20,
          left: 20,
          zIndex: 10,
          background: 'rgba(0,0,0,0.8)',
          padding: '10px',
          borderRadius: '8px',
          fontFamily: 'monospace',
          color: 'white',
          fontSize: '10px',
        }}>
          <p style={{ margin: '0 0 5px 0', fontWeight: 'bold' }}>2D Zone (Gameday-style)</p>
          <canvas 
            ref={canvasRef}
            width={160}
            height={200}
            style={{ border: '1px solid #333', borderRadius: '4px' }}
          />
        </div>
      )}

      {/* ── CROSSING POSITIONS HUD ─────────────────────────── */}
      {crossings && (
        <div style={{
          position: 'absolute',
          top: 20,
          right: 20,
          zIndex: 10,
          background: 'rgba(0,0,0,0.75)',
          color: 'white',
          padding: '10px 14px',
          borderRadius: '8px',
          fontFamily: 'monospace',
          fontSize: '11px',
          minWidth: '200px',
          backdropFilter: 'blur(6px)',
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          <p style={{ margin: '0 0 8px 0', fontWeight: 'bold', fontSize: '12px', opacity: 0.9 }}>
            📍 Crossing @ {crossingPlane === 'mid' ? 'Mid-Plate' : 'Front-of-Plate'}
          </p>
          {[
            { label: '🔵 Statcast', color: '#00aaff', pt: crossings.blue },
            { label: '🔴 Sim (live)', color: '#ff6666', pt: crossings.red },
            { label: '🟣 Sim (default)', color: '#cc88ff', pt: crossings.purple },
          ].map(({ label, color, pt }) => (
            <div key={label} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.08)'
            }}>
              <span style={{ color, fontWeight: 'bold', marginRight: '10px' }}>{label}</span>
              {pt && pt.x != null && pt.z != null
                ? <span style={{ opacity: 0.9 }}>x&nbsp;{pt.x.toFixed(3)}&nbsp;m &nbsp; z&nbsp;{pt.z.toFixed(3)}&nbsp;m</span>
                : <span style={{ opacity: 0.4 }}>—</span>
              }
            </div>
          ))}
        </div>
      )}

      <Scene pitchData={pitchData} defaultPitchData={compareMode ? defaultPitchData : null} snapTrigger={snapTrigger} crossingPlane={crossingPlane} onCrossings={setCrossings} />
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

export default App;
