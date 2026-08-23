import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldCycleWrapWatchdogFire } from '../src/util/battedBall.js'

// The cycle-wrap watchdog force-completes a launched play that never reached
// its endTime before the cycle wrapped, so the live queue can always advance.
// It must NEVER fire for a non-contact pitch (ball / take / whiff) even when
// launched.current is stale (true) from a prior contact pitch — the reset
// effect (now useLayoutEffect) closes the race window, but the contact.swing
// guard is the defense-in-depth that prevents a spurious OUT and queue wedge.

test('shouldCycleWrapWatchdogFire fires for a contact pitch that launched but did not complete', () => {
  assert.equal(
    shouldCycleWrapWatchdogFire({
      contactSwing: true,
      launched: true,
      completeEmitted: false,
      comparison: false,
    }),
    true,
  )
})

test('shouldCycleWrapWatchdogFire does NOT fire for a non-contact pitch (call_code B) even when launched is stale', () => {
  // This is the exact bug: a ball pitch (is_contact=false, contact.swing=false)
  // inherits launched=true from the previous contact pitch because the reset
  // effect hadn't run yet. The watchdog must not fire.
  assert.equal(
    shouldCycleWrapWatchdogFire({
      contactSwing: false, // ball / take / whiff
      launched: true,      // stale from the previous contact pitch
      completeEmitted: false,
      comparison: false,
    }),
    false,
  )
})

test('shouldCycleWrapWatchdogFire does NOT fire when already completed', () => {
  assert.equal(
    shouldCycleWrapWatchdogFire({
      contactSwing: true,
      launched: true,
      completeEmitted: true,
      comparison: false,
    }),
    false,
  )
})

test('shouldCycleWrapWatchdogFire does NOT fire in comparison mode', () => {
  assert.equal(
    shouldCycleWrapWatchdogFire({
      contactSwing: true,
      launched: true,
      completeEmitted: false,
      comparison: true,
    }),
    false,
  )
})

test('shouldCycleWrapWatchdogFire does NOT fire when nothing launched', () => {
  assert.equal(
    shouldCycleWrapWatchdogFire({
      contactSwing: true,
      launched: false,
      completeEmitted: false,
      comparison: false,
    }),
    false,
  )
})

test('shouldCycleWrapWatchdogFire treats undefined values as falsy (safe default)', () => {
  // If any field is missing (e.g. a malformed call), the watchdog must not fire.
  assert.equal(shouldCycleWrapWatchdogFire({}), false)
  assert.equal(shouldCycleWrapWatchdogFire(), false)
})
