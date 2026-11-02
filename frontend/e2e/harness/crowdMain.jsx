// oxlint-disable react/only-export-components -- Vite entry point: it mounts the
// harness and intentionally exports nothing.
import React, { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { Ballpark } from '../../src/components/Ballpark'

// ---------------------------------------------------------------------------
// Test-only page for the crowd's little shows (banners, instruments, the
// notes and shout marks): the real <Ballpark> from the app, with a camera
// parked in front of one show cluster so the props can be *seen*.
//
// Query parameters:
//   ?group=   which show cluster (default 0)
//   ?dist=    metres from the cluster (default 7)
//   ?height=  metres above the seat row (default 2.4)
//   ?side=    metres along the row (default 0), to look at a cluster from an angle
//   ?back=1   stands behind the row instead of in front of it, to check that a
//             billboarded mark still leans away from the group from that side
//   ?dpr=     render scale (default 2); the sampling suite asks for 1
//   ?crowdHold=all&crowdHoldT=2.5  pins every show mid-burst (CrowdShow's hook)
//   ?view=stadium                 parks the camera over the plate instead, so
//                                 the roof, press box and the mounted board
//                                 can be seen in one frame
//
// window.__crowd.framing answers with what the camera was aimed at.
// ---------------------------------------------------------------------------

const query = new URLSearchParams(window.location.search)
const GROUP = Number(query.get('group') ?? 0) || 0
const DIST = Number(query.get('dist') ?? 7) || 7
const HEIGHT = Number(query.get('height') ?? 2.4) || 2.4
const SIDE = Number(query.get('side') ?? 0) || 0
const BACK = query.get('back') === '1'
// Render scale. The scene is heavy enough that the sampling suites run at a
// handful of frames a second at 2; they ask for 1 so the mark's own frames are
// sampled often enough to see every step of its beat.
const DPR = Number(query.get('dpr') ?? 2) || 2
const VIEW = query.get('view')

// Whole-park framings for looking at the stadium itself, rather than at one
// cluster: [camera, target].
const VIEWS = {
  stadium: [[0, 26, 30], [0, 4, -34]],
  behind: [[0, 9, 40], [0, 5, -12]],
  corner: [[44, 16, 26], [-6, 4, -30]],
  // From centre field back at the home-plate grandstand: the roof, its
  // columns and flags, and the press box under it.
  stands: [[0, 13, -42], [0, 8, 18]],
  board: [[0, 7, -78], [0, 10.5, -107]],
}

const vr = { ready: false, framing: null }
window.__crowd = vr

function Aim() {
  const { camera, scene } = useThree()
  const aimed = useRef(false)
  useEffect(() => {
    const preset = VIEWS[VIEW]
    if (preset) {
      camera.position.set(...preset[0])
      camera.lookAt(...preset[1])
      camera.updateProjectionMatrix()
      vr.ready = true
      vr.scene = scene
      vr.cameraRef = camera
      vr.THREE = THREE
      vr.framing = { id: VIEW, role: 'stadium', camera: camera.position.toArray() }
      return
    }
    const groups = typeof window !== 'undefined' ? window.__crowdGroups : null
    const group = groups?.[GROUP]
    if (!group) return
    const angle = group.yaw + Math.atan2(SIDE, DIST)
    const facing = { x: Math.sin(angle), z: Math.cos(angle) }
    const d = Math.hypot(DIST, SIDE)
    camera.position.set(
      group.anchor.x + facing.x * d * (BACK ? -1 : 1),
      group.anchor.y + HEIGHT,
      group.anchor.z + facing.z * d * (BACK ? -1 : 1),
    )
    camera.lookAt(group.anchor.x, group.anchor.y + 0.8, group.anchor.z)
    camera.updateProjectionMatrix()
    vr.ready = true
    vr.scene = scene
    vr.cameraRef = camera
    vr.THREE = THREE
    vr.framing = {
      id: group.id,
      back: BACK,
      role: group.role,
      anchor: group.anchor,
      yaw: group.yaw,
      members: (group.fans ?? group.members ?? []).length,
      camera: camera.position.toArray(),
      sceneChildren: scene.children.length,
    }
    aimed.current = true
  }, [camera, scene])
  return null
}

function App() {
  return (
    <Canvas
      shadows
      dpr={DPR}
      camera={{ position: [0, 6, 12], fov: 45, near: 0.05, far: 900 }}
      gl={{ antialias: false }}
    >
      <color attach="background" args={['#0c1622']} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[10, 20, 8]} intensity={1.6} />
      <directionalLight position={[-14, 12, -6]} intensity={0.5} />
      <Ballpark />
      <Aim />
    </Canvas>
  )
}

createRoot(document.getElementById('root')).render(<App />)
