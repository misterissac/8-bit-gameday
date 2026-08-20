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
