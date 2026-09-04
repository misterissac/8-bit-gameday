import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import {
  scorebugStatusLabel,
  isGameTerminal,
  resolveInningLabel,
  resolveABSChallenges,
  STATUS_ROLL_CONFIG,
  computeStatusRollDuration,
  isOutsideClick,
} from '../util/scorebug';
import {
  BroadcastDelayBuffer,
  normalizeBroadcastDelaySeconds,
  serializeBroadcastDelayValue,
} from '../util/broadcastDelay';
import { groupGameLogPlays } from '../util/gameLog';

const GAME_STATE_URL = 'http://localhost:8000/api/game-state';
const GAME_STATUS_URL = 'http://localhost:8000/api/game-status';
const BOX_SCORE_URL = 'http://localhost:8000/api/box-score';
const GAME_LOG_URL = 'http://localhost:8000/api/game-log';
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
  pitchingChangePosition: data?.pitchingChangePosition ?? null,
  pitchingChangeNewPosition: data?.pitchingChangeNewPosition ?? null,
  review: data?.review ?? false,
  reviewIsOverturned: data?.reviewIsOverturned ?? null,
  reviewChallenger: data?.reviewChallenger ?? null,
  reviewType: data?.reviewType ?? null,
  reviewTarget: data?.reviewTarget ?? null,
  reviewTeam: data?.reviewTeam ?? null,
  offensiveSub: data?.offensiveSub ?? false,
  offensiveSubRole: data?.offensiveSubRole ?? null,
  offensiveSubNew: data?.offensiveSubNew ?? null,
  offensiveSubOld: data?.offensiveSubOld ?? null,
  offensiveSubPosition: data?.offensiveSubPosition ?? null,
  offensiveSubNewPosition: data?.offensiveSubNewPosition ?? null,
  defensiveSub: data?.defensiveSub ?? false,
  defensiveSubNew: data?.defensiveSubNew ?? null,
  defensiveSubOld: data?.defensiveSubOld ?? null,
  defensiveSubPosition: data?.defensiveSubPosition ?? null,
  defensiveSubNewPosition: data?.defensiveSubNewPosition ?? null,
  defenseAlignment: data?.defenseAlignment ?? null,
  defenseFormation: data?.defenseFormation ?? 'Standard',
});

// Status-change tab animation (Scorebug): when the game status changes, a tab
// slides UP from the scoreboard's top edge into view with the new status,
// holds for a couple of seconds, then slides back DOWN out of view. Only after
// the tab is fully hidden does the parent write the status into the bottom-left
// row of the scoreboard.
// Status labels that should stay sticky in the bottom-left row after their
// tab animation finishes, persisting until the next pitch is thrown rather
// than vanishing the moment the feed's action event clears.
const STICKY_STATUS_PATTERN = /Mound Visit|Pitching Change|Pinch Hitter|Pinch Runner|Defensive Sub|Challenge|Review/i;

function RollingStatusText({ value, style }) {
  const viewportRef = useRef(null);
  const textRef = useRef(null);
  const [overflow, setOverflow] = useState(0);
  const [phase, setPhase] = useState('idle'); // 'idle' | 'rolling' | 'paused_end'

  // Measure overflow whenever value changes, or whenever layout/font shifts
  useEffect(() => {
    setPhase('idle');
    const vp = viewportRef.current;
    const txt = textRef.current;
    if (!value || !vp || !txt) {
      setOverflow(0);
      return undefined;
    }

    const measure = () => {
      if (!viewportRef.current || !textRef.current) return;
      const diff = Math.max(0, textRef.current.scrollWidth - viewportRef.current.clientWidth);
      setOverflow(diff);
    };

    measure();

    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        measure();
      });
      ro.observe(vp);
      ro.observe(txt);
    }

    return () => {
      if (ro) ro.disconnect();
    };
  }, [value]);

  // Repeating animation cycle:
  // 1. idle: pause 2s at the beginning of the text
  // 2. rolling: roll slowly to the end of the text
  // 3. paused_end: pause 2s at the end of the text
  // 4. reset to beginning (idle) and repeat until status expires
  useEffect(() => {
    if (overflow <= 0 || !value) {
      if (phase !== 'idle') setPhase('idle');
      return undefined;
    }

    const durationSec = computeStatusRollDuration(overflow, STATUS_ROLL_CONFIG.speedPxPerSecond);
    const durationMs = durationSec * 1000;

    if (phase === 'idle') {
      const timer = setTimeout(() => {
        setPhase('rolling');
      }, STATUS_ROLL_CONFIG.startPauseMs);
      return () => clearTimeout(timer);
    }

    if (phase === 'rolling') {
      // Set a fallback timer slightly after transition end so the cycle advances
      // even if onTransitionEnd is throttled or interrupted (e.g. background tab)
      const timer = setTimeout(() => {
        setPhase('paused_end');
      }, durationMs + 50);
      return () => clearTimeout(timer);
    }

    if (phase === 'paused_end') {
      const timer = setTimeout(() => {
        setPhase('idle');
      }, STATUS_ROLL_CONFIG.endPauseMs);
      return () => clearTimeout(timer);
    }

    return undefined;
  }, [phase, overflow, value]);

  const handleTransitionEnd = (e) => {
    if (e.target === textRef.current && phase === 'rolling') {
      setPhase('paused_end');
    }
  };

  const durationSec = computeStatusRollDuration(overflow, STATUS_ROLL_CONFIG.speedPxPerSecond);

  return (
    <span
      ref={viewportRef}
      title={value || undefined}
      style={{
        display: 'block',
        width: '220px',
        maxWidth: '220px',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textAlign: 'left',
        ...style,
      }}
    >
      <span
        ref={textRef}
        style={{
          display: 'inline-block',
          whiteSpace: 'nowrap',
          transform: phase === 'idle' ? 'translateX(0px)' : `translateX(-${overflow}px)`,
          transition: phase === 'rolling' ? `transform ${durationSec}s linear` : 'none',
          willChange: overflow > 0 ? 'transform' : 'auto',
        }}
        onTransitionEnd={handleTransitionEnd}
      >
        {value || ''}
      </span>
    </span>
  );
}

const STATUS_TAB_IN_MS = 350;
const STATUS_TAB_HOLD_MS = 3200;
const STATUS_TAB_OUT_MS = 350;

// Split a long status label into two display lines so it fits the tab.
// Row 1: the category ("Pitching Change:", "Defensive Sub:", etc.)
// Row 2: the detail (player names, result).
// For ABS challenges row 1 is the challenge + challenger, row 2 is the result.
const splitStatusLabel = (label) => {
  if (!label) return null;
  // ABS Challenge: use " — " as the split point.
  if (label.includes(' — ')) {
    const idx = label.indexOf(' — ');
    return [label.slice(0, idx), label.slice(idx + 3)];
  }
  // Substitution with "replaces": row 1 = category + new player, row 2 = "replaces ..."
  if (label.includes(' replaces ')) {
    const idx = label.indexOf(' replaces ');
    return [label.slice(0, idx), `replaces ${label.slice(idx + 10)}`];
  }
  // Generic colon split for other long labels.
  if (label.length > 34 && label.includes(': ')) {
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

// Hover popover for the batter's game scoreline (H–AB). Shows each outcome
// type the batter has recorded in the game, e.g. "1B×2  HR×1  BB×1  RBI×3".
// Only non-zero counts are shown, left to right. Defined at module level for
// the same identity-stability reason as HoverStat.
function BatterLine({ children, hover, style }) {
  const [open, setOpen] = useState(false);
  const hasSummary = hover && Object.keys(hover).length > 0;
  return (
    <div
      style={{
        position: 'relative',
        cursor: hasSummary ? 'help' : 'default',
        borderBottom: hasSummary ? '1px dotted rgba(255,255,255,0.35)' : 'none',
        ...style,
      }}
      onMouseEnter={() => hasSummary && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && hasSummary && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: 4, zIndex: 40,
          background: '#0a0e14', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 5,
          padding: '4px 8px', fontSize: 10, lineHeight: 1.6, whiteSpace: 'normal',
          maxWidth: 'min(360px, calc(100vw - 24px))',
          boxSizing: 'border-box',
          boxShadow: '0 4px 14px rgba(0,0,0,0.55)',
          display: 'flex', flexWrap: 'wrap', gap: '0 8px',
        }}>
          {Object.entries(hover).map(([label, count]) => (
            <span key={label} style={{ color: '#ffd166', fontWeight: 'bold' }}>
              {label}×{count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Hover popover: renders a small season-stats card above the wrapped name.
// Defined at module level (not inside Scorebug) so its component identity is
// stable across the scorebug's 1s polling re-renders; otherwise React would
// unmount/remount it every poll and reset the hover state.
function HoverStat({ children, rows }) {
  const [open, setOpen] = useState(false);
  const hasStats = rows.some(([, v]) => v !== '—' && v != null);
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
          <th style={{ ...th, textAlign: 'center', color: '#9aa' }}>LOB</th>
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
              <td style={center}>{dash(totals.leftOnBase)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function GameLogPanel({ data, loading, error, maxHeight, onClose, onSelectPlay, selectedAtBatIndex }) {
  const groups = groupGameLogPlays(data?.plays || []);

  return (
    <div style={{
      position: 'absolute', bottom: '100%', right: 0, marginBottom: 10, zIndex: 31,
      width: 390, maxWidth: '90vw', maxHeight: maxHeight || '72vh', overflowY: 'auto',
      background: 'rgba(8,12,18,0.98)', border: '1px solid rgba(255,255,255,0.2)',
      borderRadius: 10, padding: '10px 12px', boxShadow: '0 10px 34px rgba(0,0,0,0.6)',
      fontFamily: 'monospace', color: '#fff', userSelect: 'text',
    }} className="app-scroll">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ color: '#ffd166', letterSpacing: '0.12em', fontSize: 12 }}>GAME LOG</strong>
        <button onClick={onClose} aria-label="Close game log" style={{ background: 'transparent', border: 0, color: '#aaa', cursor: 'pointer', fontSize: 16 }}>×</button>
      </div>
      {loading ? <div style={{ padding: 10, color: '#aaa', fontSize: 12 }}>Loading game log…</div>
        : error ? <div style={{ padding: 10, color: '#ff6b6b', fontSize: 12 }}>{error}</div>
          : groups.length === 0 ? <div style={{ padding: 10, color: '#888', fontSize: 12 }}>No plays available yet.</div>
            : groups.map((group) => (
              <section key={group.key} style={{ marginBottom: 12 }}>
                <h3 style={{
                  margin: '10px 0 4px',
                  paddingBottom: 4,
                  color: '#ffd166',
                  fontSize: 11,
                  lineHeight: 1.35,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  textAlign: 'left',
                  borderBottom: '1px solid rgba(255,209,102,0.35)',
                }}>
                  {group.title}
                </h3>                {group.plays.map((play, index) => (
                  <button
                    key={`${play.id ?? group.key}-${index}`}
                    type="button"
                    onClick={() => onSelectPlay?.(play)}
                    aria-pressed={selectedAtBatIndex != null && selectedAtBatIndex === play.id}
                    style={{
                      display: 'block', width: '100%', padding: play.isScoreUpdate ? '2px 2px 2px 16px' : '5px 2px', textAlign: 'left',
                      border: 0, borderBottom: '1px solid rgba(255,255,255,0.07)',
                      background: selectedAtBatIndex != null && selectedAtBatIndex === play.id
                        ? 'rgba(255,209,102,0.16)' : 'transparent',
                      color: play.isScoreUpdate ? '#aab4c0' : '#fff', fontSize: 12, lineHeight: 1.35,
                      fontFamily: 'monospace', cursor: 'pointer',
                    }}
                  >
                    {play.isScoreUpdate ? (
                      <span style={{ display: 'block', paddingLeft: 10, color: '#aab4c0', fontSize: 11 }}>
                        {['away', 'home'].map((side, scoreIndex) => {
                          const team = play.scoreAfter[side];
                          const scoring = play.scoreAfter.scoring_side === side;
                          return (
                            <React.Fragment key={side}>
                              {scoreIndex > 0 && <span> - </span>}
                              <span style={scoring ? { fontWeight: 'bold', color: '#ffd166' } : undefined}>
                                {team.abbreviation} {scoring && <strong>{team.runs}</strong>}{!scoring && team.runs}
                              </span>
                            </React.Fragment>
                          );
                        })}
                      </span>
                    ) : play.description}
                  </button>
                ))}
              </section>
            ))}
    </div>
  );
}

const nonZeroStats = (entries) => Object.fromEntries(
  entries.filter(([, value]) => value != null && value !== '' && Number(value) !== 0),
);

// Keep box-score hover cards focused on details that are not already visible
// in the batting table columns. The backend may provide either the compact
// feed names or the full MLB stat names, so accept both forms.
const batterExtraStat = (player, ...keys) => {
  for (const key of keys) {
    if (player?.[key] != null && player[key] !== '') return player[key];
  }
  return null;
};

// Pitcher hover details intentionally exclude values already rendered in the
// pitching table, keeping the card useful without repeating the box score.
const pitcherExtraStats = (p) => nonZeroStats([
  ['PIT', batterExtraStat(p, 'pitchesThrown', 'pitches', 'pit')],
  ['STR', batterExtraStat(p, 'strikesThrown', 'strikes')],
  ['S%', batterExtraStat(p, 'strikePercentage', 'strikePct')],
  ['WP', batterExtraStat(p, 'wildPitches', 'wp')],
  ['HBP', batterExtraStat(p, 'hitByPitch', 'hbp')],
  ['BK', batterExtraStat(p, 'balks', 'bk')],
  ['SV', batterExtraStat(p, 'saves', 'sv')],
  ['BS', batterExtraStat(p, 'blownSaves', 'bs')],
]);

function TeamBox({ team, color }) {
  // Team-level totals from the feed (aggregated across all players).
  const tb = team.teamBatting || {};
  const tp = team.teamPitching || {};
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
                {p.pinchHitterFor && <span style={{ color: '#667', marginRight: 5 }}>↳</span>}
                <BatterLine hover={nonZeroStats([
                  ['1B', batterExtraStat(p, 'singles', 'oneB')],
                  ['2B', batterExtraStat(p, 'doubles', 'twoB')],
                  ['3B', batterExtraStat(p, 'triples', 'threeB')],
                  ['HR', batterExtraStat(p, 'homeRuns', 'hr')],
                  ['HBP', batterExtraStat(p, 'hitByPitch', 'hitByPitch')],
                  ['SB', batterExtraStat(p, 'stolenBases', 'sb')],
                  ['CS', batterExtraStat(p, 'caughtStealing', 'cs')],
                  ['GDP', batterExtraStat(p, 'groundedIntoDoublePlay', 'gdp')],
                  ['GTP', batterExtraStat(p, 'groundedIntoTriplePlay', 'gtp')],
                  ['GO', batterExtraStat(p, 'groundOuts', 'go')],
                  ['FO', batterExtraStat(p, 'flyOuts', 'fo')],
                  ['SF', batterExtraStat(p, 'sacrificeFlies', 'sf')],
                  ['SH', batterExtraStat(p, 'sacrificeBunts', 'sh')],
                ])} style={{ display: 'inline-block', marginLeft: p.pinchHitterFor ? 16 : 0 }}>
                  {p.name}
                </BatterLine>{' '}<span style={{ color: '#788' }}>{p.position}</span>
                {p.pinchHitterFor && <div style={{ marginLeft: 16, color: '#667', fontSize: 9 }}>for {p.pinchHitterFor}</div>}
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
          {/* Team batting totals row */}
          {(tb.atBats != null || tb.runs != null) && (
            <tr style={{ borderTop: '2px solid rgba(255,209,102,0.4)' }}>
              <td style={{ ...cell, textAlign: 'left', fontWeight: 'bold', color: '#ffd166', borderTop: '2px solid rgba(255,209,102,0.4)' }}>
                TEAM TOTALS
              </td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tb.atBats)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tb.runs)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tb.hits)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tb.rbi)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tb.baseOnBalls)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tb.strikeOuts)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tb.avg)}</td>
            </tr>
          )}
          {/* Extra team stats summary: 2B, 3B, HR */}
          {(tb.doubles != null || tb.triples != null || tb.homeRuns != null) && (
            <tr style={{ color: '#889', fontSize: 10 }}>
              <td style={{ ...cell, textAlign: 'left', color: '#667' }}>
                2B / 3B / HR
              </td>
              <td style={{ ...cell, color: '#667' }} colSpan={7}>
                {dash(tb.doubles)} / {dash(tb.triples)} / {dash(tb.homeRuns)}
              </td>
            </tr>
          )}
          {/* RISP (runners in scoring position): hits-for-atBats */}
          {tb.rispAtBats != null && (
            <tr style={{ color: '#889', fontSize: 10 }}>
              <td style={{ ...cell, textAlign: 'left', color: '#667' }}>
                RISP
              </td>
              <td style={{ ...cell, color: '#667' }} colSpan={7}>
                {dash(tb.rispHits)}-for-{dash(tb.rispAtBats)}
              </td>
            </tr>
          )}
          {/* Hard-hit balls (95+ mph exit velocity) */}
          {tb.hardHitBalls != null && (
            <tr style={{ color: '#889', fontSize: 10 }}>
              <td style={{ ...cell, textAlign: 'left', color: '#667' }}>
                Hard-hit
              </td>
              <td style={{ ...cell, color: '#667' }} colSpan={7}>
                {dash(tb.hardHitBalls)}
              </td>
            </tr>
          )}
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
              <td style={{ ...cell, textAlign: 'left', whiteSpace: 'nowrap' }}>
                <BatterLine hover={pitcherExtraStats(p)} style={{ display: 'inline-block' }}>
                  {p.name}
                </BatterLine>
              </td>
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
          {/* Team pitching totals row */}
          {(tp.inningsPitched != null || tp.runs != null) && (
            <tr style={{ borderTop: '2px solid rgba(255,209,102,0.4)' }}>
              <td style={{ ...cell, textAlign: 'left', fontWeight: 'bold', color: '#ffd166', borderTop: '2px solid rgba(255,209,102,0.4)' }}>
                TEAM TOTALS
              </td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tp.inningsPitched)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tp.hits)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tp.runs)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tp.earnedRuns)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tp.baseOnBalls)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }}>{dash(tp.strikeOuts)}</td>
              <td style={{ ...cell, fontWeight: 'bold', color, borderTop: '2px solid rgba(255,209,102,0.4)' }} colSpan={2}></td>
            </tr>
          )}
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
 * a later feed update from revealing multiple queued plays at once. When
 * `delaySeconds` is set, state/status/box-score responses are buffered before
 * they reach any visible HUD surface, including while replaying or comparing.
 *
 * A "BOX SCORE" button fetches /api/box-score on demand and shows both teams'
 * full batting and pitching lines in a panel anchored above the scorebug.
 */
export function Scorebug({ refreshKey = 0, outcomeRefresh = 0, gamePk = null, frozen = false, stateOverride = null, delaySeconds = 0, onDefenseUpdate = null, onSelectGameLogPlay = null, selectedGameLogPlayId = null, reviewMode = false, reviewScoreTab = 'replay', onReviewScoreTabChange = null, comparisonActive = false, gameTerminal = false }) {
  const rootRef = useRef(null);
  const [state, setState] = useState(null);
  // Status is intentionally separate from the frozen numeric scoreboard. It
  // can change during a pitch animation (delay, review, pitching change)
  // without revealing a newer count or score.
  const [liveStatus, setLiveStatus] = useState(null);
  const [boxOpen, setBoxOpen] = useState(false);
  const [gameLogOpen, setGameLogOpen] = useState(false);
  const [gameLogData, setGameLogData] = useState(null);
  const [gameLogLoading, setGameLogLoading] = useState(false);
  const [gameLogError, setGameLogError] = useState(null);
  const gameLogButtonRef = useRef(null);
  const gameLogPanelRef = useRef(null);
  const boxButtonRef = useRef(null);
  const boxPanelRef = useRef(null);
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
  // The compact bottom-row label stored alongside the sticky ref so that when
  // the tab hides it writes the short version to the row, not the full detail
  // that was shown in the pop-up tab.
  const compactLabelRef = useRef(null);
  // Tracks the game_pk the status pollers are answering for, so a stale
  // response from a previously-selected game can't overwrite the new game.
  const gamePkRef = useRef(gamePk);
  const delayMs = normalizeBroadcastDelaySeconds(delaySeconds) * 1000;
  // Score, status, and box-score responses use their own delay buffers so a
  // raw feed update cannot bypass the broadcast-delay setting through the HUD.
  const delayedStateBufferRef = useRef(null);
  const delayedStatusBufferRef = useRef(null);
  const delayedBoxBufferRef = useRef(null);
  const delayedGameLogBufferRef = useRef(null);
  if (!delayedStateBufferRef.current) {
    delayedStateBufferRef.current = new BroadcastDelayBuffer((item) => {
      if (gamePkRef.current !== item.gamePk) return;
      setState(item.data);
      setLiveStatus(statusSnapshot(item.data));
    }, { delayMs });
  }
  if (!delayedStatusBufferRef.current) {
    delayedStatusBufferRef.current = new BroadcastDelayBuffer((item) => {
      if (gamePkRef.current !== item.gamePk) return;
      setLiveStatus(item.data);
    }, { delayMs });
  }
  if (!delayedBoxBufferRef.current) {
    delayedBoxBufferRef.current = new BroadcastDelayBuffer((item) => {
      if (gamePkRef.current !== item.gamePk) return;
      setBoxData(item.data);
      setBoxLoading(false);
    }, { delayMs });
  }
  if (!delayedGameLogBufferRef.current) {
    delayedGameLogBufferRef.current = new BroadcastDelayBuffer((item) => {
      if (gamePkRef.current !== item.gamePk) return;
      setGameLogData(item.data);
      setGameLogLoading(false);
    }, { delayMs });
  }
  // True until the current game's first real status has been observed. Used to
  // write that initial status directly (no tab animation) so a delay/final
  // that was already active when the game was entered shows immediately.
  const pendingGameInitRef = useRef(true);
  // Ref mirror of gameTerminal for synchronous checks inside callbacks.
  const gameTerminalRef = useRef(gameTerminal);
  // Keep the ref in sync on renders (mirrors reviewRef/compareModeRef pattern).
  gameTerminalRef.current = gameTerminal;

  // Computed early (before any early return) so the status-change effect below
  // can key on the label. The frozen snapshot's own fields are used while
  // frozen; liveStatus always reflects the freshest status poll.
  const displayState = reviewMode
    ? (reviewScoreTab === 'replay' && stateOverride ? stateOverride : state)
    : (frozen && stateOverride ? stateOverride : state);
  const statusLabel = displayState?.success
    ? scorebugStatusLabel({
        gameState: displayState.gameState,
        liveStatus,
        pitcher: displayState.pitcher,
        pitcherId: displayState.pitcherId,
        frozen,
        inning: displayState.inning,
        review: displayState.review,
        reviewIsOverturned: displayState.reviewIsOverturned,
        reviewChallenger: displayState.reviewChallenger,
        reviewType: displayState.reviewType,
        reviewTarget: displayState.reviewTarget,
        reviewTeam: displayState.reviewTeam,
      })
    : null;

  const fetchState = useCallback(async () => {
    try {
      const url = gamePk ? `${GAME_STATE_URL}?game_pk=${gamePk}` : GAME_STATE_URL;
      const res = await axios.get(url);
      if (gamePkRef.current !== gamePk) return;
      const publish = () => {
        setState(res.data);
        setLiveStatus(statusSnapshot(res.data));
      };
      if (delayMs > 0 || delayedStateBufferRef.current.size > 0) {
        delayedStateBufferRef.current.enqueue(
          `${gamePk ?? 'default'}:state`,
          { gamePk, data: res.data },
          {
            version: serializeBroadcastDelayValue(res.data),
            coalesce: false,
          },
        );
      } else {
        publish();
      }
    } catch (err) {
      console.error('Failed to fetch game state', err);
    }
  }, [gamePk, delayMs]);

  // While the pitch/count snapshot is frozen, keep polling only the status
  // fields. The response is never assigned to `state`, so score/count/bases
  // remain locked until the animation outcome commits its own snapshot.
  const fetchStatus = useCallback(async () => {
    try {
      const url = gamePk ? `${GAME_STATUS_URL}?game_pk=${gamePk}` : GAME_STATUS_URL;
      const res = await axios.get(url);
      if (gamePkRef.current !== gamePk) return;
      const snapshot = statusSnapshot(res.data);
      const publish = () => setLiveStatus(snapshot);
      if (delayMs > 0 || delayedStatusBufferRef.current.size > 0) {
        delayedStatusBufferRef.current.enqueue(
          `${gamePk ?? 'default'}:status`,
          { gamePk, data: snapshot },
          {
            version: serializeBroadcastDelayValue(snapshot),
            coalesce: false,
          },
        );
      } else {
        publish();
      }
    } catch (err) {
      console.error('Failed to fetch live game status', err);
    }
  }, [gamePk, delayMs]);

  // A finished game has nothing left to update, so stop the recurring polls.
  // liveStatus is reset on game switch, which flips this back to false and
  // resumes polling for the newly-selected game. Derived from the feed itself
  // (not the app-level gameTerminal prop) so it stays true for a finished game
  // even while the app-level flag is briefly toggled during navigation.
  const feedTerminal = isGameTerminal(liveStatus?.gameState);
  const isTerminal = (
    gameTerminal ||
    feedTerminal ||
    isGameTerminal(displayState?.gameState) ||
    isGameTerminal(displayState?.detailedState) ||
    displayState?.abstractGameState === 'Final' ||
    (displayState?.isLive === false && (displayState?.gameState === 'Game Over' || displayState?.gameState === 'Final'))
  );

  // Propagate the current defensive alignment + formation to the parent so the
  // 3D scene can render position labels under each fielder, and the Defense
  // panel can show the formation badge.
  useEffect(() => {
    if (onDefenseUpdate && liveStatus?.defenseAlignment) {
      onDefenseUpdate({
        alignment: liveStatus.defenseAlignment,
        formation: liveStatus.defenseFormation ?? 'Standard',
      });
    }
  }, [onDefenseUpdate, liveStatus?.defenseAlignment, liveStatus?.defenseFormation]);

  useEffect(() => {
    if (!frozen || feedTerminal) return;
    fetchStatus();
    const id = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(id);
  }, [fetchStatus, frozen, feedTerminal]);

  useEffect(() => {
    delayedStateBufferRef.current?.setDelay(delayMs);
    delayedStatusBufferRef.current?.setDelay(delayMs);
    delayedBoxBufferRef.current?.setDelay(delayMs);
    delayedGameLogBufferRef.current?.setDelay(delayMs);
  }, [delayMs]);

  useEffect(() => {
    // Entering a different game also clears the on-demand game log.
    setGameLogOpen(false);
    setGameLogData(null);
    setGameLogError(null);
    setGameLogLoading(false);
    // Entering a different game: drop the previous game's scoreboard and status
    // so stale state can't leak into (or swallow) the new game's first status —
    // e.g. a delay that was already underway before the game was selected.
    delayedStateBufferRef.current?.clear({ resetDelivered: true });
    delayedStatusBufferRef.current?.clear({ resetDelivered: true });
    delayedBoxBufferRef.current?.clear({ resetDelivered: true });
    delayedGameLogBufferRef.current?.clear({ resetDelivered: true });
    gamePkRef.current = gamePk;
    setState(null);
    setLiveStatus(null);
    setWrittenStatus(null);
    setStatusTab(null);
    setBoxData(null);
    setBoxLoading(false);
    prevStatusRef.current = null;
    stickyStatusRef.current = null;
    compactLabelRef.current = null;
    pendingGameInitRef.current = true;
  }, [gamePk]);

  useEffect(() => {
    if (!gameLogOpen) return undefined;
    const id = setInterval(async () => {
      try {
        const url = gamePk ? `${GAME_LOG_URL}?game_pk=${gamePk}` : GAME_LOG_URL;
        const res = await axios.get(url);
        if (delayMs > 0 || delayedGameLogBufferRef.current.size > 0) {
          delayedGameLogBufferRef.current.enqueue(
            `${gamePk ?? 'default'}:game-log`,
            { gamePk, data: res.data },
            { version: serializeBroadcastDelayValue(res.data), coalesce: true },
          );
        } else {
          setGameLogData(res.data);
        }
      } catch (err) {
        console.error('Failed to refresh game log', err);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [delayMs, gameLogOpen, gamePk]);

  useEffect(() => () => {
    delayedStateBufferRef.current?.clear({ resetDelivered: true });
    delayedStatusBufferRef.current?.clear({ resetDelivered: true });
    delayedBoxBufferRef.current?.clear({ resetDelivered: true });
    delayedGameLogBufferRef.current?.clear({ resetDelivered: true });
  }, []);

  useEffect(() => {
    // Review mode keeps the hidden Live tab current even while Replay is
    // selected; switching tabs should reveal the delayed live snapshot
    // immediately instead of starting a fresh poll cycle.
    //
    // A finished game stays terminal so the app never treats it as live (no
    // Live tab, no polling), but when the user is REVIEWING that game we still
    // poll the game-state endpoint once and on an interval so the (final)
    // team identity and score load immediately for the Replay scoreboard,
    // rather than flashing the previously-selected game's data.
    if ((!frozen || reviewMode) && (reviewMode || !feedTerminal)) {
      fetchState();
      const id = setInterval(fetchState, POLL_MS);
      return () => clearInterval(id);
    }
    return undefined;
  }, [fetchState, frozen, feedTerminal, reviewMode]);

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
  // tabLabel returns to null — they stay until the next pitch is thrown
  // (outcomeRefresh) or a different status appears.
  //
  // The statusLabel is now { tabLabel, bottomRowLabel }: the tabLabel is the
  // full detailed text shown in the pop-up tab, and bottomRowLabel is the
  // compact version that sits in the bottom-left row.
  useEffect(() => {
    const tabLabel = statusLabel?.tabLabel ?? null;
    const rowLabel = statusLabel?.bottomRowLabel ?? null;
    if (pendingGameInitRef.current) {
      // Still waiting for this game's first real status. A null during the
      // fetch transition isn't final; keep waiting until a label arrives.
      if (tabLabel == null) {
        prevStatusRef.current = null;
        setWrittenStatus(null);
        return;
      }
      pendingGameInitRef.current = false;
      prevStatusRef.current = tabLabel;
      // Track stickiness for the initial status too.
      stickyStatusRef.current = STICKY_STATUS_PATTERN.test(tabLabel)
        ? rowLabel : null;
      setWrittenStatus(rowLabel);
      return;
    }

    if (tabLabel === prevStatusRef.current) return;
    prevStatusRef.current = tabLabel;
    if (tabLabel) {
      // A new status appeared. Track whether it's sticky and remember its
      // compact label for the bottom-left row.
      stickyStatusRef.current = STICKY_STATUS_PATTERN.test(tabLabel)
        ? rowLabel : null;
      compactLabelRef.current = rowLabel;
      // Hide the old bottom-left status while the new tab plays.
      setWrittenStatus(null);
      statusTabSeq.current += 1;
      setStatusTab({ id: statusTabSeq.current, label: tabLabel });
    } else {
      // tabLabel went back to null (the action event cleared). If the
      // previous label was sticky, keep the bottomRowLabel visible in the
      // bottom-left row until the next pitch is thrown.
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

  // Close the game log when the user clicks anywhere outside the button or
  // the panel itself. Uses capture phase across pointerdown and click so
  // stopping propagation in child elements or canvas controls cannot block
  // dismissal. Also closes on Escape.
  useEffect(() => {
    if (!gameLogOpen) return;
    const handleOutside = (e) => {
      if (isOutsideClick(e, gameLogButtonRef.current, gameLogPanelRef.current)) {
        setGameLogOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setGameLogOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside, true);
    document.addEventListener('click', handleOutside, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutside, true);
      document.removeEventListener('click', handleOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [gameLogOpen]);

  // Close the box score when the user clicks anywhere outside the button or
  // the panel itself. Uses capture phase across pointerdown and click so
  // stopping propagation in child elements or canvas controls cannot block
  // dismissal. Also closes on Escape.
  useEffect(() => {
    if (!boxOpen) return;
    const handleOutside = (e) => {
      if (isOutsideClick(e, boxButtonRef.current, boxPanelRef.current)) {
        setBoxOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setBoxOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside, true);
    document.addEventListener('click', handleOutside, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutside, true);
      document.removeEventListener('click', handleOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [boxOpen]);

  // Keep the box-score panel within the window: cap its height to the space
  // between the top of the viewport and the scorebug, so it's fully visible.
  useEffect(() => {
    if (!boxOpen && !gameLogOpen) return;
    const update = () => {
      if (rootRef.current) {
        setPanelMaxH(Math.max(120, rootRef.current.getBoundingClientRect().top - 12));
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [boxOpen, gameLogOpen]);

  const toggleGameLog = useCallback(async () => {
    const next = !gameLogOpen;
    setGameLogOpen(next);
    if (next) setBoxOpen(false);
    if (!next) return;
    setGameLogLoading(true);
    setGameLogError(null);
    let waitingForDelay = false;
    try {
      const url = gamePk ? `${GAME_LOG_URL}?game_pk=${gamePk}` : GAME_LOG_URL;
      const res = await axios.get(url);
      if (delayMs > 0 || delayedGameLogBufferRef.current.size > 0) {
        waitingForDelay = true;
        delayedGameLogBufferRef.current.enqueue(
          `${gamePk ?? 'default'}:game-log`,
          { gamePk, data: res.data },
          { version: serializeBroadcastDelayValue(res.data), coalesce: true },
        );
      } else {
        setGameLogData(res.data);
        setGameLogLoading(false);
      }
    } catch (err) {
      console.error('Failed to load game log', err);
      setGameLogError(err.response?.data?.detail || 'Failed to load game log');
    } finally {
      if (!waitingForDelay) setGameLogLoading(false);
    }
  }, [delayMs, gameLogOpen, gamePk]);

  const toggleBox = useCallback(async () => {
    const next = !boxOpen;
    setBoxOpen(next);
    if (next) setGameLogOpen(false);
    if (!next) return;
    // Default to the team currently at bat so the most relevant box is shown.
    setBoxSide(state?.inning?.isTop ? 'away' : 'home');
    setBoxLoading(true);
    setBoxError(null);
    let waitingForDelay = false;
    try {
      const url = gamePk ? `${BOX_SCORE_URL}?game_pk=${gamePk}` : BOX_SCORE_URL;
      const res = await axios.get(url);
      const publish = () => {
        setBoxData(res.data);
        setBoxLoading(false);
      };
      if (delayMs > 0 || delayedBoxBufferRef.current.size > 0) {
        waitingForDelay = true;
        delayedBoxBufferRef.current.enqueue(
          `${gamePk ?? 'default'}:box-score`,
          { gamePk, data: res.data },
          {
            version: serializeBroadcastDelayValue(res.data),
            coalesce: true,
          },
        );
      } else {
        publish();
      }
    } catch (err) {
      console.error('Failed to fetch box score', err);
      setBoxError('Failed to load box score');
    } finally {
      if (!waitingForDelay) setBoxLoading(false);
    }
  }, [boxOpen, delayMs, gamePk, state]);

  // The status tab finished its slide-out: write the compact status into the
  // bottom-left row and unmount the tab. Uses compactLabelRef (the
  // bottomRowLabel) so the full detail only appears in the pop-up tab.
  const handleStatusTabHidden = useCallback(() => {
    setStatusTab(null);
    setWrittenStatus(compactLabelRef.current);
  }, []);

  if (!displayState || !displayState.success) return null;

  const {
    teams, score, inning, outs, count, bases, pitcher, batter, batterLine,
    batterSummary, batterSeason, pitcherSeason, pitchesThrown, isLive, venue,
  } = displayState;
  const awayScore = score?.away?.runs ?? '—';
  const homeScore = score?.home?.runs ?? '—';
  const baseSet = new Set(bases || []);
  const outsVal = outs ?? 0;
  const { away: awayChallenges, home: homeChallenges } = resolveABSChallenges(displayState);
  // Bottom-left game status is written only after the status tab has finished
  // its slide-out (see the status-change effect above), so a change isn't
  // spoiled by the old row while the new tab plays.
  const isStatusNotice =
    /Delay|Review|Change|Pinch|Mound|Defensive|Challenge/i.test(writtenStatus || '');
  // The red LIVE marker shows while the feed reports the game as live and
  // clears on its own once the game ends (abstractGameState flips to Final).
  const liveIsLive = !isTerminal && (liveStatus?.isLive ?? isLive);
  const hasCount = count?.balls != null && count?.strikes != null;

  // Inning label: "Final" or "Final/<innings>" when the game has ended,
  // "Mid 7th" / "End 7th" between halves, and "▲/▼ 7th" while in progress.
  const inningLabel = resolveInningLabel(inning, isTerminal);

  const batterRows = [
    ['AVG', dash(batterSeason?.avg)],
    ['OBP', dash(batterSeason?.obp)],
    ['SLG', dash(batterSeason?.slg)],
    ['HR', dash(batterSeason?.hr)],
    ['RBI', dash(batterSeason?.rbi)],
  ];
  const pitcherGameSummary = nonZeroStats([
    ['SO', displayState?.pitcherGameLine?.strikeouts],
    ['BB', displayState?.pitcherGameLine?.walks],
  ]);
  // Game extended line shown over the P: count — mirrors the box score's
  // pitcher hover (strikes, walks, strikeouts) but deliberately omits the
  // pitch count, which is already printed as the `#` itself.
  const pitcherGameExtended = nonZeroStats([
    ['STR', displayState?.pitcherGameLine?.strikesThrown],
    ['BB', displayState?.pitcherGameLine?.walks],
    ['SO', displayState?.pitcherGameLine?.strikeouts],
  ]);
  const pitcherRows = [
    ...Object.entries(pitcherGameSummary),
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

  const challengeBarStyle = (active) => ({
    width: 14,
    height: 1.5,
    borderRadius: 1,
    background: active ? '#ffffff' : 'rgba(255, 255, 255, 0.2)',
    boxShadow: active ? '0 0 4px rgba(255, 255, 255, 0.8)' : 'none',
    border: active ? '0.5px solid rgba(255, 255, 255, 0.95)' : '0.5px solid rgba(255, 255, 255, 0.12)',
    transition: 'background 0.25s ease, box-shadow 0.25s ease',
  });

  return (
    <div ref={rootRef} style={{
      position: 'absolute',
      bottom: 20,
      right: 20,
      zIndex: 10,
      background: reviewMode && reviewScoreTab === 'replay'
        ? 'linear-gradient(180deg, rgba(28,82,132,0.98), rgba(15,42,78,0.98))'
        : 'linear-gradient(180deg, rgba(10,14,20,0.92), rgba(6,9,14,0.92))',
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

      {/* ── Live / Replay review tabs (above the scoreboard) ──
          Finished games have no live feed to switch to, so the tabs never
          render for them: the Replay scoreboard is the default (and only)
          scoreboard — including while navigating previous plays through the
          game log. The app-level flag is set synchronously on finished-game
          selection (no first-poll flash); the feed-derived flag covers games
          that end while a review is already open. ── */}
      {reviewMode && !comparisonActive && !gameTerminal && !feedTerminal && (
        <div
          role="tablist"
          aria-label="Scoreboard review mode"
          style={{ position: 'absolute', top: -28, left: 0, zIndex: 15, display: 'flex', alignItems: 'flex-end' }}
        >
          {['live', 'replay'].map((tab) => {
            const active = reviewScoreTab === tab;
            return (
              <button
                key={tab}
                role="tab"
                aria-selected={active}
                onClick={() => onReviewScoreTabChange?.(tab)}
                style={{
                  position: 'relative', zIndex: active ? 2 : 1,
                  marginLeft: tab === 'live' ? 0 : -4,
                  padding: '5px 12px 6px',
                  background: active ? (tab === 'replay' ? '#1c5284' : '#000') : 'rgba(42,46,54,0.96)',
                  color: active ? '#fff' : '#aab4c0', border: 'none',
                  borderRadius: '7px 7px 0 0', fontSize: 13,
                  fontFamily: 'monospace', fontWeight: 'bold', cursor: 'pointer',
                  letterSpacing: '0.02em', lineHeight: '16px',
                  boxShadow: active ? '0 -2px 8px rgba(0,0,0,0.35)' : 'none',
                }}
              >
                {tab === 'live' ? 'Live' : 'Replay'}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Game log button (above the scoreboard) ── */}
      <button
        ref={gameLogButtonRef}
        onClick={toggleGameLog}
        style={{
          position: 'absolute', top: -28, right: 0, zIndex: 15,
          background: 'rgba(80,88,100,0.92)',
          border: `1px solid ${gameLogOpen ? 'rgba(255,209,102,0.6)' : 'rgba(255,255,255,0.45)'}`,
          color: gameLogOpen ? '#ffd166' : '#fff', borderRadius: 6,
          padding: '4px 10px', fontSize: 10, letterSpacing: '0.12em', cursor: 'pointer', fontFamily: 'monospace',
        }}
      >
        {gameLogOpen ? 'CLOSE LOG' : 'GAME LOG'}
      </button>

      {gameLogOpen && (
        <div ref={gameLogPanelRef} style={{ display: 'contents' }}>
          <GameLogPanel
            data={gameLogData}
            loading={gameLogLoading}
            error={gameLogError}
            maxHeight={panelMaxH || '72vh'}
            onClose={() => setGameLogOpen(false)}
            onSelectPlay={onSelectGameLogPlay}
            selectedAtBatIndex={selectedGameLogPlayId}
          />
        </div>
      )}

      {/* ── Box score button (top right, on the inning/count row) ── */}
      <button
        ref={boxButtonRef}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
            <span style={{ fontSize: 18, fontWeight: 'bold', letterSpacing: '0.08em', lineHeight: 1 }}>
              {teams?.away?.abbreviation ?? 'AWAY'}
            </span>
            <div
              style={{ display: 'flex', gap: 3, alignItems: 'center' }}
              title={`${teams?.away?.abbreviation ?? 'Away'} ABS challenges: ${awayChallenges} remaining`}
              aria-label={`${teams?.away?.abbreviation ?? 'Away'} ABS challenges: ${awayChallenges} remaining`}
            >
              <div style={challengeBarStyle(1 <= awayChallenges)} />
              <div style={challengeBarStyle(2 <= awayChallenges)} />
            </div>
          </div>
          <FlipDigits value={awayScore} style={{ fontSize: 26, fontWeight: 'bold', lineHeight: 1 }} />
        </div>

        {/* Center: inning + count, bases diamond, outs */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '0 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FlipValue value={inningLabel} style={{ fontSize: 13, fontWeight: 'bold', color: '#ffd166' }} />
            {/* The ball–strike count renders as two independent FlipValues so a
                count change flips only the digit that actually changed (e.g. a
                ball makes 1–2 → 2–2 flip just the left digit). Hidden when the
                game is final. */}
            {hasCount && !isTerminal ? (
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, fontSize: 13, color: '#aaa' }}>
                <FlipValue value={count?.balls} />
                <span>–</span>
                <FlipValue value={count?.strikes} />
              </span>
            ) : !isTerminal ? (
              <span style={{ fontSize: 13, color: '#aaa' }}>—</span>
            ) : null}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end' }}>
          <FlipDigits value={homeScore} style={{ fontSize: 26, fontWeight: 'bold', lineHeight: 1 }} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <span style={{ fontSize: 18, fontWeight: 'bold', letterSpacing: '0.08em', lineHeight: 1 }}>
              {teams?.home?.abbreviation ?? 'HOME'}
            </span>
            <div
              style={{ display: 'flex', gap: 3, alignItems: 'center' }}
              title={`${teams?.home?.abbreviation ?? 'Home'} ABS challenges: ${homeChallenges} remaining`}
              aria-label={`${teams?.home?.abbreviation ?? 'Home'} ABS challenges: ${homeChallenges} remaining`}
            >
              <div style={challengeBarStyle(1 <= homeChallenges)} />
              <div style={challengeBarStyle(2 <= homeChallenges)} />
            </div>
          </div>
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
          <div>
            <HoverStat rows={Object.entries(pitcherGameExtended)}>
              P: <FlipDigits value={pitchesThrown ?? '—'} />
            </HoverStat>
          </div>
          {batterLine?.atBats != null && (
            <BatterLine hover={batterSummary} style={{
              marginTop: 2,
              color: '#aaa',
              borderBottom: batterSummary && Object.keys(batterSummary).length > 0
                ? '1px dotted rgba(255,255,255,0.35)'
                : 'none',
              display: 'inline-block',
            }}>
              {batterLine.hits}–{batterLine.atBats}
            </BatterLine>
          )}
        </div>
      </div>

      {/* ── Bottom row: current game status (left, e.g. injury delay / final)
          + ballpark (right). Long substitution labels wrap to two lines. ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#aaa',
        marginTop: 6, letterSpacing: '0.04em', alignItems: 'flex-start',
      }}>
        <RollingStatusText
          value={writtenStatus}
          style={{
            ...(isStatusNotice && (writtenStatus ? { color: '#ffd166', fontWeight: 'bold' } : {})),
          }}
        />
        <span style={writtenStatus ? undefined : { marginLeft: 'auto' }}>{venue || '—'}</span>
      </div>

      {/* ── Box score panel ── */}
      {boxOpen && (
        <div
          ref={boxPanelRef}
          style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 10, zIndex: 30,
          width: 620, maxWidth: '90vw', maxHeight: panelMaxH || '72vh', overflowY: 'auto',
          background: 'rgba(8,12,18,0.97)', border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: 10, fontFamily: 'monospace', color: '#fff',
          padding: '10px 12px 4px', boxShadow: '0 10px 34px rgba(0,0,0,0.6)',
        }} className="app-scroll">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <strong style={{ color: '#ffd166', letterSpacing: '0.12em', fontSize: 12 }}>BOX SCORE</strong>
            <button
              type="button"
              onClick={() => setBoxOpen(false)}
              aria-label="Close box score"
              style={{ background: 'transparent', border: 0, color: '#aaa', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px' }}
            >
              ×
            </button>
          </div>
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
