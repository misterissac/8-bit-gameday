import test from 'node:test'
import assert from 'node:assert/strict'
import {
  contactCompletionAction,
  fielderCamNextState,
  shouldAutoAdvanceStuckPlay,
  CONTACT_COMPLETE_ARM,
  CONTACT_COMPLETE_FINISH,
} from '../src/util/battedBall.js'

// Run one completion against a fielder-cam state `{ armed, fired }` and return
// `{ action, next }`, threading the next state back for the caller — the same
// shape App.jsx's handlePlayComplete consumes.
function complete(state, overrides = {}) {
  const action = contactCompletionAction({
    isContactPlay: true,
    armed: state.armed,
    fired: state.fired,
    ...overrides,
  })
  return { action, next: fielderCamNextState(state, action) }
}

test('a contact play first completion arms the fielder-cam, second finishes', () => {
  // Fresh play: never armed, never fired.
  let s = { armed: false, fired: false }

  const first = complete(s)
  assert.equal(first.action, CONTACT_COMPLETE_ARM)
  assert.deepEqual(first.next, { armed: true, fired: true })

  // The play keeps looping in fielder cam; the next completion finishes it.
  s = first.next
  const second = complete(s)
  assert.equal(second.action, CONTACT_COMPLETE_FINISH)
  // Finish clears the armed flag but leaves the camera marked as fired.
  assert.deepEqual(second.next, { armed: false, fired: true })
})

test('contactCompletionAction defaults arm a fresh eligible contact play', () => {
  const action = contactCompletionAction({ isContactPlay: true, armed: false, fired: false })
  assert.equal(action, CONTACT_COMPLETE_ARM)
})

test('queued plays skip the fielder-cam and finish on the first completion', () => {
  const { action, next } = complete({ armed: false, fired: false }, { queuedPlays: true })
  assert.equal(action, CONTACT_COMPLETE_FINISH)
  assert.deepEqual(next, { armed: false, fired: false })
})

test('comparison mode skips the auto-fielder-cam and finishes at once', () => {
  const { action } = complete({ armed: false, fired: false }, { compareActive: true })
  assert.equal(action, CONTACT_COMPLETE_FINISH)
})

test('auto-fielder-cam disabled finishes on the first completion', () => {
  const { action, next } = complete({ armed: false, fired: false }, { autoFielderCam: false })
  assert.equal(action, CONTACT_COMPLETE_FINISH)
  assert.deepEqual(next, { armed: false, fired: false })
})

test('an already-fired camera never re-arms', () => {
  // e.g. the camera fired for an earlier play and wasn't reset.
  const { action } = complete({ armed: false, fired: true })
  assert.equal(action, CONTACT_COMPLETE_FINISH)
})

test('a non-contact play finishes normally and never arms', () => {
  const state = { armed: false, fired: false }
  const action = contactCompletionAction({ ...state, isContactPlay: false })
  assert.equal(action, CONTACT_COMPLETE_FINISH)
  // fielderCamNextState still just clears armed (no actual state to arm).
  assert.deepEqual(fielderCamNextState(state, action), { armed: false, fired: false })
})

// ── Gentle stuck-play auto-advance (missing Statcast hit) ───────────────────

test('stuck-play auto-advance fires only for a contacted, unlaunched play past its deadline', () => {
  assert.equal(
    shouldAutoAdvanceStuckPlay({
      contactSwing: true, launched: false, completeEmitted: false, deadlineExceeded: true,
    }),
    true,
  )
})

test('stuck-play auto-advance does NOT fire before the deadline (no early spoiling)', () => {
  // A merely-late Statcast hit hasn't exceeded the 30s window yet.
  assert.equal(
    shouldAutoAdvanceStuckPlay({
      contactSwing: true, launched: false, completeEmitted: false, deadlineExceeded: false,
    }),
    false,
  )
})

test('stuck-play auto-advance does NOT fire for a non-contact pitch', () => {
  assert.equal(
    shouldAutoAdvanceStuckPlay({
      contactSwing: false, launched: false, completeEmitted: false, deadlineExceeded: true,
    }),
    false,
  )
})

test('stuck-play auto-advance does NOT fire once the play already completed', () => {
  assert.equal(
    shouldAutoAdvanceStuckPlay({
      contactSwing: true, launched: false, completeEmitted: true, deadlineExceeded: true,
    }),
    false,
  )
})

test('stuck-play auto-advance does NOT fire in comparison mode', () => {
  assert.equal(
    shouldAutoAdvanceStuckPlay({
      contactSwing: true, launched: false, completeEmitted: false, deadlineExceeded: true, comparison: true,
    }),
    false,
  )
})

test('stuck-play auto-advance does NOT fire when the play did launch', () => {
  assert.equal(
    shouldAutoAdvanceStuckPlay({
      contactSwing: true, launched: true, completeEmitted: false, deadlineExceeded: true,
    }),
    false,
  )
})