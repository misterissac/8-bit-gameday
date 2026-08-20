import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isHitFieldingReady,
  hitMatchesAtBat,
  isBattedBallLaunchable,
} from '../src/util/battedBall.js'

// A fully-populated live Statcast hit: matching at-bat, launch data, and the
// fielding point (hc_x/hc_y) the batted-ball arc needs.
const readyHit = {
  playId: 'AB4-EV0',
  pitchPlayId: 'AB4-P3',
  atBatIndex: 4,
  launchSpeed: 95,
  launchAngle: 14,
  sprayAngle: 25,
  totalDistance: 280,
  coordX: 130,
  coordY: 160,
  fielder: 'RF',
  wasCaught: false,
  runners: [],
}

test('isHitFieldingReady requires coordinates and launch data', () => {
  assert.equal(isHitFieldingReady(null), false)
  assert.equal(isHitFieldingReady(undefined), false)
  assert.equal(isHitFieldingReady(readyHit), true)

  // Missing any of the arc-critical fields must hold the launch; a null launch
  // speed or landing point would otherwise produce a NaN/Infinity flight.
  for (const key of ['coordX', 'coordY', 'launchSpeed', 'launchAngle']) {
    const missing = { ...readyHit, [key]: null }
    assert.equal(isHitFieldingReady(missing), false, `expected missing ${key} to block launch`)
  }
})

test('hitMatchesAtBat accepts matching, missing, and unknown at-bat indexes', () => {
  assert.equal(hitMatchesAtBat(null, 4), false)
  assert.equal(hitMatchesAtBat(readyHit, 4), true)
  assert.equal(hitMatchesAtBat(readyHit, 5), false)

  // A missing at-bat on either side is a match, so bundled/legacy payloads
  // without the index still count as belonging to the active pitch.
  assert.equal(hitMatchesAtBat(readyHit, null), true)
  assert.equal(hitMatchesAtBat(readyHit, undefined), true)
  assert.equal(hitMatchesAtBat({ ...readyHit, atBatIndex: null }, 4), true)
})

test('isBattedBallLaunchable fires fouls immediately and waits for an in-play fielding point', () => {
  // A foul synthesizes its own flight, so it launches with no live hit at all.
  assert.equal(isBattedBallLaunchable({ hit: null, atBatIndex: 4, isFoul: true }), true)

  // A matching hit with a fielding point launches.
  assert.equal(isBattedBallLaunchable({ hit: readyHit, atBatIndex: 4, isFoul: false }), true)

  // The same hit must not launch for a different at-bat (stale hit).
  assert.equal(isBattedBallLaunchable({ hit: readyHit, atBatIndex: 5, isFoul: false }), false)

  // A matching hit without a fielding point must wait instead of animating a
  // reconstructed/wrong trajectory.
  const noFieldingPoint = { ...readyHit, coordX: null, coordY: null }
  assert.equal(
    isBattedBallLaunchable({ hit: noFieldingPoint, atBatIndex: 4, isFoul: false }),
    false,
  )

  // No hit yet: wait for the real hit rather than launching a demo sample.
  assert.equal(isBattedBallLaunchable({ hit: null, atBatIndex: 4, isFoul: false }), false)
})
