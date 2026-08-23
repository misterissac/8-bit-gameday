// Decide the scorebug's bottom-left game-status label from the live status
// fields and the frozen snapshot's pitcher. Returns null when nothing needs
// showing (normal in-progress play), so the row collapses back to just the
// ballpark while the game is live.
export const scorebugStatusLabel = ({
  gameState,
  liveStatus,
  pitcher,
  pitcherId,
  frozen,
  inning,
}) => {
  const liveGameState = liveStatus?.gameState ?? gameState

  // The feed embeds mound visits and pitching substitutions as action events
  // in the current play's playEvents. The backend surfaces these as explicit
  // flags, which is far more reliable than inferring from pitcher-identity
  // comparison (which can't tell a real relief appearance from the defensive
  // team simply swapping after an inning turns over).
  //
  // A mound visit takes priority — it's transient and the most actionable
  // in-game notice.
  if (liveStatus?.moundVisit) return 'Mound Visit'

  // A pitching change detected from the feed's own action event is always
  // genuine, even during inning transitions. Surface the new pitcher's name
  // (and the old one when available) so the label reads like a broadcast.
  if (liveStatus?.pitchingChange) {
    const newP = liveStatus?.pitchingChangePitcher;
    const oldP = liveStatus?.pitchingChangeOldPitcher;
    if (newP && oldP) return `Pitching Change: ${newP} replaces ${oldP}`;
    if (newP) return `Pitching Change: ${newP}`;
    return 'Pitching Change';
  }

  // An offensive substitution (pinch hitter or pinch runner). Surface the
  // role and both player names so the label reads like a broadcast.
  if (liveStatus?.offensiveSub) {
    const role = liveStatus?.offensiveSubRole || 'Pinch Hitter';
    const sub = liveStatus?.offensiveSubNew;
    const old = liveStatus?.offensiveSubOld;
    if (sub && old) return `${role}: ${sub} replaces ${old}`;
    if (sub) return `${role}: ${sub}`;
    return role;
  }

  // A defensive substitution (position player swap). Surface both player
  // names so the label reads like a broadcast.
  if (liveStatus?.defensiveSub) {
    const sub = liveStatus?.defensiveSubNew;
    const old = liveStatus?.defensiveSubOld;
    if (sub && old) return `Defensive Sub: ${sub} replaces ${old}`;
    if (sub) return `Defensive Sub: ${sub}`;
    return 'Defensive Sub';
  }

  // Show any non-"In Progress" detailed state (Final, Rain Delay, Suspended,
  // Umpire Review, ...) and hide the generic live state.
  return liveGameState && liveGameState !== 'In Progress' ? liveGameState : null
}

// Terminal game states after which the scorebug has nothing left to poll.
// "Final" is the standard MLB end-of-game value; "Game Over" and
// "Completed Early" cover feed variants for completed games.
const TERMINAL_GAME_STATES = new Set(['Final', 'Game Over', 'Completed Early'])

export const isGameTerminal = (gameState) => (
  gameState != null && TERMINAL_GAME_STATES.has(gameState)
)
