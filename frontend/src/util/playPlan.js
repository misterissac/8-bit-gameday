import * as THREE from 'three'
import {
  clamp,
  feetToM,
  getBallXYSpeed,
  getLandingLocation,
  lerp,
  makeSymmetricalArc,
  mphToMetersPerSecond,
  resolveFieldedIntercept,
  statcastHitToWorld,
} from './MathUtil.js'
import { getBaseTargetLocation } from './battedBall.js'
import { BASE_ORDER, BATTER_ACTOR, CATCH_HOLD_SECONDS, baseIndex, castLineup, evalSegments, offenseSpot, THROW_WINDUP_SECONDS } from './playCast.js'
import { FIELD } from '../constants/field.js'
import { getTuning } from '../constants/tuning.js'

// The schedule evaluator lives with the cast it drives (playCast.js); it is
// re-exported here because the batted ball's own frame loop is one of its two
// callers.
export { evalSegments }

// ---------------------------------------------------------------------------
// The play: what the ball does, and what every actor in the cast does while it
// does it. Ported from solomon-gumball:baseball-sim-main (kept as a read-only
// reference) — LiveGameView's `customPlayInfo` / arc / assist-chain block and
// its `animateBaserun`, plus Players.tsx's control of the same player.glb.
//
// This module is *pure*: given a hit, the launch point and the tuning, it
// answers with a schedule in seconds. Nothing here reads the clock, touches
// three's scene graph or knows a component exists, so the whole choreography —
// who runs where, when each out is recorded, when the play is over — is
// testable without a browser (see test/playPlan.test.js and
// test/playCast.test.js). BattedBall.jsx plays the ball half of it, and
// FieldCast.jsx plays the actors half, both off the same schedule.
//
// The cast itself (who stands where, and what each one does when idle) is in
// util/playCast.js; this file owns the *schedule*: runs, throws, outs.
// ---------------------------------------------------------------------------

// Outfield wall radius (matches Ballpark.jsx): the circle a home run clears in
// the air, and where the confetti burst fires as the ball leaves the park.
const WALL_RADIUS = feetToM(330)
// Defense-side spot for a base, mirroring solomon-gumball's
// getLocationForBaseCode(code, 'defense') — this app's FIELD.BASE already
// carries the negated X/Z handedness, so the base locations are used directly.
export function getDefenseBaseLocation(baseKey) {
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
// ── Base-running timings (ported from solomon-gumball's `animateBaserun`) ──
// The reference gives every base-to-base leg 2900 ms ± 200 ms, and holds the
// batter-runner back 300 ms before his own first leg (see
// `batterTakeoffSeconds` for what his takeoff actually is here).
// Its jitter is drawn at random; ours is keyed to the runner, because this play
// loops (and every cycle replays the same choreography) — the same runner must
// cover the same ground in the same time on every pass, or the reset that
// follows would land him in a different place each cycle and no test could pin
// the timing.
export const RUN_LEG_SECONDS = 2.9
export const RUN_LEG_JITTER_SECONDS = 0.2
// The reference's own batter-runner delay: 300 ms to drop the bat and go. It is
// the floor on his takeoff below rather than the whole story, because this app's
// batter-runner is not a body the schedule invents — he is the batter's own
// (Batter.jsx), and that body is still in its follow-through.
export const RUN_BATTER_DELAY_SECONDS = 0.3
// How long before he arrives a runner goes into his slide (the reference
// switches to `SlideStop` when less than 500 ms of the leg remain).
export const RUN_SLIDE_SECONDS = 0.5

/**
 * When the batter-runner's first leg starts, in seconds after contact: the
 * moment his own follow-through is whole, and not a frame of the way home.
 *
 * A batter becomes a runner the moment he is done swinging, and *this* batter's
 * swing is a whole choreography — the follow-through and the beat it holds its
 * finish on (`settings.followThrough` and `settings.followHold`, the same tuning
 * the swing itself is authored from). What is *not* part of it on a contact play is
 * the recovery (`settings.recoveryTime`, the ease back to the loaded stance that
 * readies a hitter for the pitch after this one): the man who has just put a ball
 * in play never hits again this cycle — he drops the bat and goes, out of the finish
 * pose the follow-through left him in, which is why the run is handed his own body
 * at the end of that beat rather than at the end of the swing's whole clock. So the
 * takeoff is those two beats and nothing else, and the body that runs to first is
 * the body that swung: the batter's own, handed to the run by Batter.jsx at exactly
 * this second (see util/batterRunner.js), so the plan and the pose can never disagree
 * about when the box was left. Read live off the tuning, so a slower follow-through
 * moves the runner rather than leaving him standing in the box while the schedule
 * walks him into the basepath.
 *
 * The recovery is still the swing's own way home on the swings that produce no play
 * (a take's settle, a miss), where the batter is staying in the box for the next
 * pitch — it is the *takeoff* that does not wait for it (see the swing's own phase
 * clock in Batter.jsx, which the runner's branch is taken in front of).
 *
 * Everything else on the play is unaffected by it: the others go on the ball,
 * and the throws are timed off the catch (see buildPlan), so a slower takeoff
 * here does not re-time the assist chain — it only makes the man on the other end
 * of it arrive later.
 */
export function batterTakeoffSeconds(tuning = getTuning().batter) {
  return Math.max(
    RUN_BATTER_DELAY_SECONDS,
    (tuning.followThrough ?? 0) + (tuning.followHold ?? 0),
  )
}

// The beat the play is held open after the last thing that happens in it — the
// last runner's arrival, or the last throw's catch, whichever is later. The
// reference does the same (it waits 600 ms after the final throw or catch before
// it resets the camera and signals the play complete), and it is what lets a
// caught fly ball sit in the fielder's glove for a moment rather than vanish on
// the frame he catches it, and the catch pose read as a pose.
export const PLAY_SETTLE_SECONDS = 0.5

function runLegSecondsFor(actor) {
  let hash = 0
  for (const ch of String(actor)) hash = (hash * 31 + ch.charCodeAt(0)) % 997
  return RUN_LEG_SECONDS + ((hash % 5) - 2) * (RUN_LEG_JITTER_SECONDS / 2)
}

/**
 * The runners' own choreography, ported from the reference's `animateBaserun`:
 * each runner walks `BASE_ORDER` from where the feed says he started to where
 * it says he finished (his `end`, or his `outBase` when he was put out), one
 * leg per base gap. A runner the feed does not move gets no run — he simply
 * stands on his base.
 *
 * Returns one entry per body, in the actor's own key: the batter-runner is
 * `'B'` (the feed spells his start as ``null``), and a runner already on base
 * keeps that base as his key, because he is the body that will start there
 * again after the reset.
 */
export function buildRuns(runners = [], batterTuning = getTuning().batter) {
  const byActor = new Map()
  const takeoff = batterTakeoffSeconds(batterTuning)
  for (const runner of runners) {
    const actor = runner.start ?? BATTER_ACTOR
    const startIdx = baseIndex(actor)
    const endKey = runner.end ?? runner.outBase
    const endIdx = baseIndex(endKey)
    // The reference short-circuits a movement it cannot resolve to two bases.
    if (startIdx < 0 || endIdx < 0) continue
    const leg = runLegSecondsFor(actor)
    const legs = []
    let t = actor === BATTER_ACTOR ? takeoff : 0
    for (let i = startIdx + 1; i <= endIdx; i++) {
      legs.push({
        from: offenseSpot(BASE_ORDER[i - 1]),
        to: offenseSpot(BASE_ORDER[i]),
        start: t,
        duration: leg,
      })
      t += leg
    }
    if (legs.length === 0) continue
    // One run per body: the reference consolidates a runner's base moves into
    // a single start-to-finish walk, and a later entry for the same actor
    // replaces the earlier one (the same runner moving twice in one event).
    byActor.set(actor, {
      actor,
      legs,
      arriveAt: t,
      slideAt: Math.max(t - RUN_SLIDE_SECONDS, legs[legs.length - 1].start),
      endKey: endKey ?? null,
      isOut: !!runner.isOut,
    })
  }
  return [...byActor.values()]
}

export function buildPlan(hit, launchPoint, settings = getTuning().battedBall) {
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
    // Each throw is preceded by the reference's own wind-up: the ball sits in
    // the thrower's hand for 750 ms while his throwing clip runs (`AssistThrow`
    // — see playCast's THROW_WINDUP_SECONDS), and only then leaves it. The
    // first of those wind-ups follows the catch itself, so the ball is never
    // teleported from the fielding point into a hand: it is gloved at
    // `ballCatch.t`, held through the catch pose (playCast's CATCH_HOLD_SECONDS,
    // the beat the reference's own camera dispatch and putout run take), and
    // only then wound up and thrown.
    let t = ballCatch.t + CATCH_HOLD_SECONDS + THROW_WINDUP_SECONDS
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
        // Who throws it and who receives it: the cast needs their bodies to
        // play the throw (the reference's own `ballThrower` / `ballReceiver`).
        fromActor: chainPositions[i],
        toActor: chainPositions[i + 1],
        fromPos: fromPos.clone(),
        toPos: toPos.clone(),
        arc: throwArc,
        isPutout: putoutPositions.has(chainPositions[i + 1]),
        start: t,
        duration,
      })
      if (putoutPositions.has(chainPositions[i + 1])) recordOut(t + duration)
      t += duration + THROW_WINDUP_SECONDS
    }
    if (throws.length) endTime = throws[throws.length - 1].start + throws[throws.length - 1].duration
  }

  // ── The runners' own choreography ────────────────────────────────────────
  // Every runner runs the bases the feed gave him (see buildRuns), and the
  // play is not over until the last of them has arrived — the reference awaits
  // the runners' animations alongside the ball's, so its play ends when the
  // slowest body stops moving (a home-run trot is four 2.9 s legs, so it is
  // the trot that ends the play, not the ball's flight).
  const runs = buildRuns(runners)
  for (const run of runs) endTime = Math.max(endTime, run.arriveAt)
  // ...then the settle: see PLAY_SETTLE_SECONDS.
  endTime += PLAY_SETTLE_SECONDS

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
    // The fielding side's own cast: the seven bodies this app owns on defense,
    // plus one per runner the feed moved (playCast.castLineup owns the spots).
    cast: castLineup(runs),
    runs,
    wasCaught: !!hit.wasCaught,
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
