import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_SECONDS,
  ARM_SECONDS,
  BOB_AMPLITUDE,
  BOB_WAVES,
  PLAY_RATE,
  PLAY_STEPS,
  SIT_SECONDS,
  STAND_FORWARD,
  STAND_HEIGHT,
  STAND_SECONDS,
  actPoseUp,
  armProgress,
  bannerReveal,
  bobAt,
  groupCycle,
  playStep,
  rowLift,
  rowStep,
  standProgress,
} from '../src/util/showMotion.js'

const near = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} should be ${expected}`)

test('the row stands up for its act and sits back down afterwards', () => {
  assert.equal(standProgress(0), 0, 'seated at the start')
  assert.ok(standProgress(0.1) > 0 && standProgress(0.1) < 0.4, 'rising')
  assert.equal(standProgress(STAND_SECONDS), 1, 'up')
  assert.equal(standProgress(ACTIVE_SECONDS / 2), 1, 'still up mid-act')
  assert.ok(standProgress(ACTIVE_SECONDS - SIT_SECONDS / 2) < 1, 'sitting down')
  assert.equal(standProgress(ACTIVE_SECONDS), 0, 'seated at the end')
  assert.equal(standProgress(ACTIVE_SECONDS + 3), 0, 'and through the idle')
  assert.equal(standProgress(-1), 0)
})

test('the wave is an integer number of crests, so both ends of the cloth ride together', () => {
  for (const time of [0, 0.7, 3.1, 11.4]) {
    near(bobAt(0, time), bobAt(1, time), 1e-12)
  }
  // Two crests across the row: the middle is a whole wavelength on (in step
  // with the ends) and the quarter points are the far side of the wave.
  near(bobAt(0, 1), bobAt(0.5, 1), 1e-12)
  near(bobAt(0.25, 1), -bobAt(0, 1), 1e-12)
  assert.equal(BOB_WAVES, 2)
  // It actually moves, and stays within the amplitude it advertises.
  let peak = 0
  for (let time = 0; time < 6; time += 0.01) peak = Math.max(peak, Math.abs(bobAt(0.25, time)))
  assert.ok(peak > BOB_AMPLITUDE * 0.95 && peak <= BOB_AMPLITUDE + 1e-9)
})

test('a fan stands up, rides the wave, and is perfectly still when its show is over', () => {
  const time = 2.2
  // The stand itself, before the wave is added.
  near(rowLift(STAND_SECONDS, time, 0), STAND_HEIGHT + bobAt(0, time), 1e-12)
  // Idle: no lift at all, wherever it stands along the row.
  for (const s of [0, 0.25, 0.5, 1]) {
    assert.equal(rowLift(ACTIVE_SECONDS, time, s), 0)
    assert.equal(rowLift(ACTIVE_SECONDS + 4, time, s), 0)
  }
  // Halfway through the rise, halfway up.
  const mid = rowLift(STAND_SECONDS / 2, time, 0.3)
  assert.ok(mid > 0 && mid < STAND_HEIGHT + BOB_AMPLITUDE)
})

test('the row raises its hands for its act and drops them between shows', () => {
  assert.equal(armProgress(0), 0, 'empty-handed at the start')
  assert.ok(armProgress(0.1) > 0 && armProgress(0.1) < 0.5, 'raising')
  assert.equal(armProgress(ARM_SECONDS), 1, 'up')
  assert.equal(armProgress(ACTIVE_SECONDS / 2), 1, 'still up mid-act')
  assert.equal(armProgress(ACTIVE_SECONDS), 0, 'down at the end')
  assert.equal(armProgress(ACTIVE_SECONDS + 2), 0, 'and through the idle')
  assert.equal(armProgress(-1), 0)

  // The pose swap is a step, and everything the act holds follows it: nothing
  // is ever displayed in a hand that has already come down.
  assert.equal(actPoseUp(0), false)
  assert.equal(actPoseUp(ACTIVE_SECONDS / 2), true)
  assert.equal(actPoseUp(ACTIVE_SECONDS), false)
})

test('the banner rises from its bottom edge and is folded away before the arms drop', () => {
  assert.equal(bannerReveal(0), 0, 'nothing in the hands yet')
  assert.ok(bannerReveal(0.6) > 0 && bannerReveal(0.6) < 1, 'rising out of the hands')
  assert.equal(bannerReveal(1.2), 1, 'fully up')
  assert.equal(bannerReveal(ACTIVE_SECONDS / 2), 1)
  // The row lowers the banner first, then its arms: at the moment the hands
  // start to drop the cloth is already gone.
  assert.equal(bannerReveal(ACTIVE_SECONDS - ARM_SECONDS), 0)
  assert.equal(armProgress(ACTIVE_SECONDS - ARM_SECONDS), 1)
  assert.equal(bannerReveal(ACTIVE_SECONDS), 0)
  assert.equal(bannerReveal(-1), 0)
})

test('a standing row steps out of its seats, and stays put between shows', () => {
  assert.equal(rowStep(0), 0)
  assert.ok(rowStep(STAND_SECONDS / 2) > 0 && rowStep(STAND_SECONDS / 2) < STAND_FORWARD)
  near(rowStep(STAND_SECONDS), STAND_FORWARD, 1e-12)
  assert.equal(rowStep(ACTIVE_SECONDS), 0)
  assert.equal(rowStep(ACTIVE_SECONDS + 3), 0)
})

test('the musicians play in whole steps, on a clock slow enough to see', () => {
  // A step lasts a sixth of a second, and the steps run 0, 1, 2, 3, 0 … — no
  // smooth interpolation, because the props are cut-outs that change pose.
  near(PLAY_RATE, 6)
  near(PLAY_STEPS, 4)
  for (let time = 0; time < 1; time += 0.01) {
    const step = playStep(time)
    assert.ok(Number.isInteger(step) && step >= 0 && step < PLAY_STEPS)
  }
  assert.equal(playStep(0), 0)
  assert.equal(playStep(0.1), 0)
  assert.equal(playStep(0.17), 1)
  assert.equal(playStep(0.34), 2)
  // It loops every four steps, and a phase offset shifts one player off the
  // beat of the next.
  assert.equal(playStep(0.6), 3)
  assert.equal(playStep(0.68), 0)
  assert.notEqual(playStep(0.1, 0.5), playStep(0.1))
})

test('each group runs its own act, off phase from its neighbours', () => {
  // Nothing is pinned in a test run, so the clock is the plain cycle.
  const at = (time, index) => groupCycle(time, index, `group-${index}`)
  const first = at(0, 0)
  assert.equal(first.active, true)
  assert.ok(first.t >= 0 && first.t < ACTIVE_SECONDS)
  assert.equal(at(ACTIVE_SECONDS + 1, 0).active, false, 'idle between acts')
  // Two neighbours are not in step: their periods differ.
  const periodOf = (index) => {
    for (let time = 0; time < 40; time += 0.05) {
      if (!at(time, index).active) return time
    }
    return null
  }
  assert.notEqual(periodOf(0), periodOf(1))
})
