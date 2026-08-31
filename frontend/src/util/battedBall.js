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
