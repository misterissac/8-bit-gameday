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

// Whether the cycle-wrap watchdog should force-complete the current play.
//
// A launched play that never reached its completion time before the cycle
// wrapped (degenerate endTime, too-short cycle) would otherwise loop forever
// and wedge the live queue. But the watchdog must ONLY fire for contact
// pitches: a non-contact pitch (ball / take / whiff) never launches the
// batted ball, so launched.current should be false.  However, the reset
// effect (useEffect → now useLayoutEffect) runs AFTER the first useFrame
// with the new pitchData, so a stale launched=true from the previous
// contact pitch can survive one cycle wrap.  Without the contact.swing
// guard the watchdog would spuriously fire onComplete for a non-contact
// pitch — surfacing an OUT and wedging the queue.
export const shouldCycleWrapWatchdogFire = ({
  contactSwing,
  launched,
  completeEmitted,
  comparison,
} = {}) => (
  contactSwing === true &&
  launched === true &&
  completeEmitted !== true &&
  comparison !== true
)
