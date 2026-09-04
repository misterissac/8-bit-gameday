import React, { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getCycleDuration, getTimeScale, getBattedBallPosition, getBallReleaseTime, stepSimulation } from '../constants/playback'
import { FIELD } from '../constants/field'
import { PLATE_FRONT_Y, clamp, plateCrossing } from '../util/MathUtil'
import { BATTER_LEAN_ORDER, batterLean } from '../util/batterLean'
import {
  resolvePitchSpeedMph,
  resolveSwingPeak,
  calculateSwingGeometry,
  computeBatTiltAtProgress,
  HIP_Y,
} from '../util/batterSwing'
import { useTuning } from '../constants/tuning'

// ---------------------------------------------------------------------------
// Batter sprite at home plate. The batter's side of the plate comes from the
// live feed's ``matchup.batSide`` (L/R), and the swing is driven by the pitch
// event's call code (``pitchData.swing``) timed to the moment the ball reaches
// the plate.
//
// The set stance mirrors a real batting stance: the hands load at the back
// shoulder (the left shoulder for a lefty, the right for a righty — the batter
// faces the pitcher, so left = -X and right = +X) with the bat cocked up over
// the shoulder, the knees are bent (each leg is a thigh + shin), and the arms
// are two segments. During the swing the upper body opens toward the pitcher,
// the hands arc forward *around* the body to the contact point (so the bat
// never passes through the torso) while the bat drops from the cocked position
// into the zone, and the sweet spot (not the handle) meets the ball.
// ---------------------------------------------------------------------------

// Camera-direction + distance translucency, mirroring the catcher's fade
// (solomon-gumball's clamp((distance - 3) / 8, 0, 1) ramp). Unlike the
// catcher, the batter only fades when the camera is BEHIND it and close — e.g.
// the "Snap to Strike Zone" view, where the batter sits between the camera and
// the plate and would block the zone. From the front (pitcher side) the batter
// never fades, so the at-bat stays visible. The fade never goes fully
// transparent: at minimum the batter stays translucent (settings.fadeMinOpacity) so
// it reads as a ghost outline instead of disappearing.

// Swing timing: the bat starts settings.swingLead seconds before the ball crosses the
// plate, reaches the contact angle exactly when the ball arrives, follows
// through for settings.followThrough seconds after, then eases back to the loaded
// stance over settings.recoveryTime while the batted ball is in flight. Before the
// swing, the batter loads the weight onto the back leg over settings.loadTime seconds
// (ending exactly where the swing begins), so the swing fires out of a loaded
// crouch instead of from a static stance.

// Bat rotation (radians around the vertical axis). At 0 the barrel points at
// the pitcher; at +/-PI it points back at the catcher. The handedness sign
// mirrors lefties vs righties: the base angles are negated for a lefty.

// The bat is cocked up over the back shoulder in the set stance, and drops to
// level by the time it reaches the contact point (radians of X tilt).

// How much the upper body (torso, shoulders, arms, bat) opens toward the
// pitcher through the swing, like the reference's SwingMid animation. Sized so
// the chest opens most of the way toward the pitcher by contact — the whole
// swing, not just the head, opens toward the ball (the follow-through then
// completes the turn to settings.fullOpenYaw). The sign mirrors handedness so the
// body turns with the swing (see bodyOpen below).

// After contact the body keeps opening through the follow-through until the
// chest fully faces the pitcher (settings.fullOpenYaw = 0, straight down the line),
// then unwinds back to the set stance during the recovery.

// The set stance faces a point on the home-plate -> catcher segment biased
// toward home plate, so the body angles in toward the pitch (a slightly open
// stance) instead of facing the catcher side. The direction is computed
// per-stance in the component: the body yaw that points the chest (local -Z)
// at that target from the batter's world position (batX, stanceZ).
//
// settings.setFaceBias is the fraction of the way from home plate (z=0) to the
// catcher (z=C.z): 0.5 faces the old plate->catcher midpoint, and lower
// values turn the body and legs toward home plate (0 would face it directly).

// The lower body (hips/legs) rotates with the swing, opening nearly as far as
// the shoulders so the legs visibly turn with the body (a real swing keeps the
// hips just short of the shoulders' rotation — the separation that reads as
// the hips driving the turn).

// The hips fire well ahead of the shoulders (the kinetic chain of a real
// swing): the lower body's opening progress is phase-advanced by this factor,
// so the legs start turning and the back leg starts driving while the upper
// body is still barely moving — the hips are most of the way open before the
// torso is halfway — reading unmistakably as the legs driving the swing. The
// same factor phase-advances the follow-through: after contact the hips keep
// rotating and finish their continued turn while the torso is still unwinding
// into the fully-open pose, so the legs drive through contact too. The clamp
// makes the hips reach their full (lesser) open angle early, hold it, and
// settle back after the shoulders on recovery.
// The upper body's turn leads the hands/bat by this factor during the pre-
// contact window, so the chest opens before the barrel arrives — part of the
// same kinetic chain as settings.hipsLead (legs -> torso -> hands).

// Head tilt range while tracking the batted ball (radians): how far the head
// can nod down toward a grounder or tilt up toward a fly ball. The contact
// look uses the smaller settings.headTiltMax; the live ball can be far above the
// batter (pop-ups) so the up range is wider.

// Leg drive: as the swing fires the BACK leg — the side away from the
// pitcher (the right leg for a righty) — unbends and drives the entire
// swing: it straightens from the crouch and pushes toward the plate as the
// hips turn, while the front leg stays bent to brace the rotation. Before
// the swing, a brief load phase shifts the weight onto the back leg — the
// hips settle lower (settings.hipSettle) and the back knee crouches deeper —
// while the front leg strides toward the pitcher and plants through the
// swing. The upper body mirrors the weight transfer: it stands straight
// in the set stance, leans forward toward home plate as the pitch arrives
// (settings.setLean), settles back onto the back leg during the load
// (settings.loadLeanBack), then holds a stronger forward lean toward the plate
// through the entire swing (settings.legLean) as the back leg drives. During the
// recovery the back leg eases back to the crouch later than the front leg
// (settings.backRecoverLag).
// Footwork through the swing: the swing pivots around the BACK foot, which
// stays planted in world space (counter-rotated against the hips' opening and
// compensating for hip drive) while pivoting toward the pitcher
// (settings.backFootPivot); the front foot unplants as the drive fires —
// lifting and turning with the body (its pre-swing plant keeps only a small
// settings.frontFootPivot).
// Hip drive: as the back leg unbuckles, the hips (lower body) drive forward
// toward the pitcher (settings.hipDriveForward) and the torso, head, arms, and
// bat ride forward with them (settings.upperDriveForward), so the entire body
// moves into the baseball through the swing. A small residual tilt back
// toward the catcher (settings.swingBackTilt) keeps a hint of the "staying
// back" posture without dragging the head backward.
// The whole-body forward push is ONE continuous accelerating motion from
// the start of the delayed front step through the swing: a quadratic ramp
// during the stride (velocity builds from zero — the body edges
// settings.strideEdgeFrac of the way by the time the foot plants), handing
// off at that same speed into a swing phase that keeps accelerating to a
// peak placed at settings.swingPeakFrac through the phase (higher pushes
// the maximal surge closer to contact) and decelerates smoothly to zero by
// the settle start; the smoothstep settle-back then eases 1 down to
// settings.pushSettleLevel at contact. The return is likewise ONE
// continuous motion: the body rides gently INTO the finish (cresting just
// after the bat's follow-through) and flows back to the stance in a single
// accelerating-then-decelerating arc — never a frozen hold followed by a
// separate ease-out stage. Every handoff is position- and
// velocity-continuous, so the whole cycle reads as one smooth accelerating
// flow into the ball and one smooth return to the stance. Taking a pitch
// gets just the stride edge: the batter strides into the pitch, holds the
// edge through the crossing, and eases back once the ball passes (the
// front foot unplants to follow).

// The sprite's top-of-head height (meters) at scale 1, and the nominal stance
// offsets for that reference sprite. Both are scaled by the same ratio so the
// silhouette (height, body width, shoulders, bat) stays proportional.
const SPRITE_NOMINAL_HEIGHT_M = 1.96
const NOMINAL_STANCE_X_M = 0.65
const NOMINAL_STANCE_Z_M = 0.75

// The cartoon sprite reads much larger than real-world scale, so a literal
// 1.8 m batter towers over the ~0.96 m strike-zone top. Scale every dimension
// down by this factor (while preserving the API-driven height ordering) so the
// batter sits naturally against the zone.
const BATTER_VISUAL_SCALE = 0.85

// Contact geometry (all in the height-scaled local frame, where the body
// centerline is x=0 and the front of the torso is at z=BODY_FRONT_Z).
const BODY_FRONT_Z = -0.28
const SHOULDER_X = 0.22
const SHOULDER_Y = 1.5

// The upper body pivots at the hip joint (the top of the legs) rather than
// at the feet, so the torso stays attached to the hips while it leans,
// tilts, and swivels through the swing (HIP_Y).

// How far each elbow rides the bat's barrel line behind the hands during the
// swing (so the bat swings WITH the forearms as one unit), and how far the two
// elbows spread apart along it.
const FOREARM_LEN = 0.4
const ELBOW_SPREAD = 0.1

// The two hands do not grip the exact same spot: the pitcher-facing (front)
// arm grips up the barrel — the "front of the bat" — while the other arm
// grips at the handle/knob — the "back of the bat" — separated by this much
// along the barrel line (the reverse of the usual bottom-hand/top-hand grip).
const GRIP_SPLIT = 0.09

// The hands at contact reach settings.handExtension of the way from the front of the
// torso toward the ball, so the arms extend naturally and the sweet spot (the
// remaining distance to the ball) lands on the barrel.

// The sweet spot sits this fraction of the bat's length from the handle (near
// the barrel end, like a real bat). The bat length is derived so the sweet
// spot lands exactly on the ball; it is clamped to keep the bat a sane size.
const SWEET_SPOT_FRACTION = 0.78
const BAT_LENGTH_MIN = 0.85
const BAT_LENGTH_MAX = 1.18

// Bat-tracking tilt clamps (degrees). The attack angle sets the barrel's
// direction at the exact moment of contact (MLB seasonal range ~0-20°, ideal
// 5-20°), while swing_path_tilt shapes the swing plane the barrel rides on the
// way in (MLB seasonal range ~20-50°). Both are clamped so the cartoon swing
// stays readable; the hands are lowered by the same amount the rising barrel
// gains, keeping the sweet spot on the ball.

// Hands in the set stance: out to the side at the back shoulder (the batter
// faces the pitcher, so the left shoulder is -X and the right is +X), at chest
// height. The hands sit slightly in front of the chest center so the
// cross-body (front) arm's forearm can ride around the front of the torso
// instead of passing through it when it reaches across to the load grip.
// The per-side sign is applied in the component.
const LOADED_HANDS_X = 0.35
const LOADED_HANDS_Y = 1.35
const LOADED_HANDS_Z = -0.15

// How far forward the hands path bulges (toward the pitcher) as it arcs from
// the loaded stance to the contact point, so the bat and arms clear the torso.

// Slow idle bob of the loaded stance: the upper body rises and falls gently so
// the batter looks alive between pitches. Driven by real elapsed time (not the
// looping playback clock) so it never jumps when the pitch loop resets, and it
// fades out as the swing takes over.

// The head faces the pitcher during the set (so the brim points down the
// pitch), then tracks the ball through the swing: it tilts forward toward the
// plate and swivels to face the contact point (the ball at home plate). The
// face is the head's local -Z (the brim sits on that side), so the yaws are
// computed from the head->pitcher / head->contact offsets expressed in the
// upper body's own rotated frame; HEAD_YAW_MAX just keeps the contact turn
// from looking cranked fully sideways.
const HEAD_YAW_MAX = 0.8

function easeSwing(t) {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x) // smoothstep
}

// Wrap-aware angular lerp: takes the shortest rotation between two yaws, so a
// blend never spins the head the long way around through +/-PI (which reads
// as the head popping off its neck).
function lerpAngle(a, b, t) {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t
}

// Quadratic Bezier used for the hands path from the loaded stance to contact.
function bezier2(p0, p1, p2, t) {
  const u = 1 - t
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    u * u * p0[2] + 2 * u * t * p1[2] + t * t * p2[2],
  ]
}

// Component-wise lerp between two [x, y, z] arrays.
function lerpV3(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

// Orient a unit-height cylinder mesh so it spans from point ``a`` to point
// ``b`` (in the parent's local frame). Used each frame to draw the arms, whose
// endpoints move as the hands travel from the loaded stance to contact.
const UP = new THREE.Vector3(0, 1, 0)
function setCylinderBetween(mesh, a, b) {
  if (!mesh) return
  const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  const length = dir.length()
  if (length < 1e-4) {
    mesh.visible = false
    return
  }
  mesh.visible = true
  mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize())
  mesh.scale.set(1, length, 1)
}

export const Batter = ({ pitchData, replayKey = 0 }) => {
  const settings = useTuning().batter
  const upperRef = useRef()
  const lowerRef = useRef()
  const batGroupRef = useRef()
  const cockRef = useRef()
  const tiltRef = useRef()
  const leftUpperRef = useRef()
  const leftForeRef = useRef()
  const rightUpperRef = useRef()
  const rightForeRef = useRef()
  const headRef = useRef()
  const thighLRef = useRef()
  const shinLRef = useRef()
  const thighRRef = useRef()
  const shinRRef = useRef()
  const shoeLRef = useRef()
  const shoeRRef = useRef()
  const groupRef = useRef()
  const camera = useThree((s) => s.camera)

  // Shared materials (one per color) so a single per-frame opacity update fades
  // the whole batter together, the same pattern the catcher uses. depthWrite is
  // disabled only while fading so the strike-zone overlays show through the
  // batter; at full opacity the batter renders opaque with normal depth.
  const pantsMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#e2e8f0', roughness: 0.8 }), [])
  const shoesMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.9 }), [])
  const jerseyMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#2b6cb0', roughness: 0.8 }), [])
  const markerMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7 }), [])
  const skinMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#f1c27d', roughness: 0.8 }), [])
  const helmetMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1a365d', roughness: 0.7 }), [])
  const brimMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#16294d', roughness: 0.7 }), [])
  const batMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#c48a5c', roughness: 0.6 }), [])
  const knobMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8b5a2b', roughness: 0.7 }), [])

  // Fade the batter when the camera is behind it (catcher side, +Z) and close
  // enough to block the strike zone; never fade when viewed from the front.
  // Same distance ramp as the catcher, but the opacity floors at
  // settings.fadeMinOpacity so the batter stays translucent instead of vanishing.
  useFrame(() => {
    const group = groupRef.current
    if (!group) return
    const behind = camera.position.z > group.position.z
    const distanceToCamera = camera.position.distanceTo(group.position)
    const fade = clamp((distanceToCamera - settings.fadeStartDistance) / (settings.fadeEndDistance - settings.fadeStartDistance), 0, 1)
    const opacity = behind
      ? settings.fadeMinOpacity + (1 - settings.fadeMinOpacity) * fade
      : 1
    for (const mat of [pantsMat, shoesMat, jerseyMat, markerMat, skinMat, helmetMat, brimMat, batMat, knobMat]) {
      mat.opacity = opacity
      mat.transparent = opacity < 1
      mat.depthWrite = opacity >= 1
    }
  })
  // 0..1 strength of the head's lock onto the batted ball: ramps in at
  // contact and eases back out after the ball lands, so the head tracks the
  // flight but never snaps back to the stance look. ``lastBallLook`` holds
  // the last tracked direction while the lock fades out.
  const trackRef = useRef(0)
  const lastBallLook = useRef(null)

  const batSide = pitchData?.bat_side || 'R'
  const swing = !!pitchData?.swing
  const sign = batSide === 'L' ? -1 : 1

  // Scale the sprite from the batter's listed height (e.g. 5'11" = 1.80m),
  // then apply the cartoon visual scale-down. Falls back to a neutral size
  // when the feed omits the height. The same ratio scales body width, shoulder
  // radius, head, and bat (uniformly) plus the stance offsets below.
  const heightM = pitchData?.batter_height != null
    ? pitchData.batter_height * 0.0254
    : null
  const heightScale = (heightM != null ? heightM / SPRITE_NOMINAL_HEIGHT_M : 1) * BATTER_VISUAL_SCALE

  const stanceX = NOMINAL_STANCE_X_M * heightScale
  const stanceZ = NOMINAL_STANCE_Z_M * heightScale

  // Left-handed batters stand on the first-base side (+X); right-handed
  // batters stand on the third-base side (-X). Behind home plate toward the
  // catcher is +Z.
  const batX = batSide === 'L' ? stanceX : -stanceX

  // Hands in the set stance, at the back shoulder: the batter faces the
  // pitcher (-Z), so their left side is -X and their right side is +X. A lefty
  // loads the bat over the left shoulder (-X), a righty over the right (+X).
  const loadedHands = useMemo(
    () => [sign * LOADED_HANDS_X, LOADED_HANDS_Y, LOADED_HANDS_Z],
    [sign],
  )

  // The upper body opens toward the pitcher through the swing, rotating with
  // the handedness (a righty opens counter-clockwise from above, a lefty
  // clockwise — each unwinding across the plate from the set stance into the
  // pitch). The sign is negated from `sign` so the chest turns toward the
  // ball/plate (a lefty's chest swings to their left, a righty's to their
  // right); the head's extra yaw then rides on the body's turn to keep the
  // eyes on the ball instead of fighting it.
  const bodyOpen = -sign * settings.bodyOpenMax
  // Set stance: the body and legs face the spot between home plate and the
  // catcher — the midpoint of the plate -> catcher segment — rather than
  // turning a full half-turn to face the catcher directly. Standing off to one
  // side of the plate that direction is a diagonal (a righty's chest angles
  // toward first base, a lefty's toward third), and the swing rotates the body
  // from this pose around to the open contact pose facing the pitcher —
  // clockwise for a lefty, counter-clockwise for a righty — so the torso
  // unwinds across the plate into the pitch.
  const setFaceTargetZ = FIELD.DEFENSE.C.z * settings.setFaceBias
  const setYaw = Math.atan2(batX, stanceZ - setFaceTargetZ)

  // During the set the head turns to face the pitcher: the head's face is its
  // local -Z, so the yaw that points it at the pitcher (a tiny horizontal
  // offset off straight-down-the-line because the batter stands to one side)
  // is that direction expressed in the upper body's rotated frame. Through
  // the swing it eases from this look to tracking the ball at contact.
  const headPitcherYaw = Math.atan2(batX, stanceZ - FIELD.DEFENSE.P.z) - setYaw


  // All swing geometry derived from the trajectory: the contact point, the
  // hands-at-contact position, the barrel's contact angle, and the bat length
  // that puts the sweet spot on the ball.
  const geom = useMemo(() => {
    return calculateSwingGeometry({
      pitchData,
      batX,
      stanceZ,
      heightScale,
      sign,
      bodyOpen,
      loadedHands,
      settings,
      catcherZ: FIELD.DEFENSE.C.z,
    })
  }, [pitchData, heightScale, batX, stanceZ, sign, loadedHands, bodyOpen, settings])

  const arms = [
    { side: -1, upperRef: leftUpperRef, foreRef: leftForeRef },
    { side: 1, upperRef: rightUpperRef, foreRef: rightForeRef },
  ]

  // Draw the arms: upper arm shoulder->elbow, forearm elbow->hands. ``bend``
  // goes 1 (loaded, elbows out) to 0 (contact, arms straight). During the
  // swing (``align`` ramping to 1) the forearms rotate around the hands to
  // ride the bat's barrel line — so the bat swings WITH the forearms as one
  // unit instead of pivoting around the wrist — easing back through the
  // follow-through.
  const updateArms = (hands, bend, align = 0, batAngle = sign * settings.loadedBaseAngle, cockAngle = settings.cockAngle, tiltAngle = 0) => {
    // The bat mesh points along local -Z, raised by the cock/tilt X rotations
    // and yawed by batAngle, so the handle->barrel direction is:
    const phi = cockAngle + tiltAngle
    const barrel = new THREE.Vector3(
      -Math.cos(phi) * Math.sin(batAngle),
      Math.sin(phi),
      -Math.cos(phi) * Math.cos(batAngle),
    ).normalize()
    // Horizontal direction perpendicular to the barrel's ground projection,
    // used to keep the two forearms apart as they ride the bat line.
    const perp = [-barrel.z, 0, barrel.x]
    for (const { side, upperRef, foreRef } of arms) {
      const shoulder = [side * SHOULDER_X, SHOULDER_Y, 0]
      // The pitcher-facing (front) arm grips up the barrel — the front of the
      // bat — while the other arm grips at the handle/knob (the back of the
      // bat), so the two hands are separated along the barrel line.
      const isFrontArm = side === -sign
      const grip = isFrontArm
        ? [
            hands[0] + GRIP_SPLIT * barrel.x,
            hands[1] + GRIP_SPLIT * barrel.y,
            hands[2] + GRIP_SPLIT * barrel.z,
          ]
        : hands
      const mid = [
        (shoulder[0] + grip[0]) / 2,
        (shoulder[1] + grip[1]) / 2,
        (shoulder[2] + grip[2]) / 2,
      ]
      // Natural pose: elbows flared out at load, straightening by contact.
      // The cross-body (front) arm flares wider and further forward so its
      // forearm sweeps around the front of the torso while the hands are
      // loaded at the shoulder, instead of tunneling through the chest.
      const flare = isFrontArm ? 0.3 : 0.2
      const forward = isFrontArm ? 0.26 : 0.12
      const elbow = [
        mid[0] + side * flare * bend,
        mid[1] - 0.13 * bend,
        mid[2] - forward * bend,
      ]
      // Rotate the forearm direction from its natural one toward the barrel
      // (around the hands), and shorten it toward FOREARM_LEN, so the forearm
      // lines up with the bat as the swing comes through.
      const foreVec = new THREE.Vector3(grip[0] - elbow[0], grip[1] - elbow[1], grip[2] - elbow[2])
      const natLen = foreVec.length()
      let finalElbow = elbow
      if (natLen > 1e-4) {
        const natDir = foreVec.normalize()
        const swing = new THREE.Quaternion().setFromUnitVectors(natDir, barrel)
        const partial = new THREE.Quaternion().slerp(swing, align)
        const dir = natDir.clone().applyQuaternion(partial)
        const len = natLen + (FOREARM_LEN - natLen) * align
        finalElbow = [
          grip[0] - len * dir.x + side * ELBOW_SPREAD * align * perp[0],
          grip[1] - len * dir.y,
          grip[2] - len * dir.z + side * ELBOW_SPREAD * align * perp[2],
        ]
      }
      setCylinderBetween(upperRef.current, shoulder, finalElbow)
      setCylinderBetween(foreRef.current, finalElbow, grip)
    }
  }

  // Pose the legs for the given drives (0 = loaded crouch, 1 = full push),
  // the pre-swing weight shift ``load``, and the late-windup front stride:
  // ``stride`` (0..1) advances the front foot toward the pitcher in step with
  // the tail of the pitcher's windup and ``strideLift`` (0..1) is the transient
  // foot/knee lift that peaks mid-step so the foot plants just as the swing
  // fires.
  // During the load the back leg crouches deeper and the hips settle lower to
  // take the weight; on the drive the back leg (the side away from the
  // pitcher — the right leg for a righty, `sign`) unbends and pushes, driving
  // the entire swing, while the front leg stays bent to brace the rotation.
  // The back leg eases back to the crouch later than the front leg (driveBack
  // lags through the recovery).
  const poseLegs = (drive, driveBack, load, stride, strideLift, lowerYaw, hipDrive) => {
    for (const [side, thigh, shin, shoe] of [
      [-1, thighLRef, shinLRef, shoeLRef],
      [1, thighRRef, shinRRef, shoeRRef],
    ]) {
      const isBack = side === sign
      const d = isBack ? driveBack : drive
      const backCrouch = isBack ? settings.legBackLoadDrop * load : 0
      // The front stride heads toward the pitcher (world -Z), expressed in
      // the lower body's set frame — the local direction of world -Z is
      // (sin(setYaw), -cos(setYaw)).
      const strideAmt = isBack ? 0 : settings.legFrontStride * stride
      const strideX = strideAmt * Math.sin(setYaw)
      const strideZ = -strideAmt * Math.cos(setYaw)
      // The hips settle lower during the load, rising back as the drive
      // engages (the upper body drops by the same amount in the frame loop).
      const hipSettle = settings.hipSettle * load * (1 - d)
      const kneeY = 0.38
        + (isBack ? settings.legBackKneeRise : settings.legFrontKneeRise) * d
        - backCrouch
        + (isBack ? 0 : settings.legFrontKneeLift * strideLift * (1 - d))
      const kneeX = side * 0.14 + strideX * 0.5
      const kneeZ = -0.13
        - (isBack ? settings.legBackKneeForward : settings.legFrontKneeForward) * d
        - strideZ * 0.5
      const ankleX = side * 0.14 + strideX
      const ankleZ = -0.05
        - (isBack ? settings.legBackPushForward : settings.legFrontPushForward) * d
        - strideZ
      const hip = [side * 0.14, 0.72 - hipSettle, 0]
      const knee = [kneeX, kneeY, kneeZ]
      // The front foot lifts clearly while striding (windup), then plants as
      // the stride completes; it unplants again briefly as the swing fires.
      let ankleLift = isBack ? 0 : settings.legFrontStrideLift * strideLift
      // Footwork through the swing: the swing pivots around the BACK foot,
      // which stays planted — its ankle/shoe are counter-rotated against the
      // hips' opening (R(-openAngle) around the hips) so it holds its spot,
      // pivoting toward the pitcher as the hips open. The front foot unplants
      // as the drive fires, lifting and turning with the body instead of
      // staying glued to the ground.
      const openAngle = lowerYaw - setYaw
      const cosA = Math.cos(openAngle)
      const sinA = Math.sin(openAngle)
      const plantedX = ankleX * cosA - ankleZ * sinA
      const plantedZ = ankleX * sinA + ankleZ * cosA
      let footX
      let footZ
      let shoeYaw
      if (isBack) {
        // Back foot: the planted pivot — counter-rotated to hold its spot,
        // plus compensation for the hips' forward drive so it stays planted
        // in world space while the hips translate toward the pitcher.
        footX = plantedX - hipDrive * Math.sin(lowerYaw)
        footZ = plantedZ + hipDrive * Math.cos(lowerYaw)
        shoeYaw = -(1 - settings.backFootPivot) * openAngle
      } else {
        // Front foot: unplants with the drive and turns with the body.
        footX = THREE.MathUtils.lerp(plantedX, ankleX, drive)
        footZ = THREE.MathUtils.lerp(plantedZ, ankleZ, drive)
        shoeYaw = THREE.MathUtils.lerp(-(1 - settings.frontFootPivot) * openAngle, 0, drive)
        ankleLift += settings.legFrontUnplantLift * drive
      }
      const ankle = [footX, 0.05 + ankleLift, footZ]
      setCylinderBetween(thigh.current, hip, knee)
      setCylinderBetween(shin.current, knee, ankle)
      if (shoe.current) {
        shoe.current.position.set(footX, 0.03 + ankleLift, footZ)
        shoe.current.rotation.y = shoeYaw
      }
    }
  }

  // Restart the playback clock whenever a new pitch arrives, keeping the swing
  // Reset tracking and look state whenever a new pitch arrives or replay fires.
  useLayoutEffect(() => {
    trackRef.current = 0
    lastBallLook.current = null
  }, [pitchData, replayKey])

  useFrame((state, delta) => {
    const { time: currentSimTime } = stepSimulation(delta, state.clock.elapsedTime)
    const traj = pitchData?.trajectory
    const simDuration = traj?.[traj.length - 1]?.t

    if (!(simDuration > 0) || !batGroupRef.current) {
      // No usable trajectory: hold the set stance with the idle bob.
      const swayPhase = state.clock.elapsedTime * settings.swaySpeed
      const bob = Math.sin(swayPhase) * settings.swayBobAmount
      if (lowerRef.current) {
        lowerRef.current.rotation.y = setYaw
        lowerRef.current.position.z = 0
      }
      if (upperRef.current) {
        // YXZ order: yaw first, then the lean's forward/sideways tilts, so the
        // lean direction (rotation.x/z) stays in the body's own frame.
        upperRef.current.rotation.order = BATTER_LEAN_ORDER
        upperRef.current.rotation.y = setYaw
        // Straight in the set stance: the forward lean only comes in as the
        // pitch is thrown.
        upperRef.current.rotation.z = 0
        upperRef.current.rotation.x = 0
        upperRef.current.position.z = 0
        upperRef.current.position.y = HIP_Y + bob
      }
      if (headRef.current) {
        headRef.current.rotation.x = 0
        headRef.current.rotation.y = headPitcherYaw
      }
      trackRef.current = 0
      lastBallLook.current = null
      poseLegs(0, 0, 0, 0, 0, setYaw, 0)
      if (batGroupRef.current) {
        batGroupRef.current.position.set(...loadedHands)
        batGroupRef.current.rotation.y = sign * settings.loadedBaseAngle
      }
      if (cockRef.current) cockRef.current.rotation.x = settings.cockAngle
      if (tiltRef.current) tiltRef.current.rotation.x = 0
      updateArms(loadedHands, 1)
      return
    }

    // Swing phases driven by the real-time clock, each eased with smoothstep:
    //   l: load, shifting the weight onto the back leg for settings.loadTime s before
    //      the swing (holds through contact, eases back with the recovery)
    //   e: swing, from settings.swingLead s before contact up to contact
    //   f: follow-through, settings.followThrough s after contact
    //   r: recovery, easing back to the loaded stance over settings.recoveryTime while
    //      the batted ball is in flight (ready for the next pitch of the cycle)
    const swingStart = geom.contactTime - settings.swingLead
    const loadStart = swingStart - settings.loadTime
    const followEnd = geom.contactTime + settings.followThrough
    const recoverEnd = followEnd + settings.recoveryTime
    // The pitcher's windup — mapped onto the post-contact window of the
    // shared cycle so the release lands exactly on the wrap (the same timing
    // the Pitcher component uses) — is when the batter starts his stride and
    // lean-in. Use the same trajectory end time the Pitcher uses as its
    // contact anchor so the two start on the exact same frame.
    const loopDuration = getCycleDuration()
    const trajEnd = traj[traj.length - 1]?.t ?? 0
    const windupStart = Math.max(trajEnd, loopDuration - getBallReleaseTime())
    const windupDur = Math.max(loopDuration - windupStart, 0.01)

    let load = 0
    let e = 0
    let f = 0
    let r = 0
    if (swing) {
      if (currentSimTime >= loadStart && currentSimTime < swingStart) {
        load = easeSwing((currentSimTime - loadStart) / settings.loadTime)
      } else if (currentSimTime >= swingStart && currentSimTime < geom.contactTime) {
        e = easeSwing((currentSimTime - swingStart) / settings.swingLead)
      } else if (currentSimTime >= geom.contactTime && currentSimTime < followEnd) {
        f = easeSwing((currentSimTime - geom.contactTime) / settings.followThrough)
      } else if (currentSimTime >= followEnd && currentSimTime < recoverEnd) {
        r = easeSwing((currentSimTime - followEnd) / settings.recoveryTime)
      }
    }
    // The load's weight shift (back-leg crouch, hip settle, settled lean)
    // holds through the swing and eases back out as the legs recover. The
    // front stride is driven separately by the pitcher's windup below.
    if (swing && currentSimTime >= swingStart && currentSimTime < followEnd) load = 1
    if (swing && currentSimTime >= followEnd && currentSimTime < recoverEnd) load = 1 - r

    // The forward lean starts on the exact frame the pitcher starts his
    // windup and ramps linearly across the windup window, reaching full just
    // as the ball leaves the pitcher's hand at the wrap — the lean-in leads
    // the front stride, which is timed separately below so it plants into
    // the swing.
    const leanRamp = currentSimTime >= windupStart
      ? clamp((currentSimTime - windupStart) / windupDur, 0, 1)
      : 0

    // Front-foot stride — delayed so it flows into the swing. The body lean
    // starts the moment the windup starts (above), but the step itself waits
    // until the pitcher is almost done with his windup (strideDelayFrac of
    // the way through it) and then steps quickly, planting as the swing
    // fires: the foot lifts mid-step and plants just as the hips drive, so
    // the stride runs straight into the swing instead of completing early
    // and waiting. The step's progress is computed across the cycle wrap
    // (the step starts before the wrap and finishes just after it), so the
    // foot never snaps back when the clock rolls over. After the swing the
    // foot eases back to the stance during the recovery (or just after the
    // pitch for a take), ready for the next windup.
    let stride = 1
    let strideLift = 0
    // Hoisted step progress (0-1 across the step window, wrap-safe) so the
    // stride-edge push below can ride the same ramp it begins on.
    let ramp = 0
    // Planted through the flight / swing; ease back during the recovery.
    if (swing) {
      if (currentSimTime >= followEnd) {
        stride = currentSimTime < recoverEnd ? 1 - r : 0
      }
    } else {
      const takeSettleEnd = geom.contactTime + settings.leanOutTime
      if (currentSimTime >= takeSettleEnd) {
        stride = Math.max(0, 1 - easeSwing((currentSimTime - takeSettleEnd) / settings.leanOutTime))
      }
    }
    // The delayed step itself: from late in the windup to just before the
    // swing fires (swingStart of the next cycle, past the wrap).
    const strideStart = windupStart + settings.strideDelayFrac * windupDur
    const strideDur = Math.max(0.2, swingStart + loopDuration - strideStart)
    let sinceStride = currentSimTime - strideStart
    if (sinceStride < 0) sinceStride += loopDuration
    if (sinceStride <= strideDur) {
      ramp = easeSwing(sinceStride / strideDur)
      stride = ramp
      // Lift only while the foot is actually stepping (0 at start and plant).
      strideLift = Math.sin(Math.PI * ramp)
    }

    // Forward lean-in, driven by the windup progress above: the batter
    // stands straight while waiting, leans forward as the pitcher winds up
    // (leading the delayed front step), holds it through the flight and
    // swing, and eases back to straight after the recovery. Independent of
    // the swing flag, so it also applies to takes.
    let leanIn
    if (currentSimTime >= windupStart) {
      leanIn = leanRamp
    } else if (currentSimTime < loadStart) {
      leanIn = 1
    } else if (currentSimTime >= recoverEnd) {
      const sinceRecover = currentSimTime - recoverEnd
      leanIn = 1 - easeSwing(sinceRecover / settings.leanOutTime)
    } else {
      leanIn = 1
    }

    // How open the upper body / head is: ramps up through the swing, holds
    // through the follow-through, and eases back during recovery.
    let open = 0
    if (swing) {
      if (currentSimTime < geom.contactTime) open = e
      else if (currentSimTime < followEnd) open = 1
      else if (currentSimTime < recoverEnd) open = 1 - r
    }

    // The torso opens ahead of the hands during the pre-contact window (the
    // barrel catches up exactly at contact), then rides the same
    // follow-through/recovery as the rest of the swing. This is the kinetic
    // chain: back foot/hips fire first (settings.hipsLead), then the body turn, then
    // the hands.
    let bodyTurn = 0
    if (swing) {
      if (currentSimTime < geom.contactTime) bodyTurn = THREE.MathUtils.clamp(e * settings.bodyTurnLead, 0, 1)
      else if (currentSimTime < followEnd) bodyTurn = 1
      else if (currentSimTime < recoverEnd) bodyTurn = 1 - r
    }

    // How strongly the forearms ride the bat's barrel line: full once the
    // swing is most of the way through (so the bat visibly swings WITH the
    // forearms into contact), easing back off through the follow-through.
    let align = 0
    if (swing) {
      if (currentSimTime < geom.contactTime) align = THREE.MathUtils.clamp(e / 0.4, 0, 1)
      else if (currentSimTime < followEnd) align = 1 - f
    }

    // The upper body opens toward the pitcher as the swing progresses, while a
    // slow idle bob raises and lowers the loaded stance (fading out while the
    // swing is active so the two don't fight).
    const swayPhase = state.clock.elapsedTime * settings.swaySpeed
    const bob = Math.sin(swayPhase) * settings.swayBobAmount * (1 - open)
    // Hips lead the shoulders: the lower body's opening progress is
    // phase-advanced (settings.hipsLead) so the legs start turning before the upper
    // body — the kinetic chain of a real swing, with the hips firing first
    // and the torso catching up by contact.
    const lowerOpenYaw = setYaw + (bodyOpen - setYaw) * settings.lowerBodyOpenFactor
    const lowerOpen = THREE.MathUtils.clamp(open * settings.hipsLead, 0, 1)
    // The legs drive with the same phase-advanced progress: the knees
    // straighten from the bent crouch and the feet push toward the plate as
    // the swing fires, with a forward lean selling the weight transfer.
    const drive = lowerOpen
    // The back leg recovers to the crouch slightly later than the front leg:
    // through the first settings.backRecoverLag of the recovery it holds its
    // extended drive, then eases back after the front leg has already settled.
    let driveBack = drive
    if (swing && r > 0) {
      const rBack = THREE.MathUtils.clamp((r - settings.backRecoverLag) / (1 - settings.backRecoverLag), 0, 1)
      driveBack = THREE.MathUtils.clamp((1 - rBack) * settings.hipsLead, 0, 1)
    }

    // Body rotation through the swing: the upper body opens toward the
    // pitcher up to contact (bodyOpen), keeps turning through the
    // follow-through until the chest fully faces the pitcher (settings.fullOpenYaw),
    // then unwinds back to the set stance during recovery. The hips ride the
    // same arc at a fraction of the rotation (settings.lowerBodyOpenFactor),
    // phase-advanced to lead the shoulders into the swing. The lead carries
    // into the follow-through: the hips finish their continued rotation
    // (lowerOpenYaw -> hipFullOpenYaw) while the torso is still unwinding
    // into the fully-open pose, so the legs keep driving through contact and
    // the torso completes the turn after them.
    const hipFullOpenYaw = setYaw + (settings.fullOpenYaw - setYaw) * settings.lowerBodyOpenFactor
    let bodyYaw = setYaw
    let lowerYaw = setYaw
    if (swing) {
      if (currentSimTime < geom.contactTime) {
        bodyYaw = THREE.MathUtils.lerp(setYaw, bodyOpen, bodyTurn)
        lowerYaw = THREE.MathUtils.lerp(setYaw, lowerOpenYaw, lowerOpen)
      } else if (currentSimTime < followEnd) {
        bodyYaw = THREE.MathUtils.lerp(bodyOpen, settings.fullOpenYaw, f)
        lowerYaw = THREE.MathUtils.lerp(
          lowerOpenYaw,
          hipFullOpenYaw,
          THREE.MathUtils.clamp(f * settings.hipsLead, 0, 1),
        )
      } else if (currentSimTime < recoverEnd) {
        bodyYaw = THREE.MathUtils.lerp(settings.fullOpenYaw, setYaw, r)
        lowerYaw = THREE.MathUtils.lerp(hipFullOpenYaw, setYaw, r)
      }
    }
    // The push envelope drives the hips forward (settings.hipDriveForward) and the
    // upper body's smaller push (settings.upperDriveForward).
    const settleStart = geom.contactTime - settings.pushSettleTime
    let push = 0
    if (swing) {
      // Whole-body forward push: ONE continuous accelerating motion from the
      // start of the delayed front step through the swing, not two
      // constant-speed stages (a slow smoothstep hump during the stride that
      // stops at the plant, then a fast one for the swing). The stride phase
      // is a quadratic ramp — velocity builds from zero with no long flat
      // middle, reaching settings.strideEdgeFrac (30%) of the full drive the
      // moment the foot plants. The swing phase hands off AT that speed (no
      // pause at the plant) and keeps accelerating as a cubic: velocity peaks
      // around the mid-swing, then decelerates smoothly to zero by the settle
      // start, where the smoothstep settle-back (1 -> settings.pushSettleLevel,
      // held through contact and eased out on recovery) takes over. Every
      // handoff is position- and velocity-continuous, so the approach reads
      // as one smooth flow that simply gets faster and faster into the bat;
      // the contact push stays exactly settings.pushSettleLevel, keeping the
      // contact geometry's compensation exact.
      const approachDur = strideDur + Math.max(1e-3, settleStart - swingStart)
      // Wrap-safe progress across the whole approach (stride start past the
      // cycle wrap to the settle start) — same construction as the stride.
      let sinceApproach = currentSimTime - strideStart
      if (sinceApproach < 0) sinceApproach += loopDuration
      if (sinceApproach <= approachDur) {
        const u = sinceApproach / approachDur
        const u1 = THREE.MathUtils.clamp(strideDur / approachDur, 1e-3, 0.999)
        if (u <= u1) {
          // Stride phase: accelerating quadratic (velocity 0 at the start of
          // the step, climbing through the plant).
          push = settings.strideEdgeFrac * (u / u1) * (u / u1)
        } else {
          // Swing phase: velocity continues from the plant (v1) and keeps
          // accelerating to a peak placed at settings.swingPeakFrac (or auto-
          // resolved from pitch speed when 0: faster pitches shift the peak
          // later so the maximal surge syncs closer to contact), then
          // decelerates to zero, ready for the smoothstep settle-back. Two
          // smoothstep velocity segments stitched at the peak keep the
          // velocity curve — and its slope — continuous everywhere; the peak
          // height is forced by the fixed displacement (the body still reaches
          // exactly full push at the settle start), so a later peak reads as a
          // sharper surge closer to contact.
          const s = (u - u1) / (1 - u1)
          const t2 = (1 - u1) * approachDur
          const v1 = 2 * settings.strideEdgeFrac / (u1 * approachDur)
          const pitchSpeed = resolvePitchSpeedMph(pitchData)
          const swingPeak = resolveSwingPeak(settings.swingPeakFrac, pitchSpeed)
          // Peak velocity chosen so the area under the velocity curve adds
          // exactly (1 - strideEdgeFrac) of push by the settle start.

          const vPeak = 2 * (1 - settings.strideEdgeFrac) / t2 - swingPeak * v1
          // Anti-derivative of the smoothstep ∫g = y³ − y⁴/2, used to
          // integrate the velocity segments in closed form below.
          const smoothInt = (y) => y * y * y - (y * y * y * y) / 2
          if (s <= swingPeak) {
            // Accelerating segment: v1 -> vPeak.
            push = settings.strideEdgeFrac + t2 * (
              v1 * s + (vPeak - v1) * swingPeak * smoothInt(s / swingPeak)
            )
          } else {
            // Decelerating segment: vPeak -> 0.
            push = settings.strideEdgeFrac + t2 * (
              swingPeak * (v1 + vPeak) / 2
              + vPeak * (s - swingPeak)
              - vPeak * (1 - swingPeak) * smoothInt((s - swingPeak) / (1 - swingPeak))
            )
          }
        }
      } else if (currentSimTime >= settleStart && currentSimTime < geom.contactTime) {
        push = THREE.MathUtils.lerp(
          1,
          settings.pushSettleLevel,
          easeSwing((currentSimTime - settleStart) / settings.pushSettleTime),
        )
      } else if (currentSimTime >= geom.contactTime && currentSimTime < recoverEnd) {
        // ONE continuous post-contact arc — no dead hold, no separate
        // ease-out stage. The body flows THROUGH contact: it rides gently
        // forward (a smoothstep bump, cresting about when the bat's own
        // follow-through completes) and then returns to the stance in a
        // single motion that accelerates to a peak backward speed at
        // settings.returnPeakFrac through the arc and decelerates to rest.
        // Three smoothstep velocity segments stitched at zero slope keep
        // position, velocity, and the feel of one flow; the arc starts
        // exactly at settings.pushSettleLevel (contact) and lands exactly
        // on zero (stance) with no velocity steps anywhere.
        const span = recoverEnd - geom.contactTime
        const u = (currentSimTime - geom.contactTime) / span
        const uFinish = THREE.MathUtils.clamp(settings.followThrough / span, 0.05, 0.5)
        const uPeak = THREE.MathUtils.clamp(settings.returnPeakFrac, 0.15, 0.85)
        // Finish ride: a crest of ~+0.02 of push above the settle level,
        // spread across the bat's follow-through window.
        const vFinish = 2 * 0.02 / uFinish
        // Return peak speed chosen so the arc's total displacement is
        // exactly -pushSettleLevel (down to zero at the stance).
        const vReturn = (vFinish * uPeak + 2 * settings.pushSettleLevel) / (1 - uFinish)
        // Anti-derivative of the smoothstep ∫g = y³ − y⁴/2.
        const smoothInt = (y) => y * y * y - (y * y * y * y) / 2
        if (u <= uFinish) {
          // Finish ride: 0 -> vFinish.
          push = settings.pushSettleLevel + vFinish * uFinish * smoothInt(u / uFinish)
        } else if (u <= uPeak) {
          // Accelerating return: vFinish -> -vReturn.
          push = settings.pushSettleLevel + vFinish * uFinish / 2
            + vFinish * (u - uFinish)
            - (vFinish + vReturn) * (uPeak - uFinish) * smoothInt((u - uFinish) / (uPeak - uFinish))
        } else {
          // Decelerating return: -vReturn -> 0.
          push = settings.pushSettleLevel + vFinish * uFinish / 2
            + (vFinish - vReturn) * (uPeak - uFinish) / 2
            - vReturn * (u - uPeak)
            + vReturn * (1 - uPeak) * smoothInt((u - uPeak) / (1 - uPeak))
        }
      }
    } else {
      // Takes get the same edge — the batter strides into the pitch and rides
      // it forward — but with no swing ride-up to hand off to, the edge holds
      // at full through the pitch crossing, then eases back out once the ball
      // passes (the same leanOutTime window the front foot uses to relax: the
      // body returns first while the foot holds its plant, then the foot
      // steps back). No bat meets the ball, so this is independent of the
      // swing's contact compensation.
      const takeEdgeEnd = geom.contactTime + settings.leanOutTime
      if (sinceStride <= strideDur) {
        push = settings.strideEdgeFrac * ramp
      } else if (currentSimTime < geom.contactTime) {
        push = settings.strideEdgeFrac
      } else if (currentSimTime < takeEdgeEnd) {
        push = settings.strideEdgeFrac * (1 - easeSwing((currentSimTime - geom.contactTime) / settings.leanOutTime))
      }
    }
    const hipDrive = (settings.hipDriveForward * push) / heightScale
    if (lowerRef.current) {
      lowerRef.current.rotation.y = lowerYaw
      lowerRef.current.position.z = -hipDrive
    }
    if (upperRef.current) {
      // YXZ order: yaw first, then the lean's forward/sideways tilts, so the
      // lean direction (rotation.x/z) stays in the body's own frame.
      upperRef.current.rotation.order = BATTER_LEAN_ORDER
      upperRef.current.rotation.y = bodyYaw
      // The lean always faces the midpoint of the home plate -> catcher
      // segment rather than the pitcher: the world direction from the batter
      // to that midpoint, expressed in the upper body's LIVE frame (so it
      // tracks the body as it opens) and split into the fore/aft
      // (rotation.x) and sideways (rotation.z) components. Straight when set,
      // ramping in as the pitch arrives (leanIn), settling back onto the back
      // leg during the load, and holding a stronger lean (settings.legLean) through
      // the swing as the back leg drives the rotation.
      const leanMag = THREE.MathUtils.lerp(settings.setLean * leanIn, settings.legLean, drive)
      const lean = batterLean(batX, stanceZ, FIELD.DEFENSE.C.z, bodyYaw, leanMag)
      let leanX = lean.rotationX + settings.loadLeanBack * load * (1 - drive)
      let leanZ = lean.rotationZ
      // As the back leg unbuckles, the body also tilts back toward the
      // catcher (world +Z) while the hips drive forward — expressed in the
      // live frame so the tilt always points at the catcher, and held through
      // the follow-through as the back leg stays driven.
      const backTilt = settings.swingBackTilt * drive
      leanX += backTilt * Math.cos(bodyYaw)
      leanZ += backTilt * Math.sin(bodyYaw)
      upperRef.current.rotation.x = leanX
      upperRef.current.rotation.z = leanZ
      // The back leg firing pushes the whole body forward toward the pitcher
      // (the hips lead with settings.hipDriveForward; the torso, head, and bat
      // follow with settings.upperDriveForward, which the contact geometry
      // compensates for so the sweet spot still meets the ball).
      upperRef.current.position.z = (-settings.upperDriveForward * push) / heightScale
      // The hips settle lower during the load (the whole upper body drops with
      // them), rising back as the drive engages.
      upperRef.current.position.y = HIP_Y + bob - settings.hipSettle * load * (1 - drive)
    }
    poseLegs(drive, driveBack, load, stride, strideLift, lowerYaw, hipDrive)

    // Head: faces the pitcher during the set, eases to track the ball through
    // the swing (tilting forward toward the plate and swiveling to the contact
    // point as the upper body opens), and once the ball is hit follows the
    // batted ball's live flight — yawing to its position and tilting up for
    // fly balls / down for grounders. The lock-on ramps in at contact and
    // eases back out once the ball lands, so the head tracks the flight but
    // never snaps when the play ends.
    if (headRef.current) {
      // YXZ order: yaw around the vertical first, then pitch — the standard
      // head convention, so the pitch always tilts the face up/down regardless
      // of how far the head is turned. With the default XYZ order the pitch
      // axis rotates WITH the yaw, so once the head turns past +/-90 degrees
      // (tracking a ball while the upper body recovers) a positive tilt flips
      // to pointing DOWN — the head looks like it's tilting off the back.
      headRef.current.rotation.order = 'YXZ'
      const ballPos = getBattedBallPosition()
      const upperYaw = upperRef.current ? upperRef.current.rotation.y : 0
      let yaw = lerpAngle(headPitcherYaw, geom.headYaw, open)
      let tilt = settings.headTiltMax * open
      const tracking = ballPos && currentSimTime >= geom.contactTime
      if (tracking) {
        // The ball launches exactly at the contact point, so this look is
        // continuous with the contact tracking. Store the WORLD yaw to the
        // ball (not a local one) so the fade below stays anchored in world
        // space while the upper body may still be rotating back.
        const headWorld = new THREE.Vector3()
        headRef.current.getWorldPosition(headWorld)
        const dx = ballPos.x - headWorld.x
        const dy = ballPos.y - headWorld.y
        const dz = ballPos.z - headWorld.z
        const dist = Math.hypot(dx, dz)
        lastBallLook.current = {
          worldYaw: Math.atan2(-dx, -dz),
          tilt: dist > 1e-4
            ? THREE.MathUtils.clamp(Math.atan2(dy, dist), -settings.headTrackTiltDown, settings.headTrackTiltUp)
            : 0,
        }
      }
      // Ease the lock-on strength: ramp in quickly at contact, decay back to
      // the stance look after the ball lands (faster in, slower out).
      const trackTarget = tracking ? 1 : 0
      const trackRate = trackTarget ? 10 : 4
      trackRef.current = THREE.MathUtils.clamp(
        trackRef.current + (trackTarget - trackRef.current) * Math.min(1, delta * getTimeScale() * trackRate),
        0,
        1,
      )
      if (trackRef.current > 0 && lastBallLook.current) {
        // Fade the head's WORLD facing directly from the last tracked
        // direction back to the stance look, then express it in the upper
        // body's current frame. If the ball lands mid-recovery the upper body
        // keeps rotating back, and a local-frame fade would drag the head's
        // world facing along with it — swinging it off the neck and behind
        // the body. Fading in world space keeps the head on a straight path
        // back to the pitcher look regardless of what the torso is doing.
        const currentWorldYaw = upperYaw + yaw
        const trackedWorldYaw = lerpAngle(currentWorldYaw, lastBallLook.current.worldYaw, trackRef.current)
        yaw = trackedWorldYaw - upperYaw
        tilt = THREE.MathUtils.lerp(tilt, lastBallLook.current.tilt, trackRef.current)
      }
      headRef.current.rotation.x = tilt
      headRef.current.rotation.y = yaw
    }

    // Hands: loaded -> contact along a forward-bulging arc through the swing,
    // held at contact through the follow-through, then eased back to loaded.
    let hands = geom.loadedHands
    if (swing && currentSimTime >= swingStart) {
      if (currentSimTime < geom.contactTime) {
        hands = bezier2(geom.loadedHands, geom.handsControl, geom.contactHands, e)
      } else if (currentSimTime < followEnd) {
        hands = geom.contactHands
      } else if (currentSimTime < recoverEnd) {
        hands = lerpV3(geom.contactHands, geom.loadedHands, r)
      }
    }

    // Bat angle: loaded -> contact (sweet spot on the ball) -> follow-through
    // -> recovered stance.
    let angle = geom.loadedY
    if (swing) {
      if (currentSimTime < geom.contactTime) {
        angle = THREE.MathUtils.lerp(geom.loadedY, geom.contactY, e)
      } else if (currentSimTime < followEnd) {
        angle = THREE.MathUtils.lerp(geom.contactY, geom.throughY, f)
      } else if (currentSimTime < recoverEnd) {
        angle = THREE.MathUtils.lerp(geom.throughY, geom.loadedY, r)
      }
    }

    batGroupRef.current.position.set(hands[0], hands[1], hands[2])
    batGroupRef.current.rotation.y = angle

    // The bat drops from the cocked position (over the shoulder) to level by
    // contact. The barrel first rides up onto the swing plane shaped by
    // swing_path_tilt, then flattens onto the true attack angle exactly at
    // contact (the sine bump is 0 at both ends, so the endpoints are exact);
    // after contact it rises back up along the plane through the
    // follow-through. The arms straighten through the swing — all reversing
    // through the recovery.
    let cockAngle = settings.cockAngle
    let tiltAngle = 0
    let bend = 1
    if (swing) {
      if (currentSimTime < geom.contactTime) {
        cockAngle = settings.cockAngle * (1 - e)
        tiltAngle = computeBatTiltAtProgress(e, geom.tilt, geom.planeTilt)
        bend = 1 - e
      } else if (currentSimTime < followEnd) {
        cockAngle = 0
        tiltAngle = THREE.MathUtils.lerp(geom.tilt, geom.planeTilt, f)
        bend = 0
      } else if (currentSimTime < recoverEnd) {
        cockAngle = settings.cockAngle * r
        tiltAngle = geom.planeTilt * (1 - r)
        bend = r
      }
    }
    if (cockRef.current) cockRef.current.rotation.x = cockAngle
    if (tiltRef.current) tiltRef.current.rotation.x = tiltAngle

    updateArms(hands, bend, align, angle, cockAngle, tiltAngle)

  })

  if (!pitchData) return null

  const batLength = geom?.batLength ?? 0.9

  return (
    <group ref={groupRef} position={[batX, 0, stanceZ]}>
      {/* Uniformly scaled body, head, and bat so the silhouette (height, body
          width, shoulder radius) stays proportional to the batter's size */}
      <group scale={heightScale}>
        {/* Lower body (hips, legs, feet): rotates slightly with the swing so
            the hips open a fraction as far as the shoulders instead of staying
            fully planted */}
        <group ref={lowerRef}>
          {/* Legs: thigh (hip->knee) + shin (knee->ankle), knees bent forward
              for the crouch of the set stance */}
          {/* Legs: thigh (hip->knee) + shin (knee->ankle), knees bent forward
              for the crouch of the set stance. Unit-height cylinders re-posed
              every frame by poseLegs (hidden until the first frame so they
              don't flash), exactly like the arms. */}
          <mesh ref={thighLRef} visible={false} castShadow material={pantsMat}>
            <cylinderGeometry args={[0.065, 0.065, 1, 8]} />
          </mesh>
          <mesh ref={shinLRef} visible={false} castShadow material={pantsMat}>
            <cylinderGeometry args={[0.05, 0.05, 1, 8]} />
          </mesh>
          <mesh ref={thighRRef} visible={false} castShadow material={pantsMat}>
            <cylinderGeometry args={[0.065, 0.065, 1, 8]} />
          </mesh>
          <mesh ref={shinRRef} visible={false} castShadow material={pantsMat}>
            <cylinderGeometry args={[0.05, 0.05, 1, 8]} />
          </mesh>

          {/* Feet (shoes), perpendicular to the first/third base line (long
              axis along the pitcher-catcher line) */}
          <mesh ref={shoeLRef} position={[-0.14, 0.03, -0.05]} castShadow material={shoesMat}>
            <boxGeometry args={[0.12, 0.06, 0.32]} />
          </mesh>
          <mesh ref={shoeRRef} position={[0.14, 0.03, -0.05]} castShadow material={shoesMat}>
            <boxGeometry args={[0.12, 0.06, 0.32]} />
          </mesh>
        </group>

        {/* Upper body: rotates to open toward the pitcher through the swing,
            carrying the torso, chest marker, head, arms, and bat together.
            The group sits at the hip joint (HIP_Y) so the torso pivots at the
            hips — staying attached to the legs while it leans, tilts, and
            swivels — with the inner group restoring the feet-relative child
            coordinates. */}
        <group ref={upperRef} position={[0, HIP_Y, 0]}>
          <group position={[0, -HIP_Y, 0]}>
            {/* Torso (jersey) */}
            <mesh position={[0, 1.05, 0]} castShadow material={jerseyMat}>
              <capsuleGeometry args={[0.28, 0.6, 4, 8]} />
            </mesh>

            {/* Chest marker (jersey number) on the front so the body's turn is
                visible as it opens toward the pitcher */}
            <mesh position={[0, 1.18, -0.3]} material={markerMat}>
              <boxGeometry args={[0.18, 0.14, 0.02]} />
            </mesh>

            {/* Head: tilts forward toward the pitcher (rotation.x on headRef) as
                the upper body opens, tracking the ball through the swing. A
                helmet + brim make the tilt read on the plain sphere. The group
                is positioned at the NECK (1.5) so the head rotates around its
                joint with the body — not the feet it previously pivoted on —
                keeping it attached even when it tilts up to track a pop-up. */}
            <group ref={headRef} position={[0, 1.5, 0]}>
              <mesh position={[0, 0.22, 0]} material={skinMat}>
                <sphereGeometry args={[0.23, 12, 12]} />
              </mesh>
              {/* Helmet cap (top half of a slightly larger sphere) */}
              <mesh position={[0, 0.22, 0]} material={helmetMat}>
                <sphereGeometry args={[0.245, 12, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
              </mesh>
              {/* Brim pointing toward the pitcher (-Z) */}
              <mesh position={[0, 0.2, -0.26]} material={brimMat}>
                <boxGeometry args={[0.36, 0.045, 0.22]} />
              </mesh>
            </group>

            {/* Arms: upper arm (shoulder->elbow) + forearm (elbow->hands), posed
                each frame by updateArms as the hands travel to the contact
                point. Hidden until the first frame so they don't flash. */}
            <mesh ref={leftUpperRef} visible={false} castShadow material={skinMat}>
              <cylinderGeometry args={[0.055, 0.055, 1, 8]} />
            </mesh>
            <mesh ref={leftForeRef} visible={false} castShadow material={skinMat}>
              <cylinderGeometry args={[0.045, 0.045, 1, 8]} />
            </mesh>
            <mesh ref={rightUpperRef} visible={false} castShadow material={skinMat}>
              <cylinderGeometry args={[0.055, 0.055, 1, 8]} />
            </mesh>
            <mesh ref={rightForeRef} visible={false} castShadow material={skinMat}>
              <cylinderGeometry args={[0.045, 0.045, 1, 8]} />
            </mesh>

            {/* Bat: handle at the hands, barrel toward the pitcher (-Z). The
                group is repositioned (hands arc) and rotated (swing) every
                frame; the inner cock group drops the bat from over the shoulder
                into the zone and the tilt group applies the contact attack
                angle / swing-plane tilt. */}
            <group ref={batGroupRef} position={loadedHands} rotation={[0, sign * settings.loadedBaseAngle, 0]}>
              <group ref={cockRef} rotation={[settings.cockAngle, 0, 0]}>
                <group ref={tiltRef}>
                  <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -batLength / 2]} material={batMat}>
                    <cylinderGeometry args={[0.045, 0.024, batLength, 8]} />
                  </mesh>
                  {/* Knob behind the handle */}
                  <mesh position={[0, 0, 0.03]} material={knobMat}>
                    <sphereGeometry args={[0.03, 8, 8]} />
                  </mesh>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  )
}
