import { Vector3 } from 'three'
import { feetToM, mphToMetersPerSecond } from '../util/MathUtil'

// ---------------------------------------------------------------------------
// Field geometry constants.
//
// Coordinate system matches the rest of the frontend (Scene.jsx / Pitch.jsx):
//   +X = first-base side (right from the catcher's view)
//   +Y = up
//   -Z = toward the field (pitcher, then outfield)
//
// Distances mirror solomon-gumball:baseball-sim-main/src/Constants.tsx
// FIELD_LOCATION, with X negated to match this app's handedness.
// ---------------------------------------------------------------------------

export const FIELD = {
  BASE: {
    HOME: new Vector3(0, 0, 0),
    FIRST: new Vector3(feetToM(63.4), 0, -feetToM(63.4)),
    SECOND: new Vector3(0, 0, -feetToM(128.2)),
    THIRD: new Vector3(-feetToM(63.4), 0, -feetToM(63.4)),
  },
  DEFENSE: {
    P: new Vector3(0, 0, -feetToM(60.5)),
    C: new Vector3(0, 0, feetToM(6)),
    '1B': new Vector3(feetToM(66), 0, -feetToM(83.4)),
    '2B': new Vector3(feetToM(45), 0, -feetToM(150)),
    '3B': new Vector3(-feetToM(66), 0, -feetToM(83.4)),
    SS: new Vector3(-feetToM(45), 0, -feetToM(150)),
    LF: new Vector3(-feetToM(120), 0, -feetToM(240)),
    CF: new Vector3(0, 0, -feetToM(270)),
    RF: new Vector3(feetToM(120), 0, -feetToM(240)),
  },
}

// Fielder sprint speed, matching solomon-gumball's CONSTANTS.MAX_RUN_SPEED (9 mph).
export const MAX_RUN_SPEED = mphToMetersPerSecond(9)
