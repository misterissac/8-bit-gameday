// oxlint-disable react/only-export-components -- Vite entry point: it mounts the
// harness and intentionally exports nothing.
import React, { Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { Ballpark } from '../../src/components/Ballpark'
import { Batter } from '../../src/components/Batter'
import { Catcher } from '../../src/components/Catcher'
import { FIELD } from '../../src/constants/field'
import { STANCE_PITCH } from './fixture'

// ---------------------------------------------------------------------------
// Scratch harness for the catcher: the real <Catcher> (his own body on the
// asset's CatcherIdle clip), the real <Batter> standing in the box beside him as
// the *reference* body — the batter's facing is pinned by the app's own visual
// baselines, so a read of his feet is what says which way a body drawn in this
// asset's frames is really facing — and the ballpark behind them for the eye.
//
//   ?kit=away    put the defense in the visitors' kit (he wears home by default)
//   ?field=0     leave the ballpark out (the probe runs lighter)
//
// window.__vr answers with, for the catcher: where he stands and faces, every
// bone this read needs (the crouch is a head height), the box his *posed* body
// really occupies (feet on the dirt), which meshes he wears, and the materials a
// fade would be written to. Plus a second sample of the head bone so a probe can
// tell a breathing clip from a frozen one, and `setCamera` for the eye.
// ---------------------------------------------------------------------------

const query = new URLSearchParams(window.location.search)
const KIT = query.get('kit') === 'away' ? 'away' : 'home'
const WITH_FIELD = query.get('field') !== '0'

const vr = { ready: false, scene: null, camera: null, kit: KIT }
window.__vr = vr

const V = new THREE.Vector3()
const BOX = new THREE.Box3()
const round = (v) => Number(v.toFixed(4))

const boneAt = (root, name) => {
  const bone = root?.getObjectByName(name)
  if (!bone) return null
  bone.getWorldPosition(V)
  return { x: round(V.x), y: round(V.y), z: round(V.z) }
}

const named = (root, name) => root?.getObjectByName(name) ?? null

// The body's own box, posed: three skinned meshes keep a rest-pose box unless they
// are asked to compute one, and the whole question here — is he standing on the
// dirt, and how low is the crouch — is about the pose.
const posedBox = (root) => {
  BOX.makeEmpty()
  if (!root) return null
  root.traverse((child) => {
    if (!child.isMesh) return
    if (child.isSkinnedMesh) child.computeBoundingBox()
    const box = child.isSkinnedMesh ? child.boundingBox : child.geometry?.boundingBox
    if (!box) return
    BOX.union(box.clone().applyMatrix4(child.matrixWorld))
  })
  return BOX.isEmpty() ? null : {
    minY: round(BOX.min.y),
    maxY: round(BOX.max.y),
    height: round(BOX.max.y - BOX.min.y),
    minX: round(BOX.min.x),
    maxX: round(BOX.max.x),
    minZ: round(BOX.min.z),
    maxZ: round(BOX.max.z),
  }
}

const materialsOf = (root) => {
  const materials = new Set()
  root?.traverse((child) => {
    if (!child.isMesh) return
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (material) materials.add(material)
    }
  })
  return [...materials]
}

const bodyProbe = (root) => {
  if (!root) return null
  root.getWorldPosition(V)
  const materials = materialsOf(root)
  return {
    position: { x: round(V.x), y: round(V.y), z: round(V.z) },
    yaw: round((root.rotation.y + Math.PI * 4) % (Math.PI * 2)),
    visible: root.visible,
    // The crouch, read off the skeleton: the head bone's height over the hips, and
    // the two feet (the forward one — the toe — against the heel, which is the
    // read of which way the body is facing).
    spine: boneAt(root, 'spine'),
    neck: boneAt(root, 'neck'),
    head: boneAt(root, 'spine006'),
    toeL: boneAt(root, 'toeL'),
    heelL: boneAt(root, 'heel02L'),
    footL: boneAt(root, 'footL'),
    handR: boneAt(root, 'handR'),
    box: posedBox(root),
    meshes: Object.fromEntries(['CAP', 'Helmet', 'GloveL', 'GloveR', 'HandL', 'HandR', 'JOINED'].map((name) => {
      const mesh = named(root, name)
      return [name, mesh ? { visible: mesh.visible, material: mesh.material?.type ?? null, map: mesh.material?.map?.image?.src?.split('/').pop() ?? null } : null]
    })),
    materials: {
      count: materials.length,
      transparent: materials.filter((m) => m.transparent).length,
      depthWrite: materials.filter((m) => m.depthWrite).length,
      opacity: materials.map((m) => round(m.opacity)),
    },
  }
}

const probe = () => {
  const catcher = vr.scene?.getObjectByName('catcher')
  return {
    // Which kit is on the defense's bodies, off the loaded texture's own url.
    kit: named(catcher, 'JOINED')?.material?.map?.image?.src?.split('/').pop() ?? null,
    catcher: bodyProbe(catcher),
    // The reference body: the batter's own feet, read the same way. His frame is
    // the asset's turned half round (he faces the pitcher), so his front is the
    // other way from the catcher's — which is the whole point of reading both.
    batter: bodyProbe(vr.scene?.getObjectByName('batter')),
    batInHand: vr.scene?.getObjectByName('bat-swing-frame')?.visible ?? null,
    plate: { x: FIELD.BASE.HOME.x, z: FIELD.BASE.HOME.z },
    catcherSpot: { x: FIELD.DEFENSE.C.x, z: FIELD.DEFENSE.C.z },
    camera: vr.camera ? { x: round(vr.camera.position.x), y: round(vr.camera.position.y), z: round(vr.camera.position.z) } : null,
    frames: vr.frames,
  }
}
vr.probe = probe

// The head bone's own height over the body, twice: a clip that is playing moves
// it, a body left in its rest pose or held on one frame does not.
vr.headHeights = () => [boneAt(vr.scene?.getObjectByName('catcher'), 'spine006')?.y ?? null]

let sampled = []
vr.sample = () => { sampled.push(boneAt(vr.scene?.getObjectByName('catcher'), 'spine006')?.y ?? null) }
vr.samples = () => sampled.slice()

vr.setCamera = (x, y, z) => {
  vr.camera.position.set(x, y, z)
  vr.camera.lookAt(0, 0.9, 0.6)
}
vr.lookAt = (x, y, z) => vr.camera.lookAt(x, y, z)
vr.frames = 0
vr.log = []
const Clock = () => {
  useFrame(() => {
    vr.frames += 1
    if (vr.frames % 6 === 0) vr.sample()
    if (vr.frames > 400) vr.log.push(vr.frames)
  })
  return null
}

const Capture = () => {
  const { scene, camera } = useThree()
  useEffect(() => {
    vr.scene = scene
    vr.camera = camera
    vr.ready = true
  }, [scene, camera])
  return null
}

const App = () => (
  <Canvas camera={{ position: [0, 1.75, 4.9], fov: 45 }} gl={{ preserveDrawingBuffer: true }} shadows>
    <Suspense fallback={null}>
      <hemisphereLight args={['#cfe8ff', '#4a5b2a', 0.9]} />
      <directionalLight position={[7, 13, 5]} intensity={1.05} castShadow />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#5c8f3a" />
      </mesh>
      {WITH_FIELD ? <Ballpark /> : null}
      <Batter pitchData={{ ...STANCE_PITCH, is_top_inning: KIT === 'home' }} />
      <Catcher defenseKit={KIT} />
    </Suspense>
    <Clock />
    <Capture />
  </Canvas>
)

createRoot(document.getElementById('root')).render(<App />)
