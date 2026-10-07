import test from 'node:test'
import assert from 'node:assert/strict'
import { isBeltColour, measureWaistband, waistbandFromShares, waistCut } from '../src/util/playerRig.js'

// The waistband is read off the model's own base-color texture at load time, and
// this is the whole of the rule that reads it: the lowest run of heights where a
// share of the trunk's ring is drawn in a colour the cloth above and below cannot
// account for — the belt in whatever colour the uniform draws it, rather than a
// colour the rule knows (``isBeltColour``). The heights the driver then cuts the
// body at are the model's; what has to be right is the rule, so it is tested here
// both on profiles with a known answer and end to end against a hand-drawn atlas.

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

test('the waistband is the lowest run of heights the ring is belt-coloured', () => {
  // A belt from 1.26 to 1.30, with a trouser stripe above it and a shoe below:
  // the stripe is belt-coloured but covers a sliver of the ring at every height,
  // and the shoe is belt-coloured all the way across but is not in the window.
  const band = waistbandFromShares(
    profile({
      from: 1.16,
      to: 1.45,
      share: (at) => (at >= 1.26 && at < 1.3 ? 0.8 : at >= 1.34 ? 0.1 : 0.02),
    }),
  )
  assert.deepEqual(band, { bottom: 1.26, top: 1.3, share: Math.round(20 * 0.8) / 20 })
})

test('a stripe is not a waistband, however tall it is', () => {
  // The trouser stripe runs the whole window and covers a fifth of the ring:
  // below the share a band has to colour, so it never becomes the waistband.
  const stripe = waistbandFromShares(profile({ from: 1.16, to: 1.45, share: () => 0.2 }))
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

// The colour rule on its own, as colours rather than as a ring: the cloth is one
// grey-blue drawn over shades, so the shades have to read as the cloth and a belt
// has to read as *not* the cloth, whichever colour the uniform draws it in.
test('a shade of the cloth is not a belt; a colour of its own is', () => {
  const cloth = [CLOTH_SHADES[1]]
  for (const shade of CLOTH_SHADES) {
    assert.equal(isBeltColour(shade, cloth), false, `${shade} is the cloth, drawn darker or lighter`)
  }
  for (const [name, belt] of [['home', HOME_BELT], ['away', AWAY_BELT]]) {
    assert.equal(isBeltColour(belt, cloth), true, `the ${name} belt is not the cloth`)
  }
  // Every cloth is judged, not just the first: a colour that *is* the trousers is
  // not the belt merely because it differs from the shirt.
  assert.equal(isBeltColour(CLOTH_SHADES[0], CLOTH_SHADES), false)
  // And an end of the window that could not be read is not a cloth to judge
  // against, rather than a cloth everything differs from.
  assert.equal(isBeltColour(HOME_BELT, [null]), true)
})

// The read end to end, against a hand-drawn atlas. Node has no canvas, so one is
// stood in whose pixels are the atlas: the read goes through ``texelAt`` exactly as
// it does in the browser, wrapping and all.
const ATLAS_HEIGHT = 120
// Rows 30 to 41 of the atlas are the belt: v runs over 0.4 rig units in 120 rows,
// which puts them at heights 1.26 to 1.30 — the band the recorded numbers describe.
const BELT_ROWS = [30, 41]
// This project's own uniform: one grey-blue drawn over three shades, plus the belt
// of each kit — the home red and the away purple, as the textures draw them.
const CLOTH_SHADES = [
  [0.5625, 0.5625, 0.6875],
  [0.6875, 0.6875, 0.8125],
  [0.625, 0.625, 0.75],
]
const HOME_BELT = [0.6875, 0.3125, 0.1875]
const AWAY_BELT = [0.3125, 0.1875, 0.3125]

// An atlas drawn by `paint(row, column)`, each texel in 0..1.
const atlas = (paint) => {
  const width = 8
  const data = new Uint8ClampedArray(width * ATLAS_HEIGHT * 4)
  for (let row = 0; row < ATLAS_HEIGHT; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const colour = paint(row, column)
      const at = (row * width + column) * 4
      for (let channel = 0; channel < 3; channel += 1) data[at + channel] = Math.round(colour[channel] * 255)
      data[at + 3] = 255
    }
  }
  return { image: { width, height: ATLAS_HEIGHT }, data }
}

// A uniform: its belt over the cloth in shades, as a *band* or — the trouser
// stripe — a sliver of every height.
const uniform = (belt, { stripe = false } = {}) => (row, column) => {
  const cloth = CLOTH_SHADES[(row + column) % CLOTH_SHADES.length]
  if (stripe) return column === 0 ? belt : cloth
  return row >= BELT_ROWS[0] && row <= BELT_ROWS[1] ? belt : cloth
}

// A trunk ring: a vertex every 0.005 rig units from 1.16 up, all at one u, with v
// running from the ring's bottom down the atlas — so the row a vertex lands in is
// the height it sits at.
const ringModel = (image) => {
  const points = []
  for (let height = 1.16; height <= 1.52 + 1e-9; height += 0.005) {
    points.push({ height: Number(height.toFixed(3)), v: (height - 1.16) / 0.4 })
  }
  const count = points.length
  return {
    traverse(visit) {
      visit({
        isSkinnedMesh: true,
        skeleton: { bones: [{ name: 'spine' }, { name: 'thighL' }] },
        material: { map: { image, flipY: false } },
        geometry: {
          attributes: {
            position: { count, getY: (vertex) => points[vertex].height },
            uv: { getX: () => 0.5, getY: (vertex) => points[vertex].v },
            skinIndex: { array: new Int16Array(count * 4).fill(0) },
            skinWeight: { array: new Float32Array(count * 4).fill(1) },
          },
        },
      })
    },
  }
}

const readAtlas = ({ image, data }) => {
  const previous = globalThis.document
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({ drawImage: () => {}, getImageData: () => ({ data }) }),
    }),
  }
  try {
    return measureWaistband(ringModel(image), metricsFor(1.158, 1.885))
  } finally {
    globalThis.document = previous
  }
}

test('the belt is found in whatever colour the uniform draws it', () => {
  // The home belt is red and the away belt is dark purple. Neither is named
  // anywhere in the rule — what it asks is that the colour is not the cloth the
  // heights sit between, which both are and the cloth's own shades are not.
  for (const [name, belt] of [['home', HOME_BELT], ['away', AWAY_BELT]]) {
    const band = readAtlas(atlas(uniform(belt)))
    assert.equal(band.source, 'texture', `${name}: the belt should be read off the atlas`)
    assert.ok(band.samples > 50, `${name}: samples ${band.samples}`)
    assert.ok(band.share >= 0.3, `${name}: share ${band.share}`)
    // The belt is drawn 1.26 to 1.30; the read reports the run of heights whose
    // ±0.015 band of samples is belt-coloured, which reaches a little past the
    // belt's own edges.
    assert.ok(Math.abs(band.bottom - 1.26) < 0.015, `${name}: bottom ${band.bottom}`)
    assert.ok(Math.abs(band.top - 1.3) < 0.015, `${name}: top ${band.top}`)
    // And what it found is the belt's own colour, by the rule that found it: the
    // away belt sits 0.084 chroma from the cloth against a 0.05 gap, the tightest
    // this rule has been asked to hold.
    assert.ok(isBeltColour(band.trim, band.cloth), `${name}: trim ${band.trim}`)
  }
})

test('the cloth’s own shades are not a belt, however they are mixed', () => {
  // The same ring with no belt drawn: every texel is the cloth, in one of the
  // three shades the uniform shades it in. A shade does not move a colour's
  // chroma, so there is no band in the ring — and the read says so, rather than
  // cutting the body at the first shade boundary it finds.
  const band = readAtlas(atlas((row, column) => CLOTH_SHADES[(row + column) % CLOTH_SHADES.length]))
  assert.equal(band.source, 'fallback')
  assert.ok(band.samples > 50, `samples ${band.samples}`)
})

test('a trouser stripe is not a belt, even in the belt’s own colour', () => {
  // The stripe runs the whole window in the belt's colour but covers an eighth of
  // the ring, so no height reaches the share a band has to colour.
  const band = readAtlas(atlas(uniform(HOME_BELT, { stripe: true })))
  assert.equal(band.source, 'fallback')
})

// The read itself, without a browser: a model whose texture cannot be read (no
// image, an image the browser will not hand back pixels for, or one that draws no
// band at all) still has to put the twist somewhere sensible. What the driver then falls back to is the recorded
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

// Where the cut is taken off the band: a share of the belt's own *height* above its
// top edge, never on the edge itself and never further up than the fold the jersey's
// hem turns under. What the share has to buy is the same thing on any uniform — the
// belt below the cut whole, so a turn of the two blocks cannot split it — and this
// pins the two properties that make it, rather than the number: the cut is above the
// band's top by a fraction of the band, and that fraction is small against the belt.
test('the cut is taken above the belt’s top edge, by a share of the belt', () => {
  const band = { bottom: 1.14079, top: 1.17579 }
  const cut = waistCut(band)
  assert.ok(cut > band.top, `the cut should be above the belt's top edge (${cut})`)
  assert.ok(cut - band.top < band.top - band.bottom, 'the cut should be inside the belt\'s own height above it')
  // On this uniform the belt is 35 mm and the cut lands 17.5 mm above its top edge:
  // the height the hem's own drawn line was measured to sit still at (see the
  // constant's own note in playerRig.js).
  assert.ok(Math.abs(cut - 1.19329) < 1e-9, `cut ${cut}`)
  // The share, not the millimetres: a belt drawn twice as tall takes the cut twice
  // as high, so it stays in the same place in its own fold.
  const tall = { bottom: 1.105, top: 1.175 }
  assert.ok(Math.abs(waistCut(tall) - (tall.top + (cut - band.top) * 2)) < 1e-9)
})

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
