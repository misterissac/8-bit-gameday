import test from 'node:test'
import assert from 'node:assert/strict'
import { scorebugStatusLabel, isGameTerminal } from '../src/util/scorebug.js'

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

test('scorebugStatusLabel falls back to the snapshot gameState when live status is missing', () => {
  const result = scorebugStatusLabel({ gameState: 'Final', liveStatus: null, pitcher: 'Max Fried', pitcherId: 1, frozen: false })
  assert.equal(tab(result), 'Final')
  assert.equal(row(result), 'Final')
})

test('scorebugStatusLabel surfaces a pitching change from the feed action-event flag', () => {
  // The backend surfaces pitching changes as an explicit flag (detected from
  // the feed's pitching_substitution action event), which is more reliable
  // than inferring from pitcher-identity comparison.
  const relief = liveStatus({
    pitcher: 'Relief Arm',
    pitcherId: 2,
    pitchingChange: true,
    pitchingChangePitcher: 'Relief Arm',
  })

  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: relief })
  // Tab gets the full label with position.
  assert.equal(tab(result), 'Pitching Change: Relief Arm (P)')
  // Bottom row gets the compact label.
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
  // Bottom row gets just the new player.
  assert.equal(row(result), 'Pinch Runner: Leo Rivas')
})

test('scorebugStatusLabel surfaces an ABS challenge', () => {
  const challenge = liveStatus({
    review: true,
    reviewIsOverturned: true,
    reviewChallenger: 'Ronald Acuna Jr.',
    reviewType: 'MJ',
  })
  const result = scorebugStatusLabel({ ...frozenBase, liveStatus: challenge })
  // Tab gets the full challenge detail.
  assert.equal(tab(result), 'ABS Challenge: Ronald Acuna Jr. — OVERTURNED')
  // Bottom row gets a compact label.
  assert.equal(row(result), 'Challenge Overturned')

  // When the review stands (not overturned).
  const stands = liveStatus({
    review: true,
    reviewIsOverturned: false,
    reviewChallenger: 'Batter',
    reviewType: 'MJ',
  })
  const standsResult = scorebugStatusLabel({ ...frozenBase, liveStatus: stands })
  assert.equal(tab(standsResult), 'ABS Challenge: Batter — STANDS')
  assert.equal(row(standsResult), 'Challenge Stands')
})

test('isGameTerminal recognizes only finished-game states', () => {
  assert.equal(isGameTerminal('Final'), true)
  assert.equal(isGameTerminal('Game Over'), true)
  assert.equal(isGameTerminal('Completed Early'), true)

  // Live or paused states must keep polling so the scorebug can catch the
  // next pitch, a delay ending, or the game eventually finishing.
  assert.equal(isGameTerminal('In Progress'), false)
  assert.equal(isGameTerminal('Rain Delay'), false)
  assert.equal(isGameTerminal('Suspended'), false)
  assert.equal(isGameTerminal(null), false)
  assert.equal(isGameTerminal(undefined), false)
})