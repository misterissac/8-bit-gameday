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
let cycleDuration = 0.5
let timeScale = 1

export function setCycleDuration(duration) {
  if (Number.isFinite(duration) && duration > 0) cycleDuration = duration
}

export function getCycleDuration() {
  return cycleDuration
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
export const CYCLE_PAUSE = 0.6

// Live world position of the batted ball while it is in flight, published by
// BattedBall every frame so the batter can track it with its head after
// contact. Null when the ball is not airborne (pre-launch, landed, caught,
// or the cycle reset).
let battedBallPosition = null

export function setBattedBallPosition(pos) {
  battedBallPosition = pos ? { x: pos.x, y: pos.y, z: pos.z } : null
}

export function getBattedBallPosition() {
  return battedBallPosition
}
