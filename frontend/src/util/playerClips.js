import * as THREE from 'three'
import { clamp } from './MathUtil.js'
import { ONE_SHOT_STATES, RUN_TIME_SCALE, STATE_FADE_SECONDS, STATE_RUN } from './playCast.js'

// ---------------------------------------------------------------------------
// How a body's baked clips are played back: the binding every actor shares, the
// cross-fade between states, and the two halves of handing a body that was being
// *authored* over to those clips without a cut.
//
// Three components drive player.glb from its own clips rather than authoring a
// pose: the cast (components/FieldCast.jsx — the seven fielders and the runners
// on the bases), the batter's own body once it is the batter-runner
// (components/Batter.jsx, through util/batterRunner.js), and the pitcher's own
// body when the play gives him something to field (components/Pitcher.jsx, off
// playCast's `pitcherFrameAt`). All three wear the body util/playerBody.js
// builds, so all three need the same things: a mixer's actions for every clip the
// asset ships, with the one-shot ones held on their last frame, a state change
// that cross-fades instead of cutting, and — for the two bodies that are authored
// before they are handed over — the snapshot and the blend below.
//
// The clip rules are the reference's own (`setAnimationState` in
// solomon-gumball's components/Players.tsx): nothing to do when the state is
// already the current one, a short cross-fade when it changes, and `Running`
// played at 4x because the baked clip is a jog. They live here rather than in any
// component so the fielder who runs down a grounder, the batter who runs to first
// and the pitcher who goes after a comebacker are all playing those clips the
// same way.
// ---------------------------------------------------------------------------

/**
 * Every clip the asset ships, bound to a mixer and primed with its loop rules:
 * the one-shot states (a slide, a catch pose, a throw) play once and hold on
 * their last frame, everything else loops.
 *
 * @param {THREE.AnimationMixer} mixer the mixer rooted at the body
 * @param {THREE.AnimationClip[]} clips the asset's own clips
 * @returns {Map<string, THREE.AnimationAction>} the actions, by clip name
 */
export function bindClips(mixer, clips = []) {
  const actions = new Map()
  for (const clip of clips) {
    const action = mixer.clipAction(clip)
    if (ONE_SHOT_STATES.has(clip.name)) {
      action.clampWhenFinished = true
      action.setLoop(THREE.LoopOnce, 1)
    }
    actions.set(clip.name, action)
  }
  return actions
}

/**
 * Cross-fade a body into an animation state (the reference's own
 * `setAnimationState`). The actor is anything holding `{ actions, state }` — the
 * cast's bodies and the batter's runner alike — and the state it is left in is
 * written back onto it, so the next call knows what it is fading out of.
 *
 * @param {{actions: Map<string, THREE.AnimationAction>, state: string|null}} actor
 * @param {string} state the clip to play (see playCast's STATE_* names)
 */
export function setActorState(actor, state) {
  if (!state || actor.state === state) return
  const action = actor.actions.get(state)
  if (!action) return
  const prev = actor.state ? actor.actions.get(actor.state) : null
  action.reset()
  if (prev && prev !== action) {
    prev.fadeOut(STATE_FADE_SECONDS)
    action.fadeIn(STATE_FADE_SECONDS)
  }
  action.setEffectiveTimeScale(state === STATE_RUN ? RUN_TIME_SCALE : 1)
  action.play()
  actor.state = state
}

/**
 * The body's bones as they stand right now: the pose it is about to be moved out
 * of. Taken on the handoff frame, where the component that authors this body has
 * just posed it for the last time — the batter's swing the frame the play's own
 * clock reaches his takeoff (components/Batter.jsx), the pitcher's delivery the
 * frame the ball is hit (components/Pitcher.jsx).
 *
 * @param {THREE.Object3D} root the body the bones hang under (the clone's own
 *   model, the one the mixer is rooted at)
 * @returns {Array<{bone: THREE.Bone, position: THREE.Vector3, quaternion: THREE.Quaternion}>}
 */
export function poseSnapshot(root) {
  const bones = []
  root.traverse((child) => {
    if (!child.isBone) return
    bones.push({ bone: child, position: child.position.clone(), quaternion: child.quaternion.clone() })
  })
  return bones
}

/**
 * Ease a snapshot out of a body: called *after* the mixer has posed it this
 * frame, and pulls every bone of it back toward the pose the snapshot holds — a
 * `weight` of 0 leaves the body exactly as the snapshot found it, 1 leaves the
 * mixer's own pose untouched, and in between the two poses are one.
 *
 * A bone rotation is interpolated on its own shortest arc (`slerpQuaternions`)
 * rather than per axis, because the handoff's turn is most of the way round: a
 * stance's hips and a sprint's are over 90 degrees apart, and a component-wise
 * blend of two quaternions that far apart is not the shorter path at all.
 *
 * @param {ReturnType<typeof poseSnapshot>} snapshot
 * @param {number} weight 0..1 of the *clips* — the handoff's own share
 */
export function blendSnapshot(snapshot, weight) {
  const w = clamp(weight, 0, 1)
  if (w >= 1 || !snapshot) return
  for (const { bone, position, quaternion } of snapshot) {
    // `lerpVectors` reads both ends before it writes, so the live value can be
    // its own second argument; `slerpQuaternions` cannot (it copies the first
    // into `this` and then interpolates `this` toward the second, which *is*
    // `this` here) — so the bone's own clip pose is taken aside first, the bone
    // is set to the snapshot and slerped back toward it.
    _clipQuaternion.copy(bone.quaternion)
    bone.position.lerpVectors(position, bone.position, w)
    bone.quaternion.copy(quaternion).slerp(_clipQuaternion, w)
  }
}

// Scratch for the blend (a frame loop allocating a quaternion per bone per frame
// is a frame loop the GC gets to run during a play).
const _clipQuaternion = new THREE.Quaternion()
