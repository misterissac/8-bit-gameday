import test from 'node:test'
import assert from 'node:assert/strict'

import { aisleRuns, snapSeatWindow } from '../src/util/seatWindow.js'

// The park's two seat grids: the bleachers' bays (a two-slot aisle every twelve
// slots on the ring's old 174-slot grid, which is where the walkway angles come
// from) and the grandstand's 246 seats with a two-seat aisle every fourteen. A
// bleacher row now carries as many slots as its own length holds, but its bays
// are cut on this same rule.
const BLEACHERS = { perRow: 174, aisle: (s) => s % 12 >= 10 }
const GRANDSTAND = { perRow: 246, aisle: (s) => s % 14 >= 12 }
const TERM = 174

// The show windows as they were asked for, before any snapping.
const WISHES = [
  { name: 'centre-field shout (left)', grid: BLEACHERS, from: 58, to: 68 },
  { name: 'centre-field shout (right)', grid: BLEACHERS, from: 145, to: 155 },
  { name: 'outfield music', grid: BLEACHERS, from: 39, to: 49 },
  { name: 'grandstand shout', grid: GRANDSTAND, from: 49, to: 59 },
  { name: 'grandstand music', grid: GRANDSTAND, from: 20, to: 29 },
]

test('a row is cut into the blocks of seats a banner can actually span', () => {
  assert.deepEqual(aisleRuns(24, (s) => s % 12 >= 10), [
    [0, 10], [12, 22],
  ])
  // The tail block is shorter when the row does not divide evenly.
  assert.deepEqual(aisleRuns(14, (s) => s % 14 >= 12), [[0, 12]])
  // No aisles at all is one block.
  assert.deepEqual(aisleRuns(23, () => false), [[0, 23]])
})

test('every show window sits inside one block of seats, whatever was asked for', () => {
  for (const wish of WISHES) {
    const { from, to } = snapSeatWindow(wish.grid, wish.from, wish.to)
    assert.ok(to > from, `${wish.name}: keeps a row to stand on`)
    for (let s = from; s < to; s++) {
      assert.equal(
        wish.grid.aisle(s),
        false,
        `${wish.name}: seat ${s} in ${from}..${to - 1} is in an aisle`,
      )
    }
    // A whole number of seats, and no wider than asked for.
    assert.equal(Number.isInteger(from) && Number.isInteger(to), true)
    assert.ok(to - from <= wish.to - wish.from, `${wish.name}: no wider than asked`)
  }
})

test('a window keeps its width when the block is wide enough, and stays put when it already fits', () => {
  // Already inside a block: untouched.
  assert.deepEqual(snapSeatWindow(GRANDSTAND, 44, 53), { from: 44, to: 53 })
  assert.deepEqual(snapSeatWindow(GRANDSTAND, 18, 26), { from: 18, to: 26 })
  assert.deepEqual(snapSeatWindow(BLEACHERS, 24, 33), { from: 24, to: 33 })
  // Nine seats asked for, nine seats given, though the window has to move.
  assert.deepEqual(snapSeatWindow(BLEACHERS, 30, 39), { from: 25, to: 34 })
  // The rescaled bleacher wishes land in a block with one seat to spare.
  assert.deepEqual(snapSeatWindow(BLEACHERS, 52, 61), { from: 49, to: 58 })
  assert.deepEqual(snapSeatWindow(BLEACHERS, 35, 44), { from: 36, to: 45 })
})

test('the window lands in the nearest block, not simply the first one', () => {
  // Asked for around seat 24: the block ending at 33 is nearer than the one
  // ending at 21, even though that one is also a legal nine seats.
  assert.deepEqual(snapSeatWindow(BLEACHERS, 20, 29), { from: 24, to: 33 })
  // An exact tie between two blocks keeps the earlier one: no unnecessary hop.
  assert.deepEqual(snapSeatWindow(BLEACHERS, 30, 40), { from: 24, to: 34 })
})

test('a window wider than a block is trimmed to the block rather than crossing it', () => {
  const wide = snapSeatWindow(BLEACHERS, 28, 48)
  assert.deepEqual(wide, { from: 36, to: 46 })
  assert.equal(wide.to - wide.from, 10, 'the full block, and no more')

  const taller = snapSeatWindow(GRANDSTAND, 40, 60)
  assert.equal(taller.to - taller.from, 12)
  for (let s = taller.from; s < taller.to; s++) assert.ok(!GRANDSTAND.aisle(s))
})

test('a seating block with no aisles (the corner terrace) keeps its window as asked', () => {
  const corner = { perRow: 12, aisle: () => false }
  assert.deepEqual(snapSeatWindow(corner, 2, 9), { from: 2, to: 9 })
  // A row of nothing but aisles has no legal window; the wish is left alone
  // rather than the call failing.
  assert.deepEqual(snapSeatWindow({ perRow: TERM, aisle: () => true }, 5, 9), { from: 5, to: 9 })
})
