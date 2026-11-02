import React, { useMemo } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { TextureLoader } from 'three'
import { FIELD } from '../constants/field'
import { getTimeScale } from '../constants/playback'
import { clamp } from '../util/MathUtil'
import { buildPlayerBody } from '../util/playerBody.js'
import { LOOK_DETAIL_MESHES } from '../util/batterLook.js'
import { bindClips, setActorState } from '../util/playerClips.js'
import {
  AWAY_PLAYER_TEXTURE_URL,
  HOME_PLAYER_TEXTURE_URL,
  blueKit,
  dressBody,
  uniformFor,
} from '../util/playerKit.js'
import { facingYaw } from '../util/playCast.js'

// ---------------------------------------------------------------------------
// The catcher behind home plate (FIELD.DEFENSE.C): the same body every other
// man on the field wears — player.glb, cloned and dressed by the shared body and
// kit plumbing — crouched in his own baked clip.
//
// He used to be a figure built out of primitives (cylinders for the bent legs, a
// capsule for the torso, a box for the chest protector, a sphere for the head),
// which read as a catcher only because of where it stood. The asset ships the
// real thing: `CatcherIdle` is a catcher's crouch, authored by the same rig that
// authored the delivery, the swing and the run — so the catcher is a body on that
// clip, played through the same mixer and the same one-shot rules the cast and the
// batter-runner play theirs with (util/playerClips.js). That is the whole of the
// move: a body, its own clip, and the two things this component has always owned —
// where he stands and the fade.
//
// Three notes on the parts that are not obvious:
//
//   * no half turn. The asset's own frame faces +Z (see util/batterLook.js, which
//     paints the face), which is the frame `facingYaw` aims at a target, so the
//     body stands at the spot facing the pitcher with nothing but that yaw. The
//     batter and the pitcher each turn their body the half turn *their* frames
//     need (both are authored facing -Z); this one is not.
//
//   * the kit is his own cloth. The kit material is built here and handed to the
//     body through `dressBody`, which re-creates the two meshes the atlas does not
//     paint (the glove and the helmet) rather than sharing them — for exactly the
//     reason this component exists: he is faded every frame, and a body sharing a
//     material with a body that is not faded cannot be.
//
//   * the fade is the one it always was: within 3 m of the camera the catcher is
//     fully transparent and ramps back to fully opaque by 11 m, the reference's own
//     `clamp((distance - 3) / 8, 0, 1)` from solomon-gumball's Players.tsx, so a
//     camera brought in behind the strike zone ("Snap to Strike Zone") sees through
//     him to the zone. His materials never write depth, whether he is faded or not:
//     the pitch trajectory, the hawk-eye ring and the zone grid are drawn *through*
//     him from behind the plate, and writing depth would cull them.
// ---------------------------------------------------------------------------

const PLAYER_MODEL_URL = '/models/player.glb'

// Warm the caches so the catcher's body and kit come up with the ballpark rather
// than a frame after it.
useGLTF.preload(PLAYER_MODEL_URL)

// The clip he lives in: one of the asset's own fourteen (the same list the cast
// plays from), and the crouch itself. It is a *single pose* — two keys, the same
// values on every channel, like the other idles — so what he is playing is a pose
// rather than a breath, and it is the mixer's per-frame update that keeps it on
// him (measured off the file, and noted in the README's clip section).
const CATCHER_CLIP = 'CatcherIdle'

// What he does not wear, off the model's own meshes: the helmet (the defense
// wears the cap — the same choice the cast makes for its seven fielders), the
// right glove, and the left hand, which is inside the mitt.
const HIDDEN_MESHES = ['Helmet', 'GloveR', 'HandL']

// Fade window in meters: fully transparent within 3 m of the catcher, fully
// opaque by 11 m (the reference's (distance - 3) / 8 ramp).
const FADE_START_M = 3
const FADE_END_M = 11

export const Catcher = ({ defenseKit = 'home' }) => {
  const gltf = useGLTF(PLAYER_MODEL_URL)
  const homeTexture = useLoader(TextureLoader, HOME_PLAYER_TEXTURE_URL)
  // The visitors' kit, in the blue he shares with the rest of his side (see
  // util/playerKit.js's `blueKit`) — and it is the *same* answer the fielders take
  // (`defenseKit`), so when the half inning turns over the man behind the plate
  // changes into the other club's colours with everyone else on the field.
  const awayTexture = blueKit(useLoader(TextureLoader, AWAY_PLAYER_TEXTURE_URL))
  const { camera } = useThree()

  // His body, the group the schedule would move if anything moved him (nothing
  // does: he stands where he stands), and the mixer his clip runs on. Built as one
  // object so a probe — or a debugger — can find him as `catcher` in the scene
  // graph, the way the cast's bodies are `cast:<kind>:<key>`.
  const catcher = useMemo(() => {
    if (!gltf?.scene) return null
    const body = buildPlayerBody(gltf.scene, {
      hide: HIDDEN_MESHES,
      // The same look pass the batter and the pitcher are put through: eyes under
      // the brim, the jersey's opening and its buttons, shoes that read as shoes.
      // A catcher works in the cap, which is what the pass is told — the helmet's
      // own ear-flap work is the helmet's and is skipped for it.
      look: { headgear: 'cap' },
    })
    const root = new THREE.Group()
    root.name = 'catcher'
    root.position.copy(FIELD.DEFENSE.C)
    // Facing the pitcher, in the asset's own frame (see the header): the yaw that
    // aims a frame's +Z at a target is the whole of the turn he needs.
    root.rotation.y = facingYaw(FIELD.DEFENSE.C, FIELD.DEFENSE.P) ?? 0
    root.add(body.model)
    const mixer = new THREE.AnimationMixer(body.model)
    return { root, body, mixer, actions: bindClips(mixer, gltf.animations), state: null }
  }, [gltf])

  const kits = useMemo(() => ({
    home: uniformFor(homeTexture, { transparent: true }),
    away: uniformFor(awayTexture, { transparent: true }),
  }), [homeTexture, awayTexture])

  // Dressed in the memo rather than an effect: the materials a body wears are a
  // function of the body and the kit, and an effect would draw one frame of the
  // uncut asset — the kit is also what this component fades, so the two have to be
  // the same materials from the first frame on.
  const dressed = useMemo(
    () => catcher && dressBody(catcher.body.model, kits[defenseKit] ?? kits.home, {
      transparent: true,
      // The look pass's hung-beside-the-body pieces (brows, laces) keep their own
      // materials; the rest of what it added is welded into his body's surface and
      // takes the kit like any other part of him.
      keep: LOOK_DETAIL_MESHES,
    }),
    [catcher, kits, defenseKit],
  )

  // His clip, the shared clock, and the fade — the only three things that happen
  // to him once he exists. Nothing here reads the pitch: a catcher's idle does not
  // depend on where the ball is, and the reference drives his own the same way.
  useFrame((state, delta) => {
    if (!catcher) return
    setActorState(catcher, CATCHER_CLIP)
    catcher.mixer.update((Number.isFinite(delta) ? delta : 0) * getTimeScale())
    const distanceToCamera = camera.position.distanceTo(catcher.root.position)
    const opacity = clamp((distanceToCamera - FADE_START_M) / (FADE_END_M - FADE_START_M), 0, 1)
    for (const material of dressed ?? []) material.opacity = opacity
  })

  if (!catcher) return null
  // Not R3F's to dispose: the body is a clone of the shared asset, but the shapes
  // it draws with are the asset's own and are worn by every other body on the
  // field (see util/playerBody.js).
  return <primitive object={catcher.root} dispose={null} />
}
