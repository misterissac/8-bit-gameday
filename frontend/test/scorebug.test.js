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

test('scorebugStatusLabel hides during normal in-progress play', () => {
  assert.equal(
    scorebugStatusLabel({ ...frozenBase, liveStatus: liveStatus() }),
    null,
  )
})

test('scorebugStatusLabel shows a non-progress state and clears when play resumes', () => {
  const delayed = scorebugStatusLabel({
    ...frozenBase,
    liveStatus: liveStatus({ gameState: 'Rain Delay' }),
  })
  assert.equal(delayed, 'Rain Delay')

  const resumed = scorebugStatusLabel({
    ...frozenBase,
    liveStatus: liveStatus({ gameState: 'In Progress' }),
  })
  assert.equal(resumed, null)
})

test('scorebugStatusLabel updates to Final when the game ends', () => {
  assert.equal(
    scorebugStatusLabel({
      ...frozenBase,
      liveStatus: liveStatus({ gameState: 'Final' }),
    }),
    'Final',
  )
})

test('scorebugStatusLabel falls back to the snapshot gameState when live status is missing', () => {
  assert.equal(
    scorebugStatusLabel({ gameState: 'Final', liveStatus: null, pitcher: 'Max Fried', pitcherId: 1, frozen: false }),
    'Final',
  )
})

test('scorebugStatusLabel surfaces a pitching change only while frozen', () => {
  const relief = liveStatus({ pitcher: 'Relief Arm', pitcherId: 2 })

  assert.equal(
    scorebugStatusLabel({ ...frozenBase, liveStatus: relief }),
    'Pitching Change',
  )

  // Unfrozen, the full state fetch is authoritative and the pitcher already
  // reflects the change, so no override label is needed.
  assert.equal(
    scorebugStatusLabel({ ...frozenBase, frozen: false, liveStatus: relief }),
    null,
  )
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
