import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BroadcastDelayBuffer,
  normalizeBroadcastDelaySeconds,
} from '../src/util/broadcastDelay.js'

const FEED_SURFACES = ['play', 'battedBall', 'scorebug', 'status']

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

// A tiny fake of the four live-feed response paths. The application uses
// separate buffers for plays, batted balls, scorebug snapshots, and status
// notices because those responses have different coalescing rules. This
// harness deliberately keeps that topology while feeding every buffer the same
// configured delay and fake clock, making this an integration test of the
// release boundary rather than another single-buffer unit test.
class FakeLiveFeed {
  constructor({ delaySeconds, clock }) {
    this.clock = clock
    this.released = []
    const delayMs = normalizeBroadcastDelaySeconds(delaySeconds) * 1000
    this.buffers = Object.fromEntries(
      FEED_SURFACES.map((surface) => [
        surface,
        new BroadcastDelayBuffer(
          ({ eventId, payload }) => {
            this.released.push({
              surface,
              eventId,
              payload,
              receivedAt: payload.receivedAt,
              releasedAt: this.clock.now(),
            })
          },
          {
            delayMs,
            now: clock.now,
            schedule: clock.schedule,
            cancel: clock.cancel,
          },
        ),
      ]),
    )
  }

  // Simulates one poll cycle receiving the same feed event from each endpoint.
  // The payloads intentionally resemble the separate response data each
  // production consumer receives, rather than sharing one object by reference.
  receiveFeedEvent(event) {
    for (const surface of FEED_SURFACES) {
      const payload = {
        ...event[surface],
        receivedAt: this.clock.now(),
      }
      this.buffers[surface].enqueue(
        `${event.id}:${surface}`,
        { eventId: event.id, payload },
        {
          version: event.id,
          // Each endpoint response is a distinct event. This matches the
          // scorebug/status paths, which must not collapse successive snapshots
          // into one update while they are waiting behind the delay.
          coalesce: false,
        },
      )
    }
  }
}

test('fake live feed releases play, batted ball, scorebug, and status together after the configured delay', () => {
  const clock = makeClock(1_000)
  const feed = new FakeLiveFeed({ delaySeconds: 10, clock })

  feed.receiveFeedEvent({
    id: 'play-42',
    play: { playId: 'play-42', kind: 'trajectory' },
    battedBall: { playId: 'play-42', launchSpeed: 101.4 },
    scorebug: { playId: 'play-42', awayRuns: 3, homeRuns: 2 },
    status: { playId: 'play-42', notice: 'Pitching Change: Relief Arm' },
  })

  clock.advanceTo(10_999)
  assert.deepEqual(feed.released, [])

  clock.advanceTo(11_000)
  assert.deepEqual(
    feed.released.map(({ surface, eventId, receivedAt, releasedAt }) => ({
      surface,
      eventId,
      receivedAt,
      releasedAt,
    })),
    FEED_SURFACES.map((surface) => ({
      surface,
      eventId: 'play-42',
      receivedAt: 1_000,
      releasedAt: 11_000,
    })),
  )
  assert.equal(feed.released.find(({ surface }) => surface === 'play').payload.kind, 'trajectory')
  assert.equal(feed.released.find(({ surface }) => surface === 'battedBall').payload.launchSpeed, 101.4)
  assert.equal(feed.released.find(({ surface }) => surface === 'scorebug').payload.awayRuns, 3)
  assert.equal(
    feed.released.find(({ surface }) => surface === 'status').payload.notice,
    'Pitching Change: Relief Arm',
  )
})

test('fake feed starts a fresh delay for a later event on every surface', () => {
  const clock = makeClock()
  const feed = new FakeLiveFeed({ delaySeconds: 10, clock })

  feed.receiveFeedEvent({
    id: 'play-1',
    play: { playId: 'play-1' },
    battedBall: { playId: 'play-1' },
    scorebug: { playId: 'play-1' },
    status: { playId: 'play-1', notice: 'Rain Delay' },
  })
  clock.advanceTo(2_000)
  feed.receiveFeedEvent({
    id: 'play-2',
    play: { playId: 'play-2' },
    battedBall: { playId: 'play-2' },
    scorebug: { playId: 'play-2' },
    status: { playId: 'play-2', notice: 'Play Resumed' },
  })

  clock.advanceTo(9_999)
  assert.deepEqual(feed.released, [])
  clock.advanceTo(10_000)
  assert.deepEqual(feed.released.map(({ eventId, releasedAt }) => ({ eventId, releasedAt })), [
    { eventId: 'play-1', releasedAt: 10_000 },
    { eventId: 'play-1', releasedAt: 10_000 },
    { eventId: 'play-1', releasedAt: 10_000 },
    { eventId: 'play-1', releasedAt: 10_000 },
  ])

  clock.advanceTo(11_999)
  assert.equal(feed.released.length, 4)
  clock.advanceTo(12_000)
  assert.deepEqual(feed.released.slice(4).map(({ surface, eventId, releasedAt }) => ({
    surface,
    eventId,
    releasedAt,
  })), FEED_SURFACES.map((surface) => ({
    surface,
    eventId: 'play-2',
    releasedAt: 12_000,
  })))
})
