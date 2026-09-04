import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  PLATE_FRONT_Y,
  clamp,
  feetToM,
  getBallXYSpeed,
  getLandingLocation,
  lerp,
  makeSymmetricalArc,
  mphToMetersPerSecond,
  plateCrossing,
  resolveFieldedIntercept,
  statcastHitToWorld,
} from '../util/MathUtil'
import { isHitFieldingReady, hitMatchesAtBat, isBattedBallLaunchable, shouldAutoAdvanceStuckPlay, getBaseTargetLocation, resolveFielderCamTarget } from '../util/battedBall'
import { FIELD } from '../constants/field'
import { setCycleDuration, getCycleDuration, getTimeScale, getCyclePause, getBallReleaseTime, setBattedBallPosition, setChaserPosition, setPlayBallPosition, setFielderCamLookTarget, getFielderCamActive, stepSimulation, getSimulationTime } from '../constants/playback'
import { getTuning, useTuning } from '../constants/tuning'
import { ConfettiBurst } from './ConfettiBurst'

// ---------------------------------------------------------------------------
// Batted-ball + fielder choreography, ported from
// solomon-gumball:baseball-sim-main (kept as a read-only reference):
//   - makeSymmetricalArc / findIntersection / getBallXYSpeed -> ball flight and
//     the fielder-intercept math.
//   - The fielder who fields the ball ALWAYS SPRINTS from their standard
//     defensive spot (FIELD.DEFENSE) to where the ball is fielded — they never
//     just appear at the fielding point.
//   - Force-outs / double plays (ported from LiveGameView):
//       * fielders with an f_putout credit run to the out base while the ball
//         is in flight (defensive positioning for the force),
//       * the chaser either runs the ball to a base (unassisted putout) or
//         throws it through the assist chain (f_assist -> f_putout), and
//       * "OUT" / "DOUBLE PLAY" / "TRIPLE PLAY" text is emitted as each out is
//         recorded.
//
// The full defensive alignment (all nine fielders) is rendered at its spots;
// the chaser and any putout fielders move. The batted ball launches from the
// spot the pitch ball is at when it reaches the front of home plate (the
// moment the batter's swing connects), timed to the same real-time playback
// cycle the Pitch and Batter components share (see constants/playback.js). When
// no live Statcast hit is present it cycles through a few sample hits so the
// trajectory types stay visible: a fly ball (caught), a line drive (fielder
// chases the roll), and a grounder.
// ---------------------------------------------------------------------------

const SAMPLE_HITS = [
  { label: 'Fly ball to center', launchSpeed: 100, launchAngle: 30, sprayAngle: 0, totalDistance: 360, fielder: 'CF', wasCaught: true },
  { label: 'Line drive to right', launchSpeed: 95, launchAngle: 14, sprayAngle: 25, totalDistance: 280, fielder: 'RF', wasCaught: false },
  { label: 'Grounder to short', launchSpeed: 85, launchAngle: 4, sprayAngle: -15, totalDistance: 120, fielder: 'SS', wasCaught: false },
]

// Foul balls (call 'F'/'L') are contact that the MLB live feed never attaches
// Statcast hitData to, so a foul would otherwise leave the batted ball hidden
// (or hand off to a stale hit from an earlier at-bat). Synthesize a short
// pop-up into foul territory — pulled to the batter's pull side — so the
// contact still reads as a batted ball leaving the bat. ``wasCaught`` stays
// false and there are no runners, so no OUT is emitted and the FOUL outcome
// shown at plate arrival is preserved.
function makeFoulHit(pitchData) {
  const pullSide = pitchData?.bat_side === 'L' ? 1 : -1
  return {
    label: 'Foul ball',
    launchSpeed: 82,
    launchAngle: 42,
    sprayAngle: pullSide * 55,
    totalDistance: 150,
    fielder: 'C',
    wasCaught: false,
    eventType: 'foul',
    runners: [],
    coordX: null,
    coordY: null,
  }
}

// Throw speed for the assist chain, matching solomon-gumball's 70 mph.

// Outfield wall radius (matches Ballpark.jsx): the circle a home run clears in
// the air, and where the confetti burst fires as the ball leaves the park.
const WALL_RADIUS = feetToM(330)

// Batted-ball trail + yellow trace: the same look as the pitch's — a constant
// yellowish-white tail that fades out behind the ball over a persistent thin
// yellow trace — but WITHOUT the billow particles. All timing/opacity/size
// constants match the pitch's trail so the two read identically.
// The batted ball carries far more instances than the pitch (16384 vs 2048):
// its flights are many times longer than a pitch's, so the full capacity is
// spread across the whole arc — enough that the trail stays a continuous
// path rather than a dotted line even on fast, long hits.
const TRAIL_MAX_PARTICLES = 16384
// The trace is slightly thicker and more opaque than the pitch's white trace
// (0.018 / 0.16) so the yellow path stays legible from the broadcast
// distance.
// Persistent dim-yellow trace under the tail. Kept clearly dimmer than the
// golden 100 mph elite-fastball ring so the two read as distinct.
const YELLOW_TRACE_COLOR = [0.7, 0.6, 0.16]
// Constant yellowish-white tail (the pitch's slow-speed trail color): the
// batted ball's tail is always this color, never speed-graded.
const TRAIL_COLOR_YELLOWISH_WHITE = [1, 0.95, 0.65]

// Tunneling comparison: batted balls dim more than the overlaid pitches so the
// trajectories stay distinguishable, and their tail/trace fade back too.

const TRAIL_VERTEX_SHADER = `
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;

void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`

const TRAIL_FRAGMENT_SHADER = `
varying vec3 vColor;
varying float vAlpha;

void main() {
    gl_FragColor = vec4(vColor, vAlpha);
}
`

function createTrailGeometry(makeBaseGeometry) {
    const geometry = makeBaseGeometry()
    const colorAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(TRAIL_MAX_PARTICLES * 3), 3,
    )
    colorAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('aColor', colorAttr)
    const alphaAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(TRAIL_MAX_PARTICLES), 1,
    )
    alphaAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('aAlpha', alphaAttr)
    return geometry
}

function createTrailMaterial() {
    return new THREE.ShaderMaterial({
        vertexShader: TRAIL_VERTEX_SHADER,
        fragmentShader: TRAIL_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
    })
}

// Distance-compensated shader for the persistent yellow trace: a thin ribbon
// reads hot up close and washes out at distance, so its alpha is scaled by
// each particle's distance from the camera — dimmed hard near the camera
// (TRACE_NEAR_FACTOR within ~9 m) ramping to full strength far away
// (TRACE_FAR_FACTOR beyond ~108 m) — keeping the traced path consistent on
// screen at any viewing distance.
const TRACE_REF_DISTANCE = 60 // m — alpha factor hits 1.0 at this distance
const TRACE_NEAR_FACTOR = 0.15 // multiplier at/under ~9 m from the camera
const TRACE_FAR_FACTOR = 1.8 // multiplier at/over ~108 m

const TRACE_VERTEX_SHADER = `
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
varying float vDistance;

void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vDistance = length(mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
}
`

const TRACE_FRAGMENT_SHADER = `
varying vec3 vColor;
varying float vAlpha;
varying float vDistance;

void main() {
    float distanceFactor = clamp(vDistance / ${TRACE_REF_DISTANCE}.0, ${TRACE_NEAR_FACTOR}, ${TRACE_FAR_FACTOR});
    gl_FragColor = vec4(vColor, vAlpha * distanceFactor);
}
`

function createTraceMaterial() {
    return new THREE.ShaderMaterial({
        vertexShader: TRACE_VERTEX_SHADER,
        fragmentShader: TRACE_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
    })
}

// Defense-side spot for a base, mirroring solomon-gumball's
// getLocationForBaseCode(code, 'defense') — this app's FIELD.BASE already
// carries the negated X/Z handedness, so the base locations are used directly.
function getDefenseBaseLocation(baseKey) {
  switch (baseKey) {
    case '1B': return FIELD.BASE.FIRST.clone()
    case '2B': return FIELD.BASE.SECOND.clone()
    case '3B': return FIELD.BASE.THIRD.clone()
    case 'score':
    case 'home': return FIELD.BASE.HOME.clone().add(new THREE.Vector3(-0.5, 0, 0.5))
    default: return FIELD.BASE.HOME.clone()
  }
}

// Where the batted-ball's ground path first crosses the outfield wall circle
// (radius WALL_RADIUS around home plate). Returns the parametric distance s in
// [0, 1] along launch -> landing, or null if the ball stays inside the wall.
function findWallExit(launch, landing) {
  const dx = landing.x - launch.x
  const dz = landing.z - launch.z
  const a = dx * dx + dz * dz
  if (a < 1e-9) return null
  const b = 2 * (launch.x * dx + launch.z * dz)
  const c = launch.x * launch.x + launch.z * launch.z - WALL_RADIUS * WALL_RADIUS
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const root = Math.sqrt(disc)
  const s1 = (-b - root) / (2 * a)
  const s2 = (-b + root) / (2 * a)
  if (s1 >= 0 && s1 <= 1) return s1
  if (s2 >= 0 && s2 <= 1) return s2
  return null
}

// Evaluate a piecewise-linear motion schedule (list of {from, to, start,
// duration}) at wall-clock time t. Before a segment starts the fielder holds at
// that segment's ``from``; during it they lerp ``from`` -> ``to``; after the
// last segment they hold at its ``to``.
function evalSegments(segments, t) {
  if (!segments || segments.length === 0) return null
  for (const seg of segments) {
    if (t < seg.start) return seg.from.clone()
    if (t < seg.start + seg.duration) {
      const p = clamp((t - seg.start) / seg.duration, 0, 1)
      return seg.from.clone().lerp(seg.to, p)
    }
  }
  return segments[segments.length - 1].to.clone()
}

function buildPlan(hit, launchPoint, settings = getTuning().battedBall) {
  const maxRunSpeed = mphToMetersPerSecond(settings.maxRunSpeedMph)
  const throwSpeed = mphToMetersPerSecond(settings.throwSpeedMph)
  const launch = launchPoint.clone()

  // Prefer the raw Statcast hit coordinates when present; fall back to the
  // total-distance + spray-angle reconstruction for the bundled demo samples.
  const landing = (hit.coordX != null && hit.coordY != null)
    ? statcastHitToWorld(hit.coordX, hit.coordY)
    : getLandingLocation(hit.totalDistance, hit.sprayAngle)

  const speed = mphToMetersPerSecond(hit.launchSpeed)

  // Batted-ball trajectory (matches solomon-gumball's makeSymmetricalArc call
  // convention: x0, y0=horizontal Z, z0=height -> xf, yf=horizontal Z, zf=0).
  const arc = makeSymmetricalArc(
    launch.x, launch.z, launch.y,
    landing.x, landing.z, 0,
    speed, hit.launchAngle,
  )
  const ballAirTime = arc.totalDuration()

  // For a home run, find where the ball's ground path crosses the outfield
  // wall so the confetti can burst there (the ball leaves the park in the air).
  let wallExit = null
  if (hit.eventType === 'home_run') {
    const s = findWallExit(launch, landing)
    if (s != null) {
      const exitTime = s * ballAirTime
      wallExit = { position: arc.positionAtTime(exitTime), time: exitTime }
    }
  }

  const flatLaunch = new THREE.Vector3(launch.x, 0, launch.z)
  const flatLanding = new THREE.Vector3(landing.x, 0, landing.z)
  const ballDir = flatLanding.clone().sub(flatLaunch).normalize()

  // The fielder who fields this ball ALWAYS starts at their standard defensive
  // spot and sprints to the fielding point (ported from solomon-gumball, which
  // runs the catching player from FIELD_LOCATION.DEFENSE[abbr]).
  const chaser = hit.fielder || 'CF'
  const chaserHome = FIELD.DEFENSE[chaser] ?? FIELD.DEFENSE.CF

  // Fielder trajectory: only fielded (not caught) balls are intercepted,
  // mirroring solomon-gumball's LiveGameView. The ball flies to its arc
  // landing at its horizontal (exit) speed, then ROLLS on the ground at
  // ``groundRollSpeedMph`` (0 = auto = the exit speed, i.e. the historical
  // timing). Re-solving the interception with the tuned roll speed keeps the
  // catch point AND the fielder's sprint consistent with however fast the user
  // makes the ball roll, so ball and fielder still arrive together.
  const airXY = getBallXYSpeed(speed, hit.launchAngle)
  const rollXY = settings.groundRollSpeedMph
    ? mphToMetersPerSecond(settings.groundRollSpeedMph)
    : airXY
  const contactDistance = flatLaunch.distanceTo(flatLanding)
  const intersection = hit.wasCaught
    ? undefined
    : resolveFieldedIntercept(
        flatLaunch,
        ballDir,
        airXY,
        rollXY,
        ballAirTime,
        contactDistance,
        chaserHome,
        maxRunSpeed,
      )

  const ballCatch = intersection ?? { location: flatLanding, t: ballAirTime }
  const catchLocation = ballCatch.location
  const timeUntilChaserReaches = chaserHome
    ? Math.min(ballCatch.t, catchLocation.distanceTo(chaserHome) / maxRunSpeed)
    : ballCatch.t

  // ── Force-out / double-play choreography (ported from solomon-gumball) ──
  // Parse the runners' movement + credits into:
  //   chaserSegments — the chaser's piecewise run (home -> fielding point,
  //                    then -> out base for an unassisted putout)
  //   putoutMoves    — fielders with f_putout run to the out base in flight
  //   throws         — the assist chain (ball thrown fielder -> fielder)
  //   outs           — { time, text } when each out is recorded
  const chaserSegments = [{
    from: chaserHome.clone(),
    to: catchLocation.clone(),
    start: 0,
    duration: Math.max(timeUntilChaserReaches, 0.001),
  }]
  const putoutMoves = []
  const outs = []
  let chaserPutoutBase = null

  const runners = hit.runners || []
  for (const runner of runners) {
    const outBase = runner.outBase
    if (!outBase) continue
    for (const credit of runner.credits || []) {
      if (credit.credit !== 'f_putout') continue
      const fielder = credit.position
      if (fielder === chaser) {
        chaserPutoutBase = outBase
      } else {
        const from = FIELD.DEFENSE[fielder]
        const to = getDefenseBaseLocation(outBase)
        if (from && to) {
          putoutMoves.push({
            fielder,
            from: from.clone(),
            to,
            duration: Math.max(Math.min(to.distanceTo(from) / maxRunSpeed, ballCatch.t), 0.001),
          })
        }
      }
    }
  }

  // Ordered assist/putout/fielded chain (deduped), starting from the chaser —
  // the sequence the ball travels through on a force-out / double play.
  const seen = new Set([chaser])
  const chainPositions = [chaser]
  for (const runner of runners) {
    for (const credit of runner.credits || []) {
      if (['f_assist', 'f_putout', 'f_fielded_ball'].includes(credit.credit)) {
        const pos = credit.position
        if (pos && !seen.has(pos)) {
          seen.add(pos)
          chainPositions.push(pos)
        }
      }
    }
  }

  // Chain positions that record a putout (for the OUT / DOUBLE PLAY text).
  const putoutPositions = new Set()
  for (const runner of runners) {
    if (!runner.outBase) continue
    for (const credit of runner.credits || []) {
      if (credit.credit === 'f_putout' && credit.position !== chaser) putoutPositions.add(credit.position)
    }
  }

  const throws = [] // { fromPos, toPos, arc, isPutout, start, duration }
  const positionOf = (pos) => {
    const move = putoutMoves.find((m) => m.fielder === pos)
    if (move) return move.to.clone()
    return (FIELD.DEFENSE[pos] ?? FIELD.DEFENSE.CF).clone()
  }

  let outCount = 0
  const recordOut = (time) => {
    outCount += 1
    outs.push({ time, text: outCount === 1 ? 'OUT' : outCount === 2 ? 'DOUBLE PLAY' : 'TRIPLE PLAY' })
  }

  let endTime = ballCatch.t

  if (hit.wasCaught) {
    // Caught in the air: the out is recorded the moment the ball is caught.
    recordOut(ballCatch.t)
  } else if (chaserPutoutBase) {
    // Unassisted putout: the chaser runs the ball from the fielding point to
    // the base (solomon-gumball's "run catching player to base").
    const to = getDefenseBaseLocation(chaserPutoutBase)
    const duration = Math.max(catchLocation.distanceTo(to) / maxRunSpeed, 0.3)
    chaserSegments.push({ from: catchLocation.clone(), to, start: ballCatch.t, duration })
    endTime = ballCatch.t + duration
    recordOut(endTime)
  } else {
    // Assist chain: throw through the fielders, recording an out at each putout
    // receiver (solomon-gumball's while-loop assist sequence).
    let t = ballCatch.t
    for (let i = 0; i < chainPositions.length - 1; i++) {
      const fromPos = positionOf(chainPositions[i])
      const toPos = positionOf(chainPositions[i + 1])
      // The first throw leaves the chaser's glove at the fielding point.
      if (i === 0) fromPos.copy(catchLocation)

      // Throw from glove height to glove height; shorter throws are flatter
      // (solomon-gumball lerps 0°..20° over the first 400 ft).
      const handHeight = 1.5
      const throwOrigin = new THREE.Vector3(fromPos.x, handHeight, fromPos.z)
      const throwDest = new THREE.Vector3(toPos.x, handHeight, toPos.z)
      const throwAngle = lerp(0, 20, clamp(fromPos.distanceTo(toPos) / feetToM(400), 0, 1))
      const throwArc = makeSymmetricalArc(
        throwOrigin.x, throwOrigin.z, throwOrigin.y,
        throwDest.x, throwDest.z, throwDest.y,
        throwSpeed, throwAngle,
      )
      const duration = throwArc.totalDuration()
      throws.push({
        fromPos: fromPos.clone(),
        toPos: toPos.clone(),
        arc: throwArc,
        isPutout: putoutPositions.has(chainPositions[i + 1]),
        start: t,
        duration,
      })
      if (putoutPositions.has(chainPositions[i + 1])) recordOut(t + duration)
      t += duration
    }
    if (throws.length) endTime = throws[throws.length - 1].start + throws[throws.length - 1].duration
  }

  // For non-out base hits, surface the hit type once the play settles
  // (solomon-gumball's end-of-play SINGLE / DOUBLE / TRIPLE text).
  let resultText = null
  if (outs.length === 0) {
    const endBase = runners[0]?.end
    if (endBase === '1B') resultText = 'SINGLE'
    else if (endBase === '2B') resultText = 'DOUBLE'
    else if (endBase === '3B') resultText = 'TRIPLE'
    else if (hit.eventType === 'home_run') resultText = 'HOME RUN'
  }

  const stepOnBagTarget = chaserPutoutBase
    ? getBaseTargetLocation(chaserPutoutBase)
    : (chaserSegments.length > 1
      ? getBaseTargetLocation(null, chaserSegments[chaserSegments.length - 1].to)
      : null)

  return {
    arc, ballAirTime, ballCatch, catchLocation, timeUntilChaserReaches,
    chaser, chaserHome, landing, wallExit,
    // Real-ground-path roll inputs (see the frame loop): the ball's ground
    // position after it touches the plane is ``flatLaunch + ballDir * d`` with
    // ``d = contactDistance + rollSpeedXY * (t - ballAirTime)``. When the roll
    // knob is 0, rollSpeedXY === airXY and this reduces to the arc's own x/z.
    flatLaunch, ballDir, rollSpeedXY: rollXY, contactDistance,
    chaserSegments, putoutMoves, throws, outs, resultText, endTime,
    chaserPutoutBase, stepOnBagTarget,
    // Where the ball ends up at the end of the play (glove of the final
    // receiver, the chaser at the base, or the catch point).
    finalBallPos: throws.length
      ? throws[throws.length - 1].toPos
      : chaserSegments.length > 1
        ? chaserSegments[chaserSegments.length - 1].to
        : catchLocation,
  }
}

// A fielder sprite (body + head). ``ref`` lets the frame loop move it; the
// inner ``leanRef`` group tilts forward while the fielder is sprinting.
// ``opacity`` makes the fielder translucent (used by the fielder camera
// replay so the body doesn't block the view from head-height).
const Fielder = React.forwardRef(({ position, leanRef, opacity = 1 }, ref) => {
  const bodyMatRef = useRef(null);
  const headMatRef = useRef(null);

  // Directly set material properties when opacity changes — R3F's declarative
  // props may not update the Three.js material in all edge cases.
  useEffect(() => {
    const materials = [bodyMatRef.current, headMatRef.current].filter(Boolean);
    materials.forEach((m) => {
      m.transparent = opacity < 1;
      m.opacity = opacity;
      m.depthWrite = opacity >= 1;
      m.needsUpdate = true;
    });
  }, [opacity]);

  return (
    <group ref={ref} position={position}>
      <group ref={leanRef}>
        <mesh position={[0, 0.9, 0]} castShadow>
          <capsuleGeometry args={[0.35, 1.1, 4, 8]} />
          <meshStandardMaterial ref={bodyMatRef} color="#e63946" roughness={0.8} transparent={opacity < 1} opacity={opacity} depthWrite={opacity >= 1} />
        </mesh>
        <mesh position={[0, 1.75, 0]}>
          <sphereGeometry args={[0.24, 12, 12]} />
          <meshStandardMaterial ref={headMatRef} color="#f1c27d" roughness={0.8} transparent={opacity < 1} opacity={opacity} depthWrite={opacity >= 1} />
        </mesh>
      </group>
    </group>
  );
});
Fielder.displayName = 'Fielder'

export const BattedBall = ({ pitchData, replayKey = 0, hit = null, hits = SAMPLE_HITS, onPlayResult, onComplete, comparison = false }) => {
  const tuning = useTuning()
  const battedTuning = tuning.battedBall
  const playbackTuning = tuning.playback
  const [hitIndex, setHitIndex] = useState(0)
  // One-shot confetti burst for home runs (set when the ball clears the wall).
  const [confetti, setConfetti] = useState(null)
  // Translucent fielder bodies during fielder cam replay so the head-height
  // camera isn't blocked.
  const [fielderOpacity, setFielderOpacity] = useState(1)
  const battedGroupRef = useRef()
  const ballRef = useRef()
  // Position-code -> { group, lean } refs for the fielders that can move.
  const fielderRefs = useRef({})
  // Flight clock starting from 0 the moment the ball is launched at contact.
  const flightClock = useRef(0)
  const firedThisCycle = useRef(false)
  const launched = useRef(false)
  const recordedOuts = useRef(0)
  const resultEmitted = useRef(false)
  const completeEmitted = useRef(false)
  // Wall-clock deadline (performance.now + timeout) at which a contacted pitch
  // that still hasn't launched its batted ball is force-completed, so a play
  // whose Statcast hit never arrives can't wedge the live queue. Set once the
  // pitch reaches the plate, cleared on launch / new pitch. Deliberately a long
  // timeout: the hit normally lands a poll or two after contact, so this never
  // fires early — it only rescues a genuinely missing hit.
  const noLaunchDeadlineRef = useRef(null)
  // Fielding-choreography restart: true from the moment the pitcher starts his
  // windup (when the fielders snap back to their defensive spots) through the
  // cycle wrap, so the chaser/putout blocks stay parked and the fielder cam
  // re-acquires the ready alignment instead of riding the reset. Cleared when
  // the batted ball launches (each play re-runs the choreography) and on a new
  // pitch.
  const fieldersReset = useRef(false)
  // Home-run confetti: fires once per cycle at the wall-crossing spot.
  const confettiFiredRef = useRef(false)
  // Pitch object that owned the current cycle duration. A live hit can arrive
  // after its pitch has already started animating; when that happens we only
  // *lengthen* the shared cycle, never shorten it, so the pitch/batter/pitcher
  // clocks (which all read getCycleDuration() every frame) don't wrap early.
  const durationOwnerPitch = useRef(null)

  // A foul (call 'F' or 'L') is contact that the feed never gives Statcast hit
  // data for, so it synthesizes its own batted-ball flight instead of waiting
  // for a matching live hit that will never arrive.
  const isFoul = pitchData?.call_code === 'F' || pitchData?.call_code === 'L'

  // The live hit must belong to the same at-bat as the current pitch. The feed
  // marks the pitch "in play" (is_contact) before the hit's Statcast data
  // lands — they arrive on separate events, so a fresh contact can show up a
  // poll or two before /api/batted-ball returns it. Hold the launch until the
  // matching hit is present instead of firing the previous hit (or a demo
  // sample) for a brand-new live contact.
  const liveHitReady = hitMatchesAtBat(hit, pitchData?.at_bat_index)

  // A live Statcast hit (from /api/batted-ball) takes precedence; otherwise
  // cycle through the bundled demo samples. A foul with no matching live hit
  // uses the synthesized foul flight instead of a stale hit or demo sample.
  const foulHit = useMemo(
    () => (isFoul ? makeFoulHit(pitchData) : null),
    [isFoul, pitchData],
  )
  // Only a hit with its Statcast fielding point is safe to animate. A live
  // hit that has landed but lacks hc_x/hc_y falls back to the demo sample so
  // the shared playback clock keeps advancing while we wait for the real
  // fielding point (never the half-populated hit, whose arc would be garbage).
  const launchableHit = liveHitReady && isHitFieldingReady(hit)
  const launchable = isBattedBallLaunchable({ hit, atBatIndex: pitchData?.at_bat_index, isFoul })
  const activeHit = (isFoul && !liveHitReady && foulHit)
    ? foulHit
    : (launchableHit ? hit : hits[hitIndex])

  // Contact geometry from the pitch trajectory: the moment the ball reaches the
  // front of home plate and where it is then — the spot the bat meets it.
  const contact = useMemo(() => {
    const traj = pitchData?.trajectory
    if (!traj || traj.length === 0) return null
    const crossing = plateCrossing(traj)
    return {
      time: crossing.time,
      simDuration: traj[traj.length - 1]?.t ?? crossing.time,
      launch: new THREE.Vector3(crossing.x, crossing.height, -PLATE_FRONT_Y),
      // Only hand off to a batted ball when the bat actually met the ball
      // (in play or foul). A swing-and-miss is still a swing for the batter
      // animation, but must NOT spawn the demo-hit fallback.
      swing: pitchData?.is_contact != null ? !!pitchData.is_contact : !!pitchData?.swing,
    }
  }, [pitchData])

  const plan = useMemo(() => {
    if (!contact) return null
    return buildPlan(activeHit, contact.launch, battedTuning)
  }, [activeHit, contact, battedTuning])

  // Tail + yellow trace (same animation as the pitch, no billow particles).
  const tailMeshRef = useRef()
  const traceMeshRef = useRef()
  const trailGeometry = useMemo(() => createTrailGeometry(() => new THREE.BoxGeometry(1, 1, 1)), [])
  const traceGeometry = useMemo(() => createTrailGeometry(() => new THREE.SphereGeometry(0.5, 12, 8)), [])
  const trailMaterial = useMemo(() => createTrailMaterial(), [])
  // The persistent yellow trace uses the distance-compensated shader so its
  // opacity stays consistent on screen at any camera distance.
  const traceMaterial = useMemo(() => createTraceMaterial(), [])

  // Sample the batted-ball arc into trail particles (position + flight time).
  // The step spreads the whole flight across the fixed instanced capacity, so
  // the tail reads as the same dense continuous trajectory the pitch leaves
  // instead of a dotted line (batted-ball flights are far longer than pitch
  // flights, so the pitch's 0.00035 s step can't be reused directly — the
  // much larger capacity above keeps the spacing comparable).
  const trailPoints = useMemo(() => {
    if (!plan) return []
    const pts = []
    const step = plan.ballAirTime / TRAIL_MAX_PARTICLES
    for (let t = 0; t <= plan.ballAirTime; t += step) {
      if (pts.length >= TRAIL_MAX_PARTICLES) break
      const pos = plan.arc.positionAtTime(t)
      if (pos.y < 0) break
      pts.push({ pos: pos.clone(), t })
    }
    return pts
  }, [plan])

  // Write each particle's transform + color once per hit. Alphas stay 0 until
  // the frame loop reveals them as the ball flies past (same as the pitch).
  React.useLayoutEffect(() => {
    if (!plan || trailPoints.length === 0) return
    const dummy = new THREE.Object3D()
    // kind: 'tail' (yellowish-white, fades) | 'yellow' (persistent trace).
    const writeLayer = (mesh, colorAttr, alphaAttr, kind) => {
      if (!mesh) return
      const colors = colorAttr.array
      const alphas = alphaAttr.array
      const isTrace = kind === 'yellow'
      const color = isTrace ? YELLOW_TRACE_COLOR : TRAIL_COLOR_YELLOWISH_WHITE
      for (let i = 0; i < TRAIL_MAX_PARTICLES; i++) {
        if (i < trailPoints.length) {
          const p = trailPoints[i]
          dummy.position.copy(p.pos)
          dummy.scale.setScalar(isTrace
            ? battedTuning.traceScale
            : (i === 0 ? battedTuning.trailLeadScale : battedTuning.trailParticleScale))
          dummy.rotation.set(0, 0, 0)
          dummy.updateMatrix()
          mesh.setMatrixAt(i, dummy.matrix)
          // Constant color per layer (matching the pitch's constant tail
          // color): yellow trace, yellowish-white tail.
          colors[i * 3] = color[0]
          colors[i * 3 + 1] = color[1]
          colors[i * 3 + 2] = color[2]
        }
        alphas[i] = 0
      }
      mesh.instanceMatrix.needsUpdate = true
      colorAttr.needsUpdate = true
      alphaAttr.needsUpdate = true
      mesh.count = trailPoints.length
    }
    writeLayer(tailMeshRef.current, trailGeometry.getAttribute('aColor'), trailGeometry.getAttribute('aAlpha'), 'tail')
    writeLayer(traceMeshRef.current, traceGeometry.getAttribute('aColor'), traceGeometry.getAttribute('aAlpha'), 'yellow')
  }, [trailPoints, plan, trailGeometry, traceGeometry, battedTuning])

  // The shared cycle spans the real-time pitch flight, then the full play
  // (batted-ball flight, chaser run, throw chain), then a pause, then the
  // pitcher's windup, so the windup (which ends with the release at the wrap)
  // only starts AFTER the play has fully resolved — never overlapping the
  // batted-ball/fielding animation. getBallReleaseTime() is appended at the end
  // of the cycle for exactly that reason. Kept out of the render phase so a
  // late-arriving live hit can update the duration without resetting any of the
  // shared clocks (see durationOwnerPitch above). A shorter duration is only
  // allowed for a new pitch or right at the cycle wrap, when the clocks are
  // already back at ~0 — never mid-flight.
  useEffect(() => {
    if (!contact) return
    if (comparison && !launchable) return
    // Comparison flies only until the ball hits the ground; no fielding.
    const isContactPitch = contact.swing && launchable
    const playEnd = isContactPitch && plan ? (comparison ? plan.ballAirTime : plan.endTime) : 0
    const duration = contact.simDuration + playEnd + getCyclePause() + getBallReleaseTime()
      + (comparison && isContactPitch ? (playbackTuning.comparisonFinishPause ?? 0) : 0)
    const isNewPitch = durationOwnerPitch.current !== pitchData
    const justWrapped = getSimulationTime() < 0.05
    // In comparison many hits share one cycle: only ever lengthen it (skip the
    // isNewPitch / justWrapped resets), so the longest flight wins regardless
    // of mount order.
    const shouldSet = comparison
      ? duration > getCycleDuration()
      : (isNewPitch || justWrapped || duration > getCycleDuration())
    if (shouldSet) setCycleDuration(duration)
    durationOwnerPitch.current = pitchData
  }, [
    contact,
    plan,
    pitchData,
    comparison,
    launchable,
    playbackTuning.cyclePause,
    playbackTuning.ballReleaseTime,
    playbackTuning.comparisonFinishPause,
  ])

  // Register a fielder's group/lean refs by position code. Both callbacks
  // create the entry independently so their invocation order doesn't matter.
  const registerFielder = useCallback((pos) => (ref) => {
    const entry = fielderRefs.current[pos] || (fielderRefs.current[pos] = {})
    entry.group = ref
  }, [])
  const registerLean = useCallback((pos) => (ref) => {
    const entry = fielderRefs.current[pos] || (fielderRefs.current[pos] = {})
    entry.lean = ref
  }, [])

  // Restart the shared playback clock only when a new pitch arrives, keeping
  // the launch in phase with the Pitch and Batter components. Deliberately NOT
  // keyed on ``hit`` (or ``activeHit``): a live hit usually arrives a poll
  // later than its pitch, and resetting the clock then would decouple the
  // batted ball from the pitch reaching the plate. The demo hit index likewise
  // changes mid-cycle (at the cycle wrap) without resetting the shared clock.
  //
  // useLayoutEffect (not useEffect): runs synchronously after render, before
  // the next useFrame. A non-contact pitch (ball / take / whiff) must have its
  // refs cleared before the cycle wraps, otherwise a stale launched=true from
  // the previous contact pitch survives one frame and leaks into the new
  // pitch's first frame (re-firing the launch gate / leaving the batted ball
  // visible).
  useLayoutEffect(() => {
    firedThisCycle.current = false
    launched.current = false
    flightClock.current = 0
    recordedOuts.current = 0
    resultEmitted.current = false
    completeEmitted.current = false
    confettiFiredRef.current = false
    fieldersReset.current = false
    setConfetti(null)
    setBattedBallPosition(null)
    setChaserPosition(null)
    setPlayBallPosition(null)
    setFielderCamLookTarget(null)
    noLaunchDeadlineRef.current = null
  }, [pitchData, replayKey])

  // Clear the shared batted-ball position when this component unmounts (e.g.
  // entering/exiting comparison mode, where the whole live branch is swapped
  // out). Between normal pitches the same instance stays mounted and keeps
  // publishing null while the ball isn't airborne — but an unmount leaves the
  // last published position lingering in the module global, which would make
  // the follow camera lock onto a vanished ball and capture a wrong "original"
  // view for the first animation after returning to live.
  useEffect(() => {
    return () => { setBattedBallPosition(null); setChaserPosition(null); setPlayBallPosition(null); setFielderCamLookTarget(null); }
  }, [])

  useFrame((state, delta) => {
    // Sync fielder opacity from the module-level fielder-cam flag so the
    // chaser re-renders translucent during the replay.
    const camActive = getFielderCamActive()
    if ((camActive ? 0 : 1) !== fielderOpacity) setFielderOpacity(camActive ? 0 : 1)

    const { time: currentPlayback, wrapped } = stepSimulation(delta, state.clock.elapsedTime)

    if (!battedGroupRef.current || !ballRef.current) return
    if (!contact || !plan) {
      battedGroupRef.current.visible = false
      setBattedBallPosition(null)
      return
    }

    const traj = pitchData?.trajectory
    const simDuration = traj?.[traj.length - 1]?.t
    if (!(simDuration > 0)) {
      battedGroupRef.current.visible = false
      setBattedBallPosition(null)
      setChaserPosition(null)
      return
    }

    // Both the shared cycle clock and the batted ball's own flight clock scale
    // with the same time scale as the pitch and batter, so the launch moment
    // and the whole play stay in sync at any playback speed.
    const speed = getTimeScale()
    const loopDuration = getCycleDuration()
    const contactWallTime = contact.time
    // The instant the pitcher begins his windup (the shared cycle's windup
    // window ends with the release at the wrap — the same timing Pitcher.jsx
    // and the trail fade use).
    const windupStart = Math.max(contactWallTime, loopDuration - getBallReleaseTime())

    // The cycle wrapped (all three components' clocks wrap at the same
    // getCycleDuration(), so Pitch and Batter reset in lockstep here too).
    // Reset the batted ball to its pre-launch state and, in demo mode, advance
    // to the next sample hit so the *next* cycle plays it — never mid-cycle.
    // (The fielders themselves were already returned to their defensive spots
    // at the windup start — see the restart below — so the wrap no longer
    // cuts them back while the camera may be locked onto the chaser.)
    if (wrapped) {
      launched.current = false
      flightClock.current = 0
      confettiFiredRef.current = false
      setBattedBallPosition(null)
      setChaserPosition(null)
      setPlayBallPosition(null)
      setFielderCamLookTarget(null)
      if (!hit) setHitIndex((i) => (i + 1) % hits.length)
    }

    // Fielding-choreography restart: the moment the pitcher starts his windup
    // — before the next pitch cycle — drop the fielder-cam publications and
    // snap any fielders that ran during the play back onto their defensive
    // spots (position AND facing, i.e. a complete restart), so the fielder cam
    // re-acquires the ready alignment instead of teleporting with the fielder
    // when the choreography resets. They stay parked through the windup;
    // launching the batted ball (including a late-arriving live hit, which
    // lengthens the cycle and moves windupStart later) clears the park and
    // re-arms this restart for the new windup.
    if (currentPlayback >= windupStart && !fieldersReset.current && launched.current) {
      fieldersReset.current = true
      setChaserPosition(null)
      setPlayBallPosition(null)
      setBattedBallPosition(null)
      setFielderCamLookTarget(null)
      const chaserRefs = fielderRefs.current[plan.chaser]
      if (chaserRefs?.group) {
        chaserRefs.group.position.copy(plan.chaserHome)
        chaserRefs.group.rotation.set(0, 0, 0)
      }
      if (chaserRefs?.lean) chaserRefs.lean.rotation.x = 0
      for (const move of plan.putoutMoves) {
        const refs = fielderRefs.current[move.fielder]
        if (refs?.group) {
          refs.group.position.copy(move.from)
          refs.group.rotation.set(0, 0, 0)
        }
        if (refs?.lean) refs.lean.rotation.x = 0
      }
    }

    // Fire the batted ball the moment the pitch reaches the contact spot. The
    // flag resets once the cycle wraps back before the contact moment, so each
    // pitch that reaches the plate AND was actually contacted re-launches the
    // hit (a swing-and-miss leaves the ball flying through the zone).
    if (currentPlayback < contactWallTime) {
      firedThisCycle.current = false
    }
    // Launch only once the matching live hit's fielding point is ready: a real
    // contact must never hand off to the previous play's hit, a demo sample, or
    // a half-populated hit whose arc would be wrong. The fielding point can
    // arrive after contact time (its own feed event), so the gate waits for it
    // and then fires from the contact point as soon as it lands. Fouls skip
    // that wait and launch their synthesized flight immediately.
    if (contact.swing && launchable && !firedThisCycle.current && currentPlayback >= contactWallTime) {
      firedThisCycle.current = true
      launched.current = true
      flightClock.current = 0
      recordedOuts.current = 0
      resultEmitted.current = false
      completeEmitted.current = false
      noLaunchDeadlineRef.current = null
      // A launch re-arms the fielding choreography (and, for a late-arriving
      // live hit, re-arms the windup-start restart for the lengthened cycle).
      fieldersReset.current = false
      // The hit data can land after the pitch reached the plate, so this launch
      // may start later than contact. Lengthen the shared cycle so the ball's
      // full flight plus the pause plus the pitcher's windup still fit before
      // the wrap. Every shared clock is still below the old duration here, so
      // lengthening never jumps the pitch/batter/pitcher animations mid-play.
      const needed = currentPlayback + plan.endTime + getCyclePause() + getBallReleaseTime()
      if (needed > getCycleDuration()) setCycleDuration(needed)
    }

    // A contacted pitch whose batted ball never became launchable (its live
    // Statcast hit is still missing, or is present but lacks a fielding point)
    // would loop forever and wedge the live queue — the pitch's own arrival
    // handler defers completion to BattedBall, but a ball that never launches
    // never fires onComplete. Give the feed a long, gentle grace
    // (``battedTuning.noLaunchTimeoutMs``, default 30s) then auto-advance. This
    // never fires early: the hit normally lands a poll or two after contact, so
    // a real late hit still launches well inside the window; only a genuinely
    // missing hit reaches the deadline.
    if (!comparison && contact.swing && !launched.current && !completeEmitted.current) {
      // Only count wall-clock time while the ball has actually reached the
      // plate un-launched; before that the deadline is left untouched so it
      // persists (not reset) across the looping cycles a missing hit produces.
      if (currentPlayback >= contactWallTime) {
        const now = performance.now()
        if (noLaunchDeadlineRef.current == null) {
          noLaunchDeadlineRef.current = now + battedTuning.noLaunchTimeoutMs
        } else if (shouldAutoAdvanceStuckPlay({
          contactSwing: contact.swing,
          launched: launched.current,
          completeEmitted: completeEmitted.current,
          deadlineExceeded: now >= noLaunchDeadlineRef.current,
          comparison,
        })) {
          completeEmitted.current = true
          if (onComplete) onComplete('noHit', {
            playId: pitchData?.play_id ?? null,
            reason: `statcast hit never arrived after ${Math.round(battedTuning.noLaunchTimeoutMs / 1000)}s`,
          })
        }
      }
    }

    if (!launched.current) {
      battedGroupRef.current.visible = false
      setBattedBallPosition(null)
      setChaserPosition(null)
      setPlayBallPosition(null)
      setFielderCamLookTarget(null)
      return
    }

    battedGroupRef.current.visible = true
    flightClock.current += delta * speed
    const t = flightClock.current

    // Home-run confetti: burst once, at the spot the ball clears the wall.
    if (!comparison && plan.wallExit && !confettiFiredRef.current && t >= plan.wallExit.time) {
      confettiFiredRef.current = true
      setConfetti({ key: performance.now(), position: plan.wallExit.position.clone() })
    }

    // ── Tail + yellow trace (same reveal/fade as the pitch, no particles) ──
    // The batted-ball trail and its persistent yellow trace vanish at the same
    // moment the pitch's white trajectory trace clears — the instant the
    // pitcher restarts his windup — so the tail of the play is gone the moment
    // the windup begins, never lingering into the cycle wrap.
    const trailFade = currentPlayback >= windupStart ? 0 : 1
    if (tailMeshRef.current || traceMeshRef.current) {
      const tailAlphaAttr = trailGeometry.getAttribute('aAlpha')
      const yellowAlphaAttr = traceGeometry.getAttribute('aAlpha')
      const tailAlphas = tailAlphaAttr.array
      const yellowAlphas = yellowAlphaAttr.array
      const fadeRate = 1 / Math.max(0.001, battedTuning.trailFadeTime)
      const trailFactor = comparison ? battedTuning.comparisonTrailFactor : 1
      let yellowFade = 1
      if (t >= plan.ballAirTime) {
        yellowFade = 1 - Math.min((t - plan.ballAirTime) / Math.max(0.001, battedTuning.traceFadeTime), 1)
      }
      const yellowAlphaNow = (battedTuning.traceMinOpacity
        + (battedTuning.traceOpacity - battedTuning.traceMinOpacity) * yellowFade) * trailFactor
      for (let i = 0; i < trailPoints.length; i++) {
        const age = t - trailPoints[i].t
        let tailAlpha = 0
        if (age >= 0) {
          tailAlpha = battedTuning.trailMaxOpacity * trailFactor * (1 - age * fadeRate)
          if (tailAlpha < 0) tailAlpha = 0
        }
        tailAlphas[i] = tailAlpha * trailFade
        yellowAlphas[i] = (age >= 0 ? yellowAlphaNow : 0) * trailFade
      }
      tailAlphaAttr.needsUpdate = true
      yellowAlphaAttr.needsUpdate = true
    }

    // ── Ball ─────────────────────────────────────────────────────────────
    if (comparison) {
      // Comparison: fly the arc only until the ball hits the ground, then hide
      // it — no fielder/throw choreography.
      if (t < plan.ballAirTime) {
        const ballPosition = plan.arc.positionAtTime(t)
        if (ballPosition.y < 0) ballPosition.y = 0
        ballRef.current.position.copy(ballPosition)
        ballRef.current.visible = true
      } else {
        ballRef.current.visible = false
      }
    } else if (t <= plan.ballCatch.t) {
      // In flight along the batted-ball arc, and the moment it first touches
      // the ground it keeps rolling forward on the same real path toward the
      // fielder's fielding point.
      //
      // The arc is a quadratic, so the flight time is clamped to the TRUE
      // air time (ballAirTime): evaluating past its landing point would
      // extrapolate the height upward — a negative-launch hit (whose arc dips
      // below the ground almost immediately) would otherwise shoot into the
      // sky while the fielder fields it. Its x/z, however, is linear in time
      // at the ball's horizontal speed.
      //
      // Once on the ground the ball rolls along the real trajectory line at
      // the tuned ``rollSpeedXY`` (plan.groundRollSpeedMph): its ground
      // distance is ``contactDistance + rollSpeedXY * (t - ballAirTime)``,
      // clamped at the catch. Because the interception was resolved with that
      // same roll speed (see buildPlan), the ball lands on ``catchLocation``
      // at ``t == ballCatch.t`` — the same instant the fielder's sprint
      // arrives — so a faster/slower roll still meets the fielder in sync.
      const ballTime = Math.min(t, plan.ballAirTime)
      let ballPosition
      if (t <= plan.ballAirTime) {
        // Airborne: height from the arc, clamped at the plane so a ball whose
        // path dips below the ground starts sliding the instant it crosses it.
        ballPosition = plan.arc.positionAtTime(ballTime)
        if (ballPosition.y < 0) ballPosition.y = 0
      } else {
        // Rolling on the real path at the tuned roll speed, clamped so it
        // never passes the fielding point. Default (rollSpeedXY === airXY)
        // reduces to the arc's own x/z continuation.
        const d = plan.contactDistance + plan.rollSpeedXY * (t - plan.ballAirTime)
        const dMax = plan.flatLaunch.distanceTo(plan.catchLocation)
        ballPosition = plan.flatLaunch
          .clone()
          .add(plan.ballDir.clone().multiplyScalar(Math.min(Math.max(d, 0), dMax)))
        ballPosition.y = 0
      }
      ballRef.current.position.copy(ballPosition)
      ballRef.current.visible = true
    } else if (plan.chaserSegments.length > 1) {
      // Unassisted putout: the ball rides with the chaser to the base.
      const pos = evalSegments([plan.chaserSegments[plan.chaserSegments.length - 1]], t)
      if (pos) {
        pos.y = 0.12
        ballRef.current.position.copy(pos)
        ballRef.current.visible = true
      }
    } else if (plan.throws.length > 0) {
      // Assist chain: follow whichever throw is active.
      let throwing = false
      for (const th of plan.throws) {
        if (t >= th.start && t <= th.start + th.duration) {
          const pos = th.arc.positionAtTime(t - th.start)
          ballRef.current.position.copy(pos)
          ballRef.current.visible = true
          throwing = true
          break
        }
      }
      if (!throwing) {
        // The ball has reached the final receiver's glove.
        ballRef.current.visible = false
      }
    } else {
      // Caught in the air: the ball rests at the catch point.
      ballRef.current.position.copy(plan.catchLocation)
      ballRef.current.visible = false
    }

    // Publish the ball's live world position (its mesh sits in an untransformed
    // group, so the local position IS world space) so the batter can track it
    // with its head after contact. Only while the ball is truly airborne on its
    // arc (t <= ballAirTime): the moment it lands the head stops tracking, even
    // if the ball then rests on the ground or is carried/thrown by a fielder.
    // (ballCatch.t — the fielder's intercept — can be far later than ballAirTime
    // for ground balls, and the ball must not be tracked while it sits there.)
    setBattedBallPosition(t <= plan.ballAirTime ? ballRef.current.position : null, pitchData?.play_id ?? null)

    // Fielder cam ball tracking: publish whenever the ball mesh is visible
    // anywhere — airborne flight, carried by the chaser to a base, or thrown
    // between fielders — so the fielder camera can follow the ball through
    // the entire choreography (throws to first, double plays, etc.).
    if (!comparison) {
      setPlayBallPosition(
        ballRef.current?.visible ? ballRef.current.position : null,
        pitchData?.play_id ?? null,
      );

      // When the fielder receives the ball and is advancing to step on the bag
      // (e.g. unassisted putout), point the camera at the bag instead of staring
      // straight down at the ball and the ground beneath his feet.
      if (plan.stepOnBagTarget && t >= plan.ballCatch.t) {
        const lookTarget = resolveFielderCamTarget({
          t,
          ballCatchTime: plan.ballCatch.t,
          stepOnBagTarget: plan.stepOnBagTarget,
          catchLocation: plan.catchLocation,
          duration: plan.endTime - plan.ballCatch.t,
        });
        setFielderCamLookTarget(lookTarget, pitchData?.play_id ?? null);
      } else {
        setFielderCamLookTarget(null);
      }
    }


    // ── Chaser: sprint from their defensive spot to the fielding point, then
    //    (for an unassisted putout) on to the base. ──────────────────────
    // Suppressed once the fielding choreography has restarted at the windup
    // start — the chaser is parked on his defensive spot through the windup and
    // the fielder cam (which follows the published position) re-acquires the
    // ready alignment there.
    const chaserRefs = fielderRefs.current[plan.chaser]
    if (!fieldersReset.current && (chaserRefs?.group || plan.chaser === 'C')) {
      const pos = evalSegments(plan.chaserSegments, t) || plan.chaserHome
      if (chaserRefs?.group && pos) {
        chaserRefs.group.position.copy(pos)
        // ``activeSeg`` is only defined while the chaser is actually running
        // (t inside [start, start+duration)), so the lean + facing drop as soon
        // as they stop — e.g. waiting under a fly ball at the fielding point.
        const activeSeg = plan.chaserSegments.find((s) => t >= s.start && t < s.start + s.duration)
        if (activeSeg) {
          chaserRefs.group.lookAt(activeSeg.to.x, chaserRefs.group.position.y, activeSeg.to.z)
        }
        if (chaserRefs.lean) chaserRefs.lean.rotation.x = activeSeg ? 0.22 : 0
      }
      // Publish the chaser's live world position so the fielder camera can
      // follow along during the replay.
      const publishedPos = chaserRefs?.group?.position || pos
      setChaserPosition(publishedPos, pitchData?.play_id ?? null)
    } else {
      setChaserPosition(null)
    }

    // ── Putout fielders sprint to their out base while the ball is in flight ──
    if (!fieldersReset.current) {
      for (const move of plan.putoutMoves) {
        const refs = fielderRefs.current[move.fielder]
        if (!refs?.group) continue
        const progress = clamp(t / move.duration, 0, 1)
        refs.group.position.lerpVectors(move.from, move.to, progress)
        refs.group.lookAt(move.to.x, refs.group.position.y, move.to.z)
        if (refs.lean) refs.lean.rotation.x = progress < 1 ? 0.22 : 0
      }
    }

    // ── Emit OUT / DOUBLE PLAY / TRIPLE PLAY as each out is recorded ─────
    // Suppressed in comparison: there is no fielding, so there are no outs to
    // emit, and the app's live scoreboard/queue must not advance.
    if (!comparison) {
      const outsNow = plan.outs.filter((o) => o.time <= t).length
      if (outsNow > recordedOuts.current) {
        recordedOuts.current = outsNow
        if (onPlayResult) onPlayResult(plan.outs[outsNow - 1].text)
      }
      if (plan.resultText && !resultEmitted.current && t >= plan.endTime) {
        resultEmitted.current = true
        if (onPlayResult) onPlayResult(plan.resultText)
      }
      if (!completeEmitted.current && t >= plan.endTime) {
        completeEmitted.current = true
        if (onComplete) onComplete('normal')
      }
    }
  })

  if (!contact || !plan) return null

  // The catcher ('C') is rendered by its own dedicated component
  // (Catcher.jsx), so it is excluded here to avoid a duplicate sprite behind
  // home plate — including when the chaser happens to be the catcher.
  const chaserPos = plan.chaser
  const renderChaser = chaserPos !== 'C'
  const staticFielders = Object.entries(FIELD.DEFENSE)
    .filter(([pos]) => pos !== chaserPos && pos !== 'C')

  return (
    <group>
      {/* All defensive fielders at their positions (hidden in comparison) */}
      {!comparison && (
        <>
          {staticFielders.map(([pos, home]) => (
            <Fielder key={pos} position={home.toArray()} ref={registerFielder(pos)} leanRef={registerLean(pos)} />
          ))}
          {renderChaser && (
            <Fielder key={`chaser-${chaserPos}`} position={plan.chaserHome.toArray()} ref={registerFielder(chaserPos)} leanRef={registerLean(chaserPos)} opacity={fielderOpacity} />
          )}
        </>
      )}

      {/* Batted ball + trajectory (hidden until the pitch is hit) */}
      <group ref={battedGroupRef} visible={false}>
        {/* Tail + yellow trace (same animation as the pitch, no billow particles) */}
        {trailPoints.length > 0 && (
          <>
            <instancedMesh
              ref={traceMeshRef}
              args={[traceGeometry, traceMaterial, TRAIL_MAX_PARTICLES]}
              renderOrder={1}
              frustumCulled={false}
            />
            <instancedMesh
              ref={tailMeshRef}
              args={[trailGeometry, trailMaterial, TRAIL_MAX_PARTICLES]}
              renderOrder={2}
              frustumCulled={false}
            />
          </>
        )}

        {/* Landing / intercept marker */}
        <mesh position={[plan.landing.x, 0.015, plan.landing.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.4, 0.55, 24]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>

        {/* Baseball, starting at the contact spot where the pitch was hit */}
        <mesh ref={ballRef} position={contact.launch.toArray()} castShadow>
          <sphereGeometry args={[0.075, 16, 16]} />
          <meshStandardMaterial
            color="#ffffff"
            roughness={0.4}
            transparent={comparison}
            opacity={comparison ? battedTuning.comparisonBallOpacity : 1}
          />
        </mesh>
      </group>

      {/* Home-run confetti burst, spawned at the wall-crossing spot */}
      <ConfettiBurst burst={confetti} />
    </group>
  )
}
