import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vector3 } from 'three'
import {
  findIntersection,
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