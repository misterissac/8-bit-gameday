import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateSwingGeometry,
  computeBatTiltAtProgress,
  forwardKinematicsSweetSpotAtContact,
  resolvePitchSpeedMph,
  resolveSwingPeak,
  BAT_LENGTH_MIN,
  BAT_LENGTH_MAX,
} from '../src/util/batterSwing.js'
import { PLATE_FRONT_Y, degToRad } from '../src/util/MathUtil.js'
import { DEFAULT_TUNING } from '../src/constants/tuning.js'

// Helper to create synthetic pitch trajectories crossing home plate at specific coordinates
// Note: Trajectory coordinates use:
//   x = horizontal offset
//   y = distance from plate (rubber at ~16.5m down to plate front at PLATE_FRONT_Y = 0.4318m)
//   z = vertical height in meters
function makeTrajectory({ crossingX, crossingHeight, tCrossing = 0.40, speedMph = 90 }) {
  const dt = 0.05
  return [
    { t: 0, x: 0, y: 16.5, z: 1.8 },
    {
      t: tCrossing - dt,
      x: crossingX,
      y: PLATE_FRONT_Y + 1.5,
      z: crossingHeight,
    },
    {
      t: tCrossing + dt,
      x: crossingX,
      y: PLATE_FRONT_Y - 1.5,
      z: crossingHeight,
    },
  ]
}

test('Attack angle at contact is exact down to floating point precision', () => {
  const testAngles = [-5, 0, 4.5, 11.2, 17.8, 20.0]
  const traj = makeTrajectory({ crossingX: 0.1, crossingHeight: 0.8 })

  for (const attackAngle of testAngles) {
    const pitchData = {
      trajectory: traj,
      attack_angle: attackAngle,
      swing_path_tilt: 34.0,
    }

    const geom = calculateSwingGeometry({
      pitchData,
      batX: -0.55,
      stanceZ: -PLATE_FRONT_Y + 0.25,
      settings: DEFAULT_TUNING.batter,
    })

    const expectedTilt = degToRad(attackAngle)
    assert.ok(Math.abs(geom.tilt - expectedTilt) < 1e-9, `geom.tilt should match attack angle ${attackAngle}°`)

    // At contact (e = 1), computeBatTiltAtProgress must be exact regardless of swing_path_tilt
    const contactTilt = computeBatTiltAtProgress(1.0, geom.tilt, geom.planeTilt)
    assert.ok(
      Math.abs(contactTilt - expectedTilt) < 1e-12,
      `bat tilt at e=1 (${contactTilt}) must equal attack angle (${expectedTilt})`,
    )
  }
})

test('Attack angle clamps to contactTiltMaxDeg on extreme Statcast inputs', () => {
  const traj = makeTrajectory({ crossingX: 0.0, crossingHeight: 0.75 })
  const pitchData = {
    trajectory: traj,
    attack_angle: 45.0, // extreme
    swing_path_tilt: 65.0,
  }

  const geom = calculateSwingGeometry({
    pitchData,
    batX: -0.55,
    stanceZ: -PLATE_FRONT_Y + 0.25,
    settings: DEFAULT_TUNING.batter,
  })

  const maxTilt = degToRad(DEFAULT_TUNING.batter.contactTiltMaxDeg)
  assert.ok(Math.abs(geom.tilt - maxTilt) < 1e-9, 'attack angle should be clamped to contactTiltMaxDeg')
})

test('Attack angle falls back to swing_path_tilt when attack_angle is absent', () => {
  const traj = makeTrajectory({ crossingX: 0.0, crossingHeight: 0.75 })
  const pitchData = {
    trajectory: traj,
    swing_path_tilt: 14.5,
  }

  const geom = calculateSwingGeometry({
    pitchData,
    batX: -0.55,
    stanceZ: -PLATE_FRONT_Y + 0.25,
    settings: DEFAULT_TUNING.batter,
  })

  assert.ok(Math.abs(geom.tilt - degToRad(14.5)) < 1e-9)
})

test('Attack angle falls back to 0 when both attack_angle and swing_path_tilt are absent', () => {
  const traj = makeTrajectory({ crossingX: 0.0, crossingHeight: 0.75 })
  const pitchData = { trajectory: traj }

  const geom = calculateSwingGeometry({
    pitchData,
    batX: -0.55,
    stanceZ: -PLATE_FRONT_Y + 0.25,
    settings: DEFAULT_TUNING.batter,
  })

  assert.equal(geom.tilt, 0)
  assert.equal(geom.planeTilt, 0)
})

test('Swing path tilt shapes the barrel plane along the approach and flattens onto attack angle at contact', () => {
  const tilt = degToRad(12.0)
  const planeTilt = degToRad(38.0)

  // At swing start (e = 0), tilt is 0
  assert.equal(computeBatTiltAtProgress(0, tilt, planeTilt), 0)

  // Mid-swing (e = 0.5), plane tilt dominates via sine-squared bump
  const midTilt = computeBatTiltAtProgress(0.5, tilt, planeTilt)
  // At e = 0.5: tilt * 0.5 + (planeTilt - tilt) * 1.0 = planeTilt - 0.5 * tilt
  const expectedMid = tilt * 0.5 + (planeTilt - tilt) * 1.0
  assert.ok(Math.abs(midTilt - expectedMid) < 1e-9)
  assert.ok(midTilt > tilt, 'barrel should ride steep swing plane above attack angle mid-swing')

  // At contact (e = 1.0), the sine bump is zero: Math.sin(PI) = 0
  const contactTilt = computeBatTiltAtProgress(1.0, tilt, planeTilt)
  assert.ok(Math.abs(contactTilt - tilt) < 1e-12, 'barrel must flatten precisely onto attack angle at contact')
})

test('Sweet spot lands on the ball with sub-millimeter accuracy regardless of animation tuning', () => {
  const tuningPresets = [
    {
      name: 'Default Tuning (v12)',
      settings: { ...DEFAULT_TUNING.batter },
    },
    {
      name: 'Aggressive Forward Lunge',
      settings: {
        ...DEFAULT_TUNING.batter,
        upperDriveForward: 0.65,
        pushSettleLevel: 0.80,
        pushSettleTime: 0.02,
        swingBackTilt: 0.15,
        legLean: 0.45,
      },
    },
    {
      name: 'Zero Forward Drive (Compact Stance)',
      settings: {
        ...DEFAULT_TUNING.batter,
        upperDriveForward: 0.0,
        pushSettleLevel: 0.50,
        pushSettleTime: 0.08,
        swingBackTilt: 0.0,
        legLean: 0.20,
      },
    },
    {
      name: 'Heavy Back-Tilt & Deep Lean',
      settings: {
        ...DEFAULT_TUNING.batter,
        swingBackTilt: 0.35,
        legLean: 0.50,
        upperDriveForward: 0.45,
        pushSettleLevel: 0.60,
      },
    },
    {
      name: 'Minimal Hand Reach',
      settings: {
        ...DEFAULT_TUNING.batter,
        handExtension: 0.15,
        upperDriveForward: 0.30,
      },
    },
    {
      name: 'Extended Hand Reach',
      settings: {
        ...DEFAULT_TUNING.batter,
        handExtension: 0.55,
        upperDriveForward: 0.35,
      },
    },
  ]

  const pitchLocations = [
    { name: 'Down the Middle', crossingX: 0.0, crossingHeight: 0.75, attackAngle: 12.0, planeTilt: 32.0 },
    { name: 'High & Inside', crossingX: -0.22, crossingHeight: 1.05, attackAngle: 18.0, planeTilt: 42.0 },
    { name: 'Low & Away', crossingX: 0.25, crossingHeight: 0.48, attackAngle: 6.0, planeTilt: 25.0 },
    { name: 'Inside Edge', crossingX: -0.30, crossingHeight: 0.70, attackAngle: 10.0, planeTilt: 30.0 },
    { name: 'Outside Edge', crossingX: 0.30, crossingHeight: 0.80, attackAngle: 14.0, planeTilt: 35.0 },
  ]

  const batterVariants = [
    { name: 'Right-handed standard', batX: -0.55, sign: 1, heightScale: 1.0 },
    { name: 'Left-handed standard', batX: 0.55, sign: -1, heightScale: 1.0 },
    { name: 'Tall righty', batX: -0.58, sign: 1, heightScale: 1.12 },
    { name: 'Compact lefty', batX: 0.52, sign: -1, heightScale: 0.88 },
  ]

  for (const preset of tuningPresets) {
    for (const pitch of pitchLocations) {
      for (const batter of batterVariants) {
        const traj = makeTrajectory({ crossingX: pitch.crossingX, crossingHeight: pitch.crossingHeight })
        const pitchData = {
          trajectory: traj,
          attack_angle: pitch.attackAngle,
          swing_path_tilt: pitch.planeTilt,
        }

        const stanceZ = -PLATE_FRONT_Y + 0.25
        const bodyOpen = 0.60

        const geom = calculateSwingGeometry({
          pitchData,
          batX: batter.batX,
          stanceZ,
          heightScale: batter.heightScale,
          sign: batter.sign,
          bodyOpen,
          settings: preset.settings,
        })

        assert.ok(geom != null, 'geom should be successfully calculated')

        // Forward kinematics of sweet spot in world coordinates
        const sweetSpot = forwardKinematicsSweetSpotAtContact(geom, preset.settings, {
          batX: batter.batX,
          stanceZ,
          heightScale: batter.heightScale,
          bodyOpen,
        })

        // Target coordinates in world space (where x=crossingX, y=crossingHeight, z=-PLATE_FRONT_Y)
        const targetX = pitch.crossingX
        const targetY = pitch.crossingHeight
        const targetZ = -PLATE_FRONT_Y

        const errX = Math.abs(sweetSpot.x - targetX)
        const errY = Math.abs(sweetSpot.y - targetY)
        const errZ = Math.abs(sweetSpot.z - targetZ)
        const distErr = Math.hypot(errX, errY, errZ)

        assert.ok(
          distErr < 1e-4,
          `Sweet spot must land on the ball for ${preset.name} / ${pitch.name} / ${batter.name}: ` +
          `error is ${distErr.toFixed(6)}m (X: ${errX.toFixed(6)}, Y: ${errY.toFixed(6)}, Z: ${errZ.toFixed(6)})`,
        )
      }
    }
  }
})

test('Bat length adapts to pitch distance across locations', () => {
  const trajInside = makeTrajectory({ crossingX: -0.25, crossingHeight: 0.75 })
  const trajOutside = makeTrajectory({ crossingX: 0.35, crossingHeight: 0.75 })

  const geomInside = calculateSwingGeometry({
    pitchData: { trajectory: trajInside },
    batX: -0.55,
    stanceZ: -PLATE_FRONT_Y + 0.25,
    settings: DEFAULT_TUNING.batter,
  })

  const geomOutside = calculateSwingGeometry({
    pitchData: { trajectory: trajOutside },
    batX: -0.55,
    stanceZ: -PLATE_FRONT_Y + 0.25,
    settings: DEFAULT_TUNING.batter,
  })

  assert.ok(
    geomOutside.batLength > geomInside.batLength,
    `outside pitch bat length (${geomOutside.batLength}) should be longer than inside pitch (${geomInside.batLength})`,
  )

  assert.ok(geomInside.batLength >= BAT_LENGTH_MIN, `batLength should be >= ${BAT_LENGTH_MIN}`)
  assert.ok(geomOutside.batLength <= BAT_LENGTH_MAX, `batLength should be <= ${BAT_LENGTH_MAX}`)
})

test('Automatic swing speed peak timing does not alter contact point or attack angle', () => {
  const traj = makeTrajectory({ crossingX: 0.1, crossingHeight: 0.8 })
  const speeds = [65, 80, 92, 104]

  for (const speed of speeds) {
    const pitchData = {
      trajectory: traj,
      speed_mph: speed,
      attack_angle: 14.0,
      swing_path_tilt: 36.0,
    }

    const peakFrac = resolveSwingPeak(0, resolvePitchSpeedMph(pitchData))

    // Changing peak timing shifts acceleration before settleStart,
    // leaving the contact geometry identical
    const geom = calculateSwingGeometry({
      pitchData,
      batX: -0.55,
      stanceZ: -PLATE_FRONT_Y + 0.25,
      settings: {
        ...DEFAULT_TUNING.batter,
        swingPeakFrac: peakFrac,
      },
    })

    assert.ok(Math.abs(geom.tilt - degToRad(14.0)) < 1e-9)

    const sweetSpot = forwardKinematicsSweetSpotAtContact(geom, DEFAULT_TUNING.batter, {
      batX: -0.55,
      stanceZ: -PLATE_FRONT_Y + 0.25,
      heightScale: 1.0,
      bodyOpen: 0.60,
    })

    const distErr = Math.hypot(
      sweetSpot.x - 0.1,
      sweetSpot.y - 0.8,
      sweetSpot.z - (-PLATE_FRONT_Y),
    )
    assert.ok(distErr < 1e-4, `speed ${speed} mph error should be < 1e-4m`)
  }
})
