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
import { getTuning } from './tuning'

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

// Whether the fielder camera replay is currently active. Read by BattedBall
// to make the chaser translucent so the body doesn't block the camera.
let fielderCamActive = false

export function setFielderCamActive(active) {
  fielderCamActive = active
}

export function getFielderCamActive() {
  return fielderCamActive
}
