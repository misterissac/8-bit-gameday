// Who is sitting in their seat.
//
// Filling a row seat by seat at a fixed share leaves a field of single empty
// seats, and a field of single empty seats reads as a texture rather than as a
// crowd: nobody buys nine tickets and leaves every ninth seat empty. Gaps are
// made the way they actually happen -- a seat is nearly always taken, and now
// and then a couple of neighbours are missing together, because that group is
// still on the concourse.
//
// The empties are counted for the row first and then cut out in groups spread
// along its whole length, rather than left to a coin flip per seat. A coin flip
// cannot hold a share: every gap it opens also costs the row the seats on
// either side of it, so a row asked to be 62% full came out at 71%. Counting
// the empties keeps the share honest at any fullness, and spreading the groups
// keeps the gaps where a row of people would leave them.

/**
 * How many neighbours one missing group takes with it: usually one seat, a
 * whole family's worth now and then. The shares add up to 1: one seat 48% of
 * the time, two 30%, three 15%, four 7%.
 */
function gapLength(rng) {
  const r = rng()
  if (r < 0.48) return 1
  if (r < 0.78) return 2
  if (r < 0.93) return 3
  return 4
}

/**
 * Which seats in one row have somebody in them.
 *
 * @param {object} opts
 * @param {number} opts.slots  seats in the row, including its aisles
 * @param {number} opts.fill   the block's share of occupied seats, 0..1
 * @param {(seat: number) => boolean} [opts.aisle]  true for a walkway slot
 * @param {(seat: number) => boolean} [opts.keep]  true for a seat that is
 *   always filled, wherever the row's own gaps fall (a show window's seats)
 * @param {() => number} [opts.rng]
 * @returns {boolean[]} one flag per slot, in seat order; aisles are never taken
 */
export function seatFillRun({
  slots, fill, aisle = () => false, keep = () => false, rng = Math.random,
}) {
  const taken = new Array(slots).fill(false)

  // Walk the row in seat order, not slot order, so a gap is made of neighbours
  // on the concrete and never of two people either side of a walkway.
  const seats = []
  for (let s = 0; s < slots; s++) if (!aisle(s)) seats.push(s)
  const count = seats.length
  if (count === 0) return taken

  // No row is a robot: it runs a little fuller or a little emptier than the
  // block it belongs to, and that is what makes one row read as its own group.
  const mood = fill >= 1
    ? 1
    : Math.min(0.995, Math.max(0, fill + (rng() - 0.5) * 0.04))
  // A row with room in it is never wholly empty: the block's share is never
  // zero, so that would be the gap rule eating the row it is meant to speckle.
  const empty = Math.min(count - 1, Math.round((1 - mood) * count))

  for (const s of seats) taken[s] = true
  if (empty === 0) return taken

  // Break the row's empties into groups of neighbours who are all away.
  const groups = []
  let left = empty
  while (left > 0) {
    const size = Math.min(left, gapLength(rng))
    groups.push(size)
    left -= size
  }

  // Spread those groups along the row: one per equal share of its length,
  // placed anywhere inside that share. A row that is nearly full still has its
  // handful of gaps spread from one end to the other, instead of bunched where
  // the first misses fell.
  let cursor = 0 // the first seat left after the previous group
  let remaining = empty // empties still to place, this group included
  for (let g = 0; g < groups.length; g++) {
    const size = groups[g]
    const from = Math.floor((g * count) / groups.length)
    const to = Math.floor(((g + 1) * count) / groups.length)
    // Anywhere in the group's own share of the row, as long as it fits before
    // the share ends; a share too narrow for the group starts right away, and
    // groups never lap over each other -- every empty seat is counted once.
    const room = Math.max(0, to - from - size)
    const start = Math.min(
      Math.max(cursor, from + Math.floor(rng() * (room + 1))),
      // ... and never so late that the groups still to come would not fit.
      count - remaining,
    )
    for (let i = 0; i < size; i++) taken[seats[start + i]] = false
    cursor = start + size
    remaining -= size
  }

  // Some seats are always filled: a crowd show is a run of neighbours who act
  // together, and its cloth (or its row of instruments) needs a hand on every
  // seat in its window. The row's gaps were counted over the whole row, so
  // filling these back in leaves the show row a little fuller than its block —
  // which is what a group who came together looks like.
  for (const s of seats) if (keep(s)) taken[s] = true

  return taken
}
