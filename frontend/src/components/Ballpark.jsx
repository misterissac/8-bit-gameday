import React, { useMemo, useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BATTER_BOX, BATTER_BOXES, CATCHER_BOX, FIELD, PLATE } from '../constants/field'
import { MOUND, createMoundGeometry } from '../constants/mound'
import { feetToM } from '../util/MathUtil'
import { CHEER_HANDS, LEGS, SEAT_RISE, legLength, musicPose } from '../util/fanSprites'
import { actPoseUp, groupCycle, rowLift, rowStep, standProgress } from '../util/showMotion'
import { addChamferedBox } from '../util/roundedGeometry'
import { seatFillRun } from '../util/crowdFill'
import { snapSeatWindow } from '../util/seatWindow'
import { CrowdShow } from './CrowdShow'
import { DynamicBillboard } from './DynamicBillboard'

// ---------------------------------------------------------------------------
// 8-bit / Minecraft-style Ballpark:
// Procedurally generated pixel textures (NearestFilter) with subtle dithering,
// manicured mowing stripes, authentic terracotta clay dirt diamond,
// full-extent checkered infield lawn, little 3D grass shrubs and tufts poking
// out from the field, smooth slanted pitcher's mound, chalk batter's boxes,
// padded outfield wall with yellow rail and distance markers,
// tiered stadium grandstands, and lively audience as moving coloured circles.
// ---------------------------------------------------------------------------

const GRASS_RADIUS = feetToM(400)
const WALL_RADIUS = feetToM(330)
const WARNING_TRACK_INNER = feetToM(314)
const DIRT_ARC_INNER = feetToM(44)
const DIRT_ARC_OUTER = feetToM(95)

// The corner's radial section line: the rows, the rear facades, the brick walls
// and the padded field wall all stop on it.
const CORNER_ANGLE = THREE.MathUtils.degToRad(47.3)

// Deterministic PRNG for stable pixel and shrub patterns
function createPRNG(seed = 12345) {
  let s = seed
  return function () {
    s = (s * 16807 + 0) % 2147483647
    return (s - 1) / 2147483646
  }
}

// 1. Pixel Grass: Minecraft-style grass with alternating mowing stripes
function createPixelGrassTexture() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rng = createPRNG(2026)

  const lightPal = ['#46a337', '#50b240', '#3e9630', '#5bbd4b', '#378729', '#4aa83b']
  const darkPal = ['#327b26', '#3b8b2e', '#2b6a1f', '#439935', '#245a1a', '#348028']

  for (let x = 0; x < size; x++) {
    const stripe = Math.floor(x / 32) % 2
    const pal = stripe === 0 ? lightPal : darkPal
    for (let y = 0; y < size; y++) {
      const r = rng()
      let c = pal[0]
      if (r < 0.45) c = pal[0]
      else if (r < 0.70) c = pal[1]
      else if (r < 0.85) c = pal[2]
      else if (r < 0.95) c = pal[3]
      else c = pal[4]
      ctx.fillStyle = c
      ctx.fillRect(x, y, 1, 1)
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

// The corner bed's planting: dark clumps of leaves, with holes cut clean
// through them.
//
// The court is not a lawn: it is a mass of bushes filling the gap between the
// two buildings, so its texture is built like foliage rather than turf. The
// tile is a grid of blocky leaf clumps -- a few deep greens to a clump, a lit
// tip here and there, a shadowed pocket underneath -- and one clump in eight
// loses a corner outright, so the bank reads as leaves with the dark behind
// them showing through instead of as a green panel. It is a nod to the bushes
// of the game and not a copy of them: the clumps are irregular and the palette
// is the park's own.
//
// The greens are deep: the texture is sampled as linear light, so the park's
// usual palette would come back several stops paler on screen.
function createCornerBedTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, size, size)
  const rng = createPRNG(6161)

  // Leaf shades, from the lit face of a clump down into the shadow between
  // them. Every clump is drawn from these, so the whole bed stays one planting.
  const pal = ['#16340f', '#1c3f14', '#122b0c', '#244a18', '#0e2209', '#2b541d']
  const lit = '#39672a'
  const shadow = '#081a05'
  const CLUMP = 8

  for (let cy = 0; cy < size; cy += CLUMP) {
    for (let cx = 0; cx < size; cx += CLUMP) {
      const base = pal[Math.floor(rng() * pal.length)]
      const hole = rng() < 0.13
      const holeX = Math.floor(rng() * CLUMP)
      const holeY = Math.floor(rng() * CLUMP)
      for (let y = 0; y < CLUMP; y++) {
        for (let x = 0; x < CLUMP; x++) {
          const px = cx + x
          const py = cy + y
          // A clump in eight is eaten away at one corner: a ragged hole big
          // enough to see the court through, not a single missing texel.
          const inHole = hole
            && Math.abs(x - holeX) <= 2
            && Math.abs(y - holeY) <= 2
            && Math.hypot(x - holeX, y - holeY) < 2.8
          // ...and a scatter of single-texel gaps keeps every edge broken up.
          if (inHole || rng() < 0.07) continue

          let c = base
          const r = rng()
          // The top of a clump catches the light, the bottom falls into the
          // shadow of the leaves below it: a voxel mass, not a flat sheet.
          if (y <= 1 && r < 0.55) c = lit
          else if (y >= CLUMP - 2 && r < 0.5) c = shadow
          else if (r < 0.22) c = pal[Math.floor(rng() * pal.length)]
          ctx.fillStyle = c
          ctx.fillRect(px, py, 1, 1)
        }
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

// 2. Infield Grass: Checkered lawn pattern
function createInfieldGrassTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rng = createPRNG(4242)

  const palA = ['#4da93d', '#58b848', '#449c36', '#61c54f', '#3d8f30']
  const palB = ['#3a872e', '#439535', '#327826', '#4ca53e', '#2a6520']

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const bx = Math.floor(x / 16)
      const by = Math.floor(y / 16)
      const pal = (bx + by) % 2 === 0 ? palA : palB
      const r = rng()
      let c = pal[0]
      if (r < 0.50) c = pal[0]
      else if (r < 0.75) c = pal[1]
      else if (r < 0.90) c = pal[2]
      else c = pal[3]
      ctx.fillStyle = c
      ctx.fillRect(x, y, 1, 1)
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

// 3. Pixel Infield Dirt: Warm terracotta clay with gravel flecks
function createPixelDirtTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rng = createPRNG(8888)

  const pal = ['#b46a39', '#bf7645', '#ca8351', '#a55e2f', '#914f25', '#d99260']

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const r = rng()
      let c
      if (r < 0.40) c = pal[0]
      else if (r < 0.65) c = pal[1]
      else if (r < 0.82) c = pal[2]
      else if (r < 0.93) c = pal[3]
      else if (r < 0.98) c = pal[4]
      else c = pal[5]
      ctx.fillStyle = c
      ctx.fillRect(x, y, 1, 1)
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

// 4A. 3-Blade Grass Sprout Texture: True Minecraft pixel art on a 16x10 grid (square 1cm pixels)
function create3BladeGrassTexture() {
  const w = 16
  const h = 10
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)

  // Grayscale luminance steps for Minecraft-style blocky lighting:
  // Tip highlight, sunward face, shadow face, root occlusion
  const C_TIP = '#ffffff'
  const C_HI = '#f4f4f4'
  const C_MID = '#d6d6d6'
  const C_SHD = '#9e9e9e'
  const C_ROOT = '#6a6a6a'

  const setPx = (x, y, color) => {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      ctx.fillStyle = color
      ctx.fillRect(x, y, 1, 1)
    }
  }

  // Blade 1 (Left blade: arches out to left, tip at row 2, x=3)
  setPx(3, 2, C_TIP)
  setPx(3, 3, C_HI);  setPx(4, 3, C_SHD)
  setPx(4, 4, C_HI);  setPx(5, 4, C_SHD)
  setPx(4, 5, C_HI);  setPx(5, 5, C_SHD)
  setPx(5, 6, C_HI);  setPx(6, 6, C_SHD)
  setPx(5, 7, C_HI);  setPx(6, 7, C_SHD)
  setPx(6, 8, C_MID); setPx(7, 8, C_SHD)
  setPx(6, 9, C_ROOT);setPx(7, 9, C_ROOT)

  // Blade 2 (Center blade: tallest, tip at row 0, x=8)
  setPx(8, 0, C_TIP)
  setPx(8, 1, C_HI);  setPx(9, 1, C_SHD)
  setPx(8, 2, C_HI);  setPx(9, 2, C_SHD)
  setPx(7, 3, C_HI);  setPx(8, 3, C_SHD)
  setPx(7, 4, C_HI);  setPx(8, 4, C_SHD)
  setPx(8, 5, C_HI);  setPx(9, 5, C_SHD)
  setPx(8, 6, C_HI);  setPx(9, 6, C_SHD)
  setPx(8, 7, C_HI);  setPx(9, 7, C_SHD)
  setPx(8, 8, C_MID); setPx(9, 8, C_SHD)
  setPx(8, 9, C_ROOT)

  // Blade 3 (Right blade: arches out to right, tip at row 2, x=13)
  setPx(13, 2, C_TIP)
  setPx(12, 3, C_HI);  setPx(13, 3, C_SHD)
  setPx(11, 4, C_HI);  setPx(12, 4, C_SHD)
  setPx(11, 5, C_HI);  setPx(12, 5, C_SHD)
  setPx(10, 6, C_HI);  setPx(11, 6, C_SHD)
  setPx(10, 7, C_HI);  setPx(11, 7, C_SHD)
  setPx(9,  8, C_MID); setPx(10, 8, C_SHD)
  setPx(9,  9, C_ROOT);setPx(10, 9, C_ROOT)

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// 4B. 4-Blade Grass Sprout Texture: True Minecraft pixel art on an 18x11 grid (square 1cm pixels)
function create4BladeGrassTexture() {
  const w = 18
  const h = 11
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)

  const C_TIP = '#ffffff'
  const C_HI  = '#f4f4f4'
  const C_MID = '#d6d6d6'
  const C_SHD = '#9e9e9e'
  const C_ROOT = '#6a6a6a'

  const setPx = (x, y, color) => {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      ctx.fillStyle = color
      ctx.fillRect(x, y, 1, 1)
    }
  }

  // Blade 1 (Far left: short arch, tip at row 5, x=2)
  setPx(2, 5, C_TIP)
  setPx(2, 6, C_HI);  setPx(3, 6, C_SHD)
  setPx(3, 7, C_HI);  setPx(4, 7, C_SHD)
  setPx(4, 8, C_HI);  setPx(5, 8, C_SHD)
  setPx(5, 9, C_MID); setPx(6, 9, C_SHD)

  // Blade 2 (Center-left: tall, tip at row 1, x=6)
  setPx(6, 1, C_TIP)
  setPx(6, 2, C_HI);  setPx(7, 2, C_SHD)
  setPx(7, 3, C_HI);  setPx(8, 3, C_SHD)
  setPx(7, 4, C_HI);  setPx(8, 4, C_SHD)
  setPx(8, 5, C_HI);  setPx(9, 5, C_SHD)
  setPx(8, 6, C_HI);  setPx(9, 6, C_SHD)
  setPx(8, 7, C_HI);  setPx(9, 7, C_SHD)
  setPx(8, 8, C_HI);  setPx(9, 8, C_SHD)
  setPx(8, 9, C_MID); setPx(9, 9, C_SHD)

  // Blade 3 (Center-right: tall, tip at row 2, x=11)
  setPx(11, 2, C_TIP)
  setPx(11, 3, C_HI);  setPx(12, 3, C_SHD)
  setPx(10, 4, C_HI);  setPx(11, 4, C_SHD)
  setPx(10, 5, C_HI);  setPx(11, 5, C_SHD)
  setPx(9,  6, C_HI);  setPx(10, 6, C_SHD)
  setPx(9,  7, C_HI);  setPx(10, 7, C_SHD)
  setPx(9,  8, C_HI);  setPx(10, 8, C_SHD)
  setPx(9,  9, C_MID); setPx(10, 9, C_SHD)

  // Blade 4 (Far right: medium arch, tip at row 4, x=15)
  setPx(15, 4, C_TIP)
  setPx(14, 5, C_HI);  setPx(15, 5, C_SHD)
  setPx(13, 6, C_HI);  setPx(14, 6, C_SHD)
  setPx(12, 7, C_HI);  setPx(13, 7, C_SHD)
  setPx(11, 8, C_HI);  setPx(12, 8, C_SHD)
  setPx(10, 9, C_MID); setPx(11, 9, C_SHD)

  // Root row (row 10)
  setPx(5, 10, C_SHD)
  setPx(6, 10, C_ROOT)
  setPx(7, 10, C_ROOT)
  setPx(8, 10, C_ROOT)
  setPx(9, 10, C_ROOT)
  setPx(10, 10, C_ROOT)
  setPx(11, 10, C_SHD)

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// 5. Outfield Warning Track: Cinder / crushed brick red
function createWarningTrackTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rng = createPRNG(9999)

  const pal = ['#9e4e2a', '#ab5a34', '#b96740', '#8f4220', '#7c3617']

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const r = rng()
      let c = pal[0]
      if (r < 0.42) c = pal[0]
      else if (r < 0.68) c = pal[1]
      else if (r < 0.85) c = pal[2]
      else if (r < 0.94) c = pal[3]
      else c = pal[4]
      ctx.fillStyle = c
      ctx.fillRect(x, y, 1, 1)
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

// 6. Outfield Wall Panel: Navy stadium padding with vertical seams
function createWallPadTexture() {
  const w = 64
  const h = 64
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const rng = createPRNG(31415)

  const base = '#1c385c'
  const hi = '#23446d'
  const lo = '#152c4a'
  const seam = '#0d1f35'

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (x % 16 === 0 || x % 16 === 15) {
        ctx.fillStyle = seam
      } else {
        const r = rng()
        ctx.fillStyle = r < 0.6 ? base : (r < 0.85 ? hi : lo)
      }
      ctx.fillRect(x, y, 1, 1)
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

// 7. Distance Sign: Pixel distance marker with yellow border
function createDistanceSignTexture(text) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#172f4e'
  ctx.fillRect(0, 0, 64, 32)

  ctx.strokeStyle = '#fbc02d'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, 62, 30)

  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 18px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 32, 16)

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// 7b. Simplistic 8-bit Ballpark Stadium Seats Texture (64x32):
// Pure simplistic pixelated shades, stepped gradients, and 8-bit checkerboard dithering.
// No numbers, no slats, no rivets, no pictorial textures — only clean, stylish pixelated tones.
// Left Half (X: 0..31): Pattern A (Classic rich ballpark green dithered gradient)
// Right Half (X: 32..63): Pattern B (Alternate forest green dithered gradient)
function createPixelSeatsTexture() {
  const w = 64
  const h = 32
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  // 5-tone stepped pixel palettes from sunlit highlight (0) down to base shadow (4)
  const PALETTE_A = [
    '#3ca850', // 0: Top highlight
    '#308a40', // 1: Light midtone
    '#246c32', // 2: Core ballpark green
    '#1b5226', // 3: Deeper shade
    '#133c1c', // 4: Base shadow
  ]

  const PALETTE_B = [
    '#369c49', // 0: Top highlight
    '#2a7e3a', // 1: Light midtone
    '#20622d', // 2: Core forest green
    '#184a22', // 3: Deeper shade
    '#103518', // 4: Base shadow
  ]

  function drawPixelGradientPattern(offsetX, palette) {
    const blockSize = 32
    for (let y = 0; y < blockSize; y++) {
      // Linear progression from 0 (top highlight) to 4 (bottom shadow)
      const val = (y / (blockSize - 1)) * (palette.length - 1)
      const baseIdx = Math.floor(val)
      const nextIdx = Math.min(baseIdx + 1, palette.length - 1)
      const frac = val - baseIdx

      const colA = palette[baseIdx]
      const colB = palette[nextIdx]

      for (let x = 0; x < blockSize; x++) {
        // 8-bit checkerboard dithering between tone steps
        const isDither = (x + y) % 2 === 0
        let c = frac < 0.28 ? colA : frac > 0.72 ? colB : isDither ? colA : colB

        // 1-pixel subtle edge border for clean voxel seat contour
        if (x === 0 || x === blockSize - 1) {
          c = palette[Math.min(baseIdx + 1, palette.length - 1)]
        }

        ctx.fillStyle = c
        ctx.fillRect(offsetX + x, y, 1, 1)
      }
    }
  }

  // Draw Pattern A (X: 0..31) and Pattern B (X: 32..63)
  drawPixelGradientPattern(0, PALETTE_A)
  drawPixelGradientPattern(32, PALETTE_B)

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// 8. Pixel Stadium Concrete Steps Texture: Authentic non-slip brushed concrete treads, aggregate flecks, expansion joints & safety curb lines
function createPixelStandsTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rng = createPRNG(9021)

  // A *shading* map, not a colour one: the stands' own greens live in the
  // geometry's vertex colours, and this multiplies a bright concrete over them,
  // so the bowl shows its panels and joints instead of going black.
  const cBase = '#cdd6c9'
  const cLight = '#dde5d8'
  const cDark = '#b6c1b3'
  const cFleck = '#e8eee4'
  const cJoint = '#94a193'
  const cCurb = '#f2f6ee'

  // Fill base concrete
  ctx.fillStyle = cBase
  ctx.fillRect(0, 0, size, size)

  // Non-slip aggregate dithering
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const r = rng()
      let c = cBase
      if (r < 0.25) c = cLight
      else if (r < 0.50) c = cDark
      else if (r < 0.65) c = cFleck
      ctx.fillStyle = c
      ctx.fillRect(x, y, 1, 1)
    }
  }

  // Expansion joint lines (horizontal and vertical score marks every 16 px)
  ctx.fillStyle = cJoint
  for (let y = 0; y < size; y += 16) {
    ctx.fillRect(0, y, size, 1)
  }
  for (let x = 0; x < size; x += 32) {
    ctx.fillRect(x, 0, 1, size)
  }

  // Subtle front tread safety edge stripe
  ctx.fillStyle = cCurb
  for (let y = 1; y < size; y += 16) {
    ctx.fillRect(0, y, size, 1)
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

// 8c. The brick the corner's two walls are laid in: courses and perpends,
// drawn as a *shading* map rather than a colour one.
//
// The walls' colour is their geometry's own -- the block's red, shaded face by
// face -- and this map multiplies it, so what it carries is the joints and the
// hand of the bricks: dark mortar in a running bond, each brick a shade or two
// off its neighbours, a lit arris along its top edge and a shadow under its
// bottom. Without it a brick face the height of a stand reads as a painted
// panel at any distance: the eye has no edges to find in it, only one red field.
//
// A tile is UV_METRES across (3 m), so the bricks are set in metres: a 0.5 m
// brick in a 0.25 m course. That is coarser than a real wall's, deliberately --
// from the plate the corner's brick is a few dozen pixels high, and a true
// 65 mm course would fall between the pixels and read as noise. Set against
// the stone dressings that cross it (0.26 m and 0.28 m courses), the wall still
// reads as brick laid to the scale of its own building.
function createBrickTexture() {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rng = createPRNG(4471)
  const px = size / UV_METRES

  const pitchX = 0.5
  const pitchY = 0.25
  const mortar = 0.03
  const width = pitchX - mortar
  const height = pitchY - mortar
  const courses = Math.round(UV_METRES / pitchY)
  const perCourse = Math.round(UV_METRES / pitchX)

  // Mortar first, so every joint is one field and the bricks are laid on it.
  ctx.fillStyle = '#33231f'
  ctx.fillRect(0, 0, size, size)

  // A brick's face, from the paler bricks of a course to the darker ones: the
  // wall's own red, warmed and cooled a shade at a time.
  const tones = ['#f5eee9', '#e9e0da', '#ddd2cb', '#f0e7e1', '#e3d8d1', '#d6c9c2']
  const lit = '#f8efe9'
  const under = '#7a625a'

  const lay = (x, y, tone) => {
    // A brick that runs over the tile's edge is drawn again on the far side, so
    // the running bond wraps without a seam.
    for (const shift of [-UV_METRES, 0, UV_METRES]) {
      const left = (x + shift) * px
      if (left > size || left + width * px < 0) continue
      const top = y * px
      const w = width * px
      const h = height * px
      ctx.fillStyle = tone
      ctx.fillRect(left, top, w, h)
      // The brick's top arris catches the light and its bottom sits in the
      // shadow of the course above: a line each, no more, so a brick still
      // reads as one flat face rather than a bevelled block.
      ctx.fillStyle = lit
      ctx.fillRect(left, top, w, Math.max(1, h * 0.06))
      ctx.fillStyle = under
      ctx.fillRect(left, top + h - Math.max(1, h * 0.09), w, Math.max(1, h * 0.09))
      // A handful of pitted pixels, so no two bricks are the same swatch.
      for (let i = 0; i < 3; i += 1) {
        if (rng() < 0.5) continue
        ctx.fillStyle = rng() < 0.5 ? under : lit
        ctx.fillRect(left + rng() * w, top + rng() * h, 1, 1)
      }
    }
  }

  for (let course = 0; course < courses; course += 1) {
    const y = course * pitchY + mortar / 2
    // Every other course starts half a brick in: a running bond, so no joint
    // runs unbroken up the wall.
    const stagger = course % 2 ? pitchX / 2 : 0
    const first = stagger ? -1 : 0
    for (let i = first; i < perCourse; i += 1) {
      const x = i * pitchX + stagger + mortar / 2
      lay(x, y, tones[Math.floor(rng() * tones.length)])
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  // A wall seen down the field is at grazing incidence: mipmaps keep the
  // courses from crawling there, while nearest magnification keeps the joints
  // square up close, like the rest of the park's pixel work.
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  return tex
}

// 8a. Batter's eye: the screen the hitter picks the ball up against (see
// createBattersEyeGeometry). A padding, not concrete: dark green cloth in a
// two-pixel weave, quilted into panels by a seam every 16 px, with the
// padding ringed by a painted retaining frame and a catchlight along its cap
// rail. It is a *colour* map — this is the one surface on the stands that is
// not the park's moulded concrete.
function createPixelBattersEyeTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rng = createPRNG(6113)

  // Dark enough to be a batter's eye and not a pale tarp: the face is the one
  // surface in the park turned up to the sky, so it is lit harder than the
  // concrete around it and has to be painted well under it to read as a screen.
  const cloth = '#08180f'
  const clothHi = '#0c2014'
  const clothLo = '#050f0a'
  const seam = '#030c07'
  const seamHi = '#0f2417'
  const frame = '#6f7358'
  const frameShadow = '#3c4335'
  const capLight = '#8f9677'

  // The weave: every other column a shade over the base, every other row a shade
  // under it, so the cloth reads as woven at arm's length and as a flat dark
  // green from the seats — which is what a batter's eye has to be.
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const over = (x % 2 === 0) === (y % 2 === 0)
      let c = over ? clothHi : clothLo
      if (rng() < 0.5) c = cloth
      if (rng() > 0.997) c = seamHi
      ctx.fillStyle = c
      ctx.fillRect(x, y, 1, 1)
    }
  }

  // Quilted panels: one seam every 8 px, with the faintest lit edge on its
  // bright side. It has to be a seam and not a stripe — a batter's eye is a
  // blank surface, so the padding is legible up close and flat from the seats.
  for (let x = 0; x < size; x += 8) {
    ctx.fillStyle = seam
    ctx.fillRect(x, 0, 1, size)
    ctx.fillStyle = seamHi
    ctx.fillRect(x + 1, 0, 1, size)
  }

  // The painted frame the panel is finished with: a dark shadow line inside a
  // bright rail, inset from the panel's own edge.
  ctx.fillStyle = seam
  ctx.fillRect(0, 0, size, 1)
  ctx.fillRect(0, size - 1, size, 1)
  ctx.fillRect(0, 0, 1, size)
  ctx.fillRect(size - 1, 0, 1, size)
  for (const [x, y, w, h] of [
    [1, 1, size - 2, 2],
    [1, size - 3, size - 2, 2],
    [1, 1, 2, size - 2],
    [size - 3, 1, 2, size - 2],
  ]) {
    ctx.fillStyle = frame
    ctx.fillRect(x, y, w, h)
  }
  ctx.fillStyle = frameShadow
  ctx.fillRect(3, 3, size - 6, 1)
  ctx.fillRect(3, size - 4, size - 6, 1)
  ctx.fillRect(3, 3, 1, size - 6)
  ctx.fillRect(size - 4, 3, 1, size - 6)
  // ...and the catchlight along the cap rail at the top of the panel.
  ctx.fillStyle = capLight
  ctx.fillRect(1, 1, size - 2, 1)

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

// 8b. Roof Skin: pixel-shaded standing-seam metal. Vertical seams every 8 px
// (the ribs that run down the slope on a slab), a bright rib edge, darker pans
// between them, a few bolt heads and weather specks, all stepped tones with
// 8-bit dithering. It is a *shading* map: it multiplies the canopy's own vertex
// colour, so the roof keeps the park's green while the metal grain reads.
function createPixelRoofTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rng = createPRNG(4771)

  const pan = '#b7c4ba'
  const panHi = '#c8d4ca'
  const panLo = '#a6b4aa'
  const ribHi = '#e2ebe3'
  const ribLo = '#7f8d83'
  const seam = '#68766c'
  const bolt = '#5a685e'
  const rust = '#b7a58a'

  for (let x = 0; x < size; x++) {
    const rib = x % 8
    for (let y = 0; y < size; y++) {
      const r = rng()
      let c = pan
      if (r < 0.2) c = panHi
      else if (r < 0.35) c = panLo
      // A rib every 8 px: dark seam, then a lit edge on its shadow side.
      if (rib === 0) c = seam
      else if (rib === 1) c = ribHi
      else if (rib === 7) c = ribLo
      // Bolt heads down each rib, every 16 px
      if (rib === 1 && y % 16 === 3) c = bolt
      // Weather: a rare freckle of rust
      if (r > 0.995) c = rust
      ctx.fillStyle = c
      ctx.fillRect(x, y, 1, 1)
    }
  }
  // Horizontal course line at the top and bottom of each tile
  ctx.fillStyle = seam
  ctx.fillRect(0, 0, size, 1)
  ctx.fillStyle = ribHi
  ctx.fillRect(0, 1, size, 1)

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

// 9. Pixel Backstop Billboard / Padding Texture: Authentic retro 8-bit ballpark sponsor boards behind home plate
function createPixelBackstopAdTexture() {
  const w = 256
  const h = 64
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  // Dark hunter green padded wall
  ctx.fillStyle = '#172c1a'
  ctx.fillRect(0, 0, w, h)

  // Top yellow caution bumper rail
  ctx.fillStyle = '#e6a817'
  ctx.fillRect(0, 0, w, 4)

  // 4 retro pixel sponsor billboard panels
  const ads = [
    { title: '8-BIT GLOVE', sub: 'EST. 1989', bg: '#0e1f38', border: '#e6a817' },
    { title: 'PIXEL COLA', sub: 'ICE COLD', bg: '#8a1c14', border: '#ffffff' },
    { title: 'HOMERUN', sub: 'SPORTSWEAR', bg: '#1b3b22', border: '#66bb6a' },
    { title: 'POWER SLUGGER', sub: 'PRO BAT CO.', bg: '#2b1d3a', border: '#ab47bc' },
  ]

  const panelW = 58
  const pad = 5
  for (let i = 0; i < 4; i++) {
    const ad = ads[i]
    const px = pad + i * (panelW + pad)
    const py = 8
    const ph = h - 14

    ctx.fillStyle = ad.border
    ctx.fillRect(px, py, panelW, ph)
    ctx.fillStyle = ad.bg
    ctx.fillRect(px + 2, py + 2, panelW - 4, ph - 4)

    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 7px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(ad.title, px + panelW / 2, py + 10)

    ctx.fillStyle = ad.border
    ctx.font = '6px monospace'
    ctx.fillText(ad.sub, px + panelW / 2, py + 24)
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

// 10. Pixel LED Ribbon Display Texture: Concourse upper-deck fascia display with retro 8-bit text & graphics
function createPixelRibbonTexture() {
  const w = 512
  const h = 32
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  // Dark LED matrix background
  ctx.fillStyle = '#090e0b'
  ctx.fillRect(0, 0, w, h)

  // LED grid phosphors
  for (let x = 0; x < w; x += 2) {
    for (let y = 0; y < h; y += 2) {
      ctx.fillStyle = '#101812'
      ctx.fillRect(x, y, 1, 1)
    }
  }

  // Top and bottom gold/yellow border strips
  ctx.fillStyle = '#d4af37'
  ctx.fillRect(0, 0, w, 2)
  ctx.fillRect(0, h - 2, w, 2)

  // 8-bit messages
  const segments = [
    { text: '★ 8-BIT PLAY-BY-PLAY ★', col: '#ffeb3b', x: 12 },
    { text: 'HOME OF THE SLUGGERS', col: '#69f0ae', x: 175 },
    { text: '★ 100 MPH FASTBALL ★', col: '#ff5252', x: 345 },
  ]

  ctx.font = 'bold 9px monospace'
  ctx.textBaseline = 'middle'
  segments.forEach((s) => {
    ctx.fillStyle = s.col
    ctx.fillText(s.text, s.x, h / 2)
  })

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

// Helper: 1-pixel dark perimeter outline around audience sprite silhouette (classic 8-bit game contour)
function applySpriteOutline(ctx, outlineColor = '#10141c') {
  const w = 32
  const h = 32
  const imgData = ctx.getImageData(0, 0, w, h)
  const data = imgData.data

  const isFilled = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false
    return data[(y * w + x) * 4 + 3] > 20
  }

  const borderPixels = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isFilled(x, y)) {
        if (
          isFilled(x + 1, y) ||
          isFilled(x - 1, y) ||
          isFilled(x, y + 1) ||
          isFilled(x, y - 1)
        ) {
          borderPixels.push([x, y])
        }
      }
    }
  }

  ctx.fillStyle = outlineColor
  for (let i = 0; i < borderPixels.length; i++) {
    const [bx, by] = borderPixels[i]
    ctx.fillRect(bx, by, 1, 1)
  }
}

// -------------------------------------------------------------
// 1. 3D Volumetric Baseball Cap (Dome Hemisphere + Visor Bill)
// -------------------------------------------------------------
function draw3dBaseballCap(ctx, crownPal, visorPal, facingRight = true) {
  const cHi = crownPal.hi
  const cMid = crownPal.mid
  const cShd = crownPal.shd
  const cDeep = crownPal.deep
  const vHi = visorPal.hi
  const vMid = visorPal.mid
  const vShd = visorPal.shd

  // Apex Button (Y=3)
  ctx.fillStyle = crownPal.btn || '#ffffff'
  ctx.fillRect(15, 3, 2, 1)

  // Row 4 (narrow apex dome): X 12..19
  ctx.fillStyle = cMid; ctx.fillRect(12, 4, 8, 1)
  ctx.fillStyle = cHi; ctx.fillRect(13, 4, 3, 1)
  ctx.fillStyle = cShd; ctx.fillRect(19, 4, 1, 1)

  // Row 5: X 11..20
  ctx.fillStyle = cMid; ctx.fillRect(11, 5, 10, 1)
  ctx.fillStyle = cHi; ctx.fillRect(12, 5, 3, 1)
  ctx.fillStyle = cShd; ctx.fillRect(19, 5, 2, 1)

  // Row 6: X 10..21
  ctx.fillStyle = cMid; ctx.fillRect(10, 6, 12, 1)
  ctx.fillStyle = cHi; ctx.fillRect(11, 6, 3, 1)
  ctx.fillStyle = cShd; ctx.fillRect(20, 6, 2, 1)
  ctx.fillStyle = cDeep; ctx.fillRect(15, 6, 1, 1) // panel seam

  // Row 7: X 10..21
  ctx.fillStyle = cMid; ctx.fillRect(10, 7, 12, 1)
  ctx.fillStyle = cHi; ctx.fillRect(11, 7, 2, 1)
  ctx.fillStyle = cShd; ctx.fillRect(20, 7, 2, 1)
  ctx.fillStyle = cDeep; ctx.fillRect(15, 7, 1, 1)

  // Row 8: X 10..21
  ctx.fillStyle = cMid; ctx.fillRect(10, 8, 12, 1)
  ctx.fillStyle = cShd; ctx.fillRect(10, 8, 1, 1)
  ctx.fillStyle = cShd; ctx.fillRect(19, 8, 3, 1)
  ctx.fillStyle = cDeep; ctx.fillRect(15, 8, 1, 1)

  // Visor Bill projecting forward in 3D perspective
  if (facingRight) {
    ctx.fillStyle = vHi; ctx.fillRect(11, 9, 13, 1)
    ctx.fillStyle = vMid; ctx.fillRect(11, 9, 2, 1)
    ctx.fillStyle = vMid; ctx.fillRect(13, 10, 11, 1)
    ctx.fillStyle = vShd; ctx.fillRect(21, 10, 3, 1)
  } else {
    ctx.fillStyle = vHi; ctx.fillRect(8, 9, 13, 1)
    ctx.fillStyle = vMid; ctx.fillRect(19, 9, 2, 1)
    ctx.fillStyle = vMid; ctx.fillRect(8, 10, 11, 1)
    ctx.fillStyle = vShd; ctx.fillRect(8, 10, 3, 1)
  }
}

// -------------------------------------------------------------
// 2. 3D Volumetric Backward Cap
// -------------------------------------------------------------
function draw3dBackwardCap(ctx, crownPal, facingRight = true) {
  const cHi = crownPal.hi
  const cMid = crownPal.mid
  const cShd = crownPal.shd

  // Button
  ctx.fillStyle = crownPal.btn || '#ffffff'
  ctx.fillRect(15, 3, 2, 1)

  // Dome Crown (Y: 4..8)
  ctx.fillStyle = cMid; ctx.fillRect(12, 4, 8, 1)
  ctx.fillStyle = cHi; ctx.fillRect(13, 4, 3, 1)
  ctx.fillStyle = cShd; ctx.fillRect(19, 4, 1, 1)

  ctx.fillStyle = cMid; ctx.fillRect(11, 5, 10, 1)
  ctx.fillStyle = cHi; ctx.fillRect(12, 5, 3, 1)
  ctx.fillStyle = cShd; ctx.fillRect(19, 5, 2, 1)

  ctx.fillStyle = cMid; ctx.fillRect(10, 6, 12, 1)
  ctx.fillStyle = cHi; ctx.fillRect(11, 6, 3, 1)
  ctx.fillStyle = cShd; ctx.fillRect(20, 6, 2, 1)

  ctx.fillStyle = cMid; ctx.fillRect(10, 7, 12, 1)
  ctx.fillStyle = cHi; ctx.fillRect(11, 7, 2, 1)
  ctx.fillStyle = cShd; ctx.fillRect(20, 7, 2, 1)

  ctx.fillStyle = cMid; ctx.fillRect(10, 8, 12, 1)
  ctx.fillStyle = cShd; ctx.fillRect(19, 8, 3, 1)

  // Backward Arch Cutout & Adjustment Strap on the rear side
  if (facingRight) {
    ctx.fillStyle = cHi; ctx.fillRect(10, 9, 10, 1)
    ctx.fillStyle = '#1a1008'; ctx.fillRect(19, 8, 3, 1) // Hair visible through arch
    ctx.fillStyle = '#2c3e50'; ctx.fillRect(19, 9, 3, 1) // Snapback plastic strap
    ctx.fillStyle = cShd; ctx.fillRect(7, 8, 4, 2)       // Backward visor tab
    ctx.fillStyle = cMid; ctx.fillRect(7, 8, 4, 1)
  } else {
    ctx.fillStyle = cHi; ctx.fillRect(12, 9, 10, 1)
    ctx.fillStyle = '#1a1008'; ctx.fillRect(10, 8, 3, 1)
    ctx.fillStyle = '#2c3e50'; ctx.fillRect(10, 9, 3, 1)
    ctx.fillStyle = cShd; ctx.fillRect(21, 8, 4, 2)
    ctx.fillStyle = cMid; ctx.fillRect(21, 8, 4, 1)
  }
}

// -------------------------------------------------------------
// 3. 3D Volumetric Face & Expressive Facial Features
// -------------------------------------------------------------
function draw3dFace(ctx, skinPal, hairPal, expression = 'focused_smirk') {
  const sHi = skinPal.hi
  const sBase = skinPal.base
  const sShd = skinPal.shd
  const sDeep = skinPal.deep

  const hHi = hairPal.hi
  const hMid = hairPal.mid
  const hShd = hairPal.shd

  // 1. Visor Cast Shadow across forehead (Row 10)
  ctx.fillStyle = sShd; ctx.fillRect(11, 10, 10, 1)
  ctx.fillStyle = sDeep; ctx.fillRect(11, 10, 1, 1)

  // 2. 3D Spherical Face Base (Rows 11..16, X 11..20)
  for (let y = 11; y <= 16; y++) {
    ctx.fillStyle = sBase; ctx.fillRect(11, y, 10, 1)
    ctx.fillStyle = sShd; ctx.fillRect(11, y, 1, 1) // Left skull curve
    ctx.fillStyle = sShd; ctx.fillRect(20, y, 1, 1) // Right skull curve
  }

  // 3. 3D Hair framing head
  ctx.fillStyle = hMid; ctx.fillRect(9, 10, 2, 5)
  ctx.fillStyle = hShd; ctx.fillRect(21, 10, 2, 5)
  ctx.fillStyle = hHi; ctx.fillRect(9, 10, 1, 3)
  ctx.fillStyle = hShd; ctx.fillRect(22, 11, 1, 3)

  // 4. Rounded Chin (Y=17)
  ctx.fillStyle = sBase; ctx.fillRect(12, 17, 8, 1)
  ctx.fillStyle = sShd; ctx.fillRect(13, 17, 6, 1)

  // 5. Recessed Neck (Y: 18..19)
  ctx.fillStyle = sDeep; ctx.fillRect(13, 18, 6, 1)
  ctx.fillStyle = sShd; ctx.fillRect(13, 19, 6, 1)

  // =========================================================
  // EXPRESSION 0: 'focused_smirk' (Fan 0: Red Cap)
  // Intense game concentration, pupils shifted right toward batter, confident smirk
  // =========================================================
  if (expression === 'focused_smirk') {
    // Focused angled brows
    ctx.fillStyle = hShd; ctx.fillRect(12, 11, 3, 1)
    ctx.fillStyle = hShd; ctx.fillRect(17, 11, 3, 1)
    ctx.fillStyle = hMid; ctx.fillRect(14, 11, 1, 1)
    ctx.fillStyle = hMid; ctx.fillRect(17, 11, 1, 1)

    // Eyes looking to the right (towards the pitcher / batter)
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 12, 2, 2)
    ctx.fillStyle = '#111822'; ctx.fillRect(18, 12, 2, 2)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(14, 12, 1, 1) // Specular glint on right pupil side
    ctx.fillStyle = '#ffffff'; ctx.fillRect(19, 12, 1, 1)

    // 3D Nose bridge
    ctx.fillStyle = sHi; ctx.fillRect(15, 13, 1, 1)
    ctx.fillStyle = sShd; ctx.fillRect(15, 14, 2, 1)

    // Cheeks
    ctx.fillStyle = '#f06292'; ctx.fillRect(11, 14, 2, 1)
    ctx.fillStyle = '#f06292'; ctx.fillRect(20, 14, 1, 1)

    // Confident smirk (curving up on right)
    ctx.fillStyle = '#7a2e1d'; ctx.fillRect(14, 16, 4, 1)
    ctx.fillStyle = '#7a2e1d'; ctx.fillRect(17, 15, 1, 1) // Upturned corner
    ctx.fillStyle = '#ff8a80'; ctx.fillRect(14, 16, 1, 1)
  }

  // =========================================================
  // EXPRESSION 1: 'roaring_cheer' (Fan 1: Backward Cap & Foam Hand)
  // Huge open shouting mouth with teeth & tongue, excited arched brows
  // =========================================================
  else if (expression === 'roaring_cheer') {
    // High arched excited brows
    ctx.fillStyle = hShd; ctx.fillRect(12, 10, 3, 1)
    ctx.fillStyle = hShd; ctx.fillRect(17, 10, 3, 1)

    // Excited eyes, two texels square: bright enough to read as a cheer, small
    // enough to sit in the face rather than fill it.
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 12, 2, 2)
    ctx.fillStyle = '#111822'; ctx.fillRect(18, 12, 2, 2)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(13, 12, 1, 1) // Single shiny glint
    ctx.fillStyle = '#ffffff'; ctx.fillRect(18, 12, 1, 1)

    // Protruding nose
    ctx.fillStyle = sHi; ctx.fillRect(15, 13, 1, 1)
    ctx.fillStyle = sShd; ctx.fillRect(15, 14, 2, 1)

    // Bright cheering flushed cheeks
    ctx.fillStyle = '#ff4081'; ctx.fillRect(11, 13, 1, 2)
    ctx.fillStyle = '#ff4081'; ctx.fillRect(20, 13, 1, 2)

    // Big Roaring Shouting Mouth (:O / :D)
    ctx.fillStyle = '#3b0000'; ctx.fillRect(13, 15, 6, 3) // Deep throat cavity
    ctx.fillStyle = '#ffffff'; ctx.fillRect(14, 15, 4, 1) // Top teeth
    ctx.fillStyle = '#ef5350'; ctx.fillRect(14, 17, 4, 1) // Tongue
    ctx.fillStyle = '#7f0000'; ctx.fillRect(13, 15, 1, 1) // Mouth corners
    ctx.fillStyle = '#7f0000'; ctx.fillRect(18, 15, 1, 1)
  }

  // =========================================================
  // EXPRESSION 2: 'cool_sunglasses_smug' (Fan 2: Sunglasses & Soda Cup)
  // Asymmetrical raised brow, Wayfarer shades with diagonal glint, cocky half-smirk
  // =========================================================
  else if (expression === 'cool_sunglasses_smug') {
    // Raised left brow above shades
    ctx.fillStyle = hShd; ctx.fillRect(11, 10, 3, 1)
    ctx.fillStyle = hShd; ctx.fillRect(17, 11, 3, 1)

    // 3D Wayfarer Sunglasses
    ctx.fillStyle = '#0d131a'; ctx.fillRect(10, 11, 12, 4)
    ctx.fillStyle = '#1e2936'; ctx.fillRect(11, 12, 4, 2)
    ctx.fillStyle = '#1e2936'; ctx.fillRect(17, 12, 4, 2)
    // Diagonal specular glare stripes
    ctx.fillStyle = '#ffffff'; ctx.fillRect(11, 12, 1, 1)
    ctx.fillStyle = '#90caf9'; ctx.fillRect(12, 13, 1, 1)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(17, 12, 1, 1)
    ctx.fillStyle = '#90caf9'; ctx.fillRect(18, 13, 1, 1)
    // Frame shadow on cheek
    ctx.fillStyle = sShd; ctx.fillRect(11, 15, 10, 1)

    // 3D Nose bridge under glasses
    ctx.fillStyle = sShd; ctx.fillRect(15, 14, 2, 1)

    // Cocky half-smirk on right side
    ctx.fillStyle = '#5d4037'; ctx.fillRect(13, 16, 3, 1)
    ctx.fillStyle = '#5d4037'; ctx.fillRect(16, 15, 2, 2) // Upturned smirk corner
    ctx.fillStyle = '#ff8a80'; ctx.fillRect(16, 15, 1, 1)
  }

  // =========================================================
  // EXPRESSION 3: 'gasp_shout' (Fan 3: Newsboy Flat Cap, Mustache & Pennant)
  // High surprised brows, stunned wide eyes, round 'OOH!' gasp mouth beneath mustache
  // =========================================================
  else if (expression === 'gasp_shout') {
    // High surprised brows
    ctx.fillStyle = hShd; ctx.fillRect(12, 10, 3, 1)
    ctx.fillStyle = hShd; ctx.fillRect(17, 10, 3, 1)

    // Stunned wide eyes, a texel smaller: white sclera and a single dark pupil.
    ctx.fillStyle = '#ffffff'; ctx.fillRect(13, 11, 2, 2)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(18, 11, 2, 2)
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 12, 1, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(18, 12, 1, 1)

    // Nose bridge
    ctx.fillStyle = sHi; ctx.fillRect(15, 13, 1, 1)

    // Handlebar Mustache
    ctx.fillStyle = hMid; ctx.fillRect(11, 14, 10, 2)
    ctx.fillStyle = hHi; ctx.fillRect(12, 14, 8, 1)
    ctx.fillStyle = hShd; ctx.fillRect(10, 15, 2, 1)
    ctx.fillStyle = hShd; ctx.fillRect(20, 15, 2, 1)

    // Big round surprised 'O' gasp mouth below mustache
    ctx.fillStyle = '#3e1508'; ctx.fillRect(14, 16, 4, 2)
    ctx.fillStyle = '#1a0000'; ctx.fillRect(15, 16, 2, 1) // Dark open mouth cavity
    ctx.fillStyle = '#ff8a80'; ctx.fillRect(15, 17, 1, 1) // Lower lip
  }

  // =========================================================
  // EXPRESSION 4: 'tense_grimace' (Fan 4: Home Pinstripe No. 8)
  // Furrowed worried brows (\ /), wide nervous eyes, clenched teeth grit
  // =========================================================
  else if (expression === 'tense_grimace') {
    // Inward-sloping furrowed worry brows (\  /)
    ctx.fillStyle = hShd; ctx.fillRect(11, 10, 1, 1)
    ctx.fillStyle = hShd; ctx.fillRect(12, 11, 3, 1)
    ctx.fillStyle = hShd; ctx.fillRect(17, 11, 3, 1)
    ctx.fillStyle = hShd; ctx.fillRect(20, 10, 1, 1)

    // Anxious eyes staring intensely at full count, two texels square
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 12, 2, 2)
    ctx.fillStyle = '#111822'; ctx.fillRect(18, 12, 2, 2)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(13, 12, 1, 1)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(18, 12, 1, 1)

    // Sweating forehead drop (nervous drop on left temple!)
    ctx.fillStyle = '#64b5f6'; ctx.fillRect(11, 11, 1, 1)
    ctx.fillStyle = '#bbdefb'; ctx.fillRect(11, 12, 1, 1)

    // 3D Nose
    ctx.fillStyle = sHi; ctx.fillRect(15, 13, 1, 1)
    ctx.fillStyle = sShd; ctx.fillRect(15, 14, 2, 1)

    // Tense clenched teeth grimace (full solid rows of teeth, zero missing teeth!)
    ctx.fillStyle = '#212121'; ctx.fillRect(13, 15, 6, 2) // Grimace contour
    ctx.fillStyle = '#ffffff'; ctx.fillRect(14, 15, 4, 1) // Upper teeth
    ctx.fillStyle = '#eceff1'; ctx.fillRect(14, 16, 4, 1) // Lower teeth
  }

  // =========================================================
  // EXPRESSION 5: 'laughing_joy' (Fan 5: Gold & Black Cheering Fan)
  // Pure ecstatic victory! Eyes crinkled shut in happy arcs (^ ^), wide laughing mouth
  // =========================================================
  else if (expression === 'laughing_joy') {
    // High joyous brows
    ctx.fillStyle = hMid; ctx.fillRect(12, 10, 3, 1)
    ctx.fillStyle = hMid; ctx.fillRect(17, 10, 3, 1)

    // Happy crinkled curved eyes (^  ^)
    // Left eye arc
    ctx.fillStyle = '#111822'; ctx.fillRect(12, 12, 1, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 11, 2, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(15, 12, 1, 1)
    // Right eye arc
    ctx.fillStyle = '#111822'; ctx.fillRect(17, 12, 1, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(18, 11, 2, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(20, 12, 1, 1)

    // Huge rosy cheeks puffed up from laughing
    ctx.fillStyle = '#ff4081'; ctx.fillRect(11, 13, 2, 2)
    ctx.fillStyle = '#ff4081'; ctx.fillRect(19, 13, 2, 2)

    // Nose tip
    ctx.fillStyle = sHi; ctx.fillRect(15, 13, 1, 1)
    ctx.fillStyle = sShd; ctx.fillRect(15, 14, 2, 1)

    // Big wide victory laugh smile
    ctx.fillStyle = '#4a0000'; ctx.fillRect(13, 15, 6, 3)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(14, 15, 4, 1) // Upper teeth
    ctx.fillStyle = '#ff5252'; ctx.fillRect(14, 17, 4, 1) // Cheerful tongue
    ctx.fillStyle = '#7a2e1d'; ctx.fillRect(12, 15, 1, 1) // Dimple
    ctx.fillStyle = '#7a2e1d'; ctx.fillRect(19, 15, 1, 1)
  }

  // =========================================================
  // EXPRESSION 6: 'bubblegum_cool' (Fan 6: 90s Retro Teal Windbreaker)
  // Laid-back half-lidded cool gaze, blowing a 3D pink bubblegum bubble!
  // =========================================================
  else if (expression === 'bubblegum_cool') {
    // Laid-back straight brows
    ctx.fillStyle = hShd; ctx.fillRect(12, 11, 3, 1)
    ctx.fillStyle = hShd; ctx.fillRect(17, 11, 3, 1)

    // Half-lidded relaxed eyes (heavy eyelid on top row)
    ctx.fillStyle = sShd; ctx.fillRect(12, 12, 3, 1)
    ctx.fillStyle = sShd; ctx.fillRect(17, 12, 3, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 13, 2, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(18, 13, 2, 1)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(13, 13, 1, 1)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(18, 13, 1, 1)

    // 3D Nose
    ctx.fillStyle = sHi; ctx.fillRect(15, 13, 1, 1)

    // --- 3D Pink Bubblegum Bubble (X: 13..18, Y: 14..17) ---
    // Outer translucent sphere
    ctx.fillStyle = '#f06292'; ctx.fillRect(14, 14, 4, 4)
    ctx.fillStyle = '#f06292'; ctx.fillRect(13, 15, 6, 2)
    // Darker rim contour
    ctx.fillStyle = '#e91e63'; ctx.fillRect(14, 14, 4, 1)
    ctx.fillStyle = '#c2185b'; ctx.fillRect(14, 17, 4, 1)
    ctx.fillStyle = '#e91e63'; ctx.fillRect(13, 15, 1, 1)
    ctx.fillStyle = '#c2185b'; ctx.fillRect(13, 16, 1, 1)
    ctx.fillStyle = '#e91e63'; ctx.fillRect(18, 15, 1, 1)
    ctx.fillStyle = '#c2185b'; ctx.fillRect(18, 16, 1, 1)
    // Core bubble color
    ctx.fillStyle = '#f48fb1'; ctx.fillRect(14, 15, 3, 2)
    // 3D Spherical white highlight glint
    ctx.fillStyle = '#ffffff'; ctx.fillRect(14, 15, 1, 1)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(15, 15, 1, 1)
  }

  // =========================================================
  // EXPRESSION 7: 'playful_wink' (Fan 7: Violet Cap & Cheer Pom-Poms)
  // Left eye sparkling wide, right eye playfully winking shut with lashes, bright singing smile
  // =========================================================
  else if (expression === 'playful_wink') {
    // Cheerful arched brows
    ctx.fillStyle = hMid; ctx.fillRect(12, 10, 3, 1)
    ctx.fillStyle = hMid; ctx.fillRect(17, 10, 3, 1)

    // Left eye: a sparkle, two texels square, with a single highlight
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 11, 2, 2)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(13, 11, 1, 1)

    // Right Eye: Playful Winking Eye (horizontal wink curve with lashes)
    ctx.fillStyle = '#111822'; ctx.fillRect(17, 12, 3, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(17, 13, 1, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(19, 11, 1, 1) // Cute lash flick!

    // Rosy Apple Cheeks
    ctx.fillStyle = '#ff4081'; ctx.fillRect(11, 14, 2, 1)
    ctx.fillStyle = '#ff4081'; ctx.fillRect(19, 14, 2, 1)

    // 3D Nose
    ctx.fillStyle = sHi; ctx.fillRect(15, 13, 1, 1)
    ctx.fillStyle = sShd; ctx.fillRect(15, 14, 2, 1)

    // Bright cheerful singing smile
    ctx.fillStyle = '#d81b60'; ctx.fillRect(13, 15, 5, 2)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(14, 15, 3, 1) // White pearly teeth
    ctx.fillStyle = '#ff80ab'; ctx.fillRect(14, 16, 1, 1) // Lower lip
  }
}

// -------------------------------------------------------------
// 4. 3D Volumetric Baseball Jersey
// -------------------------------------------------------------
function draw3dBaseballJersey(ctx, jerseyPal, trimCol, opts = {}) {
  const jHi = jerseyPal.hi
  const jMid = jerseyPal.mid
  const jShd = jerseyPal.shd
  const jDeep = jerseyPal.deep

  // Shoulders slope down from neck (Y=19..20)
  ctx.fillStyle = jHi; ctx.fillRect(8, 19, 5, 1)
  ctx.fillStyle = jMid; ctx.fillRect(19, 19, 5, 1)

  // 3D Neck Collar / V-neck opening
  ctx.fillStyle = trimCol; ctx.fillRect(13, 19, 6, 2)
  ctx.fillStyle = jDeep; ctx.fillRect(15, 20, 1, 1)

  // Main Torso (Y: 20..28, X: 8..23)
  for (let y = 20; y <= 28; y++) {
    ctx.fillStyle = jMid; ctx.fillRect(8, y, 16, 1)
    ctx.fillStyle = jHi; ctx.fillRect(10, y, 1, 1)   // Cylindrical highlight
    ctx.fillStyle = jShd; ctx.fillRect(8, y, 1, 1)   // Left flank curve
    ctx.fillStyle = jShd; ctx.fillRect(22, y, 2, 1)  // Right flank curve
  }

  // Diagonal Armpit Tension Wrinkles
  ctx.fillStyle = jShd; ctx.fillRect(9, 21, 1, 1)
  ctx.fillStyle = jShd; ctx.fillRect(10, 22, 1, 1)
  ctx.fillStyle = jDeep; ctx.fillRect(21, 21, 1, 1)
  ctx.fillStyle = jDeep; ctx.fillRect(20, 22, 1, 1)

  // Center Placket & Buttons
  ctx.fillStyle = '#b0bec5'; ctx.fillRect(15, 21, 2, 8)
  ctx.fillStyle = trimCol; ctx.fillRect(15, 22, 1, 1)
  ctx.fillStyle = trimCol; ctx.fillRect(15, 25, 1, 1)
  ctx.fillStyle = trimCol; ctx.fillRect(15, 28, 1, 1)

  // Optional team number (e.g. "8")
  if (opts.number8) {
    ctx.fillStyle = '#e53935'; ctx.fillRect(10, 23, 3, 4)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(11, 24, 1, 1)
  }

  // Waist gathering fold above belt
  ctx.fillStyle = jShd; ctx.fillRect(9, 28, 5, 1)
  ctx.fillStyle = jDeep; ctx.fillRect(18, 28, 4, 1)

  // 3D Belt & Pants
  ctx.fillStyle = '#263238'; ctx.fillRect(8, 29, 16, 2)
  ctx.fillStyle = '#ffd54f'; ctx.fillRect(14, 29, 4, 1)
  ctx.fillStyle = '#263238'; ctx.fillRect(15, 29, 1, 1)

  // Hands resting on knees
  const skinShd = opts.skinShd || '#f5c69b'
  ctx.fillStyle = skinShd; ctx.fillRect(7, 28, 3, 3)
  ctx.fillStyle = skinShd; ctx.fillRect(22, 28, 3, 3)
  ctx.fillStyle = '#bcaaa4'; ctx.fillRect(7, 30, 3, 1)
  ctx.fillStyle = '#bcaaa4'; ctx.fillRect(22, 30, 3, 1)
}

// -------------------------------------------------------------
// 8 DISTINCT 3D VOLUMETRIC AUDIENCE VARIANTS WITH UNIQUE FACIAL EXPRESSIONS
// -------------------------------------------------------------

// Variant 0: Red Team Cap Fan - Focused Game Smirk
function createPixelFanTextureCap() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')

  const capCrown = { hi: '#ff5252', mid: '#e53935', shd: '#c62828', deep: '#8e0000', btn: '#ffffff' }
  const capVisor = { hi: '#ff6e6e', mid: '#e53935', shd: '#b71c1c' }
  const skinPal = { hi: '#fff3e0', base: '#ffdfba', shd: '#f5c69b', deep: '#d79459' }
  const hairPal = { hi: '#6d4c41', mid: '#4e342e', shd: '#271713' }
  const jerseyPal = { hi: '#ffffff', mid: '#f5f7f8', shd: '#d8dee3', deep: '#b0bec5' }

  draw3dBaseballCap(ctx, capCrown, capVisor, true)
  draw3dFace(ctx, skinPal, hairPal, 'focused_smirk')
  draw3dBaseballJersey(ctx, jerseyPal, '#e53935', { skinShd: skinPal.shd })

  applySpriteOutline(ctx, '#10141c')

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// Variant 1: Cheering Fan with Backward Blue Cap & 3D #1 Foam Hand - Roaring Cheer
function createPixelFanTextureFoam() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')

  const capCrown = { hi: '#42a5f5', mid: '#1e88e5', shd: '#1565c0', deep: '#0d47a1', btn: '#ffffff' }
  const skinPal = { hi: '#fff3e0', base: '#ffdfba', shd: '#e0ac69', deep: '#b57938' }
  const hairPal = { hi: '#5d4037', mid: '#3e2723', shd: '#1a0e0a' }
  const jerseyPal = { hi: '#fff59d', mid: '#fdd835', shd: '#fbc02d', deep: '#f57f17' }

  draw3dBackwardCap(ctx, capCrown, true)
  draw3dFace(ctx, skinPal, hairPal, 'roaring_cheer')

  // Torso (Y: 19..28)
  const jHi = jerseyPal.hi
  const jMid = jerseyPal.mid
  const jShd = jerseyPal.shd
  const jDeep = jerseyPal.deep

  ctx.fillStyle = jHi; ctx.fillRect(8, 19, 5, 1)
  ctx.fillStyle = jMid; ctx.fillRect(19, 19, 5, 1)
  ctx.fillStyle = '#1565c0'; ctx.fillRect(13, 19, 6, 2) // Blue crew-neck collar

  for (let y = 20; y <= 28; y++) {
    ctx.fillStyle = jMid; ctx.fillRect(8, y, 16, 1)
    ctx.fillStyle = jHi; ctx.fillRect(10, y, 1, 1)
    ctx.fillStyle = jShd; ctx.fillRect(8, y, 1, 1)
    ctx.fillStyle = jShd; ctx.fillRect(22, y, 2, 1)
  }

  // Armpit creases
  ctx.fillStyle = jShd; ctx.fillRect(9, 21, 1, 1)
  ctx.fillStyle = jShd; ctx.fillRect(10, 22, 1, 1)
  ctx.fillStyle = jDeep; ctx.fillRect(21, 21, 1, 1)
  ctx.fillStyle = jDeep; ctx.fillRect(20, 22, 1, 1)

  // Right hand down on knee
  ctx.fillStyle = skinPal.shd; ctx.fillRect(22, 28, 3, 3)
  ctx.fillStyle = '#bcaaa4'; ctx.fillRect(22, 30, 3, 1)

  // Pants & Belt
  ctx.fillStyle = '#1a237e'; ctx.fillRect(8, 29, 16, 2)
  ctx.fillStyle = '#ffd54f'; ctx.fillRect(14, 29, 4, 1)

  // Raised Left Arm cylinder (Y: 16..19, X: 4..7)
  ctx.fillStyle = jMid; ctx.fillRect(4, 16, 4, 4)
  ctx.fillStyle = jHi; ctx.fillRect(4, 16, 1, 4)
  ctx.fillStyle = jDeep; ctx.fillRect(7, 17, 1, 3) // Elbow fold

  // 3D Foam Hand Glove (X: 1..8, Y: 2..16) - shift = 1 so max X is 7..8, never overlapping face or hair!
  const foamRed = '#e53935'
  const foamHi = '#ff6e6e'
  const foamShd = '#b71c1c'
  const foamDeep = '#7f0000'

  // 1. Wrist Cuff opening wrapping around sleeve (Y: 15..16, X: 2..7)
  ctx.fillStyle = foamRed; ctx.fillRect(2, 15, 6, 1)
  ctx.fillStyle = foamShd; ctx.fillRect(2, 16, 6, 1)
  ctx.fillStyle = foamHi; ctx.fillRect(2, 15, 1, 1)

  // 2. Palm Body (Y: 8..14, X: 1..7)
  ctx.fillStyle = foamRed; ctx.fillRect(1, 8, 7, 7)
  ctx.fillStyle = foamHi; ctx.fillRect(1, 8, 1, 7)  // Left outer edge highlight
  ctx.fillStyle = foamShd; ctx.fillRect(7, 8, 1, 7) // Right outer shadow
  ctx.fillStyle = foamShd; ctx.fillRect(2, 14, 5, 1) // Base crease

  // 3. Curving Thumb (Y: 10..12, X: 7) - kept inside hand at X <= 7, NEVER overlapping hair (X: 9..10) or face (X: 11..20)!
  ctx.fillStyle = foamRed; ctx.fillRect(7, 10, 1, 3)
  ctx.fillStyle = foamHi; ctx.fillRect(7, 10, 1, 2)
  ctx.fillStyle = foamDeep; ctx.fillRect(6, 12, 1, 1) // Thumb crease

  // 4. Upright Index Finger (Y: 2..8, X: 4..6)
  ctx.fillStyle = foamHi; ctx.fillRect(4, 2, 2, 1) // Rounded apex tip
  ctx.fillStyle = foamHi; ctx.fillRect(3, 3, 1, 6) // Left highlight edge
  ctx.fillStyle = foamRed; ctx.fillRect(4, 3, 2, 6) // Main finger body
  ctx.fillStyle = foamShd; ctx.fillRect(6, 3, 1, 6) // Right shadow edge

  // 5. Folded Knuckles (Middle, Ring, Pinky curled beside index finger)
  // Middle (X: 2, Y: 7..8)
  ctx.fillStyle = foamHi; ctx.fillRect(2, 7, 1, 1)
  ctx.fillStyle = foamRed; ctx.fillRect(2, 8, 1, 1)
  // Ring (X: 1, Y: 8..9)
  ctx.fillStyle = foamHi; ctx.fillRect(1, 8, 1, 1)
  ctx.fillStyle = foamRed; ctx.fillRect(1, 9, 1, 1)
  // Pinky (X: 0, Y: 9..11)
  ctx.fillStyle = foamHi; ctx.fillRect(0, 9, 1, 1)
  ctx.fillStyle = foamShd; ctx.fillRect(0, 10, 1, 2)

  // 6. Seam stitches & creasing
  ctx.fillStyle = '#ffffff'; ctx.fillRect(4, 2, 2, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(3, 4, 1, 1)
  ctx.fillStyle = foamDeep; ctx.fillRect(3, 7, 1, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(1, 15, 6, 1) // Cuff stitch

  // 7. Iconic Stenciled "#1" with 3D drop shadow (X: 2..7, Y: 9..13)
  // Drop shadow
  ctx.fillStyle = '#210000'; ctx.fillRect(3, 11, 3, 3)
  ctx.fillStyle = '#210000'; ctx.fillRect(6, 10, 2, 5)
  // "#" glyph (X: 2..4, Y: 10..12)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(2, 10, 1, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(4, 10, 1, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(2, 11, 3, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(2, 12, 1, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(4, 12, 1, 1)
  // "1" numeral (X: 5..7, Y: 9..13)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(5, 9, 1, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(5, 10, 1, 3)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(4, 13, 3, 1)

  applySpriteOutline(ctx, '#10141c')

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// Variant 2: Cool Fan with 3D Sunglasses & Striped Ballpark Soda Cup - Cool Smug Half-Smirk
function createPixelFanTextureSoda() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')

  const capCrown = { hi: '#66bb6a', mid: '#43a047', shd: '#2e7d32', deep: '#1b5e20', btn: '#ffffff' }
  const capVisor = { hi: '#81c784', mid: '#43a047', shd: '#2e7d32' }
  const skinPal = { hi: '#fff3e0', base: '#ffe0bd', shd: '#d79459', deep: '#af6929' }
  const hairPal = { hi: '#455a64', mid: '#263238', shd: '#101010' }
  const jerseyPal = { hi: '#42a5f5', mid: '#1e88e5', shd: '#1565c0', deep: '#0d47a1' }

  draw3dBaseballCap(ctx, capCrown, capVisor, true)
  draw3dFace(ctx, skinPal, hairPal, 'cool_sunglasses_smug')

  // 3D Polo Shirt with Folded Collar Lapels
  const jHi = jerseyPal.hi
  const jMid = jerseyPal.mid
  const jShd = jerseyPal.shd

  ctx.fillStyle = jHi; ctx.fillRect(8, 19, 5, 1)
  ctx.fillStyle = jMid; ctx.fillRect(19, 19, 5, 1)

  // 3D Folded White Polo Collar (Lapels resting on chest)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(12, 19, 3, 2)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(17, 19, 3, 2)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(14, 21, 4, 3) // Center button tab
  ctx.fillStyle = '#1e88e5'; ctx.fillRect(15, 21, 1, 1) // Top button
  ctx.fillStyle = '#1e88e5'; ctx.fillRect(15, 23, 1, 1) // Bottom button
  ctx.fillStyle = '#cfd8dc'; ctx.fillRect(13, 21, 1, 3) // Lapel cast shadow

  // Main Torso
  for (let y = 21; y <= 28; y++) {
    ctx.fillStyle = jMid; ctx.fillRect(8, y, 16, 1)
    ctx.fillStyle = jHi; ctx.fillRect(10, y, 1, 1)
    ctx.fillStyle = jShd; ctx.fillRect(8, y, 1, 1)
    ctx.fillStyle = jShd; ctx.fillRect(22, y, 2, 1)
  }

  // Pants & Belt
  ctx.fillStyle = '#37474f'; ctx.fillRect(8, 29, 16, 2)
  ctx.fillStyle = '#b0bec5'; ctx.fillRect(14, 29, 4, 1)

  // Left hand on knee
  ctx.fillStyle = skinPal.shd; ctx.fillRect(7, 28, 3, 3)
  ctx.fillStyle = '#bcaaa4'; ctx.fillRect(7, 30, 3, 1)

  // 3D Tapered Ballpark Soda Cup with Straw (in right hand, X: 22..28, Y: 13..27)
  ctx.fillStyle = '#40c4ff'; ctx.fillRect(24, 13, 2, 4) // Straw poking out
  // 3D Plastic Cup Lid (oval perspective)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(22, 17, 6, 2)
  ctx.fillStyle = '#cfd8dc'; ctx.fillRect(22, 17, 1, 1)
  ctx.fillStyle = '#cfd8dc'; ctx.fillRect(27, 17, 1, 1)
  // Tapered Cup Body with Red & White Team Stripes
  ctx.fillStyle = '#e53935'; ctx.fillRect(23, 19, 5, 8)
  ctx.fillStyle = '#ff5252'; ctx.fillRect(23, 19, 1, 8) // Left highlight edge
  ctx.fillStyle = '#b71c1c'; ctx.fillRect(27, 19, 1, 8) // Right shadow edge
  ctx.fillStyle = '#ffffff'; ctx.fillRect(23, 22, 5, 2) // White diagonal branding stripe
  ctx.fillStyle = '#8e0000'; ctx.fillRect(23, 26, 5, 1) // Base rim shadow
  // Hand holding cup
  ctx.fillStyle = skinPal.shd; ctx.fillRect(21, 21, 3, 4)
  ctx.fillStyle = skinPal.hi; ctx.fillRect(21, 22, 1, 1)

  applySpriteOutline(ctx, '#10141c')

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// Variant 3: Tweed Newsboy Flat Cap, Mustache & Waving Team Pennant - Stunned Gasp "OOH!"
function createPixelFanTexturePennant() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')

  const capCrown = { hi: '#8d8d8d', mid: '#616161', shd: '#424242', deep: '#212121', btn: '#ffffff' }
  const skinPal = { hi: '#fff3e0', base: '#ffdfba', shd: '#fcd0a1', deep: '#d19056' }
  const hairPal = { hi: '#6d4c41', mid: '#4e342e', shd: '#271713' }
  const sweaterPal = { hi: '#ffa726', mid: '#fb8c00', shd: '#e65100', deep: '#bf360c' }

  // 3D Newsboy Flat Cap (Puffy 8-panel crown with short forward brim)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(15, 3, 2, 1)
  // Puffy overhang (Y: 4..8, wider than standard cap)
  ctx.fillStyle = capCrown.mid; ctx.fillRect(11, 4, 10, 1)
  ctx.fillStyle = capCrown.hi; ctx.fillRect(12, 4, 3, 1)
  ctx.fillStyle = capCrown.mid; ctx.fillRect(9, 5, 14, 1)
  ctx.fillStyle = capCrown.hi; ctx.fillRect(10, 5, 4, 1)
  ctx.fillStyle = capCrown.shd; ctx.fillRect(20, 5, 3, 1)
  ctx.fillStyle = capCrown.mid; ctx.fillRect(8, 6, 16, 1)
  ctx.fillStyle = capCrown.hi; ctx.fillRect(9, 6, 4, 1)
  ctx.fillStyle = capCrown.shd; ctx.fillRect(21, 6, 3, 1)
  ctx.fillStyle = capCrown.mid; ctx.fillRect(8, 7, 16, 1)
  ctx.fillStyle = capCrown.shd; ctx.fillRect(20, 7, 4, 1)
  // Peaked front brim
  ctx.fillStyle = capCrown.shd; ctx.fillRect(11, 8, 12, 2)
  ctx.fillStyle = capCrown.mid; ctx.fillRect(14, 8, 9, 1)

  draw3dFace(ctx, skinPal, hairPal, 'gasp_shout')

  // 3D Cable Knit Sweater (Ribbed V-neck, horizontal chest band, knit folds)
  const sHi = sweaterPal.hi
  const sMid = sweaterPal.mid
  const sShd = sweaterPal.shd

  ctx.fillStyle = sHi; ctx.fillRect(8, 19, 5, 1)
  ctx.fillStyle = sMid; ctx.fillRect(19, 19, 5, 1)
  ctx.fillStyle = '#fff8e1'; ctx.fillRect(13, 19, 6, 2) // Cream ribbed collar

  for (let y = 20; y <= 28; y++) {
    ctx.fillStyle = sMid; ctx.fillRect(8, y, 16, 1)
    ctx.fillStyle = sHi; ctx.fillRect(10, y, 1, 1)
    ctx.fillStyle = sShd; ctx.fillRect(8, y, 1, 1)
    ctx.fillStyle = sShd; ctx.fillRect(22, y, 2, 1)
  }

  // 3D Horizontal Knitted Accent Band with rib texture
  ctx.fillStyle = '#fff8e1'; ctx.fillRect(8, 23, 16, 2)
  ctx.fillStyle = '#cfd8dc'; ctx.fillRect(8, 23, 1, 1)
  ctx.fillStyle = '#cfd8dc'; ctx.fillRect(23, 23, 1, 1)
  // Cable knit stitch accents
  ctx.fillStyle = sShd; ctx.fillRect(12, 21, 1, 1); ctx.fillStyle = sHi; ctx.fillRect(12, 22, 1, 1)
  ctx.fillStyle = sShd; ctx.fillRect(18, 21, 1, 1); ctx.fillStyle = sHi; ctx.fillRect(18, 22, 1, 1)
  ctx.fillStyle = sShd; ctx.fillRect(12, 26, 1, 1); ctx.fillStyle = sHi; ctx.fillRect(12, 27, 1, 1)
  ctx.fillStyle = sShd; ctx.fillRect(18, 26, 1, 1); ctx.fillStyle = sHi; ctx.fillRect(18, 27, 1, 1)

  // Left hand resting on knee & slacks
  ctx.fillStyle = skinPal.shd; ctx.fillRect(7, 28, 3, 3)
  ctx.fillStyle = '#bcaaa4'; ctx.fillRect(7, 30, 3, 1)
  ctx.fillStyle = '#424242'; ctx.fillRect(8, 29, 16, 2)

  // 3D Waving Team Pennant on Wooden Flagpole (Held in right hand, X: 26..28, Y: 4..27)
  ctx.fillStyle = '#8d6e63'; ctx.fillRect(26, 4, 2, 24)
  ctx.fillStyle = '#d7ccc8'; ctx.fillRect(26, 4, 1, 24) // Pole highlight
  ctx.fillStyle = '#ffd54f'; ctx.fillRect(25, 3, 4, 2)  // Golden finial ball
  // Waving Pennant Flag (waving toward center-left, with wind ripple folds)
  const pennantPals = ['#ba68c8', '#9c27b0', '#7b1fa2', '#4a148c']
  for (let py = 0; py < 9; py++) {
    const pLen = Math.floor(12 * (1 - py / 8.0))
    const pCol = pennantPals[Math.min(3, Math.floor(py / 2.5))]
    ctx.fillStyle = pCol
    ctx.fillRect(26 - pLen, 5 + py, pLen, 1)
    if (pLen > 4) {
      ctx.fillStyle = '#e1bee7'
      ctx.fillRect(26 - pLen + 2, 5 + py, 1, 1)
    }
  }
  ctx.fillStyle = '#ffd54f'; ctx.fillRect(21, 7, 2, 2) // Golden star insignia
  ctx.fillStyle = skinPal.shd; ctx.fillRect(24, 22, 3, 4) // Hand holding pole

  applySpriteOutline(ctx, '#10141c')

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// Variant 4: Home Pinstripe Baseball Fan (Navy Cap with Gold Visor + "8" Jersey) - Tense Grimace
function createPixelFanTextureHomePinstripe() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')

  const capCrown = { hi: '#29b6f6', mid: '#0288d1', shd: '#01579b', deep: '#002f6c', btn: '#ffffff' }
  const capVisor = { hi: '#ffea00', mid: '#ffd54f', shd: '#ff8f00' }
  const skinPal = { hi: '#fff3e0', base: '#ffe0bd', shd: '#f5c69b', deep: '#d79459' }
  const hairPal = { hi: '#455a64', mid: '#263238', shd: '#121212' }
  const jerseyPal = { hi: '#ffffff', mid: '#f5f7f8', shd: '#d8dee3', deep: '#b0bec5' }

  draw3dBaseballCap(ctx, capCrown, capVisor, true)
  draw3dFace(ctx, skinPal, hairPal, 'tense_grimace')
  draw3dBaseballJersey(ctx, jerseyPal, '#01579b', { number8: true, skinShd: skinPal.shd })

  applySpriteOutline(ctx, '#10141c')

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// Variant 5: Cheering Gold & Black Fan with Both Arms Raised - Laughing Joy
function createPixelFanTextureGoldCheer() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')

  const capCrown = { hi: '#fff59d', mid: '#fdd835', shd: '#fbc02d', deep: '#f57f17', btn: '#212121' }
  const capVisor = { hi: '#424242', mid: '#212121', shd: '#000000' }
  const skinPal = { hi: '#fff3e0', base: '#ffdfba', shd: '#e0ac69', deep: '#b57938' }
  const hairPal = { hi: '#5d4037', mid: '#3e2723', shd: '#1a0e0a' }
  const jerseyPal = { hi: '#fff59d', mid: '#fdd835', shd: '#fbc02d', deep: '#f57f17' }

  draw3dBaseballCap(ctx, capCrown, capVisor, true)
  draw3dFace(ctx, skinPal, hairPal, 'laughing_joy')

  const jHi = jerseyPal.hi
  const jMid = jerseyPal.mid

  // Torso (Y: 20..28)
  for (let y = 20; y <= 28; y++) {
    ctx.fillStyle = jMid; ctx.fillRect(8, y, 16, 1)
    ctx.fillStyle = jHi; ctx.fillRect(10, y, 1, 1)
    // Black athletic side compression panels (accentuating 3D torso silhouette)
    ctx.fillStyle = '#212121'; ctx.fillRect(8, y, 2, 1)
    ctx.fillStyle = '#212121'; ctx.fillRect(22, y, 2, 1)
  }

  // Black collar band
  ctx.fillStyle = '#212121'; ctx.fillRect(13, 19, 6, 2)

  // Both Arms Raised in the Air! (3D Sleeves & Cheering Hands)
  // Left raised arm (X: 4..7, Y: 12..19)
  ctx.fillStyle = '#212121'; ctx.fillRect(5, 12, 3, 8)
  ctx.fillStyle = '#424242'; ctx.fillRect(5, 12, 1, 8) // Arm highlight
  // Right raised arm (X: 24..27, Y: 12..19)
  ctx.fillStyle = '#212121'; ctx.fillRect(24, 12, 3, 8)
  ctx.fillStyle = '#424242'; ctx.fillRect(24, 12, 1, 8)
  // Cheering Hands pumping up (Y: 9..11)
  ctx.fillStyle = skinPal.shd; ctx.fillRect(5, 9, 3, 3)
  ctx.fillStyle = skinPal.hi; ctx.fillRect(5, 9, 1, 1)
  ctx.fillStyle = skinPal.shd; ctx.fillRect(24, 9, 3, 3)
  ctx.fillStyle = skinPal.hi; ctx.fillRect(24, 9, 1, 1)

  // Pants & Belt
  ctx.fillStyle = '#1a237e'; ctx.fillRect(8, 29, 16, 2)
  ctx.fillStyle = '#ffd54f'; ctx.fillRect(14, 29, 4, 1)

  applySpriteOutline(ctx, '#10141c')

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// Variant 6: 90s Retro Teal Windbreaker Fan - Bubblegum Cool
function createPixelFanTextureTealWindbreaker() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')

  const capCrown = { hi: '#80deea', mid: '#26c6da', shd: '#00acc1', deep: '#00838f', btn: '#ffffff' }
  const skinPal = { hi: '#fff3e0', base: '#ffdfba', shd: '#f5c69b', deep: '#d79459' }
  const hairPal = { hi: '#4e342e', mid: '#271713', shd: '#150a07' }
  const jacketPal = { hi: '#80deea', mid: '#26c6da', shd: '#00acc1', deep: '#00838f' }

  draw3dBackwardCap(ctx, capCrown, true)
  draw3dFace(ctx, skinPal, hairPal, 'bubblegum_cool')

  const jHi = jacketPal.hi
  const jMid = jacketPal.mid
  const jShd = jacketPal.shd
  const jDeep = jacketPal.deep

  // Puffy 90s Windbreaker Stand-up Collar
  ctx.fillStyle = jDeep; ctx.fillRect(12, 18, 8, 2)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(13, 19, 6, 1) // White inner collar band

  // Puffed Nylon Shoulders & Torso
  ctx.fillStyle = jHi; ctx.fillRect(7, 19, 6, 1)
  ctx.fillStyle = jMid; ctx.fillRect(19, 19, 6, 1)

  for (let y = 20; y <= 28; y++) {
    ctx.fillStyle = jMid; ctx.fillRect(8, y, 16, 1)
    ctx.fillStyle = jHi; ctx.fillRect(10, y, 1, 1)
    ctx.fillStyle = jShd; ctx.fillRect(8, y, 1, 1)
    ctx.fillStyle = jShd; ctx.fillRect(22, y, 2, 1)
  }

  // 3D Bold Magenta Chevron Stripe (Nylon Colorblock V-geometry)
  ctx.fillStyle = '#e91e63'; ctx.fillRect(8, 22, 2, 2)
  ctx.fillStyle = '#e91e63'; ctx.fillRect(10, 23, 2, 2)
  ctx.fillStyle = '#e91e63'; ctx.fillRect(12, 24, 2, 2)
  ctx.fillStyle = '#e91e63'; ctx.fillRect(14, 25, 4, 2) // Chevron apex
  ctx.fillStyle = '#e91e63'; ctx.fillRect(18, 24, 2, 2)
  ctx.fillStyle = '#e91e63'; ctx.fillRect(20, 23, 2, 2)
  ctx.fillStyle = '#e91e63'; ctx.fillRect(22, 22, 2, 2)

  // White Central Zipper Track with metallic pull tab
  ctx.fillStyle = '#ffffff'; ctx.fillRect(15, 19, 2, 10)
  ctx.fillStyle = '#cfd8dc'; ctx.fillRect(15, 21, 1, 1) // Zipper pull tab

  // Hands resting on knees & black jeans
  ctx.fillStyle = skinPal.shd; ctx.fillRect(7, 28, 3, 3)
  ctx.fillStyle = skinPal.shd; ctx.fillRect(22, 28, 3, 3)
  ctx.fillStyle = '#212121'; ctx.fillRect(8, 29, 16, 2)

  applySpriteOutline(ctx, '#10141c')

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// Variant 7: Mascot Spirit Fan (Violet Cap & 3D Cheer Pom-Poms) - Playful Wink
function createPixelFanTextureVioletSpirit() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')

  const capCrown = { hi: '#e1bee7', mid: '#ba68c8', shd: '#8e24aa', deep: '#4a148c', btn: '#ff4081' }
  const capVisor = { hi: '#ff80ab', mid: '#ff4081', shd: '#c51162' }
  const skinPal = { hi: '#fff3e0', base: '#ffdfba', shd: '#fcd0a1', deep: '#d19056' }
  const hairPal = { hi: '#ffe082', mid: '#ffb74d', shd: '#b26a00' } // Blonde
  const jerseyPal = { hi: '#f8bbd0', mid: '#ec407a', shd: '#c2185b', deep: '#880e4f' }

  draw3dBaseballCap(ctx, capCrown, capVisor, true)
  draw3dFace(ctx, skinPal, hairPal, 'playful_wink')

  // 3D Magenta Jersey with White Star Emblem
  const jHi = jerseyPal.hi
  const jMid = jerseyPal.mid
  const jShd = jerseyPal.shd

  ctx.fillStyle = jHi; ctx.fillRect(8, 19, 5, 1)
  ctx.fillStyle = jMid; ctx.fillRect(19, 19, 5, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(13, 19, 6, 2) // White collar

  for (let y = 20; y <= 28; y++) {
    ctx.fillStyle = jMid; ctx.fillRect(8, y, 16, 1)
    ctx.fillStyle = jHi; ctx.fillRect(10, y, 1, 1)
    ctx.fillStyle = jShd; ctx.fillRect(8, y, 1, 1)
    ctx.fillStyle = jShd; ctx.fillRect(22, y, 2, 1)
  }

  // White Star / Team Emblem on chest
  ctx.fillStyle = '#ffffff'; ctx.fillRect(15, 22, 1, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(14, 23, 4, 1)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(15, 24, 1, 1)

  // Hands & violet pants
  ctx.fillStyle = skinPal.shd; ctx.fillRect(7, 28, 3, 3)
  ctx.fillStyle = skinPal.shd; ctx.fillRect(22, 28, 3, 3)
  ctx.fillStyle = '#311b92'; ctx.fillRect(8, 29, 16, 2)

  // 3D Fluffy Cheer Pom-Poms / Rally Shakers (Bursting with 3D ribbons)
  // Left Pom-Pom (X: 3..8, Y: 17..23)
  ctx.fillStyle = '#ffd54f'; ctx.fillRect(4, 17, 3, 2)
  ctx.fillStyle = '#ba68c8'; ctx.fillRect(3, 18, 3, 2)
  ctx.fillStyle = '#ff4081'; ctx.fillRect(5, 19, 3, 2)
  ctx.fillStyle = '#ffb300'; ctx.fillRect(3, 20, 3, 2)
  ctx.fillStyle = '#7b1fa2'; ctx.fillRect(5, 21, 3, 2)

  // Right Pom-Pom (X: 24..29, Y: 17..23)
  ctx.fillStyle = '#ffd54f'; ctx.fillRect(25, 17, 3, 2)
  ctx.fillStyle = '#ba68c8'; ctx.fillRect(26, 18, 3, 2)
  ctx.fillStyle = '#ff4081'; ctx.fillRect(24, 19, 3, 2)
  ctx.fillStyle = '#ffb300'; ctx.fillRect(26, 20, 3, 2)
  ctx.fillStyle = '#7b1fa2'; ctx.fillRect(24, 21, 3, 2)

  applySpriteOutline(ctx, '#10141c')

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}





// ── The show rows' own cheering poses ──────────────────────────────────────
// The fans in a show cluster hold something while their act runs, so their row
// wears one of the acting poses instead of the seated variants: `raise` (both
// arms overhead, gripping the banner), `play` (arms reaching forward, both hands
// at the mouthpiece, blowing a horn) and `drum` (hands out at the waist, a
// drum's width apart, gripped on its sticks). The gripping hands are drawn on
// exactly the texels util/fanSprites.js names, so the banner and the instruments
// land in them instead of floating near the row — see CHEER_HANDS there.
//
// `rest` is the last pose: arms at the sides, hands empty, worn between acts and
// while the row is seated. Without it a show row stood with its arms full of
// nothing between shows, and props hung in the air beside it.

const CHEER_POSES = ['raise', 'play', 'drum', 'rest']

// Three colourways per pose, so a cheering row is varied rather than a squad
// of identical fans.
const CHEER_COLORWAYS = [
  {
    capCrown: { hi: '#ff5252', mid: '#e53935', shd: '#c62828', deep: '#8e0000', btn: '#ffffff' },
    capVisor: { hi: '#ff6e6e', mid: '#e53935', shd: '#b71c1c' },
    skinPal: { hi: '#fff3e0', base: '#ffdfba', shd: '#f5c69b', deep: '#d79459' },
    hairPal: { hi: '#6d4c41', mid: '#4e342e', shd: '#271713' },
    jerseyPal: { hi: '#ffffff', mid: '#f5f7f8', shd: '#d8dee3', deep: '#b0bec5' },
    trim: '#e53935',
  },
  {
    capCrown: { hi: '#42a5f5', mid: '#1e88e5', shd: '#1565c0', deep: '#0d47a1', btn: '#ffffff' },
    capVisor: { hi: '#64b5f6', mid: '#1976d2', shd: '#0d47a1' },
    skinPal: { hi: '#fff3e0', base: '#ffe0bd', shd: '#d79459', deep: '#af6929' },
    hairPal: { hi: '#5d4037', mid: '#3e2723', shd: '#1a0e0a' },
    jerseyPal: { hi: '#e3f2fd', mid: '#90caf9', shd: '#42a5f5', deep: '#1565c0' },
    trim: '#0d47a1',
  },
  {
    capCrown: { hi: '#4dd0e1', mid: '#00acc1', shd: '#00838f', deep: '#006064', btn: '#ffffff' },
    capVisor: { hi: '#80deea', mid: '#00acc1', shd: '#00838f' },
    skinPal: { hi: '#fff3e0', base: '#ffdfba', shd: '#fcd0a1', deep: '#d19056' },
    hairPal: { hi: '#ffe082', mid: '#ffb74d', shd: '#b26a00' },
    jerseyPal: { hi: '#c8e6c9', mid: '#66bb6a', shd: '#43a047', deep: '#1b5e20' },
    trim: '#1b5e20',
  },
]

// The cheer textures are appended to the seated variants in this order, so the
// variant index of a show fan is CHEER_FIRST_VARIANT + pose + colourway.
const CHEER_FIRST_VARIANT = 8
const FAN_VARIANTS = CHEER_FIRST_VARIANT + CHEER_POSES.length * CHEER_COLORWAYS.length

function createPixelFanTextureCheer(pose, colorway) {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  const { jerseyPal, skinPal } = colorway

  draw3dBaseballCap(ctx, colorway.capCrown, colorway.capVisor, true)
  draw3dFace(ctx, colorway.skinPal, colorway.hairPal, 'roaring_cheer')

  // Torso (rows 19-28), the same barrel every seated fan is drawn with.
  ctx.fillStyle = jerseyPal.hi; ctx.fillRect(8, 19, 5, 1)
  ctx.fillStyle = jerseyPal.mid; ctx.fillRect(19, 19, 5, 1)
  ctx.fillStyle = colorway.trim; ctx.fillRect(13, 19, 6, 2)
  for (let y = 20; y <= 28; y++) {
    ctx.fillStyle = jerseyPal.mid; ctx.fillRect(8, y, 16, 1)
    ctx.fillStyle = jerseyPal.hi; ctx.fillRect(10, y, 1, 1)
    ctx.fillStyle = jerseyPal.shd; ctx.fillRect(8, y, 1, 1)
    ctx.fillStyle = jerseyPal.shd; ctx.fillRect(22, y, 2, 1)
  }

  // Pants & belt
  ctx.fillStyle = '#263238'; ctx.fillRect(8, 29, 16, 2)
  ctx.fillStyle = '#ffd54f'; ctx.fillRect(14, 29, 4, 1)

  // The arms, and the hands at the pose's own texels (CHEER_HANDS): each grip
  // is a 3 × 3 skin block centred on the texel the props are placed at.
  if (pose === 'raise') {
    // Both arms straight up beside the head, all the way to the top row: the
    // hands there hold the banner clear of the heads along the whole row.
    for (const [x, edge] of [[6, 0], [24, 1]]) {
      ctx.fillStyle = jerseyPal.mid; ctx.fillRect(x, 2, 2, 18)
      ctx.fillStyle = jerseyPal.hi; ctx.fillRect(x + edge, 2, 1, 18)
    }
  } else if (pose === 'play') {
    // Blowing a horn: short sleeves at the shoulders, then bare forearms
    // reaching *forward* and in to the mouthpiece, so the hands meet at the
    // brace under the chin instead of standing up beside the ears. The stroke
    // is drawn as a staircase of 2 × 2 blocks, the way a pixel-art arm comes
    // at the viewer: the elbows stay at the sides and the hands are the
    // nearest thing on the figure.
    for (const [x, edge, dir] of [[6, 0, 1], [24, 1, -1]]) {
      ctx.fillStyle = jerseyPal.mid; ctx.fillRect(x, 18, 2, 4)
      ctx.fillStyle = jerseyPal.hi; ctx.fillRect(x + edge, 18, 1, 4)
      ctx.fillStyle = skinPal.shd
      ctx.fillRect(x + dir, 19, 2, 2)
      ctx.fillRect(x + dir * 2, 17, 2, 2)
      ctx.fillRect(x + dir * 3, 16, 2, 2)
    }
  } else if (pose === 'drum') {
    // Wearing a drum: the arms come down the sides to the elbows, then the
    // forearms turn in at the waist and grip the sticks on the drum's top
    // corners. The drum hangs from those corners, so the hands sit low on the
    // figure rather than up at the chest.
    for (const [x, edge, dir] of [[6, 0, 1], [24, 1, -1]]) {
      ctx.fillStyle = jerseyPal.mid; ctx.fillRect(x, 19, 2, 4)
      ctx.fillStyle = jerseyPal.hi; ctx.fillRect(x + edge, 19, 1, 4)
      ctx.fillStyle = skinPal.shd
      ctx.fillRect(x + dir, 22, 2, 2)
      ctx.fillRect(x + dir * 2, 22, 2, 2)
    }
  } else {
    // Resting: both arms hang at the sides, hands at the hips, nothing held.
    for (const [x, edge] of [[6, 0], [24, 1]]) {
      ctx.fillStyle = jerseyPal.shd; ctx.fillRect(x, 20, 2, 9)
      ctx.fillStyle = jerseyPal.hi; ctx.fillRect(x + edge, 20, 1, 9)
    }
    for (const x of [6, 24]) {
      ctx.fillStyle = skinPal.shd; ctx.fillRect(x, 28, 2, 3)
      ctx.fillStyle = skinPal.hi; ctx.fillRect(x, 28, 1, 1)
    }
  }
  if (CHEER_HANDS[pose]) {
    for (const hand of [CHEER_HANDS[pose].left, CHEER_HANDS[pose].right]) {
      // A three-texel grip, centred on the texel: [col - 1, row - 1] is its top
      // left corner.
      ctx.fillStyle = skinPal.shd; ctx.fillRect(hand[0] - 1, hand[1] - 1, 3, 3)
      ctx.fillStyle = skinPal.hi; ctx.fillRect(hand[0] - 1, hand[1] - 1, 1, 1)
    }
  }

  applySpriteOutline(ctx, '#10141c')

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// A standing fan's legs: dark trousers, a white sock, a black shoe. One strip
// for every show row (they all wear the cheer poses' navy trousers), stretched
// from the step under the seat up to the sprite's own hip while the row stands.
function createPixelLegsTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 24
  const ctx = canvas.getContext('2d')
  const pants = '#263238'
  const pantsHi = '#3b4b56'
  const pantsShd = '#16202a'
  const sock = '#f2f3ee'
  const sockShd = '#c4cdcc'
  const shoe = '#171b22'
  const shoeHi = '#2c3540'

  for (const x of [3, 9]) {
    ctx.fillStyle = pants
    ctx.fillRect(x, 0, 5, 17)
    ctx.fillStyle = pantsHi
    ctx.fillRect(x, 0, 1, 17)
    ctx.fillStyle = pantsShd
    ctx.fillRect(x + 4, 0, 1, 17)
    // Knee crease, so a stretched leg still reads as a leg
    ctx.fillStyle = pantsShd
    ctx.fillRect(x + 1, 8, 3, 1)
    // Sock and shoe
    ctx.fillStyle = sock
    ctx.fillRect(x + 1, 17, 3, 3)
    ctx.fillStyle = sockShd
    ctx.fillRect(x + 1, 19, 3, 1)
    ctx.fillStyle = shoe
    ctx.fillRect(x - 1, 21, 7, 3)
    ctx.fillStyle = shoeHi
    ctx.fillRect(x - 1, 21, 7, 1)
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  return tex
}

// Crossed-quad grass blades geometry (2 crossed vertical quads forming an X: doubled size ~4 inches tall)
function createGrassBladesGeometry(w = 0.16, h = 0.10) {
  const geom = new THREE.BufferGeometry()
  const halfW = w / 2
  const d = halfW * 0.7071

  const positions = new Float32Array([
    // Quad 1
    -d, 0, -d, d, 0, d, d, h, d,
    -d, 0, -d, d, h, d, -d, h, -d,
    // Quad 2
    -d, 0, d, d, 0, -d, d, h, -d,
    -d, 0, d, d, h, -d, -d, h, d,
  ])

  const normals = new Float32Array([
    0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0,
  ])

  const uvs = new Float32Array([
    0, 0, 1, 0, 1, 1,
    0, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1,
    0, 0, 1, 1, 0, 1,
  ])

  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  return geom
}

// 3-Plane Star grass blades geometry (3 intersecting vertical quads at 60-degree angles: doubled size ~4.5 inches tall)
function createGrassStarGeometry(w = 0.18, h = 0.11) {
  const geom = new THREE.BufferGeometry()
  const halfW = w / 2
  const positions = []
  const normals = []
  const uvs = []

  for (let i = 0; i < 3; i++) {
    const angle = (i * Math.PI) / 3
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const x1 = -halfW * cos
    const z1 = -halfW * sin
    const x2 = halfW * cos
    const z2 = halfW * sin

    positions.push(
      x1, 0, z1, x2, 0, z2, x2, h, z2,
      x1, 0, z1, x2, h, z2, x1, h, z1
    )
    normals.push(
      0, 1, 0, 0, 1, 0, 0, 1, 0,
      0, 1, 0, 0, 1, 0, 0, 1, 0
    )
    uvs.push(
      0, 0, 1, 0, 1, 1,
      0, 0, 1, 1, 0, 1
    )
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// Sample field color at (x, z) to color-match vegetation to the ground directly beneath it
function getFieldColorAt(x, z, rng = Math.random) {
  // 1. Infield Grass Checkered Diamond:
  const diamondCenterZ = FIELD.BASE.SECOND.z / 2
  const diamondHalfDiag = Math.abs(FIELD.BASE.SECOND.z) / 2
  const dx = Math.abs(x)
  const dz = Math.abs(z - diamondCenterZ)
  const inDiamond = dx / diamondHalfDiag + dz / diamondHalfDiag <= 1.02

  if (inDiamond) {
    const u = 0.5 + x / (2 * diamondHalfDiag)
    const v = -z / (2 * diamondHalfDiag)
    const checkX = Math.floor(u * 48)
    const checkY = Math.floor(v * 48)
    const isLightCheck = (checkX + checkY) % 2 === 0
    const palA = ['#4da93d', '#58b848', '#449c36']
    const palB = ['#3a872e', '#439535', '#327826']
    const pal = isLightCheck ? palA : palB
    const r = rng()
    return pal[r < 0.55 ? 0 : (r < 0.85 ? 1 : 2)]
  }

  // 2. Warning Track (r >= 314 ft = 95.7m):
  const distOrigin = Math.hypot(x, z)
  if (distOrigin >= feetToM(314)) {
    const trackPal = ['#9e4e2a', '#ab5a34', '#b96740']
    const r = rng()
    return trackPal[r < 0.5 ? 0 : (r < 0.8 ? 1 : 2)]
  }

  // 3. Outfield Grass Disc with Mowing Stripes (stripe width = 3.048m):
  const xRot = (x + z) * 0.70710678
  const uGrass = (xRot + feetToM(400)) / (2 * feetToM(400))
  const stripeIdx = Math.floor(uGrass * 80) % 2
  const lightPal = ['#46a337', '#50b240', '#3e9630']
  const darkPal = ['#327b26', '#3b8b2e', '#2b6a1f']
  const pal = stripeIdx === 0 ? lightPal : darkPal
  const r = rng()
  return pal[r < 0.55 ? 0 : (r < 0.85 ? 1 : 2)]
}

// ---------------------------------------------------------------------------
// Stadium Grandstands, 3D Seats & Continuous Infield Bowl Spline
// ---------------------------------------------------------------------------

// Continuous curve running from Left Field Foul Pole, down 3B line,
// wrapping behind home plate (behind the batter!), down 1B line,
// to Right Field Foul Pole!
const INFIELD_STANDS_CURVE = (() => {
  const poleR = feetToM(330)
  const foulAng = Math.PI / 4
  const pLF = { x: -poleR * Math.sin(foulAng), z: -poleR * Math.cos(foulAng) }
  const pRF = { x: poleR * Math.sin(foulAng), z: -poleR * Math.cos(foulAng) }

  const waypoints = [
    pLF,
    { x: -52.0, z: -42.0 },
    { x: -33.0, z: -20.0 }, // past 3B
    { x: -21.0, z: -5.0 },  // 3B line
    { x: -15.0, z: 6.0 },   // home plate corner left
    { x: -8.0,  z: 13.5 },
    { x: 0.0,   z: 16.0 },  // center backstop directly behind home plate / batter
    { x: 8.0,   z: 13.5 },
    { x: 15.0,  z: 6.0 },   // home plate corner right
    { x: 21.0,  z: -5.0 },  // 1B line
    { x: 33.0,  z: -20.0 }, // past 1B
    { x: 52.0,  z: -42.0 },
    pRF,
  ]

  return new THREE.CatmullRomCurve3(
    waypoints.map((p) => new THREE.Vector3(p.x, 0, p.z)),
    false,
    'catmullrom',
    0.15
  )
})()

// How deep the infield bowl runs, front barrier to rear facade. The corner
// infill has to land on the back of it, so both read the same number.
const INFIELD_STANDS_DEPTH = 12.8

// The bowl's cross-section, front barrier to rear facade: every row is one arris
// of the terracing, walking out and up from the field wall. The seat rows stand
// on its treads and the aisles are paved off the same profile, so a walkway
// steps exactly where the concrete it crosses steps.
const INFIELD_TIERS = [
  { d: 0.0, y: 0.0, isRiser: true },    // Front field barrier wall bottom
  { d: 0.0, y: 0.95, isRiser: false },  // Front wall top
  { d: 1.2, y: 0.95, isRiser: true },   // Tier 1 tread
  { d: 1.2, y: 1.45, isRiser: false },  // Tier 1 riser
  { d: 2.4, y: 1.45, isRiser: true },   // Tier 2 tread
  { d: 2.4, y: 1.95, isRiser: false },  // Tier 2 riser
  { d: 3.6, y: 1.95, isRiser: true },   // Tier 3 tread
  { d: 3.6, y: 2.45, isRiser: false },  // Tier 3 riser
  { d: 4.8, y: 2.45, isRiser: true },   // Tier 4 tread
  { d: 4.8, y: 2.95, isRiser: false },  // Tier 4 riser
  { d: 6.0, y: 2.95, isRiser: true },   // Tier 5 tread
  { d: 6.0, y: 3.45, isRiser: false },  // Tier 5 riser
  { d: 7.2, y: 3.45, isRiser: true },   // Tier 6 tread
  { d: 7.2, y: 3.95, isRiser: false },  // Tier 6 riser
  { d: 8.8, y: 3.95, isRiser: true },   // Concourse walkway
  { d: 8.8, y: 4.55, isRiser: false },  // Upper deck riser 1
  { d: 9.8, y: 4.55, isRiser: true },   // Upper deck tread 1
  { d: 9.8, y: 5.15, isRiser: false },  // Upper deck riser 2
  { d: 10.8, y: 5.15, isRiser: true },  // Upper deck tread 2
  { d: 10.8, y: 5.75, isRiser: false }, // Upper deck riser 3
  { d: 11.8, y: 5.75, isRiser: true },  // Upper deck tread 3
  { d: 11.8, y: 6.35, isRiser: false }, // Upper deck riser 4
  { d: INFIELD_STANDS_DEPTH, y: 6.35, isRiser: true },  // Upper deck tread 4
  { d: INFIELD_STANDS_DEPTH, y: 7.60, isRiser: false }, // Rear stadium facade top
]

// Infield grandstands bowl: Unified continuous grandstand wrapping seamlessly
// from Left Field Foul Pole, down 3B foul line, around backstop behind batter,
// down 1B foul line, to Right Field Foul Pole!
function createInfieldStandsGeometry() {
  const curve = INFIELD_STANDS_CURVE
  const tiers = INFIELD_TIERS

  const numSpline = 80
  const points = []
  const normals = []

  for (let i = 0; i <= numSpline; i++) {
    const t = i / numSpline
    const p = curve.getPoint(t)
    const tan = curve.getTangent(t).normalize()
    const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize()
    points.push(p)
    normals.push(n)
  }

  const geom = new THREE.BufferGeometry()
  const pos = []
  const uvs = []
  const colors = []
  const indices = []

  const colSeatTread = new THREE.Color('#2f4a33')
  const colSeatRiser = new THREE.Color('#233a27')
  const colConcourse = new THREE.Color('#46574a')
  const colFrontWall = new THREE.Color('#2a3630')
  const colBackFacade = new THREE.Color('#33403a')

  // The bowl's soft ambient shading, baked into the rows themselves. A tread's
  // inner edge is the step's nosing -- the one arris that sees the whole sky --
  // and its outer edge sits in the corner shadow at the foot of the riser above
  // it; a riser runs from dark at its foot to bright at its top. Each row is
  // shared by the two strips either side of it, and both want the same tone
  // there, so the gradient runs continuously round the step instead of
  // stopping dead at the crease. That is what makes the bowl read as moulded
  // concrete rather than as flat planes meeting at right angles.
  const colNosing = colSeatTread.clone().multiplyScalar(1.18)
  const colFoot = colSeatRiser.clone().multiplyScalar(0.78)

  // The corner rows: the foot of the wall, the first nosing, the walkway slab
  // and the facade keep their own materials; every other row is an arris of
  // the terracing, shaded by which way it turns.
  const rowColor = (r) => {
    if (r === 0) return colFrontWall
    if (r === 1) return colNosing
    if (r === 14) return colConcourse
    if (r === 23) return colBackFacade
    return tiers[r].isRiser ? colFoot : colNosing
  }

  for (let r = 0; r < tiers.length; r++) {
    const { d, y } = tiers[r]
    const col = rowColor(r)

    for (let i = 0; i <= numSpline; i++) {
      const p = points[i]
      const n = normals[i]
      pos.push(p.x + d * n.x, y, p.z + d * n.z)
      uvs.push(i / 2, d / 1.2)
      colors.push(col.r, col.g, col.b)
    }
  }

  const stride = numSpline + 1
  for (let r = 0; r < tiers.length - 1; r++) {
    for (let i = 0; i < numSpline; i++) {
      const a = r * stride + i
      const b = r * stride + (i + 1)
      const c = (r + 1) * stride + i
      const d = (r + 1) * stride + (i + 1)

      indices.push(a, b, c)
      indices.push(b, d, c)
    }
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setIndex(indices)
  geom.computeVertexNormals()
  return geom
}

// Outfield bleachers: 7 tiers rising behind outfield wall, connecting LF pole to RF pole.
// Their own numbers live here because the canopy over them is cut from the same
// ring: the seats and the roof have to agree on where the top row and the rear
// facade are.
const OUTFIELD_BLEACHERS = {
  startAngle: -Math.PI / 4,
  endAngle: Math.PI / 4,
  frontR: feetToM(332.0),
  tiers: 7,
  tierDepth: 1.35,
  tierHeight: 0.52,
  baseHeight: 2.45,
  facadeLift: 1.2,
}

// Where the bleachers end, either side of straight-away centre field: on the
// corner's section line (see CORNER_WALL), which is a radius of the plate, so
// every tier is drawn from it on one side to it on the other and the deck
// reaches the brick instead of stopping short of it.
function bleacherEndAngle(side) {
  return side * cornerSeatEnd()
}

function createOutfieldStandsGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const {
    frontR: rStart,
    tiers: numTiers,
    tierDepth,
    tierHeight,
    baseHeight,
    facadeLift,
  } = OUTFIELD_BLEACHERS
  const numRadial = 64

  const treadColor = new THREE.Color('#2f4a33')
  const riserColor = new THREE.Color('#233a27')
  const wallColor = new THREE.Color('#263a46')

  // The same baked ambient as the infield bowl: the tread brightens toward the
  // nosing it hangs over and darkens into the foot of the next riser, so the
  // stepped ring shades like one moulded sweep of concrete.
  const treadNosing = treadColor.clone().multiplyScalar(1.16)
  const treadFoot = treadColor.clone().multiplyScalar(0.82)
  const riserFoot = riserColor.clone().multiplyScalar(0.80)
  const riserNosing = riserColor.clone().multiplyScalar(1.16)
  const wallFoot = wallColor.clone().multiplyScalar(0.86)
  const wallTop = wallColor.clone().multiplyScalar(1.08)

  // The bleachers wear the same pixel concrete as the infield bowl, mapped the
  // same way: u runs along the arc, v up the tiers (plus height, so the rear
  // wall keeps its texture instead of collapsing to one row of texels).
  // The first edge of the quad (a/b) takes colNear, the far edge (c/d) colFar.
  function addQuad(pA, pB, pC, pD, normal, colNear, colFar = colNear) {
    positions.push(...pA, ...pB, ...pC, ...pA, ...pC, ...pD)
    const corners = [[pA, colNear], [pB, colNear], [pC, colFar], [pA, colNear], [pC, colFar], [pD, colFar]]
    for (const [p, col] of corners) {
      const r = Math.hypot(p[0], p[2])
      normals.push(normal[0], normal[1], normal[2])
      colors.push(col.r, col.g, col.b)
      uvs.push((Math.atan2(p[0], -p[2]) * r) / 1.2, (r + p[1]) / 1.2)
    }
  }

  // Every tier runs from one corner wall to the other, and its two ends are not
  // at the same angle: the wall is a chord across the ring, so a tier's outer
  // edge reaches it further round than its inner one. Each tier is drawn as a
  // band between its own ends at each radius -- a tread quad per bay with its
  // inner corners on the wall's line at r0 and its outer corners on it at r1 --
  // instead of on a common sweep that would stop short of the wall.
  for (let t = 0; t < numTiers; t++) {
    const r0 = rStart + t * tierDepth
    const r1 = r0 + tierDepth
    const yTread = baseHeight + t * tierHeight
    const yNext = baseHeight + (t + 1) * tierHeight
    // The corner is a radius, so a tier's two edges end on the same line and
    // its outermost bay is a radial sector, not a taper.
    const left = bleacherEndAngle(-1)
    const right = bleacherEndAngle(1)

    for (let i = 0; i < numRadial; i++) {
      const u0 = i / numRadial
      const u1 = (i + 1) / numRadial
      const in0 = left + (right - left) * u0
      const in1 = left + (right - left) * u1
      const out0 = in0
      const out1 = in1

      // Horizontal Tread
      const pA = [r0 * Math.sin(in0), yTread, -r0 * Math.cos(in0)]
      const pB = [r0 * Math.sin(in1), yTread, -r0 * Math.cos(in1)]
      const pC = [r1 * Math.sin(out1), yTread, -r1 * Math.cos(out1)]
      const pD = [r1 * Math.sin(out0), yTread, -r1 * Math.cos(out0)]
      addQuad(pA, pB, pC, pD, [0, 1, 0], treadNosing, treadFoot)

      // Vertical Riser
      const midA = (out0 + out1) / 2
      const nR = [-Math.sin(midA), 0, Math.cos(midA)]
      const pR1 = [r1 * Math.sin(out0), yTread, -r1 * Math.cos(out0)]
      const pR2 = [r1 * Math.sin(out1), yTread, -r1 * Math.cos(out1)]
      const pR3 = [r1 * Math.sin(out1), yNext, -r1 * Math.cos(out1)]
      const pR4 = [r1 * Math.sin(out0), yNext, -r1 * Math.cos(out0)]
      addQuad(pR1, pR2, pR3, pR4, nR, riserFoot, riserNosing)
    }
  }

  // Back Wall Facade: it follows the tiers round the corner to the same walls.
  const rBack = rStart + numTiers * tierDepth
  const yBackTop = baseHeight + numTiers * tierHeight + facadeLift
  const leftB = bleacherEndAngle(-1)
  const rightB = bleacherEndAngle(1)
  for (let i = 0; i < numRadial; i++) {
    const a0 = leftB + (rightB - leftB) * (i / numRadial)
    const a1 = leftB + (rightB - leftB) * ((i + 1) / numRadial)
    const midA = (a0 + a1) / 2
    const nR = [-Math.sin(midA), 0, Math.cos(midA)]

    const yBottom = baseHeight + numTiers * tierHeight
    const p1 = [rBack * Math.sin(a0), yBottom, -rBack * Math.cos(a0)]
    const p2 = [rBack * Math.sin(a1), yBottom, -rBack * Math.cos(a1)]
    const p3 = [rBack * Math.sin(a1), yBackTop, -rBack * Math.cos(a1)]
    const p4 = [rBack * Math.sin(a0), yBackTop, -rBack * Math.cos(a0)]
    addQuad(p1, p2, p3, p4, nR, wallFoot, wallTop)
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// The corner wall: where the back bleachers stop, and the side stand begins.
//
// Every seat in the park looks at the plate, so the corner's section line does
// too: it is a radius of the plate, not a chord across the ring. A wall on a
// radius lies along the fans' own sight lines -- from the seats it is an edge
// first and a face second, and it screens nobody's view of the catcher. The
// rows run round past the foul pole until the side stand's own end, rising from
// its 0.95 m front wall to its 7.6 m rear facade over 12.8 m of depth, cuts the
// front row's sight line; that radius is where the corner ends. The seats, the
// deck, the rear facade and the brick wall all stop on the one line, so the
// corner is squared off in plan and the stand behind it is never in its way.
//
// The wall is brick under a stone cornice, stepped in height with the rows
// behind it: one panel per row, all on the one radial face, so its inner face
// reads as a single masonry wall from the plate and its steps are only in
// silhouette. A stone string course runs the whole block at one height, so the
// brick has something to measure itself against. At the field the run begins
// behind the padded wall, with no pier of its own: the blue padding runs past
// it, and the masonry only shows above it, so the wall never crosses the
// outfield wall's face from the plate. The same brick, closed under the same
// cornice, carries the side stand's end beside it, so the corner reads as one
// block of masonry rather than two pieces that happen to meet.
const CORNER_WALL = {
  // The section line: a radius of the plate, 47.3 degrees round from
  // straight-away centre field. That is where the front row -- the last to keep
  // its view over the side stand's end -- stops, clear of the brick.
  angle: CORNER_ANGLE,
  // Clear deck left between the last cushion and the brick.
  clear: 0.5,
  // How far the wall stands over its row's back, and how thick it is. A section
  // wall, not a bastion: it is as thin as a wall the terraces can carry, so the
  // corner reads as the stands' own end and not as a block dropped beside them.
  capRise: 0.5,
  thickness: 0.46,
  // The rear pier: square in plan, standing a little proud of either face,
  // where the run stops against the bleachers' coping at the open mouth of the
  // court. There is no matching pier at the field end -- the padded wall runs
  // past the wall's foot there, and a pier standing proud of the brick would
  // ride over the blue.
  pier: 1.15,
  pierProud: 0.14,
}

// The stone dressings the corner's brick wears, in one place: the band that runs
// round the block at one datum, and the cornice that finishes the top of every
// wall in it.
//
// A brick face the height of a stand, with nothing across it, reads as a painted
// panel however good the brick is: it has no scale, because there is nothing on
// it to measure. The string course gives the eye a horizontal at a known height
// -- just over head height, where a real wall would change thickness -- and the
// cornice gives the top an edge with weight to it. Both are cut from the same
// pale stone as the caps the walls already carried, so the block has one
// dressing rather than three improvised ones.
const MASONRY = {
  // top: the band's top edge, so both walls' bands line up.
  string: { top: 1.82, height: 0.26, proud: 0.09 },
  // The second course, at the foot: a water table off the ground, where a real
  // wall changes thickness below the damp course. Two horizontals -- one at
  // 0.62 m, one at 1.82 m -- are what give the brick a scale to be read by:
  // one band alone still leaves a face the height of a stand unmeasured.
  plinth: { top: 0.62, height: 0.28, proud: 0.1 },
  // A cornice, not a coping: a bed and a projecting crown in one band, deep
  // enough to throw its own shadow down the brick. Deeper than the first cut
  // (0.28 m on a 0.18 m projection): at the block's distance a shallower band
  // disappeared into the brick from the plate.
  cornice: { height: 0.36, proud: 0.24 },
  // The cap along the two rear facades, in the same stone and the same bed as
  // the cornice: `proud` toward the field, and only `backset` behind the facade,
  // because the wall it caps is a building's eave with a roof behind it rather
  // than a free-standing parapet. Its top is each facade's own top, so the
  // corner's two abutments stop against this band instead of on a bare edge.
  coping: { height: 0.36, proud: 0.24, backset: 0.04 },
}

// The angle a row runs to on its corner side. The corner is a radius, so every
// row ends at the same angle; the seats stop `clear` short of the brick.
function cornerSeatEnd() {
  return CORNER_WALL.angle
}

// The wall itself, one run per corner: a brick panel per row on the section
// line, stepped in height as the rows behind them climb, with a stone cap, and
// a pier standing at the field end of the run where the padded wall gives out.
function createCornerWallGeometry() {
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const brick = new THREE.Color('#722e2a')
  const brickShades = faceShades(brick)
  const stone = new THREE.Color('#b6ad9a')
  const stoneShades = faceShades(stone)

  const { frontR, tiers, tierDepth, tierHeight, baseHeight, facadeLift } = OUTFIELD_BLEACHERS
  const { angle, capRise, thickness, pier, pierProud } = CORNER_WALL
  const { height: cornice, proud: corniceProud } = MASONRY.cornice

  // The section line, as a frame: `out` runs along it away from the plate,
  // `past` crosses it into the corner's own wedge. A box laid on this frame has
  // its long axis on the radius, so the wall's face is the radius too.
  const frame = (side) => ({
    out: { x: side * Math.sin(angle), z: -Math.cos(angle) },
    past: { x: side * Math.cos(angle), z: Math.sin(angle) },
    yaw: Math.atan2(Math.cos(angle), side * Math.sin(angle)),
  })

  // A pier at one end of the run: brick, with the same stone cap as the wall,
  // standing a hand's width proud of either face so the run has a stop on it.
  const pierAt = (at, yaw, r, height) => {
    const centre = at(r)
    addTransformedBox(positions, normals, colors, uvs, {
      cx: centre.x,
      cy: height / 2,
      cz: centre.z,
      sx: pier,
      sy: height,
      sz: thickness + 2 * pierProud,
      yaw,
      col: brick,
      faceColors: brickShades,
      faceUvs: faceUvsFor(pier, height, thickness + 2 * pierProud),
    })
    addTransformedBox(positions, normals, colors, uvs, {
      cx: centre.x,
      cy: height + cornice / 2,
      cz: centre.z,
      sx: pier + 0.1,
      sy: cornice,
      sz: thickness + 2 * pierProud + 0.1,
      yaw,
      col: stone,
      faceColors: stoneShades,
      faceUvs: faceUvsFor(pier + 0.1, cornice, thickness + 2 * pierProud + 0.1),
    })
  }

  for (const side of [-1, 1]) {
    const { out, past, yaw } = frame(side)
    const at = (r, pastBy = thickness / 2) => ({
      x: out.x * r + past.x * pastBy,
      z: out.z * r + past.z * pastBy,
    })

    for (let t = 0; t < tiers; t++) {
      const r0 = frontR + t * tierDepth
      const r1 = r0 + tierDepth
      const height = baseHeight + (t + 1) * tierHeight + capRise
      // The panels butt end to end along the radius: no gap at a joint, and the
      // only step between them is the one in the wall's top edge.
      const centre = at((r0 + r1) / 2)

      addTransformedBox(positions, normals, colors, uvs, {
        cx: centre.x,
        cy: height / 2,
        cz: centre.z,
        sx: tierDepth,
        sy: height,
        sz: thickness,
        yaw,
        col: brick,
        faceColors: brickShades,
        faceUvs: faceUvsFor(tierDepth, height, thickness),
      })

      // The cornice: it finishes the top of the step, so the wall's silhouette
      // is masonry rather than another edge of terracing.
      addTransformedBox(positions, normals, colors, uvs, {
        cx: centre.x,
        cy: height + cornice / 2,
        cz: centre.z,
        sx: tierDepth,
        sy: cornice,
        sz: thickness + 2 * corniceProud,
        yaw,
        col: stone,
        faceColors: stoneShades,
        faceUvs: faceUvsFor(tierDepth, cornice, thickness + 2 * corniceProud),
      })
    }

    // The run ends on a pier at the rear: the block's abutment on the bleachers'
    // rear facade, carried past the last panel's step up to the facade's own top
    // and stopped level with it -- brick under the same stone cap -- so the
    // stepped run climbs into the building instead of ending in the air beside
    // it, and the half-metre of facade left over the parapet becomes a pier
    // carrying it rather than a loose end of height. The field end needs no
    // pier: the pads stand in front of the wall's foot there, and the lowest
    // panel's own step is the stop the eye reads.
    const abutment = baseHeight + tiers * tierHeight + facadeLift
    pierAt(at, yaw, frontR + tiers * tierDepth - pier / 2, abutment - cornice)

    // The string course, one band at one height from pier to pier. It is set
    // into the faces (the piers stand proud of it), so the run reads as one
    // horizontal drawn across the brick rather than three panels with edges.
    const string = MASONRY.string
    const band = at(frontR + (tiers * tierDepth) / 2)
    addTransformedBox(positions, normals, colors, uvs, {
      cx: band.x,
      cy: string.top - string.height / 2,
      cz: band.z,
      sx: tiers * tierDepth,
      sy: string.height,
      sz: thickness + 2 * string.proud,
      yaw,
      col: stone,
      faceColors: stoneShades,
      faceUvs: faceUvsFor(tiers * tierDepth, string.height, thickness + 2 * string.proud),
    })

    // The second course, at the foot: the same stone, the same run, so the
    // brick between the two bands reads as courses of masonry rather than one
    // tall panel with a stripe on it.
    const plinth = MASONRY.plinth
    addTransformedBox(positions, normals, colors, uvs, {
      cx: band.x,
      cy: plinth.top - plinth.height / 2,
      cz: band.z,
      sx: tiers * tierDepth,
      sy: plinth.height,
      sz: thickness + 2 * plinth.proud,
      yaw,
      col: stone,
      faceColors: stoneShades,
      faceUvs: faceUvsFor(tiers * tierDepth, plinth.height, thickness + 2 * plinth.proud),
    })
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// The corner's vacant court, planted as a bank.
//
// With the wall across the back of the corner gone, the two ends stand apart,
// and the wedge between them -- the bleachers' section wall on one side, the
// side stand's end on the other, the padded field wall at the front -- is open
// to the sky and to the outside of the park. Laid flat, a bed there could not be
// seen from the plate at all: the corner's parapet, stepped wall and the stands
// themselves all stand between it and home, and the court is the lowest ground
// in the block. So the
// court is not a floor, it is a bank. Its turf climbs in the bleachers' own
// direction -- up and away from the plate -- so the planting carries their
// terracing round the corner, rising from the field wall to the rear copings and
// filling the notch between the two buildings with green. From the plate the
// bank is the one thing in the corner that is not masonry.
//
// It fills the court wall to wall, wet course and all, so no strip of bare
// ground is left down either side. At the open mouth the bank is cut back to
// the ground again (`batter`): its last metre and a half is a planted slope
// falling from the high edge of the bed to the ground between the two buildings,
// so the raised planting ends on grass from outside as it does from the field,
// instead of on a retaining wall. The slope is inside the walls, which run on to
// the mouth, so its two sides are closed by the buildings and only its green
// face shows.
const CORNER_BED = {
  // The turf runs into its walls rather than standing back from them; the
  // negative margin tucks the last few centimetres under the brick, so no seam
  // of ground shows at the foot of either wall.
  margin: -0.03,
  // How far the bank is cut back from the mouth: the planted batter down to the
  // ground outside. Kept short, because the mouth is the sky gap the bank is
  // meant to close: the further the crest stands back from it, the more of the
  // notch opens over the green again.
  batter: 1.5,
  // The stone edge along the foot of that slope, where it meets the ground.
  edge: 0.34,
  edgeHeight: 0.16,
  // One tile of the turf texture per this many metres, so its blades stay the
  // same size on the bank as they are on the field rather than minifying into
  // a flat tone.
  tile: 6,
}

// The bank's height, in the bleachers' own rake: their first tier's deck above
// the outfield wall, climbing one tier for every tier's depth out from the
// plate. That is the same rise their rows make, so the planted corner continues
// their terracing rather than being a mound dropped between the two stands.
//
// It also carries a lift, because from home plate a bank set on the deck's own
// datum disappears behind the stepped corner wall: only its last metre shows,
// and the notch between the two rear facades still opens on the night sky above
// it. Raising the whole bank sets its crest up against the copings that cap
// those facades (7.29 m on the bleachers, 7.6 m on the side stand), so the court
// reads as planted ground filling the gap between the buildings from the plate,
// not as a green sliver at the foot of the brick.
function cornerBankHeight(x, z) {
  const { frontR, baseHeight } = OUTFIELD_BLEACHERS
  const r = Math.hypot(x, z)
  return baseHeight + BANK_LIFT + BANK_RAKE * (r - frontR)
}

// The bank's rise per metre out from the plate. The bleachers climb one tier
// (0.52 m) every 1.35 m; the bed climbs with them, a little steeper -- the
// section wall in front of it steps at their own rate, so a bank laid at exactly
// their rake would hide behind the brick for its whole length. Set a little
// faster, it rises through the wall's silhouette as the rows do, and its crest
// meets the rear facades' copings at the mouth instead of stopping under them.
// It is still a planted bank and not a wall: no steeper than it has to be.
const BANK_RAKE = 0.53

// How far the bank's whole profile is lifted over the bleachers' deck datum.
// The lift is what makes the court read from home plate: it stands the bank's
// crest on the copings, and its foot over the corner's field wall, so the green
// shows above the stepped brick near the field as well as at the rear.
const BANK_LIFT = 1.3

// Where the court's three faces are. The bed is laid out off the walls rather
// than off hard-coded corners: the section wall, the side stand's end and the
// open mouth are each pushed back by `margin` (the mouth by `mouthMargin`), and
// the three lines intersected, so the bed stays clear of whatever the masonry
// does at the corner. The court is the triangle those three walls make, so the
// points come back in order round it: the section corner at the mouth, the side
// corner at the mouth, and the field apex where the two end walls meet.
function cornerBedPlan(side, margin, mouthMargin) {
  const { angle, thickness } = CORNER_WALL
  const { frontR, tiers, tierDepth } = OUTFIELD_BLEACHERS
  const rBack = frontR + tiers * tierDepth
  const out = { x: side * Math.sin(angle), z: -Math.cos(angle) }
  const past = { x: side * Math.cos(angle), z: Math.sin(angle) }
  const pole = INFIELD_STANDS_CURVE.getPoint(side < 0 ? 0 : 1)
  const tan = INFIELD_STANDS_CURVE.getTangent(side < 0 ? 0 : 1).normalize()
  const n = { x: -tan.z, z: tan.x }
  const a = { x: out.x * rBack, z: out.z * rBack }
  const b = {
    x: pole.x + n.x * (INFIELD_STANDS_DEPTH - thickness / 2),
    z: pole.z + n.z * (INFIELD_STANDS_DEPTH - thickness / 2),
  }
  const run = { x: b.x - pole.x, z: b.z - pole.z }
  const runLen = Math.hypot(run.x, run.z)
  const along = { x: run.x / runLen, z: run.z / runLen }
  const midSide = { x: pole.x + along.x * (runLen / 2), z: pole.z + along.z * (runLen / 2) }
  // The court is on the side of the side wall that the mouth's far corner is.
  let outSide = { x: along.z, z: -along.x }
  if ((a.x - midSide.x) * outSide.x + (a.z - midSide.z) * outSide.z < 0) {
    outSide = { x: -outSide.x, z: -outSide.z }
  }
  // The side end of the court: the stand's end wall, which now stands a hand's
  // width further out than the pole's line (see SIDE_END.back), so the bed's
  // edge moves out with it and the bank still finishes against brick.
  const sideSet = thickness / 2 + SIDE_END.back + margin
  const sideWall = {
    p: {
      x: midSide.x + outSide.x * sideSet,
      z: midSide.z + outSide.z * sideSet,
    },
    d: along,
  }
  const chord = { x: b.x - a.x, z: b.z - a.z }
  const chordLen = Math.hypot(chord.x, chord.z)
  const chordDir = { x: chord.x / chordLen, z: chord.z / chordLen }
  // The court is on the field side of the mouth, the side the foul pole is on.
  let intoCourt = { x: -chordDir.z, z: chordDir.x }
  if ((pole.x - a.x) * intoCourt.x + (pole.z - a.z) * intoCourt.z < 0) {
    intoCourt = { x: -intoCourt.x, z: -intoCourt.z }
  }
  const mouth = {
    p: { x: a.x + intoCourt.x * mouthMargin, z: a.z + intoCourt.z * mouthMargin },
    d: chordDir,
  }
  const section = {
    p: { x: out.x + past.x * (thickness + margin), z: out.z + past.z * (thickness + margin) },
    d: out,
  }

  const meet = (p, d, q, e) => {
    const den = d.x * e.z - d.z * e.x
    const k = ((q.x - p.x) * e.z - (q.z - p.z) * e.x) / den
    return { x: p.x + d.x * k, z: p.z + d.z * k }
  }
  return [
    meet(section.p, section.d, mouth.p, mouth.d),
    meet(mouth.p, mouth.d, sideWall.p, sideWall.d),
    meet(sideWall.p, sideWall.d, section.p, section.d),
  ]
}

// The turf itself: one raked panel per corner, filled from the crest of the
// bank in to the field, with its texture mapped straight off the world so the
// blades do not stretch where the bank is wider at the back than at the apex.
// The panel is sliced from the back in to the field rather than fanned from a
// centre, so each strip follows the bank's own rise instead of being one
// planar triangle spanning the whole slope. Beyond the crest the last strip
// falls away to the ground at the mouth, so the raised bed reads as a planted
// bank from outside as well as from the field.
function createCornerBedGeometry() {
  const positions = []
  const normals = []
  const uvs = []
  const { margin, batter, tile } = CORNER_BED
  const { tierDepth, tierHeight } = OUTFIELD_BLEACHERS
  const rake = tierHeight / tierDepth
  const SLICES = 16

  // The bank's face normal from its slope: it rises one tier's height per
  // tier's depth out from the plate, so the normal leans back toward home by
  // that same amount, all round the corner.
  const normalAt = (x, z) => {
    const r = Math.hypot(x, z) || 1
    const nx = -rake * (x / r)
    const nz = -rake * (z / r)
    const len = Math.hypot(nx, 1, nz)
    return [nx / len, 1 / len, nz / len]
  }
  const pushTriangle = (p, q, r, normal) => {
    const ux = q.x - p.x
    const uz = q.z - p.z
    const vx = r.x - p.x
    const vz = r.z - p.z
    const up = uz * vx - ux * vz > 0
    const order = up ? [p, q, r] : [p, r, q]
    for (const point of order) {
      positions.push(point.x, point.y, point.z)
      normals.push(...normal)
      // The bank is mapped off the world in plan. The mouth's face is the one
      // piece that is nearly upright, so it carries its own UVs instead: along
      // the mouth and up the drop, or the leaf clumps smear into vertical
      // streaks on the way down to the ground.
      uvs.push(point.u ?? point.x / tile, point.v ?? point.z / tile)
    }
  }

  for (const side of [-1, 1]) {
    // The bank proper, from the crest back to the field's apex.
    const crestPlan = cornerBedPlan(side, margin, batter)
    const [a, b, c] = crestPlan
    const along = (p, t) => ({ x: p.x + (c.x - p.x) * t, z: p.z + (c.z - p.z) * t })
    for (let i = 0; i < SLICES; i++) {
      const t0 = i / SLICES
      const t1 = (i + 1) / SLICES
      const corners = [along(a, t0), along(b, t0), along(b, t1), along(a, t1)].map((p) => ({
        x: p.x, y: cornerBankHeight(p.x, p.z), z: p.z,
      }))
      pushTriangle(corners[0], corners[1], corners[2], normalAt(corners[0].x, corners[0].z))
      pushTriangle(corners[0], corners[2], corners[3], normalAt(corners[2].x, corners[2].z))
    }

    // The batter: from the crest down to the ground at the mouth, a straight
    // slope between the walls, so the planted bank finishes on grass where it
    // meets the outside ground.
    const mouthPlan = cornerBedPlan(side, margin, 0)
    const [m0, m1] = mouthPlan
    const [k0, k1] = [crestPlan[0], crestPlan[1]]
    const y0 = cornerBankHeight(k0.x, k0.z)
    const y1 = cornerBankHeight(k1.x, k1.z)
    const down = (from, to, t) => ({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (0.02 - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    })
    const crestA = { x: k0.x, y: y0, z: k0.z }
    const crestB = { x: k1.x, y: y1, z: k1.z }
    // The mouth's own frame: its width runs across the slope, its drop up it, so
    // every clump lands square on the face rather than stretched down it.
    const mouthWidth = Math.hypot(m1.x - m0.x, m1.z - m0.z)
    const withUv = (p, across) => ({
      ...p,
      u: (across * mouthWidth) / tile,
      v: (p.y - 0.02) / tile,
    })
    const STEPS = 8
    for (let i = 0; i < STEPS; i++) {
      const t0 = i / STEPS
      const t1 = (i + 1) / STEPS
      const p00 = withUv(down(crestA, m0, t0), 0)
      const p10 = withUv(down(crestB, m1, t0), 1)
      const p01 = withUv(down(crestA, m0, t1), 0)
      const p11 = withUv(down(crestB, m1, t1), 1)
      const ux = p10.x - p00.x, uy = p10.y - p00.y, uz = p10.z - p00.z
      const vx = p01.x - p00.x, vy = p01.y - p00.y, vz = p01.z - p00.z
      let nx = uy * vz - uz * vy
      let ny = uz * vx - ux * vz
      let nz = ux * vy - uy * vx
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz }
      const len = Math.hypot(nx, ny, nz) || 1
      const normal = [nx / len, ny / len, nz / len]
      pushTriangle(p00, p10, p11, normal)
      pushTriangle(p00, p11, p01, normal)
    }
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// The bank's planting, in the round.
//
// A raked plane of turf has a drawn edge: its crest runs dead straight from one
// wall to the other, and the batter below falls away as one flat sheet. The
// court reads as a panel because of that line -- the eye finds it long before it
// finds the leaves. So the bank grows a crop of blocky leaf clumps along the
// crest and down the batter: cubes of leaf green, stacked and set a little out
// of true, standing proud of the slope and breaking its top edge into brows and
// notches. The foot of the batter gets its own row over the kerb, so the mouth
// finishes in leaves too instead of on the plane's cut line. They are the bed's
// own greens built in the round instead of drawn on the plane -- the bushes of
// the game in the park's palette, not a copy of them -- and every clump is held
// inside the court's plan, so the planting never breaks the brick's outside face.
const CORNER_CLUMPS = {
  // How far apart the clumps along the crest stand: the bushes are a metre or
  // so across, so this leaves them touching in places and open in others.
  step: 0.95,
  // Clear brick left at each end of the run, so the last bush finishes against
  // the walls instead of growing through them.
  inset: 0.66,
}

function createCornerBedClumpsGeometry() {
  const positions = []
  const normals = []
  const colors = []
  const uvs = []
  const rng = createPRNG(8327)
  const { margin, batter, tile } = CORNER_BED

  // The bed's greens lifted a stop or two for the clumps: they stand in the
  // light instead of being shaded by the plane behind them, and a bush has to
  // read against it from the plate. Still deep enough to be planting and not
  // turf, and a shade or two apart so one bush reads apart from the next.
  const greens = ['#7d9a5d', '#8bab6a', '#6f8b52', '#97b473', '#627c48'].map(
    (hex) => new THREE.Color(hex),
  )

  // One clump: a yawed box of leaf. Each face lands on its own spot in the leaf
  // tile, so no two bushes wear the same clump of leaves, and the faces take the
  // flat shading the park's other blocks use -- sky-lit top, lit and shaded
  // sides, dark underside -- so a clump reads as a stack of leaf facets rather
  // than a green lump.
  const clump = ({ x, y, z, sx, sy, sz, yaw, tint }) => {
    const faceColors = faceShades(tint)
    const faceUvs = [
      [0, 0, sx / tile, sy / tile],
      [0, 0, sx / tile, sy / tile],
      [0, 0, sz / tile, sy / tile],
      [0, 0, sz / tile, sy / tile],
      [0, 0, sx / tile, sz / tile],
      [0, 0, sx / tile, sz / tile],
    ].map(([u0, v0, u1, v1]) => {
      const du = rng() * 0.75
      const dv = rng() * 0.75
      return [u0 + du, v0 + dv, u1 + du, v1 + dv]
    })
    addTransformedBox(positions, normals, colors, uvs, {
      cx: x, cy: y, cz: z, sx, sy, sz, yaw, col: tint, faceColors, faceUvs,
    })
  }

  for (const side of [-1, 1]) {
    const crest = cornerBedPlan(side, margin, batter)
    const mouth = cornerBedPlan(side, margin, 0)
    const [k0, k1] = crest
    const [m0, m1] = mouth

    // The court's two brick walls, as lines in plan. A clump whose box would
    // reach into either is drawn back inside it, so the planting never breaks
    // the outside face of the brick at the corner.
    const wallLine = (p, q, away) => {
      const wdx = q.x - p.x
      const wdz = q.z - p.z
      const len = Math.hypot(wdx, wdz) || 1
      let nx = -wdz / len
      let nz = wdx / len
      if ((away.x - p.x) * nx + (away.z - p.z) * nz < 0) { nx = -nx; nz = -nz }
      return { p, n: { x: nx, z: nz } }
    }
    const walls = [
      wallLine(mouth[1], mouth[2], mouth[0]),
      wallLine(mouth[2], mouth[0], mouth[1]),
    ]
    const confine = (x, z, reach) => {
      let cx = x
      let cz = z
      for (const edge of walls) {
        const depth = (cx - edge.p.x) * edge.n.x + (cz - edge.p.z) * edge.n.z
        const need = reach + 0.08
        if (depth < need) {
          cx += edge.n.x * (need - depth)
          cz += edge.n.z * (need - depth)
        }
      }
      return { x: cx, z: cz }
    }

    const dx = k1.x - k0.x
    const dz = k1.z - k0.z
    const width = Math.hypot(dx, dz)
    const along = { x: dx / width, z: dz / width }
    // The court's outward direction: from the crest out to the ground at the
    // mouth, square to the crest line.
    const outLen = Math.hypot(m0.x - k0.x, m0.z - k0.z)
    const out = { x: (m0.x - k0.x) / outLen, z: (m0.z - k0.z) / outLen }
    const yaw = Math.atan2(-dz, dx)
    const bankY = (x, z) => cornerBankHeight(x, z)
    const crestY0 = bankY(k0.x, k0.z)
    const crestY1 = bankY(k1.x, k1.z)

    // The crest row: a bush every step or so, each set its own height above the
    // turf and its own way out over the batter, so the skyline breaks into brows
    // and notches instead of a drawn line. A station is dropped now and then to
    // leave a gap the sky shows through, and two bushes share a station often
    // enough that the row never reads as evenly spaced.
    const run = width - 2 * CORNER_CLUMPS.inset
    const stations = Math.max(3, Math.round(run / CORNER_CLUMPS.step))
    for (let i = 0; i <= stations; i += 1) {
      if (rng() < 0.14) continue
      const s = CORNER_CLUMPS.inset + (run * i) / stations
      const px = k0.x + along.x * s
      const pz = k0.z + along.z * s
      const top = bankY(px, pz)
      const bushes = rng() < 0.46 ? 2 : 1
      for (let j = 0; j < bushes; j += 1) {
        const off = (rng() - 0.5) * (j === 0 ? 0.6 : 1.15)
        // The near corner of the run's brick, as a reach from this clump's
        // centre: a bush planted at the end is trimmed back to it, so no leaf
        // ever breaks the outside face of a corner wall.
        const wall = Math.min(
          CORNER_CLUMPS.inset + s + off,
          CORNER_CLUMPS.inset + (run - s) - off,
        )
        const sx = Math.max(0.34, Math.min(0.76 + rng() * 0.6, 2 * wall - 0.3))
        const sy = 0.5 + rng() * 0.55
        const sz = 0.62 + rng() * 0.5
        const lean = -0.34 + rng() * 0.96
        // Every fourth station carries a bush a head taller than its
        // neighbours: the brow the skyline hangs on, rather than one even
        // fringe stepped along the coping.
        const above = i % 4 === 1
          ? 0.8 + rng() * 0.4
          : j === 0 ? 0.02 + rng() * 0.58 : 0.14 + rng() * 0.52
        const at = confine(
          px + along.x * off + out.x * lean,
          pz + along.z * off + out.z * lean,
          Math.max(sx, sz) / 2,
        )
        clump({
          x: at.x,
          y: top + above - sy / 2,
          z: at.z,
          sx,
          sy,
          sz,
          yaw: yaw + (rng() - 0.5) * 0.5,
          tint: greens[Math.floor(rng() * greens.length)],
        })
      }
    }

    // The batter: the face that drops from the crest to the ground at the mouth,
    // which from outside the court is one flat green sheet. Its clumps stand half
    // out of the slope at every level down it, so the drop reads as a face of
    // leaves with the sky and the ground in the gaps.
    const across = { x: k1.x - k0.x, y: crestY1 - crestY0, z: k1.z - k0.z }
    const drop = { x: m0.x - k0.x, y: 0.02 - crestY0, z: m0.z - k0.z }
    let n = {
      x: across.y * drop.z - across.z * drop.y,
      y: across.z * drop.x - across.x * drop.z,
      z: across.x * drop.y - across.y * drop.x,
    }
    const nLen = Math.hypot(n.x, n.y, n.z) || 1
    n = { x: n.x / nLen, y: n.y / nLen, z: n.z / nLen }
    if (n.x * out.x + n.z * out.z < 0) n = { x: -n.x, y: -n.y, z: -n.z }
    const ROWS = 6
    for (let row = 0; row < ROWS; row += 1) {
      // Down to the mouth's own line and a touch past it, so the foot of the
      // bank finishes in leaves standing over the kerb rather than on the
      // plane's cut edge.
      const t = 0.14 + (row / (ROWS - 1)) * 0.88 + (rng() - 0.5) * 0.06
      const count = 3 + Math.floor(rng() * 3) - (t > 0.7 ? 1 : 0)
      for (let j = 0; j < count; j += 1) {
        const u = 0.08 + rng() * 0.84
        // The face point: across the crest line, then down toward the mouth's
        // own line, so a clump lands where the plane actually is.
        const cxp = k0.x + (k1.x - k0.x) * u
        const czp = k0.z + (k1.z - k0.z) * u
        const cyp = crestY0 + (crestY1 - crestY0) * u
        const gxp = m0.x + (m1.x - m0.x) * u
        const gzp = m0.z + (m1.z - m0.z) * u
        const px = cxp + (gxp - cxp) * t
        const pz = czp + (gzp - czp) * t
        const py = cyp + (0.02 - cyp) * t
        const sx = 0.58 + rng() * 0.5
        const sy = 0.46 + rng() * 0.46
        const sz = 0.54 + rng() * 0.44
        const lift = 0.02 + rng() * 0.26
        const at = confine(
          px + n.x * lift,
          pz + n.z * lift,
          Math.max(sx, sz) / 2,
        )
        clump({
          x: at.x,
          y: py + n.y * lift,
          z: at.z,
          sx,
          sy,
          sz,
          yaw: yaw + (rng() - 0.5) * 0.8,
          tint: greens[Math.floor(rng() * greens.length)],
        })
      }
    }
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// The bed's foot: a stone edging along the mouth, where the planted batter
// meets the ground.
//
// The slope's own green face is what shows from outside, so the edge is not a
// retaining wall: it is a low band of the block's stone, one course deep, laid
// along the foot of the bank on the mouth's line, to give the planting a cut
// edge where it passes into the ground. It runs a hand's width past each end
// into the two walls, so it finishes against brick rather than in the open.
function createCornerBedKerbGeometry() {
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const stone = new THREE.Color('#b6ad9a')
  const stoneShades = faceShades(stone)
  const { margin, edge, edgeHeight } = CORNER_BED
  // Buried in the walls at either end, so no joint between stone and brick is
  // left in the clear.
  const reach = 0.35

  for (const side of [-1, 1]) {
    const plan = cornerBedPlan(side, margin, 0)
    const p0 = plan[0]
    const p1 = plan[1]
    const dx = p1.x - p0.x
    const dz = p1.z - p0.z
    const len = Math.hypot(dx, dz)
    const yaw = Math.atan2(-dz, dx)
    addTransformedBox(positions, normals, colors, uvs, {
      cx: (p0.x + p1.x) / 2,
      cy: edgeHeight / 2,
      cz: (p0.z + p1.z) / 2,
      sx: len + 2 * reach,
      sy: edgeHeight,
      sz: edge,
      yaw,
      col: stone,
      faceColors: stoneShades,
      faceUvs: faceUvsFor(len + 2 * reach, edgeHeight, edge),
    })
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// A wall's section, swept across its thickness.
//
// The corner's walls are not all boxes: the side stand's end is a low parapet at
// the field, where the corner's seats look past it, and rakes up to the rear
// facade behind them. So it is built from the section it actually has -- a
// closed outline in the wall's own (run, height) plane -- and swept across the
// wall's thickness. The outline is wound anticlockwise, so (dy, -ds) is its
// outward normal, and every face is shaded by which way it turns, the same
// `faceShades` the boxes beside it use.
function addWallSection(positions, normals, colors, uvs, { section, half, origin, along, across, shades }) {
  const at = (point, w) => [
    origin.x + along.x * point[0] + across.x * w,
    point[1],
    origin.z + along.z * point[0] + across.z * w,
  ]
  const push = (point, normal, u, v, col) => {
    positions.push(point[0], point[1], point[2])
    normals.push(normal[0], normal[1], normal[2])
    uvs.push(u, v)
    colors.push(col.r, col.g, col.b)
  }

  // The sweep: one quad per edge of the outline, from one face of the wall to
  // the other, each with the outline's own normal.
  for (let i = 0; i < section.length; i++) {
    const a = section[i]
    const b = section[(i + 1) % section.length]
    const ds = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(ds, dy) || 1
    const n = [(dy / len) * along.x, -ds / len, (dy / len) * along.z]
    const turn = n[0] * across.x + n[2] * across.z
    const col = n[1] > 0.7 ? shades[4]
      : n[1] < -0.7 ? shades[5]
        : turn > 0.7 ? shades[1]
          : turn < -0.7 ? shades[0]
            : shades[2]
    const a0 = at(a, -half)
    const a1 = at(a, half)
    const b0 = at(b, -half)
    const b1 = at(b, half)
    const ua = a[0] / UV_METRES
    const ub = b[0] / UV_METRES
    const va = a[1] / UV_METRES
    const vb = b[1] / UV_METRES
    push(a0, n, ua, va, col)
    push(b0, n, ub, vb, col)
    push(b1, n, ub, vb, col)
    push(a0, n, ua, va, col)
    push(b1, n, ub, vb, col)
    push(a1, n, ua, va, col)
  }

  // The wall's two big faces: the outline itself, triangulated rather than
  // fanned -- the cornice's band is not star-shaped, so a fan would throw a
  // triangle of stone up over the wall. The face on the field side takes the
  // lighter of the brick's two tones.
  const contour = section.map(([s, y]) => new THREE.Vector2(s, y))
  const triangles = THREE.ShapeUtils.triangulateShape(contour, [])
  for (const w of [-half, half]) {
    const n = [across.x * Math.sign(w), 0, across.z * Math.sign(w)]
    const col = w < 0 ? shades[0] : shades[1]
    for (const triangle of triangles) {
      for (const i of triangle) {
        const [s, y] = section[i]
        push(at(section[i], w), n, s / UV_METRES, y / UV_METRES, col)
      }
    }
  }
}

// The side stands' own end walls, where the bowl stops at each foul pole.
//
// The bowl is a sweep, so its ends are cross-sections: from the corner you look
// into the cut edges of the terracing and the night behind them. Each end closes
// in the same brick as the corner wall, under the same stone cornice.
//
// The wall begins where the corner's section line crosses it, not at the pole.
// The bleachers run on past the pole to that line, so the stretch of end wall
// between the pole and the line stood in front of the corner's seats -- an end
// elevation crossing their frontage rather than closing it. Cut back to the
// line, the wall is the court's own outside wall: it starts flush with the
// corner wall's court face, rakes up with the bleacher rows behind it, and dies
// into the side stand's rear facade with a pier. What closes the side stand's
// cut at the pole is the bleachers themselves, which stand right against it.
const SIDE_END = {
  thickness: 0.46,
  // How far out from the plate this wall stands, past the pole's own line: its
  // thickness and the cornice's projection, plus a hand's width. Its field face
  // sits behind the padded wall's face, so no course of the wall comes forward
  // of the blue: the padding runs past the pole uninterrupted and the masonry
  // starts behind it. (The padding's half-thickness, 0.183, plus the cornice's
  // 0.24, plus 0.03 clear.)
  back: 0.453,
  // The parapet's brick top, and where it starts to climb. The wall's start on
  // the corner's section line falls just past the knee; everything above rakes
  // with the bleacher rows behind the court.
  lowTop: 3.04,
  knee: 4.2,
}

function createSideEndWallGeometry() {
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const brick = new THREE.Color('#722e2a')
  const brickShades = faceShades(brick)
  const stone = new THREE.Color('#b6ad9a')
  const stoneShades = faceShades(stone)

  const { thickness, lowTop, knee, back: setOut } = SIDE_END
  const { height: cornice, proud } = MASONRY.cornice
  const { top: stringTop, height: stringHeight, proud: stringProud } = MASONRY.string
  const { top: plinthTop, height: plinthHeight, proud: plinthProud } = MASONRY.plinth
  const depth = INFIELD_STANDS_DEPTH
  // The wall rakes up to the bleachers' own rear wall and stops there -- the
  // brick line behind their back row, baseHeight + tiers x tierHeight -- instead
  // of climbing to the side stand's 7.6 m rear facade. It is the only piece of
  // masonry this end can put above a seat's eye, and the back rows sit at 6.72
  // m: 6.09 m of brick under the cornice keeps the whole rake below their heads,
  // so the last seats by the corner look along the wall at the plate, not at it.
  // The stand's rear facade still stands behind this, a storey higher.
  const rearTop =
    OUTFIELD_BLEACHERS.baseHeight + OUTFIELD_BLEACHERS.tiers * OUTFIELD_BLEACHERS.tierHeight

  for (const side of [-1, 1]) {
    const t = side < 0 ? 0 : 1
    const p = INFIELD_STANDS_CURVE.getPoint(t)
    const tan = INFIELD_STANDS_CURVE.getTangent(t).normalize()
    const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize()
    const yaw = Math.atan2(-n.z, n.x)
    // The frame the boxes and the section share: `n` runs the wall out from the
    // pole across the stand's depth, `across` is its thickness.
    const across = { x: Math.sin(yaw), z: Math.cos(yaw) }
    // The face the field sees, moved out past the pole's line by SIDE_END.back:
    // the whole wall is set back so its cornice clears the padded wall's face.
    const out = new THREE.Vector2(p.x, p.z).normalize()
    const origin = { x: p.x + out.x * setOut, z: p.z + out.y * setOut }
    const at = (d) => ({ x: origin.x + n.x * d, z: origin.z + n.z * d })

    // Where this wall runs out from under the bleachers: the point on its own
    // centreline where it reaches the corner's section line, taken at the
    // corner wall's court face. Everything before that was a wall across the
    // bleachers' frontage; the wall starts here, flush with the brick beside it.
    const past = { x: side * Math.cos(CORNER_WALL.angle), z: Math.sin(CORNER_WALL.angle) }
    const start = (CORNER_WALL.thickness / 2 - origin.x * past.x - origin.z * past.z)
      / (n.x * past.x + n.z * past.z)
    // The brick's top at any point along the run: the parapet to the knee, then
    // the rake the rows climb with.
    const topAt = (s) => (s <= knee
      ? lowTop
      : lowTop + (rearTop - lowTop) * ((s - knee) / (depth - knee)))
    const startTop = topAt(start)

    // The brick: the run from the corner's section line, raking to the rear
    // facade. It stands clear of the padding (see SIDE_END.back), so no part of
    // it shares the blue's face.
    addWallSection(positions, normals, colors, uvs, {
      section: start <= knee
        ? [
            [start, 0],
            [depth, 0],
            [depth, rearTop],
            [knee, lowTop],
            [start, lowTop],
          ]
        : [
            [start, 0],
            [depth, 0],
            [depth, rearTop],
            [start, startTop],
          ],
      half: thickness / 2,
      origin,
      along: { x: n.x, z: n.z },
      across,
      shades: brickShades,
    })

    // The stone cornice, on the same outline: a bed over the brick and a crown
    // standing past both faces, raking with the wall.
    addWallSection(positions, normals, colors, uvs, {
      section: start <= knee
        ? [
            [start, lowTop],
            [knee, lowTop],
            [depth, rearTop],
            [depth, rearTop + cornice],
            [knee, lowTop + cornice],
            [start, lowTop + cornice],
          ]
        : [
            [start, startTop],
            [depth, rearTop],
            [depth, rearTop + cornice],
            [start, startTop + cornice],
          ],
      half: thickness / 2 + proud,
      origin,
      along: { x: n.x, z: n.z },
      across,
      shades: stoneShades,
    })

    // The field end is where the corner wall stands, so it needs no pier: the
    // brick begins flush against that wall's court face, and the corner's own
    // stepped panels are the stop the eye reads.

    // The rear post is the block's abutment on the side stand's rear facade: it
    // climbs past the rake's cornice to that facade's own top and stops level
    // with it, brick under the same stone cap. The rake dies into a pier that
    // belongs to the taller building instead of stopping a metre short of it --
    // the step from the lowered parapet to the facade is carried, not left over.
    // It is built to the corner wall's own pier (same width, same cap), so the
    // two ends of the block are stops of one kind.
    const back = at(depth - thickness / 2)
    const abutment = ROOF.facadeTop
    const postWidth = CORNER_WALL.pier
    addTransformedBox(positions, normals, colors, uvs, {
      cx: back.x,
      cy: (abutment - cornice) / 2,
      cz: back.z,
      sx: postWidth,
      sy: abutment - cornice,
      sz: thickness + 0.1,
      yaw,
      col: brick,
      faceColors: brickShades,
      faceUvs: faceUvsFor(postWidth, abutment - cornice, thickness + 0.1),
    })
    addTransformedBox(positions, normals, colors, uvs, {
      cx: back.x,
      cy: abutment - cornice / 2,
      cz: back.z,
      sx: postWidth + 0.08,
      sy: cornice,
      sz: thickness + 2 * proud + 0.08,
      yaw,
      col: stone,
      faceColors: stoneShades,
      faceUvs: faceUvsFor(postWidth + 0.08, cornice, thickness + 2 * proud + 0.08),
    })

    // The lower band, at the block's foot: one box on the wall's own frame, from
    // the corner's section line to the rear post. The post stands proud of it,
    // so it reads as a course let into the brick rather than a ledge outside.
    const foot = at((depth + start) / 2)
    addTransformedBox(positions, normals, colors, uvs, {
      cx: foot.x,
      cy: plinthTop - plinthHeight / 2,
      cz: foot.z,
      sx: depth - start,
      sy: plinthHeight,
      sz: thickness + 2 * plinthProud,
      yaw,
      col: stone,
      faceColors: stoneShades,
      faceUvs: faceUvsFor(depth - start, plinthHeight, thickness + 2 * plinthProud),
    })

    // The string course, carried the wall's whole length: horizontal along the
    // parapet, then raking with the wall above the knee. It stays the same
    // distance under the brick's top all the way, so the face has a second
    // course climbing it instead of one blank triangle under the cornice.
    const drop = lowTop - stringTop
    addWallSection(positions, normals, colors, uvs, {
      section: start <= knee
        ? [
            [start, stringTop - stringHeight],
            [knee, stringTop - stringHeight],
            [depth, rearTop - drop - stringHeight],
            [depth, rearTop - drop],
            [knee, stringTop],
            [start, stringTop],
          ]
        : [
            [start, startTop - drop - stringHeight],
            [depth, rearTop - drop - stringHeight],
            [depth, rearTop - drop],
            [start, startTop - drop],
          ],
      half: thickness / 2 + stringProud,
      origin,
      along: { x: n.x, z: n.z },
      across,
      shades: stoneShades,
    })
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// The stone coping along the two rear facades.
//
// The corner's piers climb to the bleachers' rear facade and to the side stand's
// and stop level with them, which left both buildings' own tops bare: the
// masonry arrived at the eave and the eave was only the last edge of the facade,
// with the roof's back wall standing a storey behind it. A band along the top of
// each facade finishes that line in the block's own stone, so an abutment meets
// a coping instead of a bare slab, and the cornice that closes the corner block
// carries on round both buildings.
//
// It is the corner's cornice carried along the facades: the same 0.36 m bed,
// standing the same 0.24 m proud, with its top on the facade's own top -- so at
// either end of the block the pier's cap, the corner's stepped cornice and the
// coping all finish at one height. The run is swept as one strip rather than
// laid as a chain of boxes, because a chain of straight caps crosses itself on
// the inside of every bay of a curve.
function addCopingRun(positions, normals, colors, uvs, { samples, top, height, proud, backset, col }) {
  const shades = faceShades(col)
  const yBottom = top - height
  const depth = proud + backset
  const vTop = height / UV_METRES
  const vDepth = depth / UV_METRES

  const push = (p, normal, shade) => {
    positions.push(p.x, p.y, p.z)
    normals.push(normal[0], normal[1], normal[2])
    uvs.push(p.u, p.v)
    colors.push(shade.r, shade.g, shade.b)
  }
  const face = (corners, normal, shade) => {
    const [p0, p1, p2, p3] = corners
    for (const p of [p0, p1, p2, p0, p2, p3]) push(p, normal, shade)
  }

  // The band's two edges in plan: `outer` stands proud toward the field, `inner`
  // sits just behind the facade's plane. `s.nx/s.nz` is the facade's outward
  // normal, so the field is the -n side.
  const outer = samples.map((s) => ({ x: s.x - s.nx * proud, z: s.z - s.nz * proud }))
  const inner = samples.map((s) => ({ x: s.x + s.nx * backset, z: s.z + s.nz * backset }))
  const at = (p, y, u, v) => ({ x: p.x, y, z: p.z, u, v })

  let along = 0
  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i]
    const b = samples[i + 1]
    const seg = Math.hypot(b.x - a.x, b.z - a.z)
    const u0 = along / UV_METRES
    const u1 = (along + seg) / UV_METRES
    along += seg

    // One normal per bay, taken at the joint, so the band facets exactly where
    // the facade it caps does.
    const mx = a.nx + b.nx
    const mz = a.nz + b.nz
    const ml = Math.hypot(mx, mz) || 1
    const nx = mx / ml
    const nz = mz / ml
    const tx = (b.x - a.x) / seg
    const tz = (b.z - a.z) / seg
    const oa = outer[i]
    const ob = outer[i + 1]
    const ia = inner[i]
    const ib = inner[i + 1]

    // The face the park reads, standing proud of the facade.
    face(
      [at(oa, yBottom, u0, 0), at(ob, yBottom, u1, 0), at(ob, top, u1, vTop), at(oa, top, u0, vTop)],
      [-nx, 0, -nz],
      shades[0],
    )
    // Its back, against the wall.
    face(
      [at(ib, yBottom, u1, 0), at(ia, yBottom, u0, 0), at(ia, top, u0, vTop), at(ib, top, u1, vTop)],
      [nx, 0, nz],
      shades[1],
    )
    // The seat of the slab, and the shadow it throws from underneath.
    face(
      [at(oa, top, u0, 0), at(ob, top, u1, 0), at(ib, top, u1, vDepth), at(ia, top, u0, vDepth)],
      [0, 1, 0],
      shades[4],
    )
    face(
      [at(ia, yBottom, u0, 0), at(ib, yBottom, u1, 0), at(ib, yBottom, u1, vDepth), at(ia, yBottom, u0, vDepth)],
      [0, -1, 0],
      shades[5],
    )

    // The two ends of the run: each is the section in the clear, and each is
    // buried in an abutment's cap, so the band appears to run on into the wall.
    if (i === 0) {
      face(
        [at(oa, yBottom, 0, 0), at(ia, yBottom, vDepth, 0), at(ia, top, vDepth, vTop), at(oa, top, 0, vTop)],
        [-tx, 0, -tz],
        shades[3],
      )
    }
    if (i === samples.length - 2) {
      face(
        [at(ob, yBottom, vDepth, 0), at(ib, yBottom, 0, 0), at(ib, top, 0, vTop), at(ob, top, vDepth, vTop)],
        [tx, 0, tz],
        shades[3],
      )
    }
  }
}

// The bleachers' eave, from one corner's section line to the other: sampled on
// the same 64 bays their rear facade is drawn in, so the coping is as smooth as
// the wall it caps. Its ends land on the corner walls' rear piers, which stand
// at exactly this band's height.
function createBleacherCopingGeometry() {
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const { angle } = CORNER_WALL
  const { frontR, tiers, tierDepth, tierHeight, baseHeight, facadeLift } = OUTFIELD_BLEACHERS
  const r = frontR + tiers * tierDepth
  const bays = 64
  const samples = []
  for (let i = 0; i <= bays; i += 1) {
    const a = -angle + 2 * angle * (i / bays)
    samples.push({ x: r * Math.sin(a), z: -r * Math.cos(a), nx: Math.sin(a), nz: -Math.cos(a) })
  }

  addCopingRun(positions, normals, colors, uvs, {
    samples,
    top: baseHeight + tiers * tierHeight + facadeLift,
    ...MASONRY.coping,
    col: new THREE.Color('#b6ad9a'),
  })

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// ...and the grandstand's, foul pole to foul pole, on the bowl's own 80 bays: it
// follows the spline exactly where the facade does, runs round behind the
// backstop, and ends at the poles -- where the side stand's rear posts climb to
// this same band, so both of the block's abutments meet a finished eave.
function createGrandstandCopingGeometry() {
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const curve = INFIELD_STANDS_CURVE
  const bays = 80
  const samples = []
  for (let i = 0; i <= bays; i += 1) {
    const t = i / bays
    const p = curve.getPoint(t)
    const tan = curve.getTangent(t).normalize()
    const nx = -tan.z
    const nz = tan.x
    samples.push({
      x: p.x + nx * INFIELD_STANDS_DEPTH,
      z: p.z + nz * INFIELD_STANDS_DEPTH,
      nx,
      nz,
    })
  }

  addCopingRun(positions, normals, colors, uvs, {
    samples,
    top: ROOF.facadeTop,
    ...MASONRY.coping,
    col: new THREE.Color('#b6ad9a'),
  })

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// The batter's eye: the blank bay in the middle of the back bleachers that a
// hitter picks the ball up against.
//
// Its whole job is to have nothing on it, so the bay is cut out of the seating
// rather than covered up: the rows inside the screen's own span carry no seats,
// and no fans sit behind it, so the blank face is a section of the stand with
// that section's seats taken away — not a panel standing in front of a block of
// crowd. It stands on the deck's own front edge, just behind the padded outfield
// wall, and rises past the top row.
//
// It is set in a frame of the stand's own concrete: a pier at each end, run back
// across the empty bay, and a cap over the two of them, so the cloth is held by
// the structure the way the section walls hold the sections either side. The bay
// is what makes it read as part of the bleachers: from the plate the screen sits
// between its piers with the crowd carrying on past them, and from the side the
// blank terracing behind it is the only bare deck in the park.
const BATTERS_EYE = {
  // How much of the centre-field frontage it closes, either side of straight
  // away: 6.8° is about 24 m of wall at the bleachers' front radius.
  halfAngle: 0.1187,
  // Stands just clear of the bleachers' own front edge, so the wall and the
  // deck it sits on never share a plane.
  standoff: 0.05,
  thickness: 0.36,
  // ...and rises this far over the top row's deck, so the blank face still
  // covers the seating behind it seen from the plate's own height.
  capRise: 0.35,
  segments: 24,
  // The frame: a pier at each end of the cloth, run back across the bay on the
  // deck, and a cap over the whole width, standing proud of the screen.
  pierWidth: 0.9,
  pierDepth: 1.7,
  capThickness: 0.22,
  capOverhang: 0.16,
}

// The bay of bleachers the eye takes: the screen, its piers, and a hand's width
// of bare deck either side, so no cushion touches a pier.
const BATTERS_EYE_BAY_HALF = BATTERS_EYE.halfAngle
  + (BATTERS_EYE.pierWidth + 0.3) / OUTFIELD_BLEACHERS.frontR

// The cloth itself: the face the batter reads, its back, the cap along the top
// and the two returns at the ends. The frame around it is a separate piece (see
// createBattersEyeFrameGeometry), because it is the stand's concrete and not the
// screen's cloth.
function createBattersEyeGeometry() {
  const { frontR, tiers, tierHeight, baseHeight } = OUTFIELD_BLEACHERS
  const { halfAngle, standoff, thickness, capRise, segments } = BATTERS_EYE
  const rFront = frontR + standoff
  const rBack = rFront + thickness
  const yBase = baseHeight
  const yTop = baseHeight + tiers * tierHeight + capRise

  const positions = []
  const normals = []
  const uvs = []
  const colors = []

  const at = (r, angle, y) => [r * Math.sin(angle), y, -r * Math.cos(angle)]
  const push = (point, normal, uv, shade) => {
    positions.push(point[0], point[1], point[2])
    normals.push(...normal)
    uvs.push(...uv)
    colors.push(shade, shade, shade)
  }
  // The cloth's own falloff: 0.5 at the foot to 0.82 under the cap.
  const lit = (v) => 0.5 + 0.32 * v
  const quad = (a, b, c, d, normal, ua, ub, uc, ud) => {
    push(a, normal, ua, lit(a[3]))
    push(b, normal, ub, lit(b[3]))
    push(c, normal, uc, lit(c[3]))
    push(a, normal, ua, lit(a[3]))
    push(c, normal, uc, lit(c[3]))
    push(d, normal, ud, lit(d[3]))
  }
  // A corner of the wall, carrying its own height up the face (0 at the foot, 1
  // at the cap) so the shade climbs the screen as it does the corner terraces.
  const node = (point, v) => [...point, v]

  for (let i = 0; i < segments; i++) {
    const a0 = -halfAngle + (2 * halfAngle) * (i / segments)
    const a1 = -halfAngle + (2 * halfAngle) * ((i + 1) / segments)
    const u0 = i / segments
    const u1 = (i + 1) / segments
    const mid = (a0 + a1) / 2
    const inward = [-Math.sin(mid), 0, Math.cos(mid)]
    const outward = [Math.sin(mid), 0, -Math.cos(mid)]

    // The face the batter reads, turned toward the plate. Its u runs the cloth
    // across the panel: the texture's painted border is the screen's own
    // retaining frame inside the piers.
    quad(
      node(at(rFront, a0, yBase), 0),
      node(at(rFront, a1, yBase), 0),
      node(at(rFront, a1, yTop), 1),
      node(at(rFront, a0, yTop), 1),
      inward,
      [u0, 0], [u1, 0], [u1, 1], [u0, 1],
    )
    // ...and its back, so the screen is a wall with a thickness rather than a
    // sheet seen from behind.
    quad(
      node(at(rBack, a0, yBase), 0),
      node(at(rBack, a0, yTop), 1),
      node(at(rBack, a1, yTop), 1),
      node(at(rBack, a1, yBase), 0),
      outward,
      [u0, 0], [u0, 1], [u1, 1], [u1, 0],
    )
    // The cap along the top, under the concrete coping.
    quad(
      node(at(rFront, a0, yTop), 1),
      node(at(rBack, a0, yTop), 1),
      node(at(rBack, a1, yTop), 1),
      node(at(rFront, a1, yTop), 1),
      [0, 1, 0],
      [u0, 1], [u0, 1], [u1, 1], [u1, 1],
    )
  }

  // The two ends are returns, closed over the wall's thickness.
  for (const [angle, normal] of [
    [-halfAngle, [-Math.cos(halfAngle), 0, -Math.sin(halfAngle)]],
    [halfAngle, [Math.cos(halfAngle), 0, Math.sin(halfAngle)]],
  ]) {
    quad(
      node(at(rFront, angle, yBase), 0),
      node(at(rFront, angle, yTop), 1),
      node(at(rBack, angle, yTop), 1),
      node(at(rBack, angle, yBase), 0),
      normal,
      [0, 0], [0, 1], [1, 1], [1, 0],
    )
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geom
}

// The eye's frame: the two piers and the cap that hold the cloth, in the same
// concrete as the section walls.
//
// It is what turns the screen from a sheet propped against the stands into a bay
// of them. The piers are as deep as a section wall and stand on the deck behind
// the screen, so the blank bay they enclose reads as the section's own floor;
// the cap is a curved slab over the two, carried out past the cloth like a
// canopy's fascia, so the screen has a top you can walk under rather than a cut
// edge of cloth.
function createBattersEyeFrameGeometry() {
  const { frontR, tiers, tierHeight, baseHeight } = OUTFIELD_BLEACHERS
  const {
    halfAngle, standoff, pierWidth, pierDepth, capThickness, capOverhang, capRise, segments,
  } = BATTERS_EYE
  const rFront = frontR + standoff
  const yBase = baseHeight
  const yTop = baseHeight + tiers * tierHeight + capRise
  const pierAng = pierWidth / rFront

  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  // The section walls' concrete, shaded by face like every other box in the
  // park's structure.
  const col = new THREE.Color('#3d5044')
  const shades = faceShades(col)

  // The piers: one each end, standing on the deck and running back across the
  // bay, so the screen's ends meet the stand rather than hanging in front of it.
  for (const side of [-1, 1]) {
    const angle = side * (halfAngle + pierAng / 2)
    const r = rFront + pierDepth / 2 - 0.05
    const cx = r * Math.sin(angle)
    const cz = -r * Math.cos(angle)
    const height = yTop + capThickness - yBase
    addChamferedBox(positions, normals, colors, uvs, {
      cx,
      cy: yBase + height / 2,
      cz,
      sx: pierWidth,
      sy: height,
      sz: pierDepth,
      yaw: -angle,
      bevel: 0.05,
      col,
      faceColors: shades,
      faceUvs: faceUvsFor(pierWidth, height, pierDepth),
    })
  }

  // The cap: a curved slab from just in front of the cloth to just behind the
  // piers, so it overhangs the face and finishes the bay behind it.
  const rIn = rFront - capOverhang
  const rOut = rFront + pierDepth + capOverhang
  const aHalf = halfAngle + pierAng + 0.012
  const yCap = yTop + capThickness
  const at = (r, angle, y) => [r * Math.sin(angle), y, -r * Math.cos(angle)]
  const uvAt = (p) => {
    const r = Math.hypot(p[0], p[2])
    return [(Math.atan2(p[0], -p[2]) * r) / 1.2, (r + p[1]) / 1.2]
  }
  const quad = (pts, want, shade) => {
    let [a, b, c, d] = pts
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    let n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ]
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      ;[b, d] = [d, b]
      n = [-n[0], -n[1], -n[2]]
    }
    const len = Math.hypot(...n) || 1
    const unit = [n[0] / len, n[1] / len, n[2] / len]
    const tint = col.clone().multiplyScalar(shade)
    for (const p of [a, b, c, a, c, d]) {
      positions.push(p[0], p[1], p[2])
      normals.push(...unit)
      colors.push(tint.r, tint.g, tint.b)
      uvs.push(...uvAt(p))
    }
  }

  for (let i = 0; i < segments; i++) {
    const a0 = -aHalf + (2 * aHalf) * (i / segments)
    const a1 = -aHalf + (2 * aHalf) * ((i + 1) / segments)
    const mid = (a0 + a1) / 2
    // Top, bottom, and the two long faces: the cap is a slab, not a plane, so it
    // catches a lit edge along the field side the way the roofs do.
    quad([at(rIn, a0, yCap), at(rIn, a1, yCap), at(rOut, a1, yCap), at(rOut, a0, yCap)], [0, 1, 0], 1.22)
    quad([at(rIn, a0, yTop), at(rIn, a1, yTop), at(rOut, a1, yTop), at(rOut, a0, yTop)], [0, -1, 0], 0.62)
    quad([at(rIn, a0, yTop), at(rIn, a1, yTop), at(rIn, a1, yCap), at(rIn, a0, yCap)], [-Math.sin(mid), 0, Math.cos(mid)], 1.06)
    quad([at(rOut, a0, yTop), at(rOut, a1, yTop), at(rOut, a1, yCap), at(rOut, a0, yCap)], [Math.sin(mid), 0, -Math.cos(mid)], 0.74)
  }
  // The cap's two ends, closed over the overhang.
  for (const [angle, normal] of [
    [-aHalf, [-Math.cos(aHalf), 0, -Math.sin(aHalf)]],
    [aHalf, [Math.cos(aHalf), 0, Math.sin(aHalf)]],
  ]) {
    quad(
      [at(rIn, angle, yTop), at(rOut, angle, yTop), at(rOut, angle, yCap), at(rIn, angle, yCap)],
      normal,
      0.9,
    )
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geom
}

// Padded backstop wall with sponsor billboards directly behind home plate /
// batter. The pad is a slab, not a sheet: it stands off the wall behind it,
// its arrises are chamfered and its top edge rolls into the caution rail that
// the texture paints along its top -- so from the plate it reads as bolted-on
// padding, not as a billboard propped up in the dirt.
function createBackstopWallGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const w = 18.0
  const h = 0.90
  const z = 15.6
  const thickness = 0.26

  // The texture is the padding's own face; the back, ends, top and bottom
  // sample its dark green ground so the whole pad is one material. The front's
  // top edge carries the yellow caution band, which the top chamfer inherits.
  const padGround = [0.004, 0.10, 0.004, 0.10]
  addChamferedBox(positions, normals, colors, uvs, {
    cx: 0,
    cy: 0.05 + h / 2,
    cz: z + thickness / 2,
    sx: w,
    sy: h,
    sz: thickness,
    bevel: 0.075,
    col: new THREE.Color('#ffffff'),
    faceUvs: [[0, 0, 1, 1], padGround, padGround, padGround, padGround, padGround],
  })

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// The outfield wall's own bay lines, shared by the padding, the top rail and
// the distance signs, so all three stand on the same bays of the ring. The pads
// run past both foul poles to the corner's section line: outside the poles the
// bleachers carry on to that line, and their frontage is the blue padding there
// too, not a change of wall at the pole.
const WALL_BAYS = 32
const WALL_FROM = -CORNER_ANGLE
const WALL_TO = CORNER_ANGLE
const WALL_HEIGHT = feetToM(8)
const WALL_THICKNESS = feetToM(1.2)

function wallBay(i) {
  const a0 = WALL_FROM + (WALL_TO - WALL_FROM) * (i / WALL_BAYS)
  const a1 = WALL_FROM + (WALL_TO - WALL_FROM) * ((i + 1) / WALL_BAYS)
  const mid = (a0 + a1) / 2
  return {
    mid,
    x: WALL_RADIUS * Math.sin(mid),
    z: -WALL_RADIUS * Math.cos(mid),
    arc: (WALL_RADIUS * (WALL_TO - WALL_FROM)) / WALL_BAYS,
  }
}

// The padded outfield wall, as one mesh: thirty-two pad bays, each a chamfered
// slab so the padding rolls its arrises into the bay beside it (the pair's
// chamfers leave a shallow V that reads as the joint between two bolsters)
// instead of butting a cuboid against a cuboid, plus the yellow rail along their
// top with the same treatment. The pads keep the pad texture on every face; the rail
// takes the park's voxel face shading, so its chamfers catch a light of their
// own.
function createOutfieldWallGeometry() {
  const pad = { positions: [], normals: [], colors: [], uvs: [] }
  const rail = { positions: [], normals: [], colors: [] }
  const colPad = new THREE.Color('#ffffff') // the pad's colour is its texture
  const colRail = new THREE.Color('#fbc02d')
  const railFaces = faceShades(colRail)

  for (let i = 0; i < WALL_BAYS; i++) {
    const bay = wallBay(i)
    addChamferedBox(pad.positions, pad.normals, pad.colors, pad.uvs, {
      cx: bay.x,
      cy: WALL_HEIGHT / 2,
      cz: bay.z,
      sx: bay.arc * 1.01,
      sy: WALL_HEIGHT,
      sz: WALL_THICKNESS,
      yaw: -bay.mid,
      bevel: 0.08,
      col: colPad,
    })
    addChamferedBox(rail.positions, rail.normals, rail.colors, {
      cx: bay.x,
      cy: WALL_HEIGHT + 0.11,
      cz: bay.z,
      sx: bay.arc * 1.01,
      sy: 0.22,
      sz: WALL_THICKNESS * 1.08,
      yaw: -bay.mid,
      bevel: 0.06,
      col: colRail,
      faceColors: railFaces,
    })
  }

  const padGeom = new THREE.BufferGeometry()
  padGeom.setAttribute('position', new THREE.Float32BufferAttribute(pad.positions, 3))
  padGeom.setAttribute('normal', new THREE.Float32BufferAttribute(pad.normals, 3))
  padGeom.setAttribute('uv', new THREE.Float32BufferAttribute(pad.uvs, 2))

  const railGeom = new THREE.BufferGeometry()
  railGeom.setAttribute('position', new THREE.Float32BufferAttribute(rail.positions, 3))
  railGeom.setAttribute('normal', new THREE.Float32BufferAttribute(rail.normals, 3))
  railGeom.setAttribute('color', new THREE.Float32BufferAttribute(rail.colors, 3))

  return { pads: padGeom, rails: railGeom }
}

// The distance markers are pads too, not decals: each number is a chamfered
// slab standing off the padding, its face carrying the marker texture and its
// sides, back and chamfer band the marker's own navy frame (the band lands on
// the yellow border the texture paints round the number, so the sign wears a
// rolled yellow edge). One geometry serves all five, since only the texture and
// the bay differ.
const WALL_SIGN_WIDTH = feetToM(8)
const WALL_SIGN_HEIGHT = feetToM(4)
const WALL_SIGN_THICKNESS = 0.14
const WALL_SIGN_OFFSET = WALL_THICKNESS / 2 + WALL_SIGN_THICKNESS / 2 + 0.01

function createDistanceSignGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  // A patch of the marker's navy ground, inside its border and clear of the
  // numeral, for every face but the front. The front's U runs the other way
  // from the way a spectator in the field reads the wall (the slab is turned to
  // look back into the field with yaw = PI - mid), so its rect is mirrored —
  // otherwise the number comes out backwards.
  const frame = [0.1, 0.12, 0.2, 0.22]
  addChamferedBox(positions, normals, colors, uvs, {
    cx: 0,
    cy: 0,
    cz: 0,
    sx: WALL_SIGN_WIDTH,
    sy: WALL_SIGN_HEIGHT,
    sz: WALL_SIGN_THICKNESS,
    bevel: 0.05,
    col: new THREE.Color('#ffffff'),
    faceUvs: [[1, 0, 0, 1], frame, frame, frame, frame, frame],
  })

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// A padded collar round each foul pole where it passes the wall's yellow rail:
// a chamfered sleeve of the wall's own padding, so the mast comes up through a
// pad instead of slicing the rail in two. It spans the rail and a little above
// it, which is the only stretch of the mast a spectator at field level sees
// meet anything.
function createFoulPoleCollarGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const col = new THREE.Color('#1c385c')

  addChamferedBox(positions, normals, colors, {
    cx: 0,
    cy: 0,
    cz: 0,
    sx: 0.8,
    sy: 0.86,
    sz: 0.8,
    bevel: 0.08,
    col,
    faceColors: faceShades(col),
  })

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geom
}

// A foot on each foul pole: a chamfered sleeve over the mast where it meets the
// ground, painted the mast's own yellow, so the pole stands on a moulded base
// instead of arriving as a cylinder cut off square at the dirt. It is a little
// wider than the padding it passes through, which is what lets it read from the
// warning track rather than being swallowed by the wall.
function createFoulPoleBaseGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const col = new THREE.Color('#e8c200')

  addChamferedBox(positions, normals, colors, {
    cx: 0,
    cy: 0,
    cz: 0,
    sx: 0.82,
    sy: 0.55,
    sz: 0.82,
    bevel: 0.1,
    col,
    faceColors: faceShades(col),
  })

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geom
}

// The three bases are bags, not slabs. A wide chamfer on a 1.5 ft square of
// canvas 0.09 m thick turns the cuboid into a moulded pillow, so a bag reads as
// something a runner can knock off its moorings rather than as a tiled box.
const BASE_BAG_SIZE = feetToM(1.5)
const BASE_BAG_HEIGHT = 0.09

function createBaseBagGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const col = new THREE.Color('#f5f5f5')

  addChamferedBox(positions, normals, colors, {
    cx: 0,
    cy: 0,
    cz: 0,
    sx: BASE_BAG_SIZE,
    sy: BASE_BAG_HEIGHT,
    sz: BASE_BAG_SIZE,
    // As deep as the bag's thin side allows: the top and bottom shrink to most of
    // the bag, and the chamfer bands become the rolled edges of the canvas.
    bevel: BASE_BAG_HEIGHT * 0.45,
    col,
    faceColors: faceShades(col),
  })

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geom
}

// Helper to add transformed box with yaw and pitch to geometry arrays (supports optional uvs and faceUvs)
function addTransformedBox(positions, normals, colors, maybeUvs, maybeOpts) {
  let uvs = null
  let opts = maybeOpts
  if (maybeOpts === undefined) {
    opts = maybeUvs
  } else {
    uvs = maybeUvs
  }
  const {
    cx, cy, cz, sx, sy, sz, yaw = 0, pitch = 0, col, faceColors, faceUvs,
  } = opts
  const hw = sx / 2, hh = sy / 2, hd = sz / 2
  const corners = [
    [-hw, -hh, -hd], [hw, -hh, -hd], [hw, hh, -hd], [-hw, hh, -hd],
    [-hw, -hh, hd],  [hw, -hh, hd],  [hw, hh, hd],  [-hw, hh, hd],
  ]
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch)
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw)

  const rot = corners.map(([x, y, z]) => {
    // 1. Pitch around local X axis
    const y1 = y * cosP - z * sinP
    const z1 = y * sinP + z * cosP
    const x1 = x
    // 2. Yaw around world Y axis
    return [
      cx + x1 * cosY + z1 * sinY,
      cy + y1,
      cz - x1 * sinY + z1 * cosY,
    ]
  })

  const faces = [
    [0, 1, 2, 3], // 0: front (-Z)
    [5, 4, 7, 6], // 1: back (+Z)
    [4, 0, 3, 7], // 2: left (-X)
    [1, 5, 6, 2], // 3: right (+X)
    [3, 2, 6, 7], // 4: top (+Y)
    [4, 5, 1, 0], // 5: bottom (-Y)
  ]

  faces.forEach(([i0, i1, i2, i3], fIdx) => {
    const p0 = rot[i0], p1 = rot[i1], p2 = rot[i2], p3 = rot[i3]
    positions.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3)
    const c = (faceColors && faceColors[fIdx]) ? faceColors[fIdx] : col
    // Placeholder normals; the callers recompute them from the finished surface.
    for (let k = 0; k < 6; k++) {
      normals.push(0, 1, 0)
      colors.push(c.r, c.g, c.b)
    }
    if (uvs) {
      const [u0, v0, u1, v1] = (faceUvs && faceUvs[fIdx]) ? faceUvs[fIdx] : [0, 0, 1, 1]
      uvs.push(
        u0, v0,
        u1, v0,
        u1, v1,
        u0, v0,
        u1, v1,
        u0, v1,
      )
    }
  })
}

// The round version of addTransformedBox, for structural members. A park of
// square bars reads as scaffolding; everything that is round in life -- the
// roof's fascia, chord, hangers, columns and flag masts, the light towers' legs
// and lattice -- is emitted as a capped cylinder instead, so a member keeps the
// numbers it already had (its three sides, its yaw and pitch) and only loses its
// corners. The longest side becomes the member's length and the thinnest its
// diameter unless the caller says otherwise, so a 5.6 m x 0.25 m tie and a
// 0.3 m x 20 m leg both come out right.
function addRoundMember(positions, normals, colors, maybeUvs, maybeOpts) {
  let uvs = null
  let opts = maybeOpts
  if (maybeOpts === undefined) {
    opts = maybeUvs
  } else {
    uvs = maybeUvs
  }
  const { cx, cy, cz, yaw = 0, pitch = 0, col, segments = 8, uvScale = UV_METRES } = opts
  const sx = opts.sx ?? 0
  const sy = opts.sy ?? 0
  const sz = opts.sz ?? 0

  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  const cosP = Math.cos(pitch)
  const sinP = Math.sin(pitch)

  // The box's own axes, in world space: pitch about local X first, then yaw.
  const axes = [
    { v: [cosY, 0, -sinY], len: sx },
    { v: [sinY * sinP, cosP, cosY * sinP], len: sy },
    { v: [sinY * cosP, -sinP, cosY * cosP], len: sz },
  ]
  let axis = axes[0]
  if (opts.axis) axis = axes[opts.axis === 'y' ? 1 : opts.axis === 'z' ? 2 : 0]
  else for (const a of axes) if (a.len > axis.len) axis = a

  const length = opts.length ?? axis.len
  const thick = Math.min(...axes.filter((a) => a.len > 0).map((a) => a.len))
  const radius = opts.radius ?? thick / 2

  // A pair of axes across the member, and its two ends.
  const a = axis.v
  const seed = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  let u = [
    a[1] * seed[2] - a[2] * seed[1],
    a[2] * seed[0] - a[0] * seed[2],
    a[0] * seed[1] - a[1] * seed[0],
  ]
  const ul = Math.hypot(...u) || 1
  u = u.map((v) => v / ul)
  const w = [
    a[1] * u[2] - a[2] * u[1],
    a[2] * u[0] - a[0] * u[2],
    a[0] * u[1] - a[1] * u[0],
  ]

  const half = length / 2
  const ends = [-1, 1].map((s) => [cx + a[0] * half * s, cy + a[1] * half * s, cz + a[2] * half * s])
  const rim = []
  for (let i = 0; i <= segments; i++) {
    const th = (i / segments) * Math.PI * 2
    const c = Math.cos(th)
    const s = Math.sin(th)
    rim.push({
      d: [u[0] * c + w[0] * s, u[1] * c + w[1] * s, u[2] * c + w[2] * s],
      s,
    })
  }
  const at = (end, r) => [
    end[0] + r.d[0] * radius,
    end[1] + r.d[1] * radius,
    end[2] + r.d[2] * radius,
  ]
  const push = (p, n, uu, vv) => {
    positions.push(...p)
    normals.push(...n)
    colors.push(col.r, col.g, col.b)
    if (uvs) uvs.push(uu, vv)
  }
  const circumference = Math.PI * 2 * radius
  const vLen = length / uvScale

  // The barrel, one quad per segment (UVs run round it, then along it).
  for (let i = 0; i < segments; i++) {
    const r0 = rim[i]
    const r1 = rim[i + 1]
    const p00 = at(ends[0], r0)
    const p01 = at(ends[0], r1)
    const p10 = at(ends[1], r0)
    const p11 = at(ends[1], r1)
    const u0 = (i / segments) * (circumference / uvScale)
    const u1 = ((i + 1) / segments) * (circumference / uvScale)
    push(p00, r0.d, u0, 0)
    push(p11, r1.d, u1, vLen)
    push(p10, r0.d, u0, vLen)
    push(p00, r0.d, u0, 0)
    push(p01, r1.d, u1, 0)
    push(p11, r1.d, u1, vLen)
  }

  // The two caps, wound outward.
  for (const s of [0, 1]) {
    const cap = ends[s]
    const sign = s === 0 ? -1 : 1
    const n = [a[0] * sign, a[1] * sign, a[2] * sign]
    for (let i = 0; i < segments; i++) {
      const r0 = rim[i]
      const r1 = rim[i + 1]
      const u0 = (i / segments) * (circumference / uvScale)
      const u1 = ((i + 1) / segments) * (circumference / uvScale)
      const cu = (u0 + u1) / 2
      const c0 = at(cap, r0)
      const c1 = at(cap, r1)
      push(cap, n, cu, radius / uvScale)
      if (s === 0) {
        push(c1, n, u1, 0)
        push(c0, n, u0, 0)
      } else {
        push(c0, n, u0, 0)
        push(c1, n, u1, 0)
      }
    }
  }
}

// 4 Stadium Light Towers: Tapered Steel Lattice Truss Structure, Catwalk, Ladder & Housings
// Fixed: Behind-batter lights face forward directly toward pitcher & home plate!
function createLightTowersTrussGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []

  // The steel is round. Legs, ties, braces, ladder rungs and the floodlight
  // frame are cylinders with eight sides, so the tower reads as a built
  // structure rather than a scaffold of square bars.
  const bar = (opts) => addRoundMember(positions, normals, colors, {
    segments: 8,
    ...opts,
  })
  // The pods, hoods, deck plates and the transformer are cast boxes rather
  // than bars, so they keep their shape but lose their arrises: a floodlight
  // housing with a chamfer reads as a moulding, not as a white brick.
  const soft = (opts) => addChamferedBox(positions, normals, colors, {
    bevel: 0.05,
    ...opts,
    faceColors: opts.faceColors ?? faceShades(opts.col),
  })

  // The corner towers stand beyond the two roofs' ends, clear of them, so their
  // lattice rises above the roofline instead of through it.
  const TOWERS = [
    { x: -92.0, z: -88.0, tx: -15.0, tz: -25.0, name: 'LF' },
    { x: -28.0, z: 20.0,  tx: 0.0,   tz: -10.0, name: '3B/Plate' },
    { x: 28.0,  z: 20.0,  tx: 0.0,   tz: -10.0, name: '1B/Plate' },
    { x: 92.0,  z: -88.0, tx: 15.0,  tz: -25.0, name: 'RF' },
  ]

  const colSteel = new THREE.Color('#3f5544') // hunter steel green
  const colCatwalk = new THREE.Color('#5a6d5c') // galvanized catwalk steel
  const colHousing = new THREE.Color('#2a352c') // dark floodlight pod casing
  const colYellow = new THREE.Color('#fbc02d') // hazard yellow

  TOWERS.forEach((t) => {
    const dx = t.tx - t.x
    const dz = t.tz - t.z
    // Fixed direction: points directly forward into the field!
    const yaw = Math.atan2(dx, dz)
    const pitch = 0.38 // +22 deg tilt down toward the field

    const towerH = 20.0
    const wBase = 1.6
    const wTop = 0.75
    const legThick = 0.30

    // 1. Four Tapered Corner Columns
    const cornerSigns = [
      [-1, -1], [1, -1], [1, 1], [-1, 1]
    ]
    cornerSigns.forEach(([sx, sz]) => {
      const midW = (wBase + wTop) / 2
      const lx = sx * midW
      const lz = sz * midW
      bar({
        cx: t.x + lx * Math.cos(yaw) + lz * Math.sin(yaw),
        cy: towerH / 2,
        cz: t.z - lx * Math.sin(yaw) + lz * Math.cos(yaw),
        sx: legThick,
        sy: towerH,
        sz: legThick,
        yaw,
        col: colSteel,
      })
    })

    // 2. Horizontal Truss Framing Ties (6 tiers)
    const ties = [3.5, 7.0, 10.5, 14.0, 17.5, towerH]
    ties.forEach((yTier) => {
      const frac = yTier / towerH
      const wTier = (wBase * (1 - frac) + wTop * frac) * 2
      bar({
        cx: t.x, cy: yTier, cz: t.z + (wTier / 2) * Math.cos(yaw),
        sx: wTier, sy: 0.22, sz: 0.22, yaw, col: colSteel
      })
      bar({
        cx: t.x, cy: yTier, cz: t.z - (wTier / 2) * Math.cos(yaw),
        sx: wTier, sy: 0.22, sz: 0.22, yaw, col: colSteel
      })
      bar({
        cx: t.x - (wTier / 2) * Math.sin(yaw), cy: yTier, cz: t.z,
        sx: 0.22, sy: 0.22, sz: wTier, yaw, col: colSteel
      })
      bar({
        cx: t.x + (wTier / 2) * Math.sin(yaw), cy: yTier, cz: t.z,
        sx: 0.22, sy: 0.22, sz: wTier, yaw, col: colSteel
      })
    })

    // 3. Diagonal X-Braces between tiers
    for (let b = 0; b < ties.length - 1; b++) {
      const y1 = ties[b]
      const y2 = ties[b + 1]
      const yMid = (y1 + y2) / 2
      const dy = y2 - y1
      const frac = yMid / towerH
      const wMid = (wBase * (1 - frac) + wTop * frac) * 2
      const len = Math.hypot(wMid, dy)
      const ang = Math.atan2(dy, wMid)

      bar({
        cx: t.x, cy: yMid, cz: t.z + (wMid / 2) * Math.cos(yaw),
        sx: len, sy: 0.14, sz: 0.14, yaw: yaw + ang * 0.15, col: colSteel
      })
      bar({
        cx: t.x, cy: yMid, cz: t.z - (wMid / 2) * Math.cos(yaw),
        sx: len, sy: 0.14, sz: 0.14, yaw: yaw - ang * 0.15, col: colSteel
      })
    }

    // 4. Rear Service Access Ladder
    const numRungs = 24
    for (let r = 0; r < numRungs; r++) {
      const yr = 1.0 + (r / numRungs) * (towerH - 1.0)
      const frac = yr / towerH
      const zRear = -(wBase * (1 - frac) + wTop * frac)
      const rx = t.x - zRear * Math.sin(yaw)
      const rz = t.z + zRear * Math.cos(yaw)
      bar({
        cx: rx, cy: yr, cz: rz, sx: 0.55, sy: 0.08, sz: 0.08, yaw, col: colCatwalk
      })
    }

    // 5. Technician Service Catwalk Platform (at y = 19.8m)
    soft({
      cx: t.x, cy: 19.8, cz: t.z, sx: 3.2, sy: 0.18, sz: 2.4, yaw, col: colCatwalk, bevel: 0.07,
    })
    soft({
      cx: t.x, cy: 20.35, cz: t.z + 1.15 * Math.cos(yaw), sx: 3.2, sy: 0.9, sz: 0.08, yaw, col: colCatwalk, bevel: 0.03,
    })
    soft({
      cx: t.x, cy: 20.35, cz: t.z - 1.15 * Math.cos(yaw), sx: 3.2, sy: 0.9, sz: 0.08, yaw, col: colCatwalk, bevel: 0.03,
    })
    // High-voltage transformer box
    soft({
      cx: t.x - 0.8 * Math.sin(yaw), cy: 20.3, cz: t.z - 0.8 * Math.cos(yaw),
      sx: 0.8, sy: 0.8, sz: 0.6, yaw, col: colSteel, bevel: 0.09,
    })
    soft({
      cx: t.x - 0.8 * Math.sin(yaw), cy: 20.3, cz: t.z - 0.8 * Math.cos(yaw),
      sx: 0.85, sy: 0.15, sz: 0.65, yaw, col: colYellow, bevel: 0.04,
    })

    // 6. Angled Floodlight Head Frame (Pitched down -18° toward field)
    const headY = 21.6
    const headZLocal = 0.45
    const headXWorld = t.x + headZLocal * Math.sin(yaw)
    const headZWorld = t.z + headZLocal * Math.cos(yaw)

    bar({
      cx: headXWorld, cy: headY - 0.8, cz: headZWorld, sx: 5.6, sy: 0.25, sz: 0.25, yaw, pitch, col: colSteel
    })
    bar({
      cx: headXWorld, cy: headY + 0.8, cz: headZWorld, sx: 5.6, sy: 0.25, sz: 0.25, yaw, pitch, col: colSteel
    })
    for (let c = -2; c <= 2; c++) {
      const colOffset = c * 1.1
      const cWorldX = headXWorld + colOffset * Math.cos(yaw)
      const cWorldZ = headZWorld - colOffset * Math.sin(yaw)
      bar({
        cx: cWorldX, cy: headY, cz: cWorldZ, sx: 0.22, sy: 2.6, sz: 0.22, yaw, pitch, col: colSteel
      })
    }

    // 7. Array of 15 Floodlight Pod Housings with Overhanging Visors
    const numCols = 5
    const numRows = 3
    const podW = 0.70
    const podH = 0.65
    const podD = 0.40
    const colSpacing = 1.05
    const rowSpacing = 0.85

    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const lx = (c - (numCols - 1) / 2) * colSpacing
        const ly = (r - (numRows - 1) / 2) * rowSpacing
        const lz = 0.20

        const cosP = Math.cos(pitch), sinP = Math.sin(pitch)
        const py = ly * cosP - lz * sinP
        const pz = ly * sinP + lz * cosP
        const px = lx

        const cosY = Math.cos(yaw), sinY = Math.sin(yaw)
        const wx = headXWorld + px * cosY + pz * sinY
        const wy = headY + py
        const wz = headZWorld - px * sinY + pz * cosY

        soft({
          cx: wx, cy: wy, cz: wz, sx: podW, sy: podH, sz: podD, yaw, pitch, col: colHousing, bevel: 0.07,
        })
        const hoodZ = pz + 0.12
        const hwx = headXWorld + px * cosY + hoodZ * sinY
        const hwy = headY + (ly + podH / 2) * cosP - hoodZ * sinP
        const hwz = headZWorld - px * sinY + hoodZ * cosY
        soft({
          cx: hwx, cy: hwy, cz: hwz, sx: podW + 0.06, sy: 0.08, sz: 0.24, yaw, pitch, col: colSteel, bevel: 0.03,
        })
      }
    }
  })

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  // Every member wrote its own normals -- radial round the tubes, one per
  // chamfer facet -- so they are left alone: recomputing them flat-shades the
  // round steel and the chamfers back into facets.
  return geom
}

// Glowing Halogen Floodlight Bulbs Geometry (15 bulbs per tower = 60 glowing pixel fixtures)
function createLightTowersBulbsGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const uvs = []

  const TOWERS = [
    { x: -92.0, z: -88.0, tx: -15.0, tz: -25.0 },
    { x: -28.0, z: 20.0,  tx: 0.0,   tz: -10.0 },
    { x: 28.0,  z: 20.0,  tx: 0.0,   tz: -10.0 },
    { x: 92.0,  z: -88.0, tx: 15.0,  tz: -25.0 },
  ]

  TOWERS.forEach((t) => {
    const dx = t.tx - t.x
    const dz = t.tz - t.z
    const yaw = Math.atan2(dx, dz)
    const pitch = 0.38 // +22 deg tilt down toward the field

    const headY = 21.6
    const headZLocal = 0.45
    const headXWorld = t.x + headZLocal * Math.sin(yaw)
    const headZWorld = t.z + headZLocal * Math.cos(yaw)

    const numCols = 5
    const numRows = 3
    const bulbW = 0.52
    const bulbH = 0.48
    const colSpacing = 1.05
    const rowSpacing = 0.85
    const lz = 0.42

    const cosP = Math.cos(pitch), sinP = Math.sin(pitch)
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw)

    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const lx = (c - (numCols - 1) / 2) * colSpacing
        const ly = (r - (numRows - 1) / 2) * rowSpacing

        const hw = bulbW / 2
        const hh = bulbH / 2
        const corners = [
          [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]
        ]

        const quadWorld = corners.map(([cx, cy]) => {
          const kx = lx + cx
          const ky = ly + cy
          const y1 = ky * cosP - lz * sinP
          const z1 = ky * sinP + lz * cosP
          const x1 = kx
          return [
            headXWorld + x1 * cosY + z1 * sinY,
            headY + y1,
            headZWorld - x1 * sinY + z1 * cosY,
          ]
        })

        const [p0, p1, p2, p3] = quadWorld
        positions.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3)
        for (let k = 0; k < 6; k++) {
          normals.push(sinY * cosP, -sinP, cosY * cosP)
        }
        uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1)
      }
    }
  })

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// The park's seating grid, in one place. The seat meshes and the crowd both walk
// it, so a fan is always sitting in a seat rather than on a looser grid of its
// own, and the occupancy rule can be written per block on the same numbers.
const INFIELD_SEAT_ROWS = [
  // Lower bowl
  { dSeat: 0.85, yFloor: 0.95 },
  { dSeat: 2.05, yFloor: 1.45 },
  { dSeat: 3.25, yFloor: 1.95 },
  { dSeat: 4.45, yFloor: 2.45 },
  { dSeat: 5.65, yFloor: 2.95 },
  { dSeat: 6.85, yFloor: 3.45 },
  // Upper deck
  { dSeat: 9.45, yFloor: 4.55 },
  { dSeat: 10.45, yFloor: 5.15 },
  { dSeat: 11.45, yFloor: 5.75 },
  { dSeat: 12.45, yFloor: 6.35 },
]
// 246 seats over the spline's 221.8 m of row: 0.90 m of row per seat, the same
// pitch as the bleachers and the terrace.
const INFIELD_SEATS_PER_ROW = 246
// A two-seat aisle every fourteen seats.
const INFIELD_AISLE = (s) => s % 14 >= 12
const infieldSeatT = (s) => 0.015 + (0.97 * s) / INFIELD_SEATS_PER_ROW

// The bleachers' seating, row by row.
//
// The rows do not have one count between them any more. A row runs from the
// section wall at one corner, round the outfield, to the wall at the other: the
// back row is longer than the front one because its own radius is, though the
// two run through the same angle. Counting them all as 174 slots stretched the
// back rows' seats a third of a metre further apart than the front rows' and
// left the corner looking combed out, so each row is laid out at the same 0.92 m
// of arc per seat and carries as many seats as its own length holds. The
// walkways stay on fixed angles -- an aisle is a flight of stairs and a rail
// from the wall to the back, and a flight that drifted with the seat count would
// not be a flight -- so every row is cut into blocks by the same aisle angles
// and packed between them.
const BLEACHER_SEATS = {
  tiers: 7,
  // Metres of arc per seat, the same on every row.
  pitch: 0.92,
  rStart: feetToM(332.0),
  tierDepth: 1.35,
  tierHeight: 0.52,
  baseHeight: 2.45,
  // The cushion sits this far in front of the tier's back edge.
  seatInset: 0.4,
  // Clear concrete between a seat and the aisle paving (the corner's own
  // clearance to its wall is CORNER_WALL.clear).
  aisleClear: 0.34,
  // The ring's old slot grid, kept as angles: twelve slots to a bay, two of them
  // paved, 174 of them round the ring. The walkways have not moved.
  refPerRow: 174,
  refFrom: (-Math.PI / 4) * 0.95,
  refTo: (Math.PI / 4) * 0.95,
  baySlots: 12,
}

// The walkways' own lines: one per bay, at the centre of its paved slots. A seat
// keeps `aisleClear` clear of each edge of the paint.
const BLEACHER_AISLES = (() => {
  const { refPerRow, refFrom, baySlots } = BLEACHER_SEATS
  const step = (BLEACHER_SEATS.refTo - refFrom) / refPerRow
  const paved = (s) => s % baySlots >= baySlots - 2
  const aisles = []
  for (let s = 0; s < refPerRow; s++) {
    if (!paved(s)) continue
    let e = s
    while (e + 1 < refPerRow && paved(e + 1)) e++
    aisles.push({ ang: refFrom + step * ((s + e) / 2), half: step * 0.85 })
    s = e
  }
  return aisles
})()

// The rows themselves. Each is a list of slots in seat order -- a seat's angle,
// or a walkway's two empty slots, so a crowd show's window can still be snapped
// to one side of the cut (util/seatWindow). Seats are packed into the blocks
// between the aisles at the row's pitch, centred in each block, so no cushion
// reaches the paving at one end or the section wall at the other.
const BLEACHER_ROWS = (() => {
  const {
    tiers, pitch, rStart, tierDepth, tierHeight, baseHeight,
    seatInset, aisleClear,
  } = BLEACHER_SEATS
  const rows = []
  for (let t = 0; t < tiers; t++) {
    const r = rStart + t * tierDepth + tierDepth - seatInset
    const y = baseHeight + t * tierHeight
    // Round to the corner wall at either end, clear of it: the row runs on past
    // the foul line to the corner's section line (CORNER_WALL.angle), and stops
    // a cushion's width short of the brick.
    const end = cornerSeatEnd() - CORNER_WALL.clear / r
    const from = -end
    const to = end

    const cuts = []
    for (const aisle of BLEACHER_AISLES) {
      const lo = aisle.ang - aisle.half - aisleClear / r
      const hi = aisle.ang + aisle.half + aisleClear / r
      if (lo <= from || hi >= to) continue
      cuts.push([lo, hi])
    }

    const angles = []
    const isAisle = []
    let cursor = from
    for (let b = 0; b <= cuts.length; b++) {
      const hi = b < cuts.length ? cuts[b][0] : to
      const width = hi - cursor
      const count = Math.max(0, Math.floor((width * r) / pitch + 1e-6))
      // The seats sit at the pitch with the block's leftover split between its
      // two ends, rather than one wide gap beside the walkway.
      const step = pitch / r
      const lead = (width - (count - 1) * step) / 2
      for (let i = 0; i < count; i++) {
        angles.push(cursor + lead + i * step)
        isAisle.push(false)
      }
      if (b < cuts.length) {
        angles.push(cuts[b][0], cuts[b][1])
        isAisle.push(true, true)
        cursor = cuts[b][1]
      }
    }

    // The batter's eye's bay carries no seats: the screen closes the middle of
    // the bleachers, and the rows behind it are the blank deck it leaves. The
    // slots stay in the row's own grid, so the seats either side keep their
    // places and a show's window still snaps where it always did; they are
    // simply not seats.
    const blank = angles.map(
      (ang, s) => !isAisle[s] && Math.abs(ang) <= BATTERS_EYE_BAY_HALF + 1e-9,
    )
    rows.push({ tier: t, r, y, from, to, angles, isAisle, blank, slots: angles.length })
  }
  return rows
})()

function bleacherSeatAt(tier, s) {
  const row = BLEACHER_ROWS[tier]
  return { r: row.r, y: row.y, ang: row.angles[s] }
}

// The seat grids a crowd show's window can be snapped to, by block: the same
// per-row count and aisle rule the seat meshes and the crowd walk. The
// bleachers are asked per row, since each row has its own length now.
const SHOW_SEAT_GRIDS = {
  A: (row) => {
    const seats = BLEACHER_ROWS[row]
    // The batter's eye's bay is a gap in the row as far as a show is
    // concerned: a window aimed at it is snapped to the seats on one side of it
    // rather than split across the blank deck.
    return { perRow: seats.slots, aisle: (s) => seats.isAisle[s] || seats.blank[s] }
  },
  B: { perRow: INFIELD_SEATS_PER_ROW, aisle: INFIELD_AISLE },
}

// The crowd's little shows: contiguous runs of neighbours that periodically
// shout together (voice-projection marks + a long pixelated banner held between
// them) or play pixelated instruments (musical notes rise over their heads
// while they play). Each cluster is a seat window in one seating row. The
// window is a wish rather than a fixed count of seats -- "about these seats,
// this wide" -- and is snapped here, once, to the nearest run of seats between
// two aisles (util/seatWindow), so a cluster's neighbours are neighbours on the
// concrete and the banner is never held across a walkway. Both the crowd fill
// (which keeps these seats full) and the show itself read the same window.
const SHOWS = [
  // The seat numbers are the same places on the ring and the spline as they
  // always were: each wish was scaled with its row when the grid was made
  // (156 -> 174 slots round the ring, 220 -> 246 along the bowl) rather than
  // being left to drift round the park, and each is snapped to one block of the
  // row it names.
  { id: 'shout-cf-left', role: 'shout', banner: "LET'S GO!", block: 'A', row: 2, from: 58, to: 68 },
  // These wishes land out beyond the ±11 m of bowl the big screen overhangs --
  // the banner and marks are never drawn behind the board.
  { id: 'shout-cf-right', role: 'shout', banner: 'GO GO GO!', block: 'A', row: 5, from: 145, to: 155 },
  { id: 'shout-infield', role: 'shout', banner: 'CHEER LOUD!', block: 'B', row: 4, from: 49, to: 59 },
  { id: 'music-outfield', role: 'music', block: 'A', row: 3, from: 39, to: 49 },
  { id: 'music-infield', role: 'music', block: 'B', row: 8, from: 20, to: 29 },
].map((show) => {
  const grid = SHOW_SEAT_GRIDS[show.block]
  if (!grid) return show
  const taken = snapSeatWindow(
    typeof grid === 'function' ? grid(show.row) : grid, show.from, show.to,
  )
  return { ...show, from: taken.from, to: taken.to }
})

/** The show whose window covers this seat, or null. */
function showAt(block, row, seat) {
  for (const show of SHOWS) {
    if (show.block === block && show.row === row && seat >= show.from && seat < show.to) {
      return show
    }
  }
  return null
}

// The walkways between the seat blocks.
//
// An aisle is a gap in the rows, and an unpaved gap is not a walkway: with
// nothing in it, the two-slot cuts between blocks read from the field as black
// shafts punched through the stands -- as if the park had run out of seats
// rather than held them back for people to climb past. So each aisle is paved as
// the flight of stairs it is: one tread and one riser per deck step, taken from
// INFIELD_TIERS in the bowl and from the bleacher ring's own tiers, with a lit
// nosing along every step edge and the same baked shading the terracing has.
const AISLE_TREAD = new THREE.Color('#5c6a5d')
const AISLE_NOSE = new THREE.Color('#8a9783')
const AISLE_RISER = new THREE.Color('#3b4a41')
// A skin over the deck, not a second deck: the paving floats a centimetre above
// the concrete it covers, so the two never fight for the same depth.
const AISLE_LIFT = 0.012
// How much clear walkway is kept off the nearest seat, in seat pitches: 0.65 of
// a pitch is 0.34 m past the cushion's edge, so no cushion clips the paint.
const AISLE_CLEAR = 0.65
const AISLE_NOSING_W = 0.10

/** The cuts themselves, rather than the seats between them: [start, end) each. */
function aisleSpans(perRow, aisle) {
  const spans = []
  for (let s = 0; s < perRow; s++) {
    if (!aisle(s)) continue
    const start = s
    while (s + 1 < perRow && aisle(s + 1)) s++
    spans.push([start, s + 1])
  }
  return spans
}

function createAisleTreadsGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const treadNose = AISLE_TREAD.clone().multiplyScalar(1.14)
  const treadFoot = AISLE_TREAD.clone().multiplyScalar(0.84)
  const riserFoot = AISLE_RISER.clone().multiplyScalar(0.80)

  // One quad, wound to face `want` however its corners arrive, and mapped off
  // its own world position as the bleacher ring is: one tile per 1.2 m of arc
  // and of rise, so the walkway wears the same concrete as the bowl.
  const quad = (corners, cols, want) => {
    let [a, b, c, d] = corners
    let [ca, cb, cc, cd] = cols
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const nx = ab[1] * ac[2] - ab[2] * ac[1]
    const ny = ab[2] * ac[0] - ab[0] * ac[2]
    const nz = ab[0] * ac[1] - ab[1] * ac[0]
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
      const swapP = b
      b = d
      d = swapP
      const swapC = cb
      cb = cd
      cd = swapC
    }
    for (const [p, col] of [[a, ca], [b, cb], [c, cc], [a, ca], [c, cc], [d, cd]]) {
      positions.push(p[0], p[1], p[2])
      normals.push(want[0], want[1], want[2])
      colors.push(col.r, col.g, col.b)
      const r = Math.hypot(p[0], p[2])
      uvs.push((Math.atan2(p[0], -p[2]) * r) / 1.2, (r + p[1]) / 1.2)
    }
  }

  // The bowl: each aisle is one flight from the field wall to the rear facade,
  // stepping exactly where INFIELD_TIERS steps.
  const curve = INFIELD_STANDS_CURVE
  for (const [a, b] of aisleSpans(INFIELD_SEATS_PER_ROW, INFIELD_AISLE)) {
    const tA = infieldSeatT(a - 1 + AISLE_CLEAR)
    const tB = infieldSeatT(b - AISLE_CLEAR)
    const pA = curve.getPoint(tA)
    const pB = curve.getPoint(tB)
    const tanA = curve.getTangent(tA).normalize()
    const tanB = curve.getTangent(tB).normalize()
    const nA = [-tanA.z, 0, tanA.x]
    const nB = [-tanB.z, 0, tanB.x]
    const at = (p, n, d, y) => [p.x + d * n[0], y, p.z + d * n[2]]

    for (let r = 0; r < INFIELD_TIERS.length - 1; r++) {
      const lo = INFIELD_TIERS[r]
      const hi = INFIELD_TIERS[r + 1]
      if (Math.abs(lo.y - hi.y) < 1e-6) {
        const y = lo.y + AISLE_LIFT
        // The tread: lit along its field-side arris, shading into the foot of
        // the riser behind it.
        quad(
          [
            at(pA, nA, lo.d, y), at(pB, nB, lo.d, y),
            at(pB, nB, hi.d, y), at(pA, nA, hi.d, y),
          ],
          [treadNose, treadNose, treadFoot, treadFoot],
          [0, 1, 0],
        )
        // ... and the painted nosing band along that arris.
        const noseFront = lo.d + 0.02
        const noseBack = lo.d + AISLE_NOSING_W
        const noseY = y + 0.004
        quad(
          [
            at(pA, nA, noseFront, noseY), at(pB, nB, noseFront, noseY),
            at(pB, nB, noseBack, noseY), at(pA, nA, noseBack, noseY),
          ],
          [AISLE_NOSE, AISLE_NOSE, AISLE_NOSE, AISLE_NOSE],
          [0, 1, 0],
        )
      } else if (lo.d > 1e-6 && lo.d < INFIELD_STANDS_DEPTH - 1e-6) {
        // The riser that lifts onto the next tread. The front wall and the rear
        // facade are walls rather than steps, and keep their own tone.
        const d = lo.d - 0.004
        const nMid = [(nA[0] + nB[0]) / 2, 0, (nA[2] + nB[2]) / 2]
        quad(
          [
            at(pA, nA, d, lo.y + AISLE_LIFT), at(pB, nB, d, lo.y + AISLE_LIFT),
            at(pB, nB, d, hi.y + AISLE_LIFT), at(pA, nA, d, hi.y + AISLE_LIFT),
          ],
          [riserFoot, riserFoot, AISLE_RISER, AISLE_RISER],
          nMid,
        )
      }
    }
  }

  // The bleachers: each aisle is one flight up the ring's seven tiers, on the
  // walkway's own line -- the line every row is cut on, so the flight stays a
  // flight however the rows' lengths change.
  const atRing = (angle, r, y) => [r * Math.sin(angle), y, -r * Math.cos(angle)]
  for (const aisle of BLEACHER_AISLES) {
    const angA = aisle.ang - aisle.half
    const angB = aisle.ang + aisle.half
    const nA = [-Math.sin(angA), 0, Math.cos(angA)]
    const nB = [-Math.sin(angB), 0, Math.cos(angB)]
    const nMid = [(nA[0] + nB[0]) / 2, 0, (nA[2] + nB[2]) / 2]

    for (let t = 0; t < BLEACHER_SEATS.tiers; t++) {
      const r0 = BLEACHER_SEATS.rStart + t * BLEACHER_SEATS.tierDepth
      const r1 = r0 + BLEACHER_SEATS.tierDepth
      const y = BLEACHER_SEATS.baseHeight + t * BLEACHER_SEATS.tierHeight
      const yTop = y + BLEACHER_SEATS.tierHeight
      const treadY = y + AISLE_LIFT

      quad(
        [
          atRing(angA, r0, treadY), atRing(angB, r0, treadY),
          atRing(angB, r1, treadY), atRing(angA, r1, treadY),
        ],
        [treadNose, treadNose, treadFoot, treadFoot],
        [0, 1, 0],
      )
      quad(
        [
          atRing(angA, r0 + 0.02, treadY + 0.004), atRing(angB, r0 + 0.02, treadY + 0.004),
          atRing(angB, r0 + AISLE_NOSING_W, treadY + 0.004), atRing(angA, r0 + AISLE_NOSING_W, treadY + 0.004),
        ],
        [AISLE_NOSE, AISLE_NOSE, AISLE_NOSE, AISLE_NOSE],
        [0, 1, 0],
      )
      // The riser is at the back of a bleacher tread: the ring steps up
      // outward, behind the row in front. It sits a hair inside the deck's own
      // riser so it is the face you see.
      quad(
        [
          atRing(angA, r1 - 0.004, treadY), atRing(angB, r1 - 0.004, treadY),
          atRing(angB, r1 - 0.004, yTop + AISLE_LIFT), atRing(angA, r1 - 0.004, yTop + AISLE_LIFT),
        ],
        [riserFoot, riserFoot, AISLE_RISER, AISLE_RISER],
        nMid,
      )
    }
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// The handrail down each paved aisle.
//
// The paving makes the walkways, but the rail is what makes them read at a
// glance: one rail per aisle, down the middle of the flight and following the
// nosings at hand height, on posts planted on the treads. It is drawn in the
// wall rail's safety yellow, so the park's walkways are marked in the same
// colour as its boundaries, and it leans with the steps rather than stepping
// with them, so the eye reads the rake of the flight straight away.
const AISLE_RAIL_HEIGHT = 0.95
const AISLE_RAIL_R = 0.035
const AISLE_POST_R = 0.032
// The rail stands a hand's width back from the nosing, so it never overhangs
// the step it belongs to.
const AISLE_RAIL_INSET = 0.10
const AISLE_RAIL_COL = new THREE.Color('#fbc02d')
// The posts are painted with the rail rather than left dark: against the dark
// deck a dark post disappears and the rail reads as a floating wire.
const AISLE_POST_COL = new THREE.Color('#d9a91f')

function createAisleHandrailsGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []

  // A round member between two world points. addRoundMember's local +z tips
  // down as the pitch grows, so a rise takes the negative.
  const member = (a, b, radius, col) => {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = b[2] - a[2]
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-6) return
    addRoundMember(positions, normals, colors, {
      cx: (a[0] + b[0]) / 2,
      cy: (a[1] + b[1]) / 2,
      cz: (a[2] + b[2]) / 2,
      sx: radius * 2,
      sy: radius * 2,
      sz: len,
      axis: 'z',
      yaw: Math.atan2(dx, dz),
      pitch: -Math.atan2(dy, Math.hypot(dx, dz)),
      radius,
      length: len,
      col,
      segments: 6,
    })
  }

  // One flight: the rail through every tread's nosing plus the top tread's back
  // edge (so it finishes level), and a post on every second nosing and at the
  // top. `at(d, y)` is the aisle's own centre line in world space.
  const flight = (at, line, treads) => {
    const rail = line.map(([d, y]) => at(d + AISLE_RAIL_INSET, y + AISLE_RAIL_HEIGHT))
    for (let i = 1; i < rail.length; i++) {
      member(rail[i - 1], rail[i], AISLE_RAIL_R, AISLE_RAIL_COL)
    }
    treads.forEach(([d, y], i) => {
      if (i % 2 === 1 && i !== treads.length - 1) return
      member(
        at(d + AISLE_RAIL_INSET, y + AISLE_LIFT),
        at(d + AISLE_RAIL_INSET, y + AISLE_RAIL_HEIGHT),
        AISLE_POST_R,
        AISLE_POST_COL,
      )
    })
  }

  // The bowl's flights, up the INFIELD_TIERS nosings.
  const curve = INFIELD_STANDS_CURVE
  for (const [a, b] of aisleSpans(INFIELD_SEATS_PER_ROW, INFIELD_AISLE)) {
    const tMid = (infieldSeatT(a - 1 + AISLE_CLEAR) + infieldSeatT(b - AISLE_CLEAR)) / 2
    const p = curve.getPoint(tMid)
    const tan = curve.getTangent(tMid).normalize()
    const n = [-tan.z, 0, tan.x]
    const at = (d, y) => [p.x + d * n[0], y, p.z + d * n[2]]

    const treads = []
    let top = null
    for (let r = 0; r < INFIELD_TIERS.length - 1; r++) {
      const lo = INFIELD_TIERS[r]
      const hi = INFIELD_TIERS[r + 1]
      if (Math.abs(lo.y - hi.y) > 1e-6) continue
      treads.push([lo.d, lo.y])
      top = [hi.d, hi.y]
    }
    flight(at, [...treads, top], treads)
  }

  // The bleachers' flights, up the ring's tiers.
  for (const aisle of BLEACHER_AISLES) {
    const ang = aisle.ang
    const at = (r, y) => [r * Math.sin(ang), y, -r * Math.cos(ang)]

    const treads = []
    let top = null
    for (let t = 0; t < BLEACHER_SEATS.tiers; t++) {
      const r0 = BLEACHER_SEATS.rStart + t * BLEACHER_SEATS.tierDepth
      const y = BLEACHER_SEATS.baseHeight + t * BLEACHER_SEATS.tierHeight
      treads.push([r0, y])
      top = [r0 + BLEACHER_SEATS.tierDepth, y]
    }
    flight(at, [...treads, top], treads)
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geom
}


// Simplistic 8-bit Ballpark Stadium Seats (Seat Base + Upright Backrest):
// Clean voxel seating featuring simplistic pixelated shades, gradients, and 8-bit checkerboard dithering.
// No numbers, no fake slats, no rivets, no pictorial textures — pure minimalist 8-bit aesthetic.
function createStandsSeatsGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  // Directional voxel face shading multipliers (faces: [0:front, 1:back, 2:left, 3:right, 4:top, 5:bottom])
  // Variant A: Crisp daylight clarity
  const faceColorsA = [
    new THREE.Color('#f0f4f0'), // 0: Front face (daylight)
    new THREE.Color('#94a096'), // 1: Back face (shadow)
    new THREE.Color('#b4beb6'), // 2: Left face (side shade)
    new THREE.Color('#b8c2ba'), // 3: Right face (side shade)
    new THREE.Color('#ffffff'), // 4: Top face (sunlit highlight)
    new THREE.Color('#748076'), // 5: Bottom face (occlusion)
  ]

  // Variant B: Subtle complementary section shading
  const faceColorsB = [
    new THREE.Color('#e4eee4'), // 0: Front face
    new THREE.Color('#88948a'), // 1: Back face
    new THREE.Color('#a8b2aa'), // 2: Left face
    new THREE.Color('#acb6ae'), // 3: Right face
    new THREE.Color('#f4f8f4'), // 4: Top face
    new THREE.Color('#6c786e'), // 5: Bottom face
  ]

  // 1. Infield Grandstands Seats (10 Rows: 6 Lower Bowl + 4 Upper Deck), on the
  // shared grid the crowd sits on too.
  const curve = INFIELD_STANDS_CURVE

  INFIELD_SEAT_ROWS.forEach((row) => {
    const { dSeat, yFloor } = row

    for (let s = 0; s < INFIELD_SEATS_PER_ROW; s++) {
      if (INFIELD_AISLE(s)) continue

      const t = infieldSeatT(s)
      const p = curve.getPoint(t)
      const tan = curve.getTangent(t).normalize()
      // Inward normal pointing into playing field
      const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize()
      const yaw = Math.atan2(n.x, n.z)

      const isEven = s % 2 === 0
      const u0 = isEven ? 0.0 : 0.5
      const u1 = u0 + 0.5
      const faceColors = isEven ? faceColorsA : faceColorsB

      // (A) Clean Chunky Voxel Seat Base (Cushion)
      const cx = p.x + dSeat * n.x
      const cz = p.z + dSeat * n.z
      const cy = yFloor + 0.08
      const cushionUvs = [
        [u0, 0.75, u1, 1.00],          // 0: Front face (highlight edge)
        [u0, 0.00, u1, 0.25],          // 1: Back face (shadow crease)
        [u0, 0.00, u0 + 0.15, 1.00],   // 2: Left face (side edge)
        [u1 - 0.15, 0.00, u1, 1.00],   // 3: Right face (side edge)
        [u0, 0.00, u1, 1.00],          // 4: Top cushion face (simplistic pixelated dithered gradient)
        [u0, 0.00, u1, 0.25],          // 5: Bottom face
      ]
      // The cushion is a moulded pad, not a brick: its edges are chamfered so
      // the seat rolls away in silhouette instead of meeting at a crease.
      addChamferedBox(positions, normals, colors, uvs, {
        cx, cy, cz,
        sx: 0.46, sy: 0.16, sz: 0.38,
        yaw,
        bevel: 0.045,
        col: faceColors[4],
        faceColors,
        faceUvs: cushionUvs,
      })

      // (B) Chunky Voxel Seat Back (Backrest)
      const bx = p.x + (dSeat + 0.14) * n.x
      const bz = p.z + (dSeat + 0.14) * n.z
      const by = yFloor + 0.31
      const backrestUvs = [
        [u0, 0.00, u1, 1.00],          // 0: Front face (simplistic vertical pixelated gradient with 8-bit dithering)
        [u0, 0.00, u1, 1.00],          // 1: Back face
        [u0, 0.00, u0 + 0.15, 1.00],   // 2: Left face
        [u1 - 0.15, 0.00, u1, 1.00],   // 3: Right face
        [u0, 0.85, u1, 1.00],          // 4: Top highlight rim
        [u0, 0.00, u1, 0.25],          // 5: Bottom base shadow
      ]
      // ... and the backrest's rolled top comes from the same bevel.
      addChamferedBox(positions, normals, colors, uvs, {
        cx: bx, cy: by, cz: bz,
        sx: 0.46, sy: 0.34, sz: 0.12,
        yaw,
        bevel: 0.035,
        col: faceColors[4],
        faceColors,
        faceUvs: backrestUvs,
      })
    }
  })

  // 2. Outfield Bleachers Seats (7 Radial Tiers from LF to RF, carried round
  // into the corners to the grandstand's end walls), on the same row grid as
  // the crowd below.
  for (const row of BLEACHER_ROWS) {
    const { r: rSeat, y: yFloor } = row

    for (let s = 0; s < row.slots; s++) {
      if (row.isAisle[s] || row.blank[s]) continue

      const ang = row.angles[s]
      const sinA = Math.sin(ang)
      const cosA = Math.cos(ang)
      const yaw = -ang // Faces home plate

      const isEven = s % 2 === 0
      const u0 = isEven ? 0.0 : 0.5
      const u1 = u0 + 0.5
      const faceColors = isEven ? faceColorsA : faceColorsB

      // (A) Bleacher Chunky Voxel Seat Base (Cushion)
      const cx = rSeat * sinA
      const cz = -rSeat * cosA
      const cy = yFloor + 0.08
      const cushionUvs = [
        [u0, 0.75, u1, 1.00],
        [u0, 0.00, u1, 0.25],
        [u0, 0.00, u0 + 0.15, 1.00],
        [u1 - 0.15, 0.00, u1, 1.00],
        [u0, 0.00, u1, 1.00],
        [u0, 0.00, u1, 0.25],
      ]
      addChamferedBox(positions, normals, colors, uvs, {
        cx, cy, cz,
        sx: 0.48, sy: 0.16, sz: 0.38,
        yaw,
        bevel: 0.045,
        col: faceColors[4],
        faceColors,
        faceUvs: cushionUvs,
      })

      // (B) Bleacher Chunky Voxel Seat Back (Backrest)
      const bx = (rSeat + 0.14) * sinA
      const bz = -(rSeat + 0.14) * cosA
      const by = yFloor + 0.31
      const backrestUvs = [
        [u0, 0.00, u1, 1.00],
        [u0, 0.00, u1, 1.00],
        [u0, 0.00, u0 + 0.15, 1.00],
        [u1 - 0.15, 0.00, u1, 1.00],
        [u0, 0.85, u1, 1.00],
        [u0, 0.00, u1, 0.25],
      ]
      addChamferedBox(positions, normals, colors, uvs, {
        cx: bx, cy: by, cz: bz,
        sx: 0.48, sy: 0.34, sz: 0.12,
        yaw,
        bevel: 0.035,
        col: faceColors[4],
        faceColors,
        faceUvs: backrestUvs,
      })
    }
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  // Every seat wrote its own face and chamfer normals as it was emitted, so
  // they are left alone here: recomputing them would smooth across the cushion
  // and flatten the chamfers back into hard-edged boxes.
  return geom
}

// Stadium Steel Safety Railings (Front Wall Rail, Concourse Rail & Upper Deck Rail)
function createSafetyRailingsGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []

  const curve = INFIELD_STANDS_CURVE
  const numSteps = 70
  const colRail = new THREE.Color('#4a5e50')
  const colYellow = new THREE.Color('#fbc02d')

  for (let i = 0; i < numSteps; i++) {
    const t1 = i / numSteps
    const t2 = (i + 1) / numSteps
    const p1 = curve.getPoint(t1)
    const p2 = curve.getPoint(t2)
    const tan1 = curve.getTangent(t1).normalize()
    const n1 = new THREE.Vector3(-tan1.z, 0, tan1.x).normalize()

    // 1. Front barrier wall top rail (y = 1.18m at d = 0.05m)
    const f1x = p1.x + 0.05 * n1.x
    const f1z = p1.z + 0.05 * n1.z
    const f2x = p2.x + 0.05 * n1.x
    const f2z = p2.z + 0.05 * n1.z
    const fLen = Math.hypot(f2x - f1x, f2z - f1z)
    const fMidX = (f1x + f2x) / 2
    const fMidZ = (f1z + f2z) / 2
    const fYaw = Math.atan2(f2x - f1x, f2z - f1z)

    addRoundMember(positions, normals, colors, {
      cx: fMidX, cy: 1.18, cz: fMidZ, sx: 0.06, sy: 0.06, sz: fLen * 1.02, yaw: fYaw, col: colYellow
    })

    if (i % 3 === 0) {
      addRoundMember(positions, normals, colors, {
        cx: f1x, cy: 1.05, cz: f1z, sx: 0.06, sy: 0.30, sz: 0.06, yaw: fYaw, col: colRail
      })
    }

    // 2. Concourse safety handrail (y = 4.30m at d = 8.75m)
    const c1x = p1.x + 8.75 * n1.x
    const c1z = p1.z + 8.75 * n1.z
    const c2x = p2.x + 8.75 * n1.x
    const c2z = p2.z + 8.75 * n1.z
    const cLen = Math.hypot(c2x - c1x, c2z - c1z)
    const cMidX = (c1x + c2x) / 2
    const cMidZ = (c1z + c2z) / 2
    const cYaw = Math.atan2(c2x - c1x, c2z - c1z)

    addRoundMember(positions, normals, colors, {
      cx: cMidX, cy: 4.32, cz: cMidZ, sx: 0.06, sy: 0.06, sz: cLen * 1.02, yaw: cYaw, col: colRail
    })
    addRoundMember(positions, normals, colors, {
      cx: cMidX, cy: 4.62, cz: cMidZ, sx: 0.06, sy: 0.06, sz: cLen * 1.02, yaw: cYaw, col: colRail
    })
    if (i % 3 === 0) {
      addRoundMember(positions, normals, colors, {
        cx: c1x, cy: 4.30, cz: c1z, sx: 0.06, sy: 0.70, sz: 0.06, yaw: cYaw, col: colRail
      })
    }
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.computeVertexNormals()
  return geom
}

// Concourse Upper-Deck Fascia LED Ribbon Board (Continuous curve along the upper-deck riser)
function createFasciaRibbonGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const uvs = []
  const indices = []

  const curve = INFIELD_STANDS_CURVE
  const numSteps = 80
  const d = 8.80
  const yBottom = 3.95
  const yTop = 4.55

  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps
    const p = curve.getPoint(t)
    const tan = curve.getTangent(t).normalize()
    const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize()

    // Stand off 0.04m from the riser surface to prevent Z-fighting
    const x = p.x + (d - 0.04) * n.x
    const z = p.z + (d - 0.04) * n.z

    positions.push(x, yBottom, z)
    positions.push(x, yTop, z)

    // Facing inward toward field (-n.x, 0, -n.z)
    normals.push(-n.x, 0, -n.z)
    normals.push(-n.x, 0, -n.z)

    const u = (i / numSteps) * 8.0
    uvs.push(u, 0)
    uvs.push(u, 1)
  }

  for (let i = 0; i < numSteps; i++) {
    const a = i * 2
    const b = a + 1
    const c = a + 2
    const dIdx = a + 3
    indices.push(a, c, b)
    indices.push(b, c, dIdx)
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geom.setIndex(indices)
  return geom
}


// ---------------------------------------------------------------------------
// The stadium itself, above and around the bowl: the canopy that runs right
// round it, the press box under it, and the flags along the ridges. Without
// them the park read as a horseshoe of open bleachers with a scoreboard parked
// in the air over centre field.
// ---------------------------------------------------------------------------

// The canopy's own numbers, in the infield spline's parameter (0 at the
// left-field pole, 1 at the right-field one) and the stands' outward normal.
// It runs the whole bowl now -- down both lines to the foul poles -- and the
// outfield bleachers get the same profile cut round their own ring (see
// BLEACHER_ROOF), so the two stands share one roofline and one profile; the
// roofs stop at their own poles and leave the corner between them open.
const ROOF = {
  from: 0.02,
  to: 0.98,
  frontD: 8.0,
  backD: 14.5,
  frontY: 9.4,
  backY: 11.2,
  thickness: 0.34,
  segments: 40,
  columnD: 13.7,
  columnEvery: 4,
  // The top of the stands' rear facade, which the roof closes onto.
  facadeTop: 7.6,
}

// The outfield bleachers' canopy, in the same profile: the same heights as the
// grandstand's roof (a continuous roofline right round the park), carried on
// their own shallower ring. The front edge sits over the top three rows, the
// back edge cantilevers past the rear facade exactly as it does behind the
// plate.
const BLEACHER_ROOF = {
  frontD: 6.4,
  backD: 11.2,
  columnD: 10.4,
  segments: 44,
  columnEvery: 4,
}

// The two roof rings as plain samplers: the grandstand's walks the infield
// spline, the bleachers' walks their own circular ring. Both answer a point on
// the top of the stands and its outward normal, which is all either roof needs.
function infieldCanopySample(t) {
  const p = INFIELD_STANDS_CURVE.getPoint(t)
  const tan = INFIELD_STANDS_CURVE.getTangent(t).normalize()
  return { x: p.x, z: p.z, nx: -tan.z, nz: tan.x }
}

function bleacherCanopySample(t) {
  const { startAngle, endAngle, frontR } = OUTFIELD_BLEACHERS
  const a = startAngle + (endAngle - startAngle) * t
  return {
    x: frontR * Math.sin(a),
    z: -frontR * Math.cos(a),
    nx: Math.sin(a),
    nz: -Math.cos(a),
  }
}

// How crowded the bowl is, everywhere, in fans per square metre of seat deck.
//
// A share of each block's seats is not a density. The two blocks cut a square
// metre of deck differently -- the grandstand's rows stand 1.12 m apart, the
// bleachers' tiers 1.35 m -- so filling both to one share of seats (which is how
// this used to be set, per running metre of row) put a different crowd on every
// square metre and read as a packed block beside a half-empty one.
//
// One target fixes it: every block is filled to the crowd a full grandstand
// carries, which lands the long rows on the 0.97 cap and the bleachers a point
// under it on their deeper tiers.
const CROWD_FILL_CAP = 0.97

// A block's seat pitch, in metres of row per seat. The bleachers' is one number
// now, not a ring's average: every row is laid out at it.
const BLEACHER_SEAT_PITCH = BLEACHER_SEATS.pitch
const INFIELD_SEAT_PITCH =
  (INFIELD_STANDS_CURVE.getLength() * 0.97) / INFIELD_SEATS_PER_ROW

// The deck behind one row, which with the pitch is what a square metre of a
// block is made of: the bleachers' tier step and the grandstand's mix of six
// lower rows on 1.2 m and four upper ones on 1.0 m.
const BLEACHER_ROW_DEPTH = BLEACHER_SEATS.tierDepth
const INFIELD_ROW_DEPTH = (6 * 1.2 + 4 * 1.0) / INFIELD_SEAT_ROWS.length

const CROWD_FANS_PER_SQM =
  CROWD_FILL_CAP / (INFIELD_SEAT_PITCH * INFIELD_ROW_DEPTH)

// The share of each block's seats with somebody in them: the crowd one square
// metre of its own deck carries, times how much deck a seat there has.
const seatShare = (pitch, depth) =>
  Math.min(CROWD_FILL_CAP, CROWD_FANS_PER_SQM * pitch * depth)
const CROWD_FILL = {
  A: seatShare(BLEACHER_SEAT_PITCH, BLEACHER_ROW_DEPTH),
  B: seatShare(INFIELD_SEAT_PITCH, INFIELD_ROW_DEPTH),
}

// One texture tile per this many metres of surface, on every face of a box, so
// the roof's corrugation stays the same size whether it is on a 6 m slab or a
// 0.15 m tie.
const UV_METRES = 3

// Simplistic voxel shading for a piece of stadium steel: each face of a box gets
// one flat tone off the base colour -- top sky-lit, field side mid, back and
// underside in shadow. Two boxes of the same material then read as a stack of
// pixel facets instead of one flat silhouette.
function faceShades(col) {
  return [
    col.clone().multiplyScalar(0.82), // 0: front (-Z)
    col.clone().multiplyScalar(0.66), // 1: back (+Z)
    col.clone().multiplyScalar(0.92), // 2: left (-X)
    col.clone().multiplyScalar(1.0),  // 3: right (+X)
    col.clone().multiplyScalar(1.38), // 4: top (+Y)
    col.clone().multiplyScalar(0.55), // 5: bottom (-Y)
  ]
}

function faceUvsFor(sx, sy, sz) {
  return [
    [0, 0, sx / UV_METRES, sy / UV_METRES],
    [0, 0, sx / UV_METRES, sy / UV_METRES],
    [0, 0, sz / UV_METRES, sy / UV_METRES],
    [0, 0, sz / UV_METRES, sy / UV_METRES],
    [0, 0, sx / UV_METRES, sz / UV_METRES],
    [0, 0, sx / UV_METRES, sz / UV_METRES],
  ]
}

// A wall's stone dressings and its brick are one geometry (see
// createCornerWallGeometry), but only the brick should wear the brick map.
// Three splits a mesh into material groups by triangle range, so this walks the
// wall and lays its triangles into runs by their colour: the warm ones are the
// block's red brick, the pale ones its stone. Each run becomes a group, brick at
// material 0 and stone at 1, so the wall keeps its single mesh -- and its single
// outline, stepped and raked as it is -- while its brick reads as brick.
function assignWallMaterials(geom) {
  const color = geom.getAttribute('color')
  if (!color) return geom
  const tris = Math.floor(color.count / 3)
  const brickAt = (tri) => {
    for (let k = 0; k < 3; k += 1) {
      const i = tri * 3 + k
      const r = color.getX(i)
      const g = color.getY(i)
      const b = color.getZ(i)
      if (!(r > g * 1.15 && r > b * 1.15)) return false
    }
    return true
  }
  geom.clearGroups()
  let start = 0
  let brick = brickAt(0)
  for (let tri = 1; tri <= tris; tri += 1) {
    const next = tri < tris ? brickAt(tri) : !brick
    if (next !== brick) {
      geom.addGroup(start * 3, (tri - start) * 3, brick ? 0 : 1)
      start = tri
      brick = next
    }
  }
  return geom
}

// The two canopies' own bays, in one place: the roofs are built from these, and
// so are the flags along their ridges (a flag has to stand on the pole its own
// bay raised), so changing a roof's bays moves its flags with it.
const GRANDSTAND_CANOPY = {
  sample: infieldCanopySample,
  from: ROOF.from,
  to: ROOF.to,
  segments: ROOF.segments,
  frontD: ROOF.frontD,
  backD: ROOF.backD,
  frontY: ROOF.frontY,
  backY: ROOF.backY,
  thickness: ROOF.thickness,
  columnD: ROOF.columnD,
  columnEvery: ROOF.columnEvery,
  facadeTop: ROOF.facadeTop,
  flagEvery: 5,
}

const BLEACHER_CANOPY = {
  sample: bleacherCanopySample,
  // A bay past each pole, so the bleacher canopy covers the last seats at the
  // corner rather than stopping short of them. It runs past the grandstand
  // roof's own end there, with the corner open to the sky between the two.
  from: -0.02,
  to: 1.02,
  segments: BLEACHER_ROOF.segments,
  frontD: BLEACHER_ROOF.frontD,
  backD: BLEACHER_ROOF.backD,
  // One roofline: the bleacher canopy holds the grandstand's heights.
  frontY: ROOF.frontY,
  backY: ROOF.backY,
  thickness: ROOF.thickness,
  columnD: BLEACHER_ROOF.columnD,
  columnEvery: BLEACHER_ROOF.columnEvery,
  facadeTop: OUTFIELD_BLEACHERS.baseHeight
    + OUTFIELD_BLEACHERS.tiers * OUTFIELD_BLEACHERS.tierHeight
    + OUTFIELD_BLEACHERS.facadeLift,
  flagEvery: 6,
}

// The cloth on those poles: a metre of flag, three house colours.
const FLAG_COLORS = ['#c62828', '#f5f7f4', '#1565c0'].map((c) => new THREE.Color(c))
const FLAG_WIDTH = 1.0
const FLAG_HEIGHT = 0.6

// Where a canopy's flags are planted, on the same bay condition the roof uses.
function canopyFlagPlacements(canopy) {
  const out = []
  const step = (canopy.to - canopy.from) / canopy.segments
  for (let i = 0; i < canopy.segments; i++) {
    if (i % canopy.flagEvery !== 2) continue
    const p = canopy.sample(canopy.from + step * (i + 0.5))
    const yaw = Math.atan2(p.nx, p.nz)
    const d = canopy.frontD + 0.6
    out.push({
      x: p.x + d * p.nx,
      y: canopy.frontY + 1.95,
      z: p.z + d * p.nz,
      yaw,
      color: FLAG_COLORS[i % FLAG_COLORS.length],
      // Each flag catches the same gust a beat apart, so the ridge ripples
      // along its length instead of snapping together.
      phase: i * 0.7,
    })
  }
  return out
}

const FLAG_PLACEMENTS = [
  ...canopyFlagPlacements(GRANDSTAND_CANOPY),
  ...canopyFlagPlacements(BLEACHER_CANOPY),
]

// One canopy bay, shared by both roofs: a slab sloping down toward the field, a
// fascia beam and open truss under its front edge, a wall closing it onto the
// stands' rear facade, and columns behind the top row. The flags along the
// ridge are their own mesh (see FlagWave), so the wind can move them; the
// canopy only raises their poles.
// `sample(t)` walks the top of the stands, answering a point and its outward
// normal; `frontD`/`backD` are measured out along that normal.
function createCanopyGeometry({
  sample,
  from,
  to,
  segments,
  frontD,
  backD,
  frontY,
  backY,
  thickness,
  columnD,
  columnEvery,
  facadeTop,
  flagEvery = 5,
}) {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const colRoof = new THREE.Color('#33503c')
  const colRib = new THREE.Color('#456a4d')
  const colSteel = new THREE.Color('#556c5b')
  const colWall = new THREE.Color('#2c3d33')
  const colPole = new THREE.Color('#cfd8dc')

  // Baked face shading: the roof takes the sky on its top, the field side of
  // every member is the shadowed one, so the canopy reads as lit metal rather
  // than as one flat green slab.
  const roofFaces = [
    new THREE.Color('#2b4234'), // 0: front (-Z, toward the field)
    new THREE.Color('#2f4a3a'), // 1: back (+Z)
    new THREE.Color('#33503c'), // 2: left (-X)
    new THREE.Color('#33503c'), // 3: right (+X)
    new THREE.Color('#4a6b53'), // 4: top (sky-lit)
    new THREE.Color('#1e3026'), // 5: bottom (occluded)
  ]

  // Every piece of the canopy carries the skin at the same texel density.
  const box = (opts) => addTransformedBox(positions, normals, colors, uvs, {
    ...opts,
    faceUvs: opts.faceUvs ?? faceUvsFor(opts.sx, opts.sy, opts.sz),
  })
  // The steel under the roof is round: the fascia and the lower chord roll
  // their highlight along the edge, and the hangers, columns and flag masts are
  // cylinders, so the canopy reads as detailed structure rather than as a slab
  // carried on square sticks.
  const round = (opts) => addRoundMember(positions, normals, colors, uvs, {
    segments: 8,
    ...opts,
  })

  const step = (to - from) / segments
  const midD = (frontD + backD) / 2
  const midY = (frontY + backY) / 2
  const depth = backD - frontD
  // Local +z is the outward normal, so a *negative* pitch lifts the back edge
  // and drops the front one: the canopy slopes down toward the field.
  const pitch = -Math.atan2(backY - frontY, depth)

  for (let i = 0; i < segments; i++) {
    const t = from + step * (i + 0.5)
    const p = sample(t)
    const start = sample(from + step * i)
    const end = sample(from + step * (i + 1))
    const yaw = Math.atan2(p.nx, p.nz)
    // The bays are cut well overlong: the back edge of a bay runs along a much
    // wider arc than its chord on the tight corners behind the plate, and a
    // segment cut to the chord opens a wedge of night sky between neighbours.
    const segLen = Math.hypot(end.x - start.x, end.z - start.z) * 1.3

    const at = (d) => ({ x: p.x + d * p.nx, z: p.z + d * p.nz })

    // The slab itself
    const mid = at(midD)
    box({
      cx: mid.x, cy: midY, cz: mid.z,
      sx: segLen, sy: thickness, sz: depth,
      yaw, pitch, col: colRoof, faceColors: roofFaces,
    })

    // The fascia beam along the front edge, and the open truss under it: a
    // lower chord with hangers every other bay, so the canopy reads as carried
    // steel rather than as a slab laid on the crowd.
    const front = at(frontD)
    round({
      cx: front.x, cy: frontY - 0.16, cz: front.z,
      sx: segLen, sy: 0.56, sz: 0.24, yaw, col: colRib, radius: 0.28, axis: 'x',
    })
    const chord = at(frontD + 0.5)
    round({
      cx: chord.x, cy: frontY - 0.95, cz: chord.z,
      sx: segLen, sy: 0.15, sz: 0.15, yaw, col: colSteel,
    })
    if (i % 2 === 0) {
      round({
        cx: chord.x, cy: frontY - 0.55, cz: chord.z,
        sx: 0.13, sy: 0.8, sz: 0.13, yaw, col: colSteel,
      })
    }

    // The wall closing the roof down onto the top of the stands
    const back = at(backD)
    box({
      cx: back.x, cy: (facadeTop + backY) / 2, cz: back.z,
      sx: segLen, sy: backY - facadeTop, sz: 0.26, yaw, col: colWall,
    })

    // Columns standing behind the top row
    if (i % columnEvery === 0) {
      const col = at(columnD)
      round({
        cx: col.x, cy: (facadeTop + backY) / 2 - 0.2, cz: col.z,
        sx: 0.44, sy: backY - facadeTop + 0.4, sz: 0.44, yaw, col: colSteel,
      })
      round({
        cx: col.x, cy: backY - 0.05, cz: col.z,
        sx: 0.9, sy: 0.3, sz: 0.9, yaw, col: colSteel, radius: 0.44, axis: 'y',
      })
    }

    // Flag poles along the ridge, one every few bays; the cloth that flies from
    // them is FlagWave's, on the same placements (see FLAG_PLACEMENTS).
    if (i % flagEvery === 2) {
      const flag = at(frontD + 0.6)
      round({
        cx: flag.x, cy: frontY + 1.1, cz: flag.z,
        sx: 0.08, sy: 2.4, sz: 0.08, yaw, col: colPole,
      })
    }
  }

  // The two ends of the run, finished.
  //
  // A canopy that stops at a foul pole stops on a cut bay: the slab's edge, the
  // front fascia and the truss all break on one line, so the roof reads as
  // something sawed through rather than a stand that ends. Each end gets a
  // fascia return: the front fascia's own rolled section turned through the cut
  // and carried back up the roof's slope to the rear edge, so the beam that
  // draws the front edge turns the corner and draws the end as well. It is the
  // same member on the same centreline (0.16 m under the roof's top), standing
  // a radius proud of the cut, so the return meets the front fascia nose to nose
  // and the slab's raw edge is closed behind it. The two canopies part at the
  // corner, and each end is banded like this, which is what makes the gap
  // between them read as the space between two finished roofs rather than as two
  // raw cuts facing the sky.
  for (const tEnd of [from, to]) {
    const p = sample(tEnd)
    const yaw = Math.atan2(p.nx, p.nz)
    const mid = { x: p.x + midD * p.nx, z: p.z + midD * p.nz }
    // The outward direction along the run, so the return stands just past the
    // cut instead of growing inward over the last bay.
    const inward = tEnd === from ? 1 : -1
    const q = sample(tEnd + inward * 1e-3)
    const tx = q.x - p.x
    const tz = q.z - p.z
    const tl = Math.hypot(tx, tz) || 1
    const out = 0.16
    // The rolled fascia, lying along the roof's depth: its front end lands on
    // the front beam's centreline, its back end on the same line at the rear
    // edge, and the pitch rakes it with the slab between them.
    round({
      cx: mid.x - (tx / tl) * out, cy: midY - 0.16, cz: mid.z - (tz / tl) * out,
      sx: 0.24, sy: 0.56, sz: depth + 0.16, yaw, pitch,
      col: colRib, radius: 0.28, axis: 'z',
    })
    // The slab's own end face, in the roof's colour, set just inside the return:
    // a cut edge in shadow behind the rolled band rather than bare sky through a
    // paper-thin slab.
    box({
      cx: mid.x - (tx / tl) * 0.02, cy: midY, cz: mid.z - (tz / tl) * 0.02,
      sx: 0.12, sy: thickness + 0.04, sz: depth, yaw, pitch, col: colRoof,
    })
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geom.computeVertexNormals()
  return geom
}

// The canopy over the infield bowl, swept along the grandstand spline.
function createGrandstandRoofGeometry() {
  return createCanopyGeometry(GRANDSTAND_CANOPY)
}

// ...and the same canopy cut round the outfield bleachers, so the roofline
// carries on from the foul poles all the way behind centre field.
function createBleacherRoofGeometry() {
  return createCanopyGeometry(BLEACHER_CANOPY)
}

// The flags along both ridges, as one cloth mesh: a grid per flag fine enough
// to hold a fold (eleven across the fly, six up the drop), each vertex carrying
// the flag's hoist-to-fly fraction, its height up the cloth, the direction the
// wind pushes it, and its beat in the gust. The poles stay with the canopy;
// only the cloth is here, because only the cloth moves.
const FLAG_COLS = 10
const FLAG_ROWS = 5

function createFlagFieldGeometry() {
  const positions = []
  const colors = []
  const face = []
  const fly = []
  const drop = []
  const phase = []
  const indices = []

  FLAG_PLACEMENTS.forEach((flag) => {
    const first = positions.length / 3
    const cosY = Math.cos(flag.yaw)
    const sinY = Math.sin(flag.yaw)

    for (let row = 0; row <= FLAG_ROWS; row++) {
      for (let col = 0; col <= FLAG_COLS; col++) {
        const f = col / FLAG_COLS
        const across = row / FLAG_ROWS
        const along = 0.05 + f * FLAG_WIDTH // the hoist edge stands off the pole
        // The cloth sags toward the fly end: no flag hangs level along its top
        // rail, and the droop is what the gust then lifts and lets fall.
        const up = (across - 0.5) * FLAG_HEIGHT - 0.06 * f * f
        positions.push(flag.x + along * cosY, flag.y + up, flag.z - along * sinY)
        face.push(sinY, 0, cosY)
        fly.push(f)
        drop.push(across)
        phase.push(flag.phase)
        // A little baked shade up the cloth, sky-lit at the top rail and darker
        // where the last fold hangs under itself.
        const shade = 0.78 + 0.3 * across
        colors.push(flag.color.r * shade, flag.color.g * shade, flag.color.b * shade)
      }
    }

    for (let row = 0; row < FLAG_ROWS; row++) {
      for (let col = 0; col < FLAG_COLS; col++) {
        const a = first + row * (FLAG_COLS + 1) + col
        const b = a + 1
        const c = a + FLAG_COLS + 1
        const d = c + 1
        indices.push(a, b, c, b, d, c)
      }
    }
  })

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 3))
  geom.setAttribute('aFly', new THREE.Float32BufferAttribute(fly, 1))
  geom.setAttribute('aDrop', new THREE.Float32BufferAttribute(drop, 1))
  geom.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1))
  geom.setIndex(indices)
  geom.computeVertexNormals()
  return geom
}

// A gust running out along each flag: two waves travelling hoist to fly, the
// second tighter and faster, both pinned to nothing at the hoist (the f² grip)
// so the cloth never leaves its pole. The shorter wave is skewed down the drop,
// which is what makes the folds run diagonally instead of as a set of vertical
// corrugations, and the fly end also lifts and sags on its own beat. The normals
// are re-derived from the moved cloth each frame, so the folds catch the light
// rather than sliding over a flat sheet.
const FLAG_GUST = { amp: 0.26, k1: 7.5, w1: 5.5, k2: 12.5, w2: 8.0, lift: 0.16 }

function flagWaveAt(f, across, phase, time) {
  const grip = f * f
  const w1 = Math.sin(f * FLAG_GUST.k1 - time * FLAG_GUST.w1 + phase + across * 0.9)
  const w2 = Math.sin(
    f * FLAG_GUST.k2 - time * FLAG_GUST.w2 + phase * 1.7 + across * 1.5 + 1.3,
  )
  const billow = 0.85 + 0.3 * across // the lower hem trails, the top rail leads
  return {
    offset: FLAG_GUST.amp * grip * billow * (w1 + 0.45 * w2),
    lift: FLAG_GUST.lift * grip * Math.sin(f * 5.5 - time * 4.2 + phase + across * 1.6),
  }
}

function FlagWave() {
  const geom = useMemo(() => createFlagFieldGeometry(), [])
  const base = useMemo(() => Float32Array.from(geom.attributes.position.array), [geom])
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.95,
      metalness: 0.0,
    }),
    [],
  )

  useEffect(() => () => {
    geom.dispose()
    material.dispose()
  }, [geom, material])

  useFrame((state) => {
    const time = state.clock.elapsedTime
    const pos = geom.attributes.position.array
    const face = geom.attributes.aFace.array
    const fly = geom.attributes.aFly.array
    const drop = geom.attributes.aDrop.array
    const phase = geom.attributes.aPhase.array

    for (let v = 0; v < fly.length; v++) {
      const i3 = v * 3
      const { offset, lift } = flagWaveAt(fly[v], drop[v], phase[v], time)
      pos[i3] = base[i3] + face[i3] * offset
      pos[i3 + 1] = base[i3 + 1] + lift
      pos[i3 + 2] = base[i3 + 2] + face[i3 + 2] * offset
    }
    geom.attributes.position.needsUpdate = true
    geom.computeVertexNormals()
  })

  return <mesh name="ridge-flags" geometry={geom} material={material} castShadow />
}

// The press box: the glassed box on the backstop axis, hung under the roof on
// the top of the upper deck.
function createPressBoxGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []

  // The box is a moulded volume: plinth, body and roof cap all carry a
  // chamfer, so the press box reads as a glazed pavilion rather than a crate
  // parked on the upper deck.
  const soft = (opts) => addChamferedBox(positions, normals, colors, {
    ...opts,
    faceColors: opts.faceColors ?? faceShades(opts.col),
  })

  const t = 0.5
  const curve = INFIELD_STANDS_CURVE
  const p = curve.getPoint(t)
  const tan = curve.getTangent(t).normalize()
  const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize()
  const yaw = Math.atan2(n.x, n.z)

  const colFacade = new THREE.Color('#46545c')
  const colGlass = new THREE.Color('#5aa6c4')
  const colFrame = new THREE.Color('#7b8b93')
  const colRoof = new THREE.Color('#33503c')
  const colWall = new THREE.Color('#39464c')

  // It hangs under the front half of the canopy, over the top of the upper
  // deck: far enough back to clear the last row of seats, far enough forward
  // that its glass band shows from the field.
  const D = 11.4
  const W = 17.0
  const GH = 2.3
  const at = (d) => ({ x: p.x + d * n.x, z: p.z + d * n.z })
  const body = at(D)
  const glass = at(D - 1.5)

  // Plinth, body, roof cap
  soft({
    cx: body.x, cy: 7.95, cz: body.z, sx: W + 0.4, sy: 0.34, sz: 3.1, yaw, col: colWall, bevel: 0.10,
  })
  soft({
    cx: body.x, cy: 9.15, cz: body.z, sx: W, sy: GH, sz: 2.9, yaw, col: colFacade, bevel: 0.26,
  })
  soft({
    cx: body.x, cy: 10.42, cz: body.z, sx: W + 1.4, sy: 0.22, sz: 3.5, yaw, col: colRoof, bevel: 0.08,
  })

  // The glass band along the field side, with its mullions; the band is inset
  // just enough to catch an edge, the mullions are rolled steel.
  soft({
    cx: glass.x, cy: 9.5, cz: glass.z, sx: W - 1.0, sy: 1.2, sz: 0.12, yaw, col: colGlass, bevel: 0.04,
  })
  for (let k = -6; k <= 6; k++) {
    addRoundMember(positions, normals, colors, {
      cx: glass.x + Math.cos(yaw) * k * 1.3, cy: 9.5, cz: glass.z - Math.sin(yaw) * k * 1.3,
      sx: 0.11, sy: 1.3, sz: 0.17, yaw, col: colFrame, segments: 8,
    })
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  // The plinth, body, glass band and mullions all wrote their own normals, so
  // the chamfers keep their soft edge instead of being recomputed flat.
  return geom
}

// The chalked lines' own width, in metres: the strips the boxes are drawn with.
const CHALK_LINE_W = 0.07

export const Ballpark = ({ gameState = null }) => {
  const tuftMeshRef = useRef(null)
  const shrubMeshRef = useRef(null)
  const legMeshRef = useRef(null)
  // One instanced mesh per fan look: the eight seated variants, then the show
  // rows' own cheering poses.
  const fanMeshRefs = useMemo(
    () => Array.from({ length: FAN_VARIANTS }, () => ({ current: null })),
    [],
  )

  const fanDummyObj = useMemo(() => new THREE.Object3D(), [])

  // Initialize and memoize procedural textures
  const textures = useMemo(() => {
    const grass = createPixelGrassTexture()
    grass.repeat.set(20, 20)

    const infieldGrass = createInfieldGrassTexture()
    infieldGrass.repeat.set(12, 12)

    // The corner bed's turf is mapped off the world in metres (see
    // createCornerBedGeometry), so it wants no repeat set here.
    const cornerBed = createCornerBedTexture()

    const dirt = createPixelDirtTexture()
    dirt.repeat.set(24, 24)

    const warningTrack = createWarningTrackTexture()
    warningTrack.repeat.set(28, 4)

    const wallPad = createWallPadTexture()
    const tuft = create3BladeGrassTexture()
    const shrub = create4BladeGrassTexture()

    // The pads run from one corner's section line to the other, so the signs
    // sit on bays either side of straight-away centre field, symmetric about it.
    const signs = {
      1: createDistanceSignTexture('330'),
      7: createDistanceSignTexture('375'),
      15: createDistanceSignTexture('400'),
      24: createDistanceSignTexture('375'),
      30: createDistanceSignTexture('330'),
    }

    const stands = createPixelStandsTexture()
    stands.repeat.set(24, 6)

    // The corner's brick: mapped off the walls' own UVs in metres, so it wants
    // no repeat set here.
    const brick = createBrickTexture()

    // Mapped once over the batter's eye's face (see createBattersEyeGeometry),
    // so it wants no tiling: its border is the screen's painted frame.
    const battersEye = createPixelBattersEyeTexture()

    // The canopy's skin is mapped per face in metres (see faceUvsFor), so it
    // wants to tile straight, not be scaled here.
    const roofSkin = createPixelRoofTexture()

    const backstopAd = createPixelBackstopAdTexture()
    const ribbon = createPixelRibbonTexture()
    const seats = createPixelSeatsTexture()

    const fanCap = createPixelFanTextureCap()
    const fanFoam = createPixelFanTextureFoam()
    const fanSoda = createPixelFanTextureSoda()
    const fanPennant = createPixelFanTexturePennant()
    const fanPinstripe = createPixelFanTextureHomePinstripe()
    const fanGold = createPixelFanTextureGoldCheer()
    const fanTeal = createPixelFanTextureTealWindbreaker()
    const fanViolet = createPixelFanTextureVioletSpirit()
    // The show rows' poses, pose-major so the variant index is arithmetic.
    const fansCheering = CHEER_POSES.flatMap((pose) =>
      CHEER_COLORWAYS.map((colorway) => createPixelFanTextureCheer(pose, colorway)),
    )

    return {
      grass,
      infieldGrass,
      cornerBed,
      dirt,
      warningTrack,
      wallPad,
      tuft,
      shrub,
      signs,
      stands,
      brick,
      battersEye,
      roofSkin,
      backstopAd,
      ribbon,
      seats,
      fans: [
        fanCap,
        fanFoam,
        fanSoda,
        fanPennant,
        fanPinstripe,
        fanGold,
        fanTeal,
        fanViolet,
        ...fansCheering,
      ],
    }
  }, [])

  // Geometries for vegetation, smooth pitcher's mound, stadium stands & 3D seats
  const tuftGeom = useMemo(() => createGrassBladesGeometry(0.16, 0.10), [])
  const shrubGeom = useMemo(() => createGrassStarGeometry(0.18, 0.11), [])
  // The mound's own rings, from the one description of it the pitcher's feet are
  // solved against (see constants/mound.js).
  const moundGeom = useMemo(() => createMoundGeometry(), [])
  const outfieldStandsGeom = useMemo(() => createOutfieldStandsGeometry(), [])
  const bleacherCopingGeom = useMemo(() => createBleacherCopingGeometry(), [])
  const grandstandCopingGeom = useMemo(() => createGrandstandCopingGeometry(), [])
  const cornerWallGeom = useMemo(() => assignWallMaterials(createCornerWallGeometry()), [])
  const sideEndWallGeom = useMemo(() => assignWallMaterials(createSideEndWallGeometry()), [])
  const cornerBedGeom = useMemo(() => createCornerBedGeometry(), [])
  const cornerBedClumpsGeom = useMemo(() => createCornerBedClumpsGeometry(), [])
  const cornerBedKerbGeom = useMemo(() => createCornerBedKerbGeometry(), [])
  const battersEyeGeom = useMemo(() => createBattersEyeGeometry(), [])
  const battersEyeFrameGeom = useMemo(() => createBattersEyeFrameGeometry(), [])
  const infieldStandsGeom = useMemo(() => createInfieldStandsGeometry(), [])
  const standsSeatsGeom = useMemo(() => createStandsSeatsGeometry(), [])
  const aisleTreadsGeom = useMemo(() => createAisleTreadsGeometry(), [])
  const aisleHandrailsGeom = useMemo(() => createAisleHandrailsGeometry(), [])
  const backstopWallGeom = useMemo(() => createBackstopWallGeometry(), [])
  const grandstandRoofGeom = useMemo(() => createGrandstandRoofGeometry(), [])
  const bleacherRoofGeom = useMemo(() => createBleacherRoofGeometry(), [])
  const pressBoxGeom = useMemo(() => createPressBoxGeometry(), [])
  const lightTowersTrussGeom = useMemo(() => createLightTowersTrussGeometry(), [])
  const lightTowersBulbsGeom = useMemo(() => createLightTowersBulbsGeometry(), [])
  const railingsGeom = useMemo(() => createSafetyRailingsGeometry(), [])
  const fasciaRibbonGeom = useMemo(() => createFasciaRibbonGeometry(), [])
  const fanQuadGeom = useMemo(() => {
    const geom = new THREE.PlaneGeometry(0.55, 0.72)
    geom.translate(0, 0.36, 0) // anchor bottom at feet / seat cushion
    return geom
  }, [])

  const standsMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: textures.stands,
        vertexColors: true,
        roughness: 1.0,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
    [textures.stands],
  )

  // The brick walls' own material: the same geometry's vertex colours, with the
  // course map multiplied over them (see createBrickTexture and
  // assignWallMaterials). Only the brick triangles of the two wall meshes use
  // it; their stone dressings keep the stands' concrete.
  const brickMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: textures.brick,
        vertexColors: true,
        roughness: 1.0,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
    [textures.brick],
  )

  // The two walls' material slots, in the order assignWallMaterials writes them.
  const wallMats = useMemo(() => [brickMat, standsMat], [brickMat, standsMat])

  // The corner bed's planting: darker than the field, and cut out rather than
  // solid, so the court's walls and the night show through the leaves. It is lit
  // flat (Lambert, not Standard): a bed raked by the view from the mouth is seen
  // at grazing incidence, and a standard material's Fresnel sheen turns it pale
  // from exactly the angle the court is looked into. The colour multiplies the
  // leafy map down to a deep green instead of the field's sunlit one; alphaTest
  // keeps the holes crisp, so the bank reads as a mass of bushes rather than a
  // sheet of glass.
  const cornerBedMat = useMemo(
    () =>
      new THREE.MeshLambertMaterial({
        map: textures.cornerBed,
        color: '#5c7350',
        side: THREE.DoubleSide,
        transparent: true,
        alphaTest: 0.45,
        depthWrite: true,
      }),
    [textures.cornerBed],
  )

  // The clumps in the round wear the same leaves as the bed, but they carry
  // their own greens in their vertex colours, so the map multiplies them down
  // to the planting's depth while the boxes keep the shading of their facets.
  const cornerClumpsMat = useMemo(
    () =>
      new THREE.MeshLambertMaterial({
        map: textures.cornerBed,
        vertexColors: true,
        side: THREE.DoubleSide,
        transparent: true,
        alphaTest: 0.45,
        depthWrite: true,
      }),
    [textures.cornerBed],
  )

  // The batter's eye's own finish: cloth, not the concrete shading map the
  // stands wear, which is what separates the blank screen from the bare deck it
  // stands in.
  const battersEyeMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: textures.battersEye,
        vertexColors: true,
        roughness: 0.94,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
    [textures.battersEye],
  )

  const seatsMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: textures.seats,
        vertexColors: true,
      }),
    [textures.seats],
  )

  const backstopMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: textures.backstopAd,
        roughness: 0.7,
        side: THREE.DoubleSide,
      }),
    [textures.backstopAd],
  )

  const ribbonMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: textures.ribbon,
        emissive: '#102e16',
        emissiveIntensity: 0.9,
        roughness: 0.45,
        side: THREE.DoubleSide,
      }),
    [textures.ribbon],
  )

  const towerTrussMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.65,
        metalness: 0.35,
      }),
    [],
  )

  // Roofs and press box: one concrete-and-steel material for all of them (their
  // colours ride the vertices, like the stands and the light towers).
  const structureMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0.12,
      }),
    [],
  )

  // The canopy carries the pixel roof skin as well as its vertex colours: the
  // texture is a shading map (ribs, seams, bolts, weather) that multiplies the
  // greens above.
  const canopyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: textures.roofSkin,
        vertexColors: true,
        roughness: 0.78,
        metalness: 0.22,
        side: THREE.DoubleSide,
      }),
    [textures.roofSkin],
  )

  const towerBulbMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#fffbe8',
        emissive: '#ffe082',
        emissiveIntensity: 2.2,
        roughness: 0.2,
      }),
    [],
  )

  const railingMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.5,
      }),
    [],
  )

  // 8 distinct fan materials mapped to handcrafted pixel-gradient textures with zero monochromatic tinting
  const fanMaterials = useMemo(
    () =>
      textures.fans.map(
        (tex) =>
          new THREE.MeshStandardMaterial({
            map: tex,
            alphaTest: 0.5,
            roughness: 0.75,
            side: THREE.DoubleSide,
          }),
      ),
    [textures.fans],
  )

  // Audience spectators: 8 authentic 8-bit pixel art character variants seated across actual 3D stadium seats
  const audienceList = useMemo(() => {
    const list = []
    const crowdRng = createPRNG(777)

    // (A) Outfield Bleachers Audience (Seated directly on 3D bleacher seats)
    {
      // One fan per occupied seat round the bleacher ring, off the same rows the
      // seat mesh uses (BLEACHER_ROWS), so the crowd is as full there as
      // anywhere else, no two fans overlap, and the corner's longer rows are
      // filled at the same pitch as the ones beside them.
      for (const row of BLEACHER_ROWS) {
        const t = row.tier
        // A row is filled a row at a time, so the empty seats arrive in the
        // groups people leave them in (util/crowdFill) rather than one at a
        // time like noise.
        const taken = seatFillRun({
          slots: row.slots,
          fill: CROWD_FILL.A,
          aisle: (s) => row.isAisle[s] || row.blank[s],
          // A show window is a full block: the cloth is held along the row, so
          // an empty chair inside it is a hand missing from the banner.
          keep: (s) => showAt('A', t, s) !== null,
          rng: crowdRng,
        })
        for (let i = 0; i < row.slots; i++) {
          // The walkway, a seat nobody is in, or the eye's blank bay — no
          // cushion, so no fan to sit on it and no head peering over the screen.
          if (!taken[i] || row.blank[i]) continue
          const { r, y: yFloor, ang: angle } = bleacherSeatAt(t, i)
          const y = yFloor + 0.16 // sits squarely on seat cushion
          const x = r * Math.sin(angle)
          const z = -r * Math.cos(angle)
          const variant = (t * 3 + i) % 8
          list.push({
            x,
            y,
            z,
            baseY: y,
            yaw: -angle, // faces home plate
            variant,
            scaleX: 0.95 + crowdRng() * 0.12,
            scaleY: 0.95 + crowdRng() * 0.12,
            freq: 2.2 + crowdRng() * 2.5,
            phase: crowdRng() * Math.PI * 2,
            amp: 0.04 + crowdRng() * 0.05,
            angle,
            // Seat address, so behavior groups can claim a contiguous run of
            // neighbours in one row (see crowdGroups below).
            block: 'A',
            row: t,
            seatIdx: i,
          })
        }
      }
    }

    // (B) Infield Grandstands Audience: one fan per occupied seat along the
    // continuous spline, on the seat mesh's own grid (INFIELD_SEAT_ROWS).
    {
      INFIELD_SEAT_ROWS.forEach((sr, sIdx) => {
        const taken = seatFillRun({
          slots: INFIELD_SEATS_PER_ROW,
          fill: CROWD_FILL.B,
          aisle: INFIELD_AISLE,
          keep: (s) => showAt('B', sIdx, s) !== null,
          rng: crowdRng,
        })
        for (let i = 0; i < INFIELD_SEATS_PER_ROW; i++) {
          if (!taken[i]) continue // the aisle, or a seat nobody is in
          const tSpline = infieldSeatT(i)
          const p = INFIELD_STANDS_CURVE.getPoint(tSpline)
          const tan = INFIELD_STANDS_CURVE.getTangent(tSpline).normalize()
          const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize()

          const x = p.x + sr.dSeat * n.x
          const z = p.z + sr.dSeat * n.z
          const y = sr.yFloor + 0.16 // sits squarely on seat cushion
          const yaw = Math.atan2(-n.x, -n.z) // faces inward toward field
          const variant = (sIdx * 3 + i) % 8

          list.push({
            x,
            y,
            z,
            baseY: y,
            yaw,
            variant,
            scaleX: 0.95 + crowdRng() * 0.12,
            scaleY: 0.95 + crowdRng() * 0.12,
            freq: 2.0 + crowdRng() * 2.2,
            phase: crowdRng() * Math.PI * 2,
            amp: 0.04 + crowdRng() * 0.05,
            angle: tSpline * Math.PI * 2,
            block: 'B',
            row: sIdx,
            seatIdx: i,
          })
        }
      })
    }

    return list
  }, [])

  // The crowd's little shows (SHOWS, above). Each cluster is a seat window in
  // one seating row, snapped to one block between two aisles when the park is
  // laid out; because the crowd fill keeps a window's seats full, every show is
  // an unbroken run of neighbours rather than a run with holes in it.
  const crowdGroups = useMemo(() => {
    // The row's own axis, as the field sees it. A show sits where its fans
    // actually sit: every member keeps its own seat's x, z and yaw, so sitting
    // and standing are anchored to its own cushion rather than to a line
    // redrawn beside the chairs. The sprite scale is the row's median, which
    // keeps every raised grip at the same height without moving anyone. All
    // that is derived here is the row's coordinate ``s`` — 0 at the left-hand
    // fan, 1 at the right-hand one — which the wave in util/showMotion.js and
    // the props in CrowdShow are both written in.
    //
    // The window is full (the crowd fill keeps it so), and the cloth spans it:
    // its straight bottom edge is the chord between the two holders' hands, and
    // a row's own bow leaves the middle hands at most a hand's width behind
    // that chord (see util/fanSprites.js).
    const seatRow = (members) => {
      const yaw = members.reduce((sum, m) => sum + m.yaw, 0) / members.length
      const facing = { x: Math.sin(yaw), z: Math.cos(yaw) }
      const right = { x: facing.z, z: -facing.x }
      const along = (fan) => right.x * fan.x + right.z * fan.z
      const ordered = [...members].sort((a, b) => along(a) - along(b))
      const first = along(ordered[0])
      const span = along(ordered[ordered.length - 1]) - first
      // The one thing taken from the row rather than kept from the seat: a
      // common scale, so the raised grips all reach the same height. A row of
      // own-scale sprites puts the taller fans' hands centimetres above the
      // shorter ones', off the banner's straight bottom edge. This does not
      // move a fan: the sprite is anchored at its feet, on its cushion.
      const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
      const scaleX = median(members.map((m) => m.scaleX))
      const scaleY = median(members.map((m) => m.scaleY))
      return ordered.map((m) => ({
        ...m,
        baseY: m.y,
        scaleX,
        scaleY,
        // Where the fan sits along its row: the wave in util/showMotion.js is
        // written in this coordinate, and CrowdShow numbers the cloth with
        // the same projection.
        s: span > 0 ? (along(m) - first) / span : 0,
      }))
    }

    const built = SHOWS.map((show) => {
      // The seats the show stands on: its window, which the crowd fill has
      // already kept full.
      const seated = audienceList.filter((fan) => (
        fan.block === show.block && fan.row === show.row
        && fan.seatIdx >= show.from && fan.seatIdx < show.to
      ))
      if (seated.length < 2) return null
      const members = seatRow(seated)
      let sx = 0
      let sy = 0
      let sz = 0
      let sYaw = 0
      members.forEach((m) => {
        sx += m.x
        sy += m.y
        sz += m.z
        sYaw += m.yaw
      })
      const anchor = { x: sx / members.length, y: sy / members.length, z: sz / members.length }
      const yaw = sYaw / members.length
      // The row's own look: everyone in it wears the show's pose, so the props
      // have hands to sit in and the row reads as one cheering line. The props
      // take their own widths from the grips (see util/fanSprites.js), so nothing
      // about the show's size is decided here.
      return {
        ...show,
        anchor,
        yaw,
        // A musician's pose follows the instrument in its hands: horns are
        // played at the mouth, drums are worn at the waist, and the two are
        // handed out alternately along the row (util/fanSprites.js
        // musicPose / musicInstrument, read by CrowdShow for the props).
        fans: members.map((m, i) => {
          const pose = show.role === 'shout' ? 'raise' : musicPose(i)
          return {
            ...m,
            pose,
            show: true,
            showId: show.id,
            colourway: m.seatIdx % CHEER_COLORWAYS.length,
            cheerVariant: CHEER_FIRST_VARIANT
              + CHEER_POSES.indexOf(pose) * CHEER_COLORWAYS.length
              + (m.seatIdx % CHEER_COLORWAYS.length),
          }
        }),
      }
    }).filter(Boolean)
    // Number the groups only once the empty ones are gone: this index is the
    // clock a seat reads, and CrowdShow numbers its props the same way.
    return built.map((group, index) => ({
      ...group,
      fans: group.fans.map((fan) => ({ ...fan, showIndex: index })),
    }))
  }, [audienceList])

  // Which seats belong to a show, and the look they wear. A show row stands
  // still — no individual bounce, no stadium wave — so the hands along it hold
  // the banner level and the notes rise off a clean line. The seats are placed
  // from the show's own fan records, which are the seats they were given.
  const showLook = useMemo(() => {
    const map = new Map()
    crowdGroups.forEach((group) => {
      group.fans.forEach((fan) => {
        map.set(`${fan.block}:${fan.row}:${fan.seatIdx}`, fan)
      })
    })
    return map
  }, [crowdGroups])

  // Partition the audience into one instanced list per fan look. A fan in a
  // show row appears twice — once in its acting pose and once in the resting
  // one — and the two swap places when the row raises its hands. Nothing is
  // ever moved between instanced meshes: both slots stand on the same seat and
  // the one that is not being worn is collapsed to nothing.
  const audienceByVariant = useMemo(() => {
    const groups = Array.from({ length: FAN_VARIANTS }, () => [])
    const restPose = CHEER_POSES.indexOf('rest')
    audienceList.forEach((fan) => {
      const cheer = showLook.get(`${fan.block}:${fan.row}:${fan.seatIdx}`)
      if (cheer) {
        const rest = CHEER_FIRST_VARIANT + restPose * CHEER_COLORWAYS.length + cheer.colourway
        groups[cheer.cheerVariant].push({
          ...cheer, variant: cheer.cheerVariant, amp: 0, show: true, slot: 'act',
        })
        groups[rest].push({ ...cheer, variant: rest, amp: 0, show: true, slot: 'rest' })
        return
      }
      groups[fan.variant].push(fan)
    })
    return groups
  }, [audienceList, showLook])

  // The legs of every show-row fan: the sprites are drawn from the hips up, so
  // a row that stands is a row of floating torsos without them. The strip is
  // stretched from the step under the seat to the sprite's hip, follow the row
  // step, and is collapsed when the fan sits.
  const showLegs = useMemo(() => {
    const list = []
    crowdGroups.forEach((group, gi) => {
      group.fans.forEach((fan) => {
        list.push({
          x: fan.x,
          z: fan.z,
          baseY: fan.baseY,
          yaw: fan.yaw,
          s: fan.s,
          showIndex: gi,
        })
      })
    })
    return list
  }, [crowdGroups])

  const legGeom = useMemo(() => {
    const geom = new THREE.PlaneGeometry(LEGS.width, LEGS.height)
    geom.translate(0, LEGS.height / 2, 0) // feet on the step
    return geom
  }, [])

  const legTexture = useMemo(() => createPixelLegsTexture(), [])

  const legMat = useMemo(() => new THREE.MeshStandardMaterial({
    map: legTexture,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.85,
  }), [legTexture])

  // How many fans each seating block ended up with, beside the seats it has, so
  // the density of one block can be compared with another's.
  const crowdCounts = useMemo(() => {
    const counts = { A: 0, B: 0, C: 0 }
    for (const fan of audienceList) counts[fan.block] += 1
    return counts
  }, [audienceList])

  // Harness hook: the crowd page (e2e/harness/crowd.html) aims its camera at a
  // group's own anchor and reads the members back. Every seat's own centre is
  // handed over beside them, so a test can check that a show row is sitting on
  // its chairs rather than on a line drawn beside them. Never read by the app.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.__crowdGroups = crowdGroups
      window.__crowdCounts = crowdCounts
      window.__crowdSeats = audienceList.map((fan) => ({
        block: fan.block,
        row: fan.row,
        seatIdx: fan.seatIdx,
        x: fan.x,
        y: fan.y,
        z: fan.z,
        yaw: fan.yaw,
      }))
    }
  }, [crowdGroups, crowdCounts, audienceList])

  // Vegetation materials: transparent-cutout double-sided standard materials
  const tuftMat = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      map: textures.tuft,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.75,
      shadowSide: THREE.DoubleSide,
    })
  }, [textures.tuft])

  const shrubMat = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      map: textures.shrub,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.75,
      shadowSide: THREE.DoubleSide,
    })
  }, [textures.shrub])

  // Dispose textures, materials, and geometries on unmount
  useEffect(() => {
    return () => {
      textures.grass.dispose()
      textures.infieldGrass.dispose()
      textures.cornerBed.dispose()
      textures.dirt.dispose()
      textures.warningTrack.dispose()
      textures.wallPad.dispose()
      textures.tuft.dispose()
      textures.shrub.dispose()
      textures.stands.dispose()
      textures.brick.dispose()
      textures.battersEye.dispose()
      textures.roofSkin.dispose()
      textures.backstopAd.dispose()
      textures.ribbon.dispose()
      textures.seats.dispose()
      textures.fans.forEach((t) => t.dispose())
      Object.values(textures.signs).forEach((t) => t.dispose())

      tuftGeom.dispose()
      shrubGeom.dispose()
      moundGeom.dispose()
      outfieldStandsGeom.dispose()
      bleacherCopingGeom.dispose()
      grandstandCopingGeom.dispose()
      cornerWallGeom.dispose()
      sideEndWallGeom.dispose()
      cornerBedGeom.dispose()
      cornerBedClumpsGeom.dispose()
      cornerBedKerbGeom.dispose()
      battersEyeGeom.dispose()
      battersEyeFrameGeom.dispose()
      infieldStandsGeom.dispose()
      standsSeatsGeom.dispose()
      aisleTreadsGeom.dispose()
      aisleHandrailsGeom.dispose()
      backstopWallGeom.dispose()
      grandstandRoofGeom.dispose()
      bleacherRoofGeom.dispose()
      pressBoxGeom.dispose()
      lightTowersTrussGeom.dispose()
      lightTowersBulbsGeom.dispose()
      railingsGeom.dispose()
      fasciaRibbonGeom.dispose()
      fanQuadGeom.dispose()
      legGeom.dispose()
      legTexture.dispose()
      legMat.dispose()

    standsMat.dispose()
    brickMat.dispose()
    cornerBedMat.dispose()
    cornerClumpsMat.dispose()
    battersEyeMat.dispose()
    canopyMat.dispose()
    seatsMat.dispose()
    backstopMat.dispose()
      ribbonMat.dispose()
      towerTrussMat.dispose()
      towerBulbMat.dispose()
      railingMat.dispose()
      fanMaterials.forEach((m) => m.dispose())
      tuftMat.dispose()
      shrubMat.dispose()
    }
  }, [
    textures,
    tuftGeom,
    shrubGeom,
    moundGeom,
    outfieldStandsGeom,
    bleacherCopingGeom,
    grandstandCopingGeom,
    cornerWallGeom,
    sideEndWallGeom,
    cornerBedGeom,
    cornerBedClumpsGeom,
    cornerBedKerbGeom,
    battersEyeGeom,
    battersEyeFrameGeom,
    infieldStandsGeom,
    standsSeatsGeom,
    aisleTreadsGeom,
    aisleHandrailsGeom,
    backstopWallGeom,
    grandstandRoofGeom,
    bleacherRoofGeom,
    pressBoxGeom,
    lightTowersTrussGeom,
    lightTowersBulbsGeom,
    railingsGeom,
    fasciaRibbonGeom,
    fanQuadGeom,
    legGeom,
    legTexture,
    legMat,
    battersEyeMat,
    standsMat,
    brickMat,
    cornerBedMat,
    cornerClumpsMat,
    canopyMat,
    seatsMat,
    backstopMat,
    ribbonMat,
    towerTrussMat,
    towerBulbMat,
    railingMat,
    structureMat,
    fanMaterials,
    tuftMat,
    shrubMat,
  ])


  // Infield grass diamond custom BufferGeometry with circular hole for pitcher's mound
  const infieldGrassGeom = useMemo(() => {
    const vHome = { x: 0, z: 0 }
    const v1B = { x: FIELD.BASE.FIRST.x, z: FIELD.BASE.FIRST.z }
    const v2B = { x: FIELD.BASE.SECOND.x, z: FIELD.BASE.SECOND.z }
    const v3B = { x: FIELD.BASE.THIRD.x, z: FIELD.BASE.THIRD.z }

    const diamond = new THREE.Shape()
    diamond.moveTo(vHome.x, -vHome.z)
    diamond.lineTo(v1B.x, -v1B.z)
    diamond.lineTo(v2B.x, -v2B.z)
    diamond.lineTo(v3B.x, -v3B.z)
    diamond.closePath()

    // 18-ft diameter pitcher's mound cutout (radius = 9 ft = 2.7432m)
    const moundHole = new THREE.Path()
    const pX = FIELD.DEFENSE.P.x
    const pY2D = -FIELD.DEFENSE.P.z
    const moundR = feetToM(9)
    moundHole.absarc(pX, pY2D, moundR, 0, Math.PI * 2, true)
    diamond.holes.push(moundHole)

    const geom = new THREE.ShapeGeometry(diamond, 32)
    geom.rotateX(-Math.PI / 2)
    geom.translate(0, 0.024, 0)

    // Compute planar UVs matching infield checkered grass
    const pos = geom.getAttribute('position')
    const uvs = new Float32Array(pos.count * 2)
    const spanX = FIELD.BASE.FIRST.x - FIELD.BASE.THIRD.x
    const spanZ = vHome.z - FIELD.BASE.SECOND.z
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i)
      const vz = pos.getZ(i)
      uvs[i * 2] = (vx - FIELD.BASE.THIRD.x) / spanX
      uvs[i * 2 + 1] = (vz - FIELD.BASE.SECOND.z) / spanZ
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geom.computeVertexNormals()
    return geom
  }, [])

  // Home plate: the 17-inch pentagon, drawn in its own plane with the *point* at the
  // shape's own origin — so the mesh's place is the point's place (see PLATE in
  // constants/field.js, which is where the shape and the world's plate are kept).
  const homePlateGeom = useMemo(() => {
    const hpShape = new THREE.Shape()
    const hpW = PLATE.width / 2
    const hpSide = PLATE.side
    const hpBevel = PLATE.bevel
    // The point, then out along the two bevels (12 in at 45°, so 8.5 in across and
    // 8.5 in deep), then down the two 8.5-inch sides to the 17-inch back edge.
    const bevelX = hpW
    const bevelY = hpBevel / Math.SQRT2
    hpShape.moveTo(0, 0)
    hpShape.lineTo(bevelX, -bevelY)
    hpShape.lineTo(bevelX, -bevelY - hpSide)
    hpShape.lineTo(-bevelX, -bevelY - hpSide)
    hpShape.lineTo(-bevelX, -bevelY)
    hpShape.closePath()
    return new THREE.ShapeGeometry(hpShape)
  }, [])

  // Basepath segments connecting Home -> 1B -> 2B -> 3B -> Home
  const basepaths = useMemo(() => {
    const paths = [
      [FIELD.BASE.HOME, FIELD.BASE.FIRST],
      [FIELD.BASE.FIRST, FIELD.BASE.SECOND],
      [FIELD.BASE.SECOND, FIELD.BASE.THIRD],
      [FIELD.BASE.THIRD, FIELD.BASE.HOME],
    ]
    const width = feetToM(6)

    return paths.map(([p1, p2]) => {
      const v = p2.clone().sub(p1)
      const len = v.length()
      const mid = p1.clone().add(p2).multiplyScalar(0.5)
      const rotZ = Math.atan2(-v.x, -v.z)
      return {
        position: [mid.x, 0.026, mid.z],
        rotation: [-Math.PI / 2, 0, rotZ],
        args: [width, len],
      }
    })
  }, [])

  // Foul lines extending from home plate to the outfield wall
  const foulLines = useMemo(() => {
    const length = WALL_RADIUS * 0.98
    const lineWidth = 0.12

    return [FIELD.BASE.FIRST, FIELD.BASE.THIRD].map((baseVec) => {
      const dir = baseVec.clone().setY(0).normalize()
      const mid = dir.clone().multiplyScalar(length / 2)
      const rotZ = Math.atan2(-dir.x, -dir.z)
      return {
        position: [mid.x, 0.034, mid.z],
        rotation: [-Math.PI / 2, 0, rotZ],
        args: [lineWidth, length],
      }
    })
  }, [])

  // The padded wall round the warning track — thirty chamfered bays and their
  // rail in two merged meshes — and the distance markers standing on the bays
  // the park labels, each turned to face the field (see createDistanceSignGeometry).
  const wallGeometry = useMemo(() => createOutfieldWallGeometry(), [])
  const signGeometry = useMemo(() => createDistanceSignGeometry(), [])
  const poleBaseGeometry = useMemo(() => createFoulPoleBaseGeometry(), [])
  const poleCollarGeometry = useMemo(() => createFoulPoleCollarGeometry(), [])
  const baseBagGeometry = useMemo(() => createBaseBagGeometry(), [])
  const distanceSigns = useMemo(() => {
    const signs = []
    for (let i = 0; i < WALL_BAYS; i++) {
      const tex = textures.signs[i]
      if (!tex) continue
      const bay = wallBay(i)
      signs.push({
        tex,
        position: [
          bay.x - Math.sin(bay.mid) * WALL_SIGN_OFFSET,
          WALL_HEIGHT * 0.55,
          bay.z + Math.cos(bay.mid) * WALL_SIGN_OFFSET,
        ],
        // The slab's front face is its -Z; at this yaw it looks back into the
        // field, and its own +X runs along the wall the way a spectator in the
        // field reads it, so the number is not mirrored.
        yaw: Math.PI - bay.mid,
      })
    }
    return signs
  }, [textures.signs])

  // Foul poles: the rule wants them well above the wall, and real parks run
  // them about 90 ft, so they stand clear over the roof rather than stopping at
  // the top of the wall. The yellow mesh runs from the wall up to just under
  // the ball.
  const foulPoles = useMemo(() => {
    const poleHeight = feetToM(90)
    const screenBottom = feetToM(10)
    const screenTop = poleHeight - feetToM(1.5)
    return [-1, 1].map((side) => {
      const angle = side * (Math.PI / 4)
      const px = WALL_RADIUS * Math.sin(angle)
      const pz = -WALL_RADIUS * Math.cos(angle)
      return {
        polePos: [px, poleHeight / 2, pz],
        basePos: [px, 0.27, pz],
        // The collar sits over the wall's rail (its top edge is at WALL_HEIGHT +
        // 0.22), so it hides the mast's junction with both.
        collarPos: [px, WALL_HEIGHT + 0.39, pz],
        screenPos: [px + (side === -1 ? 0.4 : -0.4), (screenBottom + screenTop) / 2, pz],
        screenRot: [0, (side === -1 ? 1 : -1) * (Math.PI / 4), 0],
        args: [0.16, 0.26, poleHeight, 16],
        screenArgs: [feetToM(3), screenTop - screenBottom],
      }
    })
  }, [])

  // Calculate exact angle where dirt arc intersects 45-degree foul lines
  const foulAngle = useMemo(() => {
    return Math.asin((feetToM(90.2) - feetToM(60.5)) / feetToM(95))
  }, [])

  // Helper for chalk box line rectangles. Each line is named for the box it belongs to
  // (``<box>-front|back|3B|1B``) so a plan probe can reassemble the box it draws — the
  // chalk is four thin rectangles, and the rectangle they make is what the rulebook
  // cares about (see e2e/harness/fieldMain.jsx). ``yaw`` leans a line out of square,
  // which the catcher's box's two sides need (see catcherBoxLines below).
  const createChalkBox = (name, x, z, width, depth, lineWidth = CHALK_LINE_W) => [
    { name: `${name}-front`, pos: [x, 0.032, z - depth / 2], args: [width, lineWidth] },
    { name: `${name}-back`, pos: [x, 0.032, z + depth / 2], args: [width, lineWidth] },
    { name: `${name}-3B`, pos: [x - width / 2, 0.032, z], args: [lineWidth, depth] },
    { name: `${name}-1B`, pos: [x + width / 2, 0.032, z], args: [lineWidth, depth] },
  ]

  // The catcher's box, chalked as the trapezoid it is: a 15-inch front line across the
  // gap the two batters' boxes leave at their own back line, the rule's 43-inch back
  // line 8 ft behind the plate's apex, and the two sides flaring between them. Drawn
  // this way no line of it runs inside a batter's box — the front line stops 7 in short
  // of each of their back inside corners, and the sides only ever stand further out and
  // further back from there (see CATCHER_BOX in constants/field.js).
  const catcherBoxLines = useMemo(() => {
    const front = CATCHER_BOX.frontHalfWidth
    const back = CATCHER_BOX.backHalfWidth
    const dz = CATCHER_BOX.backZ - CATCHER_BOX.frontZ
    const side = Math.hypot(back - front, dz)
    const midZ = (CATCHER_BOX.frontZ + CATCHER_BOX.backZ) / 2
    const midX = (front + back) / 2
    // A strip runs along its own local +y, which a -90 degree roll about X sends to -z;
    // the yaw that leans it out by the side's own slope is that slope's own angle.
    const yaw = Math.atan2(back - front, dz)
    return [
      { name: 'catcherBox-front', pos: [0, 0.032, CATCHER_BOX.frontZ], args: [front * 2, CHALK_LINE_W] },
      { name: 'catcherBox-back', pos: [0, 0.032, CATCHER_BOX.backZ], args: [back * 2, CHALK_LINE_W] },
      { name: 'catcherBox-3B', pos: [-midX, 0.032, midZ], args: [CHALK_LINE_W, side], yaw: -yaw },
      { name: 'catcherBox-1B', pos: [midX, 0.032, midZ], args: [CHALK_LINE_W, side], yaw },
    ]
  }, [])

  // The chalk around the plate: the two batters' boxes and the catcher's box, laid out
  // from constants/field.js (which carries the rulebook's own numbers and the world's
  // own frame), plus the two coaches' boxes out by first and third.
  const chalkBoxes = useMemo(() => [
    ...BATTER_BOXES.flatMap((box) => createChalkBox(
      box.name, box.centreX, box.centreZ, BATTER_BOX.width, BATTER_BOX.depth,
    )),
    ...catcherBoxLines,
    ...createChalkBox('coachBox-3B', -feetToM(75), -feetToM(60), feetToM(10), feetToM(20)),
    ...createChalkBox('coachBox-1B', feetToM(75), -feetToM(60), feetToM(10), feetToM(20)),
  ], [catcherBoxLines])

  // Instanced vegetation data: grass tufts and voxel shrubs
  const { tuftInstances, shrubInstances } = useMemo(() => {
    const tufts = []
    const shrubs = []
    const tuftRng = createPRNG(45678)

    // (A) Tufts inside infield checkered lawn (small, manicured sprouts):
    for (let i = 0; i < 40; i++) {
      const rx = (tuftRng() - 0.5) * feetToM(80)
      const rz = -feetToM(20) - tuftRng() * feetToM(85)
      const dx = Math.abs(rx)
      const dz = Math.abs(rz - (-feetToM(64.1)))
      if (dx / feetToM(54) + dz / feetToM(54) < 0.88) {
        const distMound = Math.hypot(rx, rz - FIELD.DEFENSE.P.z)
        if (distMound > feetToM(11)) {
          tufts.push({
            x: rx,
            y: 0.026,
            z: rz,
            scale: 0.65 + tuftRng() * 0.35,
            rot: tuftRng() * Math.PI,
            color: getFieldColorAt(rx, rz, tuftRng),
          })
        }
      }
    }

    // (B) Tufts across outfield grass & foul territory:
    let attempts = 0
    while (tufts.length < 320 && attempts < 3500) {
      attempts++
      const r = feetToM(110 + tuftRng() * 194)
      const angle = (tuftRng() - 0.5) * (Math.PI * 0.88)
      const x = r * Math.sin(angle)
      const z = -r * Math.cos(angle)

      const distFromMound = Math.hypot(x, z - FIELD.DEFENSE.P.z)
      if (distFromMound < feetToM(97)) continue

      const distFoul1 = Math.abs(x - (-z)) / Math.SQRT2
      const distFoul3 = Math.abs(-x - (-z)) / Math.SQRT2
      if (distFoul1 < feetToM(3.5) || distFoul3 < feetToM(3.5)) continue

      tufts.push({
        x,
        y: 0.004,
        z,
        scale: 0.75 + tuftRng() * 0.4,
        rot: tuftRng() * Math.PI,
        color: getFieldColorAt(x, z, tuftRng),
      })
    }

    // (C) 4-blade grass clusters along warning track border & foul territory:
    const shrubRng = createPRNG(9876)
    for (let i = 0; i < 28; i++) {
      const angle = (shrubRng() - 0.5) * (Math.PI * 0.75)
      const r = feetToM(308) - shrubRng() * feetToM(8)
      const sx = r * Math.sin(angle)
      const sz = -r * Math.cos(angle)
      shrubs.push({
        x: sx,
        y: 0.018,
        z: sz,
        scale: 0.8 + shrubRng() * 0.35,
        rot: shrubRng() * Math.PI,
        color: getFieldColorAt(sx, sz, shrubRng),
      })
    }
    for (let i = 0; i < 16; i++) {
      const side = shrubRng() < 0.5 ? -1 : 1
      const sx = side * (feetToM(45) + shrubRng() * feetToM(45))
      const sz = -feetToM(20) - shrubRng() * feetToM(70)
      shrubs.push({
        x: sx,
        y: 0.023,
        z: sz,
        scale: 0.8 + shrubRng() * 0.35,
        rot: shrubRng() * Math.PI,
        color: getFieldColorAt(sx, sz, shrubRng),
      })
    }

    return { tuftInstances: tufts, shrubInstances: shrubs }
  }, [])

  // Update instance matrices and instance colors for vegetation
  useEffect(() => {
    const dummy = new THREE.Object3D()
    const colorObj = new THREE.Color()

    if (tuftMeshRef.current) {
      tuftMeshRef.current.frustumCulled = false
      tuftInstances.forEach((t, i) => {
        dummy.position.set(t.x, t.y, t.z)
        dummy.scale.set(t.scale, t.scale, t.scale)
        dummy.rotation.set(0, t.rot, 0)
        dummy.updateMatrix()
        tuftMeshRef.current.setMatrixAt(i, dummy.matrix)
        colorObj.set(t.color)
        tuftMeshRef.current.setColorAt(i, colorObj)
      })
      tuftMeshRef.current.instanceMatrix.needsUpdate = true
      if (tuftMeshRef.current.instanceColor) {
        tuftMeshRef.current.instanceColor.needsUpdate = true
      }
      tuftMat.needsUpdate = true
    }

    if (shrubMeshRef.current) {
      shrubMeshRef.current.frustumCulled = false
      shrubInstances.forEach((s, i) => {
        dummy.position.set(s.x, s.y, s.z)
        dummy.scale.set(s.scale, s.scale, s.scale)
        dummy.rotation.set(0, s.rot, 0)
        dummy.updateMatrix()
        shrubMeshRef.current.setMatrixAt(i, dummy.matrix)
        colorObj.set(s.color)
        shrubMeshRef.current.setColorAt(i, colorObj)
      })
      shrubMeshRef.current.instanceMatrix.needsUpdate = true
      if (shrubMeshRef.current.instanceColor) {
        shrubMeshRef.current.instanceColor.needsUpdate = true
      }
      shrubMat.needsUpdate = true
    }

    fanMeshRefs.forEach((ref, vIdx) => {
      const mesh = ref.current
      if (!mesh) return
      mesh.frustumCulled = false
      const fans = audienceByVariant[vIdx]
      fans.forEach((fan, i) => {
        fanDummyObj.position.set(fan.x, fan.y, fan.z)
        fanDummyObj.rotation.set(-0.08, fan.yaw, 0)
        fanDummyObj.scale.set(fan.scaleX, fan.scaleY, 1.0)
        fanDummyObj.updateMatrix()
        mesh.setMatrixAt(i, fanDummyObj.matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
      fanMaterials[vIdx].needsUpdate = true
    })
  }, [
    tuftInstances,
    shrubInstances,
    audienceByVariant,
    fanDummyObj,
    tuftMat,
    shrubMat,
    fanMaterials,
    fanMeshRefs,
  ])

  // Continuous animation loop for crowd cheering and stadium wave motion across 8 fan variants
  useFrame((state) => {
    const time = state.clock.elapsedTime
    const dummy = fanDummyObj
    // One clock per show group, shared with the props CrowdShow draws over the
    // same row (util/showMotion.js): the row and what it holds move as one.
    const showCycles = crowdGroups.map((group, i) => groupCycle(time, i, group.id))

    for (let vIdx = 0; vIdx < fanMeshRefs.length; vIdx++) {
      const mesh = fanMeshRefs[vIdx].current
      if (!mesh) continue
      const fans = audienceByVariant[vIdx]

      for (let i = 0; i < fans.length; i++) {
        const fan = fans[i]
        // 1. Individual joyful rhythmic bounce
        const individualBob = Math.abs(Math.sin(time * fan.freq + fan.phase)) * fan.amp
        // 2. Stadium wave propagating across the seating arc (a show row
        // stands still: its hands hold the props level)
        const wave = fan.show ? 0 : Math.sin(time * 3.0 - fan.angle * 3.5)
        const waveBoost = wave > 0.65 ? (wave - 0.65) * 0.28 : 0
        // 3. A show row stands up to work its banner or its instruments, then
        // rides the wave it is pumping — the same lift, at the same seat, that
        // CrowdShow gives the cloth or the horn in that fan's hands.
        const showLift = fan.show ? rowLift(showCycles[fan.showIndex].t, time, fan.s) : 0

        // A show fan steps out of its seat toward the field while it stands,
        // and wears exactly one of its two sprites: the acting pose while its
        // hands are up, the resting one otherwise. The props are swapped on the
        // same `actPoseUp` step (see CrowdShow), so nothing is ever held in an
        // empty hand or hung beside a seated fan.
        const cycle = fan.show ? showCycles[fan.showIndex] : null
        const step = cycle ? rowStep(cycle.t) : 0
        const poseUp = cycle ? actPoseUp(cycle.t) : false
        const worn = !cycle || (fan.slot === 'act' ? poseUp : !poseUp)
        const wornScale = worn ? 1 : 1e-4

        dummy.position.set(
          fan.x + Math.sin(fan.yaw) * step,
          fan.baseY + individualBob + waveBoost + showLift,
          fan.z + Math.cos(fan.yaw) * step,
        )
        dummy.rotation.set(-0.08, fan.yaw, 0)
        dummy.scale.set(fan.scaleX * wornScale, fan.scaleY * wornScale, 1.0)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
    }

    // The standing rows' legs, from the step under each seat up to the sprite's
    // hip. Both ends come from the clock, so the trousers meet the torso through
    // the whole rise and the wave, and collapse to nothing when the fan sits.
    const legMesh = legMeshRef.current
    if (legMesh) {
      for (let i = 0; i < showLegs.length; i++) {
        const fan = showLegs[i]
        const cycle = showCycles[fan.showIndex]
        const lift = rowLift(cycle.t, time, fan.s)
        const step = rowStep(cycle.t)
        const stretch = (standProgress(cycle.t) * legLength(lift)) / LEGS.height

        dummy.position.set(
          fan.x + Math.sin(fan.yaw) * step,
          fan.baseY - SEAT_RISE,
          fan.z + Math.cos(fan.yaw) * step,
        )
        dummy.rotation.set(0, fan.yaw, 0)
        dummy.scale.set(1, Math.max(stretch, 1e-4), 1)
        dummy.updateMatrix()
        legMesh.setMatrixAt(i, dummy.matrix)
      }
      legMesh.instanceMatrix.needsUpdate = true
    }
  })

  return (
    <group>
      {/* 1. Base Outfield Grass (Disc at Y = 0, rotated so mowing stripes lead to CF) */}
      <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 4]} receiveShadow>
        <circleGeometry args={[GRASS_RADIUS, 72]} />
        <meshStandardMaterial map={textures.grass} roughness={0.9} />
      </mesh>

      {/* 2. Warning Track (Ring along wall from 314 ft to 330 ft at Y = 0.015) */}
      <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <ringGeometry args={[WARNING_TRACK_INNER, WALL_RADIUS, 64, 1, Math.PI / 4, Math.PI / 2]} />
        <meshStandardMaterial
          map={textures.warningTrack}
          roughness={0.95}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>

      {/* 3. Infield Dirt Skinned Area: Semicircle arc between foul lines at Y = 0.020 */}
      <mesh position={[FIELD.DEFENSE.P.x, 0.020, FIELD.DEFENSE.P.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <ringGeometry
          args={[DIRT_ARC_INNER, DIRT_ARC_OUTER, 64, 1, foulAngle, Math.PI - 2 * foulAngle]}
        />
        <meshStandardMaterial
          map={textures.dirt}
          roughness={0.95}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
        />
      </mesh>

      {/* 4. Infield Grass Diamond (At Y = 0.024 with checkered pattern covering full diamond) */}
      <mesh geometry={infieldGrassGeom} receiveShadow>
        <meshStandardMaterial
          map={textures.infieldGrass}
          roughness={0.88}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>

      {/* 5. Basepath Dirt Lanes (Connecting Home -> 1B -> 2B -> 3B -> Home at Y = 0.026) */}
      {basepaths.map((bp, i) => (
        <mesh key={`bp-${i}`} position={bp.position} rotation={bp.rotation} receiveShadow>
          <planeGeometry args={bp.args} />
          <meshStandardMaterial
            map={textures.dirt}
            roughness={0.95}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      ))}

      {/* 6. Home Plate Dirt Cutout Circle (radius 13 ft at Y = 0.027) */}
      <mesh position={[0, 0.027, -feetToM(1.5)]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[feetToM(13), 32]} />
        <meshStandardMaterial
          map={textures.dirt}
          roughness={0.95}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
        />
      </mesh>

      {/* 7. Base Sliding Pit Circles (radius 13 ft at Y = 0.027) */}
      {[FIELD.BASE.FIRST, FIELD.BASE.SECOND, FIELD.BASE.THIRD].map((base, i) => (
        <mesh key={`pit-${i}`} position={[base.x, 0.027, base.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <circleGeometry args={[feetToM(13), 32]} />
          <meshStandardMaterial
            map={textures.dirt}
            roughness={0.95}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      ))}

      {/* 8. On-deck circles in foul territory at Y = 0.022 */}
      <mesh position={[feetToM(37), 0.022, feetToM(12)]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[feetToM(5), 24]} />
        <meshStandardMaterial
          map={textures.dirt}
          roughness={0.95}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>
      <mesh position={[-feetToM(37), 0.022, feetToM(12)]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[feetToM(5), 24]} />
        <meshStandardMaterial
          map={textures.dirt}
          roughness={0.95}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>

      {/* 9. Pitcher's Mound: Continuous Dirt Base Circle + Smooth Slanted Mound + Pitcher's Rubber Plate */}
      <mesh position={[MOUND.centre[0], 0.023, MOUND.centre[1]]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[feetToM(9), 32]} />
        <meshStandardMaterial map={textures.dirt} roughness={0.95} />
      </mesh>
      <group position={[MOUND.centre[0], MOUND.surface, MOUND.centre[1]]}>
        <mesh geometry={moundGeom} castShadow receiveShadow>
          <meshStandardMaterial map={textures.dirt} roughness={0.95} />
        </mesh>
        {/* Pitcher's Rubber (24" x 6" x 1.5"): the plate whose top the pitcher's
            pivot foot stands on, so its own thickness is read off MOUND and not
            repeated here (see constants/mound.js and moundSurfaceY). */}
        <mesh position={[0, MOUND.rise + MOUND.rubber.rise / 2, 0]} castShadow>
          <boxGeometry args={[MOUND.rubber.halfWidth * 2, MOUND.rubber.rise, MOUND.rubber.halfDepth * 2]} />
          <meshStandardMaterial color="#ffffff" roughness={0.4} />
        </mesh>
      </group>

      {/* 10. Home Plate: the 17-inch pentagon, stood where the ball's own world has it —
          its point at z = PLATE.pointZ (the pitch crosses there) and its back edge at
          z = PLATE.backZ. One slab of white rubber and nothing under it: a dark rim
          drawn between it and the dirt read as a second, black plate (see
          constants/field.js for the shape's own numbers). */}
      <mesh
        name="homePlate"
        geometry={homePlateGeom}
        position={[0, 0.035, PLATE.pointZ]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <meshStandardMaterial
          color="#ffffff"
          roughness={0.4}
          polygonOffset
          polygonOffsetFactor={-4}
          polygonOffsetUnits={-4}
        />
      </mesh>

      {/* 11. Chalk Lines: Batter's Boxes, Catcher's Box, and Coach's Boxes */}
      {chalkBoxes.map((bb) => (
        <mesh
          key={bb.name}
          name={bb.name}
          position={bb.pos}
          rotation={[-Math.PI / 2, 0, bb.yaw ?? 0]}
        >
          <planeGeometry args={bb.args} />
          <meshStandardMaterial
            color="#f8faf2"
            roughness={0.6}
            polygonOffset
            polygonOffsetFactor={-3}
            polygonOffsetUnits={-3}
          />
        </mesh>
      ))}

      {/* 12. Foul Lines (1B and 3B extending to outfield wall) */}
      {foulLines.map((fl, i) => (
        <mesh key={`fl-${i}`} position={fl.position} rotation={fl.rotation}>
          <planeGeometry args={fl.args} />
          <meshStandardMaterial
            color="#f8faf2"
            roughness={0.6}
            polygonOffset
            polygonOffsetFactor={-3}
            polygonOffsetUnits={-3}
          />
        </mesh>
      ))}

      {/* 13. Base Bags (1B, 2B, 3B): Voxel pillow cushions raised above the dirt */}
      {[FIELD.BASE.FIRST, FIELD.BASE.SECOND, FIELD.BASE.THIRD].map((base, i) => (
        <mesh
          key={`base-${i}`}
          geometry={baseBagGeometry}
          position={[base.x, 0.07, base.z]}
          rotation={[0, Math.PI / 4, 0]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial vertexColors roughness={0.55} />
        </mesh>
      ))}

      {/* 14. Outfield Wall: navy padded bays with rolled arrises, the yellow
          safety rail along them, and the distance markers as chamfered pads. */}
      <mesh name="outfield-wall-pads" geometry={wallGeometry.pads} castShadow receiveShadow>
        <meshStandardMaterial map={textures.wallPad} roughness={0.85} />
      </mesh>
      <mesh name="outfield-wall-rail" geometry={wallGeometry.rails} castShadow>
        <meshStandardMaterial vertexColors roughness={0.4} />
      </mesh>
      {distanceSigns.map((sign, i) => (
        <mesh
          key={`sign-${i}`}
          geometry={signGeometry}
          position={sign.position}
          rotation={[0, sign.yaw, 0]}
        >
          <meshStandardMaterial map={sign.tex} roughness={0.7} />
        </mesh>
      ))}

      {/* 15. Foul Poles with Pixelated Yellow Mesh Screen */}
      {foulPoles.map((pole, i) => (
        <group key={`pole-${i}`}>
          <mesh geometry={poleBaseGeometry} position={pole.basePos} castShadow receiveShadow>
            <meshStandardMaterial vertexColors roughness={0.6} />
          </mesh>
          {/* A ghosted mast: the pole has to read as the foul line's marker
              without masking what is behind it — the ball crossing it, the wall
              and the crowd it stands against. Only its front half is drawn (the
              back faces are culled) and it writes no depth, so it is a single
              pane of yellow rather than two superimposed shells, and the screen
              behind it still sorts cleanly. */}
          <mesh geometry={poleCollarGeometry} position={pole.collarPos} castShadow>
            <meshStandardMaterial vertexColors roughness={0.8} />
          </mesh>
          <mesh position={pole.polePos}>
            <cylinderGeometry args={pole.args} />
            {/* Physical rather than standard for one reason: `sheen` gives the
                mast a grazing-angle rim, so the ghosted yellow still draws its
                own silhouette against the unlit stands instead of dissolving
                into them. The emissive underneath keeps that rim lit. */}
            <meshPhysicalMaterial
              color="#ffeb3b"
              emissive="#3a2c05"
              emissiveIntensity={1.2}
              roughness={0.35}
              sheen={1}
              sheenColor="#ffe98a"
              sheenRoughness={0.55}
              transparent
              opacity={0.45}
              depthWrite={false}
            />
          </mesh>
          {/* The mesh screen is the brightest thing on the pole, so it has to
              be ghosted with the mast: at 0.85 it read as a solid yellow bar
              and the see-through mast behind it made no difference. It is a
              double-sided plane, so its two faces blend onto each other — 0.38
              apiece comes out around two thirds of a pane where they overlap,
              and less than that seen edge-on. */}
          <mesh position={pole.screenPos} rotation={pole.screenRot}>
            <planeGeometry args={pole.screenArgs} />
            <meshStandardMaterial
              color="#ffd600"
              roughness={0.6}
              side={THREE.DoubleSide}
              transparent
              opacity={0.38}
              depthWrite={false}
            />
          </mesh>
        </group>
      ))}

      {/* 16. Grass Tufts poking out from the field (InstancedMesh) */}
      <instancedMesh
        ref={tuftMeshRef}
        args={[tuftGeom, tuftMat, tuftInstances.length]}
        material={tuftMat}
        frustumCulled={false}
        castShadow
        receiveShadow
      />

      {/* 17. 4-Blade Grass Clusters along warning track and foul territory (InstancedMesh) */}
      <instancedMesh
        ref={shrubMeshRef}
        args={[shrubGeom, shrubMat, shrubInstances.length]}
        material={shrubMat}
        frustumCulled={false}
        castShadow
        receiveShadow
      />

      {/* 18. Stadium Grandstands, Fascia Ribbon, 3D Stadium Seats & Safety Railings */}
      <mesh name="outfield-stands" geometry={outfieldStandsGeom} material={standsMat} receiveShadow />
      {/* The stone coping along both stands' rear facades: the cap the corner's
          abutment piers (and the grandstand's, at each pole) climb to, so the
          two buildings finish on the block's own band instead of on the bare
          edge of their eaves (see createBleacherCopingGeometry and
          createGrandstandCopingGeometry). */}
      <mesh name="bleacher-coping" geometry={bleacherCopingGeom} material={standsMat} castShadow receiveShadow />
      <mesh name="grandstand-coping" geometry={grandstandCopingGeom} material={standsMat} castShadow receiveShadow />
      {/* The corner: the bleachers' rows carried round past the foul pole, the
          brick wall that ends them on the corner's radial section line, and the
          side stand's end closing the court beside it -- cut back to that same
          line so it no longer runs across the bleachers' frontage (see
          createCornerWallGeometry and createSideEndWallGeometry). The two ends
          stand apart, and the court between them is planted with kerbed turf
          (createCornerBedGeometry, createCornerBedKerbGeometry). The padded
          wall itself runs on past both poles to the section line, so the field
          wall does not change character at the corner. */}
      <mesh name="corner-wall" geometry={cornerWallGeom} material={wallMats} castShadow receiveShadow />
      <mesh name="side-end-wall" geometry={sideEndWallGeom} material={wallMats} castShadow receiveShadow />
      <mesh name="corner-bed" geometry={cornerBedGeom} material={cornerBedMat} receiveShadow />
      {/* The bank's leaves in the round: blocky clumps along the crest and down
          the batter, so its edge against the sky is ragged rather than the
          straight line where the turf plane ends (see
          createCornerBedClumpsGeometry). */}
      <mesh name="corner-bed-clumps" geometry={cornerBedClumpsGeom} material={cornerClumpsMat} castShadow receiveShadow />
      <mesh name="corner-bed-kerb" geometry={cornerBedKerbGeom} material={standsMat} castShadow receiveShadow />
      {/* The batter's eye, closing the middle of the back bleachers: the cloth,
          and the concrete frame that sets it into the stand (see
          createBattersEyeGeometry and createBattersEyeFrameGeometry). */}
      <mesh name="batters-eye" geometry={battersEyeGeom} material={battersEyeMat} castShadow receiveShadow />
      <mesh name="batters-eye-frame" geometry={battersEyeFrameGeom} material={standsMat} castShadow receiveShadow />
      <mesh geometry={infieldStandsGeom} material={standsMat} receiveShadow />
      <mesh name="aisle-treads" geometry={aisleTreadsGeom} material={standsMat} receiveShadow />
      <mesh name="aisle-handrails" geometry={aisleHandrailsGeom} material={railingMat} castShadow />
      <mesh name="stands-seats" geometry={standsSeatsGeom} material={seatsMat} />
      <mesh geometry={fasciaRibbonGeom} material={ribbonMat} receiveShadow />
      <mesh geometry={backstopWallGeom} material={backstopMat} receiveShadow />
      <mesh geometry={railingsGeom} material={railingMat} castShadow />

      {/* 18b. The stadium above and around the bowl: the canopy that runs right
          round the park with its columns and flags, and the press box hung
          under it behind the plate. */}
      <mesh name="grandstand-roof" geometry={grandstandRoofGeom} material={canopyMat} castShadow receiveShadow />
      <mesh name="bleacher-roof" geometry={bleacherRoofGeom} material={canopyMat} castShadow receiveShadow />
      <mesh geometry={pressBoxGeom} material={structureMat} castShadow receiveShadow />
      {/* 18c. The flags along both ridges, flown by the clock's wind. */}
      <FlagWave />

      {/* 19. Stadium Light Towers (Detailed Lattice Steel Truss + Aimed Glowing Halogen Bulbs) */}
      <mesh geometry={lightTowersTrussGeom} material={towerTrussMat} castShadow />
      <mesh geometry={lightTowersBulbsGeom} material={towerBulbMat} />

      {/* 20. 8-Bit Pixel Art Audience (8 Character Variants with Multi-Tone Pixel Gradients) */}
      {audienceByVariant.map((fans, vIdx) => (
        <instancedMesh
          key={`fan-variant-${vIdx}`}
          name={`fans-${vIdx}`}
          ref={fanMeshRefs[vIdx]}
          args={[fanQuadGeom, fanMaterials[vIdx], fans.length]}
          material={fanMaterials[vIdx]}
          frustumCulled={false}
          castShadow
        />
      ))}

      {/* 20b. The legs of the fans standing up in a show row */}
      {showLegs.length > 0 && (
        <instancedMesh
          ref={legMeshRef}
          name="crowd-legs"
          args={[legGeom, legMat, showLegs.length]}
          material={legMat}
          frustumCulled={false}
          castShadow
        />
      )}

      {/* 21. The crowd's little shows: shouting clusters (pixel voice marks +
          a long banner held together) and instrument clusters (cut-out trumpets
          and drums with big musical notes rising above the players). */}
      <CrowdShow groups={crowdGroups} />

      {/* 22. The dynamic billboard: the park's big screen over the
          center-field stands, redrawn live from the game state. */}
      <DynamicBillboard gameState={gameState} />
    </group>
  )
}
