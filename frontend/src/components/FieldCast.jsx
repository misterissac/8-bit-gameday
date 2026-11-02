import React, { useEffect, useMemo } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { TextureLoader } from 'three'
import { buildPlayerBody } from '../util/playerBody.js'
import { LOOK_DETAIL_MESHES } from '../util/batterLook.js'
import { PITCHER_ACTOR, ballCarrierAt, evaluateCast, facingYaw, resetFrames } from '../util/playCast.js'
import { bindClips, setActorState } from '../util/playerClips.js'
import { AWAY_HELMET_COLOUR, AWAY_PLAYER_TEXTURE_URL, HOME_PLAYER_TEXTURE_URL, blueKit, dressBody, playerFadeOpacity, uniformFor, writeBodyFade } from '../util/playerKit.js'
import { getTimeScale, setCastHandPosition } from '../constants/playback.js'
import { useTuning } from '../constants/tuning.js'

// ---------------------------------------------------------------------------
// The bodies on the field during a play: the seven fielders and however many
// runners the feed moved, drawn with the real player model instead of the
// capsule-and-ball placeholders this app used to stand at each spot.
//
// It is the reference's own design (solomon-gumball's LiveGameView builds a
// `PlayerControls` per position and animates them; components/Players.tsx is
// the class doing it), narrowed to the two halves this app does not already
// own: the pitcher is Pitcher.jsx's procedural delivery and the catcher is
// Catcher.jsx's own body on its own clip, so neither is in this pool (see
// util/playCast.js).
//
// The bodies are the *body* half of util/playerBody.js — the same clone the
// batter and pitcher wear, with the same hidden meshes, the same look pass (the
// defense wears the cap, and gets the batter's own corrected face, jersey front
// and shoes with it), the same shadows and the same per-kit uniform material — but
// not its rig driver: the batter and pitcher
// *author* a pose every frame from tuning, and these are played back from the
// asset's own baked clips (Running, SlideStop, CatchHI, AssistThrow, …) through
// an AnimationMixer, exactly as the reference drives them. Same body, two ways
// of moving it — and one size this cast chooses for itself, because the batter
// is drawn at a cartoon scale the doll's own size dwarfs (see
// CAST_BODY_HEIGHT_M below).
//
// Everything about *where* they go and *what* they are doing comes from
// util/playPlan.js's schedule through util/playCast.js's evaluateCast, so this
// component has no choreography of its own: it is the drawing half. When the
// play is not running — before the launch, and after the choreography has
// finished — every body snaps back to its own spot in its idle clip, which is
// the reset that lets the next cycle replay the same play from the top.
// ---------------------------------------------------------------------------

const PLAYER_MODEL_URL = '/models/player.glb'

// Warm the GLTF cache so the first play doesn't pop its cast in late.
useGLTF.preload(PLAYER_MODEL_URL)

// How tall the cast's bodies stand on the field, in metres — the height the
// model's own box is drawn at.
//
// The asset is a doll, not a person: its box stands 2.00 m with the cap on and
// the cleats on (see `measurePlayerRig`'s ``modelHeight``, and the pitcher's own
// note on the box against the stature its joints read), and the reference draws
// every body at that size. The pitcher is not scaled against it either — his own
// listed stature stands the rig at itself, a shade under 1.9 m (see
// `pitcherProfile`) — so a cast body left at the model's own size was the
// tallest man on the field: its box at two metres, against a batter whose helmet
// tops out at 1.54 m. The batter is drawn at BATTER_VISUAL_SCALE of his *listed*
// height (see Batter.jsx: a 6'0" batter's frame stands 1.55 m, and the body
// under it measures 1.50 m to the crown), and the two share a frame constantly —
// a fielder on the bag the batter-runner is arriving at, a runner on the base a
// man is being doubled off of. A third taller than the body beside him is the
// read the field was giving.
//
// So the cast is drawn a person's size instead: the body's own box stood at this
// height, one scale for every body in the pool (they are the same doll, and a
// fielder is not a different species from the runner a metre away). Read off the
// model rather than as a scale factor, so a re-exported asset of another size
// keeps standing the same body on the field.
const CAST_BODY_HEIGHT_M = 1.8

// One body at the cast's own size, for a scale factor of its own: the same read
// for every actor, off the box the clone really has.
const castBodyScale = (body) => CAST_BODY_HEIGHT_M / body.metrics.modelHeight

// The bodies this cast can ever need: the seven fielding spots it owns, and the
// four bodies the offense can be standing at (the batter's slot, then the three
// bags). Built once per kit-independent lifetime — a plan only decides which of
// them are on the field and what they are doing, never how many bodies exist,
// so a play costs no clones at all.
const POOL_SPOTS = [
  { key: '1B', kind: 'defense' },
  { key: '2B', kind: 'defense' },
  { key: '3B', kind: 'defense' },
  { key: 'SS', kind: 'defense' },
  { key: 'LF', kind: 'defense' },
  { key: 'CF', kind: 'defense' },
  { key: 'RF', kind: 'defense' },
  { key: 'B', kind: 'offense' },
  { key: '1B', kind: 'offense' },
  { key: '2B', kind: 'offense' },
  { key: '3B', kind: 'offense' },
]

const poolKey = (kind, key) => `${kind}:${key}`

// One body: the clone, the meshes this side does not wear hidden, and a mixer
// primed with every clip this cast can play. Dressing it (the kit's material)
// is the effect below, so a kit change never costs a clone.
function makeActor({ gltf, key, kind }) {
  const body = buildPlayerBody(gltf.scene, {
    // The defense wears the cap and hides the helmet; the offense wears the
    // helmet and hides the cap — the same two meshes the batter and the pitcher
    // each settle on, decided by *what the actor is playing*, which is the
    // reference's own `type === 'offense' | 'defense'` split.
    hide: kind === 'offense' ? ['CAP', 'GloveL', 'GloveR'] : ['Helmet'],
    // The same look pass the batter and the pitcher are put through
    // (util/batterLook.js): the eyes brought down and out onto the face under the
    // brim, the jersey's opening and its buttons, and shoes that read as shoes —
    // soles, tongues, laces. A fielder throws in the cap, which is what the pass
    // is told (the helmet's ear-flap work is the helmet's own and is skipped for
    // a cap), so a fielder, the pitcher on the mound and the man behind the plate
    // wear one body's face and one body's shoes. A runner is *not*: he wears the
    // helmet and the batter's own look, and this cast does not own that body's
    // helmet work.
    look: kind === 'defense' ? { headgear: 'cap' } : null,
  })
  const model = body.model
  // A person's size, not the doll's (see CAST_BODY_HEIGHT_M): the scale sits on
  // the model rather than on the group the schedule positions, so a root's own
  // transform stays the placement it is (the body's feet at x,z, yawed at its
  // look target) and a probe reading one actor's transform reads metres.
  model.scale.setScalar(castBodyScale(body))
  const get = (name) => model.getObjectByName(name)
  if (kind === 'defense') {
    // A fielder wears the glove on his left hand and throws with his bare
    // right, which is the hand the ball leaves from (the reference's
    // `setGloveHand('R')`).
    const gloveR = get('GloveR')
    const handL = get('HandL')
    if (gloveR) gloveR.visible = false
    if (handL) handL.visible = false
  }

  // The body group the schedule positions. The model goes straight into it: the
  // asset's own frame faces +Z (see util/batterLook.js, which paints the face),
  // which is the frame `facingYaw` aims at a look target, so the yaw the frame
  // loop writes onto this group is a yaw the body is actually facing. The batter
  // and the pitcher each turn their body the half turn *their* frames need (both
  // are authored facing -Z); these are not authored at all — they play clips.
  const root = new THREE.Group()
  // Named so the body is findable in the scene graph by whoever is looking at
  // it — a test harness, or a debugger reading one actor's own transform.
  root.name = `cast:${kind}:${key}`
  // Born hidden: the mount and the first frame loop are not the same commit, so
  // a body that started visible would stand at the origin for one frame — all
  // eleven of them stacked on home plate — before the schedule moved it where it
  // belongs (seen live: scripts/probe-cast.mjs reports it as eleven bodies at
  // 0,0 on the frame the pool appears).
  root.visible = false
  root.add(model)

  const mixer = new THREE.AnimationMixer(model)
  const actions = bindClips(mixer, gltf.animations)
  return {
    key,
    kind,
    root,
    model,
    mixer,
    actions,
    state: null,
    // The materials this body is dressed in (the dress pass fills it) and the
    // opacity they are last known to hold, so the distance fade below only writes
    // a material it really has to move.
    materials: [],
    fade: null,
    // The *bone* the ball rides while this body holds it: the throwing hand for
    // a fielder (the reference attaches the ball to the right palm socket), and
    // nothing for a runner, who never has it.
    //
    // A bone, not the `HandR` mesh: a skinned mesh's own node never moves — the
    // skin deforms its vertices, and its transform stays at the bind pose, which
    // on this asset sits at the body's root. Reading the mesh put the ball on
    // the ground at the fielder's feet through the whole wind-up (measured live,
    // see scripts/probe-cast.mjs); the bone's own world position is the hand.
    //
    // The reference's own socket is the right palm handle, and its name arrives
    // sanitised — three strips the dot out of `palm_handle.R`, the way it does
    // for every bone this app names (`handL`, `upper_armR`; see ARM_BONES).
    ballHand: kind === 'defense'
      ? (get('palm_handleR') ?? get('palm_handle.R') ?? get('handR') ?? get('hand.R') ?? null)
      : null,
  }
}

// The state changes and the clip binding are shared with the batter's own body
// once it is the batter-runner, so the two ways of playing a clip cannot drift
// apart — see util/playerClips.js.

// Scratch for the hand read (a frame loop allocating a Vector3 per frame is a
// frame loop the GC gets to run during a play).
const CARRIER_WORLD = new THREE.Vector3()

export const FieldCast = ({ plan, clockRef, playingRef, defenseKit = 'home', hidden = false }) => {
  const gltf = useGLTF(PLAYER_MODEL_URL)
  const homeTexture = useLoader(TextureLoader, HOME_PLAYER_TEXTURE_URL)
  // The visitors' kit is the same atlas with its team colour turned blue (see
  // util/playerKit.js's `blueKit`): one club in red, the other in blue, rather
  // than two dark reds.
  const awayTexture = blueKit(useLoader(TextureLoader, AWAY_PLAYER_TEXTURE_URL))
  const camera = useThree((s) => s.camera)
  const tuning = useTuning()

  const actors = useMemo(() => {
    if (!gltf?.scene) return []
    return POOL_SPOTS.map((spot) => makeActor({ gltf, key: spot.key, kind: spot.kind }))
  }, [gltf])

  // The lineup a plan asks for is a subset of the pool (built once); `reset` is
  // the alignment every body of that lineup returns to when the play is not
  // running — before the launch and after the choreography, which is the reset
  // the next cycle replays from.
  const reset = useMemo(() => resetFrames(plan), [plan])

  // Dress the pool: the fielding side in the pitcher's own kit (they are the
  // same team), the offense in the other one. A kit change — the inning turning
  // over — swaps materials on bodies that are already built.
  //
  // Each body gets a material of its *own*, rather than the whole side sharing
  // one: every body here fades on its own distance to the camera (see the frame
  // loop), and a body that is faded must not be sharing a material with one that
  // is not (util/playerKit.js's own note on exactly that).
  useEffect(() => {
    if (actors.length === 0) return
    const teamTexture = defenseKit === 'home' ? homeTexture : awayTexture
    const battingTexture = defenseKit === 'home' ? awayTexture : homeTexture
    // The club at the plate — the one the runners wear — is the other side, and
    // its helmet is the flat colour the atlas cannot paint (util/playerKit.js).
    const battingHelmet = defenseKit === 'home' ? AWAY_HELMET_COLOUR : null
    for (const actor of actors) {
      const offense = actor.kind === 'offense'
      // The whole dress pass — the kit over the body, and the glove's leather
      // and the helmet's own flat colour left in their own materials — is the
      // shared one the catcher is dressed with too (util/playerKit.js), so a
      // fielder and the man behind the plate cannot end up two different colours
      // of the same team.
      actor.materials = dressBody(
        actor.model,
        uniformFor(offense ? battingTexture : teamTexture),
        // The look pass's own hung-beside-the-body pieces keep the tones they were
        // read out of the body: everything else it adds is welded into the body's
        // surface and is drawn by the kit like any other part of it.
        { keep: LOOK_DETAIL_MESHES, helmetColour: offense ? battingHelmet : null },
      )
      // Born whole: the frame loop settles each body onto the distance it is
      // really at on its very next pass.
      actor.fade = 1
      writeBodyFade(actor.materials, 1)
    }
  }, [actors, homeTexture, awayTexture, defenseKit])

  // Re-evaluate the whole cast every frame off the play's own clock. The
  // schedule is absolute in play seconds, so this reads like the reference's
  // promise chain — without the promises.
  useFrame((state, delta) => {
    if (actors.length === 0) return
    const t = clockRef?.current ?? 0
    const playing = !!playingRef?.current
    const fadeNear = tuning.camera.playerFadeNear
    const fadeFar = tuning.camera.playerFadeFar
    const dt = (Number.isFinite(delta) ? delta : 0) * getTimeScale()
    const at = new Map()
    if (playing && plan?.cast) for (const frame of evaluateCast(plan, t)) at.set(poolKey(frame.kind, frame.key), frame)

    const carrier = playing ? ballCarrierAt(plan, t) : null
    let carrierHand = null

    for (const actor of actors) {
      const id = poolKey(actor.kind, actor.key)
      // While the play runs, the schedule drives the body; when it is not
      // running, the reset alignment does — the same spot, the same idle clip,
      // whatever the body was doing a moment ago. A body this plan never uses
      // has neither and stays parked (and invisible).
      const frame = playing ? at.get(id) : reset.get(id)
      actor.root.visible = !hidden && !!frame
      // How much of this body is drawn, off its own distance to the camera — the
      // body the camera is standing inside is the one that goes, and nobody else
      // (see playerKit's playerFadeOpacity). Written only on a real move: a
      // material's `transparent`/`depthWrite` are shader state, and rewriting them
      // every frame for eleven bodies is work the renderer does not need.
      const fade = playerFadeOpacity(actor.root.position.distanceTo(camera.position), fadeNear, fadeFar)
      if (actor.fade == null || Math.abs(fade - actor.fade) > 0.01) {
        actor.fade = fade
        writeBodyFade(actor.materials, fade)
      }
      if (hidden || !frame) {
        actor.mixer.update(dt)
        continue
      }
      actor.root.position.set(frame.position.x, 0, frame.position.z)
      actor.root.rotation.y = facingYaw(actor.root.position, frame.lookTarget) ?? 0
      setActorState(actor, frame.state)
      actor.mixer.update(dt)
      // The ball is in this fielder's glove from the moment he gloved it until
      // the throw leaves his hand: hand the ball's own renderer the hand it
      // should be riding.
      if (carrier != null && carrier === actor.key && actor.ballHand) {
        // The mixer has just posed this frame's bones and the body has just been
        // moved, so the hand's *world* matrix is still last frame's — three only
        // refreshes matrices at render. Without this the ball trails the hand by
        // a frame, which shows on a fast throw; the carrier is the only body
        // that needs its subtree walked.
        actor.root.updateMatrixWorld(true)
        actor.ballHand.getWorldPosition(CARRIER_WORLD)
        carrierHand = CARRIER_WORLD
      }
    }
    // Written by whichever component draws the body that has the ball — the one
    // carrier this cast does not draw is the pitcher's, and his own component
    // publishes for him (Pitcher.jsx), so this must not clear what it published.
    // Every other answer is this cast's: a fielder's own hand, and the empty one for
    // a ball nobody here is holding (in the air, thrown, or charged to a spot
    // neither component draws — the catcher's).
    if (carrier !== PITCHER_ACTOR) {
      setCastHandPosition(carrierHand ? { x: carrierHand.x, y: carrierHand.y, z: carrierHand.z } : null)
    }
  })

  // Every body is this actor's own; stop its clips when the cast is rebuilt so a
  // hot-reload or an unmount doesn't leave eleven mixers running off-screen.
  useEffect(() => () => {
    for (const actor of actors) actor.mixer.stopAllAction()
    setCastHandPosition(null)
  }, [actors])

  return (
    <group>
      {actors.map((actor) => (
        <primitive key={poolKey(actor.kind, actor.key)} object={actor.root} />
      ))}
    </group>
  )
}
