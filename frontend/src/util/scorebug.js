// Decide the scorebug's bottom-left game-status label and pop-up tab label from
// the live status fields and the frozen snapshot's pitcher.
//
// Returns an object { tabLabel, bottomRowLabel }:
//   tabLabel        — the full text shown in the slide-up tab at the top of the
//                     scorebug (includes player names, positions for subs).
//   bottomRowLabel  — the compact version shown in the bottom-left row after the
//                     tab hides (short label only, stays sticky).
// Both are null when nothing needs showing (normal in-progress play).
export const scorebugStatusLabel = ({
  gameState,
  liveStatus,
  pitcher,
  pitcherId,
  frozen,
  inning,
}) => {
  const liveGameState = liveStatus?.gameState ?? gameState

  // ── Mound Visit ───────────────────────────────────────────────────────
  if (liveStatus?.moundVisit) return { tabLabel: 'Mound Visit', bottomRowLabel: 'Mound Visit' }

  // ── ABS Challenge / Umpire Review ─────────────────────────────────────
  // The feed stores these in reviewDetails on the current play. Surface the
  // challenger and result in the tab, and keep a compact label in the row.
  if (liveStatus?.review) {
    const challenger = liveStatus?.reviewChallenger || 'Batter';
    const overturned = liveStatus?.reviewIsOverturned;
    const resultWord = overturned === true ? 'OVERTURNED' : overturned === false ? 'STANDS' : null;
    const tabLabel = resultWord
      ? `ABS Challenge: ${challenger} — ${resultWord}`
      : `ABS Challenge: ${challenger}`;
    const bottomRowLabel = resultWord
      ? `Challenge ${resultWord === 'OVERTURNED' ? 'Overturned' : 'Stands'}`
      : 'ABS Challenge';
    return { tabLabel, bottomRowLabel };
  }

  // ── Pitching Change ───────────────────────────────────────────────────
  if (liveStatus?.pitchingChange) {
    const newP = liveStatus?.pitchingChangePitcher;
    const oldP = liveStatus?.pitchingChangeOldPitcher;
    const pos = liveStatus?.pitchingChangePosition || 'P';
    // Full text for the pop-up tab.
    let tabLabel;
    if (newP && oldP) tabLabel = `Pitching Change: ${newP} (${pos}) replaces ${oldP}`;
    else if (newP) tabLabel = `Pitching Change: ${newP} (${pos})`;
    else tabLabel = 'Pitching Change';
    // Compact text for the bottom-left row.
    const bottomRowLabel = newP
      ? `Pitching Change: ${newP}`
      : 'Pitching Change';
    return { tabLabel, bottomRowLabel };
  }

  // ── Offensive Substitution (Pinch Hitter / Pinch Runner) ─────────────
  if (liveStatus?.offensiveSub) {
    const role = liveStatus?.offensiveSubRole || 'Pinch Hitter';
    const sub = liveStatus?.offensiveSubNew;
    const old = liveStatus?.offensiveSubOld;
    const oldPos = liveStatus?.offensiveSubPosition;
    const newPos = liveStatus?.offensiveSubNewPosition;
    const oldPosTag = oldPos ? ` (${oldPos})` : '';
    const newPosTag = newPos ? ` (${newPos})` : '';
    // Full text for the pop-up tab.
    let tabLabel;
    if (sub && old) tabLabel = `${role}: ${sub}${newPosTag} replaces ${old}${oldPosTag}`;
    else if (sub) tabLabel = `${role}: ${sub}${newPosTag}`;
    else tabLabel = role;
    // Compact text for the bottom-left row.
    const bottomRowLabel = sub
      ? `${role}: ${sub}${newPosTag}`
      : role;
    return { tabLabel, bottomRowLabel };
  }

  // ── Defensive Substitution ────────────────────────────────────────────
  if (liveStatus?.defensiveSub) {
    const sub = liveStatus?.defensiveSubNew;
    const old = liveStatus?.defensiveSubOld;
    const oldPos = liveStatus?.defensiveSubPosition;
    const newPos = liveStatus?.defensiveSubNewPosition;
    const oldPosTag = oldPos ? ` (${oldPos})` : '';
    const newPosTag = newPos ? ` (${newPos})` : '';
    // Full text for the pop-up tab.
    let tabLabel;
    if (sub && old) tabLabel = `Defensive Sub: ${sub}${newPosTag} replaces ${old}${oldPosTag}`;
    else if (sub) tabLabel = `Defensive Sub: ${sub}${newPosTag}`;
    else tabLabel = 'Defensive Sub';
    // Compact text for the bottom-left row.
    const bottomRowLabel = sub
      ? `Defensive Sub: ${sub}${newPosTag}`
      : 'Defensive Sub';
    return { tabLabel, bottomRowLabel };
  }

  // Show any non-"In Progress" detailed state (Final, Rain Delay, Suspended,
  // Umpire Review, ...) and hide the generic live state.
  const label = liveGameState && liveGameState !== 'In Progress' ? liveGameState : null;
  return label ? { tabLabel: label, bottomRowLabel: label } : { tabLabel: null, bottomRowLabel: null };
}

// Terminal game states after which the scorebug has nothing left to poll.
// "Final" is the standard MLB end-of-game value; "Game Over" and
// "Completed Early" cover feed variants for completed games.
const TERMINAL_GAME_STATES = new Set(['Final', 'Game Over', 'Completed Early'])

export const isGameTerminal = (gameState) => (
  gameState != null && TERMINAL_GAME_STATES.has(gameState)
)