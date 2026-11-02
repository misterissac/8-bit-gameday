import React, { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  BANNER,
  HORN,
  bannerHold,
  drumHold,
  fanFacing,
  handsOf,
  hornCant,
  hornCutout,
  musicInstrument,
  rowRight,
} from '../util/fanSprites'
import {
  ACTIVE_SECONDS,
  STAND_HEIGHT,
  actPoseUp,
  bannerReveal,
  bobAt,
  groupCycle,
  HORN_BOB,
  playStep,
  rowLift,
  rowStep,
  standProgress,
} from '../util/showMotion'
import {
  hashSeed,
  markBeat,
  mulberry32,
  raySwing,
  shoutBursts,
} from '../util/shoutMarks'

// ---------------------------------------------------------------------------
// CrowdShow: the stands' intermittent little shows.
//
// A row of fans stands up out of its seats and pumps a long pixelated banner
// held along the whole row, while cartoon shout marks flick off its two top
// corners; another row stands to play flat cut-out trumpets and drums held in
// their own hands, the bells aimed at the field, with musical notes rising off
// the instruments. The props are placed from the cheer poses' own hand
// texels (util/fanSprites.js) — never near the fans, always *in* their hands —
// and every show row keeps its own seats (Ballpark's `seatRow`): the fans sit,
// stand and step out from their own cushions, and the cloth spans the row from
// the two holders' hands.
//
// The row's motion — the stand-up, and the wave that travels along the cloth —
// is written once in util/showMotion.js as a function of (time, betweenness
// along the row). Ballpark draws the spectators, this component draws what they
// hold, and both evaluate the same function from the same clock: the hands and
// the cloth they grip cannot drift apart, because neither is animated here.
//
// The notes are particles: each has its own randomised spot above and in front
// of the row, its own lifetime, and fades in while it climbs out of the crowd
// and fades back out as it passes over it. The shout marks are not particles at
// all: they are two fixed marks, one over each top corner of the row, that lean
// up and out of the group on the corner's own side of the screen, flick between
// poses rather than climb, and swell out of the corner in whole steps and away
// again on their own beat (util/shoutMarks.js owns where they sit, how the boil
// is sampled and how big they are).
//
// Each group runs on its own clock: active for a few seconds, then idle,
// phase-shifted so the shows never fire in unison.
// ---------------------------------------------------------------------------

// ── Pixel textures ─────────────────────────────────────────────────────────

function pixelTexture(draw, w, h) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  draw(ctx)
  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// Long pennant banner the shouting row holds up together. The texture is cut
// to the cloth's own world length (one pixel per cloth texel), so the slogan
// is not stretched by the nine metres of row it spans — it is repeated along
// the cloth instead, the way a real long banner reads.
function createBannerTexture(text = "LET'S GO!", widthPx = 256, heightPx = 24) {
  const w = Math.max(64, Math.round(widthPx))
  const h = heightPx
  return pixelTexture((ctx) => {
    // Cloth with gold trim and dark under-edge
    ctx.fillStyle = '#7c1f1b'
    ctx.fillRect(0, 6, w, h - 8)
    ctx.fillStyle = '#b3312b'
    ctx.fillRect(0, 2, w, h - 6)
    ctx.fillStyle = '#fbc02d'
    ctx.fillRect(0, 2, w, 2)
    ctx.fillRect(0, h - 5, w, 2)
    // Pennant notches down both ends
    ctx.clearRect(0, 0, 6, h)
    ctx.clearRect(w - 6, 0, 6, h)
    ctx.fillStyle = '#fbc02d'
    for (let i = 0; i < 8; i++) {
      ctx.fillRect(0, 2 + i * 3, 6 - Math.floor(i / 2), 3)
      ctx.fillRect(w - 6 + Math.floor(i / 2), 2 + i * 3, 6, 3)
    }
    // The slogan, in as many cells as the cloth has room for
    const label = String(text).toUpperCase().slice(0, 14)
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 12px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const cell = label.length * 7 + 22
    const cells = Math.max(1, Math.round(w / cell))
    const step = w / cells
    for (let i = 0; i < cells; i++) {
      ctx.fillText(label, step * (i + 0.5), h / 2 + 1)
    }
  }, w, h)
}

// One shout wedge, drawn white (so the material's colour tints it, one crisp
// pixel art per group) and cut to a coarse pixel trapezium: two texels across at
// the root where it meets the crowd, six at the tip, widening in six chunky
// steps of four texels — a texel is three or four centimetres at the mark's own
// size, so the taper is a staircase of blocks rather than a grey-shaded cone.
// The right-hand column is a shade darker, which is what stops a flat wedge from
// reading as a plain white stripe.
function createShoutWedgeTexture() {
  const W = 6
  const H = 24
  const WIDTHS = [2, 2, 3, 4, 5, 6] // texels across, root to tip
  const STEP_ROWS = H / WIDTHS.length
  return pixelTexture((ctx) => {
    for (let row = 0; row < H; row++) {
      const width = WIDTHS[Math.min(WIDTHS.length - 1, Math.floor(row / STEP_ROWS))]
      const left = Math.floor((W - width) / 2)
      const y = H - 1 - row
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(left, y, width, 1)
      if (width > 2) {
        ctx.fillStyle = '#b9c6d2'
        ctx.fillRect(left + width - 1, y, 1, 1)
      }
    }
  }, W, H)
}

// Big pixelated musical note (a single eighth note or a beamed pair), drawn
// white and tinted per note so the song flies up in many colours.
function createNoteTexture(kind = 'single') {
  return pixelTexture((ctx) => {
    ctx.fillStyle = '#ffffff'
    const head = (x, y) => {
      ctx.fillRect(x, y, 9, 6)
      ctx.fillRect(x + 1, y - 1, 7, 1)
      ctx.fillRect(x + 1, y + 6, 7, 1)
    }
    if (kind === 'double') {
      head(4, 22)
      head(19, 18)
      ctx.fillRect(11, 6, 3, 17)
      ctx.fillRect(26, 2, 3, 17)
      ctx.fillRect(11, 3, 18, 4)
    } else {
      head(8, 22)
      ctx.fillRect(15, 5, 3, 18)
      ctx.fillRect(18, 5, 5, 3)
      ctx.fillRect(21, 8, 3, 4)
    }
  }, 32, 32)
}

// ── Instrument cut-outs ────────────────────────────────────────────────────
//
// Both instruments are drawn in the fans' own 8-bit idiom: chunky opaque
// texels, a one-pixel dark perimeter, and a double-sided cut-out that is lit
// with the row. The silhouette carries the outline, so the drum's sticks and
// the horn's bell stay crisp against the green deck at any distance.

// The fans' sprite outline, but for a prop of any size: every transparent
// texel touching an opaque one becomes the dark contour. Called after the art
// is drawn, with a texel of clear margin round it for the contour to grow into.
function outlineCutout(ctx, w, h, color = '#10141c') {
  const image = ctx.getImageData(0, 0, w, h)
  const data = image.data
  const filled = (x, y) => x >= 0 && x < w && y >= 0 && y < h
    && data[(y * w + x) * 4 + 3] > 20
  const border = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (filled(x, y)) continue
      if (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1)) {
        border.push([x, y])
      }
    }
  }
  ctx.fillStyle = color
  for (const [x, y] of border) ctx.fillRect(x, y, 1, 1)
}

// A one-texel brush walking a straight line, for the drumsticks. Kept to whole
// texels: a diagonal stick is a staircase, not a smooth stroke.
function pixelLine(ctx, x0, y0, x1, y1, color) {
  ctx.fillStyle = color
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0
  let y = y0
  for (;;) {
    ctx.fillRect(x, y, 1, 1)
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
  }
}

// A snare drum hanging flat in the fan's own plane, with the player's sticks
// gripped at the card's top corners — the two texels the play pose's hands
// wrap. Two frames beat against each other: in one the left stick is down on
// the head and the right is up, in the other it is the other way round, so the
// row reads as a drum roll at a low, stepped frame rate.
const DRUM_TEXELS = { width: 28, height: 22 }

function createDrumTexture(strike = 0) {
  const W = DRUM_TEXELS.width
  const H = DRUM_TEXELS.height
  return pixelTexture((ctx) => {
    // The drum: a gold upper hoop, a deep cream head, the red shell and a gold
    // lower hoop, with lugs down the shell. The silhouette's corners are cut a
    // texel at a time so it reads as a round drum and not a box.
    ctx.fillStyle = '#e2b531'
    ctx.fillRect(5, 5, 18, 1)
    ctx.fillRect(4, 6, 20, 1)
    ctx.fillRect(3, 7, 22, 1)
    ctx.fillRect(3, 12, 22, 1)
    ctx.fillRect(4, 19, 20, 1)
    ctx.fillRect(5, 20, 18, 1)
    ctx.fillStyle = '#f5f0e6'
    ctx.fillRect(3, 8, 22, 4)
    ctx.fillStyle = '#e6dfd0'
    ctx.fillRect(4, 10, 20, 2)
    ctx.fillStyle = '#d8d2c4'
    ctx.fillRect(5, 11, 18, 1)
    ctx.fillStyle = '#c62828'
    ctx.fillRect(3, 13, 22, 6)
    ctx.fillStyle = '#8e1b1b'
    ctx.fillRect(4, 18, 20, 1)
    ctx.fillStyle = '#f6d97a'
    ctx.fillRect(5, 5, 18, 1)
    ctx.fillRect(4, 8, 20, 1)
    ctx.fillStyle = '#a87f18'
    for (const x of [6, 10, 17, 21]) ctx.fillRect(x, 14, 2, 4)

    // Sticks: the grips sit on the card's top corners, in the palms, and the
    // tips cross over the head. One strikes while the other is lifted.
    const grips = [[1, 0], [W - 2, 0]]
    const tips = [[13, 9], [W - 14, 9]]
    const lifted = [[11, 3], [W - 12, 3]]
    for (let i = 0; i < 2; i++) {
      const down = (i === 0) === (strike === 0)
      const [gx, gy] = grips[i]
      const [tx, ty] = down ? tips[i] : lifted[i]
      pixelLine(ctx, gx, gy, tx, ty, '#f5c69b')
      // The bead on the tip: a second texel along the stick, so the end reads
      // as a bead rather than a cut length of dowel.
      ctx.fillStyle = '#d7a86e'
      ctx.fillRect(tx, ty, 1, 1)
      ctx.fillRect(tx, ty + (down ? 1 : -1), 1, 1)
    }
    outlineCutout(ctx, W, H)
  }, W, H)
}

// A trumpet in side elevation, drawn along the card's +x: mouthpiece at the
// near end, lead pipe with its three valve caps, and a bell flaring at the far
// end. The card stands across the fan's plane (see hornCutout in
// util/fanSprites.js) and is canted alternately down the row, so the field sees
// it at a three-quarter angle rather than edge-on.
const TRUMPET_TEXELS = { width: 36, height: 14 }

// The bell's mouth is a separate disc, cut to the horn's own bell size, facing
// out along the bell's aim. At a camera in front of the row the profile card is
// edge-on; the disc is the one part of the horn that is *face-on* there, and it
// reads as an open bell (bright rim, dark throat) instead of a missing prop. It
// is not a billboard: its normal is the horn's direction, fixed in the park.
const BELL_TEXELS = 24
// The rim band between the card's drawn bell and the mouth disc. It is a short
// open cylinder, gold like the bell, and it does two jobs: it finishes the
// flare that the card's art leaves off at its transparent margin, and it stands
// in front of the card so the profile's dark outline cannot cut across the
// face of the bell from a three-quarter view (at 22° the card's last column is
// several centimetres in front of the disc's plane at the disc's edge).
const BELL_RIM = 0.032

function createBellFaceTexture() {
  const S = BELL_TEXELS
  const c = (S - 1) / 2
  const max = S / 2 - 0.5
  return pixelTexture((ctx) => {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = Math.hypot(x - c, y - c)
        if (d > max) continue
        let colour
        if (d > max - 1.5) colour = '#f6d97a' // the rim, bright brass
        else if (d > max - 3) colour = '#d9a92b' // the flare
        else if (d > max - 5) colour = '#a87f18' // the inner cone
        else colour = '#6b4f10' // the throat, in shadow
        // The light falls from the upper left, as on every other cut-out: the
        // rim catches it and the lower right of the flare turns away.
        if (d > max - 2 && x < c && y < c + 1) colour = '#fff3b0'
        else if (d > max - 3 && x > c + 2 && y > c + 2) colour = '#b8860b'
        ctx.fillStyle = colour
        ctx.fillRect(x, y, 1, 1)
      }
    }
    outlineCutout(ctx, S, S)
  }, S, S)
}

function createTrumpetTexture() {
  const W = TRUMPET_TEXELS.width
  const H = TRUMPET_TEXELS.height
  return pixelTexture((ctx) => {
    const mid = 7
    // Mouthpiece and lead pipe.
    ctx.fillStyle = '#d9a92b'
    ctx.fillRect(1, mid - 1, 3, 3)
    ctx.fillStyle = '#6b4f10'
    ctx.fillRect(1, mid, 1, 1)
    ctx.fillStyle = '#d9a92b'
    ctx.fillRect(3, mid, 22, 2)
    ctx.fillStyle = '#f6d97a'
    ctx.fillRect(3, mid, 22, 1)
    // The valve block, centred on the card's grip — the point the play pose's
    // palms meet — with its three caps standing up off the tube.
    ctx.fillStyle = '#8a6a14'
    ctx.fillRect(14, mid - 2, 7, 4)
    ctx.fillStyle = '#f6d97a'
    for (const x of [14, 17, 20]) ctx.fillRect(x, mid - 4, 1, 3)
    ctx.fillStyle = '#8a6a14'
    for (const x of [15, 18]) ctx.fillRect(x, mid - 4, 1, 3)
    // The brace the far hand closes on, back along the lead pipe.
    ctx.fillStyle = '#8a6a14'
    ctx.fillRect(8, mid - 1, 2, 3)
    // Bell: a pixel cone opening away from the player, with a bright rim and a
    // dark mouth.
    for (let x = 25; x <= 33; x++) {
      const half = Math.round(1 + (x - 25) * 0.6)
      ctx.fillStyle = x > 31 ? '#f6d97a' : '#d9a92b'
      ctx.fillRect(x, mid - half, 1, half * 2 + 1)
    }
    ctx.fillStyle = '#8a6a14'
    ctx.fillRect(33, mid - 5, 1, 11)
    ctx.fillStyle = '#f6d97a'
    ctx.fillRect(32, mid - 5, 1, 11)
    outlineCutout(ctx, W, H)
  }, W, H)
}

// ── Sound colours ──────────────────────────────────────────────────────────

// Each burst and each note picks from this palette: no two groups shout in the
// same hue, and the notes of one song rise in several.
const SOUND_COLORS = ['#ffd54f', '#4dd0e1', '#ff6b9d', '#b2ff59', '#ffab40', '#b388ff']

// The marks have their own palette: the sound colours without the warm yellows
// and oranges. A shout mark stands exactly over a corner of the seating, and
// those corners are where the park's stair rails are — a yellow mark there read
// as more railing. White, cyan, pink, lime and violet all stand off the green
// deck, the red banner and the yellow rails.
const MARK_COLORS = ['#4dd0e1', '#ff6b9d', '#b2ff59', '#b388ff', '#ffffff']

// ── Held props ─────────────────────────────────────────────────────────────

// How many columns the cloth is cut into, so the wave can bend it along its
// length instead of moving it as one slab. One row of segments is enough: the
// wave lifts each column whole, so the cloth never shears.
const CLOTH_COLUMNS = 64

// ── The notes, and the marks ───────────────────────────────────────────────

const NOTE_COUNT = 12

// The music row's notes: where each one starts, how far it climbs, how fast it
// runs and how big it is. Everything is drawn from the group's own seed, so a
// row keeps the same flock of notes from one show to the next.
function buildNotes(group, textures) {
  const rng = mulberry32(hashSeed(`${group.id}-notes`))
  const span = Math.max(1.2, group.span ?? 2)
  const list = []
  for (let i = 0; i < NOTE_COUNT; i++) {
    const particle = {
      // Position along the row (+ = the field's right) and toward the field.
      along: (rng() - 0.5) * (span + 0.6),
      out: 0.25 + rng() * 0.75,
      // Notes start just over the instruments.
      start: 0.95 + rng() * 0.45,
      rise: 1.5 + rng() * 0.9,
      speed: 0.2 + rng() * 0.16,
      phase: rng(),
      scale: 0.34 + rng() * 0.16,
      spin: (rng() - 0.5) * 0.5,
      sway: 0.05 + rng() * 0.09,
      color: SOUND_COLORS[Math.floor(rng() * SOUND_COLORS.length)],
      texture: i % 2 === 0 ? textures.noteA : textures.noteB,
      material: null, // filled in below, one per note (its own opacity)
    }
    particle.material = new THREE.MeshBasicMaterial({
      map: particle.texture,
      color: particle.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    list.push(particle)
  }
  return list
}

// A shouting row's two marks, each a burst of three wedges sharing one material
// (so a group shouts in one colour) and one root to twitch and swell.
function buildBursts(group, textures) {
  const color = MARK_COLORS[hashSeed(group.id) % MARK_COLORS.length]
  return shoutBursts(group.id, group.span ?? 2).map((burst) => ({
    ...burst,
    material: new THREE.MeshBasicMaterial({
      map: textures.wedge,
      color,
      transparent: true,
      opacity: 0,
      // The cut-out is the wedge's own pixel silhouette: a fade must not blunt
      // its stepped edges into a soft cone.
      alphaTest: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  }))
}

// ── Props at the hands ─────────────────────────────────────────────────────

// Everything a group's show needs, laid out once: the banner across the whole
// row in every raised hand along it, one instrument per musician in its own
// hands, the music row's notes, and the shouting row's two corner marks.
function buildLayout(group, textures) {
  const facing = fanFacing(group.yaw)
  const right = rowRight(facing)
  const fans = [...(group.fans ?? [])]
  const along = (fan) => right.dot(new THREE.Vector3(fan.x, 0, fan.z))
  const span = fans.length
    ? Math.max(...fans.map(along)) - Math.min(...fans.map(along))
    : 2
  // Where a fan sits along its own row, 0 at the same end as the banner's left
  // holder: the wave is written in this coordinate, and Ballpark numbers its
  // spectators by the same projection onto the row's axis.
  const first = fans.length ? Math.min(...fans.map(along)) : 0
  const sOf = (fan) => (span > 0 ? (along(fan) - first) / span : 0)

  const layout = {
    group,
    facing,
    right,
    span,
    banner: null,
    instruments: [],
    notes: group.role === 'music' ? buildNotes({ ...group, span }, textures) : [],
    // The two marks sit at the row's own ends, so they need the span, which is
    // only known from the seats that were actually taken.
    bursts: group.role === 'shout' && fans.length >= 2 ? buildBursts({ ...group, span }, textures) : [],
  }

  if (group.role === 'shout' && fans.length >= 2) {
    // The cloth runs the length of the row, in both hands of both holders and
    // on the bottom edge of every raised hand between them (see bannerHold).
    const hold = bannerHold(fans, facing)
    // The cloth is cut into columns so the wave can bend it along its length:
    // each column is lifted whole, and its row coordinate is worked out once.
    const geometry = new THREE.PlaneGeometry(hold.width, BANNER.height, CLOTH_COLUMNS, 1)
    const positions = geometry.attributes.position
    const baseY = new Float32Array(positions.count)
    const columnS = new Float32Array(positions.count)
    for (let i = 0; i < positions.count; i++) {
      baseY[i] = positions.getY(i)
      columnS[i] = hold.sAt(positions.getX(i) / hold.width + 0.5)
    }
    layout.banner = {
      ...hold,
      geometry,
      baseY,
      columnS,
      texture: createBannerTexture(
        group.banner,
        hold.width / BANNER.texelHeight,
        Math.round(BANNER.height / BANNER.texelHeight),
      ),
    }
  }

  if (group.role === 'music') {
    fans.forEach((fan, i) => {
      // The same alternating assignment the row's sprites wear (musicPose in
      // util/fanSprites.js), so a fan in the drum pose is the one given a drum.
      const kind = musicInstrument(i)
      // Every player keeps its own seat and its own yaw, so the horn blows at
      // the field from that chair rather than from an averaged row direction.
      const playerFacing = fanFacing(fan.yaw)
      // A drum hangs flat in the player's own plane, its sticks gripped at the
      // card's top corners where the drum pose's hands are; a horn is a cut-out
      // standing across that plane, held at the tube's brace between the hands
      // and blown out at the field (see drumHold / hornCutout in
      // util/fanSprites.js). Either way the art is cut to the grips, so no
      // instrument floats in front of the hands holding it.
      //
      // Horns are canted in opposite directions down the row (`hornCant`): a
      // row of cards all square to the field is a row of hairlines from the
      // plate, while an alternating formation shows every camera a set of open
      // three-quarter silhouettes and still aims the bells at the field.
      let frame
      if (kind === 'drum') {
        frame = drumHold(fan)
      } else {
        const hands = handsOf(fan, 'play')
        frame = hornCutout(hands.left, hands.right, playerFacing, { cant: hornCant(i) })
      }
      layout.instruments.push({
        key: `${group.id}-inst-${i}`,
        kind,
        frame,
        // The card's size, and how far its centre sits from the frame's own
        // origin: the drum's card is centred on its grip row, the horn's card
        // is out along its bell from the brace.
        size: {
          width: kind === 'drum' ? frame.width : frame.length,
          height: frame.height,
          offset: kind === 'drum' ? 0 : frame.length / 2 - frame.grip,
        },
        // The art: the drum beats between its two stick frames, the horn has
        // the one silhouette and bobs instead.
        maps: kind === 'drum' ? [textures.drumA, textures.drumB] : [textures.trumpet],
        // The bell's mouth, in the card's own frame: along the horn's +x, out
        // past the drawn rim by the rim band's length. The two-texel margin at
        // the card's far end is where its outline was drawn, so the band starts
        // just inside the plane's end.
        bellAt: kind === 'drum' ? null : frame.length - frame.grip - 0.022 + BELL_RIM,
        phase: i * 1.1 + group.id.length,
        s: sOf(fan),
        // The player's own step out of its seat while it stands: the prop has
        // to follow the fan's arms, not the row's average direction.
        step: { x: playerFacing.x, z: playerFacing.z },
      })
    })
  }

  return layout
}

// ── Component ──────────────────────────────────────────────────────────────

// A prop's sway, kept as a rotation about its own local z and composed onto the
// frame's rotation each frame. Writing an Euler component (`rotation.z`) instead
// would rebuild the whole rotation from the Euler triple, and a yaw past a
// quarter turn does not decompose to a pure-yaw triple: three returns
// `(-π, θ, -π)` for one, so touching a single component silently rotates the
// prop by θ instead of leaving it facing the field.
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const SWAY = new THREE.Quaternion()

function setSway(mesh, base, angle) {
  mesh.quaternion.copy(base).multiply(SWAY.setFromAxisAngle(Z_AXIS, angle))
}

// `groups` entries (built by Ballpark from the seated audience):
//   { id, role: 'shout' | 'music', banner, anchor: {x,y,z}, yaw,
//     fans: [the show row's fan records — x, y, z, yaw, scaleX, scaleY] }
export function CrowdShow({ groups = [] }) {
  const textures = useMemo(() => {
    return {
      wedge: createShoutWedgeTexture(),
      noteA: createNoteTexture('single'),
      noteB: createNoteTexture('double'),
      // The drum's two stick frames beat against each other; the horn is one
      // silhouette. Both are cut-outs in the fans' own pixel idiom.
      drumA: createDrumTexture(0),
      drumB: createDrumTexture(1),
      bell: createBellFaceTexture(),
      trumpet: createTrumpetTexture(),
    }
  }, [])

  const layouts = useMemo(
    () => groups.map((g) => buildLayout(g, textures)),
    [groups, textures],
  )

  // One quad for every wedge, its narrow end at the root: each ray scales it to
  // its own width and length and swings it about that point, so three wedges of
  // three lengths can leave one corner.
  const streakGeometry = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1)
    geometry.translate(0, 0.5, 0)
    return geometry
  }, [])

  // Harness hook: what each show laid out (used by e2e/harness/crowd.html to
  // check that the props really sit at the hands). Never read by the app.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__crowdLayouts = layouts.map((l) => ({
      id: l.group.id,
      role: l.group.role,
      seatY: l.group.anchor?.y ?? null,
      banner: l.banner
        ? {
            width: l.banner.width,
            // The cloth's own bottom edge, and the grip it is lifted off.
            bottomY: l.banner.leftEnd.y,
            handY: l.banner.ends?.[0]?.y ?? null,
            normal: new THREE.Vector3(0, 0, 1)
              .applyQuaternion(l.banner.quaternion)
              .toArray(),
            center: l.banner.leftEnd.toArray(),
            ends: l.banner.ends?.map((p) => p.toArray()),
            fans: l.group.fans?.map((f) => [f.x, f.y, f.z]),
          }
        : null,
      instruments: l.instruments.map((i) => ({
        kind: i.kind,
        y: i.frame.position.y,
        x: i.frame.position.x,
        z: i.frame.position.z,
        // A horn's own +x: where its bell points, and how far out along it the
        // bell's mouth disc sits.
        aim: i.frame.direction ? i.frame.direction.toArray() : null,
        bellAt: i.bellAt ?? null,
      })),
      // The row's length, and the two marks over its corners: how far along the
      // row each sits, how high above the seats, and the three wedges' base
      // angles and lengths.
      span: l.span,
      bursts: l.bursts.map((b) => ({
        side: b.side,
        along: b.along,
        height: b.height,
        beat: b.beat,
        rays: b.rays.map((r) => ({
          angle: r.angle,
          offset: r.offset,
          lane: r.lane,
          length: r.length,
          width: r.width,
        })),
      })),
      facing: l.facing.toArray(),
    }))
  }, [layouts])

  const bannerRootRefs = useRef([])
  const bannerRefs = useRef([])
  const bannerTiltRefs = useRef([])
  const instrumentRefs = useRef([])
  const noteRefs = useRef([])
  const burstRefs = useRef([])

  // The cloths' textures, the notes' materials and the marks' materials are
  // owned by the layout; they die with it. The instrument cards share the
  // textures made above and their materials are their own meshes'.
  useEffect(() => () => {
    layouts.forEach((l) => {
      l.banner?.texture?.dispose()
      l.banner?.geometry?.dispose()
      l.notes.forEach((p) => p.material.dispose())
      l.bursts.forEach((b) => b.material.dispose())
    })
  }, [layouts])

  useEffect(() => () => streakGeometry.dispose(), [streakGeometry])

  useEffect(() => () => {
    Object.values(textures).forEach((t) => t.dispose())
  }, [textures])

  useFrame((state) => {
    const time = state.clock.elapsedTime

    layouts.forEach((layout, gi) => {
      const group = layout.group
      const { active, t } = groupCycle(time, gi, group.id)
      const fade = active ? Math.min(1, t * 2.5, (ACTIVE_SECONDS - t) * 2.5) : 0

      // A standing row steps out of its seats, toward the field. The props go
      // with it — the same `rowStep` the spectators are drawn with — so the
      // cloth and the hands holding it stay on top of each other.
      const step = rowStep(t)

      // ── The banner: rises out of the hands, folds back down into them ────
      const cloth = layout.banner
      const banner = bannerRefs.current[gi]
      if (banner && cloth) {
        const reveal = bannerReveal(t)
        banner.visible = active && reveal > 0.002
        // A vertical crop, not a squash: the cloth's quad shrinks to the part
        // that has come up and its own texture is cropped by the same amount,
        // so the slogan keeps its size and appears from the hands upward and
        // folds back down into them at the end of the act.
        banner.scale.y = Math.max(reveal, 1e-4)
        banner.position.y = (BANNER.height / 2) * reveal
        cloth.texture.repeat.y = Math.max(reveal, 1e-4)
        cloth.texture.offset.y = 0
        banner.material.opacity = Math.min(1, reveal * 2.4) * fade

        const root = bannerRootRefs.current[gi]
        if (root) {
          root.position.set(
            cloth.leftEnd.x + layout.facing.x * step,
            cloth.leftEnd.y,
            cloth.leftEnd.z + layout.facing.z * step,
          )
        }

        // The row stands up and then pumps: the whole cloth rides the holders'
        // hands, and the cloth's own wave bends it between them. Both come from
        // util/showMotion.js, the same functions the spectators are drawn with
        // in Ballpark, so the hands and the cloth cannot come apart.
        const lift = rowLift(t, time, cloth.sLeft)
        const tilt = bannerTiltRefs.current[gi]
        if (tilt) tilt.position.y = lift

        // Every column of the cloth rides the wave at its own point along the
        // row; the ends move with the grips, and the cloth ripples in between.
        const shape = standProgress(t)
        if (shape > 0) {
          const ends = bobAt(cloth.sLeft, time)
          const positions = cloth.geometry.attributes.position
          for (let i = 0; i < positions.count; i++) {
            positions.setY(i, cloth.baseY[i] + shape * (bobAt(cloth.columnS[i], time) - ends))
          }
          positions.needsUpdate = true
        }
      }

      // ── Instruments: held up in the players' own hands ──────────────────
      const instruments = instrumentRefs.current[gi] || []
      const handsUp = active && actPoseUp(t)
      instruments.forEach((entry, ii) => {
        if (!entry) return
        const inst = layout.instruments[ii]
        // Nothing is held while the row's hands are at its sides: the horn and
        // the drum appear and vanish on the same step the players' sprites
        // take their act pose on.
        entry.visible = handsUp
        if (!handsUp) return
        // The player's hands stand up, step forward and ride the wave, so the
        // horn or drum goes with them; the playing itself is a step clock on
        // top, not a drift of the prop away from the hands.
        const beat = playStep(time, inst.phase)
        entry.position.set(
          inst.frame.position.x + inst.step.x * step,
          inst.frame.position.y + rowLift(t, time, inst.s),
          inst.frame.position.z + inst.step.z * step,
        )
        if (inst.kind === 'trumpet') {
          // Blown: the bell nods into the mouthpiece and back on the beat.
          setSway(entry, inst.frame.quaternion, HORN_BOB[beat % HORN_BOB.length])
        } else {
          // Struck: the whole card holds its frame, and only the drawn sticks
          // change — left down, then right — so the hands never leave the grip.
          entry.quaternion.copy(inst.frame.quaternion)
          const card = entry.children[0]
          const map = inst.maps[beat % inst.maps.length]
          if (card?.material && card.material.map !== map) {
            card.material.map = map
            card.material.needsUpdate = true
          }
        }
      })

      // ── Notes: particles climbing over the music row ────────────────────
      const notes = noteRefs.current[gi] || []
      layout.notes.forEach((p, pi) => {
        const mesh = notes[pi]
        if (!mesh) return
        const life = (time * p.speed + p.phase) % 1
        if (!active) {
          p.material.opacity = 0
          mesh.visible = false
          return
        }
        mesh.visible = true
        // Billboarding: a flat quad in a camera-lit park would thin to a line
        // as the view swings round, so each particle turns to the camera and
        // only its own spin rides on top of that.
        const spin = p.spin + Math.sin(time * 1.3 + p.phase * 6.28) * 0.12
        setSway(mesh, state.camera.quaternion, spin)
        // The particle climbs from just over the fans to well above them,
        // drifting a little along the row as it goes.
        const height = p.start + life * p.rise
        const sway = Math.sin(life * Math.PI * 2 + p.phase * 6.28) * p.sway
        const along = p.along + sway
        const out = p.out + sway * 0.3
        mesh.position.set(
          group.anchor.x + layout.right.x * along + layout.facing.x * (out + step),
          group.anchor.y + height + standProgress(t) * STAND_HEIGHT,
          group.anchor.z + layout.right.z * along + layout.facing.z * (out + step),
        )
        // Fade in while it climbs out of the crowd, fade back out above it.
        const fadeIn = Math.min(1, Math.max(0, (life - 0.02) / 0.18))
        const fadeOut = Math.min(1, Math.max(0, (1 - life) / 0.34))
        p.material.opacity = active ? Math.min(fadeIn, fadeOut) * fade * 0.95 : 0
        mesh.scale.setScalar(p.scale * (0.92 + 0.2 * Math.min(1, life * 3)))
      })

      // ── The shout marks: three wedges thrown off each top corner ────────
      // Not a particle and not a climb: each mark is nailed to a corner of the
      // row, one and a half metres over the heads, and only its wedges move —
      // snapping between cartoon poses on a twelve-a-second clock while the
      // whole mark swells out of the corner and back in four whole steps, with
      // the root twitching a couple of centimetres. Both corners fire
      // alternately, so the row is always shouting from one side or the other.
      const bursts = burstRefs.current[gi] || []
      layout.bursts.forEach((burst, bi) => {
        const entry = bursts[bi]
        if (!entry?.root) return
        const beat = markBeat(burst, time)
        const opacity = active ? beat.alpha * fade : 0
        const showing = active && beat.visible && opacity > 0.01
        entry.root.visible = showing
        if (!showing) return
        // The shout is thrown: a nub on the corner, then full size, then away.
        entry.root.scale.setScalar(beat.swell)
        burst.material.opacity = opacity * 0.95
        // The mark lives in the camera's plane — a flat wedge seen edge-on is a
        // line — and the wedges' own angles are applied inside that.
        entry.root.quaternion.copy(state.camera.quaternion)
        entry.root.position.set(
          group.anchor.x
            + layout.right.x * (burst.along + beat.nudge.along)
            + layout.facing.x * step,
          group.anchor.y + burst.height + beat.nudge.up + standProgress(t) * STAND_HEIGHT,
          group.anchor.z
            + layout.right.z * (burst.along + beat.nudge.along)
            + layout.facing.z * step,
        )
        // Which side of the group the mark is on *as the camera sees it*. The
        // mark is billboarded, so its own +x is the camera's right; choosing
        // the lean in that plane is what keeps the picture straight-on right —
        // the mark to screen-left leans up and left, the one to screen-right up
        // and right — whichever side of the row the camera stands on.
        const m = state.camera.matrixWorld.elements
        const screenSide = m[0] * layout.right.x * burst.side + m[2] * layout.right.z * burst.side
        // A mark on the camera's right leans further right (negative, in the
        // billboard's own frame); one on the left leans left. The ray's own
        // angle only carries the lean's size and wobble, so it is the side, not
        // the sign it already has, that picks the way it points.
        const lean = screenSide > 0 ? -1 : 1
        burst.rays.forEach((ray, ri) => {
          const mesh = entry.rays[ri]
          if (!mesh) return
          const pose = raySwing(burst, ray, time)
          const angle = Math.abs(pose.angle) * lean
          // Two rules keep the three wedges off one another: the narrow end
          // sits ``offset`` out along its own line, so they start at three
          // depths, and it rides its own ``lane`` across the mark — outboard for
          // the diagonal wedge, inboard for the upright one — so a gap of sky
          // runs between the streaks for their whole length. The lane is
          // mirrored with the lean, so the outboard wedge stays on the outside
          // whichever side of the row the camera is on.
          mesh.position.set(
            -Math.sin(angle) * ray.offset + ray.lane * lean,
            Math.cos(angle) * ray.offset,
            0,
          )
          mesh.rotation.z = angle
          mesh.scale.set(ray.width, pose.length, 1)
        })
      })
    })
  })

  return (
    <group>
      {layouts.map((layout, gi) => {
        const group = layout.group
        return (
          <group key={group.id}>
            {layout.banner && (
              <group
                ref={(el) => { bannerRootRefs.current[gi] = el }}
                position={layout.banner.leftEnd}
                quaternion={layout.banner.quaternion}
              >
                <group ref={(el) => { bannerTiltRefs.current[gi] = el }}>
                  {/* The cloth, hanging from the two holders' hands: its left
                      end sits in the left hand, its right end in the right one.
                      It rises out of those hands from its bottom edge up. */}
                  <mesh
                    name={`crowd-banner-${group.id}`}
                    ref={(el) => { bannerRefs.current[gi] = el }}
                    geometry={layout.banner.geometry}
                    position={[layout.banner.width / 2, BANNER.height / 2, 0]}
                  >
                    <meshBasicMaterial
                      map={layout.banner.texture}
                      transparent
                      alphaTest={0.01}
                      side={THREE.DoubleSide}
                      toneMapped={false}
                      depthWrite={false}
                    />
                  </mesh>
                </group>
              </group>
            )}

            {/* Every musician's instrument, in its own hands: a flat drum card
                in the player's own plane, or a horn card standing across it
                with its bell out at the field, canted in formation. The horn's
                bell mouth is a disc on its own aim and a short rim band, so it
                stays an instrument at a camera the card is edge-on to. */}
            {layout.instruments.map((inst, ii) => (
              <group
                key={inst.key}
                name={inst.key}
                ref={(el) => {
                  if (!instrumentRefs.current[gi]) instrumentRefs.current[gi] = []
                  instrumentRefs.current[gi][ii] = el
                }}
                position={inst.frame.position}
                quaternion={inst.frame.quaternion}
              >
                <mesh position={[inst.size.offset, 0, 0]}>
                  <planeGeometry args={[inst.size.width, inst.size.height]} />
                  <meshStandardMaterial
                    map={inst.maps[0]}
                    alphaTest={0.5}
                    side={THREE.DoubleSide}
                    roughness={0.75}
                    metalness={0}
                    emissive="#2a220c"
                    emissiveIntensity={0.85}
                  />
                </mesh>
                {/* A horn's bell: a short rim band and the mouth disc. The
                    disc turns its face down the bell's own aim, so it is the
                    one part of the horn a camera in front of the row sees
                    face-on when the card is edge-on; the band carries the
                    flare out to it and hides the card's outline behind it.
                    Both ride the card's bob as children of the same group. */}
                {inst.bellAt != null && (
                  <>
                    <mesh
                      name={`${inst.key}-rim`}
                      position={[inst.bellAt - BELL_RIM / 2, 0, 0]}
                      rotation={[0, 0, -Math.PI / 2]}
                    >
                      <cylinderGeometry args={[
                        HORN.bell / 2,
                        HORN.bell / 2,
                        BELL_RIM,
                        8,
                        1,
                        true,
                      ]} />
                      <meshStandardMaterial
                        color="#d9a92b"
                        side={THREE.DoubleSide}
                        roughness={0.65}
                        metalness={0}
                        emissive="#2a220c"
                        emissiveIntensity={0.8}
                      />
                    </mesh>
                    <mesh
                      name={`${inst.key}-bell`}
                      position={[inst.bellAt, 0, 0]}
                      rotation={[0, Math.PI / 2, 0]}
                    >
                      <planeGeometry args={[HORN.bell, HORN.bell]} />
                      <meshStandardMaterial
                        map={textures.bell}
                        alphaTest={0.5}
                        side={THREE.DoubleSide}
                        roughness={0.7}
                        metalness={0}
                        emissive="#2a220c"
                        emissiveIntensity={0.9}
                      />
                    </mesh>
                  </>
                )}
              </group>
            ))}

            {/* The show's notes, climbing out of the music row */}
            {layout.notes.map((p, pi) => (
              <mesh
                key={`${group.id}-note-${pi}`}
                ref={(el) => {
                  if (!noteRefs.current[gi]) noteRefs.current[gi] = []
                  noteRefs.current[gi][pi] = el
                }}
                material={p.material}
                visible={false}
              >
                <planeGeometry args={[1, 1]} />
              </mesh>
            ))}

            {/* The row's two shout marks: three wedges per corner, sharing one
                material so the group shouts in a single colour. The group is
                turned to the camera each frame and scaled by the beat's swell;
                each wedge swings about the root at its own outboard lean. */}
            {layout.bursts.map((burst, bi) => (
              <group
                key={`${group.id}-mark-${bi}`}
                name={`crowd-mark-${group.id}-${bi}`}
                ref={(el) => {
                  if (!burstRefs.current[gi]) burstRefs.current[gi] = []
                  const entry = burstRefs.current[gi][bi] ?? { root: null, rays: [] }
                  entry.root = el
                  burstRefs.current[gi][bi] = entry
                }}
                visible={false}
              >
                {burst.rays.map((ray, ri) => (
                  <mesh
                    key={`${group.id}-mark-${bi}-${ri}`}
                    name={`crowd-mark-${group.id}-${bi}-${ri}`}
                    ref={(el) => {
                      if (!burstRefs.current[gi]) burstRefs.current[gi] = []
                      const entry = burstRefs.current[gi][bi] ?? { root: null, rays: [] }
                      entry.rays[ri] = el
                      burstRefs.current[gi][bi] = entry
                    }}
                    geometry={streakGeometry}
                    material={burst.material}
                  />
                ))}
              </group>
            ))}
          </group>
        )
      })}
    </group>
  )
}
