import test from 'node:test'
import assert from 'node:assert/strict'
import { measureWaistband, waistbandFromShares } from '../src/util/playerRig.js'

// The waistband is read off the model's own base-color texture at load time, and
// this is the whole of the rule that reads it: the lowest run of heights where
// most of the trunk's ring is drawn in the uniform's trim colour. The heights the
// driver then cuts the body at are the model's; what has to be right is the rule,
// so it is tested here on profiles with a known answer.

// A profile from a ring drawn as `trim` out of `count` samples per height, from
// `bottom` up in 0.005 steps.
const profile = (spec) => {
  const heights = []
  for (let step = 0; step <= Math.round((spec.to - spec.from) / 0.005); step += 1) {
    const height = Number((spec.from + step * 0.005).toFixed(3))
    const count = spec.count ?? 20
    heights.push({ height, count, trim: Math.round(count * spec.share(height)) })
  }
  return heights
}

test('the waistband is the lowest run of heights the ring is trim-coloured', () => {
  // A belt from 1.26 to 1.30, with a trouser stripe above it and a shoe below:
  // the stripe is trim-coloured but covers a sliver of the ring at every height,
  // and the shoe is trim-coloured all the way across but is not in the window.
  const band = waistbandFromShares(
    profile({
      from: 1.16,
      to: 1.45,
      share: (at) => (at >= 1.26 && at < 1.3 ? 0.8 : at >= 1.34 ? 0.1 : 0.02),
    }),
  )
  assert.deepEqual(band, { bottom: 1.26, top: 1.3, share: Math.round(20 * 0.8) / 20 })
})

test('a stripe is not a waistband, however wide it is', () => {
  // Below half the ring: the trouser stripe runs the whole window and never
  // becomes the waistband.
  const stripe = waistbandFromShares(profile({ from: 1.16, to: 1.45, share: () => 0.35 }))
  assert.equal(stripe, null)
})

test('a panel is not a waistband: the band has to be belt-sized', () => {
  const wide = waistbandFromShares(profile({ from: 1.16, to: 1.45, share: () => 0.9 }))
  assert.equal(wide, null, 'a band taller than a waistband is some other garment')
  const line = waistbandFromShares(
    profile({ from: 1.16, to: 1.45, share: (at) => (Math.abs(at - 1.28) < 1e-9 ? 1 : 0) }),
  )
  assert.equal(line, null, 'a single height of trim is a hem, not a band')
})

test('the lowest run wins, so a higher trim band cannot move the twist up', () => {
  // The jersey's own trim at the chest, and the belt below it: the belt is what
  // the twist is taken at.
  const band = waistbandFromShares(
    profile({
      from: 1.16,
      to: 1.6,
      share: (at) => (at >= 1.26 && at < 1.3 ? 0.9 : at >= 1.44 && at < 1.5 ? 0.9 : 0.01),
    }),
  )
  assert.equal(band.bottom, 1.26)
  assert.equal(band.top, 1.3)
})

test('a gap breaks the run: two bands are not one', () => {
  // Two belt-sized bands, 0.04 rig units of trousers between them: the lower one
  // is the belt, and the two must not be joined across the gap into a band that
  // is twice a waistband tall.
  const band = waistbandFromShares(
    profile({
      from: 1.16,
      to: 1.4,
      share: (at) => ((at >= 1.2 && at < 1.24) || (at >= 1.28 && at < 1.31) ? 0.9 : 0.05),
    }),
  )
  assert.equal(band.bottom, 1.2)
  assert.equal(band.top, 1.24)
})

test('a height with too few samples cannot start a band', () => {
  const sparse = waistbandFromShares([
    { height: 1.26, count: 2, trim: 2 },
    { height: 1.265, count: 2, trim: 2 },
    { height: 1.27, count: 2, trim: 2 },
    { height: 1.275, count: 2, trim: 2 },
    { height: 1.28, count: 2, trim: 2 },
  ])
  assert.equal(sparse, null)
  // A well-sampled band, four steps tall (0.02 rig units — the narrowest a
  // waistband is allowed to be).
  const enough = waistbandFromShares([
    { height: 1.26, count: 20, trim: 20 },
    { height: 1.265, count: 20, trim: 20 },
    { height: 1.27, count: 20, trim: 20 },
    { height: 1.275, count: 20, trim: 20 },
  ])
  assert.deepEqual(enough, { bottom: 1.26, top: 1.28, share: 1 })
})

// The read itself, without a browser: a model whose texture cannot be read (no
// image, or an image the browser will not hand back pixels for) still has to put
// the twist somewhere sensible. What the driver then falls back to is the recorded
// band *restated in the model's own proportions* — the same share of the hip-to-
// neck span — so a differently-proportioned player gets its own waistband height
// rather than this one's rig units.
const stubModel = (points) => ({
  traverse(visit) {
    visit({
      isSkinnedMesh: true,
      skeleton: { bones: [{ name: 'spine' }, { name: 'thighL' }] },
      material: { map: { image: null, flipY: false } },
      geometry: {
        attributes: {
          position: { count: points.length, getY: (vertex) => points[vertex] },
          uv: { getX: () => 0, getY: () => 0 },
          skinIndex: { array: new Int16Array(points.length * 4).fill(0) },
          skinWeight: { array: new Float32Array(points.length * 4).fill(1) },
        },
      },
    })
  },
})

// The metrics `measureWaistband` reads, as `measurePlayerRig` reports them.
const metricsFor = (hipY, neckY, unitScale = 1) => ({ hip: { y: hipY }, neckY, unitScale })

test('with no readable texture the band falls back to the model’s own proportions', () => {
  const metrics = metricsFor(1.158, 1.885)
  const band = measureWaistband(stubModel([1.3]), metrics)
  assert.equal(band.source, 'fallback')
  assert.equal(band.samples, 0)
  const span = metrics.neckY - metrics.hip.y
  assert.ok(Math.abs(band.bottom - (metrics.hip.y + 0.14 * span)) < 1e-9)
  assert.ok(Math.abs(band.top - (metrics.hip.y + 0.2 * span)) < 1e-9)
  // On the model the recorded band was measured on, the fallback *is* the band
  // that was measured: 1.26-1.30 rig units.
  assert.ok(Math.abs(band.bottom - 1.26) < 0.005, `bottom ${band.bottom}`)
  assert.ok(Math.abs(band.top - 1.3) < 0.005, `top ${band.top}`)
})

test('the fallback scales with the model, rather than standing still', () => {
  // A shorter-waisted player: same proportions, smaller span, so the band moves
  // down with its own hips instead of sitting at 1.26 rig units.
  const metrics = metricsFor(0.9, 1.6)
  const band = measureWaistband(stubModel([1.0]), metrics)
  assert.equal(band.source, 'fallback')
  assert.ok(band.bottom < 1.0, `bottom ${band.bottom} should follow the hips down`)
  assert.ok(Math.abs(band.bottom - (0.9 + 0.14 * 0.7)) < 1e-9)
})
