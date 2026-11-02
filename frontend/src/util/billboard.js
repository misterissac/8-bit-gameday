// ---------------------------------------------------------------------------
// The park's big screen: a port of the solomon-gumball reference's jumbotron
// (its Scoreboard.tsx paints this same board onto the stadium's screen mesh,
// snapshotting it to a texture per event). Every line of text on the board is
// written here (the component in components/DynamicBillboard.jsx only owns
// the texture, the meshes and the headshot download), so the board's content
// can be read back in tests instead of argued about in pixels.
//
// The board is the reference's, laid out on its own 1060 px design surface:
// the at-bat panel on the left (TEAM - X, SEASON STATS, BATTING ORDER), the
// batter card in the middle (number badge, name, AVG/HR/RBI tags and the
// quantized headshot in its bottom-right corner), and the 17-column scoring
// grid along the bottom (team labels, innings 1-9, R H E LOB, B S O).
// ---------------------------------------------------------------------------

// The reference board's design surface: 1060 px wide at the 194/80 ratio its
// stadium model's screen uses (ScoreboardHTML's widthHeightRatio).
export const CANVAS_W = 1060
export const CANVAS_H = 437 // 1060 * 80 / 194

// The board's type scale: the reference sets fontSize 24 on the board root and
// sizes everything else in em multiples of it. Rubik is its house face (bold
// for the board's weight, black for the grid's "bolder" cells); with the face
// absent the canvas falls back to sans-serif and the layout holds.
const BASE = 24
// The reference lays its board out with CSS line-height "normal". Measured in
// the browser, Rubik's normal line box is 28 px at the board's 24 px base
// (1.1667), and the same ratio holds at the 2.16 em badge and 3.3 em name — so
// the reference's .colInfoBox rows land at 46 px, its headers at 36 and its
// batting-order rows at 38. A 1.2 ratio would slide the whole column ~5 px
// long by its last row.
const LH = 28 / 24
const font = (size, weight = 700) => `${weight} ${size}px Rubik, sans-serif`

export const COL = {
  // The reference flips its screen between these two by half inning
  // (Scoreboard.tsx: halfInning === 'top' ? '#4A3448' : '#AD4126' — anything
  // that is not the top of an inning, including no state at all, wears the
  // bottom's colour).
  themeTop: '#4A3448',
  themeBottom: '#AD4126',
  white: '#ffffff',
  black: '#000000',
  // Team-coloured caps for the offline stand-in headshot.
  accentAway: '#69c0ff',
  accentHome: '#ff8a65',
}

// Grid geometry. The bottom row is 36 px of header (28 + 4 px padding) over
// two 40 px score rows — the reference's .inningHeader/.inningScoreCell — and
// the batter card takes the rest of the board's height.
const GRID_HEADER_H = 36
const GRID_CELL_H = 40
const GRID_H = GRID_HEADER_H + 2 * GRID_CELL_H // 116
const TOP_H = CANVAS_H - GRID_H // 321
const LEFT_W = Math.round(CANVAS_W * 0.32) // the reference's 32% column
const INSET = 4 // the center panel's 4 px inset side borders
const PHOTO = 300 // the reference headshot's size, bottom-right of the card

// The 17 grid columns share the board on the reference's flex basis: the team
// column takes 150% of a column, every other one 100% (17.5 units in all).
const GRID_UNIT = CANVAS_W / 17.5
const colX = (col) => (col === 0 ? 0 : GRID_UNIT * 1.5 + (col - 1) * GRID_UNIT)
const colW = (col) => (col === 0 ? GRID_UNIT * 1.5 : GRID_UNIT)

// Shorten a name so a line of text can never run past its panel.
export function fitText(ctx, text, maxWidth) {
  const s = String(text ?? '')
  if (ctx.measureText(s).width <= maxWidth) return s
  let out = s
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1)
  }
  return `${out}…`
}

// The reference's StatValue prints ".406" — three decimals with the leading
// zero sliced off (its parseFloat(val).toFixed(3).slice(1)). Two of that
// line's accidents stay behind here: a missing stat prints blank rather than
// its parseFloat's "AN", and only an actual leading zero is trimmed, so an
// OPS past 1.000 keeps its digit (its slice(1) would print ".113").
function statValue(value) {
  const n = Number.parseFloat(value ?? '')
  return Number.isFinite(n) ? n.toFixed(3).replace(/^0/, '') : ''
}

// Draw the whole board for one game state onto the 2D context. ``gameState``
// is the trajectory payload's ``game_state`` snapshot and ``headshot`` is the
// batter's already-quantized photo canvas (see quantizeHeadshot); without one
// the board grows a deterministic pixel face in its place instead.
export function drawBillboard(ctx, gameState, headshot = null) {
  const inning = gameState?.inning ?? {}
  const isTop = inning.isTop === true
  const theme = isTop ? COL.themeTop : COL.themeBottom

  ctx.textBaseline = 'middle'
  ctx.fillStyle = theme
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  drawAtBatPanel(ctx, gameState, isTop)
  drawBatterCard(ctx, gameState, theme, isTop, headshot)
  drawScoringGrid(ctx, gameState, theme)
}

// ── The at-bat panel: TEAM - X, the season line, the next three up ──────────
// (the reference's 32% column, row for row: its .colInfoBox rows carry 7 px
// padding and a 4 px divider, its .colInfoBoxHeader rows white-on-black).
function drawAtBatPanel(ctx, gameState, isTop) {
  const teams = gameState?.teams ?? {}
  const season = gameState?.batterSeason ?? {}
  const batting = (isTop ? teams.away : teams.home) ?? {}
  const teamName = String(batting.teamName ?? '').toUpperCase()

  // The column's ground: black at the left edge fading to a 10% white wash at
  // the right (the reference's linear-gradient(.25turn, black, …)).
  const gradient = ctx.createLinearGradient(0, 0, LEFT_W, 0)
  gradient.addColorStop(0, COL.black)
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0.1)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, LEFT_W, TOP_H)

  let y = 0
  // One left-aligned row of the column's 24 px text, fitted to the panel when
  // ``maxWidth`` is given (the font has to be set before anything is measured).
  const textRow = (label, rowY, maxWidth = Infinity) => {
    ctx.textAlign = 'left'
    ctx.fillStyle = COL.white
    ctx.font = font(BASE)
    if (label) {
      ctx.fillText(maxWidth === Infinity ? label : fitText(ctx, label, maxWidth), 8, rowY)
    }
  }
  const divider = (at, color = 'rgba(1, 1, 1, 0.4)') => {
    ctx.fillStyle = color
    ctx.fillRect(0, at, LEFT_W, 4)
  }
  const headerRow = (label, at, h) => {
    ctx.fillStyle = COL.white
    ctx.fillRect(0, at, LEFT_W, h)
    ctx.fillStyle = COL.black
    ctx.font = font(BASE)
    ctx.textAlign = 'center'
    ctx.fillText(label, LEFT_W / 2, at + h / 2)
  }

  // TEAM - X (.colInfoBox). The reference lets a long name wrap onto a second
  // line, which grows its board past the screen's one fixed height; the board
  // here is always 437 px, so the line is fitted to the panel instead.
  const teamH = 7 + BASE * LH + 7 + 4
  textRow(`TEAM - ${teamName}`, y + 7 + (BASE * LH) / 2, LEFT_W - 16)
  divider(y + teamH - 4)
  y += teamH

  // SEASON STATS.
  const headerH = 4 + BASE * LH + 4
  headerRow('SEASON STATS', y, headerH)
  y += headerH

  // The season line: OBP / SLG / OPS in three equal StatValues.
  const statsH = 7 + BASE * LH + BASE * 1.4 * LH + 7 + 4
  const statW = (LEFT_W - 16) / 3
  ;[['OBP', season.obp], ['SLG', season.slg], ['OPS', season.ops]].forEach(([label, val], i) => {
    const cx = 8 + statW * (i + 0.5)
    ctx.textAlign = 'center'
    ctx.fillStyle = COL.white
    ctx.font = font(BASE)
    ctx.fillText(label, cx, y + 7 + (BASE * LH) / 2)
    const shown = statValue(val)
    if (shown) {
      ctx.font = font(BASE * 1.4)
      ctx.fillText(shown, cx, y + 7 + BASE * LH + (BASE * 1.4 * LH) / 2)
    }
  })
  divider(y + statsH - 4)
  y += statsH

  // BATTING ORDER and the next three due up (dividers under the first two).
  headerRow('BATTING ORDER', y, headerH)
  y += headerH
  const next = (gameState?.nextBatters ?? []).slice(0, 3)
  for (let i = 0; i < 3; i++) {
    const last = i === 2
    const rowH = 3 + BASE * LH + 3 + (last ? 0 : 4)
    textRow(next[i] == null ? '' : String(next[i]), y + 3 + (BASE * LH) / 2, LEFT_W - 16)
    if (!last) divider(y + rowH - 4, 'rgba(0, 0, 0, 0.3)')
    y += rowH
  }
}

// ── The batter card: number badge, name, the AVG/HR/RBI tags, the headshot ──
function drawBatterCard(ctx, gameState, theme, isTop, headshot) {
  const first = String(gameState?.batterFirst ?? '').toUpperCase()
  const last = String(gameState?.batterLast ?? '').toUpperCase()
  const season = gameState?.batterSeason ?? {}
  const panelRight = CANVAS_W - INSET

  // The panel's 4 px inset side borders.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)'
  ctx.fillRect(LEFT_W, 0, INSET, TOP_H)
  ctx.fillRect(panelRight, 0, INSET, TOP_H)

  const x0 = LEFT_W + INSET + 5 // the reference's marginLeft 5
  const y0 = TOP_H * 0.05

  // The number badge: a white pill's right end, the number in the theme
  // colour at 2.16 em (the reference's badge: 20/30/16 px of padding).
  const badgeH = 20 + 28 + 16
  ctx.font = font(BASE * 2.16)
  const numberText = gameState?.batterNumber == null ? '' : String(gameState.batterNumber)
  const badgeW = numberText ? 30 + ctx.measureText(numberText).width + 30 : 0
  if (numberText) {
    roundRectFill(ctx, x0, y0, badgeW, badgeH, [0, 40, 40, 0], COL.white)
    ctx.textAlign = 'center'
    ctx.fillStyle = theme
    ctx.fillText(numberText, x0 + badgeW / 2, y0 + 20 + 14)
  }

  // The first name beside the badge (the row aligns to the badge's bottom).
  ctx.textAlign = 'left'
  ctx.fillStyle = COL.white
  if (first) {
    ctx.font = font(BASE * 1.42)
    ctx.fillText(first, x0 + badgeW + 4, y0 + badgeH - (BASE * 1.42 * LH) / 2)
  }

  // The last name at 3.3 em under them, the way the reference stacks it.
  if (last) {
    ctx.font = font(BASE * 3.3)
    ctx.fillText(last, x0 + 2, y0 + badgeH - 5 + (BASE * 3.3 * LH) / 2)
  }

  // The AVG/HR/RBI tags (the reference's .tagEl: 4/13 px of padding in a
  // 100 px-radius pill on a half-black ground, nudged 4 px up).
  const pillFont = BASE * 1.1
  const pillH = 4 + pillFont * LH + 4
  const mid = y0 + badgeH - 5 + BASE * 3.3 * LH + 12 + pillH / 2
  let x = x0
  for (const [label, value] of [['AVG', season.avg], ['HR', season.hr], ['RBI', season.rbi]]) {
    ctx.font = font(pillFont)
    ctx.fillStyle = COL.white
    ctx.textAlign = 'left'
    ctx.fillText(label, x, mid)
    x += ctx.measureText(label).width
    const valueText = value == null ? '' : String(value)
    const pillW = Math.max(40, 26 + ctx.measureText(valueText).width)
    roundRectFill(ctx, x + 5, mid - pillH / 2 - 4, pillW, pillH, pillH / 2, 'rgba(0, 0, 0, 0.5)')
    if (valueText) {
      ctx.textAlign = 'center'
      ctx.fillText(valueText, x + 5 + pillW / 2, mid - 4)
    }
    x += 5 + pillW + 16
  }

  // The headshot, 300×300 in the card's bottom-right corner. Offline the
  // deterministic pixel face stands in for the reference's quantized photo.
  const photoX = panelRight - PHOTO
  const photoY = TOP_H - PHOTO
  if (headshot) {
    ctx.drawImage(headshot, photoX, photoY, PHOTO, PHOTO)
  } else {
    const name = String(gameState?.batter ?? '')
    if (name) {
      const cap = isTop ? COL.accentAway : COL.accentHome
      drawFace(ctx, photoX, photoY, PHOTO / FACE_GRID, faceGrid(name, { cap, helmet: true }))
    }
  }
}

// ── The scoring grid: team labels, innings 1-9, R H E LOB, B S O ────────────
// The reference's 17 ScoringGridColumns: an empty label column, one column
// per inning with the current one boxed in white, the four totals, then the
// count at 48 px. A half that has not started batted yet leaves its cell
// blank; the totals always read a number once the board has a game.
function drawScoringGrid(ctx, gameState, theme) {
  const teams = gameState?.teams ?? {}
  const inning = gameState?.inning ?? {}
  const count = gameState?.count ?? {}
  const linescore = gameState?.linescore ?? {}
  const awayLine = linescore.away ?? {}
  const homeLine = linescore.home ?? {}
  const innings = linescore.innings ?? {}
  const awayInnings = innings.away ?? []
  const homeInnings = innings.home ?? []
  const totalsLive = awayLine.runs != null || homeLine.runs != null

  for (let col = 0; col <= 16; col++) {
    const x = colX(col)
    const w = colW(col)
    const current = col >= 1 && col <= 9 && inning.number === col

    // Header band and score rows (.inningHeader/.inningScoreCell).
    ctx.fillStyle = current ? COL.white : 'rgba(255, 255, 255, 0.2)'
    ctx.fillRect(x, TOP_H, w, GRID_HEADER_H)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)'
    if (col >= 14) {
      ctx.fillRect(x, TOP_H + GRID_HEADER_H, w, 2 * GRID_CELL_H)
    } else {
      ctx.fillRect(x, TOP_H + GRID_HEADER_H, w, GRID_CELL_H)
      ctx.fillRect(x, TOP_H + GRID_HEADER_H + GRID_CELL_H, w, GRID_CELL_H)
    }

    // The label.
    const header = col === 0 ? '' : col <= 9 ? String(col) : ['R', 'H', 'E', 'LOB', 'B', 'S', 'O'][col - 10]
    if (header) {
      ctx.textAlign = 'center'
      ctx.fillStyle = current ? theme : COL.white
      ctx.font = font(BASE)
      ctx.fillText(header, x + w / 2, TOP_H + GRID_HEADER_H / 2)
    }

    // The values.
    const cell = (value, cy, size) => {
      if (value == null || value === '') return
      ctx.textAlign = 'center'
      ctx.fillStyle = COL.white
      ctx.font = font(size, 900)
      ctx.fillText(String(value), x + w / 2, cy)
    }
    const totals = (line, key) => (totalsLive ? (line[key] ?? 0) : null)
    if (col >= 14) {
      const value = col === 14 ? count.balls : col === 15 ? count.strikes : gameState?.outs
      cell(value, TOP_H + GRID_HEADER_H + GRID_CELL_H, 48)
    } else {
      const top = col === 0 ? teams.away?.abbreviation : awayInnings[col - 1]
      const bottom = col === 0 ? teams.home?.abbreviation : homeInnings[col - 1]
      const totalRow = { 10: 'runs', 11: 'hits', 12: 'errors', 13: 'leftOnBase' }[col]
      cell(
        totalRow ? totals(awayLine, totalRow) : top,
        TOP_H + GRID_HEADER_H + GRID_CELL_H / 2,
        32,
      )
      cell(
        totalRow ? totals(homeLine, totalRow) : bottom,
        TOP_H + GRID_HEADER_H + GRID_CELL_H * 1.5,
        32,
      )
    }
  }

  // The black rules the reference borders the grid with: after the team
  // column, around the R column, and before the B/S/O group.
  ctx.fillStyle = COL.black
  const rule = (x) => ctx.fillRect(x, TOP_H, 2, GRID_H)
  rule(colX(0) + colW(0) - 2)
  rule(colX(10))
  rule(colX(10) + colW(10) - 2)
  rule(colX(14))

  // The current inning's column, boxed in a 4 px white inset.
  const current = inning.number
  if (current >= 1 && current <= 9) {
    const x = colX(current)
    const w = colW(current)
    ctx.strokeStyle = COL.white
    ctx.lineWidth = 4
    ctx.strokeRect(x + 2, TOP_H + 2, w - 4, GRID_H - 4)
  }
}

// A rounded rectangle fill (the badge's pill end, the stat tags). ``radii`` is
// either one number for all four corners or the canvas order — top-left,
// top-right, bottom-right, bottom-left. It has to be that array: canvas's
// roundRect reads a named-corner object as a single point and quietly rounds
// nothing, which is how a board can lose every pill corner without an error.
// Plain rectangles stand in where a canvas has no roundRect at all.
function roundRectFill(ctx, x, y, w, h, radii, fill) {
  ctx.fillStyle = fill
  const corners = typeof radii === 'number' ? [radii, radii, radii, radii] : radii
  if (typeof ctx.roundRect === 'function' && typeof ctx.beginPath === 'function') {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, corners)
    ctx.fill()
    return
  }
  ctx.fillRect(x, y, w, h)
}

// ── The quantized headshot ──────────────────────────────────────────────────
// The reference's FilteredPhoto (solomon-gumball's components/FilteredPhoto):
// the headshot is cut into blockSize blocks and each block's average colour is
// snapped to the nearest colour of its theme palette. Ported block for block —
// palette, averages, distance and alpha handling included — so the pixelated
// headshot is the reference's own, not an imitation of it.

export const HEADSHOT_PALETTE = [
  [0.11, 0.11, 0.42],  // Dark Blue (#1D1B6B)
  [0.82, 0.13, 0.13],  // Bright Red (#D02020)
  [0.16, 0.41, 0.18],  // Dark Green (#2A682F)
  [0.97, 0.89, 0],     // Bright Yellow (#F8E300)
  [0, 0.65, 0.71],     // Cyan Blue (#00A6B5)
  [0.83, 0.83, 0.83],  // Light Gray (#D3D3D3)
  [0.96, 0.51, 0.19],  // Orange (#F58231)
  [0.42, 0.05, 0.68],  // Purple (#6A0DAD)
  [1.0, 0.41, 0.71],   // Pink (#FF69B4)
  [0.36, 0.25, 0.2],   // Dark Brown (#5C4033)
  [0.5, 1, 0],         // Bright Green (#7FFF00)
  [0.29, 0.29, 0.29],  // Dark Gray (#4B4B4B)
  [0.96, 0.8, 0.65],   // Light Skin Tone (#F5CBA7)
  [0.82, 0.65, 0.47],  // Medium Skin Tone (#D2A679)
  [0.55, 0.37, 0.24],  // Dark Skin Tone (#8C5E3C)
  [0.31, 0.2, 0.18],   // Very Dark Skin Tone (#4E342E)
]

// Quantize an ImageData in place (the reference's getFilteredImageCanvas
// loop), one block of ``blockSize`` px per palette colour.
export function quantizeHeadshot(imageData, blockSize = 4, palette = HEADSHOT_PALETTE) {
  const data = imageData.data
  for (let y = 0; y < imageData.height; y += blockSize) {
    for (let x = 0; x < imageData.width; x += blockSize) {
      const [color, alpha] = blockAverage(data, x, y, blockSize, imageData.width)
      const closest = closestColor(color, palette)
      setBlock(data, x, y, blockSize, imageData.width, closest, alpha)
    }
  }
  return imageData
}

// The reference's getBlockAverageColorAndAlpha, bounds check and all.
function blockAverage(data, startX, startY, blockSize, width) {
  let totalR = 0
  let totalG = 0
  let totalB = 0
  let totalA = 0
  let count = 0
  for (let y = startY; y < startY + blockSize; y++) {
    for (let x = startX; x < startX + blockSize; x++) {
      if (x < width && y < data.length / (width * 4)) {
        const index = (y * width + x) * 4
        totalR += data[index]
        totalG += data[index + 1]
        totalB += data[index + 2]
        totalA += data[index + 3]
        count++
      }
    }
  }
  return [
    [totalR / count, totalG / count, totalB / count],
    totalA / count,
  ]
}

// The reference's findClosestColor: Euclidean distance over the palette's
// 0-1 colours scaled to 0-255, returned as 0-255 bytes.
function closestColor(averageColor, palette) {
  let closest = palette[0]
  let closestDistance = Infinity
  for (const color of palette) {
    const distance = colorDistance(averageColor, color)
    if (distance < closestDistance) {
      closestDistance = distance
      closest = color
    }
  }
  return closest.map((c) => Math.round(c * 255))
}

function colorDistance(color1, color2) {
  return Math.sqrt(
    (color1[0] - color2[0] * 255) ** 2
    + (color1[1] - color2[1] * 255) ** 2
    + (color1[2] - color2[2] * 255) ** 2,
  )
}

// The reference's setBlockColorWithAlpha: the block keeps its own average
// alpha under the palette colour.
function setBlock(data, startX, startY, blockSize, width, color, alpha) {
  for (let y = startY; y < startY + blockSize; y++) {
    for (let x = startX; x < startX + blockSize; x++) {
      if (x < width && y < data.length / (width * 4)) {
        const index = (y * width + x) * 4
        data[index] = color[0]
        data[index + 1] = color[1]
        data[index + 2] = color[2]
        data[index + 3] = alpha
      }
    }
  }
}

// ── Player faces ─────────────────────────────────────────────────────────────
// The reference's scoreboard pixelates real headshots into a small blocky
// palette (its FilteredPhoto). Offline, the same blocky read is grown
// deterministically from the player's own name: same man, same face — a
// 12×12 pixel grid of skin, hair and team-coloured cap.

const FACE_GRID = 12

// Skin in three steps (lit / mid / shadow), same family as the reference's
// theme palette.
const FACE_SKIN = [
  ['#f5cba7', '#d2a679', '#b08558'],
  ['#d2a679', '#b08558', '#8c5e3c'],
  ['#8c5e3c', '#6d4629', '#4e342e'],
  ['#4e342e', '#3a251c', '#2a1913'],
]
const FACE_HAIR = ['#3b2a20', '#5c4033', '#1d1b6b', '#4b4b4b', '#d3d3d3', '#f58231', '#6a0dad', '#8a1f1b']
const FACE_EYE = '#241a12'
const FACE_MOUTH = '#8a3a32'

function hashSeed(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Darken a #rrggbb colour by a factor (for cap shadows and brims).
function shadeHex(hex, f) {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.round(((n >> 16) & 255) * f)
  const g = Math.round(((n >> 8) & 255) * f)
  const b = Math.round((n & 255) * f)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/**
 * The pixel face for one player: a FACE_GRID × FACE_GRID array of colours
 * (null = transparent), deterministic per name. `cap` is the team colour of
 * the cap or batting helmet; `helmet` draws the batter's ear-flapped helmet.
 */
export function faceGrid(name, { cap = COL.accentHome, helmet = false } = {}) {
  const rnd = mulberry32(hashSeed(String(name ?? '')))
  const [skin, shade, shadow] = FACE_SKIN[Math.floor(rnd() * FACE_SKIN.length)]
  const hair = FACE_HAIR[Math.floor(rnd() * FACE_HAIR.length)]
  const brimLeft = rnd() < 0.5
  const smile = rnd() < 0.5
  const freckles = rnd() < 0.35
  const capDark = shadeHex(cap, 0.62)

  const grid = Array.from({ length: FACE_GRID }, () => Array(FACE_GRID).fill(null))
  const put = (c, r, color) => {
    if (r >= 0 && r < FACE_GRID && c >= 0 && c < FACE_GRID) grid[r][c] = color
  }

  // Face block (rounded at the jaw).
  for (let r = 3; r <= 10; r++) {
    for (let c = 2; c <= 9; c++) {
      if (r === 10 && (c === 2 || c === 9)) continue
      put(c, r, c === 2 || c === 9 ? shade : skin)
    }
  }
  for (let c = 3; c <= 8; c++) put(c, 10, shadow)

  // Hair under the cap edge, with sideburns.
  for (let c = 2; c <= 9; c++) put(c, 3, hair)
  put(2, 4, hair)
  put(9, 4, hair)

  // Cap or batting helmet: crown rows + a brim to one side.
  const crown = helmet ? cap : cap
  put(1, 0, crown)
  put(10, 0, crown)
  for (let c = 1; c <= 10; c++) put(c, 1, crown)
  for (let c = 2; c <= 9; c++) put(c, 2, crown)
  for (let i = 0; i < 3; i++) {
    put(brimLeft ? 1 - i : 10 + i, 2, capDark)
  }
  if (helmet) {
    // The ear flap on the face's pitch side.
    const flap = brimLeft ? 10 : 1
    put(flap, 3, capDark)
    put(flap, 4, capDark)
    put(flap, 5, cap)
  }

  // Brows, eyes, nose, mouth.
  put(3, 5, hair)
  put(4, 5, hair)
  put(7, 5, hair)
  put(8, 5, hair)
  put(3, 6, FACE_EYE)
  put(8, 6, FACE_EYE)
  put(5, 7, shade)
  put(6, 7, shade)
  if (smile) {
    put(4, 8, shade)
    put(8, 8, shade)
    for (let c = 5; c <= 7; c++) put(c, 9, FACE_MOUTH)
  } else {
    for (let c = 4; c <= 7; c++) put(c, 9, FACE_MOUTH)
  }
  if (freckles) {
    put(3, 8, shade)
    put(8, 8, shade)
  }
  return grid
}

/** Paint a face grid at cell size `cell`, top-left at (x, y). */
export function drawFace(ctx, x, y, cell, grid) {
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const color = grid[r][c]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(x + c * cell, y + r * cell, cell, cell)
    }
  }
}

// One stable key per visible board state: the component redraws only when
// something on the board actually changed.
export function boardKey(gameState) {
  return JSON.stringify([
    gameState?.teams?.away?.abbreviation ?? null,
    gameState?.teams?.home?.abbreviation ?? null,
    gameState?.teams?.away?.teamName ?? null,
    gameState?.teams?.home?.teamName ?? null,
    gameState?.inning?.number ?? null,
    gameState?.inning?.isTop ?? null,
    gameState?.count?.balls ?? null,
    gameState?.count?.strikes ?? null,
    gameState?.outs ?? null,
    gameState?.batter ?? null,
    gameState?.batterNumber ?? null,
    gameState?.batterFirst ?? null,
    gameState?.batterLast ?? null,
    gameState?.nextBatters ?? null,
    gameState?.batterSeason ?? null,
    gameState?.linescore ?? null,
  ])
}
