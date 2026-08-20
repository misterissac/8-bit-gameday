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
}
