import { useLayoutEffect, useRef, useState } from 'react'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { createPlayerRig, measurePlayerRig } from './playerRig'
import { applyBatterLook } from './batterLook'

// The body both actors wear, and the driver that poses it — the plumbing the batter
// and the pitcher each used to write for themselves (Batter.jsx and Pitcher.jsx had
// the same ninety lines twice, one of them a copy of the other).
//
// It is one asset either way (public/models/player.glb) and, measured, one body:
// every joint `measurePlayerRig` reports is the same number in the two actors'
// frames, scaled by the frame's own unit (`unitScale` — 1 for the pitcher, whose
// frame is metres, and 2.48 / the model's own height for the batter, whose frame is
// the reference sprite's). What differs between them is what they *do* with the
// body, not the body: the delivery's pose is authored in metres and the swing's is
// solved in the sprite frame, which is why the two components stay two components
// and only this is shared.
//
// What is shared, in the order it has to happen:
//
//   1. the clone — SkeletonUtils, so the cached asset's own bones are never posed,
//      and per-pitch materials and visibility never write to the cache;
//   2. the shadows, and the meshes this actor does not wear hidden — the batter's
//      cap and gloves, say (HIDDEN_MESHES); the pitcher wears the cap and hides the
//      helmet instead, which is his uniform's own business and stays with it;
//   3. the measure — `measurePlayerRig`, in *this* actor's frame (see
//      `spriteNominalHeightM`), taken at the rest pose;
//   4. the look pass (util/batterLook.js) — one body, one face, one uniform: the
//      hat, the eyes under it, the jersey's own opening and its buttons, and shoes
//      that read as shoes. Which hat is the caller's to say;
//   5. the rest pose itself, snapshotted *before* the driver starts writing to it:
//      every pose either actor authors is relative to the resting skeleton.
//
// The driver is built from those pieces by `useBodyRig` below, once the body is
// really in the scene — see its own note for why that is state rather than a ref.

/**
 * The actor's own body: the shared model cloned, dressed and measured. Pure — no
 * scene, no React — so it can be built in a memo and read in a test.
 *
 * @param {THREE.Object3D} scene the loaded player.glb scene (the cached asset)
 * @param {object} [options]
 * @param {number|null} [options.spriteNominalHeightM] the frame to measure the
 *   joints in: null for the model's own (metres), or the height the caller's frame
 *   stands the sprite at (see `measurePlayerRig`)
 * @param {string[]} [options.hide] meshes this actor does not wear
 * @param {object|null} [options.look] what to hand the look pass (see
 *   `applyBatterLook`) — `{ headgear, sign }`; null to leave the model as it ships
 * @returns {{model: THREE.Object3D, metrics: object, restPose: Map, look: object|null}}
 *   the body, its joints in the caller's frame, the resting skeleton, and what the
 *   look pass reports it did (the row the actor tests compare between the two)
 */
export function buildPlayerBody(scene, { spriteNominalHeightM = null, hide = [], look = null } = {}) {
  const model = cloneSkeleton(scene)
  model.traverse((child) => {
    if (!child.isMesh) return
    child.castShadow = true
    child.receiveShadow = true
    if (hide.includes(child.name)) child.visible = false
  })
  const metrics = measurePlayerRig(model, { spriteNominalHeightM })
  const report = look ? applyBatterLook(model, look) : null
  const restPose = new Map()
  model.traverse((child) => {
    if (!child.isBone) return
    restPose.set(child, {
      position: child.position.clone(),
      quaternion: child.quaternion.clone(),
    })
  })
  return { model, metrics, restPose, look: report }
}

// No placement, shared rather than written inline: it is a layout the driver is
// handed, and one that changed identity every render would rebuild the driver every
// render (see the effect below).
const NO_PLACEMENT = [0, 0, 0]

/**
 * The bone driver for a body, built once the model is mounted.
 *
 * Which node is mounted is held in state rather than read from a ref, and the memo
 * above is not enough on its own: the components render with no pitch at all until
 * an at-bat arrives, and player.glb can finish loading before that, so the commit
 * that creates the driver is not necessarily the commit that mounts the body. A ref
 * would be read once — empty — and the driver would never be built, leaving the
 * model in its rest pose while only the bat (or the ball) moved.
 *
 * @param {{model: THREE.Object3D, metrics: object, restPose: Map}} body from
 *   `buildPlayerBody`
 * @param {object} [options]
 * @param {number[]} [options.placement] where the model sits in the parent frame,
 *   in the metrics' units — the driver is told the same offset, because every joint
 *   target it is handed is authored from the frame's origin
 * @param {function|null} [options.groundAt] the ground the pose plants feet on, as
 *   a height under a place (see `createPlayerRig`) — null for a flat plane at zero
 * @returns {{driverRef: object, setModelNode: function, waistJoint: number[]|null}}
 *   the driver, the ref the body is mounted with, and the waist joint the driver
 *   turns the ribcage about — null until the body has been shaped, and the number
 *   the caller's pose has to carry from then on (a rig is `{ ...metrics, waistJoint }`)
 */
export function useBodyRig(body, { placement = NO_PLACEMENT, groundAt = null } = {}) {
  const driverRef = useRef(null)
  const [modelNode, setModelNode] = useState(null)
  const [waistJoint, setWaistJoint] = useState(null)
  useLayoutEffect(() => {
    if (!modelNode) return undefined
    const driver = createPlayerRig(body.model, body.metrics, body.restPose, placement, groundAt ? { groundAt } : undefined)
    driverRef.current = driver
    setWaistJoint(driver.waistJoint)
    return () => { driverRef.current = null }
  }, [modelNode, body, placement, groundAt])
  return { driverRef, setModelNode, waistJoint }
}
