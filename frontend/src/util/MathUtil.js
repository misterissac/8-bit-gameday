import { Vector3 } from 'three'

// ---------------------------------------------------------------------------
// Unit conversions + small helpers.
// Ported from solomon-gumball:baseball-sim-main/src/util/MathUtil.tsx
// (kept as a read-only reference directory).
// ---------------------------------------------------------------------------

export const feetToM = (feet) => feet * 0.3048
export const inchesToM = (inches) => (inches / 12) * 0.3048
export const mphToMetersPerSecond = (mph) => mph * 0.44704

export const clamp = (v, min, max) => Math.max(min, Math.min(v, max))
export const lerp = (a, b, t) => a + (b - a) * t
export const degToRad = (deg) => (deg * Math.PI) / 180

// ---------------------------------------------------------------------------
// Batted-ball trajectory: a symmetrical parabolic arc between a launch point
// and a landing point. ``positionAtTime`` returns three.js world coordinates
// (x = left/right, y = height, z = depth toward the field).
//
// Faithful port of solomon-gumball's ``makeSymmetricalArc``. Note the argument
// convention matches the reference exactly:
//   (x0, y0, z0) = launch point  -> x0/xf horizontal X, y0/yf horizontal Z,
//                                   z0/zf vertical height
//   (xf, yf, zf) = landing point
//   speed        = launch speed (m/s)
//   launchAngle  = launch angle (degrees)
// ---------------------------------------------------------------------------
export function makeSymmetricalArc(x0, y0, z0, xf, yf, zf, speed, launchAngle) {
  return {
    positionAtTime(time) {
      const launchAngleRad = degToRad(launchAngle)

      // Horizontal distance between launch and landing points.
      const horizontalDistance = Math.sqrt((xf - x0) ** 2 + (yf - y0) ** 2)

      // Horizontal velocity component.
      const horizontalSpeed = speed * Math.cos(launchAngleRad)

      // Total flight time based on horizontal speed.
      const totalTime = horizontalDistance / horizontalSpeed

      // Horizontal position (linear interpolation).
      const x = x0 + (xf - x0) * (time / totalTime)
      const y = y0 + (yf - y0) * (time / totalTime)

      // Maximum height (vertex of the parabola).
      const maxHeight = z0 + (horizontalDistance / 2) * Math.tan(launchAngleRad)

      // Parabolic interpolation for the vertical position.
      const z =
        z0 +
        (maxHeight - z0) * (1 - (2 * time / totalTime - 1) ** 2) +
        (zf - z0) * (time / totalTime)

      return new Vector3(x, z, y)
    },
    totalDuration() {
      const launchAngleRad = degToRad(launchAngle)
      const vx = speed * Math.cos(launchAngleRad)
      const horizontalDistance = Math.sqrt((xf - x0) ** 2 + (yf - y0) ** 2)
      return horizontalDistance / vx
    },
  }
}

// ---------------------------------------------------------------------------
// Fielder trajectory: compute the first possible intersection point between a
// ball moving at constant speed along ``ballDir`` and a fielder sprinting at
// ``catcherSpeed`` from ``catcherPos``. Returns { location, t, requiredCatcherSpeed }.
//
// Faithful port of solomon-gumball's ``findIntersection``.
// ---------------------------------------------------------------------------
export function findIntersection(
  ballPos,
  ballDir,
  ballSpeed,
  catcherPos,
  catcherSpeed,
  startingInterceptTime,
) {
  let t = startingInterceptTime
  const deltaT = 0.01
  const MAX_SECONDS = 5
  let lastDistance = Infinity

  while (t < MAX_SECONDS) {
    const dirClone = ballDir.clone()
    const currentBallPos = ballPos.clone().add(dirClone.multiplyScalar(ballSpeed * t))
    const dist = currentBallPos.distanceTo(catcherPos)
    const catcherMaxDistance = t * catcherSpeed

    const shouldOverrideResolve = lastDistance < dist && ballSpeed > catcherSpeed
    if (dist < catcherMaxDistance || shouldOverrideResolve) {
      return { location: currentBallPos, t, requiredCatcherSpeed: dist / t }
    }
    lastDistance = dist
    t += deltaT
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Generalized fielded-ball interception. Same sprint-toward-the-ball model as
// ``findIntersection`` (the fielder runs from ``catcherPos`` at ``catcherSpeed``
// and catches the first ball they can reach), but the ball's ground speed is
// piecewise: it flies at ``airSpeed`` for the first ``airTime`` seconds (the arc
// to its landing), then rolls at ``rollSpeed``. This is what lets a ground-ball
// roll-speed tuning knob change how far the ball gets before the fielder fields
// it while keeping ball and fielder converging on the same catch point/time.
// When ``rollSpeed === airSpeed`` it degenerates to ``findIntersection`` exactly
// (``contactDistance`` must then be ``airSpeed * airTime``).
// ---------------------------------------------------------------------------
export function resolveFieldedIntercept(
  ballPos,
  ballDir,
  airSpeed,
  rollSpeed,
  airTime,
  contactDistance,
  catcherPos,
  catcherSpeed,
) {
  let t = 0
  const deltaT = 0.01
  const MAX_SECONDS = 5
  let lastDistance = Infinity
  while (t < MAX_SECONDS) {
    // Ground distance from the launch point: air phase then roll phase.
    const d = t <= airTime
      ? airSpeed * t
      : contactDistance + rollSpeed * (t - airTime)
    const pos = ballPos.clone().add(ballDir.clone().multiplyScalar(d))
    const dist = pos.distanceTo(catcherPos)
    const catcherMaxDistance = t * catcherSpeed
    const currentSpeed = t <= airTime ? airSpeed : rollSpeed
    const shouldOverrideResolve = lastDistance < dist && currentSpeed > catcherSpeed
    if (dist < catcherMaxDistance || shouldOverrideResolve) {
      return { location: pos, t, requiredCatcherSpeed: dist / t }
    }
    lastDistance = dist
    t += deltaT
  }
  return undefined
}

// Horizontal (ground-plane) component of launch speed.
export function getBallXYSpeed(launchSpeed, elevationAngle) {
  const phiRadians = degToRad(elevationAngle)
  return launchSpeed * Math.cos(phiRadians)
}

// Statcast batted-ball spray angle from hit coordinates (hc_x / hc_y).
// Mirrors solomon-gumball's computeSprayAngle.
export function computeSprayAngle(hc_x, hc_y) {
  const angle = (Math.atan((hc_x - 125) / (199 - hc_y)) * 180) / Math.PI * 0.75
  return Math.round(angle * 10) / 10
}

// Landing point for a batted ball, mapped into THIS app's coordinate system:
// +X = first-base side, -Z = toward the outfield. Mirrors solomon-gumball's
// getLandingLocation (which lands in +Z), with the X/Z signs flipped to match
// the convention used by Scene.jsx / Pitch.jsx.
export function getLandingLocation(totalDistanceFt, sprayAngleDeg) {
  const totalDistance = -feetToM(totalDistanceFt)
  const deg = degToRad(sprayAngleDeg - 90)
  return new Vector3(
    -Math.cos(deg) * totalDistance,
    0,
    -Math.sin(deg) * totalDistance,
  )
}

// Convert raw Statcast hit coordinates (hc_x / hc_y) straight into this app's
// world coordinates, skipping the total-distance + spray-angle reconstruction.
//
// Statcast hit coordinates are a scaled field map: home plate sits at
// (125.42, 198.27) and one coordinate unit is ~2.5 feet (sportyR / Jim Albert
// convention). Larger hc_x leans toward first base (+X here), while smaller
// hc_y reaches deeper into the outfield (-Z here).
export function statcastHitToWorld(coordX, coordY) {
  const STATCAST_PLATE_X = 125.42
  const STATCAST_PLATE_Y = 198.27
  const STATCAST_UNIT_FT = 2.5

  const xFeet = STATCAST_UNIT_FT * (coordX - STATCAST_PLATE_X)
  const yFeet = STATCAST_UNIT_FT * (coordY - STATCAST_PLATE_Y) // negative = outfield
  return new Vector3(feetToM(xFeet), 0, feetToM(yFeet))
}

// The front edge of home plate is 17 inches from its back tip, in meters. The
// physics trajectory's ``y`` (depth) crosses this value just as the ball
// enters the strike zone — the reference moment for the swing/contact.
export const PLATE_FRONT_Y = 0.4318

// Interpolate the exact simulation time, height, and horizontal position at
// which the ball crosses the front of home plate. The trajectory's ``z`` is
// the ball's height in meters and ``x`` its horizontal offset, so this gives
// the contact point the swing should meet the ball at.
export function plateCrossing(trajectoryData) {
  for (let i = 0; i < trajectoryData.length - 1; i++) {
    const p1 = trajectoryData[i]
    const p2 = trajectoryData[i + 1]
    if (p1.y > PLATE_FRONT_Y && p2.y <= PLATE_FRONT_Y) {
      const frac = (PLATE_FRONT_Y - p1.y) / (p2.y - p1.y)
      return {
        time: p1.t + frac * (p2.t - p1.t),
        height: lerp(p1.z, p2.z, frac),
        x: lerp(p1.x, p2.x, frac),
      }
    }
  }
  const last = trajectoryData[trajectoryData.length - 1]
  return { time: last?.t ?? 0, height: last?.z ?? 1.0, x: last?.x ?? 0 }
}
