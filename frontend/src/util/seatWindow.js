// Which seats a crowd show may stand on.
//
// A show is a run of neighbours holding one banner or playing together, so the
// seats it claims have to be neighbours on the concrete -- not merely
// neighbours in the seat index. Rows are cut into blocks by aisles, and a
// window asked for across one of those cuts leaves the middle of the row
// holding the cloth over a walkway with nobody standing in it.
//
// Callers give a wish ("about these seats, this wide"); this lands it in the
// nearest block of seats between two aisles, at the same width, so a window can
// never straddle one however the seat grid is later re-spaced.

/** Every run of seats between two aisles, as [start, end) pairs. */
export function aisleRuns(perRow, aisle) {
  const runs = []
  for (let s = 0; s < perRow; s++) {
    if (aisle(s)) continue
    const start = s
    while (s + 1 < perRow && !aisle(s + 1)) s++
    runs.push([start, s + 1])
  }
  return runs
}

/**
 * Move a requested seat window onto one aisle-free run.
 *
 * @param {{perRow: number, aisle: (seat: number) => boolean}} grid
 * @param {number} from  first seat asked for, inclusive
 * @param {number} to    one past the last seat asked for
 * @returns {{from: number, to: number}} the window actually used: the nearest
 *   run's middle to the wish, as wide as asked where the run allows it, and
 *   never reaching past an aisle.
 */
export function snapSeatWindow({ perRow, aisle }, from, to) {
  const width = Math.max(1, to - from)
  const centre = (from + to) / 2
  const runs = aisleRuns(perRow, aisle)
  if (runs.length === 0) return { from, to }

  // The block whose middle sits nearest the wish. A tie keeps the one found
  // first, so a window never hops further along the row than it must.
  let best = runs[0]
  let bestDistance = Math.abs((best[0] + best[1]) / 2 - centre)
  for (const run of runs) {
    const distance = Math.abs((run[0] + run[1]) / 2 - centre)
    if (distance < bestDistance - 1e-9) {
      best = run
      bestDistance = distance
    }
  }

  // As wide as asked, or the whole block when the block is narrower; slid as
  // little as the block allows from the seat that was asked for.
  const length = Math.min(width, best[1] - best[0])
  const start = Math.min(Math.max(from, best[0]), best[1] - length)
  return { from: start, to: start + length }
}
