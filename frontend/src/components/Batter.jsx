import React, { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getCycleDuration, getTimeScale, getBattedBallPosition } from '../constants/playback'
import { FIELD } from '../constants/field'
import { PLATE_FRONT_Y, clamp, plateCrossing } from '../util/MathUtil'
import { BATTER_LEAN_ORDER, batterLean } from '../util/batterLean'
import { BALL_RELEASE_TIME } from './Pitcher'

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
// transparent: at minimum the batter stays translucent (FADE_MIN_OPACITY) so
// it reads as a ghost outline instead of disappearing.
const FADE_START_M = 3
const FADE_END_M = 11
const FADE_MIN_OPACITY = 0.2

// Swing timing: the bat starts SWING_LEAD seconds before the ball crosses the
// plate, reaches the contact angle exactly when the ball arrives, follows
// through for FOLLOW_THROUGH seconds after, then eases back to the loaded
// stance over RECOVERY_TIME while the batted ball is in flight. Before the
// swing, the batter loads the weight onto the back leg over LOAD_TIME seconds
// (ending exactly where the swing begins), so the swing fires out of a loaded
// crouch instead of from a static stance.
const SWING_LEAD = 0.22
const FOLLOW_THROUGH = 0.14
const RECOVERY_TIME = 0.55
const LOAD_TIME = 0.18

// Bat rotation (radians around the vertical axis). At 0 the barrel points at
// the pitcher; at +/-PI it points back at the catcher. The handedness sign
// mirrors lefties vs righties: the base angles are negated for a lefty.
const LOADED_BASE = -Math.PI
const THROUGH_BASE = Math.PI / 2

// The bat is cocked up over the back shoulder in the set stance, and drops to
// level by the time it reaches the contact point (radians of X tilt).
const COCK_ANGLE = 0.7

// How much the upper body (torso, shoulders, arms, bat) opens toward the
// pitcher through the swing, like the reference's SwingMid animation. Sized so
// the chest opens most of the way toward the pitcher by contact — the whole
// swing, not just the head, opens toward the ball (the follow-through then
// completes the turn to FULL_OPEN_YAW). The sign mirrors handedness so the
// body turns with the swing (see bodyOpen below).
const BODY_OPEN_MAX = 0.4

// After contact the body keeps opening through the follow-through until the
// chest fully faces the pitcher (FULL_OPEN_YAW = 0, straight down the line),
// then unwinds back to the set stance during the recovery.
const FULL_OPEN_YAW = 0

// The set stance faces a point on the home-plate -> catcher segment biased
// toward home plate, so the body angles in toward the pitch (a slightly open
// stance) instead of facing the catcher side. The direction is computed
// per-stance in the component: the body yaw that points the chest (local -Z)
// at that target from the batter's world position (batX, stanceZ).
//
// SET_FACE_BIAS is the fraction of the way from home plate (z=0) to the
// catcher (z=C.z): 0.5 faces the old plate->catcher midpoint, and lower
// values turn the body and legs toward home plate (0 would face it directly).
const SET_FACE_BIAS = 0.35

// The lower body (hips/legs) rotates with the swing, opening nearly as far as
// the shoulders so the legs visibly turn with the body (a real swing keeps the
// hips just short of the shoulders' rotation).
const LOWER_BODY_OPEN_FACTOR = 0.8

// The hips fire ahead of the shoulders (the kinetic chain of a real swing):
// the lower body's opening progress is phase-advanced by this factor, so the
// legs start turning before the upper body and reach their full (lesser) open
// angle while the torso is still rotating — reading as the legs driving the
// swing. The clamp also makes the hips hold their open angle through the
// follow-through and settle back after the shoulders on recovery.
const HIPS_LEAD = 1.8
// The upper body's turn leads the hands/bat by this factor during the pre-
// contact window, so the chest opens before the barrel arrives — part of the
// same kinetic chain as HIPS_LEAD (legs -> torso -> hands).
const BODY_TURN_LEAD = 1.15

// Head tilt range while tracking the batted ball (radians): how far the head
// can nod down toward a grounder or tilt up toward a fly ball. The contact
// look uses the smaller HEAD_TILT_MAX; the live ball can be far above the
// batter (pop-ups) so the up range is wider.
const HEAD_TRACK_TILT_DOWN = 0.55
const HEAD_TRACK_TILT_UP = 1.2

// Leg drive: as the swing fires the BACK leg — the side away from the
// pitcher (the right leg for a righty) — unbends and drives the entire
// swing: it straightens from the crouch and pushes toward the plate as the
// hips turn, while the front leg stays bent to brace the rotation. Before
// the swing, a brief load phase shifts the weight onto the back leg — the
// hips settle lower (LEG_HIP_SETTLE) and the back knee crouches deeper —
// while the front leg strides toward the pitcher and plants through the
// swing. The upper body mirrors the weight transfer: it stands straight
// in the set stance, leans forward toward home plate as the pitch arrives
// (SET_LEAN), settles back onto the back leg during the load
// (LOAD_LEAN_BACK), then holds a stronger forward lean toward the plate
// through the entire swing (LEG_LEAN) as the back leg drives. During the
// recovery the back leg eases back to the crouch later than the front leg
// (BACK_RECOVER_LAG).
const LEG_BACK_KNEE_RISE = 0.28     // back knee nearly straightens (y gain, local m)
const LEG_FRONT_KNEE_RISE = 0.06    // front leg stays bent, bracing the turn
const LEG_BACK_LOAD_DROP = 0.05     // back knee crouches deeper during the load
const LEG_HIP_SETTLE = 0.06         // hips (and upper body) drop during the load
const LEG_BACK_KNEE_FORWARD = 0.04  // back knee slides toward the plate
const LEG_FRONT_KNEE_FORWARD = 0.01
const LEG_BACK_PUSH_FORWARD = 0.05  // back foot/ankle pushes slightly toward the plate
const LEG_FRONT_PUSH_FORWARD = 0.02
const LEG_FRONT_STRIDE = 0.24       // front foot strides toward the pitcher before the swing
const LEG_FRONT_STRIDE_LIFT = 0.07  // front foot lifts clearly while striding
const LEG_FRONT_KNEE_LIFT = 0.08    // front knee lifts as it steps
const LEG_FRONT_UNPLANT_LIFT = 0.08 // front foot lifts off the ground as the swing fires
// Footwork through the swing: the swing pivots around the BACK foot, which
// stays planted (counter-rotated against the hips' opening) and pivots
// toward the pitcher (BACK_FOOT_PIVOT). The front foot unplants as the drive
// fires — lifting and turning with the body (its pre-swing plant keeps only
// a small FRONT_FOOT_PIVOT).
const BACK_FOOT_PIVOT = 0.75
const FRONT_FOOT_PIVOT = 0.2
// Hip drive: as the back leg unbuckles, the hips (lower body) drive forward
// toward the pitcher (HIP_DRIVE_FORWARD), the whole body pushes forward a
// little as well (UPPER_DRIVE_FORWARD), and the upper body tilts back toward
// the catcher (SWING_BACK_TILT) — the "staying back" posture of a real
// swing, held through the follow-through.
const HIP_DRIVE_FORWARD = 0.14  // m — hips translate toward the pitcher at full drive
const SWING_BACK_TILT = 0.14    // rad — upper body tilts back toward the catcher
const UPPER_DRIVE_FORWARD = 0.07 // m — the whole body also pushes forward when the back leg fires
// The whole-body forward push peaks as the swing fires, then eases back over
// the PUSH_SETTLE_TIME before contact, settling to PUSH_SETTLE_LEVEL through
// the follow-through so the batter settles into the plate instead of
// drifting forward past contact; the recovery then relaxes it fully.
const PUSH_SETTLE_TIME = 0.08  // s — the push eases back over this window ending at contact
const PUSH_SETTLE_LEVEL = 0.6  // fraction of the full push held through the follow-through
const LEG_LEAN = 0.3                // upper-body forward lean held through the swing (radians)
const SET_LEAN = 0.3                // forward lean-in magnitude as the pitch arrives (radians)
const LEAN_OUT_TIME = 0.3           // s — lean eases back to straight after the recovery
const LOAD_LEAN_BACK = 0.08         // extra lean back onto the back leg during the load
const BACK_RECOVER_LAG = 0.35       // fraction of the recovery the back leg holds its drive

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
// tilts, and swivels through the swing.
const HIP_Y = 0.72

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

// The hands at contact reach HAND_EXTENSION of the way from the front of the
// torso toward the ball, so the arms extend naturally and the sweet spot (the
// remaining distance to the ball) lands on the barrel.
const HAND_EXTENSION = 0.35

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
const CONTACT_TILT_MAX_DEG = 20
const CONTACT_TILT_MAX_DEG_RAD = THREE.MathUtils.degToRad(CONTACT_TILT_MAX_DEG)
const PLANE_TILT_MAX_DEG = 50
const PLANE_TILT_MAX_DEG_RAD = THREE.MathUtils.degToRad(PLANE_TILT_MAX_DEG)

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
const HANDS_PATH_BULGE = 0.3

// Slow idle bob of the loaded stance: the upper body rises and falls gently so
// the batter looks alive between pitches. Driven by real elapsed time (not the
// looping playback clock) so it never jumps when the pitch loop resets, and it
// fades out as the swing takes over.
const SWAY_SPEED = 1.4
const SWAY_BOB_AMOUNT = 0.04

// The head faces the pitcher during the set (so the brim points down the
// pitch), then tracks the ball through the swing: it tilts forward toward the
// plate and swivels to face the contact point (the ball at home plate). The
// face is the head's local -Z (the brim sits on that side), so the yaws are
// computed from the head->pitcher / head->contact offsets expressed in the
// upper body's own rotated frame; HEAD_YAW_MAX just keeps the contact turn
// from looking cranked fully sideways.
const HEAD_TILT_MAX = -0.15
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

export const Batter = ({ pitchData }) => {
  const clock = useRef(0)
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
  // FADE_MIN_OPACITY so the batter stays translucent instead of vanishing.
  useFrame(() => {
    const group = groupRef.current
    if (!group) return
    const behind = camera.position.z > group.position.z
    const distanceToCamera = camera.position.distanceTo(group.position)
    const fade = clamp((distanceToCamera - FADE_START_M) / (FADE_END_M - FADE_START_M), 0, 1)
    const opacity = behind
      ? FADE_MIN_OPACITY + (1 - FADE_MIN_OPACITY) * fade
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
  const bodyOpen = -sign * BODY_OPEN_MAX
  // Set stance: the body and legs face the spot between home plate and the
  // catcher — the midpoint of the plate -> catcher segment — rather than
  // turning a full half-turn to face the catcher directly. Standing off to one
  // side of the plate that direction is a diagonal (a righty's chest angles
  // toward first base, a lefty's toward third), and the swing rotates the body
  // from this pose around to the open contact pose facing the pitcher —
  // clockwise for a lefty, counter-clockwise for a righty — so the torso
  // unwinds across the plate into the pitch.
  const setFaceTargetZ = FIELD.DEFENSE.C.z * SET_FACE_BIAS
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
    const traj = pitchData?.trajectory
    if (!traj || traj.length === 0) return null
    const crossing = plateCrossing(traj)

    const loadedY = sign * LOADED_BASE
    const throughY = sign * THROUGH_BASE

    // Contact point in the height-scaled frame. The batter group sits at
    // (batX, 0, stanceZ) in world space and the plate front is at world
    // z = -PLATE_FRONT_Y, so:
    const contact = {
      x: (crossing.x - batX) / heightScale,
      y: crossing.height / heightScale,
      // The whole body pushes forward by the time the swing reaches contact
      // (UPPER_DRIVE_FORWARD, eased back to PUSH_SETTLE_LEVEL at contact), so
      // the ball sits that much closer to the body.
      z: (-PLATE_FRONT_Y - stanceZ) / heightScale + UPPER_DRIVE_FORWARD * PUSH_SETTLE_LEVEL / heightScale,
    }

    // Head yaw to look at the ball at the plate. The head's face is its local
    // -Z, so the world yaw that faces the contact point is atan2(-dx, -dz) for
    // the horizontal offset (dx, dz) from the head to the contact point (the
    // head sits at x=batX, z=stanceZ; the contact point is at x=crossing.x,
    // z=-PLATE_FRONT_Y). The head is inside the upper body (rotation.y =
    // bodyOpen), so the local yaw subtracts the body's turn.
    const headDx = crossing.x - batX
    const headDz = -PLATE_FRONT_Y - stanceZ
    const headYaw = THREE.MathUtils.clamp(
      Math.atan2(-headDx, -headDz) - bodyOpen,
      -HEAD_YAW_MAX,
      HEAD_YAW_MAX,
    )

    // The upper body at contact also carries the lean / back-tilt from the
    // frame loop (leanX/leanZ at drive = 1), so express the contact point in
    // the body's FULL rotated frame — the inverse of Ry(bodyOpen)Rx(leanXc)
    // Rz(leanZc), the 'YXZ' rotation the upper body uses — not just the yaw,
    // so the sweet spot lands on the real contact point once the whole
    // rotation is applied.
    const lean = batterLean(batX, stanceZ, FIELD.DEFENSE.C.z, bodyOpen, LEG_LEAN)
    const leanXc = lean.rotationX + SWING_BACK_TILT * Math.cos(bodyOpen)
    const leanZc = lean.rotationZ + SWING_BACK_TILT * Math.sin(bodyOpen)
    // The upper body rotates around the hip pivot (HIP_Y), so the contact
    // point is first shifted into the upper body's frame (-hip), the inverse
    // rotation (Ry(-bodyOpen), Rx(-leanXc), Rz(-leanZc)) is applied in that
    // order, and the result is shifted back to the feet-relative frame the
    // geometry works in (+hip).
    const cU = { x: contact.x, y: contact.y - HIP_Y, z: contact.z }
    const ryX = cU.x * Math.cos(bodyOpen) - cU.z * Math.sin(bodyOpen)
    const ryY = cU.y
    const ryZ = cU.x * Math.sin(bodyOpen) + cU.z * Math.cos(bodyOpen)
    const rxX = ryX
    const rxY = ryY * Math.cos(leanXc) + ryZ * Math.sin(leanXc)
    const rxZ = -ryY * Math.sin(leanXc) + ryZ * Math.cos(leanXc)
    const contactRot = {
      x: rxX * Math.cos(leanZc) + rxY * Math.sin(leanZc),
      y: -rxX * Math.sin(leanZc) + rxY * Math.cos(leanZc) + HIP_Y,
      z: rxZ,
    }

    // Hands at contact: reach a fraction of the way from the front of the
    // torso toward the (rotated) ball. The remaining distance (hands -> ball)
    // is the sweet-spot reach, and the direction defines the barrel's contact
    // angle (barrel direction = (-sin, -cos) at rotation.y).
    const handsH = {
      x: HAND_EXTENSION * contactRot.x,
      z: BODY_FRONT_Z + HAND_EXTENSION * (contactRot.z - BODY_FRONT_Z),
    }
    const reach = Math.hypot(contactRot.x - handsH.x, contactRot.z - handsH.z) || 1
    const d = {
      x: (contactRot.x - handsH.x) / reach,
      z: (contactRot.z - handsH.z) / reach,
    }
    const contactY = Math.atan2(-d.x, -d.z)

    // The barrel's direction at contact comes from Statcast's attack angle
    // (the sweet spot's true direction of travel the instant the bat meets the
    // ball), falling back to swing_path_tilt when bat tracking lacks an attack
    // angle. Lower the hands by the same amount the rising barrel gains so the
    // sweet spot still meets the ball, and stretch the bat to cover the longer
    // 3D reach.
    const attackDeg = pitchData?.attack_angle
    const planeDeg = pitchData?.swing_path_tilt
    const tilt = attackDeg != null
      ? THREE.MathUtils.clamp(THREE.MathUtils.degToRad(attackDeg), -CONTACT_TILT_MAX_DEG_RAD, CONTACT_TILT_MAX_DEG_RAD)
      : (planeDeg != null
          ? THREE.MathUtils.clamp(THREE.MathUtils.degToRad(planeDeg), -CONTACT_TILT_MAX_DEG_RAD, CONTACT_TILT_MAX_DEG_RAD)
          : 0)
    // swing_path_tilt shapes the steep swing plane the barrel rides on the way
    // to contact; the animation eases off it onto the attack angle at the
    // instant of contact. Without attack-angle data (or a plane value) it
    // collapses to the contact tilt, matching the old single-value behavior.
    const planeTilt = (planeDeg != null && attackDeg != null)
      ? THREE.MathUtils.clamp(THREE.MathUtils.degToRad(planeDeg), -PLANE_TILT_MAX_DEG_RAD, PLANE_TILT_MAX_DEG_RAD)
      : tilt
    const handsY = contactRot.y - reach * Math.tan(tilt)
    const sweetSpotDist = reach / Math.cos(tilt)
    const batLength = THREE.MathUtils.clamp(
      sweetSpotDist / SWEET_SPOT_FRACTION,
      BAT_LENGTH_MIN,
      BAT_LENGTH_MAX,
    )

    return {
      contactTime: crossing.time,
      loadedY,
      throughY,
      contactY,
      loadedHands,
      // Control point for the hands path: bulge forward (toward the pitcher)
      // so the bat and arms arc around the torso instead of through it.
      handsControl: [
        (loadedHands[0] + handsH.x) / 2,
        (loadedHands[1] + handsY) / 2,
        Math.min(loadedHands[2], handsH.z) - HANDS_PATH_BULGE,
      ],
      contactHands: [handsH.x, handsY, handsH.z],
      batLength,
      tilt,
      planeTilt,
      headYaw,
    }
  }, [pitchData, heightScale, batX, stanceZ, sign, loadedHands, bodyOpen])

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
  const updateArms = (hands, bend, align = 0, batAngle = sign * LOADED_BASE, cockAngle = COCK_ANGLE, tiltAngle = 0) => {
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
  // the pre-swing weight shift ``load``, and the windup-timed front stride:
  // ``stride`` (0..1) advances the front foot toward the pitcher in step with
  // the pitcher's windup and ``strideLift`` (0..1) is the transient foot/knee
  // lift that peaks mid-stride so the foot plants as the windup completes.
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
      const backCrouch = isBack ? LEG_BACK_LOAD_DROP * load : 0
      // The front stride heads toward the pitcher (world -Z), expressed in
      // the lower body's set frame — the local direction of world -Z is
      // (sin(setYaw), -cos(setYaw)).
      const strideAmt = isBack ? 0 : LEG_FRONT_STRIDE * stride
      const strideX = strideAmt * Math.sin(setYaw)
      const strideZ = -strideAmt * Math.cos(setYaw)
      // The hips settle lower during the load, rising back as the drive
      // engages (the upper body drops by the same amount in the frame loop).
      const hipSettle = LEG_HIP_SETTLE * load * (1 - d)
      const kneeY = 0.38
        + (isBack ? LEG_BACK_KNEE_RISE : LEG_FRONT_KNEE_RISE) * d
        - backCrouch
        + (isBack ? 0 : LEG_FRONT_KNEE_LIFT * strideLift * (1 - d))
      const kneeX = side * 0.14 + strideX * 0.5
      const kneeZ = -0.13
        - (isBack ? LEG_BACK_KNEE_FORWARD : LEG_FRONT_KNEE_FORWARD) * d
        - strideZ * 0.5
      const ankleX = side * 0.14 + strideX
      const ankleZ = -0.05
        - (isBack ? LEG_BACK_PUSH_FORWARD : LEG_FRONT_PUSH_FORWARD) * d
        - strideZ
      const hip = [side * 0.14, 0.72 - hipSettle, 0]
      const knee = [kneeX, kneeY, kneeZ]
      // The front foot lifts clearly while striding (windup), then plants as
      // the stride completes; it unplants again briefly as the swing fires.
      let ankleLift = isBack ? 0 : LEG_FRONT_STRIDE_LIFT * strideLift
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
        // plus a compensation for the hips' forward drive (world +Z in the
        // lower frame) so it stays anchored while the hips translate toward
        // the pitcher.
        footX = plantedX - hipDrive * Math.sin(lowerYaw)
        footZ = plantedZ + hipDrive * Math.cos(lowerYaw)
        shoeYaw = -(1 - BACK_FOOT_PIVOT) * openAngle
      } else {
        // Front foot: unplants with the drive and turns with the body.
        footX = THREE.MathUtils.lerp(plantedX, ankleX, drive)
        footZ = THREE.MathUtils.lerp(plantedZ, ankleZ, drive)
        shoeYaw = THREE.MathUtils.lerp(-(1 - FRONT_FOOT_PIVOT) * openAngle, 0, drive)
        ankleLift += LEG_FRONT_UNPLANT_LIFT * drive
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
  // in phase with the Pitch component (which shares the same cycle).
  useEffect(() => {
    clock.current = 0
  }, [pitchData])

  useFrame((state, delta) => {
    const traj = pitchData?.trajectory
    const simDuration = traj?.[traj.length - 1]?.t

    if (!(simDuration > 0) || !batGroupRef.current) {
      // No usable trajectory: hold the set stance with the idle bob.
      const swayPhase = state.clock.elapsedTime * SWAY_SPEED
      const bob = Math.sin(swayPhase) * SWAY_BOB_AMOUNT
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
        batGroupRef.current.rotation.y = sign * LOADED_BASE
      }
      if (cockRef.current) cockRef.current.rotation.x = COCK_ANGLE
      if (tiltRef.current) tiltRef.current.rotation.x = 0
      updateArms(loadedHands, 1)
      return
    }

    // Playback on the shared pitch + batted-ball cycle, scaled by the same
    // time scale as the pitch and batted ball so the swing stays in sync.
    clock.current = (clock.current + delta * getTimeScale()) % getCycleDuration()
    const currentSimTime = clock.current

    // Swing phases driven by the real-time clock, each eased with smoothstep:
    //   l: load, shifting the weight onto the back leg for LOAD_TIME s before
    //      the swing (holds through contact, eases back with the recovery)
    //   e: swing, from SWING_LEAD s before contact up to contact
    //   f: follow-through, FOLLOW_THROUGH s after contact
    //   r: recovery, easing back to the loaded stance over RECOVERY_TIME while
    //      the batted ball is in flight (ready for the next pitch of the cycle)
    const swingStart = geom.contactTime - SWING_LEAD
    const loadStart = swingStart - LOAD_TIME
    const followEnd = geom.contactTime + FOLLOW_THROUGH
    const recoverEnd = followEnd + RECOVERY_TIME
    // The pitcher's windup — mapped onto the post-contact window of the
    // shared cycle so the release lands exactly on the wrap (the same timing
    // the Pitcher component uses) — is when the batter starts his stride and
    // lean-in. Use the same trajectory end time the Pitcher uses as its
    // contact anchor so the two start on the exact same frame.
    const loopDuration = getCycleDuration()
    const trajEnd = traj[traj.length - 1]?.t ?? 0
    const windupStart = Math.max(trajEnd, loopDuration - BALL_RELEASE_TIME)
    const windupDur = Math.max(loopDuration - windupStart, 0.01)

    let load = 0
    let e = 0
    let f = 0
    let r = 0
    if (swing) {
      if (currentSimTime >= loadStart && currentSimTime < swingStart) {
        load = easeSwing((currentSimTime - loadStart) / LOAD_TIME)
      } else if (currentSimTime >= swingStart && currentSimTime < geom.contactTime) {
        e = easeSwing((currentSimTime - swingStart) / SWING_LEAD)
      } else if (currentSimTime >= geom.contactTime && currentSimTime < followEnd) {
        f = easeSwing((currentSimTime - geom.contactTime) / FOLLOW_THROUGH)
      } else if (currentSimTime >= followEnd && currentSimTime < recoverEnd) {
        r = easeSwing((currentSimTime - followEnd) / RECOVERY_TIME)
      }
    }
    // The load's weight shift (back-leg crouch, hip settle, settled lean)
    // holds through the swing and eases back out as the legs recover. The
    // front stride is driven separately by the pitcher's windup below.
    if (swing && currentSimTime >= swingStart && currentSimTime < followEnd) load = 1
    if (swing && currentSimTime >= followEnd && currentSimTime < recoverEnd) load = 1 - r

    // Both the stride and the forward lean start on the exact frame the
    // pitcher starts his windup. The stride eases through the delivery (its
    // foot lift peaks mid-stride), while the body lean ramps linearly across
    // the same window so it keeps visibly moving and reaches full just as the
    // ball leaves the pitcher's hand at the wrap.
    const strideRamp = currentSimTime >= windupStart
      ? easeSwing((currentSimTime - windupStart) / windupDur)
      : 0
    const leanRamp = currentSimTime >= windupStart
      ? clamp((currentSimTime - windupStart) / windupDur, 0, 1)
      : 0

    // Front-foot stride, driven by the same windup progress as the body lean.
    // It starts the moment the windup starts, the foot lift peaks mid-stride,
    // and the foot plants as the body lean settles. It then stays planted
    // through the pitch flight / swing and eases back to the stance after the
    // play (or just after the pitch for a take), ready for the next windup.
    let stride = 0
    let strideLift = 0
    if (currentSimTime >= windupStart) {
      stride = strideRamp
      // Lift only while the foot is actually stepping (0 at start and plant).
      strideLift = Math.sin(Math.PI * strideRamp)
    } else if (swing) {
      if (currentSimTime < followEnd) {
        stride = 1
      } else if (currentSimTime < recoverEnd) {
        stride = 1 - r
      }
    } else {
      const takeSettleEnd = geom.contactTime + LEAN_OUT_TIME
      if (currentSimTime < takeSettleEnd) {
        stride = 1
      } else {
        stride = Math.max(0, 1 - easeSwing((currentSimTime - takeSettleEnd) / LEAN_OUT_TIME))
      }
    }

    // Forward lean-in, synced to the same windup progress as the stride: the
    // batter stands straight while waiting, leans forward in step with the
    // front foot through the windup, holds it through the flight and swing,
    // and eases back to straight after the recovery. Independent of the swing
    // flag, so it also applies to takes.
    let leanIn
    if (currentSimTime >= windupStart) {
      leanIn = leanRamp
    } else if (currentSimTime < loadStart) {
      leanIn = 1
    } else if (currentSimTime >= recoverEnd) {
      const sinceRecover = currentSimTime - recoverEnd
      leanIn = 1 - easeSwing(sinceRecover / LEAN_OUT_TIME)
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
    // chain: back foot/hips fire first (HIPS_LEAD), then the body turn, then
    // the hands.
    let bodyTurn = 0
    if (swing) {
      if (currentSimTime < geom.contactTime) bodyTurn = THREE.MathUtils.clamp(e * BODY_TURN_LEAD, 0, 1)
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
    const swayPhase = state.clock.elapsedTime * SWAY_SPEED
    const bob = Math.sin(swayPhase) * SWAY_BOB_AMOUNT * (1 - open)
    // Hips lead the shoulders: the lower body's opening progress is
    // phase-advanced (HIPS_LEAD) so the legs start turning before the upper
    // body — the kinetic chain of a real swing, with the hips firing first
    // and the torso catching up by contact.
    const lowerOpenYaw = setYaw + (bodyOpen - setYaw) * LOWER_BODY_OPEN_FACTOR
    const lowerOpen = THREE.MathUtils.clamp(open * HIPS_LEAD, 0, 1)
    // The legs drive with the same phase-advanced progress: the knees
    // straighten from the bent crouch and the feet push toward the plate as
    // the swing fires, with a forward lean selling the weight transfer.
    const drive = lowerOpen
    // The back leg recovers to the crouch slightly later than the front leg:
    // through the first BACK_RECOVER_LAG of the recovery it holds its
    // extended drive, then eases back after the front leg has already settled.
    let driveBack = drive
    if (swing && r > 0) {
      const rBack = THREE.MathUtils.clamp((r - BACK_RECOVER_LAG) / (1 - BACK_RECOVER_LAG), 0, 1)
      driveBack = THREE.MathUtils.clamp((1 - rBack) * HIPS_LEAD, 0, 1)
    }

    // Body rotation through the swing: the upper body opens toward the
    // pitcher up to contact (bodyOpen), keeps turning through the
    // follow-through until the chest fully faces the pitcher (FULL_OPEN_YAW),
    // then unwinds back to the set stance during recovery. The hips ride the
    // same arc at a fraction of the rotation (LOWER_BODY_OPEN_FACTOR),
    // phase-advanced to lead the shoulders into the swing.
    const hipFullOpenYaw = setYaw + (FULL_OPEN_YAW - setYaw) * LOWER_BODY_OPEN_FACTOR
    let bodyYaw = setYaw
    let lowerYaw = setYaw
    if (swing) {
      if (currentSimTime < geom.contactTime) {
        bodyYaw = THREE.MathUtils.lerp(setYaw, bodyOpen, bodyTurn)
        lowerYaw = THREE.MathUtils.lerp(setYaw, lowerOpenYaw, lowerOpen)
      } else if (currentSimTime < followEnd) {
        bodyYaw = THREE.MathUtils.lerp(bodyOpen, FULL_OPEN_YAW, f)
        lowerYaw = THREE.MathUtils.lerp(lowerOpenYaw, hipFullOpenYaw, f)
      } else if (currentSimTime < recoverEnd) {
        bodyYaw = THREE.MathUtils.lerp(FULL_OPEN_YAW, setYaw, r)
        lowerYaw = THREE.MathUtils.lerp(hipFullOpenYaw, setYaw, r)
      }
    }
    // Whole-body forward push: ramps in with the back-leg drive, then eases
    // back over the PUSH_SETTLE_TIME before contact, settling to
    // PUSH_SETTLE_LEVEL through the follow-through so the batter settles into
    // the plate instead of drifting forward past contact (the recovery then
    // relaxes it fully). Drives the hips forward (HIP_DRIVE_FORWARD) and the
    // upper body's smaller push (UPPER_DRIVE_FORWARD).
    let push = drive
    if (swing) {
      if (currentSimTime >= geom.contactTime - PUSH_SETTLE_TIME && currentSimTime < geom.contactTime) {
        push = THREE.MathUtils.lerp(
          drive,
          PUSH_SETTLE_LEVEL,
          (currentSimTime - (geom.contactTime - PUSH_SETTLE_TIME)) / PUSH_SETTLE_TIME,
        )
      } else if (currentSimTime >= geom.contactTime && currentSimTime < followEnd) {
        push = PUSH_SETTLE_LEVEL
      } else if (currentSimTime >= followEnd && currentSimTime < recoverEnd) {
        push = PUSH_SETTLE_LEVEL * (1 - r)
      }
    }
    const hipDrive = HIP_DRIVE_FORWARD * push
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
      // leg during the load, and holding a stronger lean (LEG_LEAN) through
      // the swing as the back leg drives the rotation.
      const leanMag = THREE.MathUtils.lerp(SET_LEAN * leanIn, LEG_LEAN, drive)
      const lean = batterLean(batX, stanceZ, FIELD.DEFENSE.C.z, bodyYaw, leanMag)
      let leanX = lean.rotationX + LOAD_LEAN_BACK * load * (1 - drive)
      let leanZ = lean.rotationZ
      // As the back leg unbuckles, the body also tilts back toward the
      // catcher (world +Z) while the hips drive forward — expressed in the
      // live frame so the tilt always points at the catcher, and held through
      // the follow-through as the back leg stays driven.
      const backTilt = SWING_BACK_TILT * drive
      leanX += backTilt * Math.cos(bodyYaw)
      leanZ += backTilt * Math.sin(bodyYaw)
      upperRef.current.rotation.x = leanX
      upperRef.current.rotation.z = leanZ
      // The back leg firing pushes the whole body forward toward the pitcher
      // a little (the hips lead with HIP_DRIVE_FORWARD; the torso follows
      // with UPPER_DRIVE_FORWARD, which the contact geometry compensates for).
      upperRef.current.position.z = -UPPER_DRIVE_FORWARD * push
      // The hips settle lower during the load (the whole upper body drops with
      // them), rising back as the drive engages.
      upperRef.current.position.y = HIP_Y + bob - LEG_HIP_SETTLE * load * (1 - drive)
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
      let tilt = HEAD_TILT_MAX * open
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
            ? THREE.MathUtils.clamp(Math.atan2(dy, dist), -HEAD_TRACK_TILT_DOWN, HEAD_TRACK_TILT_UP)
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
    let cockAngle = COCK_ANGLE
    let tiltAngle = 0
    let bend = 1
    if (swing) {
      if (currentSimTime < geom.contactTime) {
        cockAngle = COCK_ANGLE * (1 - e)
        tiltAngle = geom.tilt * e + (geom.planeTilt - geom.tilt) * Math.sin(Math.PI * e) ** 2
        bend = 1 - e
      } else if (currentSimTime < followEnd) {
        cockAngle = 0
        tiltAngle = THREE.MathUtils.lerp(geom.tilt, geom.planeTilt, f)
        bend = 0
      } else if (currentSimTime < recoverEnd) {
        cockAngle = COCK_ANGLE * r
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
            <group ref={batGroupRef} position={loadedHands} rotation={[0, sign * LOADED_BASE, 0]}>
              <group ref={cockRef} rotation={[COCK_ANGLE, 0, 0]}>
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
