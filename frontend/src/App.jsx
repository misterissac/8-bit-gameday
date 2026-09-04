import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, Component } from 'react';
import axios from 'axios';
import { Canvas, useFrame } from '@react-three/fiber';
import { Line, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { Scene } from './components/Scene';
import { isHitFieldingReady, contactCompletionAction, fielderCamNextState, CONTACT_COMPLETE_ARM } from './util/battedBall';
import { isGameTerminal } from './util/scorebug';
import { Scorebug } from './components/Scorebug';
import { AtBatZone, AtBatLoadingPlaceholder } from './components/AtBatZone';
import { pitchTypeColor } from './util/pitchType';
import { defenseFromSnapshot, restoreLiveDefense, defensePositions } from './util/defense';
import { setTimeScale, setCycleDuration, resetSimulationTime, SLOWEST_SPEED } from './constants/playback';
import { PitchMovementGraph } from './components/PitchMovementGraph';
// IMPORTANT: DebugDrawer is intentionally hidden from the
// production UI for now. Do not remove it, its styles, or the tuning store;
// continue maintaining them as new features are added so diagnostics can be
// re-enabled later without reconstruction.
// import { DebugDrawer } from './components/DebugDrawer';
import { setTuningValue, useTuning, DEFAULT_TUNING } from './constants/tuning';
import {
  BroadcastDelayBuffer,
  BROADCAST_DELAY_OPTIONS,
  MAX_BROADCAST_DELAY_SECONDS,
  normalizeBroadcastDelaySeconds,
  serializeBroadcastDelayValue,
} from './util/broadcastDelay';
import './App.css';

// How often the app polls the backend for the newest play (ms). Silent polls
// deduplicate already-seen plays and queue newer payloads until the current
// pitch/play animation has finished.
const LIVE_POLL_MS = 1000;
// Hard ceiling on each live poll request. Without this a hung backend response
// (slow MLB feed during a pitching change / inning break) would leave the
// in-flight counter stuck above zero forever and freeze the 1s poller, which
// reads exactly like polling "stopping". A timed-out request is silently
// dropped and the next tick retries.
// A trajectory request can legitimately take a while on a cold backend cache:
// the backend re-fetches the MLB feed (up to 15s) and, on a process restart,
// the Statcast bat-tracking CSV (up to 15s) before simulating. 20s was too
// tight for that worst case, which made Jump to newest look broken with a
// spurious "Failed to fetch trajectory" banner. Give the request headroom over
// the backend's own timeouts so a cold rebuild completes instead of timing out.
const LIVE_POLL_TIMEOUT_MS = 45000;
// How often the Live Games drawer re-fetches so the live/upcoming lists stay
// current without a manual refresh.
const LIVE_GAMES_REFRESH_MS = 30000;
const NO_SIMULATABLE_PITCH_DETAIL = 'No simulated pitch data yet.';
// Playback speed used while the tunneling comparison plays several pitches /
// batted balls overlaid together (0.2x slow motion). Restored on exit.
const COMPARE_PLAYBACK_SPEED = 0.2;
// Cap on how many plays may wait behind the currently-animating play. After a
// long catch-up gap the backend can return a whole stretch of pitches at once;
// without a cap those drain one-by-one and the live view lags for minutes. At
// most MAX_QUEUED_PLAYS plays wait, and overflow is dropped from the front so
// the newest plays always survive and animate.
const MAX_QUEUED_PLAYS = 5;
// Pause between draining queued plays so the just-finished play's outcome
// indicator stays visible (in order) before the next play clears it.
const QUEUE_PLAY_GAP_MS = 700;
// Broadcast delay is applied at the client boundary: raw live-feed responses
// are held before they can enter the play queue or any HUD/status surface.
const BROADCAST_DELAY_STORAGE_KEY = 'playbyplay-broadcast-delay-seconds';
const DEFAULT_BROADCAST_DELAY_SECONDS = 0;
const HIGH_SPEED_TEST_MPH = 104;
const HIGH_SPEED_TEST_PLAY_ID = '__high-speed-effect-test__';

const initialBroadcastDelaySeconds = () => {
  if (typeof window === 'undefined') return DEFAULT_BROADCAST_DELAY_SECONDS;
  try {
    return normalizeBroadcastDelaySeconds(
      window.localStorage.getItem(BROADCAST_DELAY_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_BROADCAST_DELAY_SECONDS;
  }
};


// Fallback league-average induced break (inches) by pitch type. Same fixed
// Fallback league averages per pitch type, split by pitcher hand, in the same
// fixed Statcast sign convention as the panel and the movement graph: pfxX >
// 0 = break toward first base (catcher's right) for BOTH hands, pfxZ > 0 =
// upward ride (IVB). Horizontal break is the mirror image across hands (a RHP
// fastball breaks toward 3B = -x while a LHP's breaks toward 1B = +x), so
// each hand gets its own value; IVB is handedness-independent. These are only
// used while the live league averages from the backend /api/break-averages
// endpoint (which aggregates Baseball Savant Statcast data the same way) are
// loading or unavailable.
const FALLBACK_BREAK_BY_TYPE = {
  FF: { R: { x: -6, z: 18 }, L: { x: 6, z: 18 } },     // 4-seam fastball
  FA: { R: { x: -6, z: 18 }, L: { x: 6, z: 18 } },     // 4-seam fastball (alt code)
  FT: { R: { x: -14, z: 8 }, L: { x: 14, z: 8 } },     // 2-seam fastball
  SI: { R: { x: -14, z: 8 }, L: { x: 14, z: 8 } },     // sinker
  FC: { R: { x: 2, z: 5 }, L: { x: -2, z: 5 } },       // cutter
  SL: { R: { x: 4, z: -2 }, L: { x: -4, z: -2 } },     // slider
  ST: { R: { x: 14, z: -3 }, L: { x: -14, z: -3 } },   // sweeper
  SW: { R: { x: 14, z: -3 }, L: { x: -14, z: -3 } },   // sweeper (alt code)
  CU: { R: { x: 6, z: -7 }, L: { x: -6, z: -7 } },     // curveball
  KC: { R: { x: 5, z: -4 }, L: { x: -5, z: -4 } },     // knuckle curve
  CH: { R: { x: -10, z: 6 }, L: { x: 10, z: 6 } },     // changeup
  FS: { R: { x: -6, z: 2 }, L: { x: 6, z: 2 } },       // splitter
  SC: { R: { x: 10, z: 2 }, L: { x: -10, z: 2 } },     // screwball
  KN: { R: { x: 0, z: 0 }, L: { x: 0, z: 0 } },        // knuckleball
};

// Map an MLB play-result event to a specific banner label, so outs read as
// FLYOUT / POPOUT / LINEOUT / GROUNDOUT / STRIKEOUT / SAC FLY / BUNT / etc.
// instead of a generic OUT. Returns null for events without a specific label
// (the caller falls back to BALL / STRIKE / HIT / OUT).
const specificOutcomeLabel = (event) => {
  switch (event) {
    case 'Strikeout': return 'STRIKEOUT';
    case 'Walk': return 'WALK';
    case 'Intent Walk': return 'INTENTIONAL WALK';
    case 'Hit By Pitch': return 'HIT BY PITCH';
    case 'Flyout': return 'FLYOUT';
    case 'Pop Out': return 'POPOUT';
    case 'Lineout': return 'LINEOUT';
    case 'Groundout': return 'GROUNDOUT';
    case 'Forceout': return 'FORCE OUT';
    case 'Double Play':
    case 'Grounded Into DP': return 'DOUBLE PLAY';
    case 'Triple Play': return 'TRIPLE PLAY';
    case 'Sac Fly': return 'SAC FLY';
    case 'Sac Bunt': return 'SAC BUNT';
    case 'Bunt Groundout': return 'BUNT';
    case 'Field Error': return 'ERROR';
    case 'Fielders Choice': return "FIELDER'S CHOICE";
    case 'Catcher Interference': return 'CATCHER INTERFERENCE';
    case 'Stolen Base 2B':
    case 'Stolen Base 3B':
    case 'Stolen Base Home': return 'STOLEN BASE';
    case 'Caught Stealing 2B':
    case 'Caught Stealing 3B':
    case 'Caught Stealing Home': return 'CAUGHT STEALING';
    case 'Pickoff 1B':
    case 'Pickoff 2B':
    case 'Pickoff 3B':
    case 'Pickoff Caught Stealing 2B':
    case 'Pickoff Caught Stealing 3B':
    case 'Pickoff Caught Stealing Home': return 'PICKOFF';
    case 'Balk':
    case 'balk': return 'BALK';
    case 'Pickoff Attempt 1B':
    case 'Pickoff Attempt 2B':
    case 'Pickoff Attempt 3B': return 'PICKOFF ATTEMPT';
    case 'Wild Pitch':
    case 'wild_pitch': return 'WILD PITCH';
    case 'Passed Ball':
    case 'passed_ball': return 'PASSED BALL';
    default:
      // Fall back to the raw event uppercased so an unmapped out/result (e.g.
      // "Fielders Choice Out", "Sac Fly DP", "Runner Out") never reads as a
      // bare 'OUT' when its play hasn't resolved to a known label.
      return (typeof event === 'string' && event.trim())
        ? event.trim().toUpperCase()
        : null;
  }
};

// A hit can arrive from Stats API before its play has a final result. Keep a
// compact key for the fields that change when the feed resolves that play, so
// a same-hit update is applied without restarting the already-running pitch.
const battedBallResolutionKey = (d) => {
  if (!d) return null;
  return JSON.stringify({
    playId: d.play_id ?? null,
    playComplete: d.play_complete ?? d.is_complete ?? false,
    event: d.event ?? null,
    eventType: d.event_type ?? null,
    description: d.description ?? null,
    totalOuts: d.total_outs ?? 0,
    runners: (d.runners ?? []).map((runner) => ({
      start: runner.start ?? null,
      end: runner.end ?? null,
      outBase: runner.outBase ?? null,
      isOut: !!runner.isOut,
      outNumber: runner.outNumber ?? null,
      credits: runner.credits ?? [],
    })),
  });
};

// Pitches drawn in the at-bat / game strike zones: the current in-flight
// pitch (play_id matches but its outcome isn't revealed yet) is excluded so
// the zone never spoils it before the animation finishes.
const revealedPitches = (list, pitchData, pitchOutcome) =>
  (list ?? []).filter((p) => !(p.play_id === pitchData?.play_id && !pitchOutcome));

const trajectoryResolutionKey = (d) => JSON.stringify({
  playComplete: d?.play_complete ?? d?.is_complete ?? false,
  resultEvent: d?.result_event ?? null,
  actionEvent: d?.action_event ?? null,
  battedBall: battedBallResolutionKey(d?.batted_ball),
  gameState: d?.game_state?.gameState ?? null,
  score: d?.game_state?.score ?? null,
  outs: d?.game_state?.outs ?? null,
});

// Version of a trajectory response used by the broadcast-delay buffer. The
// full trajectory arrays are intentionally excluded: they are immutable for a
// pitch, while these fields describe everything that can change between polls
// (a newer play, a late result, waiting metadata, or a scoreboard snapshot).
const trajectoryDeliveryVersion = (d) => serializeBroadcastDelayValue({
  playId: d?.play_id ?? null,
  resolution: trajectoryResolutionKey(d),
  waiting: d?.waiting_for_pitch_data === true,
  pendingPitchId: d?.pending_pitch_id ?? null,
  pendingPlayEvent: d?.pending_play_event ?? null,
  gameState: d?.game_state ?? null,
  queued: (d?.queued_trajectories ?? []).map((queued) => ({
    playId: queued?.play_id ?? null,
    resolution: trajectoryResolutionKey(queued),
    gameState: queued?.game_state ?? null,
  })),
});

// Play-result events whose outcome is final the moment the pitch reaches the
// plate, so the specific banner label can replace the bare BALL/STRIKE right
// away. Stolen bases, caught stealings, and pickoffs live here too: they are
// recorded as the play's result and are attached to a pitch in the at-bat, so
// they reach the trajectory payload via ``result_event``.
const IMMEDIATE_RESULT_EVENTS = new Set([
  'Strikeout', 'Walk', 'Intent Walk', 'Hit By Pitch',
  'Stolen Base 2B', 'Stolen Base 3B', 'Stolen Base Home',
  'Caught Stealing 2B', 'Caught Stealing 3B', 'Caught Stealing Home',
  'Pickoff 1B', 'Pickoff 2B', 'Pickoff 3B',
  'Pickoff Caught Stealing 2B', 'Pickoff Caught Stealing 3B', 'Pickoff Caught Stealing Home',
  'Pickoff Attempt 1B', 'Pickoff Attempt 2B', 'Pickoff Attempt 3B',
]);

// The subset of immediate results that only make sense on the pitch that ended
// the at-bat. When replaying an earlier pitch of a completed at-bat, these must
// fall back to that pitch's own call (BALL / STRIKE / FOUL) instead of showing
// the at-bat's final result prematurely. Stolen bases / caught stealings /
// pickoffs are attached to a specific pitch, so they stay immediate regardless.
const AT_BAT_ENDING_EVENTS = new Set(['Strikeout', 'Walk', 'Intent Walk', 'Hit By Pitch']);

// The single outcome-resolution function for every reveal path: the plate
// arrival (with a bare ball/strike fallback), the same-play late poll (a
// stolen base / walk / strikeout that lands a poll after the pitch), and a
// no-pitch play (automatic intentional walk / standalone pickoff) surfaced via
// ``pending_play_event``. Priority: the no-pitch play event, then the resolved
// result (a strikeout double play reads STRIKEOUT, not the caught-stealing
// runner), then an action event (stolen base / caught stealing / pickoff
// attempt / wild pitch / passed ball / balk), and finally the pitch's own
// ball/strike call.
const resolvePlayOutcomeLabel = (d) => {
  const pending = d?.pending_play_event;
  if (pending) return specificOutcomeLabel(pending);
  const event = d?.result_event;
  if (event && IMMEDIATE_RESULT_EVENTS.has(event)) {
    if (!AT_BAT_ENDING_EVENTS.has(event) || d?.is_at_bat_final !== false) {
      return specificOutcomeLabel(event);
    }
  }
  const action = d?.action_event;
  if (action) return specificOutcomeLabel(action);
  const call = d?.call_code;
  if (call === 'B' || call === '*B' || call === 'P') return 'BALL';
  if (call === 'H') return 'HIT BY PITCH';
  if (call === 'F' || call === 'T' || call === 'L') return 'FOUL';
  if (call === 'C' || call === 'S' || call === 'W' || call === 'M') return 'STRIKE';
  return null;
};

// Banner color by outcome: green for batter-friendly results, red for strikes,
// yellow for big plays (runs / multiple outs), fiery orange for home runs,
// white for everything else.
const outcomeColor = (label) => {
  if (label?.startsWith('WALK-OFF') || label === 'HOME RUN') return '#ff9f1c';
  if (label === 'BALL' || label === 'WALK' || label === 'INTENTIONAL WALK' || label === 'HIT BY PITCH' || label === 'STOLEN BASE') return '#7ee0a0';
  if (label === 'STRIKE' || label === 'STRIKEOUT' || label === 'CAUGHT STEALING' || label === 'PICKOFF') return '#ff6b6b';
  if (label === 'FOUL') return '#ffb066';
  if (label === 'RUN' || label === 'DOUBLE PLAY' || label === 'TRIPLE PLAY' || label === 'WILD PITCH' || label === 'PASSED BALL' || label === 'BALK' || label === 'PICKOFF ATTEMPT') return '#ffd166';
  return '#ffffff';
};

// Local calendar-day offset for a game's start time relative to today
// (0 = today, 1 = tomorrow, ...). Null when the schedule hasn't published a
// parseable time yet.
const gameDayOffset = (game) => {
  if (!game?.game_date) return null;
  const date = new Date(game.game_date);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const gameStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((gameStart - todayStart) / 86400000);
};

// Local start time for an upcoming game (e.g. "7:05 PM"). Falls back when the
// schedule hasn't published a time yet.
const formatGameStartTime = (game) => {
  if (!game?.game_date || game?.start_time_tbd) return 'Start time TBD';
  const date = new Date(game.game_date);
  if (Number.isNaN(date.getTime())) return 'Start time TBD';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

// ── OUTCOME BANNER ────────────────────────────────────────────────────────
// Broadcast-style play-outcome pill (BALL / STRIKE / STRIKEOUT / FLYOUT / ...)
// shown where the old OUT banner was. The black box scales out sideways from
// its center when the outcome appears and folds back in when it clears, so the
// reveal reads as an animation instead of popping in/out. The wrapper stays
// mounted while the fold-out plays so the exit animation is visible, then
// unmounts (see the outcome-expand / outcome-fold keyframes in App.css).
const OUTCOME_UNROLL_MS = 900;    // box expands sideways (slower)
const OUTCOME_COLLAPSE_MS = 700;  // box folds back in (slower)
const OUTCOME_TEXT_IN_MS = 500;   // text fade-in (slower)
const OUTCOME_TEXT_OUT_MS = 400;  // text fade-out (slower)
// The text fades in once the box is ~70% unrolled, and the box waits to fold
// back in until the text has finished fading out.
const OUTCOME_TEXT_IN_DELAY_MS = Math.round(OUTCOME_UNROLL_MS * 0.7);
const OUTCOME_COLLAPSE_DELAY_MS = OUTCOME_TEXT_OUT_MS;
// Quick count events (BALL / STRIKE / FOUL) skip the unroll/fold and just do
// a short text fade on a smaller pill.
const SMALL_TEXT_IN_MS = 220;
const SMALL_TEXT_OUT_MS = 220;
const OutcomeBanner = ({ label }) => {
  const [display, setDisplay] = useState(null); // label currently rendered
  const [hiding, setHiding] = useState(false);  // true while the fold-out plays
  // Mirrors ``display`` without triggering the effect: the effect keys only on
  // ``label``, and reads the current rendered label through the ref so the
  // fold-out can be triggered by the next pitch without an extra dependency.
  const displayRef = useRef(null);

  useEffect(() => {
    if (label) {
      displayRef.current = label;
      setDisplay(label);
      setHiding(false);
    } else if (displayRef.current != null) {
      setHiding(true);
    }
  }, [label]);

  if (!display) return null;

  // Count-only outcomes render as a smaller static pill; outs and hits keep
  // the unroll/collapse reveal. Home runs get their own glow + box treatment.
  const small = display === 'BALL' || display === 'STRIKE' || display === 'FOUL';
  const isHomer = display === 'HOME RUN';
  const finishHide = () => {
    if (hiding) {
      displayRef.current = null;
      setDisplay(null);
      setHiding(false);
    }
  };
  const textAnimation = hiding
    ? `outcome-text-out ${small ? SMALL_TEXT_OUT_MS : OUTCOME_TEXT_OUT_MS}ms ease-in forwards`
    : isHomer
      ? `outcome-text-in ${OUTCOME_TEXT_IN_MS}ms ease-out ${OUTCOME_TEXT_IN_DELAY_MS}ms forwards, outcome-hr-glow 1.6s ease-in-out ${OUTCOME_TEXT_IN_DELAY_MS}ms infinite`
      : `outcome-text-in ${small ? SMALL_TEXT_IN_MS : OUTCOME_TEXT_IN_MS}ms ease-out ${small ? 0 : OUTCOME_TEXT_IN_DELAY_MS}ms forwards`;
  const boxAnimation = small
    ? 'none'
    : hiding
      ? `outcome-box-collapse ${OUTCOME_COLLAPSE_MS}ms ease-in-out ${OUTCOME_COLLAPSE_DELAY_MS}ms forwards`
      : `outcome-box-unroll ${OUTCOME_UNROLL_MS}ms ease-out forwards`;

  return (
    <div style={{
      position: 'absolute',
      top: 20,
      left: 0,
      right: 0,
      zIndex: 20,
      textAlign: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        {/* Text layer: in normal flow (it sizes the pill) and fades in/out on
            its own, so the letters never unroll/stretch with the box below.
            position:relative + zIndex keeps it above the box layer. The text
            owns the unmount trigger for small outcomes (no box animation). */}
        <span
          onAnimationEnd={small ? finishHide : undefined}
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'inline-block',
            padding: small ? '8px 28px' : '14px 52px',
            fontFamily: 'monospace',
            fontWeight: 'bold',
            fontSize: small ? '36px' : '64px',
            letterSpacing: '0.12em',
            // Broadcast-style outline around the letters: a hard stroke plus a
            // soft multi-direction shadow ring, so the glyphs read crisply
            // against the pill and the field behind it.
            WebkitTextStroke: '2px rgba(0,0,0,0.9)',
            textShadow: [
              '2px 0 0 rgba(0,0,0,0.9)', '-2px 0 0 rgba(0,0,0,0.9)',
              '0 2px 0 rgba(0,0,0,0.9)', '0 -2px 0 rgba(0,0,0,0.9)',
              '1px 1px 0 rgba(0,0,0,0.9)', '-1px 1px 0 rgba(0,0,0,0.9)',
              '1px -1px 0 rgba(0,0,0,0.9)', '-1px -1px 0 rgba(0,0,0,0.9)',
              '0 0 12px rgba(0,0,0,0.55)',
            ].join(', '),
            color: outcomeColor(display),
            animation: textAnimation,
          }}
        >
          {display}
        </span>
        {/* Box layer: unrolls/collapses sideways behind the text for outs and
            hits. The text is NOT inside it, so the letters never stretch with
            the box. Small count outcomes keep it static. */}
        <span
          onAnimationEnd={small ? undefined : finishHide}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            background: isHomer ? '#1a1206' : '#000',
            borderRadius: 10,
            transformOrigin: 'center',
            animation: boxAnimation,
            ...(isHomer && {
              border: '1px solid rgba(255,159,28,0.55)',
              boxShadow: '0 0 18px rgba(255,159,28,0.35), inset 0 0 12px rgba(255,159,28,0.12)',
            }),
          }}
        />
      </div>
    </div>
  );
};

// ── PLAY SEQUENCE PANEL ───────────────────────────────────────────────────
// Unfolds at the bottom of the screen showing the players involved in the
// play (e.g. "Juan Soto grounds into double play, SS Bo Bichette to 2B
// Cavan Biggio to 1B Vladdy Jr." for a double play, "CF Mike Trout makes
// the catch" for a flyout). Reuses the same unroll/collapse keyframes as
// the OutcomeBanner.
const SEQUENCE_UNROLL_MS = 750;
const SEQUENCE_COLLAPSE_MS = 600;
const SEQUENCE_TEXT_IN_MS = 400;
const SEQUENCE_TEXT_OUT_MS = 350;
const SEQUENCE_TEXT_IN_DELAY_MS = Math.round(SEQUENCE_UNROLL_MS * 0.6);
const SEQUENCE_COLLAPSE_DELAY_MS = SEQUENCE_TEXT_OUT_MS;
// Hold the bottom-center play narrative back until the outcome banner has
// finished revealing, so the detailed text (e.g. "grounds out, SS → 1B") can't
// spoil the outcome word it describes. Length: the outcome box unrolls then
// its text fades in; the sequence unfolds only after both have completed.
const SEQUENCE_REVEAL_DELAY_MS = Math.round(OUTCOME_UNROLL_MS + OUTCOME_TEXT_IN_MS + 200);
const PlaySequencePanel = ({ lines }) => {
  const [display, setDisplay] = useState(null);
  const [hiding, setHiding] = useState(false);
  const displayRef = useRef(null);

  useEffect(() => {
    if (lines && lines.length > 0) {
      displayRef.current = lines;
      setDisplay(lines);
      setHiding(false);
    } else if (displayRef.current != null) {
      setHiding(true);
    }
  }, [lines]);

  if (!display || display.length === 0) return null;

  const finishHide = () => {
    if (hiding) {
      displayRef.current = null;
      setDisplay(null);
      setHiding(false);
    }
  };

  const textAnimation = hiding
    ? `outcome-text-out ${SEQUENCE_TEXT_OUT_MS}ms ease-in forwards`
    : `outcome-text-in ${SEQUENCE_TEXT_IN_MS}ms ease-out ${SEQUENCE_TEXT_IN_DELAY_MS}ms forwards`;
  const boxAnimation = hiding
    ? `outcome-box-collapse ${SEQUENCE_COLLAPSE_MS}ms ease-in-out ${SEQUENCE_COLLAPSE_DELAY_MS}ms forwards`
    : `outcome-box-unroll ${SEQUENCE_UNROLL_MS}ms ease-out forwards`;

  return (
    <div style={{
      position: 'absolute',
      bottom: 80,
      left: 0,
      right: 0,
      zIndex: 19,
      textAlign: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <span
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'inline-block',
            padding: '8px 28px',
            fontFamily: 'monospace',
            fontWeight: 'bold',
            fontSize: '15px',
            lineHeight: 1.5,
            letterSpacing: '0.04em',
            WebkitTextStroke: '1px rgba(0,0,0,0.85)',
            textShadow: [
              '1px 0 0 rgba(0,0,0,0.85)', '-1px 0 0 rgba(0,0,0,0.85)',
              '0 1px 0 rgba(0,0,0,0.85)', '0 -1px 0 rgba(0,0,0,0.85)',
              '0 0 8px rgba(0,0,0,0.45)',
            ].join(', '),
            color: '#ffffff',
            animation: textAnimation,
          }}
        >
          {display.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </span>
        <span
          onAnimationEnd={finishHide}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            background: 'rgba(0,0,0,0.8)',
            borderRadius: 8,
            transformOrigin: 'center',
            animation: boxAnimation,
            border: '1px solid rgba(255,255,255,0.15)',
            boxShadow: '0 0 16px rgba(0,0,0,0.5)',
          }}
        />
      </div>
    </div>
  );
};

// ── DEFENSIVE ALIGNMENT DIAMOND ───────────────────────────────────────────
// Mini diamond diagram of the defending team's alignment, shown in the
// pitch panel's Defense tab before each pitch. Renders a small SVG with the
// position code + player name at each of the nine spots. Each fielder sits on
// a CSS-transformed <g>, so when the alignment shifts between formations (or
// pitches in rewind mode), the fielders glide to their new spots instead of
// snapping — the same transition animates player swaps at a position.
const DefenseDiagram = ({ alignment, formation = 'Standard' }) => {
  // Name shortening: "Mauricio Dubón" -> "Dubón", "Michael Harris II" -> "M. Harris II"
  const shortName = (name) => {
    if (!name) return '—';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
  };
  // Color the formation badge by type.
  const formationColor = formation === 'Strategic'
    ? '#ffb066'       // warm amber for shifts/strategic alignments
    : formation === 'Infield In'
    ? '#66b3ff'        // cool blue for infield-in
    : '#9aa3ad';      // muted grey for standard
  // Coordinates per position code for this formation (base spots + the
  // formation's offsets — see util/defense.js).
  const positions = defensePositions(formation);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 0 2px' }}>
      <svg width="100%" height="260" viewBox="0 0 320 260" preserveAspectRatio="xMidYMid meet">
        {/* Formation badge at top-left */}
        <rect x="8" y="6" rx="3" ry="3" width="76" height="16" fill="rgba(10,14,20,0.8)" stroke={formationColor} strokeWidth="0.8" />
        <text x="46" y="17" textAnchor="middle" style={{ fontSize: 8.5, fontWeight: 'bold', fill: formationColor, fontFamily: 'monospace', letterSpacing: '0.03em' }}>
          {formation.toUpperCase()}
        </text>
        {/* Fielders */}
        {Object.entries(positions).map(([pos, { x, y }]) => {
          const player = alignment[pos];
          const name = player?.name;
          return (
            <g
              key={pos}
              style={{
                transform: `translate(${x}px, ${y}px)`,
                transition: 'transform 0.5s ease',
              }}
            >
              <circle cx={0} cy={0} r="20" fill="rgba(10,14,20,0.75)" stroke="rgba(255,209,102,0.5)" strokeWidth="1.3" />
              <text x={0} y={-2} textAnchor="middle" style={{ fontSize: 12, fontWeight: 'bold', fill: '#ffd166', fontFamily: 'monospace' }}>
                {pos}
              </text>
              <text
                key={name ?? '—'}
                x={0}
                y={10}
                textAnchor="middle"
                style={{ fontSize: 9, fill: '#dde3ea', fontFamily: 'monospace', animation: 'defense-name-in 0.4s ease' }}
              >
                {shortName(name)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

// ── WAITING FOR PLAY TO RESOLVE BANNER ────────────────────────────────────
// Contact-pitch notice that drops down from the top when the batted ball's
// Statcast fielding point is still pending, and slides back up out of view
// once it arrives. It stays mounted through the exit animation, then unmounts
// when the slide-out finishes.
const RESOLVE_BANNER_IN_MS = 420;
const RESOLVE_BANNER_OUT_MS = 360;
const WaitingResolveBanner = ({ active }) => {
  const [shown, setShown] = useState(false);
  const [hiding, setHiding] = useState(false);
  const shownRef = useRef(false);

  useEffect(() => {
    if (active) {
      shownRef.current = true;
      setShown(true);
      setHiding(false);
    } else if (shownRef.current) {
      setHiding(true);
    }
  }, [active]);

  if (!shown) return null;

  const finishHide = () => {
    if (hiding) {
      shownRef.current = false;
      setShown(false);
      setHiding(false);
    }
  };

  return (
    <div style={{
      position: 'absolute',
      top: 20,
      left: 0,
      right: 0,
      zIndex: 20,
      textAlign: 'center',
      pointerEvents: 'none',
    }}>
      <span
        onAnimationEnd={hiding ? finishHide : undefined}
        style={{
          display: 'inline-block',
          padding: '10px 22px',
          background: 'rgba(0,0,0,0.72)',
          color: '#ffd166',
          border: '1px solid rgba(255,209,102,0.35)',
          borderRadius: 8,
          fontFamily: 'monospace',
          fontWeight: 'bold',
          fontSize: 16,
          letterSpacing: '0.06em',
          animation: hiding
            ? `waiting-banner-out ${RESOLVE_BANNER_OUT_MS}ms ease-in forwards`
            : `waiting-banner-in ${RESOLVE_BANNER_IN_MS}ms ease-out forwards`,
        }}
      >
        ⏳ Waiting for play to resolve…
      </span>
    </div>
  );
};

// ── SPIN AXIS VISUALIZATION ───────────────────────────────────────────────
// A small 3D view that renders the actual ported baseball model (the same
// ball.glb flying in the scene) spinning around the backend's reconstructed
// world-space spin axis, with the axis drawn as an arrow through the ball's
// center so the rotation direction reads at a glance. The camera looks down
// -Z (catcher's view: X right, Y up) — the same projection the old 2D drawer
// used — and the spin is slowed further than the scene's already-slowed rate
// so the axis and seam motion are easy to follow.
const PANEL_BALL_MODEL_URL = '/models/ball.glb';
const PANEL_BALL_RADIUS = 0.0636; // m — model sphere radius (from ball.glb bounds)
const PANEL_AXIS_HALF_LEN = 0.1; // m — axis arrow sticks ~1.6x past the ball
// Panel spin slowdown: the scene already slows true RPM by SPIN_SPEED_SCALE
// (0.1); the panel slows it further still, since its whole purpose is to make
// the spin axis and rotation direction readable at a glance.
const PANEL_SPIN_SPEED_SCALE = 0.04;

// The ported baseball, cloned so the shared useGLTF cache isn't mutated, spun
// around the world-space spin axis. The model sits centered at the origin, so
// the quaternion's pivot (the object's own position) IS the ball's center —
// the axis always passes through the baseball.
const SpinBall = ({ axis, spinRate }) => {
    const { scene } = useGLTF(PANEL_BALL_MODEL_URL);
    const model = useMemo(() => scene.clone(true), [scene]);
    const ref = useRef();
    const angleRef = useRef(0);
    useFrame((_, delta) => {
        if (!ref.current) return;
        const rpm = spinRate ?? 2000;
        angleRef.current += rpm * ((2 * Math.PI) / 60) * PANEL_SPIN_SPEED_SCALE * delta;
        ref.current.quaternion.setFromAxisAngle(axis, angleRef.current);
    });
    return <primitive object={model} ref={ref} />;
};

// The spin axis arrow: a line through the ball's center with a cone arrowhead
// on the +axis end, so the rotation direction reads at a glance. The segment
// inside the ball is hidden by depth, so the arrow visibly pierces the
// baseball from both sides of its center.
const SpinAxisArrow = ({ axis }) => {
    const dir = useMemo(() => axis.clone().normalize(), [axis]);
    const tip = useMemo(() => dir.clone().multiplyScalar(PANEL_AXIS_HALF_LEN), [dir]);
    const coneQuat = useMemo(
        () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir),
        [dir],
    );
    return (
        <group>
            <Line
                points={[
                    [-dir.x * PANEL_AXIS_HALF_LEN, -dir.y * PANEL_AXIS_HALF_LEN, -dir.z * PANEL_AXIS_HALF_LEN],
                    [dir.x * PANEL_AXIS_HALF_LEN, dir.y * PANEL_AXIS_HALF_LEN, dir.z * PANEL_AXIS_HALF_LEN],
                ]}
                color="#ff6b6b"
                lineWidth={2}
            />
            {/* Arrowhead: base at the ball's surface, tip at the line's end. */}
            <mesh position={[tip.x, tip.y, tip.z]} quaternion={coneQuat}>
                <coneGeometry args={[0.022, PANEL_AXIS_HALF_LEN - PANEL_BALL_RADIUS, 14]} />
                <meshBasicMaterial color="#ff6b6b" />
            </mesh>
        </group>
    );
};

const SpinAxisViz = ({ spinAxis, spinRate = 2000 }) => {
    const axis = useMemo(() => {
        if (!Array.isArray(spinAxis) || spinAxis.length !== 3) return null;
        const v = new THREE.Vector3(spinAxis[0], spinAxis[1], spinAxis[2]);
        return v.lengthSq() > 1e-8 ? v.normalize() : null;
    }, [spinAxis]);

    return (
        <div style={{ width: 150, height: 150, margin: '4px auto', borderRadius: 6, overflow: 'hidden' }}>
            <Canvas
                camera={{ position: [0, 0, 0.34], fov: 35 }}
                dpr={[1, 2]}
                gl={{ alpha: true, antialias: true }}
                style={{ background: 'transparent' }}
            >
                <ambientLight intensity={0.9} />
                <directionalLight position={[2, 3, 4]} intensity={1.2} />
                <React.Suspense fallback={null}>
                    {axis ? (
                        <>
                            <SpinBall axis={axis} spinRate={spinRate} />
                            <SpinAxisArrow axis={axis} />
                        </>
                    ) : (
                        // No axis data: show the ball still, without an arrow.
                        <SpinBall axis={new THREE.Vector3(0, 0, -1)} spinRate={0} />
                    )}
                </React.Suspense>
            </Canvas>
        </div>
    );
};

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
  const [battedBallData, setBattedBallData] = useState(null);
  const tuning = useTuning();
  const playbackSpeed = tuning.playback.timeScale;
  useEffect(() => {
    setTimeScale(playbackSpeed);
  }, [playbackSpeed]);
  // Local diagnostic pitch used to preview the >100 mph visual effects without
  // changing the live-feed cursor or scoreboard.
  const [highSpeedTestActive, setHighSpeedTestActive] = useState(false);
  const highSpeedTestActiveRef = useRef(false);
  // Live-feed responses stay behind this wall-clock delay before they can
  // affect playback, scorebug data, status notices, or read-only pitch views.
  // It is persisted locally so a broadcast setup survives a reload.
  const [broadcastDelaySeconds, setBroadcastDelaySeconds] = useState(initialBroadcastDelaySeconds);
  const broadcastDelayMs = broadcastDelaySeconds * 1000;
  const broadcastDelayMsRef = useRef(broadcastDelayMs);
  broadcastDelayMsRef.current = broadcastDelayMs;
  // Defaults ON: the camera follows each live batted ball's trajectory once,
  // then returns to the pre-play angle. Disabled automatically in comparison
  // and historical-replay modes.
  const [followBattedBall, setFollowBattedBall] = useState(true);
  // Defaults ON: after a contact play's first animation completes, the camera
  // automatically switches to a fielder's over-the-shoulder angle for one
  // replay cycle. When OFF the replay button is always available instead.
  const [autoFielderCam, setAutoFielderCam] = useState(true);
  const autoFielderCamRef = useRef(true);
  const toggleAutoFielderCam = () => {
    setAutoFielderCam((v) => {
      const next = !v;
      autoFielderCamRef.current = next;
      return next;
    });
  };
  // Bumped to trigger the fielder-camera replay (over-the-shoulder view of
  // the fielder who fields the ball). For contact plays it auto-fires after
  // the first animation; the replay button lets the user replay it again.
  const [fielderCamTrigger, setFielderCamTrigger] = useState(0);
  // Ref gate: when true the next handlePlayComplete is a fielder-cam replay
  // and should NOT re-arm (it should finish the play normally instead).
  const fielderCamArmedRef = useRef(false);
  // Whether a fielder-cam replay button should be shown for the current play
  // (only contact plays with fielding data).
  const fielderCamAvailable = useRef(false);
  // Whether the fielder-cam replay overlay is currently active, so the
  // fielder's position label can be shown in the top-left of the screen (it
  // used to be projected above the chaser inside the scene).
  const [fielderCamActive, setFielderCamActive] = useState(false);
  // Tracks whether the auto-fielder-cam has already fired for the current
  // play, so it never fires more than once per pitch.
  const fielderCamFiredRef = useRef(false);
  // Toggles for the pitch trail layers, default ON. Hiding them reduces visual
  // clutter without changing the simulation (the ball still flies; only the
  // colored tail / billow wake are dropped).
  const [showColoredTails, setShowColoredTails] = useState(true);
  const [showBillowParticles, setShowBillowParticles] = useState(true);
  // Selects the >100 mph impact treatment shown at the strike-zone ring.
  const [impactEffect, setImpactEffect] = useState('beams');
  // Whether the playback-controls panel is unrolled. When open the panel
  // drops down flush from the handle's top edge and the handle is hidden.
  const [playbackPanelOpen, setPlaybackPanelOpen] = useState(true);
  // The ☰ handle only fades in after the panel has fully rolled back up and
  // is removed the instant the panel starts unrolling again.
  const [handleVisible, setHandleVisible] = useState(false);
  // A click anywhere outside the open panel rolls it back up into the handle
  // (the handle itself is hidden while the panel is open).
  const playbackPanelRef = useRef(null);
  useEffect(() => {
    if (!playbackPanelOpen) return;
    const onPointerDown = (event) => {
      const el = playbackPanelRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) {
        setPlaybackPanelOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [playbackPanelOpen]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The feed can publish a new pitch before its coordinates/spin arrive. Keep
  // showing the last valid pitch, but tell the user why the new one has not
  // started yet instead of treating the intentional fallback as an error.
  const [waitingForPitchData, setWaitingForPitchData] = useState(false);
  const [pendingPitchNumber, setPendingPitchNumber] = useState(null);
  // A live play can arrive while a historical pitch is being replayed. Keep
  // the selected replay on screen and show this notice instead of switching
  // back to live automatically.
  const [newLivePlayAvailable, setNewLivePlayAvailable] = useState(false);
  // At-bat review mode protects the selected historical at-bat from live
  // queue advancement while its pitches are replayed in chronological order.
  const [review, setReview] = useState({ active: false, atBatIndex: null, playId: null, autoAdvance: false });
  const reviewRef = useRef(review);
  const [reviewScoreTab, setReviewScoreTab] = useState('replay');
  const [snapTrigger, setSnapTrigger] = useState(0);
  const [crossings, setCrossings] = useState(null);
  const [pitchOutcome, setPitchOutcome] = useState(null); // specific outcome (BALL, STRIKE, STRIKEOUT, FLYOUT, POPOUT, ...)
  // Whether the bottom-center play narrative (PlaySequencePanel) may be shown.
  // Held false until the outcome banner has had its reveal, so the narrative
  // never appears first and spoils the result; reset the instant the outcome
  // clears for the next pitch.
  const [sequenceRevealed, setSequenceRevealed] = useState(false);
  useEffect(() => {
    if (!pitchOutcome) {
      setSequenceRevealed(false);
      return;
    }
    const t = setTimeout(() => setSequenceRevealed(true), SEQUENCE_REVEAL_DELAY_MS);
    return () => clearTimeout(t);
  }, [pitchOutcome]);
  // Bottom-left pitch panel: open by default. Before a new play is fully
  // animated for the first time, it slides out of the screen to the left,
  // and slides back in once the play finishes. Manual expansion/collapsibility
  // is preserved for when the user wants more space in the interface.
  const [pitchPanelOpen, setPitchPanelOpen] = useState(true);
  const [panelSlidOut, setPanelSlidOut] = useState(true);
  // The show/hide toggle stays disabled until the first play has fully
  // animated, so the pitch can't be spoiled by opening the panel early.
  const [toggleUnlocked, setToggleUnlocked] = useState(false);
  // At-bat tunneling view: replaces the panel's stats/spin ball with a 2D
  // strike zone of every pitch thrown in the current at-bat.
  const [atBatOpen, setAtBatOpen] = useState(false);
  const [defenseOpen, setDefenseOpen] = useState(false);
  const [atBatData, setAtBatData] = useState(null);
  const [atBatLoading, setAtBatLoading] = useState(false);
  const [atBatError, setAtBatError] = useState(null);
  // Whole-game scope in the at-bat tab: the strike zone shows every pitch
  // thrown to the batter across the game (labeled by pitch type, no replay),
  // with a pitcher list below it to filter by pitcher.
  const [batterGameOpen, setBatterGameOpen] = useState(false);
  const [batterGameData, setBatterGameData] = useState(null);
  const [batterGameLoading, setBatterGameLoading] = useState(false);
  const [batterGameError, setBatterGameError] = useState(null);
  // pitcher_id filter in the game view (null = all pitchers the batter faced).
  const [pitcherFilter, setPitcherFilter] = useState(null);
  // Filter mode in the game (batter-faced) view: 'pitcher' chips or 'pitchType' chips.
  const [gameFilterMode, setGameFilterMode] = useState('pitcher');
  // pitch_type code filter in the game view (null = all pitch types).
  const [pitchTypeFilter, setPitchTypeFilter] = useState(null);
  // Snapshot the pitch panel's rendered width when switching to the at-bat
  // view so the loading placeholder doesn't shrink the panel during the fetch.
  const [atBatSnapshotWidth, setAtBatSnapshotWidth] = useState(null);
  // Same snapshot for height, used in both directions so the panel eases
  // between the two views' content heights instead of snapping.
  const [atBatSnapshotHeight, setAtBatSnapshotHeight] = useState(null);
  // Incremented each time the Pitch tab is selected, used as a React key on
  // the pitch content wrapper so it remounts and plays the fade-in animation.
  const [pitchContentKey, setPitchContentKey] = useState(0);
  // Pitch movement graph: toggles between 3D model view and the scatterplot
  // graph of the pitcher's pitch movement (H Break vs V Break). Reset to
  // model whenever a new play auto-expands the panel.
  const [graphMode, setGraphMode] = useState(false);
  const [graphData, setGraphData] = useState(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState(null);
  // Per-pitcher graph cache so switching back to a previously-seen pitcher
  // doesn't re-fetch.
  const graphCacheRef = useRef({});

  // Tunneling comparison visualizer: 'idle' (single-pitch view) →
  // 'selecting' (click pitches in the at-bat zone to build a set) →
  // 'active' (selected pitches + batted balls animate overlaid together).
  const [compareMode, setCompareMode] = useState('idle');
  // play_ids the user has picked while in 'selecting' mode (ordered).
  const [compareSelectedIds, setCompareSelectedIds] = useState([]);
  // [{ pitch, hit }] actually animating in 'active' mode.
  const [comparisonPlays, setComparisonPlays] = useState([]);
  // Bumped to restart the active comparison from the beginning (remounts the
  // overlaid pitch/batted-ball components via their keys), so a lengthy batted
  // ball flight can be skipped and watched again without waiting for it to land.
  const [comparisonReplayKey, setComparisonReplayKey] = useState(0);
  // Pitch-type labels under each overlaid pitch's strike-zone ring in
  // comparison mode. Default ON; toggled from the comparison controls so the
  // rings can be identified or left clean. Persists across comparisons.
  const [showComparisonRingLabels, setShowComparisonRingLabels] = useState(true);
  // Playback settings to restore when leaving comparison (0.2x is forced on enter).
  const [preComparisonSpeed, setPreComparisonSpeed] = useState(null);
  const preComparisonSpeedRef = useRef(null);
  const preComparisonVisualsRef = useRef(null);
  // Bumped each time a pitch/play resolves so the at-bat zone adds that pitch
  // only after its animation finishes (instead of spoiling it on arrival).
  const [atBatOutcomeRefresh, setAtBatOutcomeRefresh] = useState(0);
  // Historical-pitch replay mode: when active polling continues, but the
  // selected pitch is protected until a genuinely newer live play appears;
  // the scorebug is un-frozen so it keeps showing the live count/score.
  const [replay, setReplay] = useState({
    active: false,
    playId: null,
    pitchNumber: null,
    atBatIndex: null,
    // The live pitch that was current when replay started. Polling continues
    // during replay, but the selected historical pitch stays on screen until
    // a genuinely newer live pitch arrives.
    livePlayId: null,
  });
  // Live league-average break by pitch type from the backend (Baseball Savant
  // aggregation); null until it loads, so the panel uses FALLBACK_BREAK_BY_TYPE.
  const [breakAverages, setBreakAverages] = useState(null);
  const [hudRefresh, setHudRefresh] = useState(0); // bumps to re-fetch the scorebug
  // Frozen scoreboard snapshots are committed only when their corresponding
  // pitch/play animation finishes. This prevents a newer live feed response
  // from revealing several queued results at once.
  const [scorebugStateOverride, setScorebugStateOverride] = useState(null);
  // Bumps when the pitch/play outcome is revealed, so the scorebug re-fetches
  // exactly once per pitch (even while frozen) — the count/outs/score update
  // the moment the BALL/STRIKE/HIT/RUN/OUT indicator appears.
  const [scorebugOutcomeRefresh, setScorebugOutcomeRefresh] = useState(0);
  // Current defensive alignment: position-code → {id, name} + formation type.
  // Updated by the Scorebug component on each game-state poll. Used by the
  // DefenseDiagram panel (bottom-left), which auto-opens only when the
  // fielding arrangement actually changes (new player at a position or a new
  // formation), not on every poll.
  const [defenseData, setDefenseData] = useState(null);
  const defenseAlignment = defenseData?.alignment ?? null;
  const defenseFormation = defenseData?.formation ?? 'Standard';
  // The live defensive alignment captured when review mode starts, so
  // Return to Live can restore it (the replayed at-bat's snapshots overwrite
  // defenseData while the Replay tab freezes the live status poll).
  const liveDefenseRef = useRef(null);

  // Auto-open the Defense tab only when the fielding arrangement actually
  // changes: a new player at any position (a pitching change swaps the P slot)
  // or a different formation (Standard → Strategic / Infield In / ...). The
  // scorebug re-reports the alignment on every status poll as a fresh object,
  // so identity alone can't distinguish a real change — compare the contents.
  // The first sighting only seeds the baseline (the status quo isn't a
  // change), so the initial pitch resolves onto the pitch panel instead.
  const lastDefenseSigRef = useRef(null);
  useEffect(() => {
    if (!defenseAlignment || Object.keys(defenseAlignment).length === 0) return;
    const sig = JSON.stringify([defenseAlignment, defenseFormation]);
    if (lastDefenseSigRef.current == null) {
      lastDefenseSigRef.current = sig;
      return;
    }
    if (sig === lastDefenseSigRef.current) return;
    lastDefenseSigRef.current = sig;
    setDefenseOpen(true);
  }, [defenseAlignment, defenseFormation]);

  // Bumped exactly once when a play fully finishes; the effect below commits
  // the scoreboard snapshot and advances the queue AFTER the reveal render, so
  // the outcome banner gets a frame to display before the next play starts.
  const [playCompletion, setPlayCompletion] = useState(0);
  // Debug: how the most recent play finished ('normal' once the choreography
  // reached its end time). Surfaced in the debug overlays drawer.
  const [completionDebug, setCompletionDebug] = useState({ source: null });
  const [activeGamePk, setActiveGamePk] = useState(null); // null = backend's default game
  const activeGamePkRef = useRef(activeGamePk);
  activeGamePkRef.current = activeGamePk;

  const makeHighSpeedTestPitch = (source) => {
    if (!source?.trajectory?.length) return null;
    return {
      ...source,
      play_id: HIGH_SPEED_TEST_PLAY_ID,
      speed_mph: HIGH_SPEED_TEST_MPH,
      pitch_type: source.pitch_type || 'FF',
      pitch_type_description: source.pitch_type_description || '4-Seam Fastball',
      call_code: 'C',
      is_contact: false,
      swing: false,
      result_event: null,
      action_event: null,
      pending_play_event: null,
      batted_ball: null,
      game_state: null,
    };
  };

  const stopHighSpeedTest = () => {
    highSpeedTestActiveRef.current = false;
    setHighSpeedTestActive(false);
    setPitchData(null);
    setBattedBallData(null);
    setPitchOutcome(null);
    setWaitingForPitchData(false);
    setPendingPitchNumber(null);
    pitchDataRef.current = null;
    playFinishedRef.current = false;
    outcomeShownPlayId.current = null;
    refreshAll(activeGamePkRef.current);
  };
  // Delay buffers are intentionally separate by stream: a trajectory response
  // can be coalesced while a play is enriched, whereas successive scoreboard,
  // status, and panel snapshots each retain the delay from their own receipt.
  const delayedTrajectoryBufferRef = useRef(null);
  const delayedBattedBallBufferRef = useRef(null);
  const delayedUiBufferRef = useRef(null);
  // Once the feed reports the game as finished (Final / Game Over / Completed
  // Early) there is nothing new to poll, so the app-level trajectory and
  // batted-ball pollers stop until a different game is selected.
  const [gameTerminal, setGameTerminal] = useState(false);
  // Ref mirror of gameTerminal for synchronous checks inside callbacks (a
  // state read inside a callback would see the render-time value, which can
  // lag the just-set flag within the same tick).
  const gameTerminalRef = useRef(false);
  const [liveGames, setLiveGames] = useState(null);
  const [finishedGames, setFinishedGames] = useState(null);
  const [upcomingGames, setUpcomingGames] = useState(null);
  const [liveGamesLoading, setLiveGamesLoading] = useState(false);
  // The live-games drawer is capped so it stretches from below the control
  // panel down to just above the bottom-left pitch panel (or the WASD hint
  // when no pitch is loaded) instead of running off the bottom of the window.
  const drawerRef = useRef(null);
  const bottomLeftRef = useRef(null);
  // The top-left column (control panel + drawer); its height drives the
  // drawer's top, which moves the drawer's bottom even when the cap is fixed.
  const topLeftRef = useRef(null);
  // The view tabs stick out above the pitch panel's box, so the drawer cap is
  // anchored to them — the panel's topmost visible element.
  const tabsRef = useRef(null);
  const summaryRef = useRef(null);
  const gamesListRef = useRef(null);
  const [drawerMaxHeight, setDrawerMaxHeight] = useState(null);
  const [gamesListMaxHeight, setGamesListMaxHeight] = useState(null);
  // Whether the Games drawer is unrolled. It rolls down/up with a coordinated
  // two-phase sequence: expand width first -> unroll height, roll up height first -> shrink width.
  const [gamesDrawerOpen, setGamesDrawerOpen] = useState(true);
  const [drawerWidthExpanded, setDrawerWidthExpanded] = useState(true);
  const [drawerHeightExpanded, setDrawerHeightExpanded] = useState(true);

  useEffect(() => {
    let timer;
    if (gamesDrawerOpen) {
      setDrawerWidthExpanded(true);
      timer = setTimeout(() => {
        setDrawerHeightExpanded(true);
      }, 260);
    } else {
      setDrawerHeightExpanded(false);
      timer = setTimeout(() => {
        setDrawerWidthExpanded(false);
      }, 310);
    }
    return () => clearTimeout(timer);
  }, [gamesDrawerOpen]);
  // Rendered width of the bottom-left pitch/at-bat panel, so the live-games
  // drawer can match it exactly.
  const pitchPanelRef = useRef(null);
  const [pitchPanelWidth, setPitchPanelWidth] = useState(null);
  // The debug-overlays drawer's rendered width, measured so the playback
  // panel above it can match it exactly.
  const overlaysRef = useRef(null);
  const [overlaysWidth, setOverlaysWidth] = useState(null);
  // play_id of the currently-animating pitch / batted ball, so polling can
  // tell a genuinely new play from a re-fetch of the same one.
  const lastTrajectoryPlayId = useRef(null);
  const lastBattedPlayId = useRef(null);
  // Batted-ball responses can arrive before their owning trajectory. Keep
  // those payloads by hit id until that pitch becomes active, then advance the
  // batted-ball cursor only when the payload is actually applied.
  const pendingBattedBallsRef = useRef(new Map());
  const appliedBattedPlayIdsRef = useRef(new Map());
  // Resolution keys are separate from play_id: the same hit event can first
  // arrive without result/runners and later be enriched when MLB marks the
  // play complete. Those updates must reach the choreography.
  const lastTrajectoryResolutionKey = useRef(null);
  const lastBattedResolutionKey = useRef(null);
  // Keep incoming trajectory payloads in arrival order while the current pitch
  // is still animating. The backend may answer with a newer play before the
  // current animation has revealed its result.
  const trajectoryQueueRef = useRef([]);
  const queuedTrajectoryPlayIdsRef = useRef(new Set());
  const knownTrajectoryPlayIdsRef = useRef(new Set());
  // Timer for the QUEUE_PLAY_GAP_MS pause between back-to-back queued plays.
  const queueStartTimerRef = useRef(null);
  // Mirror of trajectoryQueueRef.current.length kept in React state so the UI
  // (the Jump-to-newest control) can show the queue size / appear only when
  // plays are actually waiting. Synced at every queue mutation.
  const [queuedPlayCount, setQueuedPlayCount] = useState(0);
  const pitchDataRef = useRef(null);
  // A play can be enriched (run/out/result) after its trajectory starts. Keep
  // the newest scoreboard snapshot without replacing pitchData and restarting
  // the animation.
  const currentPitchScoreSnapshotRef = useRef(null);
  // The scoreboard snapshot captured the moment a play finished, held so the
  // deferred completion effect can commit exactly that play's state even if a
  // newer poll has already applied the next play. Refreshed by the late-
  // resolution guard when an enriched payload arrives after the animation
  // finished, so the deferred commit still lands the play's final state.
  const completedPlaySnapshotRef = useRef(null);
  const replayRef = useRef(replay);
  // Comparison mode's live baseline: the play_id that was current when the
  // overlaid comparison started. Polling continues, but a genuinely newer
  // play is surfaced as a notice instead of replacing the comparison.
  const compareModeRef = useRef(compareMode);
  const comparisonBaselinePlayIdRef = useRef(null);
  pitchDataRef.current = pitchData;
  replayRef.current = replay;
  reviewRef.current = review;
  gameTerminalRef.current = gameTerminal;
  compareModeRef.current = compareMode;
  // play_id whose outcome has already been shown, so the looping playback
  // doesn't re-trigger the indicator for the same pitch.
  const outcomeShownPlayId = useRef(null);
  // Last no-pitch play outcome surfaced from the trajectory payload (an
  // automatic intentional walk / standalone pickoff attempt), so the 1s poll
  // doesn't re-show the same banner on every tick.
  const lastPendingPlayEventRef = useRef(null);
  // Whether the currently-active play has fully finished animating (every out
  // and the final result emitted). Separate from the revealed outcome label so
  // an intermediate OUT on a double/triple play can't be mistaken for the play
  // being complete and advance the queue (or skip) early.
  const playFinishedRef = useRef(false);
  // Monotonic request counters: polling runs on a 1s cadence but each fetch
  // can take longer than that, so responses can arrive out of order. These let
  // us discard a stale response instead of reverting the animation to an older
  // pitch (which reads as the newest pitch/play being skipped).
  const trajectoryReqSeq = useRef(0);
  const battedReqSeq = useRef(0);
  // The seq of the newest response already applied to state. A response is
  // stale only when a NEWER response has already been applied — comparing
  // against the latest request *started* starves the feed once request latency
  // reaches the poll interval: every response then arrives after the next poll
  // bumped the counter, nothing is ever applied, and the pitch panel stays
  // empty forever.
  const lastTrajectoryAppliedSeq = useRef(0);
  const lastBattedAppliedSeq = useRef(0);
  // The 1s live poll is one request cycle: if either endpoint from the prior
  // cycle is still pending, the next tick waits instead of piling up another
  // pair of backend calls.
  const trajectoryRequestsInFlight = useRef(0);
  const battedBallRequestsInFlight = useRef(0);
  // Number of in-flight non-silent trajectory fetches, so overlapping refreshes
  // don't clear the loading flag while a newer fetch is still running.
  const trajectoryLoadingCount = useRef(0);
  const canvasRef = useRef(null);
  // Spin-components hover popup: anchored to the Spin Rate row in the pitch
  // panel and rendered fixed-positioned, so the panel's overflow:hidden never
  // clips it. State holds the viewport anchor (null = hidden).
  const [spinPopupAnchor, setSpinPopupAnchor] = useState(null);
  const spinRateRef = useRef(null);
  const spinPopupHideTimer = useRef(null);

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

  const API_BASE = 'http://localhost:8000';
  const withGame = (path, gamePk, extraParams = {}) => {
    const params = new URLSearchParams();
    if (gamePk) params.set('game_pk', gamePk);
    for (const [key, value] of Object.entries(extraParams)) {
      if (value != null && value !== '') params.set(key, value);
    }
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  };

  const ensureDelayBuffers = () => {
    if (!delayedTrajectoryBufferRef.current) {
      delayedTrajectoryBufferRef.current = new BroadcastDelayBuffer((item) => {
        if (activeGamePkRef.current !== item.gamePk) return;
        item.process();
      }, { delayMs: broadcastDelayMsRef.current });
    }
    if (!delayedBattedBallBufferRef.current) {
      delayedBattedBallBufferRef.current = new BroadcastDelayBuffer((item) => {
        if (activeGamePkRef.current !== item.gamePk) return;
        item.process();
      }, { delayMs: broadcastDelayMsRef.current });
    }
    if (!delayedUiBufferRef.current) {
      delayedUiBufferRef.current = new BroadcastDelayBuffer((item) => {
        if (item.scope === 'game' && activeGamePkRef.current !== item.gamePk) return;
        item.apply();
      }, { delayMs: broadcastDelayMsRef.current });
    }
  };

  const scheduleDelayedTrajectoryResponse = (d, gamePk, process) => {
    ensureDelayBuffers();
    const gameKey = gamePk ?? 'default';
    delayedTrajectoryBufferRef.current.enqueue(
      `${gameKey}:${d?.play_id ?? 'no-play'}`,
      { gamePk, process },
      { version: trajectoryDeliveryVersion(d), coalesce: true },
    );
  };

  const scheduleDelayedBattedBallPayload = (d, gamePk, process) => {
    if (d?.play_id == null) return;
    ensureDelayBuffers();
    const gameKey = gamePk ?? 'default';
    delayedBattedBallBufferRef.current.enqueue(
      `${gameKey}:${d.play_id}`,
      { gamePk, process },
      { version: serializeBroadcastDelayValue(d), coalesce: true },
    );
  };

  const scheduleDelayedUiUpdate = (id, value, apply, {
    gamePk = activeGamePk,
    scope = 'game',
    coalesce = false,
  } = {}) => {
    ensureDelayBuffers();
    delayedUiBufferRef.current.enqueue(
      id,
      { gamePk, scope, apply },
      { version: serializeBroadcastDelayValue(value), coalesce },
    );
  };

  useEffect(() => {
    const delayMs = broadcastDelaySeconds * 1000;
    broadcastDelayMsRef.current = delayMs;
    delayedTrajectoryBufferRef.current?.setDelay(delayMs);
    delayedBattedBallBufferRef.current?.setDelay(delayMs);
    delayedUiBufferRef.current?.setDelay(delayMs);
    try {
      window.localStorage.setItem(
        BROADCAST_DELAY_STORAGE_KEY,
        String(broadcastDelaySeconds),
      );
    } catch {
      // localStorage can be unavailable; the in-memory setting still works.
    }
  }, [broadcastDelaySeconds]);

  const fetchTrajectory = async (gamePk = activeGamePk, { silent = false } = {}) => {
    const seq = ++trajectoryReqSeq.current;
    trajectoryRequestsInFlight.current += 1;
    try {
      if (!silent) {
        trajectoryLoadingCount.current += 1;
        setLoading(true);
        setError(null);
      }
      const response = await axios.get(
        withGame(`${API_BASE}/api/trajectory`, gamePk, {
          after_play_id: lastTrajectoryPlayId.current,
        }),
        { timeout: LIVE_POLL_TIMEOUT_MS },
      );
      const d = response.data;
      // Drop this response only when a NEWER response has already been
      // received, so an out-of-order response can't revert the animation to an
      // older pitch. Comparing against the latest request *started* (rather
      // than the latest response received) would drop every response once
      // request latency matches the 1s poll cadence, leaving the panel empty.
      if (seq < lastTrajectoryAppliedSeq.current) return;
      lastTrajectoryAppliedSeq.current = seq;

      // Keep response processing behind the broadcast-delay wall. The function
      // closes over this response so a delayed callback processes exactly the
      // payload that was received, while the buffer may still coalesce an
      // enriched replacement for the same play.
      const processTrajectoryPayload = () => {
      // A finished game has nothing left to poll. The trajectory payload
      // carries the feed's current game status, so detect a terminal result
      // here and stop the app-level pollers. This also fires while replaying
      // a historical pitch, where the payload still reflects the live status.
      if (isGameTerminal(d?.game_state?.gameState)) setGameTerminal(true);

      // The backend may return the previous valid pitch while the newest feed
      // event is still missing coordinates or spin. Update this status before
      // the play-id gate below: the fallback pitch is intentionally unchanged,
      // but the waiting indicator still needs to appear and disappear as the
      // feed catches up.
      const waiting = d?.waiting_for_pitch_data === true;
      setWaitingForPitchData(waiting);
      setPendingPitchNumber(waiting ? (d?.pending_pitch_number ?? null) : null);

      // A no-pitch play (an automatic intentional walk, a standalone pickoff
      // attempt) has no trajectory to animate, but its result still deserves a
      // banner. The backend surfaces it via ``pending_play_event`` when the
      // feed has moved past the last simulatable pitch into such a play.
      const pendingPlayEvent = d?.pending_play_event || null;
      if (pendingPlayEvent !== lastPendingPlayEventRef.current) {
        lastPendingPlayEventRef.current = pendingPlayEvent;
        if (pendingPlayEvent) {
          setPitchOutcome(resolvePlayOutcomeLabel({ pending_play_event: pendingPlayEvent }));
        }
      }

      // While replaying, keep the selected historical pitch on screen. The
      // poller still runs so a later live play can be detected, but it must not
      // silently end the replay. The baseline was already live when replay
      // began; anything newer becomes a visible "new play available" notice.
      if (highSpeedTestActiveRef.current) return;
      if (reviewRef.current.active) {
        const isSelectedReviewPlay = d?.play_id === reviewRef.current.playId;
        if (!isSelectedReviewPlay) setNewLivePlayAvailable(true);
        return;
      }
      if (replayRef.current.active) {
        const isSelectedReplay = d?.play_id === replayRef.current.playId;
        const isReplayBaseline = d?.play_id === replayRef.current.livePlayId;
        const hasNewLivePlay = (
          d?.play_id != null && !isSelectedReplay && !isReplayBaseline
        );
        const hasNewPendingPitch = (
          waiting &&
          d?.pending_pitch_id != null &&
          d.pending_pitch_id !== replayRef.current.playId &&
          d.pending_pitch_id !== replayRef.current.livePlayId
        );
        if (hasNewLivePlay || hasNewPendingPitch) setNewLivePlayAvailable(true);
        return;
      }
      // While the tunneling comparison is being set up or animating, protect
      // it the same way: a newer live play must not change the at-bat being
      // selected from, replace the overlaid pitches, or restart anything
      // underneath them. Surface it as a notice instead, and let the next poll
      // apply it once the comparison is cancelled or exited.
      if ((compareModeRef.current === 'selecting' || compareModeRef.current === 'active') && comparisonBaselinePlayIdRef.current != null) {
        const baseline = comparisonBaselinePlayIdRef.current;
        const hasNewLivePlay = d?.play_id != null && d?.play_id !== baseline;
        const hasNewPendingPitch = (
          waiting &&
          d?.pending_pitch_id != null &&
          d.pending_pitch_id !== baseline
        );
        if (hasNewLivePlay || hasNewPendingPitch) setNewLivePlayAvailable(true);
        return;
      }
      // The backend answered, so clear any transient error from an earlier
      // failed poll (e.g. the game was between at-bats / had null coordinates).
      setError(null);

      // When the backend observes that the feed jumped from A to C, it returns
      // B as catch-up payload data. Enqueue B (and then C) in arrival order and
      // start the first one immediately if nothing is still animating. If C is
      // already the active play, the repeated cached catch-up list is ignored.
      const catchUpPayloads = Array.isArray(d?.queued_trajectories)
        ? d.queued_trajectories
        : [];
      if (catchUpPayloads.length > 0 && d?.play_id !== lastTrajectoryPlayId.current) {
        const unseenCatchUp = [];
        for (const queued of catchUpPayloads) {
          const queuedId = queued?.play_id;
          if (queuedId == null || knownTrajectoryPlayIdsRef.current.has(queuedId)) continue;
          const queuedIndex = queuedTrajectoryQueueIndex(queuedId);
          if (queuedIndex >= 0) {
            trajectoryQueueRef.current[queuedIndex] = queued;
          } else {
            unseenCatchUp.push(queued);
          }
        }
        if (unseenCatchUp.length > 0) {
          for (const queued of unseenCatchUp) enqueueTrajectoryPayload(queued);
          if (d?.play_id !== lastTrajectoryPlayId.current) enqueueTrajectoryPayload(d);
          startNextQueuedPlay();
          return;
        }
      }

      // Only swap in a genuinely new play. Polling re-fetches the same pitch
      // repeatedly, and swapping identical data would restart the animation
      // (Pitch/Batter reset their clocks whenever pitchData changes).
      const nextTrajectoryResolutionKey = trajectoryResolutionKey(d);
      const nextBattedPayload = d?.batted_ball || null;
      const nextBattedBall = nextBattedPayload ? toBattedBallData(nextBattedPayload) : null;
      const nextBattedResolutionKey = battedBallResolutionKey(nextBattedPayload);

      if (d?.play_id === lastTrajectoryPlayId.current) {
        if (d?.game_state) currentPitchScoreSnapshotRef.current = d.game_state;
        if (
          isGameTerminal(d?.game_state?.gameState) ||
          isGameTerminal(d?.game_state?.detailedState) ||
          d?.game_state?.abstractGameState === 'Final'
        ) {
          setGameTerminal(true);
        }
        // Late-resolution guard: a play can gain its run/out/result or terminal
        // game state after its animation already finished. Commit the enriched
        // snapshot immediately if the play has finished, so the scoreboard
        // reflects the final score and terminal state even if trajectory flight
        // resolution keys match.
        if (playFinishedRef.current && d?.game_state) {
          completedPlaySnapshotRef.current = d.game_state;
          setScorebugStateOverride(d.game_state);
        }
        // Do not replace pitchData here: BattedBall uses that object as the
        // animation identity, and replacing it would restart a long play.
        // A newly-completed hit is applied independently so its pending OUT /
        // DOUBLE PLAY callbacks can catch up with the current flight clock.
        if (nextTrajectoryResolutionKey === lastTrajectoryResolutionKey.current) return;
        lastTrajectoryResolutionKey.current = nextTrajectoryResolutionKey;
        // A late-arriving action_event (stolen base / caught stealing / pickoff
        // attempt / balk / wild pitch / passed ball) or a late-resolved
        // result_event (walk / strikeout / ...) can land a poll after the pitch
        // already reached the plate and showed a bare BALL/STRIKE. Merge those
        // two fields into the live pitch in place — same object identity, so
        // the Pitch/Batter/BattedBall clocks don't restart — then surface the
        // outcome the earlier reveal missed.
        const livePitch = pitchDataRef.current;
        if (livePitch && livePitch.play_id === d.play_id) {
          const prevAction = livePitch.action_event ?? null;
          const prevResult = livePitch.result_event ?? null;
          const nextAction = d.action_event ?? null;
          const nextResult = d.result_event ?? null;
          if (nextAction !== prevAction) livePitch.action_event = nextAction;
          if (nextResult !== prevResult) livePitch.result_event = nextResult;
          // Only surface the late outcome once the play has already finished
          // (a take/whiff resolves at the plate). If the poll lands while the
          // pitch is still in flight, just merge the fields above: the upcoming
          // handlePitchArrival reads the enriched pitchData and reveals the
          // right label at the plate instead of spoiling it early. Showing
          // early would also mark the outcome shown and make handlePitchArrival
          // skip finishCurrentPlay, which would wedge the queue.
          if ((nextAction !== prevAction || nextResult !== prevResult) && playFinishedRef.current) {
            const lateLabel = resolvePlayOutcomeLabel(livePitch);
            if (lateLabel) showOutcome(lateLabel);
          }
        }
        if (nextBattedPayload && nextBattedResolutionKey !== lastBattedResolutionKey.current) {
          lastBattedPlayId.current = nextBattedPayload.play_id;
          lastBattedResolutionKey.current = nextBattedResolutionKey;
          rememberAppliedBattedBall(nextBattedPayload, nextBattedResolutionKey);
          setBattedBallData(nextBattedBall);
        }
        // Late-resolution guard: a play can gain its run/out/result after its
        // animation already finished. The completion committed the play's
        // un-enriched snapshot, so re-commit the enriched one here — the
        // scorebug must reflect the late result even though nothing is left to
        // animate. Refresh the deferred completion snapshot too, so a
        // completion effect that hasn't run yet commits the enriched state
        // instead of overwriting this override with the stale one.
        if (playFinishedRef.current && d?.game_state) {
          completedPlaySnapshotRef.current = d.game_state;
          setScorebugStateOverride(d.game_state);
        }
        return;
      }

      // A queued play can be enriched by a later poll before it starts. Keep
      // the newest payload for that play without adding a duplicate animation.
      const queuedIndex = queuedTrajectoryQueueIndex(d?.play_id);
      if (queuedIndex >= 0) {
        trajectoryQueueRef.current[queuedIndex] = d;
        return;
      }

      // Never replace an unfinished animation with a newer response. Queue it
      // so its own scoreboard snapshot is committed only after it finishes.
      const hasActivePitch = !!pitchDataRef.current || lastTrajectoryPlayId.current != null;
      if (!reviewRef.current.active && !replayRef.current.active && trajectoryQueueRef.current.length > 0) {
        enqueueTrajectoryPayload(d);
        startNextQueuedPlay();
        return;
      }
      if (!reviewRef.current.active && !replayRef.current.active && hasActivePitch && !playFinishedRef.current) {
        enqueueTrajectoryPayload(d);
        startNextQueuedPlay();
        return;
      }

      applyTrajectoryPayload(d);
      };

      if (broadcastDelayMsRef.current > 0 || delayedTrajectoryBufferRef.current?.size > 0) {
        scheduleDelayedTrajectoryResponse(d, gamePk, processTrajectoryPayload);
        return;
      }
      processTrajectoryPayload();
    } catch (err) {
      const detail = err.response?.data?.detail;
      const isWaiting = detail === NO_SIMULATABLE_PITCH_DETAIL;
      // The backend returns a 502 when the MLB feed itself is slow or down.
      // That's transient — the 1s poller retries and recovers — so it must not
      // flash a hard "Failed to fetch trajectory" banner (which made Jump to
      // newest look broken during a cold rebuild or a momentary feed outage).
      const isFeedDown = typeof detail === 'string' && detail.startsWith('Failed to fetch from MLB API');
      // A client-side timeout or network error produces NO server response at
      // all (``err.response`` is undefined). Like a feed blip, that's transient
      // — a cold trajectory rebuild can legitimately exceed the poll timeout
      // while the backend is still computing it — so treat it as "still
      // loading" and let the 1s poller retry instead of flashing a red banner.
      // Only a genuine server response (which always carries a ``detail`` on
      // this backend) surfaces a real failure.
      const hasServerResponse = !!err.response;
      if (isWaiting && seq >= lastTrajectoryAppliedSeq.current) {
        // A game can have no valid pitch yet, so there is no previous payload
        // to carry the status. Treat the expected 404 as a waiting state, not
        // as a red error banner.
        setWaitingForPitchData(true);
        setPendingPitchNumber(null);
        setError(null);
      } else if (isFeedDown) {
        // Keep the current view and let the poller retry; surface nothing more
        // than a console warning so the feed blip isn't mistaken for a failure.
        if (!silent && seq === trajectoryReqSeq.current) {
          console.warn("Trajectory feed temporarily unavailable, will retry", err);
        }
        setWaitingForPitchData(false);
        setPendingPitchNumber(null);
        setError(null);
      } else if (!hasServerResponse) {
        // Client-side timeout / network drop: keep the current view, mark it as
        // still loading, and retry silently on the next tick.
        if (!silent && seq === trajectoryReqSeq.current) {
          console.warn("Trajectory request timed out; still loading, will retry", err);
        }
        setWaitingForPitchData(true);
        setPendingPitchNumber(null);
        setError(null);
      } else if (!silent && seq === trajectoryReqSeq.current) {
        // A real server response: surface the backend's detail (e.g. a 500
        // "Simulation failed") as a genuine failure, not a transient blip.
        console.error("Failed to fetch trajectory", err);
        setWaitingForPitchData(false);
        setPendingPitchNumber(null);
        setError(detail || "Failed to fetch trajectory data from backend.");
      }
    } finally {
      trajectoryRequestsInFlight.current = Math.max(0, trajectoryRequestsInFlight.current - 1);
      if (!silent) {
        trajectoryLoadingCount.current = Math.max(0, trajectoryLoadingCount.current - 1);
        if (trajectoryLoadingCount.current === 0) setLoading(false);
      }
    }
  };

  // Normalize the raw /api/batted-ball (or at-bat ``hit``) payload into the
  // shape BattedBall expects, shared by live polling and at-bat replay.
  const toBattedBallData = (d) => (d ? ({
    playId: d.play_id,
    pitchPlayId: d.pitch_play_id,
    pitchNumber: d.pitch_number,
    atBatIndex: d.at_bat_index,
    playComplete: d.play_complete ?? d.is_complete ?? false,
    launchSpeed: d.launch_speed,
    launchAngle: d.launch_angle,
    sprayAngle: d.spray_angle ?? 0,
    totalDistance: d.total_distance,
    coordX: d.coord_x,
    coordY: d.coord_y,
    fielder: d.fielder || 'CF',
    // Backend payloads use `fielder_name`; keep both spellings available for
    // older at-bat/replay payloads and the top-left fielder overlay.
    fielderName: d.fielder_name || d.fielderName || d.fielder_player_name || null,
    wasCaught: !!d.was_caught,
    trajectory: d.trajectory,
    batter: d.batter,
    pitcher: d.pitcher,
    description: d.description,
    event: d.event,
    eventType: d.event_type,
    runners: d.runners || [],
    totalOuts: d.total_outs ?? 0,
    label: d.batter
      ? `${d.batter} — ${(d.trajectory || 'hit').replace(/_/g, ' ')}`
      : 'Live batted ball',
  }) : null);

  const queuedTrajectoryQueueIndex = (playId) => (
    trajectoryQueueRef.current.findIndex((queued) => queued?.play_id === playId)
  );

  const enqueueTrajectoryPayload = (d) => {
    const playId = d?.play_id;
    if (playId == null || knownTrajectoryPlayIdsRef.current.has(playId)) return false;
    const queuedIndex = queuedTrajectoryQueueIndex(playId);
    if (queuedIndex >= 0) {
      trajectoryQueueRef.current[queuedIndex] = d;
      return false;
    }
    queuedTrajectoryPlayIdsRef.current.add(playId);
    trajectoryQueueRef.current.push(d);
    // Cap the backlog: once the queue passes the max, drop the oldest
    // unrendered play. Its id stays in knownTrajectoryPlayIdsRef so a later
    // poll's catch-up list won't resurrect it; the newest plays always remain
    // queued and animate next.
    while (trajectoryQueueRef.current.length > MAX_QUEUED_PLAYS) {
      const dropped = trajectoryQueueRef.current.shift();
      queuedTrajectoryPlayIdsRef.current.delete(dropped?.play_id ?? null);
    }
    setQueuedPlayCount(trajectoryQueueRef.current.length);
    return true;
  };

  const rememberAppliedBattedBall = (d, resolutionKey = battedBallResolutionKey(d)) => {
    const playId = d?.play_id;
    if (playId == null) return;
    const applied = appliedBattedPlayIdsRef.current;
    applied.delete(playId);
    applied.set(playId, resolutionKey);
    // A bounded client history is enough to deduplicate repeated catch-up
    // responses without growing for the entire game.
    while (applied.size > 64) {
      applied.delete(applied.keys().next().value);
    }
  };

  const queueBattedBallPayload = (d) => {
    const playId = d?.play_id;
    if (playId == null || appliedBattedPlayIdsRef.current.has(playId)) return;
    const existing = pendingBattedBallsRef.current.get(playId);
    if (!existing || battedBallResolutionKey(existing) !== battedBallResolutionKey(d)) {
      pendingBattedBallsRef.current.set(playId, d);
    }
  };

  const applyBattedBallPayload = (d) => {
    const playId = d?.play_id;
    if (playId == null) return false;
    const resolutionKey = battedBallResolutionKey(d);
    if (appliedBattedPlayIdsRef.current.get(playId) === resolutionKey) {
      pendingBattedBallsRef.current.delete(playId);
      return false;
    }

    const activePitch = pitchDataRef.current;
    const ownsActivePitch = d.pitch_play_id != null
      ? d.pitch_play_id === activePitch?.play_id
      : (
        activePitch?.at_bat_index != null &&
        d?.at_bat_index === activePitch.at_bat_index &&
        activePitch.is_contact === true
      );
    if (!ownsActivePitch) {
      // Legacy payloads without pitch_play_id retain the old safety rule: an
      // unrelated hit is ignored, while new backend payloads can wait for the
      // exact owning trajectory.
      if (d.pitch_play_id != null) queueBattedBallPayload(d);
      return false;
    }

    pendingBattedBallsRef.current.delete(playId);
    lastBattedPlayId.current = playId;
    lastBattedResolutionKey.current = resolutionKey;
    rememberAppliedBattedBall(d, resolutionKey);
    const bb = toBattedBallData(d);
    setBattedBallData(bb);
    // When auto-fielder-cam is OFF, make the replay button immediately
    // available as soon as a contact play's fielding data arrives.
    if (!autoFielderCamRef.current && bb?.fielder) {
      fielderCamAvailable.current = true;
    }
    return true;
  };

  const applyTrajectoryPayload = (d) => {
    const bundledBattedBall = d?.batted_ball || null;
    const pendingBattedBall = d?.play_id
      ? pendingBattedBallsRef.current.get(d.play_id)
      : null;
    // Prefer a separately-polled payload when one is already waiting for this
    // pitch; it may contain the final result/runners after trajectory data was
    // built from an earlier feed snapshot.
    const nextBattedPayload = pendingBattedBall || bundledBattedBall;
    const nextBattedBall = nextBattedPayload ? toBattedBallData(nextBattedPayload) : null;
    const nextBattedResolutionKey = battedBallResolutionKey(nextBattedPayload);
    lastTrajectoryPlayId.current = d?.play_id ?? null;
    if (d?.play_id != null) knownTrajectoryPlayIdsRef.current.add(d.play_id);
    lastTrajectoryResolutionKey.current = trajectoryResolutionKey(d);
    pitchDataRef.current = d;
    outcomeShownPlayId.current = null;
    playFinishedRef.current = false;
    fielderCamAvailable.current = false;
    fielderCamArmedRef.current = false;
    fielderCamFiredRef.current = false;
    currentPitchScoreSnapshotRef.current = d?.game_state ?? null;
    if (nextBattedPayload) {
      pendingBattedBallsRef.current.delete(nextBattedPayload.play_id);
      lastBattedPlayId.current = nextBattedPayload.play_id;
      lastBattedResolutionKey.current = nextBattedResolutionKey;
      rememberAppliedBattedBall(nextBattedPayload, nextBattedResolutionKey);
    }
    // A non-contact pitch clears the animation data but deliberately keeps the
    // last applied hit cursor, so a later dropped-hit response can be resumed.
    setBattedBallData(nextBattedBall);
    // When auto-fielder-cam is OFF, make the replay button immediately
    // available for contact plays with fielding data (don't wait for the
    // first completion).
    if (!autoFielderCamRef.current && nextBattedBall?.fielder) {
      fielderCamAvailable.current = true;
    }
    // A new pitch is about to animate: clear the previous outcome and slide
    // the panel out of the screen to the left until this pitch finishes, so
    // the scorebug remains frozen on the last completed snapshot and the pitch
    // details do not spoil the play before it animates.
    setPitchOutcome(null);
    setPanelSlidOut(true);
    // Every new pitch resolves onto the pitch panel, not whatever view was
    // left open (the Defense tab previously auto-opened after every play).
    // At-Bat and Defense stay available through their tabs; Defense only
    // auto-reopens when the fielding actually changes (see below). The game
    // view (a whole-game scope inside the At-Bat tab) also closes, so
    // reopening the tab never lands on a stale batter's game summary — it
    // refreshes to the at-bat view and re-fetches on the next open.
    setAtBatOpen(false);
    setDefenseOpen(false);
    setBatterGameOpen(false);
    setPitchData(d);
  };

  const cancelQueuedStart = () => {
    if (queueStartTimerRef.current) {
      clearTimeout(queueStartTimerRef.current);
      queueStartTimerRef.current = null;
    }
  };

  // Drain the queue by starting the next play when the current one is finished
  // (or when nothing is active). This is the single point that advances from
  // one play to the next, so queued plays always animate in arrival order and
  // never skip ahead to a play that hasn't animated yet.
  const startNextQueuedPlay = () => {
    if (reviewRef.current.active || replayRef.current.active) return;
    // If a gap between plays is already scheduled, leave it to that tick so a
    // concurrent poll can't jump the queue and clear the finished play's
    // outcome before it has been seen.
    if (queueStartTimerRef.current) return;
    const hasActivePitch = !!pitchDataRef.current || lastTrajectoryPlayId.current != null;
    if (hasActivePitch && !playFinishedRef.current) return;
    const next = trajectoryQueueRef.current.shift();
    if (next) {
      queuedTrajectoryPlayIdsRef.current.delete(next.play_id ?? null);
      applyTrajectoryPayload(next);
      // A play left the queue: refresh the on-screen count so the Jump-to-
      // newest control keeps its badge accurate as the backlog drains.
      setQueuedPlayCount(trajectoryQueueRef.current.length);
    }
  };

  // Advance the queue after a short pause so each just-finished play's outcome
  // indicator is visible in order before the next play's animation clears it.
  // Idempotent: re-scheduling replaces any pending timer.
  const scheduleNextQueuedPlay = () => {
    if (reviewRef.current.active || replayRef.current.active) return;
    cancelQueuedStart();
    queueStartTimerRef.current = setTimeout(() => {
      queueStartTimerRef.current = null;
      startNextQueuedPlay();
    }, QUEUE_PLAY_GAP_MS);
  };

  const fetchBattedBall = async (gamePk = activeGamePk, { silent = false } = {}) => {
    const seq = ++battedReqSeq.current;
    battedBallRequestsInFlight.current += 1;
    try {
      const response = await axios.get(
        withGame(`${API_BASE}/api/batted-ball`, gamePk, {
          after_play_id: lastBattedPlayId.current,
        }),
        { timeout: LIVE_POLL_TIMEOUT_MS },
      );
      const d = response.data;
      // Drop this response only when a NEWER response has already arrived, so
      // a slow poll can't overwrite the newest hit with a stale one. Comparing
      // against the latest request *started* starves the feed under latency.
      if (seq < lastBattedAppliedSeq.current) return;
      lastBattedAppliedSeq.current = seq;

      // Apply recovered hits in feed order. A hit whose owning trajectory has
      // not started is held by pitch_play_id; the top-level newest hit is then
      // safe to process without overwriting an earlier animation. The whole
      // response is held first when broadcast delay is enabled, so a hit cannot
      // arrive in the scene before its delayed owning pitch.
      const processBattedBallResponse = () => {
        const recovered = Array.isArray(d?.queued_batted_balls)
          ? d.queued_batted_balls
          : [];
        for (const hit of [...recovered, d]) applyBattedBallPayload(hit);
      };
      if (broadcastDelayMsRef.current > 0 || delayedBattedBallBufferRef.current?.size > 0) {
        for (const hit of [
          ...(Array.isArray(d?.queued_batted_balls) ? d.queued_batted_balls : []),
          d,
        ]) {
          scheduleDelayedBattedBallPayload(hit, gamePk, () => applyBattedBallPayload(hit));
        }
      } else {
        processBattedBallResponse();
      }
    } catch (err) {
      if (!silent && seq === battedReqSeq.current) console.error("Failed to fetch batted ball", err);
      // Keep the bundled demo samples running when no live hit is available.
    } finally {
      battedBallRequestsInFlight.current = Math.max(0, battedBallRequestsInFlight.current - 1);
    }
  };

  const fetchLiveGames = async ({ silent = false } = {}) => {
    try {
      if (!silent) setLiveGamesLoading(true);
      const response = await axios.get(`${API_BASE}/api/live-games`);
      const publish = () => {
        setLiveGames(response.data?.games ?? []);
        setFinishedGames(response.data?.finished ?? []);
        setUpcomingGames(response.data?.upcoming ?? []);
      };
      if (broadcastDelayMsRef.current > 0 || delayedUiBufferRef.current?.size > 0) {
        scheduleDelayedUiUpdate('live-games', response.data, publish, {
          scope: 'global',
          gamePk: null,
        });
      } else {
        publish();
      }
    } catch (err) {
      console.error("Failed to fetch live games", err);
    } finally {
      if (!silent) setLiveGamesLoading(false);
    }
  };

  // Auto-refresh the drawer in the background. A ref keeps the interval stable
  // across the frequent re-renders caused by live pitch polling (re-keying the
  // effect on ``fetchLiveGames`` would restart the timer every render).
  const fetchLiveGamesRef = useRef(fetchLiveGames);
  fetchLiveGamesRef.current = fetchLiveGames;
  useEffect(() => {
    const id = setInterval(() => fetchLiveGamesRef.current({ silent: true }), LIVE_GAMES_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Force a full re-fetch + re-animate to the newest live play, used whenever
  // the user returns to the live feed: picking a game from the live-games
  // drawer, re-entering the currently-watched game, abandoning a replay back
  // to live, or exiting a comparison. It discards any queued-but-unrendered
  // plays and resets every cursor so the next fetch applies ONLY the newest
  // play instead of draining a stale catch-up list one animation at a time.
  const refreshAll = (gamePk = activeGamePk) => {
    // Invalidate any poll still in flight from a previous game or replay
    // period. A replay-period request is built from the replayed pitch's
    // cursor, so if it resolves after Back to Live it would re-enqueue its
    // stale catch-up list and regress the app to older pitches instead of
    // resuming the live feed. Advancing the applied seq past every in-flight
    // seq drops those responses.
    trajectoryReqSeq.current += 1;
    lastTrajectoryAppliedSeq.current = trajectoryReqSeq.current;
    battedReqSeq.current += 1;
    lastBattedAppliedSeq.current = battedReqSeq.current;

    trajectoryQueueRef.current = [];
    queuedTrajectoryPlayIdsRef.current.clear();
    setQueuedPlayCount(0);
    cancelQueuedStart();
    knownTrajectoryPlayIdsRef.current.clear();
    pendingBattedBallsRef.current.clear();
    delayedTrajectoryBufferRef.current?.clear({ resetDelivered: true });
    delayedBattedBallBufferRef.current?.clear({ resetDelivered: true });
    delayedUiBufferRef.current?.clear({ resetDelivered: true });
    setNewLivePlayAvailable(false);
    appliedBattedPlayIdsRef.current.clear();
    pitchDataRef.current = null;
    playFinishedRef.current = false;
    currentPitchScoreSnapshotRef.current = null;
    lastTrajectoryPlayId.current = null;
    lastBattedPlayId.current = null;
    lastTrajectoryResolutionKey.current = null;
    lastBattedResolutionKey.current = null;
    lastPendingPlayEventRef.current = null;
    // Clear the scene immediately so the old pitch doesn't keep animating
    // while the new fetch is in flight (matches backToLive's behaviour).
    setPitchData(null);
    setBattedBallData(null);
    setPitchOutcome(null);
    setWaitingForPitchData(false);
    setError(null);
    // Kick off a background trajectory build server-side so this first poll
    // (and the ones that follow) hit a warm cache instead of a cold rebuild.
    // Fire-and-forget with a short timeout so it never contributes to loading
    // state or a failure banner; the build reuses the backend's single-flight
    // lock, so it never duplicates the real poll's work.
    if (gamePk) {
      axios.get(withGame(`${API_BASE}/api/trajectory/prewarm`, gamePk), { timeout: 8000 }).catch(() => {});
    }
    fetchTrajectory(gamePk);
    fetchBattedBall(gamePk);
    setHudRefresh(prev => prev + 1);
  };

  const startHighSpeedTest = () => {
    if (highSpeedTestActiveRef.current) {
      stopHighSpeedTest();
      return;
    }
    if (!pitchDataRef.current?.trajectory?.length) return;
    if (reviewRef.current.active) exitReview();
    if (replayRef.current.active) backToLive();
    if (compareModeRef.current === 'active') exitComparison();
    if (compareModeRef.current === 'selecting') cancelCompareSelecting();
    cancelQueuedStart();
    trajectoryQueueRef.current = [];
    queuedTrajectoryPlayIdsRef.current.clear();
    setQueuedPlayCount(0);
    highSpeedTestActiveRef.current = true;
    setHighSpeedTestActive(true);
    const testPitch = makeHighSpeedTestPitch(pitchDataRef.current);
    if (!testPitch) {
      highSpeedTestActiveRef.current = false;
      setHighSpeedTestActive(false);
      return;
    }
    lastTrajectoryPlayId.current = testPitch.play_id;
    lastTrajectoryResolutionKey.current = trajectoryResolutionKey(testPitch);
    lastBattedPlayId.current = null;
    lastBattedResolutionKey.current = null;
    pitchDataRef.current = testPitch;
    playFinishedRef.current = false;
    outcomeShownPlayId.current = null;
    setBattedBallData(null);
    setPitchOutcome(null);
    setPanelSlidOut(true);
    setAtBatOpen(false);
    setDefenseOpen(false);
    setPitchData(testPitch);
  };

  // Enter review-mode replay of a historical at-bat (used by finished-game
  // cards). Unlike selectReviewPlay it keeps the game marked terminal so the
  // app never treats a finished game as live (no Live tab, no polling).
  const enterFinishedGameReview = (atBatIndex) => {
    const next = {
      active: true,
      atBatIndex,
      playId: null,
      autoAdvance: atBatIndex != null,
    };
    reviewRef.current = next;
    setReview(next);
    setReviewScoreTab('replay');
    // Remember the live alignment before the replayed at-bat's snapshots start
    // driving the defense panel, so Return to Live can restore it.
    liveDefenseRef.current = defenseData;
    setNewLivePlayAvailable(false);
    setScorebugStateOverride(null);
    setPanelSlidOut(false);
    if (atBatIndex == null) {
      setPitchPanelOpen(false);
      setAtBatOpen(false);
      return;
    }
    setPitchPanelOpen(true);
    setAtBatOpen(true);
    setDefenseOpen(false);
  };

  const selectFinishedGame = async (gamePk) => {
    if (highSpeedTestActiveRef.current) stopHighSpeedTest();
    if (compareModeRef.current === 'active') exitComparison({ skipRefresh: true });
    if (compareModeRef.current === 'selecting') cancelCompareSelecting();
    // Drop any active review (a previous finished game or a game-log click)
    // without Back to Live's live refresh of the old game.
    reviewRef.current = { active: false, atBatIndex: null, playId: null, autoAdvance: false };
    setReview({ active: false, atBatIndex: null, playId: null, autoAdvance: false });
    setReviewScoreTab('replay');
    // Clear the previous game's pitch/batted-ball/at-bat state so a finished
    // game whose fetches fail doesn't keep the old game's scene or scorebug on
    // screen.
    pitchDataRef.current = null;
    currentPitchScoreSnapshotRef.current = null;
    setPitchData(null);
    setBattedBallData(null);
    setScorebugStateOverride(null);
    setWaitingForPitchData(false);
    setPendingPitchNumber(null);
    setPitchOutcome(null);
    outcomeShownPlayId.current = null;
    setAtBatData(null);
    setAtBatError(null);
    // The game is over: keep it terminal so there's no Live tab and no polling.
    setGameTerminal(true);
    setActiveGamePk(gamePk);
    // Find the finished game's final at-bat so rewind can replay it. If none
    // (e.g. the feed has no plays), enter review anyway with no selection.
    let atBatIndex = null;
    try {
      const res = await axios.get(`${API_BASE}/api/game-log?game_pk=${gamePk}`);
      const plays = (res.data?.plays ?? []).filter((p) => p.id != null);
      if (plays.length > 0) atBatIndex = plays[plays.length - 1].id;
    } catch {
      atBatIndex = null;
    }
    enterFinishedGameReview(atBatIndex);
  };

  const selectGame = (gamePk) => {
    if (highSpeedTestActiveRef.current) stopHighSpeedTest();
    if (gamePk === activeGamePk) {
      // Re-entering the game the user is already on: if plays are queued but
      // not yet rendered, drop them and jump straight to the newest play.
      // Nothing is skipped when nothing is waiting (a plain no-op).
      if (trajectoryQueueRef.current.length > 0
          || queuedTrajectoryPlayIdsRef.current.size > 0
          || pendingBattedBallsRef.current.size > 0) {
        refreshAll(activeGamePk);
      }
      return;
    }
    setActiveGamePk(gamePk);
    // Clear the previous game's pitch/batted-ball/at-bat state so a live game
    // whose first fetch fails (or which has no pitch data yet, e.g. a warmup
    // game) doesn't keep replaying the previous game's last scene, and the
    // at-bat panel doesn't try to load the old game's pitches against the
    // newly-selected game_pk.
    pitchDataRef.current = null;
    currentPitchScoreSnapshotRef.current = null;
    setPitchData(null);
    setBattedBallData(null);
    setScorebugStateOverride(null);
    setWaitingForPitchData(false);
    setPendingPitchNumber(null);
    setPitchOutcome(null);
    outcomeShownPlayId.current = null;
    setAtBatData(null);
    setAtBatError(null);
    // Selecting a different game resumes the app-level pollers; the new
    // game's first payload flips this back if it is already final. When the
    // new game's first play animates, applyTrajectoryPayload switches the
    // panel to the pitch view; the Defense tab only auto-reopens on an actual
    // fielding change.
    setGameTerminal(false);
    refreshAll(gamePk);
  };

  // Snap the live view straight to the newest play: discard any queued-but-
  // unrendered plays and re-fetch the newest from scratch (the same discard
  // path used by switching games, exiting replay, and exiting comparison).
  const jumpToNewest = () => {
    refreshAll(activeGamePk);
  };

  // Fetch every pitch thrown to the current batter across the whole game,
  // grouped by pitcher, for the at-bat tab's game view. Lightweight payload:
  // location/type/outcome only (the game view disables click-to-replay).
  const fetchBatterGame = async (atBatIndex) => {
    try {
      setBatterGameLoading(true);
      setBatterGameError(null);
      // Clear the previous batter's dots when the at-bat rolls over, so the
      // zone resets to "Loading…" instead of briefly showing the old batter.
      if (batterGameData && batterGameData.at_bat_index !== atBatIndex) setBatterGameData(null);
      const params = new URLSearchParams();
      if (activeGamePk) params.set('game_pk', activeGamePk);
      if (atBatIndex != null) params.set('at_bat_index', atBatIndex);
      const qs = params.toString();
      const response = await axios.get(`${API_BASE}/api/batter-pitches${qs ? `?${qs}` : ''}`);
      // Drop stale responses (e.g. a batter change while an older fetch was
      // still in flight) so the zone never shows the previous batter's pitches.
      if (atBatIndex != null && response.data?.at_bat_index !== atBatIndex) return;
      const publish = () => setBatterGameData(response.data);
      if (broadcastDelayMsRef.current > 0 || delayedUiBufferRef.current?.size > 0) {
        scheduleDelayedUiUpdate(
          `batter-game:${activeGamePk ?? 'default'}:${atBatIndex ?? 'current'}`,
          response.data,
          publish,
        );
      } else {
        publish();
      }
    } catch (err) {
      console.error("Failed to fetch batter game pitches", err);
      setBatterGameError(err.response?.data?.detail || "Failed to load the batter's game pitches.");
    } finally {
      setBatterGameLoading(false);
    }
  };

  const fetchAtBat = async (atBatIndex) => {
    try {
      setAtBatLoading(true);
      setAtBatError(null);
      // Clear the previous batter's dots when the at-bat rolls over, so the
      // zone resets to "Loading…" instead of briefly showing the old batter.
      if (atBatData && atBatData.at_bat_index !== atBatIndex) setAtBatData(null);
      const params = new URLSearchParams();
      if (activeGamePk) params.set('game_pk', activeGamePk);
      if (atBatIndex != null) params.set('at_bat_index', atBatIndex);
      const qs = params.toString();
      const response = await axios.get(`${API_BASE}/api/at-bat${qs ? `?${qs}` : ''}`);
      // Drop stale responses (e.g. a batter change while an older fetch was
      // still in flight) so the zone never shows the previous batter's pitches.
      if (atBatIndex != null && response.data?.at_bat_index !== atBatIndex) return;
      const publish = () => setAtBatData(response.data);
      if (broadcastDelayMsRef.current > 0 || delayedUiBufferRef.current?.size > 0) {
        scheduleDelayedUiUpdate(
          `at-bat:${activeGamePk ?? 'default'}:${atBatIndex ?? 'current'}`,
          response.data,
          publish,
        );
      } else {
        publish();
      }
    } catch (err) {
      console.error("Failed to fetch at-bat", err);
      // Surface the backend's reason (e.g. "Game hasn't started yet!" or
      // "At-bat N not found.") instead of a generic failure message.
      setAtBatError(err.response?.data?.detail || "Failed to load at-bat pitches.");
    } finally {
      setAtBatLoading(false);
    }
  };

  const selectReviewPlay = (play) => {
    if (play?.id == null) return;
    // Clicking a game-log play jumps to review of a historical at-bat, so
    // drop any active comparison overlay (and pending selection) first. No
    // live refresh: review mode ignores live plays, and the at-bat panel
    // loads its own data.
    if (compareMode === 'active') exitComparison({ skipRefresh: true });
    if (compareMode === 'selecting') cancelCompareSelecting();
    setReview({ active: true, atBatIndex: play.id, playId: null, autoAdvance: true });
    reviewRef.current = { active: true, atBatIndex: play.id, playId: null, autoAdvance: true };
    setReviewScoreTab('replay');
    // Remember the live alignment before the replayed at-bat's snapshots
    // start driving the defense panel, so Return to Live can restore it.
    liveDefenseRef.current = defenseData;
    setScorebugStateOverride(null);
    setNewLivePlayAvailable(false);
    // A game-log click inside a finished game must not un-terminal the app:
    // there is no live feed to return to, and un-terminating would show the
    // (meaningless) Live tab and resume polling a finished game.
    if (!gameTerminalRef.current) setGameTerminal(false);
    setAtBatOpen(true);
    setDefenseOpen(false);
    setPitchPanelOpen(true);
    setPanelSlidOut(false);
  };

  const exitReview = () => {
    reviewRef.current = { active: false, atBatIndex: null, playId: null, autoAdvance: false };
    setReview({ active: false, atBatIndex: null, playId: null, autoAdvance: false });
    setReviewScoreTab('replay');
    backToLive();
  };

  const selectPitchView = () => {
    // Leaving the at-bat view ends an active comparison or drops a pending
    // selection (its controls live in the at-bat view, so there'd otherwise
    // be no way out).
    if (compareMode === 'active') exitComparison();
    if (compareMode === 'selecting') cancelCompareSelecting();
    if (!pitchData) return;
    setDefenseOpen(false);
    // Freeze the panel's current dimensions so the switch back to the pitch
    // view eases from the at-bat content's size instead of snapping.
    const panel = pitchPanelRef.current;
    if (panel) {
      const rect = panel.getBoundingClientRect();
      setAtBatSnapshotWidth(rect.width);
      setAtBatSnapshotHeight(rect.height);
    }
    setAtBatOpen(false);
    setPitchPanelOpen(true);
    // Bump the key so the pitch content wrapper remounts and fades in.
    setPitchContentKey((k) => k + 1);
  };

  const selectAtBatView = () => {
    if (!pitchData) return;
    // Freeze the panel's current rendered dimensions so the loading state
    // (or the empty gap before it) doesn't collapse the panel inward.
    const panel = pitchPanelRef.current;
    if (panel) {
      const rect = panel.getBoundingClientRect();
      setAtBatSnapshotWidth(rect.width);
      setAtBatSnapshotHeight(rect.height);
    }      setAtBatOpen(true);
    setDefenseOpen(false);
    setPitchPanelOpen(true);
  };

  const selectDefenseView = () => {
    if (!pitchData) return;
    setAtBatOpen(false);
    setDefenseOpen(true);
    setPitchPanelOpen(true);
  };

  // ── Tunneling comparison visualizer ─────────────────────────────────────
  // Enter selection mode: the Compare button becomes Simulate and the at-bat
  // zone switches from replaying a clicked pitch to toggling it for compare.
  const startCompareSelecting = () => {
    // Comparison is intentionally uncluttered by default. Snapshot the user's
    // current playback-menu choices once, so both selecting and active modes
    // show the comparison defaults and exit can restore them exactly.
    if (preComparisonVisualsRef.current == null) {
      preComparisonVisualsRef.current = {
        showColoredTails,
        showBillowParticles,
      };
    }
    setShowColoredTails(false);
    setShowBillowParticles(false);
    setCompareSelectedIds([]);
    setCompareMode('selecting');
    // Protect the at-bat being selected from: a new live play is surfaced as
    // a notice instead of swapping in and resetting the zone mid-selection.
    comparisonBaselinePlayIdRef.current = lastTrajectoryPlayId.current;
    setNewLivePlayAvailable(false);
  };

  // Drop a pending comparison selection and return to the normal at-bat view
  // (playback speed is untouched — it only changes when the comparison runs).
  const cancelCompareSelecting = () => {
    setCompareMode('idle');
    if (preComparisonVisualsRef.current) {
      setShowColoredTails(preComparisonVisualsRef.current.showColoredTails);
      setShowBillowParticles(preComparisonVisualsRef.current.showBillowParticles);
      preComparisonVisualsRef.current = null;
    }
    setCompareSelectedIds([]);
    // Releasing the protection lets the next poll apply any play that arrived
    // while the selection was open.
    comparisonBaselinePlayIdRef.current = null;
    setNewLivePlayAvailable(false);
  };

  const toggleCompareSelection = (p) => {
    if (!p?.replayable || !p?.play_id) return;
    setCompareSelectedIds((prev) => (
      prev.includes(p.play_id)
        ? prev.filter((id) => id !== p.play_id)
        : [...prev, p.play_id]
    ));
  };

  // Turn the selected pitches into overlaid animations. Forced down to 0.2x,
  // with the pre-comparison speed saved so exit can restore it.
  const startComparison = () => {
    if (compareSelectedIds.length < 2) return;
    if (preComparisonVisualsRef.current == null) {
      preComparisonVisualsRef.current = { showColoredTails, showBillowParticles };
    }
    setShowColoredTails(false);
    setShowBillowParticles(false);
    if (reviewRef.current.active) {
      reviewRef.current = { active: false, atBatIndex: null, playId: null, autoAdvance: false };
      setReview({ active: false, atBatIndex: null, playId: null, autoAdvance: false });
      setReviewScoreTab('replay');
    }
    const plays = (atBatData?.pitches ?? [])
      .filter((p) => compareSelectedIds.includes(p.play_id))
      .map((p) => ({ pitch: p.pitch, hit: toBattedBallData(p.hit) }))
      .filter((o) => o.pitch);
    if (plays.length < 2) return;

    // Baseline shared cycle: enough for the longest pitch flight plus the
    // windup, so comparisons without any batted ball still loop. Contact
    // plays' batted balls only lengthen this (see BattedBall comparison mode),
    // so the longest flight wins regardless of mount order.
    let maxPitchFlight = 0;
    for (const { pitch } of plays) {
      const traj = pitch?.trajectory;
      const t = traj?.[traj.length - 1]?.t ?? 0;
      if (t > maxPitchFlight) maxPitchFlight = t;
    }
    const duration = Math.max(0.5, maxPitchFlight)
      + tuning.playback.cyclePause + tuning.playback.ballReleaseTime
      + (tuning.playback.comparisonFinishPause ?? 0);

    setCycleDuration(duration, { force: true });
    resetSimulationTime();

    if (preComparisonSpeedRef.current == null) {
      const baseSpeed = (playbackSpeed != null && Math.abs(playbackSpeed - COMPARE_PLAYBACK_SPEED) > 0.001)
        ? playbackSpeed
        : (DEFAULT_TUNING.playback.timeScale ?? 0.61);
      preComparisonSpeedRef.current = baseSpeed;
    }
    setPreComparisonSpeed(preComparisonSpeedRef.current);
    setTuningValue('playback', 'timeScale', COMPARE_PLAYBACK_SPEED, { persist: false });
    setTimeScale(COMPARE_PLAYBACK_SPEED);
    setComparisonPlays(plays);
    setCompareMode('active');
    // A live play that arrives while the overlaid pitches animate is protected
    // (see fetchTrajectory) and surfaced as a notice, so it can't knock the
    // viewer out of the comparison. Remember which play was live when it began.
    comparisonBaselinePlayIdRef.current = lastTrajectoryPlayId.current;
    setNewLivePlayAvailable(false);
  };

  // Exits comparison mode and restores the pre-comparison playback speed.
  // `skipRefresh` is for callers that refresh the live feed themselves (Back
  // to Live) or enter a mode that ignores live plays (review): the overlay
  // state is cleared either way, only the re-fetch is skipped.
  const exitComparison = ({ skipRefresh = false } = {}) => {
    setCompareMode('idle');
    if (preComparisonVisualsRef.current) {
      setShowColoredTails(preComparisonVisualsRef.current.showColoredTails);
      setShowBillowParticles(preComparisonVisualsRef.current.showBillowParticles);
      preComparisonVisualsRef.current = null;
    }
    setComparisonPlays([]);
    setCompareSelectedIds([]);
    comparisonBaselinePlayIdRef.current = null;
    setNewLivePlayAvailable(false);
    resetSimulationTime();
    const restoredSpeed = preComparisonSpeedRef.current ?? preComparisonSpeed;
    if (restoredSpeed != null) {
      setTuningValue('playback', 'timeScale', restoredSpeed);
      setTimeScale(restoredSpeed);
    }
    preComparisonSpeedRef.current = null;
    setPreComparisonSpeed(null);
    // Returning to the live feed: discard any queued-but-unrendered plays and
    // animate only the newest live play, same as Back to Live and switching
    // games. The trajectory cursor stayed frozen at the pre-comparison
    // baseline while the overlay ran, so re-fetching from scratch (rather
    // than letting the next poll drain the catch-up list of everything that
    // happened meanwhile) is what prevents a barrage of stale plays.
    setPitchData(null);
    setBattedBallData(null);
    setPitchOutcome(null);
    setWaitingForPitchData(false);
    setPendingPitchNumber(null);
    outcomeShownPlayId.current = null;
    if (!skipRefresh) refreshAll(activeGamePk);
  };

  // "✕ Exit comparison" in the at-bat panel: unlike a Back-to-Live exit, this
  // does NOT jump to the live feed. It leaves the overlay, restarts the pitch
  // that was live when the comparison was entered, and stays on the at-bat
  // view so the user can immediately select other pitches to compare again.
  const exitComparisonToAtBat = () => {
    // Capture the baseline play before exitComparison clears the ref.
    const baselineId = comparisonBaselinePlayIdRef.current ?? lastTrajectoryPlayId.current;
    exitComparison({ skipRefresh: true });
    // Restart the play that was animating when the comparison began, pulled
    // from the at-bat list so it replays in place (no live-swap). We re-enter
    // review for it first so the replayed snapshot also drives the scoreboard
    // (scorebug 'replay' tab) and the defense panel, not just the scene.
    if (atBatData && baselineId != null) {
      const p = (atBatData.pitches || []).find((pp) => pp.play_id === baselineId);
      if (p?.replayable && p?.pitch) {
        // Remember the current (pre-replay) defensive alignment so Back to
        // Live can restore it once this review ends.
        liveDefenseRef.current = defenseData;
        const nextReview = {
          active: true,
          atBatIndex: p.pitch?.at_bat_index ?? atBatData.at_bat_index ?? null,
          playId: p.play_id,
          autoAdvance: false,
        };
        reviewRef.current = nextReview;
        setReview(nextReview);
        setReviewScoreTab('replay');
        setScorebugStateOverride(null);
        selectReplayPitch(p);
      }
    }
    // Stay on the at-bat panel (Replay itself collapses it when not in review,
    // so force it back open here).
    setAtBatOpen(true);
    setPitchPanelOpen(true);
    setDefenseOpen(false);
  };

  // Replay one pitch from the at-bat: swap it in exactly like a freshly-arrived
  // pitch (panel collapses, outcome clears, then reveals on arrival/play).
  const selectReplayPitch = (p, { autoAdvance = false } = {}) => {
    if (!p?.replayable || !p?.pitch) return;
    // Invalidate any live poll still in flight so its (now-stale) response
    // can't overwrite the replayed pitch after it lands.
    trajectoryReqSeq.current += 1;
    battedReqSeq.current += 1;
    // Freeze the panel's current dimensions (at-bat content) so the switch
    // back to the pitch view eases smoothly instead of snapping.
    const panel = pitchPanelRef.current;
    if (panel) {
      const rect = panel.getBoundingClientRect();
      setAtBatSnapshotWidth(rect.width);
      setAtBatSnapshotHeight(rect.height);
    }
    // Bump the key so the pitch content wrapper remounts and fades in.
    setPitchContentKey((k) => k + 1);
    if (!reviewRef.current.active) setAtBatOpen(false);
    if (!replayRef.current.active) setNewLivePlayAvailable(false);
    const nextReplay = {
      active: true,
      playId: p.play_id,
      pitchNumber: p.pitch_number,
      atBatIndex: p.pitch.at_bat_index ?? atBatData?.at_bat_index ?? null,
      // When switching directly between historical pitches, retain the live
      // baseline from the first replay. Using the currently displayed replay
      // pitch here makes the next poll mistake the real live pitch for a new
      // play and silently exit replay mode.
      livePlayId: replayRef.current.active
        ? replayRef.current.livePlayId
        : pitchData?.play_id ?? lastTrajectoryPlayId.current,
    };
    trajectoryQueueRef.current = [];
    queuedTrajectoryPlayIdsRef.current.clear();
    setQueuedPlayCount(0);
    replayRef.current = nextReplay;
    setReplay(nextReplay);
    if (reviewRef.current.active) {
      const nextReview = { ...reviewRef.current, playId: p.play_id, autoAdvance };
      reviewRef.current = nextReview;
      setReview(nextReview);
    }
    outcomeShownPlayId.current = null;
    playFinishedRef.current = false;
    setPitchOutcome(null);
    if (!reviewRef.current.active) {
      setPanelSlidOut(true);
    } else {
      setPanelSlidOut(false);
    }
    lastTrajectoryPlayId.current = p.play_id ?? null;
    lastTrajectoryResolutionKey.current = trajectoryResolutionKey(p.pitch);
    lastBattedPlayId.current = p.hit?.play_id ?? null;
    lastBattedResolutionKey.current = battedBallResolutionKey(p.hit);
    pitchDataRef.current = p.pitch;
    currentPitchScoreSnapshotRef.current = p.pitch?.game_state ?? null;
    if (reviewRef.current.active) {
      // Drive the replay scoreboard AND the defense panel from the reviewed
      // at-bat's snapshot: the defense shows the alignment in effect for the
      // play being rewound instead of the live (current) one.
      const snap = p.pitch?.game_state_before ?? p.pitch?.game_state ?? null;
      setScorebugStateOverride(snap);
      const defense = defenseFromSnapshot(snap);
      if (defense) setDefenseData(defense);
    }
    setPitchData(p.pitch);
    setBattedBallData(toBattedBallData(p.hit));
    if (reviewRef.current.active) setAtBatOpen(true);
  };

  const backToLive = () => {
    // Back to Live also leaves comparison mode: the overlaid pitches must not
    // survive the return to the live feed. Skip exitComparison's own refresh
    // because backToLive refreshes below.
    if (compareModeRef.current === 'active') exitComparison({ skipRefresh: true });
    if (compareModeRef.current === 'selecting') cancelCompareSelecting();
    const nextReplay = { active: false, playId: null, pitchNumber: null, atBatIndex: null, livePlayId: null };
    replayRef.current = nextReplay;
    reviewRef.current = { active: false, atBatIndex: null, playId: null, autoAdvance: false };
    setReview({ active: false, atBatIndex: null, playId: null, autoAdvance: false });
    setReviewScoreTab('replay');
    trajectoryQueueRef.current = [];
    queuedTrajectoryPlayIdsRef.current.clear();
    fielderCamAvailable.current = false;
    fielderCamArmedRef.current = false;
    fielderCamFiredRef.current = false;
    setScorebugStateOverride(null);
    // Restore the live defensive alignment captured when review started; the
    // live status poll resumes now that the scorebug is unfrozen.
    setDefenseData(current => restoreLiveDefense(current, liveDefenseRef.current));
    setReplay(nextReplay);
    // Clear the replayed pitch immediately so the scene doesn't keep looping
    // it while the fresh live fetch is in flight, and reset the outcome state
    // so the next live play reveals cleanly. The fresh live play's animation
    // (applyTrajectoryPayload) resolves the panel onto the pitch view; the
    // Defense tab only auto-reopens on an actual fielding change.
    setPitchData(null);
    setBattedBallData(null);
    setPitchOutcome(null);
    setWaitingForPitchData(false);
    setPendingPitchNumber(null);
    outcomeShownPlayId.current = null;
    refreshAll(activeGamePk);
  };

  // Build a human-readable play sequence from the batted-ball runner credits.
  // Extracts the ordered chain of fielders who touched the ball (fielded,
  // assisted, or recorded the putout) and formats it as:
  //   "3B Austin Riley to 1B Matt Olson"
  //   "Juan Soto grounds out, SS Bo Bichette to 1B Vladdy Jr."
  //   "CF Mike Trout makes the catch"
const playSequence = useMemo(() => {
    const lines = [];

    // ── Contact plays (batted ball): fielder chain from runner credits ──
    const bb = battedBallData;
    if (bb) {
      const event = bb.event;
      const isHit = ['Single', 'Double', 'Triple', 'Home Run'].includes(event);
      // Only show the sequence for outs and defensive plays (home runs skip).
      if (!isHit || event === 'Home Run') {
        const batter = bb.batter || null;

        // Collect all unique credit entries across all runners, preserving order.
        const seen = new Set();
        const chain = [];
        for (const runner of bb.runners || []) {
          for (const credit of runner.credits || []) {
            const key = `${credit.position}-${credit.credit}`;
            if (!seen.has(key)) {
              seen.add(key);
              chain.push(credit);
            }
          }
        }

        if (chain.length > 0) {
          // For a caught fly ball.
          if (bb.was_caught) {
            const fielder = chain[0];
            const name = fielder.player || '?';
            const pos = fielder.position || '?';
            lines.push(`${pos} ${name} makes the catch`);
          } else {
            // Build the "pos name" parts for each fielder in the chain.
            const parts = [];
            for (const credit of chain) {
              const name = credit.player || '?';
              const pos = credit.position || '?';
              parts.push(`${pos} ${name}`);
            }
            const fielders = parts.join(' to ');

            // Determine the play description prefix from the event.
            let prefix = '';
            if (event === 'Grounded Into DP') {
              prefix = batter ? `${batter} grounds into double play, ` : 'Grounded into double play, ';
            } else if (event === 'Double Play') {
              prefix = batter ? `${batter} hit into double play, ` : 'Double play, ';
            } else if (event === 'Forceout') {
              prefix = batter ? `${batter} grounds into force out, ` : 'Force out, ';
            } else if (event === 'Groundout') {
              prefix = batter ? `${batter} grounds out, ` : 'Ground out, ';
            } else if (event === 'Flyout') {
              prefix = '';
            } else if (event === 'Lineout') {
              prefix = '';
            } else if (event === 'Pop Out') {
              prefix = '';
            } else if (event === 'Sac Fly') {
              prefix = batter ? `${batter} sacrifice fly, ` : 'Sacrifice fly, ';
            } else if (event === 'Sac Bunt' || event === 'Bunt Groundout') {
              prefix = batter ? `${batter} sacrifice bunt, ` : 'Sacrifice bunt, ';
            } else if (batter) {
              prefix = `${batter} out, `;
            }

            // Unassisted putout: the fielder does it alone.
            if (parts.length === 1) {
              lines.push(`${prefix}${parts[0]} records the out`);
            } else {
              lines.push(`${prefix}${fielders}`);
            }
          }
        }
      }
    }

    // ── Non-contact plays: stolen base / caught stealing / wild pitch etc. ──
    // Always as a separate line — can stack with a batted ball line above.
    const pd = pitchData;
    if (pd) {
      const ae = pd.action_event;
      if (ae) {
        const runner = pd.action_event_runner || pd.batter || '?';
        if (ae === 'Stolen Base 2B') lines.push(`${runner} steals 2nd base`);
        else if (ae === 'Stolen Base 3B') lines.push(`${runner} steals 3rd base`);
        else if (ae === 'Stolen Base Home') lines.push(`${runner} steals home`);
        else if (ae === 'Caught Stealing 2B') lines.push(`${runner} caught stealing 2nd base`);
        else if (ae === 'Caught Stealing 3B') lines.push(`${runner} caught stealing 3rd base`);
        else if (ae === 'Caught Stealing Home') lines.push(`${runner} caught stealing home`);
        else if (ae === 'Wild Pitch') lines.push(`Wild pitch`);
        else if (ae === 'Passed Ball') lines.push(`Passed ball`);
        else if (ae === 'Pickoff Attempt 1B' || ae === 'Pickoff Attempt 2B' || ae === 'Pickoff Attempt 3B') lines.push(`Pickoff attempt`);
        else if (ae === 'Balk') lines.push(`Balk`);
      }
    }

    return lines.length > 0 ? lines : null;
  }, [battedBallData, pitchData]);

  // Coarse play-outcome indicator shown where the old OUT banner was: BALL /
  // STRIKE for takes, HIT for a base hit, RUN when a run scores, and OUT (or
  // DOUBLE/TRIPLE PLAY) when the batter is retired.
  const showOutcome = (label) => {
    outcomeShownPlayId.current = pitchData?.play_id ?? null;
    setPitchOutcome(label);
  };

  // Mark a fully-animated play as finished exactly once. showOutcome (the
  // banner) can fire several times for one play (OUT, then DOUBLE PLAY); this
  // is the single completion signal, and its side effects run in the
  // playCompletion effect after the reveal has rendered.
  const finishCurrentPlay = () => {
    if (playFinishedRef.current) return;
    playFinishedRef.current = true;
    // Capture the completed play's scoreboard state now, before any deferred
    // work or an in-flight poll can replace the active play.
    completedPlaySnapshotRef.current = currentPitchScoreSnapshotRef.current ?? pitchDataRef.current?.game_state;
    setPlayCompletion(prev => prev + 1);
  };

  // The pitch reached the plate: for a take the ball/strike call is already
  // final, so reveal it now. Contact pitches wait for the batted-ball
  // choreography to finish so the hit/out/run isn't spoiled mid-play.
  const handlePitchArrival = () => {
    const playId = pitchData?.play_id ?? null;
    if (playId != null && playId === outcomeShownPlayId.current) return;
    // A pitch the bat met hands off to BattedBall, which finishes the play via
    // handlePlayComplete. A take / whiff is fully resolved at the plate.
    const isContactPitch = pitchData?.is_contact === true;
    // Resolve and reveal the outcome now (specific result/action, or the bare
    // ball/strike call). A take / whiff finishes at the plate; a contact pitch
    // hands completion to BattedBall.
    const label = resolvePlayOutcomeLabel(pitchData);
    if (label) showOutcome(label);
    if (!isContactPitch) finishCurrentPlay();
  };

  // The batted-ball choreography resolved: map its granular text to a specific
  // outcome. Outs use the resolved play result (flyout / popout / sac fly /
  // bunt / ...), and base hits read as their hit type (SINGLE / DOUBLE /
  // TRIPLE / HOME RUN).
  const handlePlayResult = (text) => {
    if (!text) return;
    if (text === 'OUT') {
      // Surface the specific out type from the resolved play result (flyout,
      // popout, lineout, groundout, force out, sac fly, bunt, ...).
      showOutcome(specificOutcomeLabel(battedBallData?.event) || 'OUT');
      return;
    }
    if (text === 'DOUBLE PLAY' || text === 'TRIPLE PLAY') {
      showOutcome(text);
      return;
    }
    if (text === 'SINGLE' || text === 'DOUBLE' || text === 'TRIPLE' || text === 'HOME RUN') {
      const isWalkOff = (
        isGameTerminal(pitchData?.game_state?.gameState) ||
        isGameTerminal(currentPitchScoreSnapshotRef.current?.gameState) ||
        isGameTerminal(pitchData?.game_state?.detailedState) ||
        isGameTerminal(currentPitchScoreSnapshotRef.current?.detailedState)
      );
      showOutcome(isWalkOff ? `WALK-OFF ${text}` : text);
      return;
    }
    const scored = battedBallData?.runners?.some((r) => r.end === 'score');
    showOutcome(scored ? 'RUN' : 'HIT');
  };

  // The batted-ball choreography fully resolved (last out recorded / hit
  // settled). Unlike handlePlayResult, which fires per result (including the
  // intermediate OUT of a double play), this fires exactly once per play and
  // is the signal that advances to the next queued play.
  //
  // For contact plays, the first completion arms a fielder-camera replay:
  // the play loops, the camera follows the fielder, and only the second
  // completion advances the queue.
  const handlePlayComplete = () => {
    const isContactPlay = battedBallData && battedBallData.fielder;

    // Mark the play as having fielding data so the replay button can appear.
    if (isContactPlay) fielderCamAvailable.current = true;

    // Contact-play completion state machine: the first completion arms the
    // fielder-cam replay instead of advancing the queue (the play keeps looping
    // as the camera follows the fielder); the second completion finishes it
    // normally. Skipped (a single completion finishes) when queued plays are
    // waiting, comparison mode is active, auto-fielder-cam is off, or it has
    // already fired this play.
    const armed = fielderCamArmedRef.current;
    const fired = fielderCamFiredRef.current;
    const action = contactCompletionAction({
      isContactPlay,
      armed,
      fired,
      compareActive: compareModeRef.current === 'active',
      queuedPlays: trajectoryQueueRef.current.length > 0,
      autoFielderCam: autoFielderCamRef.current,
    });
    const nextState = fielderCamNextState({ armed, fired }, action);
    fielderCamArmedRef.current = nextState.armed;
    fielderCamFiredRef.current = nextState.fired;
    if (action === CONTACT_COMPLETE_ARM) {
      setFielderCamTrigger((prev) => prev + 1);
      return; // Don't finish the play yet; the replay cycle keeps it alive.
    }

    // Second completion (or a skipped auto-replay): finish normally. Review
    // mode intentionally stops here; the user can inspect/replay the final
    // pitch again instead of automatically advancing into the next batter.
    finishCurrentPlay();

    // A contact pitch can finish without the batted-ball choreography ever
    // emitting an outcome (e.g. its hit never arrived). Surface the play
    // result so the banner isn't blank (an in-play out reads OUT as a last
    // resort). Guard: only override for contact pitches ('X'/'E'/'D'/'F'/'L')
    // — a non-contact pitch's own arrival handler already surfaced the correct
    // BALL/STRIKE and finished the play.
    if (outcomeShownPlayId.current !== (pitchData?.play_id ?? null)) {
      const isContact = ['X', 'E', 'D', 'F', 'L'].includes(pitchData?.call_code);
      const label = isContact
        ? (specificOutcomeLabel(battedBallData?.event || pitchData?.result_event)
           || (pitchData?.call_code === 'X' ? 'OUT' : null))
        : null;
      if (label) showOutcome(label);
    }
    setCompletionDebug(() => ({ source: 'normal' }));
  };

  useEffect(() => {
    fetchTrajectory();
    fetchBattedBall();
    fetchLiveGames();
    // Clear any pending queue-advance timer if the app unmounts.
    return () => {
      if (queueStartTimerRef.current) clearTimeout(queueStartTimerRef.current);
      delayedTrajectoryBufferRef.current?.clear({ resetDelivered: true });
      delayedBattedBallBufferRef.current?.clear({ resetDelivered: true });
      delayedUiBufferRef.current?.clear({ resetDelivered: true });
    };
  }, []);

  // League-average break by pitch type for the panel's H/V Break comparison
  // rows. Fetched once; the hardcoded fallback table is used until it arrives
  // (or if the backend / Savant are unreachable).
  useEffect(() => {
    let cancelled = false;
    axios.get(`${API_BASE}/api/break-averages`)
      .then((res) => {
        if (!cancelled && res.data?.averages) setBreakAverages(res.data.averages);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Fetch pitch movement scatter data when the pitcher changes. Cached per
  // pitcher so switching back to a previously-seen pitcher doesn't re-fetch.
  useEffect(() => {
    const pitcherId = pitchData?.pitcher_id;
    if (!pitcherId) {
      setGraphData(null);
      setGraphError(null);
      return;
    }
    // Check in-memory cache first.
    if (graphCacheRef.current[pitcherId]) {
      setGraphData(graphCacheRef.current[pitcherId]);
      setGraphLoading(false);
      setGraphError(null);
      return;
    }
    setGraphLoading(true);
    setGraphError(null);
    let cancelled = false;
    axios.get(`${API_BASE}/api/pitcher-movement?pitcher_id=${pitcherId}`)
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data ?? null;
        if (data) graphCacheRef.current[pitcherId] = data;
        setGraphData(data);
        setGraphLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('Failed to fetch pitcher movement data', err);
        setGraphError('Movement data unavailable');
        setGraphLoading(false);
      });
    return () => { cancelled = true; };
  }, [pitchData?.pitcher_id]);

  // Poll the backend so the newest play animates as soon as it's available.
  // Silent polls deduplicate identical plays and queue newer payloads (the
  // play-id gate above) so the current animation isn't restarted or skipped.
  // Keep one live
  // request cycle at a time: a slow trajectory or batted-ball response makes
  // the next tick a no-op instead of starting another pair of requests.
  // Polling remains active during a historical replay: the selected pitch is
  // protected by the replay guard in fetchTrajectory, and a genuinely newer
  // live play resumes the feed automatically.
  useEffect(() => {
    if (gameTerminal || highSpeedTestActive) return;
    const id = setInterval(() => {
      if (trajectoryRequestsInFlight.current > 0 || battedBallRequestsInFlight.current > 0) return;
      fetchTrajectory(activeGamePk, { silent: true });
      fetchBattedBall(activeGamePk, { silent: true });
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [activeGamePk, replay.active, gameTerminal, highSpeedTestActive]);

  // Load (and refresh) the at-bat pitch list while the 2D strike zone is open.
  // Review mode pins the request to the selected game-log at-bat even while
  // the pitch panel is showing the automatically replayed pitch.
  useEffect(() => {
    if (!atBatOpen) return;
    fetchAtBat(reviewRef.current.active
      ? reviewRef.current.atBatIndex
      : pitchData?.at_bat_index ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atBatOpen, pitchData?.at_bat_index, atBatOutcomeRefresh, review.active, review.atBatIndex]);

  useEffect(() => {
    if (!review.active || !atBatData || atBatData.at_bat_index !== review.atBatIndex || review.playId) return;
    const firstPitch = (atBatData.pitches || []).find((pitch) => pitch.replayable && pitch.pitch);
    if (firstPitch) selectReplayPitch(firstPitch, { autoAdvance: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.active, review.atBatIndex, review.playId, atBatData]);

  // A game-log click selects exactly one pitch. Review-mode auto-advancement
  // is enabled only for the initial at-bat walkthrough, not when the user
  // explicitly clicks a pitch in the at-bat zone.
  useEffect(() => {
    if (!review.active || !review.autoAdvance || playCompletion === 0 || !atBatData) return;
    const currentIndex = (atBatData.pitches || []).findIndex(
      (pitch) => pitch.play_id === reviewRef.current.playId,
    );
    if (currentIndex < 0) return;
    const nextPitch = (atBatData.pitches || []).slice(currentIndex + 1)
      .find((pitch) => pitch.replayable && pitch.pitch);
    if (!nextPitch) return;
    const timer = setTimeout(() => selectReplayPitch(nextPitch, { autoAdvance: true }), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playCompletion]);

  // Load (and refresh) the whole-game pitch list while the game view is open:
  // same triggers as the at-bat list (open, batter change, each pitch reveal).
  useEffect(() => {
    if (!atBatOpen || !batterGameOpen) return;
    fetchBatterGame(atBatData?.at_bat_index ?? pitchData?.at_bat_index ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atBatOpen, batterGameOpen, atBatData?.at_bat_index, atBatOutcomeRefresh]);

  // The pitcher/pitch-type filters belong to one batter: drop them when the
  // game view rolls over to a new batter (or its data is cleared).
  useEffect(() => {
    setPitcherFilter(null);
    setPitchTypeFilter(null);
  }, [batterGameData?.batter_id]);

  // Release the frozen panel dimensions once the at-bat data arrives (the
  // loading state is done) or when switching back to the pitch view. The
  // useEffect fires after paint, so the min-width/min-height transition
  // plays from the snapshot to the new natural size instead of snapping.
  //
  // Height is released first so the panel eases to its target vertical
  // size, then width follows after a short stagger to feel more deliberate
  // — avoids both dimensions shifting at once when the content sizes differ.
  useEffect(() => {
    if (!atBatOpen || atBatData) {
      const heightRaf = requestAnimationFrame(() => {
        setAtBatSnapshotHeight(null);
      });
      const widthTimer = setTimeout(() => {
        setAtBatSnapshotWidth(null);
      }, 160);
      return () => {
        cancelAnimationFrame(heightRaf);
        clearTimeout(widthTimer);
      };
    }
  }, [atBatOpen, atBatData]);

  // Once a play fully finishes, commit its scoreboard snapshot, open the panel,
  // and start the next queued play. Deferred to an effect (keyed on
  // playCompletion rather than pitchOutcome) so it runs exactly once per play —
  // not once per intermediate result — and only after the reveal has rendered.
  useEffect(() => {
    if (playCompletion === 0) return;

    setPanelSlidOut(false);
    setToggleUnlocked(true);
    // When the play finishes and the panel slides back in, reset to the
    // pitch model view so the movement graph doesn't persist from the previous pitch.
    setGraphMode(false);
    // Commit the state captured for THIS completed play before starting the
    // next queued animation. Scorebug's frozen override prevents its own
    // /api/game-state poll from jumping over any queued play. In review mode
    // the replay scoreboard must advance to the state after the pitch that
    // just finished (score/count/bases/outs/pitches) as the at-bat plays out.
    if (reviewRef.current.active) {
      if (completedPlaySnapshotRef.current) {
        setScorebugStateOverride(completedPlaySnapshotRef.current);
        const defense = defenseFromSnapshot(completedPlaySnapshotRef.current);
        if (defense) setDefenseData(defense);
      }
    } else if (!replayRef.current.active && completedPlaySnapshotRef.current) {
      setScorebugStateOverride(completedPlaySnapshotRef.current);
    }
    setScorebugOutcomeRefresh(prev => prev + 1);
    setAtBatOutcomeRefresh(prev => prev + 1);

    if (!reviewRef.current.active) scheduleNextQueuedPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playCompletion]);

  // Scoreboard spoiler guard: freeze the scorebug for the normal live pitch
  // animation so it can't poll ahead and spoil the next pitch. Historical
  // replay and tunneling comparison are independent viewing modes, so their
  // scorebug follows the delayed live state instead of staying pinned to the
  // selected historical pitch. The Scorebug component applies the configured
  // broadcast delay in every mode.
  const scoreboardFrozen = review.active
    ? (reviewScoreTab === 'replay' && compareMode !== 'active')
    : (!!pitchData && !replay.active && compareMode === 'idle');

  // A contact pitch has no batted ball to show until its Statcast fielding
  // point (hc_x/hc_y) arrives. While that data is pending, hold the batted
  // ball and show a notice instead of animating a reconstructed/wrong flight.
  const waitingForPlayResolve = (
    !replay.active &&
    !review.active &&
    pitchData?.is_contact === true &&
    pitchData?.call_code !== 'F' &&
    pitchData?.call_code !== 'L' &&
    !isHitFieldingReady(battedBallData)
  );

  // Shared base style for the lightweight top-left status lines (loading /
  // waiting-for-pitch-data / error). No panel box, just readable text over the
  // field with a dark shadow so it stays legible against the grass and sky.
  const topLeftStatusTextStyle = {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: '16px',
    padding: '2px 4px',
    textShadow: '0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.6)',
    whiteSpace: 'pre-wrap',
    maxWidth: '280px',
  };

  // The Upcoming section only shows today's not-yet-started games; tomorrow's
  // games are omitted so the drawer stays focused on the current day.
  const todayUpcomingGames = (upcomingGames ?? []).filter(
    (g) => gameDayOffset(g) === 0,
  );

  // Horizontal/vertical break display: the actual Statcast induced breaks
  // (inches) for this pitch, matching Baseball Savant's game feed. The
  // backend payload fills pfx_x / pfx_z from the feed's breaks object
  // (H Break = -breakHorizontal, IVB = breakVerticalInduced) with a fallback
  // to coordinates.pfxX/pfxZ — NOT derived from the physics simulation
  // (which only drives the 3D animation and the spin-components popup). The
  // "vs avg" percentage is SIGNED for both axes: it reads as "more break in
  // the positive direction than typical" — for H Break, ▲ = more break
  // toward 1B (▼ = more toward 3B); for IVB, ▲ = more upward ride (▼ = more
  // drop). Because the averages are bucketed by pitcher hand in this same
  // fixed convention, a signed comparison is meaningful for both hands (a LHP
  // and a RHP fastball both compare against their own hand's arm-side
  // average). Live league averages from /api/break-averages take precedence;
  // the backend buckets them by pitcher hand in this same fixed convention
  // (so pooling RHP + LHP horizontal breaks can't cancel to ~0), and the
  // fallback table covers loading/failure.
  //
  // Sign convention (fixed, both hands): positive H Break = toward 1B
  // (catcher's right), positive IVB = upward ride. No pitcher-hand mirroring
  // is applied — the values are exactly what Savant shows.
  const pitchHand = pitchData?.pitch_hand === 'L' ? 'L' : 'R';
  const avgBreak = pitchData
    ? (breakAverages?.[pitchData.pitch_type]?.[pitchHand]
       ?? FALLBACK_BREAK_BY_TYPE[pitchData.pitch_type]?.[pitchHand])
    : null;
  const breakPct = (value, avg) => {
    if (value == null || avg == null || avg === 0) return null;
    return ((value - avg) / Math.abs(avg)) * 100;
  };
  const breakRows = [
    // The hint annotation on H Break clarifies the sign convention (positive
    // = toward 1B) so the panel matches the movement graph's axis. IVB
    // (pfxZ) is positive up and needs no annotation.
    { label: 'H Break', hint: '+→1B', value: pitchData?.pfx_x, avg: avgBreak?.x },
    { label: 'IVB', value: pitchData?.pfx_z, avg: avgBreak?.z },
  ].map((row) => ({ ...row, pct: breakPct(row.value, row.avg) }));

  // Spin-components popup: anchored to the right edge of the Spin Rate value,
  // vertically centered on it. A short hide delay plus hover handlers on the
  // popup itself keeps it open while the mouse crosses the gap between the
  // trigger and the popup.
  const showSpinComponentsPopup = () => {
    clearTimeout(spinPopupHideTimer.current);
    const el = spinRateRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSpinPopupAnchor({ left: r.right + 10, top: r.top + r.height / 2 });
  };
  const hideSpinComponentsPopup = () => {
    clearTimeout(spinPopupHideTimer.current);
    spinPopupHideTimer.current = setTimeout(() => setSpinPopupAnchor(null), 120);
  };

  useEffect(() => {
    if (panelSlidOut) setSpinPopupAnchor(null);
  }, [panelSlidOut]);

  // Cap the live-games drawer so its expanded bottom sits just above the
  // bottom-left pitch panel (or the WASD hint when no pitch is loaded) instead
  // of extending out of the window. A ResizeObserver re-measures whenever the
  // panels around the drawer change size — including every frame of the pitch
  // panel's expand/collapse transition, so the cap settles on the panel's
  // final (collapsed) position instead of freezing at the pre-transition
  // measurement.
  useLayoutEffect(() => {
    const compute = () => {
      const drawer = drawerRef.current;
      if (!drawer) return;
      // Never let the drawer touch the bottom edge of the window.
      let limitY = window.innerHeight - 20;
      // Stop just above the pitch panel's topmost visible element (the view
      // tabs stick out above the panel's box); its top moves up when the pitch
      // panel expands, so this also keeps the open panel clear of the drawer.
      // Without pitch data, the WASD hint is the bottom-left column's top.
      const tabs = tabsRef.current;
      const bottomLeft = bottomLeftRef.current;
      if (tabs) {
        limitY = Math.min(limitY, tabs.getBoundingClientRect().top - 10);
      } else if (bottomLeft) {
        limitY = Math.min(limitY, bottomLeft.getBoundingClientRect().top - 10);
      }
      const drawerCap = Math.max(120, limitY - drawer.getBoundingClientRect().top);
      setDrawerMaxHeight(drawerCap);
      // The scrollable game list gets the drawer's cap minus the pinned
      // summary row (and its 8px top margin), so the summary stays visible
      // while the games below it scroll.
      const summary = summaryRef.current;
      const list = gamesListRef.current;
      if (summary && list) {
        const listCap = drawerCap - summary.getBoundingClientRect().height - 8;
        setGamesListMaxHeight(Math.max(80, listCap));
      }
    };
    compute();
    // Re-measure on window resize (the panel's top moves even though its size
    // doesn't) and whenever either column's size changes.
    const ro = new ResizeObserver(compute);
    if (topLeftRef.current) ro.observe(topLeftRef.current);
    if (bottomLeftRef.current) ro.observe(bottomLeftRef.current);
    window.addEventListener('resize', compute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, [pitchData, pitchPanelOpen, panelSlidOut, loading, error, waitingForPitchData, pendingPitchNumber, newLivePlayAvailable]);

  // Track the debug-overlays drawer's rendered width so the playback panel
  // above it matches exactly (the drawer only mounts once overlay data exists,
  // so re-run whenever its render condition could change).
  useLayoutEffect(() => {
    const drawer = overlaysRef.current;
    if (!drawer) return;
    const update = () => setOverlaysWidth(drawer.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(drawer);
    return () => ro.disconnect();
  }, [crossings, pitchData, battedBallData]);

  // Track the bottom-left pitch/at-bat panel's rendered width so the
  // live-games drawer matches it exactly (including the at-bat view, which
  // can render wider than the pitch view).
  useLayoutEffect(() => {
    const panel = pitchPanelRef.current;
    if (!panel) {
      setPitchPanelWidth(null);
      return;
    }
    const update = () => setPitchPanelWidth(panel.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [pitchData]);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden' }}>
      {/* IMPORTANT: DebugDrawer intentionally remains hidden
          for now. Do not remove this component or its supporting code; keep it
          maintained as new features are added so diagnostics can be re-enabled
          later. */}
      {/* ── TOP-LEFT: status text / replay badge + live games drawer ── */}
      <div ref={topLeftRef} style={{
        position: 'absolute',
        top: 20,
        left: 20,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 10,
      }}>
      {/* Fielder position label while the fielder-camera replay is active: a
          small pill in the top-left of the screen (previously drawn above the
          fielder's head in the 3D scene, obscuring the view). */}
      {fielderCamActive && battedBallData?.fielder && (
        <div style={{
          background: 'rgba(0,0,0,0.75)',
          color: '#ffd166',
          padding: '4px 10px',
          borderRadius: 5,
          fontSize: 12,
          fontFamily: 'monospace',
          fontWeight: 'bold',
          letterSpacing: '0.05em',
          textShadow: '0 0 6px rgba(0,0,0,0.8)',
          border: '1px solid rgba(255,209,102,0.35)',
          whiteSpace: 'nowrap',
        }}>
          {battedBallData.fielder} · {battedBallData.fielderName || '—'}
        </div>
      )}
      {/* Lightweight status text replaces the old 8-Bit Pitch panel: backend
          failures and feed-catching-up state stay visible without a box. */}
      {loading && !waitingForPitchData && !replay.active && (
        <div style={{ ...topLeftStatusTextStyle, color: '#e6e6e6' }}>Loading data…</div>
      )}
      {waitingForPitchData && !replay.active && (
        <div
          role="status"
          aria-live="polite"
          style={{ ...topLeftStatusTextStyle, color: '#ffd166' }}
        >
          ⏳ Waiting for pitch data
          {pendingPitchNumber != null ? ` (pitch ${pendingPitchNumber})` : '…'}
        </div>
      )}
      {error && (
        <div role="alert" style={{ ...topLeftStatusTextStyle, color: '#ff6b6b' }}>
          {error}
        </div>
      )}

      {/* Snap the live view to the newest play, discarding any plays queued
          behind the current animation (they would otherwise drain one-by-one
          and lag the live feed). Shown only when plays are actually waiting —
          clean control surface during normal play — with a badge of how many
          plays are behind. Hidden while replaying/comparing; they have their
          own return-to-live controls. */}
      {!replay.active && compareMode === 'idle' && queuedPlayCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={jumpToNewest}
            title="Discard queued plays and jump to the newest live play"
            style={{
              padding: '4px 10px',
              cursor: 'pointer',
              background: '#1a4a7a',
              color: 'white',
              border: '1px solid #4a9eff',
              borderRadius: '6px',
              fontSize: '11px',
              fontFamily: 'monospace',
              fontWeight: 'bold',
            }}
          >
            ⤓ Jump to newest
          </button>
          <span
            title={`${queuedPlayCount} play${queuedPlayCount === 1 ? '' : 's'} queued behind the current animation`}
            style={{
              padding: '2px 7px',
              background: 'rgba(234,179,8,0.16)',
              color: '#ffd166',
              border: '1px solid rgba(234,179,8,0.5)',
              borderRadius: '10px',
              fontSize: '10px',
              fontFamily: 'monospace',
              whiteSpace: 'nowrap',
            }}
          >
            {queuedPlayCount} plays behind
          </span>
        </div>
      )}

      {/* Replay status and live-resume controls occupy their own row above the
          live-games drawer, so they never cover or compress the game list. */}
      {replay.active && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{
            background: 'rgba(42,46,54,0.96)', color: '#ffd166', padding: '6px 12px',
            borderRadius: '7px', fontFamily: 'monospace', fontWeight: 'bold',
            fontSize: 13, letterSpacing: '0.02em', boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
            whiteSpace: 'nowrap',
          }}>↺ REPLAY</div>
          <button
            onClick={backToLive}
            title="Resume the live feed"
            style={{ padding: '6px 10px', background: '#b33a3a', color: '#fff',
              border: '1px solid rgba(255,180,180,0.7)', borderRadius: 6,
              fontFamily: 'monospace', fontWeight: 'bold', fontSize: 11, cursor: 'pointer' }}
          >▶ Back to Live</button>
          {newLivePlayAvailable && (
            <span role="status" aria-live="polite" style={{ padding: '5px 8px',
              background: 'rgba(255,209,102,0.14)', color: '#ffd166',
              border: '1px solid rgba(255,209,102,0.55)', borderRadius: 4,
              fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold', whiteSpace: 'nowrap' }}>
              ● New live play available
            </span>
          )}
        </div>
      )}

        {/* ── LIVE GAMES DRAWER ── */}
        <div
          ref={drawerRef}
          style={{
            background: 'linear-gradient(180deg, rgba(10,14,20,0.92), rgba(6,9,14,0.92))',
            color: 'white',
            padding: '10px 14px',
            borderRadius: 10,
            fontFamily: 'monospace',
            fontSize: '11px',
            width: drawerWidthExpanded ? (pitchPanelWidth ?? 280) : 108,
            alignSelf: 'flex-start',
            boxSizing: 'border-box',
            backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.18)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
            userSelect: 'none',
            maxHeight: drawerMaxHeight ?? 'none',
            overflow: 'hidden',
            transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <button
            ref={summaryRef}
            onClick={() => setGamesDrawerOpen((v) => !v)}
            aria-expanded={gamesDrawerOpen}
            title={gamesDrawerOpen ? 'Roll the games list back up' : 'Unroll the games list'}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: drawerWidthExpanded ? 'space-between' : 'center',
              gap: drawerWidthExpanded ? 0 : 6,
              padding: 0,
              background: 'transparent',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '12px',
              opacity: 0.9,
              outline: 'none',
              userSelect: 'none',
              fontFamily: 'monospace',
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap',
            }}
          >
            <span>Games</span>
            <span style={{ opacity: 0.7, fontSize: 10 }}>{drawerHeightExpanded ? '▾' : '▸'}</span>
          </button>
          <div style={{
            maxHeight: drawerHeightExpanded ? (drawerMaxHeight ?? 700) : 0,
            opacity: drawerHeightExpanded ? 1 : 0,
            overflow: 'hidden',
            transition: 'max-height 0.35s ease-in-out, opacity 0.25s ease-in-out',
          }}>
            <div ref={gamesListRef} className="app-scroll" style={{ marginTop: 8, overflowY: 'auto', maxHeight: gamesListMaxHeight ?? 'none' }}>
              {(finishedGames ?? []).length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div className="finished-games-scroll" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
                    {finishedGames.map((g) => {
                      const selected = activeGamePk === g.game_pk;
                      const innings = Number(g.innings);
                      const wentExtra = Number.isFinite(innings) && innings > 9;
                      const record = (side) => {
                        const w = g.teams?.[side]?.wins;
                        const l = g.teams?.[side]?.losses;
                        return w != null && l != null ? `${w}-${l}` : '';
                      };
                      return (
                        <button
                          key={g.game_pk}
                          onClick={() => selectFinishedGame(g.game_pk)}
                          title={`Replay ${g.teams?.away?.abbreviation} at ${g.teams?.home?.abbreviation}`}
                          style={{ flex: '0 0 116px', minHeight: 66, padding: '7px 8px', textAlign: 'left', cursor: 'pointer', background: selected ? '#1a4a7a' : '#17263a', color: '#fff', border: selected ? '1px solid #70b7ff' : '1px solid #315477', borderRadius: 7, fontFamily: 'monospace', fontSize: 11 }}
                        >
                          <div style={{ fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span>{g.teams?.away?.abbreviation} {g.teams?.away?.score ?? '—'}</span>
                            {record('away') && <span style={{ color: '#9ecbff', fontWeight: 'normal' }}>{record('away')}</span>}
                          </div>
                          <div style={{ fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span>{g.teams?.home?.abbreviation} {g.teams?.home?.score ?? '—'}</span>
                            {record('home') && <span style={{ color: '#9ecbff', fontWeight: 'normal' }}>{record('home')}</span>}
                          </div>
                          <div style={{ marginTop: 4, color: '#9ecbff', fontSize: 10 }}>{wentExtra ? `Final/${innings}` : 'Final'}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ opacity: 0.7 }}>{liveGames ? `${liveGames.length} live` : '—'}</span>
                <button
                  onClick={() => fetchLiveGames()}
                  disabled={liveGamesLoading}
                  style={{ padding: '2px 8px', cursor: 'pointer', background: '#333', color: 'white', border: 'none', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace' }}
                >
                  ⟳ Refresh
                </button>
              </div>
              {liveGamesLoading && <div style={{ opacity: 0.6, padding: '4px 0' }}>Loading…</div>}
              {!liveGamesLoading && (!liveGames || liveGames.length === 0) && (
                <div style={{ opacity: 0.6, padding: '4px 0' }}>No live games right now.</div>
              )}
              {activeGamePk && (
                <button
                  onClick={() => selectGame(null)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', marginBottom: 6, cursor: 'pointer', background: '#1b2a1b', color: '#9be7a0', border: '1px solid #2e5c33', borderRadius: '6px', fontSize: '11px', fontFamily: 'monospace' }}
                >
                  ↺ Back to default game
                </button>
              )}
              {liveGames?.map((g) => {
                const selected = activeGamePk === g.game_pk;
                // Broadcast-style inning state: ▲7 / ▼7 while playing, Mid/End
                // between halves. Rendered in the yellow accent.
                const ord = g.inning?.ordinal;
                const inningState = g.inning?.state;
                let inningLabel = null;
                if (ord) {
                  if (g.status === 'Final' || g.status === 'Game Over' || isGameTerminal(g.status)) {
                    const innNum = Number(g.innings || g.inning?.number);
                    inningLabel = innNum && innNum > 9 ? `Final/${innNum}` : 'Final';
                  } else if (inningState === 'Middle') inningLabel = `Mid ${ord}`;
                  else if (inningState === 'End') inningLabel = `End ${ord}`;
                  else inningLabel = `${g.inning.isTop ? '▲' : '▼'}${ord}`;
                }
                return (
                  <button
                    key={g.game_pk}
                    onClick={() => selectGame(g.game_pk)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 8px',
                      marginBottom: 4,
                      cursor: 'pointer',
                      background: selected ? '#1a4a7a' : '#222',
                      color: 'white',
                      border: selected ? '1px solid #4a9eff' : '1px solid #333',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontFamily: 'monospace',
                    }}
                  >
                    <div style={{ fontWeight: 'bold', letterSpacing: '0.03em' }}>
                      {g.teams?.away?.abbreviation} {g.teams?.away?.score ?? '—'}
                      {g.teams?.away?.wins != null && g.teams?.away?.losses != null && (
                        <span style={{ color: '#ffd166', fontWeight: 'normal', marginLeft: 4 }}>{g.teams.away.wins}-{g.teams.away.losses}</span>
                      )}
                      <span style={{ opacity: 0.6 }}> @ </span>
                      {g.teams?.home?.abbreviation} {g.teams?.home?.score ?? '—'}
                      {g.teams?.home?.wins != null && g.teams?.home?.losses != null && (
                        <span style={{ color: '#ffd166', fontWeight: 'normal', marginLeft: 4 }}>{g.teams.home.wins}-{g.teams.home.losses}</span>
                      )}
                    </div>
                    <div style={{ opacity: 0.7, marginTop: 2 }}>
                      {inningLabel && (
                        <span style={{ color: '#ffd166', fontWeight: 'bold', marginRight: 6 }}>{inningLabel}</span>
                      )}
                      <span>
                        {inningLabel
                          ? g.venue
                          : `${g.status || 'Live'}${g.venue ? ` · ${g.venue}` : ''}`}
                      </span>
                    </div>
                  </button>
                );
              })}
              {todayUpcomingGames.length > 0 && (
                <>
                  <div style={{
                    marginTop: 10,
                    paddingTop: 8,
                    borderTop: '1px solid rgba(255,255,255,0.15)',
                    marginBottom: 6,
                    fontWeight: 'bold',
                    letterSpacing: '0.03em',
                    opacity: 0.9,
                  }}>
                    ⏳ Upcoming
                  </div>
                  {todayUpcomingGames.map((g) => (
                    <div
                      key={g.game_pk}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '6px 8px',
                        marginBottom: 4,
                        background: '#1c1c1c',
                        color: '#ddd',
                        border: '1px solid #333',
                        borderRadius: '6px',
                        fontSize: '11px',
                        fontFamily: 'monospace',
                      }}
                    >
                      <span style={{ fontWeight: 'bold', letterSpacing: '0.03em' }}>
                        {g.teams?.away?.abbreviation}
                        <span style={{ opacity: 0.6 }}> @ </span>
                        {g.teams?.home?.abbreviation}
                      </span>
                      <span style={{ opacity: 0.7 }}>
                        {formatGameStartTime(g)}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      </div>


      {/* ── PLAY OUTCOME BANNER (ball / strike / hit / run / out, shown at the
          top of the screen once each pitch/play resolves). The pill expands
          out sideways when it appears and folds back in when the next pitch
          clears the outcome. ── */}
      <OutcomeBanner label={pitchOutcome} />

      {/* ── PLAY SEQUENCE PANEL (players involved in the play, shown at the
          bottom of the screen for outs and double plays). Same unfolding
          animation as the outcome banner. ── */}
      <PlaySequencePanel lines={sequenceRevealed ? playSequence : null} />

      {/* ── WAITING FOR PLAY TO RESOLVE BANNER (contact pitch whose Statcast
          fielding point hasn't arrived yet). Drops in and slides out via CSS
          keyframes; WaitingResolveBanner owns its exit animation. ── */}
      <WaitingResolveBanner active={waitingForPlayResolve} />

      {/* ── TOP-RIGHT: playback controls + debug overlays ── */}
      <div style={{
        position: 'absolute',
        top: 20,
        right: 20,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 0,
      }}>

        {/* ── PLAYBACK CONTROLS PANEL (camera snap + speed slider). Drops
            down flush from the ☰ handle's top edge when opened; a click
            anywhere outside rolls it back up into the handle. ── */}
        {/* In-flow wrapper clips the panel so it unrolls/rolls from zero
            height. Because it is the topmost flex item, its top edge lines up
            exactly with the collapsed handle's top edge (no gap, no overlap)
            and it pushes the overlays drawer below it while open. ── */}
        <div
          id="playback-controls-panel"
          ref={playbackPanelRef}
          onTransitionEnd={(event) => {
            // Show the ☰ handle (with a fade-in) only once the roll-up
            // transition has fully completed.
            if (
              event.target === event.currentTarget &&
              event.propertyName === 'max-height' &&
              !playbackPanelOpen
            ) {
              setHandleVisible(true);
            }
          }}
          style={{
            width: overlaysWidth ?? 210,
            boxSizing: 'border-box',
            maxHeight: playbackPanelOpen ? 700 : 0,
            overflow: 'hidden',
            transition: 'max-height 0.35s ease-in-out',
          }}
        >
        <div style={{
          width: '100%',
          boxSizing: 'border-box',
          background: 'linear-gradient(180deg, rgba(10,14,20,0.92), rgba(6,9,14,0.92))',
          border: '1px solid rgba(255,255,255,0.18)',
          borderRadius: 10,
          fontFamily: 'monospace',
          color: '#fff',
          padding: '10px 14px',
          backdropFilter: 'blur(6px)',
          boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
          userSelect: 'none',
        }}>
          <button
            onClick={() => setImpactEffect((current) => current === 'beams' ? 'ripple' : 'beams')}
            title={impactEffect === 'beams'
              ? 'Toggle the extra radial beam burst on the >100 mph impact (the ripple always shows)'
              : 'Toggle the extra radial beam burst back on (the ripple always shows)'}
            style={{
              width: '100%',
              marginBottom: 8,
              padding: '5px 8px',
              background: impactEffect === 'beams' ? 'rgba(255,159,28,0.12)' : 'rgba(255,255,255,0.1)',
              border: impactEffect === 'beams' ? '1px solid rgba(255,159,28,0.55)' : '1px solid rgba(255,255,255,0.45)',
              color: impactEffect === 'beams' ? '#ffb347' : '#f2f4f7',
              borderRadius: 4,
              fontSize: 11,
              fontFamily: 'monospace',
              fontWeight: 'bold',
              letterSpacing: '0.05em',
              cursor: 'pointer',
            }}
          >
            {impactEffect === 'beams' ? '✦ Impact: Beams + Ripple' : '◌ Impact: Ripple'}
          </button>
          <button
            onClick={() => setSnapTrigger((prev) => prev + 1)}
            title="Snap the camera to the strike zone"
            style={{
              width: '100%',
              padding: '5px 8px',
              background: 'rgba(255,209,102,0.12)',
              border: '1px solid rgba(255,209,102,0.5)',
              color: '#ffd166',
              borderRadius: 4,
              fontSize: 11,
              fontFamily: 'monospace',
              fontWeight: 'bold',
              letterSpacing: '0.08em',
              cursor: 'pointer',
            }}
          >
            Strike Zone
          </button>
          <button
            onClick={() => setFollowBattedBall((v) => !v)}
            title={followBattedBall
              ? 'Camera follows each live batted ball, then returns to the pre-play angle'
              : 'Keep the current camera angle during plays'}
            style={{
              width: '100%',
              marginTop: 8,
              padding: '5px 8px',
              background: followBattedBall ? 'rgba(123,180,255,0.14)' : 'rgba(255,255,255,0.06)',
              border: followBattedBall ? '1px solid rgba(123,180,255,0.55)' : '1px solid rgba(255,255,255,0.25)',
              color: followBattedBall ? '#9fd0ff' : '#9aa3ad',
              borderRadius: 4,
              fontSize: 11,
              fontFamily: 'monospace',
              fontWeight: 'bold',
              letterSpacing: '0.06em',
              cursor: 'pointer',
            }}
          >
            {followBattedBall ? '🎥 Follow Batted Ball: ON' : '🎥 Follow Batted Ball: OFF'}
          </button>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              onClick={() => setShowColoredTails((v) => !v)}
              title={showColoredTails
                ? 'Hide the speed-graded colored tail behind the pitch'
                : 'Show the speed-graded colored tail behind the pitch'}
              style={{
                flex: 1,
                minWidth: 0,
                padding: '5px 4px',
                background: showColoredTails ? 'rgba(255,209,102,0.12)' : 'rgba(255,255,255,0.06)',
                border: showColoredTails ? '1px solid rgba(255,209,102,0.55)' : '1px solid rgba(255,255,255,0.25)',
                color: showColoredTails ? '#ffd166' : '#9aa3ad',
                borderRadius: 4,
                fontSize: 10,
                fontFamily: 'monospace',
                fontWeight: 'bold',
                letterSpacing: '0.03em',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {showColoredTails ? '🌈 Tails: ON' : '🌈 Tails: OFF'}
            </button>
            <button
              onClick={() => setShowBillowParticles((v) => !v)}
              title={showBillowParticles
                ? 'Hide the billow/spark particles kicked up behind the pitch'
                : 'Show the billow/spark particles kicked up behind the pitch'}
              style={{
                flex: 1,
                minWidth: 0,
                padding: '5px 4px',
                background: showBillowParticles ? 'rgba(197,120,255,0.12)' : 'rgba(255,255,255,0.06)',
                border: showBillowParticles ? '1px solid rgba(197,120,255,0.55)' : '1px solid rgba(255,255,255,0.25)',
                color: showBillowParticles ? '#d9a8ff' : '#9aa3ad',
                borderRadius: 4,
                fontSize: 10,
                fontFamily: 'monospace',
                fontWeight: 'bold',
                letterSpacing: '0.03em',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {showBillowParticles ? '✨ Billows: ON' : '✨ Billows: OFF'}
            </button>
          </div>
          <div
            id="playback-speed-slider"
            title="Scales the whole simulation (pitch, swing, and batted ball) together"
            style={{ width: '100%', marginTop: 8 }}
          >
            <label
              htmlFor="playback-speed-range"
              style={{
                display: 'block', marginBottom: 4, fontWeight: 'bold', fontSize: 11,
                letterSpacing: '0.03em',
                color: playbackSpeed === 1 ? '#ccc' : '#ffd166',
              }}
            >
              {playbackSpeed === 1
                ? 'Playback: 1× Real Time'
                : `Playback: ${Number(playbackSpeed.toFixed(2))}× Slow-Mo`}
            </label>
            <input
              id="playback-speed-range"
              type="range"
              min={SLOWEST_SPEED}
              max={1}
              step={0.01}
              value={playbackSpeed}
              onChange={(e) => {
                const next = parseFloat(e.target.value);
                const inComparison = compareMode === 'active';
                setTuningValue('playback', 'timeScale', next, { persist: !inComparison });
                setTimeScale(next);
              }}
              style={{ width: '100%', cursor: 'pointer', accentColor: '#ffd166' }}
            />
          </div>

          {/* ── Broadcast delay ──────────────────────────────────────────
              Responses are fetched normally but are not allowed to enter
              playback, the scorebug, or status/pitch panels until this many
              seconds have elapsed. This keeps the whole app behind a TV
              broadcast when its feed is ahead of the viewer. ── */}
          <div
            id="broadcast-delay-control"
            title="Hold live plays, score, and game-status notices behind the broadcast"
            style={{ width: '100%', marginTop: 10 }}
          >
            <label
              htmlFor="broadcast-delay-range"
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: 4, fontWeight: 'bold', fontSize: 11,
                letterSpacing: '0.03em', color: broadcastDelaySeconds > 0 ? '#ffd166' : '#ccc',
              }}
            >
              <span>Broadcast Delay</span>
              <span>{broadcastDelaySeconds > 0 ? `${broadcastDelaySeconds}s` : 'OFF'}</span>
            </label>
            <input
              id="broadcast-delay-range"
              type="range"
              min={0}
              max={MAX_BROADCAST_DELAY_SECONDS}
              step={5}
              list="broadcast-delay-options"
              value={broadcastDelaySeconds}
              onChange={(e) => setBroadcastDelaySeconds(
                normalizeBroadcastDelaySeconds(e.target.value),
              )}
              aria-label="Broadcast delay in seconds"
              style={{ width: '100%', cursor: 'pointer', accentColor: '#ffd166' }}
            />
            <datalist id="broadcast-delay-options">
              {BROADCAST_DELAY_OPTIONS.map((seconds) => (
                <option key={seconds} value={seconds} label={`${seconds}s`} />
              ))}
            </datalist>
            <div style={{ marginTop: 2, fontSize: 9, color: '#8b949e', lineHeight: 1.35 }}>
              New plays and HUD updates wait before appearing.
            </div>
          </div>

          {/* ── Auto Fielder Cam toggle: when ON the camera automatically
              switches to a fielder's angle after the first play-through.
              When OFF the replay button appears immediately instead. ── */}
          <button
            onClick={toggleAutoFielderCam}
            title={autoFielderCam
              ? 'Disable auto fielder camera; the replay button will appear immediately for manual use'
              : 'Enable auto fielder camera; it switches automatically after the first animation'}
            style={{
              width: '100%',
              marginTop: 8,
              padding: '5px 8px',
              background: autoFielderCam ? 'rgba(255,143,143,0.12)' : 'rgba(255,255,255,0.06)',
              border: autoFielderCam ? '1px solid rgba(255,143,143,0.55)' : '1px solid rgba(255,255,255,0.25)',
              color: autoFielderCam ? '#ff8f8f' : '#9aa3ad',
              borderRadius: 4,
              fontSize: 11,
              fontFamily: 'monospace',
              fontWeight: 'bold',
              letterSpacing: '0.06em',
              cursor: 'pointer',
            }}
          >
            {autoFielderCam ? '🏃 Auto Fielder Cam: ON' : '🏃 Auto Fielder Cam: OFF'}
          </button>

          {/* ── Fielder Cam Replay button: shown for contact plays with
              fielding data after the first animation completes (auto ON)
              or immediately (auto OFF). Replays the play from the
              fielder's over-the-shoulder angle. ── */}
          {fielderCamAvailable.current && (
            <button
              onClick={() => {
                fielderCamArmedRef.current = true;
                fielderCamFiredRef.current = true;
                setFielderCamTrigger((prev) => prev + 1);
              }}
              title="Replay the fielder camera view"
              style={{
                width: '100%',
                marginTop: 8,
                padding: '5px 8px',
                background: 'rgba(255,143,143,0.12)',
                border: '1px solid rgba(255,143,143,0.55)',
                color: '#ff8f8f',
                borderRadius: 4,
                fontSize: 11,
                fontFamily: 'monospace',
                fontWeight: 'bold',
                letterSpacing: '0.06em',
                cursor: 'pointer',
              }}
            >
              🏃 Fielder Cam Replay
            </button>
          )}
        </div>
        </div>

        {/* ☰ Handle: fades in only after the panel has fully rolled back up,
            and is removed the instant the panel starts unrolling. Sits flush
            at the top edge, so the unrolled panel shares its top edge. ── */}
        {handleVisible && (
          <button
            onClick={() => {
              // Remove the handle first, then start the unroll.
              setHandleVisible(false);
              setPlaybackPanelOpen(true);
            }}
            className="playback-handle-in"
            aria-expanded={false}
            aria-controls="playback-controls-panel"
            aria-label="Expand playback controls"
            title="Unroll the playback controls"
            style={{
              width: 40,
              height: 40,
              boxSizing: 'border-box',
              borderRadius: 10,
              background: 'linear-gradient(180deg, rgba(10,14,20,0.92), rgba(6,9,14,0.92))',
              border: '1px solid rgba(255,255,255,0.18)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
              backdropFilter: 'blur(6px)',
            }}
          >
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ width: 16, height: 2, background: '#fff', borderRadius: 1, opacity: 0.9 }} />
              <span style={{ width: 16, height: 2, background: '#fff', borderRadius: 1, opacity: 0.9 }} />
              <span style={{ width: 16, height: 2, background: '#fff', borderRadius: 1, opacity: 0.9 }} />
            </span>
          </button>
        )}

        {/* ── DEBUG OVERLAYS DRAWER (collapsible) ── */}
        {(crossings || (pitchData && pitchData.statcast_px != null && pitchData.statcast_pz != null) || battedBallData) && (
        <div ref={overlaysRef} style={{
          marginTop: 10,
          background: 'rgba(0,0,0,0.75)',
          color: 'white',
          padding: '10px 14px',
          borderRadius: '8px',
          fontFamily: 'monospace',
          fontSize: '11px',
          minWidth: '210px',
          backdropFilter: 'blur(6px)',
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 'bold', fontSize: '12px', opacity: 0.9, outline: 'none', userSelect: 'none' }}>
              🛠 Overlays
            </summary>

            {/* ── >100 mph effects test (top of the debug drawer) ── */}
            <button
              onClick={startHighSpeedTest}
              disabled={!pitchData || !pitchData.trajectory?.length}
              title={highSpeedTestActive
                ? 'Stop the >100 mph effects test and return to live playback'
                : `Replay the current pitch at ${HIGH_SPEED_TEST_MPH} mph to test the high-speed effects`}
              style={{
                width: '100%',
                marginTop: 8,
                padding: '5px 8px',
                background: highSpeedTestActive ? 'rgba(255,107,107,0.16)' : 'rgba(255,159,28,0.16)',
                border: highSpeedTestActive ? '1px solid rgba(255,107,107,0.7)' : '1px solid rgba(255,159,28,0.7)',
                color: highSpeedTestActive ? '#ff9e9e' : '#ffb347',
                borderRadius: 4,
                fontSize: 11,
                fontFamily: 'monospace',
                fontWeight: 'bold',
                letterSpacing: '0.05em',
                cursor: pitchData?.trajectory?.length ? 'pointer' : 'not-allowed',
                opacity: pitchData?.trajectory?.length ? 1 : 0.45,
              }}
            >
              {highSpeedTestActive ? '■ Stop >100 mph Test' : `⚡ Test ${HIGH_SPEED_TEST_MPH} mph Effects`}
            </button>

            {/* ── Play completion source ── */}
            <div style={{ marginTop: '8px', paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ opacity: 0.7 }}>🎬 Completion</span>
                <span style={{ fontWeight: 'bold', color: completionDebug.source === 'normal' ? '#7ee0a0' : '#999' }}>
                  {completionDebug.source === 'normal' ? 'normal' : '—'}
                </span>
              </div>
            </div>

            {/* ── Crossings ── */}
            {crossings && (
              <details style={{ marginTop: '8px' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 'bold', fontSize: '11px', opacity: 0.85, outline: 'none', userSelect: 'none' }}>
                  📍 Crossing @ Mid-Plate
                </summary>
                {[
                  { label: '🔵 Statcast', color: '#00aaff', pt: crossings.blue },
                  { label: '🔴 Sim (live)', color: '#ff6666', pt: crossings.red },
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
              </details>
            )}

            {/* ── 2D strike zone ── */}
            {pitchData && pitchData.statcast_px != null && pitchData.statcast_pz != null && (
              <details style={{ marginTop: '8px' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 'bold', fontSize: '11px', opacity: 0.85, outline: 'none', userSelect: 'none' }}>
                  🎯 2D Zone (Gameday-style)
                </summary>
                <canvas
                  ref={canvasRef}
                  width={160}
                  height={200}
                  style={{ border: '1px solid #333', borderRadius: '4px', marginTop: '6px' }}
                />
              </details>
            )}

            {/* ── Batted ball ── */}
            {battedBallData && (
              <details style={{ marginTop: '8px' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 'bold', fontSize: '11px', opacity: 0.85, outline: 'none', userSelect: 'none' }}>
                  ⚾ Batted Ball (Statcast)
                </summary>
                {[
                  { label: 'Batter', value: battedBallData.batter ?? '—' },
                  { label: 'Launch', value: `${battedBallData.launchSpeed != null ? battedBallData.launchSpeed.toFixed(1) : '—'} mph · ${battedBallData.launchAngle != null ? battedBallData.launchAngle.toFixed(0) : '—'}°` },
                  { label: 'Spray', value: `${battedBallData.sprayAngle != null ? battedBallData.sprayAngle.toFixed(1) : '—'}°` },
                  { label: 'Distance', value: `${battedBallData.totalDistance != null ? battedBallData.totalDistance.toFixed(0) : '—'} ft` },
                  { label: 'Result', value: (battedBallData.trajectory || '').replace(/_/g, ' ') },
                ].map((row) => (
                  <div key={row.label} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.08)'
                  }}>
                    <span style={{ opacity: 0.7 }}>{row.label}</span>
                    <span style={{ opacity: 0.95 }}>{row.value}</span>
                  </div>
                ))}
              </details>
            )}
          </details>
        </div>
        )}
      </div>


      <Scene pitchData={pitchData} battedBall={battedBallData} snapTrigger={snapTrigger} onCrossings={setCrossings} onArrival={handlePitchArrival} onPlayResult={handlePlayResult} onComplete={handlePlayComplete} comparisonActive={compareMode === 'active'} comparisonPlays={comparisonPlays} replayKey={comparisonReplayKey} showColoredTails={showColoredTails} showBillowParticles={showBillowParticles} impactEffect={impactEffect} showComparisonRingLabels={showComparisonRingLabels} followEnabled={followBattedBall && compareMode !== 'active' && !replay.active} fielderCamTrigger={fielderCamTrigger} onFielderCamEnd={() => {}} onFielderCamActiveChange={setFielderCamActive} defenseAlignment={defenseAlignment} />

      <Scorebug
        refreshKey={hudRefresh}
        outcomeRefresh={scorebugOutcomeRefresh}
        gamePk={activeGamePk}
        frozen={scoreboardFrozen}
        stateOverride={scorebugStateOverride}
        delaySeconds={broadcastDelaySeconds}
        onDefenseUpdate={setDefenseData}
        onSelectGameLogPlay={selectReviewPlay}
        selectedGameLogPlayId={review.atBatIndex}
        reviewMode={review.active}
        reviewScoreTab={reviewScoreTab}
        onReviewScoreTabChange={setReviewScoreTab}
        comparisonActive={compareMode === 'active'}
        gameTerminal={gameTerminal}
      />


      {/* ── BOTTOM-LEFT: pitch metrics + movement hint ── */}
      <div ref={bottomLeftRef} style={{
        position: 'absolute',
        bottom: 20,
        left: 20,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 10,
      }}>
        {pitchData && (
          <div
            ref={pitchPanelRef}
            aria-hidden={panelSlidOut}
            style={{
              position: 'relative',
              background: 'linear-gradient(180deg, rgba(10,14,20,0.92), rgba(6,9,14,0.92))',
              color: 'white',
              padding: pitchPanelOpen ? '10px 14px' : '4px 12px',
              borderRadius: '10px',
              fontFamily: 'monospace',
              fontSize: '11px',
              minWidth: atBatOpen && !atBatData
                ? (atBatSnapshotWidth ? `${atBatSnapshotWidth}px` : '280px')
                : '280px',
              minHeight: pitchPanelOpen ? (atBatSnapshotHeight ? `${atBatSnapshotHeight}px` : undefined) : 19,
              backdropFilter: 'blur(6px)',
              border: '1px solid rgba(255,255,255,0.18)',
              boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
              transform: panelSlidOut ? 'translateX(calc(-100% - 40px))' : 'translateX(0)',
              transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), min-width 0.3s ease, min-height 0.3s ease, padding 0.3s ease',
              pointerEvents: panelSlidOut ? 'none' : 'auto',
            }}
          >
            {/* Browser-style view tabs sit above the panel: the selected tab
                is flush with the panel and the other tab sits slightly behind
                it instead of cycling through views from one button. */}
            {/* The header row doubles as the collapse/expand toggle, in the
                style of the Games drawer: clicking the top strip (the part
                that stays visible when collapsed) flips the panel, with a
                ▾/▸ triangle showing the state. Interactive controls inside
                stop the click so they don't collapse the panel. */}
            <div
              onClick={toggleUnlocked ? () => setPitchPanelOpen((open) => !open) : undefined}
              title={toggleUnlocked
                ? (pitchPanelOpen ? 'Collapse the pitch details' : 'Expand the pitch details')
                : 'Available once the play has finished'}
              style={{
                minHeight: pitchPanelOpen ? 24 : 19,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: pitchPanelOpen ? 8 : 0,
                userSelect: 'none',
                cursor: toggleUnlocked ? 'pointer' : 'default',
                transition: 'min-height 0.3s ease, margin-bottom 0.3s ease',
              }}
            >
              <span
                ref={tabsRef}
                role="tablist"
                aria-label="Play view"
                style={{
                  position: 'absolute',
                  top: -28,
                  left: -1,
                  zIndex: 2,
                  display: 'flex', alignItems: 'flex-end',
                }}
              >
                {[
                  { label: 'Pitch', active: !atBatOpen && !defenseOpen, onClick: selectPitchView, title: 'Show pitch details' },
                  { label: 'At-Bat', active: atBatOpen, onClick: selectAtBatView, title: 'Show every pitch in this at-bat' },
                  { label: 'Defense', active: defenseOpen, onClick: selectDefenseView, title: 'Show defensive alignment' },
                ].map((tab, index) => (
                  <button
                    key={tab.label}
                    role="tab"
                    aria-selected={tab.active}
                    onClick={(e) => { e.stopPropagation(); tab.onClick(); }}
                    disabled={!pitchData}
                    title={tab.title}
                    style={{
                      position: 'relative',
                      zIndex: tab.active ? 2 : 1,
                      marginLeft: index === 0 ? 0 : -4,
                      padding: '5px 12px 6px',
                      background: tab.active ? '#000' : 'rgba(42,46,54,0.96)',
                      color: tab.active ? '#fff' : '#aab4c0',
                      border: 'none',
                      borderBottom: 'none',
                      borderRadius: '7px 7px 0 0',
                      fontSize: 13,
                      fontFamily: 'monospace',
                      fontWeight: 'bold',
                      letterSpacing: '0.02em',
                      cursor: pitchData ? 'pointer' : 'not-allowed',
                      opacity: pitchData ? 1 : 0.4,
                      boxShadow: tab.active ? '0 -2px 8px rgba(0,0,0,0.35)' : 'none',
                      lineHeight: '16px',
                      transition: 'background 0.25s ease, color 0.25s ease, box-shadow 0.25s ease, z-index 0s',
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </span>
              {/* Comparison controls share the header row (left) and the
                  triangle sits right-aligned in the pitch view. The empty
                  slot keeps the triangle on the right. */}
              {/* Model/Graph toggle: switches between the 3D baseball model
                  and the pitch movement scatterplot. Shown in the Pitch view
                  only, and only while the panel is expanded. Disabled until
                  the first play finishes. */}
              {pitchPanelOpen && !atBatOpen && !defenseOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); setGraphMode((v) => !v); }}
                  disabled={!toggleUnlocked}
                  title={toggleUnlocked
                    ? (graphMode ? 'Switch to 3D baseball model' : 'Switch to pitch movement graph')
                    : 'Available once the play has finished'}
                  style={{
                    padding: '2px 8px',
                    background: graphMode ? 'rgba(123,180,255,0.18)' : '#333',
                    color: graphMode ? '#9fd0ff' : 'white',
                    border: graphMode ? '1px solid rgba(123,180,255,0.6)' : 'none',
                    borderRadius: 4,
                    fontSize: 11,
                    fontFamily: 'monospace',
                    fontWeight: 'bold',
                    opacity: toggleUnlocked ? 1 : 0.4,
                    cursor: toggleUnlocked ? 'pointer' : 'not-allowed',
                  }}
                >
                  {graphMode ? 'Model' : 'Graph'}
                </button>
              )}
              <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {/* The compare flow operates on the current at-bat's replayable
                    pitches, so its controls are hidden in the read-only game
                    view (and entering that view drops any pending selection). */}
                {pitchPanelOpen && atBatOpen && atBatData && !batterGameOpen && (
                  compareMode === 'active' ? (
                    <>
                      <button
                        onClick={exitComparisonToAtBat}
                        title="End the comparison, replay the play that was running, and stay on the at-bat view"
                        style={{
                          padding: '2px 8px', background: '#7a3a00', color: '#ffd166',
                          border: '1px solid #ff9933', borderRadius: 4,
                          fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold',
                          cursor: 'pointer',
                        }}
                      >
                        ✕ Exit comparison
                      </button>
                      <button
                        onClick={() => setComparisonReplayKey((k) => k + 1)}
                        title="Restart the comparison from the beginning (skip the current flight)"
                        style={{
                          padding: '2px 8px', background: '#1a4a7a', color: '#9be7a0',
                          border: '1px solid #4a9eff', borderRadius: 4,
                          fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold',
                          cursor: 'pointer',
                        }}
                      >
                        ↺ Replay
                      </button>
                      <button
                        onClick={() => setShowComparisonRingLabels((v) => !v)}
                        title={showComparisonRingLabels
                          ? 'Hide the pitch-type labels under each ring'
                          : 'Show the pitch-type label under each ring'}
                        style={{
                          padding: '2px 8px',
                          background: showComparisonRingLabels ? 'rgba(123,180,255,0.14)' : 'rgba(255,255,255,0.06)',
                          color: showComparisonRingLabels ? '#9fd0ff' : '#9aa3ad',
                          border: showComparisonRingLabels ? '1px solid rgba(123,180,255,0.55)' : '1px solid rgba(255,255,255,0.25)',
                          borderRadius: 4,
                          fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold',
                          cursor: 'pointer',
                        }}
                      >
                        {showComparisonRingLabels ? '🏷 Labels: ON' : '🏷 Labels: OFF'}
                      </button>
                    </>
                  ) : (
                    <>
                      {compareMode === 'selecting' && (
                        <button
                          onClick={cancelCompareSelecting}
                          title="Cancel and clear the selection"
                          style={{
                            padding: '2px 8px', background: '#5c2b2b', color: '#ffb0b0',
                            border: '1px solid #b34a4a', borderRadius: 4,
                            fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold',
                            cursor: 'pointer',
                          }}
                        >
                          ✕ Cancel
                        </button>
                      )}
                      <button
                        onClick={compareMode === 'selecting' ? startComparison : startCompareSelecting}
                        disabled={compareMode === 'selecting' && compareSelectedIds.length < 2}
                        title={compareMode === 'selecting' ? 'Simulate the selected pitches together' : 'Compare the pitches in this at-bat'}
                        style={{
                          padding: '2px 8px', background: '#1a4a7a', color: '#9be7a0',
                          border: '1px solid #4a9eff', borderRadius: 4,
                          fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold',
                          cursor: compareMode === 'selecting' && compareSelectedIds.length < 2 ? 'not-allowed' : 'pointer',
                          opacity: compareMode === 'selecting' && compareSelectedIds.length < 2 ? 0.55 : 1,
                        }}
                      >
                        {compareMode === 'selecting'
                          ? `▶ Simulate${compareSelectedIds.length > 0 ? ` (${compareSelectedIds.length})` : ''}`
                          : '⇉ Compare'}
                      </button>
                    </>
                  )
                )}
              </div>
              <span
                aria-hidden="true"
                style={{
                  fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold',
                  color: 'white', opacity: 0.85,
                  lineHeight: pitchPanelOpen ? 'normal' : '19px',
                }}
              >
                {pitchPanelOpen ? '▾' : '▸'}
              </span>
            </div>

            {/* Animated collapsible body: stays mounted so the height (CSS grid
                0fr→1fr) and opacity can transition smoothly on expand/collapse. */}
            <div style={{
              display: 'grid',
              gridTemplateRows: pitchPanelOpen ? '1fr' : '0fr',
              opacity: pitchPanelOpen ? 1 : 0,
              overflow: 'hidden',
              transition: 'grid-template-rows 0.35s ease, opacity 0.3s ease',
            }}>
              <div style={{ minHeight: 0, overflow: 'hidden' }}>
                {atBatOpen ? (
                  <div>
                    {/* Show the skeleton any time the at-bat tab is open but
                        the data hasn't arrived yet (covers both the brief
                        gap before fetchAtBat sets atBatLoading and the
                        actual fetch window). */}
                    {!atBatData && !atBatError && <AtBatLoadingPlaceholder />}
                    {atBatError && !atBatData && <div style={{ color: '#ff6b6b', padding: '8px 0' }}>{atBatError}</div>}
                    {atBatData && (
                      <div
                        className="at-bat-fade-in"
                        key={atBatData.at_bat_index ?? 'loaded'}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 11 }}>
                          <span style={{ opacity: 0.8 }}>{atBatData.batter ?? '—'}</span>
                          {batterGameOpen ? (
                            (() => {
                              const all = revealedPitches(batterGameData?.pitches, pitchData, pitchOutcome);
                              const shown = gameFilterMode === 'pitchType'
                                ? (pitchTypeFilter == null ? all : all.filter((p) => (p.pitch_type ?? (p.pitch || {}).pitch_type ?? null) === pitchTypeFilter)).length
                                : (pitcherFilter == null ? all : all.filter((p) => p.pitcher_id === pitcherFilter)).length;
                              return (
                                <span style={{ opacity: 0.7 }}>
                                  {shown} / {all.length} pitches
                                </span>
                              );
                            })()
                          ) : (
                            <span style={{ opacity: 0.7 }}>{atBatData.pitches?.length ?? 0} pitches</span>
                          )}
                        </div>
                        {atBatError && <div style={{ color: '#ffb066', fontSize: 10, marginBottom: 4 }}>{atBatError}</div>}
                        {batterGameOpen ? (
                          (() => {
                            // Every pitch this batter has faced in the game
                            // (minus the still-animating one), filtered by the
                            // selected pitcher when a chip is active.
                            const allGamePitches = revealedPitches(batterGameData?.pitches, pitchData, pitchOutcome);
                            const pitchTypeOf = (p) => p.pitch_type ?? (p.pitch || {}).pitch_type ?? null;
                            const shownGamePitches = gameFilterMode === 'pitchType'
                              ? (pitchTypeFilter == null ? allGamePitches : allGamePitches.filter((p) => pitchTypeOf(p) === pitchTypeFilter))
                              : (pitcherFilter == null ? allGamePitches : allGamePitches.filter((p) => p.pitcher_id === pitcherFilter));
                            // Pitch types this batter has seen this game, most
                            // thrown first (drives the type chips and legend).
                            const typeCounts = {};
                            for (const p of allGamePitches) {
                              const code = pitchTypeOf(p) || 'Unknown';
                              typeCounts[code] = (typeCounts[code] || 0) + 1;
                            }
                            const typeEntries = Object.entries(typeCounts)
                              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
                            const chipStyle = (active) => ({
                              padding: '3px 8px',
                              background: active ? 'rgba(123,180,255,0.18)' : 'rgba(255,255,255,0.05)',
                              color: active ? '#9fd0ff' : '#c7d0da',
                              border: active ? '1px solid rgba(123,180,255,0.6)' : '1px solid rgba(255,255,255,0.2)',
                              borderRadius: 10,
                              fontSize: 10,
                              fontFamily: 'monospace',
                              cursor: 'pointer',
                            });
                            return (
                              <>
                                {batterGameLoading && !batterGameData && <AtBatLoadingPlaceholder />}
                                {batterGameError && !batterGameData && <div style={{ color: '#ff6b6b', padding: '8px 0' }}>{batterGameError}</div>}
                                {batterGameData && (
                                  <>
                                    <AtBatZone
                                      pitches={shownGamePitches}
                                      szTop={batterGameData.strike_zone_top ?? atBatData.strike_zone_top ?? pitchData?.strike_zone_top ?? 3.5}
                                      szBot={batterGameData.strike_zone_bottom ?? atBatData.strike_zone_bottom ?? pitchData?.strike_zone_bottom ?? 1.5}
                                      showPitchType
                                      colorBy={gameFilterMode === 'pitchType' ? 'pitchType' : 'outcome'}
                                    />
                                    {gameFilterMode === 'pitchType' ? (
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 6, fontSize: 10, opacity: 0.85 }}>
                                        {typeEntries.map(([code]) => (
                                          <span key={code}><span style={{ color: pitchTypeColor(code) }}>●</span> {code}</span>
                                        ))}
                                      </div>
                                    ) : (
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 6, fontSize: 10, opacity: 0.85 }}>
                                        <span><span style={{ color: '#ff5f5f' }}>●</span> Strike</span>
                                        <span><span style={{ color: '#7ee0a0' }}>●</span> Ball</span>
                                        <span><span style={{ color: '#ffa64d' }}>●</span> Foul</span>
                                        <span><span style={{ color: '#4da6ff' }}>●</span> In play</span>
                                        <span><span style={{ color: '#c15cff' }}>●</span> In play · out</span>
                                      </div>
                                    )}
                                    {/* Filter the zone by pitcher or by pitch
                                        type; click a chip to focus it. */}
                                    <div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.12)', paddingTop: 6 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, opacity: 0.75, marginBottom: 4 }}>
                                        <span>Filter by:</span>
                                        <button
                                          onClick={() => setGameFilterMode('pitcher')}
                                          style={{
                                            padding: '2px 8px',
                                            background: gameFilterMode === 'pitcher' ? 'rgba(123,180,255,0.18)' : 'rgba(255,255,255,0.05)',
                                            color: gameFilterMode === 'pitcher' ? '#9fd0ff' : '#c7d0da',
                                            border: gameFilterMode === 'pitcher' ? '1px solid rgba(123,180,255,0.6)' : '1px solid rgba(255,255,255,0.2)',
                                            borderRadius: 10,
                                            fontSize: 10,
                                            fontFamily: 'monospace',
                                            cursor: 'pointer',
                                          }}
                                        >
                                          Pitchers faced
                                        </button>
                                        <button
                                          onClick={() => setGameFilterMode('pitchType')}
                                          style={{
                                            padding: '2px 8px',
                                            background: gameFilterMode === 'pitchType' ? 'rgba(123,180,255,0.18)' : 'rgba(255,255,255,0.05)',
                                            color: gameFilterMode === 'pitchType' ? '#9fd0ff' : '#c7d0da',
                                            border: gameFilterMode === 'pitchType' ? '1px solid rgba(123,180,255,0.6)' : '1px solid rgba(255,255,255,0.2)',
                                            borderRadius: 10,
                                            fontSize: 10,
                                            fontFamily: 'monospace',
                                            cursor: 'pointer',
                                          }}
                                        >
                                          Pitch type
                                        </button>
                                      </div>
                                      {gameFilterMode === 'pitchType' ? (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                          <button
                                            onClick={() => setPitchTypeFilter(null)}
                                            title="Show every pitch type"
                                            style={chipStyle(pitchTypeFilter == null)}
                                          >
                                            All ({allGamePitches.length})
                                          </button>
                                          {typeEntries.map(([code, count]) => {
                                            const active = pitchTypeFilter === code;
                                            return (
                                              <button
                                                key={code}
                                                onClick={() => setPitchTypeFilter(active ? null : code)}
                                                title={`Show only ${code} pitches`}
                                                style={chipStyle(active)}
                                              >
                                                {code} ({count})
                                              </button>
                                            );
                                          })}
                                        </div>
                                      ) : (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                          <button
                                            onClick={() => setPitcherFilter(null)}
                                            title="Show every pitcher's pitches"
                                            style={chipStyle(pitcherFilter == null)}
                                          >
                                            All ({allGamePitches.length})
                                          </button>
                                          {(batterGameData.pitchers ?? []).map((p) => {
                                            const active = pitcherFilter === p.pitcher_id;
                                            return (
                                              <button
                                                key={p.pitcher_id ?? p.pitcher}
                                                onClick={() => setPitcherFilter(active ? null : p.pitcher_id)}
                                                title={`Show only ${p.pitcher}'s pitches`}
                                                style={chipStyle(active)}
                                              >
                                                {p.pitcher} ({p.pitches})
                                              </button>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  </>
                                )}
                              </>
                            );
                          })()
                        ) : (
                          <>
                            <AtBatZone
                              pitches={revealedPitches(atBatData.pitches, pitchData, pitchOutcome)}
                              szTop={atBatData.strike_zone_top ?? pitchData?.strike_zone_top ?? 3.5}
                              szBot={atBatData.strike_zone_bottom ?? pitchData?.strike_zone_bottom ?? 1.5}
                              activePitchNumber={replay.active ? replay.pitchNumber : null}
                              onSelect={compareMode === 'active' ? undefined : selectReplayPitch}
                              selectionMode={compareMode === 'selecting'}
                              selectedPlayIds={compareMode === 'selecting' ? new Set(compareSelectedIds) : null}
                              onToggleSelect={toggleCompareSelection}
                            />
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 6, fontSize: 10, opacity: 0.85 }}>
                              <span><span style={{ color: '#ff5f5f' }}>●</span> Strike</span>
                              <span><span style={{ color: '#7ee0a0' }}>●</span> Ball</span>
                              <span><span style={{ color: '#ffa64d' }}>●</span> Foul</span>
                              <span><span style={{ color: '#4da6ff' }}>●</span> In play</span>
                              <span><span style={{ color: '#c15cff' }}>●</span> In play · out</span>
                            </div>
                            {/* Selection feedback while picking pitches to compare;
                                the Compare/Simulate/Cancel buttons themselves live
                                in the header row above. */}
                            {compareMode === 'selecting' && (
                              <div style={{ marginTop: 6, fontSize: 10, color: '#9be7a0', opacity: 0.9 }}>
                                Select pitches to compare{compareSelectedIds.length > 0 ? ` — ${compareSelectedIds.length} selected` : ''}.
                              </div>
                            )}
                          </>
                        )}
                        <div style={{ marginTop: 6, fontSize: 10, opacity: 0.6 }}>
                          {batterGameOpen
                            ? 'Read-only view — use the filter above to focus the zone.'
                            : compareMode === 'selecting'
                              ? 'Click pitches to select them for comparison.'
                              : 'Click a pitch to replay it.'}
                        </div>
                        {/* Game scope toggle, under the at-bat panel: switches
                            the zone between the current at-bat and every pitch
                            the batter has faced this game. */}
                        <button
                          onClick={() => {
                            // Entering the read-only game view has no way to
                            // select or compare pitches, so drop any pending
                            // comparison state first.
                            if (!batterGameOpen) {
                              if (compareMode === 'active') exitComparison();
                              if (compareMode === 'selecting') cancelCompareSelecting();
                            }
                            setBatterGameOpen((v) => !v);
                          }}
                          title={batterGameOpen
                            ? 'Show only the current at-bat'
                            : 'Show every pitch this batter has faced in the game'}
                          style={{
                            width: '100%',
                            marginTop: 8,
                            padding: '4px 8px',
                            background: batterGameOpen ? 'rgba(26,74,122,0.55)' : 'rgba(26,74,122,0.35)',
                            color: '#9fd0ff',
                            border: '1px solid rgba(74,158,255,0.55)',
                            borderRadius: 4,
                            fontSize: 11,
                            fontFamily: 'monospace',
                            fontWeight: 'bold',
                            cursor: 'pointer',
                          }}
                        >
                          {batterGameOpen ? '◀ At-bat' : 'Game'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : defenseOpen ? (
                  <div className="at-bat-fade-in" key="defense-view">
                    {/* Defensive alignment diamond diagram */}
                    {defenseAlignment ? (
                      <DefenseDiagram alignment={defenseAlignment} formation={defenseFormation} />
                    ) : (
                      <div style={{ color: '#aab', padding: '12px 0', fontSize: 11 }}>
                        Defensive alignment unavailable.
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    className="at-bat-fade-in"
                    key={pitchContentKey}
                  >
                    {/* Bold velocity + pitch type, shown in both model and graph views */}
                    <div style={{ fontWeight: 'bold', fontSize: '13px', letterSpacing: '0.02em', margin: graphMode ? '0 0 4px' : '6px 0', userSelect: 'none' }}>
                      {pitchData.speed_mph != null ? `${Number(pitchData.speed_mph.toFixed(1))} mph` : '— mph'}
                      {pitchData.pitch_type_description ? ` · ${pitchData.pitch_type_description}` : ''}
                    </div>
                    {graphMode ? (
                      <>
                        {/* Pitch movement scatterplot with confidence ellipses.
                            The current pitch dot is hidden until the animation
                            finishes (toggleUnlocked), so it can't spoil the
                            pitch before the first play-through. */}
                        {graphLoading && !graphData && (
                          <div style={{ color: '#9aa3ad', fontSize: 10, padding: '20px 0', textAlign: 'center' }}>
                            Loading movement data…
                          </div>
                        )}
                        {graphError && !graphData && (
                          <div style={{ color: '#ffb066', fontSize: 10, padding: '12px 0', textAlign: 'center' }}>
                            {graphError}
                          </div>
                        )}
                        {graphData && (
                          <PitchMovementGraph
                            graphData={graphData}
                            currentPitch={pitchData}
                            showCurrentDot={toggleUnlocked}
                            leagueAvg={avgBreak}
                          />
                        )}
                        {!graphLoading && !graphError && !graphData && (
                          <div style={{ color: '#9aa3ad', fontSize: 10, padding: '20px 0', textAlign: 'center' }}>
                            No movement data available for this pitcher.
                          </div>
                        )}
                        {/* H/V Break row — compact, shown under the graph */}
                        {breakRows.map(({ label, hint, value, pct }) => (
                          <div key={label} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '2px 0',
                          }}>
                            <span style={{ opacity: 0.7 }}>
                              {label}
                              {hint && (
                                <span
                                  title="Positive H Break = toward 1B, negative = toward 3B (catcher's view)"
                                  style={{ opacity: 0.55, fontSize: 9, marginLeft: 4 }}
                                >
                                  ({hint})
                                </span>
                              )}
                            </span>
                            <span style={{ opacity: 0.95 }}>
                              {value != null ? `${value.toFixed(1)} in` : '—'}
                              {pct != null && (
                                <span style={{ color: pct >= 0 ? '#7ee0a0' : '#ffb066', marginLeft: 6, fontSize: 10 }}>
                                  {pct >= 0 ? '▲' : '▼'} {pct >= 0 ? '+' : ''}{Math.round(pct)}% vs avg
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </>
                    ) : (
                      <>
                        {/* Spinning ball with the spin axis drawn as an arrow */}
                        <SpinAxisViz spinAxis={pitchData.spin_axis} spinRate={pitchData.spin_rate} />

                        {/* Horizontal/vertical break, each with how far above/below the
                            pitch-type average this pitch's movement is (▲/▼) */}
                        {breakRows.map(({ label, hint, value, pct }) => (
                          <div key={label} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '3px 0'
                          }}>
                            <span style={{ opacity: 0.7 }}>
                              {label}
                              {hint && (
                                <span
                                  title="Positive H Break = toward 1B, negative = toward 3B (catcher's view)"
                                  style={{ opacity: 0.55, fontSize: 9, marginLeft: 4 }}
                                >
                                  ({hint})
                                </span>
                              )}
                            </span>
                            <span style={{ opacity: 0.95 }}>
                              {value != null ? `${value.toFixed(1)} in` : '—'}
                              {pct != null && (
                                <span style={{ color: pct >= 0 ? '#7ee0a0' : '#ffb066', marginLeft: 6, fontSize: 10 }}>
                                  {pct >= 0 ? '▲' : '▼'} {pct >= 0 ? '+' : ''}{Math.round(pct)}% vs avg
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                        {/* Spin rate + efficiency on a single row. The Spin Rate group
                            is hoverable: it pops up a window with the pitch's spin
                            components (Backspin/Sidespin/Gyrospin). */}
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '3px 0'
                        }}>
                          <span
                            ref={spinRateRef}
                            onMouseEnter={showSpinComponentsPopup}
                            onMouseLeave={hideSpinComponentsPopup}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'default' }}
                          >
                            <span style={{ opacity: 0.7, borderBottom: '1px dashed rgba(255,255,255,0.3)' }}>Spin Rate</span>
                            <span style={{ opacity: 0.95 }}>{pitchData.spin_rate != null ? `${Math.round(pitchData.spin_rate)} RPM` : '—'}</span>
                          </span>
                          <span style={{ opacity: 0.7, marginLeft: 16 }}>Spin Eff.</span>
                          <span style={{ opacity: 0.95 }}>{pitchData.spin_efficiency != null ? `${(pitchData.spin_efficiency * 100).toFixed(1)}%` : '—'}</span>
                        </div>
                        {/* Expected batting average on this pitch, estimated locally from
                            exit velocity + launch angle (+ sprint speed on ground balls) */}
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '3px 0 0', borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 2
                        }}>
                          <span style={{ opacity: 0.7 }}>xBA</span>
                          <span style={{ opacity: 0.95 }}>
                            {pitchData.xba != null ? (
                              <span title="Estimated locally from exit velocity, launch angle, and sprint speed (not Savant's official xBA)">
                                {pitchData.xba.toFixed(3).replace(/^0/, '')}
                                <span style={{ opacity: 0.6, fontSize: '10px', marginLeft: 3 }}>est.</span>
                              </span>
                            ) : '—'}
                          </span>
                        </div>
                        {/* Batted-ball metrics, present only on contact plays: Statcast
                            exit velocity + launch angle plus the projected distance. */}
                        {battedBallData && (
                          <>
                            <div style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '3px 0 0', borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 2,
                            }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ opacity: 0.7 }}>Exit Velocity</span>
                                <span style={{ opacity: 0.95 }}>{battedBallData.launchSpeed != null ? `${battedBallData.launchSpeed.toFixed(1)} mph` : '—'}</span>
                              </span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ opacity: 0.7 }}>Launch Angle</span>
                                <span style={{ opacity: 0.95 }}>{battedBallData.launchAngle != null ? `${battedBallData.launchAngle.toFixed(0)}°` : '—'}</span>
                              </span>
                            </div>
                            <div style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '3px 0',
                            }}>
                              <span style={{ opacity: 0.7 }}>Projected Distance</span>
                              <span style={{ opacity: 0.95 }}>{battedBallData.totalDistance != null ? `${battedBallData.totalDistance.toFixed(0)} ft` : '—'}</span>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── SPIN COMPONENTS POPUP ── */}
        {/* Hover window for the Spin Rate row: lists the pitch's reconstructed
            spin components. Fixed-positioned so it escapes the panel's
            overflow clipping; both it and the trigger share the hide timer so
            moving the mouse between them doesn't flicker it closed. */}
        {spinPopupAnchor && pitchData && (
          <div
            onMouseEnter={showSpinComponentsPopup}
            onMouseLeave={hideSpinComponentsPopup}
            style={{
              position: 'fixed',
              left: spinPopupAnchor.left,
              top: spinPopupAnchor.top,
              transform: 'translateY(-50%)',
              zIndex: 30,
              background: 'linear-gradient(180deg, rgba(10,14,20,0.95), rgba(6,9,14,0.95))',
              color: 'white',
              padding: '7px 10px',
              borderRadius: 8,
              fontFamily: 'monospace',
              fontSize: '11px',
              minWidth: '140px',
              backdropFilter: 'blur(6px)',
              border: '1px solid rgba(255,255,255,0.18)',
              boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
              userSelect: 'none',
            }}
          >
            {[
              { label: 'Backspin', value: `${Math.round(pitchData.sim_params?.backspin_rpm || 0)} RPM` },
              { label: 'Sidespin', value: `${Math.round(pitchData.sim_params?.sidespin_rpm || 0)} RPM` },
              { label: 'Gyrospin', value: `${Math.round(pitchData.sim_params?.wg_rpm || 0)} RPM` },
            ].map(({ label, value }) => (
              <div key={label} style={{
                display: 'flex', justifyContent: 'space-between', gap: 16,
                padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.08)'
              }}>
                <span style={{ opacity: 0.7 }}>{label}</span>
                <span style={{ opacity: 0.95 }}>{value}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── WASD MOVEMENT HINT ── */}
        <div style={{
          background: 'rgba(0,0,0,0.55)',
          color: 'rgba(255,255,255,0.75)',
          padding: '6px 12px',
          borderRadius: '6px',
          fontFamily: 'monospace',
          fontSize: '12px',
          letterSpacing: '0.04em',
          pointerEvents: 'none',
          userSelect: 'none',
        }}>
          WASD — move · Q/E — up/down · click + drag — fly look · Shift — sprint
        </div>
      </div>
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
