// oxlint-disable react/only-export-components -- Vite entry point: it mounts the
// harness and intentionally exports nothing.
import React, { Suspense, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { Batter } from '../../src/components/Batter'
import { ARM_BONES, PART_BONES, PLAYER_BONES } from '../../src/util/playerRig'
import { setCycleDuration, setSimulationTime, setTimeScale } from '../../src/constants/playback'
import { DEFAULT_TUNING, getTuning, setTuningValue } from '../../src/constants/tuning'
import { CONTACT_WORLD, CYCLE_DURATION_S, PHASES, STANCE_PITCH } from './fixture'

// ---------------------------------------------------------------------------
// Test-only harness page for the batter visual-regression suite.
//
// It mounts the real <Batter> component from the app (no stubs, no copies) on a
// bare stage with the app's lighting, pinned to one phase of the swing cycle, so
// Playwright can compare renders against committed baselines. The suite is
// described in frontend/e2e/batter.visual.spec.js; the pitch fixture and phase
// times live in ./fixture.js.
//
// Determinism is the whole job here. The batter's pose is driven by the shared
// simulation clock plus one wall-clock term (the idle stance bob), so the
// harness:
//   1. forces the tuning groups that affect this pose back to DEFAULT_TUNING
//      (a developer's saved DebugDrawer tweaks on this origin would otherwise
//      silently re-baseline the renders),
//   2. zeroes the idle bounce, which is driven by real elapsed time and is the only
//      non-clock input to the pose (``?idle=1`` keeps it, for measuring it — with
//      the idle clock itself pinnable and sweepable, see sweepIdle),
//   3. pins the cycle duration, and
//   4. freezes the simulation clock at the phase time every animation frame.
//
// The camera is framed ONCE from the batter's set stance and then left alone, so
// all four phases share the exact same view and can be compared pose-to-pose.
//
// The drei <Environment preset> the app uses is deliberately omitted: it streams
// an HDRI over the network, which would make renders depend on a CDN. Lighting
// matches Scene.jsx apart from that.
// ---------------------------------------------------------------------------

// The batter's root group (named by the component) and the bat node inside it.
// The bat is measured separately and left out of the body's bounds: it swings
// far outside the body, so including it would make the camera depend on the pose.
const BATTER_NAME = 'batter'
const BAT_NAME = 'bat'
// The bat's swing frame: the group carrying the swing's own yaw, whose local X
// is the axis the barrel sweeps about — the normal of the bat's swing plane.
const SWING_FRAME_NAME = 'bat-swing-frame'

// The batter's own frame loop advances the shared clock by delta * timeScale, so
// a near-zero scale holds the pose on the pinned phase time (the residual drift
// is ~1e-8 s per frame).
const FROZEN_TIME_SCALE = 1e-9

// Frames to let the stance pose settle before the camera is framed from it.
const FRAME_SETTLE_FRAMES = 5

const TUNING_GROUPS_IN_PLAY = ['batter', 'playback']

// Camera: a three-quarter view from the pitcher's side, fitted to the batter's
// stance with enough padding that the bat stays in frame through the whole
// swing. SWING_MARGIN is the extra distance the barrel travels outside the
// body's own bounds.
const CAMERA_FOV = 38
// Debug aid: the suite always frames from the three-quarter view below, but a
// pose can be checked from the front or the side (?view=front|side|back) where
// a torso that is not following the hips is obvious.
const VIEWS = {
  'three-quarter': [1.15, 0.42, -1],
  front: [0, 0.25, -1],
  side: [1, 0.2, 0],
  // The other ear: `side` frames the batter's lead side (where the helmet's one
  // flap belongs), and this is the side that has to be clear of one.
  'side-trail': [-1, 0.2, 0],
  back: [0, 0.3, 1],
  low: [0, 0.7, -1],
  top: [0, 3, -0.25],
}
const query = new URLSearchParams(window.location.search)
const viewName = query.get('view') || 'three-quarter'
// ...and ?cam=x,y,z for a direction the named views do not cover — the batter's own
// *chest* is one, because he is squared to the plate rather than to the pitcher, so
// the seam down his jersey is read head-on from a direction none of the six above
// looks along. Same contract as the rest: a debug knob the suite never passes.
// Colons as well as commas: a query string is split on commas by every kit script that
// passes one, so a direction has to be writable without them (?cam=1:0.15:-0.06).
const camParam = (query.get('cam') || '').split(/[,:]/).map(Number)
const CAMERA_DIRECTION = (camParam.length === 3 && camParam.every(Number.isFinite)
  ? new THREE.Vector3(...camParam)
  : new THREE.Vector3(...(VIEWS[viewName] ?? VIEWS['three-quarter']))).normalize()
// ?zoom=0.5 halves the framing distance, for a close look at the pose. The
// suite never passes it, so the baselines keep the default framing.
const CAMERA_ZOOM = Number(query.get('zoom') || 1) || 1
// ?focus=torso frames on the torso's own joints instead of the whole body, so a
// pose can be inspected where a twisting waist shows up. Same contract as
// ?zoom: a debug knob the suite never passes.
const FOCUS_BONES = {
  torso: ['spine', 'spine001', 'spine002', 'neck', 'shoulderL', 'shoulderR'],
  arms: ['upper_armL', 'upper_armR', 'forearmL', 'forearmR', 'handL', 'handR'],
  // The grip alone: the fists and the handle they close on, for looking at how
  // the palms sit on the bat.
  hands: ['handL', 'handR', 'fingersL', 'fingersR', 'thumbL', 'thumbR'],
  // The hip crease: where the trunks meet the legs.
  hips: ['spine', 'spine001', 'pelvisL', 'pelvisR', 'thighL', 'thighR'],
  // The head: the helmet, the face and what the brim covers. The model's own
  // head is the last spine link.
  head: ['neck', 'spine006'],
  // The feet: the shoe, its laces and the sock it meets. The ankle, the toe and
  // the heel are the bones the shoe's own weights name.
  feet: ['footL', 'footR', 'toeL', 'toeR', 'heel02L', 'heel02R'],
}
const CAMERA_FOCUS = FOCUS_BONES[query.get('focus')] || null
// ?fade=arms,head draws those parts translucent, which is how the torso's own
// deformation is inspected: the body is one skinned mesh, so a part is addressed
// by the *bones* that drive it and every vertex fades by the share of it those
// bones skin. Names are grouped so the usual questions are one word — see
// FADE_REGIONS. ?fadeOpacity= sets how much of a faded part stays visible (0.18
// by default: enough to see where the part is, little enough to see through it).
// Same contract as ?view / ?zoom / ?focus: a knob the suite never passes, so it
// cannot move a committed baseline.
const FADE_REGIONS = {
  head: ['neck', 'spine006'],
  torso: ['spine', 'spine001', 'spine002'],
  arms: ['upper_armL', 'upper_armR', 'forearmL', 'forearmR'],
  hands: ['handL', 'handR', 'fingersL', 'fingersR', 'thumbL', 'thumbR'],
  // Both at once, as one word: the arms alone still leave the fists in front of the
  // chest, and a query string is split on commas by every kit script that passes it.
  limbs: ['upper_armL', 'upper_armR', 'forearmL', 'forearmR',
    'handL', 'handR', 'fingersL', 'fingersR', 'thumbL', 'thumbR'],
  legs: ['thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR', 'toeL', 'toeR'],
}
// Parts that are their own mesh rather than a region of the skinned body.
const FADE_MESHES = { bat: BAT_NAME }
const FADE_OPACITY = Number(query.get('fadeOpacity') || 0.18) || 0.18
const HEAT_BONE = query.get('heat')
// Measurement aid: ?mark=1 draws a ruler of rings around the body — one every
// 0.05 rig units from 1.15 to 1.60, magenta on the tenths — so a height can be
// read off a render by eye when tuning where a region of the body turns.
const MARK_RULER = query.get('mark') === '1'
// `?ring=1.15,1.22,1.28,1.34` draws one ring per height, each in its own colour
// (?ring= is a measurement aid the suite never passes, like ?mark=1).
const RING_COLORS = [0xff00ff, 0x00ffff, 0x00ff00, 0x8000ff]
// Empty entries are dropped *before* they are turned into numbers: `Number('')`
// is 0, which is finite, so an unset parameter would otherwise draw an aid at
// rig 0 — a magenta ring lying in the ground plane, z-fighting with it, in every
// render the suite takes.
const RING_HEIGHTS = (query.get('ring') || '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '')
  .map(Number)
  .filter((value) => Number.isFinite(value))
// `?dot=1.16,1.22,1.28,1.34` draws a small coloured dot either side of the body
// at each height: at the body's own depth, so a front view reads a height off
// the silhouette without the rings' perspective getting in the way.
const DOT_HEIGHTS = (query.get('dot') || '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '')
  .map(Number)
  .filter((value) => Number.isFinite(value))
const fadeNames = (query.get('fade') || '').split(',').map((name) => name.trim()).filter(Boolean)
for (const name of fadeNames) {
  if (!FADE_REGIONS[name] && !FADE_MESHES[name]) {
    throw new Error(`unknown fade region "${name}" (expected one of ${[...Object.keys(FADE_REGIONS), ...Object.keys(FADE_MESHES)].join(', ')})`)
  }
}
const FRAME_MARGIN = 1.15
const SWING_MARGIN = 1.25

const phaseName = new URLSearchParams(window.location.search).get('phase') || 'contact'
const phase = PHASES[phaseName]
if (!phase) throw new Error(`unknown phase "${phaseName}" (expected one of ${Object.keys(PHASES).join(', ')})`)
// ``&time=`` pins the clock somewhere else inside the phase's own window, so a
// motion that happens *between* the named shots (the arms unwinding off the
// torso half way through the recovery, say) can be measured rather than
// guessed at. The phase's pitch and camera are unchanged.
const timeParam = Number(new URLSearchParams(window.location.search).get('time'))
const phaseTime = Number.isFinite(timeParam) && timeParam > 0 ? timeParam : phase.time

for (const group of TUNING_GROUPS_IN_PLAY) {
  for (const [key, value] of Object.entries(DEFAULT_TUNING[group])) {
    setTuningValue(group, key, value, { persist: false })
  }
}
// Idle bounce: the one real-time term in the stance pose. Its amplitudes are
// zeroed by default so every render here is a pure function of the pinned clock;
// ``?idle=1`` keeps them, and the idle clock below can then be walked the same
// way the simulation clock is (see sweepIdle).
const idleQuery = new URLSearchParams(window.location.search)
const idleParam = idleQuery.get('idle')
const idleOn = idleParam === '1' || idleParam === 'true'
const IDLE_KEYS = [
  'swayKneeFlex',
  'swaySwayAmount',
  'swayKneeTravel',
  'swayLeanAmount',
  'swayBatWiggle',
  'swayBatRoll',
]
for (const key of IDLE_KEYS) {
  if (!idleOn) setTuningValue('batter', key, 0, { persist: false })
}

setCycleDuration(CYCLE_DURATION_S, { force: true })
setTimeScale(FROZEN_TIME_SCALE)
setSimulationTime(phaseTime)

// Probe surface the Playwright spec drives. Functions are bound to the live
// scene once the canvas exists.
const vr = {
  ready: false,
  phase: phaseName,
  time: phaseTime,
  // Set once the player model's asset is cached (see PlayerAssetReady).
  playerLoaded: false,
  frames: 0,
  // Debug fade: the regions asked for, and how many meshes it caught.
  fade: fadeNames,
  fadedMeshes: 0,
  probeBat: () => null,
  probeBones: () => null,
  probeSolve: () => null,
  probeStrain: () => null,
  probeGrip: () => null,
  probeBatBody: () => null,
  probeCover: () => null,
  probeKit: () => null,
  // Set once, when the camera was framed: the measurement the framing was based
  // on, kept for diagnosing a baseline shift.
  framing: null,
}
window.__vr = vr

const _origin = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _vertex = new THREE.Vector3()
const _sweep = new THREE.Vector3()
const _sweepQuat = new THREE.Quaternion()

// Where the bat is right now: its handle (the node's own origin) and the barrel
// direction (the node's local -Z), both in world space. ``length`` is the true
// rendered handle -> barrel-tip distance, measured from the live vertices rather
// than assumed from the authored model or the batter's size scaling.
function probeBat(scene) {
  const bat = scene.getObjectByName(BAT_NAME)
  if (!bat) return null
  bat.updateWorldMatrix(true, false)
  bat.getWorldPosition(_origin)
  bat.getWorldQuaternion(_quat)
  _axis.set(0, 0, -1).applyQuaternion(_quat).normalize()

  let tipDistance = 0
  bat.traverse((child) => {
    if (!child.isMesh || !child.geometry) return
    const position = child.geometry.getAttribute('position')
    if (!position) return
    child.updateWorldMatrix(true, false)
    for (let i = 0; i < position.count; i += 1) {
      _vertex.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld)
      tipDistance = Math.max(tipDistance, _vertex.sub(_origin).dot(_axis))
    }
  })

  // The plane the bat *swings in*: the swing frame's own +X, which is the axis
  // the barrel sweeps about (the yaw group in Batter.jsx — the bat's tilt rides
  // on the two groups inside it, both about this same axis), so the barrel's line
  // and this axis span the plane the bat swings in. Read off the live scene rather
  // than fitted to the tip's motion, so it is defined at every sample — including
  // the ones where the bat is barely moving and such a fit is ill-conditioned.
  const swingFrame = scene.getObjectByName(SWING_FRAME_NAME)
  if (swingFrame) {
    swingFrame.updateWorldMatrix(true, false)
    _sweep.set(1, 0, 0).applyQuaternion(swingFrame.getWorldQuaternion(_sweepQuat)).normalize()
  } else {
    _sweep.set(0, 0, 0)
  }

  return {
    origin: [_origin.x, _origin.y, _origin.z],
    axis: [_axis.x, _axis.y, _axis.z],
    sweep: [_sweep.x, _sweep.y, _sweep.z],
    length: tipDistance,
  }
}

// A plain copy of a subtree of the driver's own report, so a probe answers with
// the frame it was asked about. The driver keeps *one* report and rewrites it in
// place every frame, and ``sweep`` hands its rows back to Playwright to serialize
// only after the whole sweep is done — with a live reference every row would
// serialize the last frame's solve (and, since a sweep puts the clock back where
// the phase left it, the phase time's solve for *every* row). Copies are shallow
// in the type sense: the report is numbers, strings and arrays.
function copyPlain(value) {
  if (Array.isArray(value)) return value.map(copyPlain)
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = copyPlain(item)
    return out
  }
  return value
}

// The last frame's arm and leg solves, straight from the bone driver (rig units).
function probeSolve(scene) {
  const batter = scene.getObjectByName(BATTER_NAME)
  let debug = null
  batter?.traverse((node) => {
    if (!debug && node.userData?.playerRig) debug = node.userData.playerRig
  })
  return debug ? copyPlain(debug) : null
}

// How hard the bands between the parts are working.
//
// The parts are rigid and the joints are narrow bands of blended weights, so a
// joint's whole rotation has to be absorbed by a thin strip of skin: the bands
// are where a pose *stretches*, and how much is a question of how far apart the
// two parts pull the skin between them. This measures that directly, off the
// skinning: for every vertex whose weights straddle two parts, where the vertex
// would be if it followed each part alone, and the distance between those two
// answers — the gap the band's skin has to span. Reported in rig units and as a
// fraction of the band's own width, which is the number the eye reads as "the
// hips are tearing".
const _skinMatrix = new THREE.Matrix4()
const _skinVertex = new THREE.Vector3()
const _restVertex = new THREE.Vector3()
const _scratch = new THREE.Vector3()
const _partPoint = { pelvis: new THREE.Vector3(), torso: new THREE.Vector3(), legs: new THREE.Vector3(), head: new THREE.Vector3() }

function probeStrain(scene) {
  const batter = scene.getObjectByName(BATTER_NAME)
  const mesh = batter?.getObjectByName('JOINED')
  const solve = probeSolve(scene)
  if (!mesh?.isSkinnedMesh || !solve?.parts) return null
  const { skinIndex, skinWeight, position } = mesh.geometry.attributes
  if (!skinIndex || !skinWeight) return null
  const { unitScale } = solve.metrics
  // What each band is worth, from the driver's own cut: the band a pair of parts
  // shares, keyed the way the pair is named below (the two parts in alphabetical
  // order), in the order the body stacks them.
  const width = {
    'legs/pelvis': solve.parts.hip[1] - solve.parts.hip[0],
    'pelvis/torso': solve.parts.waist[1] - solve.parts.waist[0],
    'head/torso': solve.parts.neck[1] - solve.parts.neck[0],
  }
  const bands = Object.keys(width)

  const partOfBone = new Map()
  for (const [part, name] of Object.entries(PART_BONES)) {
    for (const bone of name) partOfBone.set(bone, part)
  }
  const bones = mesh.skeleton.bones
  const boneNames = bones.map((bone) => bone.name)
  const stack = Object.keys(PART_BONES)

  const bandsFound = {}
  let worst = { gap: 0, parts: null, rigY: null, share: 0 }
  const sums = { pelvis: 0, torso: 0, legs: 0, head: 0 }
  const neck = solve.parts.neck
  const reach = { onArms: 0, outside: 0 }
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    for (const part of stack) {
      sums[part] = 0
      _partPoint[part].set(0, 0, 0)
    }
    // The bind matrix is what the mesh's own space was when the skeleton was
    // bound (the loader gives the mesh one), so the skinning matrices only mean
    // anything with it on both sides — as the shader applies them.
    _restVertex.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix)
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.array[vertex * 4 + slot]
      if (!weight) continue
      const index = skinIndex.array[vertex * 4 + slot]
      const part = partOfBone.get(boneNames[index])
      if (!part) continue
      sums[part] += weight
      _skinMatrix.multiplyMatrices(bones[index].matrixWorld, mesh.skeleton.boneInverses[index])
      _partPoint[part].addScaledVector(_skinVertex.copy(_restVertex).applyMatrix4(_skinMatrix), weight)
    }
    const body = sums.pelvis + sums.torso + sums.legs + sums.head
    const rigY = position.getY(vertex) * unitScale
    // The head's reach, over the whole body: how much of the head's bones is
    // carried by skin that is not the neck's. A shoulder or a sleeve that turns
    // with the look is the chest being wrung, and skin outside the neck band that
    // blends the head and the torso is the same fault smeared lower, so both are
    // measured here rather than only where two parts happen to meet.
    if (sums.head > 0) {
      if (body < 0.5) reach.onArms = Math.max(reach.onArms, sums.head)
      else if (sums.torso / body >= 0.05 && (rigY < neck[0] - 0.02 || rigY > neck[1] + 0.02)) {
        reach.outside = Math.max(reach.outside, Math.min(sums.head, sums.torso / body))
      }
    }

    const carrying = stack.filter((part) => sums[part] > 1e-4)
    if (carrying.length < 2) continue
    for (const part of carrying) {
      _partPoint[part].multiplyScalar(1 / sums[part]).applyMatrix4(mesh.bindMatrixInverse)
    }

    for (let i = 0; i < carrying.length; i += 1) {
      for (let j = i + 1; j < carrying.length; j += 1) {
        const key = [carrying[i], carrying[j]].sort().join('/')
        // Only the bands the body actually stacks: two parts that meet across a
        // band are a joint, and any other pair (a shoulder blade's skin reaching
        // a thigh bone, say) is not one of the cut's bands at all.
        if (!bands.includes(key)) continue
        const gap = _partPoint[carrying[i]].distanceTo(_partPoint[carrying[j]]) * unitScale
        const share = gap / (width[key] ?? 1)
        const band = bandsFound[key] ?? { worst: 0, share: 0, vertices: 0, rigY: null }
        band.vertices += 1
        if (share > band.share) {
          band.share = share
          band.worst = gap
          band.rigY = rigY
        }
        // And the same number over the skin the two parts really *share*: the
        // vertices carried mostly by the body's own parts, with at least a fifth
        // of each of the pair. A shoulder vertex with a sliver of the neck on it
        // is pulled apart by the head's turn as far as the geometry goes, but it
        // is not the joint's own skin — it is the arms'.
        const onJointSkin =
          body >= 0.5 && sums[carrying[i]] / body >= 0.2 && sums[carrying[j]] / body >= 0.2
        if (onJointSkin) {
          const entry = band.shared ?? { share: 0, worst: 0, rigY: null, vertices: 0, low: Infinity, high: -Infinity }
          entry.vertices += 1
          entry.low = Math.min(entry.low, rigY)
          entry.high = Math.max(entry.high, rigY)
          if (share > entry.share) {
            entry.share = share
            entry.worst = gap
            entry.rigY = rigY
          }
          band.shared = entry
        }
        bandsFound[key] = band
        if (share > worst.share) {
          worst = { gap, parts: key, rigY: band.rigY, share }
        }
      }
    }
  }
  return { worst, bands: bandsFound, head: reach }
}

// How the two fists are holding the handle.
//
// The model came with its own bat-holding rig: a ``palm_handle`` node in each
// palm (the point of the handle the fist closes on, and the direction the handle
// runs through the palm) and one IK target per hand. Those are the model's own
// statement of a two-hand grip, and this reads the *posed* result back against
// them: where each palm's handle point sits against the bat's axis, how far apart
// the two fists grip along it, and how much of each fist's skin has ended up on
// the far side of the handle (a palm closed on the bat has skin either side of
// its axis). Measured off the posed skin and the live bones, in rig units.
function probeGrip(scene) {
  const batter = scene.getObjectByName(BATTER_NAME)
  const mesh = batter?.getObjectByName('JOINED')
  const frame = batter?.getObjectByName('batter-frame')
  const bat = scene.getObjectByName(BAT_NAME)
  if (!mesh?.isSkinnedMesh || !frame || !bat) return null
  const perMetre = 1 / frame.getWorldScale(new THREE.Vector3()).x
  bat.updateWorldMatrix(true, false)
  const origin = bat.getWorldPosition(new THREE.Vector3())
  const axis = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(bat.getWorldQuaternion(new THREE.Quaternion()))
    .normalize()
  const rig = (point) => new THREE.Vector3().copy(point).sub(origin).multiplyScalar(perMetre)
  const bones = mesh.skeleton.bones
  const boneNames = bones.map((bone) => bone.name)
  // The two hand targets the model's rig carries, and the spacing between them:
  // the grip the hands were modelled for (see BAT_HAND_TARGETS).
  const target = (name) => batter.getObjectByName(name)?.getWorldPosition(new THREE.Vector3()) ?? null
  const bottom = target('BatBottomHandIK')
  const top = target('BatTopHandIK')
  const targets = bottom && top ? rig(bottom).distanceTo(rig(top)) : null
  const hand = (side) => {
    const marker = batter.getObjectByName(`palm_handle${side}`)
    if (!marker) return null
    const at = marker.getWorldPosition(new THREE.Vector3())
    const rel = rig(at)
    const along = rel.dot(axis)
    const radial = rel.clone().addScaledVector(axis, -along).length()
    // The direction the handle runs through the palm: the marker's own local +Y,
    // which is how the model's rig states it. A fist closed on the bat has that
    // lying along the barrel; a fist lying across it does not.
    const through = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(marker.getWorldQuaternion(new THREE.Quaternion()))
      .normalize()
    const alongHandle = Math.abs(through.dot(axis))
    // The fist's own skin: the surface the handle runs through. The hands are
    // their own meshes — the body mesh carries no hand skin at all — so the fist
    // is read off the hand mesh, posed by the same skeleton.
    const fist = batter.getObjectByName(`Hand${side}`)
    if (!fist?.isSkinnedMesh) return null
    const { skinIndex, skinWeight, position } = fist.geometry.attributes
    const fistBones = fist.skeleton.bones
    const fistNames = fistBones.map((bone) => bone.name)
    const arm = ARM_BONES[side]
    const set = new Set([arm.hand, arm.fingers, `thumb${side}`])
    const matrix = new THREE.Matrix4()
    const placed = new THREE.Vector3()
    const rest = new THREE.Vector3()
    const skin = []
    const worldSkin = []
    // Which bone group carries each vertex: the palm (the hand bone itself), the
    // four fingers, or the thumb. "Do the fingers curl round the handle" is a
    // question about the two latter groups, not about the fist as a whole — the
    // palm's own skin sits on the near side of the handle by construction.
    const groupOf = { [arm.hand]: 'palm', [arm.fingers]: 'fingers', [`thumb${side}`]: 'thumb' }
    const groupOfVertex = []
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      let on = 0
      let heaviest = null
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = skinWeight.array[vertex * 4 + slot]
        if (!weight) continue
        const bone = fistNames[skinIndex.array[vertex * 4 + slot]]
        if (set.has(bone)) on += weight
        if (!heaviest || weight > heaviest.weight) heaviest = { bone, weight }
      }
      if (on < 0.5) continue
      rest.fromBufferAttribute(position, vertex).applyMatrix4(fist.bindMatrix)
      placed.set(0, 0, 0)
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = skinWeight.array[vertex * 4 + slot]
        if (!weight) continue
        const index = skinIndex.array[vertex * 4 + slot]
        matrix.multiplyMatrices(fistBones[index].matrixWorld, fist.skeleton.boneInverses[index])
        placed.addScaledVector(rest.clone().applyMatrix4(matrix), weight)
      }
      placed.applyMatrix4(fist.bindMatrixInverse).applyMatrix4(fist.matrixWorld)
      worldSkin.push(placed.clone())
      skin.push(rig(placed))
      groupOfVertex.push(groupOf[heaviest?.bone] ?? 'other')
    }
    // The two sides of the handle, as the fist sees them: the closest point on
    // the bat's axis to the fist's own centre of mass, and how far every vertex
    // of the fist lies either side of that. A palm closed on the bat has skin
    // behind the axis (the fingers curling round it); a hand lying alongside the
    // bat has none, and the whole hand is on the near side.
    const centre = new THREE.Vector3()
    for (const point of skin) centre.add(point)
    centre.divideScalar(Math.max(1, skin.length))
    // The bat's axis passes through the frame's own origin, so a point's offset
    // from the axis is its distance from the axis *line*.
    const outward = centre.clone().addScaledVector(axis, -centre.dot(axis)).normalize()
    let behind = 0
    let straddleMin = Infinity
    let straddleMax = -Infinity
    let alongMin = Infinity
    let alongMax = -Infinity
    // The same reading, per bone group: how far each group's own skin reaches
    // either side of the handle's axis. The fingers wrap the handle when their
    // own skin ends up *across* it — a positive maximum alone means they lie
    // along the near side of it.
    const groups = {}
    for (let i = 0; i < skin.length; i += 1) {
      const point = skin[i]
      const group = (groups[groupOfVertex[i]] ??= {
        count: 0,
        straddle: [Infinity, -Infinity],
        // How close the group's own skin comes to the handle's axis line, and
        // how close it sits on average: a fist closed round the handle has its
        // fingers *inside* the palm's own radius from the axis, because they
        // have folded across it.
        radial: { min: Infinity, sum: 0 },
        signed: 0,
      })
      group.count += 1
      const distance = point.dot(outward)
      if (distance < 0) behind += 1
      straddleMin = Math.min(straddleMin, distance)
      straddleMax = Math.max(straddleMax, distance)
      group.straddle[0] = Math.min(group.straddle[0], distance)
      group.straddle[1] = Math.max(group.straddle[1], distance)
      group.signed += distance
      const offAxis = point.clone().addScaledVector(axis, -point.dot(axis)).length()
      group.radial.min = Math.min(group.radial.min, offAxis)
      group.radial.sum += offAxis
      const at = point.dot(axis)
      alongMin = Math.min(alongMin, at)
      alongMax = Math.max(alongMax, at)
    }
    const round = (value) => Number(value.toFixed(4))
    for (const group of Object.values(groups)) {
      group.straddle = group.straddle.map(round)
      group.signed = round(group.signed / group.count)
      group.radial = { min: round(group.radial.min), mean: round(group.radial.sum / group.count) }
    }
    // Where each group's own skin sits *in the hand's own frame*, and which way
    // the handle runs through that frame. This is the frame the fist's geometry
    // is authored in, so "have the fingers closed round the handle" has the same
    // answer in every pose — read in world it does not, because the whole fist is
    // turned to put the palm on the handle.
    const handBone = batter.getObjectByName(arm.hand)
    handBone.updateWorldMatrix(true, false)
    const toHand = new THREE.Matrix4().copy(handBone.matrixWorld).invert()
    const rotation = new THREE.Matrix4().extractRotation(toHand)
    const localSum = {}
    for (let i = 0; i < worldSkin.length; i += 1) {
      const entry = (localSum[groupOfVertex[i]] ??= { sum: new THREE.Vector3(), count: 0 })
      entry.sum.add(_scratch.copy(worldSkin[i]).applyMatrix4(toHand))
      entry.count += 1
    }
    for (const [name, entry] of Object.entries(localSum)) {
      const group = groups[name]
      if (!group) continue
      group.local = entry.sum.clone().divideScalar(entry.count).toArray().map(round)
    }
    const markerNode = batter.getObjectByName(`palm_handle${side}`)
    const handleLocal = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(markerNode.getWorldQuaternion(new THREE.Quaternion()))
      .applyMatrix4(rotation)
      .normalize()
      .toArray()
      .map(round)
    const handlePointLocal = markerNode
      .getWorldPosition(new THREE.Vector3())
      .applyMatrix4(toHand)
      .toArray()
      .map(round)
    return {
      marker: {
        along: round(along),
        radial: round(radial),
        alongHandle: Number(alongHandle.toFixed(4)),
      },
      skin: skin.length,
      behind: round(behind / Math.max(1, skin.length)),
      straddle: [round(straddleMin), round(straddleMax)],
      along: [round(alongMin), round(alongMax)],
      handleLocal,
      handlePointLocal,
      groups,
    }
  }
  const hands = { L: hand('L'), R: hand('R') }
  const separation = hands.L && hands.R ? hands.R.marker.along - hands.L.marker.along : null
  return {
    axis: axis.toArray(),
    knob: rig(origin).toArray().map((value) => Number(value.toFixed(4))),
    separation: separation === null ? null : Number(separation.toFixed(4)),
    targets: targets === null ? null : Number(targets.toFixed(4)),
    hands,
  }
}

// Whether the hands swing through the body.
//
// The body is one skinned mesh, so "the hands go through the torso" is a question
// about the posed *skin*, and about the arms' own skin in particular: the hands
// hold the bat, so the thing the eye reads as the hands passing through the body
// is the skin of the hands and forearms, not the wrist joints. This reads the
// pose off the skinning and asks, for every vertex the arms' own bones carry,
// where the nearest bit of *body* skin is and which side of it the vertex is on.
// Positive is out in front of the surface, negative is inside the body, and the
// size of it is how deep. Reported in rig units.
//
// The body here is everything the arm is not: the trunk, the legs, the head, and
// the shoulder and upper arm too — the whole skin minus the forearms and the
// hands themselves, which are what is being measured. That is the surface a
// forearm can bury itself in, and it is dense everywhere the arms travel:
// reading only the trunk's own bones leaves out the skin the shoulders carry,
// which is most of the skin near where a batter's hands are held — while reading
// the forearm's *own* skin would find a vertex on itself and call the arm
// outside the body wherever it went.
function probeTrunk(scene) {
  const batter = scene.getObjectByName(BATTER_NAME)
  const mesh = batter?.getObjectByName('JOINED')
  const authored = batter?.getObjectByName('batter-frame')
  if (!mesh?.isSkinnedMesh || !authored) return null
  const { skinIndex, skinWeight, position, normal } = mesh.geometry.attributes
  if (!skinIndex || !skinWeight || !normal) return null
  // Rig units per world metre, read off the frame the animation is authored in.
  const perMetre = 1 / authored.getWorldScale(new THREE.Vector3()).x
  const bones = mesh.skeleton.bones
  const boneNames = bones.map((bone) => bone.name)
  const partOfBone = new Map()
  for (const [part, names] of Object.entries(PART_BONES)) {
    for (const name of names) partOfBone.set(name, part)
  }
  // The forearm and the hand, but not the upper arm: the deltoid's skin *is* the
  // shoulder's own surface, so it is the arm and the trunk at once, and asking
  // which side of the trunk it is on means nothing.
  const armSideOf = new Map()
  // The skin being measured, whichever side and however many of the bones carry
  // it: a vertex the forearm, the hand or the fingers hold is the arm.
  const measuredBones = new Set()
  // The shoulder and the upper arm: the arm's own surface, which a forearm
  // shares a joint with. It answers for the *other* arm and for the body, but a
  // forearm cannot be asked to stay out of its own upper arm — they are the same
  // skin at the elbow — so each is tagged with its side.
  const upperSideOf = new Map()
  for (const [side, names] of Object.entries(ARM_BONES)) {
    for (const bone of [names.forearm, names.hand, names.fingers]) armSideOf.set(bone, side)
    for (const bone of [names.forearm, names.hand, names.fingers, names.thumb]) measuredBones.add(bone)
    for (const bone of [names.shoulder, names.upperArm]) upperSideOf.set(bone, side)
  }
  const bodySkin = []
  const _normal = new THREE.Vector3()
  const _rotation = new THREE.Matrix3()
  const placed = (vertex) => {
    _restVertex.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix)
    _skinVertex.set(0, 0, 0)
    _normal.set(0, 0, 0)
    let arm = 0
    const upper = { L: 0, R: 0 }
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.array[vertex * 4 + slot]
      if (!weight) continue
      const index = skinIndex.array[vertex * 4 + slot]
      if (measuredBones.has(boneNames[index])) arm += weight
      const which = upperSideOf.get(boneNames[index])
      if (which) upper[which] += weight
      _skinMatrix.multiplyMatrices(bones[index].matrixWorld, mesh.skeleton.boneInverses[index])
      _skinVertex.addScaledVector(_scratch.copy(_restVertex).applyMatrix4(_skinMatrix), weight)
      _rotation.setFromMatrix4(_skinMatrix)
      _normal.addScaledVector(
        _scratch.set(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex)).applyMatrix3(_rotation).normalize(),
        weight,
      )
    }
    return { point: _skinVertex.clone(), normal: _normal.clone().normalize(), arm, upper }
  }
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const placedAt = placed(vertex)
    // The body's own skin: a vertex the arms carry is the arm, and a vertex the
    // two share is the seam between them.
    if (placedAt.arm > 0.5) continue
    bodySkin.push({
      vertex,
      point: placedAt.point,
      normal: placedAt.normal,
      side: placedAt.upper.L > 0.5 ? 'L' : placedAt.upper.R > 0.5 ? 'R' : null,
    })
  }
  // Every piece of the body's skin is a candidate when an arm vertex is asked
  // which side of the surface it is on. The surface is low-poly: a sampled
  // candidate can be several centimetres from the true nearest point, which is
  // the same size as the depths being judged — the first version of this probe
  // walked every fourth vertex and read the armpit as 3 cm of overlap whatever
  // the arm did. One pass over the body per arm vertex is a few million distance
  // tests, which is nothing next to the render the same frame needs.
  const SAMPLE = 1
  // How far the nearest piece of the body may be before its verdict means
  // nothing, in rig units. The nearest surface to a point inside the body is a
  // few centimetres away, so a limit well above that still catches anything
  // buried — it is here so that a stray vertex whose nearest skin is half a body
  // away cannot report a depth by accident.
  const GAP_LIMIT = 0.06
  // How far past the elbow a forearm's own skin is its own joint's rather than
  // the arm's, as a share of the forearm's length. At the elbow the forearm's
  // surface and the upper arm's are the same surface — the skin is one piece and
  // the joint is where it turns — so a vertex there reads a couple of centimetres
  // inside the upper arm whatever the arm is doing. That is a crease, not a
  // glitch, so the measurement starts past it.
  const ELBOW_SKIRT = 0.35
  // ...and the same skirt at the shoulder, for the upper arm's own pass below.
  // The deltoid is the shoulder joint's own cap and it is continuous with the
  // trapezius: at the joint the arm's skin *is* the trunk's surface, so it reads
  // as inside the chest whatever the arm does. A third of the way down the upper
  // arm the cap is behind you and what is left is bicep — the part the eye reads
  // as the arm — so that is where the measurement starts. (It used to start at
  // 0.85, which measured only the last sixth of the arm, next to the elbow: the
  // whole bicep could lie inside the ribs and the probe would still report the
  // arm clear.)
  const SHOULDER_SKIRT = 0.5
  // The joints the skirt is measured from, per side, read off the posed bones.
  const solveArm = probeSolve(scene)?.metrics?.arm ?? null
  const armFore = solveArm?.fore ?? null
  const armUpper = solveArm?.upper ?? null
  const elbows = {}
  const shoulders = {}
  for (const [side, names] of Object.entries(ARM_BONES)) {
    if (armFore === null) break
    const bone = bones[boneNames.indexOf(names.forearm)]
    const upper = armUpper === null ? null : bones[boneNames.indexOf(names.upperArm)]
    if (bone) {
      elbows[side] = {
        at: bone.getWorldPosition(new THREE.Vector3()),
        reach: (armFore * ELBOW_SKIRT) / perMetre,
      }
    }
    if (upper) {
      shoulders[side] = {
        at: upper.getWorldPosition(new THREE.Vector3()),
        reach: (armUpper * SHOULDER_SKIRT) / perMetre,
      }
    }
  }
  // Which bones make a vertex the *upper arm* rather than the shoulder's cap:
  // the upper arm's own bone carries the bicep, and the clavicle carries the
  // deltoid. A vertex the clavicle also holds is the seam at the joint.
  const upperBoneOf = new Map()
  const capBones = new Set()
  for (const [side, names] of Object.entries(ARM_BONES)) {
    upperBoneOf.set(names.upperArm, side)
    capBones.add(names.shoulder)
  }
  // The nearest piece of body skin to a posed point, and which side of it the
  // point is on: positive is out in front of the surface, negative is inside the
  // body, and the size of it is how deep. The gap is how far that piece of skin
  // is, and `reads` says whether it is near enough for the side to mean anything
  // — a point whose nearest skin is half a body away has no side.
  const against = (point, skipSide = null) => {
    let nearest = null
    for (let i = 0; i < bodySkin.length; i += SAMPLE) {
      const candidate = bodySkin[i]
      if (skipSide && candidate.side === skipSide) continue
      const distance = candidate.point.distanceToSquared(point)
      if (!nearest || distance < nearest.distance) nearest = { distance, ...candidate }
    }
    if (!nearest) return null
    const gap = Math.sqrt(nearest.distance) * perMetre
    return {
      depth: _scratch.copy(point).sub(nearest.point).dot(nearest.normal) * perMetre,
      gap,
      reads: gap <= GAP_LIMIT,
      against: nearest.vertex,
      touch: nearest.point.clone(),
      face: nearest.normal.clone(),
    }
  }
  const blank = (list) => ({
    vertices: 0,
    inside: 0,
    worst: Infinity,
    closest: Infinity,
    sides: { L: 0, R: 0 },
    innermost: [],
    ...list,
  })
  const summarise = (tally) => {
    tally.worst = Number((tally.worst === Infinity ? 0 : tally.worst).toFixed(3))
    tally.closest = Number((tally.closest === Infinity ? 0 : tally.closest).toFixed(3))
    tally.innermost = tally.innermost.sort((a, b) => a.depth - b.depth).slice(0, 6)
    return tally
  }
  let worst = { depth: Infinity, vertex: null, at: null }
  let closest = Infinity
  let count = 0
  let armVertices = 0
  // Which arm each buried vertex belongs to, so a reading can be traced back to
  // the elbow hint that put it there, and the deepest few with their places.
  const sides = { L: 0, R: 0 }
  const innermost = []
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    let onArm = 0
    let heaviest = null
    const share = { L: 0, R: 0 }
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.array[vertex * 4 + slot]
      if (!weight) continue
      const bone = boneNames[skinIndex.array[vertex * 4 + slot]]
      const side = armSideOf.get(bone)
      if (!side) continue
      onArm += weight
      share[side] += weight
      if (!heaviest || weight > heaviest.weight) heaviest = { bone, weight }
    }
    // The arm's own skin, and away from where the arm blends into the trunk: a
    // vertex the two share sits *on* the surface by definition.
    if (onArm < 0.95) continue
    const placedAt = placed(vertex)
    // The arm's own joint's skin, and the wrist's: see ELBOW_SKIRT.
    const ownSide = share.R > share.L ? 'R' : 'L'
    const joint = elbows[ownSide]
    if (joint && placedAt.point.distanceTo(joint.at) < joint.reach) continue
    armVertices += 1
    const at = against(placedAt.point, ownSide)
    if (!at) continue
    if (at.gap < closest) closest = at.gap
    if (!at.reads) continue
    const depth = at.depth
    const side = share.R > share.L ? 'R' : 'L'
    if (depth < 0) {
      count += 1
      sides[side] += 1
      innermost.push({
        vertex,
        side,
        bone: heaviest?.bone ?? null,
        depth: Number(depth.toFixed(3)),
        gap: Number(at.gap.toFixed(3)),
        at: placedAt.point.toArray().map((value) => Number(value.toFixed(3))),
      })
    }
    if (depth < worst.depth) {
      worst = {
        depth,
        vertex,
        side,
        at: placedAt.point.clone(),
        gap: at.gap,
        against: at.against,
        touch: at.touch,
        face: at.face,
      }
    }
  }
  // The upper arms, in their own pass. The loop above cannot ask the question:
  // it measures the forearm, the hand and the fingers, because those are skin
  // the trunk does not carry at all. The upper arm's skin *is* the shoulder's
  // own cap at the joint, so the same test there is meaningless — but the half
  // of it past the cap is bone-deep arm, and a bicep inside the ribs is exactly
  // what the eye reads as "the arm went through the body". So: every vertex the
  // upper arm's own bone carries (and the clavicle does not hold), past a skirt
  // measured from the shoulder joint. This is what "both arms in front of the
  // torso" means for the upper arms — the segment the elbow hint aims.
  const pick = (value) => Number((value === Infinity ? 0 : value).toFixed(3))
  const upper = { L: blank({}), R: blank({}) }
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    let onUpper = 0
    let cap = 0
    let share = { L: 0, R: 0 }
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.array[vertex * 4 + slot]
      if (!weight) continue
      const name = boneNames[skinIndex.array[vertex * 4 + slot]]
      const which = upperBoneOf.get(name)
      if (which) {
        onUpper += weight
        share[which] += weight
      }
      if (capBones.has(name)) cap += weight
    }
    if (onUpper < 0.95 || cap > 0.05) continue
    const ownSide = share.R > share.L ? 'R' : 'L'
    const placedAt = placed(vertex)
    const joint = shoulders[ownSide]
    if (joint && placedAt.point.distanceTo(joint.at) < joint.reach) continue
    const at = against(placedAt.point, ownSide)
    if (!at) continue
    const tally = upper[ownSide]
    tally.vertices += 1
    if (at.gap < tally.closest) tally.closest = at.gap
    if (!at.reads) continue
    if (at.depth < 0) {
      tally.inside += 1
      tally.sides[ownSide] += 1
      tally.innermost.push({
        vertex,
        side: ownSide,
        bone: ARM_BONES[ownSide].upperArm,
        depth: Number(at.depth.toFixed(3)),
        gap: Number(at.gap.toFixed(3)),
        at: placedAt.point.toArray().map((value) => Number(value.toFixed(3))),
      })
    }
    if (at.depth < tally.worst) {
      tally.worst = at.depth
      tally.worstAt = placedAt.point.toArray().map((value) => Number(value.toFixed(3)))
      tally.touch = at.touch.toArray().map((value) => Number(value.toFixed(3)))
      tally.face = at.face.toArray().map((value) => Number(value.toFixed(3)))
      tally.against = at.against
      tally.worstBone = ARM_BONES[ownSide].upperArm
      tally.worstGap = Number(at.gap.toFixed(3))
    }
  }
  const upperAll = {
    vertices: upper.L.vertices + upper.R.vertices,
    inside: upper.L.inside + upper.R.inside,
    worst: pick(Math.min(upper.L.worst, upper.R.worst)),
    closest: pick(Math.min(upper.L.closest, upper.R.closest)),
    skirts: { L: upper.L.vertices, R: upper.R.vertices },
    // Per side, because the two arms are doing different jobs: the arm on the
    // pitcher's side is the one a swing carries in front of the chest.
    worstBySide: { L: pick(upper.L.worst), R: pick(upper.R.worst) },
    // Where the deepest one is, what it is inside of, and which way that surface
    // faces — the direction the arm has to move to come out.
    worstAt: upper.L.worst <= upper.R.worst ? upper.L.worstAt : upper.R.worstAt,
    worstBone: upper.L.worst <= upper.R.worst ? upper.L.worstBone : upper.R.worstBone,
    touch: upper.L.worst <= upper.R.worst ? upper.L.touch : upper.R.touch,
    face: upper.L.worst <= upper.R.worst ? upper.L.face : upper.R.face,
    sides: { L: upper.L.sides.L, R: upper.R.sides.R },
    innermost: [...upper.L.innermost, ...upper.R.innermost]
      .sort((a, b) => a.depth - b.depth)
      .slice(0, 6),
  }
  // The fists are their own meshes — the body mesh carries no hand skin at all
  // (see probeGrip) — so a fist pushed into the chest is invisible to the loop
  // above, and the hands are exactly what the eye reads as "the arms went
  // through the body". Every vertex of the fist is asked here, the fingers and
  // the thumb included: a fingertip inside the belly is as much a glitch as a
  // forearm is.
  const fists = blank({})
  for (const name of ['HandL', 'HandR']) {
    const fist = batter.getObjectByName(name)
    if (!fist?.isSkinnedMesh) continue
    const side = name.endsWith('L') ? 'L' : 'R'
    const { skinIndex: fIndex, skinWeight: fWeight, position: fPosition } = fist.geometry.attributes
    if (!fIndex || !fWeight) continue
    const fBones = fist.skeleton.bones
    const fNames = fBones.map((bone) => bone.name)
    const onFist = new Set([ARM_BONES[side].hand, ARM_BONES[side].fingers, ARM_BONES[side].thumb])
    for (let vertex = 0; vertex < fPosition.count; vertex += 1) {
      const weights = []
      let on = 0
      let heaviest = null
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = fWeight.array[vertex * 4 + slot]
        if (!weight) continue
        const bone = fNames[fIndex.array[vertex * 4 + slot]]
        weights.push({ index: fIndex.array[vertex * 4 + slot], weight })
        if (onFist.has(bone)) on += weight
        if (!heaviest || weight > heaviest.weight) heaviest = { bone, weight }
      }
      // A fist is skinned to its own hand's bones; a vertex the forearm carries
      // is the wrist, and is measured by the loop above.
      if (on < 0.5) continue
      _restVertex.fromBufferAttribute(fPosition, vertex).applyMatrix4(fist.bindMatrix)
      _skinVertex.set(0, 0, 0)
      for (const { index, weight } of weights) {
        _skinMatrix.multiplyMatrices(fBones[index].matrixWorld, fist.skeleton.boneInverses[index])
        _skinVertex.addScaledVector(_scratch.copy(_restVertex).applyMatrix4(_skinMatrix), weight)
      }
      const at = against(_skinVertex, side)
      if (!at) continue
      if (at.gap < fists.closest) fists.closest = at.gap
      if (!at.reads) continue
      fists.vertices += 1
      if (at.depth < 0) {
        fists.inside += 1
        fists.sides[side] += 1
        fists.innermost.push({
          vertex,
          side,
          mesh: name,
          bone: heaviest?.bone ?? null,
          depth: Number(at.depth.toFixed(3)),
          at: _skinVertex.toArray().map((value) => Number(value.toFixed(3))),
        })
      }
      if (at.depth < fists.worst) {
        fists.worst = at.depth
        fists.worstAt = _skinVertex.toArray().map((value) => Number(value.toFixed(3)))
        fists.touch = at.touch.toArray().map((value) => Number(value.toFixed(3)))
        fists.face = at.face.toArray().map((value) => Number(value.toFixed(3)))
        fists.against = at.against
        fists.worstOf = `${name}/${heaviest?.bone ?? '?'}`
        fists.gap = Number(at.gap.toFixed(3))
      }
    }
  }
  summarise(fists)
  // Sanity: how far the trunk's own skin reads from the trunk's own surface. A
  // consistent set of normals puts this at zero; a sign error puts half of it
  // negative in the same way the arms read.
  const selfCheck = { min: Infinity, max: -Infinity, mean: 0, sampled: 0 }
  for (let i = 0; i < bodySkin.length; i += Math.max(1, Math.round(bodySkin.length / 60))) {
    const here = bodySkin[i]
    let nearest = null
    for (const candidate of bodySkin) {
      if (candidate === here) continue
      const distance = candidate.point.distanceToSquared(here.point)
      if (!nearest || distance < nearest.distance) nearest = { distance, ...candidate }
    }
    if (!nearest) continue
    const depth = _scratch.copy(here.point).sub(nearest.point).dot(nearest.normal) * perMetre
    selfCheck.min = Math.min(selfCheck.min, depth)
    selfCheck.max = Math.max(selfCheck.max, depth)
    selfCheck.mean += depth
    selfCheck.sampled += 1
  }
  selfCheck.mean = Number((selfCheck.mean / Math.max(1, selfCheck.sampled)).toFixed(3))
  return {
    arms: {
      vertices: armVertices,
      inside: count,
      worst: Number((worst.depth === Infinity ? 0 : worst.depth).toFixed(3)),
      worstAt: worst.at ? worst.at.toArray().map((value) => Number(value.toFixed(3))) : null,
      touch: worst.touch ? worst.touch.toArray().map((value) => Number(value.toFixed(3))) : null,
      face: worst.face ? worst.face.toArray().map((value) => Number(value.toFixed(3))) : null,
      against: worst.against,
      side: worst.side ?? null,
      // The nearest the arm's own skin comes to the body's, over every vertex
      // that was measured: how much daylight there is between them, whatever
      // side of the surface they are on.
      closest: Number((closest === Infinity ? 0 : closest).toFixed(3)),
      worstGap: worst.gap === undefined ? null : Number(worst.gap.toFixed(3)),
      near: (() => {
        const point = worst.at
        if (!point) return null
        const rows = bodySkin
          .map((entry) => ({ d: entry.point.distanceTo(point) * perMetre, p: entry.point }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 8)
        return rows.map((row) => [Number(row.d.toFixed(3)), row.p.toArray().map((v) => Number(v.toFixed(2)))])
      })(),
      trunkBox: (() => {
        const box = new THREE.Box3()
        for (const entry of bodySkin) box.expandByPoint(entry.point)
        return box.isEmpty()
          ? null
          : [box.min.toArray(), box.max.toArray()].map((corner) => corner.map((v) => Number(v.toFixed(2))))
      })(),
      sides,
      innermost: innermost.sort((a, b) => a.depth - b.depth).slice(0, 6),
      sampled: bodySkin.length,
      selfCheck: {
        min: Number(selfCheck.min.toFixed(3)),
        max: Number(selfCheck.max.toFixed(3)),
        mean: selfCheck.mean,
        sampled: selfCheck.sampled,
      },
    },
    upper: upperAll,
    fists,
  }
}

// How close the bat comes to the batter's own body.
//
// The bat is a mesh of its own, driven analytically from the swing path, and the
// body is skinned onto the bones the arms are solved through — so “the bat is
// lying on him” is a question about two *surfaces*, and the distance that answers
// it is the bat's own barrel against the posed skin. This reads it off the
// skinning: every vertex of the body mesh the arms' holding bones do *not* carry
// is placed, and each one is asked how far it is from the bat's own axis segment.
// The arm skin is left out because it is what holds the handle — the fists are
// their own meshes and sit on the bat by construction — while the upper arms are
// not: a bat lying along the bicep is a clip, and the shoulder and the bicep are
// part of the body the bat has to stay off.
//
// Reported in rig units, over the whole bat and over its barrel (everything past
// ``BARREL_SHARE`` of its length, which is the half that is not being held), each
// with where along the bat the closest skin sits and which part of the body it
// belongs to. A closed fist reads about 0.02 rig clear of the handle's own axis
// (the bat's own radius), so anything under that is the mesh inside the bat.
const BARREL_SHARE = 0.4
function probeBatBody(scene) {
  const batter = scene.getObjectByName(BATTER_NAME)
  const mesh = batter?.getObjectByName('JOINED')
  const frame = batter?.getObjectByName('batter-frame')
  const bat = scene.getObjectByName(BAT_NAME)
  if (!mesh?.isSkinnedMesh || !frame || !bat) return null
  const { skinIndex, skinWeight, position } = mesh.geometry.attributes
  if (!skinIndex || !skinWeight) return null
  const perMetre = 1 / frame.getWorldScale(new THREE.Vector3()).x
  const origin = batter.getWorldPosition(new THREE.Vector3())
  const rig = (point) => point.clone().sub(origin).multiplyScalar(perMetre)
  // The bat's own line, and how long it really is on screen: the furthest any of
  // its vertices reaches along its own axis (same reading probeBat reports).
  bat.updateWorldMatrix(true, false)
  const knob = bat.getWorldPosition(new THREE.Vector3())
  const axis = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(bat.getWorldQuaternion(new THREE.Quaternion()))
    .normalize()
  let length = 0
  let radius = 0
  const corner = new THREE.Vector3()
  const offset = new THREE.Vector3()
  bat.traverse((child) => {
    if (!child.isMesh || !child.geometry) return
    const attribute = child.geometry.getAttribute('position')
    if (!attribute) return
    child.updateWorldMatrix(true, false)
    for (let i = 0; i < attribute.count; i += 1) {
      corner.fromBufferAttribute(attribute, i).applyMatrix4(child.matrixWorld)
      offset.copy(corner).sub(knob)
      const along = offset.dot(axis)
      length = Math.max(length, along)
      radius = Math.max(radius, offset.clone().addScaledVector(axis, -along).length())
    }
  })
  // The bones that hold the handle: the forearm, the hand and the digits.
  const held = new Set()
  for (const names of Object.values(ARM_BONES)) {
    for (const bone of [names.forearm, names.hand, names.fingers, names.thumb]) held.add(bone)
  }
  const partOf = new Map()
  for (const [part, names] of Object.entries(PART_BONES)) {
    for (const name of names) partOf.set(name, part)
  }
  for (const [side, names] of Object.entries(ARM_BONES)) {
    partOf.set(names.shoulder, `shoulder${side}`)
    partOf.set(names.upperArm, `upperArm${side}`)
  }
  const bones = mesh.skeleton.bones
  const boneNames = bones.map((bone) => bone.name)
  const rest = new THREE.Vector3()
  const placed = new THREE.Vector3()
  const skin = new THREE.Matrix4()
  const sample = new THREE.Vector3()
  const reading = { distance: Infinity, along: 0, rigY: 0, part: null, bone: null, at: null }
  const barrel = { ...reading }
  let samples = 0
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    let onArm = 0
    let heaviest = null
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.array[vertex * 4 + slot]
      if (!weight) continue
      const bone = boneNames[skinIndex.array[vertex * 4 + slot]]
      if (held.has(bone)) onArm += weight
      if (!heaviest || weight > heaviest.weight) heaviest = { bone, weight }
    }
    // A vertex the arm that holds the handle carries is the grip's own skin, and
    // the fists are separate meshes on the bat by construction (see probeGrip).
    if (onArm > 0.05) continue
    rest.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix)
    placed.set(0, 0, 0)
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.array[vertex * 4 + slot]
      if (!weight) continue
      const index = skinIndex.array[vertex * 4 + slot]
      skin.multiplyMatrices(bones[index].matrixWorld, mesh.skeleton.boneInverses[index])
      placed.addScaledVector(sample.copy(rest).applyMatrix4(skin), weight)
    }
    placed.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld)
    samples += 1
    // The bat's own axis segment, and this vertex's place along it. The overlap
    // that matters is against the *barrel*: the knob is inside the fists, which
    // are on the bat, so the near end is only read for completeness.
    const along = Math.max(0, Math.min(length, offset.copy(placed).sub(knob).dot(axis)))
    const distance = sample.copy(knob).addScaledVector(axis, along).distanceTo(placed) * perMetre
    const share = length > 1e-6 ? along / length : 0
    const where = rig(placed).toArray().map((value) => Number(value.toFixed(3)))
    const record = {
      distance,
      along: Number(share.toFixed(3)),
      rigY: where[1],
      part: partOf.get(heaviest?.bone) ?? 'other',
      bone: heaviest?.bone ?? null,
      at: where,
    }
    if (distance < reading.distance) Object.assign(reading, record)
    if (share >= BARREL_SHARE && distance < barrel.distance) Object.assign(barrel, record)
  }
  const send = (entry) => (entry.distance === Infinity
    ? null
    : { ...entry, distance: Number(entry.distance.toFixed(3)) })
  return {
    length: Number(length.toFixed(3)),
    radius: Number(radius.toFixed(3)),
    rigRadius: Number((radius * perMetre).toFixed(3)),
    vertices: samples,
    closest: send(reading),
    barrel: send(barrel),
  }
}

// How much of each upper arm the body *hides*: the posed skin projected onto a
// view's own screen, each arm vertex asked whether some body vertex is nearer the
// camera and lands on top of it. That is the test the eye makes looking at a
// screenshot, and the one the penetration probes cannot make — an arm lying along
// the chest is outside the surface (nothing inside) and still covered by it.
// ``view`` names the harness's views, so the same pose can be judged from the
// pitcher's side, from behind the plate, or from the suite's three-quarter shot.
function probeCover(scene, view = 'three-quarter') {
  const batter = scene.getObjectByName(BATTER_NAME)
  const mesh = batter?.getObjectByName('JOINED')
  if (!mesh?.isSkinnedMesh) return null
  const { skinIndex, skinWeight, position } = mesh.geometry.attributes
  if (!skinIndex || !skinWeight) return null
  const bones = mesh.skeleton.bones
  const boneNames = bones.map((bone) => bone.name)
  const armBones = new Set()
  const upperOf = new Map()
  for (const [side, names] of Object.entries(ARM_BONES)) {
    for (const name of Object.values(names)) armBones.add(name)
    upperOf.set(names.upperArm, side)
  }
  const arm = []
  const body = []
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    _restVertex.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix)
    _skinVertex.set(0, 0, 0)
    let onArm = 0
    const upper = { L: 0, R: 0 }
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.array[vertex * 4 + slot]
      if (!weight) continue
      const name = boneNames[skinIndex.array[vertex * 4 + slot]]
      if (armBones.has(name)) onArm += weight
      const which = upperOf.get(name)
      if (which) upper[which] += weight
      _skinMatrix.multiplyMatrices(bones[skinIndex.array[vertex * 4 + slot]].matrixWorld, mesh.skeleton.boneInverses[skinIndex.array[vertex * 4 + slot]])
      _skinVertex.addScaledVector(_scratch.copy(_restVertex).applyMatrix4(_skinMatrix), weight)
    }
    // A vertex the arms carry is the arms; a vertex they do not is the surface
    // that can hide them. The seam between the two is left out of both.
    if (onArm > 0.95) {
      const side = upper.R > upper.L ? 'R' : upper.L > upper.R ? 'L' : null
      if (side && upper[side] > 0.35) arm.push({ point: _skinVertex.clone(), side })
    } else if (onArm < 0.05) {
      body.push(_skinVertex.clone())
    }
  }
  // The view's own frame: the direction from the pose toward the camera, and the
  // two screen axes. Depth is measured along the first, so bigger is nearer.
  const dir = new THREE.Vector3(...(VIEWS[view] ?? VIEWS['three-quarter'])).normalize()
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize()
  const up = new THREE.Vector3().crossVectors(dir, right).normalize()
  const CELL = 0.012
  const nearest = new Map()
  const depths = body.map((point) => point.dot(dir))
  const key = (point) => {
    const u = Math.floor(point.dot(right) / CELL)
    const v = Math.floor(point.dot(up) / CELL)
    return `${u},${v}`
  }
  // Every body vertex claims its cell with the depth that gets there first, and
  // the eight neighbours are filled from it as well: a cell is about the size of
  // the gap between two vertices, so a vertex can land beside the one that hides
  // it rather than under it.
  body.forEach((point, index) => {
    const u = Math.floor(point.dot(right) / CELL)
    const v = Math.floor(point.dot(up) / CELL)
    for (let du = -1; du <= 1; du += 1) {
      for (let dv = -1; dv <= 1; dv += 1) {
        const cell = `${u + du},${v + dv}`
        const current = nearest.get(cell)
        if (current === undefined || depths[index] > current) nearest.set(cell, depths[index])
      }
    }
  })
  const tally = { L: { hidden: 0, total: 0, deepest: 0 }, R: { hidden: 0, total: 0, deepest: 0 } }
  const worst = { depth: 0, side: null, at: null }
  for (const entry of arm) {
    const depth = entry.point.dot(dir)
    const front = nearest.get(key(entry.point))
    const covered = front !== undefined && front > depth + 0.004
    const row = tally[entry.side]
    row.total += 1
    if (covered) {
      row.hidden += 1
      // How far the covering body vertex sits in front of it, in metres.
      const gap = front - depth
      if (gap > row.deepest) row.deepest = gap
      if (gap > worst.depth) {
        worst.depth = gap
        worst.side = entry.side
        worst.at = entry.point.toArray().map((value) => Number(value.toFixed(3)))
      }
    }
  }
  const round = (value) => Number(value.toFixed(3))
  return {
    view,
    L: { hidden: tally.L.hidden, total: tally.L.total, deepest: round(tally.L.deepest) },
    R: { hidden: tally.R.hidden, total: tally.R.total, deepest: round(tally.R.deepest) },
    hidden: tally.L.hidden + tally.R.hidden,
    total: tally.L.total + tally.R.total,
    share: round((tally.L.hidden + tally.R.hidden) / Math.max(1, tally.L.total + tally.R.total)),
    worst: { side: worst.side, deepest: round(worst.depth), at: worst.at },
  }
}

// What the belt cut has to hold. The belt's own ring is cut open, and a sleeve is
// hidden under the opening, so one thing has to stay true: the seam must not open
// *through* the sleeve, i.e. the two sides of the cut must not come apart by more
// than the sleeve runs past the cut.
//
// Measured off the skinning, like probeStrain: where the pelvis and the torso each
// place each point of the cut ring. A spin about the body's up axis carries a ring
// perpendicular to it onto itself, so what opens a gap is whatever is *not* that
// spin — the lean, and the section's own width — and the number that matters is
// the vertical one: the sleeve runs past the cut vertically.
function probeSleeve(scene) {
  const batter = scene.getObjectByName(BATTER_NAME)
  const mesh = batter?.getObjectByName('JOINED')
  const solve = probeSolve(scene)
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
    // The nearest point of the other side of the seam: the two curves are the same
    // ring, so this is how far the cut's own edge has drifted from the edge it
    // belongs against — and its *vertical* part is what the sleeve's margin has to
    // run past.
    let nearest = high[0]
    for (const other of high) if (point.distanceTo(other) < point.distanceTo(nearest)) nearest = other
    open = Math.max(open, Math.abs(point.y - nearest.y) * unitScale)
    gap = Math.max(gap, point.distanceTo(nearest) * unitScale)
  }
  return { cut: sleeve.cut, margin: sleeve.margin, inset: sleeve.inset, open, gap }
}

// The posed skeleton, in world space: every joint's position plus the scale the
// batter's frame is rendered at, so a test can assert on the limbs themselves
// (are the hands on the bat?) instead of only on the pixels.
function probeBones(scene) {
  const batter = scene.getObjectByName(BATTER_NAME)
  if (!batter) return null
  const bones = {}
  batter.traverse((node) => {
    if (node.isBone) bones[node.name] = node.getWorldPosition(new THREE.Vector3()).toArray()
  })
  // The batter's own frame: its origin, and how many metres a rig unit is on
  // screen (the body's height scale), so world positions can be read back as the
  // units the animation is authored in.
  const frame = batter.getObjectByName('batter-frame')
  return {
    origin: batter.getWorldPosition(new THREE.Vector3()).toArray(),
    scale: frame ? frame.getWorldScale(new THREE.Vector3()).x : 1,
    bones,
  }
}

// The batter's kit, read off the live model: every separate shell of the helmet
// and of the body, and the placket the look pass hangs on the chest with how far
// it stands off the jersey. src/util/batterLook.js shapes all three, so the suite
// reads the geometry here rather than the pass's own report of what it did: the
// shells are measured in the model's rest frame (a shell's own bounds do not move
// with the pose — the skinning is what moves), which is the frame the kit is
// authored in.
function probeKit(scene) {
  const batter = scene.getObjectByName(BATTER_NAME)
  if (!batter) return null
  const helmet = batter.getObjectByName('Helmet')
  const body = batter.getObjectByName('JOINED')
  const laces = batter.getObjectByName('LaceDetail')
  const brows = batter.getObjectByName('BrowDetail')
  if (!body?.isSkinnedMesh) return null

  // The jersey's opening and the shoes' own leather are *welded into* the body's own
  // geometry (see weldDetail in src/util/batterLook.js): what they are in the model is a
  // range of the body's vertices, so this is how they are read back — the range cut out
  // as a geometry of its own, with the body's own attributes, material and skeleton, and
  // the faces between its vertices. Every reading below (its shells, its tones, how far
  // it stands off the cloth it is drawn on) then applies to it unchanged.
  const welded = (range, name) => {
    if (!range) return null
    const [from, to] = range
    const geometry = new THREE.BufferGeometry()
    for (const [key, attribute] of Object.entries(body.geometry.attributes)) {
      const { itemSize, normalized, array } = attribute
      const out = new array.constructor((to - from) * itemSize)
      out.set(array.subarray(from * itemSize, to * itemSize))
      const next = new THREE.BufferAttribute(out, itemSize)
      next.normalized = normalized
      geometry.setAttribute(key, next)
    }
    const index = body.geometry.getIndex().array
    const kept = []
    for (let i = 0; i < index.length; i += 3) {
      const corners = [index[i], index[i + 1], index[i + 2]]
      if (corners.some((vertex) => vertex < from || vertex >= to)) continue
      kept.push(corners[0] - from, corners[1] - from, corners[2] - from)
    }
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(kept), 1))
    return {
      name,
      isSkinnedMesh: true,
      skeleton: body.skeleton,
      material: body.material,
      parent: body.parent,
      geometry,
    }
  }
  const look = body.userData?.batterLook ?? null
  const jersey = welded(look?.jersey ? [look.jersey.from, look.jersey.to] : null, 'JerseyFront')
  const shoes = welded(look?.shoes ? [look.shoes.from, look.shoes.to] : null, 'ShoeDetail')
  // The model's own vertices: everything the welds did not add. A welded piece stands
  // off *those* — against the whole body its own vertices are the nearest ones to
  // themselves, and every piece would read as sitting exactly on the surface.
  const bodyVertices = body.geometry.getAttribute('position').count
  const ownVertices = Array.from(
    { length: look?.jersey?.from ?? bodyVertices },
    (_, vertex) => vertex,
  )

  // The pieces of a mesh: the model is one mesh per body part, so its separate
  // closed surfaces (the helmet's flaps, the eyes, the nose) are separate islands
  // in one index buffer. Union-find over the triangles is the whole of it.
  const shells = (geometry) => {
    const index = geometry.getIndex()
    const count = geometry.getAttribute('position').count
    if (!index) return []
    const parent = new Int32Array(count)
    for (let i = 0; i < count; i += 1) parent[i] = i
    const find = (start) => {
      let root = start
      while (parent[root] !== root) root = parent[root]
      let walk = start
      while (parent[walk] !== root) {
        const next = parent[walk]
        parent[walk] = root
        walk = next
      }
      return root
    }
    const array = index.array
    for (let i = 0; i < array.length; i += 3) {
      parent[find(array[i + 1])] = find(array[i])
      parent[find(array[i + 2])] = find(array[i])
    }
    const byRoot = new Map()
    for (let i = 0; i < count; i += 1) {
      const root = find(i)
      if (!byRoot.has(root)) byRoot.set(root, [])
      byRoot.get(root).push(i)
    }
    return [...byRoot.values()]
  }

  const round = (value) => Number(value.toFixed(4))
  const bounds = (geometry, vertices) => {
    const position = geometry.getAttribute('position')
    const box = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] }
    for (const vertex of vertices) {
      box.x[0] = Math.min(box.x[0], position.getX(vertex))
      box.x[1] = Math.max(box.x[1], position.getX(vertex))
      box.y[0] = Math.min(box.y[0], position.getY(vertex))
      box.y[1] = Math.max(box.y[1], position.getY(vertex))
      box.z[0] = Math.min(box.z[0], position.getZ(vertex))
      box.z[1] = Math.max(box.z[1], position.getZ(vertex))
    }
    return {
      x: box.x.map(round), y: box.y.map(round), z: box.z.map(round),
    }
  }

  const describe = (mesh) => {
    if (!mesh?.geometry) return null
    const geometry = mesh.geometry
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    return {
      name: mesh.name,
      parent: mesh.parent?.name ?? null,
      skinned: Boolean(mesh.isSkinnedMesh),
      verts: geometry.getAttribute('position').count,
      triangles: (geometry.getIndex()?.count ?? 0) / 3,
      vertexColors: Boolean(material?.vertexColors),
      color: material?.color ? [round(material.color.r), round(material.color.g), round(material.color.b)] : null,
      // Only the pieces big enough to be one of the model's own surfaces: a
      // shell of two or three vertices is an artefact of the export, not a part.
      shells: shells(geometry)
        .filter((vertices) => vertices.length >= 8)
        .map((vertices) => ({ verts: vertices.length, box: bounds(geometry, vertices) })),
    }
  }

  // The tones a piece of detail is drawn in, out of its own vertex colours: the
  // jersey's opening is grey on a pale blue uniform, so this is where the grey is.
  // The details hung on the body carry floats and the welded ones are a range of the
  // body's own colour attribute, which is a normalised byte array — three's `getX`
  // hands either back as the 0-1 the shader multiplies by, so both read the same way.
  const tones = (mesh) => {
    const attribute = mesh?.geometry?.getAttribute('color')
    if (!attribute) return null
    const luminance = []
    for (let vertex = 0; vertex < attribute.count; vertex += 1) {
      luminance.push(0.2126 * attribute.getX(vertex) + 0.7152 * attribute.getY(vertex) + 0.0722 * attribute.getZ(vertex))
    }
    return { min: round(Math.min(...luminance)), max: round(Math.max(...luminance)) }
  }

  // How far a piece of detail sits off the body it is hung on: for every vertex of
  // it, the nearest vertex of the body, and how far that is and how far *out* along
  // the model's own front (+z) the detail sits from it. A piece that hugs reads a
  // little out (its own lift); one buried in the body reads negative.
  const standOffOf = (mesh, against = null) => {
    if (!mesh) return null
    const positions = body.geometry.getAttribute('position')
    const others = against ?? Array.from({ length: positions.count }, (_, vertex) => vertex)
    const own = mesh.geometry.getAttribute('position')
    const gaps = []
    const outs = []
    for (let vertex = 0; vertex < own.count; vertex += 1) {
      const p = _vertex.fromBufferAttribute(own, vertex)
      let nearest = -1
      let squared = Infinity
      for (const other of others) {
        const dx = p.x - positions.getX(other)
        const dy = p.y - positions.getY(other)
        const dz = p.z - positions.getZ(other)
        const candidate = dx * dx + dy * dy + dz * dz
        if (candidate < squared) {
          squared = candidate
          nearest = other
        }
      }
      if (nearest < 0) continue
      gaps.push(Math.sqrt(squared))
      outs.push(p.z - positions.getZ(nearest))
    }
    const span = (values) => [round(Math.min(...values)), round(Math.max(...values))]
    return { gap: span(gaps), out: span(outs) }
  }

  // The cloth the jersey's opening is drawn on: the chest's own shells — the ones that
  // reach down to the belt and stop at the jersey's collar, whose front is the chest's.
  // The opening has to stand proud of *these* and hug them; measured against the whole
  // body its own top band reads the neck instead, which stands proud of the collar
  // (z 0.1003 against 0.0143) and so reads as the opening sinking into the chest.
  const chestVertices = (() => {
    const list = shells(body.geometry).filter((vertices) => vertices.length >= 40)
      .map((vertices) => ({ vertices, box: bounds(body.geometry, vertices) }))
      .filter(({ box }) => box.y[0] <= 1.292 && box.y[1] <= 1.56 && box.z[1] >= 0.06)
    return list.flatMap(({ vertices }) => vertices)
  })()

  // The ear cover the helmet still draws, side by side: how far down the shell still
  // hangs *beside an ear*, which a batting helmet has on one side only. The zone is the
  // space beside an ear and no further back than the ear's own trailing edge (the head's
  // ear runs y 1.7346 to 1.8165 at |x| 0.147 to 0.1725, z -0.019 to 0.053), below the
  // brim's underside — so the number is "how low does the helmet come down beside this
  // ear", and the nape behind it (z < -0.09) is not what is being asked about. The flap
  // side reaches the jaw; the other side stops over the ear's own middle, so half of
  // that ear shows below it.
  const EAR_ZONE = { topY: 1.7954, sideX: 0.12, backZ: -0.09, frontZ: 0.06 }
  // The ear's own z span, with a hair of slack either side of it: the window the shell's
  // lower edge is read in when the question is "how much of *this ear* is covered".
  const EAR_SPAN_Z = [-0.025, 0.055]
  const earCover = (side) => {
    const geometry = helmet?.geometry
    if (!geometry) return null
    const position = geometry.getAttribute('position')
    const array = geometry.getIndex().array
    const inside = (vertex) => position.getX(vertex) * side >= EAR_ZONE.sideX
      && position.getY(vertex) <= EAR_ZONE.topY
      && position.getZ(vertex) >= EAR_ZONE.backZ
      && position.getZ(vertex) <= EAR_ZONE.frontZ
    // Read off the triangles, not off the vertex buffer: a piece of the shell the pass
    // has taken away leaves its vertices where they were, and a vertex nothing draws is
    // not part of the helmet's edge.
    const drawnOn = (side, zFrom = -Infinity, zTo = Infinity) => {
      let low = Infinity
      for (let i = 0; i < array.length; i += 3) {
        for (const vertex of [array[i], array[i + 1], array[i + 2]]) {
          if (position.getX(vertex) * side < EAR_ZONE.sideX) continue
          if (position.getY(vertex) > EAR_ZONE.topY) continue
          const z = position.getZ(vertex)
          if (z < zFrom || z > zTo) continue
          low = Math.min(low, position.getY(vertex))
        }
      }
      return low
    }
    let triangles = 0
    let lowY = Infinity
    let frontZ = -Infinity
    // And the lowest the shell comes down on that side *anywhere* below the brim, off
    // the midline — the jaw guard's own reach, whatever z it hangs at.
    let hungY = Infinity
    for (let i = 0; i < array.length; i += 3) {
      const [a, b, c] = [array[i], array[i + 1], array[i + 2]]
      if ([a, b, c].some(inside)) {
        triangles += 1
        for (const vertex of [a, b, c]) {
          if (!inside(vertex)) continue
          lowY = Math.min(lowY, position.getY(vertex))
          frontZ = Math.max(frontZ, position.getZ(vertex))
        }
      }
      for (const vertex of [a, b, c]) {
        if (position.getX(vertex) * side < EAR_ZONE.sideX) continue
        if (position.getY(vertex) > EAR_ZONE.topY) continue
        hungY = Math.min(hungY, position.getY(vertex))
      }
    }
    // The edge, station by station along the head: behind the ear, over it, and out by
    // the brim in front of it. This is what says the edge is the helmet's own sweep and
    // not a cut: it is lowest over the ear's own middle, reaches the brim's underside in
    // front of it, and falls away behind it into the nape, which is the helmet's back.
    // A rim cut off level reads the same height in all three windows, and a rim cut with
    // a step in it reads a jump between two of them.
    const over = drawnOn(side, ...EAR_SPAN_Z)
    const behind = drawnOn(side, -0.10, -0.04)
    const beside = drawnOn(side, -0.03, 0.02)
    const forward = drawnOn(side, 0.08, 0.12)
    return {
      triangles,
      lowY: Number.isFinite(lowY) ? round(lowY) : null,
      frontZ: Number.isFinite(frontZ) ? round(frontZ) : null,
      belowBrim: Number.isFinite(lowY) ? round(EAR_ZONE.topY - lowY) : null,
      hungY: Number.isFinite(hungY) ? round(hungY) : null,
      // How low the shell comes down over the ear's own span: the head's ear runs
      // 1.7346 to 1.8165, so a rim between the two covers part of it and leaves the rest.
      earY: Number.isFinite(over) ? round(over) : null,
      rim: {
        behind: Number.isFinite(behind) ? round(behind) : null,
        beside: Number.isFinite(beside) ? round(beside) : null,
        forward: Number.isFinite(forward) ? round(forward) : null,
      },
    }
  }

  // How far a piece of detail stands off the *surface* it is drawn on, rather than off
  // the nearest vertex of it: for every vertex of the piece, the front-most triangle of
  // the body's own shells that covers the point looking down the model's own front, and
  // the gap between the two. A line drawn on the cloth follows the cloth's surface, which
  // runs between its vertices — measured against the nearest vertex, an opening drawn
  // properly on the chest reads as sinking into it wherever the surface bulges forward of
  // the vertices on either side of the point.
  const SURFACE_FRONT_MIN_Z = 0.02
  const surfaceOffOf = (mesh, against) => {
    if (!mesh) return null
    const position = body.geometry.getAttribute('position')
    const array = body.geometry.getIndex().array
    const covering = new Set(against)
    const own = mesh.geometry.getAttribute('position')
    const frontAt = (x, y) => {
      let front = -Infinity
      for (let i = 0; i < array.length; i += 3) {
        const [a, b, c] = [array[i], array[i + 1], array[i + 2]]
        if (!covering.has(a) || !covering.has(b) || !covering.has(c)) continue
        const ax = position.getX(a)
        const ay = position.getY(a)
        const bx = position.getX(b)
        const by = position.getY(b)
        const cx = position.getX(c)
        const cy = position.getY(c)
        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if (Math.abs(det) < 1e-9) continue
        const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det
        const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det
        const wc = 1 - wa - wb
        if (wa < -0.02 || wb < -0.02 || wc < -0.02) continue
        const z = wa * position.getZ(a) + wb * position.getZ(b) + wc * position.getZ(c)
        // ...and it has to be the cloth's own *front*: a shoulder's slope crosses these
        // stations from inside, and the height it reads there is behind the cloth's.
        if (z < SURFACE_FRONT_MIN_Z) continue
        front = Math.max(front, z)
      }
      return front
    }
    const offsets = []
    const rows = []
    for (let vertex = 0; vertex < own.count; vertex += 1) {
      const front = frontAt(own.getX(vertex), own.getY(vertex))
      if (!Number.isFinite(front)) continue
      offsets.push(own.getZ(vertex) - front)
      rows.push(own.getY(vertex))
    }
    if (!offsets.length) return null
    // ...and how much of the piece reads: how many of its vertices are in front of the
    // cloth *at all*, and how far up and down the piece they run. A station the cloth's
    // own front does not reach reads nothing, so a piece that stops short is the piece's
    // own range, not a shorter one of the cloth's.
    return {
      count: offsets.length,
      off: [round(Math.min(...offsets)), round(Math.max(...offsets))],
      fromY: round(Math.min(...rows)),
      toY: round(Math.max(...rows)),
    }
  }

  // The eyes, and how much of each the head's own surface is in front of: a flat plate
  // on a face that curves sinks into it at the edges, and what is inside the head is not
  // drawn. The head's own shells are coarse — the face is 63 vertices for the whole
  // thing — so the front it puts up at a point is the *interpolated* surface of the
  // triangles that cover that point down the model's own front, not the highest vertex
  // near it: between two of those vertices the drawn surface bulges forward of both,
  // and that is exactly where a plate sinks in. Reported per eye: how many of its
  // vertices the head covers, how deep the worst of them goes, and how proud the most
  // marginal vertex is (negative when the head is in front of it).
  const EYE_BOX = { vertMin: 20, vertMax: 90, frontMinZ: 0.05, bottomMinY: 1.6, topMaxY: 1.9 }
  const eyeReading = () => {
    const position = body.geometry.getAttribute('position')
    const index = body.geometry.getIndex()
    const array = index.array
    const boxed = (vertices) => bounds(body.geometry, vertices)
    const eyes = shells(body.geometry)
      .filter((vertices) => vertices.length >= EYE_BOX.vertMin && vertices.length <= EYE_BOX.vertMax)
      .map((vertices) => ({ vertices, box: boxed(vertices) }))
      .filter(({ box }) => box.y[0] >= EYE_BOX.bottomMinY && box.y[1] <= EYE_BOX.topMaxY
        && box.z[0] >= EYE_BOX.frontMinZ
        && (box.x[0] > 0.004 || box.x[1] < -0.004))
    const own = new Set(eyes.flatMap((eye) => eye.vertices))
    const frontAt = (x, y) => {
      let front = -Infinity
      for (let i = 0; i < array.length; i += 3) {
        const [a, b, c] = [array[i], array[i + 1], array[i + 2]]
        if (own.has(a) || own.has(b) || own.has(c)) continue
        const ax = position.getX(a)
        const ay = position.getY(a)
        const bx = position.getX(b)
        const by = position.getY(b)
        const cx = position.getX(c)
        const cy = position.getY(c)
        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if (Math.abs(det) < 1e-9) continue
        const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det
        const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det
        const wc = 1 - wa - wb
        if (wa < 0 || wb < 0 || wc < 0) continue
        front = Math.max(front, wa * position.getZ(a) + wb * position.getZ(b) + wc * position.getZ(c))
      }
      return front
    }
    return eyes.map((eye) => {
      let buried = 0
      let deepest = 0
      let margin = Infinity
      for (const vertex of eye.vertices) {
        const x = position.getX(vertex)
        const y = position.getY(vertex)
        const front = frontAt(x, y)
        if (!Number.isFinite(front)) continue
        const proud = position.getZ(vertex) - front
        margin = Math.min(margin, proud)
        if (proud >= 0) continue
        buried += 1
        deepest = Math.max(deepest, -proud)
      }
      return {
        verts: eye.vertices.length,
        buried,
        deepest: round(deepest),
        margin: Number.isFinite(margin) ? round(margin) : null,
        box: eye.box,
      }
    })
  }

  // The buttons: a hollow one is a ring, so the vertices of its own piece are all a
  // little way out from its centre, with the cloth showing through the hole.
  const holes = (mesh) => {
    if (!mesh) return []
    const position = mesh.geometry.getAttribute('position')
    return shells(mesh.geometry)
      .filter((vertices) => vertices.length >= 8)
      .map((vertices) => {
        const box = bounds(mesh.geometry, vertices)
        const centre = {
          x: (box.x[0] + box.x[1]) / 2,
          y: (box.y[0] + box.y[1]) / 2,
        }
        const radii = vertices.map((vertex) => Math.hypot(
          position.getX(vertex) - centre.x,
          position.getY(vertex) - centre.y,
        ))
        return {
          verts: vertices.length,
          inner: round(Math.min(...radii)),
          outer: round(Math.max(...radii)),
          width: round(box.x[1] - box.x[0]),
          height: round(box.y[1] - box.y[0]),
        }
      })
  }

  // The shoes, and what is worn above them. How high each shoe's own rim reaches is
  // read off the body's shoe shells, one per foot; the pieces of the shoe detail are
  // then told apart by shape: a lace bar lies across the instep (wide and low, and thin
  // along the foot), the tongue is a pad running down the foot under them, and the
  // edge of the sole is the wide piece down at the ground. Nothing may stand *above*
  // the shoe's own rim: measured, the trousers already cover the leg down past it (the
  // leg shell reaches y 0.2716 against the shoes' 0.2992), so a band there is a sock
  // pulled out over the trouser — which is what the kit used to wear, and no longer
  // does. `sockBands` is that check: pieces rising more than a hair over the rim.
  const feetReading = () => {
    if (!shoes) return null
    const shoeShells = describe(body).shells.filter((shell) => shell.verts >= 60
      && shell.box.y[1] < 0.36 && shell.box.y[0] < 0
      && (shell.box.x[0] > 0.01 || shell.box.x[1] < -0.01))
    if (!shoeShells.length) return null
    const rim = Math.max(...shoeShells.map((shell) => shell.box.y[1]))
    const piecesOf = (mesh) => shells(mesh.geometry)
      .filter((vertices) => vertices.length >= 8)
      .map((vertices) => ({
        verts: vertices.length,
        box: bounds(mesh.geometry, vertices),
        own: new Set(vertices),
      }))
    // The shoe's own pieces — the edge of its sole and the tongue — are welded into the
    // body's geometry; the laces across them are their own mesh.
    const leather = piecesOf(shoes)
    const lacePieces = laces ? piecesOf(laces) : []
    const pieces = [...leather, ...lacePieces]
    // A lace bar lies *across* the instep: wide in x, low on the shoe, and thin along
    // the foot. The sole's edge is wide too, but it is under the bars.
    const across = (piece) => piece.box.x[1] - piece.box.x[0] >= 0.08
      && piece.box.y[0] >= 0.08 && piece.box.y[1] <= 0.2
      && piece.box.y[1] - piece.box.y[0] <= 0.06
    const bars = lacePieces.filter(across)
    const above = pieces.filter((piece) => piece.box.y[1] > rim + 0.01)
    // ...and how many of the bars' own faces look *up*. A bar is laid across the shoe's
    // top surface, so a face of it the renderer draws from above is wound out of that
    // surface; wound the other way it faces down into the shoe, which the renderer draws
    // from behind and so never draws at all. Measured, that is what the laces were: all
    // twelve bars on the model, every face of them pointing down, and not one of them on
    // screen — so the count of them alone cannot tell a laced shoe from a bare one.
    const shoeIndex = (laces ?? shoes).geometry.getIndex().array
    const shoePosition = (laces ?? shoes).geometry.getAttribute('position')
    let laceUpFaces = 0
    for (let i = 0; i < shoeIndex.length; i += 3) {
      const [a, b, c] = [shoeIndex[i], shoeIndex[i + 1], shoeIndex[i + 2]]
      if (!bars.some((bar) => bar.own.has(a) && bar.own.has(b) && bar.own.has(c))) continue
      const ux = shoePosition.getX(b) - shoePosition.getX(a)
      const uy = shoePosition.getY(b) - shoePosition.getY(a)
      const uz = shoePosition.getZ(b) - shoePosition.getZ(a)
      const vx = shoePosition.getX(c) - shoePosition.getX(a)
      const vy = shoePosition.getY(c) - shoePosition.getY(a)
      const vz = shoePosition.getZ(c) - shoePosition.getZ(a)
      const length = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)
      if (length > 0 && (uz * vx - ux * vz) / length > 0.5) laceUpFaces += 1
    }
    return {
      rim: round(rim),
      shellTops: shoeShells.map((shell) => round(shell.box.y[1])),
      laceBars: bars.length,
      laceUpFaces,
      sockBands: above.length,
      sockTop: above.length ? round(Math.max(...above.map((piece) => piece.box.y[1]))) : round(rim),
      // The tongue is the pad down the instep: wide, well off the ground, and far deeper
      // than a bar (measured, 0.07 of the shoe's height against a bar's 0.005).
      tongues: leather.filter((piece) => piece.box.x[1] - piece.box.x[0] >= 0.08
        && piece.box.y[1] - piece.box.y[0] >= 0.05 && piece.box.y[0] >= 0.06).length,
      pieces: pieces.length,
    }
  }

  // The brows, one per eye: a bar over the top of each eye plate, its own bounds read in
  // the model's rest frame, the piece it is read as, and its tone — the face's own tone
  // taken down, so it is darker than the skin it is drawn on and lighter than the eye
  // under it (the eyes are painted black). How far in front of the face a brow stands is
  // measured like the jersey's detail: the nearest vertex of the body it is hung on.
  const browsReading = () => {
    if (!brows) return null
    const list = shells(brows.geometry)
      .filter((vertices) => vertices.length >= 8)
      .map((vertices) => ({ verts: vertices.length, box: bounds(brows.geometry, vertices) }))
    return {
      count: list.length,
      pieces: list,
      standOff: standOffOf(brows),
      tones: tones(brows),
    }
  }

  return {
    helmet: helmet ? { ...describe(helmet), earCover: { lead: earCover(1), trail: earCover(-1) } } : null,
    body: describe(body),
    eyes: eyeReading(),
    brows: browsReading(),
    feet: feetReading(),
    jersey: jersey
      ? {
        ...describe(jersey),
        boundToBody: Boolean(jersey.isSkinnedMesh && jersey.skeleton && jersey.skeleton === body.skeleton),
        standOff: standOffOf(jersey, chestVertices),
        surfaceOff: surfaceOffOf(jersey, chestVertices),
        // The opening's own line, station by station: the piece that is the line (the one
        // with the most vertices), each station's height and how far forward it sits. A
        // station the cloth does not reach, and that falls back to a default rather than
        // holding the height of the one below it, leaves a step in this — measured, the
        // opening's top three stations sat 0.031 rig *behind* the cloth's own front and
        // came back 0.047 forward again at the collar, which is the opening diving inside
        // the body under it.
        line: (() => {
          const own = jersey.geometry.getAttribute('position')
          const widest = shells(jersey.geometry).sort((a, b) => b.length - a.length)[0] ?? []
          const stations = new Map()
          for (const vertex of widest) {
            const key = own.getY(vertex).toFixed(4)
            stations.set(key, Math.max(stations.get(key) ?? -Infinity, own.getZ(vertex)))
          }
          return [...stations.entries()]
            .map(([y, z]) => [Number(y), round(z)])
            .sort((a, b) => a[0] - b[0])
        })(),
        tones: tones(jersey),
        pieces: holes(jersey),
      }
      : null,
    shoes: shoes
      ? {
        ...describe(shoes),
        boundToBody: Boolean(shoes.isSkinnedMesh && shoes.skeleton && shoes.skeleton === body.skeleton),
        standOff: standOffOf(shoes, ownVertices),
        tones: tones(shoes),
        pieces: holes(shoes),
      }
      : null,
    // The laces on their own: the kit's cloth rather than the shoe's leather, so they
    // are the one piece of the shoe that is still a mesh of its own (see addShoeDetail).
    laces: laces
      ? {
        ...describe(laces),
        boundToBody: Boolean(laces.isSkinnedMesh && laces.skeleton && laces.skeleton === body.skeleton),
        standOff: standOffOf(laces),
        tones: tones(laces),
        pieces: holes(laces),
      }
      : null,
  }
}

// Which way each bone of the pose is *pointing*: the world direction of a bone's
// own three local axes, for the joints whose orientation is the pose rather than
// its position — the hands (whether a wrist has rolled over) and the upper arms
// (whether an elbow has popped up). probeBones gives where the joints are; this
// gives how they are turned, which the eye reads off a wrist and cannot get from
// a joint position.
function probeAxes(scene, names) {
  const batter = scene.getObjectByName(BATTER_NAME)
  if (!batter) return null
  const out = {}
  const up = new THREE.Vector3(0, 1, 0)
  for (const name of names) {
    const bone = batter.getObjectByName(name)
    if (!bone) continue
    const q = bone.getWorldQuaternion(new THREE.Quaternion())
    const axes = {}
    for (const [label, axis] of [['x', new THREE.Vector3(1, 0, 0)], ['y', new THREE.Vector3(0, 1, 0)], ['z', new THREE.Vector3(0, 0, 1)]]) {
      const world = axis.clone().applyQuaternion(q).normalize()
      axes[label] = { dir: world.toArray(), up: world.dot(up) }
    }
    out[name] = axes
  }
  return out
}

// Which way the *back of each palm* is facing, in world terms: the hand's own
// axes read off the posed skeleton, with the model's own statement of which of
// them is the back of the palm. The rig carries a ``palm_handle`` marker in each
// palm (see handFrames), and it sits on the palm's *side* of the hand — its local
// z is negative in both hands — so the palm faces the marker's side and the back
// of the palm is the hand's own +Z. Read rather than assumed, since it is the
// model's marker placement that makes it true.
function probePalms(scene) {
  const batter = scene.getObjectByName(BATTER_NAME)
  if (!batter) return null
  const up = new THREE.Vector3(0, 1, 0)
  const out = {}
  for (const side of ['L', 'R']) {
    const hand = batter.getObjectByName(`hand${side}`)
    const marker = batter.getObjectByName(`palm_handle${side}`)
    if (!hand || !marker) continue
    const localZ = marker.position.z
    const q = hand.getWorldQuaternion(new THREE.Quaternion())
    const back = new THREE.Vector3(0, 0, localZ < 0 ? 1 : -1).applyQuaternion(q).normalize()
    const handle = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize()
    out[side] = {
      // How much of the back of the palm faces the sky (-1 to 1).
      up: back.dot(up),
      back: back.toArray(),
      // How far the barrel is off vertical, which is what makes "the back of the
      // palm up" a direction the fist can be held on at all.
      tilt: Math.hypot(handle.x, handle.z),
      handle: handle.toArray(),
    }
  }
  return out
}

// World-space bounds of the batter's body, measured from the skeleton's joints:
// the body is skinned, so its geometry's own bounds are the rest pose and say
// nothing about the pose on screen. The joints stop at the skull and the ankles,
// so the box is padded to cover the head and the feet. Used once, on the set
// stance, to frame the camera.
function probeBodyBox(scene, only = null) {
  const batter = scene.getObjectByName(BATTER_NAME)
  if (!batter) return null
  let bones = null
  batter.traverse((node) => {
    if (!bones && node.isSkinnedMesh) bones = node.skeleton.bones
  })
  if (!bones) return null
  if (only) bones = bones.filter((bone) => only.includes(bone.name))
  const box = new THREE.Box3()
  for (const bone of bones) box.expandByPoint(bone.getWorldPosition(new THREE.Vector3()))
  if (box.isEmpty()) return null
  return box.expandByScalar(box.getSize(new THREE.Vector3()).y * 0.09)
}

// The clock the harness pins the pose to: the phase's own time to begin with, and
// walked by sweep() below. Held in an object rather than passed down as a prop so
// a sweep can move it without re-rendering the stage.
const pinnedTime = { at: phaseTime }

// The idle's own clock: real elapsed time in the app (see the idle in
// Batter.jsx), and "leave it running" here. A sweep can pin and walk it, which is
// what makes the bounce measurable at all: it is otherwise wall-clock, so two
// reads of the same pose never agree.
// ``?idleTime=`` pins it on the way in, for reading or rendering one chosen phase
// of the bounce without a sweep.
const idleTimeRaw = idleQuery.get('idleTime')
const idleTimeParam = idleTimeRaw == null ? Number.NaN : Number(idleTimeRaw)
const idleTime = { at: Number.isFinite(idleTimeParam) ? idleTimeParam : null }

// Hold the frozen clocks on those times: re-pinned every frame so the pose can
// never creep away from them as frames accumulate. Mounted BEFORE the batter (see
// Stage) so the pin lands in the same frame as the read: three's clock has
// already accumulated this frame's delta by the time the subscribers run.
function TimePin() {
  useFrame((state) => {
    setSimulationTime(pinnedTime.at)
    if (idleTime.at !== null) state.clock.elapsedTime = idleTime.at
  })
  return null
}

// How many rendered frames a sweep waits after moving the clock. The batter's own
// frame callback and this file's pin run in the same frame, so the pose lags the
// clock by a frame; two is enough and three is the margin. The cap is only there
// so a page that has stopped drawing fails loudly instead of hanging.
const SWEEP_SETTLE_FRAMES = 3
const SWEEP_MAX_TRIES = 600

const settleFrames = (count) =>
  new Promise((resolve) => {
    const target = vr.frames + count
    let tries = 0
    const tick = () => {
      tries += 1
      if (vr.frames >= target || tries > SWEEP_MAX_TRIES) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

/**
 * Move the pinned clock across a window and read the probes at every step, in one
 * page load. This is what lets a reading cover a *whole* window rather than a
 * chosen moment: a pop between two moments is exactly what a moment-based test
 * cannot see, and a page load per sample would re-frame the camera and re-mount
 * the body for each one (about a second a sample).
 *
 * @param {number} from first sample's simulation time (s)
 * @param {number} to last sample's simulation time (s), inclusive
 * @param {number} step the gap between samples (s)
 * @param {string[]} names probe functions on ``vr`` to call at each sample
 * @returns {Promise<Array<{time: number, [probe: string]: any}>>}
 */
async function sweep(from, to, step, names) {
  const count = Math.max(1, Math.round((to - from) / step))
  const rows = []
  for (let i = 0; i <= count; i += 1) {
    const time = from + (i * (to - from)) / count
    pinnedTime.at = time
    await settleFrames(SWEEP_SETTLE_FRAMES)
    const row = { time: Number(time.toFixed(4)) }
    for (const name of names) row[name] = typeof vr[name] === 'function' ? vr[name]() : null
    rows.push(row)
  }
  // Leave the page where the phase put it: a sweep must not leak into a
  // baseline, so the clock goes back to the phase time and the pose settles
  // there again before the page is used for anything else.
  pinnedTime.at = phaseTime
  await settleFrames(SWEEP_SETTLE_FRAMES)
  return rows
}

/**
 * The same walk, over the idle's own clock rather than the simulation's: the
 * bounce is a function of real elapsed time, so a pose can only be compared
 * between builds if the clock that drives it is pinned. Leaves the idle clock
 * free again (``at = null``) so a baseline render is not held on one phase of
 * the bounce.
 *
 * @param {number} from first sample's idle clock time (s)
 * @param {number} to last sample's idle clock time (s), inclusive
 * @param {number} step the gap between samples (s)
 * @param {string[]} names probe functions on ``vr`` to call at each sample
 * @returns {Promise<Array<{time: number, [probe: string]: any}>>}
 */
async function sweepIdle(from, to, step, names) {
  const count = Math.max(1, Math.round((to - from) / step))
  const rows = []
  for (let i = 0; i <= count; i += 1) {
    const time = from + (i * (to - from)) / count
    idleTime.at = time
    await settleFrames(SWEEP_SETTLE_FRAMES)
    const row = { time: Number(time.toFixed(4)) }
    for (const name of names) row[name] = typeof vr[name] === 'function' ? vr[name]() : null
    rows.push(row)
  }
  idleTime.at = null
  await settleFrames(SWEEP_SETTLE_FRAMES)
  return rows
}

/**
 * The idle's own clock, as it stands: a probe reading the bounce at one phase of
 * it can pin ``?idleTime=`` and read this back rather than re-deriving the phase.
 *
 * @returns {number|null} the pinned idle clock time (s), or null while it runs free
 */
function getIdleTime() {
  return idleTime.at
}

// A material that punches the faded part out of whatever draws it, or — on the
// shell mesh that redraws exactly that part — draws it translucent instead. Both
// read the per-vertex ``aFade`` share the geometry carries, and a vertex counts
// as faded at 0.5, so the two are exact complements: no gap at the seam and no
// triangle drawn twice.
const FADE_ATTRIBUTE = 'aFade'

function fadeMaterial(source, shell) {
  const material = source.clone()
  material.transparent = shell
  material.depthWrite = !shell
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeOpacity = { value: FADE_OPACITY }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float ${FADE_ATTRIBUTE};\nvarying float vFade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvFade = ${FADE_ATTRIBUTE};`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;\nuniform float uFadeOpacity;')
      .replace('#include <opaque_fragment>', `${shell
        ? 'if (vFade <= 0.5) discard;\ndiffuseColor.a *= uFadeOpacity;'
        : 'if (vFade > 0.5) discard;'}\n#include <opaque_fragment>`)
  }
  material.needsUpdate = true
  return material
}

// How much of every vertex follows one of ``names``, from the mesh's own skin
// weights: the body is a single skinned mesh, so this is what makes the regions
// separable at all. A vertex on the shoulder seam ends up half faded, which is
// why the materials cut at 0.5 rather than at 1.
function fadeShares(mesh, names) {
  const index = mesh.skeleton.bones.map((bone) => (names.has(bone.name) ? 1 : 0))
  if (!index.some(Boolean)) return null
  const { skinIndex, skinWeight } = mesh.geometry.attributes
  if (!skinIndex || !skinWeight) return null
  const shares = new Float32Array(skinIndex.count)
  for (let vertex = 0; vertex < shares.length; vertex += 1) {
    let share = 0
    for (let slot = 0; slot < 4; slot += 1) {
      share += skinWeight.array[vertex * 4 + slot] * index[skinIndex.array[vertex * 4 + slot]]
    }
    shares[vertex] = share
  }
  return shares
}

// Makes the requested parts translucent, once the body is in the scene. Each
// affected mesh keeps its own triangles minus the faded part, and gains a shell
// that draws that part translucent on top; the bat, and anything else outside
// the skinned body, fades whole. Note the shells are cloned materials, so they do
// not track the component's camera-proximity fade — a pose view holds the camera
// in front of the batter, where that fade is inactive anyway.
function heatParts(scene, boneName) {
  const bones = new Set([boneName])
  scene.traverse((node) => {
    if (!node.isSkinnedMesh || node.userData.faded) return
    const shares = fadeShares(node, bones)
    if (!shares) return
    const geometry = node.geometry.clone()
    geometry.setAttribute(FADE_ATTRIBUTE, new THREE.BufferAttribute(shares, 1))
    node.geometry = geometry
    const patch = (source) => {
      const material = source.clone()
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\nattribute float ${FADE_ATTRIBUTE};\nvarying float vFade;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>\nvFade = ${FADE_ATTRIBUTE};`)
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vFade;')
          .replace('#include <opaque_fragment>',
            'gl_FragColor = mix(vec4(outgoingLight, diffuseColor.a), vec4(vFade, 0.0, 1.0 - vFade, 1.0), 0.5);')
      }
      material.needsUpdate = true
      return material
    }
    node.material = Array.isArray(node.material) ? node.material.map(patch) : patch(node.material)
    node.userData.faded = true
  })
}

function fadeParts(scene) {
  const bones = new Set()
  for (const name of fadeNames) for (const bone of FADE_REGIONS[name] ?? []) bones.add(bone)
  const meshes = new Set(fadeNames.map((name) => FADE_MESHES[name]).filter(Boolean))
  if (!bones.size && !meshes.size) return 0

  const targets = []
  scene.traverse((node) => {
    if (!node.isMesh || node.userData.faded) return
    let shares = null
    if (node.isSkinnedMesh && bones.size) {
      shares = fadeShares(node, bones)
      if (!shares) return
    } else if (meshes.size) {
      let inside = false
      for (let parent = node; parent && !inside; parent = parent.parent) inside = meshes.has(parent.name)
      if (!inside) return
      shares = new Float32Array(node.geometry.attributes.position.count).fill(1)
    } else return
    if (!shares.some((share) => share > 0)) return
    targets.push({ node, shares })
  })

  for (const { node, shares } of targets) {
    const source = Array.isArray(node.material) ? [...node.material] : [node.material]
    // The geometry is cloned rather than edited: the model's geometries are
    // shared with drei's cached asset, and the fade attribute belongs to this
    // view alone.
    const geometry = node.geometry.clone()
    geometry.setAttribute(FADE_ATTRIBUTE, new THREE.BufferAttribute(shares, 1))
    // The body draws the same geometry with the faded part cut out of it, so it
    // has to carry the fade attribute too.
    node.geometry = geometry
    const patch = (shell) => (Array.isArray(node.material)
      ? source.map((material) => fadeMaterial(material, shell))
      : fadeMaterial(source[0], shell))
    node.material = patch(false)
    const shell = node.isSkinnedMesh
      ? new THREE.SkinnedMesh(geometry, patch(true))
      : new THREE.Mesh(geometry, patch(true))
    if (node.isSkinnedMesh) {
      shell.bind(node.skeleton, node.bindMatrix)
      shell.bindMode = node.bindMode
    }
    shell.castShadow = false
    shell.receiveShadow = false
    shell.frustumCulled = false
    shell.userData.faded = true
    node.userData.faded = true
    node.add(shell)
  }
  return targets.length
}

// Renders the batter the way the app does, in three stages:
//
//   0. no pitch at all — the app renders <Batter> before any at-bat data
//      arrives, and player.glb is preloaded, so the body's asset routinely
//      loads before there is anything to swing at. The body has to come up
//      posed from a mount like that, which is exactly what it failed to do.
//   1. the set stance, purely to frame the camera from it. Measured on the
//      stance, the framing is identical for every phase; measured on the
//      displayed pose it would shift shot to shot and make the baselines
//      impossible to compare.
//   2. the phase's pitch, on the pinned clock.
//
// Stage 2 is only entered once the render has settled, so every baseline also
// covers the late-pitch mount.
function Stage() {
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const [stage, setStage] = useState(0)
  const idleFrames = useRef(0)
  const settleFrames = useRef(0)
  const sinceStaged = useRef(0)
  const faded = useRef(false)

  useFrame(() => {
    vr.frames += 1
    // The body mounts with the first pitch, so this is where the debug fade (if
    // one was asked for) can see it.
    if (!faded.current && scene.getObjectByName(BATTER_NAME)) {
      faded.current = true
      vr.fadedMeshes = fadeParts(scene)
      if (HEAT_BONE) heatParts(scene, HEAT_BONE)
      if (MARK_RULER || RING_HEIGHTS.length || DOT_HEIGHTS.length) {
        const batter = scene.getObjectByName(BATTER_NAME)
        const frame = batter.getObjectByName('batter-frame')
        const scale = frame.getWorldScale(new THREE.Vector3()).x
        const origin = batter.getWorldPosition(new THREE.Vector3())
        // A legible ladder: a ring every 0.05 rig units from 1.15 to 1.60, with
        // magenta on the tenths (1.20, 1.30, 1.40, 1.50) so a height can be read
        // off a render by eye. `?ring=a,b,c` instead draws just those heights,
        // each in its own colour, for calibrating a render against the body.
        const marks = RING_HEIGHTS.length
          ? RING_HEIGHTS.map((rigY, index) => [rigY, RING_COLORS[index % RING_COLORS.length]])
          : []
        if (!RING_HEIGHTS.length) {
          for (let step = 23; step <= 32; step += 1) {
            const rigY = step * 0.05
            marks.push([rigY, Math.abs(rigY * 10 - Math.round(rigY * 10)) < 1e-6 ? 0xff00ff : 0x00ffff])
          }
        }
        for (const rigY of DOT_HEIGHTS) {
          const index = DOT_HEIGHTS.indexOf(rigY)
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.012 * scale, 12, 12),
            new THREE.MeshBasicMaterial({ color: RING_COLORS[index % RING_COLORS.length] }),
          )
          for (const side of [1, -1]) {
            const dot = sphere.clone()
            dot.position.set(origin.x + side * 0.34 * scale, rigY * scale, origin.z)
            scene.add(dot)
          }
        }
        for (const [rigY, color] of marks) {
          const points = []
          for (let i = 0; i <= 64; i += 1) {
            const a = (i / 64) * Math.PI * 2
            points.push(new THREE.Vector3(
              origin.x + Math.sin(a) * 0.5 * scale,
              rigY * scale,
              origin.z + Math.cos(a) * 0.5 * scale,
            ))
          }
          scene.add(new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color }),
          ))
        }
      }
    }
    if (stage === 0) {
      // Held until the body's own asset is in the cache, so this stage is the
      // real thing rather than a race the harness might win.
      idleFrames.current += 1
      if (vr.playerLoaded && idleFrames.current > 2) setStage(1)
      return
    }
    if (stage === 1) {
      // The stance is a static pose, but the body's first frames after the mount
      // can still be in its resting shape (the pose is written per frame), and
      // framing on that would move the camera — visible as a shifted horizon in
      // every baseline. Wait for the pose to have been written a few times.
      settleFrames.current += 1
      if (settleFrames.current <= FRAME_SETTLE_FRAMES) return
      const box = probeBodyBox(scene, CAMERA_FOCUS)
      if (!box) return
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2
      const fitHeight = (size.y / 2) / Math.tan(halfFov)
      const fitWidth = (Math.max(size.x, size.z) / 2) / (Math.tan(halfFov) * camera.aspect)
      const distance = Math.max(fitHeight, fitWidth) * FRAME_MARGIN * SWING_MARGIN * CAMERA_ZOOM
      camera.position.copy(center).addScaledVector(CAMERA_DIRECTION, distance)
      camera.lookAt(center)
      camera.updateProjectionMatrix()
      vr.framing = { center: center.toArray(), size: size.toArray(), distance }
      // ...and the camera itself, so a probe can project a point of the body to a
      // pixel exactly rather than rebuilding the framing and hoping it matches.
      vr.camera = camera
      vr.fov = camera.fov
      setStage(2)
      return
    }
    sinceStaged.current += 1
    // A few frames on the pinned clock so every part has rendered at the phase.
    if (sinceStaged.current > 4 && !vr.ready) vr.ready = true
  })

  useEffect(() => {
    vr.scene = scene
    vr.THREE = THREE
    vr.probeBat = () => probeBat(scene)
    vr.probeBones = () => probeBones(scene)
    vr.probeAxes = (names) => probeAxes(scene, names ?? ['handL', 'handR', 'upper_armL', 'upper_armR', 'forearmL', 'forearmR'])
    vr.probePalms = () => probePalms(scene)
    vr.probeSolve = () => probeSolve(scene)
    vr.probeStrain = () => probeStrain(scene)
    vr.probeTrunk = () => probeTrunk(scene)
    vr.probeBatBody = () => probeBatBody(scene)
    vr.probeCover = (view) => probeCover(scene, view)
    vr.probeGrip = () => probeGrip(scene)
    vr.probeSleeve = () => probeSleeve(scene)
    vr.probeKit = () => probeKit(scene)
    vr.sweep = (from, to, step, names) => sweep(from, to, step, names)
    vr.sweepIdle = (from, to, step, names) => sweepIdle(from, to, step, names)
    vr.getIdleTime = () => getIdleTime()
    // The tuning this page is actually running with, for a probe that needs to know
    // what it asked for (the group that affects this pose, at least).
    vr.getIdleTuning = () => ({ ...getTuning().batter })
  }, [scene])

  // One <Batter> instance for the whole run, with only its pitchData prop
  // changing — the app remounts nothing when a new pitch arrives, so neither
  // does this.
  const pitchData = stage === 0 ? null : stage === 1 ? STANCE_PITCH : phase.pitch

  return (
    <Suspense fallback={null}>
      {/* The pin is mounted first so its frame callback runs *before* the batter's:
          three's clock has already added this frame's delta by then, so pinning
          after the batter would hold a pose one frame stale instead. */}
      {stage === 2 && <TimePin />}
      <Batter pitchData={pitchData} replayKey={0} />
    </Suspense>
  )
}

// Pulls the batter body's asset into the cache and reports it, so the harness
// can hold stage 0 until the model is genuinely loaded: that is the mount order
// where the body used to come up in its rest pose. The path mirrors
// PLAYER_URL in src/components/Batter.jsx.
const PLAYER_ASSET_URL = '/models/player.glb'

function PlayerAssetReady() {
  useGLTF(PLAYER_ASSET_URL)
  useEffect(() => {
    vr.playerLoaded = true
  }, [])
  return null
}

// The app's ballpark grass, minus the full Ballpark model, so the batter reads
// against a surface instead of floating in the background.
function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[20, 64]} />
      <meshStandardMaterial color="#2e7d32" roughness={1} />
    </mesh>
  )
}

// A baseball parked on the pitch's plate crossing, so the contact baseline shows
// at a glance whether the barrel is arriving on the ball. The suite's geometric
// assertion measures the same point without relying on this marker.
function BallMarker() {
  return (
    <mesh position={CONTACT_WORLD}>
      <sphereGeometry args={[0.037, 16, 16]} />
      <meshStandardMaterial color="#ffffff" roughness={0.6} />
    </mesh>
  )
}

createRoot(document.getElementById('root')).render(
  <Canvas dpr={1} camera={{ fov: CAMERA_FOV, near: 0.05, far: 200 }} gl={{ antialias: true }}>
    <color attach="background" args={['#8fc4ec']} />
    {/* Lighting copied from Scene.jsx (ambient 0.5 + a key light at [10, 10, 5]) */}
    <ambientLight intensity={0.5} />
    <directionalLight position={[10, 10, 5]} intensity={1} />
    <Ground />
    <BallMarker />
    <Suspense fallback={null}>
      <PlayerAssetReady />
    </Suspense>
    <Stage />
  </Canvas>,
)
