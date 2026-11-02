// oxlint-disable react/only-export-components -- Vite entry point: it mounts the
// harness and intentionally exports nothing.
import React, { Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { BattedBall } from '../../src/components/BattedBall'
import { Batter } from '../../src/components/Batter'
import { Pitcher } from '../../src/components/Pitcher'
import { FIELD } from '../../src/constants/field'
import { getBatterRun, getCastHandPosition, getCycleDuration, getPlayBallPosition, getPlayClock, getSimulationTime, getTimeScale, setSimulationTime, setTimeScale } from '../../src/constants/playback'
import { SWING_PITCH } from './fixture'

// ---------------------------------------------------------------------------
// Scratch harness for the *cast*: it mounts the app's own <BattedBall> over the
// batter harness's swing pitch, with a hit whose runners are a 6-4-3 double
// play, and answers with where every body and the ball are. It exists so a
// probe (scripts/probe-cast.mjs) can watch a real play — the sprint, the catch,
// the throws, the runners — and then watch the reset put everyone back and the
// next cycle replay it, without a backend or a live feed.
//
// The *batter* is mounted beside it, because the batter-runner is his own body
// (see src/util/batterRunner.js): the play has one body at the plate, and it is
// the one swinging. The probe reads his own group — where he is, whether the bat
// is in his hands, and a bone of him — alongside the cast's.
//
// window.__vr.probeCast() answers with, per body, its world position and whether
// it is on the field; plus the ball's own published position and the hand the
// ball is riding (both published by the app's own components).
// ---------------------------------------------------------------------------

const query = new URLSearchParams(window.location.search)
const POSITION = query.get('play') ?? 'double'

const SWING = { ...SWING_PITCH, is_contact: true, is_top_inning: query.get('half') === 'top' }

const HITS = {
  // A grounder to short with a man on first: the shortstop fields it, throws to
  // second for one, and the second baseman throws on to first.
  double: {
    coordX: 100,
    coordY: 120,
    launchSpeed: 88,
    launchAngle: 3,
    sprayAngle: -12,
    fielder: 'SS',
    wasCaught: false,
    eventType: 'grounded_into_double_play',
    runners: [
      { start: '1B', end: null, outBase: '2B', isOut: true, credits: [{ position: 'SS', credit: 'f_fielded_ball' }, { position: '2B', credit: 'f_putout' }] },
      { start: null, end: '1B', isOut: false, credits: [{ position: 'SS', credit: 'f_assist' }, { position: '1B', credit: 'f_putout' }] },
    ],
  },
  // A single to right: no outs at all — the batter-runner is the only man who
  // moves, so the cast is the seven fielders plus one runner.
  single: {
    coordX: 120,
    coordY: 90,
    launchSpeed: 92,
    launchAngle: 12,
    sprayAngle: 24,
    fielder: 'RF',
    wasCaught: false,
    eventType: 'single',
    runners: [{ start: null, end: '1B', isOut: false }],
  },
  // A fly ball caught in centre: nobody runs, one out, no throws.
  fly: {
    coordX: 130,
    coordY: 130,
    launchSpeed: 100,
    launchAngle: 30,
    sprayAngle: 0,
    totalDistance: 360,
    fielder: 'CF',
    wasCaught: true,
    eventType: 'flyout',
    runners: [],
  },
  // A comebacker: the ball is hit back at the mound, and the pitcher is the man who
  // fields it. He is not a body of the cast's (see util/playCast.js) — the pitcher's
  // own component draws him, and this harness mounts it below so a probe can watch
  // *his* half of the play: the delivery handed over to the plan's schedule, the ball
  // in his hand, and the reset that puts him back on the mound.
  comeback: {
    coordX: 125,
    coordY: 130,
    launchSpeed: 85,
    launchAngle: 2,
    sprayAngle: 0,
    fielder: 'P',
    wasCaught: false,
    eventType: 'fielders_choice',
    runners: [
      {
        start: null,
        end: '1B',
        isOut: false,
        credits: [
          { position: 'P', credit: 'f_fielded_ball' },
          { position: 'P', credit: 'f_assist' },
          { position: '1B', credit: 'f_putout' },
        ],
      },
    ],
  },
}

const HIT = HITS[POSITION] ?? HITS.double

const vr = { ready: false, scene: null, camera: null, hit: POSITION }
window.__vr = vr

const V = new THREE.Vector3()
const H = new THREE.Vector3()
const round = (v) => ({ x: Number(v.x.toFixed(3)), y: Number(v.y.toFixed(3)), z: Number(v.z.toFixed(3)) })

function probeCast() {
  const scene = vr.scene
  if (!scene) return null
  const bodies = []
  scene.traverse((child) => {
    if (!child.name?.startsWith('cast:')) return
    child.getWorldPosition(V)
    bodies.push({
      name: child.name,
      visible: child.visible && child.parent?.visible !== false,
      x: Number(V.x.toFixed(3)),
      y: Number(V.y.toFixed(3)),
      z: Number(V.z.toFixed(3)),
    })
  })
  const hand = getCastHandPosition()
  const ball = getPlayBallPosition()
  return {
    bodies: bodies.sort((a, b) => a.name.localeCompare(b.name)),
    hand: hand ? { x: Number(hand.x.toFixed(3)), y: Number(hand.y.toFixed(3)), z: Number(hand.z.toFixed(3)) } : null,
    ball: ball ? { x: Number(ball.x.toFixed(3)), y: Number(ball.y.toFixed(3)), z: Number(ball.z.toFixed(3)) } : null,
    // The batter's own body: where it stands, whether the bat is still in his
    // hands, and one bone of him (the right hand — the swing's grip and the run's
    // arm swing both move it, so a pose that is being played reads as a bone that
    // moves on its own).
    batter: batterProbe(scene),
    // How many bodies are standing at the plate right now: the batter, plus any
    // cast body within a stride of home. One is the whole point of the handoff.
    // ...and whether any body of the cast's is standing at the plate (the batter
    // is read above, off his own live position, so the two cannot disagree).
    castAtPlate: bodiesNextTo(scene, 1.6),
    playClock: getPlayClock(),
    batterRun: !!getBatterRun(),
    // The pitcher: his own body, the one actor of the defense this cast does not
    // draw (Pitcher.jsx does, and hands him the play's own schedule — see
    // util/playCast.js's `pitcherFrameAt`).
    pitcher: pitcherProbe(scene),
  }
}

// The pitcher's own body: where it stands, what the fielding half of the play says
// it is doing (Pitcher.jsx's own readout), and how far it is off its spot on the
// mound — a body the schedule has moved reads as a metre count, a body `null` has
// nothing to do and is standing in its delivery.
function pitcherProbe(scene) {
  const node = scene.getObjectByName('pitcher')
  if (!node) return null
  node.getWorldPosition(V)
  // Pitcher.jsx writes its own readout on the body it poses (the model, the group's
  // child) — found by walking up from a mesh of it, because the pose's own readout
  // is written there and not on the group the schedule moves.
  let field = null
  for (let at = node.getObjectByName('JOINED'); at && !field; at = at.parent) {
    field = at.userData?.pitcher?.field ?? null
  }
  // ...and how much of him is drawn: the meshes he is really wearing, read the way
  // the cast's bodies are (the hidden helmet and the glove's other hand keep the
  // asset's own shared material, so they are not this body's to fade).
  const opacities = new Set()
  node.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.visible) return
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (mat) opacities.add(Number(mat.opacity.toFixed(3)))
    }
  })
  return {
    ...round(V),
    visible: node.visible,
    offMound: Number(Math.hypot(V.x - FIELD.DEFENSE.P.x, V.z - FIELD.DEFENSE.P.z).toFixed(3)),
    opacity: [...opacities],
    // The yaw the body is turned by: the *group's* own, which is the frame the
    // model is mounted turned half round in (Pitcher.jsx's own mount), so a reader
    // can tell which way the body really faces — the delivery's own yaw is the same
    // aim at the plate, and the fielding's is the play's look target (see the
    // pitcher's fielding test in e2e/pitcher.visual.spec.js).
    yaw: Number(node.rotation.y.toFixed(6)),
    field: field
      ? {
          clock: Number(field.clock.toFixed(3)),
          state: field.state,
          hasBall: field.hasBall,
          look: field.look ?? null,
        }
      : null,
  }
}

// Every cast body's own opacity, by name: the fade is per body and follows the
// *camera*, so a probe moves the camera and reads what each body is drawn at (see
// util/playerKit.js's playerFadeOpacity).
function castOpacities(scene) {
  const out = {}
  scene.traverse((child) => {
    if (!child.name?.startsWith('cast:')) return
    const seen = new Set()
    child.traverse((mesh) => {
      if (!mesh.isMesh) return
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (mat) seen.add(Number(mat.opacity.toFixed(3)))
      }
    })
    out[child.name] = [...seen]
  })
  return out
}

// Every body — cast or batter — within `radius` metres of home plate.
function bodiesNextTo(scene, radius) {
  const near = []
  scene.traverse((child) => {
    if (!child.name?.startsWith('cast:')) return
    if (!child.visible) return
    child.getWorldPosition(V)
    if (Math.hypot(V.x - FIELD.BASE.HOME.x, V.z - FIELD.BASE.HOME.z) <= radius) near.push(child.name)
  })
  return near
}

function batterProbe(scene) {
  const node = scene.getObjectByName('batter')
  if (!node) return null
  node.getWorldPosition(V)
  const bat = scene.getObjectByName('bat-swing-frame')
  const hand = scene.getObjectByName('handR')
  if (hand) hand.getWorldPosition(H)
  return {
    ...round(V),
    batVisible: bat ? bat.visible : null,
    hand: hand ? round(H) : null,
    // The bat he left behind (see Batter.jsx's dropBat): where it is, which way it
    // lies, and how far off the ground it sits — read off the mesh's own box, so a
    // bat left standing on its end or floating reads as one.
    dropped: droppedProbe(scene, bat),
  }
}

function droppedProbe(scene, handBat) {
  const dropped = scene.getObjectByName('bat-dropped')
  if (!dropped) return null
  V.set(0, 0, 0)
  dropped.getWorldPosition(V)
  // The bat's own long axis, read off the mesh's own matrix: this asset's bat runs
  // down its own -Z (the knob at +Z, the barrel at -Z — public/models/parts/
  // bat.glb), so the axis the *bat* lies along is that column of its world matrix,
  // negated. Its y is the whole of "is it lying flat".
  let axis = null
  const box = new THREE.Box3().setFromObject(dropped)
  dropped.traverse((child) => {
    if (!child.isMesh || axis) return
    axis = new THREE.Vector3().fromArray(child.matrixWorld.elements, 8).normalize().negate()
  })
  return {
    visible: dropped.visible,
    x: Number(V.x.toFixed(3)),
    y: Number(V.y.toFixed(3)),
    z: Number(V.z.toFixed(3)),
    axis: axis ? round(axis) : null,
    ground: Number(box.min.y.toFixed(3)),
    top: Number(box.max.y.toFixed(3)),
    span: Number(Math.max(box.max.x - box.min.x, box.max.z - box.min.z).toFixed(3)),
    distanceToHandBat: handBat ? Number(handBat.getWorldPosition(new THREE.Vector3()).distanceTo(V).toFixed(3)) : null,
    // The two bats are never both drawn: the in-hand one is hidden on the frame
    // the dropped one appears.
    bothDrawn: !!handBat && handBat.visible && dropped.visible,
  }
}

vr.probeCast = probeCast
vr.spots = Object.fromEntries(
  ['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'].map((k) => [`defense:${k}`, { x: Number(FIELD.DEFENSE[k].x.toFixed(3)), z: Number(FIELD.DEFENSE[k].z.toFixed(3)) }]),
)
vr.bases = Object.fromEntries(
  [['1B', FIELD.BASE.FIRST], ['2B', FIELD.BASE.SECOND], ['3B', FIELD.BASE.THIRD], ['home', FIELD.BASE.HOME]]
    .map(([k, v]) => [`offense:${k}`, { x: Number(v.x.toFixed(3)), z: Number(v.z.toFixed(3)) }]),
)
vr.setTimeScale = (scale) => setTimeScale(scale)
// Put the camera somewhere: the fade below is a distance to it, so this is how a
// probe stands the camera inside a fielder's own body (what the fielder-cam replay
// does — its position is the chaser's head, a head height over his feet).
vr.setCamera = (x, y, z) => {
  vr.camera?.position.set(x, y, z)
  return { x: vr.camera?.position.x, y: vr.camera?.position.y, z: vr.camera?.position.z }
}
vr.opacities = () => castOpacities(vr.scene)
vr.pitcherSpot = { x: Number(FIELD.DEFENSE.P.x.toFixed(3)), z: Number(FIELD.DEFENSE.P.z.toFixed(3)) }
// The clock the play is drawn on, so a probe can tell a slow machine from a
// play that never ran: how many frames have rendered, and where the shared
// simulation clock is on its cycle.
vr.stats = () => ({
  frames: vr.frames,
  simTime: Number(getSimulationTime().toFixed(3)),
  cycle: Number(getCycleDuration().toFixed(3)),
  scale: getTimeScale(),
})
vr.wind = (t) => setSimulationTime(t)
// Per-frame log, mounted last so its callback runs *after* the batter's and the
// play's own: what it records for a frame is therefore exactly what the batter
// will read on the next one (it reads the previous frame's publications). It
// exists to catch a handoff that came undone between two frames — a null clock,
// a run that went away — which a one-sample-per-frame probe cannot see.
const LOG_FRAMES = 400
vr.log = []
vr.frames = 0
const Clock = () => {
  useFrame(() => {
    vr.frames += 1
    const batter = vr.scene?.getObjectByName('batter')
    const bat = vr.scene?.getObjectByName('bat-swing-frame')
    const dropped = vr.scene?.getObjectByName('bat-dropped')
    vr.log.push({
      f: vr.frames,
      sim: Number(getSimulationTime().toFixed(3)),
      play: getPlayClock(),
      run: getBatterRun() ? Number(getBatterRun().legs[0].start.toFixed(3)) : null,
      x: batter ? Number(batter.position.x.toFixed(3)) : null,
      z: batter ? Number(batter.position.z.toFixed(3)) : null,
      bat: bat ? bat.visible : null,
      // The bat on the dirt, every frame: when it appears (the handoff), whether
      // it stays put while he runs, and when the reset takes it away.
      drop: dropped?.visible ?? null,
      dropX: dropped && dropped.visible ? Number(dropped.position.x.toFixed(3)) : null,
      dropZ: dropped && dropped.visible ? Number(dropped.position.z.toFixed(3)) : null,
    })
    if (vr.log.length > LOG_FRAMES) vr.log.splice(0, vr.log.length - LOG_FRAMES)
  })
  return null
}
vr.probeLog = () => vr.log.slice()

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
  <Canvas camera={{ position: [0, 3, 6], fov: 45 }} gl={{ preserveDrawingBuffer: true }}>
    <Suspense fallback={null}>
      <hemisphereLight args={['#cfe8ff', '#4a5b2a', 0.9]} />
      <directionalLight position={[8, 14, 6]} intensity={1.1} />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#5c8f3a" />
      </mesh>
      <Batter pitchData={SWING} />
      {/* The pitcher's own body: he is not a body of the cast's (see
          util/playCast.js), so a play that gives him something to field — the
          comebacker above — is played by this component's body off the plan's own
          schedule. Mounted for every play, because a pitcher standing in his
          delivery on the mound is what the field looks like when the ball is not
          his. */}
      <Pitcher pitchData={SWING} />
      <BattedBall pitchData={SWING} hit={HIT} />
    </Suspense>
    <Clock />
    <Capture />
  </Canvas>
)

createRoot(document.getElementById('root')).render(<App />)
