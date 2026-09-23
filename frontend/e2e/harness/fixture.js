// Deterministic fixtures and phase timings for the batter visual-regression
// suite (frontend/e2e/batter.visual.spec.js).
//
// This module is imported by BOTH the Playwright spec and the browser harness
// (frontend/e2e/harness/batterMain.jsx) so a shot's simulation time and the
// numbers asserted against it can never drift apart. Keep it free of React,
// three.js, and DOM access.
//
// Trajectory convention (same as frontend/test/swingGeometry.test.js):
//   x = horizontal offset from the plate center (m)
//   y = distance from the plate (rubber ~16.5 m -> front of plate at PLATE_FRONT_Y)
//   z = vertical height (m)
import { PLATE_FRONT_Y } from '../../src/util/MathUtil.js'
import { DEFAULT_TUNING } from '../../src/constants/tuning.js'

// A right-handed batter taking a 94 mph four-seamer with Statcast bat tracking
// (attack angle + swing path tilt), so every data-driven parameter the swing
// geometry consumes is exercised: plate crossing, attack angle, swing plane.
export const CROSSING_X = 0.06
export const CROSSING_HEIGHT_M = 0.78
export const CONTACT_TIME_S = 0.4
export const SPEED_MPH = 94
export const ATTACK_ANGLE_DEG = 12
export const SWING_PATH_TILT_DEG = 33
export const BAT_SIDE = 'R'
export const BATTER_HEIGHT_IN = 72 // 6'0"
export const CYCLE_DURATION_S = 4

const DT = 0.05
const TRAJECTORY = [
  { t: 0, x: 0, y: 16.5, z: 1.8 },
  { t: CONTACT_TIME_S - DT, x: CROSSING_X, y: PLATE_FRONT_Y + 1.5, z: CROSSING_HEIGHT_M },
  { t: CONTACT_TIME_S + DT, x: CROSSING_X, y: PLATE_FRONT_Y - 1.5, z: CROSSING_HEIGHT_M },
]

// World-space point [x, y, z] where the pitch crosses the front of the plate:
// the contact target the whole swing geometry is derived from. The batter's
// world frame maps trajectory x -> x, trajectory height (z) -> y, and the plate
// front to z = -PLATE_FRONT_Y (the pitcher is at -Z), matching
// calculateSwingGeometry.
export const CONTACT_WORLD = [CROSSING_X, CROSSING_HEIGHT_M, -PLATE_FRONT_Y]

// The pitch the batter swings at.
export const SWING_PITCH = {
  play_id: 'visual-harness-swing',
  pitch_type: 'FF',
  pitch_type_description: 'Four-Seam Fastball',
  speed_mph: SPEED_MPH,
  bat_side: BAT_SIDE,
  batter_height: BATTER_HEIGHT_IN,
  swing: true,
  attack_angle: ATTACK_ANGLE_DEG,
  swing_path_tilt: SWING_PATH_TILT_DEG,
  trajectory: TRAJECTORY,
}

// No trajectory => the batter holds its set stance (loaded hands, crouch, bat
// cocked, head on the pitcher). That is the pose the app shows before a pitch's
// trajectory arrives, so it is the honest "stance" baseline.
export const STANCE_PITCH = {
  play_id: 'visual-harness-stance',
  speed_mph: SPEED_MPH,
  bat_side: BAT_SIDE,
  batter_height: BATTER_HEIGHT_IN,
  swing: false,
}

const batterTuning = DEFAULT_TUNING.batter
export const SWING_START_S = CONTACT_TIME_S - batterTuning.swingLead
const FOLLOW_THROUGH_END_S = CONTACT_TIME_S + batterTuning.followThrough
export const HOLD_END_S = FOLLOW_THROUGH_END_S + (batterTuning.followHold ?? 0.28)

// Both fists are on the handle for the whole swing and the pose it finishes on: the
// bat's place is carried 0.42 rig *round* the trailing shoulder (see TRAIL_REACH_CLEAR
// in src/components/Batter.jsx), which is what takes the trailing arm's bicep clear of
// the ribs *while that arm stays straight* all the way through the hold. So the pose
// the suite reads a grip at is the path's own end, and there is no second, one-handed
// finish below it.

// The window the swing unwinds over: from the end of the hold, where the body is
// still in its finish pose, to the set stance. The way the body comes back is
// half of what the swing reads as, so the suite samples inside it rather than
// only at its endpoints.
export const RECOVERY_WINDOW = { start: HOLD_END_S, end: HOLD_END_S + batterTuning.recoveryTime }

// Everything after contact: the follow-through, the hold, and the whole way home.
// This is the window the *limbs* are judged over — whether a wrist stays rolled
// the right way up, whether an elbow keeps pointing where it belongs — and it is
// swept rather than sampled at moments, because where those go wrong is between
// the poses anyone would think to pick.
export const WAY_HOME_WINDOW = { start: FOLLOW_THROUGH_END_S, end: RECOVERY_WINDOW.end }

// The shots the suite captures. ``time`` is the shared simulation clock time
// (seconds into the pitch cycle) the harness pins before rendering.
export const PHASES = {
  // Loaded set stance, before the swing fires.
  stance: { pitch: STANCE_PITCH, time: 0 },
  // Mid-swing: the barrel is on the swing plane, partway from load to contact, at the
  // swing's own clock midpoint. Read here rather than at half of the swing's *progress*:
  // the swing's ease (SWING_EASE) puts its fastest frame on the ball, so half of the
  // progress is three quarters of the way through the clock, and the bat's own pivot has
  // turned over by then -- the geometry test reads this pose as the one that is *behind*
  // contact, and the bat's carry is only monotone toward the plate before that turn.
  midSwing: { pitch: SWING_PITCH, time: SWING_START_S + batterTuning.swingLead / 2 },
  // Exactly the contact frame (the pose the sweet spot is computed for).
  contact: { pitch: SWING_PITCH, time: CONTACT_TIME_S },
  // The swing's arrival: the pose the follow-through's own path ends on, with the
  // barrel carried almost clear of the plane through the lead shoulder. The hold
  // holds this pose — nothing moves after it, which is what leaves the sequence
  // reading as one swing rather than a swing that stops and slides — the way home is
  // authored from it, and both fists are on the handle here and through the hold. It
  // is where the swing's *end* is read (the body's turn, the bat's carry and
  // clearance, and the arms' own finish poses), and where the grip assertions and the
  // fists' own baselines are read.
  followThrough: { pitch: SWING_PITCH, time: FOLLOW_THROUGH_END_S },
  // Halfway back to the set stance. The swing turns the body open, so the way
  // it turns *back* is half of what the eye reads as a swing — and it is the
  // half where the body's own separation lives: the arms and the torso unwind
  // on their own clocks, and if those clocks are not the same the batter's
  // shoulders twist against its chest all the way home.
  recovery: { pitch: SWING_PITCH, time: HOLD_END_S + batterTuning.recoveryTime / 2 },
}
