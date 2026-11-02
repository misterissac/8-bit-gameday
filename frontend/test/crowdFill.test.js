import test from 'node:test'
import assert from 'node:assert/strict'

import { seatFillRun } from '../src/util/crowdFill.js'

// The same generator the park's crowd uses, so a run is reproducible here.
function createPRNG(seed = 12345) {
  let s = seed
  return function () {
    s = (s * 16807 + 0) % 2147483647
    return (s - 1) / 2147483646
  }
}

function runs(flags) {
  const found = []
  let start = -1
  for (let i = 0; i <= flags.length; i++) {
    const empty = i < flags.length && !flags[i]
    if (empty && start < 0) start = i
    if (!empty && start >= 0) {
      found.push([start, i])
      start = -1
    }
  }
  return found
}

test('only real seats are taken: a walkway is always empty', () => {
  const aisle = (s) => s % 12 >= 10
  const flags = seatFillRun({ slots: 144, fill: 0.95, aisle, rng: createPRNG(7) })
  for (let s = 0; s < 144; s++) {
    if (aisle(s)) assert.equal(flags[s], false, `walkway slot ${s} has a fan on it`)
  }
  const seats = flags.filter(Boolean).length
  assert.ok(seats > 0)
})

test('the empties come in groups of people, not in single seats', () => {
  const flags = seatFillRun({ slots: 600, fill: 0.88, rng: createPRNG(11) })
  const empty = runs(flags)
  assert.ok(empty.length > 10, 'some seats are empty')
  for (const [from, to] of empty) {
    assert.ok(to - from <= 4, `a gap of ${to - from} seats reads as a hole`)
  }
  assert.ok(
    empty.some(([from, to]) => to - from >= 2),
    'at least one group is missing together, not one lone seat',
  )
})

test('the gaps are spread along the row, not bunched where the misses fell', () => {
  const slots = 400
  const flags = seatFillRun({ slots, fill: 0.7, rng: createPRNG(17) })
  const empty = runs(flags)
  const quarters = [0, 0, 0, 0]
  for (const [from] of empty) quarters[Math.floor((from * 4) / slots)] += 1
  for (let q = 0; q < 4; q++) {
    assert.ok(quarters[q] > 0, `quarter ${q} of the row has no empty seats`)
  }
  // ... and they are not on a metronome either: the spaces between groups vary.
  const starts = empty.map(([from]) => from)
  const gaps = starts.slice(1).map((s, i) => s - starts[i])
  assert.ok(new Set(gaps).size > 1, 'every gap is the same distance apart')
})

test('a row lands on its block share, at any fullness', () => {
  // Blocks are painted anywhere from 0.6 to 0.97, so the share has to mean the
  // same thing at both ends of the range.
  for (const fill of [0.6, 0.7, 0.85, 0.95, 0.97]) {
    let taken = 0
    let total = 0
    // Spread the seeds: this generator's first draw tracks its seed closely,
    // so consecutive seeds would give every row the same mood.
    for (let row = 0; row < 80; row++) {
      const flags = seatFillRun({ slots: 100, fill, rng: createPRNG((row + 1) * 7919) })
      taken += flags.filter(Boolean).length
      total += 100
    }
    const share = taken / total
    assert.ok(
      Math.abs(share - fill) < 0.02,
      `fill ${fill} came out at ${share.toFixed(3)}`,
    )
  }
})

test('a show window is filled, wherever the row’s own gaps fell', () => {
  // A crowd show is a run of neighbours acting together, so its seats are kept
  // full even though the row around them has its usual gaps.
  const slots = 90
  const aisle = (s) => s % 30 >= 28
  const keep = (s) => (s >= 10 && s < 20) || (s >= 28 && s < 30)
  const flags = seatFillRun({ slots, fill: 0.6, aisle, keep, rng: createPRNG(23) })
  for (let s = 10; s < 20; s++) assert.equal(flags[s], true, `show seat ${s} is empty`)
  // A walkway is never a seat, even when a window is asked to keep it.
  for (let s = 0; s < slots; s++) if (aisle(s)) assert.equal(flags[s], false)
  // The rest of the row is untouched: it still has the gaps it was dealt.
  const outside = [...flags.slice(0, 10), ...flags.slice(20, 28), ...flags.slice(30)]
  assert.ok(outside.some((taken) => !taken), 'the row lost all of its gaps')
})

test('a full block has every seat taken, and no gaps at all', () => {
  const flags = seatFillRun({ slots: 40, fill: 1, rng: createPRNG(3) })
  assert.ok(flags.every(Boolean))
})

test('the same seed fills the same row', () => {
  const a = seatFillRun({ slots: 60, fill: 0.9, rng: createPRNG(99) })
  const b = seatFillRun({ slots: 60, fill: 0.9, rng: createPRNG(99) })
  assert.deepEqual(a, b)
})

test('a row of nothing but walkways stays empty, and a tiny row keeps one fan', () => {
  assert.deepEqual(seatFillRun({ slots: 8, fill: 0.9, aisle: () => true, rng: createPRNG(5) }), [
    false, false, false, false, false, false, false, false,
  ])
  const tiny = seatFillRun({ slots: 1, fill: 0.1, rng: createPRNG(5) })
  assert.deepEqual(tiny, [true])
})
