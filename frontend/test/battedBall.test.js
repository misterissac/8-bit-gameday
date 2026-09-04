import test from 'node:test'
import assert from 'node:assert/strict'
import {
  contactCompletionAction,
  fielderCamNextState,
  shouldAutoAdvanceStuckPlay,
  shouldFielderCamFollow,
  shouldFielderCamRestore,
  getBaseTargetLocation,
  resolveFielderCamTarget,
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

// ── Fielder-cam catcher follow & automatic exit on completion ─────────────

test('shouldFielderCamFollow enables following for moving chaser or ball in flight', () => {
  assert.equal(shouldFielderCamFollow({ snapped: false, hasChaser: true, hasBall: true }), false)
  assert.equal(shouldFielderCamFollow({ snapped: true, hasChaser: true, hasBall: false }), true)
  assert.equal(shouldFielderCamFollow({ snapped: true, hasChaser: false, hasBall: true }), true)
  assert.equal(shouldFielderCamFollow({ snapped: true, hasChaser: false, hasBall: false }), false)
})

test('shouldFielderCamFollow enables following for catcher when ball is in play', () => {
  assert.equal(
    shouldFielderCamFollow({
      snapped: true,
      hasChaser: false,
      hasBall: true,
      fielderPosition: 'C',
    }),
    true,
  )
  assert.equal(
    shouldFielderCamFollow({
      snapped: true,
      hasChaser: false,
      hasBall: false,
      fielderPosition: 'C',
    }),
    false,
  )
})

test('shouldFielderCamRestore triggers camera exit on completion in both following and waiting states', () => {
  // When complete signal changes:
  assert.equal(shouldFielderCamRestore('following', true), true)
  assert.equal(shouldFielderCamRestore('waiting', true), true)

  // Does not trigger restore when play cycle has not finished:
  assert.equal(shouldFielderCamRestore('following', false), false)
  assert.equal(shouldFielderCamRestore('waiting', false), false)

  // Does not trigger restore when already idle or already restoring:
  assert.equal(shouldFielderCamRestore('idle', true), false)
  assert.equal(shouldFielderCamRestore('restoring', true), false)
})

// ── Fielder-cam bag look-at targeting (unassisted putouts) ─────────────────

test('getBaseTargetLocation resolves 1B, 2B, 3B, and home bag target locations', () => {
  const target1B = getBaseTargetLocation('1B')
  assert.equal(target1B.y, 0.05)
  assert.ok(target1B.x > 15)
  assert.ok(target1B.z < -15)

  const target2B = getBaseTargetLocation('2B')
  assert.equal(target2B.y, 0.05)
  assert.equal(target2B.x, 0)
  assert.ok(target2B.z < -30)

  const target3B = getBaseTargetLocation('3B')
  assert.equal(target3B.y, 0.05)
  assert.ok(target3B.x < -15)
  assert.ok(target3B.z < -15)

  const targetHome = getBaseTargetLocation('home')
  assert.equal(targetHome.y, 0.012)
  assert.equal(targetHome.x, 0)

  const targetScore = getBaseTargetLocation('score')
  assert.equal(targetScore.y, 0.012)
  assert.equal(targetScore.x, 0)

  // Fallback location
  const customFallback = { x: 10, y: 0, z: -10 }
  const targetCustom = getBaseTargetLocation('custom', customFallback)
  assert.deepEqual(targetCustom, { x: 10, y: 0.05, z: -10 })
})

test('resolveFielderCamTarget returns null before ball is received or when no bag target exists', () => {
  const bag = getBaseTargetLocation('1B')
  const catchLocation = { x: 15, y: 0, z: -18 }

  // No bag target (e.g. fly ball caught or throw)
  assert.equal(resolveFielderCamTarget({
    t: 2.0,
    ballCatchTime: 1.0,
    stepOnBagTarget: null,
    catchLocation,
  }), null)

  // Ball is still in flight (t < ballCatchTime)
  assert.equal(resolveFielderCamTarget({
    t: 0.8,
    ballCatchTime: 1.2,
    stepOnBagTarget: bag,
    catchLocation,
  }), null)

  // Missing or invalid inputs
  assert.equal(resolveFielderCamTarget({ t: null, ballCatchTime: 1.0, stepOnBagTarget: bag }), null)
  assert.equal(resolveFielderCamTarget({ t: 1.5, ballCatchTime: null, stepOnBagTarget: bag }), null)
})

test('resolveFielderCamTarget starts at catch location and smoothly eases to the bag', () => {
  const bag = { x: 20, y: 0.05, z: -20 }
  const catchLocation = { x: 10, y: 0.1, z: -10 }
  const ballCatchTime = 1.0
  const duration = 2.0

  // At the moment of catch (t == ballCatchTime), target is at the catch location
  const startTarget = resolveFielderCamTarget({
    t: ballCatchTime,
    ballCatchTime,
    stepOnBagTarget: bag,
    catchLocation,
    duration,
    transitionDuration: 0.3,
  })
  assert.ok(Math.abs(startTarget.x - catchLocation.x) < 1e-4)
  assert.ok(Math.abs(startTarget.y - catchLocation.y) < 1e-4)
  assert.ok(Math.abs(startTarget.z - catchLocation.z) < 1e-4)

  // Mid transition (t = ballCatchTime + 0.15), target is between catch location and bag
  const midTarget = resolveFielderCamTarget({
    t: ballCatchTime + 0.15,
    ballCatchTime,
    stepOnBagTarget: bag,
    catchLocation,
    duration,
    transitionDuration: 0.3,
  })
  assert.ok(midTarget.x > catchLocation.x && midTarget.x < bag.x)
  assert.ok(midTarget.z < catchLocation.z && midTarget.z > bag.z)

  // Once transition completes (t >= ballCatchTime + 0.3), target locks onto the bag
  const lockedTarget = resolveFielderCamTarget({
    t: ballCatchTime + 0.3,
    ballCatchTime,
    stepOnBagTarget: bag,
    catchLocation,
    duration,
    transitionDuration: 0.3,
  })
  assert.ok(Math.abs(lockedTarget.x - bag.x) < 1e-4)
  assert.ok(Math.abs(lockedTarget.y - bag.y) < 1e-4)
  assert.ok(Math.abs(lockedTarget.z - bag.z) < 1e-4)

  // Stays locked on the bag for the rest of the walk to the base
  const walkTarget = resolveFielderCamTarget({
    t: ballCatchTime + 1.5,
    ballCatchTime,
    stepOnBagTarget: bag,
    catchLocation,
    duration,
    transitionDuration: 0.3,
  })
  assert.ok(Math.abs(walkTarget.x - bag.x) < 1e-4)
  assert.ok(Math.abs(walkTarget.y - bag.y) < 1e-4)
  assert.ok(Math.abs(walkTarget.z - bag.z) < 1e-4)
})