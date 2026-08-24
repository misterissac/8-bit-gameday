import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BroadcastDelayBuffer,
  MAX_BROADCAST_DELAY_SECONDS,
  normalizeBroadcastDelaySeconds,
} from '../src/util/broadcastDelay.js'

const makeClock = (start = 0) => {
  let now = start
  const timers = []
  const schedule = (callback, wait) => {
    const timer = { callback, at: now + wait, cancelled: false }
    timers.push(timer)
    return timer
  }
  const cancel = (timer) => {
    if (timer) timer.cancelled = true
  }
  const advanceTo = (target) => {
    while (true) {
      const next = timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!next) break
      next.cancelled = true
      now = next.at
      next.callback()
    }
    now = target
  }
  return { now: () => now, schedule, cancel, advanceTo }
}

test('normalizeBroadcastDelaySeconds clamps invalid, negative, and excessive values', () => {
  assert.equal(normalizeBroadcastDelaySeconds(undefined), 0)
  assert.equal(normalizeBroadcastDelaySeconds(''), 0)
  assert.equal(normalizeBroadcastDelaySeconds('10'), 10)
  assert.equal(normalizeBroadcastDelaySeconds(-5), 0)
  assert.equal(
    normalizeBroadcastDelaySeconds(MAX_BROADCAST_DELAY_SECONDS + 1),
    MAX_BROADCAST_DELAY_SECONDS,
  )
})

test('BroadcastDelayBuffer does not release a value before the full delay', () => {
  const clock = makeClock(1000)
  const released = []
  const buffer = new BroadcastDelayBuffer(
    (value) => released.push({ value, at: clock.now() }),
    { delayMs: 10_000, now: clock.now, schedule: clock.schedule, cancel: clock.cancel },
  )

  buffer.enqueue('play-1', 'pitch', { version: 'v1' })
  clock.advanceTo(10_999)
  assert.deepEqual(released, [])

  clock.advanceTo(11_000)
  assert.deepEqual(released, [{ value: 'pitch', at: 11_000 }])
})

test('coalesced enrichment stays delayed from the latest update without spoiling the play', () => {
  const clock = makeClock(0)
  const released = []
  const buffer = new BroadcastDelayBuffer(
    (value) => released.push({ value, at: clock.now() }),
    { delayMs: 10_000, now: clock.now, schedule: clock.schedule, cancel: clock.cancel },
  )

  buffer.enqueue('play-1', 'initial', { version: 'initial' })
  clock.advanceTo(2_000)
  buffer.enqueue('play-1', 'resolved', { version: 'resolved' })
  clock.advanceTo(11_999)
  assert.deepEqual(released, [])

  clock.advanceTo(12_000)
  assert.deepEqual(released, [{ value: 'resolved', at: 12_000 }])
})

test('distinct snapshots retain independent deadlines instead of resetting a stream', () => {
  const clock = makeClock(0)
  const released = []
  const buffer = new BroadcastDelayBuffer(
    (value) => released.push({ value, at: clock.now() }),
    { delayMs: 10_000, now: clock.now, schedule: clock.schedule, cancel: clock.cancel },
  )

  buffer.enqueue('score', 'old', { version: 'old', coalesce: false })
  clock.advanceTo(1_000)
  buffer.enqueue('score', 'new', { version: 'new', coalesce: false })
  clock.advanceTo(10_000)
  assert.deepEqual(released, [{ value: 'old', at: 10_000 }])
  clock.advanceTo(11_000)
  assert.deepEqual(released, [
    { value: 'old', at: 10_000 },
    { value: 'new', at: 11_000 },
  ])
})

test('changing the setting re-anchors pending values to the new delay', () => {
  const clock = makeClock(0)
  const released = []
  const buffer = new BroadcastDelayBuffer(
    (value) => released.push({ value, at: clock.now() }),
    { delayMs: 10_000, now: clock.now, schedule: clock.schedule, cancel: clock.cancel },
  )

  buffer.enqueue('play-1', 'pitch', { version: 'v1' })
  clock.advanceTo(2_000)
  buffer.setDelay(3_000)
  clock.advanceTo(4_999)
  assert.deepEqual(released, [])
  clock.advanceTo(5_000)
  assert.deepEqual(released, [{ value: 'pitch', at: 5_000 }])
})
