import React, { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { feetToM } from '../util/MathUtil'
import { createChamferedBoxGeometry } from '../util/roundedGeometry'
import {
  drawBillboard,
  boardKey,
  quantizeHeadshot,
  CANVAS_W,
  CANVAS_H,
} from '../util/billboard'

// ---------------------------------------------------------------------------
// The dynamic billboard: the park's big screen, driven by the live game state.
// The board's content is the solomon-gumball reference's jumbotron, ported in
// util/billboard.js (batter card + 17-column scoring grid); this component
// only owns the texture and the meshes. The board is drawn onto one canvas
// whenever the visible state changes (boardKey below) and the canvas rides a
// NearestFilter texture so the whole board reads as one 8-bit LED matrix,
// matching the ribbon and the distance signs next to it.
//
// The one picture on the board is the batter's headshot, cut into the
// reference's quantized blocks exactly as its FilteredPhoto does: the photo is
// downloaded once per batter, quantized offscreen (see quantizeHeadshot) and
// painted into the card's corner. Without a photo the board grows a
// deterministic pixel face in its place instead.
// ---------------------------------------------------------------------------

// Where the board stands: above the center-field bleachers, facing home plate.
// The outfield seats top out around 341 ft; the board hangs just behind and
// above them (a plane's +z face looks toward home at this yaw).
const BOARD_POSITION = [0, 11.5, -feetToM(352)]
// The reference's screen ratio (194/80), so the board keeps the port's shape.
const BOARD_SIZE = [22, (22 * 80) / 194]

const HEADSHOT = 300
const HEADSHOT_URL = (id) =>
  `https://img.mlbstatic.com/mlb-photos/image/upload/w_300,q_100/v1/people/${id}/headshot/silo/current`

// Quantize a loaded headshot the reference's way, on an offscreen canvas the
// board can simply paint into its corner.
function quantizedHeadshot(image) {
  const canvas = document.createElement('canvas')
  canvas.width = HEADSHOT
  canvas.height = HEADSHOT
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, HEADSHOT, HEADSHOT)
  ctx.drawImage(image, 0, 0, HEADSHOT, HEADSHOT)
  const pixels = ctx.getImageData(0, 0, HEADSHOT, HEADSHOT)
  quantizeHeadshot(pixels, 4)
  ctx.putImageData(pixels, 0, 0)
  return canvas
}

// The board's furniture is cast, not sawn: every housing, mast and truss beam
// is a chamfered box, so the mount rolls its highlights along its edges the way
// the ballpark's own props do. Geometries are per size and disposed with the
// mesh, exactly like the <boxGeometry> this replaces.
function SoftBox({ size, bevel = 0.08, ...props }) {
  const [w, h, d] = size
  const geometry = useMemo(
    () => createChamferedBoxGeometry({ size: [w, h, d], bevel }),
    [w, h, d, bevel],
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  return <mesh geometry={geometry} {...props} />
}

export function DynamicBillboard({ gameState, position = BOARD_POSITION, size = BOARD_SIZE }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = CANVAS_W
    canvas.height = CANVAS_H
    const ctx = canvas.getContext('2d')
    drawBillboard(ctx, null)
    const tex = new THREE.CanvasTexture(canvas)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }, [])

  // The batter's headshot, quantized once his photo lands. The board keeps
  // drawing the previous one until it does (the reference's FilteredPhoto
  // repaints its canvas the same way).
  const batterId = gameState?.batterId ?? null
  const [headshot, setHeadshot] = useState(null)
  useEffect(() => {
    if (!batterId) {
      setHeadshot(null)
      return undefined
    }
    let cancelled = false
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (!cancelled) setHeadshot(quantizedHeadshot(image))
    }
    image.src = HEADSHOT_URL(batterId)
    return () => {
      cancelled = true
    }
  }, [batterId])

  // The board's text is canvas-drawn, and a canvas never asks for a face on
  // its own: pull Rubik in explicitly and repaint once it lands, so the
  // texture cannot keep the fallback's letterforms on a frozen board.
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => {
    const fonts = document.fonts
    if (!fonts?.load) {
      setFontsReady(true)
      return undefined
    }
    let cancelled = false
    Promise.all([fonts.load('700 24px Rubik'), fonts.load('900 24px Rubik')])
      .catch(() => [])
      .then(() => {
        if (!cancelled) setFontsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const key = boardKey(gameState)
  useEffect(() => {
    const canvas = texture.image
    const ctx = canvas.getContext('2d')
    drawBillboard(ctx, gameState, headshot)
    texture.needsUpdate = true
    // The board's content is a pure function of the state, keyed above; the
    // headshot and the face repaint the same board in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, headshot, fontsReady])

  useEffect(() => {
    return () => texture.dispose()
  }, [texture])

  const half = size[1] / 2
  const steel = { color: '#202d38', roughness: 0.55, metalness: 0.45 }
  const dark = { color: '#121a22', roughness: 0.7, metalness: 0.25 }
  const gold = { color: '#e0a92f', roughness: 0.4, metalness: 0.5 }
  const speaker = { color: '#0d1218', roughness: 0.9, metalness: 0.1 }

  return (
    <group position={position}>
      {/* The lit screen itself (unlit material keeps the board readable at night) */}
      <mesh name="dynamicBillboard">
        <planeGeometry args={[size[0], size[1]]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>

      {/* Housing and its shadow gap, so the screen sits in a box rather than
          floating as a sheet of light */}
      <SoftBox size={[size[0] + 0.9, size[1] + 0.9, 0.6]} bevel={0.12} position={[0, 0, -0.35]}>
        <meshStandardMaterial {...dark} />
      </SoftBox>

      {/* The mount: a truss beam and catwalk under the screen, speaker towers
          either side and masts behind it. This is what stops the board reading
          as a scoreboard parked in mid-air over the bleachers. Everything
          under the screen stays *behind* its face: the bleachers' back rows
          rise to head height right below the board, so a band brought forward
          would be drawn across the crowd rather than under the screen. */}
      <SoftBox size={[size[0] + 4.6, 0.55, 1.1]} bevel={0.08} position={[0, -(half + 0.35), -0.9]}>
        <meshStandardMaterial {...steel} />
      </SoftBox>
      <SoftBox size={[size[0] * 0.92, 0.16, 1.4]} bevel={0.04} position={[0, -(half + 0.95), -1.5]}>
        <meshStandardMaterial {...steel} />
      </SoftBox>
      {[-1, 1].map((side) => (
        <group key={`wall-${side}`}>
          {/* Speaker tower, full height of the screen, with its grille */}
          <SoftBox size={[1.7, size[1] + 1.2, 1.5]} bevel={0.12} position={[side * (size[0] / 2 + 0.85), -0.3, -0.25]}>
            <meshStandardMaterial {...steel} />
          </SoftBox>
          <SoftBox size={[1.3, size[1] - 0.6, 0.08]} bevel={0.03} position={[side * (size[0] / 2 + 0.85), -0.3, 0.53]}>
            <meshStandardMaterial {...speaker} />
          </SoftBox>
          <SoftBox size={[1.8, 0.22, 1.6]} bevel={0.05} position={[side * (size[0] / 2 + 0.85), size[1] / 2 + 0.05, 0.2]}>
            <meshStandardMaterial {...gold} />
          </SoftBox>
          {/* Mast behind the board, down to the stands' own structure */}
          <SoftBox size={[1.0, 5.6, 1.0]} bevel={0.14} position={[side * (size[0] * 0.3), -(half + 2.6), -1.5]}>
            <meshStandardMaterial {...steel} />
          </SoftBox>
        </group>
      ))}
      {[-1, 1].map((side) => (
        <SoftBox
          key={`tie-${side}`}
          size={[size[0] * 0.6, 0.22, 0.22]}
          bevel={0.06}
          position={[0, -(half + 1.6 + side * 1.5), -1.5]}
        >
          <meshStandardMaterial {...steel} />
        </SoftBox>
      ))}

      {/* The board's lit skirt: a narrow ad band on the screen's own bottom
          edge, with the gold trim that separates it from the score grid */}
      <SoftBox size={[size[0] * 0.94, 0.34, 0.2]} bevel={0.04} position={[0, -(half + 0.12), 0.06]}>
        <meshStandardMaterial color="#5e1414" emissive="#3a0a0a" emissiveIntensity={0.9} roughness={0.5} />
      </SoftBox>
      <SoftBox size={[size[0] * 0.94, 0.07, 0.22]} bevel={0.02} position={[0, -(half + 0.3), 0.07]}>
        <meshStandardMaterial {...gold} />
      </SoftBox>
    </group>
  )
}
