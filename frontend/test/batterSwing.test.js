import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolvePitchSpeedMph,
  resolveSwingPeak,
  SWING_PEAK_BASELINE_MPH,
  SWING_PEAK_BASELINE_FRAC,
  SWING_PEAK_AUTO_MIN,
  SWING_PEAK_AUTO_MAX,
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

test('resolveSwingPeak respects manual overrides when setting is > 0', () => {
  // Even on a 104 mph pitch, explicit manual setting is used (clamped)
  assert.equal(resolveSwingPeak(0.70, 104), 0.70)
  assert.equal(resolveSwingPeak(0.60, 95), 0.60)
  assert.equal(resolveSwingPeak(0.01, 95), 0.05) // clamped to min
  assert.equal(resolveSwingPeak(0.99, 95), 0.95) // clamped to max
})

test('resolveSwingPeak automatic mode (0/null/undefined) shifts peak later for faster pitches', () => {
  const peakSlow = resolveSwingPeak(0, 70)
  const peakMedium = resolveSwingPeak(0, 85)
  const peakFast = resolveSwingPeak(0, 95)
  const peakHeat = resolveSwingPeak(0, 104)

  assert.ok(
    peakSlow < peakMedium,
    `slow pitch peak (${peakSlow}) should be earlier than medium pitch peak (${peakMedium})`,
  )
  assert.ok(
    peakMedium < peakFast,
    `medium pitch peak (${peakMedium}) should be earlier than fast pitch peak (${peakFast})`,
  )
  assert.ok(
    peakFast < peakHeat,
    `fast pitch peak (${peakFast}) should be earlier than heat pitch peak (${peakHeat})`,
  )
})

test('resolveSwingPeak matches baseline fraction at 90 mph', () => {
  const peak90 = resolveSwingPeak(0, 90)
  assert.equal(peak90, SWING_PEAK_BASELINE_FRAC)
})

test('resolveSwingPeak clamps automatic values within natural bounds', () => {
  const peakVerySlow = resolveSwingPeak(0, 45)
  const peakVeryFast = resolveSwingPeak(0, 120)

  assert.ok(peakVerySlow >= SWING_PEAK_AUTO_MIN, `very slow pitch peak (${peakVerySlow}) should be >= ${SWING_PEAK_AUTO_MIN}`)
  assert.ok(peakVeryFast <= SWING_PEAK_AUTO_MAX, `very fast pitch peak (${peakVeryFast}) should be <= ${SWING_PEAK_AUTO_MAX}`)
})
