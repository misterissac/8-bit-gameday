import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vector3 } from 'three'
import {
  findIntersection,
  PLATE_FRONT_Y,
  plateCrossing,
  resolveFieldedIntercept,
} from '../src/util/MathUtil.js'

const approx = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

// A fielded grounder: the ball launches from home and flies at ``airSpeed``
// for ``airTime`` (reaching ``contactDistance``), then rolls at ``rollSpeed``.
// The fielder starts at ``catcherPos`` and sprints at ``catcherSpeed``.
const launch = new Vector3(0, 0, 0)
const dir = new Vector3(1, 0, 0)
const airSpeed = 30
const rollSpeed = 30
const airTime = 1
const contactDistance = 30
const catcherPos = new Vector3(45, 0, 0)
const catcherSpeed = 8

function catchDist(intercept) {
  return intercept.location.distanceTo(launch)
}

test('resolveFieldedIntercept matches findIntersection when roll speed equals air speed', () => {
  // With rollSpeed === airSpeed the piecewise model collapses to the constant
  // speed model — the resolver must reproduce findIntersection exactly.
  const piece = resolveFieldedIntercept(
    launch, dir, airSpeed, rollSpeed, airTime, contactDistance, catcherPos, catcherSpeed,
  )
  const classic = findIntersection(
    launch, dir, airSpeed, catcherPos, catcherSpeed, airTime + 0.05,
  )
  assert.ok(piece, 'resolver should find a catch')
  assert.ok(classic, 'findIntersection should find a catch')
  approx(piece.t, classic.t)
  approx(piece.location.x, classic.location.x)
  approx(piece.location.z, classic.location.z)
})

test('a slower roll is fielded sooner (closer to home) than the default', () => {
  const slow = resolveFieldedIntercept(
    new Vector3().copy(launch), dir, airSpeed, 15, airTime, contactDistance,
    new Vector3().copy(catcherPos), catcherSpeed,
  )
  const base = resolveFieldedIntercept(
    new Vector3().copy(launch), dir, airSpeed, rollSpeed, airTime, contactDistance,
    new Vector3().copy(catcherPos), catcherSpeed,
  )
  assert.ok(slow, 'slower roll should still be catchable')
  // A slow-rolling ball doesn't escape toward the outfield, so the fielder
  // meets it before (shorter distance) the default-speed ball.
  assert.ok(catchDist(slow) < catchDist(base), `slow ${catchDist(slow)} < base ${catchDist(base)}`)
})

test('a faster roll is fielded farther out than the default', () => {
  const fast = resolveFieldedIntercept(
    new Vector3().copy(launch), dir, airSpeed, 60, airTime, contactDistance,
    new Vector3().copy(catcherPos), catcherSpeed,
  )
  const base = resolveFieldedIntercept(
    new Vector3().copy(launch), dir, airSpeed, rollSpeed, airTime, contactDistance,
    new Vector3().copy(catcherPos), catcherSpeed,
  )
  assert.ok(fast, 'faster roll should still be catchable')
  // A fast-rolling ball keeps heading out, so the fielder has to run farther.
  assert.ok(catchDist(fast) > catchDist(base), `fast ${catchDist(fast)} > base ${catchDist(base)}`)
})

// --- plateCrossing: the contact point's source of truth ---------------------
// Every swing, contact and batted-ball handoff is aimed at this interpolation.
// It must land on the *exact* crossing of the simulated trajectory, not on the
// nearest 1 ms sample, or the bat meets the ball at the wrong height.

test('PLATE_FRONT_Y is the pinned front edge of home plate', () => {
  // 17 inches (the plate's depth) in meters. Changing this moves every contact
  // point in the app, so it is pinned rather than derived here.
  assert.equal(PLATE_FRONT_Y, 0.4318)
})

test('plateCrossing interpolates between the bracketing samples', () => {
  // Two samples straddle the plate front; the true crossing is 0.4 of the way
  // from the first to the second. Values are chosen so the expected answer is
  // exact in binary floating point where possible, and analytic otherwise.
  const traj = [
    { t: 0.4, x: 0.1, y: PLATE_FRONT_Y + 0.2, z: 1.0 },
    { t: 0.41, x: 0.2, y: PLATE_FRONT_Y - 0.3, z: 0.5 },
  ]
  const crossing = plateCrossing(traj)
  const frac = 0.2 / (0.2 + 0.3)
  approx(crossing.time, 0.4 + frac * 0.01, 1e-12)
  approx(crossing.height, 1.0 + frac * (0.5 - 1.0), 1e-12)
  approx(crossing.x, 0.1 + frac * (0.2 - 0.1), 1e-12)
  // And it is genuinely between the two samples, not snapped to either.
  assert.ok(crossing.height < 1.0 && crossing.height > 0.5)
})

test('plateCrossing at 1 ms resolution matches the analytic crossing', () => {
  // A full-resolution (dt = 1 ms) flight like the payload's: y decreases
  // linearly from the release, z falls quadratically. The analytic crossing is
  // known in closed form, so the interpolation error is measured, not assumed.
  const dt = 0.001
  const y0 = 16.4
  const z0 = 1.9
  const vz = -1.1
  const az = -9.8
  const v0 = -y0 / 0.44 // reaches y = 0 at t = 0.44 s
  const traj = []
  for (let i = 0; i < 441; i += 1) {
    const t = i * dt
    traj.push({ t, x: 0.15 * t, y: y0 + v0 * t, z: z0 + vz * t + 0.5 * az * t * t })
  }
  const tTrue = (y0 - PLATE_FRONT_Y) / -v0
  const heightTrue = z0 + vz * tTrue + 0.5 * az * tTrue * tTrue
  const crossing = plateCrossing(traj)
  approx(crossing.time, tTrue, 1e-12)
  approx(crossing.x, 0.15 * tTrue, 1e-12)
  // Height is quadratic in time, so linear interpolation across one 1 ms step
  // carries an O(az * dt^2) error of ~1e-6 m — three orders below the ~5 mm
  // error of snapping to the nearest sample.
  approx(crossing.height, heightTrue, 1e-5)

  // The two samples bracketing the crossing straddle it; picking the nearest
  // one instead would be off by up to half a millisecond of flight.
  const bracket = traj.findIndex((p, i) => p.y > PLATE_FRONT_Y && traj[i + 1].y <= PLATE_FRONT_Y)
  assert.ok(bracket >= 0, 'the synthetic flight must cross the plate')
  assert.ok(crossing.time > traj[bracket].t && crossing.time < traj[bracket + 1].t)
  const nearestError = Math.min(
    Math.abs(traj[bracket].z - heightTrue),
    Math.abs(traj[bracket + 1].z - heightTrue),
  )
  assert.ok(
    Math.abs(crossing.height - heightTrue) < nearestError / 10,
    'interpolation must beat the nearest sample by an order of magnitude',
  )
})

test('plateCrossing returns the last sample when the flight never reaches the plate', () => {
  const traj = [
    { t: 0, x: 0, y: 16.0, z: 1.8 },
    { t: 0.2, x: 0.05, y: 2.0, z: 1.2 },
    { t: 0.3, x: 0.06, y: 1.0, z: 1.0 },
  ]
  const crossing = plateCrossing(traj)
  assert.equal(crossing.time, 0.3)
  assert.equal(crossing.height, 1.0)
  assert.equal(crossing.x, 0.06)
})

test('the ball reaches the catch point in sync with the catch time under its roll speed', () => {
  // The frame loop drives the roll as d(t) = contactDistance + rollSpeed*(t -
  // airTime), clamped at the catch. At the catch time this must land exactly on
  // catchLocation — i.e. the ball and the fielder (who arrives at catch.t)
  // converge together no matter the roll speed.
  for (const roll of [10, 30, 60]) {
    const piece = resolveFieldedIntercept(
      new Vector3().copy(launch), dir, airSpeed, roll, airTime, contactDistance,
      new Vector3().copy(catcherPos), catcherSpeed,
    )
    assert.ok(piece, `roll ${roll} should be catchable`)
    const dAtCatch = contactDistance + roll * (piece.t - airTime)
    approx(catchDist(piece), dAtCatch, 1e-2)
  }
})