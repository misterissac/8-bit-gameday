import test from 'node:test'
import assert from 'node:assert/strict'

import {
  drawBillboard,
  boardKey,
  fitText,
  faceGrid,
  drawFace,
  quantizeHeadshot,
  HEADSHOT_PALETTE,
} from '../src/util/billboard.js'

// A canvas 2D context that records the text (with where and in what colour it
// was drawn) and the pixel cells painted on it: the board's content is what
// this suite pins, not its anti-aliasing.
function mockCtx() {
  const texts = []
  const rects = []
  const strokes = []
  const images = []
  const rounded = []
  return {
    texts,
    rects,
    strokes,
    images,
    rounded,
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    lineWidth: 0,
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, fill: this.fillStyle }) },
    strokeRect(x, y, w, h) { strokes.push({ x, y, w, h, stroke: this.strokeStyle }) },
    beginPath() { this.path = null },
    roundRect(x, y, w, h, radii) { this.path = { x, y, w, h, radii } },
    // fill() closes a roundRect path the way a browser would; a plain fillRect
    // never goes through here.
    fill() {
      if (this.path) {
        rects.push({ ...this.path, fill: this.fillStyle })
        rounded.push(this.path)
        this.path = null
      }
    },
    fillText(text, x, y) { texts.push({ text: String(text), x, y, fill: this.fillStyle, font: this.font }) },
    drawImage(img, x, y, w, h) { images.push({ img, x, y, w, h }) },
    measureText: (text) => ({ width: String(text).length * 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }
}

const words = (ctx) => ctx.texts.map((t) => t.text)

// The board's own geometry, so tests can speak about cells by place: the 17
// grid columns share 1060 px with the team column at 1.5 units (see
// util/billboard.js), and the two score rows sit under 36 px of header.
const GRID_UNIT = 1060 / 17.5
const colCenter = (col) => (col === 0 ? 0 : GRID_UNIT * 1.5 + (col - 1) * GRID_UNIT) + GRID_UNIT / 2
const AWAY_ROW_Y = 321 + 36 + 20
const HOME_ROW_Y = 321 + 36 + 60
const atCell = (ctx, col, y) => ctx.texts.filter((t) => Math.abs(t.x - colCenter(col)) < 1 && Math.abs(t.y - y) < 1)

const MID_GAME = {
  teams: {
    away: { abbreviation: 'NYY', name: 'New York Yankees', teamName: 'Yankees' },
    home: { abbreviation: 'BOS', name: 'Boston Red Sox', teamName: 'Red Sox' },
  },
  inning: { number: 5, ordinal: '5th', state: 'Top', isTop: true },
  count: { balls: 2, strikes: 1 },
  outs: 1,
  batter: 'Aaron Judge',
  batterId: 592450,
  batterNumber: '99',
  batterFirst: 'Aaron',
  batterLast: 'Judge',
  nextBatters: ['JUAN SOTO', 'GIANCARLO STANTON', 'ANTHONY RIZZO'],
  batterSeason: {
    avg: '0.311', obp: '0.425', slg: '0.688', ops: '1.113', hr: '48', rbi: '115',
  },
  linescore: {
    innings: {
      away: [1, 0, 2, null, null, null, null, null, null],
      home: [0, null, null, null, null, null, null, null, null],
    },
    away: { runs: 3, hits: 6, errors: 0, leftOnBase: 4 },
    home: { runs: 1, hits: 4, errors: 1, leftOnBase: 2 },
  },
}

test('the board is the reference jumbotron: at-bat panel, batter card, scoring grid', () => {
  const ctx = mockCtx()
  drawBillboard(ctx, MID_GAME)
  const text = words(ctx).join('\n')

  // The at-bat panel: TEAM - X, the season line, the next three up.
  assert.ok(text.includes('TEAM - YANKEES'))
  assert.ok(text.includes('SEASON STATS'))
  assert.ok(text.includes('OBP'))
  assert.ok(text.includes('SLG'))
  assert.ok(text.includes('OPS'))
  assert.ok(text.includes('BATTING ORDER'))
  assert.ok(text.includes('JUAN SOTO'))
  assert.ok(text.includes('GIANCARLO STANTON'))
  assert.ok(text.includes('ANTHONY RIZZO'))

  // The batter card: number badge, name, the three tags with their raw stats.
  assert.ok(text.includes('99'))
  assert.ok(text.includes('AARON'))
  assert.ok(text.includes('JUDGE'))
  assert.ok(text.includes('AVG'))
  assert.ok(text.includes('HR'))
  assert.ok(text.includes('RBI'))
  assert.ok(text.includes('0.311'))
  assert.ok(text.includes('48'))
  assert.ok(text.includes('115'))

  // The grid: team rows, the inning headers and the totals.
  assert.ok(text.includes('NYY'))
  assert.ok(text.includes('BOS'))
  for (const label of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'R', 'H', 'E', 'LOB', 'B', 'S', 'O']) {
    assert.ok(text.includes(label), `grid carries the ${label} column`)
  }
  // Away line: 1 _ 2 in the innings, then R 3 H 6 E 0 LOB 4.
  assert.deepEqual(atCell(ctx, 1, AWAY_ROW_Y).map((t) => t.text), ['1'])
  assert.deepEqual(atCell(ctx, 3, AWAY_ROW_Y).map((t) => t.text), ['2'])
  assert.deepEqual(atCell(ctx, 10, AWAY_ROW_Y).map((t) => t.text), ['3'])
  assert.deepEqual(atCell(ctx, 11, AWAY_ROW_Y).map((t) => t.text), ['6'])
  assert.deepEqual(atCell(ctx, 12, AWAY_ROW_Y).map((t) => t.text), ['0'])
  assert.deepEqual(atCell(ctx, 13, AWAY_ROW_Y).map((t) => t.text), ['4'])
  // Home line: 0 in the first, then R 1 H 4 E 1 LOB 2.
  assert.deepEqual(atCell(ctx, 1, HOME_ROW_Y).map((t) => t.text), ['0'])
  assert.deepEqual(atCell(ctx, 10, HOME_ROW_Y).map((t) => t.text), ['1'])
  assert.deepEqual(atCell(ctx, 11, HOME_ROW_Y).map((t) => t.text), ['4'])
  assert.deepEqual(atCell(ctx, 12, HOME_ROW_Y).map((t) => t.text), ['1'])
  assert.deepEqual(atCell(ctx, 13, HOME_ROW_Y).map((t) => t.text), ['2'])
  // The count at 48 px: B 2, S 1, O 1.
  const big = ctx.texts.filter((t) => t.font.includes('48px')).map((t) => t.text)
  assert.deepEqual(big, ['2', '1', '1'])
})

test('the badge and the stat tags round their corners the way a canvas reads them', () => {
  const ctx = mockCtx()
  drawBillboard(ctx, MID_GAME)

  // Canvas's roundRect takes the radii as a list, not named corners: a
  // {topRight, bottomRight} object is read as one point and rounds nothing (the
  // board shipped square-cornered pills exactly that way). Every call has to
  // carry the array, in the canvas order top-left, top-right, bottom-right,
  // bottom-left.
  assert.ok(ctx.rounded.length >= 4, 'the badge and the three tags are rounded')
  for (const shape of ctx.rounded) {
    assert.ok(Array.isArray(shape.radii), 'corner radii must be the array form, never a named-corner object')
    assert.equal(shape.radii.length, 4)
  }
  // The number badge is a pill's right end: square on the left, 40 px round on
  // the right (the reference's borderTop/BottomRightRadius).
  assert.deepEqual(ctx.rounded[0].radii, [0, 40, 40, 0])
  // The AVG/HR/RBI tags are fully round (border-radius: 100px), so their ends
  // are half the tag's height.
  for (const shape of ctx.rounded.slice(1)) {
    assert.equal(shape.radii[0], shape.h / 2)
    assert.deepEqual(shape.radii, [shape.h / 2, shape.h / 2, shape.h / 2, shape.h / 2])
  }
})

test('the season line prints .425-style values, keeping a leading digit past 1.000', () => {
  const ctx = mockCtx()
  drawBillboard(ctx, MID_GAME)
  const text = words(ctx).join('\n')
  // The reference prints three decimals with the leading zero sliced off…
  assert.ok(text.includes('.425'))
  assert.ok(text.includes('.688'))
  // …and an OPS over 1.000 keeps its leading digit (its slice(1) would eat it).
  assert.ok(words(ctx).includes('1.113'))
  assert.ok(!words(ctx).includes('.113'))

  // A missing stat prints blank — never a "NaN" artifact.
  const bare = mockCtx()
  drawBillboard(bare, { ...MID_GAME, batterSeason: { ...MID_GAME.batterSeason, obp: undefined } })
  assert.ok(!words(bare).includes('AN'))
})

test('the current inning is boxed in white and its number wears the theme', () => {
  const ctx = mockCtx()
  drawBillboard(ctx, MID_GAME)

  // The 5th-inning header band is the only white one in the grid's header row
  // (the at-bat panel's own two headers are white and 36 px tall as well, so
  // the row itself has to be named)…
  const whiteBands = ctx.rects.filter((r) => r.fill === '#ffffff' && r.w > 50 && r.h === 36 && r.y === 321)
  assert.equal(whiteBands.length, 1)
  assert.ok(Math.abs(whiteBands[0].x - (GRID_UNIT * 1.5 + 4 * GRID_UNIT)) < 1)
  // …and its number reads in the top half's theme colour (#4A3448).
  const header = ctx.texts.find((t) => t.text === '5' && t.font.includes('24px'))
  assert.equal(header.fill, '#4A3448')

  // The column is boxed in the reference's 4 px white inset.
  assert.equal(ctx.strokes.length, 1)
  assert.equal(ctx.strokes[0].stroke, '#ffffff')
  assert.ok(Math.abs(ctx.strokes[0].x - (GRID_UNIT * 1.5 + 4 * GRID_UNIT + 2)) < 1)
  assert.equal(ctx.strokes[0].h, 112)

  // The bottom half wears the other theme.
  const bottom = mockCtx()
  drawBillboard(bottom, { ...MID_GAME, inning: { ...MID_GAME.inning, isTop: false } })
  assert.equal(bottom.rects[0].fill, '#AD4126')
  assert.equal(bottom.texts.find((t) => t.text === '5' && t.font.includes('24px')).fill, '#AD4126')
})

test('a half that has not started leaves its cell blank', () => {
  const ctx = mockCtx()
  drawBillboard(ctx, MID_GAME)

  // Away batted in innings 1-3: a played half with no runs reads 0, not blank.
  assert.deepEqual(atCell(ctx, 2, AWAY_ROW_Y).map((t) => t.text), ['0'])
  // The halves that have not started stand blank — away's 4th on…
  assert.deepEqual(atCell(ctx, 4, AWAY_ROW_Y).map((t) => t.text), [])
  // …and every home half after the first.
  assert.deepEqual(atCell(ctx, 2, HOME_ROW_Y).map((t) => t.text), [])
  assert.deepEqual(atCell(ctx, 5, HOME_ROW_Y).map((t) => t.text), [])
})

test('an empty board invents no info: the chrome, nothing more', () => {
  const ctx = mockCtx()
  drawBillboard(ctx, null)
  const text = words(ctx).join('\n')

  // The labels are chrome — the column headers, the panel rows — but not one
  // score cell is filled and no man is named.
  assert.deepEqual(ctx.texts.filter((t) => t.font.includes('32px')), [], 'no cell holds a value')
  assert.deepEqual(ctx.texts.filter((t) => t.font.includes('48px')), [], 'no count, no outs')
  assert.ok(text.includes('SEASON STATS'))
  assert.ok(text.includes('BATTING ORDER'))
  assert.ok(text.includes('OBP'))
  assert.ok(text.includes('TEAM - '), 'the at-bat panel hangs empty')
  assert.ok(!text.includes('AARON'))
  assert.ok(!text.includes('JUDGE'))
  // "Not the top of an inning" wears the bottom's theme, per the reference.
  assert.equal(ctx.rects[0].fill, '#AD4126')
  // No headshot, no stand-in face: the card's corner is empty.
  assert.equal(ctx.images.length, 0)
  assert.equal(ctx.rects.filter((r) => r.w === 25 && r.h === 25).length, 0)
})

test('the headshot lands in the card corner, quantized to the reference palette', () => {
  const ctx = mockCtx()
  const photo = { fake: 'quantized canvas' }
  drawBillboard(ctx, MID_GAME, photo)
  // Bottom-right of the batter card: 300×300 at (756, 21) on the board.
  assert.deepEqual(ctx.images, [{ img: photo, x: 756, y: 21, w: 300, h: 300 }])

  // quantizeHeadshot snaps every block to the nearest palette colour and
  // keeps the block's own alpha (the reference's FilteredPhoto, block for block).
  const block = (r, g, b, a) => {
    const data = new Uint8ClampedArray(4 * 4 * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
    return { data, width: 4, height: 4 }
  }
  const white = block(250, 250, 250, 255)
  quantizeHeadshot(white, 4)
  assert.deepEqual([...white.data.slice(0, 4)], [212, 212, 212, 255])

  const red = block(209, 33, 33, 128)
  quantizeHeadshot(red, 4)
  assert.deepEqual([...red.data.slice(0, 4)], [209, 33, 33, 128])
  assert.equal(HEADSHOT_PALETTE.length, 16)
})

test('without a photo the board grows the batter pixel face in the headshot place', () => {
  const ctx = mockCtx()
  drawBillboard(ctx, MID_GAME)
  const facePixels = ctx.rects.filter((r) => r.w === 25 && r.h === 25)
  assert.ok(facePixels.length > 20, 'the stand-in face is drawn')
  for (const r of facePixels) {
    assert.ok(r.x >= 756 && r.x < 1056 && r.y >= 21 && r.y < 321, 'inside the card corner')
  }

  // No batter, no face.
  const empty = mockCtx()
  drawBillboard(empty, null)
  assert.equal(empty.rects.filter((r) => r.w === 25 && r.h === 25).length, 0)
})

test('each man gets a deterministic pixel face — same name, same face; different men, different faces', () => {
  const a1 = faceGrid('Aaron Judge', { cap: '#69c0ff' })
  const a2 = faceGrid('Aaron Judge', { cap: '#69c0ff' })
  assert.deepEqual(a1, a2)
  assert.notDeepEqual(a1, faceGrid('Gerrit Cole', { cap: '#69c0ff' }))

  // A 12×12 grid of colours (or null), with the cap and eye pixels in place.
  assert.equal(a1.length, 12)
  for (const row of a1) assert.equal(row.length, 12)
  const flat = a1.flat()
  assert.ok(flat.includes('#69c0ff'), 'cap colour is on the head')
  assert.ok(flat.includes('#241a12'), 'eyes are drawn')

  // The batter's helmet wears its ear flap in the cap's dark shade.
  const helmeted = faceGrid('Aaron Judge', { cap: '#69c0ff', helmet: true })
  assert.notDeepEqual(a1, helmeted)
  const darkCap = helmeted.flat().some((c) => c && c !== '#69c0ff' && c.startsWith('#4'))
  assert.ok(darkCap, 'helmet shading exists')
})

test('drawFace paints one cell per pixel and skips the nulls', () => {
  const ctx = mockCtx()
  drawFace(ctx, 0, 0, 2, [[null, '#fff'], ['#000', null]])
  assert.deepEqual(ctx.rects, [
    { x: 2, y: 0, w: 2, h: 2, fill: '#fff' },
    { x: 0, y: 2, w: 2, h: 2, fill: '#000' },
  ])
})

test('fitText clips a line to its panel', () => {
  const measure = { measureText: (t) => ({ width: String(t).length * 8 }) }
  assert.equal(fitText(measure, 'JUDGE', 1000), 'JUDGE')
  const clipped = fitText(measure, 'Some Improbably Long Minor League Name', 120)
  assert.ok(clipped.endsWith('…'))
  assert.ok(measure.measureText(clipped).width <= 120)
})

test('the board redraws only when something visible changes', () => {
  const same = boardKey(MID_GAME)
  assert.equal(same, boardKey({ ...MID_GAME }))
  // A different batter card, season line, count, out, half or linescore is a
  // different board…
  assert.notEqual(same, boardKey({ ...MID_GAME, batterLast: 'Stanton' }))
  assert.notEqual(same, boardKey({ ...MID_GAME, batterNumber: '98' }))
  assert.notEqual(same, boardKey({ ...MID_GAME, nextBatters: ['A', 'B', 'C'] }))
  assert.notEqual(same, boardKey({ ...MID_GAME, batterSeason: { ...MID_GAME.batterSeason, avg: '0.312' } }))
  assert.notEqual(same, boardKey({ ...MID_GAME, count: { balls: 3, strikes: 1 } }))
  assert.notEqual(same, boardKey({ ...MID_GAME, outs: 2 }))
  assert.notEqual(same, boardKey({ ...MID_GAME, inning: { ...MID_GAME.inning, isTop: false, state: 'Bottom' } }))
  assert.notEqual(same, boardKey({
    ...MID_GAME,
    linescore: {
      ...MID_GAME.linescore,
      away: { ...MID_GAME.linescore.away, leftOnBase: 5 },
    },
  }))
  assert.notEqual(same, boardKey({
    ...MID_GAME,
    linescore: {
      ...MID_GAME.linescore,
      innings: { ...MID_GAME.linescore.innings, away: [1, 0, 2, 1, null, null, null, null, null] },
    },
  }))
  // …while the team names the board prints are keyed too.
  assert.notEqual(same, boardKey({
    ...MID_GAME,
    teams: { ...MID_GAME.teams, away: { ...MID_GAME.teams.away, teamName: 'Yanks' } },
  }))
})
