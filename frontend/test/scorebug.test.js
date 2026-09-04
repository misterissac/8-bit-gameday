import test from 'node:test'
import assert from 'node:assert/strict'
import {
  scorebugStatusLabel,
  isGameTerminal,
  resolveInningLabel,
  resolveABSChallenges,
  STATUS_ROLL_CONFIG,
  computeStatusRollDuration,
  nextRollingStatusPhase,
  isOutsideClick,
} from '../src/util/scorebug.js'

const liveStatus = (overrides = {}) => ({
  gameState: 'In Progress',
  pitcher: 'Max Fried',
  pitcherId: 1,
  ...overrides,
})

const frozenBase = {
  gameState: 'In Progress',
  pitcher: 'Max Fried',
  pitcherId: 1,
  frozen: true,
}

// Helper: the function now returns { tabLabel, bottomRowLabel }; extract the
// field the previous tests cared about. For most cases they're the same.
const tab = (result) => result?.tabLabel ?? null
const row = (result) => result?.bottomRowLabel ?? null

test('scorebugStatusLabel hides during normal in-progress play', () => {
  assert.equal(
    tab(scorebugStatusLabel({ ...frozenBase, liveStatus: liveStatus() })),
    null,
  )
})

test('scorebugStatusLabel shows a non-progress state and clears when play resumes', () => {
  const delayed = scorebugStatusLabel({
    ...frozenBase,
    liveStatus: liveStatus({ gameState: 'Rain Delay' }),
  })
  assert.equal(tab(delayed), 'Rain Delay')
  assert.equal(row(delayed), 'Rain Delay')

  const resumed = scorebugStatusLabel({
    ...frozenBase,
    liveStatus: liveStatus({ gameState: 'In Progress' }),
  })
  assert.equal(tab(resumed), null)
})

test('scorebugStatusLabel updates to Final when the game ends', () => {
  const result = scorebugStatusLabel({
    ...frozenBase,
    liveStatus: liveStatus({ gameState: 'Final' }),
  })
  assert.equal(tab(result), 'Final')
  assert.equal(row(result), 'Final')
})

test('terminal Game Over wins over a lingering mound visit (walk-off end)', () => {
  // A walk-off ends the game before the inning completes; the feed routinely
  // keeps the mound-visit flag set into the Final state, so the end-of-game
  // label must beat the stale action flag or the game never reads as over.
  const result = scorebugStatusLabel({
    ...frozenBase,
    liveStatus: liveStatus({ gameState: 'Game Over', moundVisit: true }),
  })
  assert.equal(tab(result), 'Game Over')
  assert.equal(row(result), 'Game Over')
})

test('terminal Final wins over stale pitching-change / review flags', () => {
  const changing = scorebugStatusLabel({
    ...frozenBase,
    liveStatus: liveStatus({ gameState: 'Final', pitchingChange: true, pitchingChangePitcher: 'X' }),
  })
  assert.equal(tab(changing), 'Final')

  const reviewed = scorebugStatusLabel({
    ...frozenBase,
    liveStatus: liveStatus({ gameState: 'Final', review: true, reviewChallenger: 'Team' }),
  })
  assert.equal(tab(reviewed), 'Final')
})

test('action flags still win while the game is in progress', () => {
  const result = scorebugStatusLabel({
    ...frozenBase,
    liveStatus: liveStatus({ gameState: 'In Progress', moundVisit: true }),
  })
  assert.equal(tab(result), 'Mound Visit')
  assert.equal(row(result), 'Mound Visit')
})

test('scorebugStatusLabel falls back to the snapshot gameState when live status is missing', () => {
  const result = scorebugStatusLabel({ gameState: 'Final', liveStatus: null, pitcher: 'Max Fried', pitcherId: 1, frozen: false })
  assert.equal(tab(result), 'Final')
  assert.equal(row(result), 'Final')
})

test('scorebugStatusLabel surfaces a pitching change from the feed action-event flag', () => {
  // The backend surfaces pitching changes as an explicit flag (detected from
  // the feed's pitching_substitution action event), which is more reliable
  // than inferring from pitcher-identity comparison.
  const reliefWithOld = liveStatus({
    pitcher: 'Braydon Fisher',
    pitcherId: 2,
    pitchingChange: true,
    pitchingChangePitcher: 'Braydon Fisher',
    pitchingChangeOldPitcher: 'Dylan Cease',
  })

  const resultWithOld = scorebugStatusLabel({ ...frozenBase, liveStatus: reliefWithOld })
  // Tab gets the full label with position.
  assert.equal(tab(resultWithOld), 'Pitching Change: Braydon Fisher (P) replaces Dylan Cease')
  // Rolling bottom row includes the swapped-out player.
  assert.equal(row(resultWithOld), 'Pitching Change: Braydon Fisher replaces Dylan Cease')

  // When old pitcher is missing, fall back to new pitcher name only.
  const relief = liveStatus({
    pitcher: 'Relief Arm',
    pitcherId: 2,
    pitchingChange: true,
    pitchingChangePitcher: 'Relief Arm',
  })

  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: relief })
  assert.equal(tab(result), 'Pitching Change: Relief Arm (P)')
  assert.equal(row(result), 'Pitching Change: Relief Arm')

  // Without the flag, a different pitcher alone must not read as a change
  // (the defensive team swaps at inning breaks without a substitution).
  const noFlag = liveStatus({ pitcher: 'Relief Arm', pitcherId: 2 })
  assert.equal(
    tab(scorebugStatusLabel({ ...frozenBase, liveStatus: noFlag })),
    null,
  )
})

test('scorebugStatusLabel surfaces a mound visit', () => {
  const mound = liveStatus({ moundVisit: true })
  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: mound })
  assert.equal(tab(result), 'Mound Visit')
  assert.equal(row(result), 'Mound Visit')
})

test('scorebugStatusLabel surfaces a pinch hitter/runner substitution', () => {
  const pinch = liveStatus({
    offensiveSub: true,
    offensiveSubRole: 'Pinch Runner',
    offensiveSubNew: 'Leo Rivas',
    offensiveSubOld: 'Taylor Ward',
  })
  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: pinch })
  // Tab gets the full replacement detail.
  assert.equal(tab(result), 'Pinch Runner: Leo Rivas replaces Taylor Ward')
  // Rolling bottom row includes the swapped-out player.
  assert.equal(row(result), 'Pinch Runner: Leo Rivas replaces Taylor Ward')
})

test('scorebugStatusLabel surfaces a pinch hitter/runner substitution with position abbreviation', () => {
  const pinch = liveStatus({
    offensiveSub: true,
    offensiveSubRole: 'Pinch Hitter',
    offensiveSubNew: 'David Hensley',
    offensiveSubOld: 'Trent Grisham',
    offensiveSubPosition: 'CF',
  })
  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: pinch })
  assert.equal(tab(result), 'Pinch Hitter: David Hensley replaces Trent Grisham (CF)')
  assert.equal(row(result), 'Pinch Hitter: David Hensley replaces Trent Grisham (CF)')

  // Pinch runner replacing a shortstop (SS)
  const runner = liveStatus({
    offensiveSub: true,
    offensiveSubRole: 'Pinch Runner',
    offensiveSubNew: 'Leo Rivas',
    offensiveSubOld: 'Bo Bichette',
    offensiveSubPosition: 'SS',
  })
  const runnerResult = scorebugStatusLabel({ ...frozenBase, liveStatus: runner })
  assert.equal(tab(runnerResult), 'Pinch Runner: Leo Rivas replaces Bo Bichette (SS)')
  assert.equal(row(runnerResult), 'Pinch Runner: Leo Rivas replaces Bo Bichette (SS)')
})

test('scorebugStatusLabel surfaces a defensive substitution', () => {
  const defSub = liveStatus({
    defensiveSub: true,
    defensiveSubNew: 'Enrique Hernandez',
    defensiveSubOld: 'Andy Pages',
  })
  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: defSub })
  assert.equal(tab(result), 'Defensive Sub: Enrique Hernandez replaces Andy Pages')
  assert.equal(row(result), 'Defensive Sub: Enrique Hernandez replaces Andy Pages')
})

test('scorebugStatusLabel surfaces a defensive substitution with position abbreviations', () => {
  const defSub = liveStatus({
    defensiveSub: true,
    defensiveSubNew: 'Enrique Hernandez',
    defensiveSubNewPosition: 'CF',
    defensiveSubOld: 'Andy Pages',
    defensiveSubPosition: 'CF',
  })
  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: defSub })
  assert.equal(tab(result), 'Defensive Sub: Enrique Hernandez (CF) replaces Andy Pages (CF)')
  assert.equal(row(result), 'Defensive Sub: Enrique Hernandez (CF) replaces Andy Pages (CF)')
})

test('scorebugStatusLabel surfaces detailed ABS challenge (who, what, call stands/overturned)', () => {
  const challenge = liveStatus({
    review: true,
    reviewIsOverturned: true,
    reviewChallenger: 'Ronald Acuna Jr.',
    reviewType: 'MJ',
  })
  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: challenge })
  // Tab gets who, what, and the call result (separated by " — " for multi-line split).
  assert.equal(tab(result), 'ABS Challenge: Ronald Acuna Jr. (Called Strike) — Call Overturned')
  // Rolling bottom row gets the full detailed sentence.
  assert.equal(row(result), 'ABS Challenge: Ronald Acuna Jr. challenges Called Strike — Call Overturned')

  // When the review stands (not overturned).
  const stands = liveStatus({
    review: true,
    reviewIsOverturned: false,
    reviewChallenger: 'Batter',
    reviewType: 'MJ',
  })
  const standsResult = scorebugStatusLabel({ ...frozenBase, liveStatus: stands })
  assert.equal(tab(standsResult), 'ABS Challenge: Batter (Called Strike) — Call Stands')
  assert.equal(row(standsResult), 'ABS Challenge: Batter challenges Called Strike — Call Stands')

  // Catcher challenges a called ball
  const ballChallenge = liveStatus({
    review: true,
    reviewIsOverturned: true,
    reviewChallenger: 'Adley Rutschman',
    reviewTarget: 'Called Ball',
    reviewType: 'MJ',
  })
  const ballResult = scorebugStatusLabel({ ...frozenBase, liveStatus: ballChallenge })
  assert.equal(tab(ballResult), 'ABS Challenge: Adley Rutschman (Called Ball) — Call Overturned')
  assert.equal(row(ballResult), 'ABS Challenge: Adley Rutschman challenges Called Ball — Call Overturned')

  // Review in progress
  const inProgress = liveStatus({
    review: true,
    reviewIsOverturned: null,
    reviewChallenger: 'Aaron Judge',
    reviewTarget: 'Called Strike',
    reviewType: 'MJ',
  })
  const inProgressResult = scorebugStatusLabel({ ...frozenBase, liveStatus: inProgress })
  assert.equal(tab(inProgressResult), 'ABS Challenge: Aaron Judge (Called Strike) — Review In Progress')
  assert.equal(row(inProgressResult), 'ABS Challenge: Aaron Judge challenges Called Strike — Review In Progress')
})

test('scorebugStatusLabel surfaces detailed Managerial challenge (who, what, call stands/overturned)', () => {
  const mgrChallenge = liveStatus({
    review: true,
    reviewIsOverturned: false,
    reviewChallenger: 'Dave Roberts',
    reviewTarget: 'Safe at 1B',
    reviewType: 'Manager',
  })
  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: mgrChallenge })
  assert.equal(tab(result), 'Manager Challenge: Dave Roberts (Safe at 1B) — Call Stands')
  assert.equal(row(result), 'Manager Challenge: Dave Roberts challenges Safe at 1B — Call Stands')

  const mgrOverturned = liveStatus({
    review: true,
    reviewIsOverturned: true,
    reviewChallenger: 'Aaron Boone',
    reviewTeam: 'NYY',
    reviewTarget: 'Out at 2B',
    reviewType: 'Manager',
  })
  const ovResult = scorebugStatusLabel({ ...frozenBase, liveStatus: mgrOverturned })
  assert.equal(tab(ovResult), 'Manager Challenge: Aaron Boone (NYY) (Out at 2B) — Call Overturned')
  assert.equal(row(ovResult), 'Manager Challenge: Aaron Boone (NYY) challenges Out at 2B — Call Overturned')
})

test('isGameTerminal recognizes only finished-game states', () => {
  assert.equal(isGameTerminal('Final'), true)
  assert.equal(isGameTerminal('Game Over'), true)
  assert.equal(isGameTerminal('Completed Early'), true)
  assert.equal(isGameTerminal('Final: Tied'), true)
  assert.equal(isGameTerminal('Final/11'), true)

  // Live or paused states must keep polling so the scorebug can catch the
  // next pitch, a delay ending, or the game eventually finishing.
  assert.equal(isGameTerminal('In Progress'), false)
  assert.equal(isGameTerminal('Rain Delay'), false)
  assert.equal(isGameTerminal('Suspended'), false)
  assert.equal(isGameTerminal(null), false)
  assert.equal(isGameTerminal(undefined), false)
})

test('resolveInningLabel formats terminal games as Final or Final/<innings> (walk-offs)', () => {
  // A walk-off in the bottom of the 11th ends the game with inning.state = 'Bottom'.
  // When terminal, it must render Final/11 instead of ▼ 11th.
  assert.equal(
    resolveInningLabel({ number: 11, ordinal: '11th', state: 'Bottom', isTop: false }, true),
    'Final/11',
  )
  // A walk-off in the 9th must render Final instead of ▼ 9th.
  assert.equal(
    resolveInningLabel({ number: 9, ordinal: '9th', state: 'Bottom', isTop: false }, true),
    'Final',
  )
  // Normal in-progress states
  assert.equal(
    resolveInningLabel({ number: 11, ordinal: '11th', state: 'Bottom', isTop: false }, false),
    '▼ 11th',
  )
  assert.equal(
    resolveInningLabel({ number: 7, ordinal: '7th', state: 'Top', isTop: true }, false),
    '▲ 7th',
  )
  assert.equal(
    resolveInningLabel({ number: 7, ordinal: '7th', state: 'Middle', isTop: false }, false),
    'Mid 7th',
  )
  assert.equal(
    resolveInningLabel({ number: 7, ordinal: '7th', state: 'End', isTop: false }, false),
    'End 7th',
  )
  assert.equal(resolveInningLabel(null, false), '—')
})

test('resolveABSChallenges defaults to 2 challenges per team in regulation', () => {
  const result = resolveABSChallenges({ inning: { number: 3 } })
  assert.deepEqual(result, { away: 2, home: 2 })
})

test('resolveABSChallenges uses state challenges and clamps to [0, 2]', () => {
  assert.deepEqual(
    resolveABSChallenges({ challenges: { away: 1, home: 2 } }),
    { away: 1, home: 2 },
  )
  assert.deepEqual(
    resolveABSChallenges({ challenges: { away: 0, home: 1 } }),
    { away: 0, home: 1 },
  )
  // Clamping
  assert.deepEqual(
    resolveABSChallenges({ challenges: { away: -1, home: 5 } }),
    { away: 0, home: 2 },
  )
})

test('resolveABSChallenges refills to 2 in extra innings when challenges object missing', () => {
  const result = resolveABSChallenges({ inning: { number: 10 } })
  assert.deepEqual(result, { away: 2, home: 2 })
})

test('resolveABSChallenges reflects historical snapshot challenges during replay/rewind', () => {
  const historicalSnapshotEarly = {
    inning: { number: 2 },
    challenges: { away: 2, home: 2 },
  }
  assert.deepEqual(resolveABSChallenges(historicalSnapshotEarly), { away: 2, home: 2 })

  const historicalSnapshotLate = {
    inning: { number: 7 },
    challenges: { away: 1, home: 0 },
  }
  assert.deepEqual(resolveABSChallenges(historicalSnapshotLate), { away: 1, home: 0 })

  const historicalSnapshotExtras = {
    inning: { number: 10 },
    challenges: { away: 2, home: 2 },
  }
  assert.deepEqual(resolveABSChallenges(historicalSnapshotExtras), { away: 2, home: 2 })
})

test('STATUS_ROLL_CONFIG defines 2s start pause, slow roll, and 2s end pause', () => {
  assert.equal(STATUS_ROLL_CONFIG.startPauseMs, 2000, 'must pause for 2s before rolling')
  assert.equal(STATUS_ROLL_CONFIG.endPauseMs, 2000, 'must pause for 2s when reaching end of text')
  assert.equal(STATUS_ROLL_CONFIG.speedPxPerSecond, 35, 'must roll slowly at broadcast speed')
})

test('computeStatusRollDuration calculates roll duration and handles bounds', () => {
  assert.equal(computeStatusRollDuration(0), 0)
  assert.equal(computeStatusRollDuration(-20), 0)
  assert.equal(computeStatusRollDuration(null), 0)

  // 140px at 35px/s = 4.0s
  assert.equal(computeStatusRollDuration(140, 35), 4.0)

  // Clamps to at least 1.0s for small overflows to prevent abrupt flashes
  assert.equal(computeStatusRollDuration(10, 35), 1.0)
})

test('nextRollingStatusPhase cycles from start pause to roll to end pause to reset and repeats', () => {
  // 1. Starts in idle (sits at beginning for 2s)
  let phase = 'idle'

  // 2. Starts rolling slowly
  phase = nextRollingStatusPhase(phase)
  assert.equal(phase, 'rolling', 'transitions to rolling after start pause')

  // 3. Reaches end of text, pauses for 2s
  phase = nextRollingStatusPhase(phase)
  assert.equal(phase, 'paused_end', 'transitions to paused_end when reaching end')

  // 4. Resets to beginning (idle) and pauses for 2s before repeating
  phase = nextRollingStatusPhase(phase)
  assert.equal(phase, 'idle', 'resets to beginning (idle)')

  // 5. Cycles again (repetition until status expires)
  phase = nextRollingStatusPhase(phase)
  assert.equal(phase, 'rolling', 'repeats rolling cycle')
  phase = nextRollingStatusPhase(phase)
  assert.equal(phase, 'paused_end', 'repeats paused_end')
  phase = nextRollingStatusPhase(phase)
  assert.equal(phase, 'idle', 'repeats idle reset')
})

test('isOutsideClick detects clicks outside containers', () => {
  const button = { contains: (target) => target.id === 'box-button' }
  const panel = { contains: (target) => target.id === 'box-panel-child' }

  // Target outside both button and panel
  assert.equal(isOutsideClick({ target: { id: 'field-canvas' } }, button, panel), true)
  assert.equal(isOutsideClick({ target: { id: 'scoreboard' } }, button, panel), true)

  // Target inside button
  assert.equal(isOutsideClick({ target: { id: 'box-button' } }, button, panel), false)

  // Target inside panel
  assert.equal(isOutsideClick({ target: { id: 'box-panel-child' } }, button, panel), false)
})

test('isOutsideClick handles edge cases gracefully', () => {
  const panel = { contains: () => false }
  assert.equal(isOutsideClick(null, panel), true)
  assert.equal(isOutsideClick({}, panel), true)
  assert.equal(isOutsideClick({ target: {} }, null, undefined, panel), true)
})