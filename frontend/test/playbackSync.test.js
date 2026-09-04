import test from 'node:test'
import assert from 'node:assert/strict'
import {
  setCycleDuration,
  getCycleDuration,
  getPendingCycleDuration,
  setTimeScale,
  getTimeScale,
  stepSimulation,
  getSimulationTime,
  setSimulationTime,
  resetSimulationTime,
  isSimulationWrapped,
} from '../src/constants/playback.js'
import {
  getTuning,
  setTuningValue,
  subscribeTuning,
  DEFAULT_TUNING,
  mergeTuning,
} from '../src/constants/tuning.js'

test.beforeEach(() => {
  resetSimulationTime()
  setCycleDuration(3.0, { force: true })
  setTimeScale(1.0)
})

test('stepSimulation advances simulation time linearly at real time (timeScale = 1)', () => {
  resetSimulationTime()
  setCycleDuration(4.0, { force: true })

  const res1 = stepSimulation(0.1, 1.0)
  assert.equal(res1.wrapped, false)
  assert.ok(Math.abs(res1.time - 0.1) < 1e-6)
  assert.ok(Math.abs(getSimulationTime() - 0.1) < 1e-6)

  const res2 = stepSimulation(0.2, 1.1)
  assert.equal(res2.wrapped, false)
  assert.ok(Math.abs(res2.time - 0.3) < 1e-6)
  assert.ok(Math.abs(getSimulationTime() - 0.3) < 1e-6)
})

test('stepSimulation is idempotent across multiple callers within the same render tick', () => {
  resetSimulationTime()
  setCycleDuration(5.0, { force: true })

  // First caller (e.g. SimulationClock) steps at frame time 10.0
  const clockRes = stepSimulation(0.016, 10.0)

  // Second caller (e.g. Pitch) in the same frame tick
  const pitchRes = stepSimulation(0.016, 10.0)

  // Third caller (e.g. Batter) in the same frame tick
  const batterRes = stepSimulation(0.016, 10.0)

  // Fourth caller (e.g. Pitcher) in the same frame tick
  const pitcherRes = stepSimulation(0.016, 10.0)

  // Fifth caller (e.g. BattedBall) in the same frame tick
  const ballRes = stepSimulation(0.016, 10.0)

  assert.equal(clockRes.time, pitchRes.time)
  assert.equal(clockRes.time, batterRes.time)
  assert.equal(clockRes.time, pitcherRes.time)
  assert.equal(clockRes.time, ballRes.time)
  assert.ok(Math.abs(clockRes.time - 0.016) < 1e-6)
  assert.equal(clockRes.wrapped, false)
  assert.equal(pitchRes.wrapped, false)
})

test('stepSimulation wraps cleanly past cycleDuration and flags wrapped: true', () => {
  resetSimulationTime()
  setCycleDuration(3.0, { force: true })

  // Set time near the end of the cycle (2.95s)
  setSimulationTime(2.95)

  // Step 0.1s -> 3.05s >= 3.0s -> wraps to 0.05s
  const res = stepSimulation(0.1, 20.0)
  assert.equal(res.wrapped, true)
  assert.ok(Math.abs(res.time - 0.05) < 1e-6)
  assert.equal(isSimulationWrapped(), true)

  // Next frame does not wrap
  const nextRes = stepSimulation(0.016, 20.016)
  assert.equal(nextRes.wrapped, false)
  assert.ok(Math.abs(nextRes.time - (0.05 + 0.016)) < 1e-6)
  assert.equal(isSimulationWrapped(), false)
})

test('setCycleDuration defers shortening when simulationTime > newDuration to avoid mid-air jump', () => {
  resetSimulationTime()
  setCycleDuration(6.0, { force: true })

  // Simulation is midway through a long flyball flight (4.5s)
  setSimulationTime(4.5)

  // A shorter duration (3.0s) is requested mid-flight
  setCycleDuration(3.0)

  // cycleDuration stays 6.0 until the wrap; pending is stored
  assert.equal(getCycleDuration(), 6.0)
  assert.equal(getPendingCycleDuration(), 3.0)
  assert.equal(getSimulationTime(), 4.5) // no backward snap

  // Advance to near end of the 6.0s cycle
  setSimulationTime(5.95)

  // Step across the wrap
  const wrapRes = stepSimulation(0.1, 30.0)
  assert.equal(wrapRes.wrapped, true)

  // Now the pending duration (3.0s) has taken effect cleanly
  assert.equal(getCycleDuration(), 3.0)
  assert.equal(getPendingCycleDuration(), null)
  assert.ok(wrapRes.time >= 0 && wrapRes.time < 0.1)
})

test('setCycleDuration applies immediately when lengthening or forced', () => {
  resetSimulationTime()
  setCycleDuration(3.0, { force: true })
  setSimulationTime(1.5)

  // Lengthening from 3.0s to 7.0s is safe immediately (1.5s < 7.0s)
  setCycleDuration(7.0)
  assert.equal(getCycleDuration(), 7.0)
  assert.equal(getPendingCycleDuration(), null)
  assert.equal(getSimulationTime(), 1.5)

  // Forced shortening applies immediately
  setCycleDuration(2.0, { force: true })
  assert.equal(getCycleDuration(), 2.0)
  assert.equal(getPendingCycleDuration(), null)
})

test('resetSimulationTime resets clock to 0, clears wrap flag, and applies pending duration', () => {
  resetSimulationTime()
  setCycleDuration(6.0, { force: true })
  setSimulationTime(5.0)
  setCycleDuration(2.5) // deferred
  assert.equal(getPendingCycleDuration(), 2.5)

  resetSimulationTime()
  assert.equal(getSimulationTime(), 0)
  assert.equal(isSimulationWrapped(), false)
  assert.equal(getCycleDuration(), 2.5)
  assert.equal(getPendingCycleDuration(), null)
})

test('setTimeScale slows down or speeds up simulation step proportionally', () => {
  resetSimulationTime()
  setCycleDuration(5.0, { force: true })
  setTimeScale(0.5) // 50% speed
  assert.equal(getTimeScale(), 0.5)

  const res = stepSimulation(0.1, 40.0)
  // 0.1s delta * 0.5 timeScale = 0.05s
  assert.ok(Math.abs(res.time - 0.05) < 1e-6)
})

test('comparison mode speed (0.2x) steps at 5x slow-motion cleanly from release (t = 0)', () => {
  resetSimulationTime()
  // Simulate live pitch was mid-flight at 2.4s of an 8s cycle
  setCycleDuration(8.0, { force: true })
  setSimulationTime(2.4)

  // Enter comparison mode: force-shorten cycle duration and reset clock
  const comparisonCycleDuration = 4.2
  setCycleDuration(comparisonCycleDuration, { force: true })
  resetSimulationTime()
  setTimeScale(0.2)

  assert.equal(getSimulationTime(), 0)
  assert.equal(getCycleDuration(), 4.2)
  assert.equal(getPendingCycleDuration(), null)
  assert.equal(getTimeScale(), 0.2)

  // Step 0.1s wall-clock time -> 0.02s simulation time in 5x slow motion
  const stepRes = stepSimulation(0.1, 50.0)
  assert.ok(Math.abs(stepRes.time - 0.02) < 1e-6)
  assert.equal(stepRes.wrapped, false)
})

test('setTuningValue with persist: false updates in-memory tuning and notifies subscribers', () => {
  let notified = false
  const unsubscribe = subscribeTuning(() => {
    notified = true
  })

  // Set timeScale to 0.2 without persisting
  setTuningValue('playback', 'timeScale', 0.2, { persist: false })
  assert.equal(getTuning().playback.timeScale, 0.2)
  assert.equal(notified, true)

  // Restore back to default
  setTuningValue('playback', 'timeScale', DEFAULT_TUNING.playback.timeScale, { persist: false })
  assert.equal(getTuning().playback.timeScale, DEFAULT_TUNING.playback.timeScale)

  unsubscribe()
})

test('mergeTuning sanitizes saved tuning containing 0.2 timeScale back to default', () => {
  // Simulate localStorage corrupted by previous comparison session
  const corruptedSaved = {
    playback: {
      timeScale: 0.2,
      cyclePause: 0.8,
    },
  }

  const merged = mergeTuning(corruptedSaved)
  // timeScale 0.2 should be sanitized to default (0.61)
  assert.equal(merged.playback.timeScale, DEFAULT_TUNING.playback.timeScale)
  // other valid customizations should be preserved
  assert.equal(merged.playback.cyclePause, 0.8)

  // Non-corrupted timeScale (e.g. 0.75) should be preserved
  const validSaved = {
    playback: {
      timeScale: 0.75,
    },
  }
  const validMerged = mergeTuning(validSaved)
  assert.equal(validMerged.playback.timeScale, 0.75)
})
