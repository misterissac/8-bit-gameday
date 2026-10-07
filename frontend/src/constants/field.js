import { Vector3 } from 'three'
import { PLATE_FRONT_Y, feetToM, inchesToM, mphToMetersPerSecond } from '../util/MathUtil.js'

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

// ---------------------------------------------------------------------------
// Home plate and the boxes chalked around it (drawn by Ballpark.jsx).
//
// **Where the plate stands** is the *ball's* own frame, because that is the frame
// the app is played in and the one every other reading of the plate is taken in:
// the trajectory's `y` is the distance from the plate's back edge, so the pitch
// crosses the plate's *point* at y = PLATE_FRONT_Y; and Pitch.jsx places a
// trajectory point at world z = -y, while the swing's contact point is authored at
// world z = -PLATE_FRONT_Y (see `plateCrossing` in util/MathUtil.js and
// CONTACT_WORLD in e2e/harness/fixture.js). So:
//
//   z = -PLATE_FRONT_Y   the plate's point, facing the pitcher (fair territory)
//   z = 0                the plate's 17-inch back edge, at the foot of the baselines
//
// ...and the pitcher and the outfield are at -Z, as everywhere else in the app. The
// numbers below are the rulebook's own (Official Baseball Rules 1.04 and its diagram
// 2), given in inches and feet and converted here, so the drawing and the tests have
// one source for them rather than each their own.
//
//   * Home plate: a 17-inch square with its two front corners cut away. The back
//     edge is 17 in, the two sides 8.5 in, and the two front sides (the bevels) are
//     the 12-inch ones, meeting at a right angle at the point — so the slab is 17 in
//     across and 17 in deep.
//   * The batter's boxes: 4 ft by 6 ft, each one's inner edge 6 in from the plate's
//     own parallel (8.5-inch) edges — 8.5 + 6 = 14.5 in off the midline — and centred
//     along its *length* on the plate's two obtuse (135°) corners, which are 8.5 in in
//     front of the back edge. A box therefore runs from 27.5 in behind that edge to
//     44.5 in in front of it, and its own far edge stands 62.5 in off the midline.
//   * The catcher's box: 43 in by 8 ft, chalked *between* the two batters' boxes as the
//     trapezoid a grounds crew actually lays out for adult baseball — its front line runs
//     from 7 in inside one batter's box's back inside corner to 7 in inside the other
//     (15 in wide, in the gap the two batters' boxes leave), its sides flare back to the
//     full 43 in, and its back line stands 8 ft behind the plate's apex. So the three
//     boxes tile the ground without crossing: the chalk of the catcher's box never runs
//     inside a batter's box (see CATCHER_BOX below).
// ---------------------------------------------------------------------------
export const PLATE = {
  /** Across (the back edge), and the depth from that edge to the point. 17 in each. */
  width: inchesToM(17),
  depth: inchesToM(17),
  /** The two straight sides... */
  side: inchesToM(8.5),
  /** ...and the two bevels that cut the front corners off to make the point. */
  bevel: inchesToM(12),
  /** The point, in world z: the pitch crosses here, and the foul lines meet here. */
  pointZ: -PLATE_FRONT_Y,
  /** ...and the 17-inch back edge, where the baselines' foot is (FIELD.BASE.HOME). */
  backZ: 0,
  /** How thick the slab is drawn (it is set into the ground; the top is the plate). */
  thickness: 0.005,
}

/** One batter's box: 4 ft by 6 ft, beside the plate — mirrored for the two sides. */
export const BATTER_BOX = {
  width: feetToM(4),
  depth: feetToM(6),
  /** The line nearest the plate, off the midline: the plate's half-width plus 6 in. */
  innerX: PLATE.width / 2 + inchesToM(6),
  /** Its length is centred on the plate's 135° corners, 8.5 in in front of the back edge. */
  centreZ: PLATE.backZ - PLATE.side,
}

/** The two of them, third-base side first (where a right-handed batter stands). */
export const BATTER_BOXES = [
  {
    name: 'batterBox-3B',
    centreX: -(BATTER_BOX.innerX + BATTER_BOX.width / 2),
    centreZ: BATTER_BOX.centreZ,
  },
  {
    name: 'batterBox-1B',
    centreX: BATTER_BOX.innerX + BATTER_BOX.width / 2,
    centreZ: BATTER_BOX.centreZ,
  },
]

/**
 * The catcher's box: 43 in wide by 8 ft long, chalked between the two batters' boxes.
 *
 * The rule gives its size (43 in by 8 ft) and where its length is measured from — the
 * plate's apex — and the standard layout every grounds crew chalks for adult baseball
 * gives its *front* line: it runs 7 in inside each batter's box's back inside corner,
 * i.e. across the gap the two boxes leave at their own back line, and the sides flare
 * out to the full 43 in at the 8 ft mark. Drawn that way its chalk meets the batters'
 * boxes' chalk without ever crossing it, which is what "drawn between the two batter's
 * boxes" means; a 43-in rectangle hung off the plate instead would swallow the plate and
 * cross both batters' boxes by 7 in a side.
 */
export const CATCHER_BOX = {
  /** The width at its back line: 43 in, the rule's own. */
  width: inchesToM(43),
  /** How far behind the plate's apex its back line stands: 8 ft, the rule's own. */
  depth: feetToM(8),
  /** How far in from each batter's box's inner line its front line stops: 7 in. */
  frontInset: inchesToM(7),
  /** Its front line: the batters' boxes' own back line, across the gap between them. */
  frontZ: BATTER_BOX.centreZ + BATTER_BOX.depth / 2,
  /** ...and its back line, 8 ft behind the plate's apex (the width's own reference). */
  backZ: PLATE.pointZ + feetToM(8),
  /** Half of it across, at each end: 7.5 in at the front, 21.5 in at the back. */
  frontHalfWidth: BATTER_BOX.innerX - inchesToM(7),
  backHalfWidth: inchesToM(43) / 2,
}
