// Pure math for the batter's forward-lean pose, shared by Batter.jsx and the
// regression tests.
//
// The lean points at the midpoint of the home-plate -> catcher segment and is
// expressed as an upper-body Euler rotation. The Euler order matters: the yaw
// must be applied first so the forward/sideways lean tilts stay in the body's
// own frame. three.js's default 'XYZ' order applies the forward lean (x) after
// the yaw and flips the lean nearly 180 degrees — the body leans AWAY from the
// midpoint — which is the regression this module exists to pin down.

export const BATTER_LEAN_ORDER = 'YXZ'

// Normalized world-space horizontal direction from the batter to the midpoint
// of the home-plate -> catcher segment.
export function batterLeanDirection(batX, stanceZ, catcherZ) {
  const len = Math.hypot(batX, stanceZ - catcherZ * 0.5) || 1
  return {
    x: -batX / len,
    z: (catcherZ * 0.5 - stanceZ) / len,
  }
}

// Upper-body lean rotation: returns rotation.x / rotation.z (radians) that tilt
// the body ``leanMag`` radians toward the plate-catcher midpoint, given the
// upper body's current ``bodyYaw``. Apply them with Euler order
// BATTER_LEAN_ORDER (yaw -> x -> z). Also returns the target direction so
// callers/tests can check the resulting tilt without recomputing it.
export function batterLean(batX, stanceZ, catcherZ, bodyYaw, leanMag) {
  const dir = batterLeanDirection(batX, stanceZ, catcherZ)
  const localX = dir.x * Math.cos(bodyYaw) - dir.z * Math.sin(bodyYaw)
  const localZ = dir.x * Math.sin(bodyYaw) + dir.z * Math.cos(bodyYaw)
  return {
    targetX: dir.x,
    targetZ: dir.z,
    rotationX: leanMag * localZ,
    rotationZ: -leanMag * localX,
  }
}
