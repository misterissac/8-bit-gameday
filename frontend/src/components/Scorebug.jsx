import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { scorebugStatusLabel, isGameTerminal } from '../util/scorebug';

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
  inningNumber: data?.inningNumber ?? null,
  isTopInning: data?.isTopInning ?? null,
  inningState: data?.inningState ?? null,
  moundVisit: data?.moundVisit ?? false,
  pitchingChange: data?.pitchingChange ?? false,
  pitchingChangePitcher: data?.pitchingChangePitcher ?? null,
  pitchingChangeOldPitcher: data?.pitchingChangeOldPitcher ?? null,
  offensiveSub: data?.offensiveSub ?? false,
  offensiveSubRole: data?.offensiveSubRole ?? null,
  offensiveSubNew: data?.offensiveSubNew ?? null,
  offensiveSubOld: data?.offensiveSubOld ?? null,
  defensiveSub: data?.defensiveSub ?? false,
  defensiveSubNew: data?.defensiveSubNew ?? null,
  defensiveSubOld: data?.defensiveSubOld ?? null,
});

// Status-change tab animation (Scorebug): when the game status changes, a tab
// slides UP from the scoreboard's top edge into view with the new status,
// holds for a couple of seconds, then slides back DOWN out of view. Only after
// the tab is fully hidden does the parent write the status into the bottom-left
// row of the scoreboard.
// Status labels that should stay sticky in the bottom-left row after their
// tab animation finishes, persisting until the next pitch is thrown rather
// than vanishing the moment the feed's action event clears.
const STICKY_STATUS_PATTERN = /Mound Visit|Pitching Change|Pinch Hitter|Pinch Runner|Defensive Sub/i;

const STATUS_TAB_IN_MS = 350;
const STATUS_TAB_HOLD_MS = 3200;
const STATUS_TAB_OUT_MS = 350;

// Split a long status label into two display lines so it fits the tab.
// Labels like "Pinch Runner: Leo Rivas replaces Taylor Ward" or
// "Pitching Change: Colin Rea replaces Daniel Palencia" are too long for
// one row; split at "replaces" or at the colon so the role is on line 1.
const splitStatusLabel = (label) => {
  if (!label || label.length <= 34) return null;
  if (label.includes(' replaces ')) {
    const idx = label.indexOf(' replaces ');
    return [label.slice(0, idx), label.slice(idx + 1)];
  }
  if (label.includes(': ')) {
    const idx = label.indexOf(': ');
    return [label.slice(0, idx + 1), label.slice(idx + 2)];
  }
  return null;
};

function StatusTab({ id, label, onHidden }) {
  const [hiding, setHiding] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setHiding(true), STATUS_TAB_HOLD_MS);
    return () => clearTimeout(t);
  }, [id]);

  const finishHide = () => {
    if (hiding) onHidden(label);
  };

  const lines = splitStatusLabel(label);
  const isMulti = !!lines;
  const tabHeight = isMulti ? 44 : 24;

  return (
    <div style={{
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: tabHeight,
      zIndex: 16,
      overflow: 'hidden',
      borderRadius: '10px 10px 0 0',
      pointerEvents: 'none',
    }}>
      <div
        onAnimationEnd={finishHide}
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: isMulti ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(180deg, rgba(16,20,28,0.98), rgba(8,11,17,0.98))',
          borderBottom: '1px solid rgba(255,209,102,0.45)',
          color: '#ffd166',
          fontWeight: 'bold',
          fontSize: isMulti ? 11 : 12,
          letterSpacing: '0.08em',
          fontFamily: 'monospace',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          padding: isMulti ? '4px 14px' : '0 14px',
          lineHeight: 1.4,
          transform: 'translateY(100%)',
          animation: hiding
            ? `status-tab-out ${STATUS_TAB_OUT_MS}ms ease-in forwards`
            : `status-tab-in ${STATUS_TAB_IN_MS}ms ease-out forwards`,
        }}
      >
        {isMulti ? (
          <>
            <div>{lines[0]}</div>
            <div>{lines[1]}</div>
          </>
        ) : label}
      </div>
    </div>
  );
}

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

// Slot-flip value for the scoreboard: whenever ``value`` changes — a team's
// score, the inning arrow + number, the ball–strike count, the pitch count, or
// the bottom-left game status — the glyph flips in with a quick rotateX
// animation (each new value is a fresh keyed element, so the animation always
// re-triggers on change). If ``value`` is removed (null/''), it flips back out
// first — an animated disappearance instead of an instant unmount. Defined at
// module level (like HoverStat) so its identity is stable across the scorebug's
// 1s polling re-renders.
function FlipValue({ value, style, renderSplit }) {
  // The value currently on screen, kept while a flip-out finishes.
  const [shownValue, setShownValue] = useState(value);
  // Mirror of the on-screen value read from the change effect, so it can
  // decide whether there's something to flip out without depending on state
  // that is itself mid-animation.
  const shownValueRef = useRef(value);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (value == null || value === '') {
      // The parent removed the value: flip the old glyph out before vanishing.
      if (shownValueRef.current != null) setLeaving(true);
    } else {
      // A new value always wins, even if one is still flipping out.
      shownValueRef.current = value;
      setShownValue(value);
      setLeaving(false);
    }
  }, [value]);

  if (shownValue == null) return null;

  // When renderSplit is provided (a [line1, line2] array for long
  // substitution labels), render each line as its own div so the label
  // wraps to two rows instead of overflowing the scorebug width.
  const content = renderSplit ? (
    <>
      <div>{renderSplit[0]}</div>
      <div>{renderSplit[1]}</div>
    </>
  ) : shownValue;

  return (
    <span
      key={shownValue}
      onAnimationEnd={() => {
        if (leaving) {
          shownValueRef.current = null;
          setShownValue(null);
          setLeaving(false);
        }
      }}
      style={{
        display: 'inline-block',
        transformStyle: 'preserve-3d',
        ...style,
        animation: leaving
          ? 'flip-value-out 0.9s ease forwards'
          : 'flip-value-in 1.1s ease',
      }}
    >
      {content}
    </span>
  );
}

// Per-digit version of FlipValue for numbers (scores, pitch count): each
// digit is its own FlipValue, so a change like 12 → 13 flips only the trailing
// digit while the leading one stays put. Position-keyed so React keeps each
// digit's identity across the change; FlipValue itself re-keys on the digit,
// which is what re-triggers the animation.
function FlipDigits({ value, style }) {
  const digits = String(value).split('');
  return (
    <span style={{ display: 'inline-flex', ...style }}>
      {digits.map((d, i) => (
        <FlipValue key={i} value={d} />
      ))}
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
  // Status-change tab: non-null while a status tab is sliding in/holding/
  // sliding out. The bottom-left status row shows `writtenStatus` instead, and
  // only after the tab finishes hiding does the tab write it there.
  const [statusTab, setStatusTab] = useState(null);
  const [writtenStatus, setWrittenStatus] = useState(null);
  const prevStatusRef = useRef(null);
  const statusTabSeq = useRef(0);
  // A sticky status label (mound visit, pitching change, pinch/defensive sub)
  // that persists in the bottom-left row after its tab animation, until the
  // next pitch is thrown (outcomeRefresh) or a different status appears.
  const stickyStatusRef = useRef(null);
  // Tracks the game_pk the status pollers are answering for, so a stale
  // response from a previously-selected game can't overwrite the new game.
  const gamePkRef = useRef(gamePk);
  // True until the current game's first real status has been observed. Used to
  // write that initial status directly (no tab animation) so a delay/final
  // that was already active when the game was entered shows immediately.
  const pendingGameInitRef = useRef(true);

  // Computed early (before any early return) so the status-change effect below
  // can key on the label. The frozen snapshot's own fields are used while
  // frozen; liveStatus always reflects the freshest status poll.
  const displayState = frozen && stateOverride ? stateOverride : state;
  const statusLabel = displayState?.success
    ? scorebugStatusLabel({
        gameState: displayState.gameState,
        liveStatus,
        pitcher: displayState.pitcher,
        pitcherId: displayState.pitcherId,
        frozen,
        inning: displayState.inning,
      })
    : null;

  const fetchState = useCallback(async () => {
    try {
      const url = gamePk ? `${GAME_STATE_URL}?game_pk=${gamePk}` : GAME_STATE_URL;
      const res = await axios.get(url);
      if (gamePkRef.current !== gamePk) return;
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
      if (gamePkRef.current !== gamePk) return;
      setLiveStatus(statusSnapshot(res.data));
    } catch (err) {
      console.error('Failed to fetch live game status', err);
    }
  }, [gamePk]);

  // A finished game has nothing left to update, so stop the recurring polls.
  // liveStatus is reset on game switch, which flips this back to false and
  // resumes polling for the newly-selected game.
  const gameTerminal = isGameTerminal(liveStatus?.gameState);

  useEffect(() => {
    if (!frozen || gameTerminal) return;
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(id);
  }, [fetchStatus, frozen, gameTerminal]);

  useEffect(() => {
    // Entering a different game: drop the previous game's scoreboard and status
    // so stale state can't leak into (or swallow) the new game's first status —
    // e.g. a delay that was already underway before the game was selected.
    gamePkRef.current = gamePk;
    setState(null);
    setLiveStatus(null);
    setWrittenStatus(null);
    setStatusTab(null);
    prevStatusRef.current = null;
    stickyStatusRef.current = null;
    pendingGameInitRef.current = true;
  }, [gamePk]);

  useEffect(() => {
    if (!frozen && !gameTerminal) {
      fetchState();
      const id = setInterval(fetchState, POLL_MS);
      return () => clearInterval(id);
    }
    return undefined;
  }, [fetchState, frozen, gameTerminal]);

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

  // A changed game status slides up from the scoreboard's top edge as a tab,
  // holds, slides back down, and only then gets written to the bottom-left
  // row. The first status observed for a game (e.g. a delay that was already
  // underway before the game was entered) is written directly — no tab — so it
  // isn't swallowed by the previous game's stale status.
  //
  // Sticky labels (mound visit, pitching change, pinch/defensive sub) persist
  // in the bottom-left row even after the feed's action event clears and
  // statusLabel returns to null — they stay until the next pitch is thrown
  // (outcomeRefresh) or a different status appears.
  useEffect(() => {
    if (pendingGameInitRef.current) {
      // Still waiting for this game's first real status. A null during the
      // fetch transition isn't final; keep waiting until a label arrives.
      if (statusLabel == null) {
        prevStatusRef.current = null;
        setWrittenStatus(null);
        return;
      }
      pendingGameInitRef.current = false;
      prevStatusRef.current = statusLabel;
      // Track stickiness for the initial status too.
      stickyStatusRef.current = STICKY_STATUS_PATTERN.test(statusLabel)
        ? statusLabel : null;
      setWrittenStatus(statusLabel);
      return;
    }

    if (statusLabel === prevStatusRef.current) return;
    prevStatusRef.current = statusLabel;
    if (statusLabel) {
      // A new status label appeared. Track whether it's sticky.
      stickyStatusRef.current = STICKY_STATUS_PATTERN.test(statusLabel)
        ? statusLabel : null;
      // Hide the old bottom-left status while the new tab plays.
      setWrittenStatus(null);
      statusTabSeq.current += 1;
      setStatusTab({ id: statusTabSeq.current, label: statusLabel });
    } else {
      // statusLabel went back to null (the action event cleared). If the
      // previous label was sticky, keep it visible in the bottom-left row
      // until the next pitch is thrown — the substitution is still the
      // relevant game state even though the feed moved past the action event.
      if (stickyStatusRef.current) {
        setStatusTab(null);
        setWrittenStatus(stickyStatusRef.current);
      } else {
        // Non-sticky (delay/review/final): drop the tab and clear.
        setStatusTab(null);
        setWrittenStatus(null);
      }
    }
  }, [statusLabel]);

  // A new pitch was thrown (or the user refreshed): clear any sticky status
  // so the mound visit / pitching change / substitution notice goes away.
  useEffect(() => {
    if (outcomeRefresh > 0 && stickyStatusRef.current) {
      stickyStatusRef.current = null;
      // Only clear the written status if it was the sticky label — a delay
      // or final that appeared in the meantime should stay.
      setWrittenStatus((prev) =>
        prev && STICKY_STATUS_PATTERN.test(prev) ? null : prev,
      );
    }
  }, [outcomeRefresh]);

  // Once the new game's data has actually arrived, its initial status has been
  // observed (even when it's an 'In Progress' null label), so subsequent
  // changes animate via the tab again.
  useEffect(() => {
    if (state || liveStatus) pendingGameInitRef.current = false;
  }, [state, liveStatus]);

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

  // The status tab finished its slide-out: write the status into the
  // bottom-left row and unmount the tab.
  const handleStatusTabHidden = useCallback((label) => {
    setStatusTab(null);
    setWrittenStatus(label);
  }, []);

  if (!displayState || !displayState.success) return null;

  const {
    teams, score, inning, outs, count, bases, pitcher, batter, batterLine,
    batterSeason, pitcherSeason, pitchesThrown, isLive, venue,
  } = displayState;
  const awayScore = score?.away?.runs ?? '—';
  const homeScore = score?.home?.runs ?? '—';
  const baseSet = new Set(bases || []);
  const outsVal = outs ?? 0;
  // Bottom-left game status is written only after the status tab has finished
  // its slide-out (see the status-change effect above), so a change isn't
  // spoiled by the old row while the new tab plays.
  const isStatusNotice =
    /Delay|Review|Change|Pinch|Mound|Defensive/i.test(writtenStatus || '');
  // The red LIVE marker shows while the feed reports the game as live and
  // clears on its own once the game ends (abstractGameState flips to Final).
  const liveIsLive = liveStatus?.isLive ?? isLive;
  const hasCount = count?.balls != null && count?.strikes != null;

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
      minWidth: 320,
    }}>
      {/* ── Status-change tab: slides up from the top edge, holds a few
          seconds, then slides back down; the bottom-left row is written only
          after it hides ── */}
      {statusTab && (
        <StatusTab
          key={statusTab.id}
          id={statusTab.id}
          label={statusTab.label}
          onHidden={handleStatusTabHidden}
        />
      )}

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
          <FlipDigits value={awayScore} style={{ fontSize: 26, fontWeight: 'bold', lineHeight: 1 }} />
        </div>

        {/* Center: inning + count, bases diamond, outs */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '0 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FlipValue value={inningLabel} style={{ fontSize: 13, fontWeight: 'bold', color: '#ffd166' }} />
            {/* The ball–strike count renders as two independent FlipValues so a
                count change flips only the digit that actually changed (e.g. a
                ball makes 1–2 → 2–2 flip just the left digit). */}
            {hasCount ? (
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, fontSize: 13, color: '#aaa' }}>
                <FlipValue value={count?.balls} />
                <span>–</span>
                <FlipValue value={count?.strikes} />
              </span>
            ) : (
              <span style={{ fontSize: 13, color: '#aaa' }}>—</span>
            )}
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
          <FlipDigits value={homeScore} style={{ fontSize: 26, fontWeight: 'bold', lineHeight: 1 }} />
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
          <div>Pitches <FlipDigits value={pitchesThrown ?? '—'} /></div>
          {batterLine?.atBats != null && (
            <div style={{ marginTop: 2, color: '#aaa' }}>{batterLine.hits}–{batterLine.atBats}</div>
          )}
        </div>
      </div>

      {/* ── Bottom row: current game status (left, e.g. injury delay / final)
          + ballpark (right). Long substitution labels wrap to two lines. ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#aaa',
        marginTop: 6, letterSpacing: '0.04em', alignItems: 'flex-start',
      }}>
        <FlipValue
          value={writtenStatus}
          style={{
            maxWidth: 220,
            ...(isStatusNotice && (writtenStatus ? { color: '#ffd166', fontWeight: 'bold' } : {})),
          }}
          renderSplit={splitStatusLabel(writtenStatus)}
        />
        <span style={writtenStatus ? undefined : { marginLeft: 'auto' }}>{venue || '—'}</span>
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
