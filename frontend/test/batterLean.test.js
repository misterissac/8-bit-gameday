import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { BATTER_LEAN_ORDER, batterLean } from '../src/util/batterLean.js'

const feetToM = (f) => f * 0.3048
const CATCHER_Z = feetToM(6)
const LEAN_MAG = 0.3

// Mirrors the stance math in Batter.jsx for a typical 5'11" batter: the
// batter stands on the third-base side (righty) or first-base side (lefty),
// and the set stance yaw faces a point biased toward home plate on the
// plate -> catcher segment.
const stance = (batSide) => {
  const heightScale = ((71 * 0.0254) / 1.96) * 0.85
  const stanceX = 0.65 * heightScale
  const stanceZ = 0.75 * heightScale
  const batX = batSide === 'L' ? stanceX : -stanceX
  const setYaw = Math.atan2(batX, stanceZ - CATCHER_Z * 0.35)
  return { batX, stanceZ, setYaw }
}

// Apply the lean exactly the way Batter.jsx does: rotation.x/y/z with the
// shared Euler order, then read how far the body's up vector tilts in X/Z.
const worldUpTilt = (lean, bodyYaw) => {
  const up = new THREE.Vector3(0, 1, 0).applyEuler(
    new THREE.Euler(lean.rotationX, bodyYaw, lean.rotationZ, BATTER_LEAN_ORDER),
  )
  return { x: up.x, z: up.z }
}

for (const batSide of ['R', 'L']) {
  test(`${batSide === 'R' ? 'right' : 'left'}-handed batter leans toward the plate-catcher midpoint`, () => {
    const { batX, stanceZ, setYaw } = stance(batSide)
    const lean = batterLean(batX, stanceZ, CATCHER_Z, setYaw, LEAN_MAG)

    const tilt = worldUpTilt(lean, setYaw)
    const dot = tilt.x * lean.targetX + tilt.z * lean.targetZ

    // A lean that points away from the midpoint has a negative dot product;
    // the old XYZ-order bug produced ~-0.05 here. Require it to be clearly
    // positive and close to the full lean magnitude.
    assert.ok(dot > 0, `lean tilts away from the midpoint (dot=${dot.toFixed(3)})`)
    assert.ok(
      dot > LEAN_MAG * 0.8,
      `lean is too weak or off-target (dot=${dot.toFixed(3)}, expected ~${LEAN_MAG})`,
    )
  })

  test(`${batSide === 'R' ? 'right' : 'left'}-handed batter head aims directly at pitcher without tilting up during windup forward lean`, () => {
    const { batX, stanceZ, setYaw } = stance(batSide)
    const lean = batterLean(batX, stanceZ, CATCHER_Z, setYaw, LEAN_MAG)
    const PITCHER_Z = -18.44

    const upper = new THREE.Group()
    upper.rotation.order = BATTER_LEAN_ORDER
    upper.rotation.y = setYaw
    upper.rotation.x = lean.rotationX
    upper.rotation.z = lean.rotationZ

    const head = new THREE.Group()
    head.rotation.order = 'YXZ'
    upper.add(head)
    upper.updateMatrixWorld(true)

    // Compute compensated pitcher look in upper body live frame
    const headWorld = new THREE.Vector3()
    head.getWorldPosition(headWorld)
    const pitcherTarget = new THREE.Vector3(0, headWorld.y, PITCHER_Z)
    const worldDir = new THREE.Vector3().subVectors(pitcherTarget, headWorld).normalize()
    const upperQuat = upper.getWorldQuaternion(new THREE.Quaternion())
    const localDir = worldDir.clone().applyQuaternion(upperQuat.clone().invert())
    const pitcherYaw = Math.atan2(-localDir.x, -localDir.z)
    const pitcherDist = Math.hypot(localDir.x, localDir.z)
    const pitcherTilt = Math.atan2(localDir.y, pitcherDist)

    head.rotation.y = pitcherYaw
    head.rotation.x = pitcherTilt
    upper.updateMatrixWorld(true)

    const headWorldQuat = head.getWorldQuaternion(new THREE.Quaternion())
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(headWorldQuat)

    // Forward gaze should point directly at the pitcher with 0 vertical elevation error
    const angleToTarget = (forward.angleTo(worldDir) * 180) / Math.PI
    assert.ok(angleToTarget < 0.01, `head angle to pitcher should be <0.01 deg, got ${angleToTarget.toFixed(4)} deg`)
    assert.ok(Math.abs(forward.y) < 0.001, `head vertical gaze error should be <0.001, got ${forward.y.toFixed(4)}`)
  })
}

test('torso recovery lags upper arms and bat so torso does not turn back first', () => {
  const torsoRecoverLag = 0.22

  // During initial 22% of recovery, arms/bat unwrap while torso holds follow-through turn
  for (const r of [0.0, 0.05, 0.10, 0.20, 0.22]) {
    const rTorso = THREE.MathUtils.clamp((r - torsoRecoverLag) / (1 - torsoRecoverLag), 0, 1)
    assert.equal(rTorso, 0, `torso should hold turn at r=${r}, got rTorso=${rTorso}`)
  }

  // After 22%, torso smoothly turns back trailing the arms
  const rMid = 0.61
  const rTorsoMid = THREE.MathUtils.clamp((rMid - torsoRecoverLag) / (1 - torsoRecoverLag), 0, 1)
  assert.ok(rTorsoMid > 0 && rTorsoMid < 1, `torso should be recovering at r=${rMid}`)
  assert.ok(rTorsoMid < rMid, `torso recovery (${rTorsoMid.toFixed(2)}) should trail arms (${rMid})`)

  // By end of recovery, both reach 1
  const rEnd = 1.0
  const rTorsoEnd = THREE.MathUtils.clamp((rEnd - torsoRecoverLag) / (1 - torsoRecoverLag), 0, 1)
  assert.equal(rTorsoEnd, 1.0, 'torso reaches set stance at r=1.0')
})
