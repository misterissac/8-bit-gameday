import React, { useMemo, useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BATTER_BOX, BATTER_BOXES, CATCHER_BOX, FIELD, PLATE } from '../constants/field'
import { MOUND, createMoundGeometry } from '../constants/mound'
import { feetToM } from '../util/MathUtil'

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

  // Non-slip stadium concrete palette (dithered concrete tones)
  const cBase = '#354338'
  const cLight = '#3e4f42'
  const cDark = '#2c372f'
  const cFleck = '#4b5e50'
  const cJoint = '#202822'
  const cCurb = '#4e6153'

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

    // Wide starry excited eyes with sharp black pupils
    ctx.fillStyle = '#111822'; ctx.fillRect(12, 11, 3, 3)
    ctx.fillStyle = '#111822'; ctx.fillRect(17, 11, 3, 3)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(12, 11, 2, 2) // Huge shiny glint
    ctx.fillStyle = '#ffffff'; ctx.fillRect(17, 11, 2, 2)
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 12, 1, 1) // Black pupil!
    ctx.fillStyle = '#111822'; ctx.fillRect(18, 12, 1, 1) // Black pupil!

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

    // Stunned wide eyes (white sclera around dark center)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(12, 11, 3, 3)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(17, 11, 3, 3)
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 12, 2, 2)
    ctx.fillStyle = '#111822'; ctx.fillRect(17, 12, 2, 2)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(13, 12, 1, 1)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(17, 12, 1, 1)

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

    // Anxious wide eyes staring intensely at full count
    ctx.fillStyle = '#111822'; ctx.fillRect(12, 12, 3, 2)
    ctx.fillStyle = '#111822'; ctx.fillRect(17, 12, 3, 2)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(12, 12, 1, 1)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(17, 12, 1, 1)

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

    // Left Eye: Big sparkle starry eye with sharp black pupil
    ctx.fillStyle = '#111822'; ctx.fillRect(12, 11, 3, 3)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(12, 11, 2, 2)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(14, 13, 1, 1)
    ctx.fillStyle = '#111822'; ctx.fillRect(13, 12, 1, 1) // Black pupil!

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

// Infield grandstands bowl: Unified continuous grandstand wrapping seamlessly
// from Left Field Foul Pole, down 3B foul line, around backstop behind batter,
// down 1B foul line, to Right Field Foul Pole!
function createInfieldStandsGeometry() {
  const curve = INFIELD_STANDS_CURVE
  const tiers = [
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
    { d: 12.8, y: 6.35, isRiser: true },  // Upper deck tread 4
    { d: 12.8, y: 7.60, isRiser: false }, // Rear stadium facade top
  ]

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

  const colSeatTread = new THREE.Color('#253d28')
  const colSeatRiser = new THREE.Color('#192b1b')
  const colConcourse = new THREE.Color('#38463c')
  const colFrontWall = new THREE.Color('#142217')
  const colBackFacade = new THREE.Color('#1e2722')

  for (let r = 0; r < tiers.length; r++) {
    const { d, y, isRiser } = tiers[r]
    let col = colSeatTread
    if (r === 0 || r === 1) col = colFrontWall
    else if (r === 14) col = colConcourse
    else if (r >= 23) col = colBackFacade
    else if (isRiser) col = colSeatTread
    else col = colSeatRiser

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

// Outfield bleachers: 7 tiers rising behind outfield wall, connecting LF pole to RF pole
function createOutfieldStandsGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []
  const uvs = []

  const startAngle = -Math.PI / 4
  const endAngle = Math.PI / 4
  const numRadial = 64
  const numTiers = 7
  const rStart = feetToM(332.0)
  const tierDepth = 1.35
  const tierHeight = 0.52
  const baseHeight = 2.45

  const treadColor = new THREE.Color('#253d28')
  const riserColor = new THREE.Color('#192b1b')
  const wallColor = new THREE.Color('#141e28')

  function addQuad(pA, pB, pC, pD, normal, col) {
    positions.push(...pA, ...pB, ...pC, ...pA, ...pC, ...pD)
    for (let k = 0; k < 6; k++) {
      normals.push(normal[0], normal[1], normal[2])
      colors.push(col.r, col.g, col.b)
      uvs.push(0, 0)
    }
  }

  for (let t = 0; t < numTiers; t++) {
    const r0 = rStart + t * tierDepth
    const r1 = r0 + tierDepth
    const yTread = baseHeight + t * tierHeight
    const yNext = baseHeight + (t + 1) * tierHeight

    for (let i = 0; i < numRadial; i++) {
      const a0 = startAngle + (endAngle - startAngle) * (i / numRadial)
      const a1 = startAngle + (endAngle - startAngle) * ((i + 1) / numRadial)

      const sin0 = Math.sin(a0), cos0 = Math.cos(a0)
      const sin1 = Math.sin(a1), cos1 = Math.cos(a1)

      // Horizontal Tread
      const pA = [r0 * sin0, yTread, -r0 * cos0]
      const pB = [r0 * sin1, yTread, -r0 * cos1]
      const pC = [r1 * sin1, yTread, -r1 * cos1]
      const pD = [r1 * sin0, yTread, -r1 * cos0]
      addQuad(pA, pB, pC, pD, [0, 1, 0], treadColor)

      // Vertical Riser
      const midA = (a0 + a1) / 2
      const nR = [-Math.sin(midA), 0, Math.cos(midA)]
      const pR1 = [r1 * sin0, yTread, -r1 * cos0]
      const pR2 = [r1 * sin1, yTread, -r1 * cos1]
      const pR3 = [r1 * sin1, yNext, -r1 * cos1]
      const pR4 = [r1 * sin0, yNext, -r1 * cos0]
      addQuad(pR1, pR2, pR3, pR4, nR, riserColor)
    }
  }

  // Back Wall Facade
  const rBack = rStart + numTiers * tierDepth
  const yBackTop = baseHeight + numTiers * tierHeight + 1.2
  for (let i = 0; i < numRadial; i++) {
    const a0 = startAngle + (endAngle - startAngle) * (i / numRadial)
    const a1 = startAngle + (endAngle - startAngle) * ((i + 1) / numRadial)
    const sin0 = Math.sin(a0), cos0 = Math.cos(a0)
    const sin1 = Math.sin(a1), cos1 = Math.cos(a1)
    const midA = (a0 + a1) / 2
    const nR = [-Math.sin(midA), 0, Math.cos(midA)]

    const yBottom = baseHeight + numTiers * tierHeight
    const p1 = [rBack * sin0, yBottom, -rBack * cos0]
    const p2 = [rBack * sin1, yBottom, -rBack * cos1]
    const p3 = [rBack * sin1, yBackTop, -rBack * cos1]
    const p4 = [rBack * sin0, yBackTop, -rBack * cos0]
    addQuad(p1, p2, p3, p4, nR, wallColor)
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return geom
}

// Padded Backstop Wall geometry with sponsor billboards directly behind home plate / batter
function createBackstopWallGeometry() {
  const geom = new THREE.BufferGeometry()
  const w = 18.0
  const h = 0.90
  const z = 15.6
  const positions = new Float32Array([
    -w / 2, 0.05, z,  w / 2, 0.05, z,  w / 2, 0.05 + h, z,
    -w / 2, 0.05, z,  w / 2, 0.05 + h, z,  -w / 2, 0.05 + h, z,
  ])
  const normals = new Float32Array([
    0, 0, -1,  0, 0, -1,  0, 0, -1,
    0, 0, -1,  0, 0, -1,  0, 0, -1,
  ])
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,
    0, 0,  1, 1,  0, 1,
  ])
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
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
  const { cx, cy, cz, sx, sy, sz, yaw = 0, pitch = 0, col, faceColors, faceUvs } = opts
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

// 4 Stadium Light Towers: Tapered Steel Lattice Truss Structure, Catwalk, Ladder & Housings
// Fixed: Behind-batter lights face forward directly toward pitcher & home plate!
function createLightTowersTrussGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const colors = []

  const TOWERS = [
    { x: -76.0, z: -68.0, tx: -15.0, tz: -25.0, name: 'LF' },
    { x: -28.0, z: 20.0,  tx: 0.0,   tz: -10.0, name: '3B/Plate' },
    { x: 28.0,  z: 20.0,  tx: 0.0,   tz: -10.0, name: '1B/Plate' },
    { x: 76.0,  z: -68.0, tx: 15.0,  tz: -25.0, name: 'RF' },
  ]

  const colSteel = new THREE.Color('#1a2b1c') // hunter steel green
  const colCatwalk = new THREE.Color('#314234') // galvanized catwalk steel
  const colHousing = new THREE.Color('#141e15') // dark floodlight pod casing
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
      addTransformedBox(positions, normals, colors, {
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
      addTransformedBox(positions, normals, colors, {
        cx: t.x, cy: yTier, cz: t.z + (wTier / 2) * Math.cos(yaw),
        sx: wTier, sy: 0.22, sz: 0.22, yaw, col: colSteel
      })
      addTransformedBox(positions, normals, colors, {
        cx: t.x, cy: yTier, cz: t.z - (wTier / 2) * Math.cos(yaw),
        sx: wTier, sy: 0.22, sz: 0.22, yaw, col: colSteel
      })
      addTransformedBox(positions, normals, colors, {
        cx: t.x - (wTier / 2) * Math.sin(yaw), cy: yTier, cz: t.z,
        sx: 0.22, sy: 0.22, sz: wTier, yaw, col: colSteel
      })
      addTransformedBox(positions, normals, colors, {
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

      addTransformedBox(positions, normals, colors, {
        cx: t.x, cy: yMid, cz: t.z + (wMid / 2) * Math.cos(yaw),
        sx: len, sy: 0.14, sz: 0.14, yaw: yaw + ang * 0.15, col: colSteel
      })
      addTransformedBox(positions, normals, colors, {
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
      addTransformedBox(positions, normals, colors, {
        cx: rx, cy: yr, cz: rz, sx: 0.55, sy: 0.08, sz: 0.08, yaw, col: colCatwalk
      })
    }

    // 5. Technician Service Catwalk Platform (at y = 19.8m)
    addTransformedBox(positions, normals, colors, {
      cx: t.x, cy: 19.8, cz: t.z, sx: 3.2, sy: 0.18, sz: 2.4, yaw, col: colCatwalk
    })
    addTransformedBox(positions, normals, colors, {
      cx: t.x, cy: 20.35, cz: t.z + 1.15 * Math.cos(yaw), sx: 3.2, sy: 0.9, sz: 0.08, yaw, col: colCatwalk
    })
    addTransformedBox(positions, normals, colors, {
      cx: t.x, cy: 20.35, cz: t.z - 1.15 * Math.cos(yaw), sx: 3.2, sy: 0.9, sz: 0.08, yaw, col: colCatwalk
    })
    // High-voltage transformer box
    addTransformedBox(positions, normals, colors, {
      cx: t.x - 0.8 * Math.sin(yaw), cy: 20.3, cz: t.z - 0.8 * Math.cos(yaw),
      sx: 0.8, sy: 0.8, sz: 0.6, yaw, col: colSteel
    })
    addTransformedBox(positions, normals, colors, {
      cx: t.x - 0.8 * Math.sin(yaw), cy: 20.3, cz: t.z - 0.8 * Math.cos(yaw),
      sx: 0.85, sy: 0.15, sz: 0.65, yaw, col: colYellow
    })

    // 6. Angled Floodlight Head Frame (Pitched down -18° toward field)
    const headY = 21.6
    const headZLocal = 0.45
    const headXWorld = t.x + headZLocal * Math.sin(yaw)
    const headZWorld = t.z + headZLocal * Math.cos(yaw)

    addTransformedBox(positions, normals, colors, {
      cx: headXWorld, cy: headY - 0.8, cz: headZWorld, sx: 5.6, sy: 0.25, sz: 0.25, yaw, pitch, col: colSteel
    })
    addTransformedBox(positions, normals, colors, {
      cx: headXWorld, cy: headY + 0.8, cz: headZWorld, sx: 5.6, sy: 0.25, sz: 0.25, yaw, pitch, col: colSteel
    })
    for (let c = -2; c <= 2; c++) {
      const colOffset = c * 1.1
      const cWorldX = headXWorld + colOffset * Math.cos(yaw)
      const cWorldZ = headZWorld - colOffset * Math.sin(yaw)
      addTransformedBox(positions, normals, colors, {
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

        addTransformedBox(positions, normals, colors, {
          cx: wx, cy: wy, cz: wz, sx: podW, sy: podH, sz: podD, yaw, pitch, col: colHousing
        })
        const hoodZ = pz + 0.12
        const hwx = headXWorld + px * cosY + hoodZ * sinY
        const hwy = headY + (ly + podH / 2) * cosP - hoodZ * sinP
        const hwz = headZWorld - px * sinY + hoodZ * cosY
        addTransformedBox(positions, normals, colors, {
          cx: hwx, cy: hwy, cz: hwz, sx: podW + 0.06, sy: 0.08, sz: 0.24, yaw, pitch, col: colSteel
        })
      }
    }
  })

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.computeVertexNormals()
  return geom
}

// Glowing Halogen Floodlight Bulbs Geometry (15 bulbs per tower = 60 glowing pixel fixtures)
function createLightTowersBulbsGeometry() {
  const geom = new THREE.BufferGeometry()
  const positions = []
  const normals = []
  const uvs = []

  const TOWERS = [
    { x: -76.0, z: -68.0, tx: -15.0, tz: -25.0 },
    { x: -28.0, z: 20.0,  tx: 0.0,   tz: -10.0 },
    { x: 28.0,  z: 20.0,  tx: 0.0,   tz: -10.0 },
    { x: 76.0,  z: -68.0, tx: 15.0,  tz: -25.0 },
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

  // 1. Infield Grandstands Seats (10 Rows: 6 Lower Bowl + 4 Upper Deck)
  const curve = INFIELD_STANDS_CURVE
  const INFIELD_ROWS = [
    // Lower Bowl
    { dSeat: 0.85, yFloor: 0.95 },
    { dSeat: 2.05, yFloor: 1.45 },
    { dSeat: 3.25, yFloor: 1.95 },
    { dSeat: 4.45, yFloor: 2.45 },
    { dSeat: 5.65, yFloor: 2.95 },
    { dSeat: 6.85, yFloor: 3.45 },
    // Upper Deck
    { dSeat: 9.45, yFloor: 4.55 },
    { dSeat: 10.45, yFloor: 5.15 },
    { dSeat: 11.45, yFloor: 5.75 },
    { dSeat: 12.45, yFloor: 6.35 },
  ]

  const numSeatsPerRow = 220

  INFIELD_ROWS.forEach((row) => {
    const { dSeat, yFloor } = row

    for (let s = 0; s < numSeatsPerRow; s++) {
      // 2-seat aisle gaps every 14 seats for clean stadium aisles
      if (s % 14 >= 12) continue

      const t = 0.015 + (0.97 * s) / numSeatsPerRow
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
      addTransformedBox(positions, normals, colors, uvs, {
        cx, cy, cz,
        sx: 0.46, sy: 0.16, sz: 0.38,
        yaw,
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
      addTransformedBox(positions, normals, colors, uvs, {
        cx: bx, cy: by, cz: bz,
        sx: 0.46, sy: 0.34, sz: 0.12,
        yaw,
        col: faceColors[4],
        faceColors,
        faceUvs: backrestUvs,
      })
    }
  })

  // 2. Outfield Bleachers Seats (7 Radial Tiers from LF to RF)
  const numBleacherTiers = 7
  const rStart = feetToM(332.0)
  const tierDepth = 1.35
  const tierHeight = 0.52
  const baseHeight = 2.45
  const startAng = -Math.PI / 4 * 0.95
  const endAng = Math.PI / 4 * 0.95
  const numBleacherSeats = 96

  for (let t = 0; t < numBleacherTiers; t++) {
    const yFloor = baseHeight + t * tierHeight
    const rSeat = rStart + t * tierDepth + tierDepth - 0.40

    for (let s = 0; s < numBleacherSeats; s++) {
      if (s % 12 >= 10) continue // Aisle gap

      const ang = startAng + (endAng - startAng) * (s / numBleacherSeats)
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
      addTransformedBox(positions, normals, colors, uvs, {
        cx, cy, cz,
        sx: 0.48, sy: 0.16, sz: 0.38,
        yaw,
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
      addTransformedBox(positions, normals, colors, uvs, {
        cx: bx, cy: by, cz: bz,
        sx: 0.48, sy: 0.34, sz: 0.12,
        yaw,
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
  geom.computeVertexNormals()
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

    addTransformedBox(positions, normals, colors, {
      cx: fMidX, cy: 1.18, cz: fMidZ, sx: 0.06, sy: 0.06, sz: fLen * 1.02, yaw: fYaw, col: colYellow
    })

    if (i % 3 === 0) {
      addTransformedBox(positions, normals, colors, {
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

    addTransformedBox(positions, normals, colors, {
      cx: cMidX, cy: 4.32, cz: cMidZ, sx: 0.06, sy: 0.06, sz: cLen * 1.02, yaw: cYaw, col: colRail
    })
    addTransformedBox(positions, normals, colors, {
      cx: cMidX, cy: 4.62, cz: cMidZ, sx: 0.06, sy: 0.06, sz: cLen * 1.02, yaw: cYaw, col: colRail
    })
    if (i % 3 === 0) {
      addTransformedBox(positions, normals, colors, {
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


// The chalked lines' own width, in metres: the strips the boxes are drawn with.
const CHALK_LINE_W = 0.07

export const Ballpark = () => {
  const tuftMeshRef = useRef(null)
  const shrubMeshRef = useRef(null)
  const fanMeshRef0 = useRef(null)
  const fanMeshRef1 = useRef(null)
  const fanMeshRef2 = useRef(null)
  const fanMeshRef3 = useRef(null)
  const fanMeshRef4 = useRef(null)
  const fanMeshRef5 = useRef(null)
  const fanMeshRef6 = useRef(null)
  const fanMeshRef7 = useRef(null)
  const fanMeshRefs = useMemo(
    () => [
      fanMeshRef0,
      fanMeshRef1,
      fanMeshRef2,
      fanMeshRef3,
      fanMeshRef4,
      fanMeshRef5,
      fanMeshRef6,
      fanMeshRef7,
    ],
    [],
  )

  const fanDummyObj = useMemo(() => new THREE.Object3D(), [])

  // Initialize and memoize procedural textures
  const textures = useMemo(() => {
    const grass = createPixelGrassTexture()
    grass.repeat.set(20, 20)

    const infieldGrass = createInfieldGrassTexture()
    infieldGrass.repeat.set(12, 12)

    const dirt = createPixelDirtTexture()
    dirt.repeat.set(24, 24)

    const warningTrack = createWarningTrackTexture()
    warningTrack.repeat.set(28, 4)

    const wallPad = createWallPadTexture()
    const tuft = create3BladeGrassTexture()
    const shrub = create4BladeGrassTexture()

    const signs = {
      1: createDistanceSignTexture('330'),
      7: createDistanceSignTexture('375'),
      15: createDistanceSignTexture('400'),
      22: createDistanceSignTexture('375'),
      28: createDistanceSignTexture('330'),
    }

    const stands = createPixelStandsTexture()
    stands.repeat.set(24, 6)

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

    return {
      grass,
      infieldGrass,
      dirt,
      warningTrack,
      wallPad,
      tuft,
      shrub,
      signs,
      stands,
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
  const infieldStandsGeom = useMemo(() => createInfieldStandsGeometry(), [])
  const standsSeatsGeom = useMemo(() => createStandsSeatsGeometry(), [])
  const backstopWallGeom = useMemo(() => createBackstopWallGeometry(), [])
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
      const startAngle = -Math.PI / 4 * 0.95
      const endAngle = Math.PI / 4 * 0.95
      const numTiers = 7
      const rStart = feetToM(332.0)
      const tierDepth = 1.35
      const tierHeight = 0.52
      const baseHeight = 2.45

      for (let t = 0; t < numTiers; t++) {
        const r = rStart + t * tierDepth + tierDepth - 0.40
        const y = baseHeight + t * tierHeight + 0.16 // sits squarely on seat cushion
        const count = 48
        for (let i = 0; i < count; i++) {
          if (crowdRng() < 0.16) continue // leave empty seats visible
          const angle = startAngle + (endAngle - startAngle) * ((i + 0.5 + (crowdRng() - 0.5) * 0.35) / count)
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
          })
        }
      }
    }

    // (B) Infield Grandstands Audience: Seated in 3D stadium chairs along the continuous spline!
    {
      const seatRows = [
        { d: 0.85, yFloor: 0.95 },
        { d: 2.05, yFloor: 1.45 },
        { d: 3.25, yFloor: 1.95 },
        { d: 4.45, yFloor: 2.45 },
        { d: 5.65, yFloor: 2.95 },
        { d: 6.85, yFloor: 3.45 },
        { d: 9.45, yFloor: 4.55 },
        { d: 10.45, yFloor: 5.15 },
        { d: 11.45, yFloor: 5.75 },
        { d: 12.45, yFloor: 6.35 },
      ]

      seatRows.forEach((sr, sIdx) => {
        const count = sIdx < 6 ? 64 : 48
        for (let i = 0; i < count; i++) {
          if (crowdRng() < 0.18) continue // empty seats
          const tSpline = 0.02 + 0.96 * ((i + 0.5 + (crowdRng() - 0.5) * 0.3) / count)
          const p = INFIELD_STANDS_CURVE.getPoint(tSpline)
          const tan = INFIELD_STANDS_CURVE.getTangent(tSpline).normalize()
          const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize()

          const x = p.x + sr.d * n.x
          const z = p.z + sr.d * n.z
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
          })
        }
      })
    }

    return list
  }, [])

  // Partition audience into 8 variant lists for individual instancing
  const audienceByVariant = useMemo(() => {
    const groups = [[], [], [], [], [], [], [], []]
    audienceList.forEach((fan) => {
      groups[fan.variant].push(fan)
    })
    return groups
  }, [audienceList])

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
      textures.dirt.dispose()
      textures.warningTrack.dispose()
      textures.wallPad.dispose()
      textures.tuft.dispose()
      textures.shrub.dispose()
      textures.stands.dispose()
      textures.backstopAd.dispose()
      textures.ribbon.dispose()
      textures.seats.dispose()
      textures.fans.forEach((t) => t.dispose())
      Object.values(textures.signs).forEach((t) => t.dispose())

      tuftGeom.dispose()
      shrubGeom.dispose()
      moundGeom.dispose()
      outfieldStandsGeom.dispose()
      infieldStandsGeom.dispose()
      standsSeatsGeom.dispose()
      backstopWallGeom.dispose()
      lightTowersTrussGeom.dispose()
      lightTowersBulbsGeom.dispose()
      railingsGeom.dispose()
      fasciaRibbonGeom.dispose()
      fanQuadGeom.dispose()

      standsMat.dispose()
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
    infieldStandsGeom,
    standsSeatsGeom,
    backstopWallGeom,
    lightTowersTrussGeom,
    lightTowersBulbsGeom,
    railingsGeom,
    fasciaRibbonGeom,
    fanQuadGeom,
    standsMat,
    seatsMat,
    backstopMat,
    ribbonMat,
    towerTrussMat,
    towerBulbMat,
    railingMat,
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

  // Outfield wall segments, top safety rail, and distance signs
  const wallSegments = useMemo(() => {
    const height = feetToM(8)
    const thickness = feetToM(1.2)
    const count = 30
    const startAngle = -Math.PI / 4
    const endAngle = Math.PI / 4
    const arcLength = (WALL_RADIUS * (endAngle - startAngle)) / count

    const segments = []
    for (let i = 0; i < count; i++) {
      const a0 = startAngle + (endAngle - startAngle) * (i / count)
      const a1 = startAngle + (endAngle - startAngle) * ((i + 1) / count)
      const mid = (a0 + a1) / 2
      const x = WALL_RADIUS * Math.sin(mid)
      const z = -WALL_RADIUS * Math.cos(mid)

      const signTex = textures.signs[i] || null
      const signPos = signTex
        ? [x - Math.sin(mid) * (thickness / 2 + 0.06), height * 0.55, z + Math.cos(mid) * (thickness / 2 + 0.06)]
        : null

      segments.push({
        position: [x, height / 2, z],
        railPosition: [x, height + 0.11, z],
        rotation: [0, -mid, 0],
        scale: [arcLength * 1.01, height, thickness],
        railScale: [arcLength * 1.01, 0.22, thickness * 1.08],
        signPos,
        signTex,
      })
    }
    return segments
  }, [textures.signs])

  // Foul poles
  const foulPoles = useMemo(() => {
    const poleHeight = feetToM(24)
    return [-1, 1].map((side) => {
      const angle = side * (Math.PI / 4)
      const px = WALL_RADIUS * Math.sin(angle)
      const pz = -WALL_RADIUS * Math.cos(angle)
      return {
        polePos: [px, poleHeight / 2, pz],
        screenPos: [px + (side === -1 ? 0.4 : -0.4), poleHeight * 0.6, pz],
        screenRot: [0, (side === -1 ? 1 : -1) * (Math.PI / 4), 0],
        args: [0.18, 0.22, poleHeight, 16],
        screenArgs: [feetToM(2.5), poleHeight * 0.7],
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

    for (let vIdx = 0; vIdx < fanMeshRefs.length; vIdx++) {
      const mesh = fanMeshRefs[vIdx].current
      if (!mesh) continue
      const fans = audienceByVariant[vIdx]

      for (let i = 0; i < fans.length; i++) {
        const fan = fans[i]
        // 1. Individual joyful rhythmic bounce
        const individualBob = Math.abs(Math.sin(time * fan.freq + fan.phase)) * fan.amp
        // 2. Stadium wave propagating across the seating arc
        const wave = Math.sin(time * 3.0 - fan.angle * 3.5)
        const waveBoost = wave > 0.65 ? (wave - 0.65) * 0.28 : 0

        dummy.position.set(fan.x, fan.baseY + individualBob + waveBoost, fan.z)
        dummy.rotation.set(-0.08, fan.yaw, 0)
        dummy.scale.set(fan.scaleX, fan.scaleY, 1.0)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
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
        <mesh key={`base-${i}`} position={[base.x, 0.07, base.z]} rotation={[0, Math.PI / 4, 0]} castShadow>
          <boxGeometry args={[feetToM(1.5), 0.09, feetToM(1.5)]} />
          <meshStandardMaterial color="#f5f5f5" roughness={0.5} />
        </mesh>
      ))}

      {/* 14. Outfield Wall: Navy stadium pads, yellow safety rail, and distance markers */}
      {wallSegments.map((seg, i) => (
        <group key={`wall-${i}`}>
          <mesh position={seg.position} rotation={seg.rotation} scale={seg.scale} castShadow receiveShadow>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial map={textures.wallPad} roughness={0.85} />
          </mesh>
          <mesh position={seg.railPosition} rotation={seg.rotation} scale={seg.railScale} castShadow>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="#fbc02d" roughness={0.35} />
          </mesh>
          {seg.signTex && (
            <mesh position={seg.signPos} rotation={seg.rotation}>
              <planeGeometry args={[feetToM(8), feetToM(4)]} />
              <meshBasicMaterial map={seg.signTex} />
            </mesh>
          )}
        </group>
      ))}

      {/* 15. Foul Poles with Pixelated Yellow Mesh Screen */}
      {foulPoles.map((pole, i) => (
        <group key={`pole-${i}`}>
          <mesh position={pole.polePos} castShadow>
            <cylinderGeometry args={pole.args} />
            <meshStandardMaterial color="#ffeb3b" emissive="#443300" roughness={0.3} />
          </mesh>
          <mesh position={pole.screenPos} rotation={pole.screenRot}>
            <planeGeometry args={pole.screenArgs} />
            <meshStandardMaterial
              color="#ffd600"
              roughness={0.6}
              side={THREE.DoubleSide}
              transparent
              opacity={0.85}
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
      <mesh geometry={outfieldStandsGeom} material={standsMat} receiveShadow />
      <mesh geometry={infieldStandsGeom} material={standsMat} receiveShadow />
      <mesh geometry={standsSeatsGeom} material={seatsMat} />
      <mesh geometry={fasciaRibbonGeom} material={ribbonMat} receiveShadow />
      <mesh geometry={backstopWallGeom} material={backstopMat} receiveShadow />
      <mesh geometry={railingsGeom} material={railingMat} castShadow />

      {/* 19. Stadium Light Towers (Detailed Lattice Steel Truss + Aimed Glowing Halogen Bulbs) */}
      <mesh geometry={lightTowersTrussGeom} material={towerTrussMat} castShadow />
      <mesh geometry={lightTowersBulbsGeom} material={towerBulbMat} />

      {/* 20. 8-Bit Pixel Art Audience (8 Character Variants with Multi-Tone Pixel Gradients) */}
      {audienceByVariant.map((fans, vIdx) => (
        <instancedMesh
          key={`fan-variant-${vIdx}`}
          ref={fanMeshRefs[vIdx]}
          args={[fanQuadGeom, fanMaterials[vIdx], fans.length]}
          material={fanMaterials[vIdx]}
          frustumCulled={false}
          castShadow
        />
      ))}
    </group>
  )
}
