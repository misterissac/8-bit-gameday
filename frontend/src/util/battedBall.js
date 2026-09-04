import { feetToM } from './MathUtil.js'
import { FIELD } from '../constants/field.js'

// A live Statcast hit can arrive before its fielding point (hc_x/hc_y) is
// known. Until then the landing spot is a guess, so don't render the batted
// ball — or build its arc, which would otherwise divide by a null launch speed
// and poison the shared playback clock with an Infinity/NaN cycle duration.
export const isHitFieldingReady = (hit) => (
  hit != null &&
  hit.coordX != null &&
  hit.coordY != null &&
  hit.launchSpeed != null &&
  hit.launchAngle != null
)

// A live hit belongs to the active pitch's at-bat. A missing at-bat index on
// either side counts as a match (older/bundled payloads omit it), so only a
// genuinely different at-bat is rejected.
export const hitMatchesAtBat = (hit, atBatIndex) => (
  hit != null && (
    atBatIndex == null ||
    hit.atBatIndex == null ||
    hit.atBatIndex === atBatIndex
  )
)

// Whether the batted ball may launch for the current pitch. A foul launches its
// synthesized flight immediately; an in-play hit launches only once it belongs
// to the current at-bat AND has its Statcast fielding point, so a half-populated
// hit never animates a wrong arc.
export const isBattedBallLaunchable = ({ hit = null, atBatIndex = null, isFoul = false } = {}) => (
  isFoul === true || (
    hitMatchesAtBat(hit, atBatIndex) &&
    isHitFieldingReady(hit)
  )
)

// ── Contact-play completion state machine (fielder-camera replay) ──────────
// A contact play finishes in two steps so the fielder-camera replay can run:
// the FIRST completion arms the fielder-cam (the play keeps looping as the
// camera follows the fielder) instead of advancing the queue, and the SECOND
// completion — after the replay cycle ends — finishes the play normally. The
// fielder-cam is skipped entirely (a single completion finishes at once) when
// queued plays are waiting, comparison mode is active, auto-fielder-cam is
// off, or the camera already fired once this play.
export const CONTACT_COMPLETE_ARM = 'arm'
export const CONTACT_COMPLETE_FINISH = 'finish'

// Decide what one play completion should do given the current fielder-cam
// state. Pure: mirrors the gate in App.jsx's handlePlayComplete.
export function contactCompletionAction({
  isContactPlay,
  armed,
  fired,
  compareActive = false,
  queuedPlays = false,
  autoFielderCam = true,
}) {
  const skipFielderCam = compareActive || queuedPlays || !autoFielderCam || fired
  if (isContactPlay && !armed && !skipFielderCam) return CONTACT_COMPLETE_ARM
  return CONTACT_COMPLETE_FINISH
}

// The fielder-cam ref state to adopt after handling a completion with the
// given action. Arming also marks the camera as fired so the next completion
// finishes; finishing clears the armed flag. Mirrors the ref updates App.jsx
// applies in handlePlayComplete.
export function fielderCamNextState(state, action) {
  if (action === CONTACT_COMPLETE_ARM) return { armed: true, fired: true }
  return { armed: false, fired: state.fired }
}

// Whether the gentle stuck-play auto-advance should fire: a contacted pitch
// whose batted ball still hasn't launched AND whose long (No-Launch timeout,
// default 30s) deadline has passed — but never for a non-contact pitch, never
// twice (``completeEmitted``), never in comparison mode, and never before the
// deadline (so a merely-late Statcast hit never fires early). Mirrors
// BattedBall.jsx's never-launched watchdog condition.
export function shouldAutoAdvanceStuckPlay({
  contactSwing,
  launched,
  completeEmitted,
  deadlineExceeded,
  comparison = false,
}) {
  return (
    contactSwing === true &&
    launched === false &&
    completeEmitted !== true &&
    comparison !== true &&
    deadlineExceeded === true
  )
}

// Whether FielderCam should transition to or initialize in 'following' mode.
// In addition to dynamic chaser sprinters, fielders without moving groups
// (such as the catcher behind the plate) arm following as soon as the ball
// is in play.
export function shouldFielderCamFollow({
  snapped = false,
  hasChaser = false,
  hasBall = false,
  fielderPosition = null,
} = {}) {
  if (!snapped) return false
  return hasChaser || hasBall || (fielderPosition === 'C' && hasBall)
}

// Whether FielderCam should begin easing back / exiting on play completion.
// Both 'following' and 'waiting' (e.g. catchers without separate chaser groups)
// must restore when the play completion signal increments so the camera
// never hangs or fails to exit automatically.
export function shouldFielderCamRestore(mode, completeSignalChanged) {
  return completeSignalChanged === true && (mode === 'following' || mode === 'waiting')
}

// Target coordinates of base bags for camera focus. Raised slightly (y = 0.05)
// to center on the physical bag geometry on the infield dirt.
export function getBaseTargetLocation(baseKey, fallback = null) {
  switch (baseKey) {
    case '1B':
      return { x: FIELD.BASE.FIRST.x, y: 0.05, z: FIELD.BASE.FIRST.z }
    case '2B':
      return { x: FIELD.BASE.SECOND.x, y: 0.05, z: FIELD.BASE.SECOND.z }
    case '3B':
      return { x: FIELD.BASE.THIRD.x, y: 0.05, z: FIELD.BASE.THIRD.z }
    case 'score':
    case 'home':
      return { x: 0, y: 0.012, z: -feetToM(8.5 / 12) }
    default:
      if (fallback) {
        return { x: fallback.x, y: 0.05, z: fallback.z }
      }
      return { x: FIELD.BASE.FIRST.x, y: 0.05, z: FIELD.BASE.FIRST.z }
  }
}

// Resolve the look-at target for FielderCam when a fielder fields the ball
// and is advancing to step on a base bag (e.g. unassisted groundout). Over a
// brief transition window (default 0.3s) it eases the look target from where
// the ball was received to the base bag, then stays locked on the bag until
// the out is recorded at the base.
export function resolveFielderCamTarget({
  t,
  ballCatchTime,
  stepOnBagTarget,
  catchLocation,
  duration,
  transitionDuration = 0.3,
}) {
  if (!stepOnBagTarget || t == null || ballCatchTime == null || t < ballCatchTime) {
    return null
  }
  const maxTransition = duration != null ? Math.min(transitionDuration, Math.max(0.01, duration * 0.5)) : transitionDuration
  const elapsed = t - ballCatchTime
  const p = maxTransition > 0 ? Math.min(Math.max(elapsed / maxTransition, 0), 1) : 1
  const ease = p * p * (3 - 2 * p) // smoothstep

  const from = catchLocation ? {
    x: catchLocation.x,
    y: Math.max(catchLocation.y ?? 0, 0.1),
    z: catchLocation.z,
  } : { ...stepOnBagTarget }

  return {
    x: from.x + (stepOnBagTarget.x - from.x) * ease,
    y: from.y + (stepOnBagTarget.y - from.y) * ease,
    z: from.z + (stepOnBagTarget.z - from.z) * ease,
  }
}

