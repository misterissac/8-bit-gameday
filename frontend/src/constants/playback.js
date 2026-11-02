// Shared real-time simulation clock and playback speed.
//
// The pitch, batter, and batted ball all advance their clocks by the wall-clock
// frame delta times the shared time scale, and share a single cycle:
//
//   t = 0                    pitch released, batter loaded
//   t = contact time         pitch reaches the plate, batter connects, the
//                            batted ball launches
//   t = pitch flight time    pitch ball holds at the plate
//   t = contact + flight     batted ball lands / is caught
//   t = cycle duration       whole scene resets and the next pitch is thrown
//
// Because every component multiplies its clock by the same getTimeScale(), the
// whole simulation (pitch, swing, and batted-ball flight) slows down together
// and stays in sync at any playback speed. Default is 1 (real time).
//
// BattedBall knows how long the hit stays airborne, so it computes the full
// cycle length; Pitch and Batter read it back each frame via getCycleDuration().
import { getTuning } from './tuning.js'

let cycleDuration = 0.5
let timeScale = 1
let simulationTime = 0
let pendingCycleDuration = null
let lastFrameStamp = null
let wrappedThisFrame = false

export function setCycleDuration(duration, { force = false } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) return
  // If shortening while the clock is currently past the new duration and not forced,
  // defer applying the new duration until the cycle cleanly wraps, avoiding mid-flight snaps.
  if (!force && duration < simulationTime) {
    pendingCycleDuration = duration
  } else {
    cycleDuration = duration
    pendingCycleDuration = null
  }
}

export function getCycleDuration() {
  return cycleDuration
}

export function getPendingCycleDuration() {
  return pendingCycleDuration
}

export function stepSimulation(delta, frameStamp = null) {
  // Guarantee idempotency across multiple callers within the same render tick
  if (frameStamp !== null && frameStamp === lastFrameStamp) {
    return { time: simulationTime, wrapped: wrappedThisFrame }
  }
  if (frameStamp !== null) {
    lastFrameStamp = frameStamp
  }
  const dt = (Number.isFinite(delta) ? delta : 0) * timeScale
  const nextTime = simulationTime + dt
  if (nextTime >= cycleDuration) {
    wrappedThisFrame = true
    if (pendingCycleDuration !== null) {
      cycleDuration = pendingCycleDuration
      pendingCycleDuration = null
    }
    simulationTime = cycleDuration > 0 ? (nextTime % cycleDuration) : 0
  } else {
    wrappedThisFrame = false
    simulationTime = nextTime
  }
  return { time: simulationTime, wrapped: wrappedThisFrame }
}

export function getSimulationTime() {
  return simulationTime
}

export function setSimulationTime(t) {
  if (Number.isFinite(t)) {
    simulationTime = Math.max(0, t)
    wrappedThisFrame = false
  }
}

export function resetSimulationTime() {
  simulationTime = 0
  wrappedThisFrame = false
  lastFrameStamp = null
  if (pendingCycleDuration !== null) {
    cycleDuration = pendingCycleDuration
    pendingCycleDuration = null
  }
}

export function isSimulationWrapped() {
  return wrappedThisFrame
}

// Playback speed (1 = real time). Slower values slow the whole cycle together.
export function setTimeScale(scale) {
  if (Number.isFinite(scale) && scale > 0) timeScale = scale
}

export function getTimeScale() {
  return timeScale
}

// Slow-motion floor offered by the playback slider (1 = real time; the slider
// ranges from 1 down to SLOWEST_SPEED).
export const SLOWEST_SPEED = 0.05

// Short beat between the batted ball landing and the next pitch of the loop.
export function getCyclePause() {
  return getTuning().playback.cyclePause
}

export function getBallReleaseTime() {
  return getTuning().playback.ballReleaseTime
}

// Live world position of the batted ball while it is in flight, published by
// BattedBall every frame so the batter can track it with its head after
// contact. Null when the ball is not airborne (pre-launch, landed, caught,
// or the cycle reset). Carries the owning pitch's play id so the follow camera
// can ignore a stale position left over from a previous play (or a contact
// pitch whose own Statcast hit hasn't arrived yet).
let battedBallPosition = null

export function setBattedBallPosition(pos, playId = null) {
  battedBallPosition = pos ? { x: pos.x, y: pos.y, z: pos.z, playId: playId ?? null } : null
}

export function getBattedBallPosition() {
  return battedBallPosition
}

// Live world position of the chaser (the fielder who fields the batted ball),
// published by BattedBall every frame while the play is animating. Null when
// no play is active or the chaser isn't running. Carries the owning pitch's
// play id so the fielder camera can verify it belongs to the current play.
let chaserPosition = null

export function setChaserPosition(pos, playId = null) {
  chaserPosition = pos ? { x: pos.x, y: pos.y, z: pos.z, playId: playId ?? null } : null
}

export function getChaserPosition() {
  return chaserPosition
}

// Live world position of the ball throughout the entire play (airborne flight,
// thrown between fielders, carried to a base by the chaser). Published by
// BattedBall every frame while the ball mesh is visible so the fielder camera
// can track it through the choreography. Null when the ball is hidden or no
// play is active. Carries the owning pitch's play id for gating.
let playBallPosition = null

export function setPlayBallPosition(pos, playId = null) {
  playBallPosition = pos ? { x: pos.x, y: pos.y, z: pos.z, playId: playId ?? null } : null
}

export function getPlayBallPosition() {
  return playBallPosition
}

// Live world position of the hand holding the ball, published every frame by
// whoever draws the body that has it — the cast (FieldCast) for a fielder, and
// the pitcher's own component for the pitcher (Pitcher.jsx, who is not one of the
// cast's bodies) — from the moment the ball is gloved until the throw leaves his
// hand. The batted ball's own renderer reads
// it and follows the hand, so the ball rides the catch and the wind-up instead
// of hanging in the air where it was fielded (the reference attaches the ball
// to the thrower's palm socket instead; this is the same thing across the
// component boundary). Null whenever nobody is holding it.
let castHandPosition = null

export function setCastHandPosition(pos) {
  castHandPosition = pos ? { x: pos.x, y: pos.y, z: pos.z } : null
}

export function getCastHandPosition() {
  return castHandPosition
}

// The play's own clock: the seconds since the batted ball left the bat, which
// is the clock util/playPlan.js's schedule is written in. Published by BattedBall
// every frame while the choreography is running — the same window the cast plays
// in — and null when it is not: before the launch, and once the play has finished
// (the instant the cast resets, so the field and the batter's own body come back
// together). Read by the batter, whose body becomes the batter-runner at the
// schedule's own takeoff (see util/batterRunner.js and the Batter component).
let playClock = null

export function setPlayClock(t) {
  playClock = Number.isFinite(t) ? t : null
}

export function getPlayClock() {
  return playClock
}

// The batter-runner's own run, straight out of the plan that owns it
// (util/playPlan.js's `runs`, the entry whose actor is 'B' — the batter's own
// slot in the feed's movement data). Published by BattedBall when the plan is
// built, because the body that runs it is Batter.jsx's: the batter is the one
// actor of the offense this cast does not draw (see util/playCast.js), exactly
// as the pitcher and the catcher are their own components on defense.
let batterRun = null

export function setBatterRun(run) {
  batterRun = run ?? null
}

export function getBatterRun() {
  return batterRun
}

// The plan the pitcher's own body is fielding, published by BattedBall while a
// play gives him something to do with the ball (util/playCast.js's
// `pitcherIsInvolved`: a comebacker to field, a putout to make at the bag, a throw
// to make or to take) and null while it does not. Read by Pitcher.jsx, whose body
// is not one of the cast's (see util/playCast.js): he plays his half of the
// choreography off this plan and the play's own clock, exactly as the cast plays
// theirs, and stands in his own delivery the rest of the time.
let pitcherFielding = null

export function setPitcherFielding(plan) {
  pitcherFielding = plan ?? null
}

export function getPitcherFielding() {
  return pitcherFielding
}

// Live world position of the look-at target for FielderCam when overriding the
// ball tracking (e.g. looking ahead at the bag as the fielder carries the ball
// to step on it). Carries the owning pitch's play id for gating.
let fielderCamLookTarget = null

export function setFielderCamLookTarget(pos, playId = null) {
  fielderCamLookTarget = pos ? { x: pos.x, y: pos.y, z: pos.z, playId: playId ?? null } : null
}

export function getFielderCamLookTarget() {
  return fielderCamLookTarget
}

