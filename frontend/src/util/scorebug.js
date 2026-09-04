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
  review,
  reviewIsOverturned,
  reviewChallenger,
  reviewType,
  reviewTarget,
  reviewTeam,
}) => {
  const liveGameState = liveStatus?.gameState ?? gameState

  // ── Terminal game state (Final / Game Over / Completed Early) ─────────
  // A game that has ended must always surface the end-of-game label, ahead of
  // any action flag below. Action flags routinely linger in the feed past the
  // final play (a walk-off often ends while a mound visit / challenge / sub
  // flag is still set), and letting them win would leave the scoreboard stuck
  // announcing "Mound Visit" etc. instead of that the game is over — most
  // visible for walk-offs, which end before the inning completes.
  if (isGameTerminal(liveGameState)) {
    return { tabLabel: liveGameState, bottomRowLabel: liveGameState }
  }

  // ── Mound Visit ───────────────────────────────────────────────────────
  if (liveStatus?.moundVisit) return { tabLabel: 'Mound Visit', bottomRowLabel: 'Mound Visit' }

  // ── ABS Challenge / Managerial Challenge / Umpire Review ───────────────
  // Surface who challenged what, and whether the call stands or is overturned.
  const isReview = liveStatus?.review ?? review;
  if (isReview) {
    const overturned = liveStatus?.reviewIsOverturned !== undefined
      ? liveStatus.reviewIsOverturned
      : reviewIsOverturned;
    const rawType = liveStatus?.reviewType ?? reviewType ?? '';
    const challenger = liveStatus?.reviewChallenger ?? reviewChallenger ?? 'Batter';
    let target = liveStatus?.reviewTarget ?? reviewTarget ?? null;
    const team = liveStatus?.reviewTeam ?? reviewTeam ?? null;
    const teamTag = team ? ` (${team})` : '';

    // Determine category: ABS Challenge vs Manager Challenge vs Umpire Review
    let challengeKind = 'ABS Challenge';
    if (/manager|mgr|replay|crew|umpire/i.test(rawType) || /manager/i.test(challenger)) {
      challengeKind = /umpire|crew/i.test(rawType) ? 'Umpire Review' : 'Manager Challenge';
    } else if (target && !/strike|ball/i.test(target)) {
      challengeKind = 'Manager Challenge';
    }

    if (!target) {
      target = challengeKind === 'ABS Challenge' ? 'Called Strike' : 'Call on Field';
    }

    const challengerWithTeam = `${challenger}${teamTag}`;

    // Verdict phrasing: "Call Overturned", "Call Stands", or "Review In Progress"
    let resultText = 'Review In Progress';
    if (overturned === true) {
      resultText = 'Call Overturned';
    } else if (overturned === false) {
      resultText = 'Call Stands';
    }

    // Pop-up tab label: row 1 (who + what), row 2 (verdict)
    // Uses " — " as the separator so splitStatusLabel places the verdict on line 2.
    const tabLabel = `${challengeKind}: ${challengerWithTeam} (${target}) — ${resultText}`;

    // Game status rolling display: detailed summary describing who challenged what and the verdict
    // e.g. "ABS Challenge: Ronald Acuña Jr. challenges Called Strike — Call Overturned"
    const bottomRowLabel = `${challengeKind}: ${challengerWithTeam} challenges ${target} — ${resultText}`;

    return { tabLabel, bottomRowLabel };
  }

  // ── Pitching Change ───────────────────────────────────────────────────
  if (liveStatus?.pitchingChange) {
    const newP = liveStatus?.pitchingChangePitcher || liveStatus?.pitcher;
    const oldP = liveStatus?.pitchingChangeOldPitcher;
    const pos = liveStatus?.pitchingChangePosition || 'P';
    // Full text for the pop-up tab.
    let tabLabel;
    if (newP && oldP) tabLabel = `Pitching Change: ${newP} (${pos}) replaces ${oldP}`;
    else if (newP) tabLabel = `Pitching Change: ${newP} (${pos})`;
    else tabLabel = 'Pitching Change';
    // Rolling status bar text for the bottom-left row (includes swapped-out player).
    const bottomRowLabel = newP && oldP
      ? `Pitching Change: ${newP} replaces ${oldP}`
      : newP
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
    const newPosTag = (newPos && newPos !== 'PH' && newPos !== 'PR') ? ` (${newPos})` : '';
    // Full text for the pop-up tab.
    let tabLabel;
    if (sub && old) tabLabel = `${role}: ${sub}${newPosTag} replaces ${old}${oldPosTag}`;
    else if (sub) tabLabel = `${role}: ${sub}${newPosTag || oldPosTag}`;
    else tabLabel = role;
    // Rolling status bar text for the bottom-left row (includes swapped-out player + position abbreviation).
    const bottomRowLabel = sub && old
      ? `${role}: ${sub}${newPosTag} replaces ${old}${oldPosTag}`
      : sub
      ? `${role}: ${sub}${newPosTag || oldPosTag}`
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
    else if (sub) tabLabel = `Defensive Sub: ${sub}${newPosTag || oldPosTag}`;
    else tabLabel = 'Defensive Sub';
    // Rolling status bar text for the bottom-left row (includes swapped-out player + position abbreviation).
    const bottomRowLabel = sub && old
      ? `Defensive Sub: ${sub}${newPosTag} replaces ${old}${oldPosTag}`
      : sub
      ? `Defensive Sub: ${sub}${newPosTag || oldPosTag}`
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
const TERMINAL_GAME_STATES = new Set(['Final', 'Game Over', 'Completed Early', 'Final: Tied'])

export const isGameTerminal = (gameState) => (
  gameState != null && (
    TERMINAL_GAME_STATES.has(gameState) ||
    /^Final/i.test(String(gameState).trim()) ||
    /^Game Over/i.test(String(gameState).trim())
  )
)

// Inning label for the broadcast scorebug and games drawer. When a game has
// ended (terminal), it renders "Final" or "Final/<innings>" for extra innings,
// rather than an in-progress half-inning label (e.g. "▼ 11th" on a walk-off).
export const resolveInningLabel = (inning, isTerminal = false) => {
  if (isTerminal) {
    const num = Number(inning?.number);
    return Number.isFinite(num) && num > 9 ? `Final/${num}` : 'Final';
  }
  if (!inning?.ordinal) return '—';
  const state = inning.state;
  if (state === 'Middle') return `Mid ${inning.ordinal}`;
  if (state === 'End') return `End ${inning.ordinal}`;
  return `${inning.isTop ? '▲' : '▼'} ${inning.ordinal}`;
}

/**
 * Resolves the remaining ABS challenges for away and home teams (max 2).
 *
 * Rules:
 * - Each team starts regulation (innings 1–9) with 2 challenges.
 * - An unsuccessful challenge costs 1 challenge (clamped at 0).
 * - A successful challenge is retained.
 * - In extra innings (inning >= 10), challenges are refilled to 2.
 * - Replay/rewind mode, live feed, and finished games reflect the snapshot's state.
 *
 * @param {object|null|undefined} state - displayState object (from game-state or snapshot override)
 * @returns {{ away: number, home: number }} Challenges remaining for each team (0, 1, or 2)
 */
export const resolveABSChallenges = (state) => {
  const awayCh = state?.challenges?.away;
  const homeCh = state?.challenges?.home;

  if (typeof awayCh === 'number' && typeof homeCh === 'number') {
    return {
      away: Math.max(0, Math.min(2, Math.round(awayCh))),
      home: Math.max(0, Math.min(2, Math.round(homeCh))),
    };
  }

  // Fallback if challenges object is omitted (e.g. older snapshot/mock):
  // Default to 2 challenges. Extra innings (inning >= 10) also refill to 2.
  return {
    away: 2,
    home: 2,
  };
};

/**
 * Timing and velocity configuration for the bottom-left game status rolling ticker.
 * Requirements:
 * - Start rolling slowly after 2 seconds.
 * - Pause for 2 seconds upon reaching the end of the text.
 * - Reset to the beginning and repeat until the status expires.
 */
export const STATUS_ROLL_CONFIG = {
  startPauseMs: 2000,
  endPauseMs: 2000,
  speedPxPerSecond: 35,
};

/**
 * Computes roll duration in seconds based on text overflow.
 */
export const computeStatusRollDuration = (overflow, speed = STATUS_ROLL_CONFIG.speedPxPerSecond) => {
  if (!overflow || overflow <= 0) return 0;
  return Math.max(1.0, overflow / speed);
};

/**
 * Resolves the next animation phase in the scoreboard rolling status cycle:
 * 'idle' (pause 2s at start) -> 'rolling' (slow roll to end) -> 'paused_end' (pause 2s at end) -> 'idle' (reset to start and repeat).
 */
export const nextRollingStatusPhase = (phase) => {
  switch (phase) {
    case 'idle':
      return 'rolling';
    case 'rolling':
      return 'paused_end';
    case 'paused_end':
      return 'idle';
    default:
      return 'idle';
  }
};

/**
 * Checks whether a pointer/mouse/click event target is outside all given elements.
 * Returns false if the target is inside any provided container, true otherwise.
 */
export function isOutsideClick(event, ...elements) {
  const target = event?.target;
  if (!target) return true;
  for (const el of elements) {
    if (!el) continue;
    if (typeof el.contains === 'function' && el.contains(target)) {
      return false;
    }
  }
  return true;
}