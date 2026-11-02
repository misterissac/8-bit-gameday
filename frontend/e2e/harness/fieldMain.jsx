// oxlint-disable react/only-export-components -- Vite entry point: it mounts the
// harness and intentionally exports nothing.
import React, { Suspense, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { Ballpark } from '../../src/components/Ballpark'
import { Batter } from '../../src/components/Batter'
import { STANCE_PITCH } from './fixture'

// ---------------------------------------------------------------------------
// Test-only harness page for the field's own layout: the real <Ballpark> from the
// app (no stubs, no copies) under a straight-down orthographic camera, so the
// home plate and the boxes chalked around it can be *seen* as a plan — and read
// back as numbers — instead of being argued about from a perspective view.
//
// Query parameters:
//   ?x=&z=      the plan's centre, in world metres (default: the plate's own centre)
//   ?span=      metres across the frame (default 10)
//   ?view=top   top down (the default) | ?view=tilt  30 degrees off the top, from
//               behind the plate, so the chalk reads against the dirt at an angle
//   ?batter=1   stand the app's own batter in the box (the real <Batter>, on the
//               harness fixture's stance pitch) — the reading the batter's own
//               stance is judged by: "both feet within the batter's box"
//
// window.__vr.probeField() answers with every named piece of the plate area — the
// plate, its rim, and each box's four lines — as a world rectangle in metres and in
// feet/inches, which is what a test pins the layout with (see
// e2e/field.visual.spec.js).
// ---------------------------------------------------------------------------

const query = new URLSearchParams(window.location.search)
const CENTRE = new THREE.Vector2(
  Number(query.get('x') ?? 0) || 0,
  Number(query.get('z') ?? -0.2) || 0,
)
const SPAN = Number(query.get('span') ?? 10) || 10
const TILT = query.get('view') === 'tilt'
const WITH_BATTER = query.get('batter') === '1'

const vr = { ready: false, scene: null, camera: null, framing: null }
window.__vr = vr

/** The box lines Ballpark names, grouped back into the boxes they belong to. */
const BOX_NAMES = [
  'batterBox-3B',
  'batterBox-1B',
  'catcherBox',
  'coachBox-3B',
  'coachBox-1B',
]

const _corner = new THREE.Vector3()
const _box = new THREE.Box3()

const metres = (value) => Number(value.toFixed(4))
const inches = (value) => Number((value * 12 / 0.3048).toFixed(2))
const asRule = ({ x, z }) => ({
  x: x.map(metres),
  z: z.map(metres),
  acrossIn: inches(x[1] - x[0]),
  deepIn: inches(z[1] - z[0]),
  centreZIn: inches((z[0] + z[1]) / 2),
  frontZIn: inches(z[0]),
  backZIn: inches(z[1]),
  innerXIn: inches(Math.min(Math.abs(x[0]), Math.abs(x[1]))),
})

/** A mesh's own world rectangle in the plane the field is drawn on (x and z only). */
function worldRect(node) {
  node.geometry.computeBoundingBox()
  _box.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld)
  return { x: [_box.min.x, _box.max.x], z: [_box.min.z, _box.max.z], y: [_box.min.y, _box.max.y] }
}

/** The four corners of a flat piece of chalk, in the plane: what the chalk covers. */
function worldCorners(node) {
  const position = node.geometry.attributes.position
  const corners = []
  for (let i = 0; i < position.count; i += 1) {
    _corner.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld)
    corners.push([metres(_corner.x), metres(_corner.z)])
  }
  return corners
}

const inRect = ([x, z], rect) => (
  x > rect.x[0] && x < rect.x[1] && z > rect.z[0] && z < rect.z[1]
)

/**
 * What the plate area is made of, read off the scene's own meshes: each named piece
 * with its own world rectangle (x and z, the plane the field is drawn on) in metres
 * and in feet/inches, each box reassembled from the lines that draw it, the plate's
 * own shape (which end its point is at), and — the thing a plan view is read for —
 * how much chalk of one box lands *inside* another.
 */
function probeField() {
  const scene = vr.scene
  if (!scene) return null
  scene.updateMatrixWorld(true)
  const meshes = new Map()
  scene.traverse((node) => {
    if (!node.isMesh || !node.name) return
    if (!node.name.startsWith('homePlate') && !/Box-/.test(node.name)) return
    meshes.set(node.name, node)
  })
  const pieces = new Map([...meshes].map(([name, node]) => [name, worldRect(node)]))
  const boxes = {}
  for (const name of BOX_NAMES) {
    const sides = [...pieces.entries()].filter(([key]) => key.startsWith(`${name}-`))
    if (!sides.length) continue
    // Each box is chalk: thin lines, so the rectangle is the union of them.
    const x = [Math.min(...sides.map(([, p]) => p.x[0])), Math.max(...sides.map(([, p]) => p.x[1]))]
    const z = [Math.min(...sides.map(([, p]) => p.z[0])), Math.max(...sides.map(([, p]) => p.z[1]))]
    boxes[name] = asRule({ x, z })
  }
  // The plate: its own rectangle, and the vertices at each end of it, so the shape's
  // own direction settles whether the point faces the pitcher or the catcher — a
  // 17-inch box reads the same either way round.
  const plateMesh = meshes.get('homePlate')
  let plate = null
  if (plateMesh) {
    const corners = worldCorners(plateMesh)
    const zs = corners.map(([, z]) => z)
    const frontZ = Math.min(...zs)
    const backZ = Math.max(...zs)
    const spanAt = (z) => {
      const xs = corners.filter(([, zz]) => Math.abs(zz - z) < 0.02).map(([x]) => x)
      return xs.length ? [Math.min(...xs), Math.max(...xs)] : null
    }
    plate = {
      ...asRule(pieces.get('homePlate')),
      vertices: corners.length,
      /** The x each end is drawn across: the point is a point, the back is 17 in. */
      frontX: (spanAt(frontZ) ?? []).map(metres),
      backX: (spanAt(backZ) ?? []).map(metres),
    }
  }
  // Chalk that runs inside a box it does not belong to — the three boxes overlap a
  // drawn plan's eye if any does, and none may.
  const boxesOf = (name) => (name.startsWith('batterBox-3B') ? ['batterBox-1B'] : name.startsWith('batterBox-1B') ? ['batterBox-3B'] : ['batterBox-3B', 'batterBox-1B'])
  const crossings = []
  for (const [name, node] of meshes) {
    if (!/Box-/.test(name)) continue
    for (const other of boxesOf(name)) {
      const sides = [...pieces.entries()].filter(([key]) => key.startsWith(`${other}-`))
      if (!sides.length) continue
      const union = {
        x: [Math.min(...sides.map(([, p]) => p.x[0])), Math.max(...sides.map(([, p]) => p.x[1]))],
        z: [Math.min(...sides.map(([, p]) => p.z[0])), Math.max(...sides.map(([, p]) => p.z[1]))],
      }
      for (const corner of worldCorners(node)) {
        if (inRect(corner, union)) crossings.push({ name, inside: other, corner })
      }
    }
  }
  return {
    plate,
    /** One white slab and nothing else: no second, dark plate under it. */
    plates: [...meshes.keys()].filter((name) => /plate/i.test(name)),
    boxes,
    /** Every drawn line's own rectangle and the corners of its chalk. */
    lines: Object.fromEntries([...meshes].map(([name, node]) => [name, {
      ...asRule(pieces.get(name)),
      corners: worldCorners(node),
    }])),
    crossings,
    pieces: pieces.size,
  }
}

vr.probeField = probeField

/** Frames the plan once and then leaves the camera alone. */
function Plan({ centre, span, tilt }) {
  const { camera, scene, size } = useThree()
  const done = useRef(false)
  useEffect(() => {
    vr.scene = scene
    vr.camera = camera
  }, [scene, camera])
  useFrame(() => {
    if (done.current) return
    done.current = true
    if (tilt) {
      camera.position.set(centre.x, span * 0.75, centre.y + span * 0.9)
      camera.lookAt(centre.x, 0, centre.y)
    } else {
      camera.position.set(centre.x, 40, centre.y)
      camera.up.set(0, 0, -1)
      camera.lookAt(centre.x, 0, centre.y)
    }
    camera.zoom = Math.min(size.width, size.height) / span
    camera.updateProjectionMatrix()
    vr.framing = { centre: [centre.x, centre.y], span, tilt }
    vr.ready = true
  })
  return null
}

// Harness hook: ``?demoGame=mid`` feeds the billboard a canned mid-game state
// so its matchup strip (faces, names, count) can be checked on screen.
const DEMO_GAME = new URLSearchParams(window.location.search).get('demoGame') === 'mid'
  ? {
      teams: {
        away: { abbreviation: 'NYM', name: 'New York Mets' },
        home: { abbreviation: 'PHI', name: 'Philadelphia Phillies' },
      },
      score: {
        away: { runs: 3, hits: 5, errors: 0 },
        home: { runs: 4, hits: 7, errors: 1 },
      },
      inning: { number: 5, ordinal: '5th', state: 'Top', isTop: true },
      count: { balls: 2, strikes: 1 },
      outs: 1,
      batter: 'Bryce Harper',
      pitcher: 'Zack Wheeler',
      gameState: 'In Progress',
    }
  : undefined

const Field = () => (
  <Canvas
    orthographic
    camera={{ position: [CENTRE.x, 40, CENTRE.y], zoom: 60, near: 0.1, far: 200 }}
  >
    <ambientLight intensity={0.9} />
    <directionalLight position={[8, 20, 6]} intensity={1.2} />
    <Suspense fallback={null}>
      <Ballpark gameState={DEMO_GAME} />
      {WITH_BATTER ? <Batter pitchData={STANCE_PITCH} /> : null}
    </Suspense>
    <Plan centre={CENTRE} span={SPAN} tilt={TILT} />
  </Canvas>
)

createRoot(document.getElementById('root')).render(<Field />)
