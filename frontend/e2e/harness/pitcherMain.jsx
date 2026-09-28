// oxlint-disable react/only-export-components -- Vite entry point: it mounts the
// harness and intentionally exports nothing.
import React, { Suspense, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { Pitcher } from '../../src/components/Pitcher'
import { setCycleDuration, setSimulationTime, setTimeScale } from '../../src/constants/playback'
import { DEFAULT_TUNING, setTuningValue } from '../../src/constants/tuning'
import { PLATE_FRONT_Y } from '../../src/util/MathUtil.js'
import { PART_BONES } from '../../src/util/playerRig.js'

// ---------------------------------------------------------------------------
// Test/look harness for the pitcher. It mounts the real <Pitcher> component on a
// bare stage with the app's lighting, pinned to one frame of the delivery, so the
// pose can be looked at and measured without a live game feed.
//
// The delivery is driven by the shared cycle clock (the same mapping Pitcher.jsx
// uses: the windup is the cycle's last `ballReleaseTime` seconds, the release
// lands on the wrap), so a *clip* time is what the harness pins — the clock the
// delivery is authored on — and the cycle time it corresponds to is computed
// here.
//
//   ?clip=1.32          the delivery's own clock, in seconds (release = 1.32)
//   ?view=three-quarter  three-quarter | side | front | back | top | low
//   ?zoom=1.4           framing distance multiplier
//   ?hand=L             which arm throws (the pitch's own hand by default)
//
// `window.__vr.probe()` reads back what matters about the release: the world
// point the pitch's trajectory starts from, where the body was placed for it,
// where the posed hand's own ball is, and how hard the arm had to work — the arm's
// and the legs' own joints, the place each was asked for and the place it landed.
// `__vr.setClip(clip)` moves the pin to another frame and answers with its probe,
// and `__vr.sweep(from, to, step)` walks a window of them in order, which is what a
// test checks a whole delivery with (see e2e/pitcher.visual.spec.js).
// ---------------------------------------------------------------------------

const CYCLE_DURATION_S = 4
const FROZEN_TIME_SCALE = 1e-9
const RELEASE_TIME = DEFAULT_TUNING.playback.ballReleaseTime

// A right-handed four-seamer: 94 mph off the third-base side of the rubber,
// released 1.78 m up and 54 ft from the plate.
const RELEASE_POINT = { t: 0, x: -0.55, y: 16.46, z: 1.78 }
const CROSSING = { t: 0.44, x: 0.02, y: PLATE_FRONT_Y, z: 0.86 }
const handQuery = new URLSearchParams(window.location.search).get('hand')
const PITCH_HAND = handQuery === 'L' ? 'L' : 'R'
export const PITCH = {
  play_id: 'pitcher-harness',
  pitch_hand: PITCH_HAND,
  pitch_type: 'FF',
  pitch_type_description: 'Four-Seam Fastball',
  speed_mph: 94,
  is_top_inning: false,
  trajectory: [
    RELEASE_POINT,
    { t: CROSSING.t - 0.05, x: 0.0, y: PLATE_FRONT_Y + 1.1, z: 0.9 },
    CROSSING,
  ],
}
// The world point the pitch is drawn from (the app's own mapping: x -> x,
// height -> y, distance -> -z).
const RELEASE_WORLD = new THREE.Vector3(RELEASE_POINT.x, RELEASE_POINT.z, -RELEASE_POINT.y)

const query = new URLSearchParams(window.location.search)
const clipParam = Number(query.get('clip'))
const CLIP_TIME = Number.isFinite(clipParam) && clipParam >= 0 ? clipParam : RELEASE_TIME
// Each entry is the direction from the body *to the camera*: ``front`` looks the
// pitcher in the face from home plate, ``side`` stands off his own right (the
// throwing side, -X in world), which is the side the arm and the slot read from.
const VIEWS = {
  'three-quarter': [-0.6, 0.4, 1],
  front: [0, 0.2, 1],
  side: [-1, 0.22, 0],
  glove: [1, 0.22, 0],
  back: [0.2, 0.25, -1],
  low: [-0.3, 0.5, 1],
  top: [0.1, 2.2, 0.5],
}
const viewName = query.get('view') || 'three-quarter'
const CAMERA_DIRECTION = new THREE.Vector3(...(VIEWS[viewName] ?? VIEWS['three-quarter'])).normalize()
const CAMERA_ZOOM = Number(query.get('zoom') || 1) || 1
const CAMERA_FOV = 32

// The cycle time the delivery's own clock sits at, through the mapping Pitcher.jsx
// uses: the windup is the cycle's last `releaseTime` seconds (ending on the wrap),
// and the follow-through runs on from the wrap at the same rate.
const contactTime = PITCH.trajectory[PITCH.trajectory.length - 1].t
const windupStart = Math.max(contactTime, CYCLE_DURATION_S - RELEASE_TIME)
const rate = RELEASE_TIME / Math.max(0.25, CYCLE_DURATION_S - windupStart)
export const cycleTimeForClip = (clip) => (
  clip < RELEASE_TIME
    ? windupStart + clip / rate
    : Math.min((clip - RELEASE_TIME) / rate, CYCLE_DURATION_S)
)

for (const group of ['pitcher', 'playback']) {
  for (const [key, value] of Object.entries(DEFAULT_TUNING[group])) {
    setTuningValue(group, key, value, { persist: false })
  }
}
// No crossfade: the fade runs on the *simulation* clock, which this page holds
// still, so a phase flip pinned here would leave the pose part-way between the
// idle and the delivery for ever. Every render is one frame of one of them.
setTuningValue('pitcher', 'crossfadeTime', 0, { persist: false })
setCycleDuration(CYCLE_DURATION_S, { force: true })
setTimeScale(FROZEN_TIME_SCALE)
setSimulationTime(cycleTimeForClip(CLIP_TIME))

// Re-pinned every frame, so the pose cannot creep as frames accumulate.
const pinned = { at: cycleTimeForClip(CLIP_TIME) }
function TimePin() {
  useFrame(() => { setSimulationTime(pinned.at) })
  return null
}

// The renderer's own three, for a probe that has to build its own machinery (a
// ray through a pixel, say). The harness is the only place that needs it.
window.__THREE = THREE

const vr = {
  ready: false,
  frames: 0,
  view: viewName,
  clip: CLIP_TIME,
  pitch: PITCH,
  releaseWorld: RELEASE_WORLD.toArray(),
  probe: () => null,
  framing: null,
}
window.__vr = vr

const _ball = new THREE.Vector3()
const _origin = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _offset = new THREE.Vector3()
const _quat2 = new THREE.Quaternion()

// A plain copy of part of the driver's own report, so a probe answers with the
// frame it was asked about. The driver keeps *one* report and empties and refills
// its rows in place every frame, and ``sweep`` hands its rows back to Playwright to
// serialize only once the whole sweep is done — with a live reference every row
// would serialize the last frame's legs, so a test walking a window would check one
// pose 53 times (and report the *set*'s legs for the drive). Same copy, and for the
// same reason, as the batter harness's ``copyPlain``.
function copyPlain(value) {
  if (Array.isArray(value)) return value.map(copyPlain)
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = copyPlain(item)
    return out
  }
  return value
}

/** The pitcher's root group, and the model under it carrying the driver's debug. */
function pitcherParts(scene) {
  const group = scene.getObjectByName('pitcher')
  if (!group) return null
  let model = null
  group.traverse((node) => {
    if (node.userData?.playerRig) model = node
  })
  return { group, model }
}

/**
 * What this frame's delivery actually did: the pitch's own release point in world
 * space, the body's placement, and where the *posed* hand carries the ball — the
 * three the release's accuracy is the agreement of. Read off the driver's own
 * solve (`userData.playerRig.arms`), not off the pose that asked for it.
 */
/** The trunk's own axis: the pelvis-root and ribcage bones' places and the ribcage's
 * own up, as the driver left them, in the rig frame (the frame the legs and the
 * arms report in: the model's own, turned about Y — see `toRigVector` in the
 * driver). Read off the bones' world matrices, so it is the realised skeleton.
 *
 * `side` is the ribcage's own left-right line, and it is the number to read for
 * "which way is the body turned": the chest is the last bone before the shoulders,
 * so its own line is the trunk's turn with *nothing* of the arms in it — where the
 * shoulder sockets are moved by each arm's own solve (its clavicle shifts the
 * reach), so the sockets' line turns with whatever the two arms happen to be doing
 * and says nothing extra about the trunk. The two agree wherever the arms are
 * quiet and part company where they are not (at the break the throwing arm is
 * swinging up past the shoulder, and the sockets read several hundred degrees a
 * second more of turn than the chest is making).
 *
 * `yaw` is the body's own turn about its up axis, in radians, in the same sense the
 * pose authors it (nought faces the plate). It is read off the chest's rotation
 * with the *lean divided out*: the driver composes the upper body as a yaw about
 * the up axis and then a fold (`Ry x Lean`, the yaw applied last), and for that
 * shape the lean's own columns leave the yaw exactly in the (row 0, column 2) /
 * (row 2, column 2) pair — so the trunk's turn is readable as itself rather than as
 * the ground-plane angle of a line that is leaning over (which mixes the two, and
 * reads a body leaning harder as a body turning faster).
 *
 * `head` is the head's own *line*: a direction in the rig frame, taken off the head
 * bone, which the driver's neck turn carries (the look is the neck's, and the head
 * rides it). It points down the pitch at the set — the same way the chest's own
 * forward does — and it is read as a direction rather than as a yaw with the lean
 * divided out because that is what the delivery promises: the eyes on the plate is a
 * *way the head points*, and a neck turned in a frame the look did not mean shows up
 * here as the difference, while two ways of writing the same yaw would not (see the
 * sequence's `look`).
 */
const _axisPoint = new THREE.Vector3()
const _axisUp = new THREE.Vector3()
const _axisSide = new THREE.Vector3()
const _axisHead = new THREE.Vector3()
const _axisQuat = new THREE.Quaternion()
const _axisMatrix = new THREE.Matrix4()
function spineAxis(model) {
  const group = model?.parent
  const base = model?.getObjectByName('spine')
  const chest = model?.getObjectByName('spine002')
  if (!group || !base || !chest) return null
  group.updateWorldMatrix(true, true)
  // A place: into the body's own frame, then the rig's (which is that frame turned
  // about Y — see the driver's `toRigVector`).
  const place = (bone) => {
    const at = group.worldToLocal(_axisPoint.setFromMatrixPosition(bone.matrixWorld))
    return [-at.x, at.y, -at.z]
  }
  // A direction: the same turn without the translation.
  _quat.copy(group.getWorldQuaternion(_quat)).invert()
  const chestWorld = chest.getWorldQuaternion(_quat2)
  _axisUp.set(0, 1, 0).applyQuaternion(chestWorld).applyQuaternion(_quat)
  _axisSide.set(1, 0, 0).applyQuaternion(chestWorld).applyQuaternion(_quat)
  // The body's own yaw: the chest's rotation in the body's frame, with the lean's
  // factor divided out (see above).
  _axisMatrix.makeRotationFromQuaternion(
    _axisQuat.copy(_quat).multiply(chestWorld),
  )
  const cells = _axisMatrix.elements
  // Read before the scratch matrix is reused below: `cells` is the matrix's own
  // array, not a copy of it.
  const yaw = Math.atan2(cells[8], cells[10])
  // ...and the head's own line, as the direction the head bone points along: the
  // neck is the bone the look is written on and the head hangs off it, so this is
  // the gaze itself, in the rig's own frame (down the pitch is -z, like the chest's
  // own forward — the head's own axis runs the same way, so it is its +z that looks
  // where the chest's does).
  const headBone = model.getObjectByName('spine006')
  let head = null
  if (headBone) {
    _axisHead.set(0, 0, 1)
      .applyQuaternion(headBone.getWorldQuaternion(_quat2))
      .applyQuaternion(_quat)
    // The same last step as the two above: the model's own z is the rig's the other
    // way round.
    head = [-_axisHead.x, _axisHead.y, -_axisHead.z]
  }
  return {
    base: place(base),
    chest: place(chest),
    up: [-_axisUp.x, _axisUp.y, -_axisUp.z],
    side: [-_axisSide.x, _axisSide.y, -_axisSide.z],
    yaw,
    head,
  }
}

function probe() {
  const scene = vr.scene
  const parts = pitcherParts(scene)
  if (!parts) return null
  const { group, model } = parts
  const debug = model?.userData?.playerRig ?? null
  const arm = debug?.arms?.find((entry) => entry.open && !entry.lead) ?? debug?.arms?.[0] ?? null
  group.updateWorldMatrix(true, true)
  let ball = null
  if (arm?.ball) {
    _ball.set(arm.ball[0], arm.ball[1], arm.ball[2])
    group.localToWorld(_ball)
    ball = _ball.toArray()
  }
  return {
    clip: vr.clip,
    release: RELEASE_WORLD.toArray(),
    position: group.getWorldPosition(_origin).toArray(),
    yaw: group.rotation.y,
    ball,
    ballRig: arm?.ball ?? null,
    // How far the posed hand's ball is from the point the pitch is drawn from.
    offset: ball ? _offset.copy(_ball).sub(RELEASE_WORLD).toArray() : null,
    miss: ball ? _ball.distanceTo(RELEASE_WORLD) : null,
    arm: arm && {
      side: arm.side,
      required: arm.required,
      reach: arm.reach,
      stretch: arm.stretch,
      wristMiss: arm.miss,
      shoulderTurn: arm.shoulderTurn,
      curl: arm.curl,
      // How close the arm came to the body's own volume: nought is clear of the
      // trunk and positive is inside it (see the driver's `armDepth`), plus what
      // the solve spent keeping it there — the fold it took, and the distance the
      // wrist ended up short of the place the pose asked for.
      depth: arm.armDepth,
      fold: arm.fold,
      short: arm.short,
      // The elbow's own bend, in degrees, off the posed bones.
      elbowDegrees: arm.bend * 180 / Math.PI,
      // The arm's own joints, in the rig frame: the socket the solve hung it
      // from, the elbow it chose on the pose's pole, and where the wrist and the
      // hand's own line of fingers ended up.
      shoulder: arm.shoulder,
      elbow: arm.elbow,
      elbowMiss: arm.elbowMiss,
      target: arm.target,
      wrist: arm.wrist,
      aim: arm.aim,
      // Where the palm is turned: the model's own palm marker's facing, in the rig
      // frame (see the driver's ``palmFacing``), the facing the pose asked for, and
      // the roll between them in degrees.
      palm: arm.palm,
      palmAsk: arm.palmAsk,
      palmRoll: arm.palmRoll,
      ballRig: arm.ball,
    },
    // Copied out rather than handed back: the driver keeps one report per frame and
    // refills it, so a ``sweep`` that passed its rows through would serialize the last
    // frame's sockets for every frame (see ``copyPlain``).
    arms: debug?.arms?.map((entry) => ({
      side: entry.side,
      open: !!entry.open,
      required: entry.required,
      reach: entry.reach,
      stretch: entry.stretch,
      miss: entry.miss,
      curl: entry.curl,
      depth: entry.armDepth,
      fold: entry.fold,
      short: entry.short,
      elbowDegrees: entry.bend * 180 / Math.PI,
      // The socket the arm hung from, in the rig frame: the two of them are the
      // shoulder line, which is the thing the body's own opening is read from. The
      // elbow and the wrist come with it, because the lead arm's own *shape* — which
      // way its forearm points — is what the delivery's turn is authored off.
      shoulder: copyPlain(entry.shoulder),
      elbow: copyPlain(entry.elbow),
      wrist: copyPlain(entry.wrist),
      // The hand's own line off the wrist (the model's fingers, in the rig frame):
      // what the pose's own ``gloveAim`` asks for, and the axis the palm's roll
      // turns about — a palm can only be rolled onto a facing square to it, so the
      // two are read together (see the suite's palm test).
      aim: copyPlain(entry.aim),
      // The hand's own turn: which way the palm faces the plate, in the rig frame,
      // and the roll the pose's own answer for it took (see the driver's open-hand
      // arm solve) — the lead arm's palm is the delivery's own way of showing the
      // ball, and the turn it takes through the unwind is a shape like any other.
      palm: copyPlain(entry.palm),
      palmAsk: copyPlain(entry.palmAsk),
      palmRoll: entry.palmRoll,
    })) ?? null,
    legs: copyPlain(debug?.legs) ?? null,
    // The torso's own axis, read off the spine's two bones rather than off the
    // shoulders: a shoulder socket is moved by *that arm's* own solve (its clavicle
    // shifts the reach), so the sockets' midpoint tilts with whatever the two arms
    // happen to be doing and says nothing about the trunk. The spine bones are the
    // trunk — `base` is the torso's root above the pelvis and `chest` the ribcage's
    // — so the line between them is the axis the body is turning on, and how much of
    // it points sideways is whether the torso leans off that axis or simply turns on
    // it. Both in the rig frame, like the legs and the arms.
    torso: spineAxis(model),
    // What the trunk's own two blocks differ by, off the driver's read-back of the
    // chain it just wrote: the *shear* is how far the pelvis's and the chest's up
    // axes disagree, which is nought for a torso that leans as one piece and turns
    // about the axis it is leaning on — and is the lean's own angle for a pelvis
    // left upright under a torso that bends over it (see the driver's `separation`).
    separation: copyPlain(debug?.torso?.separation ?? null),
    pose: debug?.pose ?? null,
    pitcherData: model?.userData?.pitcher ?? null,
  }
}

vr.probe = probe

// What the belt's cut does in this frame: the seam's own two edges, placed one
// following the pelvis and one following the torso, and how far the two have
// drifted apart — the vertical part of it is what the sleeve's margin has to run
// past, and it is the number the eye reads as the belt coming apart. Same read the
// batter's harness makes (see its `probeSleeve`), off the driver's own ring.
const _restVertex = new THREE.Vector3()
const _skinMatrix = new THREE.Matrix4()
function probeSleeve() {
  const parts = pitcherParts(vr.scene)
  const mesh = parts?.model?.getObjectByName('JOINED')
  const solve = parts?.model?.userData?.playerRig
  const sleeve = solve?.sleeve
  if (!mesh?.isSkinnedMesh || !sleeve?.ring?.length) return null
  const { unitScale } = solve.metrics
  const bones = mesh.skeleton.bones
  const boneNames = bones.map((bone) => bone.name)
  const pelvis = boneNames.indexOf(PART_BONES.pelvis[0])
  const torso = boneNames.indexOf(PART_BONES.torso[0])
  if (pelvis < 0 || torso < 0) return null
  const placed = (bone, out) => {
    _skinMatrix.multiplyMatrices(bones[bone].matrixWorld, mesh.skeleton.boneInverses[bone])
    return out.copy(_restVertex).applyMatrix4(_skinMatrix).applyMatrix4(mesh.bindMatrixInverse)
  }
  const low = []
  const high = []
  for (const point of sleeve.ring) {
    _restVertex.fromArray(point).applyMatrix4(mesh.bindMatrix)
    low.push(placed(pelvis, new THREE.Vector3()).clone())
    high.push(placed(torso, new THREE.Vector3()).clone())
  }
  let open = 0
  let gap = 0
  for (const point of low) {
    let nearest = high[0]
    for (const other of high) if (point.distanceTo(other) < point.distanceTo(nearest)) nearest = other
    open = Math.max(open, Math.abs(point.y - nearest.y) * unitScale)
    gap = Math.max(gap, point.distanceTo(nearest) * unitScale)
  }
  return { cut: sleeve.cut, margin: sleeve.margin, inset: sleeve.inset, lip: sleeve.lip, open, gap }
}
vr.probeSleeve = probeSleeve

// What the belt's own surfaces are, read by ringing the waist with rays.
//
// Two things the cut can get wrong are *seen* rather than measured, and a ray is
// what reads either. A hole: a ray that goes through the uniform and out into the
// body's inside, which is what a tear that nothing backs looks like. And the inset
// sleeve standing in front of the uniform it is copied from: its own surface is
// the outermost thing the ray meets, which is what "the jersey's sleeve shows
// through" — the tear at the pitcher's waist — was.
//
// What a ray *cannot* read is the thing the tear at the pitcher's waist actually
// was — a backing sunk past the body, so that the gap in the uniform showed bare
// skin. That is a surface's place rather than a hole, and the second surface along
// a ray through the waist is as often the far side of the body as the near side of
// it. The appearance is pinned by the belt crops in the suite instead, and this
// probe reports what it can: whether the uniform is whole.
//
// The rays are cast in the model's own space, around the axis the cut is measured
// from, over the sleeve's own margin either side of the cut — everything the cut
// touches and nothing else — and far enough out to clear the body, scaled off the
// belt's own width rather than assumed.
const BELT_PROBE_RINGS = 32
const BELT_PROBE_ROWS = 9
function probeBelt() {
  const parts = pitcherParts(vr.scene)
  const mesh = parts?.model?.getObjectByName('JOINED')
  const solve = parts?.model?.userData?.playerRig
  const belt = solve?.sleeve
  const scene = vr.scene
  if (!mesh?.isSkinnedMesh || !belt?.ring?.length) return null
  const { unitScale } = solve.metrics
  const [axisX, axisZ] = belt.axis
  const cutY = belt.cut / unitScale
  const marginY = belt.margin / unitScale
  const radius = Math.max(...belt.ring.map(([x, , z]) => Math.hypot(x - axisX, z - axisZ))) * 2
  const sleeveStart = mesh.geometry.index.count - belt.sleeve
  const rc = new THREE.Raycaster()
  const from = new THREE.Vector3()
  const at = new THREE.Vector3()
  let rays = 0
  let holes = 0
  let through = 0
  for (let row = 0; row <= BELT_PROBE_ROWS; row += 1) {
    const h = cutY + ((row / BELT_PROBE_ROWS) - 0.5) * 2 * marginY
    for (let i = 0; i < BELT_PROBE_RINGS; i += 1) {
      const angle = (i / BELT_PROBE_RINGS) * Math.PI * 2
      from.copy(at.set(axisX + Math.cos(angle) * radius, h, axisZ + Math.sin(angle) * radius))
      mesh.localToWorld(from)
      const aim = mesh.localToWorld(at.set(axisX, h, axisZ)).clone()
      rc.set(from, aim.sub(from).normalize())
      const hits = rc.intersectObjects(scene.children, true).filter((hit) => hit.object.isSkinnedMesh)
      rays += 1
      if (!hits.length) {
        holes += 1
        continue
      }
      if (hits[0].object === mesh && hits[0].faceIndex * 3 >= sleeveStart) through += 1
    }
  }
  return { rays, holes, through, cut: belt.cut, margin: belt.margin, inset: belt.inset }
}
vr.probeBelt = probeBelt

// Move the pin to another frame of the delivery and answer with what that frame is:
// the harness holds the simulation clock still, so this is the only way to walk from
// one pose to another (and what a test checks a whole window with).
const settle = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve))
})
vr.setClip = async (clip) => {
  pinned.at = cycleTimeForClip(clip)
  vr.clip = clip
  await settle()
  return probe()
}

/** The probe at every frame of a window of the delivery's clock, in order. */
vr.sweep = async (from, to, step) => {
  const out = []
  for (let clip = from; clip <= to + 1e-9; clip += step) out.push(await vr.setClip(clip))
  return out
}

/** The ground plane the pitcher stands on, at the mound's own height. */
function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -17.4]}>
      <planeGeometry args={[24, 24]} />
      <meshStandardMaterial color="#c8a06a" roughness={1} />
    </mesh>
  )
}

/** The pitch's own release point, and the posed hand's ball, drawn as dots. */
function ReleaseMarkers() {
  const scene = useThree((state) => state.scene)
  const marker = useRef()
  const hand = useRef()
  useFrame(() => {
    if (hand.current) {
      const parts = pitcherParts(scene)
      const debug = parts?.model?.userData?.playerRig
      const arm = debug?.arms?.find((entry) => entry.open && !entry.lead)
      if (arm?.ball) {
        parts.group.localToWorld(_ball.set(arm.ball[0], arm.ball[1], arm.ball[2]))
        hand.current.position.copy(_ball)
        hand.current.visible = true
      } else {
        hand.current.visible = false
      }
    }
  })
  return (
    <>
      <mesh ref={marker} position={RELEASE_WORLD.toArray()}>
        <sphereGeometry args={[0.05, 12, 12]} />
        <meshBasicMaterial color="#00ff66" />
      </mesh>
      <mesh ref={hand}>
        <sphereGeometry args={[0.035, 12, 12]} />
        <meshBasicMaterial color="#ff2244" />
      </mesh>
    </>
  )
}

/** Frames the camera once on the pitcher's own place, so every clip pins alike. */
function Framing() {
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)
  const framed = useRef(false)
  useFrame(() => {
    if (framed.current) return
    const parts = pitcherParts(scene)
    if (!parts) return
    framed.current = true
    const centre = parts.group.getWorldPosition(new THREE.Vector3())
    centre.y += 1.1
    const distance = 5.6 / CAMERA_ZOOM
    camera.position.copy(centre).addScaledVector(CAMERA_DIRECTION, distance)
    camera.lookAt(centre)
    camera.updateProjectionMatrix()
    vr.framing = { centre: centre.toArray(), view: viewName, zoom: CAMERA_ZOOM }
    vr.camera = camera
    vr.ready = true
  })
  return null
}

function Stage() {
  const scene = useThree((state) => state.scene)
  useFrame(() => {
    vr.frames += 1
    vr.scene = scene
  })
  return (
    <>
      <Pitcher pitchData={PITCH} />
      <ReleaseMarkers />
      <Framing />
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <Canvas
    dpr={1}
    camera={{ fov: CAMERA_FOV, near: 0.05, far: 200 }}
    gl={{ antialias: true }}
    onCreated={({ scene }) => { vr.scene = scene }}
  >
    <color attach="background" args={['#8fc4ec']} />
    {/* Lighting copied from Scene.jsx (ambient 0.5 + a key light at [10, 10, 5]). */}
    <ambientLight intensity={0.5} />
    <directionalLight position={[10, 10, 5]} intensity={1} />
    {/* Mounted first, so the pin lands in the same frame as the pose that reads
        it: three's clock has already accumulated the frame's delta by the time
        the subscribers run. */}
    <TimePin />
    <Ground />
    <Suspense fallback={null}>
      <Stage />
    </Suspense>
  </Canvas>,
)
