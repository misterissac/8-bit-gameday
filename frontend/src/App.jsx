import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, Component } from 'react';
import axios from 'axios';
import { Canvas, useFrame } from '@react-three/fiber';
import { Line, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { Scene } from './components/Scene';
import { isHitFieldingReady } from './util/battedBall';
import { isGameTerminal } from './util/scorebug';
import { Scorebug } from './components/Scorebug';
import { AtBatZone } from './components/AtBatZone';
import { setTimeScale, SLOWEST_SPEED } from './constants/playback';
import './App.css';

// How often the app polls the backend for the newest play (ms). Silent polls
// deduplicate already-seen plays and queue newer payloads until the current
// pitch/play animation has finished.
const LIVE_POLL_MS = 1000;
const NO_SIMULATABLE_PITCH_DETAIL = 'No simulated pitch data yet.';

// Fallback league-average induced break (inches, Statcast pfx convention:
// pfxX > 0 = breaks toward the pitcher's glove side / away from an RHB,
// pfxZ > 0 = upward ride) by pitch type. These are only used while the live
// league averages from the backend /api/break-averages endpoint (which
// aggregates Baseball Savant Statcast data) are loading or unavailable.
const FALLBACK_BREAK_BY_TYPE = {
  FF: { x: -6, z: 18 }, // 4-seam fastball
  FA: { x: -6, z: 18 }, // 4-seam fastball (alt code)
  FT: { x: -14, z: 8 }, // 2-seam fastball
  SI: { x: -14, z: 8 }, // sinker
  FC: { x: 2, z: 5 },   // cutter
  SL: { x: 4, z: -2 },  // slider
  ST: { x: 14, z: -3 }, // sweeper
  SW: { x: 14, z: -3 }, // sweeper (alt code)
  CU: { x: 6, z: -7 },  // curveball
  KC: { x: 5, z: -4 },  // knuckle curve
  CH: { x: -10, z: 6 }, // changeup
  FS: { x: -6, z: 2 },  // splitter
  SC: { x: 10, z: 2 },  // screwball
  KN: { x: 0, z: 0 },   // knuckleball
};

// Map an MLB play-result event to a specific banner label, so outs read as
// FLYOUT / POPOUT / LINEOUT / GROUNDOUT / STRIKEOUT / SAC FLY / BUNT / etc.
// instead of a generic OUT. Returns null for events without a specific label
// (the caller falls back to BALL / STRIKE / HIT / OUT).
const specificOutcomeLabel = (event) => {
  switch (event) {
    case 'Strikeout': return 'STRIKEOUT';
    case 'Walk':
    case 'Intent Walk': return 'WALK';
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
    case 'Wild Pitch':
    case 'wild_pitch': return 'WILD PITCH';
    case 'Passed Ball':
    case 'passed_ball': return 'PASSED BALL';
    default: return null;
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

const trajectoryResolutionKey = (d) => JSON.stringify({
  playComplete: d?.play_complete ?? d?.is_complete ?? false,
  resultEvent: d?.result_event ?? null,
  actionEvent: d?.action_event ?? null,
  battedBall: battedBallResolutionKey(d?.batted_ball),
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
]);

// The subset of immediate results that only make sense on the pitch that ended
// the at-bat. When replaying an earlier pitch of a completed at-bat, these must
// fall back to that pitch's own call (BALL / STRIKE / FOUL) instead of showing
// the at-bat's final result prematurely. Stolen bases / caught stealings /
// pickoffs are attached to a specific pitch, so they stay immediate regardless.
const AT_BAT_ENDING_EVENTS = new Set(['Strikeout', 'Walk', 'Intent Walk', 'Hit By Pitch']);

// Banner color by outcome: green for batter-friendly results, red for strikes,
// yellow for big plays (runs / multiple outs), fiery orange for home runs,
// white for everything else.
const outcomeColor = (label) => {
  if (label === 'HOME RUN') return '#ff9f1c';
  if (label === 'BALL' || label === 'WALK' || label === 'HIT BY PITCH' || label === 'STOLEN BASE') return '#7ee0a0';
  if (label === 'STRIKE' || label === 'STRIKEOUT' || label === 'CAUGHT STEALING' || label === 'PICKOFF') return '#ff6b6b';
  if (label === 'FOUL') return '#ffb066';
  if (label === 'RUN' || label === 'DOUBLE PLAY' || label === 'TRIPLE PLAY' || label === 'WILD PITCH' || label === 'PASSED BALL') return '#ffd166';
  return '#ffffff';
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
const OutcomeBanner = ({ label, replay }) => {
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
        <ReplayIndicator replay={replay} />
      </div>
    </div>
  );
};

// Replay marker attached to the outcome banner so historical pitch replays
// remain visually distinct without competing with the outcome text.
const ReplayIndicator = ({ replay }) => {
  if (!replay?.active) return null;
  return (
    <div style={{
      position: 'absolute',
      right: 0,
      bottom: -27,
      zIndex: 2,
      pointerEvents: 'none',
    }}>
      <span style={{
        display: 'inline-block',
        padding: '5px 12px 6px',
        background: 'rgba(42,46,54,0.96)',
        color: '#ffd166',
        border: 'none',
        borderRadius: '0 0 7px 7px',
        fontSize: 13,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        letterSpacing: '0.02em',
        lineHeight: '16px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
        whiteSpace: 'nowrap',
      }}>
        ↺ REPLAY
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
  const [playbackSpeed, setPlaybackSpeed] = useState(1); // shared simulation time scale
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
  const [snapTrigger, setSnapTrigger] = useState(0);
  const [crossings, setCrossings] = useState(null);
  const [pitchOutcome, setPitchOutcome] = useState(null); // specific outcome (BALL, STRIKE, STRIKEOUT, FLYOUT, POPOUT, ...)
  // Bottom-left pitch panel: collapsed by default so the speed/type don't
  // spoil the pitch before it animates; expands once the play resolves.
  const [pitchPanelOpen, setPitchPanelOpen] = useState(false);
  // The show/hide toggle stays disabled until the first play has fully
  // animated, so the pitch can't be spoiled by opening the panel early.
  const [toggleUnlocked, setToggleUnlocked] = useState(false);
  // At-bat tunneling view: replaces the panel's stats/spin ball with a 2D
  // strike zone of every pitch thrown in the current at-bat.
  const [atBatOpen, setAtBatOpen] = useState(false);
  const [atBatData, setAtBatData] = useState(null);
  const [atBatLoading, setAtBatLoading] = useState(false);
  const [atBatError, setAtBatError] = useState(null);
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
  // Bumped exactly once when a play fully finishes; the effect below commits
  // the scoreboard snapshot and advances the queue AFTER the reveal render, so
  // the outcome banner gets a frame to display before the next play starts.
  const [playCompletion, setPlayCompletion] = useState(0);
  const [activeGamePk, setActiveGamePk] = useState(null); // null = backend's default game
  // Once the feed reports the game as finished (Final / Game Over / Completed
  // Early) there is nothing new to poll, so the app-level trajectory and
  // batted-ball pollers stop until a different game is selected.
  const [gameTerminal, setGameTerminal] = useState(false);
  const [liveGames, setLiveGames] = useState(null);
  const [liveGamesLoading, setLiveGamesLoading] = useState(false);
  // The live-games drawer is capped so it stretches from below the control
  // panel down to just above the bottom-left pitch panel (or the WASD hint
  // when no pitch is loaded) instead of running off the bottom of the window.
  const drawerRef = useRef(null);
  const bottomLeftRef = useRef(null);
  const summaryRef = useRef(null);
  const gamesListRef = useRef(null);
  const [drawerMaxHeight, setDrawerMaxHeight] = useState(null);
  const [gamesListMaxHeight, setGamesListMaxHeight] = useState(null);
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
  const pitchDataRef = useRef(null);
  // A play can be enriched (run/out/result) after its trajectory starts. Keep
  // the newest scoreboard snapshot without replacing pitchData and restarting
  // the animation.
  const currentPitchScoreSnapshotRef = useRef(null);
  // The scoreboard snapshot captured the moment a play finished, held so the
  // deferred completion effect can commit exactly that play's state even if a
  // newer poll has already applied the next play.
  const completedPlaySnapshotRef = useRef(null);
  const replayRef = useRef(replay);
  pitchDataRef.current = pitchData;
  replayRef.current = replay;
  // play_id whose outcome has already been shown, so the looping playback
  // doesn't re-trigger the indicator for the same pitch.
  const outcomeShownPlayId = useRef(null);
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
      );
      const d = response.data;
      // Drop this response only when a NEWER response has already been
      // received, so an out-of-order response can't revert the animation to an
      // older pitch. Comparing against the latest request *started* (rather
      // than the latest response received) would drop every response once
      // request latency matches the 1s poll cadence, leaving the panel empty.
      if (seq < lastTrajectoryAppliedSeq.current) return;
      lastTrajectoryAppliedSeq.current = seq;

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

      // While replaying, keep the selected historical pitch on screen. The
      // poller still runs so a later live play can be detected, but it must not
      // silently end the replay. The baseline was already live when replay
      // began; anything newer becomes a visible "new play available" notice.
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
        // Do not replace pitchData here: BattedBall uses that object as the
        // animation identity, and replacing it would restart a long play.
        // A newly-completed hit is applied independently so its pending OUT /
        // DOUBLE PLAY callbacks can catch up with the current flight clock.
        if (nextTrajectoryResolutionKey === lastTrajectoryResolutionKey.current) return;
        lastTrajectoryResolutionKey.current = nextTrajectoryResolutionKey;
        if (nextBattedPayload && nextBattedResolutionKey !== lastBattedResolutionKey.current) {
          lastBattedPlayId.current = nextBattedPayload.play_id;
          lastBattedResolutionKey.current = nextBattedResolutionKey;
          rememberAppliedBattedBall(nextBattedPayload, nextBattedResolutionKey);
          setBattedBallData(nextBattedBall);
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
      if (!replayRef.current.active && trajectoryQueueRef.current.length > 0) {
        enqueueTrajectoryPayload(d);
        startNextQueuedPlay();
        return;
      }
      if (!replayRef.current.active && hasActivePitch && !playFinishedRef.current) {
        enqueueTrajectoryPayload(d);
        startNextQueuedPlay();
        return;
      }

      applyTrajectoryPayload(d);
    } catch (err) {
      const detail = err.response?.data?.detail;
      const isWaiting = detail === NO_SIMULATABLE_PITCH_DETAIL;
      if (isWaiting && seq >= lastTrajectoryAppliedSeq.current) {
        // A game can have no valid pitch yet, so there is no previous payload
        // to carry the status. Treat the expected 404 as a waiting state, not
        // as a red error banner.
        setWaitingForPitchData(true);
        setPendingPitchNumber(null);
        setError(null);
      } else if (!silent && seq === trajectoryReqSeq.current) {
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
    setBattedBallData(toBattedBallData(d));
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
    // A new pitch is about to animate: clear the previous outcome and collapse
    // the panel in the same update as the pitch swap, so the scorebug remains
    // frozen on the last completed snapshot until this pitch finishes.
    setPitchOutcome(null);
    setPitchPanelOpen(false);
    setPitchData(d);
  };

  // Drain the queue by starting the next play when the current one is finished
  // (or when nothing is active). This is the single point that advances from
  // one play to the next, so queued plays always animate in arrival order and
  // never skip ahead to a play that hasn't animated yet.
  const startNextQueuedPlay = () => {
    if (replayRef.current.active) return;
    const hasActivePitch = !!pitchDataRef.current || lastTrajectoryPlayId.current != null;
    if (hasActivePitch && !playFinishedRef.current) return;
    const next = trajectoryQueueRef.current.shift();
    if (next) {
      queuedTrajectoryPlayIdsRef.current.delete(next.play_id ?? null);
      applyTrajectoryPayload(next);
    }
  };

  const fetchBattedBall = async (gamePk = activeGamePk, { silent = false } = {}) => {
    const seq = ++battedReqSeq.current;
    battedBallRequestsInFlight.current += 1;
    try {
      const response = await axios.get(
        withGame(`${API_BASE}/api/batted-ball`, gamePk, {
          after_play_id: lastBattedPlayId.current,
        }),
      );
      const d = response.data;
      // Drop this response only when a NEWER response has already arrived, so
      // a slow poll can't overwrite the newest hit with a stale one. Comparing
      // against the latest request *started* starves the feed under latency.
      if (seq < lastBattedAppliedSeq.current) return;
      lastBattedAppliedSeq.current = seq;

      // Apply recovered hits in feed order. A hit whose owning trajectory has
      // not started is held by pitch_play_id; the top-level newest hit is then
      // safe to process without overwriting an earlier animation.
      const recovered = Array.isArray(d?.queued_batted_balls)
        ? d.queued_batted_balls
        : [];
      for (const hit of [...recovered, d]) applyBattedBallPayload(hit);
    } catch (err) {
      if (!silent && seq === battedReqSeq.current) console.error("Failed to fetch batted ball", err);
      // Keep the bundled demo samples running when no live hit is available.
    } finally {
      battedBallRequestsInFlight.current = Math.max(0, battedBallRequestsInFlight.current - 1);
    }
  };

  const fetchLiveGames = async () => {
    try {
      setLiveGamesLoading(true);
      const response = await axios.get(`${API_BASE}/api/live-games`);
      setLiveGames(response.data?.games ?? []);
    } catch (err) {
      console.error("Failed to fetch live games", err);
    } finally {
      setLiveGamesLoading(false);
    }
  };

  // Force a full re-fetch + re-animate, used by the Refresh button and when a
  // game is picked from the live-games drawer.
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
    knownTrajectoryPlayIdsRef.current.clear();
    pendingBattedBallsRef.current.clear();
    setNewLivePlayAvailable(false);
    appliedBattedPlayIdsRef.current.clear();
    pitchDataRef.current = null;
    playFinishedRef.current = false;
    currentPitchScoreSnapshotRef.current = null;
    lastTrajectoryPlayId.current = null;
    lastBattedPlayId.current = null;
    lastTrajectoryResolutionKey.current = null;
    lastBattedResolutionKey.current = null;
    fetchTrajectory(gamePk);
    fetchBattedBall(gamePk);
    setHudRefresh(prev => prev + 1);
  };

  const selectGame = (gamePk) => {
    if (gamePk === activeGamePk) return;
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
    setPitchPanelOpen(false);
    // Selecting a different game resumes the app-level pollers; the new
    // game's first payload flips this back if it is already final.
    setGameTerminal(false);
    refreshAll(gamePk);
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
      setAtBatData(response.data);
    } catch (err) {
      console.error("Failed to fetch at-bat", err);
      // Surface the backend's reason (e.g. "Game hasn't started yet!" or
      // "At-bat N not found.") instead of a generic failure message.
      setAtBatError(err.response?.data?.detail || "Failed to load at-bat pitches.");
    } finally {
      setAtBatLoading(false);
    }
  };

  const selectPitchView = () => {
    if (!pitchData) return;
    setAtBatOpen(false);
    setPitchPanelOpen(true);
  };

  const selectAtBatView = () => {
    if (!pitchData) return;
    setAtBatOpen(true);
    setPitchPanelOpen(true);
  };

  // Replay one pitch from the at-bat: swap it in exactly like a freshly-arrived
  // pitch (panel collapses, outcome clears, then reveals on arrival/play).
  const selectReplayPitch = (p) => {
    if (!p?.replayable || !p?.pitch) return;
    // Invalidate any live poll still in flight so its (now-stale) response
    // can't overwrite the replayed pitch after it lands.
    trajectoryReqSeq.current += 1;
    battedReqSeq.current += 1;
    setAtBatOpen(false);
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
    replayRef.current = nextReplay;
    setReplay(nextReplay);
    outcomeShownPlayId.current = null;
    playFinishedRef.current = false;
    setPitchOutcome(null);
    setPitchPanelOpen(false);
    lastTrajectoryPlayId.current = p.play_id ?? null;
    lastTrajectoryResolutionKey.current = trajectoryResolutionKey(p.pitch);
    lastBattedPlayId.current = p.hit?.play_id ?? null;
    lastBattedResolutionKey.current = battedBallResolutionKey(p.hit);
    pitchDataRef.current = p.pitch;
    currentPitchScoreSnapshotRef.current = p.pitch?.game_state ?? null;
    setPitchData(p.pitch);
    setBattedBallData(toBattedBallData(p.hit));
  };

  const backToLive = () => {
    const nextReplay = { active: false, playId: null, pitchNumber: null, atBatIndex: null, livePlayId: null };
    replayRef.current = nextReplay;
    trajectoryQueueRef.current = [];
    queuedTrajectoryPlayIdsRef.current.clear();
    setScorebugStateOverride(null);
    setReplay(nextReplay);
    setAtBatOpen(false);
    // Clear the replayed pitch immediately so the scene doesn't keep looping
    // it while the fresh live fetch is in flight, and reset the outcome/panel
    // state so the next live play reveals cleanly.
    setPitchData(null);
    setBattedBallData(null);
    setPitchOutcome(null);
    setPitchPanelOpen(false);
    setWaitingForPitchData(false);
    setPendingPitchNumber(null);
    outcomeShownPlayId.current = null;
    refreshAll(activeGamePk);
  };

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
    const event = pitchData?.result_event;
    // A strikeout / walk / hit-by-pitch / stolen base / caught stealing /
    // pickoff is final the moment the ball reaches the plate, so reveal its
    // specific outcome right away instead of a bare BALL/STRIKE.
    if (event && IMMEDIATE_RESULT_EVENTS.has(event)) {
      // Strikeout/walk/hit-by-pitch are only "immediate" when this pitch is
      // the one that ended the at-bat. Replaying an earlier pitch of a
      // completed at-bat must show that pitch's own BALL/STRIKE/FOUL instead.
      // (``is_at_bat_final`` is absent on live payloads, which are always the
      // final pitch of their at-bat, so the shortcut still applies there.)
      if (!AT_BAT_ENDING_EVENTS.has(event) || pitchData?.is_at_bat_final !== false) {
        showOutcome(specificOutcomeLabel(event));
        if (!isContactPitch) finishCurrentPlay();
        return;
      }
    }
    // A wild pitch / passed ball is an action event attached to the pitch that
    // got away, not the play's result. Show it when the batter's outcome
    // wasn't already definitive, so it isn't hidden behind a bare BALL/STRIKE.
    const action = pitchData?.action_event;
    if (action === 'Wild Pitch' || action === 'Passed Ball') {
      showOutcome(specificOutcomeLabel(action));
      if (!isContactPitch) finishCurrentPlay();
      return;
    }
    const call = pitchData?.call_code;
    if (call === 'B' || call === '*B' || call === 'P') {
      showOutcome('BALL');
    } else if (call === 'H') {
      showOutcome('HIT BY PITCH');
    } else if (call === 'F' || call === 'T' || call === 'L') {
      showOutcome('FOUL');
    } else if (call === 'C' || call === 'S' || call === 'W' || call === 'M') {
      showOutcome('STRIKE');
    }
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
      showOutcome(text);
      return;
    }
    const scored = battedBallData?.runners?.some((r) => r.end === 'score');
    showOutcome(scored ? 'RUN' : 'HIT');
  };

  // The batted-ball choreography fully resolved (last out recorded / hit
  // settled). Unlike handlePlayResult, which fires per result (including the
  // intermediate OUT of a double play), this fires exactly once per play and
  // is the signal that advances to the next queued play.
  const handlePlayComplete = () => {
    finishCurrentPlay();
  };

  useEffect(() => {
    fetchTrajectory();
    fetchBattedBall();
    fetchLiveGames();
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
    if (gameTerminal) return;
    const id = setInterval(() => {
      if (trajectoryRequestsInFlight.current > 0 || battedBallRequestsInFlight.current > 0) return;
      fetchTrajectory(activeGamePk, { silent: true });
      fetchBattedBall(activeGamePk, { silent: true });
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [activeGamePk, replay.active, gameTerminal]);

  // Load (and refresh) the at-bat pitch list while the 2D strike zone is open:
  //   * on open, and again whenever the batter changes, so the zone resets to
  //     the new batter's at-bat;
  //   * each time a pitch/play finishes animating (atBatOutcomeRefresh) so the
  //     zone grows one dot at a time instead of spoiling the pitch on arrival.
  useEffect(() => {
    if (!atBatOpen) return;
    fetchAtBat(pitchData?.at_bat_index ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atBatOpen, pitchData?.at_bat_index, atBatOutcomeRefresh]);

  // Once a play fully finishes, commit its scoreboard snapshot, open the panel,
  // and start the next queued play. Deferred to an effect (keyed on
  // playCompletion rather than pitchOutcome) so it runs exactly once per play —
  // not once per intermediate result — and only after the reveal has rendered.
  useEffect(() => {
    if (playCompletion === 0) return;

    setPitchPanelOpen(true);
    setToggleUnlocked(true);
    // Commit the state captured for THIS completed play before starting the
    // next queued animation. Scorebug's frozen override prevents its own
    // /api/game-state poll from jumping over any queued play.
    if (!replayRef.current.active && completedPlaySnapshotRef.current) {
      setScorebugStateOverride(completedPlaySnapshotRef.current);
    }
    setScorebugOutcomeRefresh(prev => prev + 1);
    setAtBatOutcomeRefresh(prev => prev + 1);

    startNextQueuedPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playCompletion]);

  // Scoreboard spoiler guard: freeze the scorebug for the entire time a pitch
  // is loaded (including its looping replay) so it can't poll ahead and spoil
  // the next pitch. It re-fetches once per pitch via scorebugOutcomeRefresh.
  // During a user-initiated historical replay the scorebug is deliberately
  // un-frozen so it keeps showing the newest live score/count.
  const scoreboardFrozen = !!pitchData && !replay.active;

  // A contact pitch has no batted ball to show until its Statcast fielding
  // point (hc_x/hc_y) arrives. While that data is pending, hold the batted
  // ball and show a notice instead of animating a reconstructed/wrong flight.
  const waitingForPlayResolve = (
    !replay.active &&
    pitchData?.is_contact === true &&
    pitchData?.call_code !== 'F' &&
    pitchData?.call_code !== 'L' &&
    !isHitFieldingReady(battedBallData)
  );

  // Horizontal/vertical break display: Statcast pfx (in) plus how far above or
  // below the pitch-type average this pitch's movement is. Magnitude-based for
  // both axes (handedness-independent), so the percentage reads as "how much
  // break vs. typical" — a curve with extra drop shows ▲ just like a fastball
  // with extra ride. Live league averages from /api/break-averages take
  // precedence; the fallback table covers loading/failure.
  const avgBreak = pitchData
    ? (breakAverages?.[pitchData.pitch_type] ?? FALLBACK_BREAK_BY_TYPE[pitchData.pitch_type])
    : null;
  const breakPct = (value, avg) => {
    if (value == null || avg == null || avg === 0) return null;
    const base = Math.abs(avg);
    return ((Math.abs(value) - base) / base) * 100;
  };
  const breakRows = [
    { label: 'H Break', value: pitchData?.pfx_x, avg: avgBreak?.x },
    { label: 'V Break', value: pitchData?.pfx_z, avg: avgBreak?.z },
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

  // Cap the live-games drawer so it stretches down to just above the
  // bottom-left pitch panel (closed state included) instead of extending out
  // of the window. Re-measured on resize and whenever the panels around it
  // change size. Measured before paint so there's no flash of an over-tall
  // drawer.
  useLayoutEffect(() => {
    const compute = () => {
      const drawer = drawerRef.current;
      if (!drawer) return;
      // Never let the drawer touch the bottom edge of the window.
      let limitY = window.innerHeight - 20;
      // Stop just above the bottom-left column (pitch panel + WASD hint); its
      // top moves up when the pitch panel expands, so this also keeps the
      // open panel clear of the drawer.
      const bottomLeft = bottomLeftRef.current;
      if (bottomLeft) {
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
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [pitchData, pitchPanelOpen, loading, error, waitingForPitchData, pendingPitchNumber, newLivePlayAvailable]);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* ── TOP-LEFT: control panel + live games drawer ── */}
      <div style={{
        position: 'absolute',
        top: 20,
        left: 20,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 10,
      }}>
      <div style={{
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
            onClick={() => refreshAll()}
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

        {/* ── PLAYBACK SPEED SLIDER ─────────────────────── */}
        <div
          id="playback-speed-slider"
          title="Scales the whole simulation (pitch, swing, and batted ball) together"
          style={{
            width: '100%',
            marginBottom: '10px',
            padding: '6px 8px',
            borderRadius: '4px',
            background: playbackSpeed === 1
              ? 'linear-gradient(90deg, #0e4a4a 0%, #1a8a8a 100%)'
              : 'linear-gradient(90deg, #7a3a00 0%, #ff9933 100%)',
            boxShadow: playbackSpeed === 1 ? '0 0 8px #1a8a8a44' : '0 0 8px #ff993344',
          }}
        >
          <label
            htmlFor="playback-speed-range"
            style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold', fontSize: '11px', letterSpacing: '0.03em', color: 'white' }}
          >
            {playbackSpeed === 1
              ? '⏱ Playback: 1× Real Time'
              : `⏱ Playback: ${Number(playbackSpeed.toFixed(2))}× Slow-Mo`}
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
              setPlaybackSpeed(next);
              setTimeScale(next);
            }}
            style={{ width: '100%', cursor: 'pointer', accentColor: '#22cccc' }}
          />
        </div>

        {loading && !waitingForPitchData && <p>Loading data...</p>}
        {waitingForPitchData && (
          <p
            role="status"
            aria-live="polite"
            style={{ color: '#ffd166', margin: '8px 0 0' }}
          >
            ⏳ Waiting for pitch data
            {pendingPitchNumber != null ? ` (pitch ${pendingPitchNumber})` : '…'}
          </p>
        )}
        {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
      </div>

        {/* ── LIVE GAMES DRAWER ── */}
        <div
          ref={drawerRef}
          style={{
            background: 'rgba(0,0,0,0.75)',
            color: 'white',
            padding: '10px 14px',
            borderRadius: '8px',
            fontFamily: 'monospace',
            fontSize: '11px',
            minWidth: '220px',
            backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.1)',
            maxHeight: drawerMaxHeight ?? 'none',
            overflow: 'hidden',
          }}
        >
          <details>
            <summary ref={summaryRef} style={{ cursor: 'pointer', fontWeight: 'bold', fontSize: '12px', opacity: 0.9, outline: 'none', userSelect: 'none' }}>
              📡 Live Games
            </summary>
            <div ref={gamesListRef} style={{ marginTop: 8, overflowY: 'auto', maxHeight: gamesListMaxHeight ?? 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ opacity: 0.7 }}>{liveGames ? `${liveGames.length} live` : '—'}</span>
                <button
                  onClick={fetchLiveGames}
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
                const inningLabel = g.inning?.ordinal
                  ? `${g.inning.isTop ? 'T' : 'B'} ${g.inning.ordinal}`
                  : (g.status || 'Live');
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
                      <span style={{ opacity: 0.6 }}> @ </span>
                      {g.teams?.home?.abbreviation} {g.teams?.home?.score ?? '—'}
                    </div>
                    <div style={{ opacity: 0.7, marginTop: 2 }}>
                      {inningLabel} · {g.venue}
                    </div>
                  </button>
                );
              })}
            </div>
          </details>
        </div>
      </div>


      {/* ── PLAY OUTCOME BANNER (ball / strike / hit / run / out, shown at the
          top of the screen once each pitch/play resolves). The pill expands
          out sideways when it appears and folds back in when the next pitch
          clears the outcome. ── */}
      <OutcomeBanner label={pitchOutcome} replay={replay} />

      {/* ── WAITING FOR PLAY TO RESOLVE BANNER (contact pitch whose Statcast
          fielding point hasn't arrived yet) ── */}
      {waitingForPlayResolve && (
        <div style={{
          position: 'absolute',
          top: 20,
          left: 0,
          right: 0,
          zIndex: 20,
          textAlign: 'center',
          pointerEvents: 'none',
        }}>
          <span style={{
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
          }}>
            ⏳ Waiting for play to resolve…
          </span>
        </div>
      )}

      {/* ── TOP-RIGHT DRAWERS (debug overlays) ── */}
      <div style={{
        position: 'absolute',
        top: 20,
        right: 20,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 10,
      }}>

        {/* ── DEBUG OVERLAYS DRAWER (collapsible) ── */}
        {(crossings || (pitchData && pitchData.statcast_px != null && pitchData.statcast_pz != null) || battedBallData) && (
        <div style={{
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


      <Scene pitchData={pitchData} battedBall={battedBallData} snapTrigger={snapTrigger} onCrossings={setCrossings} onArrival={handlePitchArrival} onPlayResult={handlePlayResult} onComplete={handlePlayComplete} />
      <Scorebug
        refreshKey={hudRefresh}
        outcomeRefresh={scorebugOutcomeRefresh}
        gamePk={activeGamePk}
        frozen={scoreboardFrozen}
        stateOverride={scorebugStateOverride}
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
          <div style={{
            position: 'relative',
            background: 'linear-gradient(180deg, rgba(10,14,20,0.92), rgba(6,9,14,0.92))',
            color: 'white',
            padding: '10px 14px',
            borderRadius: '10px',
            fontFamily: 'monospace',
            fontSize: '11px',
            minWidth: '280px',
            backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.18)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
          }}>
            {/* A live poll can discover a newer play without interrupting the
                selected replay. The existing Back-to-Live control remains the
                deliberate way to switch to it. */}
            {replay.active && newLivePlayAvailable && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  width: '100%', marginBottom: 8, padding: '5px 8px',
                  boxSizing: 'border-box',
                  background: 'rgba(255,209,102,0.14)',
                  color: '#ffd166',
                  border: '1px solid rgba(255,209,102,0.55)',
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  fontWeight: 'bold',
                  textAlign: 'center',
                }}
              >
                ● New live play available
              </div>
            )}

            {/* Back-to-live control, shown while a historical pitch is being
                replayed so the user can resume the live feed. */}
            {replay.active && (
              <button
                onClick={backToLive}
                title="Resume the live feed"
                style={{
                  width: '100%', marginBottom: 8, padding: '4px 8px',
                  background: '#b33a3a', color: 'white', border: 'none', borderRadius: 4,
                  fontSize: 11, fontFamily: 'monospace', fontWeight: 'bold',
                  cursor: 'pointer',
                }}
              >
                ▶ Back to Live
              </button>
            )}

            {/* Browser-style view tabs sit above the panel: the selected tab
                is flush with the panel and the other tab sits slightly behind
                it instead of cycling through views from one button. */}
            <div style={{
              minHeight: 24,
              display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
              marginBottom: 8, userSelect: 'none',
            }}>
              <span
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
                  { label: 'Pitch', active: !atBatOpen, onClick: selectPitchView, title: 'Show pitch details' },
                  { label: 'At-Bat', active: atBatOpen, onClick: selectAtBatView, title: 'Show every pitch in this at-bat' },
                ].map((tab, index) => (
                  <button
                    key={tab.label}
                    role="tab"
                    aria-selected={tab.active}
                    onClick={tab.onClick}
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
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </span>
              <button
                onClick={() => setPitchPanelOpen((open) => !open)}
                disabled={!toggleUnlocked}
                title={toggleUnlocked
                  ? (pitchPanelOpen ? 'Hide pitch details' : 'Show pitch details')
                  : 'Available once the play has finished'}
                style={{
                  padding: '2px 8px', background: '#333', color: 'white',
                  border: 'none', borderRadius: 4, fontSize: 11, fontFamily: 'monospace',
                  opacity: toggleUnlocked ? 1 : 0.4,
                  cursor: toggleUnlocked ? 'pointer' : 'not-allowed',
                }}
              >
                {pitchPanelOpen ? '▾ Hide' : '▸ Show'}
              </button>
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
                    {atBatLoading && !atBatData && <div style={{ opacity: 0.7, padding: '8px 0' }}>Loading at-bat…</div>}
                    {atBatError && !atBatData && <div style={{ color: '#ff6b6b', padding: '8px 0' }}>{atBatError}</div>}
                    {atBatData && (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 11 }}>
                          <span style={{ opacity: 0.8 }}>{atBatData.batter ?? '—'}</span>
                          <span style={{ opacity: 0.7 }}>{atBatData.pitches?.length ?? 0} pitches</span>
                        </div>
                        {atBatError && <div style={{ color: '#ffb066', fontSize: 10, marginBottom: 4 }}>{atBatError}</div>}
                        <AtBatZone
                          pitches={(atBatData.pitches ?? []).filter((p) => !(p.play_id === pitchData?.play_id && !pitchOutcome))}
                          szTop={atBatData.strike_zone_top ?? pitchData?.strike_zone_top ?? 3.5}
                          szBot={atBatData.strike_zone_bottom ?? pitchData?.strike_zone_bottom ?? 1.5}
                          activePitchNumber={replay.active ? replay.pitchNumber : null}
                          onSelect={selectReplayPitch}
                        />
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 6, fontSize: 10, opacity: 0.85 }}>
                          <span><span style={{ color: '#ff5f5f' }}>●</span> Strike</span>
                          <span><span style={{ color: '#7ee0a0' }}>●</span> Ball</span>
                          <span><span style={{ color: '#ffa64d' }}>●</span> Foul</span>
                          <span><span style={{ color: '#4da6ff' }}>●</span> In play</span>
                          <span><span style={{ color: '#c15cff' }}>●</span> In play · out</span>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 10, opacity: 0.6 }}>
                          Click a pitch to replay it.
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Spinning ball with the spin axis drawn as an arrow */}
                    <SpinAxisViz spinAxis={pitchData.spin_axis} spinRate={pitchData.spin_rate} />

                    {/* Bold velocity + pitch type, below the 3D model */}
                    <div style={{ fontWeight: 'bold', fontSize: '13px', letterSpacing: '0.02em', margin: '6px 0', userSelect: 'none' }}>
                      {pitchData.speed_mph != null ? `${Number(pitchData.speed_mph.toFixed(1))} mph` : '— mph'}
                      {pitchData.pitch_type_description ? ` · ${pitchData.pitch_type_description}` : ''}
                    </div>
                    {/* Horizontal/vertical break, each with how far above/below the
                        pitch-type average this pitch's movement is (▲/▼) */}
                    {breakRows.map(({ label, value, pct }) => (
                      <div key={label} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '3px 0'
                      }}>
                        <span style={{ opacity: 0.7 }}>{label}</span>
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
                  </>
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
