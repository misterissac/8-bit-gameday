import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';

const GAME_STATE_URL = 'http://localhost:8000/api/game-state';
const GAME_STATUS_URL = 'http://localhost:8000/api/game-status';
const BOX_SCORE_URL = 'http://localhost:8000/api/box-score';
const POLL_MS = 1000;

const dash = (v) => (v == null || v === '' ? '—' : v);

const statusSnapshot = (data) => ({
  gameState: data?.gameState ?? null,
  isLive: data?.isLive ?? null,
  pitcher: data?.pitcher ?? null,
  pitcherId: data?.pitcherId ?? null,
});

// Hover popover: renders a small season-stats card above the wrapped name.
// Defined at module level (not inside Scorebug) so its component identity is
// stable across the scorebug's 1s polling re-renders; otherwise React would
// unmount/remount it every poll and reset the hover state.
function HoverStat({ children, rows }) {
  const [open, setOpen] = useState(false);
  const hasStats = rows.some(([, v]) => v !== '—');
  return (
    <span
      style={{ position: 'relative', borderBottom: hasStats ? '1px dotted rgba(255,255,255,0.35)' : 'none', cursor: hasStats ? 'help' : 'default' }}
      onMouseEnter={() => hasStats && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <span style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, zIndex: 40,
          background: '#0a0e14', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 6,
          padding: '6px 9px', fontSize: 11, lineHeight: 1.7, whiteSpace: 'nowrap',
          boxShadow: '0 4px 14px rgba(0,0,0,0.55)',
        }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
              <span style={{ color: '#9aa' }}>{label}</span>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>{value}</span>
            </div>
          ))}
        </span>
      )}
    </span>
  );
}

// One team's batting + pitching tables for the box-score panel.
const cell = { padding: '2px 7px', textAlign: 'right', borderTop: '1px solid rgba(255,255,255,0.07)' };
const th = { padding: '2px 7px', fontWeight: 'normal' };

// Classic scoreboard team line shown at the top of the box-score panel:
// runs scored in each inning (X for innings not yet played, which the MLB
// API leaves as null), then the running R/H/E totals.
function Linescore({ data }) {
  const ls = data?.linescore;
  if (!ls) return null;
  const byNum = new Map((ls.innings || []).map((i) => [i.num, i]));
  const maxInning = Math.max(9, ls.currentInning || 0, ...Array.from(byNum.keys()));
  const nums = Array.from({ length: maxInning }, (_, k) => k + 1);
  const center = { padding: '1px 6px', textAlign: 'center' };
  const played = (side, n) => {
    const runs = byNum.get(n)?.[side]?.runs;
    return runs == null
      ? <span style={{ color: '#556' }}>X</span>
      : runs;
  };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, lineHeight: 1.45, marginBottom: 8 }}>
      <thead>
        <tr style={{ color: '#788', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <th style={{ ...th, textAlign: 'left' }} />
          {nums.map((n) => (
            <th
              key={n}
              style={{ ...th, textAlign: 'center', color: n <= (ls.currentInning || 0) ? '#9aa' : '#556' }}
            >
              {n}
            </th>
          ))}
          <th style={{ ...th, textAlign: 'center', color: '#9aa' }}>R</th>
          <th style={{ ...th, textAlign: 'center', color: '#9aa' }}>H</th>
          <th style={{ ...th, textAlign: 'center', color: '#9aa' }}>E</th>
        </tr>
      </thead>
      <tbody>
        {['away', 'home'].map((side) => {
          const t = data.teams?.[side];
          const totals = ls.teams?.[side] || {};
          return (
            <tr key={side}>
              <td style={{ padding: '1px 6px', textAlign: 'left', fontWeight: 'bold', letterSpacing: '0.06em' }}>
                {t?.abbreviation ?? side.toUpperCase()}
              </td>
              {nums.map((n) => (
                <td key={n} style={center}>{played(side, n)}</td>
              ))}
              <td style={{ ...center, fontWeight: 'bold' }}>{dash(totals.runs)}</td>
              <td style={center}>{dash(totals.hits)}</td>
              <td style={center}>{dash(totals.errors)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TeamBox({ team, color }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, lineHeight: 1.35 }}>
        <thead>
          <tr style={{ color: '#889' }}>
            <th style={{ ...th, textAlign: 'left' }}>BATTERS</th>
            <th style={th}>AB</th><th style={th}>R</th><th style={th}>H</th>
            <th style={th}>RBI</th><th style={th}>BB</th><th style={th}>SO</th><th style={th}>AVG</th>
          </tr>
        </thead>
        <tbody>
          {team.batting.map((p) => (
            <tr key={p.id}>
              <td style={{ ...cell, textAlign: 'left', whiteSpace: 'nowrap' }}>
                {p.name} <span style={{ color: '#788' }}>{p.position}</span>
              </td>
              <td style={cell}>{dash(p.ab)}</td>
              <td style={cell}>{dash(p.r)}</td>
              <td style={cell}>{dash(p.h)}</td>
              <td style={cell}>{dash(p.rbi)}</td>
              <td style={cell}>{dash(p.bb)}</td>
              <td style={cell}>{dash(p.so)}</td>
              <td style={{ ...cell, color }}>{dash(p.avg)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, lineHeight: 1.35, marginTop: 6 }}>
        <thead>
          <tr style={{ color: '#889' }}>
            <th style={{ ...th, textAlign: 'left' }}>PITCHERS</th>
            <th style={th}>IP</th><th style={th}>H</th><th style={th}>R</th><th style={th}>ER</th>
            <th style={th}>BB</th><th style={th}>SO</th><th style={th}>ERA</th><th style={th}>WHIP</th>
          </tr>
        </thead>
        <tbody>
          {team.pitching.map((p) => (
            <tr key={p.id}>
              <td style={{ ...cell, textAlign: 'left', whiteSpace: 'nowrap' }}>{p.name}</td>
              <td style={cell}>{dash(p.ip)}</td>
              <td style={cell}>{dash(p.h)}</td>
              <td style={cell}>{dash(p.r)}</td>
              <td style={cell}>{dash(p.er)}</td>
              <td style={cell}>{dash(p.bb)}</td>
              <td style={cell}>{dash(p.so)}</td>
              <td style={{ ...cell, color }}>{dash(p.era)}</td>
              <td style={{ ...cell, color }}>{dash(p.whip)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Broadcast-style scorebug HUD (bottom right of the app).
 *
 * Polls the backend /api/game-state endpoint (which reads the MLB live feed)
 * and renders a TV-style scoreboard: teams + score, inning/half, ball-strike
 * count, occupied bases, outs, the current pitcher/batter matchup (with the
 * batter's game line and season-stats hover popovers), and pitch totals.
 * Re-fetches immediately whenever `refreshKey` changes (the Refresh button in
 * the left panel).
 *
 * While `frozen` (a pitch is loaded and animating/replaying, and its outcome
 * would spoil the scoreboard), numeric polling is suspended and the current
 * state is held. A lightweight status poll still updates delay/review/pitching
 * change notices. The scorebug re-fetches once per pitch via `outcomeRefresh` when the
 * BALL/STRIKE/HIT/RUN/OUT indicator is revealed, and on demand via
 * `refreshKey` (the Refresh button / game switch). A frozen `stateOverride`
 * can commit the state captured for the pitch that just finished, preventing
 * a later feed update from revealing multiple queued plays at once.
 *
 * A "BOX SCORE" button fetches /api/box-score on demand and shows both teams'
 * full batting and pitching lines in a panel anchored above the scorebug.
 */
export function Scorebug({ refreshKey = 0, outcomeRefresh = 0, gamePk = null, frozen = false, stateOverride = null }) {
  const rootRef = useRef(null);
  const [state, setState] = useState(null);
  // Status is intentionally separate from the frozen numeric scoreboard. It
  // can change during a pitch animation (delay, review, pitching change)
  // without revealing a newer count or score.
  const [liveStatus, setLiveStatus] = useState(null);
  const [boxOpen, setBoxOpen] = useState(false);
  const [boxData, setBoxData] = useState(null);
  const [boxLoading, setBoxLoading] = useState(false);
  const [boxError, setBoxError] = useState(null);
  const [boxSide, setBoxSide] = useState('away');
  const [panelMaxH, setPanelMaxH] = useState(0);

  const fetchState = useCallback(async () => {
    try {
      const url = gamePk ? `${GAME_STATE_URL}?game_pk=${gamePk}` : GAME_STATE_URL;
      const res = await axios.get(url);
      setState(res.data);
      setLiveStatus(statusSnapshot(res.data));
    } catch (err) {
      console.error('Failed to fetch game state', err);
    }
  }, [gamePk]);

  // While the pitch/count snapshot is frozen, keep polling only the status
  // fields. The response is never assigned to `state`, so score/count/bases
  // remain locked until the animation outcome commits its own snapshot.
  const fetchStatus = useCallback(async () => {
    try {
      const url = gamePk ? `${GAME_STATUS_URL}?game_pk=${gamePk}` : GAME_STATUS_URL;
      const res = await axios.get(url);
      setLiveStatus(statusSnapshot(res.data));
    } catch (err) {
      console.error('Failed to fetch live game status', err);
    }
  }, [gamePk]);

  useEffect(() => {
    if (!frozen) return;
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(id);
  }, [fetchStatus, frozen]);

  useEffect(() => {
    setLiveStatus(null);
  }, [gamePk]);

  useEffect(() => {
    if (!frozen) {
      fetchState();
      const id = setInterval(fetchState, POLL_MS);
      return () => clearInterval(id);
    }
    return undefined;
  }, [fetchState, frozen]);

  // Manual Refresh button (deliberate user action, so allowed even while
  // frozen) and game switches, which also bump refreshKey.
  useEffect(() => {
    if (refreshKey > 0) fetchState();
  }, [refreshKey, fetchState]);

  // Outcome-triggered refresh: re-fetch once when the pitch/play resolves
  // (BALL/STRIKE at the plate, or HIT/RUN/OUT after the play) so the count,
  // outs, and score update the moment the indicator shows — even though the
  // scorebug stays frozen for the replay.
  useEffect(() => {
    // A frozen snapshot is authoritative for the pitch that just finished;
    // fetching the already-advanced live feed here would only update hidden
    // internal state and risks leaking multiple queued results on the next
    // unfreeze. If there is no snapshot (or replay has unfrozen the HUD), use
    // the endpoint as the fallback.
    if (outcomeRefresh > 0 && (!frozen || !stateOverride)) fetchState();
  }, [outcomeRefresh, fetchState, frozen, stateOverride]);

  // Keep the box-score panel within the window: cap its height to the space
  // between the top of the viewport and the scorebug, so it's fully visible.
  useEffect(() => {
    if (!boxOpen) return;
    const update = () => {
      if (rootRef.current) {
        setPanelMaxH(Math.max(120, rootRef.current.getBoundingClientRect().top - 12));
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [boxOpen]);

  const toggleBox = useCallback(async () => {
    const next = !boxOpen;
    setBoxOpen(next);
    if (!next) return;
    // Default to the team currently at bat so the most relevant box is shown.
    setBoxSide(state?.inning?.isTop ? 'away' : 'home');
    setBoxLoading(true);
    setBoxError(null);
    try {
      const url = gamePk ? `${BOX_SCORE_URL}?game_pk=${gamePk}` : BOX_SCORE_URL;
      const res = await axios.get(url);
      setBoxData(res.data);
    } catch (err) {
      console.error('Failed to fetch box score', err);
      setBoxError('Failed to load box score');
    } finally {
      setBoxLoading(false);
    }
  }, [boxOpen, gamePk, state]);

  const displayState = frozen && stateOverride ? stateOverride : state;
  if (!displayState || !displayState.success) return null;

  const {
    teams, score, inning, outs, count, bases, pitcher, pitcherId, batter, batterLine,
    batterSeason, pitcherSeason, pitchesThrown, gameState, isLive, venue,
  } = displayState;
  const awayScore = score?.away?.runs ?? '—';
  const homeScore = score?.home?.runs ?? '—';
  const baseSet = new Set(bases || []);
  const outsVal = outs ?? 0;
  // Bottom-left game status: show it whenever it's meaningful (delays, umpire
  // review, pitcher change, final, ...), but hide the generic "In Progress"
  // during normal live play — the LIVE dot already says that.
  const liveGameState = liveStatus?.gameState ?? gameState;
  const liveIsLive = liveStatus?.isLive ?? isLive;
  const pitcherChanged = Boolean(
    frozen &&
    liveStatus?.pitcher &&
    pitcher &&
    (
      liveStatus.pitcherId != null && pitcherId != null
        ? liveStatus.pitcherId !== pitcherId
        : liveStatus.pitcher !== pitcher
    )
  );
  const statusLabel = pitcherChanged
    ? 'Pitching Change'
    : liveGameState && liveGameState !== 'In Progress'
      ? liveGameState
      : null;
  const isStatusNotice =
    /Delay|Review|Change/i.test(statusLabel || '');
  const countLabel = count?.balls != null && count?.strikes != null
    ? `${count.balls}–${count.strikes}`
    : '—';

  // "▼ 10th" / "▲ 7th" (down = bottom of the inning, up = top); "Mid 7th" /
  // "End 7th" between innings; plain ordinal when game over.
  const inningLabel =
    !inning?.ordinal ? '—'
    : inning.state === 'Middle' ? `Mid ${inning.ordinal}`
    : inning.state === 'End' ? `End ${inning.ordinal}`
    : `${inning.isTop ? '▲' : '▼'} ${inning.ordinal}`;

  const batterRows = [
    ['AVG', dash(batterSeason?.avg)],
    ['OBP', dash(batterSeason?.obp)],
    ['SLG', dash(batterSeason?.slg)],
    ['HR', dash(batterSeason?.hr)],
    ['RBI', dash(batterSeason?.rbi)],
  ];
  const pitcherRows = [
    ['ERA', dash(pitcherSeason?.era)],
    ['WHIP', dash(pitcherSeason?.whip)],
    ['W–L', `${dash(pitcherSeason?.wins)}–${dash(pitcherSeason?.losses)}`],
    ['SO', dash(pitcherSeason?.so)],
    ['IP', dash(pitcherSeason?.ip)],
  ];

  const dot = (occupied) => ({
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: occupied ? '#ffd166' : 'transparent',
    border: `1.5px solid ${occupied ? '#ffd166' : 'rgba(255,255,255,0.3)'}`,
    boxShadow: occupied ? '0 0 6px rgba(255,209,102,0.7)' : 'none',
  });

  return (
    <div ref={rootRef} style={{
      position: 'absolute',
      bottom: 20,
      right: 20,
      zIndex: 10,
      background: 'linear-gradient(180deg, rgba(10,14,20,0.92), rgba(6,9,14,0.92))',
      border: '1px solid rgba(255,255,255,0.18)',
      borderRadius: 10,
      fontFamily: 'monospace',
      color: '#fff',
      padding: '10px 14px 8px',
      backdropFilter: 'blur(6px)',
      boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
      userSelect: 'none',
    }}>
      {/* ── Box score button (top right, on the inning/count row) ── */}
      <button
        onClick={toggleBox}
        style={{
          position: 'absolute',
          top: 10,
          right: 14,
          zIndex: 15,
          background: boxOpen ? 'rgba(255,209,102,0.18)' : 'rgba(255,255,255,0.06)',
          border: `1px solid ${boxOpen ? 'rgba(255,209,102,0.6)' : 'rgba(255,255,255,0.25)'}`,
          color: boxOpen ? '#ffd166' : '#ccc',
          borderRadius: 4,
          padding: '2px 8px',
          fontSize: 10,
          letterSpacing: '0.12em',
          cursor: 'pointer',
          fontFamily: 'monospace',
        }}
      >
        {boxOpen ? 'CLOSE' : 'BOX'}
      </button>

      {/* ── Live indicator (top left, on the inning/count row) ── */}
      {liveIsLive && (
        <div style={{
          position: 'absolute',
          top: 10,
          left: 14,
          zIndex: 15,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 10,
          fontWeight: 'bold',
          letterSpacing: '0.14em',
          color: '#ff5252',
        }}>
          <span className="live-dot" style={{
            width: 7, height: 7, borderRadius: '50%',
            background: '#ff5252', boxShadow: '0 0 6px rgba(255,82,82,0.9)',
          }} />
          LIVE
        </div>
      )}

      {/* ── Score row ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* Away */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flex: 1 }}>
          <span style={{ fontSize: 18, fontWeight: 'bold', letterSpacing: '0.08em' }}>
            {teams?.away?.abbreviation ?? 'AWAY'}
          </span>
          <span style={{ fontSize: 26, fontWeight: 'bold', lineHeight: 1 }}>{awayScore}</span>
        </div>

        {/* Center: inning + count, bases diamond, outs */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '0 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 'bold', color: '#ffd166' }}>{inningLabel}</span>
            <span style={{ fontSize: 13, color: '#aaa' }}>{countLabel}</span>
          </div>
          <div style={{ position: 'relative', width: 54, height: 32 }}>
            <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', ...dot(baseSet.has('2B')) }} title="2B" />
            <div style={{ position: 'absolute', bottom: 0, left: 5, ...dot(baseSet.has('3B')) }} title="3B" />
            <div style={{ position: 'absolute', bottom: 0, right: 5, ...dot(baseSet.has('1B')) }} title="1B" />
          </div>
          <div style={{ fontSize: 11, letterSpacing: '0.28em', color: '#aaa', display: 'flex', alignItems: 'center' }}>
            {[1, 2, 3].map((n) => (
              <span key={n} style={{ color: n <= outsVal ? '#ff6b6b' : 'rgba(255,255,255,0.22)' }}>●</span>
            ))}
            <span style={{ marginLeft: 7, letterSpacing: '0.02em' }}>OUTS</span>
          </div>
        </div>

        {/* Home */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flex: 1, justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 26, fontWeight: 'bold', lineHeight: 1 }}>{homeScore}</span>
          <span style={{ fontSize: 18, fontWeight: 'bold', letterSpacing: '0.08em' }}>
            {teams?.home?.abbreviation ?? 'HOME'}
          </span>
        </div>
      </div>

      {/* ── Divider ── */}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.12)', margin: '8px 0 6px' }} />

      {/* ── Matchup row ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontSize: 12, lineHeight: 1.5, textAlign: 'left' }}>
          <div>
            <span style={{ color: '#8ecbff', fontWeight: 'bold' }}>P</span>{' '}
            <HoverStat rows={pitcherRows}>{pitcher || '—'}</HoverStat>
          </div>
          <div style={{ marginTop: 2 }}>
            <span style={{ color: '#ffd166', fontWeight: 'bold' }}>B</span>{' '}
            <HoverStat rows={batterRows}>{batter || '—'}</HoverStat>
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, color: '#bbb', lineHeight: 1.5 }}>
          <div>Pitches {pitchesThrown ?? '—'}</div>
          {batterLine?.atBats != null && (
            <div style={{ marginTop: 2, color: '#aaa' }}>{batterLine.hits}–{batterLine.atBats}</div>
          )}
        </div>
      </div>

      {/* ── Bottom row: current game status (left, e.g. injury delay / final)
          + ballpark (right) ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#aaa',
        marginTop: 6, letterSpacing: '0.04em',
      }}>
        {statusLabel && (
          <span style={{
            ...(isStatusNotice && { color: '#ffd166', fontWeight: 'bold' }),
          }}>
            {statusLabel}
          </span>
        )}
        <span style={statusLabel ? undefined : { marginLeft: 'auto' }}>{venue || '—'}</span>
      </div>

      {/* ── Box score panel ── */}
      {boxOpen && (
        <div style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 10, zIndex: 30,
          width: 620, maxWidth: '90vw', maxHeight: panelMaxH || '72vh', overflowY: 'auto',
          background: 'rgba(8,12,18,0.97)', border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: 10, fontFamily: 'monospace', color: '#fff',
          padding: '10px 12px 4px', boxShadow: '0 10px 34px rgba(0,0,0,0.6)',
        }}>
          {boxLoading ? (
            <div style={{ padding: '12px 8px', fontSize: 12, color: '#aaa' }}>Loading box score…</div>
          ) : boxError ? (
            <div style={{ padding: '12px 8px', fontSize: 12, color: '#ff6b6b' }}>{boxError}</div>
          ) : boxData?.teams ? (
            <>
              {/* Scoreboard team line: runs by inning, R/H/E totals */}
              <Linescore data={boxData} />
              {/* Team selection tabs (upper left) */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {['away', 'home'].map((side) => {
                  const t = boxData.teams[side];
                  const active = boxSide === side;
                  return (
                    <button
                      key={side}
                      onClick={() => setBoxSide(side)}
                      style={{
                        background: active ? 'rgba(255,209,102,0.2)' : 'rgba(255,255,255,0.06)',
                        border: `1px solid ${active ? 'rgba(255,209,102,0.6)' : 'rgba(255,255,255,0.25)'}`,
                        color: active ? '#ffd166' : '#ccc',
                        borderRadius: 4,
                        padding: '2px 12px',
                        fontSize: 11,
                        fontWeight: 'bold',
                        letterSpacing: '0.08em',
                        cursor: 'pointer',
                        fontFamily: 'monospace',
                      }}
                    >
                      {t.abbreviation}
                    </button>
                  );
                })}
              </div>
              <TeamBox
                team={boxData.teams[boxSide]}
                color={boxSide === 'away' ? '#7ab8ff' : '#ffa63e'}
              />
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
