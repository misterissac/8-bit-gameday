import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolvePitchSpeedMph,
  SWING_PEAK_BASELINE_MPH,
} from '../src/util/batterSwing.js'

test('resolvePitchSpeedMph extracts speed_mph when present', () => {
  assert.equal(resolvePitchSpeedMph({ speed_mph: 97.5 }), 97.5)
  assert.equal(resolvePitchSpeedMph({ speed_mph: '84.2' }), 84.2)
})

test('resolvePitchSpeedMph falls back to trajectory distance/time if speed_mph is missing', () => {
  // ~16 meters in ~0.40 seconds = 40 m/s = ~89.48 mph
  const traj = [
    { t: 0, x: 0, y: 16.5, z: 1.8 },
    { t: 0.4, x: 0, y: 0.5, z: 0.8 },
  ]
  const speed = resolvePitchSpeedMph({ trajectory: traj })
  assert.ok(speed >= 85 && speed <= 95, `computed speed ${speed} should be ~90 mph`)
})

test('resolvePitchSpeedMph defaults to baseline 90 mph when data is missing or empty', () => {
  assert.equal(resolvePitchSpeedMph(null), SWING_PEAK_BASELINE_MPH)
  assert.equal(resolvePitchSpeedMph({}), SWING_PEAK_BASELINE_MPH)
  assert.equal(resolvePitchSpeedMph({ trajectory: [] }), SWING_PEAK_BASELINE_MPH)
})
