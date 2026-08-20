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
}) => {
  const liveGameState = liveStatus?.gameState ?? gameState

  // While frozen, a live pitching change should surface even though the rest
  // of the scoreboard stays locked on the completed play's snapshot.
  const pitcherChanged = Boolean(
    frozen &&
    liveStatus?.pitcher &&
    pitcher &&
    (
      liveStatus.pitcherId != null && pitcherId != null
        ? liveStatus.pitcherId !== pitcherId
        : liveStatus.pitcher !== pitcher
    )
  )
  if (pitcherChanged) return 'Pitching Change'

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
