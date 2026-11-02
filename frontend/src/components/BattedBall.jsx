import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PLATE_FRONT_Y, plateCrossing } from '../util/MathUtil'
import { isHitFieldingReady, hitMatchesAtBat, isBattedBallLaunchable, shouldAutoAdvanceStuckPlay, resolveFielderCamTarget, resolveFielderCamThrowTarget } from '../util/battedBall'
import { buildPlan, evalSegments } from '../util/playPlan'
import { BATTER_ACTOR, ballCarrierAt, pitcherIsInvolved } from '../util/playCast'
import { defenseKitForInning } from '../util/playerKit'
import { setCycleDuration, getCycleDuration, getTimeScale, getCyclePause, getBallReleaseTime, setBattedBallPosition, setChaserPosition, setPlayBallPosition, setFielderCamLookTarget, getCastHandPosition, setCastHandPosition, setPlayClock, setBatterRun, setPitcherFielding, stepSimulation, getSimulationTime } from '../constants/playback'
import { useTuning } from '../constants/tuning'
import { FieldCast } from './FieldCast'
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
// What is on the field, and what each body does while the ball is in play, is
// the cast's own business: util/playPlan.js builds the schedule, util/playCast.js
// says where every actor is at a given second of it, and components/FieldCast.jsx
// draws them (the real player.glb, seven fielders plus the runners, in place of
// the capsule-and-ball placeholders that used to stand at each spot). This
// component plays the ball half of that same plan — the arc, the roll, the throw
// chain and the trail — and the rest of the choreography it leaves to the cast.
//
// The batted ball launches from the
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

export const BattedBall = ({ pitchData, replayKey = 0, hit = null, hits = SAMPLE_HITS, onPlayResult, onComplete, comparison = false }) => {
  const tuning = useTuning()
  const battedTuning = tuning.battedBall
  const playbackTuning = tuning.playback
  const [hitIndex, setHitIndex] = useState(0)
  // One-shot confetti burst for home runs (set when the ball clears the wall).
  const [confetti, setConfetti] = useState(null)
  const battedGroupRef = useRef()
  const ballRef = useRef()
  // Flight clock starting from 0 the moment the ball is launched at contact.
  const flightClock = useRef(0)
  // Whether the cast should be live this frame: the play has launched and the
  // choreography has not run out (FieldCast reads it, and falls back to its own
  // alignment — the reset — when it is false).
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
  const castPlaying = useRef(false)
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

  // Hand the batter-runner's own run to the body that runs it: the batter's
  // (see constants/playback.js's `batterRun`, and util/playCast.js on why this
  // cast draws seven fielders and the runners on the bases but not him). One
  // schedule, one owner — the batter reads the very walk the play was timed
  // from, rather than keeping a second copy of it in step with this one.
  useEffect(() => {
    setBatterRun(plan?.runs?.find((r) => r.actor === BATTER_ACTOR) ?? null)
    return () => setBatterRun(null)
  }, [plan])

  // ...and the pitcher's own body is handed the same plan when the play gives him
  // something to do with the ball — a comebacker to field, a putout to make at the
  // bag, a throw to make or to take. Like the batter's run, this is published for
  // the component that draws that body (Pitcher.jsx) rather than drawn by the
  // cast: the pitcher is not one of the cast's bodies either (see util/playCast.js),
  // and the plan is only ever published when it is really his to field.
  // ...never in comparison mode, which has no fielding at all: an overlaid pitcher is
  // a pitch to read against others, not a body in a play (the same reason the cast is
  // not drawn there).
  useEffect(() => {
    setPitcherFielding(!comparison && pitcherIsInvolved(plan) ? plan : null)
    return () => setPitcherFielding(null)
  }, [plan, comparison])

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
    setPlayClock(null)
    // ...and the hand holding the ball: a pitch carries no fielding, so whatever
    // body held it on the last play must not leave its hand behind for this one to
    // ride (the cast and the pitcher each publish their own carrier's hand, and
    // neither is asked for one here).
    setCastHandPosition(null)
    noLaunchDeadlineRef.current = null
  }, [pitchData, replayKey])

  // Clear the shared batted-ball position when this component unmounts (e.g.
  // entering/exiting comparison mode, where the whole live branch is swapped
  // out). Between normal pitches the same instance stays mounted and keeps
  // publishing null while the ball isn't airborne — but an unmount leaves the
  // last published position lingering in the module global, which would make
  // the follow camera lock onto a vanished ball and capture a wrong "original"
  // view for the first animation after returning to live. The play's own clock
  // goes with it for the same reason (a body that ran a play of a component
  // that no longer exists would keep running it).
  useEffect(() => {
    return () => { setBattedBallPosition(null); setChaserPosition(null); setPlayBallPosition(null); setFielderCamLookTarget(null); setPlayClock(null) }
  }, [])

  useFrame((state, delta) => {
    const { time: currentPlayback, wrapped } = stepSimulation(delta, state.clock.elapsedTime)
    // The play's clock is only up while the play is: every path that leaves the
    // choreography (no plan, no flight, before the launch, after the last body
    // has stopped) takes it away below, so a reader can never see a play that is
    // over while its own positions still look alive.
    setPlayClock(null)

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
      // The cast's reset is its own: with the play over (this instant is past
      // every plan's endTime), FieldCast puts every body back on its own spot in
      // its idle clip — the same alignment the next cycle replays from.
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
    // The cast plays exactly as long as the play does: launched, and still
    // inside the choreography's own length. When this goes false — before the
    // launch, and once the last runner has arrived — FieldCast puts every body
    // back on its own spot in its idle clip, which is the reset that lets the
    // next cycle replay the same play from the top.
    castPlaying.current = launched.current && t <= plan.endTime
    setPlayClock(castPlaying.current ? t : null)

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
    } else if (ballCarrierAt(plan, t) && getCastHandPosition()) {
      // The ball is in a fielder's hand: the man who gloved it holds it through
      // his wind-up, and each man who receives a throw holds it before making
      // his own (the reference attaches the ball to the palm socket for exactly
      // these windows). The cast publishes the hand each frame; with no cast
      // hand — a ball fielded by the pitcher or the catcher, who are not in the
      // cast — the branches below carry it instead.
      const hand = getCastHandPosition()
      ballRef.current.position.set(hand.x, hand.y, hand.z)
      ballRef.current.visible = true
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
      } else if (plan.throws && plan.throws.length > 0 && t >= plan.ballCatch.t) {
        // Assist chain: once he HAS the ball the fielder turns toward the
        // teammate he throws to (and every receiver after him turns toward the
        // next), so the camera must look where the body looks — at the
        // receiving fielder — not straight down at the ball, which stares at
        // the ground.
        const lookTarget = resolveFielderCamThrowTarget({
          t,
          ballCatchTime: plan.ballCatch.t,
          throws: plan.throws,
          catchLocation: plan.catchLocation,
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
    // The bodies themselves are FieldCast's (below): it reads the same plan on
    // the same clock and moves every actor, so all that is left here is to
    // publish the chaser's live position for the fielder camera to follow.
    // Suppressed once the fielding choreography has restarted at the windup
    // start — the chaser is parked on his defensive spot through the windup and
    // the fielder cam (which follows the published position) re-acquires the
    // ready alignment there.
    if (!fieldersReset.current) {
      const pos = evalSegments(plan.chaserSegments, t) || plan.chaserHome
      setChaserPosition(pos, pitchData?.play_id ?? null)
    } else {
      setChaserPosition(null)
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

  return (
    <group>
      {/* The cast: every fielder and runner this play has, in the real uniform
          (FieldCast owns the bodies and their clips; the plan's schedule drives
          them). Hidden in comparison mode, which has no fielding at all, and
          while the play is not running — before the launch and after the
          choreography has ended, when the cast sits on its own alignment ready
          for the next cycle to replay. */}
      {!comparison && (
        <FieldCast
          plan={plan}
          clockRef={flightClock}
          playingRef={castPlaying}
          defenseKit={defenseKitForInning(pitchData)}
        />
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
