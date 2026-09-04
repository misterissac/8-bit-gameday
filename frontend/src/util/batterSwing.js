import { PLATE_FRONT_Y, clamp, degToRad, plateCrossing } from './MathUtil.js'
import { batterLean } from './batterLean.js'
import { FIELD } from '../constants/field.js'

// Baseline anchor: a standard 90 mph pitch peaks at 0.75 through the swing phase.
export const SWING_PEAK_BASELINE_MPH = 90
export const SWING_PEAK_BASELINE_FRAC = 0.75

// Rate of shift: +0.0075 per mph (+0.075 per 10 mph).
// A 70 mph curveball shifts earlier (~0.60), letting the batter stay back and
// coast into contact. A 104 mph heater shifts later (~0.855), keeping the
// forward drive accelerating almost all the way to contact for an explosive
// late burst.
export const SWING_PEAK_PER_MPH = 0.0075

// Clamp bounds for automatic swing peak timing to keep the acceleration and
// deceleration segments well-formed and visually natural.
export const SWING_PEAK_AUTO_MIN = 0.55
export const SWING_PEAK_AUTO_MAX = 0.88

// Swing geometry and contact constants
export const SWEET_SPOT_FRACTION = 0.78
export const BAT_LENGTH_MIN = 0.85
export const BAT_LENGTH_MAX = 1.18
export const HIP_Y = 0.72
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
 * Resolves where in the swing phase (plant -> settle start) the body's forward
 * speed peaks.
 *
 * When manual (swingPeakSetting > 0), uses the explicit setting clamped to [0.05, 0.95].
 * When automatic (swingPeakSetting <= 0 or omitted), faster pitches shift the peak later
 * so the batter's maximal surge syncs closer to contact:
 *   - Slower pitches (e.g. 70 mph) peak earlier (~0.60) so the batter stays back and rides through.
 *   - Standard pitches (90 mph) peak at 0.75.
 *   - Fast pitches (100+ mph) shift the peak late (~0.83–0.88) so the maximal surge explodes right into the ball.
 *
 * @param {number|null|undefined} swingPeakSetting - Tuned value (0 or null = auto)
 * @param {number|null|undefined} pitchSpeedMph - Pitch speed in mph
 * @returns {number} Fraction of swing phase (0.05 to 0.95)
 */
export function resolveSwingPeak(swingPeakSetting, pitchSpeedMph) {
  const manual = Number(swingPeakSetting)
  if (Number.isFinite(manual) && manual > 0) {
    return clamp(manual, 0.05, 0.95)
  }

  const speed = Number.isFinite(Number(pitchSpeedMph))
    ? Number(pitchSpeedMph)
    : SWING_PEAK_BASELINE_MPH

  const clampedSpeed = clamp(speed, 60, 110)
  const autoPeak = SWING_PEAK_BASELINE_FRAC + (clampedSpeed - SWING_PEAK_BASELINE_MPH) * SWING_PEAK_PER_MPH
  return clamp(autoPeak, SWING_PEAK_AUTO_MIN, SWING_PEAK_AUTO_MAX)
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
}) {
  const traj = pitchData?.trajectory
  if (!traj || traj.length === 0) return null
  const crossing = plateCrossing(traj)

  const loadedY = sign * settings.loadedBaseAngle
  const throughY = sign * settings.throughBaseAngle

  // Contact point in the height-scaled frame. The batter group sits at
  // (batX, 0, stanceZ) in world space and the plate front is at world
  // z = -PLATE_FRONT_Y, so:
  const contact = {
    x: (crossing.x - batX) / heightScale,
    y: crossing.height / heightScale,
    // The whole body pushes forward by the time the swing reaches contact
    // (settings.upperDriveForward, eased back to settings.pushSettleLevel at contact), so
    // the ball sits that much closer to the body.
    z: (-PLATE_FRONT_Y - stanceZ) / heightScale + settings.upperDriveForward * settings.pushSettleLevel / heightScale,
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
  const lean = batterLean(batX, stanceZ, catcherZ, bodyOpen, settings.legLean)
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
 * 3. Upper body translation: [0, HIP_Y, -upperDriveForward * pushSettleLevel]
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
  const { contactHands, contactY, tilt, sweetSpotDist, leanXc, leanZc } = geom

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

  // Shift back from hip pivot and add upperRef forward position:
  const upperPosZ = (-settings.upperDriveForward * settings.pushSettleLevel) / heightScale
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
