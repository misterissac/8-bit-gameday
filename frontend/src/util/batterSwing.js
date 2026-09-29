import { PLATE_FRONT_Y, clamp, degToRad, plateCrossing } from './MathUtil.js'
import { batterLean } from './batterLean.js'
import { FIELD } from '../constants/field.js'

// Baseline anchor: the speed a pitch is assumed to be when nothing says otherwise.
// It is the sweep's own fallback rather than a timing: where the body's forward
// drive peaks is not a pitch-speed question any more (see the drive in Batter.jsx,
// whose fastest frame is the contact frame whatever the pitch does).
export const SWING_PEAK_BASELINE_MPH = 90

// Swing geometry and contact constants
export const SWEET_SPOT_FRACTION = 0.78
export const BAT_LENGTH_MIN = 0.85
// The longest the bat may grow before the sweet spot stops reaching the ball.
// It is what sets the batter's *place* in the box: the bat has to make up
// whatever distance the body's own travel leaves (see STANCE_SETBACK_M in
// Batter.jsx), and the drive's ride is itself bounded by how far the planted rear
// leg can reach its footprint (see the rear-foot block there) — so a rework of
// the drive that shortens the ride feeds straight into how long the bat is
// allowed to become. A re-fit that wants a shorter bat has to buy it back from
// the two things on the other side of the ledger: the stance's depth and how far
// the hands reach (settings.handExtension).
export const BAT_LENGTH_MAX = 2.6
export const HIP_Y = 1.04
export const BODY_FRONT_Z = -0.28
export const HEAD_YAW_MAX = 0.8

/**
 * Extracts or computes the pitch speed in mph from pitchData.
 * Falls back to trajectory velocity or 90 mph if speed is not available.
 *
 * @param {object|null|undefined} pitchData
 * @returns {number} Speed in mph
 */
export function resolvePitchSpeedMph(pitchData) {
  if (pitchData?.speed_mph != null && Number.isFinite(Number(pitchData.speed_mph))) {
    return Number(pitchData.speed_mph)
  }
  const traj = pitchData?.trajectory
  if (Array.isArray(traj) && traj.length >= 2) {
    const p0 = traj[0]
    const p1 = traj[traj.length - 1]
    const dt = (p1?.t ?? 0) - (p0?.t ?? 0)
    if (dt > 0.05) {
      const dist = Math.hypot(
        (p1.x ?? 0) - (p0.x ?? 0),
        (p1.y ?? 0) - (p0.y ?? 0),
        (p1.z ?? 0) - (p0.z ?? 0),
      )
      // 1 m/s = 1 / 0.44704 mph
      const mph = (dist / dt) / 0.44704
      if (Number.isFinite(mph) && mph >= 30 && mph <= 140) {
        return mph
      }
    }
  }
  return SWING_PEAK_BASELINE_MPH
}

/**
 * Calculates the complete swing geometry derived from pitch trajectory:
 * the contact point, hands-at-contact position, barrel contact angle,
 * bat length, and attack angle / swing plane tilt.
 *
 * @param {object} params
 * @param {object} params.pitchData
 * @param {number} params.batX
 * @param {number} params.stanceZ
 * @param {number} [params.heightScale=1]
 * @param {number} [params.sign=1]
 * @param {number} [params.bodyOpen=0.6]
 * @param {number[]} [params.loadedHands=[0.35, 1.35, -0.15]]
 * @param {object} params.settings
 * @param {number} [params.catcherZ]
 * @param {{batX: number, stanceZ: number}|null} [params.leanAt=null] where the
 *   body is taken to be standing *for the lean's own direction* — the batter
 *   stands beside the plate and leans over it, and the animation's lean is posed
 *   about the stance it was tuned at, so a batter set back in the box poses the
 *   lean from there (see STANCE_SETBACK_M in Batter.jsx). Defaults to the contact
 *   geometry's own position, which is where the animation measures it from when
 *   nothing is set back.
 * @param {number|null} [params.driveRide=null] how far forward toward the pitcher
 *   the whole body has actually travelled at the contact, in the height-scaled
 *   frame (rig units). The animation bounds the pelvis' ride by the planted rear
 *   leg's own span (see the drive's rear-foot block in Batter.jsx), so the travel
 *   the ball is met against is the bounded one and not the tuning's own
 *   ``hipDriveForward + upperDriveForward``; the geometry has to be handed the
 *   travel the pose actually makes or the sweet spot would be drawn for a body
 *   that is somewhere else. Defaults to the tuning's full travel, which is what
 *   every caller that does not bound the drive sees.
 * @returns {object|null} Swing geometry
 */
export function calculateSwingGeometry({
  pitchData,
  batX,
  stanceZ,
  heightScale = 1,
  sign = 1,
  bodyOpen = 0.6,
  loadedHands = [0.35, 1.35, -0.15],
  settings,
  catcherZ = FIELD.DEFENSE.C.z,
  leanAt = null,
  driveRide = null,
}) {
  const traj = pitchData?.trajectory
  if (!traj || traj.length === 0) return null
  const crossing = plateCrossing(traj)

  const loadedY = sign * settings.loadedBaseAngle
  const throughY = sign * settings.throughBaseAngle

  // How far the body has ridden forward toward the pitcher by the contact, in
  // the height-scaled frame: the hips' own lunge (settings.hipDriveForward) and
  // the torso's push on top of it (settings.upperDriveForward) — unless the
  // animation bounded the ride by the planted rear leg's span, in which case that
  // bounded travel is what the pose makes and what the ball has to be measured
  // against. The shipped swing always bounds it: the drive's own scale *is* that
  // leg's budget (see the frame loop in Batter.jsx), so what is left here is the
  // drive's full ask, for a caller that stands the body somewhere else.
  const rideAtContact = driveRide == null
    ? (settings.hipDriveForward + settings.upperDriveForward) / heightScale
    : driveRide

  // Contact point in the height-scaled frame. The batter group sits at
  // (batX, 0, stanceZ) in world space and the plate front is at world
  // z = -PLATE_FRONT_Y, so:
  const contact = {
    x: (crossing.x - batX) / heightScale,
    y: crossing.height / heightScale,
    // The whole body pushes forward by the time the swing reaches contact — the
    // hips' own lunge (settings.hipDriveForward) and the torso's push on top of
    // it (settings.upperDriveForward) — so the ball sits that much closer to
    // the body. The bat hangs in the body's own frame (upperRef, which carries
    // exactly this travel), so both halves of the drive move the ball closer in
    // that frame, not one of them.
    z: (-PLATE_FRONT_Y - stanceZ) / heightScale + rideAtContact,
  }

  // Head yaw to look at the ball at the plate. The head's face is its local
  // -Z, so the world yaw that faces the contact point is atan2(-dx, -dz) for
  // the horizontal offset (dx, dz) from the head to the contact point (the
  // head sits at x=batX, z=stanceZ; the contact point is at x=crossing.x,
  // z=-PLATE_FRONT_Y). The head is inside the upper body (rotation.y =
  // bodyOpen), so the local yaw subtracts the body's turn.
  const headDx = crossing.x - batX
  const headDz = -PLATE_FRONT_Y - stanceZ
  const headYaw = clamp(
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
  const lean = batterLean(
    leanAt?.batX ?? batX,
    leanAt?.stanceZ ?? stanceZ,
    catcherZ,
    bodyOpen,
    settings.legLean,
  )
  const leanXc = lean.rotationX + settings.swingBackTilt * Math.cos(bodyOpen)
  const leanZc = lean.rotationZ + settings.swingBackTilt * Math.sin(bodyOpen)

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
    x: settings.handExtension * contactRot.x,
    z: BODY_FRONT_Z + settings.handExtension * (contactRot.z - BODY_FRONT_Z),
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
  const maxContactTilt = degToRad(settings.contactTiltMaxDeg)
  const maxPlaneTilt = degToRad(settings.planeTiltMaxDeg)

  const tilt = attackDeg != null
    ? clamp(degToRad(attackDeg), -maxContactTilt, maxContactTilt)
    : (planeDeg != null
        ? clamp(degToRad(planeDeg), -maxContactTilt, maxContactTilt)
        : 0)

  // swing_path_tilt shapes the steep swing plane the barrel rides on the way
  // to contact; the animation eases off it onto the attack angle at the
  // instant of contact. Without attack-angle data (or a plane value) it
  // collapses to the contact tilt, matching the old single-value behavior.
  const planeTilt = (planeDeg != null && attackDeg != null)
    ? clamp(degToRad(planeDeg), -maxPlaneTilt, maxPlaneTilt)
    : tilt

  const handsY = contactRot.y - reach * Math.tan(tilt)
  const sweetSpotDist = reach / Math.cos(tilt)
  const batLength = clamp(
    sweetSpotDist / SWEET_SPOT_FRACTION,
    BAT_LENGTH_MIN,
    BAT_LENGTH_MAX,
  )

  return {
    contactTime: crossing.time,
    crossing,
    loadedY,
    throughY,
    contactY,
    loadedHands,
    // Control point for the hands path: bulge forward (toward the pitcher)
    // so the bat and arms arc around the torso instead of through it.
    handsControl: [
      (loadedHands[0] + handsH.x) / 2,
      (loadedHands[1] + handsY) / 2,
      Math.min(loadedHands[2], handsH.z) - settings.handsPathBulge,
    ],
    contactHands: [handsH.x, handsY, handsH.z],
    batLength,
    reach,
    sweetSpotDist,
    tilt,
    planeTilt,
    headYaw,
    contactRot,
    contact,
    leanXc,
    leanZc,
    // The travel the contact point was measured against, so the forward-kinematics
    // helper below — and every caller that reads the pose back — puts the bat in
    // the same place the geometry just did.
    driveRide: rideAtContact,
  }
}

/**
 * Computes the bat tilt angle along the swing path as a function of swing progress e (0 -> 1).
 *
 * The barrel rides up on the steep swing plane shaped by planeTilt (from Statcast swing_path_tilt),
 * and smoothly flattens onto the true attack angle (tilt) at contact (e = 1).
 * The sine-squared bump is exactly 0 at e = 0 and e = 1, ensuring the attack angle at contact
 * is exact regardless of how steep the swing plane is.
 *
 * @param {number} e - Swing progress (0 = swing start, 1 = contact)
 * @param {number} tilt - Attack angle in radians
 * @param {number} planeTilt - Swing plane tilt in radians
 * @returns {number} Bat tilt angle in radians
 */
export function computeBatTiltAtProgress(e, tilt, planeTilt) {
  const progress = clamp(e, 0, 1)
  return tilt * progress + (planeTilt - tilt) * Math.sin(Math.PI * progress) ** 2
}

/**
 * Forward kinematics of the bat's sweet spot in world space at the instant of contact.
 *
 * Evaluates the full transformation hierarchy of the 3D batter rig at contact:
 * 1. Batter base position: [batX, 0, stanceZ]
 * 2. Uniform height scale: heightScale
 * 3. Upper body translation: [0, HIP_Y, -driveRide] (the drive's own travel)
 * 4. Upper body rotation around [0, HIP_Y, 0]: Order 'YXZ' with
 *    rotation.y = bodyOpen, rotation.x = leanXc, rotation.z = leanZc
 * 5. Bat group at hands position: contactHands
 * 6. Bat group rotation.y = contactY
 * 7. Bat tilt group rotation.x = tilt (cockAngle = 0 at contact)
 * 8. Sweet spot at distance sweetSpotDist along local barrel (-Z)
 *
 * @param {object} geom - Swing geometry returned by calculateSwingGeometry
 * @param {object} settings - Batter animation tuning settings
 * @param {object} batterParams - Batter instance parameters { batX, stanceZ, heightScale, bodyOpen }
 * @returns {{ x: number, y: number, z: number }} World-space coordinates of the sweet spot
 */
export function forwardKinematicsSweetSpotAtContact(geom, settings, batterParams) {
  const { batX, stanceZ, heightScale = 1, bodyOpen = 0.6 } = batterParams
  const { contactHands, contactY, tilt, sweetSpotDist, leanXc, leanZc, driveRide } = geom

  // 1. Vector from hands to sweet spot in batGroup local frame:
  // Barrel points along local -Z and rotates around X by tilt.
  const yBarrel = sweetSpotDist * Math.sin(tilt)
  const zBarrel = -sweetSpotDist * Math.cos(tilt)

  // 2. Bat group rotates around Y by contactY:
  // Rotation around Y by contactY on [0, yBarrel, zBarrel]:
  const xBat = zBarrel * Math.sin(contactY)
  const yBat = yBarrel
  const zBat = zBarrel * Math.cos(contactY)

  // 3. Bat group sits at contactHands inside upperRef (offset by [0, -HIP_Y, 0]):
  const pRelativeHip = {
    x: contactHands[0] + xBat,
    y: contactHands[1] + yBat - HIP_Y,
    z: contactHands[2] + zBat,
  }

  // 4. Upper body rotates around hip pivot in 'YXZ' order (Rz, then Rx, then Ry):
  // Rz(leanZc):
  const v1X = pRelativeHip.x * Math.cos(leanZc) - pRelativeHip.y * Math.sin(leanZc)
  const v1Y = pRelativeHip.x * Math.sin(leanZc) + pRelativeHip.y * Math.cos(leanZc)
  const v1Z = pRelativeHip.z

  // Rx(leanXc):
  const v2X = v1X
  const v2Y = v1Y * Math.cos(leanXc) - v1Z * Math.sin(leanXc)
  const v2Z = v1Y * Math.sin(leanXc) + v1Z * Math.cos(leanXc)

  // Ry(bodyOpen):
  const v3X = v2X * Math.cos(bodyOpen) + v2Z * Math.sin(bodyOpen)
  const v3Y = v2Y
  const v3Z = -v2X * Math.sin(bodyOpen) + v2Z * Math.cos(bodyOpen)

  // Shift back from hip pivot and add upperRef forward position — the same
  // travel ``contact`` above was measured against, or the two would not agree on
  // where the bat is. That travel is the geometry's own ``driveRide``, so a swing
  // whose ride the animation has bounded reads back on the ball too:
  const upperPosZ = -(driveRide ??
    (settings.hipDriveForward + settings.upperDriveForward) / heightScale)
  const pUpperWorld = {
    x: v3X,
    y: v3Y + HIP_Y,
    z: v3Z + upperPosZ,
  }

  // 5. Apply heightScale and world offset [batX, 0, stanceZ]:
  return {
    x: batX + pUpperWorld.x * heightScale,
    y: pUpperWorld.y * heightScale,
    z: stanceZ + pUpperWorld.z * heightScale,
  }
}

// ---------------------------------------------------------------------------
// The set stance's idle.
//
// A batter waiting on a pitch is never still: he rocks his weight from foot to
// foot, his knees give and take, and the bat waggles in his hands. What he does
// *not* do is rise and fall as a block — his feet stay nailed to the ground and
// the body's height is the knees' business. That distinction is the whole of
// this shape, and it is the one the old bob got wrong: it moved the hips up and
// down around the stance, and above the stance there is nothing left to give
// (the rig's legs are at full stretch there), so the ankles rose with the hips
// and the shoes came off the ground — measured, 3.9 cm of it, heel first.
//
// So the wave is one-sided: it goes *down* from the stance and comes back, and
// the stance itself is its own top. "Way down" is a knee flex (see idleCrouch),
// which the hips then follow.
// How far the bat's own waggle lags the body's rock, in radians of the idle clock.
// A bat held in loose hands trails the hands that are carrying it, which is what
// keeps the waggle reading as the bat's own motion rather than a second bob.
export const IDLE_WAGGLE_PHASE = 1.3

/**
 * The idle's own clock, as two shapes on one period: the crouch (0 at the stance,
 * 1 at the deepest point) and the bat's waggle (-1..1, the same rate, lagging).
 *
 * The crouch's own shape is (1 - cos) / 2 rather than |sin|: it leaves and
 * returns to the stance smoothly, with no corner at the top of the wave, which
 * is where a bob that "bounces" off a rectified sine reads as a bounce off a
 * wall.
 *
 * The *rock* is this same shape, not a second one: read off the reference idle
 * clip (solomon-gumball's BattingIdle, two identical cycles in 2.46 s), the
 * pelvis's lateral travel and its vertical travel move together — 3.05 cm across
 * as it drops 4.37 cm, reaching both extremes on the same frame — so the weight
 * shift *is* the crouch rather than something happening alongside it. A batter
 * rocks onto a foot as his knees give, and comes back up over the other as they
 * straighten; there is no frame of that clip where he is crouched and centred.
 *
 * @param {number} phase radians on the idle clock (elapsed * swaySpeed)
 * @returns {{crouch: number, waggle: number}}
 */
export function idleStance(phase) {
  return {
    crouch: (1 - Math.cos(phase)) / 2,
    waggle: Math.sin(phase + IDLE_WAGGLE_PHASE),
  }
}

/**
 * How far the hips drop when the knees flex, for a leg that cannot stretch.
 *
 * A leg is two rigid links and a planted foot, so the hip sits at whatever
 * distance the knee's own angle puts it from the ankle: d = sqrt(t^2 + s^2 -
 * 2ts cos(theta)) for a thigh t, a shin s and an interior knee angle theta, and
 * the hip's *height* above the ankle is that distance with the ankle's own
 * horizontal offset taken out, sqrt(d^2 - horizontal^2). The stance's own
 * distance fixes theta at rest, so a request to flex the knee by ``flex`` is a
 * request to drop the hips by exactly this much — and asking for the drop any
 * other way is what lets the driver pull a foot off the ground. Flexing is
 * *smaller* theta: a straight leg is the interior angle's own maximum, 180
 * degrees, and there is nothing above it to ask for (which is why the idle's
 * wave has to be the side of the stance that flexes).
 *
 * The caller takes the *smallest* drop its two legs imply: the legs share one
 * pelvis, so the one that can give less is the one the drop has to respect, and
 * no leg is ever left asking for more length than it has.
 *
 * @param {object} leg the leg's own measurements, in rig units
 * @param {number} leg.flex radians of extra knee flexion at the deepest point
 * @param {number} leg.thigh thigh length
 * @param {number} leg.shin shin length
 * @param {number} leg.rise hip joint's height above the planted ankle at the stance
 * @param {number} leg.horizontal hip-to-ankle horizontal offset at the stance
 * @returns {number} how far the hips must drop, in rig units (>= 0)
 */
export function idleCrouch({ flex, thigh, shin, rise, horizontal }) {
  if (!(flex > 0) || !(thigh > 0) || !(shin > 0) || !(rise > 0)) return 0
  const rest = Math.hypot(horizontal, rise)
  // The stance's own knee angle. A stance that already sits at the bones' own
  // span has no angle to speak of (the leg is straight), and a request to flex
  // from there is measured from straight: the acos is clamped, so the arithmetic
  // below cannot ask for a leg longer than the bones.
  const cosRest = clamp((thigh * thigh + shin * shin - rest * rest) / (2 * thigh * shin), -1, 1)
  const restAngle = Math.acos(cosRest)
  const angle = Math.max(0, restAngle - flex)
  const reach = Math.sqrt(Math.max(0, thigh * thigh + shin * shin - 2 * thigh * shin * Math.cos(angle)))
  if (!(reach < rest)) return 0
  const riseNow = Math.sqrt(Math.max(0, reach * reach - horizontal * horizontal))
  return Math.max(0, rise - riseNow)
}
