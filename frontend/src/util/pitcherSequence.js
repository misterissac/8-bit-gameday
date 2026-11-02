import { clamp, feetToM } from './MathUtil.js'

// ---------------------------------------------------------------------------
// The pitcher's motion, authored as joint targets in the rig's own frame.
//
// This is the pitcher's half of what util/batterSwing.js does for the batter: a
// pure function of the clock that returns the pose the bone driver realises (see
// util/playerRig.js). The reference project plays a canned glTF clip for the
// delivery — a fixed performance at a fixed scale — and the app then has to place
// the *body* so that a hard-coded hand offset lands on the pitch's release point
// (`HAND_OFFSET_*` in Pitcher.jsx, which is why the pitcher slides a few tenths of
// a metre around the mound from pitch to pitch). Authoring the delivery as joint
// targets turns that around: the throw's own frame is anchored to the release
// point instead, and the body stands where the delivery needs it (see
// `pitcherRelease` and the placement in Pitcher.jsx).
//
// The rig's frame (see the driver's header): the body faces -Z, +X is the
// throwing side, y is measured from the ground. Everything here is authored for a
// RIGHT-handed pitcher and mirrored for a lefty, so the throw comes over the
// right shoulder, the glove is the left hand, and the kick and stride are the
// left leg.
//
// The delivery is one continuous motion: the set stance, the weight onto the back
// foot, the leg kick, the stride and plant, the cock, the release, the
// follow-through, and back to the set. Every joint is a *track* and the tracks
// are read through a monotone (finite-difference Hermite) interpolator rather
// than a smoothstep between keys — a delivery is one accelerating motion, and a
// curve that stopped at every key would read as a series of poses, not a throw.
//
// Two things make the release *accurate* rather than approximate:
//
//   * the ball's place at the release frame is `pitcherRelease`, whose height is
//     the pitch's own (see below), so the pose is built around where this ball
//     actually leaves from;
//   * the release window's keys are authored as *offsets from that place*, so the
//     hand's whole whip rides it, and the component's placement is read off this
//     same frame (see Pitcher.jsx): the body is put where the delivery's own
//     release point lands on the trajectory's first sample.
// ---------------------------------------------------------------------------

// The clock the delivery is authored on, in clip seconds. Both are the tuning's
// own numbers (playback.ballReleaseTime / pitcher.clipDuration), and a tuning
// that moves the release moves the whole delivery with it (see `pitcherPose`).
export const AUTHORED_RELEASE_TIME = 1.32
// ...and the clip is longer than the throw by a second: the finish is *held* (see the
// settle and the hold in the keys below), so a delivery that recovers the moment its
// trail foot lands is a pitcher who never stood in his follow-through at all. The
// tuning's own ``pitcher.clipDuration`` and the cycle's pause are the same number and
// the same second (see the tuning), so the app's loop gives the hold the room the
// delivery asks for rather than cutting it off at the wrap.
export const AUTHORED_CLIP_END = 3.32

// How long a pitch takes to get from the hand to the front of the plate. It is the
// one moment of the delivery that belongs to the *pitch* rather than to the pose,
// and the delivery needs it because the look is handed over on it: a pitcher's eyes
// are on the strike zone until the ball is most of the way there, and the last of
// the flight is what the head spends letting go of it (see the look's own clock
// below). It is also the one moment this file
// can state but not read — the app's own flight time is a trajectory's (see
// util/MathUtil's `plateCrossing`, which is where the batter's swing is aimed), and
// it runs from about 0.38 to 0.48 of a second across a real staff's pitches. So the
// delivery carries one number for it rather than being re-keyed per pitch: the
// authored slot's own flight, a 94 mph four-seamer's 0.44.
const ZONE_FLIGHT = 0.44
export const AUTHORED_ZONE_TIME = AUTHORED_RELEASE_TIME + ZONE_FLIGHT

// The idle between pitches breathes on its own clock, in cycles per second.
const IDLE_BREATHE_HZ = 0.17

// How high off its own rest height a foot may be and still count as standing on the
// ground: the trailing foot is peeled off the rubber by the drive and the front foot
// is lifted by the kick, so what this separates is a foot the delivery is *carrying*
// from one it is standing on (see ``planted`` below).
const PLANTED_LIFT = 0.02

// How much of a lifted leg hangs off its knee (see the pose assembly). A leg the
// delivery is carrying is not a leg standing on something: it is *lifted*, so what
// the pose can name about it is where the knee is going, and the shin dangles under
// that knee with the foot below it. Folding the shin back over the foot instead —
// which is what a pole anchored to the foot's own place does once the foot is off
// the ground — is the shape of a leg being pulled, not of one being lifted.
const HANG_SHARE = 0.5

// How high off its own rest height a foot has to be before the leg it belongs to is
// hanging off its knee rather than standing on it. A leg the delivery is carrying has
// let the ground go: the shin hangs under the knee from about a hand's width up, and
// the foot is the last thing to leave and the first thing to come back. Easing this in
// across the whole lift instead is what folded the kick's shin back over its own foot
// through the first half of the pick-up — the shape of a leg being *dragged* up, with
// the boot trailing across the body while the knee is already out at the side.
const HANG_LIFT = 0.06

// How much of a carried leg's ``lift`` comes up at the *knee*: the keys measure the
// lift where the shape of the leg is authored, and a foot lifted a hand's width is a
// knee up a shade over half of it (the rest is the shin swinging under it as it
// hangs). See the pose assembly's ``rise``.
const KNEE_RISE = 0.55

// How far *above* its own socket a carried leg's knee may be asked for, in rig units.
// A thigh hung straight down carries the knee a femur under the socket, and a windup's
// first pick-up brings it up level with it; a *high* kick is the hip flexing past the
// horizontal, so the femur points up out of the socket and the knee rides over the
// belt the leg is standing in (see the balance key, which is the highest ask in the
// delivery: 0.19 of a unit over the socket). This is the ceiling that ask is held
// under, and it is the model's own hip rather than a number picked: 0.61 of a thigh —
// the femur 38° over the horizontal — is as high as a pelvis this size lifts a knee
// without folding over its own socket.
const KNEE_OVER_HIP = 0.26


// The release slots a real staff spans, and how upright the body is at each end
// of them. The arm can only lift the ball so far above the shoulder, so the rest
// of a high release has to come from the body standing up out of its forward
// fold — which is what a high-slot pitcher does, and what a sidearmer does not.
const SLOT_LOW_M = 1.35
const SLOT_HIGH_M = 2.05
const LEAN_LOW = 1.15
const LEAN_HIGH = 0.75

// The release height the keys' own leans were written for, and the lean they hold
// there: the release key is authored at AUTHORED_RELEASE_LEAN, and the height is
// the one whose slot lean *is* that lean — derived from the pair of them rather
// than picked, so the delivery's own shape and the slot it is corrected from can
// never drift apart. Every other height turns the release window's lean by the
// difference between its own slot lean and this one (see the ``slot`` track), so a
// high slot stands the body up out of the fold instead of asking the same fold to
// reach higher.
const AUTHORED_RELEASE_LEAN = 0.92
export const AUTHORED_RELEASE_HEIGHT = SLOT_LOW_M
  + (SLOT_HIGH_M - SLOT_LOW_M) * (LEAN_LOW - AUTHORED_RELEASE_LEAN) / (LEAN_LOW - LEAN_HIGH)

// How far down the hand's own line the model carries what it is holding: the
// palm marker `measurePlayerRig` reads (rig.palm), so a released ball's place is
// the arm's own geometry rather than a number tuned for one rig.
export function releaseCarry(rig, hand) {
  return rig.palm?.[hand] ?? rig.arm.hand * 0.8
}

// ---------------------------------------------------------------------------
// The pitcher's own body, from the pitch's stats.
//
// A delivery is thrown by a *body*, and the body is not a free parameter. A real
// staff has a pitcher's arm half his stature and no more, his pivot foot on the
// rubber and his stride carrying the ball the distance his own release point asks
// for; the two places a delivery can be wrong about that are its proportions (a rig
// whose arm is a third of its height throws like nothing human, however well its
// joints are driven) and its stance (a body placed wherever a hard-coded release
// offset leaves it stands off the rubber with its feet off the ground).
//
// What this section reads is the *pitch's* own numbers, so the delivery can be
// built from them instead:
//
//   * the body's proportions are clamped to the ranges a real staff spans (the
//     arm, the leg, the trunk and the head against the stature), so a rig whose
//     limbs are authored long or short cannot be driven past a person's;
//   * the body's own size is the *pitcher's*: his listed height, the one the feed
//     looks up out of `gameData` beside the batter's (see the backend's
//     ``pitcher_height``), stands him at that stature and no other — the pitch does
//     not size him, and a release point above what his arm's own angle band can lift
//     the ball to is reported as a shortfall rather than answered by growing him;
//   * the release point is placed in front of the *rubber*, and the metres the
//     delivery carries the ball purely toward the strike zone are what the
//     delivery's own stride and the set stance are solved from — from the pitcher's
//     own height, because the delivery is his length of it, and from the release
//     point's own arm angle together: a pitch released further out is thrown by a
//     longer *delivery* — the same shape taken a stride further, see STRIDE_BAND —
//     standing where the shoe's own leather says on the rubber;
//   * the arm at the release is *straight* — the driver's own longest reach, its
//     elbow at ELBOW_BEND_MAX — along the line from its socket to the release
//     point, so the ball's place, the arm's own angle and the hand's line are one
//     answer rather than three that have to be tuned against each other.
//
// It is a *profile* rather than a constant because all three of them are the
// pitcher's own: `pitcherProfile` is called again for every pitch — and so for
// every new pitcher — and what comes back is what the pose, the placement and the
// tests are handed (see Pitcher.jsx).
// ---------------------------------------------------------------------------

// Where the rubber stands: sixty feet six inches from the plate's own origin, to its
// *front* edge — the line the pitch's own release distances are measured from (the
// backend reconstructs a release point at ``60.5 ft - extension``, see
// `_pitch_parameters_from_event`). The world's +Z runs from the mound toward the
// plate, so "in front of the rubber" is +Z and the rubber's front edge is at
// RUBBER_Z. (constants/field.js puts the defense's own P on the same line, and
// Ballpark draws the plate there rather than centred on it.)
export const RUBBER_Y = feetToM(60.5)
const RUBBER_Z = -RUBBER_Y
// The rubber's own depth: six inches of it run back from that edge.
export const RUBBER_DEPTH = feetToM(0.5)
// ...and how far the drive foot's ankle may stand either side of the edge while some
// part of the *shoe* is still on the rubber. A sole runs about a foot with the ankle
// most of a hand's width behind the toe, so the foot's own ball may stand that far
// ahead of the edge, and the heel may hang the rubber's own depth and a hand's width
// behind it — a pitcher's pivot foot stands on the rubber's front half or its back,
// and a foot's own leather is what touches.
export const PIVOT_AHEAD = 0.13
export const PIVOT_BEHIND = RUBBER_DEPTH + 0.17
// ...and how far the same ankle may stand *across* the rubber's own line, which is
// the plate's: the rubber's own half-width (two feet wide, less half). The pivot shoe
// is on the rubber for every pitch — a pitcher stands where he stands — so a release
// wide enough to drag the stance off it is answered by the body rather than by the
// feet: the trunk tilts out over the leather (see `pitcherRelease`'s ``tilt``, the
// profile's ``sideShortfall`` and `pitcherPlacement`), and what the arm still cannot
// reach comes back as a shortfall rather than as a foot in the air.
export const PIVOT_SIDE = feetToM(1)

// ...and how far the bit of the *shoe* that touches the rubber stands outward of the
// ankle it hangs from, along the shoe's own line, in the rig's own units. The stance's
// pivot shoe points across the rubber rather than down the pitch — its own yaw at the
// set is seventy degrees off the plate's line — and a shoe runs a foot, so the sole's
// lowest bit (the ball of the foot, which is the bit the driver's ground rule reads and
// the bit the eye reads as "the foot is on the rubber") stands most of a shoe ahead of
// the ankle, toward the throwing side, which is the side the leather runs out on.
// Measured off the driver's own sole probes on the harness's stance: 0.222 of a rig
// unit on the stride foot and 0.250 on the pivot's, which is the one the placement is
// read from. It is a *measured* constant rather than a read of the model, because the
// sole is the driver's geometry and this module solves the stance before there is a
// model to ask (the browser suite is where the two are held together).
export const SHOE_LEAD = 0.25

// How far the trunk may *tilt* toward the throwing side — out over the rubber's own
// edge — in radians, which is the whole of what a delivery answers a pitch's own
// lateral with: the upper body rolls about the body's own fore/aft line, so the shoulder
// the arm hangs from goes out over the leather by the socket's own height above the hip
// pivot (half a rig unit, and the only lever a roll has), while the pelvis is *carried*
// by the same roll and the legs under it are asked for nothing they were not already
// doing: there is no lateral translation of the body for the feet to have been left
// behind by, and no crouch taken out of the drive leg to pay for one (see
// `pitcherRelease`, which solves the angle, its own `rollLift`, which pays the drive
// socket back the height the roll carries it up by, and the pose's own ``tilt``).
//
// A quarter of a circle of roll is what this end of the band is worth — 0.508 of a rig
// unit of socket over the pivot at a sine of 0.5, so four-and-twenty centimetres across
// — and it is the *first* of the delivery's two lateral levers: what it cannot reach is
// carried by the body's own step (see STANCE_SIDE_MAX below), because the tilt is the
// lever that costs the legs nothing and the step is the lever that has somewhere to go
// (a stride foot is a foot in the air).
export const TRUNK_TILT_MAX = 0.5

// ...and how far the *body* may be carried across its own stance — out over the rubber's
// own edge — in the rig's own units, and how much of its height that carry may cost. The
// second lever, and the one the step pays for: what the tilt above cannot reach is what
// the delivery *steps* into, so the lateral goes out with the stride — the pelvis is
// carried across by it (see the pose's own ``offsetX``, which draws it) and the stride
// foot's own step is authored across by the same metres (see STEP_TRACK below), which is
// what makes it a step rather than a slide: the foot in the air goes where the body goes,
// and the leg under it keeps its own shape instead of fighting the carry.
//
// What it costs is the *drive* leg, and that is the trade the two levers are: the drive
// foot is pinned to the rubber (a pitcher stands where he stands), so a pelvis carried
// off that foot by ``lean`` stands on a leg slanted out from under it — a straight rod
// (the pair below is one allowance precisely so that it stays straight: a pelvis the
// lean of ``STANCE_SIDE_MAX`` out from its own ankle has to come down by whatever the
// leg under it can no longer span, and what is left over is the slant, six tenths of a
// rig unit across a 0.855 leg being four-and-forty degrees of it) — and it is the one
// part of the delivery the tilt above is *for*. A pitch standing wider than the tilt,
// the body's own carry and the arm's cone together reach comes back as the profile's
// ``sideShortfall``, and the mound's own leather is what the placement has left (see
// PIVOT_SIDE above and `pitcherPlacement`).
export const STANCE_SIDE_MAX = 0.6
export const STANCE_DIP_MAX = 0.2

// The statures a staff's pitchers span, in metres: five foot six to six foot
// eleven. The band is what the pitcher's own listed height is held inside (see
// `pitcherProfile`), so the body a pitch is thrown by is a person's size — the
// number the feed carries, clamped — rather than a stature solved from the pitch.
export const STATURE_BAND = [1.68, 2.11]

// The arm's own angle band at the release, in radians, as Statcast reads a slot:
// nought is level with the shoulder, a right angle is straight over the top, and
// negative is under it (see `armAngle`). The band is the real staff's own span — a
// submarine's arm at the bottom, an over-the-top arm's at the top; Savant's own
// readings for a season run from -67° (Tyler Rogers) to +73° (Trey Yesavage) — and a
// shade over the top of it, because the model's own arm is the short end of a
// person's (0.38 of the stature over the reach a release is thrown with, where a
// real staff's arms run to half again): standing the tallest slot a real staff
// throws up on this rig's own shoulder asks about 76°, so the band holds 77°. What a
// slot past either end gets is the arm's own end and a reported shortfall (see
// ``slotCeiling``), and what the band is *for* is the other half of the release
// posture: the shoulder the arm hangs off (see `releasePosture`).
export const ARM_ANGLE_BAND = { low: (-67 * Math.PI) / 180, high: (77 * Math.PI) / 180 }

// The release shoulder's own height at the two ends of that band, as a share of the
// pitcher's stature: a submarine's shoulder folds down toward a half, an over-the-top
// arm's stands at three quarters (see `releaseShoulderShare`). It is the number the
// *slot* owns rather than the delivery: a real staff's release shoulder is not one
// posture — the model's used to stand every pitch at 0.628 of the stature, where the
// real staff's own arm angles imply 0.53 at the bottom and 0.78 at the top — and a
// shoulder authored to one height is an arm asked to reach past its own band to
// answer for the slots at the other end of the staff.
const SHOULDER_SHARE = { low: 0.53, high: 0.78 }
// ...and the same law as the straight line it is: the shoulder's share read off the
// arm's own sine, laid across the band's two ends. The pair below is what the pair
// above is worth — the share at a level arm and the rise per unit of sine — derived
// once so the ends and the read can never drift apart.
const SHOULDER_SIN = { low: Math.sin(ARM_ANGLE_BAND.low), high: Math.sin(ARM_ANGLE_BAND.high) }
const SHOULDER_RISE = (SHOULDER_SHARE.high - SHOULDER_SHARE.low) / (SHOULDER_SIN.high - SHOULDER_SIN.low)
const SHOULDER_FLAT = SHOULDER_SHARE.high - SHOULDER_RISE * SHOULDER_SIN.high

// How much of the authored delivery's own forward movement a pitch may be thrown
// with, as the share of it a shorter or a longer one is drawn at (see `pitcherPose`'s
// ``stride`` and `pitcherProfile`, which solves it). It is the one number a pitch's
// own extension spends when the stance's own leather cannot cover it, so the band is
// how far the app lets a delivery be from the one that was authored: two fifths of
// the stride is a body that barely steps (a real short delivery, and not a shuffle),
// and half again the authored one is a body thrown at the plate with everything it
// has. Between them the band carries every extension a staff pitches with — four and
// a half feet of it to eight or so — with the drive foot still on the rubber.
export const STRIDE_BAND = [0.4, 1.6]

// The body's own ratios, as the ranges a real staff spans: arm, leg, trunk and head
// against the stature, the two limb segments against each other, and the two
// girdles' own breadths. They are the anthropometric measures (Drillis & Contini's
// segment ratios for the limbs and the trunk, ANSUR's breadths for the shoulders and
// the hips) with a hand's width either side of them, so a model whose limbs were
// authored a little long or a little short still reads as a person instead of being
// redrawn. What they are for is `clampProportions` below: a rig outside them is
// driven to them rather than as it stands.
// ``armSpan`` is the one row that is *derived* rather than held: the two arms and the
// two sockets together are the arm's own band and the shoulder's, so what its range
// is is the widest and the narrowest body those two allow — 2 x 0.395 + 0.20 through
// 2 x 0.50 + 0.28 — and a body inside both of them cannot fall outside it. (A real
// staff sits in the lower half of it: a person's own fingertip-to-fingertip span is
// about 1.02 to 1.11 of the stature, and the sockets it is measured between are
// narrower than the shoulders the span is usually quoted across.)
export const PROPORTION_BANDS = {
  arm: [0.395, 0.50],      // shoulder socket to fingertip, over the stature
  armSpan: [0.99, 1.28],   // derived: the arm's own band and the girdle's, together
  forearm: [0.75, 0.95],   // forearm over upper arm
  leg: [0.45, 0.56],       // hip socket to the ground, over the stature
  shin: [0.88, 1.12],      // shin over thigh
  trunk: [0.25, 0.33],     // hip socket to shoulder socket, over the stature
  neck: [0.035, 0.065],    // shoulder to neck joint, over the stature
  head: [0.055, 0.09],     // neck joint to head joint, over the stature
  crown: [0.09, 0.15],     // head joint to the top of the head, over the stature
  // The two girdles, read the way `measurePlayerRig` reads them: the *joints'* own
  // spacing across the body (the arm roots and the leg sockets), not the breadth of
  // the bones they hang from — a shoulder joint's line is a good deal narrower than
  // the acromion-to-acromion width the measure is usually quoted as, and the hip
  // sockets sit inside the pelvis's own.
  shoulder: [0.20, 0.28],  // the two shoulder sockets, over the stature
  hip: [0.09, 0.14],       // the two hip sockets, over the stature
}

// The crown above the head joint, as a share of the stature, for a rig that cannot
// be asked for the model's own height (`measurePlayerRig`'s modelHeight): the head
// joint sits at the skull's base and the crown an eighth of a stature over it.
const CROWN_SHARE = 0.12

// How far a straight arm's own chord falls short of its two bones' own span. A real
// elbow does not lock, and the driver does not build one that has: an arm asked for
// its last degree of extension is answered by the hand coming back along the arm's
// line to the longest reach that keeps ELBOW_BEND_MAX of bend (see the driver's
// bendChord). The pose asks for *that* number, so "fully straight" is the straightest
// arm the rig can hold rather than an ask the driver has to refuse.
// ...and it is the *body's* own limit rather than the release's, because the anchor is
// built off this chord and the anchor is what the whole profile is placed by: the
// ball's own place in the body's frame, and with it the stride the delivery is solved
// for and the staff curve the profile is held to. A straighter ask is a longer chord,
// and a longer chord carries the ball a few millimetres further down the arm's own
// line — measured, ten degrees here walked a tall slot's stance a good ten centimetres
// along the rubber and tied two of a sampled staff's three extensions to one delivery
// (see the unit suite's own ordering). So the *profile* keeps the driver's own limit,
// and the release hands the throwing arm its own, straighter one beside it — paid out
// of the hand's own carry rather than out of the ball's place (see RELEASE_ELBOW).
const ELBOW_STRAIGHT = (165 * Math.PI) / 180

// The throwing arm's own elbow limit at the release, in radians: the arm a pitch
// leaves on, which is not the bow a hand carried near the body is. The pose hands it —
// with the girdle's own budget beside it (see `pitcherPose`'s arm output, and the
// driver's solveOpenArm, which reads both per arm) — and what it costs the ball is
// nothing: the straighter chord is a longer reach, and the *hand's* carry gives the
// difference back, so the wrist stands a longer chord from the socket while the ball
// stays on the release point the profile placed the body for. That is the whole reason
// the limit is handed rather than built into the anchor: the anchor's own chord is the
// body's placement, and the release's own arm is the pitch's.
//
// The read is a shade *over* the pose's own ask rather than the ask itself — 179°, for
// the same reason the bow is 165 rather than 180: an ask is a limit and a reading is
// always inside it. It is over it by more than a whisker here, because the driver's
// own bookkeeping is done in the *model's* bone lengths and the elbow it really builds
// is a couple of tenths of a millimetre longer than that: at this end of the range the
// realised elbow angle is a steep function of the chord (some four thousand degrees of
// it to the rig unit), so the two tenths are worth nearly three degrees of reading
// (measured off the realised skeleton: an ask of 176.5° and one of 177.7° both read
// 174.87° — the ask moves the chord by a hand's *hundredth* of a millimetre and the
// chord is what the reading is made of). The ask is set so the *reading* clears what
// the delivery promises — an arm extended, the two bones within a few degrees of one
// straight line, and above 175° at the frame the ball goes — rather than so the ask
// itself reads like a straight arm: a bound written at the ask's own number is a bound
// the reading can never clear (see the browser suite's release test).
export const RELEASE_ELBOW = (179 * Math.PI) / 180

// What the *reading* of that ask is, and why it is not the ask's own number. The pose
// hands the driver a place and a chord; the driver answers with the model's own chain,
// and the elbow it builds stands off the arm the pose's metrics describe by a fraction
// of a millimetre of either bone — and at this end of the range the elbow angle is a
// steep function of the chord (measured: some four thousand degrees of it to the rig
// unit), so that fraction is worth nearly three degrees of arm. It is a ceiling rather
// than a tuning, because the driver's two-bone solve holds the wrist to the ask's chord
// and *stretches* the bones the moment the pose's own wrist stands past the span the
// metrics name: measured, a pose wrist a fifth of a millimetre outside that span reads
// 173.7° where the same arm just inside it reads 174.87° — the stretch is worth several
// degrees the other way, and there is no ask between them. So the straightest arm this
// pose *realises* is the ask's 179° read as 174.9° off the skeleton — the two bones
// within five degrees of one line, which is what "fully extended" is, and what the
// browser suite's release test holds. Moving the reading itself would mean measuring the
// rig's bones the way the driver's chain is built rather than from the model's own bind
// matrices (see `measurePlayerRig`), which moves every number the delivery is authored
// in.

/**
 * How far the plate is from the release point, in metres: the rubber stands 18.44 m
 * off the plate and the hand goes two metres up the mound's own slope and out past
 * the rubber, so what is left between the ball and the zone is nearly sixteen and a
 * half. It is the depth the *palm* is aimed down (see `pitcherPose`'s ``handPalm``),
 * where only the direction matters — two tenths of a metre on the depth is a tenth of
 * a degree on the bearing — so the number needs no company with the profile's own
 * placement to be right.
 */
const RELEASE_TO_PLATE = 16.4

/**
 * The longest chord a two-bone arm can hold at an elbow angle of ``bend``: the law
 * of cosines on the two bones, and the number the release's own reach is built from.
 * For the model's own arm (0.3145 and 0.2855) at the driver's limit it is 0.5949 of
 * the 0.600 the two bones span — a straight arm that still has a bend in it, which is
 * the straightest a limb reads.
 *
 * @param {number} upper the upper arm's own length
 * @param {number} fore the forearm's
 * @param {number} [bend=ELBOW_STRAIGHT] the elbow's own angle, radians
 */
export function straightChord(upper, fore, bend = ELBOW_STRAIGHT) {
  return Math.sqrt(Math.max(0, upper * upper + fore * fore - 2 * upper * fore * Math.cos(bend)))
}

// How far the driver will *stretch* a bone for an ask its arm cannot reach, which is
// the ceiling every chord below is read at (see ARM_STRETCH_MAX in util/playerRig.js,
// which is where the number lives — the pose stands at the same one because the two
// have to agree about what the arm can hold: a hand asked past a straight arm is a
// stretched one, and both of them read the chord off the bones the stretch leaves).
// Named here rather than imported: the driver is the model's own bookkeeping and the
// pose is the pitch's, and the one thing they share is this limit rather than a module.
const ARM_STRETCH_MAX = 1.25

// The whisker every ask in this file is kept *inside* a limit by, in rig units of the
// arm's own length (see `snap`, which carries the same two millimetres). It is there
// because an ask is a limit and not a place: the release's own wrist is authored a
// twenty-thousandth of a span past its chord on purpose, so that the driver's own solve
// lands the elbow on the angle the release is read at (see RELEASE_ELBOW) rather than a
// couple of degrees inside it — and a rule that moved a place already inside the arm's
// own reach would be moving the release's ask out from under that reading.
const ASK_WHISKER = 0.002
// The little of the arm's own span the pose leaves the body's own rules when it answers
// with the chord the driver holds (see the chord read in `pitcherPose`): the pose's
// socket is an estimate and the body's is the body's — a centimetre apart at the cock on
// both the centred and the wide pitch, measured along the ask — so a hand asked for the
// very chord is a hand the driver's clip pulls back by that centimetre. Two per cent of
// the span is a little over that centimetre on this rig's 0.600 m arm, costs the bend
// about a degree at a cocked arm, and is not spent at all where the ask is the chord
// itself (the release's anchor, whose ask is inside the whisker by construction).
const ARM_KEEP_SHARE = 0.02

// How far the glove's own place is swung out of the chest by the frame the fold tops out
// on, in rig units: the width it takes for the mitt's arm to stay out of a trunk that is
// folded most of a right angle over it.
//
// The mitt is authored against a standing body, and the trunk comes over it by up to a
// radian through the finish (see holdFoldAt), so the arm's own ring — the circle its two
// bones draw about the chord — loses its clear arc: the driver's clearance rule has
// nothing to answer with and the arm sits inside the body (measured, 16.8 mm inside at
// 1.96 s against its 12 mm bound, the elbow stepping 4 cm on the frame the rule changed
// its mind). A hand's width of swing is all it takes, and it has to be a *swing*: a nudge
// out along the chest's own lateral is a longer ask, and the driver answers that by
// folding the elbow and pulling the wrist 28 mm off the pose (measured at 1.66 s), where
// the same width spent as a turn about the chest's forward axis is a swing the arm already
// has in it. Twenty-two millimetres leaves the frame at 1.90 s a hair inside, and the
// driver answers *that* by folding the arm 13% and pulling the wrist 27 mm off the pose,
// so the width is the one that leaves no frame for it to answer: 27 mm. Nought with the
// fold, whole from the crossing to the pause, and nought again by the frame the recovery
// has stood him up.
const GLOVE_SWING = 0.027

// The radius the pose hands an elbow's own *pole* to the driver at, in rig units.
//
// A pole is a direction and not a place: the driver reads the upper arm's own line
// from the live socket to the point and takes the point's distance from that socket as
// nought (see the driver's own note). What the keys author is where the line *points*,
// written where the arm is — within a third of a unit of the socket, which is what an
// elbow's own place looks like on a body — and that is a direction the driver can only
// read as far as the two sockets agree, which they do not: the pose's socket is the
// body's own turn (see the chord read in `pitcherPose`) while the driver's shoulder
// rides the clavicle it is swinging, and across the fold the two stand five to a dozen
// centimetres apart (measured on the realised skeleton: 0.05-0.12 of a rig unit between
// 1.58 s and 1.66 s, the clavicle's own hand-over being what moves). At the arm's own
// radius that error re-aims the direction a dozen to two dozen degrees, and the ring
// the fold's own elbow hangs on is nine or ten degrees wide, so the plane the elbow is
// placed on is the *estimate's* rather than the pose's: the elbow swings round its
// chord by the ring's whole radius, which is the throwing arm's flick up across the
// drive leg (read on the realised skeleton: 20.6° of upper arm in the one frame at
// 1.6125 s, against 6.6° on the frames either side of it, with the bend held still).
// Handed out at this radius instead — twenty-five times the width of that ring, five
// times the widest the sockets disagree — the same direction arrives as the authored
// one to within three degrees, and the ring, the fold and the bend with it are the
// pose's own again.
const POLE_REACH = 1.5

// The forearm's own line, off the pose's own model of the driver's two-bone solve:
// the elbow sits on the ring the two bones draw about the chord — at the distance
// the law of cosines puts it from the socket along the chord, swung to the pole's
// own side of it — and the forearm runs from there to the wrist (see the driver's
// open-arm solve, whose ring this is). It is what "the hand's line is the
// forearm's" has to be read against: a wrist's angle is the hand's line off the
// forearm's, and the forearm's line is the *driver's* to say — the pose only
// authors where the wrist is and which side of it the elbow hangs on.
function forearmOf(socket, wrist, polePlace, upper, fore, straight, sweep, out) {
  // The same three moves the driver's own open-arm solve makes, in its order (see
  // util/playerRig.js): the bones *stretch* for an ask past the arm's own span, the
  // frame's own bend caps the chord the wrist may stand at, and the sweep carries a
  // short ask out to that cap — the line is the pose's and the length is the arm's.
  // Only then is the elbow placed, on the ring the two bones draw about the chord,
  // swung to the pole's own side of it.
  const armSpan = upper + fore
  const reach = Math.hypot(wrist[0] - socket[0], wrist[1] - socket[1], wrist[2] - socket[2])
  const stretch = Math.min(1.25, Math.max(1, reach / armSpan))
  const up = upper * stretch
  const fr = fore * stretch
  const cap = Math.sqrt(Math.max(0, up * up + fr * fr - 2 * up * fr * Math.cos(straight)))
  let chord = reach
  if (sweep > 0 && reach > 1e-6 && reach < cap) chord = reach + (cap - reach) * sweep
  if (chord > cap) chord = cap
  const dir = reach > 1e-6
    ? [(wrist[0] - socket[0]) / reach, (wrist[1] - socket[1]) / reach, (wrist[2] - socket[2]) / reach]
    : [0, -1, 0]
  if (chord > (up + fr) * 0.999) chord = (up + fr) * 0.999
  const along = (chord * chord + up * up - fr * fr) / (2 * chord)
  const radius = Math.sqrt(Math.max(0, up * up - along * along))
  const pole = [polePlace[0] - socket[0], polePlace[1] - socket[1], polePlace[2] - socket[2]]
  const share = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2]
  const perp = [pole[0] - dir[0] * share, pole[1] - dir[1] * share, pole[2] - dir[2] * share]
  let perpLength = Math.hypot(perp[0], perp[1], perp[2])
  // ...and the same side read off the caller's own first chord (see the pose's
  // two-step), kept as the fallback below: it is the same pole, the same ring and
  // the same side — only the chord it is read against is the ball's rather than the
  // wrist's, which is the one pair the carry's own lean on the hand's line cannot
  // put in the same line as each other.
  const sideLength = Math.hypot(_ringSide[0], _ringSide[1], _ringSide[2])
  // A pole stood down the chord's own line leaves the ring no side to be read off
  // (see the driver's own fallback): the up axis stands in for it — and here the
  // two are *faded* into each other by the margin rather than switched, because
  // the pose's own socket is an estimate (see its note) and a side read hard off a
  // chord that stands a couple of centimetres from the body's own is the one place
  // that estimate is unforgiving: the hand's whole line hangs on which side of the
  // chord the elbow is read, and a side that decides differently one frame to the
  // next steps the hand half a rig unit (measured on the come-through, where the
  // pole sweeps down the chord's own line as the trunk folds).
  const poleLength = Math.hypot(pole[0], pole[1], pole[2]) || 1
  const weight = Math.min(1, perpLength / poleLength / 0.3)
  if (weight < 1) {
    // The fallback is the side the *world's* up axis puts on the chord — which is a side
    // no stretch of the pole can take away, and the one the driver's own solve falls back
    // on. Where the chord itself is near the up axis that perpendicular shrinks, and the
    // caller's own first side stands in for it (see the two-step above); where neither is
    // left, the last resort below answers as it always did.
    let other = _ringSide.slice()
    let otherLength = sideLength
    if (otherLength > 1e-6) {
      const share2 = _ringSide[0] * dir[0] + _ringSide[1] * dir[1] + _ringSide[2] * dir[2]
      other[0] -= dir[0] * share2
      other[1] -= dir[1] * share2
      other[2] -= dir[2] * share2
      otherLength = Math.hypot(other[0], other[1], other[2])
    }
    if (otherLength < 1e-6) {
      other = [dir[2], 0, -dir[0]]
      otherLength = Math.hypot(other[0], other[1], other[2])
    }
    if (otherLength > 1e-6) {
      const scale = perpLength / poleLength
      // ...and the fallback is read on the *pole's* own side: two sides that oppose each
      // other cannot be faded into one another — the sum walks through nought and the
      // hand steps to the other end of the ring in a frame (measured, 0.45 of a rig unit
      // at 1.288 s, where the whip's pole runs down the ball's own chord). Flipped to
      // agree, the fade is a turn rather than a jump, and the side the frame settles on
      // is the pole's own wherever the pole has one to give.
      const agree = perp[0] * other[0] + perp[1] * other[1] + perp[2] * other[2] < 0 ? -1 : 1
      perp[0] = perp[0] * weight + agree * (other[0] / otherLength) * scale * (1 - weight)
      perp[1] = perp[1] * weight + agree * (other[1] / otherLength) * scale * (1 - weight)
      perp[2] = perp[2] * weight + agree * (other[2] / otherLength) * scale * (1 - weight)
      perpLength = Math.hypot(perp[0], perp[1], perp[2]) || 1
    }
  }
  // The up axis stands in where neither chord leaves the ring a side (see the
  // driver's own fallback).
  if (perpLength < 1e-6) {
    perp[0] = dir[2]
    perp[1] = 0
    perp[2] = -dir[0]
    perpLength = Math.hypot(perp[0], perp[1], perp[2]) || 1
  }
  _ringSide[0] = perp[0] / perpLength
  _ringSide[1] = perp[1] / perpLength
  _ringSide[2] = perp[2] / perpLength
  out[0] = dir[0] * (chord - along) - (perp[0] / perpLength) * radius
  out[1] = dir[1] * (chord - along) - (perp[1] / perpLength) * radius
  out[2] = dir[2] * (chord - along) - (perp[2] / perpLength) * radius
  const length = Math.hypot(out[0], out[1], out[2]) || 1
  out[0] /= length
  out[1] /= length
  out[2] /= length
  return out
}

/**
 * Holds one frame's elbow under the plane the two shoulder sockets draw: turns the
 * elbow's own place about the socket-to-ball chord until what is left of it *above*
 * that plane is nought (see SHOULDER_PLANE_IN, which says which frames the rule
 * binds on).
 *
 * The turn is about the chord rather than about the world's up, and that is the whole
 * of what keeps the arm's shape: the elbow's own ring is a circle about the chord, so
 * a turn along it moves the elbow round the arm's fold without lengthening the arm,
 * folding it further, or moving the hand at all. What it decides is which way round
 * the ring the arm is carried — the same degree of freedom the pose's pole names, and
 * the one a low slot's upper arm is read by.
 *
 * ``share`` is the rule's own weight for the frame (nought outside the windup, one
 * through it, easing out across the whip — see the constants above), and an elbow
 * already at or under the plane is returned untouched: the rule only ever takes the
 * arm down, never lifts it.
 *
 * @param {number[]} at the elbow's place, in the rig frame (written in place)
 * @param {number[]} socket the shoulder the arm hangs from, in the rig frame
 * @param {number[]} line the unit chord the arm's own hold runs along (socket to ball)
 * @param {number[]} up the unit normal of the sockets' plane (the chest's own up)
 * @param {number} share the frame's own weight, nought to one
 * @returns {number[]} ``at``
 */
function holdUnderShoulders(at, socket, line, up, share) {
  if (share <= 0) return at
  const [ax, ay, az] = line
  const ex = at[0] - socket[0]
  const ey = at[1] - socket[1]
  const ez = at[2] - socket[2]
  const along = ex * ax + ey * ay + ez * az
  // The elbow's own ring about the chord: what is left of the offset once the chord's
  // share is taken off it. The arm's whole offset climbs by ``along·(chord·up)`` with
  // the chord, and only the ring's own part of it is the pose's to turn.
  let px = ex - ax * along
  let py = ey - ay * along
  let pz = ez - az * along
  const chordRise = (ax * up[0] + ay * up[1] + az * up[2]) * along
  // ...and the elbow's own rise over the plane, split as the ring reads it: the offset
  // above the chord's line (``a``) and the turn about the chord (``b``) — ``a·cosθ +
  // b·sinθ`` is the height the elbow comes to after a turn of θ.
  const a = px * up[0] + py * up[1] + pz * up[2]
  const cx = ay * pz - az * py
  const cy = az * px - ax * pz
  const cz = ax * py - ay * px
  const b = cx * up[0] + cy * up[1] + cz * up[2]
  const radius = Math.hypot(a, b)
  if (radius < 1e-9) return at
  // An elbow already at or under the plane is left exactly where it is: the rule only
  // ever takes the arm down, never lifts it.
  const rise = chordRise + a
  if (rise <= 1e-12) return at
  // What the ring's own rise has to be for the elbow to sit on the plane: the whole of
  // the frame's climb less the rule's own share of it, which is the plane for a share
  // of one and the elbow's own place for a share of nought.
  const target = rise * (1 - share) - chordRise
  const want = Math.max(-radius, Math.min(radius, target))
  const phi = Math.atan2(b, a)
  const spread = Math.acos(Math.max(-1, Math.min(1, want / radius)))
  // The two turns that answer it — the elbow can come down on either side of the ring
  // — and the nearer of them is the one that only ever moves the arm as far as the
  // plane, never round its other side.
  let one = phi + spread
  let two = phi - spread
  const wrap = (angle) => {
    let turned = angle
    while (turned > Math.PI) turned -= Math.PI * 2
    while (turned < -Math.PI) turned += Math.PI * 2
    return turned
  }
  one = wrap(one)
  two = wrap(two)
  const angle = Math.abs(one) <= Math.abs(two) ? one : two
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  px = px * cos + cx * sin
  py = py * cos + cy * sin
  pz = pz * cos + cz * sin
  at[0] = socket[0] + ax * along + px
  at[1] = socket[1] + ay * along + py
  at[2] = socket[2] + az * along + pz
  return at
}

// The wrist's own cock, key by key: the angle the hand's own line is drawn *back*
// off the forearm's by, in radians. Nought is the relaxed hand — the palm/forearm
// joint at its own 180°, the hand running on down the arm it hangs on — and the
// cock is the joint opening *past* it: the hand drawn back off the forearm, which
// is what a throwing wrist loads with.
//
// It is nought for the whole of the delivery up to the ball: the hand is locked to
// the forearm it hangs on from the moment it leaves the glove to the frame the ball
// goes, so what the arm's own rise and the cock's fold do to the hand is *carried*
// rather than answered — the wrist is not a second joint working against the elbow.
// (The reference delivery does not cock its wrist on the way back, either: what
// looks like a cocked hand at the layback is the hand still running on down a
// forearm that has been folded up behind it. The old schedule here loaded twenty
// degrees across the come-through and fired it off into the release, which is a
// wrist moving while the arm is already moving — one more thing to time, on the two
// frames that have the least time in them.)
const WRIST_COCK = [
  [1.05, 0],
  [AUTHORED_RELEASE_TIME, 0],
]
const WRIST_COCK_TIMES = WRIST_COCK.map(([t]) => t)
const WRIST_COCK_TRACK = WRIST_COCK.map(([, v]) => v)
// The window the hand's own line is read down the forearm's (see the pose's arm
// ask): in across the break, out across the release's own line taking over.
const ARM_ASK_IN = 1.10
const ARM_ASK_FULL = 1.12
const ARM_ASK_FADE = 1.32
const ARM_ASK_OUT = 1.36
const _foreArm = [0, 0, 0]
const _planeUp = [0, 0, 0]
const _armLine = [0, 0, 0]
const _wristHere = [0, 0, 0]
const _cockedAim = [0, 0, 0]
const _ringSide = [0, 0, 0]


/**
 * The stature a rig's own joints imply, in the units the rig is measured in: the head
 * joint plus the crown above it (see CROWN_SHARE). It is the denominator every ratio
 * below is read against — and it is read off the *joints* rather than off the height
 * `measurePlayerRig` takes off the model's bounding box, because the box is the model
 * with its cap on and its cleats on: this model's box stands 2.00 m and its head joint
 * is 1.65 with a crown's own 0.22 over it, so a body read against the box comes out
 * with arms at 0.37 of its stature — a species no staff has, and every chain of it
 * driven up to the band. The box is still the number the *crown* row is read against,
 * where a tall box is a fact about the model rather than about the body (see the
 * ``crown`` band).
 */
export function statureOf(rig) {
  return rig.headY / (1 - CROWN_SHARE)
}

/**
 * The body's proportions, clamped to the ranges a real staff spans (see
 * PROPORTION_BANDS): what the delivery and the placement are handed, rather than
 * the rig as it was measured.
 *
 * The clamp is per *chain*, because that is what the driver moves: the arm's two
 * bones and the hand together, the leg's two, the trunk between the hip socket and
 * the shoulder socket, and the head above it. Each one that is out of its band is
 * scaled to the band's own edge, and the joints between the chains are carried with
 * them — the hip socket stays on the leg it stands on (ankleY + thigh + shin, which
 * is how `measurePlayerRig` reads it), the shoulder socket stays a trunk above the
 * hip, the neck and the head stay above the shoulder — so the rig that comes back is
 * a skeleton, not a set of numbers that disagree.
 *
 * @param {object} rig result of measurePlayerRig
 * @param {object} [options]
 * @param {number} [options.stature] the body's own height, in metres (defaults to
 *   the rig's own read, see `statureOf`)
 * @returns {{rig: object, stature: number, bands: object}} the clamped rig, the
 *   stature it was clamped against, and one row per band: the measured ratio, the
 *   band, and whether it was the band or the rig that won
 */
export function clampProportions(rig, { stature = null } = {}) {
  const height = stature ?? statureOf(rig)
  const out = {
    ...rig,
    hip: { ...rig.hip },
    shoulder: { ...rig.shoulder },
    arm: { ...rig.arm },
    leg: { ...rig.leg },
  }
  const bands = {}
  // One ratio, held to its band: what the rig has, the band it is held to, and the
  // factor the chain it belongs to is scaled by (one where the rig is inside it).
  // What is returned is the clamped ratio, so a chain whose two bones are being
  // re-divided can ask for the number to divide them by.
  const hold = (name, measured) => {
    const [low, high] = PROPORTION_BANDS[name]
    const want = clamp(measured, low, high)
    bands[name] = { measured, band: [low, high], factor: measured > 1e-9 ? want / measured : 1 }
    return want
  }
  // ...and the same read as the *factor* a chain is scaled by: one where the rig is
  // already inside its band, and the band's own edge over what it measured otherwise.
  const factor = (name, measured) => {
    const want = hold(name, measured)
    return measured > 1e-9 ? want / measured : 1
  }
  const ratio = (a, b) => a / Math.max(1e-9, b)

  // The arm: its share of the stature, and the two bones' own balance. Both are spent
  // on the same pair of bones, in that order — a chain that is too long is brought in
  // whole (the hand with it), and one whose forearm is out of proportion is then
  // re-divided over the length it has, so a clamped arm is still an arm rather than a
  // number that no longer adds up.
  const armLength = out.arm.upper + out.arm.fore + out.arm.hand
  const armFactor = factor('arm', ratio(armLength, height))
  out.arm.upper *= armFactor
  out.arm.fore *= armFactor
  out.arm.hand *= armFactor
  const fore = out.arm.upper + out.arm.fore
  const foreRatio = hold('forearm', ratio(out.arm.fore, out.arm.upper))
  out.arm.upper = fore / (1 + foreRatio)
  out.arm.fore = fore - out.arm.upper

  // The leg, and the two bones it stands on: the socket stays on the leg, so the
  // pelvis' own height is read off the leg rather than left where it was.
  const legLength = out.hip.y - out.ankleY
  const legFactor = factor('leg', ratio(legLength, height))
  out.leg.thigh *= legFactor
  out.leg.shin *= legFactor
  const leg = out.leg.thigh + out.leg.shin
  const shinRatio = hold('shin', ratio(out.leg.shin, out.leg.thigh))
  out.leg.shin = (leg * shinRatio) / (1 + shinRatio)
  out.leg.thigh = leg - out.leg.shin
  out.hip.y = out.ankleY + leg

  // The trunk, and the head above it: the shoulder socket is moved by whatever the
  // trunk's own ratio asks for, and the neck and the head ride with it so the body
  // above the pelvis stays the body it was measured as. The head's own ratios are
  // then read where they stand, and the head joint is moved to hold them.
  const trunkLength = out.shoulder.y - out.hip.y
  const above = out.shoulder.y
  out.shoulder.y = out.hip.y + trunkLength * factor('trunk', ratio(trunkLength, height))
  const lifted = out.shoulder.y - above
  out.neckY += lifted
  out.headY += lifted
  // ...and the neck's own length between them, so a giraffe's neck is *held* to the
  // band like every other chain rather than being the one number the clamp reads and
  // leaves: the joint moves and the head it carries moves with it (before its own
  // length above it is read, which is why the two are two passes and not one).
  const neckLength = out.neckY - out.shoulder.y
  out.neckY = out.shoulder.y + neckLength * factor('neck', ratio(neckLength, height))
  const headLength = out.headY - out.neckY
  out.headY = out.neckY + headLength * factor('head', ratio(headLength, height))
  if (rig.modelHeight > 0) hold('crown', ratio(rig.modelHeight - out.headY, height))

  // ...and the two girdles' own breadths, which are the last things a rig's
  // proportions can be wrong about.
  out.shoulder.halfWidth *= factor('shoulder', ratio(out.shoulder.halfWidth * 2, height))
  out.hip.halfWidth *= factor('hip', ratio(out.hip.halfWidth * 2, height))

  // The span the fingertips draw, read where the arm's and the girdle's own clamps
  // have both been spent: it is not a chain of its own — the two clamps above are what
  // hold it — so what this leaves in ``bands`` is the read the tests hold rather than
  // a factor anything is scaled by.
  hold('armSpan', ratio(
    (out.arm.upper + out.arm.fore + out.arm.hand) * 2 + out.shoulder.halfWidth * 2,
    height,
  ))

  return { rig: out, stature: height, bands }
}

/**
 * The arm's own angle at the release, in degrees: how far the line from the socket to
 * the ball stands above the horizontal. It is Statcast's own reading of a slot —
 * nought is level with the shoulder (a sidearmer), ninety is straight over the top,
 * and negative is a submarine's arm below it — measured in the vertical plane the arm
 * itself swings in rather than in the frontal plane, because it is the *arm* the pose
 * drives and the ball it carries that are read here. The release's own coordinates
 * decide it: the arm is straight, so the line from the shoulder to the ball is the
 * arm, and the angle is that line's elevation.
 */
export function armAngle(shoulder, ball) {
  const up = ball[1] - shoulder[1]
  const out = Math.hypot(ball[0] - shoulder[0], ball[2] - shoulder[2])
  return (Math.atan2(up, out) * 180) / Math.PI
}

/**
 * How far the authored delivery folds forward at a slot, by how high that slot is:
 * a deep fold at the bottom of the range, a nearly upright torso at the top. It is
 * the *keys'* own lean track over the slot band — the reference the authored slot
 * window is written around — rather than the posture a real pitch is thrown at any
 * more: a release's fold is solved from the slot's own arm angle (see
 * `releasePosture`), and this read is what the reference height above is derived
 * from and what the tests read the authored shape against.
 */
export function releaseLean(height) {
  const share = clamp((height - SLOT_LOW_M) / (SLOT_HIGH_M - SLOT_LOW_M), 0, 1)
  return LEAN_LOW + (LEAN_HIGH - LEAN_LOW) * share
}

/**
 * The release shoulder's own height as a share of the stature, by the arm's own
 * angle at the release (see `armAngle`): the line through SHOULDER_SHARE's two ends,
 * so a submarine's arm reads its shoulder at 0.53 and an over-the-top arm's at 0.78.
 * It is one half of the release posture; the other half is the fold that stands the
 * shoulder there (see `releasePosture`).
 */
export function releaseShoulderShare(angle) {
  return SHOULDER_FLAT + SHOULDER_RISE * Math.sin(angle)
}

// How deep the release's own fold is drawn, in radians: past this the trunk is
// folded onto its own hips and the pose has no more fold to give, so a slot under
// the body's own floor comes back at this end instead of folding further (see
// `releasePosture` and ``slotCeiling``).
const RELEASE_FOLD_DEEP = 1.6

/**
 * The body's own highest stand, in the rig's units: the fold that puts the shoulder
 * socket topmost, and the socket's height there. A body's tallest release is not a
 * fold of nought — the trunk's rest already leans a little and the socket sits a
 * shade forward of the hip pivot, so standing the socket highest asks the trunk a few
 * degrees *past* its own rest — and it is the rig's own answer, read rather than
 * authored, because the proportions a pitcher is clamped to carry their socket a
 * little differently. It is where a slot the body cannot stand up to is answered
 * from (see `slotCeiling`).
 */
// The pelvis' own rest pivot: the place the driver turns and leans the upper body
// from — the spine bone, a hand's width below and behind the hip sockets the legs
// hang from (see measurePlayerRig's ``hipY``/``hipZ``). The release anchor is the one
// place in the pose that is a *world* place the driver has to land on, so it is the
// one place the pose's own estimate of the chest cannot be wrong: rotating the
// shoulder's offset about the hip sockets instead of about this pivot leaves the
// socket a couple of centimetres from where the driver's body puts it, the arm is
// asked for its straightest chord from that phantom socket, and the elbow folds to
// hold a wrist the driver's body has already reached (measured at the release: 2.8 cm
// of socket, and 142° of elbow where the ask was 165°). A rig that does not report a
// pivot — the tests' own hand-written one — falls back to its hip sockets.
function torsoPivot(rig) {
  return {
    y: rig.hipY ?? rig.hip.y,
    z: rig.hipZ ?? rig.hip.z,
  }
}

/**
 * What a pose's own socket is *short by* when the rig turns the ribcage about the waist
 * joint instead of about the pelvis' pivot: the joint's own offset from that pivot,
 * carried by the pelvis' turn less the same offset carried by the trunk's.
 *
 * Both carries are the driver's own composition. Its trunk turns about the joint (see
 * its placement of the waist bone), and the joint itself rides on the pelvis: the
 * hips take the trunk's turn with the separation rolled back, so the pelvis' carry of
 * any offset is that offset first turned by the separation's own yaw, then by the trunk.
 * The pose has all three — the joint (`waistJoint`, measured when the body is shaped),
 * the trunk's turn and the keys' own separation — so the difference is one subtraction.
 */
function jointCarry(turn, joint, separation) {
  const rolled = rotateY(joint, -separation)
  const byPelvis = turnVector(turn, rolled)
  const byTrunk = turnVector(turn, joint)
  return [
    byPelvis[0] - byTrunk[0],
    byPelvis[1] - byTrunk[1],
    byPelvis[2] - byTrunk[2],
  ]
}

function releaseStand({ rig, hand, hipY, drive, tilt = 0, stance = 0 }) {
  let best = { lean: 0, socketY: -Infinity }
  for (let lean = -0.5; lean <= 0.05; lean += 0.002) {
    const { shoulder, socket } = releaseShoulder({ rig, hand, lean, tilt, stance, hipY, drive })
    if (shoulder.y + socket[1] > best.socketY) best = { lean, socketY: shoulder.y + socket[1] }
  }
  return best
}

/**
 * The release posture for one pitch: the shoulder the slot's own arm angle stands
 * the body at, and the fold that stands it there. One solve, because the two are
 * one posture:
 *
 *   * the slot *is* the shoulder plus the arm's own lift over it — both of them
 *     rising with the arm's angle's own sine (``share = shoulderShare +
 *     reachShare·sin``) — so the law's shoulder and the pitch's slot together name
 *     the angle outright, and the read is one division rather than a search;
 *   * the fold is the body's own answer for that angle: deeper toward the deep end
 *     of `RELEASE_FOLD_DEEP` for a submarine's arm, out to the socket's own highest
 *     stand for the tallest slot a body can reach, and whatever the slot asks for in
 *     between. A slot the body cannot stand its shoulder to — a real staff's own
 *     seasonal top is a few centimetres past this rig's arm — comes back with the
 *     shoulder at the body's own end, and the release's own clamp, the band, is what
 *     the ball's height is then read against (see `pitcherRelease`).
 *
 * @param {number} [params.tilt=0] the trunk's own roll toward the throwing side, in
 *   radians, and [params.stance=0] the body's own carry across its stance, in the rig's
 *   own x (see `pitcherRelease`, which solves the two): the delivery's two lateral
 *   levers, the roll and the step. The roll rides the fold's own solve — it is a
 *   rotation of the body the fold is measured off, so the socket the law stands is the
 *   socket the pose really builds — while the carry is a pure translation and is
 *   deliberately read by nothing in that solve: a translation moves no height, and a
 *   carry that moved the *fold* would spend the release's forward lean on the lateral
 *   (the fold is what the pitch's own momentum comes down on).
 * @returns {{shoulder: object, socket: number[], trunk: object, turn: object,
 *   lean: number, angle: number, shoulderShare: number}} the shoulder frame the
 *   anchor hangs off, the fold the body stands at, the arm's own angle there, and
 *   the share of the stature the shoulder came out standing at
 */
export function releasePosture({ rig, hand = 'R', height, hipY = 0, drive = 0, tilt = 0, stance = 0 }) {
  const stature = statureOf(rig)
  const reach = straightChord(rig.arm.upper, rig.arm.fore) + releaseCarry(rig, hand)
  const sin = clamp(
    (height / stature - SHOULDER_FLAT) / (SHOULDER_RISE + reach / stature),
    SHOULDER_SIN.low,
    SHOULDER_SIN.high,
  )
  const wanted = (SHOULDER_FLAT + SHOULDER_RISE * sin) * stature
  // ...solved on the *rolled* body, not on a square one: the share the law names is the
  // height of the socket the arm really hangs from, and a trunk rolled toward the
  // throwing side carries that socket down by the cosine of its own roll (and the pelvis
  // down with it, see `rollLift`). Solving the fold square and then rolling the body
  // would leave the released socket a body's own roll *below* the share the pitch's arm
  // angle names — measured on a submarine's slot: 0.49 of the stature against the 0.55
  // the law stands at the angle that then comes off the arm. The roll rides the fold's
  // own solve for exactly that reason.
  const stand = releaseStand({ rig, hand, hipY, drive, tilt, stance })
  // The socket the arm hangs from is the point the law's share names — the shoulder's
  // own ball-and-socket, which is where a release's arm is measured from (Savant's own
  // ``arm_angle`` is the line from it to the ball) — and it sits a couple of
  // centimetres off the chest's centre that `releaseShoulder` also returns: the two
  // travel together, so the fold is solved on the socket and the centre is reported
  // with it.
  const socketHeight = (lean) => {
    const { shoulder, socket } = releaseShoulder({ rig, hand, lean, tilt, stance, hipY, drive })
    return shoulder.y + socket[1]
  }
  let lean = stand.lean
  if (wanted < stand.socketY) {
    // A lower shoulder is a deeper fold, and the fold's own height falls with it all
    // the way down (the stand is the top of that curve), so what the body stands at
    // is a bisection away — unless the slot is past the deep end, which comes back
    // at the end's own fold and reports the rest (see `pitcherRelease`).
    let low = stand.lean
    let high = RELEASE_FOLD_DEEP
    if (socketHeight(high) > wanted) {
      lean = high
    } else {
      for (let pass = 0; pass < 40; pass += 1) {
        const mid = (low + high) / 2
        if (socketHeight(mid) > wanted) low = mid
        else high = mid
      }
      lean = (low + high) / 2
    }
  }
  const { shoulder, socket, trunk, turn } = releaseShoulder({ rig, hand, lean, tilt, stance, hipY, drive })
  const socketY = shoulder.y + socket[1]
  return {
    shoulder,
    socket,
    socketY,
    trunk,
    turn,
    lean,
    angle: Math.asin(sin),
    shoulderShare: socketY / stature,
  }
}

/**
 * How much of the release window's own lean a frame takes: the authored tracks
 * carry the delivery's own shape, and the ``slot`` track says which frames are the
 * ones the pitch's release height gets a say in — nought until the arm is cocked,
 * all of it from the cock through the follow-through, and eased back out over the
 * recovery, so the delivery ends in the set it began in at any height.
 */
/**
 * The upper body's own turn at a frame of the delivery, as the sequence can know
 * it: the yaw about the body's up axis, then the forward fold, then the fold toward
 * the throwing side — the driver's own composition (see its applyPose), written in
 * the model's frame while the rig's is the model's turned about Y. The yaw is the
 * same turn in both frames and the folds run the other way, which is why a fold of
 * ``fold`` here is the driver's ``-fold``. Carrying the *positions* of the upper
 * body by this same turn — rather than by a fold taken on its own — is what keeps
 * the pose's own reads (the chest's centre, the glove's socket, the clasp's palm,
 * the release anchor) on the body the driver builds, and a body a quarter of the way
 * round is a hand's width of difference.
 */
export function upperTurn(yaw, fold, foldSide) {
  return {
    cy: Math.cos(yaw),
    sy: Math.sin(yaw),
    cx: Math.cos(-fold),
    sx: Math.sin(-fold),
    cz: Math.cos(-foldSide),
    sz: Math.sin(-foldSide),
  }
}

/** A rotation about one of the driver's own axes: what its euler composes, one at a
 * time and in the frame the last one left (see its applyPose). */
const rotateY = (v, angle) => [
  v[0] * Math.cos(angle) + v[2] * Math.sin(angle),
  v[1],
  -v[0] * Math.sin(angle) + v[2] * Math.cos(angle),
]
const rotateZ = (v, angle) => [
  v[0] * Math.cos(angle) - v[1] * Math.sin(angle),
  v[0] * Math.sin(angle) + v[1] * Math.cos(angle),
  v[2],
]

/**
 * The chest's own rest up, in the driver's frame: the shoulders are hinged to a
 * spine that already leans over its own hips, so the trunk a delivery turns starts a
 * little off upright (measured off the realised skeleton: 0.984 of upright, the rest
 * of it back along the driver's own -Z).
 */
const TRUNK_REST_UP = [0, 0.984, -0.18]
const TRUNK_REST_FOLD = Math.atan2(TRUNK_REST_UP[2], TRUNK_REST_UP[1])

/**
 * The two lean numbers a frame's trunk is *driven* by, from the two it is authored
 * with — which are not the same pair once the body has turned.
 *
 * ``lean`` and ``leanSide`` are the delivery's own promise about the trunk: the fold
 * at the *plate*, and the fold toward the throwing side — the pitch's line, not the
 * facing the body happens to hold. The driver leans the upper body in the body's own
 * frame (a yaw, then a fold), so a body turned 70° past the plate and handed the same
 * pair would come round with its trunk folded 70° off the pitch's line: the trunk
 * falling away toward the glove hand as the body turns, which is what a trunk
 * *carried* by the pitch does not do. What the driver is handed here is that pair
 * carried back through the body's own yaw, so the realised trunk stands on the axis
 * the hips are tilted along — at the plate, leaning, with the body's turn a rotation
 * about *that* axis rather than a cone the fold sweeps round.
 *
 * The turn itself is untouched: the yaw is the same number either way, so the pelvis',
 * the shoulders' and the feet's own turns are what the keys say they are.
 *
 * @returns {{leanX: number, leanZ: number}} the pose's own two numbers for the frame
 */
export function trunkLean(yaw, lean, leanSide) {
  // What the trunk's up is asked to be, in the driver's frame: at the plate by
  // ``lean`` (its +Z is the way the pitch goes) and toward the throwing side by
  // ``leanSide``.
  const up = [0, Math.cos(lean), Math.sin(lean)]
  const side = rotateZ(up, leanSide)
  // ...and carried back through the yaw the driver is about to apply.
  const m = rotateY(side, -yaw)
  // The fold pair that puts the chest's own rest up there: the side fold is what
  // moves it across (the rest up has none of its own, so the whole of the traverse
  // is the fold's), and the forward one then tips the rest of the way.
  const leanZ = -Math.asin(clamp(-m[0] / Math.cos(TRUNK_REST_FOLD), -1, 1))
  const leanX = -(
    Math.atan2(m[2], m[1])
    - Math.atan2(Math.sin(TRUNK_REST_FOLD), Math.cos(TRUNK_REST_FOLD) * Math.cos(-leanZ))
  )
  return { leanX, leanZ }
}

/**
 * A direction of the rig's frame carried *back* through one of those turns: the
 * inverse of `turnVector`, and what the pose needs when what it knows is where the
 * eyes have to point in the world and what it is solving for is the neck's own two
 * angles. The forward composition is the side fold, then the forward fold, then the
 * yaw (see turnVector), so the inverse undoes the yaw first and the two folds after
 * it, each by its own angle the other way.
 */
function unturnVector(turn, v, out = [0, 0, 0]) {
  const x = v[0] * turn.cy - v[2] * turn.sy
  const z = v[0] * turn.sy + v[2] * turn.cy
  const y0 = v[1] * turn.cx + z * turn.sx
  const z0 = -v[1] * turn.sx + z * turn.cx
  out[0] = x * turn.cz + y0 * turn.sz
  out[1] = -x * turn.sz + y0 * turn.cz
  out[2] = z0
  return out
}

/** A vector of the rig's frame carried by that turn (see upperTurn). */
export function turnVector(turn, v, out = [0, 0, 0]) {
  // 'YXZ': the side fold inside the forward one, both inside the yaw — the order
  // the driver's own euler composes them in.
  const x = v[0] * turn.cz - v[1] * turn.sz
  const y = v[0] * turn.sz + v[1] * turn.cz
  const yFold = y * turn.cx - v[2] * turn.sx
  const zFold = y * turn.sx + v[2] * turn.cx
  out[0] = x * turn.cy + zFold * turn.sy
  out[1] = yFold
  out[2] = -x * turn.sy + zFold * turn.cy
  return out
}

/**
 * Where the ball leaves the hand, in the rig's frame: the anchor the delivery's
 * release window is authored about, and the point the component's placement puts
 * on the trajectory's own first sample.
 *
 * The height is the pitch's own (a release height is the pitcher's, and does not
 * move with the batter), the lateral is the arm's (the ball leaves just off the
 * shoulder's line), and the forward reach is the arm's: the leaned shoulder less
 * the arm's span and the palm's carry, pointing at the plate.
 *
 * @param {object} params
 * @param {object} params.rig result of measurePlayerRig (no sprite nominal height)
 * @param {string} [params.hand='R'] the throwing hand
 * @param {number} params.height the release height above the ground, rig units
 * @param {number} [params.hipY=0] the pelvis's own height at the release, and how
 *   far it has driven toward the plate: the shoulder the anchor is measured from
 *   is the one the release *pose* carries, or a delivery that drives its hips
 *   forward would reach its own release point from a shoulder that never went with
 *   them (which reads as an arm thrown straight up rather than out at the plate)
 * @param {number} [params.side] how far *across* the body the pitch's own release
 *   stands, in the rig's own x and relative to where the arm's own posture already
 *   puts the ball — a delta, so a pitch the posture already reaches is the anchor it
 *   always was. It is the lateral the arm is asked to reach for, which the delivery's
 *   own stance cannot supply (a pivot foot stands on the rubber; see
 *   `pitcherPlacement`, which is where the feet's own line is kept). Left out, the ask
 *   is nought, which is what every caller inside this module means by it.
 * @returns {{x: number, y: number, z: number, aim: number[], lean: number,
 *   height: number, angle: number, reach: number, shoulderShare: number}} the
 *   ball's place, the hand's own line there, the lean the body holds at the release,
 *   the height the pose could actually hold (an arm has only so much lift in it: past
 *   that the release comes off the arm's own reach, and it is the profile's
 *   ``heightShortfall`` that reports the difference), the arm's own angle there, the
 *   reach the anchor was built from, and the share of the stature the shoulder came
 *   out standing at (see `releasePosture`)
 */
/**
 * The arm's own cone at a slot, as the anchor solves it: the height the pose can
 * really hold (an arm has only so much lift in it, and the band is its own — see
 * ARM_ANGLE_BAND), the share of the reach the vertical gap takes, and what is left
 * *across* the body at that elevation — the lateral the arm can carry, which is the
 * number the body's own lean is read against (see `pitcherRelease`).
 */
function armCone({ socketY, height, reach }) {
  const low = socketY + reach * Math.sin(ARM_ANGLE_BAND.low)
  const high = socketY + reach * Math.sin(ARM_ANGLE_BAND.high)
  const held = clamp(height, low, high)
  const up = clamp((held - socketY) / reach, Math.sin(ARM_ANGLE_BAND.low), Math.sin(ARM_ANGLE_BAND.high))
  return { held, up, flat: Math.sqrt(Math.max(0, 1 - up * up)) }
}

/**
 * The height the pelvis has to come *up* by for a trunk rolled `tilt` toward the throwing
 * side, in the rig's own units: the roll turns the whole upper body about the body's own
 * midline — the pelvis tips with the trunk, and the side it tips toward is the side that
 * drops — so the hip socket on the throwing side, the one the drive leg hangs from, is
 * carried *down* by that half-width times the sine of the roll, and the pelvis comes up by
 * the same amount so that the socket stands exactly where the stance put it. It is
 * negative geometry rather than a taste: a roll left unpaid stands the drive socket a hip
 * half-width of roll below where its own ankle can follow, and a leg asked for a span
 * shorter than it has answers by folding — which is the one thing the tilt may not cost
 * (see TRUNK_TILT_MAX). What the same roll leaves the *other* leg is that amount again of
 * slack, which is the leg that strides and is bent under the body anyway.
 *
 * The angle it is handed is the roll the *legs* are paying for, which is the drive's own
 * clock rather than the body's: see TILT_LIFT_TRACK for why the two are not the same
 * number over the kick.
 */
export function rollLift({ rig, tilt = 0 }) {
  return rig.hip.halfWidth * Math.sin(Math.abs(tilt))
}

/**
 * The height a pelvis carried `lean` across its own stance has to give up for it, in the
 * rig's own units: the leg under it cannot span the carry the body has taken on, so the
 * body comes down by what the leg is short — the leg is a rigid span and the pelvis is
 * its top, so a pelvis `lean` out from the ankle it stands on is a leg the same length
 * standing on a shorter vertical (the Pythagorean read of the same triangle). It is
 * negative geometry rather than a taste: it is exactly the sink that leaves the drive
 * leg a *straight* rod rather than a folded one — the chord from its socket to its ankle
 * is the leg's own length at every lean this pays for — so the one thing the body's carry
 * costs is the slant, which is the trade the delivery's two levers are (see
 * STANCE_SIDE_MAX). Held to the crouch a carry is allowed, which is also what caps the
 * carry itself.
 */
export function stanceDip({ rig, lean = 0 }) {
  const legLength = rig.leg.thigh + rig.leg.shin
  const span = Math.sqrt(Math.max(0, legLength * legLength - lean * lean))
  return Math.min(STANCE_DIP_MAX, legLength - span)
}

export function pitcherRelease({ rig, hand = 'R', height, hipY = 0, drive = 0, side = null }) {
  const s = hand === 'L' ? -1 : 1
  const carry = releaseCarry(rig, hand)
  // The arm's own reach: the straightest chord the driver will build (see
  // `straightChord`, which is the driver's own bendChord), and the ball a palm below
  // the wrist's own place on the same line. Asking for that chord — rather than for
  // the two bones and the hand added together — is what makes the release frame a
  // *straight* arm: the wrist lands at the chord exactly, the elbow at the driver's
  // own limit, and the hand runs on down the arm's line rather than a wrist's bend
  // off it.
  const wristReach = straightChord(rig.arm.upper, rig.arm.fore)
  const reach = wristReach + carry
  // The body's own share of the ask, and the arm's: solved together, because each is
  // the other's remainder. The *pose* the delivery stands in — the fold that holds the
  // slot's own arm angle (see `releasePosture`) and the socket the arm hangs from — is
  // what says how much of the ask the arm's cone can carry, and the rest is the body's,
  // spent in the order of what each lever costs. The *tilt* first (see TRUNK_TILT_MAX):
  // a rotation of the upper body about its own fore/aft line, which carries the socket
  // the whole of a sine across (half a rig unit of lever at this body's size) and asks
  // the legs for nothing — the pelvis is carried by the same rotation and comes down by
  // what the roll carries the drive socket down by (see `rollLift`), so the drive leg
  // stands on the chord the stance gave it. What that cannot reach is the *step* (see
  // STANCE_SIDE_MAX): the body is carried across its own stance, and it is carried by the
  // stride — the pelvis shifts and the front foot's own place goes with it (the pose's
  // own carry below), so it is the drive leg that slants and the striding leg that keeps
  // its shape. The two are one posture, so they are solved as one: the roll is read off
  // the socket the fold really stood (a sine is not a metre, and the fold is what the
  // roll has to work on), the carry is what is left of the ask, and the sink is what the
  // pair costs the legs.
  const want = side ?? 0
  const lever = rig.shoulder.y - torsoPivot(rig).y
  const tiltMax = lever * Math.sin(TRUNK_TILT_MAX)
  const postureAt = (tilt, stance, sink) => releasePosture({
    rig, hand, height, hipY: hipY - sink, drive, tilt, stance,
  })
  let tilt = 0
  let stance = 0
  let sink = 0
  let posture = postureAt(0, 0, 0)
  // Where the anchor's own socket stands with the body standing *square*: what each
  // lever comes out at is read against this — the metres across the pitch's own line the
  // body really moved, rather than the metres an angle was asked for.
  const baseArmX = posture.shoulder.x + posture.socket[0]
  // ...and what the last pass's roll carried it by, with the last pass's *carry* taken
  // back out of it (both levers end up in the same socket, so what is asked of each is
  // the other's remainder: the roll takes the most it has and the step takes the rest).
  let rollX = 0
  for (let pass = 0; pass < 3; pass += 1) {
    const { socket } = posture
    const cone = armCone({
      socketY: posture.shoulder.y + socket[1], height, reach,
    }).flat * reach
    const body = want - clamp(want, -cone, cone)
    // The roll's own share, held to the most a roll of TRUNK_TILT_MAX has in it — an
    // angle a sine away from the metres it carries — and then the step for what is left.
    tilt = Math.asin(clamp(clamp(body, -tiltMax, tiltMax) / lever, -1, 1))
    stance = clamp(body - rollX, -STANCE_SIDE_MAX, STANCE_SIDE_MAX)
    sink = stanceDip({ rig, lean: Math.abs(stance) }) - rollLift({ rig, tilt })
    posture = postureAt(tilt, stance, sink)
    rollX = posture.shoulder.x + posture.socket[0] - baseArmX - stance
  }
  // The shoulder the anchor hangs off is the *release posture*'s: the slot's own arm
  // angle stands the body at its own fold, and the chest is leaned at the plate and
  // turned by the yaw the release key holds — the same rotation the driver realises
  // the trunk with (see trunkLean and `releasePosture`, which is where this solve
  // lives). Authored to one lean, this was the number that stood every pitch off the
  // same shoulder — 0.628 of the stature — and left the slots at the ends of a real
  // staff answered by a shortfall rather than by the arm.
  const { shoulder, socket } = posture
  // How much of the arm's own reach the vertical gap takes, and the rest of the line
  // going forward at the plate. The arm hangs from the *socket*, not from the chest's
  // centre, so the anchor is built off the socket the same way `releasePosture`
  // solved the fold off it: the ball is a straight arm's own reach from the joint it
  // leaves from — a clavicle's width in front of and below the chest's centre — rather
  // than from a point the arm does not pass through (which is what folds the release's
  // own elbow). The gap is held inside the arm's own *angle band* (see ARM_ANGLE_BAND):
  // past the top of it the ball cannot be lifted any higher off the shoulder the body
  // is standing on, so what comes back is the height the pose could hold and the
  // caller's own stand — the scale the profile solves — is what takes the pitch the
  // rest of the way up.
  const socketY = shoulder.y + socket[1]
  const socketZ = shoulder.z + socket[2]
  const { held, flat } = armCone({ socketY, height, reach })
  // What the arm has left to spend once the slot's own elevation has its share: the
  // arm's reach is a *cone*, and a pitch's release is a place on it rather than a
  // direction. The rest of the share is spent *across* the body before it is spent
  // forward — the pitch's own lateral offset, relative to the socket the arm hangs
  // from (see ``side``), is the arm's to reach, not the feet's: a pitcher's pivot foot
  // stands on the rubber whoever he is, and the ball leaves a hand that has swung
  // out over the plate's own line rather than a body slid along the mound to meet it.
  // Past the arm's own lateral reach the anchor comes back at the end of the cone and
  // what it could not take is reported (see ``sideShortfall`` in the profile).
  const armX = shoulder.x + socket[0]
  const whisker = s * rig.shoulder.halfWidth * 0.05
  // The ask is how far the *arm* has to come across, in the rig's own x, and nothing
  // else: a pitch released where the delivery's arm already reaches it (every centred
  // one) builds exactly the anchor it always did, whisker included, and the cone is
  // spent on the pitch's own lateral rather than on the hair the posture places the
  // ball off its socket by — the two hands' whiskers are each other's mirror, and
  // charging them as lateral would answer the same world x with two different
  // deliveries (measured: 3.1 cm of travel between a lefty's and a righty's own on the
  // suite's own pitch).
  // ...and the two levers read off the posture the anchor is really built on, so the
  // numbers reported and the place drawn are one answer: the roll's metres come back out
  // of the body's own carry (see the loop above), and the carry is the difference of the
  // socket's own place and the square body's.
  const tiltX = armX - baseArmX - stance
  const lateral = clamp((want - stance - tiltX) / reach, -flat, flat)
  const ahead = Math.sqrt(Math.max(1e-6, flat * flat - lateral * lateral))
  const x = armX + whisker + lateral * reach
  const y = held
  const z = socketZ - reach * ahead
  const aim = [x - armX, y - socketY, z - socketZ]
  const length = Math.hypot(aim[0], aim[1], aim[2]) || 1
  const line = [aim[0] / length, aim[1] / length, aim[2] / length]
  return {
    x,
    y,
    z,
    aim: line,
    lean: posture.lean,
    height: held,
    // How much of the ask the arm's own cone carried, in the rig's x and relative to
    // the place its posture stands the ball at: ``side`` where the arm reaches the
    // pitch's own lateral, less where its elevation has already spent the cone, and
    // nought for a release the posture already owns. It is what the profile's own
    // ``sideShortfall`` is read against.
    spent: x - (armX + whisker),
    // ...and the *body's* own share of the same ask: the metres the trunk's own roll
    // carried the socket across the pitch's own line, in the rig's x and toward the same
    // side as the ask (see TRUNK_TILT_MAX). It is what the pose draws — the trunk's own
    // ``tilt``, which the placement then reads the feet's line against (see ``tilt`` on
    // the pose and `pitcherPlacement`) — and the angle it was solved at, with the sink
    // that pays the drive socket back its height, in the rig's own units, so that the
    // pose can stand the same body without re-solving any of it.
    tilt,
    tiltX,
    // The body's own carry across its stance — the second lever, in metres of the rig's
    // own x — and the sink the pair of them costs the legs (see `rollLift`/`stanceDip`).
    stance,
    sink,
    // The arm's own angle at the release, as Statcast reads it (see `armAngle`),
    // and the reach the anchor was built from — the number the pose's own ask and
    // the straight-arm correction are both read against.
    angle: (Math.asin(clamp(line[1], -1, 1)) * 180) / Math.PI,
    reach,
    wristReach,
    // The shoulder's own height as a share of the stature: the posture the ball is
    // thrown off, which is what the slot's own arm angle asked the body to stand (see
    // `releaseShoulderShare`). It is reported rather than promised — the body's own
    // fold range is the limit when a slot asks past it.
    shoulderShare: posture.shoulderShare,
  }
}

/**
 * The shoulder the release's own anchor hangs off, and the socket the ball leaves
 * from, in the rig's frame: the chest leaned at the plate by the slot's lean and
 * turned by the yaw the release key holds — the same rotation the driver realises the
 * trunk with (see trunkLean, and `pitcherRelease`, which is where this was read).
 *
 * It is a function of the *pose's* own numbers rather than of the driver's bones, and
 * that is the whole point of it: the anchor, the pose's release-window targets and the
 * tests all have to agree about where the shoulder the pitch is thrown from is, and a
 * shared read is what makes them one answer.
 *
 * @returns {{shoulder: {x, y, z}, socket: number[], trunk: object, turn: object}}
 */
export function releaseShoulder({ rig, hand = 'R', lean, tilt = 0, stance = 0, hipY = 0, drive = 0 }) {
  const s = hand === 'L' ? -1 : 1
  const key = KEYS[TIMES.indexOf(AUTHORED_RELEASE_TIME)]
  // The keys are authored for the right hand, so a lefty's anchor comes off the
  // mirrored body — the same rule the pose's own frame follows (see pitcherPose) — and
  // the trunk's own tilt is added *beside* that mirror rather than inside it, because it
  // is a number of the rig's own x (the frame the ask is in: a right-hander's is positive
  // toward his own side and a left-hander's negative, which is the same world side the
  // keys' own lateral mirror is).
  const trunk = trunkLean(s * key.chestYaw, lean, s * key.leanSide + tilt)
  const turn = upperTurn(s * key.chestYaw, -trunk.leanX, -trunk.leanZ)
  const pivot = torsoPivot(rig)
  const turned = turnVector(turn, [
    0,
    rig.shoulder.y - pivot.y,
    rig.shoulder.z - pivot.z,
  ])
  // ...and the joint that turn is *about* belongs to the pelvis, not to the pose: the
  // rig takes the chest's turn about the waist's own centre, and that centre rides on
  // the pelvis — the pelvis' turn carries the joint, and the chest's turn is taken about
  // wherever it has been carried to. The socket below is the chest's offset turned about
  // the pelvis' *pivot*, so it stands short of the joint's own travel; measured on the
  // realised rig at the release, that is 7 mm of socket, and the arm answers it by
  // folding the elbow to hold a ball the body has already reached — 169.30° where this
  // ask realises 174.87°. Carried, the released ball rides the joint with the chest and
  // the arm keeps the chord the ask is written for.
  //
  // A rig that reports no joint — the suite's own hand-written ones — is a rig shaped
  // before the cut, and the pose models the old axis for it, which is what those rigs
  // were written against.
  const joint = rig.waistJoint ?? null
  const carried = joint ? jointCarry(turn, joint, s * (key.chestYaw - key.hipYaw)) : [0, 0, 0]
  const shoulder = {
    // Two levers, one place. The trunk's own tilt is *in* the turn above rather than
    // beside it: the roll is a rotation of the whole upper body about the body's fore/aft
    // line, so it carries the chest's centre, the sockets, the anchor's own ball and every
    // place the pose's release window is read against out over the rubber by the socket's
    // own height over the pivot (see TRUNK_TILT_MAX). What the tilt cannot reach is the
    // *body's* carry (see STANCE_SIDE_MAX), which is a translation of the pelvis: the same
    // place for the socket at the same height, with the drive leg slanted under it — and
    // it is the pose's own step that goes out with it, so it is the body that is carried
    // and not the feet that are slid.
    x: stance + turned[0] + carried[0],
    y: pivot.y + turned[1] + hipY + carried[1],
    z: pivot.z + turned[2] - drive + carried[2],
  }
  // The ball leaves just off the arm's own socket, which is half a shoulder's width
  // along the body's shoulder line — *that* line, not the rig's: a body a quarter of
  // the way round carries its shoulders round with it, and an anchor pinned to the
  // rig's lateral axis would leave the hand a hand's width out to the side.
  const socket = turnVector(turn, [s * rig.shoulder.halfWidth, 0, 0])
  return { shoulder, socket, trunk, turn }
}

// ---------------------------------------------------------------------------
// The authored delivery: one key per pose, in clip seconds.
//
//   hipYaw / chestYaw  the pelvis's and the chest's own turn: 0 faces the plate,
//                      negative is closed (turned toward the throwing side)
//   lean / leanSide    the forward fold over the hip pivot, and the fold toward
//                      the throwing side, in radians
//   hipY / drive       the pelvis's own height, and its push toward the plate. A
//                      delivery's stride *is* this: a foot planted a stride ahead
//                      can only be reached from a pelvis that has come down and
//                      gone with it (the leg is a fixed 0.85 rig units — see the
//                      reach test), so the drive is what carries the body onto the
//                      front foot and what peels the trailing one off the ground
//   headPitch          the head's nod, as the model's own neck takes it: positive
//                      *raises* the gaze (read off the realised skeleton — the
//                      number is a turn about the model's lateral axis, and its
//                      sense is the model's). It is what the head does once the
//                      look belongs to the body: while the look is pinned on the
//                      zone the neck's two angles are solved for the zone itself
//                      (see the look's own clock below)
//   pivot / front      the two feet: x across the body, lift above its own rest
//                      height, z fore/aft (negative toward the plate), the shoe's
//                      yaw, how far forward the knee is pushed, whether the leg is one
//                      the delivery *carries* — hangs off its own knee (see ``hang``
//                      below) — and, on the keys where the foot has come down for good,
//                      whether the pose *stands* the shoe flat on the dirt rather than
//                      leaving it on whichever of its corners the leg's own turn has
//                      left lowest (see ``flat`` in the pose assembly). Both are places
//                      in the frame the body stands in — a pitcher's feet do not
//                      ride his hips forward — and the trailing (``pivot``) foot's
//                      z follows the drive and its lift leaves the rubber as the
//                      body passes over it, which is what the back leg does.
//
//                      The two feet read their shoe's yaw in different frames,
//                      because the two feet are not the same foot. The ``pivot``    //                      foot is planted on the rubber and the body turns *on* it, so
    //                      its yaw is the shoe's own, in the frame the foot stands in.
    //                      That is what makes the back leg the turn's engine: the windup
    //                      turns it *out* as the pelvis cocks (the thigh carrying the
    //                      shin round with it), the drive brings it round onto the plate
    //                      line and the leg bends over it — straight at the plate, and
    //                      out over the outside of its own foot rather than across the
    //                      body — and the hips coming round drag nothing sideways out of
    //                      the plane the leg drives in. Past the release the same yaw is
    //                      what spins the leg out: it goes on round to the glove side of
    //                      the plate's line while the shoe's place goes across the body,
    //                      so the follow-through's swing is the thigh's turn and not a
    //                      step (see the release, the sweep and the finish below). The ``front`` foot is carried to
//                      its place by the body that swings it there, so its yaw is
//                      *relative* to the pelvis' facing — how far the shoe is turned
//                      out from the way the body faces — and the stance's own foot
//                      angles survive the stance being turned.
//   ball               where the ball *is* — the wrist the driver solves is this
//                      less the palm's carry down the hand's line — as a place in
//                      the rig frame, or (in the release window) an offset from
//                      the release point itself. A ``clasp`` key has none: while
//                      the hands are together the ball is *in the glove*, so its
//                      place and the hand's own line are the glove's own (see
//                      claspTracks), and a key with neither is refused at load
//   aim / curl         the hand's own line, and how far the fingers close
//   elbow              the elbow's own pole, as a place in the rig frame (or an
//                      offset from the release point in the release window). Left
//                      out where the arm is the *glove* arm's own mirror (see the
//                      track below): while the hands are clasped the two arms are
//                      one shape, and a windup's elbows do not need authoring to
//                      hang level with each other
//   slot               1 where the pitch's release height has its say in the
//                      lean: the cock, the release and the follow-through
//   glove / gloveAim   the glove hand: an offset from its own shoulder, in the
//                      chest's turned frame (the form that keeps it in front of
//                      the chest while the chest turns under it), and the line it
//                      points along
//   glovePalm          which way the glove's *palm* faces, as a direction in the
//                      rig frame — the one turn the hand's own line leaves free,
//                      and the one a glove is read by: the palm shown to the zone
//                      is a glove presenting the ball, and the twist that holds it
//                      there while the chest comes round under it is what the lead
//                      arm's own swing is made of (see the driver's open-hand solve).
//                      Written in the rig's frame rather than the chest's on purpose:
//                      "the palm faces the plate" is a fact about the *world* the
//                      pitch goes into, so a chest turning 90 degrees under it spends
//                      the turn in the wrist rather than carrying the palm off the
//                      zone with it — which is exactly the drag the unwind is
//   gloveElbow         the glove hand's own elbow: a place in the same frame and
//                      read from the same socket as ``glove``. It is what the
//                      *lead* arm's shape is made of, and the shape is what turns
//                      the body: an elbow rising while the glove holds its own
//                      height leaves the forearm pointing down, and an elbow swept
//                      out with a straightening forearm is what takes the shoulders
//                      round with it. Left out where a clasped glove's own tucked
//                      elbow is what the arm is doing (see the track below),
//                      because a windup's elbows do not need authoring to hang.
const KEYS = [
  {
    // The set: the body *fully* side-on to the plate — the pelvis and the chest both
    // at a right angle to it, so the line through the shoulders lies along the way
    // the pitch goes and the glove (non-throwing) shoulder points straight at the
    // strike zone, with the throwing shoulder away from it and the throwing hand
    // trailing. The feet are spread under the hips with the weight even. The hands
    // are clasped in front of the chest with the ball inside the glove (see
    // ``clasp``): a grip is kept out of sight until the pitcher is ready to show it —
    // and what keeps it out of sight is the *glove*. Its palm is turned away from the
    // plate here, so the mitt's own back is what the batter is looking at, and its
    // fingers are closed over the hand the ball is in: ``gloveCurl`` 1.55, a fist of a
    // glove against the 0.3 it is down to by the time the elbow has come up and the
    // palm is showing the plate (see the break below). A grip showing is a glove
    // left open on the palm it sits on.
    //
    // -1.571 is a right angle exactly: the chest square with the pelvis (no waist
    // separation, which is what puts the shoulder *on* the zone rather than a few
    // degrees off it) at the whole of the plate's side, and it is the pelvis that is
    // square rather than the chest turned under it — the legs read side-on with it
    // (see the ``facing`` note in the pose assembly).
    t: 0.0,
    clasp: true,
    hipYaw: -1.571, chestYaw: -1.571, lean: 0.03, leanSide: 0.0, hipY: -0.04, drive: 0.0,
    headPitch: 0.06,
    // The feet are places in the frame the body stands in, so a body turned a
    // third of the way round carries its stance with it: the pivot foot is turned
    // out toward the glove side, which is the shoe a side-on body pivots on.
    pivot: { x: 0.105, lift: 0, z: 0.150, yaw: -1.231, bend: 0.18, hang: 0 },
    front: { x: -0.130, lift: 0, z: -0.130, yaw: 0.02, bend: 0.16, hang: 0, cock: 0 },
    // The hands, written in the chest's own frame from the glove's shoulder: in to
    // the body's midline, down to the belt, and a hand's width clear of the jersey
    // (the driver will not put a hand where the trunk already is). The ball's own
    // place and the throwing hand's line are *this* glove's (see claspTracks) — the
    // glove is what hides the grip, so the glove is what is authored.
    //
    // And the throwing arm is the glove arm's own mirror while the hands are together
    // (see mirrorTracks): one shape drawn twice, both elbows hanging a hand's width
    // under the belt's own clasp, so the stance is symmetrical from the waist up and
    // stays that way as the hands come up (see the rocker and the gather below).
    glove: [0.240, -0.300, -0.300], gloveAim: [0.0, -0.22, -0.975], gloveCurl: 1.55,
    // ...and the palm faces the ball it is hiding: the set's own turn, read off the
    // realised glove (the model's own palm marker, see the driver's ``palmFacing``)
    // and written back here as the track's first number, so the stance the windup
    // begins from is the pose the rig already had.
    glovePalm: [0.12, 0.30, 0.95],
    curl: 1.5,
  },
  {
    // The rocker: the weight goes back onto the pivot foot, the front foot slides
    // back under the body, and the hands stay together and come *up* — the arms go
    // up with the leg, so that by the time the knee is at the top of the kick the
    // hands are at the chest rather than down at the belt (a windup lifts its arms
    // as it lifts its leg, and the grip rides the glove's own palm up with them).
    // The *elbows* do not go with them, and they are the reason the two hands can
    // come up without the arms shortening: the hands are lifted from the shoulders,
    // and what a pair of hanging arms does as the hands rise under a fixed elbow is
    // swing the forearms from level with them to standing off them — both gloves
    // ending above both elbows rather than the arms folding up as they come. Read
    // off the realised skeleton, each elbow keeps the height its own shoulder gave it
    // to within a couple of centimetres over this whole first half of the windup
    // (see the browser suite's windup reading).
    //
    // The
    // windup's own *cock* starts here — the pelvis begins to turn away from the
    // plate and the body's weight leans onto the back leg — and the pivot shoe turns
    // out with it, a few degrees at a time: the thigh is what carries the shin round
    // (see the pivot yaw note in the assembly), so the back leg winds up as one piece
    // rather than the shoe staying put while the body turns over it.
    t: 0.46,
    clasp: true,
    hipYaw: -1.605, chestYaw: -1.625, lean: 0.05, leanSide: 0.015, hipY: -0.06, drive: -0.055,
    headPitch: 0.05,
    pivot: { x: 0.108, lift: 0, z: 0.160, yaw: -1.265, bend: 0.20, hang: 0 },
    front: { x: -0.125, lift: 0, z: 0.020, yaw: 0.02, bend: 0.20, hang: 1, cock: 0 },
    // ...and the hands are already on their way up here: ten centimetres of the
    // lift are spent by the rocker, because the hands now have to be at the chest by
    // the *gather* rather than at the balance (see the gather's own note). Written
    // at the belt's own height they spent the first third of the windup down there
    // and then had twenty frames to make the climb in.
    glove: [0.245, -0.235, -0.290], gloveAim: [0.0, -0.30, -0.954], gloveCurl: 1.55,
    glovePalm: [0.07, 0.30, 0.95],
    curl: 1.5,
  },
  {
    // The gather: the front knee comes up — all the way up and *over the belt* the
    // leg is standing in, which is the kick's own height and is where it is highest
    // (see the balance key's note on the lift, and the pose assembly's
    // ``KNEE_OVER_HIP``) — the hands travel with the body, still together and still
    // hiding the ball, and the chest coils a little further over the back hip, the
    // pelvis and the pivot shoe with it. The arms come with them
    // as the one shape they have been since the set (see mirrorTracks): the two
    // elbows hang level and stay low while the hands rise to the chest, which is the
    // windup's own lift — the arms go up with the leg, the elbows do not go with the
    // hands — and it is what leaves both elbows *below* the clasped hands here, with
    // the two forearms standing up to them.
    t: 0.80,
    part: true,
    hipYaw: -1.760, chestYaw: -1.820, lean: 0.16, leanSide: 0.035, hipY: -0.015, drive: -0.095,
    headPitch: 0.04,
    // The weight is *on* the drive leg by here and the shoe has taken it: the pivot
    // foot's own place is carried back with the hips (see the pivot leg's note), so
    // what the kick rises over is the back leg rather than the space between them.
    pivot: { x: 0.110, lift: 0, z: 0.180, yaw: -1.340, bend: 0.22, hang: 0 },
    front: { x: -0.150, lift: 1.13, z: 0.030, yaw: 0.0, bend: 0.34, hang: 1, cock: 0 },
    // The hands are *at the chest* on this key — the place the balance used to hold
    // them at (see its own note) — and the mitt lets go of the ball here, because the
    // knee has reached the top of its kick on this frame and the throwing arm has the
    // rest of the windup to fall and come back up in. The lift is what the windup's
    // hands are: they come up with the leg, and the leg is as high as it goes here.
    glove: [0.225, -0.110, -0.270], gloveAim: [0.90, 0.10, 0.20], gloveCurl: 1.5,
    // ...and the elbow hangs *deep* under the socket while the hands are at the chest —
    // sixteen centimetres down and a hand's width behind it, in the chest's own frame —
    // because that is what keeps the top of the lift from being a pair of elbows coming up
    // with the hands. Read on the realised skeleton with the elbow asked for at the
    // balance's own shallow angle, the two elbows rose 10 cm under their sockets over the
    // kick and stood 9.7 cm apart in shape at the top of it — a wing on one side, which the
    // browser suite's windup reading catches; asked for deep, they stay 26-30 cm under and
    // within 3 cm of each other for the whole of the kick.
    gloveElbow: [-0.16, -0.26, -0.06],
    glovePalm: [0.06, 0.22, 0.97],
    // ...and the throwing arm is off the mitt on this frame: the ball a hand's width
    // below and behind the place the hands were holding, on a bent arm (the elbow's
    // own 140°) so the swing hangs off the shoulder and goes on opening as it drops.
    // The standstill it starts from is the clasp's own top, which is now here.
    ball: [0.3000, 1.0600, 0.6000], aim: [0.42, 0.90, 0.10], curl: 1.42,
    straight: (140 * Math.PI) / 180,
    // ...and it leaves the mitt *still showing the ball*: the plate's bearing, which is
    // the facing the clasp's own palm had it turned to (see the balance's note on the
    // world and the rig). The turn to first base is the drop's, and it is spent over the
    // whole of it — the hand is at the hip by the balance, which is where the ball is
    // shown to the infield's own line.
    palm: [-0.0480, 0.0000, -0.9990],
    // The arm's pole is not its own here: with the hands still one shape on this frame
    // the trail elbow hangs where the lead arm's own mirror puts it (see `mirrorTracks`),
    // and it is the pole *track* that takes the side over from there, on its own clock.
    // (The hand's own curl is the arm block's 1.42 above — the clasp's 1.5 that used to sit
    // here was a second `curl` on the same object, and a key cannot say one thing twice.)
  },
  {
    // The balance point: the knee at the top of the kick, the body coiled *hard* over
    // the back leg — the pelvis 30° past side-on away from the plate against the set's
    // nought — the hands still together at the chest, the eyes on the target, and
    // nothing that lifts lifted yet: the lead elbow is still down, its own place a
    // hand's width under the shoulder socket, and the two arms are still the glove
    // arm's own mirror here (see MIRROR_TRACK), so the two elbows hang 29 and 25 cm
    // under their own shoulders and within 4 cm of level with each other. The elbow's
    // rise, the glove's showing and the kicking leg's own unwind are all the *fall's*
    // — the key between this one and the break — which is the delivery's own story:
    // the weight leaves the back foot before anything unwinds.
    //
    // This is the cock at its furthest, and the *kick* is what wound it: the chest
    // sits 5° further round than the pelvis over the weight leaned onto the back leg,
    // the glove's palm is still turned in on the ball it is hiding, and the pivot shoe
    // has turned 15° further out with them — the shoe leads the pelvis, which leads the
    // chest, which is the order the lead leg's own swivel hands the turn round in. The
    // whole back leg is wound, and it *stays* wound: what unwinds from here waits on
    // the break.
    //
    // ...and the kick is a *high* one: the knee is carried up *over the belt the leg is
    // standing in* — 0.19 of a rig unit above its own socket, which is the femur 27°
    // above the horizontal, and reads on the realised skeleton as the knee a good four
    // centimetres over the waistband's own top edge — with the shin hanging plumb under
    // it, so the front foot rides 0.68 of a unit up off the ground (a foot a hand's
    // width above the knee of the leg he is standing on). The pose's ``lift`` is the
    // measure of that while the leg is carried: 0.55 of it comes up at the knee and the
    // rest is the shin swinging under it as it hangs (see the pose assembly's
    // ``KNEE_RISE``, its ``KNEE_OVER_HIP`` ceiling, and the ``hang`` note on the
    // come-through key). So the raise is the knee's own and nothing else's — the leg is
    // a size higher with the delivery's timing, its rocker and its turn where they were
    // — and a knee the hip has lifted *past* its own socket is what a kick that clears
    // the belt is: what the windup's cock winds is a thigh pointed up out of the hip,
    // and the shin under it hangs the way every other carried leg's does (see the
    // browser suite's reading of the hang, and its reading of the cock, which is the
    // same window).
    //
    // ...and the hands *part on this key*, which is the whole of what the balance is
    // for. A windup's two hands lift together and the grip is let go at the top of
    // that lift: left clasped, the hands go on holding the chest for the three frames
    // the fall takes, which is a delivery standing in its own windup at the one moment
    // it has already finished winding — and it costs the throwing arm a twentieth of a
    // second of the quarter second it has to start from rest in. So the key that lifts
    // the mitt to its highest is the key that lets it go (see PART_KEYS below): the
    // ball is still in the glove on this frame — the swing begins where the hands were
    // holding, from a standstill, the way a pendulum's top is a moment of rest — and the
    // arm's own track leaves from there, three frames before it used to.
    t: 1.00,
    hipYaw: -2.090, chestYaw: -2.170, lean: 0.17, leanSide: 0.060, hipY: -0.025, drive: -0.135,
    headPitch: 0.03,
    // The balance: the hips are over the drive leg and stay there — a rig unit of
    // the body's own weight is 13 cm behind the space between the feet, directly
    // over the shoe the whole kick is stood on — and the back leg is the lower of
    // the two by the height the hips gave up to it. The pivot foot's own place goes
    // with them: a windup rocks *onto* a foot rather than turning over the spot it
    // was standing on, and what the shoe does under its own hips is stay under them.
    pivot: { x: 0.112, lift: 0, z: 0.195, yaw: -1.495, bend: 0.24, hang: 0 },
    front: { x: -0.170, lift: 1.13, z: 0.010, yaw: -0.10, bend: 0.41, hang: 1, cock: -0.32 },
    // The hands are at the *chest* here rather than at the belt, and higher than the
    // windup has carried them so far: the clasp comes up under the chin as the knee
    // comes up, which is the shape a windup's high hands are (see the gather, and the
    // lead arm's own elbow rise under them).
    glove: [0.225, -0.110, -0.270], gloveAim: [0.90, 0.10, 0.20], gloveCurl: 1.5,
    gloveElbow: [-0.14, -0.10, -0.04],
    // ...and the glove's palm is still turned *in*, hiding the ball: the showing is
    // the fall's own (see the key between this one and the break). What it is when it
    // comes is a *twist* of the wrist — the hand's line hangs with the elbow's own
    // rise and the palm comes round *about* it, which is the one turn a hand has left
    // once its aim has placed its fingers, rather than a wrist broken sideways to
    // point a palm. Here the fingers follow the forearm they hang off (`gloveAim`
    // tracks the elbow's own drop below: an almost level forearm with the fingers
    // running down it), which is what leaves the wrist a wrist for the showing to be
    // a roll of.
    glovePalm: [0.06, 0.22, 0.97],
    // ...and the throwing hand is *down beside the hip* by here: the mitt let it go at
    // the gather and the swing is spent over the balance, so the arm the drive finds is
    // the one it has always wanted — plumb, straight, the hand behind the hip — with
    // twelve hundredths of a second still to come before it starts up the back. That is
    // the whole of what the earlier letting-go buys: the same key, the same body, an arm
    // that is already at the bottom of its swing rather than on its way down to it.
    //
    // ...and the palm is square to **first base** on this frame — the pitcher's own back
    // while he stands sideways to the plate — which is what the hold then carries from
    // 1.02 s. Written the way the world reads it and *negated in x and z*, because the
    // rig frame is the world turned a half turn about its up axis (the driver's
    // ``toRigVector``): first base stands (0.999, 0, -0.046) in the world and
    // (-0.999, 0, 0.046) here. A palm written the world's way round shows the ball to
    // third, which is a hand at the pitcher's side read upside down.
    ball: [0.1700, 0.4254, 0.6640], aim: [0.0657, -0.9782, 0.1970], curl: 1.4,
    straight: (168 * Math.PI) / 180,
    palm: [-0.9990, -0.0100, 0.0457],
    // The arm's own elbow still hangs down and behind the hands it was clasped into
    // (see the gather's own pole): the place the swing's bottom is read from.
    elbow: [0.1378, 0.8339, 0.5913],
  },
  {
    // The fall: the body's weight goes forward *before* anything unwinds. The coil is
    // held at the depth the balance wound it to — a degree or two off it and no more
    // — the knee is still up and still cocked, the glove's elbow is still down and
    // the hands are still together at the chest, while the pelvis has already crossed
    // four and a half centimetres of ground toward the plate. Read as a list of joints
    // a delivery is a stand-up, a coil and an uncoil; read as a *body* it is the weight
    // leaving the back foot first and the turn arriving after the fall, and this key
    // is that order written down: the pelvis has turned a degree since the balance and
    // travelled four and a half centimetres of ground, and by the break it is 26° and
    // seventeen.
    //
    // ...and it is where each of the delivery's three forward motions gets its own
    // start, all of them at a body's pace rather than a throw's: the weight is four and
    // a half centimetres here and the pelvis a single degree of turn. Read as *rates* —
    // which is what the eye reads a delivery by — the five hundredths of a second the
    // fall spans are slow on all three at once, and what follows is one build from here
    // to the ball rather than a step out of the coil and then a windup (see the break's
    // own note on the starts, and the browser suite's reading of the three speeds,
    // which holds each of them to its fastest frame on the release rather than a crest
    // inside the stride).
    //
    // ...and the *swing is already running by here*: the mitt let the hand go at the
    // gather — the clasp's own top — so the ball leaves it at the height the windup lifted
    // it to, and the swing that follows starts from rest rather than being launched out of
    // the clasp the instant the hands come apart. That is the whole of what gives the windup
    // its length: with the mitt held to the balance (where it used to be let go) the hand
    // had to cover the drop from the chest to the hip in the seven hundredths of a second
    // between that key and this one, which is a hand *thrown* down rather than let down,
    // and the cock that followed had a quarter of a second to arrive in. Off the gather it
    // has twenty hundredths for the drop and ten for the carry up the back, which is a body
    // swinging an arm as a pendulum swings — and the frame the hands part on is the pass at
    // the top, where a pendulum is standing still.
    //
    // The knee's own cock is what the fall leaves longest: the leg is up and pointed
    // where the coil pointed it (``cock`` carries the wound angle it held at the
    // balance, and the chest it is read against has not moved either), so the kicking
    // leg's unwind, the step out of it and the arms' break all still wait on the
    // break below — which is what "the ball is thrown by the body that has already
    // fallen" looks like from the outside.
    t: 1.05,
    hipYaw: -2.075, chestYaw: -2.160, lean: -0.26, leanSide: 0.050, hipY: -0.045, drive: -0.090,
    headPitch: 0.035,
    pivot: { x: 0.113, lift: 0, z: 0.198, yaw: -1.525, bend: 0.25, hang: 0 },
    front: { x: -0.169, lift: 1.14, z: 0.008, yaw: -0.10, bend: 0.42, hang: 1, cock: -0.30 },
    // The glove is where the balance put it — up at the chest, drifting forward off
    // it — with the *elbow* authored to arrive late (see the break). The palm is
    // already on its way round to the plate with it: the showing is the elbow's own
    // rise's passenger.
    glove: [0.230, -0.130, -0.300], gloveAim: [0.50, -0.80, 0.32], gloveCurl: 1.35,
    gloveElbow: [-0.22, 0.06, -0.12],
    glovePalm: [0.03, -0.02, -1.0],
    // ...and the throwing arm, off the clasp: the ball is a hand's width below and
    // behind the place the two hands were holding (the clasp's own top, one key back),
    // so the swing has already begun — the mitt let go at the gather, and the hand is
    // past the ribs on this frame rather than still at the chest. Its line is the one
    // it leaves the mitt on — down and back along the body's own flank — and its elbow
    // hangs where the clasped mirror put it, a little further out as the arm comes free.
    //
    // ...and the swing has been running for a fifth of a second by this key: the mitt
    // let the hand go at the gather, so what the fall does is carry the arm *on* from
    // the hip rather than down to it — a quarter of the climb from the hip's own place
    // to the lift's, which is the arc the keys either side of this one already drew,
    // resampled onto the longer swing. The arm is folded 24° past the hanging straight
    // of the balance and closes on to 58° by the lift, which is the hand drawing up the
    // back on an elbow that leads it.
    ball: [0.1920, 0.4830, 0.6550], aim: [0.1290, -0.8300, 0.3640], curl: 1.39,
    straight: (156 * Math.PI) / 180,
    // ...and the ball is already turned toward **first base** by the balance — the
    // pitcher's own back at that frame — so what the fall and the break are for is the
    // hand's *arc*, not its turn: the facing is the hold's own from 1.02 s (see
    // PALM_HOLD) and the numbers below are only the fallback it reads where no key
    // names one.
    palm: [-0.9990, -0.0100, 0.0457],
    elbow: [0.1470, 0.8370, 0.5240],
  },
  {
    // The break: the front leg drives out toward the plate and the hands come
    // apart — the throwing hand has swung down beside the hip while the glove goes
    // out in front of the chest — with the pelvis already turning ahead of the
    // shoulders, which is the drive the torso is about to be handed.
    //
    // The *glove* arm is what hands the shoulders the rest of it, and from here it is
    // a forearm: out in front of the chest and away from the body, straightening as
    // it goes (0.72 of its span here, 0.87 by the plant — nearly all of it) with the
    // elbow kept level out to the glove's side. A lead arm that swung out to point
    // *at* the plate only lengthens the way it is already pointing; one that sweeps
    // across the front of the body takes the shoulder line round with it, and that
    // sweep is what the windup below is authored as: the same hand crossing the
    // chest's own midline at 0.94s, with only 6° of the shoulders' own unwind behind
    // it and 133° of it still to come — the turn's biggest part after the cross.
    //
    // The back leg fires *first*, and it leads by more than the pelvis does. The fall
    // has left the coil exactly where the balance put it, so the whole of the unwind
    // is spent in the seven hundredths of a second between the fall and here: the pivot
    // shoe comes round 31° while the pelvis turns 26° and the chest 15°, so the order
    // the turn runs in is the hip, then the body, then the shoulders — and across the
    // step out that follows the pelvis passes the shoe up (92° of it to the shoe's 83°
    // by the plant), which is the hip handing the turn over rather than trailing it.
    //
    // ...and the whole of the delivery's unwind *starts* here, at a third of the pace
    // it runs at. The shoulders' own turn is 213°/s off the fall where the step out
    // makes 584 of it; the weight has come seventeen centimetres across the fall and the
    // break together — twelve hundredths of a second — where the step out that follows
    // takes the next thirty-six in eight; and the throwing hand is only just out of the glove,
    // down beside the hip and not yet on its way up. Authored the other way round — this
    // key taking the reach's own pace straight off the balance — the delivery steps out
    // of its coil and is half way through its windup before the ball has gone anywhere,
    // which is a throw made in two pieces: a lurch to the plant and then a stall until
    // the arm catches up. What is held here is the *start* of the three of them, so the
    // whole of the quarter second before the ball goes is one build (see the ramp below,
    // and the arm's own note at the reach for the third of them).
    //
    // The turn's own *rate* is what this key is shaped for, and it is the one number
    // of the break that is authored against the release: the unwind gathers speed
    // from the fall to the release and never spends it early. Taken quickly — the
    // body already most of the way round by here — a delivery snaps round at the
    // break, stalls behind the plant and snaps again into the release: one that turns
    // in two pieces rather than in one, with its fastest frame of spin a quarter of a
    // second *before* the ball goes (which is what an earlier authoring of this key
    // did). Read across the break, the plant, the high cock and the coming-through
    // key, the shoulders' own turn is a ramp of 580, 370, 400 and 2580°/s: the build is
    // spread across the whole quarter of a second before the ball rather than gathered
    // into its first frames — the dip in the middle of the ramp is the coil *deepening*,
    // the hips running on while the shoulders are held — and the last of it, six times
    // the step before it, is spent in the two hundredths of a second the ball goes on.
    // The turn's own peak is the release's, which is what the browser suite's reading of
    // the three speeds the delivery makes is there to hold. The coil goes with it rather
    // than jumping: the chest sits 5° under the pelvis at the balance, 15° at the break
    // and 35° at the plant — trailing further as the drive hands the turn up the chain —
    // and then 36° at the high cock and 38° at the come-through, where the shoulders are
    // the last thing still closed while the hips and the ball go on through, before the
    // 8° they are back to at the release.
    //
    // What the turn does *not* carry is the fold. The trunk comes over the hips with
    // the drive and not before it: the body turns its way through the stride standing
    // nearly as upright as it stood in the set, and what the pitch's fold is reached by
    // is the back leg's own two moves — the trunk tilted *back* over the drive foot as
    // the leg fires, and the fall over it as the drive pushes (see the plant's own note
    // and the walk's, in LEAN_IN_TRACK). This key is where the walk's own share begins:
    // the trunk is most of the way into the pitch's lean by the break the slow way — the
    // walk's square, a little on every frame — and the fastest the trunk moves anywhere
    // in the delivery is the fall the drive makes of it: ten degrees a frame at sixty,
    // a couple of hundredths of a second past the plant.
    t: 1.12,
    hipYaw: -1.640, chestYaw: -1.900, lean: -0.58, leanSide: 0.02, hipY: -0.08, drive: 0.040,
    headPitch: 0.04,
    pivot: { x: 0.118, lift: 0, z: 0.200, yaw: -0.950, bend: 0.26, hang: 0 },
    // The lift is the *knee's* own height while the leg is carried (see the pose
    // assembly's ``hang``): a carried foot hangs its shin plumb from the knee, so the
    // height a kick's foot rides at is set by how high the knee goes, and the knee
    // has to go higher as the hips drop under it — a leg left at the kick's own
    // number would hang its foot into the dirt by the reach.
    front: { x: -0.166, lift: 0.60, z: -0.180, yaw: 0.0, bend: 0.16, hang: 1, cock: 0.10 },
    // ...and the throwing arm is *on its way up the back* by this key: the swing that
    // used to begin here is two frames old (the mitt let go at the gather and the hip
    // was reached at the balance), so what the break does to it is carry it — half of
    // the climb from the hip's own place to the lift's, the hand past the ribs with the
    // elbow leading it and the arm folded 44°.
    //
    // What the arm no longer does here is *hang*. The break is still the legs' and the
    // trunk's — the front leg drives out and the pelvis turns ahead of the shoulders —
    // but the arm is the windup's now, not the drop's, and the frames between here and
    // the lift are one path up the body's own back with no corner in them at the key.
    //
    // The palm's own bearing is the *world's* rather than the rig's (see the balance's
    // own note on first base and `toRigVector`'s negated x and z): the fall and the
    // break carry the hand's arc, and the facing is the hold's from 1.02 s (PALM_HOLD),
    // so this key's numbers are the fallback `palmAt` reads where no key names one.
    ball: [0.2220, 0.6000, 0.6420], aim: [0.2190, -0.6230, 0.5980], curl: 1.37,
    straight: (137 * Math.PI) / 180,
    palm: [-0.9990, -0.0100, 0.0457],
    // ...and the elbow leads the hand up the back, the way the lift's own key reads it:
    // from behind the body's coil rather than out in front of it.
    elbow: [0.1680, 0.8430, 0.3650],
    glove: [0.130, -0.110, -0.400], gloveAim: [-0.092, -0.700, -0.704], gloveCurl: 0.8,
    gloveElbow: [-0.26, 0.16, -0.18],
    glovePalm: [0, 0, -1],
  },
  {
    // The lift: the throwing arm starts *up*, and up the back of the pitcher — the
    // shoulder swings the hanging arm backward and the elbow closes as it goes, so
    // what rises is the hand, drawing a line up behind the hip rather than in front
    // of the chest. The trunk is still coming over the foot here (the fold is the
    // window's own), so the arm and the body are travelling in the same direction
    // for the first time in the delivery: the body forward, the hand back and up.
    //
    // The elbow is what leads, and it is below the hand all the way up — a hand
    // dragged up by a *straight* arm has to go round the front to get above the
    // shoulder (which is the arc this key replaces); one whose elbow is already
    // folding can come up the back and arrive over the shoulder without ever
    // crossing the chest. That is the reference pitch's own shape between the ball
    // leaving the glove and the high cock, and it is why the wrist is never asked to
    // turn: the hand runs on down the forearm the whole way (see WRIST_COCK).
    //
    // The lift *ends higher* than it used to, and that is what buys the upper arm its
    // level frames. An upper arm can only lie level while the wrist it carries is
    // within a forearm's length of the socket's own height (0.286 of a rig unit: the
    // two bones cannot reach further than that, whatever the fold), and the hand used
    // to come up to within 0.31 of it here and only cross that line at 1.18 s. The
    // wrist is asked 0.125 higher — the hand up beside the ear by this key rather
    // than at the shoulder a key later — and the pole with it (the elbow a hand's
    // width up), so the level arrives at 1.175 s instead of 1.185 and runs, flat to
    // within three degrees, to 1.218 where the trunk's own whip takes the arm over.
    // What the driver cannot realise of the last of that climb is the reach, not the
    // shape: the shoulder is asked for a wrist a couple of centimetres past its own
    // span on the two frames at 1.13 s, and answers by leaving the elbow where this
    // key put it (measured, 8 cm of the ask unrealised at 1.13 s against 5 on the
    // frames either side) — the arm's own line runs on unbroken through it.
    t: 1.16,
    hipYaw: -1.1000, chestYaw: -1.4650, lean: -0.4000, leanSide: 0.0100, hipY: -0.1700, drive: 0.2800,
    headPitch: 0.0450, curl: 1.35,
    pivot: { x: 0.1240, lift: 0, z: 0.2025, yaw: -0.5000, bend: 0.3000, hang: 0 },
    front: { x: 0.0040, lift: 0.6600, z: -0.3950, yaw: 0.2500, bend: 0.2300, hang: 1, cock: 0.2700 },
    straight: (113 * Math.PI) / 180,
    ball: [0.2568, 0.7800, 0.6279], aim: [0.3204, -0.3857, 0.8652],
    elbow: [0.1740, 1.0200, 0.3230],
    palm: [0.0000, -1.0000, 0.0000],
    glove: [0.0700, -0.1400, -0.4475], gloveAim: [-0.1460, -0.7900, -0.5670], gloveCurl: 0.5500,
    gloveElbow: [-0.2800, 0.0550, -0.2400],
    glovePalm: [0.0500, -0.0800, -0.9900],
  },
  {
    // The reach: the front leg is thrown out to the length of its stride — the foot
    // over the place it is going to land on — and the throwing arm swings up past the
    // shoulder on its way to the cock. The pelvis is already square while the chest is
    // still closed and turning: the body's turn runs up the chain, and the shoulders
    // are the last thing before the arm.
    //
    // ...and the arm's swing is *carried* here rather than begun: the hand has come
    // up off the hip and out along the body's own line — up past the belt with the
    // elbow rising under it — so the cock below is the last of a path the reach has
    // already walked rather than the whole of it. Left where the windup's own numbers
    // had it — the hand down beside the hip, a quarter of a rig unit lower and a
    // tenth further back than this — the whole of the hand's rise is spent in the six
    // hundredths of a second between here and the cock, which is a hand moving 0.32 of
    // a rig unit in a sixtieth of a second before the ball has started to come over:
    // the throw beginning at the cock rather than arriving out of the windup. (The head
    // start has a limit of its own: asked for up *at* the shoulder the hand folds the
    // arm to the elbow's own stop, and a solve at the stop has no side left to choose
    // — the elbow jumps between its two tangents from frame to frame.)
    //
    // The foot is *out* but not down: the stride's own end is the plant, and the plant
    // waits for the ball (see the front leg's note). What the reach is, then, is the
    // leg at the length it will land at with the shoe still a hand's width up and
    // coming down: the delivery stands on the drive leg alone from the break to just
    // past the release, and the stride is the front leg's own *reach* — out and under
    // the body that is turning over it — rather than something the weight arrives on.
    //
    // ...and the trunk is *tilted back* over the drive foot by here: the walk's own share
    // is withdrawn at this key (see LEAN_IN_TRACK), so what the body carries is this key's
    // own lean — half a radian back, which is the arch the reference pitch shows
    // as the back leg fires (the trunk's weight going back over the rubber with the chest
    // up over it, before the drive takes it forward). Written at the third of a radian a
    // first deepening carried, the arch read on the realised skeleton as some eight and a
    // half degrees of back-tilt across the four frames the plant holds it — a shape the eye
    // still reads as a body standing up out of the coil rather than one bowed *back* over
    // the leg it is standing on. The reference pitch's arch is a deep one: the chest is
    // thrown back over the rubber with the whole trunk's weight on the drive leg before the
    // drive takes it forward, so the depth here is most of the way to a right angle of
    // back-tilt at its deepest (measured on the realised skeleton, the chest rides some
    // twenty-nine degrees back over the hips at the plant's own frame against the seventeen
    // the third-of-a-radian wrote). The whole of the depth is spent
    // before the ball goes and none of it is held: the fold comes over the foot across the
    // whip the throw is made of rather than standing the trunk up between the plant and the
    // cock (see FOLD_ARRIVE), so the fall the drive makes of it is deeper and *longer* than
    // the arch that begins it — the arch the delivery is read by is the place the trunk
    // takes up for the length of the back leg's fire. Beside that, what the reach is is the
    // body's turn and its travel (see the break's own note above, and the finish below for
    // the other end of it).
    t: 1.20,
    hipYaw: -0.560, chestYaw: -1.030, lean: -0.32, leanSide: 0.0, hipY: -0.26, drive: 0.520,
    headPitch: 0.05,
    // The drive leg's own two numbers are held back with the rest of the start: its
    // shoe is three degrees short of the plate's own line here (it comes fully onto
    // it a hundredth of a second later, and the unit suite's own reading of the shoe
    // is what holds that within the foot's own plane), and the shoe has slid a
    // millimetre on the rubber since the break rather than the two centimetres it once
    // did — a foot being stood *on* while the body turns over it does not travel.
    pivot: { x: 0.130, lift: 0, z: 0.205, yaw: -0.050, bend: 0.34, hang: 0 },
    // ...and the striding leg's ``cock`` has run on to five and twenty degrees, which
    // is the azimuth its knee is read at: the carried foot hangs its shin plumb off
    // the knee, so it is this number and the chest's own turn that set where the
    // stride's foot is, and held where it once was the foot comes back with the chest
    // the six degrees this key now holds it by.
    front: { x: 0.174, lift: 0.72, z: -0.610, yaw: 0.500, bend: 0.30, hang: 1, cock: 0.44 },
    // ...and the arm's own three numbers, re-authored key by key against the reference
    // pitch (a first-person delivery filmed from the plate): what the windup hands the
    // throw is a hand coming up the *back* of the body's own arc — off the hip, past
    // the ribs with the arm's underside turned to the camera, and up behind the
    // shoulder by the cock below — so the cock is the last key of one path rather than
    // the first of its own. The hand's line is the *forearm's*, too: a hand cocked off
    // the arm it hangs on is the one thing a windup cannot hide, and written the way
    // they were — a hand pointing up and back while the arm swings down behind — the
    // wrist carried most of a right angle of cock through the whole of the swing
    // (measured off the realised skeleton, the hand's own line stands 88° off the
    // forearm at the reach and 83° at the cock, the ball most of a hand's width
    // outside the arm's own plane on both).
    // ...and the hand is at the *chest* by here rather than still at the belt: the
    // reference pitch has the ball carried up the ribs and held at the sternum by the
    // reach, with the elbow already above its own shoulder — read off the two cameras
    // as the arm's own outline through the stride (the elbow out and up, the forearm
    // slanting *down* off it to the hand) — and the old place here, a third of a rig
    // unit lower, spent the whole of the hand's rise in the six hundredths of a second
    // between this key and the cock: a hand climbing most of a rig unit between two
    // frames, which is the throw beginning at the cock rather than arriving out of the
    // windup. Measured on the realised skeleton, this place holds the throwing elbow
    // four hundredths of a unit *above* its own socket at the key, against the quarter
    // of a unit below it the low place read (see the browser suite's own reading of the
    // two elbows' hangs at the plant).
    // ...and the arm is *up* by here, hanging off the shoulder's own line: the upper
    // arm has swung back and level (it points back and a little down, the elbow under
    // the hand and behind the shoulder) and the forearm is folded up off it, so the
    // hand is above the elbow and behind the head — the layback, reached from the
    // hanging arm by one turn of the shoulder rather than by a windmill round the
    // front. Straightness is the fold's own number now: 79°, the ring the two bones
    // draw is what the pole below is for, and the hand's line is the forearm's (a
    // wrist locked to the arm it hangs on — see WRIST_COCK).
    straight: (80 * Math.PI) / 180,
    ball: [0.3150, 1.0950, 0.3240], aim: [0.1202, 0.9283, 0.3519], curl: 1.3,
    // The elbow *leads* the hand up, and it leads it from *behind* the body's own coil:
    // written off the right hand's own side, the pole this key hands the driver points
    // back over the throwing shoulder — the shape the layback below is reached from, and
    // the shape the reference pitch shows of the reach (the elbow out at the shoulder's
    // own line with the forearm slanting down off it to the hand), rather than the
    // shoulder-high wing the old place put the driver in (its read: the elbow 0.63 of a
    // unit *above* the socket, which is most of a forearm's length the wrong way).
    // Measured on the realised skeleton, the elbow rides 0.23 of a rig unit out along the
    // shoulders, 0.21 of one *in front* of the plane they draw and 0.02 of one below its
    // own socket; asked for on the ring's other side — a pole across the body, which is
    // where this key's own place sat before — the same arm reads 0.29 of a unit *behind*
    // that plane, and what a pole has to answer to is the browser suite's own reading of
    // the trail (see its torso reading).
    elbow: [0.2729, 0.9642, 0.0943],
    // Which way the ball is turned: to the pitcher's own *back*, which is what a
    // windup shows a camera at the plate and what the throw then brings round to the
    // zone (see the layback's own note, and the pose's ``palmAt``).
    palm: [0.3000, 0.2500, 0.9200],
    // (Handed on to the hold from the frame after the break — see PALM_HOLD —, so this
    // facing is the wrist's own angle read at the reach rather than an ask the frames
    // between here and the cock re-point: the down-swing and the cock are one roll.)
    glove: [0.010, -0.170, -0.495], gloveAim: [-0.20, -0.88, -0.43], gloveCurl: 0.3,
    gloveElbow: [-0.30, -0.05, -0.30],
    glovePalm: [0.10, -0.16, -0.98],
  },
  {
    // The high cock: the arm at the top of the cock (up and behind the shoulder),
    // the glove tucked to the chest — and the shoulders *held closed*, the mid-thirties
    // of degrees behind the hips they are riding, which is the deepest the delivery's
    // coil goes before the throw. The turn is what is left of the delivery's work here:
    // from this key to the follow-through the arm is authored from the release point,
    // so the cock is where the hand's own path turns over, and the two hundredths of
    // a second after the come-through are where the whole of the shoulder line's turn
    // is spent (see the break's own note on the ramp). The ball is drawn further back
    // off the release at this key than at any other in the window — most of a rig unit
    // of its own line — so the whip has further to come than anywhere else in it.
    // ...and this key's own lean is a *coordinate* rather than the body's shape by here:
    // the fold the frame carries is shared between this key and the release posture's own
    // (see FOLD_ARRIVE), so the number below is what the trunk does on the way *into* the
    // fall — a trunk still coming over the foot it is thrown from rather than one already
    // stood up out of the arch — where writing the posture's own depth straight into the
    // key is what made the fall a three-frame step (measured off the realised skeleton
    // across a deeper arch: 13.3° of fold in one frame at 1.227 s).
    //
    // And the fold is most of the way to the pitch's own by here: the window's slot track
    // has taken the trunk off the plant's own tilt, and what it is handed is the release
    // posture's fold (see SLOT_TRACK) — eased in across the whole of the whip rather than
    // spent between the plant and this key (see FOLD_ARRIVE), so the body the arm unwinds
    // off is over the hips it is throwing from by the release rather than by the top of the
    // cock, and the chest is still *coming* through the ball rather than already there.
    t: 1.26,
    release: true, slot: 1,
    // The cock's own elbow: a right angle, which is where a throw is drawn back *to* —
    // the forearm folded up and the ball held behind the shoulder on it (see the arm's
    // own note above, and the straightness track the pose reads). Straight here, the
    // elbow has no ring to be pulled on and the pole below is worth nothing.
    straight: (90 * Math.PI) / 180,
    // ...and the arch is *still* under the arm here — most of a third of a radian back,
    // which is the reference's own bow at the top of the cock (PS-8) and what lets the
    // forearm lie straight back under a shoulder line that has tipped back with it (see
    // FOLD_ARRIVE, which keeps the fold off this frame until the ball has finished
    // loading). Written where the fold was nearly *nought* here and the trunk already
    // half-way over the foot, the layback had to be bought sideways: the elbow could not
    // lie back under a level shoulder line and point the forearm along the body's own
    // +z at the same time, and it took the ring's outer side to do the second, which is
    // the lateral shape the cock used to be.
    hipYaw: -0.070, chestYaw: -0.780, lean: -0.28, leanSide: 0.0, hipY: -0.13, drive: 0.580,
    headPitch: 0.06,
    pivot: { x: 0.150, lift: 0.05, z: 0.050, yaw: 0.050, bend: 0.28, hang: 0 },
    // The foot has reached the place it will land on and is on its way down: the
    // release is a hand's width above the dirt for it (see the plant below).
    front: { x: 0.000, lift: 0.22, z: -1.000, yaw: -0.120, bend: 0.36, hang: 0, cock: 0 },
    // The cock's own ball is *behind the shoulder at its own level*, which is what a
    // laid-back arm holds: written off the release, that is 1.905 rig units back along
    // the ball's own line and 0.11 of one below it, so the hand hangs level with the
    // socket it is drawn back from rather than over its head. It is the position the
    // whole throw is loaded from (the reference's PS-7 and PS-8, which are the same
    // shape a frame apart), and it is what the forearm's own line is read against: with
    // the hand level and behind, the chord the fold is drawn about points back along the
    // body's own +z and the forearm folded off it lies level too — straight back at
    // second base, a couple of degrees to the first-base side of it for a right-hander
    // (see the pole below, and the browser suite's reading of the line).
    //
    // Written a hand's height higher — the ball at face level with the forearm rising to
    // it, which is where this key's place used to sit — the chord rises with the ball and
    // the forearm folded off it *keeps* rising: the rings of the whip then run round the
    // chest instead of behind it, which is the arm swinging the body's own coil rather
    // than being carried by it. The layback is the *upper arm's* to make (see the elbow
    // below); the ball's job is only to say where the hand is while it does.
    //
    // The draw-back costs the throw nothing it cannot pay: the whip is spent in the twenty
    // milliseconds before the release, and the pose's own worst frame step through it is
    // inside the pitch's speed (see the unit suite's speed test, whose bound is 0.36 of a
    // rig unit a frame at a hundred-and-twentieth). The ball's place is the offset from
    // the release anchor every window key is written in (see `trackRelease`), and the
    // hand's line is the forearm's, as at the reach.
    // (The ball's own *carry* down the hand's line is a window key's rather than the
    // palm's — the release's chord is what the window's ends are read at, so the number
    // is larger here than the palm's own eleven-hundredths, see ``handCarry`` — and
    // what the place below is written off is the *wrist* it should put the hand at.)
    ball: [-0.255, -0.110, 1.905], aim: [0.53, 0.79, -0.24], curl: 1.0,
    // ...and the elbow is *out*, level with its own socket, which is what the reference
    // pitch shows of the layback at the middle of the fold (PS-9): as the upper arm comes
    // round level and the elbow starts to bend, the joint swings out to the throwing side
    // and the forearm turns back along the body's own +z — the hand carried behind the
    // shoulder with the ball still in front of it. Written on the ring's other side, with
    // the elbow hanging under the arm (where this key's own place sat before), the forearm
    // comes out square to the body and the ball is shown *round the side* of the throw
    // rather than carried back on it.
    //
    // Where the elbow may sit is the *hand's* to say: a folded arm hangs its elbow on a
    // ring drawn about the hand, and with the hand 0.42 of a rig unit from the socket — a
    // right angle of arm — the ring is wide enough for the elbow to lie anywhere from the
    // body's own side to under the socket. Measured on the realised skeleton with the pole
    // below: the upper arm stands level with its socket and 89° round to the throwing side,
    // the elbow a hundredth of a rig unit off the socket's own level and 0.30 of one out
    // along the shoulders, and the forearm lies 22° up and 2° off straight back — held
    // there, not passing through it: 21° up at 1.24 and at 1.27, which is the layback the
    // cock is drawn back to and the frames the eye reads it on (see the browser suite's
    // reading of the line).
    //
    // The arm that shape buys is *lateral*, and it is the layback's own: the elbow is swung
    // out to the throwing side, which is what puts the forearm straight back behind the
    // shoulder. The plane the *chest* draws is not the reading for it — through the cock the
    // chest is still closed over its hips, facing out at third base, so an elbow out on that
    // side stands a quarter of a rig unit "ahead" of a plane that has turned with the coil,
    // without the arm being anywhere near the front of the body. What says the arm is behind
    // the torso is the arm: the ball is 0.58 of a rig unit *behind its own socket* at this
    // key, and it stays behind it until the frames the ball goes (see the browser suite's
    // reading).
    elbow: [0.7198, -0.3420, 0.6040],
    // ...and the palm: to the pitcher's own back, which is what a camera at the plate
    // sees of a cocked arm — the ball hidden behind the hand rather than shown to the
    // throw (see the reach's own note above, and the pose's ``palmAt``).
    // ...and the palm: the reference turns the whole arm over so the palm faces the
    // *ground* by the time the elbow has folded up to its right angle — the walk from
    // the side the hand left the mitt on (first base's own bearing for a right-hander)
    // round and down — so the ball sits *under* the hand rather than shown out behind
    // it. (Was "to the pitcher's own back", the same cocked arm with the palm held out
    // toward the back instead of turned under onto the ground.)
    palm: [0.0, -1.0, 0.0],
    glove: [-0.190, -0.260, -0.420], gloveAim: [-0.40, -0.85, -0.34], gloveCurl: 0.3,
    gloveElbow: [-0.32, -0.08, -0.24],
    glovePalm: [0, 0, -1],
  },
  {
    // Coming through: the arm is over the top with the hand nearly on the ball's own
    // line — and the *chest* is still coming round behind the hips it is riding, 38°
    // back of them, which is the widest separation the delivery makes: the shoulders
    // are the last thing in the chain still wound. The two hundredths of a second that
    // follow are the throw: the hips' travel and the body's turn have their fastest frame
    // on the release (see the browser suite's reading of the two speeds — and its own note
    // on why the trunk's fold is a place the pitch pins rather than one of them), and the
    // ball covers seven tenths of a rig unit of its own path in them (see the keys' own
    // note on the ramp, at the break).
    t: 1.30,
    release: true, slot: 1,
    // The elbow is still folded to its *right angle* here — the reference's own layback
    // lock: once the fold reaches 90° the forearm and the palm hold their place against
    // the upper arm (the forearm trailing back off the laid-back elbow — see the pole
    // below) right up to the release, where they *unwind*. So this key keeps the whole of
    // the fold rather than spending it early, which is what opening the arm to 173° here
    // did: the elbow stays at its 90° through the layback, and the release's own frames
    // are the unfold — the whip — the arm coming open only as the ball goes. (The follow-
    // through's straight-window therefore starts just before the release rather than at
    // 1.30s, since the arm is still folded on this frame and only straightens into the
    // release — see the browser suite's "folds about the elbow" read.)
    straight: (90 * Math.PI) / 180,
    // ...and the chest trails the hips by 32° here rather than the 41° it holds through
    // the cock (see the cock's key above): the shoulders have turned out from under the
    // throwing arm by nine degrees across the last four hundredths, which is the last of
    // the drag the arm is left with — the pose's own share of it, worth 0.02 of a rig unit
    // at the elbow. Left at the cock's separation, the chest is still riding the arm at the
    // frame the ball goes, and the arm reads as the thing throwing the chest, and more of it
    // comes off over the two hundredths *after* this key — the turn's own gather (which dips
    // 3° deep and returns on the ball, see TURN_GATHER_LEAD): the key's own number is what
    // the shoulders stand at here, and the frames between here and the release are the
    // clock's rather than the curve's.
    //
    // ...and the number is a *fiftieth of a radian* deeper than the trail alone asks for,
    // which is the move that puts the chest's own turn on the ball (see the note below the
    // fold's clock, at TURN_GATHER_LEAD, and the browser suite's claim): a
    // twentieth-of-a-second window is 0.02 s wide and the key's value leads the window that
    // ends on it, so a degree of chest here is 57°/s off that window and onto the one that
    // ends on the release — and with the clock's own snap on top of it, the release is the
    // fastest frame of the turn on *both* of the suites' grids rather than only the fine
    // one.
    hipYaw: 0.240, chestYaw: -0.320, lean: 0.21, leanSide: 0.0, hipY: -0.05, drive: 0.760,
    headPitch: 0.08,
    pivot: { x: 0.175, lift: 0.06, z: -0.280, yaw: 0.060, bend: 0.24, hang: 0 },
    front: { x: 0.000, lift: 0.17, z: -1.060, yaw: -0.460, bend: 0.30, hang: 0, cock: 0 },
    ball: [0.05, 0.20, 0.660], aim: [0.79, -0.30, 0.54], curl: 0.9,
    // The elbow's own place is not read here at all: from the cock to the release the whip
    // rolls the pole about the chord as an *angle* (see WHIP_ROLL), and what this key's
    // number supplies is only the along-the-chord share the ring is composed at. What the
    // angle itself says is where round that ring the arm is carried: the layback left the
    // elbow out on the throwing side, and by this key it has come a quarter turn round the
    // ring to hang *under* the chord — which is what stands the folded forearm up over the
    // shoulder as the arm comes through (the reference's PS-9 and PS-10, the elbow at the
    // shoulder and the hand above it).
    //
    // Nothing else here may pay for that. The ball's own travel across its last two frames
    // is what the whip is made of, and the delivery's own bound on it is the pitch's speed
    // (0.36 of a rig unit in a frame of a hundred-and-twentieth: 42 rig units a second,
    // which is what a 94 mph four-seamer leaves at — see the unit suite's speed test), so a
    // ball drawn back *here* to buy the elbow more room buys it out of the throw's own
    // speed. The ring is the free one — rolling the elbow round it moves the joint without
    // touching the arm's length or the ball — and that is exactly why the whip is written
    // this way round: the chord is the ball's, and the arm's shape inside it is the pose's.
    elbow: [0.47, 0.95, 1.50],
    // ...and the palm is *held* here: the cock's own facing carried by the arm as it
    // sweeps, so the wrist keeps the turn it took when the ball was turned to the
    // pitcher's own back rather than spending it across the whip. Written as the
    // direction the carry gives (measured off the realised skeleton: the ball's own
    // turn round the forearm is 122° at the cock and 122° here), so the whole of the
    // unload is spent between this key and the release, in the two frames the forearm
    // approaches the plate (see the release's own note on the bearing it hands over).
    palm: [-0.6200, 0.1200, 0.7760],
    glove: [-0.250, -0.280, -0.400], gloveAim: [-0.30, -0.87, -0.39], gloveCurl: 0.3,
    gloveElbow: [-0.34, -0.10, -0.20],
    glovePalm: [0.15, -0.25, -0.96],
  },
  {
    // The release frame itself: the hand is on the ball's own place and the
    // fingers are opening off it. The pelvis is back on its own legs' rest here —
    // the body stands tall over the plate at the frame the ball goes (see the hips'
    // own note in the header, and `releasePosture` for why a release cannot be
    // crouched under it) — so the trailing foot has peeled off the rubber and folded
    // up under the standing body rather than hanging off the end of a stretched leg.
    t: AUTHORED_RELEASE_TIME,
    release: true, slot: 1,
    // The shoulders are *square on the plate* at the frame the ball goes: the chest's
    // own turn here is the tiniest shade past the plate's line (a couple of degrees,
    // which is what the trunk's fold costs the bearing — see the browser suite's own
    // reading of the trunk), and the pelvis is a hand's width past it, so the whole of
    // the coil has been spent by the time the arm unwinds. It is what makes the release
    // a *throw* rather than an arm swinging out of a body still wound up: the ball
    // leaves on a hand the chest has already faced the zone with, which is why the
    // trunk leads the snap (see the trail's own reading below). Authored the other way
    // (0.48 of a turn — a quarter of the way back off the plate, which is where a
    // delivery that throws with its *arm* puts it) the release reads 25° off square.
    hipYaw: 0.24, chestYaw: 0.04, lean: AUTHORED_RELEASE_LEAN, leanSide: 0.0, hipY: 0.0, drive: 1.00,
    headPitch: 0.10,
    pivot: { x: 0.200, lift: 0.16, z: -0.400, yaw: 0.090, bend: 0.20, hang: 0 },
    front: { x: 0.000, lift: 0.155, z: -1.060, yaw: -0.600, bend: 0.28, hang: 0, cock: 0 },
    ball: [0.0, 0.0, 0.0], aim: [0.03, -0.07, -0.996], curl: 0.6,
    // The release's own pole is the *chord's* bow, and a bow is not a shape the pose
    // can draw on the line: the driver hangs the elbow on the ring its two bones draw
    // about the hand — a circle the arm's own radius stands off the chord's line — so
    // what the pole really writes is *which way* that bow points. Up (and a shade out
    // to the throwing side) is the answer, because a bow that points up out of the arm
    // is a bow the plate cannot see: the arm reads as the straight chord it is, where a
    // bow written out to the throwing side (which is what was here) reads as an arm
    // thrown with the elbow out. The bow's own size is the arm's, not the pole's: at
    // the ask's chord it is a couple of centimetres at the release, and it is spent on
    // the frames either side of this one as the hand comes off the ball.
    //
    // What the pole's *along-the-line* share is written for is those frames either
    // side: the arm folds again the sooner the hand is off the ball (see the keys after
    // this one), and the ring the elbow then rides is read in the direction of this
    // pole. Written *back along* the line — which is what this key used to carry — the
    // elbow is pulled behind the body's own turn from the release on: measured off the
    // realised skeleton, the arm is 0.10 of a rig unit behind the chest's plane at
    // 1.34s and a quarter of one behind it by 1.40s, on a throw whose whole shape is
    // the elbow *leading* the hand down and across. Written *forward*, the same bow
    // puts the elbow in front of that plane from the release through the follow-through
    // (measured: a hundredth of a unit past it at 1.34s, and the half of a hand's width
    // past it over the plant) — and the release frame itself does not move, because at
    // the ask's own chord there is no ring left for a pole to point on.
    elbow: [-0.02, 0.11, -3.20],
    glove: [-0.290, -0.300, -0.370], gloveAim: [-0.32, -0.85, -0.42], gloveCurl: 0.3,
    gloveElbow: [-0.36, -0.12, -0.18],
    glovePalm: [0.16, -0.28, -0.95],
  },
  {
    // The first of the *window's* own keys, and the note the four beside it are read
    // with (1.40 here, 1.42 and 1.48 either side of the pair, and 1.51 where the run
    // ends). What the run asks for is one thing: an arm that is *straight* out of the
    // release and across the body until the upper arm has crossed the torso's own
    // centre line. A straight arm is the one arm with no slack in it, and that is
    // what makes the shape something the *driver* has to be asked for rather than
    // the pose: the pose hangs the arm off the socket it estimates (a rig's own
    // shoulder over a pelvis its tracks carry) and the driver off the socket its body
    // really has, and the two part by a few centimetres on the frames right after a
    // throw — which a folded arm forgives and this one cannot.
    //
    // Measured on the realised skeleton: the sweep's own interpolated ask (a share
    // of the span either side of the chord) came back a fifth of it *inside* at 1.36s
    // — an elbow 73° off straight — and the two keys solved against the pose's own
    // estimate fared no better, 0.93 of the span at 1.36 and 0.82 at 1.40, where the
    // estimate stood five and eleven centimetres off the joint. So the ask is written
    // off the driver's own report: each key keeps the direction the throw already had
    // (the ball read from the realised skeleton, so the trajectory the sweep authored
    // is the one it keeps) with the wrist put back out on the chord the *body*
    // carries, and the hand's own line turned to run down that line rather than cocked
    // off it. What that leaves is an authored chord *long* of the span (1.10 to 1.23 of
    // it here, against the 1.25 the driver's own bones stretch to): the unit suite
    // reads that number and the browser suite the realisation (see both).
    //
    // Every other track is the frame's own place between its neighbours — the body's
    // turn, its lean, the hips' travel, both feet, the glove — so the delivery's own
    // shape across here is exactly what the keys either side asked for, and the keys
    // are the throwing arm's alone.
    t: 1.36,
    release: true, slot: 1,
    hipYaw: 0.488, chestYaw: 0.464, lean: 0.518, leanSide: 0.0, hipY: -0.016, drive: 1.070,
    headPitch: 0.124,
    pivot: { x: 0.450, lift: 0.240, z: -0.694, yaw: 0.134, bend: 0.172, hang: 0 },
    front: { x: 0.000, lift: 0.093, z: -1.060, yaw: -0.704, bend: 0.272, hang: 0, cock: 0 },
    ball: [-0.1658, -0.3152, -0.4375], aim: [0.6359, 0.1908, -0.7478], curl: 0.52,
    // A straight arm's own ring has no radius, so the pole is written off the chord it
    // is on rather than anywhere the elbow is doing work (see the key above): the side
    // it names is the one the arm would fold to, which is the throw's own.
    elbow: [-0.3341, -0.3571, 0.1424],
    glove: [-0.294, -0.308, -0.366], gloveAim: [-0.352, -0.630, -0.600], gloveCurl: 0.3,
    gloveElbow: [-0.352, -0.128, -0.164],
    glovePalm: [0.216, -0.448, -0.830],
  },
  {
    // The second of the window's own keys, solved the same way (see the key above):
    // the same read again, a twentieth of a second on.
    t: 1.40,
    release: true, slot: 1,
    hipYaw: 0.736, chestYaw: 1.030, lean: 0.466, leanSide: 0.0, hipY: -0.032, drive: 1.133,
    headPitch: 0.148,
    pivot: { x: 0.701, lift: 0.320, z: -0.988, yaw: 0.178, bend: 0.144, hang: 0 },
    front: { x: 0.000, lift: 0.031, z: -1.060, yaw: -0.808, bend: 0.264, hang: 0, cock: 0 },
    ball: [-0.2410, -0.5601, -0.5596], aim: [0.6041, -0.1272, -0.7867], curl: 0.44,
    elbow: [-0.5168, -0.1331, -0.0755],
    glove: [-0.298, -0.316, -0.362], gloveAim: [-0.384, -0.410, -0.780], gloveCurl: 0.3,
    gloveElbow: [-0.344, -0.136, -0.148],
    glovePalm: [0.272, -0.616, -0.710],
  },
  {
    // The arm crossing the body and the *chest* finishing its turn — the body's own
    // deceleration, with the hand carried down and across to the glove side. What the
    // release started, the momentum finishes: the chest is 60° past the plate's own
    // line by here — most of it since the hand let the ball go — while the pelvis has
    // all but stopped, turning a quarter as far after the release as it did before
    // it. That is the whip's own order: the end of the chain arrives last and carries
    // on, so what the pitch threw is the body as much as the ball.
    //
    // The whole body goes on travelling with it: by the plant the delivery has driven
    // 0.46 rig units toward the plate and by this key 0.78 of them, which is the
    // pelvis' own place among the feet rather than the feet riding it — and the lead
    // arm is *long* here (0.56 of its 0.60 span, out to the glove's side and down),
    // which is the shape that took the shoulders round to where this key has them.
    // The pivot foot has left the rubber and is on its way forward and across, which
    // is the swing the next two keys finish.
    //
    // The *leg* swings rather than steps, and the swing is what the shoe's own yaw is
    // for. The drive has just left the shoe on the plate's own line (8° off it, which
    // is the plane the leg drove in — see the shoe's yaw note above and the unit test
    // that holds it there through the release), and from the next key the
    // follow-through turns it out: 32° at 1.48, 52° at 1.54 and 172° — most of the
    // way round and pointing back the way the turn came — by the landing.
    // The leg comes round as one piece — the hip, the knee and the foot travelling in
    // a plane that turns with the swing — rather than the foot sliding on under a
    // thigh still pointed at the plate. The foot's *forward*
    // travel is not what this is for: it lands where the stride already put it (see
    // the finish below), and what the turn adds is the swing out to the glove's side.
    //
    // The throwing hand's own place is *in front of* the body by here, and that is
    // the whole of what keeps the arm out of it: written where the *standing* body
    // would have it, the chord from this key to the finish runs through the shoulder
    // socket — the hook has folded to five centimetres by the middle of it and the
    // elbow came out inside the hip. A hand forward of the line instead leaves the
    // whole sweep outside the trunk: the arm reaches out on its own chord from the
    // socket rather than folding around the body, so the further forward the hand is
    // carried the less of the trunk the straight arm has to cross — and this key and
    // the two either side of it are the window's own read, solved against the chord
    // the driver's body carries rather than the pose's own estimate (see the first of
    // them, 1.36).
    // The *head* does not come off the plate with the ball: the neck has held the
    // whole of the chest's turn off the look to here and it goes on holding it until
    // the ball has crossed the plate (see the look's own clock) — a seventh of a
    // second after this key, with the shoulders most of a right angle further round
    // than they threw it from (104°, against the 24 the shoulders were square by on
    // the release). What that costs is the neck: the counter-rotation it is holding
    // here is 57° (read off the realised skeleton, against the chest's own 59°) and
    // 104 by the landing. And it is the *cost* that goes once the ball has arrived,
    // not the look: the neck unwinds and the head comes round with the body it is
    // falling over, which is a follow-through's own shape.
    t: 1.42,
    release: true, slot: 1,
    hipYaw: 0.860, chestYaw: 1.100, lean: 0.440, leanSide: 0.0, hipY: -0.04, drive: 1.161,
    headPitch: 0.16,
    // The drive leg is *thrown* out from under the body rather than left behind: the
    // shoe is off the plate's own line and a good hand's width up, and the leg has
    // begun to swing round on the hip that has outrun it — the arc the next three
    // keys draw. The lift is where the swing's own width comes from (see the swing's
    // widest frame below). ...and the lift is a *carry* now rather than a hand's width:
    // the pelvis stands back up on its own legs' rest through this window (the release
    // key put it there and the tail keys only climb from here), so the socket is that
    // much higher over the shoe the swing is dragging round, and a leg the hips have
    // outrun is a leg whose own length is spent. What carries the difference is the
    // foot: the shoe rides higher off the dirt, which is what the swing's own width
    // wants anyway (see the swing's widest frame, whose own lift is written to match).
    pivot: { x: 0.826, lift: 0.36, z: -1.135, yaw: 0.200, bend: 0.13, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.860, bend: 0.26, hang: 0, cock: 0 },
    ball: [-0.3457, -0.6305, -0.6000], aim: [0.5723, -0.1908, -0.7975], curl: 0.4,
    // ...and the pole is written *down and in front of* the arm's own line, which is the
    // shape the whole follow-through is: the arm is folded again by here (the hand has
    // come off the ball and is being carried down and across the chest), so the elbow
    // has a ring to lead on — and leading is what it does, down and across the front of
    // the body the chest is folding over. Written *behind* the line instead (which is
    // where a relaxed arm's elbow hangs, and what this key used to author), the elbow
    // rides the last of the turn *behind* the shoulders: measured off the realised
    // skeleton, the arm is the better part of a quarter of a rig unit behind the
    // chest's own plane at 1.40s, and what the throw leaves behind is the arm.
    elbow: [-0.5865, -0.1741, -0.1518],
    glove: [-0.300, -0.320, -0.360], gloveAim: [-0.40, -0.30, -0.87], gloveCurl: 0.3,
    gloveElbow: [-0.34, -0.14, -0.14],
    glovePalm: [0.30, -0.70, -0.65],
  },
  {
    // The middle of the arm's own sweep, and it is authored rather than left to the
    // two keys around it: the hand goes from up and *in front of* the shoulder to
    // down and behind it, which is a sweep of most of a half-turn about the socket,
    // and a pair of keys that far apart put the chord of it through the shoulder
    // itself — the arm folded to five centimetres of its span and the elbow came out
    // inside the hip. So the hand is written where the sweep actually passes: down
    // and across the front of the chest, out past the midline and well below the
    // socket, with the wrist put back out on the *driver's* own chord like its two
    // brothers' (1.12 of the span as the pose reads it, a straight arm as the body
    // does — see the window's first key). The elbow's pole rides up and out to the
    // throwing side with it, which is the shape the whole frame is: an elbow leading
    // a forearm that is coming across the body.
    //
    // Every other track is written at the frame's own place between its neighbours
    // (the body's turn, its lean, the hips' travel, the glove's own arm), so the key
    // is the arm's and nothing else's: the lead arm's work either side of it is
    // exactly what the two keys around it asked for. The pivot foot is the one track
    // that is not on the line between its neighbours, and its own note says why (see
    // the release above): the back leg swings out on an arc, so it hangs on the
    // throwing side of the line a little longer than a step through would.
    t: 1.48,
    release: true, slot: 1,
    hipYaw: 0.95, chestYaw: 1.350, lean: 0.37, leanSide: 0.0,    hipY: -0.07, drive: 1.233,
    headPitch: 0.15,
    // The swing's own widest frame: the foot is as far out to the throwing side of the
    // body as it ever gets — 0.73 of a rig unit out from the hip socket it hangs from,
    // against the 0.61 it had at the release — and the knee, half way down that chord,
    // is by now 0.40 of a rig unit *outside* the line the two hip sockets draw, from 0.08
    // of one *inside* it at the release: the clearance is what the first tenth of a
    // second of the swing bought, and it is the swing that bought it — the knee is
    // carried out from under the body by the arc rather than posed wide (see the
    // browser suite's reading of the arc). The shoe is carried round with the foot,
    // which is the *arc* the leg is dragged along rather than a step it is taking (see
    // the shoe's yaw note in the assembly). The arc is held at the leg's own *length*:
    // the shoe rides the circle its own span draws around a hip that has outrun it —
    // 0.73 of a rig unit out, with the knee a thigh's own length from the socket it
    // hangs from — so the leg reads as the straight limb the turn is throwing round
    // rather than one folding up under the body (see the finish, where the same
    // reading lands it).
    //
    // The *lift* is what puts the knee out there, and it is the swing's own
    // arithmetic rather than decoration. The leg is a fixed 0.85 rig units and the
    // hips have outrun the shoe, so the leg hangs off its own socket at the length it
    // has: what the foot — and so the knee, a little over half way along the chord —
    // can be drawn *out* from the socket by is what the drop from hip to shoe leaves
    // it, and the chord is the same length either way. Measured on the realised
    // skeleton: a shoe a hand's width up (the release) leaves the foot 0.63 of a rig
    // unit out from its hip and the knee 0.16 out from the body's own centre line,
    // which is *inside* the trouser; a shoe a quarter of a rig unit up leaves the
    // foot 0.73 out and the knee 0.51 out, which is a good hand's width clear of it.
    // So the swing's own height is its width: a leg carried round a hip it has been
    // left behind by has to come *up* to get round, and coming up is what draws it
    // wide.
    pivot: { x: 0.596, lift: 0.39, z: -1.793, yaw: 0.550, bend: 0.11, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.860, bend: 0.25, hang: 0, cock: 0 },
    ball: [-0.5597, -0.7351, -0.7100], aim: [0.3498, -0.2862, -0.8921], curl: 0.35,
    // The sweep's own pole carries on down and in front of the line with it: the elbow
    // is the leading point of the arm all the way through the follow-through, which is
    // what the hand being carried across the body *is* (see the key above).
    elbow: [-0.6994, -0.2433, -0.2847],
    glove: [-0.295, -0.350, -0.340], gloveAim: [-0.37, -0.40, -0.83], gloveCurl: 0.275,
    gloveElbow: [-0.33, -0.16, -0.13],
    glovePalm: [0.40, -0.80, -0.45],
  },
  {
    // The sweep's own *fastest* frames, and the one place left where the pair either
    // side of it let the chord sag: the arm comes round a third of a right angle across
    // the fortieth of a second between the two keys above, and the interpolator's path
    // between two places cuts inside the circle that hard — 3 of the span's own
    // centimetres at 1.50s, which is an elbow 36° off the straight arm the whole of this
    // window is asking for. It is written the same way its two brothers before it are
    // (see them for the read): the direction the frame is already carrying, with the
    // wrist put back out on the arm's own span.
    //
    // Every other track is the frame's own place between its neighbours.
    t: 1.51,
    release: true, slot: 1,
    hipYaw: 0.980, chestYaw: 1.450, lean: 0.345, leanSide: 0.0, hipY: -0.085, drive: 1.262,
    headPitch: 0.145,
    pivot: { x: 0.315, lift: 0.395, z: -1.971, yaw: 0.725, bend: 0.105, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.860, bend: 0.245, hang: 0, cock: 0 },
    ball: [-0.4697, -0.7351, -0.7623], aim: [0.1908, -0.1908, -0.9629], curl: 0.325,
    elbow: [-0.500000, -0.630000, -0.365700],
    // ...and from here the ring's own *angle* is authored rather than read off that
    // place (see SWEEP_VALUES): the rest of the release window is the straight arm's,
    // and a straight arm's own place stands on the chord it is meant to be read
    // against — the two keys on either side of this one ask for a tenth and a fifth of
    // a right angle off it, and the interpolator's place between them cuts *inside* it,
    // so the side the driver reads off the place is the interpolation's noise rather
    // than the pose's. Written as the angle it is, the turn the window was always
    // making is the frame's own: the ring comes off the release's own fall (86° off the
    // chord at this key, from 95° at 1.45 s) and turns on into the fold's first key at
    // -75° — the whole of it one turn, read off the keys either side instead of off a
    // place whose own tilt has run out.
    sweep: (-370.0 * Math.PI) / 180,
    glove: [-0.2925, -0.365, -0.330], gloveAim: [-0.355, -0.45, -0.81], gloveCurl: 0.2625,
    gloveElbow: [-0.325, -0.17, -0.125],
    glovePalm: [0.425, -0.80, -0.425],
  },
  {
    // The follow-through's own middle, and the frame the lead arm's work is judged
    // at: the forearm is out away from the body and nearly straight (0.57 of the
    // 0.60 the arm has), the glove carrying on down and round to the glove's side
    // while the elbow stays on the outside of the line it holds. Meanwhile the whole
    // body keeps travelling: the pelvis is 0.92 rig units toward the plate — past the
    // front foot's own plant, which stands at 0.88 — and the chest is 86° past the
    // plate's line (it is the frame the shoulders are *square* on: the line reads 180°
    // here), with the pivot foot crossing in front of the front one on its way
    // to landing.
    t: 1.54,
    slot: 1,
    straight: (174.9 * Math.PI) / 180,
    hipYaw: 1.01, chestYaw: 1.550, lean: 0.32, leanSide: 0.0,    hipY: -0.10, drive: 1.3070,
    headPitch: 0.14,
    // ...and the arc keeps coming: the leg is up and coming round the body's own line,
    // out on the circle its own length draws and still a hand's width up, with the
    // shoe turned out the way the swing went rather than the way the body is facing —
    // and the knee still riding a few centimetres *outside* the hip it hangs from
    // rather than tucking under it, which is the whole of what a leg being carried
    // round looks like from the plate, and the first frame it is (see the arc's middle
    // key below, where the clearance is a hand's width). (Measured: the foot rides
    // 0.74 of a rig unit out from the hip it hangs from through the middle of the
    // swing, against the 0.35 it drew while the leg was folding back under the body —
    // see the arc's middle key below, which is what holds it out there.)
    pivot: { x: 0.034, lift: 0.40, z: -2.1610, yaw: 0.900, bend: 0.10, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.860, bend: 0.24, hang: 0, cock: 0 },
    // The arm's own places ride the body's travel rather than standing still in the
    // rig: the delivery is a good hand's width further down the mound by this key
    // than the keys either side were first written for (see the finish), and an arm
    // asked for a place the body has gone past is the driver's to fold short — a
    // follow-through whose hand comes down *behind* the chest it is falling over.
    //
    // ...and the crossing *eases* out of the throw rather than running at one rate
    // and stopping at the landing. The arm's places on the middles between here and
    // the finish are the arm's own — written on a decelerating schedule, the hand
    // covering more of the crossing in each of the first frames than the last — so
    // the whip that leaves the release is spent over the whole of the follow-through
    // and the hand arrives at the landing *slow*, still moving, and carries on into
    // the hold. What the keys are bought for is measured off the realised skeleton:
    // the hand's own speed falls from the better part of seven rig units a second
    // through the swing's first frames to 3.3 at the landing, and the settle carries
    // the same fall on to nothing across the fifth of a second after it (see the
    // browser suite, whose own reading of the fall is taken off these frames). A
    // follow-through that ran its whole length at the speed it
    // left the hand with is a hand that arrives at the foot the body is standing on
    // at a crawl and stops there — two motions, a swing and then a settle, which is
    // not what letting a throw go looks like.
    // ...and this key, and the two after it, are written a few degrees *down* from where
    // they were: the hand-over's own height is read against the pitch, and the two frames
    // the keys meet in disagree. Every key inside the release window is an offset from the
    // *anchor* (see `trackRelease`), so the whole of the throw's own line rides the pitch's
    // release height; a key outside it is a place in the rig frame, riding only the
    // delivery's own stride. The authored delivery stands flat on the field with its
    // release at 1.72 m, and a pitch on the mound hands the pose its release *over its own
    // feet* — 1.53 m for a 1.78 m slot ten inches up — so between the two frames the
    // window's last key comes down 22 cm and the fold's first key stays where it is, which
    // is the wrist climbing into the fold on the frame the throw lets go: measured on the
    // harness pitch, the window's end sat 4.1 cm *under* this key where the keys put it,
    // and the climb is what a hand that has just thrown does not do. The three keys are
    // swung about the socket they are read from rather than moved: -3.6°, -5.0° and -5.1°
    // of their own elevation, which leaves every ask's own distance from the socket exactly
    // what it was — and that distance is the *ramp* the whip's own release is written on
    // (see the swing's next two keys), so a place moved down instead would shorten the ask
    // with it and the arm's stretch would let go a frame early. Read on the pose at the
    // harness's own slot, the wrist now falls 4 mm a key from 1.51s to 1.575s; read on the
    // suite's own, the fold's line is the one it was (the pole's own up at the hand-over
    // comes down a further 0.07 of a unit, which is the fall's own and inside the travel
    // the fold is measured by), and every ask the keys carry is the length it was.
    ball: [-0.0736, 0.3901, -3.219], aim: [0.0733, -0.2748, -0.9587], curl: 0.3,
    // ...and the pole is written *along* the arm it is on rather than off the chord the
    // way the straight keys above are: this is the frame the fold starts from, and the
    // ring the driver hangs the elbow on is read from the pole's own direction — so the
    // pole that follows it (see the key below) has to start from the arm's line here,
    // or the elbow swings the ring's own width round between the two frames and the
    // upper arm with it.
    elbow: [-0.14, 0.94, -2.285],
    // ...and the same angle for the last frame of it: the ring has come round 165° of
    // its own circle since the key above (see that key's note), which is the turn the
    // place asked for and the turn the driver reads off the keys here rather than off
    // the place (see SWEEP_VALUES).
    sweep: (-205.0 * Math.PI) / 180,
    glove: [-0.29, -0.38, -0.332], gloveAim: [-0.34, -0.50, -0.79], gloveCurl: 0.25,
    gloveElbow: [-0.32, -0.18, -0.132],
    glovePalm: [0.45, -0.80, -0.40],
  },
  {
    // The swing's own middle again, a fraction of a second on: the leg is out over the
    // *front* of the body — the foot nearly a rig unit ahead of the socket it hangs
    // from — and the shoe is carried round with it. The arc turns through most of a
    // right angle across this key and the two around it, and a chord that straight
    // cuts inside the circle the leg's own length draws about its hip: the same
    // reason the last middle key is here, one step on (see the swing's own middle).
    //
    // ...and this is the frame the *fold* starts on, so it is the first key that names
    // the arm's own bend rather than its place (see STRAIGHT_TRACK): 169° here and
    // 167.5° at the key after it — the ask is left long of the arm (see the place below),
    // so the driver's own stretch is what carries these two and folds them to the bend
    // the key names — and then 159.6° at the 1.61 key, where the ask comes *inside* the
    // arm's own reach and the places themselves take the bend over: from there down, each
    // key's place is written at the chord of the bend it means, and the realised elbow is
    // the law of cosines at that chord, which is the arm's own length rather than a
    // stretched one (measured: the driver's stretch is exactly 1.000 from 1.61s on).
    //
    // One monotone schedule for the whole of what the elbow does while the drive leg
    // swings past it, measured on the realised skeleton (240 Hz, 1.55s to 1.75s): 174.9°
    // held to the release window's own last frame (1.545s — the one place in the delivery
    // the arm is meant to be straight, and the place the browser suite's lock reading
    // exempts), then 168.6°, 165.5°, 158.8°, 155.3°, 152.6°, 150.6°, 148.6°, 145.9° and
    // 138.4° at the hold. Every step of it is a fall; the widest is 3.1° on the single
    // frame the fold lets go, there is no locked window anywhere in it, and from 1.61s on
    // every key sits on its own cap — the chase from the release is the caps' whole
    // schedule (before the fold was re-authored off these keys the elbow held 174.9° from
    // the release until 1.645s and then turned 23° in one frame, which is the flick the
    // follow-through was re-authored to lose).
    //
    // The *place* below is the arm's line as it always was — the direction the throw
    // already had, off the socket the pose estimates — and it is deliberately long of
    // the arm, so the driver answers it by stretching to it and folding it to the bend
    // this key names.
    //
    // ...and it is written a shade *in* along that line and a shade up — 8 mm in and 8 mm
    // up off the line the throw's own carry runs on — because this is the one key of the
    // fold whose own place is a local extreme of the hand's lateral: the ask runs out to
    // here with the throw and comes back in across the body from here, and the pose's own
    // track joins two keys component by component, so the curve leaves this key flat and
    // then *runs* to catch the next one up. What that costs is the forearm's own direction
    // between the two keys, which reads a fraction of a thousandth of a unit.
    t: 1.5575,
    slot: 0.957,
    straight: (169 * Math.PI) / 180,
    hipYaw: 1.023125, chestYaw: 1.600, lean: 0.311, leanSide: 0.0, hipY: -0.115, drive: 1.3186,
    headPitch: 0.135,
    pivot: { x: 0.050, lift: 0.30, z: -2.0400, yaw: 1.100, bend: 0.11, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.23425, hang: 0, cock: 0 },
    ball: [-0.077566, 0.758828, -2.34462], aim: [0.0104, -0.2651, -0.9642], curl: 0.2822,
    elbow: [-0.0717, 0.8386, -2.2135],
    // ...and which way round the chord that line hangs, as an *angle* rather than as a
    // place: the ring's own sweep about the socket-to-wrist chord, in the frame the
    // world's own up makes with it (see SWEEP_VALUES below, and the pole the pose hands
    // the driver). A pole is a *direction*, and a direction written as a place is
    // carried corner to corner by the interpolator: through the crossing the ring turns
    // most of a right angle between two keys, and the line the interpolated place
    // writes cuts across the body instead of sweeping round it — the pose's own elbow
    // then stands inside the trunk, where the driver answers with its clearance rule
    // rather than with the promise, and the upper arm comes up across the drive leg in
    // one frame (read on the realised skeleton: 20.6° of upper arm, an 11.6 cm jump of
    // the elbow, with the bend held still). Read as the angle it is, the same fold turns
    // its ring the way the keys turn it and the driver holds the pose's own line.
    //
    // ...and it is turned the better part of a tenth of a right angle further round than
    // the crossing's own keys were first written for, which is what keeps the *upper
    // arm's* own line falling through the frames after it: the ring's angle is where the
    // elbow hangs about the chord, so a ring that turns *under* the line it is carrying
    // walks the elbow back up on its way in. Read on the pose at a two hundredth of a
    // second a frame, the upper arm's own up (the sense its travel is read in, see the
    // arm test) turned back up by 0.0054 of a unit a frame across the hand-over with the
    // ring at its old tilt — the flick the follow-through was re-authored to lose, this
    // time in the *line* rather than in the bend — against the 0.0016 those frames read
    // here; this key turned alone reads 0.0031 and the next one alone 0.0037, so the two
    // go round together. What the key names is still the fold's own chord: the ring is
    // where round that chord the elbow hangs, and the bend is untouched by it.
    sweep: (-95.00 * Math.PI) / 180,
    glove: [-0.28775, -0.40475, -0.331], gloveAim: [-0.34875, -0.489, -0.79425], gloveCurl: 0.254,
    gloveElbow: [-0.3175, -0.1825, -0.1375],
    glovePalm: [0.418, -0.79525, -0.43375],
  },
  {
    // The swing's own middle, and it is authored rather than left to the two keys
    // around it: the foot goes from out on the throwing side of the body to out on the
    // glove side of it across those two keys, which is most of the swing's arc, and a
    // single chord that far round cuts *inside* the circle the leg's own length draws
    // about the hip it hangs from — enough to fold the knee a third of the way to the
    // shin and bring the foot back under the body it is being carried around, which is
    // the one shape a leg that is no longer carrying any weight does not make. So the
    // foot is written where the arc actually passes: the swing's own middle, with the
    // leg at its own length the whole way round (measured on the realised skeleton:
    // within a tenth of its span of straight at every frame of the swing, against the
    // third of it the chord alone leaves, and the foot never comes closer than half a
    // rig unit to its own hip — see the browser suite's reading of the swing).
    //
    // The crossing is *fast* — a sixth of a second from the swing's widest frame to the
    // side it lands on — and the leg is *up* for it: this is the frame the leg is
    // nearest level with the ground, which is what a back leg the turn has carried
    // round actually looks like. What it is not is a step: the shoe's own line is
    // still coming round with the swing (see the shoe's yaw note in the assembly), and
    // the knee rides out ahead of the foot on the side the swing is going — which is
    // what puts it outside the body's own outline rather than under it (see the
    // swing's widest frame above, and the browser suite's reading of the knee's
    // clearance).
    //
    // Every other track is the frame's own place between its neighbours — the body's
    // turn, its lean and the hips' travel (a `slot` of three quarters is where the
    // release-window lean is between the two keys as well) — so that the delivery's
    // own shape across here is what the keys either side asked for and this key is the
    // leg's. The *arms* are the exception: their places here are the arm's own, on the
    // decelerating crossing the follow-through's first key above writes (see it).
    //
    // The arm's own place is written *in* from where the throw's line runs at this key,
    // on the ramp the two keys either side of it sit on, and it is the fold's schedule
    // that asks for it (see the key above, and STRAIGHT_TRACK): the pose answers an ask
    // past the reach it holds by handing back the reach itself, so the further in the ask
    // is written the closer that answer already is to the chord the driver will fold to,
    // and the less of the pose's own promise the drawn ball stands off (measured on the
    // realised skeleton: the frames across the hand-over read 4.4 to 9.4 mm off, against
    // 5.6 to 11.0 mm with the place left on the throw's line). The *bend* is untouched
    // either way — that is the cap track's, and the same 165.5° comes back with either
    // place — so what the place buys is the pose's own number keeping up with the arm it
    // is asking for, not the arm's shape.
    //
    // ...and the *ramp* is what that place is, so the ask's own distance from the socket
    // is a schedule rather than a spike in one. On the throw's line this key stands 1.17
    // of a rig unit out from the socket, where the key before it asks 0.91 and the one
    // after it 0.70: the pose's own track interpolates a place *component by component*
    // (see `trackAt`), so a key that is a local extreme in its own components — this one
    // is, forward of both of its neighbours in z and below both of them in y — holds where
    // it is and then *runs* to catch the next key up: the ask's distance fell 39 mm in one
    // frame at 1.6083 s against 3 or 4 on the frames either side of it (measured in the
    // pose's own units, 240 Hz), and the driver's answer to an ask past its reach is its
    // own stretch — so the arm was stretched 1.20 to hold that ask and let go of it in
    // three frames, which is the throwing arm's own flick up across the drive leg (read on
    // the realised skeleton with the place on the line: the elbow 4.6 cm *up* over two
    // frames against 1 cm around them, the hand's own fall turning over into a rise for a
    // frame, and the hand covering 9 cm down the mound on the frame the stretch let go).
    // Written on the ramp — 0.91 out, then 0.80, then 0.70 — the same place realises the
    // same line: the ask is 1.25 of the span here and at the key before it, so the reach
    // the pose promises the driver is the chord either way, and what moves is only the
    // rate the promise's own distance leaves the line at (no hold anywhere across the
    // crossing, and the stretch falls 1.24 to 1.00 over the fifth of a second the fold
    // takes rather than over three frames).
    t: 1.575,
    slot: 0.844,
    straight: (165.0 * Math.PI) / 180,
    hipYaw: 1.03625, chestYaw: 1.645, lean: 0.302, leanSide: 0.0, hipY: -0.120, drive: 1.3360,
    headPitch: 0.13,
    // The swing's own middle: out over the hip it hangs from with the foot still a
    // hand's width up and the leg at its length — the arc written down.
    pivot: { x: 0.070, lift: 0.30, z: -1.9970, yaw: 1.300, bend: 0.12, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.2285, hang: 0, cock: 0 },
    ball: [-0.1501, 0.7846, -2.2633], aim: [-0.0825, -0.3174, -0.9447], curl: 0.2660,
    elbow: [-0.1286, 0.8416, -2.199],
    // ...and the ring keeps coming round on the same schedule as the key before it (see
    // that key's own note): the two of them together are what the arm's travel is read
    // off, and the elbow's line falls through both of them without turning back.
    sweep: (-45.00 * Math.PI) / 180,
    glove: [-0.2855, -0.4295, -0.329], gloveAim: [-0.3575, -0.478, -0.7985], gloveCurl: 0.258,
    gloveElbow: [-0.315, -0.185, -0.142],
    glovePalm: [0.386, -0.7905, -0.4675],
  },
  {
    // The swing's own way out: out to the glove side of the body's own line now and on
    // its way down, the shoe turned well out the way the swing went and the knee out
    // beyond it — the side the swing comes round on. This is the last frame before the
    // foot is put down, so it is also where the leg gives up the last of its height.
    t: 1.61,
    slot: 0.5,
    straight: (158.5 * Math.PI) / 180,
    hipYaw: 1.171, chestYaw: 1.720, lean: 0.2107, leanSide: 0.0, hipY: -0.0952, drive: 1.3480,
    headPitch: 0.12,
    // Out to the glove side of the body's own line now, still a hand's width up and on
    // its way down, with the shoe turned well out the way the swing went and the knee
    // out beyond it — the side the swing comes round on, and the far end of it: from
    // here the foot carries *in* as it comes down, across the body's own line and on to
    // the far side of it, which is where the finish stands (see the middles below).
    //
    // ...and it is the key the fold's ask comes onto the arm's own chord on (see the
    // fold's own note at the first follow-through key): the place below is a chord rather
    // than a line past it, the driver's stretch is nought from here on, and the elbow the
    // frame realises is the *cap's* own — 158.8° on the realised skeleton at this key,
    // against the 158.5° the cap track names, with the frames either side of it reading
    // 160.3° and 155.3°, so no frame of the fall carries a step of more than 0.9°.
    //
    // ...and the place is written *clear of the trunk's own clearance* as well as on the
    // chord: an ask inside the body's own volume is answered by the driver pushing it out
    // of it, and what the pose then promises — the place it wrote — stands off the hand
    // the driver really carries by exactly that push. Written a shade further forward and
    // out (on the pose's own chord place the wrist landed 6.5 mm short of the ask here and
    // 6.3 mm at 1.62s, and the drawn ball stood that far off the promise), the two keep up
    // with each other: 2.6 mm here and 2.0 mm at 1.62s, against the browser suite's own
    // 5 mm reading (see its test of the promise).
    pivot: { x: 0.100, lift: 0.301, z: -1.7950, yaw: 1.750, bend: 0.14, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.217, hang: 0, cock: 0 },
    ball: [-0.332962, 0.727195, -2.043], aim: [-0.2378, -0.5511, -0.7998], curl: 0.2380,
    // The pole is the upper arm's own line, and it stands off the chord by the angle the
    // key's own bend puts it at: 0.056 of a unit for these 158.5° — the arm's own law of
    // cosines, sin(10.2°) of the upper arm's length. Written closer to the chord than that
    // (measured, 0.024 of a unit off it), the plane the driver hangs the elbow's own ring
    // on is at the mercy of the pose's socket estimate — which stands five to a dozen
    // centimetres from the driver's own socket across the hand-over — and the elbow swings
    // round its chord by the ring's whole radius, the fold's own bend with it: that is what
    // the throwing arm's flick up across the drive leg was, and it is why the pole has to
    // name its side plainly (see the browser suite's reading of the fall, and the unit
    // suite, which holds every pole of the delivery clear of its own chord).
    //
    // ...and it was half the story: the *width* of the ring is the pole's own tilt, and
    // the *way round* the chord it hangs is this key's ``sweep`` (see the fold's first
    // follow-through key). A place written between two keys is carried corner to corner,
    // and the fold's own ring turns most of a right angle an eighth of a second here: the
    // interpolated line cuts across the chest, which is a pole asking for an elbow inside
    // the body — and the driver answers *that* with its clearance rule rather than with
    // the promise, which is the flick the tilt alone did not stop (read on the realised
    // skeleton with the tilt corrected and no sweep: 19.5° of upper arm and an 11.1 cm
    // elbow jump in the one frame at 1.6125 s). Composed from the sweep, the same fold
    // reads 5.6° and 3.7 cm at its worst, and the browser suite's own frame-by-frame
    // reading of the arm's turn is what holds it.
    elbow: [-0.179589, 1.06849, -1.82514],
    sweep: 0,
    glove: [-0.281, -0.479, -0.319], gloveAim: [-0.375, -0.456, -0.807], gloveCurl: 0.266,
    gloveElbow: [-0.31, -0.19, -0.145],
    glovePalm: [0.322, -0.781, -0.535],
  },
  {
    // ...and the last of the arc's middles, where the crossing is: the foot is out at
    // the far end of its own swing — to the glove side of the body's own line and still
    // dropping — with the shoe turned a hand's width further round than the frame
    // before it and the leg still at its own length. Written for the same reason as the middles either side of it:
    // the arc turns through a hundred and sixty degrees across the follow-through, and
    // a track between keys a twentieth of a second apart cannot hold that many degrees
    // without running to catch up in its middle.
    //
    // The arm's place here is its own chord (see the fold's note at the first
    // follow-through key), and the cap track is left *wide* of it on purpose: the arc the
    // place is written on turns hard between this key and the two below it — the hand
    // comes in eleven centimetres of the span across them — and the curve the keys are
    // joined on bulges *out* over that turn, so the frame between this key and the last of
    // the fold's keys carries a wrist three and a half millimetres further out than either
    // of them asks for. The cap is what answers it: set a degree and a half wide of the
    // place's own chord, it takes those overshooting frames back to the schedule rather
    // than letting them read as a straighter arm (measured on the realised skeleton: the
    // frame at 1.62s reads 157.4°, which is this key's own schedule, against 164.4° with
    // the cap left at its old 179°, and the frame carries no step either way).
    //
    // Every other track is the frame's own place between its neighbours.
    t: 1.6275,
    slot: 0.316,
    straight: (155.6 * Math.PI) / 180,
    hipYaw: 1.238, chestYaw: 1.755, lean: 0.1549, leanSide: 0.0, hipY: -0.0742, drive: 1.3560,
    headPitch: 0.115,
    pivot: { x: 0.120, lift: 0.255, z: -1.7580, yaw: 2.050, bend: 0.16, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.21275, hang: 0, cock: 0 },
    ball: [-0.423326, 0.657388, -1.8957], aim: [-0.2907, -0.7019, -0.6503], curl: 0.2262,
    // ...and its pole stands off this key's own chord by the 0.064 of a unit the same
    // reading asks for its 155.6° (see the note at the key above).
    elbow: [-0.241174, 1.0576, -1.75054],
    sweep: (8 * Math.PI) / 180,
    glove: [-0.26825, -0.49925, -0.316], gloveAim: [-0.38125, -0.442, -0.81025], gloveCurl: 0.2745,
    gloveElbow: [-0.3075, -0.1925, -0.1455],
    glovePalm: [0.2915, -0.76075, -0.57125],
  },
  {
    // The swing's own middle again, one key later than the last one, because the leg
    // is on its way to a *landing* across here and the last of the arc is where that
    // happens: the foot has turned the corner of the arc — back from its own furthest
    // and starting in across toward the body's line — with the shoe's line following it
    // round and the whole of the leg's own travel with it, the socket and the foot
    // together. It is still out to the glove side of that line: the landing under it is
    // the *last* thing the swing does (see the two keys below, and the finish).
    //
    // A second middle key is here for the same reason the first one is, one step on:
    // the arc the foot is written on turns through a hundred and sixty degrees across
    // the follow-through, and a pair of keys half a second apart cannot hold a
    // hundred and sixty degrees of turn without the track between them *running* to
    // catch up in its middle — the foot left the wide frame at the 1.61 key and
    // reached the landing at 1.68 by travelling nearly a rig unit in a fifteenth of a
    // second, twice the speed of the swing it belongs to. Written here, the leg turns
    // through the same angle in two even steps and the foot arrives at its landing
    // carried round rather than thrown at it (see the swing's own note above).
    //
    // Every other track is the frame's own place between its neighbours, as at the
    // first middle key — the body's turn, its lean and the hips' travel — and the arms
    // are the arm's own, as at every middle across the crossing.
    //
    // ...and the arm's own *place* here is written at the chord of the bend this frame
    // means (see the fold's note at the first follow-through key): the ask is inside the
    // arm's own reach by this point in the fall, so the driver neither stretches nor
    // folds anything here — the elbow is the law of cosines at the place itself, and the
    // place is what the fold's schedule is written on. Measured on the realised skeleton,
    // this key reads a 152.6° elbow, which is the cap track's own number there, and the
    // keys either side of it 155.3° and 150.6°, so the fall carries no step of more than
    // 2.0° between the keys of the crossing and no frame of it rises at all.
    //
    // ...and the asks from here to the pause are left a few millimetres *inside* the
    // trunk's own clearance, which is the one number of this fold that is not the pose's
    // to settle: the driver answers such an ask by pushing it out of the body's own
    // volume, so the pose's own promise stands off the hand it really carries by that
    // push — 6.4 mm at 1.6625s and 4.3 mm at 1.71s, and 11.4 mm on the frames between
    // this key and the one before it, where the interpolated ask dips deepest into it.
    // The *hand* is the driver's own answer and is outside the body by construction; what
    // the drift costs is only the promise's own fidelity. Moving these asks out was tried
    // and reverted: the swing's own deceleration moves with them (it read 10.27° between
    // 1.745s and 1.78s against 9.58° before it), and that deceleration is what this half
    // of the follow-through is *for* (see the swing's own keys, and the unit suite).
    t: 1.645,
    slot: 0.156,
    straight: (152.7 * Math.PI) / 180,
    hipYaw: 1.305, chestYaw: 1.785, lean: 0.1025, leanSide: 0.0, hipY: -0.0491, drive: 1.3660,
    headPitch: 0.11,
    pivot: { x: 0.135, lift: 0.214, z: -1.7410, yaw: 2.350, bend: 0.18, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.860, bend: 0.2085, hang: 0, cock: 0 },
    ball: [-0.445826, 0.709002, -1.6932], aim: [-0.3085, -0.8404, -0.4456], curl: 0.2160,
    elbow: [-0.2715, 1.0649, -1.6612],
    sweep: 0,
    glove: [-0.2555, -0.5195, -0.313], gloveAim: [-0.3875, -0.428, -0.8135], gloveCurl: 0.283,
    gloveElbow: [-0.305, -0.195, -0.146],
    glovePalm: [0.261, -0.7405, -0.6075],
  },
  {
    // The arc's own last step before the foot is down: it is a fifth of a rig unit out
    // to the glove side of the body's own line and nearly on the ground, the shoe's line
    // a quarter turn past the plate's, and the leg — held at its own length the whole
    // way round — coming down on the place it lands on, which from here is the whole of
    // the rest of its travel: the last fifth of a second of it is spent carrying the foot
    // in *across* the body's own line and down onto the far side of it — the side the
    // finish's own lean stands the weight on (see the landing's own note) — while the shoe
    // goes on round with the shin. The same middle key, one more time (see the two above).
    //
    // Every other track is the frame's own place between its neighbours.
    t: 1.6625,
    slot: 0.043,
    straight: (150.6 * Math.PI) / 180,
    hipYaw: 1.373, chestYaw: 1.805, lean: 0.0635, leanSide: 0.0, hipY: -0.0298, drive: 1.3750,
    headPitch: 0.105,
    pivot: { x: 0.145, lift: 0.107, z: -1.6220, yaw: 2.700, bend: 0.20, hang: 0 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.20425, hang: 0, cock: 0 },
    ball: [-0.4167, 0.743779, -1.5113], aim: [-0.2811, -0.9384, -0.2009], curl: 0.2072,
    elbow: [-0.2784, 1.0877, -1.5814],
    sweep: (-10 * Math.PI) / 180,
    glove: [-0.24275, -0.53975, -0.31], gloveAim: [-0.39375, -0.414, -0.81675], gloveCurl: 0.2915,
    gloveElbow: [-0.3025, -0.1975, -0.1465],
    glovePalm: [0.2305, -0.72025, -0.64375],
  },
  {
    // The finish: upright out of the fold, the throwing arm done across the body, and
    // the *back* foot landed — the whole body's travel finishes in the feet, which is
    // what a delivery's weight going with the pitch looks like. The pelvis is a full
    // rig unit toward the plate by here, which is 0.41 of a unit past the spot the front
    // foot planted on and 0.16 short of where the pivot foot lands: the hips have gone
    // *through* the plant rather than stopping at it, and the pivot foot — which the
    // drive peeled off the rubber at the break — has swung round the front leg and
    // come down beyond it, on the glove's own side, where a body that has turned this
    // far round actually puts a foot. The chest is 104° round on the plate's own line —
    // read off the posed shoulders, 189° from the set's side-on stance, which is 9°
    // *past* square: the turn did not stop with the ball and it did not stop at the
    // plant either — and this is the frame it stops on. Its rate is what makes the
    // finish read as momentum rather than a pose: the turn's fastest frame is the
    // release's and it only ever slows after it (3275°/s on the ball, 960 by 1.42, 360 by
    // 1.48, 240 by 1.54 and 120 on this frame), so the last of it is *spent* arriving
    // here rather than being carried through the landing.
    //
    // That shape is what the keys between the release and this one are for. A turn
    // still going when the foot lands is a body that has to be stopped, or one that
    // turns on through its own landing; an earlier authoring of this delivery spent the
    // last twenty degrees of it *after* the foot was down, over the give the landing
    // used to have. With the give removed (see the hold below) the same turn had to be
    // moved into the swing, which is what those keys' yaws are written for: a rate that
    // only falls, from the release's own peak to a tenth of it here.
    //
    // The *travel* is written the same way, and it is why the keys from 1.54 on stand
    // where they do. The pelvis used to reach its own place while the foot was still a
    // hand's breadth off the ground and spend the rest of the swing shifting its last
    // three centimetres, which reads as a stop at the plant rather than a body going
    // over it. The keys from 1.54 to this one now carry what is left of the travel at a
    // rate that only falls — measured on the realised spine root, 1.2 rig/s at 1.52s,
    // 1.5 at 1.54, 1.3 at 1.56, 1.1 at 1.58, 0.8 at 1.60, 0.6 at 1.62, 0.5 at 1.64 and
    // 0.35 at 1.66, against a crawl of 0.06 a second from 1.63 on before it — and it
    // does *not* stop here. A delivery's weight does not stop on the frame its lead foot
    // lands; the plant is where the body goes *over* the foot, so the drive's own keys
    // from this one to the hold carry the last of it: 0.55 of a rig unit a second on this
    // frame, then 0.49, 0.41, 0.38, 0.34, 0.26, 0.22 and 0.11 at 1.88s, and nought from
    // 1.90 — one decaying run, 0.074 of a rig unit of it, where the previous authoring
    // had the drive one number from this frame out and the pelvis dead on the spot (see
    // the hold, and the keys between).
    //
    // The *plant* is what pays for it and what gives it room: the stride foot is authored
    // a foot further down the mound than it was (0.12 of a rig unit out, 0.94 to 1.06 in
    // the keys' own frame), so the leg the body lands over is the same leg at the same
    // reach and the hips have somewhere to go. The mound falls away under that foot by
    // 1.4 cm over the extra 0.12, which the placement's own step already carries (see
    // Pitcher.jsx, which solves it off `pitcherFinish`'s feet every pitch).
    //
    // What the extra carry costs is paid on the other tracks of the window by the same
    // amount: the pivot foot's own keys and the throwing arm's places stand 0.046 of a
    // unit further toward the plate on each of them, so the leg's span and the arm's own
    // chord are the ones they were and the pelvis is the only thing that arrives later,
    // and past this key the arm rides the body's own travel frame by frame (see `carried`
    // in the pose, which hands it the whole of what the pelvis spends after the plant).
    //
    // The pelvis has come up over the feet on the way: nought of a rig unit of rise
    // across the stride's fold by 1.575 and a tenth of one by here (hipY -0.075 to
    // -0.0245 over the last tenth of a second of the swing), which is why the feet can
    // land on straight legs at all — a pelvis that arrived low and stood up afterwards
    // would be a knee giving under the weight (see the hold below, which is the frame
    // this one is).
    //
    // And the leg came *round* to get there rather than stepping: the shoe's own yaw
    // has turned the whole way out to the glove side of the plate's line (54°, from
    // 25° before this was authored), so the plane the knee bends in turns out with the
    // swing instead of a shoe left pointed at the plate carrying the foot across the
    // body beneath it. What the spin does with the foot is both: round, and *on* — the
    // landing is half a rig unit ahead of the lead foot's own place (0.61 on the
    // realised ankles, against the 0.604 it stood at before the drive leg's plant was
    // brought in toward that foot — see below), because what the finish has to stand on
    // is the weight *between* the two feet, and a trail foot that comes down level with
    // the stride's plant leaves the hips' own shadow sitting over it rather than over
    // the space between the legs (see the finish below). The extra travel is the
    // swing's — the leg goes on round the arc its own momentum drew and the turn is
    // what puts it down on the body's own line instead of out at the end of it.
    //
    // One axis throughout: the pelvis' forward fold is the whole of the tilt, the
    // sideways one is nought from the plant on, and what the turn does with the rest
    // is rotate. A torso that leaned toward the glove hand while it came round is the
    // one thing a body *carried* by its own momentum does not do — the momentum is
    // along the pitch, and the axis it turns about is the one the fold has already
    // leaned it on.
    //
    // The arm's own two places are read *in front of* the body the finish is thrown
    // by: by here the delivery has driven a rig unit toward the plate and folded the
    // torso over it, so a hand written at the *standing* body's belly height is
    // written inside the leaning one. Both are what a follow-through does: the hand
    // comes down across the front of the body, and the elbow leads it forward, not
    // through the ribs.
    //
    // The arm's own *line* is still travelling on this key and the two after it: the
    // whole arm swings on the arc the socket draws, and its travel is eased out across
    // the swing rather than spent in the frame the fall hands it over on — the fall
    // brings it round at several rig units a second, so a line that arrived at its own
    // spot here would be a line the *hand* had to be stopped by, and the stop would show
    // in the hand's own sweep: measured on the realised skeleton before the easing, the
    // hand's own lateral step fell to 0.0001 of a unit at 1.70s and came back to -0.008
    // on the step after it. The travel's own share is 0.45 of it here, 0.80 by 1.71s and
    // the whole of it by 1.745s, each step smaller than the one before it, and the line
    // is held on the spot it arrives at for the rest of the beat and out to the pause
    // (see the fold's own keys, and the unit suite, which reads the ease, the arrival
    // and then the hold).
    t: 1.68,
    straight: (148.6 * Math.PI) / 180,
    // The slot's own say in the lean runs out with the follow-through: the arm's own
    // keys are still in the window, and the recovery below is not.
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.3840,
    headPitch: 0.10,
    // ...and it comes down half a rig unit *past* the foot the stride planted on (0.61:
    // past the whole of that foot and near half of another, which is a foot the hips have
    // to travel on to reach) and a tenth of one *across* it: to the throwing side of the
    // body's own line (0.150), where the swing's own arc had it two fifths of a unit out
    // on the glove side of it a tenth of a second before. The two numbers are one
    // decision, and it is the *lean's*: the roll the follow-through leaves standing (see
    // TILT_TRACK and TILT_LANDING_SHARE) carries the body it stands over across by its own
    // metres — a fore/aft line a body is rolled about is a *lever*, and the weight on the
    // far end of it is not over its own feet any more — so a trail foot left where an
    // un-leaned finish would take it lands with the weight outside the pair of them: the
    // foot is put down where the weight is coming to instead. Read off the realised
    // skeleton, the trail foot's ankle stands 0.12 of a unit across the pelvis' own line
    // and the lead foot's ankle 0.03 the other way, so the weight the roll carries is
    // *between* the two feet: the lean's own metres come to 0.59 of a unit across that
    // line on this body's widest ask, against the 0.60 this foot's ankle is standing at —
    // the shoe is put down under the weight a rolled torso brings with it rather than
    // inside the line it would stand in upright. The two feet are 0.53 of a unit apart
    // either way (0.150 across and 0.61 of the stride's own forward travel), the same
    // stance an un-leaned finish would have been authored with, turned the other way about
    // the lead foot's own line: what the lean moves is *where* the finish's weight is
    // stood, and what the swing moves is the foot that is stood under it. It lands there
    // because that is what a body dragged round by its own turn does with its back leg:
    // the leg is carried *through* by the same momentum the chest is — across the body it
    // has stopped under, and on out to the side the weight is falling to — and the hips go
    // on forward over it rather than stopping at the plant they made earlier (see the
    // finish's own note above, and ``drive``). Where it lands is where the weight arrives,
    // and where the weight arrives
    // is where the delivery ends: the frame this foot lands in is the frame he is left
    // standing in, with nothing to settle onto it and nothing to stand up out of (see the
    // hold below).
    pivot: { x: 0.150, lift: 0, z: -1.5010, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    glovePalm: [0.20, -0.70, -0.68],
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.3718, 0.765852, -1.3527], aim: [-0.2155, -0.9747, 0.0591], curl: 0.2,
    elbow: [-0.2711, 1.1029, -1.5101],
    sweep: (-30.82 * Math.PI) / 180,
    glove: [-0.23, -0.56, -0.306], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.3, -0.2, -0.146],
  },
  {
    // The swing's own middle: every track here but the drive is the landing key's —
    // the body is written flat across the hold, and the one thing still moving through
    // it is the pelvis, which the drive keys carry on down from the plant to the hold
    // (see the landing's own note) — and the throwing arm's own two places are where
    // the realised skeleton had the arm at this frame when the key was written.
    t: 1.71,
    straight: (147.6 * Math.PI) / 180,
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.4000,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.5010, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.3385, 0.8316, -1.2117], aim: [-0.0925, -0.8181, 0.5676], curl: 0.2136,
    elbow: [-0.2603, 1.0983, -1.4795],
    sweep: (-50.76 * Math.PI) / 180,
    glove: [-0.226, -0.556, -0.296], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.286, -0.21, -0.148],
    glovePalm: [0.20, -0.70, -0.68],
  },
  {
    // The swing's own middle: every track here but the drive is the landing key's —
    // the body is written flat across the hold, and the one thing still moving through
    // it is the pelvis, which the drive keys carry on down from the plant to the hold
    // (see the landing's own note) — and the throwing arm's own two places are where
    // the realised skeleton had the arm at this frame when the key was written.
    //
    // The ring's own angle is the last of the fold's, and it is the one number of the
    // swing that had to be re-solved when the finish's fold deepened (see FINISH_FOLD):
    // the ring is read off the socket-to-wrist chord, and the deeper fold carries the
    // socket a centimetre and a half further down and forward on every frame of the hold,
    // so the angle that composed this key's own elbow before now composed a place 17 mm
    // from it — a step the driver would have taken on the frame the window ended. At
    // -61.4° the ring lands on the place the keys hold to 0.0002 of a rig unit, which is
    // the arm's own line, unchanged from the frame the travel arrives on to the end of
    // the beat.
    t: 1.745,
    straight: (147.1 * Math.PI) / 180,
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.4150,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.5010, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.3132, 0.9136, -1.1192], aim: [-0.0043, -0.4165, 0.9091], curl: 0.2295,
    elbow: [-0.2538, 1.0972, -1.4622],
    sweep: (-61.4 * Math.PI) / 180,
    glove: [-0.2234, -0.5534, -0.2903], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.2769, -0.2165, -0.1501],
    glovePalm: [0.20, -0.70, -0.68],
  },
  {
    // The swing's own middle: every track here but the drive is the landing key's —
    // the body is written flat across the hold, and the one thing still moving through
    // it is the pelvis, which the drive keys carry on down from the plant to the hold
    // (see the landing's own note) — and the throwing arm's own two places are where
    // the realised skeleton had the arm at this frame when the key was written.
    t: 1.78,
    straight: (179 * Math.PI) / 180,
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.4290,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.5010, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.2981, 1.0049, -1.0862], aim: [0.0228, 0.0009, 0.9997], curl: 0.2455,
    elbow: [-0.2538, 1.0972, -1.4622],
    glove: [-0.2218, -0.5518, -0.2831], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.2713, -0.2205, -0.1477],
    glovePalm: [0.20, -0.70, -0.68],
  },
  {
    // The swing's own middle: every track here but the drive is the landing key's —
    // the body is written flat across the hold, and the one thing still moving through
    // it is the pelvis, which the drive keys carry on down from the plant to the hold
    // (see the landing's own note) — and the throwing arm's own two places are where
    // the realised skeleton had the arm at this frame when the key was written.
    t: 1.82,
    straight: (179 * Math.PI) / 180,
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.4410,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.5010, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.2850, 0.8800, -1.1150], aim: [0.0114, -0.4000, 0.9165], curl: 0.2636,
    elbow: [-0.2538, 1.0450, -1.4720],
    glove: [-0.2208, -0.5508, -0.2746], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.2678, -0.223, -0.1422],
    glovePalm: [0.20, -0.70, -0.68],
  },
  {
    // The swing's own middle: every track here but the drive is the landing key's —
    // the body is written flat across the hold, and the one thing still moving through
    // it is the pelvis, which the drive keys carry on down from the plant to the hold
    // (see the landing's own note) — and the throwing arm's own two places are where
    // the realised skeleton had the arm at this frame when the key was written.
    t: 1.86,
    straight: (179 * Math.PI) / 180,
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.4510,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.5010, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.2766, 0.8200, -1.0950], aim: [-0.0190, -0.8600, 0.5099], curl: 0.2818,
    elbow: [-0.2538, 1.0300, -1.4800],
    glove: [-0.2203, -0.5503, -0.2683], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.2661, -0.2243, -0.1375],
    glovePalm: [0.20, -0.70, -0.68],
  },
  {
    // The hold: the frame the drive foot landed in, and the same pose nine tenths of a
    // second later. There is no give in this finish and no stand up out of one. The give
    // the delivery used to land in was 0.020 of a rig unit of pelvis and four degrees of
    // knee onto the foot the swing had just put down, with the body standing back up out
    // of it over the next fifth of a second; what took it out is the *lever* the landing
    // is: a leg is a fixed length, so its knee's bend and the height of the pelvis over
    // its foot are one number read twice, and the only way for both legs to arrive
    // *straight* in the frame their feet plant in is for the pelvis to be up over them
    // by then. So the travel that used to be the stand was moved into the swing's own
    // tail — the pelvis comes up a tenth of a rig unit over the last tenth of a second
    // of it, see the landing above — and what is left here is the beat a delivery's own
    // follow-through has, where nothing happens: the pitcher standing in what he has
    // just done rather than sagging onto the leg that caught him and standing back up.
    //
    // Read off the realised skeleton, both legs land at their own length: 0.8519 and
    // 0.8511 of a rig unit from socket to ankle against a 0.8546 limb — 99.68 and 99.59
    // per cent of it, which a two-bone chain can only be with 9.2° of knee on the drive
    // side and 10.3° on the lead. The last of that bend is the *shoe*'s and it is the
    // pose's own to name: a planted shoe is stood on the dirt by its own lowest corner
    // (see the driver's ground rule), so a shoe left on whichever corner the leg's own
    // turn made lowest carries the *ankle* up by that much — and a socket-to-foot line
    // short by that much is a knee with that much bend in it. Measured with ``flat``
    // left off these keys' shoes, the ground rule has to carry the ankles 0.0316 and
    // 0.0281 of a unit up to get a corner of each shoe onto the dirt, and the knees read
    // 31.4° and 29.7°; with the flat written (``flat`` 1 — the ankle's turn about the
    // line the sole itself runs along, see the pose assembly and the driver's
    // ``rollSoleFlat``) the ankles come down to 0.0016 and 0.0022 and the knees read
    // 9.2° and 10.3°. So the last 22° and 19° of the finish are neither the leg's length
    // nor the stride: they are the shoe's own sole, and it is authored. Standing him
    // further up is not available either: the legs are within three millimetres of their
    // whole length as it is, and a pelvis asking for more is answered by the shoe
    // tipping onto its toe — measured at hipY -0.023 on this same drive, where the reach
    // came out at 0.8548 against the 0.8546 limb and both shoes read ``rolled`` — which
    // is the one thing a finish standing on its own two feet may not look like.
    //
    // Nothing above the legs moves either, which is the same decision read again: the
    // *authored* turn and fold are spent with the travel (the chest is 104° round on the
    // plate's line and the trunk three degrees off upright by the landing — see the
    // two keys above), so the key's own numbers have nothing left to ease. The lean the
    // *pitch* has in him is another matter: the roll the follow-through leaves is the
    // finish's own (see TILT_LANDING_SHARE) and it is *held* here, on this key and on
    // every frame between it and the landing — a pose that drifted across the second would
    // be a pitcher swaying in the hold, and what a hold is is a *stop*. What gives it up
    // is the walk-back, with the turn and the step that carry the body home (see
    // TILT_TRACK): the two are one motion, and a body coming upright on frames its feet
    // are not moving on would be standing up out of its own finish rather than into the
    // set.
    //
    // The throwing arm *hangs* by here. The throw's own straight line is spent with the
    // hand-over, and what a thrown arm does once there is nothing in it is fall to the
    // ground and stop: the upper arm has travelled on from the hand-over down its own
    // arc — 61° under the socket on the hand-over's own frame (1.745s), 52° at the top
    // of the settle, 65° by 1.88 and 58° through the beat — and the forearm has come
    // down *under* it rather than folding up over the hip, from 63° below the horizon at
    // the hand-over to 79° here. So the hand the hold is written at hangs at the thigh,
    // 0.54 of a rig unit under the socket, with the elbow's own point just outside the
    // ribs — the arm a body stands in after a throw, not one it is still holding out.
    //
    // It is written as a *hang* rather than as the fold the finish used to land in, and
    // the two places below are what decide it. The keys here used to carry the hand up at
    // the hip — 0.20 of a unit *above* the elbow it was written off — with the forearm
    // standing up over the joint, and the ride then lifted the whole arm as the trunk
    // stood up under it: measured on the realised skeleton, the upper arm climbed from
    // 61° below the horizon to 39.5° across the beat and pointed forward rather than
    // down. What fixed it is the chord, not the pole: the driver solves the elbow on the
    // chord the hand draws, so a hand at the hip is an elbow folded to a hundred degrees
    // with the upper arm lying along that chord whatever the pole asks for. Put under
    // the socket instead, the hand draws a chord the arm can nearly lie along, and the
    // arm reads as hanging from 1.88 s to the landing frame — the hand's own line
    // (``aim``) turned down with it, 0.86 of that line vertical here.
    //
    // The elbow it hangs off is a place on the body — the arm's own length out along the
    // chest's lateral, a hand's width under its centre and a hand's own length in front
    // of it (0.145 of a rig unit, against the 0.005 the hand-over's own elbow stands at)
    // — and it is the chest that carries it, so what moves under the settle is the torso
    // while the arm's own line on it holds still. The forward share is the arm's own
    // room: an elbow left at the body's own side sends the hanging forearm through the
    // jersey, and the arm's own depth in the trunk's volume runs 0.005 of a rig unit at
    // its worst across the descent, against 0.008 before the carry (see the browser
    // suite's arm test, which reads that clearance and the realised step back).
    //
    // ...and the pause is where that ends: the key below is these same numbers again a
    // fifth of a second on, so nothing about the arm moves across the beat — which is
    // what makes the recovery that follows a separate movement rather than the hang
    // easing back out. What the *hold* stands in is the arm the throw has finished
    // with, at his side and limp (see the key below and the recovery's own note).
    //
    // The *glove* arm settles with it, and it is its own motion rather than the
    // throwing arm's mirror. The lead arm comes through the delivery out in front of
    // the chest — it is the shape that took the shoulders round, and it is carrying a
    // twentieth of a rig unit more of its own reach out in front of its socket than
    // the throwing arm at the same frame — and what it stands in by here is the hang
    // on its own side of him:
    // the hand back over the thigh it passes (0.12 of a rig unit in front of the
    // socket against the 0.16 it was carrying through the swing) and the elbow swept
    // back under it, off the line the swing had it out on. A lead arm left exactly
    // where the throw put it is a pose *held* for a second with the ball gone — and
    // what the hold is is a body standing in what it has just done, arms and all.
    //
    // The head is the shoulders' by here: the eyes came off the zone with the ball
    // (see the look's own clock), so what the neck held back through the throw has
    // unwound and the head looks where the body it is falling over looks.
    t: 1.90,
    straight: (179 * Math.PI) / 180,
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.4580,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.5010, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.2766, 0.8200, -1.0950], aim: [-0.019, -0.8600, 0.5099], curl: 0.3,
    elbow: [-0.2538, 1.0300, -1.4800],
    glove: [-0.22, -0.55, -0.265], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.265, -0.225, -0.135],
    glovePalm: [0.20, -0.70, -0.68],
  },
  {
    // The pause, held to the frame: the key above's own numbers again a fifth of a
    // second on. Written so the track *reads flat* between the two — the interpolator's
    // tangents fall to nought where its neighbours are equal, so the arm is still to the
    // thousandth across the beat — which is what the browser suite reads the pause off
    // (see the arm test there), and what the request's own words ask for: the arm hangs
    // still rather than drifting on down the body, and the delivery stands in the pose
    // for a beat before the recovery takes it.
    // Every track is the pause's, body for body: a shorter or a longer hold is this key
    // moved, and nothing else.
    t: 2.10,
    straight: (179 * Math.PI) / 180,
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.4580,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.5010, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.2766, 0.8200, -1.0950], aim: [-0.019, -0.8600, 0.5099], curl: 0.3,
    elbow: [-0.2538, 1.0300, -1.4800],
    glove: [-0.22, -0.55, -0.265], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.265, -0.225, -0.135],
    glovePalm: [0.20, -0.70, -0.68],
  },
  {
    // The recovery: the body is the pause's to the frame — nothing above the legs has
    // moved since the landing, so the tracks read flat across the whole of it (see the
    // pause above) — and what *does* move is the throwing arm letting the throw go. The
    // fold's own swing is spent with the pause, so what is left is the fall to the side:
    // the hand comes down to the thigh (a hand's width out from it, level with the knee),
    // the elbow opens most of the way to the driver's own limit of what a bare arm may
    // straighten to (see ELBOW_BEND_MAX), and the hand's line runs *on down the arm*
    // instead of cocked back off it (the pose asked for 32° of wrist at the landing,
    // which is past the 30 the driver allows, and asks for none of it here). Both of the
    // numbers are written the way every arm place is — in the frame the body stands in —
    // and the body is 104° round by here, so "beside the body" is most of a right angle
    // off the plate's line: the arm hangs down and *behind* the plate's own line, on the
    // side of him the throw came from.
    //
    // ...and it hangs *clear* of the body rather than against it. Measured off the
    // realised skeleton, the arm's nearest approach to the trunk's own girth is 0.059
    // of a rig unit, and the hand's own line stands 0.14 of one out from the body's
    // centre line: an arm left to hang with less than that reads as leaning on the
    // thigh it passes, which is not the throw letting go — it is the arm *collapsing*
    // onto the body once the ball is gone. So the place the hand is written at is a
    // hand's width further out than it hangs by itself — and *sideways* to the line
    // from the socket, which is why the arm reads as straight as it did before it
    // moved (0.581 of its 0.600 span either way, and the elbow's 151°) while the
    // trunk's own clearance goes from 0.043 of a rig unit to 0.059.
    t: 2.80,
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.4580,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.5010, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -1.060, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.303, 0.7, -1.694], aim: [-0.42, -0.88, -0.24], curl: 0.3,
    elbow: [-0.12, 0.88, -1.606],
    glove: [-0.22, -0.55, -0.265], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.265, -0.225, -0.135],
    glovePalm: [0.20, -0.70, -0.68],
  },
  {
    // The way back to the set: the feet come out of the crossed finish they landed in
    // and square up under the body — the pivot foot stepping back toward the rubber
    // and the front one back to the stance's own spread — while the arms come down
    // and out to the fielding posture and the body stands up out of the turn. Written
    // in front of the body's own line for the same reason the finish is: the delivery
    // has not finished driving yet.
    //
    // Nor is the turn finished with the ball: the chest was a good way past the
    // plate's line at the finish, and the recovery brings a third of that back on its
    // way to the set rather than standing up where it was left — which is the whip's
    // own reading, that the shoulders carry on round after the throw and come back
    // round rather than stopping at the throw. It comes *after* the hold, not before
    // it: the feet come out of the finish last, which is the order a pitcher does it
    // in — the throw, the follow-through, and then the walk back to the rubber.
    t: 3.14,
    hipYaw: -0.50, chestYaw: -0.72, lean: 0.16, leanSide: 0.0, hipY: -0.06, drive: 0.34,
    headPitch: 0.06,
    pivot: { x: -0.100, lift: 0.10, z: -0.300, yaw: 0.300, bend: 0.20, hang: 0 },
    front: { x: 0.000, lift: 0.06, z: -0.440, yaw: 0.500, bend: 0.20, hang: 0, cock: 0 },
    glovePalm: [0.87, 0.13, 0.48],
    ball: [0.20, 0.94, -0.56], aim: [0.26, -0.90, -0.34], curl: 0.8,
    elbow: [0.28, 1.08, -0.58],
    glove: [0.150, -0.390, -0.300], gloveAim: [-0.12, -0.40, -0.91], gloveCurl: 1.25,
  },
  {
    // And the set again, so the loop's own wrap is one pose: the delivery ends
    // where the windup begins, hands together and all — side-on, glove shoulder on
    // the zone, throwing hand trailing.
    t: AUTHORED_CLIP_END,
    clasp: true,
    hipYaw: -1.571, chestYaw: -1.571, lean: 0.03, leanSide: 0.0, hipY: -0.04, drive: 0.0,
    headPitch: 0.06,
    pivot: { x: 0.105, lift: 0, z: 0.150, yaw: -1.231, bend: 0.18, hang: 0 },
    front: { x: -0.130, lift: 0, z: -0.130, yaw: 0.02, bend: 0.16, hang: 0, cock: 0 },
    glove: [0.240, -0.300, -0.300], gloveAim: [0.0, -0.22, -0.975], gloveCurl: 1.55,
    glovePalm: [0.12, 0.30, 0.95],
    curl: 1.5,
  },
]

const TIMES = KEYS.map((key) => key.t)
// One key by its own clock. The keys below are added and re-timed as the delivery
// is authored, so the moments that read one (the plant's fold, the drive's own full
// lean) are named by the clock they stand on rather than by an index that would
// move under them.
const KEY_AT = (t) => KEYS[TIMES.indexOf(t)]

// The release key's own hips: where the anchor's shoulder is (see pitcherRelease).
// Read off the keys rather than repeated, so the two cannot drift.
const RELEASE_HIPS = (() => {
  const key = KEYS[TIMES.indexOf(AUTHORED_RELEASE_TIME)]
  return { hipY: key.hipY, drive: key.drive }
})()

// The two feet of the set, as the authored stance stands them: where the drive
// (pivot) foot's ankle and the stride foot's ankle sit in the frame the body stands
// in, both on the ground. Read off the first key rather than repeated, so a
// re-authored stance carries the whole profile with it.
const SET_DRIVE = KEYS[0].pivot
const SET_STRIDE = KEYS[0].front

/**
 * The tallest release the body can hold, in rig units: the height at which the arm's
 * own angle at the release has reached the top of its band (see ARM_ANGLE_BAND) with
 * the shoulder standing at the body's own highest stand (see `releaseStand`). A
 * release point above this one cannot be reached by pointing the arm any higher — and
 * it cannot be reached by a taller body either, because the body's own stature is the
 * *pitcher's*: what it is instead is `pitcherProfile`'s ``heightShortfall``, the
 * metres between the pitch's own slot and the reach the arm has when this ceiling is
 * stood at his own height.
 *
 * It is a closed read rather than the fixed point it used to be, and the two ends meet
 * exactly: the release posture now solves the fold from the slot's own arm angle (see
 * `releasePosture`), so a saturated slot is handed *this* height — the body's highest
 * stand plus the arm at the top of the band — and an arm asked for its own ceiling
 * comes out standing at it (the same read of the same body, see `pitcherProfile`).
 */
export function slotCeiling({ rig, hand = 'R', hipY = 0, drive = 0, tilt = 0, stance = 0 }) {
  const reach = straightChord(rig.arm.upper, rig.arm.fore) + releaseCarry(rig, hand)
  // The shoulder the top of the band stands the socket at — and the body's own highest
  // stand, because the two are not the same point and the *lower* of them is what the
  // arm's top really hangs off: the law's own top is 0.78 of the stature (a real staff's
  // over-the-top arm, read off Savant's own angles) and this model stands its socket at
  // 0.773 of its own, a hand's width under the law's end, which is the short shoulder the
  // model's own proportions carry. A slot past whichever of the two binds comes back at
  // it. It is the same number `pitcherRelease`'s
  // clamp tops out at, which is what makes the ceiling the height a slot past it really
  // comes out standing at.
  const stature = statureOf(rig)
  const top = Math.min(
    releaseShoulderShare(ARM_ANGLE_BAND.high) * stature,
    releaseStand({ rig, hand, hipY, drive, tilt, stance }).socketY,
  )
  return top + reach * Math.sin(ARM_ANGLE_BAND.high)
}

/**
 * The set stance, as the delivery stands it: both feet on the ground — their ankles
 * at the model's own rest height, so the shoes' soles are what the body stands on —
 * the stance's own spread, and the drive foot's place, which is the one the rubber
 * is pinned to (see `pitcherPlacement`).
 *
 * It is the *authored* set — the pose's first key — read rather than re-authored, so
 * what the profile promises about it is what the delivery's own first frame already
 * holds: a pitcher in the set is a pitcher standing on his own feet. What is *not*
 * read off the rig is the size it is stood at: the set's own metres are the
 * pitcher's, and the profile's stride and contact are solved against them (see
 * `pitcherProfile`).
 */
export function pitcherSet({ rig, hand = 'R' }) {
  // The keys are authored for the right hand and the pose mirrors them for a lefty
  // (its drive foot is the throwing hand's own side), so the stance read here is
  // mirrored with them: the placement clamps and reads the mound under the shoe the
  // delivery really stands on. Read the other way — the right-hander's stance handed
  // to every pitch — a lefty's drive shoe is measured where the *front* foot stands:
  // on the default game's own lefty (release 1.2157 m off the plate's line, 0.885 m
  // up) that read the mound 0.21 m away from the shoe that was really on it.
  const s = hand === 'L' ? -1 : 1
  const drive = [s * SET_DRIVE.x, rig.ankleY, SET_DRIVE.z]
  const stride = [s * SET_STRIDE.x, rig.ankleY, SET_STRIDE.z]
  return {
    drive,
    stride,
    spread: Math.hypot(stride[0] - drive[0], stride[2] - drive[2]),
    // What the set's own feet are: a shoe on the dirt (nought lift, and the pose
    // stands it flat rather than on a corner — see ``flat`` in the pose assembly),
    // and a foot the driver's ground rule is told to hold there (``planted``).
    lift: 0,
    flat: 1,
    planted: true,
  }
}

/**
 * The feet of the delivery's own finish, as the hold's keys stand them: the two
 * ankles of the pose the delivery is left standing in, in the frame the body stands
 * in — `pitcherSet`'s counterpart for the other end of the delivery. It is what the
 * component reads the mound's own surface under (see ``settle`` in `pitcherPose`):
 * by the finish the delivery has driven a metre and a half out in front of the
 * rubber, down the mound's own front slope, and the body has to stand on the dirt
 * those feet find rather than on the plateau the stance was solved from. The frame
 * they land in is the pose a caller has to solve that step against, which is
 * AUTHORED_LANDING_TIME beside this.
 */
export function pitcherFinish({ rig, hand = 'R' }) {
  const held = HOLD_KEY ?? KEYS[LANDING_KEY]
  // ...and the same mirror as `pitcherSet`: the keys are the right-hander's, and the
  // pose draws a lefty's feet mirrored, so the step is solved under the feet the
  // delivery really lands (measured: 0.11 of a metre of stance beside the old line).
  const s = hand === 'L' ? -1 : 1
  const foot = (spec) => [s * spec.x, rig.ankleY, spec.z]
  return { drive: foot(held.pivot), stride: foot(held.front) }
}

/**
 * The pitcher's own body and stance for one pitch (see the section header above
 * `straightChord`). One call per pitch — and so one per *pitcher*, since a new
 * pitcher is a new pitch — and what comes back is everything the delivery and the
 * component's placement are read against:
 *
 *   * ``rig`` — the body's proportions clamped to the ranges a real staff spans;
 *   * ``stature`` and ``rigStature`` — the pitcher's own height in metres (the feed's
 *     number, held inside the statures `STATURE_BAND` spans) and the stature the rig's
 *     own joints read (see `statureOf`): the body's proportions are read against the
 *     second and rendered at the first, because scaling a rig uniformly is a body the
 *     same shape at another size;
 *   * ``scale`` — the body's own size, the pitcher's own height standing the rig at
 *     its own stature: one rig unit is worth ``stature`` over ``rigStature``. The pitch
 *     does not size the body — a release point the arm's own angle band cannot lift the
 *     ball to is reported as ``heightShortfall`` rather than answered by growing him;
 *   * ``stride`` — the delivery's own forward movement, as the share of the authored
 *     one this pitch is thrown with. It is the number the pitch's own extension is
 *     spent on — a shorter release is a shorter delivery rather than a body slid
 *     down the mound — and it is the authored stride for every pitch the stance can
 *     cover (see STRIDE_BAND);
 *   * ``rigHeight`` — the release height in the *rig's* own units, which is what the
 *     pose is handed (the body is rendered at ``scale``, so a rig unit is no longer
 *     a metre), held to the arm's own ceiling: what a body of this stature can hold;
 *   * ``contact`` — where along the rubber the drive foot stands so that the
 *     delivery's own travel lands the release on the pitch's own point, and
 *     ``shortfall``, the fraction of a metre that neither the stride nor the shoe's
 *     own reach could cover (nought for every extension a staff pitches with);
 *   * ``release`` and ``armAngle`` — the anchor in the rig frame and the arm's own
 *     angle there, straight to the release point (see `pitcherRelease`);
 *   * ``ceiling`` and ``heightShortfall`` — the tallest release the arm can hold off a
 *     body of this stature, in world metres, and the gap between the pitch's own slot
 *     and the height the anchor actually came out at: nought for every pitch a real
 *     staff throws, because a release point is a fact about a body's own reach.
 *
 * @param {object} params
 * @param {object} params.rig result of measurePlayerRig
 * @param {string} [params.hand='R'] the throwing hand
 * @param {number} [params.height] the pitch's release height in the world, in metres
 *   (defaults to the delivery's own reference slot, which is already a height above
 *   the body's own ground — see ``ground``)
 * @param {number[]} [params.release] the pitch's release point in the world, as
 *   [x, height, z]: the same frame the app draws the trajectory in (z is negative at
 *   the mound). Left out, the profile is the delivery's own body at its own scale.
 * @param {number} [params.pitcherHeight] the pitcher's own height, in metres (the
 *   feed's ``pitcher_height`` inches, see Pitcher.jsx). It is the body's own stature —
 *   held inside `STATURE_BAND` — and the number the whole stance is solved against;
 *   left out, the rig's own stature is used.
 * @param {number} [params.ground=0] the world height of the surface the body stands
 *   on — the mound's own top under the stance (see constants/mound.js). A pitch's
 *   release height is a world fact, so it is measured from the ground the feet are
 *   on rather than from the field: a pitcher up a mound releases lower over his own
 *   feet, and every promise below (the anchor, the stride, the stance) is about the
 *   body's own metres. Nought is the field's own surface, which is what the
 *   delivery is authored against.
 * @param {number} [params.side] where the pitch's own release stands *across* its
 *   own stance, in world metres: the pitch's release x, less the world x the stance's
 *   own line stands on (the rubber's own centre — the profile has no mound of its
 *   own, so the caller reads it off the one the body stands on). It is the lateral
 *   the *arm* is asked to reach for, which is why the profile takes it rather than
 *   the placement: a pitcher's pivot foot stands on the rubber and the ball is
 *   thrown off a hand that comes across to its own line (see `pitcherRelease`). The
 *   body's own answer is reported — the arm takes what its own cone reaches and
 *   ``sideShortfall`` is the rest — and the placement holds the feet's line
 *   regardless (see `pitcherPlacement`).
 */
export function pitcherProfile({
  rig, hand = 'R', height = null, release = null, pitcherHeight = null, ground = 0, side = null,
}) {
  const fitted = clampProportions(rig)
  const body = fitted.rig
  // The body's own size, and it is *his*: the pitcher's listed height where the feed
  // carries one — the same gameData lookup the batter's own height comes from — and the
  // rig's own read where it does not. It is clamped to the statures a staff spans
  // because the number is data: a typo cannot make a person a giant, and the pitch
  // cannot make him anything at all.
  const stature = clamp(pitcherHeight ?? fitted.stature, STATURE_BAND[0], STATURE_BAND[1])
  // One rig unit in world metres, off the body's own height rather than off the pitch.
  const scale = stature / fitted.stature
  // The pitch's own lateral, in the body's frame: the group stands facing home plate
  // — the yaw the placement solves is the half-turn of a body on the mound — so the
  // rig's own +x is the world's −x, and the ask is a negative scale away. It is the
  // same frame the anchor and the pose's own keys carry.
  const ask = side == null ? null : -side / scale
  // The slot the arm is asked to hold, above the body's own ground: the pitch's
  // release height *is* a world one, and the mound the body stands on takes its own
  // share of it (a ten-inch mound is ten inches of the release's own height). The
  // delivery's own reference slot is already a height over the feet, so it is left
  // as it stands rather than being measured down again.
  const slot = height == null ? scale * (body.shoulder.y + 0.28) : height - ground
  // ...and where the release point is, read against the rubber: how far in front of
  // it the ball is thrown from, which is the only part of the pitch's own geometry
  // the delivery's travel has to answer for.
  const needed = release ? release[2] - RUBBER_Z : null
  // The ball's own place in the body's frame, at a slot and a stride: the anchor the
  // pose is handed, and the number every promise below is read off.
  const anchorAt = (h, stride) => pitcherRelease({
    rig: body, hand, height: h, hipY: RELEASE_HIPS.hipY, drive: RELEASE_HIPS.drive * stride, side: ask,
  })
  // How far the body carries the ball toward the plate from the drive foot's own set
  // place — the whole of the pitch's own extension, and what the delivery's stride is
  // spent on (see `pitcherPose`, which draws the same share of the authored stride).
  const travelAt = (h, stride) => SET_DRIVE.z - anchorAt(h, stride).z
  // The body's own stand, and what it can hold at it: the tallest release the arm's own
  // angle band reaches off the shoulder of a body this tall (see slotCeiling). What the
  // slot does *not* do is move the body — that is `stature`'s — so the pose is handed the
  // height the arm can really hold and the metres between it and the pitch's own slot
  // come back as `heightShortfall` instead. (The two agree *exactly* there: the anchor
  // asked for the ceiling comes out standing at it, because the ceiling is the height
  // whose own lean reaches it — see slotCeiling.)
  // The body's own arm at the top of its band, and the tallest stand this delivery has
  // for it: read off the *posture* rather than off a body standing square, because a
  // delivery that leans stands its socket lower than a square one's (the roll carries it
  // down by a cosine and the carry sinks the pelvis by what it takes off the drive leg —
  // see `rollLift`/`stanceDip`), and the arm's top off that socket is that much lower
  // too. The two are read as one answer, and the *lower* of them is what is kept: a lean
  // is what a pitch's own lateral asks the body for, so the honest stand of an arm under
  // a body that may have to lean is the leaning one's. (The other way round the answer
  // turns on itself: the lower socket leaves the arm a wider sweep *across* the body,
  // which can leave the ask to the arm alone, take the lean away and lift the ceiling
  // with it — two answers half a hand's width apart, and which one a pitch got would
  // depend on where the search started.) The stand is monotone down, so three passes
  // find the pair.
  let ceiling = slotCeiling({ rig: body, hand, ...RELEASE_HIPS })
  for (let pass = 0; pass < 3; pass += 1) {
    const lean = anchorAt(Math.min(slot / scale, ceiling), 1)
    const next = slotCeiling({
      rig: body,
      hand,
      hipY: RELEASE_HIPS.hipY - lean.sink,
      drive: RELEASE_HIPS.drive,
      tilt: lean.tilt,
      stance: lean.stance,
    })
    if (next >= ceiling - 1e-12) break
    ceiling = next
  }
  // The delivery's own stand: the pitch's slot where the arm can hold it, and the arm's
  // own ceiling where it cannot — which is the height a slot past the reach comes out
  // standing at, and what ``heightShortfall`` is the gap to.
  const rigHeight = Math.min(slot / scale, ceiling)
  // What the delivery's own stride reaches, in metres: its share of the authored
  // movement, at the size his own stature stands the body at (``scale``).
  const reach = (s2) => scale * travelAt(rigHeight, s2)
  // The stride that lands the ball exactly on the pitch's own point: ``reach`` is
  // monotone in the stride (a longer stride carries the ball further down the pitch's
  // own line), so a half out per pass finds it in thirty. A pitch the band has no
  // stride for comes back at the band's own end, which is where the callers' own
  // clamp puts it and where the shoe below takes over.
  const solveStride = (want) => {
    let low = STRIDE_BAND[0]
    let high = STRIDE_BAND[1]
    for (let pass = 0; pass < 30; pass += 1) {
      const mid = (low + high) / 2
      if (reach(mid) < want) low = mid
      else high = mid
    }
    return clamp((low + high) / 2, STRIDE_BAND[0], STRIDE_BAND[1])
  }
  // The stride is the *authored* one wherever the stance can cover the difference
  // between the pitch's own point and what the delivery reaches: a pitcher sets up
  // along the rubber within the shoe's own leather (see PIVOT_AHEAD and PIVOT_BEHIND)
  // and throws the delivery he throws. It is only a pitch the shoe cannot reach from
  // that moves the stride — the leftover, drawn as a shorter or a longer delivery
  // rather than as a body slid down the mound. The two are spent in that order and
  // the order is the promise: the shoe's own leather first, because a difference a
  // stance can take is a difference no delivery has to; the stride for everything
  // beyond it, because the length of a delivery is the pitch's; and the shoe again
  // for whatever a band-ended stride still leaves, which is what ``shortfall``
  // reports. Which of the two promises gives there is `pitcherPlacement`'s to say:
  // the ball still leaves the hand the pitch is drawn from, and it is the stance that
  // comes off the rubber by that much rather than the pitch that comes off its own
  // point. Nothing a staff pitches with reaches that — the band spans every extension
  // Statcast records, about four and a half feet to eight.
  let stride = 1
  if (needed != null) {
    const slack = needed - reach(1)
    if (slack > PIVOT_AHEAD) {
      // A pitch past what even the longest delivery reaches comes back at the band's
      // own end rather than a whisker short of it (the search is a search; the end of
      // the band is a number).
      stride = reach(STRIDE_BAND[1]) <= needed ? STRIDE_BAND[1] : solveStride(needed)
    } else if (slack < -PIVOT_BEHIND) {
      stride = reach(STRIDE_BAND[0]) >= needed ? STRIDE_BAND[0] : solveStride(needed)
    }
  }
  const anchor = anchorAt(rigHeight, stride)
  const travel = travelAt(rigHeight, stride)
  // What the delivery's own reach leaves of the pitch's own depth: the shoe's leather
  // takes what it covers (see PIVOT_AHEAD), and the stride is the delivery that does the
  // rest of the travelling (see the note above).
  const step = needed == null ? 0 : needed - scale * travel
  const contact = clamp(step, -PIVOT_BEHIND, PIVOT_AHEAD)
  return {
    rig: body,
    hand,
    stature,
    rigStature: fitted.stature,
    proportions: fitted.bands,
    scale,
    height: slot,
    rigHeight,
    release: anchor,
    armAngle: anchor.angle,
    travel,
    stride,
    needed,
    contact,
    shortfall: step - contact,
    // What the arm's own band could not hold, in metres: nought for every slot the
    // body's own stature carries, positive where the pitch is released above the arm's
    // own highest reach at that stature — the ball comes off that reach rather than off
    // a taller body, and the placement's own stand is read against this number (see
    // `pitcherPlacement`) — and negative where the slot is *under* the arm's own lowest
    // reach at that stature, which is the one direction a body cannot fold any further
    // out of.
    // Snapped to nought below a nanometre: the two answers this is the gap between
    // agree exactly at the ceiling (see above), and a subtraction of two answers that
    // agree leaves its own last bit behind — measured at 2e-16 of a metre on the
    // staff's own number 2, which is the arithmetic's own noise and not a gap the
    // body could stand up out of.
    heightShortfall: (() => {
      const gap = slot - scale * anchor.y
      return Math.abs(gap) < 1e-9 ? 0 : gap
    })(),
    // ...and what the arm's own *lateral* reach could not hold, in world metres, in
    // the rig's own x: nought for every release the body's tilt and the arm's cone
    // together cover, positive where the ball comes off its own lateral line on the
    // rig's +x side. It is read against *both* of the pitch's answers — the metres the
    // trunk's roll carried the socket out over the rubber (``tiltX``) and the arm's own
    // share of what was left (see `pitcherRelease`) — and it is the pitch's own residual rather than
    // a fault: a staff's releases are as wide as its bodies and arms are, and the two
    // are spent in that order because a pitcher carries the pitch with his body before
    // his hand. The placement reads the feet's line against the stance rather than
    // against it (see `pitcherPlacement`).
    sideShortfall: ask == null ? 0 : scale * (ask - anchor.stance - anchor.tiltX - anchor.spent),
    // The body's own answer to the pitch's own line, in its two levers: the *angle* the
    // trunk rolled out toward the throwing side and the metres that came out of it (see
    // `pitcherRelease`'s ``tilt``/``tiltX``), then the metres of the *body's* own carry
    // across the stance — the step — that the roll could not reach, and the sink the pair
    // of them costs the legs in height (see `rollLift`/`stanceDip`). The pose draws the
    // angle, the metres and the sink (see its own ``tilt``/``offsetX``/``offsetY``), and
    // the placement reads the shoe's own line off the *feet*, which neither lever moves:
    // the stride goes out with the body and the drive foot keeps the rubber (see
    // `pitcherPlacement`).
    tilt: anchor.tilt,
    tiltX: anchor.tiltX,
    stance: anchor.stance,
    sink: anchor.sink,
    // The lateral the anchor was asked for, in the rig's own x (see ``side``): what
    // the pose is handed to build the same anchor at, so a caller can read the ask
    // and the answer side by side.
    side: ask,
    ceiling: ceiling * scale,
    // The surface the body stands on, in the world: the placement stands the group
    // there, and it is the height the pose's own nought is read against.
    ground,
    set: pitcherSet({ rig: body, hand }),
  }
}

/**
 * Where the body stands for one pitch, in the world: the group's own place and yaw,
 * with the set stance's drive foot on the rubber and the release frame's ball on the
 * pitch's own release point.
 *
 * The body's place is what the two promises share, so they are solved together: the
 * group's own height is the ground's — the surface the profile was handed, which is
 * the mound's own top under the stance (the body stands with its soles on the dirt
 * rather than floating on whatever the arm could reach, and up there with the mound
 * that raised it) — the release point is what the *ball* pins (the pitch's own two
 * axes, its lateral and its depth), and the yaw is the way the body faces home plate
 * from where that leaves it. The drive foot's
 * own z then falls wherever the delivery's own travel puts it — which is the whole
 * point of the profile's stance and scale: for every pitch the shoe's own reach
 * covers, the foot comes out standing *on* the rubber (see ``contact``, and the
 * ``stance`` this reports).
 *
 * @param {object} params
 * @param {object} params.profile result of pitcherProfile
 * @param {number[]} params.release the pitch's own release point in the world
 * @param {number} [params.line=0] the world x the stance's own line stands on: the
 *   rubber's own centre, which is the mound's and the plate's (see
 *   constants/mound.js). The pivot shoe is held inside `PIVOT_SIDE` of it — the
 *   leather it really stands on — because a pitcher's feet do not follow his arm
 *   across the mound (see `pitcherRelease`'s ``side``, which is where the lateral is
 *   spent instead).
 * @returns {{position: number[], yaw: number, scale: number, foot: number[],
 *   ball: number[], stance: number, slide: number, line: number, side: number}} the
 *   group's transform, the two solved places, where the stance's own line was put for
 *   this pitch, and how far the foot came out of it (the yaw's own coupling, nought
 *   for a body square to the pitch, plus whatever of the pitch the shoe's reach could
 *   not take) — then the shoe's own world lateral (``line``, how far across the mound
 *   the stance stood) and the metres the *ball* came off the pitch's own lateral by
 *   for it (``side``, nought wherever the arm's own reach carried the pitch)
 */
export function pitcherPlacement({ profile, release, line = 0 }) {
  const s = profile.scale
  const foot = profile.set.drive
  // The bit of the *shoe* the clamp is read on: the leather stands a shoe's own lead
  // ahead of the ankle, toward the throwing side (see SHOE_LEAD), and it is that bit
  // the rubber is asked about — a foot whose ankle is inside the leather with its toe
  // hanging over the back of the mound is not a foot on the rubber.
  const lead = (profile.hand === 'L' ? -1 : 1) * SHOE_LEAD
  const ball = [profile.release.x, profile.release.y, profile.release.z]
  const stance = RUBBER_Z + profile.contact
  const spin = (v, cos, sin) => [
    v[0] * cos + v[2] * sin,
    v[1],
    -v[0] * sin + v[2] * cos,
  ]
  let position = [release[0], profile.ground, RUBBER_Z]
  let yaw = Math.atan2(position[0], position[2])
  let footAt = foot
  let shoeAt = foot
  let ballAt = ball
  for (let pass = 0; pass < 4; pass += 1) {
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    footAt = spin([foot[0] * s, foot[1] * s, foot[2] * s], cos, sin)
    // The bit of the *shoe* the stance's own line is held by: the ankle carried a
    // shoe's own lead toward the throwing side, in the body's frame (see SHOE_LEAD).
    shoeAt = spin([(foot[0] + lead) * s, foot[1] * s, foot[2] * s], cos, sin)
    ballAt = spin([ball[0] * s, ball[1] * s, ball[2] * s], cos, sin)
    // The ball pins the body and the *shoe* keeps the leather: the pitch's lateral is
    // the body's to reach — the trunk tilts out over the rubber and the arm spends its
    // own cone on what is left (see ``tilt`` in `pitcherRelease`) — and the stance's
    // own line is held inside the leather here, once per pass, because the yaw is read
    // off the place the body really stands at — a stance pushed across the mound faces
    // home plate from somewhere else. What the clamp takes off is what the body alone
    // could not carry, and it comes back as ``side`` rather than as a foot off the
    // rubber.
    const pinned = release[0] - ballAt[0]
    const stray = pinned + shoeAt[0] - line
    const kept = clamp(stray, -PIVOT_SIDE, PIVOT_SIDE)
    position = [pinned + (kept - stray), profile.ground, release[2] - ballAt[2]]
    yaw = Math.atan2(position[0], position[2])
  }
  return {
    position,
    yaw,
    scale: s,
    foot: [position[0] + footAt[0], position[1] + footAt[1], position[2] + footAt[2]],
    shoe: [position[0] + shoeAt[0], position[1] + shoeAt[1], position[2] + shoeAt[2]],
    ball: [position[0] + ballAt[0], position[1] + ballAt[1], position[2] + ballAt[2]],
    stance,
    slide: position[2] + footAt[2] - stance,
    line: position[0] + shoeAt[0],
    side: release[0] - ballAt[0] - position[0],
  }
}

// The plain tracks, and the two the release window is authored for (their keys
// carry their own answer about which frame they are in — see `release` on the
// keys above).
const PLAIN_VECTORS = ['aim', 'glove', 'gloveAim', 'glovePalm']
const PLAIN_NUMBERS = [
  'hipYaw', 'chestYaw', 'lean', 'leanSide', 'hipY', 'drive', 'headPitch', 'curl', 'gloveCurl',
]
const FEET = ['pivot', 'front']
const FOOT_NUMBERS = ['x', 'lift', 'z', 'yaw', 'bend', 'hang']
// The stride leg carries one number the pivot has no use for: ``cock``, the yaw of a
// *lifted* leg's own plane away from the direction the torso faces (see the pose
// assembly). It is only read while the leg is hanging off its knee, so the keys that
// stand on the ground leave it at nought.
const FOOT_PARTS = {
  pivot: FOOT_NUMBERS,
  front: [...FOOT_NUMBERS, 'cock'],
}
// ...and the one number neither of them carries, per foot: whether the pose *stands*
// this shoe flat on the dirt — the ankle's own roll about the line the shoe points
// along, which lays the sole on the ground (see the driver's leg solve). It is
// defaulted rather than authored on every key because it is the same answer wherever
// the foot is planted, and read as a *share* rather than as a flag so a foot can be
// handed the joint over a few frames as the weight comes onto it. It is worth asking
// for at all because the ground rule stands a planted shoe on the ground by its own
// geometry: a shoe left on a corner is a foot carried a hand's width into the air,
// and a leg there is nothing left to spend but its own bend (measured at the finish:
// 29° and 33° of knee on the corners, 7° and 11° with the rolls).
const FOOT_FLAT = KEYS.map((key) => [key.pivot.flat ?? 0, key.front.flat ?? 0])
const FOOT_FLAT_TRACKS = FEET.map((_, index) => FOOT_FLAT.map((shares) => shares[index]))

// The keys whose hands are together — the set and the windup up to the break. The
// ball's own place and the throwing hand's own line are the *glove's* on those keys
// (see claspTracks): a grip is hidden under a glove, so the glove is what is
// authored, and a second set of numbers for the hand would be a second opinion
// about the one place the pose has to get right. A key with neither a ball nor a
// clasp key's glove to take one from would pose the hand at the rig's own origin,
// so it is refused here rather than drawn.
const CLASP_KEYS = KEYS.map((key) => !!key.clasp)
const HAS_CLASP = CLASP_KEYS.some(Boolean)
// ...and the key the hands are let go on: a `part` key is written the way a clasp key
// is — the ball is still in the mitt on that frame, so its place and the throwing
// hand's line are the glove's own (see claspTracks) — but the hands are no longer one
// hand *past* it, so what the pose mixes the two forms by begins its walk to nought
// there (see CLASP_TRACK). It is what lets the swing start at the top of the lift
// rather than three frames into the fall.
const PART_KEYS = KEYS.map((key) => !!key.part)
// The keys `claspTracks` seeds: the hands are together on the clamp's own keys and on
// the frame they let go on, and nowhere else.
const SEED_KEYS = CLASP_KEYS.map((clasp, i) => clasp || PART_KEYS[i])
for (const key of KEYS) {
  if (!key.ball && !key.clasp && !key.part) {
    throw new Error(`pitcherSequence: the key at ${key.t}s carries neither a ball nor a clasp`)
  }
  // The same promise about the *trail* arm: a pole is authored per key, or taken
  // from the lead arm's own glove — which is the clasp's shape on the keys the hands
  // are together on *and* on the frame they let go on, where the two arms are still
  // one shape for the half-frame the mix takes to come apart (see mirrorTracks). A
  // key with neither would pose the throwing arm's elbow at the rig's own origin, so
  // it is refused here.
  if (!key.elbow && !key.clasp && !key.part) {
    throw new Error(`pitcherSequence: the key at ${key.t}s carries neither an elbow nor a clasp to mirror it from`)
  }
}

// The upper arm's own rule: it is never carried above the plane the two shoulder
// sockets draw. The plane is the sockets' own — square to the chest's up axis, tilted
// with whatever fold the trunk is standing in — and the elbow's place is turned about
// the arm's chord until its own rise over that plane is nought, which keeps the elbow
// on the ring its two bones draw (the fold and the stretch are untouched) and only
// decides *which way round* the arm is: the ring's high side gives way to the socket's
// own level. It is the rule a low arm slot is read by — a sidearmer's upper arm sweeps
// under the shoulder line rather than over it — and it binds from the set, through the
// whole of the windup and the cock.
//
// The throw hands it back across the frames from the cock's own key to the
// come-through's, and the reason is the drag rather than the release: over the last
// hundredths of a second before the ball goes the chest turns out from under the arm it
// laid back on (see the trail reading), and an elbow left *behind* a chest folded
// thirty-odd degrees stands above that chest's transverse plane by plain geometry — its
// drag times the fold's own sine, 0.21 × 0.53 = 0.11 of a span on the 3/4 harness pitch —
// without the arm being lifted at all. Held past that the clamp answers by turning the
// elbow round its chord to the *front*, which is the drag the whole throw is read by
// (measured: held on through the come-through's own key the elbow is dragged only 0.03 of
// a span behind the plane there, against the 0.21 it is left with once the fade has run
// out). So it is off from the cock's own key on, where the
// chest is still closed over that arm; from the release on the ball is above the shoulder
// on every slot above a submarine's anyway (the wrist is on the release point, and the
// upper arm is the first half of a straight line to it), so the arm's last frames *are*
// above the plane and cannot be anything else. Measured, the arm never stands above 0.03
// of a span anywhere the cap binds, on either slot.
const SHOULDER_PLANE_IN = 1.00
const SHOULDER_PLANE_FULL = 1.02
// ...and what the rule hands back, and over how long: from the cock's own key rather
// than from the frame before the come-through. Handed over in the last hundredth of a
// second before that key, the rule was still folding the elbow under the plane while
// the authored pole beside it had already turned the arm up and back — so the two
// answers crossed inside one frame, and the upper arm swung 60° and back again on the
// frames either side of 1.28 s. Spread over the 0.04 s between the cock and the
// come-through it is the same hand-over the throw makes: the elbow comes off the plane
// as the chest turns out from under it, and the pole's own turn either side of PS-8 is
// one direction.
const SHOULDER_PLANE_OUT = KEY_AT(1.26).t
const SHOULDER_PLANE_END = KEY_AT(1.30).t

// The two tracks the clasp writes over, seeded from the numbers the keys carry so
// that a key with its own keeps them (a key with neither is caught above).
const _claspBall = KEYS.map((key) => (key.ball ?? [0, 0, 0]).slice())
const _claspAim = KEYS.map((key) => (key.aim ?? [0, 0, 0]).slice())

const NUMBER_TRACKS = PLAIN_NUMBERS.map((name) => ({
  key: name,
  values: KEYS.map((key) => key[name]),
}))

// The look's own clock: how much of the chest's own turn the neck takes back off the
// head's line — one is the eyes pinned on the strike zone's own line, *level*, and
// nought is the head riding the shoulders it sits on.
//
// It is read through a table of its own rather than off the keys, because what it
// names is a moment in the *pitch* rather than a shape of the body. The eyes come onto
// the zone over the windup's own lift (see below) and are on it until the ball is most of
// the way there — the hand-off *begins* with 30% of the flight still to run — and they are
// wholly the shoulders' a third of a second after that; the pose's keys are where the
// body's shapes are, with the landing and the hold already written in between the two. A
// share carried on the keys instead is a hand-off that can only begin on the frame nearest
// to it, which is how the eyes came to leave the zone a frame or two *before* the ball
// arrived.
//
// Coming off the zone *early* is the point of it rather than an approximation: the
// chest is still coming round onto its finish when the head is let go, so the first
// of the unwind rides shoulders that are moving under it and the head is turned by
// the body as well as by its own neck. A hand-off that waits for the ball is a head
// that only ever unwinds off a body already square to the plate — a neck doing all of
// the work, which is not what following the torso is.
//
// The *front* of the clock is the set, and the set is not a look at anything: a pitcher
// stands in the set looking straight ahead down his own line — side-on, with the shoulders
// and the plate at right angles — and the eyes come onto the zone over the windup's lift and
// are on it *before the drive fires* (see LOOK_SETTLE). The tail of the table is nought from
// the hand-off on: the look is the body's for the whole of the finish and the hold, and then
// it comes back on at the far end of the clip, so that the stance the throw is recovered into
// is the stance it was thrown from, head and all (see STANCE_PIN, and the loop test, which
// reads both ends outright).
const LOOK_UNWIND = 0.32
// Where the look is handed over: the ball is 70% of the way to the plate. It is a
// share of the pitch's own flight rather than an offset off the arrival, so a pitch
// that gets there sooner hands its look over sooner too, and it is exported because
// the moment is a promise the suite reads rather than a shape it can derive.
const LOOK_HANDOFF_SHARE = 0.7
export const AUTHORED_HANDOFF_TIME = AUTHORED_RELEASE_TIME + ZONE_FLIGHT * LOOK_HANDOFF_SHARE
// Where the drive begins: the leg's own push toward the plate, read off the keys. The fall
// (1.05) has the weight going forward with the coil still held and the pelvis' own travel
// still *behind* it (a hand's width of it spent); the break (1.12) is the front leg driving
// out with the last of that travel gone. The hip crosses its own nought between the two, on
// the frame the fall's own push has carried it past where it stood in the set, and that is
// the frame the drive starts on. The look is *finished* by then (see LOOK_SETTLE), and the two
// moments are exported together because the promise is the pair of them: the eyes are on the
// zone before the legs take the body anywhere.
export const AUTHORED_DRIVE_TIME = 1.11
// ...and how long the eyes take to come onto the zone: the whole of the turn the head has to
// make, which is a right angle off the stance's own line. 0.31 of a second for 90° is 290 a
// second, against the 3275 the chest's own turn peaks at as the shoulders are handed the last
// of it — and it is the unwind's own 0.32 read the other way round, the look taking as long to
// come on as it takes to come off.
const LOOK_TAKEUP = 0.31
// ...and where it *lands*, which is what the take-up is measured back from: on the zone, and
// finished before the drive leg fires — a look is picked up before the legs take the body
// anywhere, and what stays quiet through the drive is the head, not the body. A settled
// eleventh of a second buys that (1.00 against the drive's 1.11), and it puts the lock on
// the balance point, the key where the coil is deepest and the knee at its highest: the eyes
// are on the target from there through the fall, the drive, the break and the throw.
const LOOK_SETTLE = 0.11
export const AUTHORED_LOOK_LOCK_TIME = AUTHORED_DRIVE_TIME - LOOK_SETTLE
// ...and where the sweep *starts*: the front of the windup holds the stance's line, and the
// head comes off it here (see STANCE_PIN). Exported with the other two, because "the eyes
// hold their own line until X, are on the zone by Y, and Y is before the drive" is the whole
// of the promise and the suite reads all three.
export const AUTHORED_LOOK_SWEEP_TIME = AUTHORED_LOOK_LOCK_TIME - LOOK_TAKEUP
const LOOK_PIN = [
  // The set and the front of the windup: nought, and not the shoulders' — the *stance's*
  // share is one there (see STANCE_PIN), so the line the windup opens on is the one the
  // stance stands in. A look taken up from the top of the windup instead carries the body's
  // own coil in the neck on every frame between, for no gain: the target is a place, and it
  // is not going anywhere while the leg comes up.
  [0, 0],
  [AUTHORED_LOOK_SWEEP_TIME, 0],
  // ...and then the eyes come onto it, over the windup's own lift (see LOOK_TAKEUP), and are
  // there before the drive does anything at all (see LOOK_SETTLE).
  [AUTHORED_LOOK_LOCK_TIME, 1],
  [AUTHORED_HANDOFF_TIME, 1],
  [AUTHORED_HANDOFF_TIME + LOOK_UNWIND, 0],
  [AUTHORED_CLIP_END, 0],
]
const LOOK_TIMES = LOOK_PIN.map(([t]) => t)
const LOOK_TRACK = LOOK_PIN.map(([, value]) => value)

// The stance's own clock, which is the other half of the front of the look: how much of the
// *stance's* line the neck is holding. One is the head standing where the set stands,
// looking down the body's own front; nought is the pin's business, or the shoulders'.
//
// The front of a windup turns the *body* a few degrees off the plate under the head, and what
// the head is asked for there is not that turn. A coil is the body winding under eyes that
// hold the line they stood in; a head carried round with the shoulders has stopped looking at
// anything. So the stance's share is one for the set and the front of the windup, and it falls
// to nought across the lift (``LOOK_PIN``'s sweep): the two are one hand-off, the head going
// off the line it stands in and onto the zone's *before* the drive fires. From the lock on to
// the end of the hold both are nought and the shoulders are what is left — and then it comes
// back on at the far end of the clip, so that the recovery has the head turn back onto the
// line it stands in as the body squares up under it: the stance the clip closes in is the
// stance it opened in, head and all (see the loop test).
const STANCE_PIN = [
  [0, 1],
  [AUTHORED_LOOK_SWEEP_TIME, 1],
  [AUTHORED_LOOK_LOCK_TIME, 0],
  [2.8, 0],
  [3.14, 1],
  [AUTHORED_CLIP_END, 1],
]
const STANCE_TIMES = STANCE_PIN.map(([t]) => t)
const STANCE_TRACK = STANCE_PIN.map(([, value]) => value)

// ...and the line it is a hold *of*: the *heading* the set stands in, read off the first key
// rather than written down, so that a re-authored stance carries the look with it (the
// stance the clip closes in is the same one, key for key — see the loop test).
//
// The heading and not the chest's forward outright: the model stands with its ribcage tipped
// a good ten degrees over its hips at rest, and the *head* is the one part of the body that
// looks at something — a gaze held along the chest's own forward is the eyes on the floor,
// which is the same promise the plate's own solve keeps (it holds the zone's line, *level*,
// and not the trunk's fold). So the line is flattened: the stance's own bearing, on the
// horizon. The two hands get one each, since the delivery is mirrored about the body's own
// midline (see ``normalize``).
function stanceLine(s, out = [0, 0, 0]) {
  const trunk = trunkLean(s * KEYS[0].chestYaw, KEYS[0].lean, s * KEYS[0].leanSide)
  turnVector(upperTurn(s * KEYS[0].chestYaw, -trunk.leanX, -trunk.leanZ), [0, 0, -1], out)
  const flat = Math.hypot(out[0], out[2]) || 1
  out[0] /= flat
  out[1] = 0
  out[2] /= flat
  return out
}
const STANCE_LINE = { 1: stanceLine(1), [-1]: stanceLine(-1) }

// The pin's own limit: how far off the head's own straight-ahead the neck may be asked to
// turn it. A neck turns a long way — the solve below carries the chest's whole *turn and
// fold* back off the eyes, and reads out whatever that leaves — but a head looking over
// its own shoulder is a head turned 170° inside its torso, which is past any neck. Beyond
// that the pin is not a look at anything, so it is not asked for: the head stops tracking
// the zone and rides the shoulders it sits on, which is the shape the look is handed over
// to at nought (see LOOK_PIN).
const LOOK_SEPARATION_MAX = (170 * Math.PI) / 180

/**
 * How much of the pin the neck can take, given the separation the solve asks for: one
 * anywhere up to the limit, and nought past it — the head off the zone and on its own
 * shoulders. A pure function of that one angle, so the boundary is a promise the suite can
 * read rather than a shape it has to walk the whole clip to find.
 */
export function headTrackShare(separation) {
  return separation > LOOK_SEPARATION_MAX ? 0 : 1
}

// Which frames the pitch's own release height has a say in the lean of: the keys
// that carry ``slot`` are the release window's and the follow-through's, and the
// recovery's keys drop it again so the delivery ends in the set it began in.
// Derived from the keys rather than listed, so it cannot drift from them.
const SLOT_TRACK = KEYS.map((key) => key.slot ?? 0)
// ...and the last frame the release's own chord is handed over on: the last key the
// slot track is full on — the follow-through key, after which the recovery eases the
// arm back to the driver's own bow. Read off the keys rather than listed, so the
// browser suite's lock bound and the window the pose really throws on cannot drift
// apart (see the arm output's own note on RELEASE_ELBOW).
export const AUTHORED_SLOT_END = KEYS[SLOT_TRACK.lastIndexOf(1)].t

// ...and the frames the *trunk's* own fall is handed over on, which is a longer window
// than the arm's: the slot track's ramp spans the three frames between the plant and the
// high cock, and a trunk coming out of an arch takes the whole of the whip to come over
// the foot it is thrown from — the arch is a *place* the delivery stands in for the
// length of the back leg's fire (see the plant key's own lean), not a curl spent on the
// way to the cock (see its note). Written as a share of the posture's own fold like the
// walk, so a submarine's arch and an over-the-top arm's are the same shape on different
// bodies (see LEAN_IN_TRACK).
//
// It is the share the fold is read through where the two overlap — the slower of the two
// — and the slot track is what it is everywhere else: before the plant this one is
// nought, and from the come-through on it is whole, so what the *recovery* reads is
// still the slot's own ease-out.
// ...and the arch is *held* to the top of the cock, which is where the reference's own
// back bows over the rubber (PS-8) rather than where it comes undone: the fold waits
// until the arm has finished loading and only then comes over the front foot, so the
// pocket the forearm is laid back into is a *back-arched* one for the whole of the cock.
// The window below therefore starts past the plant and ends on the release itself, and
// what the whip spends is the whole of the arch's depth in the last tenth of a second
// before the ball — the fold that launches the trunk over the plant, rather than one
// spread across a cock that is then thrown off a body already half-way over.
const FOLD_ARRIVE = [[KEY_AT(1.20).t + 0.04, 0], [KEY_AT(1.30).t, 1]]
const FOLD_ARRIVE_TIMES = FOLD_ARRIVE.map(([t]) => t)
const FOLD_ARRIVE_TRACK = FOLD_ARRIVE.map(([, v]) => v)

// ...and the *finish's* own share of the fold, which is the extra the delivery carries
// after the ball has gone: the trunk does not stop at the posture it threw from, it goes
// on over the front foot and folds the body up behind the arm, which is what a pitch is
// read as — the whole body launched, and the throw the last thing in it rather than a
// thing the body stops at. It is added as a share of a track rather than as keyed angles:
// nought through the ball, so the release itself is the pitch's own posture, and back to
// nought by the landing, so the stance the clip ends in is the stance it began in (see the
// loop's own reading).
//
// Written as one number for every slot for the same reason the walk is: a submarine's
// finish is already folded most of a right angle at the release (49.5° on the submarine
// harness slot) and a three-quarter slot's is 32°, so the same 0.36 of a radian — 20.6° —
// is two fifths of the one and two thirds of the other.
//
// It is *carried* off the ball rather than eased in from it, and that is the difference
// between momentum and a body that stops and leans a second time. Written as the keyed
// ramp this was first (0, then 0.30 at 1.345, ...), the trunk stood dead still for five
// frames on the frames the ball went — measured on the realised skeleton, 32.04° at
// 1.3017, 1.3058, 1.3100, 1.3142 and 1.3183 s, then 111°/s — because a pin's first key
// leaves at rest unless a key before it says otherwise, and there is no key before the
// release that may say so (the fold's own *value* is the pitch's posture on the ball, and
// the frames in front of it are the gather's, see FINISH_RIP_LEAD). So the carry is
// written as a decay rather than as a ramp: it leaves the release at the rate the fall
// arrived with and its own rate falls continuously to nought.
//
// The shape it is spent in is the finish's own, and it is one shape for both clocks (see
// below): the carry leaves the release at 462°/s — the 350 the power it used to be left at,
// through a sharper shape — is within a tenth of it on the 1.40 frame (98°/s against 106) and
// is one and a third times faster by 1.48 (8.6 against 3.7). So what the trunk does with the
// 20.6° is come over it where the whip is and keep the last of it for the frames the front
// foot is still reaching for, rather than standing still for five frames and then finding
// 0.26 rad somewhere to put.
//
// This is the bump the *keys* were authored against — the arm's places through the fold
// were measured on a body carrying it (see HOLD_FOLD, which is the fold the finish is now
// stood in and is the only part of it the arm's places are turned by).
const FINISH_TILT = 0.36
// ...the halfway of the follow-through proper: the ball has gone at the release and the
// body lands on the finished stance at 1.68, so halfway is the average of the two.
const FINISH_CARRY_END = (AUTHORED_RELEASE_TIME + KEY_AT(1.68).t) / 2

// ...and the *shape* the two of them spend their distances in — the carry above and the
// rip below — which is one shape for both: a rate that is at its highest on the frame the
// ball leaves, a carry under it through the middle of the follow-through, and the brake in
// the last of it. Both halves of what the finish is asked for are answered here and neither
// of them for free, because the distance is the same 44.7° of fold either way (see
// FINISH_FOLD): the *max speed at the release* is what the frame the ball goes is handed,
// and the *deceleration moved later* is how much of that distance is still being spent a
// fifth of a second after it. Measured on the pose, against the cubic this replaces: 984°/s
// on the release's own frame against 834, 1160 on the finest frame after the ball (1.3225 s)
// against 913, the rate 93°/s against 92 by 1.43 — the one frame the two agree on — then 63
// at 1.45 against 58, 32 at 1.48 against 25 and 17 at 1.50 against 11, with nought
// reached on the crossing rather than a fifth of a second early. What it *costs* is the
// middle of the sweep, and that is measured too: the fold is 194°/s there at 1.39 against
// 222, and 161 at 1.40 against 179, while its *value* never leaves the cubic's by more than
// two fifths of a degree before 1.39 (52.7° against 53.1° at 1.40) — the same fold on the
// same clock, spent the other way round.
//
// Written as the sum of two powers of the fraction of the own clock that is left — the
// snap's fast decay and the carry's slower one under it, `A·(1 - u)^p + w·(1 - u)^q` with `A`
// read off the normalisation `A/(p + 1) + w/(q + 1) = 1` — rather than as a spline, because
// the share's own integral is then closed form and the two ends of a hand-off can be matched
// to the radian (`holdShareAt`'s gather hands this rate over on the release's own frame, and
// `finishTiltAt` opens on it). The *weight* `w` is the whole of the choice: at nought every
// share is the snap's and the release is left at eleven shares a second with the distance
// spent by the third frame, and at `q + 1` every share is the carry's and the release is left
// at 2.4 of the sweep's mean — a trunk that eases over rather than one that is thrown. 2.05
// is where the two asks are held together, and the exponents are what make each of them a
// movement of its own: ten for the snap makes it a frame rather than a slope on the release's
// own two (which is what the suite's "the fold's fastest frame after the ball is the first
// one" reads), and one and a half for the carry leaves 42 per cent of the peak on the halfway
// frame. A single power cannot do both — a `(1 - u)^p` that leaves the release faster than
// the cubic's also brakes earlier, because the distance is spent over the same span either
// way and the two asks pull at the same area.
const FINISH_SNAP_POWER = 10
const FINISH_SPEND_CARRY = 1.5
const FINISH_SPEND_WEIGHT = 2.05

/**
 * The finish's own rate at a frame, as a share of the distance a *second*... read on the
 * fraction of its own clock the frame stands at: nought at the release and one at the top.
 *
 * Normalised so that its integral over the sweep is one, which is what makes the two ends
 * of the two clocks meet: the rate the rip leaves the release at is this value over the
 * rip's own span, and it is that number the gather's Hermite is handed (see `holdShareAt`).
 *
 * @param {number} u the share of the clock spent, nought to one
 * @returns {number} the rate, in shares of the distance a second of the sweep
 */
function finishSpendRate(u) {
  const snap = (FINISH_SNAP_POWER + 1) * (1 - FINISH_SPEND_WEIGHT / (FINISH_SPEND_CARRY + 1))
  return snap * (1 - u) ** FINISH_SNAP_POWER
    + FINISH_SPEND_WEIGHT * (1 - u) ** FINISH_SPEND_CARRY
}

/**
 * The share of the finish's own distance a frame has spent: the rate above, integrated —
 * nought at the release, one at the top, and monotone between them.
 *
 * @param {number} u the share of the clock spent, nought to one
 * @returns {number} the share of the distance, nought to one
 */
function finishSpent(u) {
  const snap = (FINISH_SNAP_POWER + 1) * (1 - FINISH_SPEND_WEIGHT / (FINISH_SPEND_CARRY + 1))
  return 1
    - (snap * (1 - u) ** (FINISH_SNAP_POWER + 1)) / (FINISH_SNAP_POWER + 1)
    - (FINISH_SPEND_WEIGHT * (1 - u) ** (FINISH_SPEND_CARRY + 1)) / (FINISH_SPEND_CARRY + 1)
}

/**
 * The finish's own share of the fold at a frame: nought through the ball, one at half-way
 * through the follow-through, and back to nought by the frame the body lands on its stance
 * (see FINISH_TILT for the decay and why it is not a keyed ramp).
 *
 * @param {number} t the authored clock
 * @returns {number} the share, nought to one
 */
function finishTiltAt(t) {
  if (t <= AUTHORED_RELEASE_TIME) return 0
  if (t <= FINISH_CARRY_END) {
    return finishSpent((t - AUTHORED_RELEASE_TIME) / (FINISH_CARRY_END - AUTHORED_RELEASE_TIME))
  }
  const landed = KEY_AT(1.68).t
  if (t >= landed) return 0
  // ...and the recovery puts it back, off the top's own stillness: the carry arrives at
  // nought rate and the body comes up out of the fold with the same ease at either end.
  const u = (t - FINISH_CARRY_END) / (landed - FINISH_CARRY_END)
  return 1 - u * u * (3 - 2 * u)
}

// ...and the fold the *finish* is stood in, which is the whole of what the trunk does with
// the follow-through: the keys' own lean has spent itself by 1.68 (0.05 rad, the finish's
// stand) and the bump above is spent by then too, so a delivery that stops there is a body
// that has given the fold back on the frames it lands on — 23.5° over its hips at the
// plant, against the 39° its deepest frame had a fifth of a second before. What the request
// asks for is the fold thrown rather than reached: the trunk comes over the front foot with
// the whip, is deepest on the frame the back foot sweeps across the line toward the plate on,
// and is standing back up out of it from that frame on — the body's own momentum spent, and
// spent while the foot it was thrown off is still coming round.
//
// So the pose's fold is *lerped* from the keys' own path to this one: nought of it at the
// release (the frame is the pitch's own posture, to the radian), the whole of it on the
// crossing, and out again from there over the rest of the beat and the recovery — which is
// where FINISH_STAND_FROM and FINISH_STAND put the stand. A lerp rather than a sum
// because the sum is what a plain additive share is, and a sum over a decay sagged the trunk
// back upright before the shoe landed (measured: 58° at 1.48, 39° at the landing, 20° at the
// hold — a fold, a partial unfold and a second fold); the lerp has one deep end whatever the
// keys do underneath it.
//
// 1.05 of a radian is 60.2° over the hips at the plate — twenty-one degrees past the deepest
// frame the delivery used to reach, and two and a half times what it arrived at — and it is
// one number for every slot, like the walk: every pitcher's finish is the same fold because
// it is the same movement, and what the slot changes is where he threw *from* rather than
// where he ends.
//
// A fold this deep is a fold the legs have to be able to stand in. The pelvis is the whole
// block the driver leans, so the rotation that carries the chest over the front foot carries
// the two hip sockets with it — one up and one down, by the sine of the fold through the
// sockets' own half-width — and the socket that *rises* is the stride side's, the leg that is
// already standing at the length of its own shin and thigh with the shoe rolled onto its toe.
// At 0.85 rad it lifted the front socket 0.082 of a rig unit and the front leg read 0.923 at
// the landing against a 0.9205 budget (its own 0.8506 plus the 0.0699 the roll is worth); a
// fifth of a radian more asks it for another 0.014 it does not have. So the fold is paid for
// the way a body pays for one: the *hips sink* as the trunk comes over (FINISH_SINK), which
// is the knee giving under the weight of the trunk — the trade a squat makes — and it lands
// the front socket back where the stance had it. Measured on the pose at the landing, the
// front leg reads 0.893 and the drive leg 0.749, both inside the same budget and neither of
// them standing on its toe at rest.
const FINISH_FOLD = 1.05
// ...and the hip the fold is paid out of, in rig units, on the frame the fold is whole:
// nought anywhere the fold is nought, and eased with the fold's own schedule so the knee
// gives as the trunk comes over it rather than a step arriving with the foot.
const FINISH_SINK = 0.032
// ...and how long before the ball goes the fold's own clock is already *running*, in
// seconds: the hand-off is a hand-off rather than a starting gun, so the trunk is moving on
// the frames the release is read on instead of standing still on them and setting off when
// the ball has gone.
//
// It is spent as a *gather* and not as an early rip, and that is the whole of why it is
// shaped the way it is: the release's own frame has to carry the pitch's posture — the arm's
// window places are authored round the release point, and the socket they hang from is a
// function of the fold (a few tenths of a degree of fold is a millimetre of socket at the
// socket's own radius, and a millimetre of chord is degrees of elbow here, see
// RELEASE_ELBOW) — so a trunk already folded *past* the posture when the ball goes is a ball
// thrown off an arm the release's own chord no longer fits. What the lead is, then, is the
// trunk easing the last degree or two *off* the posture it is held at and gathering, so that
// the rip's own rate is the rate it crosses the release point at rather than the rate it
// sets off from: the share below leaves the release with the same rate the rip is thrown at
// (see the shape's own note) and arrives at nought-fold exactly on the ball's own frame, so
// the fold's value there is the posture's to the decimal while its *rate* is the whip's.
// Measured on the pose, the fold's rate across 1.30-1.32 s runs nought, then -310°/s at
// 1.3075 as the gather opens, back through nought at 1.314, and 922°/s on the release's own
// frame — the rip's own rate with the gather's return on top of it — where before this the
// same two hundredths of a second read nought on every frame of them. The gather is deeper
// than it was for the same reason the rip is faster: its depth is *set* by the rate it hands
// over rather than chosen, so this one dips 2.4° under the posture where the 701°/s cubic's
// dipped 1.8.
const FINISH_RIP_LEAD = 0.02

// ---------------------------------------------------------------------------
// ...and the turn's own clock, which is the same lead spent the other way round: the
// chest's *turn* is the one clock of the whip the keys cannot hand over on the ball.
//
// A monotone curve through keys has no crest *on* a key anywhere: its rate is a quadratic
// on each span, and where that quadratic tops out is set by the two spans' own mean slopes
// rather than by anything the keys can say — with the come-through at 1.30 and the release
// at 1.32 the crest came out at 1.310, a hundredth before the ball, with the turn already
// braking *into* the release and a second crest behind it as the next span's mean took
// over. Measured on the pose — the keys' own track, the clock taken off — the chest's own
// rate ran 990 on the come-through's own window, **1187 at 1.310** and 1174 at 1.315 — a
// monotone curve's crest sits *inside* a span — then **863 on the ball**, 910 and 706
// behind it, so the turn braked into the release and set off again behind it. Every re-fit
// of the two keys moves that crest
// around (and a scan of them all puts it anywhere but on the ball), which is what the
// clock below is for.
//
// What a throw does with the last of its turn is the opposite of that shape: the chest is
// *thrown* through the ball, and the ball is the fastest frame of it. So the turn is given
// the fold's own treatment (see FINISH_RIP_LEAD and `holdShareAt`, its mirror on this
// side): the last two hundredths gather the chest a degree or two *back* off the keys'
// track — the coil carried closed while the pelvis runs on under it, which is the dip the
// delivery's own note reads the smaller ramp by — and hand it over on the release's own
// frame at `TURN_SNAP`. A Hermite on the lead's own span, so the two clocks meet in value
// (both nought, which is what keeps the release frame's own chest to the keys' decimal —
// the torso squared to the plate, and with it every place the window's arm was authored in
// the chest's frame, moves by nothing at all) and hand over with no step on either side of
// the ball.
//
// The snap is a rate and not a distance, like the rip's: what the gather spends is set by
// the rate it hands over rather than chosen — four twenty-sevenths of the lead at that
// rate, three degrees for the thousand below — and the delivered rate on the ball is the
// keys' own crossing rate *plus* this one. 1012°/s is most of twice what the keys crossed
// at on their own (608): the turn is handed the ball at 1619°/s instantaneous, of which
// the pose's own five-millisecond window reads 1432 on the ball's frame, and every frame
// behind it is slower than it — 910 on the frame after the ball (where the keys' own window
// crosses at 863), 706 the next, 447 by 1.345 where the finish's own key takes the turn up
// again — which is the brake the request is about: *behind* the ball, not in front of it.
const TURN_GATHER_LEAD = 0.02
// ...the rate the gathered turn is handed over at, in degrees a second (the depth below is
// derived from it, so this is the number to move).
const TURN_SNAP = 1012

/**
 * How much of the turn the chest is carrying off the keys' own track at a frame: nought
 * until the lead opens, deepest two thirds of the way through it — where the keys' own span
 * is at its own crest, so the two shapes cancel rather than add — and handed back to nought
 * *at the snap's own rate* on the release's own frame.
 *
 * @param {number} t the authored clock
 * @returns {number} the share, in radians: negative (the coil carried closed) through the
 *   lead and nought on the frame the ball goes
 */
function turnGathered(t) {
  if (t <= AUTHORED_RELEASE_TIME - TURN_GATHER_LEAD) return 0
  if (t >= AUTHORED_RELEASE_TIME) return 0
  const v = (t - (AUTHORED_RELEASE_TIME - TURN_GATHER_LEAD)) / TURN_GATHER_LEAD
  return ((TURN_SNAP * Math.PI) / 180) * TURN_GATHER_LEAD * v * v * (v - 1)
}

/**
 * How much of the finish's fold the pose is carrying at a frame: nought on the ball's own
 * frame (the release is the posture's, and the frame either side of it is the gather above),
 * the whole of it on the frame the back foot sweeps across the line toward the plate on, and
 * back to nought by the frame the stand has him up (see FINISH_STAND_FROM and FINISH_STAND).
 *
 * The schedule is the fold's own clock, and the hips' sink is read off it as well as the fold
 * is, so the two move as one movement: the trunk comes over and the hips give under it. The
 * *arm* is read off the fold's depth instead (see FINISH_RIDE): it rides the trunk through
 * the stand and is handed back on the keys' own clock, because what it is held against is the
 * folded chest the keys drew the places for rather than the pace the fold comes off at — and
 * it rides the *gather* the same way, which is what keeps the window's places on the chord
 * they were authored at (see the note below).
 *
 * @param {number} t the authored clock
 * @returns {number} the share, a degree or two negative just before the release and nought to
 *   one after it
 */
function holdShareAt(t) {
  if (t <= AUTHORED_RELEASE_TIME - FINISH_RIP_LEAD) return 0
  if (t < AUTHORED_RELEASE_TIME) {
    // The gather: the share comes back off nought, eases out to its own depth two thirds of
    // the way through the lead, and is handed back to nought *at the rip's own rate* on the
    // release's frame — a Hermite on the lead's own span, so the two clocks meet in value and
    // in slope and the fold has no step and no rate on the frame the ball goes.
    // Its depth is set by the rate rather than chosen: the steeper the rip, the deeper the
    // gather that hands it over (see the note above, and `FINISH_FOLD` for the distance the
    // share is spent over).
    const v = (t - (AUTHORED_RELEASE_TIME - FINISH_RIP_LEAD)) / FINISH_RIP_LEAD
    const slope = finishSpendRate(0) / (FINISH_STAND_FROM - AUTHORED_RELEASE_TIME)
    return slope * FINISH_RIP_LEAD * v * v * (v - 1)
  }
  if (t === AUTHORED_RELEASE_TIME) return 0
  if (t <= FINISH_STAND_FROM) {
    // Front-loaded out of the release and carried behind it (see the shape's own note): the
    // fold is *thrown* through the release point — the fastest frame after the ball is the
    // first one — and what is behind that is the second half of the request, a movement that
    // is still spending itself on the frames the stand is waiting for. A smoothstep instead
    // is at rest on both ends, which is the shape of a movement that starts after the pitch
    // has gone: measured on the pose, the fold's rate fell from 626°/s at 1.278 to 44 at 1.303
    // and nought on the release's own two frames, then picked back up at 356°/s — so the
    // trunk *stopped* at the release and started a second movement after it, which is the one
    // thing a throw does not do. What the fold is by the crossing is the same FINISH_FOLD
    // either way; only the order the distance is spent in has changed.
    return finishSpent((t - AUTHORED_RELEASE_TIME) / (FINISH_STAND_FROM - AUTHORED_RELEASE_TIME))
  }
  if (t >= FINISH_STAND) return 0
  // ...and it is stood out of from that frame on rather than *held* there: the frame the fold
  // tops out on is the last frame of the fold, and the stand leaves it at the fastest rate the
  // stand has. A squared fall rather than a smoothstep, because a smoothstep leaves the top at
  // nought rate — which is the trunk standing in its deepest fold for a fifth of a second while
  // the shoe comes round: measured on the pose, 59.9° at 1.60 s against the crossing's 60.2°,
  // so it had not begun to come up at all by the frame after the top, and what it did come up
  // at afterwards was half the stand's own mean rate. Squared, the top is a corner in *rate*
  // and nothing else — the stand leaves at two and a half times the rate it did (see
  // STAND_PACE), under two degrees of fold on the very next frame at 120 fps — and the rate
  // falls to nought at the far end, so the keys' own standing body takes the trunk back with
  // no step and no rate on the frame it does.
  //
  // Measured, the trunk is 60.2° on the crossing (1.54), 33.7° at the landing, 8.5° at
  // 1.90 s, and the keys' own 2.9° at the pause by the time the stand is over at 2.06. At
  // the keys' own pace the same schedule read 48.7°, 32.1° and 20.5° — the stand is the same
  // movement spent in two fifths of the time, so every frame of it carries the fold out at
  // two and a half times the rate.
  const u = (t - FINISH_STAND_FROM) / (FINISH_STAND - FINISH_STAND_FROM)
  return (1 - u) * (1 - u)
}

/**
 * How far the fold is *held* past what the keys' own path has it at a frame: the share above
 * times the distance from the keyed path to FINISH_FOLD, in radians.
 *
 * It is also the number the *arm's* places are turned by, which is why it is this distance
 * rather than the fold outright: the keys' places were written on a body carrying the bump
 * above, so the part of the fold they do not know about is exactly this.
 *
 * @param {number} keyed the fold this frame's own keys, the window and the bump ask for
 * @param {number} t the authored clock
 * @returns {number} the fold to add to it, in radians
 */
function holdFoldAt(keyed, t) {
  return (FINISH_FOLD - keyed) * holdShareAt(t)
}

// ...and the frame the fold tops out on — the frame the stand *starts* from. It is the frame
// the back (drive) foot sweeps across the body's line toward the plate on: read off the keys
// as the pivot foot's own place furthest toward the zone through the follow-through (the
// arc's key at 1.54, written as "the pivot foot crossing in front of the front one on its way
// to landing"). The trunk is thrown over the hips *onto* that frame and turns over out of it
// while the shoe is still out on its arc, which is the order a delivery does it in: the whip
// spends the fold and the stand is what the whip leaves, so the two are one movement with its
// top on the crossing rather than a fold held and a stand bolted on after the beat. Read off
// the keys rather than listed, so a re-drawn arc carries the fold's own top with it.
const FINISH_STAND_FROM = (() => {
  const landing = KEY_AT(1.68).t
  let frame = KEY_AT(1.54).t
  let reach = Infinity
  for (const key of KEYS) {
    if (key.t <= AUTHORED_RELEASE_TIME || key.t > landing) continue
    if (!key.pivot || key.pivot.z >= reach) continue
    reach = key.pivot.z
    frame = key.t
  }
  return frame
})()

// ...and the frame it is stood back up by: the recovery's own key — where the keys' body is
// the standing one again and the walk back to the rubber begins — *paced* onto this
// delivery's own clock. The stand is the delivery's longest movement (the whole beat and the
// recovery together), and its pace is a choice rather than a key: STAND_PACE of 2.4 brings
// the trunk out of the fold two and a half times as fast as the keys' own tail would, which
// is what a stand that begins on the crossing has to be — at the keys' pace it was still
// carrying 20.5° of fold at the pause, a third of the way into the beat, and did not reach
// the standing body until the walk back. Paced, it is the keys' own 2.9° at the pause and the
// keys' body from 2.06 s on. The 20 per cent over the old two is read through the finish's
// whole shape: the crossing's top is spent a little sooner, so the landing frame stands in
// 33.7° of fold where it stood in 38.7°, and the arm the finish carries is that much nearer
// the standing body's by the pause (see the pose's own readings).
//
// The fold and the hips' sink it is paid out of are read on this one clock, so the pace is one
// number for the two of them and the knee gives as the trunk comes over at whatever pace the
// trunk takes. The *arms* keep the keys' own windows (see FINISH_RIDE). Read off the keys
// rather than listed, so a clip with a longer beat still stands up over a longer tail rather
// than into its hold.
const STAND_PACE = 2.4
const FINISH_STAND = FINISH_STAND_FROM + (KEY_AT(2.80).t - FINISH_STAND_FROM) / STAND_PACE

// ...and the frame the *arms'* own clocks end on: the keys' standing key, where the recovery's
// places are the standing body's and the walk back begins. The two arm clocks — the throwing
// arm's ride and the glove's swing — are owed against how *deep* the fold is rather than how
// fast it comes off, so they keep the keys' own window while the trunk's schedule is paced:
// the ride is a turn of the arm by the stand since the crossing, and what it holds the arm
// against is the distance the keys' places are from the folded chest. Handed back on the
// stand's own paced clock instead (measured) the arm comes up out of the hold and crosses the
// trunk while it is still settling — the driver's clearance rule folds the arm for three
// frames at 2.15 s (a 20 mm shortfall and a 7° fold), which is a twitch on the very arm the
// eye is on. On the keys' clock it unwinds over the recovery, as it did before the stand was
// paced, and the arm's own shape is the delivery's while the trunk it hangs from is not.
const FINISH_RIDE = KEY_AT(2.80).t


// The frames the delivery holds the *throw's own line* on, and the frame it stops
// holding it at: the ball goes at the release frame, and the arm goes on being the
// throw's own line through the whole of the fold — to its *last* key, the one the
// upper arm is *held* across the body on and the forearm swings on about the elbow
// from (see the fold's keys). Read off the keys rather than listed, like the window's
// own end above, so the two cannot drift apart.
//
// The fold's keys are on that line too, and this is what the sweep is for there: what
// their *places* author is the direction the throw already had, and the *reach* the arm
// answers them with is the fold's own schedule (see STRAIGHT_TRACK) — so the place's
// own distance from the socket is not part of the delivery's shape at all, and reading
// it puts the between-keys part of the track into the bend. Read on the realised
// skeleton with the fold's keys out of the sweep, the elbow steps 5 to 8 degrees on the
// frames either side of a key and 2 on the keys themselves (1/240 s through the
// crossing, 1.6492 to 1.6750, against the 0.7 the same frames read on the fall above):
// a place's components are interpolated one at a time, so the track between two keys
// crosses the turn's own chord, and the chord stands a millimetre or two inside the arc
// the wrist travels — which a folded arm reads as the elbow's own step, and a *line*,
// named to the driver, reads as nothing at all.
//
// On these frames the arm's place is a *line* rather than a place: the pose writes it
// from the socket it estimates, and the body's own socket stands five to a dozen
// centimetres from that estimate on the frames right after a throw — a gap a folded
// arm forgives and a straight one cannot. So the frames are named to the driver (see
// the arm output's ``sweep``), which puts the wrist out on that line at the arm's own
// length instead of folding to hold a place a few centimetres inside it: measured on
// the realised skeleton with the places alone, a frame meaning a 168° arm came back
// 118° at 1.37 s — the elbow folding on the very frames the throw is thrown on.
const SWEEP_IN_TIME = AUTHORED_RELEASE_TIME
// The throw window's own sweep, eased in across the break (the clasp's own last key,
// 1.05, and the first key of the arm free of the mitt, 1.12 — the same span the
// hands part over): from the raise's first frame the arm is held to its own shape
// (see the sweep note in the pose assembly), and the clasp before it keeps the
// glove's own mirror and its fold untouched.
const SWEEP_WINDOW_IN = 1.05
const SWEEP_WINDOW_END = 1.12
// ...and the fold's own end: the last key that names a bend of its own (see
// STRAIGHT_TRACK), which is where the arm stops being written on the throw's line and
// the places below take the reach over again. Read off the keys, like the two ends
// above, so the window and the fold cannot drift apart.
const AUTHORED_FOLD_END = KEYS[
  KEYS.findLastIndex((key) => (key.straight ?? Math.PI) < Math.PI * 0.99)
].t
const SWEEP_OUT_TIME = AUTHORED_FOLD_END
// ...and the couple of frames it takes to hand the line over at each end: the release
// frame keeps the anchor's own place bit-exact (it is the frame the body is *placed*
// by, see pitcherPlacement), and the fold's own first frame is answered by the bend
// its key authors rather than by the sweep (see STRAIGHT_TRACK).
const SWEEP_IN_HANDOVER = 0.02
// The hand-over into the fold is the long one, and it is the *ask's* own length rather
// than the driver's: from the crossing on, the pose's own places start folding the wrist
// in — read on the realised skeleton with the sweep taken out of the answer, its ask
// runs 0.93 of the chord at 1.5383, 0.89 by 1.5467 and 0.73 by 1.5717 — and the line
// has to be handed over across those same frames. Held for a couple of frames and then
// dropped, the fold arrives as one frame's work: an arm still 174.9° at 1.53 s and
// 143.3° by 1.5467, an elbow travelling a third of a right angle in a single frame,
// which is the snap this length is bought against. Faded across the frames the ask
// itself folds on, the same elbow walks 175° to 152° to 144° to 131° to 113° to 99°
// across the twentieth of a second the fall takes and lands on the fold's own 90°.
// The *elbow* the hand-over is read off — the unit suite's held place, and this file's
// own keys — is a direction off the socket rather than a place on the arm, so the length
// above is the driver's alone: what the pose promises is where the upper arm *points*
// from the crossing on, and it points there whatever the fingers of the fold are.
const SWEEP_OUT_HANDOVER = 0.06
// ...and the couple of frames the elbow's *pole* takes to hand the ring over to the place
// the keys hold (see the pose's own note). Two hundredths of a second is a third of a
// frame of the depth of the step it is bought against — the fold's last key is 17 mm from
// the place the ring composes on a body carrying the finish's own fold — and it is read at
// 240 Hz, where the same 17 mm spent on one frame is a visible step in a hold that is
// otherwise dead still.
const SWEEP_POLE_HANDOVER = 0.02

// How far into the jersey the release's own arm may sit, in a rig unit, and the frames
// either side of it the allowance is spent over.
//
// The release point is the pitch's, not the body's: the ball's flight is drawn from it,
// and a hand a centimetre off it is a pitch a centimetre off. A cross-body delivery is
// exactly the delivery whose arm has nowhere to go but past the chest — a left-hander's
// release on a right-hander's line of the mound crosses 0.53 of a rig unit to get there,
// and a straight arm that far across has its chord through the trunk however the elbow
// is held. The driver's own rules answer that by folding the reach (a real arm folds) and
// by pushing a hand asked inside the body back out of it, and what the fold costs is the
// release point itself: measured on the harness's pitch, a lefty's ball 4 cm short of
// the point the pitch is thrown to, and 1 cm more from the hand's own push.
//
// So the frames round the release are allowed to *give*: the arm may sit this deep for a
// couple of hundredths either side of the ball's going, spent smoothly so that no frame
// steps. What it buys is the pitch; what it costs is a sleeve a couple of centimetres
// into a chest on the one frame the ball is gone from — which is the frame nobody reads.
const RELEASE_GRAZE = 0.045
const RELEASE_GRAZE_IN = 0.04
const RELEASE_GRAZE_OUT = 0.04

// The *last* key the release window hands over to the fold on — the first key after the
// window's own end that names a bend of its own (see STRAIGHT_TRACK, and
// AUTHORED_SLOT_END above for the window's end). Read off the keys rather than listed,
// like every other end in this file, so the schedule below cannot drift from them.
const AUTHORED_FOLD_FIRST = KEYS.find(
  (key) => key.t > AUTHORED_SLOT_END && (key.straight ?? Math.PI) < Math.PI * 0.99,
).t
// ...and the *stretch* the ask is answered at, frame by frame: the release window's own
// share of the span (see ARM_STRETCH_MAX), handed back to the arm's own length by the
// fold's first key.
//
// The window's keys are authored *long* of the arm on purpose (see the arm output's own
// note on the release window, and ``pitcherRelease``'s grip): an ask past the span is a
// wrist the driver carries out to the chord the frame's bend allows, which is what keeps
// the throw's own line — and its straight, 174.9° arm — through the whole window. What
// the ask's *distance* does on the frames after the window is not part of the delivery's
// shape at all (see SWEEP_IN_TIME): the keys there author the direction the throw already
// had, and it is this schedule, and the bend, that the arm's own length is read off.
// Without it the reach is read off the *ask* — the clamp below spends the ask down to
// whatever chord the two reads meet on, and the two meet where the ask itself crosses
// that chord: on the last window's own keys the ask runs 1.30 of the span at 1.54 s and
// the fold's first key is written 0.60 of it, so the chord the clamp holds the hand on
// falls 0.75 to 0.60 *on the frames the ask crosses it* — read on the realised skeleton
// at 240 Hz, the wrist 0.11 of a rig unit in one frame and the elbow 0.067 with it, the
// whole arm snapping in as the bone-length the driver was stretching goes back to one.
// That is the flick this schedule is bought against: the same wrist read with the reach
// handed back on its own frames moves 0.03 at its fastest, and the elbow 0.02, which is
// what the fold's own frames beside it already read.
//
// The three middles are the window's own end and the hand-over's own middle, and the
// values are the corners of an ease rather than a line: the fall starts on the window's
// last frames (0.06 of the span across the 19 ms the window still runs for) so that the
// hand-over's own two frames are not asked to carry all of it, and it lands on the fold's
// key at the arm's own length with no slope left at all — a chord that arrives still
// moving is a chord the first fold's frame has to stop, which is the step this is
// avoiding in the first place.
const STRETCH_TIMES = [
  AUTHORED_RELEASE_TIME,
  AUTHORED_SLOT_END,
  AUTHORED_SLOT_END + (AUTHORED_FOLD_FIRST - AUTHORED_SLOT_END) * 0.5,
  AUTHORED_FOLD_FIRST,
]
const STRETCH_TRACK = [1.25, 1.18, 1.08, 1]

// ...and the arm's own *straightness* through that window, key by key: the release's
// own chord on every frame the pitch is thrown on (see RELEASE_ELBOW), and the *cock's*
// own fold wherever a key authors one. A cocked arm is a folded arm — the elbow is most
// of a right angle at the top of it and the ball is held up behind the shoulder on it —
// and the fold is what the whole of the arm's own *pull* is read off: the driver hangs
// the elbow on a ring the two bones draw about the hand, and the ring's own radius is
// what a pole is worth (see its open-arm solve). Handed the release's chord there, the
// ring has no radius left and the pole is dead: measured on the realised skeleton, a
// straight cock reads the same two hundredths of a rig unit of plane lead with any pole
// at all (the two tried: up and back, and out to the throwing side), while the fold the
// cock's own key authors here lets that key's own pole — up and behind the shoulder,
// which is where a cocked elbow is — put the elbow the better part of a fifth of a rig
// unit behind the chest's plane. Both are what a throw is: the arm is *drawn back*
// folded and is *extended* through the ball, so the straightness is a ramp from the
// cock to the release rather than a switch at either end of it.
//
// The windup and the recovery keep the release's own chord as theirs, for the reason
// the whole hand-off exists: an ask is an upper *limit*, and the hand the windup holds
// near the body never reaches it.
//
// ...and the *follow-through* is where that limit is the delivery's own instrument
// rather than a default, because what the arm does after the crossing is fold, and a
// fold is the one shape a *place* cannot ask for. What an elbow is, is the chord its
// wrist sits at — a chord at the span is a straight arm, and every centimetre inside it
// is an angle — and near the straight end that reading is flat enough to be no use as a
// place at all: the whole of the fall's own fold, 175° to 145°, is two and a bit
// centimetres of chord, so a hand written a centimetre from the one that was meant is
// an elbow eleven degrees from the bend that was meant, and the socket the pose measures
// its place off is itself a couple of centimetres from the one the driver hangs the arm
// from. So from the hand-over on the *limit* is the pose's schedule and the places are
// the arm's: the fold's own keys name the bend they mean — 168°, 163°, 158°, 154° and
// 150° down the fall, with the last of them (1.6625s) a shade *looser* again, since by
// there the asks have come back inside the chord (0.96 of the span with the driver's own
// stretch nought) and the bend is theirs: a limit below them would only spend the body's
// own whisker on the fold and land it two degrees deeper than the hold's own keys carry
// on from — and the places stay *long* of the arm, exactly as the release window's own
// keys do: the driver answers a long ask by stretching to it and then folding it back to
// the bend the frame names, so the bend is the pose's promise wherever the ask is
// outside the chord, and the wrist rides at the chord the frame's own bend holds. That
// is what makes the hand come *in* as the arm folds, rather than the fold being an elbow
// the hand's own millimetres — a track's interpolation is worth a millimetre or two of
// radial travel a frame — walk around once the two are inside a degree of one another.
//
// Measured on the realised skeleton, the elbow folds 174.9° at the crossing through
// 168.3°, 163.2°, 158.7°, 152.9°, 150° and 145.5° and lands on the hold's own 147.9° —
// one movement, the hold's keys carrying the same rate on from there (142.5° at 1.71s)
// — where the previous authoring's own two keys dipped to 168° and 158.5° and the three
// after them asked for the release's own chord again: the elbow *straightened* back
// through 174.9° across the middle of the fall, so the arm unfolded and folded again
// while the drive leg swung past it, and the hand's own height, which rides the fold,
// came down on the frames either side of it (measured 23 mm against the 11 mm of the
// frames around them).
const STRAIGHT_TRACK = KEYS.map((key) => key.straight ?? RELEASE_ELBOW)

// The key the delivery lands in — the first after the release that stands on both
// feet — and the last key of the hold it is left standing in. Read off the keys
// rather than listed, so a re-timed delivery carries its own landing with it: the
// hold is the run of keys the finish is still written on, and it is the *feet* that
// name it rather than the pelvis' own travel — since the stride's plant was lengthened
// the pelvis goes on driving through the follow-through, so the drive is no longer one
// number from the landing out (see the landing key), and what the hold is the run of
// is the frames both shoes are still on the dirt (the recovery below lifts them, and
// the set is not standing in the finish).
const STANDING = (key) => key.pivot.lift === 0 && key.front.lift === 0
const LANDING_KEY = KEYS.findIndex((key) => key.t > AUTHORED_RELEASE_TIME && STANDING(key))
// ...and the hold runs to the last key *before* the recovery lifts a shoe: the set the
// clip comes home to is standing too, so it is the run starting at the landing that is
// read rather than every standing key in the file.
const FIRST_LIFTED = KEYS.findIndex((key, index) => index > LANDING_KEY && !STANDING(key))
const HOLD_KEY = KEYS[(FIRST_LIFTED < 0 ? KEYS.length : FIRST_LIFTED) - 1]
const LANDING_TIME = KEYS[LANDING_KEY].t
const HOLD_END_TIME = HOLD_KEY === undefined ? LANDING_TIME : HOLD_KEY.t

/**
 * The frame the fold's *hold* ends and the stand's last stretch begins: the pause's own key,
 * paced onto the stand's clock (see STAND_PACE).
 *
 * The two things that are *owed* for the fold — the glove's swing out of the chest and the
 * throwing arm's ride — are held whole to this frame and let out over what is left of the
 * stand: the swing because the fold it answers is coming off, the ride because the recovery's
 * keys are drawn for a body standing up and take the arm back as the stand ends. Paced with
 * the stand as well, so neither of them is still being let out after the trunk has stood.
 */

// ...and the pelvis' own travel on the frame the delivery lands in: the number the
// stride foot's authored place is pinned against (see `plantZ` in the pose) and the one
// a foot the dirt is holding stops taking the delivery's stride-scaling from.
const LANDING_DRIVE = KEYS[LANDING_KEY].drive


// The frame the delivery lands in, in the authored clock — the one the ``settle``
// below reaches its whole depth at, and so the frame a caller solves the body's own
// step against (see Pitcher.jsx, which reads the step's depth off the ground rule
// on this key's pose rather than off the mound's bare arithmetic).
export const AUTHORED_LANDING_TIME = LANDING_TIME

// ...and which frames the body's own step down the mound's slope is handed in on
// (see ``settle`` in pitcherPose): nought through the release — that frame's ball is
// what the placement pins on the pitch's own point, so the body cannot move under
// the anchor — the whole of it by the landing key, held while the delivery holds its
// finish, and eased back out across the recovery's own first key, so the delivery
// comes home to the set it began in. Read off the keys rather than listed; the
// *metres* of the step are the mound's own, and the caller reads them (Pitcher.jsx).
// ...and which frames the body's own *tilt* is handed in on (the lateral the arm cannot
// reach; see `pitcherRelease`, which solves the angle): nought at the set — the stance
// the clip opens and closes in is the stance the profile reads, and a pitcher in the set
// stands on his own two feet rather than out over the rubber's own edge — and then the
// whole of it out over the *kick*, in one motion rather than two: the roll begins on the
// rocker, the frame the weight goes back onto the pivot foot and the leg comes up over it,
// and it is standing by the plant, the frame the stride is out and the front foot has
// landed (see TILT_START_TIME and TILT_FULL_TIME, which are those two frames).
//
// The kick and not the drive, because the roll is *reach* before it is anything else. A
// pitch's lateral is spent on the arm's own cone first and on the body's two levers after
// (see `pitcherRelease`): the roll is what carries the socket the throw hangs from across,
// and the throw is *drawn back* off that socket — the cock is the arm up and behind a
// trunk that has already come across, so a socket that arrives late is a socket the arm
// reaches off, on the one window a throw is laid back folded in. Out over the kick
// instead, the roll is one motion with the leg: the weight goes back onto the drive leg,
// the knee comes up over it, and the trunk comes across over it while it does. It is under
// way well before the head comes off the line it stands in, which is the *look's* own
// clock and not this track's (see LOOK_PIN): the eyes sweep from
// AUTHORED_LOOK_SWEEP_TIME and lock on the zone before the drive fires, and the body they
// stand over is already coming across on the frames before the sweep.
//
// What the kick's frames pay for the roll is height rather than the drive leg's own line,
// and that is what makes them free: a roll turns the whole upper body about the body's own
// midline — the pelvis tips with the trunk — so the socket the drive leg hangs from comes
// *down* by a hip half-width of roll read along the pelvis' *own* lateral, and `rollLift`
// stands the pelvis back up by exactly that, which leaves the drive socket where the stance
// put it and the leg under it neither stretched nor folded (see `rollLift`, which is that
// geometry and nothing else). The pelvis' own turn is what the half-width is read along,
// and that is the whole of the windup's difference: square on the plate — the release
// window — a socket stands the half-width *across* the roll's own axis and pays nearly the
// whole of the sine, where a pelvis coiled a hundred degrees round the pitch's line lays
// its two sockets most of the way *along* that axis and pays for the roll in twist rather
// than in height. Measured on the game's own
// wide pitch: the drive socket stands still to a tenth of a millimetre through the whole of
// the kick with most of the roll out (46% of it at the gather, 80% at the fall), so a lift
// charged at the bare sine is a pelvis standing two and a half centimetres above the leg
// that has to reach the rubber — and what the driver's leg solve answers with is the shoe
// rolled up onto its toe (see its own give). What the same lift
// leaves the *kicking* leg is that much slack again, on the frames the leg is up in the air
// and bent under the body anyway (see TRUNK_TILT_MAX). The *carry* is the
// delivery's other lever and it stays where it was: the metres the roll cannot reach go
// out with the drive (see the step below), because the front foot is what pays for them and
// the front foot is on the dirt by the plant. Both are complete by the plant, so the anchor
// the pitch is placed by is built on the whole of the body's answer to the ask.
//
// ...then it is held through the whole window the ball rides the release anchor on (see
// AUTHORED_SLOT_END): the anchor's own place is the tilted one, so the body cannot unwind
// under a ball that is still riding it.
// ...and then it comes *off*, and how it comes off is two things rather than one. The
// body's own follow-through spends the roll — the chest goes on round, the arm sweeps
// across and the trunk comes up out of the lean it threw from — and what is left of it
// by the frame the back foot lands in is what the *finish* stands in (see
// TILT_LANDING_SHARE): the lean a delivery lands on is the lean it lands on, and a
// landing that snapped the rest of it out on the frame the swing happened to reach would
// be a body standing up out of its own follow-through. So the roll decays *through* the
// follow-through and is left whole — whatever it is — for the finish: nought of it is
// paid back on the frames the foot is still coming down through, which is what stops the
// drive leg being swung out from under a body that has not landed yet. What is left is
// then *held* for the whole of the finish (the hold is a stop, like every other track's —
// see the landing key's own note), and given up gently as the delivery comes home to the
// set: the roll rides the recovery's own turn back to the stance it began in, rather than
// being unwound out of the body on one frame in the middle of the follow-through.
// ...and which frames the body's own *carry* — the metres of the ask the tilt could not
// reach — is handed in on (see `pitcherRelease`, which solves the metres): nought at the
// set (the stance the clip opens and closes in is the stance the profile reads, and a
// pitcher in the set stands on his own two feet rather than out over the rubber's own
// edge), and then out with the *drive* — the same window the tilt comes out on, because
// the two are one motion: it is the stride that pays for the metres, the front foot's own
// place is authored across by them (see the pose's own ``offsetX`` and the front leg's
// shift), so the body goes where its step goes rather than the step sliding under a body
// that stayed. The *authored* foot comes across on that window too — the keys hold the
// front shoe a hand's width the other side of the drive leg's own line until the fall and
// have it across by the plant — so the two agree frame for frame rather than by a tuning.
// It is complete by the plant — the foot comes down where the body has come to, rather
// than the body arriving after the foot is down — and then *held*: through the window the
// ball rides the anchor on, through the whole of the follow-through the back leg swings
// through, and through the finish the delivery lands in and stands in. Both feet are on
// the ground from the plant to the walk-back, and what is standing on the ground does not
// slide: the body's own metres are the *front* shoe's own by then (its place is authored
// across by them, see the pose below), so paying the carry back out from under the finish
// is the stride foot skating across the mound, which is what a carry released on the
// follow-through's own frames did. What pays it back instead is the *recovery*'s own
// step: the feet come up out of the crossed finish and go back to the set over the
// walk-back, and the body comes across with them, so the delivery comes home to the
// stance it left with the metres it spent still under it rather than out in front of it.
const STEP_TRACK = (() => {
  const from = KEY_AT(1.05).t   // the fall: the kick is stood, and the back leg drives the body out
  const full = KEY_AT(1.20).t   // the plant: the stride is out, and the foot is where the body is going
  return KEYS.map((key) => {
    if (key.t <= from) return 0
    if (key.t < full) return (key.t - from) / (full - from)
    if (key.t <= HOLD_END_TIME) return 1
    if (key.t >= AUTHORED_CLIP_END) return 0
    return (AUTHORED_CLIP_END - key.t) / (AUTHORED_CLIP_END - HOLD_END_TIME)
  })
})()

// The lean-in's own share, key by key: what the trunk's fold is *walked* into the pitch
// with, as a share of the release's own fold rather than as an angle — read off the keys'
// own place in the delivery like the tilt's, and held back until the rocker because the
// lean-in is the *stride's* clock rather than the windup's: while the weight is going back
// onto the pivot foot the trunk is the windup's, and the walk starts as the front leg does
// (see LEAN_IN_START_TIME).
//
// A share rather than a track of angles, because the fold it wakes is the *pitch's*: the
// release posture solves it from the slot's own arm angle, so a submarine's release is
// folded most of a right angle where an over-the-top arm's stands a shade past upright
// (see `releasePosture`). Written as angles, the walk would have to be re-authored for
// every slot on the staff; written as a share of the posture's own fold, one walk carries
// all of them — the deep slots simply walk deeper, which is what the delivery does.
//
// Its shape is the walk's own: the square of the delivery's own progress from the rocker to
// the release. Squared rather than straight, because the walk is a *rate* as well as a
// place: the trunk is a body the front leg is carrying forward, so it comes onto the foot
// over the whole of the kick and the balance rather than arriving on the last of the
// stride — half the lean a third of the way in, and the rest of it over the frames the
// body is turning down onto the plant.
//
// It is *withdrawn* at the plant rather than arriving there: the back leg's fire puts the
// trunk back over the drive foot first (see the drive keys), so the plant's own key is left
// holding the walk's share at nought and the window's slot track carries the fold from there
// (see SLOT_TRACK) — the fall over the foot is the pitch's, and the delivery's own part in it
// is where it comes rather than how deep it is.
const LEAN_IN_START_TIME = KEYS[1].t   // the rocker: the last frame the stride foot is on the dirt
const LEAN_IN_TRACK = KEYS.map((key) => {
  if (key.t <= LEAN_IN_START_TIME) return 0
  if (key.t >= AUTHORED_RELEASE_TIME) return key.slot ?? 0   // ...and the window's own share from there on
  // The *fall*: withdrawn here, so the key's own lean is what the body carries from the
  // moment the weight goes forward — the trunk tilted *back* over the drive foot as the
  // back leg fires (see the drive keys). The withdrawal is at the fall rather than at the
  // plant, because the reference's own back-tilt begins as early as the body's forward
  // fall does: the stride is thrown with the trunk already leaning back over the rubber
  // (see the PS reference's own first frames), so the walk's forward share is off from
  // here and the arch is the fall's, the break's and the plant's together.
  if (key.t <= 1.26) {
    // ...and it stays withdrawn to the top of the cock: the arch is the body's *shape*
    // for the whole of the load, so what carries the fold from the cock to the ball is
    // the fall over the front foot — the last sixty milliseconds, squared, into the
    // release — rather than a walk already half-way over the rubber at the cock (which
    // is what the half-share here used to be, and what tipped the shoulder line forward
    // out from under the layback before the arm had finished loading).
    if (key.t >= 1.05) return 0
    const through = (key.t - LEAN_IN_START_TIME) / (AUTHORED_RELEASE_TIME - LEAN_IN_START_TIME)
    return through * through
  }
  const late = (key.t - 1.26) / (AUTHORED_RELEASE_TIME - 1.26)
  return late * late
})

// The frame the stride foot's own turn stops being the keys' and becomes the ground's: the
// frame the shoe is put down on the plate's own line, which is the plant end of the
// stride — the last key the front foot's own place and bearing still move on, and the key
// the boot is left standing on the dirt by (the stretch's own ``lift`` reaches nought
// there, see the key's own note). Read off the keys rather than listed, so a delivery
// whose stride lands on another frame carries its own plant with it.
const FRONT_PLANT = KEYS.find((key) => key.t > AUTHORED_RELEASE_TIME && key.front.lift === 0)
const FRONT_PLANT_TIME = FRONT_PLANT.t
// ...and how much of that turn the *ground* is holding, key by key: all of it from the
// plant through the finish, and nought by the clip's own end, because the finish is a
// stance the shoe is stood *out* of — the delivery comes home to the set over the
// walk-back, and the shoe comes up out of the finish and steps back with the body rather
// than being dragged round the dirt on the way (the clip ends in the set it began in, see
// the last key). Shared rather than switched, like every other window here, so the angle is
// handed back to the keys over the recovery's own frames.
const FRONT_PLANT_HOLD = KEYS.map((key) => {
  if (key.t < FRONT_PLANT_TIME) return 0
  if (key.t <= HOLD_END_TIME) return 1
  if (key.t >= AUTHORED_CLIP_END) return 0
  return (AUTHORED_CLIP_END - key.t) / (AUTHORED_CLIP_END - HOLD_END_TIME)
})

// ...and the lead shoe's own turn once the dirt has it: the *body's* whole turn through
// the pitch, from the release rather than from the plant, and off the trunk rather than off
// the pelvis.
//
// Off the trunk because a foot the ground is holding comes round as the body standing over
// it does, and the body standing over it is the trunk: locked to the pelvis instead, the
// shoe inherits a turn that is not smooth through the follow-through — the hips' keyed yaw
// stands at 1.0231 rad across 1.54-1.5575 and then takes 0.135 in the next thirty-two
// thousandths, so the shoe turned 8.3°, 9.1° and 9.5° on three frames and then 11.1°, 15.3°,
// 19.3°, a stall and a snap, which is the one thing a shoe on the ground cannot do. The
// trunk's turn is the pitch's own curve — up to 300°/s by 1.46 s and down to 46°/s on the
// landing frame — and it is the angle the leg above the shoe turns by too, the knee's plane
// being the shoe's own line (see the knee's own note in the driver).
//
// Read as a *track* of its own rather than as the trunk's angle off the pose: the shoe's
// turn leaves from rest (the delivery's own rule is that a thing handed from one owner to
// another starts where it was left, and the plant is a frame of its own), where the chest's
// own interpolated curve leaves the plant at the whipping rate the trunk turns at there.
// Written this way the shoe picks the turn up over two frames, and every key of the window
// still lands on the trunk's own angle to the decimal — the track's values *are* the trunk's
// turn at the keys, times the share below.
//
// ...and the share is the whole of the body's turn *through the pitch*, not the part that
// falls after the plant. The chest comes round 101.9° between the release and the landing
// (0.04 rad to 1.819), and 61.0° of that is spent before the shoe is down (0.04 → 1.10 on
// the plant's own key). A shoe handed only the trunk's turn from the plant's own frame takes
// 41.2° of the 101.9 and leaves the lead foot standing in a finish the body has come most of
// the way round over: the trail shoe spins 155° through the same frames, and the lead one,
// on the same dirt, turned less than a third of that and stopped pointing a hand's width off
// the plate's line while the chest was square to it. What the shoe is handed instead is the
// body's turn from the *release*, spent over the frames it has on the dirt after the plant:
// 101.9° of pivot in the trunk's own shape — one decay, out of rest at the plant and back
// into it on the landing key, never a step — at 2.474 times the trunk's own rate over those
// frames. The share is read off the keys rather than listed, so a delivery re-timed or
// re-authored carries its own plant, release and landing with it.
//
// Where it pivots is *not* where the trail shoe does (see the ``leg`` solve below): 101.9° on
// the heel would sweep 0.155 of a rig unit of ankle travel across the dirt, and the front leg
// — which stood at 101 per cent of its own length on the landing under the 41.2° it used to
// turn — had 0.070 of it to give.
const RELEASE_KEY = KEYS.find((key) => key.t >= AUTHORED_RELEASE_TIME)
const FRONT_SHOE_TURN_SHARE = (KEYS[LANDING_KEY].chestYaw - RELEASE_KEY.chestYaw)
  / (KEYS[LANDING_KEY].chestYaw - FRONT_PLANT.chestYaw)
const FRONT_SHOE_TURN = KEYS.map((key) => (
  key.t < FRONT_PLANT_TIME ? 0 : (key.chestYaw - FRONT_PLANT.chestYaw) * FRONT_SHOE_TURN_SHARE
))


const TILT_START_TIME = KEYS[1].t   // the rocker: the kick's own first frame, and the last one the stride shoe is on the dirt
const TILT_DRIVE_TIME = KEY_AT(1.05).t   // the fall: the kick is stood, and the back leg drives
const TILT_FULL_TIME = KEY_AT(1.20).t    // the plant: the stride is out, and the tilt is standing
// What the follow-through leaves of the roll by the frame the back foot lands in: the
// finish's own lean, held for the whole of the hold and given up over the walk-back (see
// the tilt's own note above). It is a share rather than an angle, because what it is a
// share *of* is the pitch's own ask: a pitch thrown over the rubber's edge lands leaning.
// The share itself is small — a tenth of the ask, which is 2.9° of the widest pitch's
// 28.65° — because what a landing can be stood *under* is the lean whose weight line the
// two feet the swing put down already carry (see the landing key's own note): anything
// more and the finish is a body still out over its front foot rather than one standing on
// it, and nought is a landing that stood up out of its own follow-through on a frame.
export const TILT_LANDING_SHARE = 0.10
// The roll's own share, key by key, from the frame it is handed in on: up in one motion,
// standing by the plant, held for the whole window the ball rides the anchor on, spent by
// the follow-through and left standing for the finish (see the tilt's own note above). One
// shape and two clocks, because the roll and the *height* it costs the legs are two
// promises: the body's roll comes out with the kick (TILT_TRACK), and the pelvis' own lift
// follows the drive (TILT_LIFT_TRACK).
const tiltRamp = (from) => KEYS.map((key) => {
  if (key.t <= from) return 0
  if (key.t < TILT_FULL_TIME) {
    return (key.t - from) / (TILT_FULL_TIME - from)
  }
  if (key.t <= AUTHORED_SLOT_END) return 1
  // ...and then the body's own follow-through spends it: the arm comes across, the chest
  // goes on round and the trunk comes up out of the lean it threw from, so what the roll
  // is worth decays across the frames the swing is landing on rather than being dropped
  // on one of them.
  if (key.t < AUTHORED_LANDING_TIME) {
    const through = (key.t - AUTHORED_SLOT_END) / (AUTHORED_LANDING_TIME - AUTHORED_SLOT_END)
    // ...and *eased* onto the finish rather than run straight into it: the last of the
    // roll is given up on the frames the swing is settling on, so a decay with a
    // constant rate would still be spending it at full speed on the frame the shoe
    // touches — a body standing up out of its follow-through as it lands. What is left
    // at the landing is the finish's own share either way (see TILT_LANDING_SHARE); the
    // ease is what makes the *arrival* at it a settling rather than a stop.
    const eased = through * through * (3 - 2 * through)
    return 1 + (TILT_LANDING_SHARE - 1) * eased
  }
  // ...and what is left of it is the finish: held to the frame for the whole of the hold
  // (nothing above the legs moves in a hold — see the landing's own note), and then eased
  // out as the delivery turns and steps back into the set it began in.
  if (key.t <= HOLD_END_TIME) return TILT_LANDING_SHARE
  if (key.t >= AUTHORED_CLIP_END) return 0
  return TILT_LANDING_SHARE * (AUTHORED_CLIP_END - key.t) / (AUTHORED_CLIP_END - HOLD_END_TIME)
})

// The body's own roll, on the *kick's* own clock: out from the rocker, standing by the
// plant.
const TILT_TRACK = tiltRamp(TILT_START_TIME)
// ...and the *height* the same roll costs the legs, on the *drive's* clock: nought through
// the kick — the windup's pelvis is coiled most of the way round the pitch's own line, so
// its two sockets lie along the roll's own axis and what the roll does to them is twist the
// pelvis rather than drop it, and there is nothing for a lift to pay. Measured on the game's
// own wide pitch with the roll most of the way out (46% of it at the gather, 80% at the
// fall): the drive socket stands still to a tenth of a millimetre, and a lift charged over
// the kick instead is a pelvis standing two and a half centimetres above the leg that has to
// reach the rubber — which the driver's leg solve answers by rolling the shoe up onto its
// toe (see its own give, and the browser suite's reading of the kick). From the fall on the
// two clocks are one motion: the pelvis is coming square under the roll as the back leg
// carries it, the socket takes the roll's own sine, and the heights the delivery's own keys
// were authored with are the ones the lift pays for (see `rollLift`).
const TILT_LIFT_TRACK = tiltRamp(TILT_DRIVE_TIME)

// ...and which frames the *back* foot's own place stops being the rubber's and becomes the
// body's. A pitcher's feet are authored where they are in the frame he stands in — his
// pivot foot does not ride his hips forward, which is the whole point of a pivot foot (see
// the pose's own ``carry`` note below) — but that goes only as far as the shoe is standing
// on the rubber. The release is the last frame it is: the leg drives over its own toe and
// the delivery carries the ankle up onto the swing from there, and from then on the foot
// is a place *on the body*, hanging off a socket the body's own metres have carried across.
// So what the pose hands the drive foot's place is the carry the stride foot is authored
// across by (see the ``pivotFoot`` below), ramped in across the frames the shoe is coming
// off the dirt on — the release-to-slot window the pitch is thrown on, which is the peel
// and the first of the swing — and the share is read off the delivery's own release and
// slot rather than listed, so a re-timed delivery carries its own peel with it. Spread
// rather than switched, because it is a *place* that moves and a place that moved on one
// frame is a step (see the suite's own bound on how fast a foot may travel): the whole of
// the transfer is 0.45 m of the body's own carry, and spending it on the frames the leg
// is peeling on is a foot moving faster than the swing that is carrying it.
const PIVOT_RIDE_TRACK = KEYS.map((key) => {
  if (key.t <= AUTHORED_RELEASE_TIME) return 0
  if (key.t >= AUTHORED_SLOT_END) return 1
  return (key.t - AUTHORED_RELEASE_TIME) / (AUTHORED_SLOT_END - AUTHORED_RELEASE_TIME)
})

const SETTLE_TRACK = (() => {
  const recovery = KEYS.find((key) => key.t > HOLD_END_TIME)
  const recoveryTime = recovery ? recovery.t : AUTHORED_CLIP_END
  return KEYS.map((key) => {
    if (key.t <= AUTHORED_RELEASE_TIME) return 0
    if (key.t <= LANDING_TIME) {
      return (key.t - AUTHORED_RELEASE_TIME) / (LANDING_TIME - AUTHORED_RELEASE_TIME)
    }
    if (key.t <= HOLD_END_TIME) return 1
    if (key.t <= recoveryTime) return 1 - (key.t - HOLD_END_TIME) / (recoveryTime - HOLD_END_TIME)
    return 0
  })
})()
// Which frames the hands are together on: the clasp's own keys *and* the one it lets
// go on (see PART_KEYS), read as a weight, so the correction below is full while they
// are clasped — and on the frame the swing begins from, where the ball is still in the
// mitt — and eases out across the five frames that follow, while the arm's own track
// takes the hand over.
const CLASP_TRACK = KEYS.map((key) => (key.clasp || key.part ? 1 : 0))
// The frame the hands let go on, and how long the pose goes on reading them as one
// hand past it. The ball is still in the mitt on that frame (see PART_KEYS), so the
// hand-over is a mix of two places that agree to within the centimetre the chest's
// estimate is worth — but spread across the five frames to the fall it spends the
// first of the swing's motion dragging the ball out of a mitt that has already let
// it go, which is the pause the delivery is being fixed for. Two frames is a let-go;
// after them the throwing hand is the arm's own track and nothing else. (A *third* of
// a hundredth of a second, not two frames at a hundred-and-twentieth: the window is
// written in the delivery's own clock, so it is two frames at any frame rate the
// renderer happens to be drawing.)
const PART_INDEX = PART_KEYS.indexOf(true)
const PART_TIME = PART_INDEX < 0 ? null : KEYS[PART_INDEX].t
const HAS_PART = PART_TIME != null
const PART_FADE = 0.03
// Which frames the trail arm is the *lead* arm's own mirror on: a key that leaves
// the elbow number out is one the arm is not doing its own work on, read as a
// weight — full through the clasped windup and eased out across the segment that
// ends at the balance key, which is where the swing leaves the clasp's shape (see
// `mirrorTracks` and the correction below).
const MIRROR_TRACK = KEYS.map((key) => (key.elbow ? 0 : 1))
const VECTOR_TRACKS = PLAIN_VECTORS.map((name) => ({
  key: name,
  // The throw's own line is the scratch the clasp writes over: on the keys whose
  // hands are together it is the glove's own line and on every other key it is the
  // numbers the key wrote (see claspTracks).
  values: name === 'aim' ? _claspAim : KEYS.map((key) => key[name]),
}))
const FOOT_TRACKS = FEET.map((name) => ({
  key: name,
  values: KEYS.map((key) => key[name]),
  parts: FOOT_PARTS[name].map((part) => KEYS.map((key) => key[name][part])),
}))
// The release window's own two vectors, and which keys are authored in it.
const RELEASE_KEYS = KEYS.map((key) => !!key.release)
const BALL_TRACK = CLASP_KEYS.some(Boolean) ? _claspBall : KEYS.map((key) => key.ball)
// The trail arm's own pole, key by key: the place a key authored, or — on the keys
// whose arm is the *lead* arm's own mirror — the place the mirror puts it, written
// into the track by `mirrorTracks` (see below). The keys that leave the number out
// are the clasped windup's, up to just before the glove elbow starts to rise: that
// is where the two arms stop being one shape, and from the balance key on the
// throwing arm is doing its own work and says so with its own numbers.
const ELBOW_TRACK = KEYS.map((key) => key.elbow ?? [0, 0, 0])

// The glove hand's own elbow, key by key: the place a key authored, or the tucked
// one a clasped glove's arm is doing — half way along the glove's own line, a hand's
// width further out from the body's midline and a little behind it. Seeded per key
// from that key's own glove, rather than derived from the interpolator's answer at
// the frame being posed, for the same reason the clasp's two tracks are seeded: a
// key that named its own elbow keeps it, and the two forms interpolate as places.
// ...and the same pole read as the *angle* it hangs at, on the keys that author one (see
// the note at the fold's first follow-through key): which way round the socket-to-wrist
// chord the elbow's own ring stands, in the frame the world's up makes with that chord —
// lateral = chord × up, and the ring's own up = lateral × chord, so a sweep of nought is
// the elbow out on the throwing side of the chord and a right angle is it hanging under
// it. The series is *unwrapped* — it is one angle that turns, not an angle per key — so a
// fold whose ring comes round past the world's own -z carries on climbing rather than
// winding back, and the interpolator between the keys is a smooth turn the whole way.
// The pose composes the pole from this angle and the place's own along/tilt below (see
// `poleOut`), which is what keeps the driver's clearance rule out of a promise the fold
// makes about its own plane.
const SWEEP_KEYS = KEYS.filter((key) => key.sweep != null)
const SWEEP_TIMES = SWEEP_KEYS.map((key) => key.t)
const SWEEP_VALUES = SWEEP_KEYS.map((key) => key.sweep)

const GLOVE_ELBOW_TRACK = KEYS.map((key) => key.gloveElbow ?? [
  key.glove[0] * 0.5 - 0.18,
  key.glove[1] * 0.5,
  key.glove[2] * 0.35 + 0.14,
])

// The *throwing* hand's own palm, where a key authors one: which way the ball is
// turned as the arm comes up behind the shoulder — the pitcher's own back, which is
// what a windup shows a camera at the plate — and what the throw then brings round to
// the plate (see the keys' own ``palm``, and `palmAt` below). A key that names none is
// asked for the pitch's own *bearing* instead, which is where the throw's frames
// either side of the release want it, so the two facings are one ask rather than a
// hand that is asked for nothing outside the keys that name one.
const HAND_PALM = KEYS.map((key) => (key.palm ? key.palm.slice() : null))
// ...and how much of that ask the frame is turned to, key by key: nought through the
// windup, where the hand rides the delivery's own rest and then the mitt it is holding
// (the clasp's share of the turn is read beside this one, see the arm output's
// ``palmMix``), and one from the reach through the whole of the throw — the layback
// turns the ball to the back and the come-through brings it round to the zone — before
// the fold takes the share back with the arm (see the hand-over's own end below).
const PALM_ASK = [
  [1.20, 1],
  [AUTHORED_SLOT_END, 1],
  [AUTHORED_FOLD_FIRST, 0],
]
const PALM_ASK_TIMES = PALM_ASK.map(([t]) => t)
const PALM_ASK_TRACK = PALM_ASK.map(([, v]) => v)
// One key's own ask per axis, for the read below.
const _palmAxis = KEYS.map(() => 0)
// ...and the *hold*: how much of that ask rides the arm's own frame rather than standing
// still in the rig's. A wrist does not re-turn itself as the arm swings — it keeps its own
// angle and the ball in the hand goes where the arm carries it — while a facing written in
// the rig's frame is one the wrist has to keep chasing down the swing: measured on the
// realised skeleton, the layback's own facing took a 30° turn of the wrist between the cock
// and the come-through over and above the arm's own travel. Nought through the windup,
// where the palm is a question about the mitt the hand is in and the keys' own facing is
// what answers it, one from *the frame the hands part on* — and from there the *forearm* is
// what rolls: the hand comes out of the glove on the plate's bearing and turns over the
// whole of the down-swing as one joint, so that by the frame the arm is at the pitcher's
// side (1.11-1.16 s) the palm is square to first base, which is the back he is turned to
// with (see the break key's own ``palm``, and HOLD_ROLL's own angles) —
// rather than a wrist re-pointing itself at every facing the swing passes through, to the
// come-through, where the hold is let go: the arm is
// straightening there (a hundred and fifty-eight degrees of elbow at 1.29 s, and the plane
// the hold is written in is the elbow's own, so it is going thin), and the throw's own
// bearing is what the ask wants on the frames the ball leaves on (see the pose's
// ``handPalm`` and, below it, `PALM_ASK`).
//
// Starting it at the *separation* rather than after the break is the other half of the same
// point, and it is what the *fall* needs rather than the cock. A facing named in the rig's
// frame through the down-swing is one no roll can answer for a third of it: the hand's own
// line turns end over end as the arm comes down (the wrist cock runs the fingers back off the
// forearm and the arm swings through it), so on the frames where the line points at the
// plate or at first base the ask is a direction *along* the hand — measured 0.90 of the way
// down it at 1.08 s — and the driver squares it up to nothing and rolls the wrist to
// whatever is left: read on the realised skeleton, that left the palm 64° off the ask a
// frame and then snapped it 77° in the frame after. A held joint has no such frame: it is
// always square to the line by construction, so the fall turns over as one motion instead of
// arriving at the last frame.
const PALM_HOLD = [
  [1.00, 0],  // the hands part: the mitt's own facing is still the one answering
  // ...and handed over across the fast part of the drop rather than in two frames. In two
  // frames the hand-over lands on the one frame the hand's own line swings fastest (the hand
  // coming down past the chest), and the two turns add: 56.9° of palm in a frame of a
  // hundred-and-twentieth, against the 55° a hand leaving a mitt is allowed. Across four it is
  // 52.6°, and the wrist the drop leaves is the hold's from 1.04 s on either way.
  [1.04, 1],
  [1.28, 1],
  [1.30, 0],
]
const PALM_HOLD_TIMES = PALM_HOLD.map(([t]) => t)
const PALM_HOLD_TRACK = PALM_HOLD.map(([, v]) => v)
// The wrist's own angle, as the layback leaves it: the facing the keys author there (the
// ball turned to the pitcher's own back, which is what a camera at the plate sees of a
// cocked arm), written in the arm's own frame rather than in the rig's, so that what the
// hold keeps is a *joint* rather than a direction in the world. Two numbers and not three,
// because a palm is a direction *square to the hand's own line* by construction — the line
// is the axis the wrist's one free turn is about (see the driver's ``palmFacing``, whose
// roll is taken about exactly that axis), so the part of a facing written along it is a
// part no wrist can answer and the driver squares up out of the ask. Written as the two
// the turn is in: across the plane the elbow hangs off, and level within it. Read off the
// realised skeleton at the layback (1.20 s: 0.000, 0.339, -0.941), where the keys' own
// facing stands — a wrist most of the way through the arm's own plane, which is the
// reference pitch's own layback — and it is the same angle the *down-swing* is asked for:
// what the hold keeps from the break on is one joint, so the roll the swing makes of the
// hand is the forearm's rather than a wrist re-turning to each facing in the rig's frame.
//
// The reference pitch does not carry *one* angle down the swing: the forearm and the palm
// roll together as the torso falls forward, the hand turning over the whole of the
// down-swing — through the sky, then down at the ground, then out to the pitcher's own
// back — and arriving at the layback's angle as the cock folds. A single held angle is a
// wrist frozen mid-roll: measured on the realised skeleton, the constant ask left the palm
// wandering across the fall with no roll to call its own (the turn about the hand's line
// read 145°, -131°, 59° across 1.16-1.30 — no direction at all, the hand re-pointing to
// whichever rig facing the swing happened to pass). What is held now is a joint that
// *turns*: `HOLD_ROLL` is the wrist's angle about the hand's line, swept from the break's
// own angle — the one that stands the palm square to first base — to the layback's across
// the fall, so the palm rolls through the sky and the ground to the back as one forearm
// rather than a hand chasing the rig's facings.
// The layback's own angle as the two the hold is written in: read off the realised
// skeleton at the layback (1.20 s: 0.000, 0.339, -0.941), where the keys' own facing stands
// — a wrist most of the way through the arm's own plane, which is the reference pitch's own
// layback. atan2 of the pair is the single angle that pair names about the hand's line,
// which is what the roll below settles on and holds through the cock.
const HOLD_PALM = [-0.0500, -0.9990]
const HOLD_ROLL_END = Math.atan2(HOLD_PALM[1], HOLD_PALM[0])
// The angles below are the ones that stand the palm on **first base** with the arm where it
// actually is on each frame — read off the pose's own hand line and elbow (the frame the hold
// is written in) at the frame in question, not guessed from a key: while the arm swings, its
// own roll about the hand's line carries the facing a few degrees a frame, so one angle does
// not serve two frames. Read on the realised skeleton with these in place, the palm is within
// 5° of the base on every frame from 0.97 s to 1.02 s — the frames the arm is at the pitcher's
// side and the ball is being shown to the infield — and the ask is the plate's bearing at the
// gather (0.80 s, 90° away), with no frame of a hundred-and-twentieth turning it more than 26°.
//
// The keys from 1.03 s on are read off the arm the *lift* now has (see the swivel's window):
// with the elbow opening out of the hang from 1.06 s the hand's own frame turns over faster,
// so the wrist's angle has to give way with it — 1.10 at 1.05 s, nought at 1.07 s — and the
// track runs *down* from the side's angle to the layback's own -92.9° instead of up past it.
// Written the other way (the layback's angle wound on past a half turn, which is what the
// track did while the arm hung four frames longer) the wrist would have to unwind backwards
// through most of a turn to arrive where the arm already is.
const HOLD_ROLL = [
  [1.00, 2.110],  // the arm reaches his side: the palm square to first base, the ball shown
  [1.03, 1.702],  // ...and held there while the arm hangs (the lift is not yet begun)
  [1.05, 1.100],  // ...and again as the arm starts up the back (its roll has moved)
  [1.07, -0.100],
  [1.09, -0.600],
  [1.11, -1.150],
  [1.13, HOLD_ROLL_END],  // turned over onto the ground as the elbow opens (PS-2), and
  [1.30, HOLD_ROLL_END],  // held there: one forearm rolling, no wrist chasing the swing
]
const HOLD_ROLL_TIMES = HOLD_ROLL.map(([t]) => t)
const HOLD_ROLL_TRACK = HOLD_ROLL.map(([, v]) => v)

// The throwing arm's own pole, where a key authors a *direction* rather than a place.
//
// A key's ``elbow`` is a place, and the driver reads the arm's side off the direction
// from the socket to it — which is the same thing while the arm is held out and the
// hand is somewhere else, and is *not* while the hand swings past the place itself.
// The fall is exactly that case: the hand leaves the chest and drops beside the hip,
// and the set's own pole stands above and behind the chest, so somewhere in the
// middle of the drop the hand's line runs through it. On the frame it does, the place
// names no side at all: the elbow's ring has no near point to hang on, the driver
// squares the ask up to whatever is left, and the arm turns over as the hand goes by
// — measured on the realised skeleton, 55° of upper arm and 76° of forearm between
// two frames of a hundred-and-twentieth in the fall, with the palm swept 35° with
// them. Written as a direction, the side the elbow hangs on is a setting the hand's
// own travel cannot re-answer: what the frames between two of them do is walk round
// the sphere between two sides, which is the drop that is being authored.
//
// Authored for the right hand and mirrored on the way out, like the keys' own places
// (see `trackRelease`). Its own clock rather than the keys': what it is for is the
// *frames between* them — the place of the fall is a place, and where the side turns
// over inside a segment is the one thing a key cannot say.
//
// Read off the pitch: the elbow hangs out to the throwing side and level while the hands are
// together (at the gather, 0.80), falls under the arm as it drops, and is under it by the
// frame the hand reaches the hip (the balance, 1.00) — the reference pitch's own PS-2 into
// PS-3, where the arm is thrown down at the ribs before the elbow goes anywhere. That is the
// whole of what this track owns: the *lift* out of the hang is the swivel's (see its window),
// written as a turn about the socket so that the arm can be paced through it, and from there
// to the cock the swivel is the only clock.
//
// Its times moved with the swing: the drop is the gather-to-balance's own now rather than the
// balance-to-break's, so the same four directions are walked over 0.80-1.00 instead of
// 1.00-1.12 — twenty hundredths of a second where the arm falls, against twelve before, and
// the swivel's lift then has the whole of the rest of the windup to bring the upper arm level.
// The directions are the ones the old drop was authored with, unchanged: an arm dropped
// beside the body is the same plumb shape whichever key's clock it is on.
const POLE_TRACK = [
  [0.80, [0.6512, -0.7547, 0.0800]],
  [0.86, [0.8000, -0.4200, -0.4000]],
  [0.92, [0.7400, -0.6428, -0.1982]],
  [1.00, [0.4924, -0.8660, 0.0868]],
  // The cock's own key, kept for the swivel to arrive on and the whip to leave from: the
  // frames between it and the break's own key are the swivel's (see `swivelAt`), never read
  // as a line between two places.
  [1.26, [0.9600, -0.3400, 0.0200]],
]
const POLE_TIMES = POLE_TRACK.map(([t]) => t)
const POLE_DIRS = POLE_TRACK.map(([, v]) => v)
const POLE_FIRST = POLE_TIMES[0]
// ...the last frame the *place* track owns. The swivel owns everything from here to the
// cock's own key (see `SWIVEL_FROM`), so this is the balance: the frame the hand is at the
// bottom of its swing and the arm starts up the back.
const POLE_LAST = 1.00
// How long the track takes over from the key's own place on its first frames: two at
// a hundred-and-twentieth, which is a wrist turning over rather than a snap.
const POLE_HANDOVER = 0.02
const _poleAxis = POLE_TIMES.map(() => 0)
const _placeDir = [0, 0, 0]
const _poleOut = [0, 0, 0]
const _poleEnd = [0, 0, 0]
const _poleStart = [0, 0, 0]
/**
 * The pole's own direction at a frame, in the frame the keys are authored in: the
 * keys' own directions, mixed as directions (each axis separately and the answer
 * squared back up), so what the frames between two of them walk is the short way
 * round the sphere — the same interpolation the palm's facings are read with.
 *
 * @param {number} t the authored clock
 * @param {number[]} out a scratch triple
 * @returns {number[]} ``out``
 */
function poleAt(t, out) {
  for (let axis = 0; axis < 3; axis += 1) {
    for (let i = 0; i < POLE_DIRS.length; i += 1) _poleAxis[i] = POLE_DIRS[i][axis]
    out[axis] = trackAt(_poleAxis, POLE_TIMES, t)
  }
  return out
}
const _poleDir = [0, 0, 0]

// The swivel's own clock, in the rig frame: the throwing upper arm's *bearing* about its
// socket (degrees, 0 = straight back along the body, +90 = the throwing side) and its *rise*
// below the shoulder line (degrees, positive down). It is written as the two angles rather
// than as a place because what is being paced is the *turn*: a bearing read off a place
// cannot be told to accelerate, and a bearing read off a distance along the sphere can.
//
// The window is the throw's own three movements:
//
//   * the lift — the arm drawn up out of the windup onto the hold: it leaves the pole track's
//     own arm on the *balance*'s frame (1.00 s), where the drop has put the hand at the
//     pitcher's side and the arm hangs sixty-two degrees under its socket on the realised
//     skeleton, and it comes up over ten frames onto a hold that is *parallel to the ground*.
//     It starts there — with the hand, rather than four frames later — because the forearm is
//     already rising by 1.09 s and the windup's own swing is the two of them as one motion:
//     the upper arm opening *back and up* under the elbow while the hand draws up behind it.
//     Read on the realised skeleton it is 62° under the socket at 1.08 s, 56° at 1.117, 49° at
//     1.133, 35° at 1.15, 18° at 1.167 and level at 1.183 — some six hundred degrees a second
//     at its fastest frame over the whole of it, where the same rise spread over four frames
//     was 47° of upper arm in one;
//   * the hesitation — three frames stood on that arm at 1.178-1.202 s: the upper arm parallel
//     to the ground (realised: 0.6°, 2.0° and 1.1° off the level on its frames) with the elbow
//     out toward first base, which is the frame a hitter reads the arm's side out of and the
//     frame this throw is loaded from;
//   * the turn — from rest, one accelerating turn round the shoulder that carries the elbow
//     *down* (fifty degrees under the socket by 1.2325 s) and round under the arm, and that
//     comes back up into the plane the shoulders draw as the chest turns out from under it,
//     arriving on the cock's own arm at 1.26 s. The drop is not a movement of its own laid
//     inside this one: it is walked on the turn's own travel (see `SWIVEL_RISE_PATH`), so the
//     arm leaves the hold slowly and is one motion from the level arm to the cock.
//
// The lift can go no earlier than the balance: while the arm is at the side it is straight, so
// the wrist has no roll of its own to hold and the palm's facing is the elbow's to carry. The
// lift's own keys in `HOLD_ROLL` are read off the arm each frame has, and read on the realised
// skeleton the palm is within 5° of first base from 0.97 s to 1.02 s and turns away as the hand
// comes up the back. A lift begun while the hand is still on its way down — any frame between
// the gather and the balance — asks the elbow to open out of an arm that has not finished
// falling, which leaves the palm 21° off the base as the arm arrives: a ball shown to the
// infield a beat late. The window starts on the frame the arm reaches the side.
//
// The rise and the bearing walk *together* on the way up (one smoothstep each, see
// `swivelAt`'s lift): that is the shape being asked for — one arm swinging back and up — and
// it is why the window starts at the break. Trailed behind the bearing instead (two and a half
// powers of the same walk, which is what this window used to do) the elbow stays under the
// arm while the hand has begun to rise, and the arm arrives at the hold in two frames rather
// than six.
//
// The rise is its own small track rather than one curve, because the *shape* is the point:
// the elbow drops away from the hold, hangs under the arm while it comes round, and lifts
// back into the plane only at the end.
const SWIVEL_FROM = 1.00
const SWIVEL_HOLD_FROM = 1.155
const SWIVEL_HOLD_TO = 1.212
const SWIVEL_END = 1.26
// The hold's own two angles: five degrees under the socket line on the pose's own clock,
// which the driver realises at zero to within a degree and a half — the upper arm *parallel to
// the ground*, with the elbow out toward first base.
const SWIVEL_BEARING_HOLD = -25
const SWIVEL_RISE_HOLD = 5
// ...and the arm is held *still* across them, which takes one small counter-drift: an arm
// written motionless in the rig is not motionless on the screen, because the trunk is turning
// out from under it through the hesitation at some three hundred and fifty degrees a second
// and carries the elbow round and *down* with it. Measured on the realised skeleton before
// this line was here: the hold's frames read a rise of 0.9°, 1.1°, 3.2° and 6.9° — the
// horizontal arm sagging six degrees over the two frames, which is exactly what made a pause
// read as a slow collapse. The number below is that carriage written back with the other
// sign; measured again, the same frames read 0.9°, -0.7°, -0.9° and -0.3°: a level arm held
// level for the whole hold.
//
// Only the rise can be held this way. The elbow's *bearing* through the hold is the driver's
// own answer — the ring about the shoulder-to-hand chord, kept clear of the trunk — and it
// does not follow the pose's pole there: a counter-turn written into the arm (5.6°, then 20°,
// then the arm asked straight back along the body) moved the realised bearing not at all,
// while the same frames moved 6.0° on their own (-35.7° to -41.7°) — the trunk's own turn,
// which the arm is carried with. What the hesitation promises is therefore that the arm stops
// *lifting and dropping* while the shoulders go on turning under it; taking the bearing back
// as well would mean stopping the delivery's turn, which is not the pause's to stop.
const SWIVEL_HOLD_DRIFT_RISE = -6.0
const SWIVEL_RISE_HELD = SWIVEL_RISE_HOLD + SWIVEL_HOLD_DRIFT_RISE
// ...and the drop, as a *path* through the rise rather than a track on the clock:
// [share of the turn's own walk, degrees under the shoulder line]. It is written this way —
// against the turn's travel rather than against the clock — because the drop is not a second
// movement laid inside the turn; it is *part* of it. Walked on the clock (which is what this
// window used to do: its own keys, each segment eased out of rest and into it) the descent
// snapped the arm 7,355°/s on the frame after the hold, crawled at 1,000-1,600°/s through the
// come-through while it waited to be started again, and stalled at 149°/s on the cock's own
// frame. Read on the turn's own travel, the two joints share one pace: measured on the same
// skeleton, the upper arm now leaves the hold at 582°/s, 979°/s and 2,439°/s and is still
// turning at 2,653°/s as the ball goes.
const SWIVEL_RISE_PATH = [
  [0, SWIVEL_RISE_HELD],
  // ...fifty degrees under the socket line by half the turn (1.2325 s on the clock), which is
  // the frame the suite reads "the elbow hangs under the arm" on, and held there while the
  // shoulder carries it round. It is put *late* on the path on purpose: the descent's own rate
  // is this path's slope times the turn's pace, so a bottom at half the travel is a drop that
  // creeps out of the hold and is still finding its speed where the shoulder is already turning
  // — the arm comes round with the elbow still near the level rather than diving first.
  [0.5, 50],
  [0.6, 50],
  // ...and up into the plane as the chest turns out from under it, on the cock's own arm.
  [1, 20],
]
// The arms either side of the window, read off the pole track itself: the lift starts on the
// track's own arm at the break — the hang the drop left — and the turn ends on the cock's own,
// which is the arm the pose has always stood there. Neither hand-over is a seam, and neither is
// read as a *place* on the socket — which is what made the arm jump thirty degrees of rise on
// one frame when the socket moved under a place that had been standing still.
const _swivelHold = [0, 0, 0]
const _swivelCock = [0, 0, 0]
poleAt(SWIVEL_FROM, _swivelHold)
poleAt(SWIVEL_END, _swivelCock)
const SWIVEL_BEARING_FROM = bearingOf(_swivelHold)
const SWIVEL_RISE_FROM = riseOf(_swivelHold)
const SWIVEL_BEARING_COCK = bearingOf(_swivelCock)
const SWIVEL_RISE_VALUES = SWIVEL_RISE_PATH.map(([, v]) => v)
// The turn's own slopes at its two ends: it leaves the hold from rest, and it arrives on the
// cock at about the speed the trunk is turning at — which is the speed the whip then picks up
// (see `whipPole`). Arriving at full pace instead (1.05) the turn is still at 2,918°/s on the
// frame before the cock and the arm reads 149°/s on the frame after it: the throw stops in the
// middle. Measured with 0.6, the hand-over runs 699°/s into 320°/s — a soft corner rather than
// a stop, which is what the arm's own arrival at the cock is.
const SWIVEL_LEAVE = 0
const SWIVEL_ARRIVE = 0.6
let SWIVEL_SPAN_BEARING = SWIVEL_BEARING_COCK - SWIVEL_BEARING_HOLD
// The bearing's own branch: a turn past a hundred and eighty is either way round, and the
// short one is the way the arm goes.
while (SWIVEL_SPAN_BEARING > 180) SWIVEL_SPAN_BEARING -= 360
while (SWIVEL_SPAN_BEARING < -180) SWIVEL_SPAN_BEARING += 360
// The two arms at the ends of the turn, as directions, so the *rate* it arrives at can be
// named: `SWIVEL_ARRIVE` is a slope along the bearing, and the hand-over it has to meet is an
// angle on the socket's own sphere.
const armDirection = (bearing, rise) => {
  const b = (bearing * Math.PI) / 180
  const r = (rise * Math.PI) / 180
  return [Math.sin(b) * Math.cos(r), -Math.sin(r), Math.cos(b) * Math.cos(r)]
}
const SWIVEL_TURN_SPAN = (() => {
  const hold = armDirection(SWIVEL_BEARING_HOLD, SWIVEL_RISE_HELD)
  const cock = armDirection(SWIVEL_BEARING_COCK, SWIVEL_RISE_VALUES[SWIVEL_RISE_VALUES.length - 1])
  const dot = hold[0] * cock[0] + hold[1] * cock[1] + hold[2] * cock[2]
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI
})()
// ...the turn's own arrival rate, in degrees a second, which is the pace the whip starts at.
const SWIVEL_ARRIVE_RATE = (SWIVEL_ARRIVE * SWIVEL_TURN_SPAN) / (SWIVEL_END - SWIVEL_HOLD_TO)

/** The angle of a direction's sideways turn, in degrees, and its rise below the level. */
function bearingOf(dir) { return (Math.atan2(dir[0], dir[2]) * 180) / Math.PI }
function riseOf(dir) { return (Math.asin(-dir[1]) * 180) / Math.PI }

/** The cubic that walks nought to one between two slopes: a value, its rate at each end. */
const hermite = (u, m0, m1) => -2 * u * u * u + 3 * u * u
  + (u * u * u - 2 * u * u + u) * m0
  + (u * u * u - u * u) * m1

/**
 * The rise the swivel's path names at a share of the turn's own travel.
 *
 * A cubic through the keys with the tangents the keys either side give it, so the path turns
 * no corners: the elbow's drop, the arm's carry under the trunk and its lift back into the
 * plane are one curve, and the rate the frames take out of it is the turn's pace times this
 * curve's own slope — nought at the hold, and still rising when the cock is reached.
 *
 * @param {number} travel the turn's paced share, nought on the hold and one on the cock
 * @returns {number} degrees under the shoulder line
 */
function swivelRiseAt(travel) {
  const keys = SWIVEL_RISE_PATH
  const last = keys.length - 1
  if (travel <= keys[0][0]) return keys[0][1]
  if (travel >= keys[last][0]) return keys[last][1]
  // The key's own slope, read off the keys either side of it (the secant of the neighbours, so
  // a level stretch is level and a peak is not a corner). The *first* end is flat: the drop
  // leaves the hold at rest, so the elbow's descent is not begun with a jerk but grows out of
  // the hold's stillness — and the turn's first frames are the shoulder's own, with the elbow
  // still level under it. The last end keeps its own segment's slope, because the cock is a
  // hand-over and not a place the arm comes to rest on: the lift is still moving when the whip
  // takes the arm on.
  const slope = (i) => {
    if (i <= 0) return 0
    if (i >= last) return (keys[last][1] - keys[last - 1][1]) / (keys[last][0] - keys[last - 1][0])
    return (keys[i + 1][1] - keys[i - 1][1]) / (keys[i + 1][0] - keys[i - 1][0])
  }
  for (let i = 1; i <= last; i += 1) {
    if (travel > keys[i][0]) continue
    const u0 = keys[i - 1][0]
    const u1 = keys[i][0]
    const h = u1 - u0
    const s = (travel - u0) / h
    const s2 = s * s
    const s3 = s2 * s
    return (2 * s3 - 3 * s2 + 1) * keys[i - 1][1]
      + (s3 - 2 * s2 + s) * h * slope(i - 1)
      + (-2 * s3 + 3 * s2) * keys[i][1]
      + (s3 - s2) * h * slope(i)
  }
  return keys[last][1]
}

/**
 * The throwing upper arm's own direction on a frame of the swivel.
 *
 * Read as a bearing and a rise, every frame is one place on the socket's own sphere: the
 * elbow sweeps the ring the arm is hinged on rather than being carried across it, which is
 * what a place read off two keys a hand's width apart does once the socket travels between
 * them.
 *
 * @param {number} t the authored clock
 * @param {number[]} out a scratch triple
 * @returns {number[]} ``out``
 */
function swivelAt(t, out) {
  let bearing = SWIVEL_BEARING_HOLD
  let rise = SWIVEL_RISE_HOLD
  if (t <= SWIVEL_HOLD_FROM) {
    // The lift: the track's own arm drawn up onto the hold, out of rest, at the pace the
    // window has room for (see the window's own note on why it cannot start earlier).
    const u = clamp((t - SWIVEL_FROM) / (SWIVEL_HOLD_FROM - SWIVEL_FROM), 0, 1)
    const travel = hermite(u, 0, 0)
    // ...and the rise walks with the bearing (see the window's own note): one arm swinging
    // back and up out of the hang, rather than an elbow turning while the arm stays low.
    const travelRise = travel
    bearing = SWIVEL_BEARING_FROM + (SWIVEL_BEARING_HOLD - SWIVEL_BEARING_FROM) * travel
    rise = SWIVEL_RISE_FROM + (SWIVEL_RISE_HOLD - SWIVEL_RISE_FROM) * travelRise
  } else if (t <= SWIVEL_HOLD_TO) {
    // The hesitation: the arm's own aim held while the trunk goes on turning under it (see
    // the window's own note on the drift), which is the pause — the level is held for the two
    // frames the hold is worth, and the turn leaves it from rest.
    const u = clamp((t - SWIVEL_HOLD_FROM) / (SWIVEL_HOLD_TO - SWIVEL_HOLD_FROM), 0, 1)
    rise = SWIVEL_RISE_HOLD + (SWIVEL_RISE_HELD - SWIVEL_RISE_HOLD) * u
  } else {
    // The turn: off the hold's stillness, one turn round the shoulder that leaves from rest
    // and accelerates all the way to the cock — with the elbow held under the arm on the way
    // round and lifting back into the plane at the end (see `SWIVEL_RISE_PATH`).
    const u = clamp((t - SWIVEL_HOLD_TO) / (SWIVEL_END - SWIVEL_HOLD_TO), 0, 1)
    // One pace for both joints (see the path's own note): the bearing turns on it and the
    // elbow's drop rides *in* it, so the arm is one movement out of the hold rather than a
    // turn with a drop laid inside it.
    const travel = hermite(u, SWIVEL_LEAVE, SWIVEL_ARRIVE)
    bearing = SWIVEL_BEARING_HOLD + SWIVEL_SPAN_BEARING * travel
    rise = swivelRiseAt(travel)
  }
  const b = (bearing * Math.PI) / 180
  const r = (rise * Math.PI) / 180
  out[0] = Math.sin(b) * Math.cos(r)
  out[1] = -Math.sin(r)
  out[2] = Math.cos(b) * Math.cos(r)
  return out
}

/** A cross product into a scratch triple: the third axis of a frame built from two. */
const crossOut = (a, b, out) => {
  out[0] = a[1] * b[2] - a[2] * b[1]
  out[1] = a[2] * b[0] - a[0] * b[2]
  out[2] = a[0] * b[1] - a[1] * b[0]
  return out
}
const _holdPlane = [0, 0, 0]

/**
 * The direction a frame's palm is asked for: the keys' own facing (the pose hands it in as
 * ``given``) or, while the cock holds it, that facing *carried with the arm*.
 *
 * The frame it is carried in is the hand's own: the *line* the hand runs along (the axis
 * the wrist's one free turn is taken about — see the driver's ``palmFacing``) and the plane
 * the elbow hangs off, squared up out of that line. `HOLD_PALM` is the wrist's own angle in
 * that pair, so the facing travels with the arm and the wrist is asked for nothing while the
 * arm cocks — where a facing written in the rig's frame is one the wrist has to keep chasing
 * down the swing.
 *
 * Everything is read in the numbers the keys are authored in and mirrored back out again (a
 * lefty's arm is the mirror of this one, which is what ``s`` does on the way in and on the
 * way out). The share is what hands the ask back to the keys: at one it is the held facing
 * outright, at nought it is ``given``, and between them the two are mixed as *directions*,
 * the way the keys' own facings are (see `palmAt`) — so the hand-over the arm's own
 * straightening forces is a wrist turning over a frame or two rather than a snap.
 */
function heldPalm(given, share, roll, socket, line, pole, s) {
  if (!(share > 0)) return given
  const hand = normalize(line, s)
  const elbow = normalize([
    pole[0] - socket[0], pole[1] - socket[1], pole[2] - socket[2],
  ], s)
  const plane = normalize(crossOut(hand, elbow, _holdPlane), 1)
  const side = crossOut(hand, plane, [0, 0, 0])
  // The roll is one angle about the hand's own line: ``across`` the elbow's plane and
  // ``level`` within it, which is the pair HOLD_PALM is written in — so the sweep below is
  // the forearm turning over, and the layback's own numbers are one frame of it.
  const across = Math.cos(roll)
  const level = Math.sin(roll)
  const held = normalize([
    across * plane[0] + level * side[0],
    across * plane[1] + level * side[1],
    across * plane[2] + level * side[2],
  ], s)
  return normalize([
    given[0] + (held[0] - given[0]) * share,
    given[1] + (held[1] - given[1]) * share,
    given[2] + (held[2] - given[2]) * share,
  ], 1)
}

/**
 * The direction the throwing hand's palm is asked for at a frame, in the frame the
 * keys are authored in: the keys' own facings, mixed the way every other clasp track
 * is (see `trackAt`), with the pitch's own bearing standing in on the keys that name
 * none (see HAND_PALM). Read as a direction rather than as a place, so what
 * interpolates between two keys is the *turn* of the wrist rather than a place it has
 * to pass through — the two facings either side of the throw are most of a right angle
 * apart, and a wrist handed from one to the other in the frame a key is left would
 * snap.
 */
function palmAt(t, bearing) {
  const out = [0, 0, 0]
  for (let axis = 0; axis < 3; axis += 1) {
    for (let i = 0; i < KEYS.length; i += 1) {
      _palmAxis[i] = HAND_PALM[i] ? HAND_PALM[i][axis] : bearing[axis]
    }
    out[axis] = trackAt(_palmAxis, TIMES, t)
  }
  return out
}

// Scratch for one clasp key's own wrist, in the chest's frame (see claspTracks).
const _claspWrist = [0, 0, 0]

/**
 * The frame one key's own chest is in: where the chest's centre is (the midpoint of
 * the two shoulder sockets, off the same leaned shoulder the release anchor is
 * measured from) and the turn that carries a place written in the chest's frame out
 * into the rig's. Both the clasp's two tracks and the trail arm that mirrors the
 * lead arm read it, so the two cannot come to different opinions about which body
 * the windup's hands and elbows are on.
 */
function chestFrameAt(rig, key, index = 0, tilt = 0) {
  // The frame the keys are authored in is the right hand's, so the tilt this receives is
  // the rig's own x carried back into it: the tracks this frame seeds are mirrored on
  // their lateral axis by the hand they are read on (see `trackRelease`), and a tilt
  // seeded the other way round would carry the clasped hands *out* of a chest that was
  // rolling the other way.
  const trunk = trunkLean(key.chestYaw, key.lean, key.leanSide + TILT_TRACK[index] * tilt)
  const turn = upperTurn(key.chestYaw, -trunk.leanX, -trunk.leanZ)
  const centre = turnVector(turn, [
    0,
    rig.shoulder.y - rig.hip.y,
    rig.shoulder.z - rig.hip.z,
  ])
  centre[1] += rig.hip.y + key.hipY
  centre[2] += rig.hip.z - key.drive
  return { turn, centre }
}

/**
 * Writes the clasp into the two tracks it owns: the ball's own place and the
 * throwing hand's own line, on the keys whose hands are together.
 *
 * The ball is *in* the glove, so the glove is the one that is authored. The
 * throwing hand's place is the glove's own palm — the glove's wrist, less the carry
 * down the glove's own line — carried into the rig frame by the turn the chest
 * holds at that key, and the throwing hand's line is the glove's line. Authored the
 * other way round, the two hands are two sets of numbers that have to be tuned to
 * agree, and a change to the stance's own turn pulls them apart invisibly — which
 * is exactly where the grip is: a hand a centimetre out from its glove is the pitch
 * showing.
 *
 * A key's own numbers are read for a right-hander, as the whole table is, and the
 * mirror is the one the tracks are read through (see `trackRelease`) — so the turn,
 * the glove's offset and its line are the authored ones. What moves with the key is
 * the chest's own centre (the midpoint of the two shoulder sockets, off the same
 * leaned shoulder the release anchor is measured from) and with it the hands, which
 * is what a windup is.
 */
function claspTracks(rig, tilt = 0) {
  const carry = releaseCarry(rig, 'R')
  const halfWidth = rig.shoulder.halfWidth
  for (let i = 0; i < KEYS.length; i += 1) {
    if (!SEED_KEYS[i]) continue
    const key = KEYS[i]
    // The key's own share of the delivery's tilt (see TILT_TRACK): the clasped hands are
    // one body with the chest they are held in front of, so a chest rolled out over the
    // rubber carries them with it rather than leaving them where a square chest was.
    const { turn, centre } = chestFrameAt(rig, key, i, tilt)
    const aim = turnVector(turn, normalize(key.gloveAim, 1), _claspAim[i])
    // The glove's wrist in the chest's own frame, measured from that centre: the
    // key wrote it from the glove's own shoulder, which sits half the shoulders'
    // width out along the chest's lateral.
    const wrist = turnVector(
      turn, [key.glove[0] - halfWidth, key.glove[1], key.glove[2]], _claspWrist,
    )
    const ball = _claspBall[i]
    ball[0] = centre[0] + wrist[0] + aim[0] * carry
    ball[1] = centre[1] + wrist[1] + aim[1] * carry
    ball[2] = centre[2] + wrist[2] + aim[2] * carry
  }
}

/**
 * Writes the trail arm's own pole on the keys it is the lead arm's mirror on: the
 * *other half of one shape*, rather than a second opinion about it.
 *
 * While the hands are clasped the two arms hold one pair of hands, so the shape the
 * lead arm makes with the glove is the shape the throwing arm has on the other side
 * of the body's own midline — one upper arm and one forearm, drawn twice. Authoring
 * the second one is authoring numbers that have to be tuned against the first, and
 * what a change to either one does is pull the two arms out of agreement invisibly;
 * a windup's two elbows are meant to hang *level with each other*, and this is what
 * makes that a fact about the pose instead of a coincidence about the numbers.
 *
 * The mirror is about the body's own *midline*, in the chest's own frame, and it is
 * the lateral axis negated and nothing else: the two shoulder sockets are a shoulder
 * width apart along that axis, so the place the other arm's elbow goes is the same
 * height, the same distance out in front, and the same distance out to its own side
 * — which is what leaves the two forearms pointing down together rather than one of
 * them hanging. A key that authored its own elbow keeps it (see ELBOW_TRACK), which
 * is how the elbow raise at the balance key hands the arm back to its own numbers.
 *
 * Seeded per key from that key's own glove elbow, rather than derived from the
 * interpolator's answer at the frame being posed, for the same reason the clasp's
 * two tracks are seeded: the two forms interpolate as places. What the seeded places
 * agree on at the keys, the pose then reads off the glove's *live* elbow at the frame
 * being posed (see the correction in `pitcherPose`), so the two arms are one shape
 * between the keys as well as on them.
 */
function mirrorTracks(rig, tilt = 0) {
  const halfWidth = rig.shoulder.halfWidth
  for (let i = 0; i < KEYS.length; i += 1) {
    if (!MIRROR_TRACK[i]) continue
    const { turn, centre } = chestFrameAt(rig, KEYS[i], i, tilt)
    // The glove's own elbow in the chest's frame, measured from that centre: the
    // key wrote it from the glove's own shoulder, which sits half the shoulders'
    // width out along the chest's lateral (see GLOVE_ELBOW_TRACK).
    const away = GLOVE_ELBOW_TRACK[i][0] - halfWidth
    // ...and its mirror: the same place the other side of the midline, which is
    // that lateral offset negated.
    turnVector(turn, [-away, GLOVE_ELBOW_TRACK[i][1], GLOVE_ELBOW_TRACK[i][2]], ELBOW_TRACK[i])
    ELBOW_TRACK[i][0] += centre[0]
    ELBOW_TRACK[i][1] += centre[1]
    ELBOW_TRACK[i][2] += centre[2]
  }
}

/**
 * A monotone curve through one track's keys: the value at ``t``, with each key's
 * slope taken from its neighbours' one-sided differences, halved where they
 * disagree in sign (a key that is a local extreme holds there instead of
 * overshooting it) and capped at three times the segment's own slope
 * (Fritsch-Carlson). That is what keeps a track whose keys step — the fingers
 * opening through the release, the front foot planting — from ringing around the
 * step, while a track whose keys progress carries its speed through them.
 */
function trackAt(values, times, t) {
  const last = times.length - 1
  if (t <= times[0]) return values[0]
  if (t >= times[last]) return values[last]
  let i = 0
  while (i < last - 1 && times[i + 1] < t) i += 1
  const dt = Math.max(1e-9, times[i + 1] - times[i])
  const here = (values[i + 1] - values[i]) / dt
  const beforeOne = i > 0 ? (values[i] - values[i - 1]) / Math.max(1e-9, times[i] - times[i - 1]) : here
  const afterOne = i < last - 1 ? (values[i + 2] - values[i + 1]) / Math.max(1e-9, times[i + 2] - times[i + 1]) : here
  const tangent = (one) => {
    if (one * here <= 0) return 0
    return Math.sign(here) * Math.min(Math.abs(one), 3 * Math.abs(here))
  }
  const m0 = tangent(beforeOne)
  const m1 = tangent(afterOne)
  const u = (t - times[i]) / dt
  const u2 = u * u
  const u3 = u2 * u
  return (2 * u3 - 3 * u2 + 1) * values[i]
    + (u3 - 2 * u2 + u) * dt * m0
    + (-2 * u3 + 3 * u2) * values[i + 1]
    + (u3 - u2) * dt * m1
}

// The release window's own tracks, resolved to places in the rig frame for the
// frame being posed: a key authored in the window is an offset from the release
// point, and every key is read as a place, so the two forms interpolate together
// instead of stepping from one to the other where the window opens.
const _axis = KEYS.map(() => 0)
const _releaseAt = [0, 0, 0]
// The drive each key is written at, for the carry below: a key's own frame carries
// the body's own forward movement (see ``drive`` above), and that is the number a
// place outside the release window is held to when the delivery is thrown at another
// stride.
const DRIVE_KEYS = KEYS.map((key) => key.drive ?? 0)
function trackRelease(values, release, s, t, out, stride, shift = null, keys = null) {
  _releaseAt[0] = release.x
  _releaseAt[1] = release.y
  _releaseAt[2] = release.z
  for (let axis = 0; axis < 3; axis += 1) {
    // The keys are authored for a right-hander, so the lateral axis is mirrored
    // for a lefty. The *anchor* is already the hand's own (pitcherRelease mirrors
    // it), so this is the authored part of the track and nothing else.
    const hand = axis === 0 ? s : 1
    for (let i = 0; i < KEYS.length; i += 1) {
      // A key *outside* the release window is a place in the rig frame, written for
      // the authored delivery, and what a delivery at another stride changes is how
      // far forward that frame is carried: the place rides the difference, by the
      // drive the key itself is written at, so that a pitch thrown with a shorter (or
      // a longer) delivery carries the same arm and the same ball through the same
      // body rather than reaching for a place the body has left behind. A key inside
      // the window is an offset from the anchor, and the anchor is already the
      // stride's own (see `pitcherRelease`'s drive) — and already the *lean's*: the
      // anchor's own place carries the pelvis' lean across the stance (see its
      // ``stance``), so a key outside the window, which is a place written in a frame
      // whose body has not leaned, is carried with the body here while a key inside it
      // needs nothing (its offset is measured from the leaned anchor it rides).
      const carried = RELEASE_KEYS[i] ? 0 : shift ? shift[axis] : 0
      const carry = axis === 2 && !RELEASE_KEYS[i] ? -(stride - 1) * DRIVE_KEYS[i] : 0
      _axis[i] = hand * values[i][axis] + (RELEASE_KEYS[i] ? _releaseAt[axis] : 0) + carry + carried
      if (keys) keys[i][axis] = _axis[i]
    }
    out[axis] = trackAt(_axis, TIMES, t)
  }
  return out
}

// The key the release frame owns, for the track below.
const RELEASE_KEY_INDEX = TIMES.indexOf(AUTHORED_RELEASE_TIME)

/**
 * Writes the release key's own hand line: the *straight* arm's, which is the line
 * from its socket to the ball (see `pitcherRelease` and `straightChord`). Authored
 * the other way round — the key's own aim, a hand pointed level at the plate while
 * the arm reaches up and out of the fold — the wrist is placed a palm *off* the arm's
 * own line, and the driver answers with an elbow bent to hold it there and a wrist
 * cocked back off the forearm: the release reads as a throw made with the wrist
 * rather than with the arm, at the one frame the ball leaves on. Written before the
 * track is read, like the clasp's own two, and for the same reason: the line is the
 * pitch's own release point's rather than the key's.
 */
function writeReleaseArm(rig, release, s) {
  const aim = release.aim
  const index = RELEASE_KEY_INDEX
  // The key's own aim, as authored: what the pole's own side is read against below.
  // The track is authored for the right hand and mirrored on the way out (see
  // `normalize`), so a lefty's line is stored the other way round its own lateral axis.
  //
  // Read off the key every call rather than off the track it is stored in: the write
  // below replaces that key's entry with the pitch's own line, and the key is not a
  // clasp key (the hands are apart at the release), so `claspTracks` does not put the
  // authored aim back — reading the track would hand the *first* frame of a session the
  // authored aim and every frame after it the line the first frame wrote, which makes
  // the release pole depend on which frame the reader started from (measured: the
  // pose's own elbow 1.2 of a rig unit across the body on the one frame, and the
  // release window's whip reading as a flick on a sweep that began mid-delivery).
  const { turn } = chestFrameAt(rig, KEYS[index], index, s * release.tilt)
  const authored = turnVector(turn, normalize(KEYS[index].gloveAim, 1), [0, 0, 0])
  // ...and the pitch's own line in the same frame the tracks are stored in (the pose
  // multiplies a track's lateral axis by the hand on the way out, see trackRelease).
  const line = [s * aim[0], aim[1], aim[2]]
  _claspAim[index][0] = line[0]
  _claspAim[index][1] = line[1]
  _claspAim[index][2] = line[2]
  return { authored, line }
}

// The window key's own pole as authored, kept for the write above: the pose is called
// once per frame and the write is idempotent, so it is read from here rather than from
// the track it writes into. Taken on the first pose the module writes a release for,
// which is after `mirrorTracks` has filled the keys that leave their own pole out.
let ELBOW_AUTHORED = null

/**
 * Turns the release key's own elbow pole to the pitch's own line: the pole is a *place*
 * and the driver reads the elbow's side off the direction to it (see its open-arm
 * solve), so a pole authored beside the *authored* release names a side that has turned
 * with the ball — a pitch whose release stands half a metre across the body (see ``side``
 * in `pitcherRelease`) hands the driver a pole half a metre off the arm's own plane,
 * and the driver answers by folding the elbow to hold the line it was given: measured,
 * six degrees of it at the suite's own wide release, on the one frame the ball leaves
 * on. What travels with the pitch is the pole's *side* — its offset taken across the
 * arm's own line, which is the direction the pitch cannot change — with its share along
 * the line kept as authored. A pitch with no lateral to reach for is the identity.
 */
function writeReleasePole(release, s, authored) {
  const index = RELEASE_KEY_INDEX
  const line = [s * release.aim[0], release.aim[1], release.aim[2]]
  if (ELBOW_AUTHORED === null) ELBOW_AUTHORED = ELBOW_TRACK.map((v) => v.slice())
  const pole = ELBOW_AUTHORED[index]
  const along = pole[0] * authored[0] + pole[1] * authored[1] + pole[2] * authored[2]
  for (let axis = 0; axis < 3; axis += 1) {
    ELBOW_TRACK[index][axis] = pole[axis] - authored[axis] * along + line[axis] * along
  }
}

// The whip: the arm's last sixty milliseconds of turn, from the arm the swivel hands over on
// (1.26 s, the cock's own key) to the direction the release key draws. It walks the span the
// two arms make over the window, evenly: the arm is not sped up and not eased down inside the
// whip, and nothing is turned back about the chord — the arm used to be held through these
// frames while the hand laid itself back, and that hold is the pause the throw had in it.
//
// What is *not* spent through it is the turn the old place track drew: read off the keys the
// two arms stand 45° apart on the socket's own sphere (the release's own direction is the
// cock's carried up and round by the chest's turn), so the whip's own travel is forty-five
// degrees in sixty milliseconds. The rest of the throw's turn is spent before the cock, which
// is why the swivel is written as one accelerating turn and this is its settling half: an
// upper arm that had kept accelerating at the swivel's 2,600°/s would have run out of ring
// before 1.28 s and stood still through the ball.
//
// A place is only a direction as seen from the socket it hangs off, and through the whip the
// socket travels most of a stride while the keys' places stand a hand's width apart: the line
// between two of them cuts across the chord instead of sweeping round it, and the pole it
// names walks down the chord's own line — which is the one place the ring has no side to be
// read on. `forearmOf` fades its side there and the elbow it hangs still flips: measured on
// the realised skeleton, the hand jumped 0.45 of a rig unit on two frames a five-thousandth of
// a second apart at 1.288 s, and the same seam showed as a 0.24 of a unit step of the drawn
// ball at 1.279 s. Read as a turn between two unit triples there is no line to cut: the arm
// goes from one direction to the other the short way round its own sphere.

/** One place's direction off the socket it hangs from, as a unit triple. */
function directionOf(place, socket, out) {
  const dx = place[0] - socket[0]
  const dy = place[1] - socket[1]
  const dz = place[2] - socket[2]
  const length = Math.hypot(dx, dy, dz) || 1
  out[0] = dx / length
  out[1] = dy / length
  out[2] = dz / length
  return out
}

// Scratch for the turn: the elbows the keys draw (the hold's, the cock's and the release's),
// and the answer.
const _swivelPlace = [0, 0, 0]
const _swivelRelease = [0, 0, 0]
const _whipPlace = [0, 0, 0]
const _whipAt = [0, 0, 0]

/**
 * Reads the throwing arm's pole through the whip as a turn from one arm to the other.
 *
 * The two ends are directions off the shoulder — the arm the swivel hands over on its last
 * frame, and the arm the release key draws — and the frames between them are the short way
 * round the socket's own sphere, at a rate that leaves the swivel's and rises.
 *
 * @param {number[]} out the elbow's pole place, in the rig frame (written in place)
 * @param {number[]} socket the shoulder the arm hangs from, in the rig frame
 * @param {number} t the authored clock
 * @param {number[]} from the swivel's own last arm, in the rig frame
 * @param {number[]} to the pole's direction the release key draws, in the rig frame
 * @returns {number[]} ``out``
 */
function whipPole(out, socket, t, from, to) {
  // Where the frame stands in the whip's own window: nought on the cock, one on the release.
  const share = clamp((t - SWIVEL_END) / (AUTHORED_RELEASE_TIME - SWIVEL_END), 0, 1)
  // The arm's own travel: the shortest turn from the direction the swivel left it in to the
  // direction the release key draws. Both are arms the pose already stands the upper arm in —
  // the swivel's last frame and the key's own — so the frames between them are the arm going
  // from one to the other and nothing else.
  const dotFT = clamp(from[0] * to[0] + from[1] * to[1] + from[2] * to[2], -1, 1)
  const span = Math.acos(dotFT)
  // ...and the travel is walked at the pace the turn handed over: the whip picks up the speed
  // the swivel arrived at and accelerates from it, so the arm's rate rises all the way from
  // the hold to the release and is at its highest as the ball goes — rather than arriving at
  // the cock fast and restarting the throw at a walking pace (see `SWIVEL_ARRIVE`). The walk
  // is `a·u + (1-a)·u³`: unit slope at nought is `a` and at one it is `3-2a`, so a hand-over at
  // `a` leaves the whip at `3-2a` times the window's mean, which is the keys' to slow down.
  const spanDeg = (span * 180) / Math.PI
  const meanRate = spanDeg / (AUTHORED_RELEASE_TIME - SWIVEL_END)
  const handOver = Math.max(0.05, Math.min(1, SWIVEL_ARRIVE_RATE / meanRate))
  const travelled = share * (handOver + (1 - handOver) * share * share)
  const sinSpan = Math.sin(span)
  let ahead = 1 - travelled
  let behind = travelled
  if (sinSpan > 1e-6) {
    ahead = Math.sin((1 - travelled) * span) / sinSpan
    behind = Math.sin(travelled * span) / sinSpan
  }
  _whipAt[0] = from[0] * ahead + to[0] * behind
  _whipAt[1] = from[1] * ahead + to[1] * behind
  _whipAt[2] = from[2] * ahead + to[2] * behind
  const unit = Math.hypot(_whipAt[0], _whipAt[1], _whipAt[2]) || 1
  for (let axis = 0; axis < 3; axis += 1) {
    out[axis] = socket[axis] + (_whipAt[axis] / unit) * POLE_REACH
  }
  return out
}

const _ball = [0, 0, 0]
const _elbow = [0, 0, 0]
// ...and the place the fold's own ring composes, beside the keyed one it is handed over from
// (see the pole's own note in the pose).
const _composed = [0, 0, 0]
const _pinned = [0, 0, 0]
const _stance = [0, 0, 0]
const _spin = [0, 0, 0]

/**
 * The pose of one frame of the delivery.
 *
 * @param {number} t the clip's clock, in seconds: 0 is the top of the windup,
 *   ``releaseTime`` is the release, the clip's end is the set again
 * @param {object} ctx
 * @param {object} ctx.rig result of measurePlayerRig (the pitcher's own frame)
 * @param {string} [ctx.hand='R'] the throwing hand
 * @param {number} [ctx.height] the release height above the ground, rig units —
 *   the pitch's own, which the delivery is aimed and leaned by (see
 *   `pitcherRelease`)
 * @param {number} [ctx.releaseTime=1.32] the clip time of the release
 * @param {number} [ctx.stride=1] the delivery's own forward movement as a share of
 *   the authored one: the pelvis' drive and both feet's travel toward the plate are
 *   read at it, so a shorter delivery is the *same* shape taken less far (see
 *   `pitcherProfile`, which solves it, and STRIDE_BAND)
 * @param {number} [ctx.idle] the idle showing under the delivery: ``breathe``
 *   (a -1..1 wave) and ``fade`` (its strength)
 * @param {number} [ctx.side=null] where the pitch's own release stands *across* the
 *   body, in the rig's own x (see `pitcherRelease`): the ask the profile has already
 *   solved the same anchor against, so the delivery the pose draws is the delivery the
 *   stride and the placement were read off. It is the arm's own reach and nothing of
 *   the feet's — the stance's line is the placement's (see `pitcherPlacement`).
 * @param {number} [ctx.settle=0] the body's own step down the mound it stands on, in
 *   the rig's own units: how far the surface under the delivery's finish stands below
 *   the plateau the stance was solved from (negative where the mound falls away, as
 *   it does). It is the caller's to read — the pose is a pure function of the rig and
 *   has no mound of its own — and the pose hands it in over the approach (see
 *   SETTLE_TRACK), so the body steps down the slope as it drives rather than dropping
 *   at the frame the shoes touch the dirt.
 * @returns {object} the driver's pose, plus ``ball``: where the ball is this
 *   frame, in the rig frame
 */
export function pitcherPose(t, ctx) {
  const {
    rig,
    hand = 'R',
    height = null,
    releaseTime = AUTHORED_RELEASE_TIME,
    stride = 1,
    idle = null,
    settle = 0,
    side = null,
  } = ctx
  const s = hand === 'L' ? -1 : 1
  // The ring's own side starts this frame empty: `forearmOf` carries the side it read
  // off the ball's own chord into the wrist's second pass, and that is the same *frame's*
  // pair — a side left over from the frame before is a feedback rather than a read, and
  // where the pole lies near the chord it answers on alternate frames: measured, the
  // hand standing 0.45 of a rig unit apart on two frames a five-thousandth of a second
  // apart at 1.288 s, which is the step the whip's own frames were showing. It is also
  // what keeps the pose a function of its arguments: read off the frame before, the same
  // clock drawn twice answers two ways (measured, the hand's line 5e-4 of a rig unit
  // apart on a repeat call), and a mirror of the delivery is then only as exact as the
  // order the two hands happened to be drawn in.
  _ringSide[0] = 0
  _ringSide[1] = 0
  _ringSide[2] = 0
  // The authored clock is the release-to-set one; a tuning that moves the release
  // moves the whole delivery by the same factor, so the release still lands on
  // the clock the app syncs the pitch to.
  const scale = releaseTime / AUTHORED_RELEASE_TIME
  const authored = clamp(
    scale > 1e-6 ? t / scale : t,
    TIMES[0],
    TIMES[TIMES.length - 1],
  )
  const release = pitcherRelease({
    rig,
    hand,
    height: height ?? rig.shoulder.y + 0.28,
    hipY: RELEASE_HIPS.hipY,
    drive: RELEASE_HIPS.drive * stride,
    // Where the pitch's own release stands across the body (see `pitcherRelease`):
    // the arm's own line at the release is read off this anchor, so a pitch thrown
    // off the rubber's own line releases off a hand that has come to its own lateral
    // rather than off the posture's own square one.
    side,
  })
  // The body's own carry of that line, on the clip's own clock, in the delivery's two
  // levers: the tilt the anchor solved is handed in over the *kick* (see TILT_TRACK) — the
  // trunk comes across over the leg the weight is on as the knee comes up over it — and
  // what it could not reach goes out with the *step* (see STEP_TRACK), on the drive's own
  // window: the back leg carries the body out and the front foot comes with the body it is
  // on, and the two levers are both standing through the throw. The *sink* is the pair's own geometry rather than a number of its own (see
  // `rollLift` and `stanceDip`): the pelvis comes up by what the roll carries the drive
  // socket down by and down by what the carry takes off the drive leg's own span, so the
  // drive leg stays a straight rod at every metre of it — slanted and nothing else, which
  // is the one thing the carry costs, and the sidestep's own extent is the lever that
  // angles it. It costs it while the shoe is *standing* on the rubber and not a frame
  // longer: the delivery carries the ankle up onto the swing from the release (see
  // PIVOT_RIDE_TRACK), and a swing foot is a place on the body rather than on the ground,
  // so the carry stops taking anything off the leg's span the moment the leg stops
  // standing on it — the tall body is the whole of what a pitcher's landing is, and a
  // sink carried through it would land him folded.
  const tiltTrack = trackAt(TILT_TRACK, TIMES, authored)
  const tilt = release.tilt * tiltTrack
  // ...and the roll the *pelvis' own height* is paid for, which is the same angle on the
  // drive's own clock (see TILT_LIFT_TRACK): the body rolls with the kick, and what the
  // legs are charged for it starts with the drive, so the two numbers part company over
  // the windup and are one from the fall on.
  const liftTilt = release.tilt * trackAt(TILT_LIFT_TRACK, TIMES, authored)
  const stanceTrack = trackAt(STEP_TRACK, TIMES, authored)
  const stanceAcross = release.stance * stanceTrack
  const ride = trackAt(PIVOT_RIDE_TRACK, TIMES, authored)
  // ...and the *sink* the pair of them costs the legs, which is the two levers' own
  // geometry: the carry takes the drive leg's span off the vertical and the lift stands
  // the pelvis back up by what the roll carried the drive socket down by (see `stanceDip`
  // and `rollLift`, the second of them on the drive's own clock — see TILT_LIFT_TRACK).
  const sink = stanceDip({ rig, lean: Math.abs(stanceAcross) }) * (1 - ride)
    - rollLift({ rig, tilt: liftTilt })
  // ...and both of them in the rig's own x, which is the frame the places *outside* the
  // release window are written in and so have to be carried by (see `trackRelease` below).
  const leanAcross = stanceAcross + release.tiltX * tiltTrack

  const at = {}
  for (const track of NUMBER_TRACKS) at[track.key] = trackAt(track.values, TIMES, authored)
  // ...and the *turn's* own clock on the chest's key: the trunk, the socket the arms hang
  // from, the shoulder plane and every place the keys wrote in the chest's frame read the
  // turn off this one number, so the gather lands in a single place rather than on each of
  // them (see TURN_GATHER_LEAD, and the note there for why the keys cannot hand it over).
  at.chestYaw += turnGathered(authored)
  // The pitch's own posture, applied to the release-window lean: the slot track says
  // which frames the pitch's own release has a say in — nought until the arm is
  // cocked, all of it from the cock through the follow-through, and eased back out
  // over the recovery — and what those frames are handed is the *release posture's*
  // own fold, blended in rather than shifted by a difference. The solved folds now
  // span a whole staff: a submarine's trunk is folded most of a right angle at the
  // release where an over-the-top arm's stands a shade past upright, and a shift of
  // that size would carry the window's authored shape clean off the body (a cock
  // key folded forward a third of the way would come back arched past its own rest).
  // So it is the weight that moves: nought leaves the authored key, one is the
  // posture's own fold, and the frames between are the blend (see SLOT_TRACK and
  // `releasePosture`).
  const slot = trackAt(SLOT_TRACK, TIMES, authored)
  // ...and the lean-in's own share, which is the *trunk's* clock rather than the arm's
  // (see LEAN_IN_TRACK): it comes out of the rocker rather than out of the cock, so the
  // fold the pitch is thrown from is walked onto the front foot across the whole of the
  // delivery's front half. The share the fold is read through is the greater of the two —
  // a frame is either inside the release window, or inside the walk — and the two hand over
  // at the plant, where the walk is withdrawn and the back leg's own tilt is what the fold
  // holds (see the walk's own note).
  const leanIn = trackAt(LEAN_IN_TRACK, TIMES, authored)
  // ...and the *fold's* own arrival, which the slot track's own ramp is the arm's side
  // of (see FOLD_ARRIVE): a trunk the plant left arched comes forward over the whole of
  // the whip rather than in the three frames between the plant and the cock, which is
  // what keeps the arch a shape the delivery stands in and the fall over it a motion the
  // throw is *made* of. The window it is read through is the slower of the two shares,
  // so nothing outside the fall moves.
  const arrive = trackAt(FOLD_ARRIVE_TRACK, FOLD_ARRIVE_TIMES, authored)
  const handed = slot < arrive ? slot : arrive
  const foldShare = handed > leanIn ? handed : leanIn
  // The arm's own straightness this frame, off the keys' own folds (see STRAIGHT_TRACK):
  // the release's chord across the window, and the cock's right angle at the top of it,
  // with the frames between them the ramp the throw straightens on.
  const armStraight = trackAt(STRAIGHT_TRACK, TIMES, authored)
  // ...and how much of the *sweep* this frame is on (see SWEEP_IN_TIME): the frames
  // the arm's own place is the throw's line rather than a place, handed to the driver
  // so that a line written off the pose's own estimate of its socket is realised at
  // the arm's own length rather than folded into it (see the arm output's ``sweep``).
  // The throw window is on the same terms from its very first frame — the arm raising
  // off the belt is the arm's own shape and not the ball's own place's: the frame's
  // ``straight`` ramps the elbow's fold down from its own 180° to the cock's right
  // angle (see STRAIGHT_TRACK), and a chord left to the ball's place instead would
  // fold the arm past that ramp mid-swing and open it again — measured before this,
  // the elbow bent to 94° at 1.17 s and came back to 82° at the plant, against a
  // ramp asking 53° and 80°. The line through the window is still the pose's own
  // (the ball's place, the pole's, the hand's own line): only the *length* is the
  // arm's.
  const sweepWindow = clamp((authored - SWEEP_WINDOW_IN) / (SWEEP_WINDOW_END - SWEEP_WINDOW_IN), 0, 1)
  const sweep = Math.max(
    clamp((authored - SWEEP_IN_TIME) / SWEEP_IN_HANDOVER, 0, 1),
    sweepWindow,
  ) * clamp((SWEEP_OUT_TIME - authored) / SWEEP_OUT_HANDOVER, 0, 1)
  // ...and how far the body gives the arm on the frames the ball is the pitch's (see
  // RELEASE_GRAZE): the allowance ramps up to the release's own frame and back down
  // after it, so the fold and the hand's own push come back in as the arm swings on.
  const graze = RELEASE_GRAZE
    * clamp((authored - (AUTHORED_RELEASE_TIME - RELEASE_GRAZE_IN)) / RELEASE_GRAZE_IN, 0, 1)
    * clamp((AUTHORED_RELEASE_TIME + RELEASE_GRAZE_OUT - authored) / RELEASE_GRAZE_OUT, 0, 1)
  // The trunk's own fold at the plate, as the pose holds it, beside the *lateral* the
  // pelvis carries (see ``leanAcross`` above): the two are different levers, and the
  // pose is the one place they meet. The finish's own share is read on its own, because
  // it is the part of the fold the *keys* were written without and so the part the arm's
  // places below have to be carried by (see the carry's own note).
  const keyedFold = at.lean + foldShare * (release.lean - at.lean)
    + FINISH_TILT * finishTiltAt(authored)
  const finishFold = holdFoldAt(keyedFold, authored)
  let fold = keyedFold + finishFold
  // ...and the hip the held fold is *paid* out of (see FINISH_SINK): the pelvis' own height
  // comes down with the share the fold is held at, so the knee gives under the trunk as it
  // comes over the foot rather than the sockets riding up off the legs the stance planted.
  // Nought wherever the fold's own share is — including the gather before the release, which
  // is the fold coming *off* the posture rather than a depth being carried, and so is a hip
  // the knee is standing on and not one it is giving up.
  const finishShare = holdShareAt(authored)
  const foldSink = FINISH_SINK * Math.max(0, finishShare)
  // ...and the share of the chest's own turn the head takes off its look (see
  // LOOK_PIN, which is read on its own clock).
  const look = trackAt(LOOK_TRACK, LOOK_TIMES, authored)
  // The release frame's own hand line is the *arm's*, written from the anchor rather
  // than authored: a straight arm's hand runs on down the line the arm reaches along
  // (see `writeReleaseArm`).
  const releaseArm = writeReleaseArm(rig, release, s)
  for (const track of VECTOR_TRACKS) {
    at[track.key] = track.values[0].map((_, axis) => (
      trackAt(track.values.map((v) => v[axis]), TIMES, authored)
    ))
  }
  const foot = {}
  for (const [index, track] of FOOT_TRACKS.entries()) {
    foot[track.key] = { flat: trackAt(FOOT_FLAT_TRACKS[index], TIMES, authored) }
    FOOT_PARTS[track.key].forEach((part, partIndex) => {
      foot[track.key][part] = trackAt(track.parts[partIndex], TIMES, authored)
    })
  }
  // The striding foot's own numbers with the body's carry written into them (see ``step``
  // above): the foot's place is authored in the *keys'* frame — the one frame in this
  // pose that mirrors its lateral by the hand a key is read on (see `leg`) — so the
  // carry, which is a number of the rig's own x, is mirrored into it the same way the
  // keys are, and the foot the leg is solved to is the foot the body has come to.
  const frontFoot = { ...foot.front, x: foot.front.x + s * stanceAcross }
  // ...and the same shift for the *drive* foot, on the frames the shoe is no longer
  // standing on the rubber ones (see PIVOT_RIDE_TRACK): the foot's own place is authored
  // in the frame the body stands in like the stride foot's, so once the delivery has
  // carried the body across, the foot it is carrying is carried with it — the leg keeps
  // the shape its own keys were authored with, whatever the pitch's ask was, and where it
  // lands is where the body it has to hold up is. Written in the keys' own frame and
  // mirrored the same way (see `leg`), like the stride foot's.
  const pivotFoot = { ...foot.pivot, x: foot.pivot.x + s * stanceAcross * ride }
  // ...and the lead shoe's own plant, read with this pitch's numbers at the frame the shoe
  // goes down (see FRONT_PLANT): what the body had come by on that frame is part of
  // where the shoe was put, and the sweep below anchors its arc on that place rather than
  // on this frame's, so the foot is not carried out with the body a second time.
  const plantAcross = release.stance * trackAt(STEP_TRACK, TIMES, FRONT_PLANT_TIME)
  // The clasp's own two tracks (see claspTracks), and the trail arm's own mirror of
  // the lead arm's elbow (see mirrorTracks), are written before they are read: they
  // are places in the rig frame like every other target, and the rig is what turns
  // them.
  const keyTilt = s * release.tilt
  if (HAS_CLASP) claspTracks(rig, keyTilt)
  mirrorTracks(rig, keyTilt)
  // ...and the release key's own pole turns with the pitch's line (see above), after
  // the mirror has filled the keys that carry no pole of their own.
  writeReleasePole(release, s, releaseArm.authored)
  // The places the tracks carry are places *on the body*, so they are carried with it:
  // the pelvis' own lean across the stance, and the sink it costs, are handed to the
  // tracks as the shift a key outside the release window rides by (see `trackRelease`).
  // Without it the arm reaches back across the lean to a place the body has left —
  // measured at the landing, with the lean held: 1.25 of the arm's own span, which the
  // driver answers by pulling the shoulder out of its socket.
  //
  // ...and the *follow-through's* own travel is the same kind of shift and is paid the
  // same way: the keys' arm places are places in the rig, written for a body that came to
  // rest on the frame it landed in — the drive used to be one number from the landing
  // out — and since the stride's plant was lengthened the pelvis goes on driving through
  // the follow-through (see the landing key and the hold's own keys). An arm asked for a
  // place the body has gone past is the hand left behind the chest it is falling over, so
  // the whole of the keys' own travel past the landing is handed to the tracks here, on
  // the same track the pelvis rides: a place outside the window is carried by what the
  // body has come by since it landed, and the arm keeps the shape the keys gave it while
  // the body goes on moving under it. (Not the *stride's* scaling — that is the `carry`
  // inside `trackRelease`, which is the delivery's own length; this is the follow-through
  // alone, and it is nought on every frame up to and including the landing.)
  //
  // ...and the *finish's* own fold is a carriage of its own, and it is paid here for the
  // same reason: the arm's places are places in the rig, and the whole of what the finish
  // does that the keys do not know about is the trunk turning over its hips by up to a
  // radian (see holdFoldAt). A place handed over as a *shift* travels with the socket and
  // goes on pointing where it pointed, so an arm carried that way stands in the world while
  // the chest turns under it: across the stand the glove's upper arm trails the chest by
  // 0.16 of its own direction between 1.9 s and the pause, and the trunk sweeps through the
  // mitt where the two cross — 17 mm inside it at 1.96 s against the driver's 12 mm bound,
  // with the ring's own clearance rule spent answering it (see the pose's glove pole below,
  // which is where the turn is paid).
  //
  // ...and the *turn* is a different carriage from the shift, and it is the one a *pole*
  // takes whole (see `rideShape`): a pole is a direction on the body the keys drew, so it
  // is turned from the turn that body stands at to the turn this frame's does, on every
  // frame the finish's fold is on.
  //
  // ...and the throwing arm takes it too, but on the *stand's* own clock rather than the
  // fold's (see `standShare` at the hand-over below): turned across the whole of the finish
  // it would carry the throw's own sweep off the frames it was authored on — measured, the
  // arm goes from 0.29 to 0.68 of its own travel between two frames of the fold's hand-over
  // and the crossing at 1.52 s moves 32 mm off the plate's line the keys draw it on. The
  // frames the arm's places are authored on are the *throw*, and what the ride is for is the
  // stand: from the crossing (1.54 s) out, the trunk rises under an arm the keys have already
  // thrown, and the arm rides it there.
  const followRide = Math.max(0, at.drive - LANDING_DRIVE) * stride
  const foldRide = finishFold === 0 ? [0, 0, 0] : (() => {
    const joint = torsoPivot(rig)
    // ...the *throwing* socket's own offset from the joint, lateral and all: the fold is taken
    // at the plate's line, so a socket a shoulder's half-width out from the midline does not
    // ride the same arc the midline point does once the body is a quarter-turn round.
    const offset = [s * rig.shoulder.halfWidth, rig.shoulder.y - joint.y, rig.shoulder.z - joint.z]
    const socketOf = (lean) => {
      const trunkAt = trunkLean(s * at.chestYaw, lean, s * at.leanSide + tilt)
      return turnVector(upperTurn(s * at.chestYaw, -trunkAt.leanX, -trunkAt.leanZ), offset)
    }
    const folded = socketOf(fold)
    // ...and the socket the driver builds hangs off a pelvis that has given up FINISH_SINK of
    // its height to stand the fold in (see the pose's own ``offsetY``): the arm rides that
    // with the rest of the body rather than standing out of the trunk it hangs from.
    folded[1] -= foldSink
    const flat = socketOf(fold - finishFold)
    return [folded[0] - flat[0], folded[1] - flat[1], folded[2] - flat[2]]
  })()
  // The turn the *keys'* body stands at, against this frame's own (see `rideShape`): the
  // frame every place they wrote was written in, and the pose's fold is the whole of what it
  // adds to a body it did not author.
  const keyedTrunk = trunkLean(s * at.chestYaw, fold - finishFold, s * at.leanSide + tilt)
  const keyedTurn = upperTurn(s * at.chestYaw, -keyedTrunk.leanX, -keyedTrunk.leanZ)
  // Scratch for the ride below: the one direction it is read through, the two offsets the
  // hand-over blends between, and the answer it writes.
  const _rideAt = [0, 0, 0]
  const _rideRidden = [0, 0, 0]
  const _rideKeyed = [0, 0, 0]
  const _rideDir = [0, 0, 0]
  const carried = [
    leanAcross + foldRide[0],
    foldRide[1],
    -followRide + foldRide[2],
  ]
  trackRelease(BALL_TRACK, release, s, authored, _ball, stride, carried)

  // The idle's own breath, under the delivery: it fades out as the windup takes
  // over rather than being switched off, so a pitcher waiting on the rubber is
  // moving in the same joint targets the delivery moves.
  if (idle && idle.fade > 0) {
    const w = idle.breathe * idle.fade
    at.hipY += 0.012 * w
    fold += 0.02 * w
    at.leanSide += 0.012 * w
    at.headPitch += 0.02 * w
  }

  const carry = releaseCarry(rig, hand)
  // The palm's own carry is what the *profile* placed the ball by; the throwing arm is
  // handed the release's own limit beside it (see RELEASE_ELBOW), and the reach that
  // limit adds comes back out of the hand's carry: the wrist stands the straighter
  // chord from the socket while the ball goes on riding the release point the body was
  // placed for (see the arm output below, which hands both the place and the carry to
  // the driver). Eased across the window the arm is handed the limit on (see
  // SLOT_TRACK), so the clasped windup keeps the palm the glove's own numbers are
  // written with.
  const reachGive = straightChord(rig.arm.upper, rig.arm.fore, armStraight)
    - straightChord(rig.arm.upper, rig.arm.fore)
  const handCarry = carry - reachGive * slot
  // `let` because the hand's own line is settled onto the forearm's own once the
  // socket is known (see below): the keys author it, and what the driver builds
  // the arm from is that line read down the forearm the hand hangs on, cocked
  // about the palm's own normal by the wrist's own schedule (WRIST_COCK).
  let aim = normalize(at.aim, s)
  // `let` because the glove's line is *carried by the lean's own turn* below (see the
  // note where it is written): the authored line is the chest's, and what the mitt
  // shows the plate is that line with the fold's tilt taken back off it.
  let gloveAim = normalize(at.gloveAim, s)
  // The glove's palm, as the direction it faces rather than the line the hand runs
  // along: the one turn of a hand a place and a line leave free, and the one the
  // delivery is read by (see the keys' own ``glovePalm``).
  const glovePalm = normalize(at.glovePalm, s)
  // The *throwing* hand's palm, which is a different question from the glove's: while the
  // hands are together the ball hand is turned into the mitt, so what the pose asks for
  // is the mitt's own facing (see the clasp below, and the arm output's ``palm``). Once
  // they have parted the hand is free, and what it should face is where the ball is
  // going — the plate — rather than the line the arm happens to run along. The two are
  // not the same direction and on a slot out to the side they are most of a right angle
  // apart: the release's arm is slung along the ground it was thrown over (see
  // ``pitcherRelease``'s own lateral, which puts the anchor well off the midline), while
  // the ball still leaves *at* the zone, so a palm asked to follow the arm's own line
  // would turn the wrist a quarter of a turn off the throw on the very frames the ball
  // is in the hand.
  //
  // What the palm faces is therefore the *plate's* own bearing at the release: the
  // anchor's lateral carried back to the plate's line over the pitch's own length, and
  // level. Written that way it is a direction in the rig's frame — what the driver's
  // ``palmFacing`` reads — and one the pose can hand over without knowing where on the
  // field its release point sits: the lateral is the anchor's own, and the depth is the
  // plate's (see RELEASE_TO_PLATE). The two hundredths of a rise in it are the strike
  // zone's own centre over that distance — a hand's width up from the ball's own height.
  //
  // The share of it this frame is turned to is the clasp's own or the keys' — the hand is
  // turned to one facing or the other, never half of neither (see the output's
  // ``palmMix``). The keys' facings are written for the right hand like the rest of the
  // table, so the bearing is carried back into that frame to stand beside them and the
  // answer is mirrored out again: that is the ``s`` the ``thrownPalm`` below is read
  // with, and why the bearing is written there and not here.
  const palmAsk = trackAt(PALM_ASK_TRACK, PALM_ASK_TIMES, authored)
  const thrownPalm = normalize(
    palmAt(authored, normalize([-release.x, 0.02, -RELEASE_TO_PLATE], s)), s,
  )
  // ...asked for as the clasp's palm *eased* into the ask across the frames the two
  // are handed over on: the hands part with the wrist still turned into the mitt it
  // was holding, and the twist comes round to the throw over the frame or two the arm
  // is coming over. The means of the two are what the ask is written on rather than
  // either place, so what crosses over is a wrist's own small turn and not a snap.
  const handPalm = normalize([
    glovePalm[0] + (thrownPalm[0] - glovePalm[0]) * palmAsk,
    glovePalm[1] + (thrownPalm[1] - glovePalm[1]) * palmAsk,
    glovePalm[2] + (thrownPalm[2] - glovePalm[2]) * palmAsk,
  ], 1)


  // The elbows are authored, like the ball, as *places* in the rig frame (see the
  // driver's open-arm solve: a pole reads only the direction from the shoulder to
  // it). The glove is held in front of the chest, so its own pole is written in the
  // chest's frame and measured off *its* socket — a pole is only a direction from
  // the socket the arm hangs from, and one measured off the other arm's would send
  // the glove's elbow across the chest. Both the frame and the socket are read off
  // the pose: the chest's turn, and the centre of the two sockets (the leaned
  // shoulder, moved by the pelvis' own height and its drive).
  const trunk = trunkLean(s * at.chestYaw, fold, s * at.leanSide + tilt)
  const turn = upperTurn(s * at.chestYaw, -trunk.leanX, -trunk.leanZ)
  /**
   * A direction of the *keys'* body, turned onto this frame's (see the ride's own note at
   * the fold below): the turn the keys' body stands at is undone and this frame's put on,
   * which is the chest's own rotation over the hold and nothing else. Nought of it while the
   * two turns are one — the whole of the delivery up to the point the finish's fold lifts —
   * so nothing the keys authored through the fall is touched.
   *
   * @param {number[]} dir a direction or an offset in the rig frame (written in place)
   * @returns {number[]} ``dir``
   */
  const rideShape = (dir) => {
    if (finishFold === 0) return dir
    unturnVector(keyedTurn, dir, _rideAt)
    turnVector(turn, _rideAt, dir)
    return dir
  }
  // ...and the glove arm *carried by the lean's own turn*: its place and its line are
  // authored in the chest's frame (``local``/``aimLocal`` below) and the palm in the
  // rig's — where the pitch goes — so the fold turns the whole arm by the lean's own
  // degrees while the palm stands still, and a palm can only be rolled about the hand's
  // own line. Two promises spend each other here: the mitt shows the plate (the line
  // square to the facing asked for, so the roll can reach it) and the palm is *rolled*
  // onto the plate rather than the wrist *pointed* at it (the line still hangs off its
  // own forearm). Carrying the line alone turned the hand to the plate by bending the
  // wrist off its forearm (measured: 72° — the palm pointed, not rolled). So the whole
  // arm rides the lean's own fold taken back off it — place and line together, the
  // inverse of the two folds ``turn`` carries, yaw and everything else untouched — and
  // the forearm turns with the line, which keeps the hand's roll relationship to it
  // while the trunk folds under a mitt that stays turned to the hitter. This is what
  // lets a way-more-obvious arch and a plate-facing mitt coexist rather than one
  // spending the other.
  // ...carried by a *share* of that fold, not the whole of it: the three promises the
  // suite reads on a mitt — the palm on the plate, the palm *rolled* there rather than
  // the wrist pointed, and the roll reaching the facing the pose asked for — pull the
  // hand's line two ways. Carrying the fold off the arm all the way turns the mitt square
  // to the plate but carries it past the authored ask (the roll's floor is the ask's own
  // angle to the hand's line, and squaring the line to the plate lifts that angle out of
  // the palm's reach: measured 42° short at the whole carry, against 18° at none). The
  // share below is where all three read under their bounds together — the plate within
  // the palm's reach, the wrist still rolled rather than pointed, and the ask still on
  // the palm's own roll-circle — on a trunk that keeps the deep arch under all of it.
  // ...carried only once the break has parted the hands: while they are clasped the ball
  // sits in the mitt and the two hands are one place, so turning the glove's line to the
  // plate would drag its palm off the ball the clasp is holding (see the clasp's own read).
  // The carry is therefore inert through the clasp and eases in across the break, where the
  // mitt is free to turn to the hitter under a trunk that keeps the deep arch.
  const GLOVE_LEAN_CARRY = 1
  // ...but only *after* the break, and only while the ball is *out* of the mitt: through
  // the clasp and the whole of the windup the carry is inert (the two hands are one grip
  // and the ball is in the mitt — moving the glove's frame then would lift the ball out of
  // it and lift the glove with the elbow, see the windup's own rise read), and it walks in
  // over 1.13-1.18 so that by the plant, where the lean is deepest, the carry is whole and
  // the roll has its room back. The ``1 - claspShare`` is what closes the *loop*: the clip
  // ends in the set it began in, the ball back in the mitt, so a carry that stayed lit to
  // the end would leave the hand (and the ball it holds) half a lean off the place the set
  // wrote — the delivery would snap back into its stance between pitches (see the unit
  // suite's own loop read, ``close.ball`` against ``open.ball``).
  const carryShare =
    GLOVE_LEAN_CARRY * clamp((authored - 1.13) / 0.05, 0, 1) *
    (1 - trackAt(CLASP_TRACK, TIMES, authored))
  const leanCarry = upperTurn(0, -carryShare * trunk.leanX, -carryShare * trunk.leanZ)
  const carryByLean = (v) => unturnVector(leanCarry, v)
  gloveAim = carryByLean(gloveAim)
  const gloveLocal = carryByLean([s * at.glove[0], at.glove[1], at.glove[2]])
  // ...and swung out of the chest by the width the deeper fold takes away (see
  // GLOVE_SWING): spent as a turn about the chest's own forward axis, so the arm keeps
  // its reach while the ring gets its clear arc back. Its own clock walks in across the
  // whip and *holds* the whole of the pause, rather than decaying with the fold: what it
  // answers is a body folded over a mitt, so it is owed for as long as the fold is held —
  // and a swing still easing out through the hold is the arm still settling (measured,
  // 2.1 mm of the glove's own shape between 1.98 s and 2.08 on the fold's own share).
  const gloveSwingShare = (() => {
    if (authored <= AUTHORED_RELEASE_TIME || authored >= FINISH_RIDE) return 0
    if (authored >= FINISH_STAND_FROM && authored <= HOLD_END_TIME) return 1
    if (authored < FINISH_STAND_FROM) {
      const u = (authored - AUTHORED_RELEASE_TIME) / (FINISH_STAND_FROM - AUTHORED_RELEASE_TIME)
      return u * u * (3 - 2 * u)
    }
    const u = (authored - HOLD_END_TIME) / (FINISH_RIDE - HOLD_END_TIME)
    return 1 - u * u * (3 - 2 * u)
  })()
  const gloveSwing = -s * (GLOVE_SWING * gloveSwingShare)
    / (Math.hypot(gloveLocal[0], gloveLocal[1], gloveLocal[2]) || 1)
  const gloveX = gloveLocal[0] * Math.cos(gloveSwing) - gloveLocal[1] * Math.sin(gloveSwing)
  gloveLocal[1] = gloveLocal[0] * Math.sin(gloveSwing) + gloveLocal[1] * Math.cos(gloveSwing)
  gloveLocal[0] = gloveX
  const throwLocal = carryByLean([s * (at.glove[0] - 2 * rig.shoulder.halfWidth), at.glove[1], at.glove[2]])
  // The look's own two angles, solved rather than authored: two directions of the rig frame
  // — the one that lands *level* on the plate (the rig's own -z, which is where the strike
  // zone is) and the one the stance stands in (STANCE_LINE) — each carried back through the
  // very turn the chest is holding this frame, so the eyes are on the line that is asked for
  // whatever the shoulders are doing under them and are *level*, rather than a head riding
  // the trunk's fold down the way the fold goes.
  // One solve for the pair, because the neck's yaw and nod are one answer: the yaw
  // a folded chest needs to hold a *bearing* is not the chest's own turn (measured
  // off the realised skeleton, the fold is worth seven degrees of the bearing on the
  // release frame), and a nod authored next to it cannot know what the fold has
  // already done to it. What the pose's own answer is worth is a third of a degree
  // — see the browser suite's reading of the realised head against this one — and
  // what the authoring it replaces was worth is 35° of gaze pointing at the dirt the
  // pitch was thrown over.
  const pinned = unturnVector(turn, [0, 0, -1], _pinned)
  const pinnedYaw = Math.atan2(-pinned[0], -pinned[2])
  const pinnedPitch = Math.asin(clamp(pinned[1], -1, 1))
  // ...and how much of that the neck can hold. ``pinned`` is the plate's own direction read
  // *in the chest's frame*, so the angle it makes with that frame's -z is exactly how far
  // off the head's own straight-ahead the pin would turn the neck — the chest's turn and
  // fold as the neck has to answer for them. Past the look's own limit that is a head turned
  // inside its own shoulders, so the pin is dropped rather than held: the head stops
  // tracking the zone and the shoulders carry it (see LOOK_SEPARATION_MAX).
  const separation = Math.acos(clamp(-pinned[2], -1, 1))
  const tracked = look * headTrackShare(separation)
  // The stance's own solve, beside the pin's: the line the set stands in (STANCE_LINE), read
  // in this frame's chest. It is what the head holds through the windup — the same pair of
  // angles solved for a direction, so what the neck turns there is the coil and nothing of
  // the plate — and the two are one hand-off across the drive (see STANCE_PIN).
  const stance = unturnVector(turn, STANCE_LINE[s], _stance)
  const stanceYaw = Math.atan2(-stance[0], -stance[2])
  const stancePitch = Math.asin(clamp(stance[1], -1, 1))
  const hold = trackAt(STANCE_TRACK, STANCE_TIMES, authored)
  // Where the chest's own centre is at this frame: the shoulder's rest offset from
  // the hip pivot, carried by the same turn — the driver rotates the pelvis about
  // that pivot by exactly this rotation, so the pose's own reads (the glove's socket,
  // the clasp's palm, the release anchor) sit on the body the driver builds rather
  // than on an estimate of it.
  const chestAt = turnVector(turn, [
    0,
    rig.shoulder.y - rig.hip.y,
    rig.shoulder.z - rig.hip.z,
  ])
  // The hip pivot the turn happens about is on the body's own centre line, and the
  // shoulder's rest offset is measured from it (see measurePlayerRig's rig.hip).
  // ...and the body's own carry and the sink the pelvis pays for it carry it, exactly as
  // they carry the driver's body (see `pitcherRelease`): the chest, the glove's socket and
  // the clasp's palm are one body, so a read that misses the carry puts the two hands a
  // step apart — half a foot of leather at the metres this delivery can ask for. The
  // *roll* is already in the turn the offset above is carried by, so what is left here is
  // the translation and the pelvis's own height (see the pose's ``offsetX``/``offsetY``).
  chestAt[0] += stanceAcross
  chestAt[1] += rig.hip.y + at.hipY - sink - foldSink
  chestAt[2] += rig.hip.z - at.drive * stride
  // The glove's own socket: the chest's centre out along the chest's lateral, which
  // is what the chest's turn does to the half-width it sits at.
  const gloveShoulder = turnVector(turn, [-s * rig.shoulder.halfWidth, 0, 0])
  gloveShoulder[0] += chestAt[0]
  gloveShoulder[1] += chestAt[1]
  gloveShoulder[2] += chestAt[2]
  // And its elbow: an authored place in that same frame, read from that same socket
  // (see GLOVE_ELBOW_TRACK) — the pole the driver's solve reads is only the
  // direction from the socket to it, so what a key authors is which way the upper
  // arm hangs, and the glove's own place is what the arm reaches for.
  const gloveElbowAt = GLOVE_ELBOW_TRACK[0].map((_, axis) => (
    trackAt(GLOVE_ELBOW_TRACK.map((point) => point[axis]), TIMES, authored)
  ))
  const gloveElbow = turnVector(turn, [
    s * gloveElbowAt[0],
    gloveElbowAt[1],
    gloveElbowAt[2],
  ])
  // ...carried with the place it is read from (see `rideShape`): a pole is only the
  // direction the ring is read on, so it turns with the arm it belongs to.
  rideShape(gloveElbow)
  gloveElbow[0] += gloveShoulder[0]
  gloveElbow[1] += gloveShoulder[1]
  gloveElbow[2] += gloveShoulder[2]

  // The ball rides the chord of the arm this frame asks for — the *wrist* the frame asks
  // for, and the chord that arm can hold. A chain bent by ``straight`` spans that chord
  // and no more (a right angle of bend is most of a hand's span shorter than a straight
  // one) and the driver holds the wrist to it: an ask past the chord is answered by the
  // arm brought back along its own line, and the ball the driver draws is carried off the
  // wrist it *reached*. So a ball placed outside the chord is a ball the pose's own number
  // does not hold — the pose's ball is carried out toward the release's own place before
  // the arm has straightened to it, while the arm is still folded up behind the shoulder
  // on the bend the same frame asks for. Measured at the high cock, the drawn ball stood
  // 12.6 cm off the pose's on the harness pitch and 32 cm on the game's wide one; with the
  // ball on the chord it stands 0.4 mm and 0.5 mm off them (1.26 s, the centred pitch and
  // the wide one — see the suite's own delivery test).
  //
  // ...and the chord is the one the *driver* holds, which is not the chord the pose would
  // take on its own: the driver reads its stretch off the hand it is given rather than off
  // the place the pose wrote (see the open-arm solve), so a reach the driver can answer
  // with its own arm is answered by the arm's own chord, and only a reach past the arm's
  // own span buys the bones the reach itself stretches (see ARM_STRETCH_MAX). Read any
  // other way the pose promises a hand the driver's clip then pulls back off it: answering
  // with the pose's own stretch instead still left 5.5 cm on the centred pitch at 1.28 s
  // and 11.3 cm on the wide one at 1.26 s.
  //
  // The socket the read is taken from is *the pose's own*, which is the pivot's own
  // offset rather than the chest's centre — the read the release anchor itself is built
  // from (see `releaseShoulder`), because a socket taken off the hip sockets instead of
  // the pivot the driver hinges the upper body on stands a couple of centimetres off the
  // joint the arm really hangs from — and a couple of centimetres is more than a release
  // may be moved by. And because it *is* an estimate, the pose leaves the body a whisker
  // of the reach (ARM_KEEP_SHARE): the body's own socket stands a centimetre from the
  // estimated one at the cock on both pitches (measured along the ask: 7.6 mm on the
  // centred pitch at 1.26 s, 7.2 mm on the game's wide one), and a hand asked for the very
  // chord is a hand the driver's clip still pulls back by exactly that centimetre. Where
  // the ask is already inside the reach the driver holds — the clasped windup, and every
  // frame the authored arm can hold — this is the authored place outright.
  const armPivot = torsoPivot(rig)
  const throwingSocket = turnVector(turn, [
    s * rig.shoulder.halfWidth,
    rig.shoulder.y - armPivot.y,
    rig.shoulder.z - armPivot.z,
  ])
  throwingSocket[0] += stanceAcross
  throwingSocket[1] += armPivot.y + at.hipY - sink
  throwingSocket[2] += armPivot.z - at.drive * stride
  const ball = [_ball[0], _ball[1], _ball[2]]
  trackRelease(ELBOW_TRACK, release, s, authored, _elbow, stride, carried)
  // ...and where the arm's side is authored as a *side* rather than as a place — the fall,
  // the lift and the layback — the elbow hangs off that direction instead (see `poleAt`):
  // the track's own share is whole inside its window and eased in over the first couple of
  // frames, so the part key's own place still rules the frame the hands let go on.
  const poleShare = authored >= POLE_FIRST - 1e-9 && authored <= POLE_LAST + 1e-9
    ? clamp((authored - POLE_FIRST) / POLE_HANDOVER, 0, 1)
    : 0
  if (poleShare > 0) {
    poleAt(authored, _poleDir)
    const poleLength = Math.hypot(s * _poleDir[0], _poleDir[1], _poleDir[2]) || 1
    // The place's own direction, which the track hands over from on its first frames.
    directionOf(_elbow, throwingSocket, _placeDir)
    const share = poleShare
    for (let axis = 0; axis < 3; axis += 1) {
      const authoredDir = (axis === 0 ? s : 1) * _poleDir[axis] / poleLength
      _poleOut[axis] = _placeDir[axis] + (authoredDir - _placeDir[axis]) * share
    }
    const held = Math.hypot(_poleOut[0], _poleOut[1], _poleOut[2]) || 1
    for (let axis = 0; axis < 3; axis += 1) {
      _elbow[axis] = throwingSocket[axis] + (_poleOut[axis] / held) * POLE_REACH
    }
  }
  // ...and from the hands parting the arm's side is authored as a *turn* rather than as a
  // place (see `swivelAt`): the windup's own arm held on for the hesitation, then one turn the
  // whole way to the cock's own arm, and from there the whip continues the same turn to the
  // release's. Every frame of it is one place on the socket's own sphere, so the elbow sweeps
  // the ring the arm is hinged on rather than being carried across it.
  // ...and from the hands parting the arm's side is authored as a *turn* rather than as a
  // place (see `swivelAt`): the arm lifted onto the hold, stood on for the hesitation, and
  // then one accelerating turn round the shoulder that points the elbow down and brings it
  // back into the plane the shoulders draw. Every frame of it is one place on the socket's
  // own sphere, so the elbow sweeps the ring the arm is hinged on rather than being carried
  // across it.
  if (authored >= SWIVEL_FROM - 1e-9 && authored <= AUTHORED_RELEASE_TIME + 1e-9) {
    if (authored <= SWIVEL_END + 1e-9) {
      swivelAt(authored, _poleDir)
      const swivelLength = Math.hypot(s * _poleDir[0], _poleDir[1], _poleDir[2]) || 1
      for (let axis = 0; axis < 3; axis += 1) {
        _elbow[axis] = throwingSocket[axis]
          + ((axis === 0 ? s : 1) * _poleDir[axis] / swivelLength) * POLE_REACH
      }
    } else {
      // ...and the whip turns from the cock's own arm — the pole track's own last key, which
      // is the arm the swivel has just arrived on — to the release's, the short way round the
      // socket's own sphere: one arm either side of the hand-over, where the keys used to
      // park it.
      poleAt(SWIVEL_END, _poleEnd)
      const cockLength = Math.hypot(s * _poleEnd[0], _poleEnd[1], _poleEnd[2]) || 1
      for (let axis = 0; axis < 3; axis += 1) {
        _poleStart[axis] = (axis === 0 ? s : 1) * _poleEnd[axis] / cockLength
      }
      trackRelease(ELBOW_TRACK, release, s, AUTHORED_RELEASE_TIME, _swivelPlace, stride, carried)
      directionOf(_swivelPlace, throwingSocket, _swivelRelease)
      whipPole(_elbow, throwingSocket, authored, _poleStart, _swivelRelease)
    }
  }
  // ...and *now* the hand's own line can be the forearm's own (see `forearmOf`):
  // a wrist's angle is the hand's line off the forearm's, the forearm's line is
  // the driver's to say — it is the ring its own two bones draw about the chord,
  // on the pole's own side of it — and the pose's own model of that ring is this.
  // The aim the keys author is replaced by the forearm's line wherever the
  // schedule's cock is nought (the hand running on down the arm it hangs on, the
  // palm/forearm joint at its own 180°) and by that line swung back about the
  // palm's own normal wherever the schedule cocks it (the joint opening *past*
  // 180°, the hand drawn back toward the back of the hand). Settled against the
  // wrist's own place — the ball less the carry down the hand's line — three
  // times over, because each is the other's input: the line moves the wrist it
  // is read from.
  const wristCock = trackAt(WRIST_COCK_TRACK, WRIST_COCK_TIMES, authored)
  // Seeded off the *ball* rather than the keys' own lines: the hand's line runs on
  // past the wrist to the ball, so a forearm read to it is the answer already bar
  // the carry's own lean on it — and the carry is a third of the forearm's own
  // length, so a seed read off a stale key line walks in slowly enough that three
  // passes leave most of a right angle standing on the frames whose keys were
  // never close (measured: the come-through's own ask stood 87° off the forearm it
  // hung on before this seed).
  // Scoped to the window the hand's own line is the forearm's own *question* — the
  // break to the release — and faded either side of it into the keys' own lines: the
  // clasped windup's hand is the glove's own mirror (its line is a mitten's, not a
  // forearm's), and the sweep's own frames are written as the throw's own line and
  // held to the last thousandth of a rig unit by the tests that read them. What this
  // hands the driver is the hand's line where the wrist's own angle is the question,
  // and the keys' own everywhere their line is.
  const armAsk = normalize(at.aim, s)
  const windowAsk = clamp((authored - ARM_ASK_IN) / (ARM_ASK_FULL - ARM_ASK_IN), 0, 1)
    * clamp((ARM_ASK_OUT - authored) / (ARM_ASK_OUT - ARM_ASK_FADE), 0, 1)
  // The upper arm's own rule, applied to the elbow's place before the arm is read off
  // it (see `holdUnderShoulders`): the plane is the chest's own, square to the up axis
  // the trunk is standing on, and the chord is the arm's line to the ball.
  // ...and the plane itself is the one the shoulder *line* lies in rather than the
  // chest's own rolled one: the trunk's fold and its yaw, with the throw-side roll left
  // out of the normal. That is the plane a slot is read against — the line between the
  // two sockets, tilted fore and aft by the lean the body is throwing from — and it is
  // the roll that makes the difference. A sidearmer's trunk rolls toward the throwing
  // side so that the shoulder the arm hangs from stands *lower* than the other; measured
  // off the rolled chest, an arm swung out level over that shoulder is "above" its plane
  // on every frame of a low slot, which is not a shape anyone can watch for — the arm is
  // level, the body is tilted. Read off the fold alone, the same arm is level with the
  // line it is supposed to be level with, and the arch is what the plane tilts with.
  const planeUp = turnVector(upperTurn(s * at.chestYaw, -trunk.leanX, 0), [0, 1, 0], _planeUp)
  const planeHold = clamp((authored - SHOULDER_PLANE_IN) / (SHOULDER_PLANE_FULL - SHOULDER_PLANE_IN), 0, 1)
    * clamp((SHOULDER_PLANE_END - authored) / (SHOULDER_PLANE_END - SHOULDER_PLANE_OUT), 0, 1)
  if (planeHold > 0) {
    const lineLength = Math.hypot(
      ball[0] - throwingSocket[0], ball[1] - throwingSocket[1], ball[2] - throwingSocket[2],
    ) || 1
    _armLine[0] = (ball[0] - throwingSocket[0]) / lineLength
    _armLine[1] = (ball[1] - throwingSocket[1]) / lineLength
    _armLine[2] = (ball[2] - throwingSocket[2]) / lineLength
    holdUnderShoulders(_elbow, throwingSocket, _armLine, planeUp, planeHold)
  }
  forearmOf(throwingSocket, ball, _elbow, rig.arm.upper, rig.arm.fore, armStraight, sweep, _foreArm)
  aim = normalize(_foreArm, 1)
  // ...and one refinement off the wrist that line leaves: the carry is the ball's
  // own lean down the hand's line, and a hand's line drawn on past the wrist to the
  // ball is already the forearm's — what the carry leans on it is a couple of
  // centimetres of wrist and a degree or two of forearm. One pass and no more,
  // because the wrist's place leans on the aim and the aim on the wrist: walked
  // round, that circle keeps two answers on the come-through and steps between
  // them a frame apart (measured: the hand's own place stepped 0.47 of a unit).
  {
    _wristHere[0] = ball[0] - aim[0] * handCarry
    _wristHere[1] = ball[1] - aim[1] * handCarry
    _wristHere[2] = ball[2] - aim[2] * handCarry
    forearmOf(throwingSocket, _wristHere, _elbow, rig.arm.upper, rig.arm.fore, armStraight, sweep, _foreArm)
    // The cock is the hand drawn *back* off the forearm: swung toward the back of
    // the hand, which is the palm's own facing the other way round. The palm's
    // ask stands square to the hand's line by construction, so what it leaves
    // free is exactly this turn (see the driver's `palmFacing`) and the only
    // question is which way up it is answered — the back of the hand is the
    // palm's negation, taken off the forearm's line and turned down it.
    const dorsal = normalize([
      -(handPalm[0] - _foreArm[0] * (handPalm[0] * _foreArm[0] + handPalm[1] * _foreArm[1] + handPalm[2] * _foreArm[2])),
      -(handPalm[1] - _foreArm[1] * (handPalm[0] * _foreArm[0] + handPalm[1] * _foreArm[1] + handPalm[2] * _foreArm[2])),
      -(handPalm[2] - _foreArm[2] * (handPalm[0] * _foreArm[0] + handPalm[1] * _foreArm[1] + handPalm[2] * _foreArm[2])),
    ], 1)
    _cockedAim[0] = _foreArm[0] * Math.cos(wristCock) + dorsal[0] * Math.sin(wristCock)
    _cockedAim[1] = _foreArm[1] * Math.cos(wristCock) + dorsal[1] * Math.sin(wristCock)
    _cockedAim[2] = _foreArm[2] * Math.cos(wristCock) + dorsal[2] * Math.sin(wristCock)
    aim = normalize(_cockedAim, 1)
  }
  if (windowAsk < 1) {
    aim = normalize([
      aim[0] * windowAsk + armAsk[0] * (1 - windowAsk),
      aim[1] * windowAsk + armAsk[1] * (1 - windowAsk),
      aim[2] * windowAsk + armAsk[2] * (1 - windowAsk),
    ], 1)
  }
  const askedOut = [
    ball[0] - aim[0] * handCarry - throwingSocket[0],
    ball[1] - aim[1] * handCarry - throwingSocket[1],
    ball[2] - aim[2] * handCarry - throwingSocket[2],
  ]
  const asked = Math.hypot(askedOut[0], askedOut[1], askedOut[2])
  const armSpan = rig.arm.upper + rig.arm.fore
  // The chord the pose would take on its own: the bones at the stretch the ask is worth —
  // and never *past* the window's own share of it, which is handed back to the arm's own
  // length on its own frames (see STRETCH_TRACK): where a frame is inside the throw's own
  // line, the reach the ask is answered with is the window's chord and the schedule's, and
  // the ask's own distance is not part of the delivery's shape at all. Read off the ask
  // alone, the chord falls wherever the ask crosses it — which on the window's last frames
  // is the frame the fold's own shorter places begin to be read, and that frame is the
  // snap the schedule is bought against (see the numbers there). A frame at the release
  // itself is unaffected either way: its own place is the anchor, which sits inside the
  // hold of the window's own chord and is handed through bit-exact (see ``pitcherRelease``).
  const windowStretch = trackAt(STRETCH_TRACK, STRETCH_TIMES, authored)
  const stretch = Math.min(clamp(asked / armSpan, 1, ARM_STRETCH_MAX), windowStretch)
  const chord = straightChord(rig.arm.upper * stretch, rig.arm.fore * stretch, armStraight)
  // ...and the chord the driver holds off that ball, read the way the driver reads it:
  // its stretch off the reach it is handed (which is this chord, not the ask), and its
  // bend off the arm the frame asks for. A reach inside the arm's own span is answered
  // by the arm's own chord and no more, so the two reads are pulled together here — and
  // the difference between them is what the drawn ball was off by.
  const given = clamp(chord / armSpan, 1, ARM_STRETCH_MAX)
  const held = Math.min(chord, straightChord(
    rig.arm.upper * given, rig.arm.fore * given, armStraight,
  ))
  // ...less the pose's own whisker of the span, which is what the body's rules cost it:
  // the release's own anchor asks for the chord itself (see ASK_WHISKER), and the whisker
  // is left out of the *answer* rather than out of the ask, so an ask at the chord — the
  // release, and every anywhere-near-straight arm — is inside the reach held and the
  // anchor is not moved by the whisker at all.
  const reachHeld = held - armSpan * ARM_KEEP_SHARE
  // ...and where the ask stands *past* the reach the pose holds, the whisker comes back
  // in over the ask's own overshoot rather than all at once. A switch spends the whole of
  // it on the frame the ask drops inside the chord, and the hand's own track carries the
  // step: measured on the realised skeleton at the follow-through's hand-over — the one
  // place in the delivery where an authored ask falls out of the arm's own stretch and
  // into it slowly enough to read — the hand fell 24 mm on the frame the clamp let go
  // against 11 mm on the frames either side of it, and the turn back up out of that frame
  // is what the arm's own sweep read wrong with. Eased, the answer meets the ask where
  // the two arrive at the chord together (the whisker is whole at the crossing, so an ask
  // *at* the chord — the release's own anchor, which sits inside ASK_WHISKER of it — is
  // still answered with the ask itself) and is only a tenth of a millimetre longer than
  // the held reach on an ask written a whole span past the arm, which is every frame of
  // the release window.
  if (asked - held > ASK_WHISKER) {
    const over = asked - held - ASK_WHISKER
    const whisker = armSpan * ARM_KEEP_SHARE
    const reach = reachHeld + whisker * (whisker / (over + whisker))
    for (let axis = 0; axis < 3; axis += 1) {
      ball[axis] = throwingSocket[axis] + askedOut[axis] * (reach / asked) + aim[axis] * handCarry
    }
  } else if (sweep > 0 && authored > AUTHORED_RELEASE_TIME && asked > 1e-6) {
    // The chord is the driver's own, read off the bones at the stretch a *short* ask
    // leaves them (one: an ask inside the chord is never a stretched one).
    const shortChord = straightChord(rig.arm.upper, rig.arm.fore, armStraight)
    if (asked < shortChord - ASK_WHISKER) {
      // ...and the same rule read the other way, which is where the *sweep* is on: an
      // ask that is shorter than the arm's own chord is answered at the chord — the line
      // is the pose's and the length is the arm's (see `forearmOf`, and the driver's own
      // open-arm solve, which carries a short ask out to it exactly this much) — so the
      // promise has to be that answer rather than the ask. Written as the ask's place it
      // handed the driver a ball its own arm would not stand on, and the space between
      // the two was the *fold's* own: measured on the realised skeleton, the pose
      // promised a ball 0.41 of a rig unit from the socket through the hold's fold while
      // the arm answered at its 0.60 chord — 0.19 apart at 1.58s, and 0.03 of one at
      // 1.62s. Promised as the answer, the same frames read 3.4 mm at 1.62s and 10 mm at
      // their worst (the 1.6275-1.645 stretch), which is the centimetre the driver's own
      // socket stands from the pose's estimate.
      //
      // The release's own frame is left out and the rule is eased in over the two
      // hundredths of a second after it: that frame's place *is* the anchor the pitch is
      // flown from (see `pitcherRelease`), and on a wide pitch the pose's own socket
      // estimate stands far enough from the body's that the ask reads short of the chord
      // there — the anchor is handed through bit-exact rather than moved by an
      // estimate's error.
      const pushShare = clamp((authored - AUTHORED_RELEASE_TIME) / 0.02, 0, 1)
      const answer = asked + (shortChord - asked) * sweep * pushShare
      for (let axis = 0; axis < 3; axis += 1) {
        ball[axis] = throwingSocket[axis] + askedOut[axis] * (answer / asked) + aim[axis] * handCarry
      }
    }
  }


  // The clasp at *this* frame — the ball in the glove's own palm and the throwing
  // hand's own line the glove's own. The tracks above already put the two together
  // *at* the keys, but between them the two hands are read through different frames
  // (the throwing hand's place is a place in the rig frame, and the glove's is the
  // chest's own, turned by the frame this pose is holding), and a chest that turns a
  // couple of degrees over a segment walks them a centimetre or two apart — which is
  // the grip showing. So inside the window the ball is read off the glove's *live*
  // numbers instead, and what the tracks carry is where that window begins and ends.
  const claspedWeight = trackAt(CLASP_TRACK, TIMES, authored)
  // ...eased out in the two frames after the parting (see PART_FADE) rather than across
  // the whole segment to the next key: the hands let go on the frame they stop lifting,
  // and what follows is the throw's own.
  // ...and the fade reaches no further than its own window: past it the *track* is
  // the weight again — the clasp opens over the fall and closes again into the set at
  // the clip's own end, and a fade that stayed lit would leave the delivery's last
  // frame empty-handed (see the unit suite's loop read).
  const partFade = HAS_PART && authored >= PART_TIME && authored < PART_TIME + PART_FADE
    ? 1 - (authored - PART_TIME) / PART_FADE
    : 1
  const clasped = claspedWeight * partFade
  if (clasped > 0) {
    // The glove's own line, carried into the rig frame: the glove is authored in the
    // chest's, so this is also the line the throwing hand takes.
    const line = turnVector(turn, gloveAim)
    const palm = turnVector(turn, [
      s * (at.glove[0] - rig.shoulder.halfWidth),
      at.glove[1],
      at.glove[2],
    ])
    palm[0] += chestAt[0] + line[0] * carry
    palm[1] += chestAt[1] + line[1] * carry
    palm[2] += chestAt[2] + line[2] * carry
    // ...and written as the two ends' own weighted sum rather than as a step off one
    // of them: `a + (b - a)·w` is a ``w``-th of the way from ``a`` to ``b`` in real
    // numbers, but at ``w`` = 1 it lands a bit beside ``b`` — and the clip's own wrap
    // reads the last frame against the first (see the unit suite's loop read), where
    // one end is the clasp held whole and the other is the tracks' own place.
    for (let axis = 0; axis < 3; axis += 1) {
      ball[axis] = ball[axis] * (1 - clasped) + palm[axis] * clasped
      aim[axis] = aim[axis] * (1 - clasped) + line[axis] * clasped
    }
    // A mixture of two unit lines is not a unit line, so it is normalized the way
    // the tracks' own mixtures are.
    const length = Math.hypot(aim[0], aim[1], aim[2]) || 1
    aim[0] /= length
    aim[1] /= length
    aim[2] /= length
  }

  // And the trail arm at *this* frame is the lead arm's own mirror (see the track
  // above), for the same reason and in the same way: the two agree at the keys, and
  // between them the two elbows are read through different frames — the glove's off
  // its own socket in the chest's frame and the throwing arm's as a place in the
  // rig's — so a chest that turns a couple of degrees over a segment walks them a
  // centimetre or two apart, which is the trailing elbow hanging at its own height
  // instead of the glove's. Inside the window it is read off the glove's *live*
  // elbow instead, and what the track carries is where the window begins and ends.
  const mirroring = trackAt(MIRROR_TRACK, TIMES, authored)
  if (mirroring > 0) {
    // The mirror is about the body's own midline: the chest's centre and the lateral
    // axis the two sockets sit on, so the other arm's share of it is that axis'
    // distance negated and the other two axes left alone.
    const lateral = turnVector(turn, [s, 0, 0])
    const away = [
      gloveElbow[0] - chestAt[0],
      gloveElbow[1] - chestAt[1],
      gloveElbow[2] - chestAt[2],
    ]
    const along = away[0] * lateral[0] + away[1] * lateral[1] + away[2] * lateral[2]
    for (let axis = 0; axis < 3; axis += 1) {
      const mirrored = chestAt[axis] + away[axis] - 2 * along * lateral[axis]
      _elbow[axis] += (mirrored - _elbow[axis]) * mirroring
    }
  }

  // And the throwing arm's own pole is read as the *angle* the fold's keys author rather
  // than as the place they were written on (see the fold's first follow-through key and
  // SWEEP_VALUES above): the ring is composed here, about the chord the pose itself is
  // asking the wrist along, out of the place's own along and tilt — so the two radii the
  // interpolated place carries are the keys' own, and only the *way round* the chord is
  // interpolated as an angle. That is the difference between a fold whose ring sweeps
  // round the socket as the body comes round and one whose ring is carried corner to
  // corner: through the crossing the keys turn the ring most of a right angle in an
  // eighth of a second, and the line between two places cuts across the chest instead —
  // which is a pole that asks for an elbow *inside* the body, and the driver answers an
  // elbow it cannot have with its clearance rule rather than with the promise. On the
  // realised skeleton that is the throwing arm's flick up across the drive leg (20.6° of
  // upper arm in the one frame at 1.6125 s, an 11.6 cm jump of the elbow, with the bend
  // held still); read as the angle it is, the whole fold turns its ring the way the keys
  // turn it, and the driver's ring, fold and bend are the pose's own frame by frame.
  // ...and only where the keys author one: outside that stretch the poles are the places
  // they always were, which is what keeps the frame the clip ends on — the set's own arm,
  // authored as a place — exactly the place the loop's own reading wants it to be.
  //
  // The window's own *end* is a hand-over rather than a switch (see SWEEP_POLE_HANDOVER):
  // the composed place and the authored one are the same promise drawn two ways, and how
  // far apart they land is a reading of the body the fold is written on.
  const poleHand = clamp(
    (SWEEP_TIMES[SWEEP_TIMES.length - 1] + SWEEP_POLE_HANDOVER - authored) / SWEEP_POLE_HANDOVER,
    0, 1,
  )
  if (poleHand > 0 && authored >= SWEEP_TIMES[0] - 1e-9) {
    // The chord the pose is asking this frame along: the wrist's own place, less the
    // carry down the hand's line (see the arm output below, which hands the same place
    // to the driver as `hand`).
    const askedAt = [
      ball[0] - aim[0] * handCarry - throwingSocket[0],
      ball[1] - aim[1] * handCarry - throwingSocket[1],
      ball[2] - aim[2] * handCarry - throwingSocket[2],
    ]
    const chordAt = Math.hypot(askedAt[0], askedAt[1], askedAt[2])
    if (chordAt > 1e-6) {
      for (let axis = 0; axis < 3; axis += 1) askedAt[axis] /= chordAt
      // The ring's own frame: the lateral the world's own up makes with the chord, and
      // the ring's up off that (see the sweep's own note at the track above). A chord
      // with no lateral against the world — an arm asked for straight up or straight
      // down — leaves the angle with nothing to be read against, so such a frame keeps
      // the authored place; the fold's own chords are 0.4-0.75 of the unit off the
      // vertical at every key, so this is a guard rather than a reading.
      const lateral = [-askedAt[2], 0, askedAt[0]]
      const lateralLength = Math.hypot(lateral[0], lateral[1], lateral[2])
      if (lateralLength > 1e-6) {
        for (let axis = 0; axis < 3; axis += 1) lateral[axis] /= lateralLength
        // ...and the ring's own up: the two axes the ring's angle is read on.
        const ringUp = [
          lateral[1] * askedAt[2] - lateral[2] * askedAt[1],
          lateral[2] * askedAt[0] - lateral[0] * askedAt[2],
          lateral[0] * askedAt[1] - lateral[1] * askedAt[0],
        ]
        const pole = [
          _elbow[0] - throwingSocket[0],
          _elbow[1] - throwingSocket[1],
          _elbow[2] - throwingSocket[2],
        ]
        const along = pole[0] * askedAt[0] + pole[1] * askedAt[1] + pole[2] * askedAt[2]
        const flat = [
          pole[0] - along * askedAt[0],
          pole[1] - along * askedAt[1],
          pole[2] - along * askedAt[2],
        ]
        // ...and mirrored with the delivery, because the ring's own lateral is read off the
        // *world*'s up: a left-hander's body is the right-hander's mirrored and so is the
        // chord, but the lateral the same up makes with a mirrored chord is the *negative*
        // of the mirrored lateral (the two make a handed pair: the cross product turns over
        // under a reflection), so the same ring reads as the supplement of the authored
        // angle — the same place on the ring, measured from the other end of the chord's
        // lateral — and the whole fold's own sweep is mirrored with the hand.
        const sweep = s > 0
          ? trackAt(SWEEP_VALUES, SWEEP_TIMES, authored)
          : Math.PI - trackAt(SWEEP_VALUES, SWEEP_TIMES, authored)
        const reach = Math.sin(sweep) * Math.hypot(flat[0], flat[1], flat[2])
        const about = Math.cos(sweep) * Math.hypot(flat[0], flat[1], flat[2])
        for (let axis = 0; axis < 3; axis += 1) {
          _composed[axis] = throwingSocket[axis] + along * askedAt[axis]
            + about * lateral[axis] + reach * ringUp[axis]
        }
        // ...and the place the keys hold, for the frames past the window's own end: the
        // composition and the authored place are the same promise, so the hand-over is a
        // blend between two places and nothing else (see the pole's own note above).
        for (let axis = 0; axis < 3; axis += 1) {
          _elbow[axis] += (_composed[axis] - _elbow[axis]) * poleHand
        }
      }
    }
  }

  // ...and the upper arm's rule once more, now that the fold has composed the pole: the
  // frames inside the fold write the ring as an *angle* about the chord (see above), so
  // the place the rule left before the arm was read is not the place the fold hands over
  // — recomposed from the angle, the elbow can sit above the sockets' plane again. What
  // the rule reads here is the final place, against the chord the *wrist* is asked along
  // (the ball less the carry down the hand's line) rather than the ball's, which is the
  // arm's own hold at this frame.
  if (planeHold > 0) {
    _armLine[0] = ball[0] - aim[0] * handCarry - throwingSocket[0]
    _armLine[1] = ball[1] - aim[1] * handCarry - throwingSocket[1]
    _armLine[2] = ball[2] - aim[2] * handCarry - throwingSocket[2]
    const chord = Math.hypot(_armLine[0], _armLine[1], _armLine[2]) || 1
    _armLine[0] /= chord
    _armLine[1] /= chord
    _armLine[2] /= chord
    holdUnderShoulders(_elbow, throwingSocket, _armLine, planeUp, planeHold)
  }

  // The knee's own plane is the leg's own: a knee bends about the axis its shoe
  // points along and about no other, so for a leg *standing on the ground* the pole
  // that shapes it is carried by the shoe's line and not directly by the body's
  // facing above it (the batter anchors its knee to its foot for the same reason).
  // Which frame that shoe's line is read in is the difference between the two feet,
  // and it is the drive's whole story: the pivot foot stands still while the body
  // turns over it, so its yaw is the shoe's own and the leg goes on bending in the
  // plane it is driving in however far the pelvis has come round; the stride foot
  // swings with the body, so its yaw rides the pelvis' turn.
  //
  // A leg *lifted* off the ground has no ground to bend over, and what the pose can
  // name about it is where the knee is going. The kick is raised in the body's own
  // frame, not at the plate: the knee is picked up pointing where the *torso* faces
  // (for a side-on pitcher that is out to the side, not forward at home plate) and the
  // shin hangs straight down from it — and ``cock`` then turns the knee from there
  // toward the back leg, which is the hip joint's own yaw with the leg's height left
  // to ``lift``: the turn carries no vertical movement, and that turn *is* the hip
  // cocking, as one piece with the pelvis' own coil above it. From the cock the thigh
  // opens on toward home plate as the back leg drives, its own line coming round to
  // the plate's (see the break's own number), which is the stride's plane.
  const restKneeY = rig.hip.y - rig.leg.thigh
  const leg = (side, spec, shoeFrame) => {
    // How much of the ground's own say the lead shoe's *angle* is standing in: nought
    // before the plant, the whole of it through the follow-through and the hold, and given
    // up over the walk-back, where the shoe comes up out of the finish and the keys have it
    // again (see FRONT_PLANT_HOLD). It is a share of the *turn* and nothing else: where the
    // shoe stands is the keys' own place from the plant on, and the turn is what the dirt
    // holds.
    const sweep = trackAt(FRONT_PLANT_HOLD, TIMES, authored)
    // The shoe's own line. The pivot foot's is the stance's (its shoe's keyed angle,
    // mirrored into the rig by the hand the pose is read on) and the stride foot's is the
    // *body's*: the pelvis's own turn until the shoe is planted, and the whole of the body's
    // turn through the pitch from the plant out — the trunk's own curve, scaled by the share
    // the heels of both feet are read against (see FRONT_SHOE_TURN) — which is what carries
    // the lead shoe round with the leg and the torso instead of leaving it standing where it
    // was put. The two read the same angle on the plant's own frame (the shoe is put down on
    // the plate's line, and the turn is nought there), so the hand-over is a step in the
    // *rule* and not in the angle: the shoe has no step in it.
    const stoodIn = at.hipYaw + spec.yaw
    const turn = FRONT_PLANT.hipYaw + FRONT_PLANT.front.yaw
      + trackAt(FRONT_SHOE_TURN, TIMES, authored)
    const grounded = authored < FRONT_PLANT_TIME ? 0 : sweep
    const shoeYaw = shoeFrame === 'stance'
      ? s * spec.yaw
      : s * (stoodIn + grounded * (turn - stoodIn))
    // Where the shoe stands, at this pitch's own stride. A longer delivery is the
    // *same* shape taken further, and a foot is a place in the frame the body stands
    // in rather than a place in the world: the feet ride the extra the pelvis carries
    // them by — the difference between the stroke this pitch is thrown with and the
    // authored one, at this frame's own drive — so the leg's own geometry (what the
    // authored delivery's asks are all sized to) is the same at every stride, and the
    // shoe goes with the hips rather than being left behind by them. The set does not
    // scale: a stance is a stance, and at the set the drive is nought, so a delivery
    // thrown at half a stride still stands on the same two feet.
    //
    // ...and a foot the *dirt* has stops taking that term once it has landed, or a
    // delivery scaled by the pitch would walk its planted pivot shoe down the mound on
    // the frames the body drives on after the finish (the stride foot is pinned by its
    // own hold below; the pivot foot has no hold to pin it, so the scaling is frozen on
    // the frame its own landing leaves it standing in). Every frame up to that landing
    // is the frame's own drive, as before, so the swing and the plant are untouched.
    const scaled = shoeFrame === 'stance' ? Math.min(at.drive, LANDING_DRIVE) : at.drive
    const z = spec.z - (stride - 1) * scaled
    // ...and the plant's own place, which is what the shoe keeps from then on: the key's
    // own, plus the lateral the body had come by on that frame (see ``frontFoot``), read at
    // the plant rather than here because the metres the body has spent getting out over the
    // rubber are part of where the shoe went down, and a hold anchored on the frame's own
    // carry would carry the foot out with the body a second time. Written in the keys' own
    // frame — mirrored into it by the hand the pose is read on, like every other place the
    // keys author — and handed back to the keys over the walk-back, with the turn.
    const plantX = FRONT_PLANT.front.x + s * plantAcross
    const plantZ = FRONT_PLANT.front.z - (stride - 1) * FRONT_PLANT.drive
    // The turn is about the shoe's own *ankle*, and that is where it parts company with the
    // trail shoe, whose turn is carried round its heel. A shoe the dirt is holding cannot
    // skid, so the point it turns about has to be one of its own; the heel is that point for
    // the trail foot because it is the end the plant put down. For the lead foot the arc is
    // the cost, and the lead leg is what pays it: a heel-anchored turn carries the ankle
    // round a circle of the boot's own length behind it, and the front leg — which stood at
    // 101 per cent of its own length on the landing under the shorter turn already, rolling the
    // shoe onto its toe to find the last centimetre — held 0.070 of a rig unit of that travel
    // and no more.
    // That is the 41.2° the shoe used to turn through the follow-through, spent to the
    // decimal. A 101.9° turn on the same anchor sweeps 0.155: measured, the leg comes out at
    // 108 per cent of its length with the ankle 7.2 cm short of the place it was asked for
    // and the shoe 8.5 cm off the dirt — a foot on its toe and a leg torn straight, which is
    // no finish at all. So the pivot is the ankle: the leg's own base keeps the spot the
    // plant gave it to the last decimal, the shoe comes round over it, and what sweeps the
    // dirt is the shoe — 0.155 of a unit across its own sole at the landing — which is the
    // trade a real lead foot makes, the sole turning under the weight on it.
    const held = shoeFrame !== 'body' || sweep === 0
      ? { x: 0, z: 0 }
      : { x: sweep * s * (plantX - spec.x), z: sweep * (plantZ - z) }
    // How much of the leg hangs off its own knee (``hang``; see the driver's leg
    // solve), and the two planes that share it: what a standing leg bends over, and
    // where a lifted one's knee is pointed. The keys' own ``hang`` is the *share* of
    // the leg the delivery carries, read through the same interpolator as the rest of
    // the spec: a leg the pitch hands from its knee down to its own place is handed
    // over *across* a window, a handful of frames either side of the key that ends it,
    // rather than in the one frame the share reached nought — which is what a step in
    // it looked like (the stride's foot, carried with the shin plumb, sat a hand's
    // width off the dirt at the reach and then jumped a foot into the air over the
    // next frame as the key that lands it took over). The pivot's trailing foot is
    // nought throughout: it stays the driving leg and rolls over its own toe.
    //
    // ...and a foot can only be carried from a lift: a leg whose own place is the
    // dirt is standing on it, whatever the share says.
    const hang = clamp(spec.hang ?? 0, 0, 1) * clamp(spec.lift / HANG_LIFT, 0, 1)
    const facing = s * (at.chestYaw + (spec.cock ?? 0))
    const bend = {
      x: -Math.sin(shoeYaw) * (1 - hang) - Math.sin(facing) * hang,
      z: -Math.cos(shoeYaw) * (1 - hang) - Math.cos(facing) * hang,
    }
    // Where a carried leg's knee sits above its socket, in rig units: the one number
    // the lift is read as, and the one the leg's whole *shape* comes off — its height
    // here and the tilt of the direction below are the same number, which is what
    // leaves ``cock`` nothing to do but turn the leg about the vertical axis. The
    // window the ask is held in is a knee's own travel: from a hand's width off the
    // ground to just over half a thigh *above* the socket, which is the high kick's own
    // allowance (see ``KNEE_OVER_HIP``) — a knee carried below the socket, which is
    // every other lift in the delivery, is a leg hanging off its hip as usual.
    const rise = clamp(
      restKneeY + spec.lift * KNEE_RISE,
      rig.ankleY + 0.06,
      rig.hip.y + KNEE_OVER_HIP,
    ) - rig.hip.y
    const tilt = Math.max(-1, Math.min(1, rise / rig.leg.thigh))
    const flat = Math.sqrt(Math.max(0, 1 - tilt * tilt))
    return {
      // Which chain the driver poses: both feet of a delivery are the pitcher's own,
      // so the pivot is the throwing side's leg and the front is the glove side's.
      side,
      // The lifted leg's own direction, handed over as a *whole* direction rather than
      // as a place: a direction is a direction, while a place only says which way the
      // knee goes if the socket it is measured from is right — and the driver's socket
      // is the real one (see its leg solve), so a direction named here as "the way the
      // torso is facing, turned ``cock``, and this high off the socket" arrives in the
      // solve as exactly that. The azimuth is the torso's facing, the elevation is the
      // knee's own rise, and the two are separate numbers: at a given lift ``cock``
      // turns the leg about the vertical axis and nothing else, so the knee swings
      // round its own circle without rising or falling out of it, which is the hip
      // cocking. (Read a plane alone and the tilt comes off whatever the knee's place
      // happened to be, which drifts a few centimetres with the leg's bend.)
      kneeDir: [-Math.sin(facing) * flat, tilt, -Math.cos(facing) * flat],
      knee: [
        s * spec.x + held.x + bend.x * spec.bend,
        // A carried leg's knee is asked for by its own height — the lift is the
        // kick's, so it reads up the leg's own line — and a standing one's by the
        // knee's own travel, which is what the driver reads it for: a shape, not a
        // place. The height is the same ``rise`` the direction above is built from,
        // so the line the solve is pointed at and the line it is handed as a place
        // are the same line wherever the bend's own push is the thigh's own length.
        rig.hip.y + rise,
        z + held.z + bend.z * spec.bend,
      ],
      ankle: [s * spec.x + held.x, rig.ankleY + spec.lift, z + held.z],
      footYaw: shoeYaw,
      // A foot at its own rest height is a foot standing on the ground, and the driver
      // is told so: it holds a planted shoe out of the ground, which the leg's own
      // turn would otherwise roll a corner of into (see the driver's leg solve). A
      // foot the delivery is carrying — the kick, and the trailing foot once the body
      // has driven off it — is left where the pose put it, and a leg that is hanging
      // off its knee is in the air by definition: the ground has nothing to say about
      // it, and its own place comes off the knee instead of off this target.
      planted: spec.lift < PLANTED_LIFT && hang < HANG_SHARE,
      hang,
      // ...and a foot the pose *stands* on is asked for by the joint a standing foot
      // has and an aim alone does not: the ankle's own roll about the line the shoe
      // points along, which lays the sole on the dirt rather than leaving the shoe
      // up on whichever of its corners the shin's own twist has turned lowest (see
      // the driver's leg solve). It is worth naming for one reason and it is the one
      // this delivery's finish keeps running into: the ground rule stands a planted
      // shoe on the ground by its *own* geometry, so a shoe on a corner is a foot
      // carried a hand's width into the air, and a foot a hand's width into the air
      // is a socket-to-foot line that much shorter — which a leg that is nearly
      // straight along all of its length reads as knee (measured at the hold: 29°
      // bent on the corner, 7° with the roll, over the same bones).
      flat: clamp(spec.flat ?? 0, 0, 1),
      // Both feet are authored where they are, in the frame the body stands in: a
      // pitcher's feet do not ride his hips forward (that is the whole point of the
      // pivot foot), and the driver rolls a foot onto its toe when the hips outrun
      // the leg rather than dragging it (see the driver's leg solve).
      carry: 0,
    }
  }

  // The throwing arm's own share of its span, which is what the driver's girdle budget
  // is measured in (its ARM_SHOULDER_BEND is 0.97 of it, a bow for a hand held near the
  // body): the pose's own ask *is* the chord, so a pose that means the arm it asks for
  // hands its own share and the girdle is left at rest — with a couple of millimetres
  // of whisker on it, because the pose measures the ask off the socket it estimates and
  // the driver off the one its body really carries, and the two are a millimetre or two
  // apart. The ask is the *release's* own limit rather than the model's (see
  // RELEASE_ELBOW): the answer the release window wants is the chord held straight, and
  // the girdle's budget is what a bow would otherwise be spent out of. Handed across
  // the window the pitch is thrown on (see SLOT_TRACK), so the clasped windup keeps the
  // bow the driver gives it.
  const straight = straightChord(rig.arm.upper, rig.arm.fore, RELEASE_ELBOW)
  const snap = (straight + 0.002) / (rig.arm.upper + rig.arm.fore)
  // ...and the same share handed over the *fold*, which the window's own slot track
  // runs out into. The fold's keys are authored the way the window's are — a direction
  // the throw already had, off the socket the pose estimates — so they need the same
  // answer, and what the pose names for them is the whole of what the driver will
  // stretch to: an ask there is answered by the arm's own reach rather than by the
  // shoulder. Left to the girdle instead, the clavicle swings up to a dozen degrees to
  // close the gap between the estimated socket and the body's own — and every
  // centimetre of socket it moves takes the elbow with it around the ring the two
  // bones draw, which is the one thing the fold is a promise about: measured on the
  // realised skeleton, the upper arm's own direction reads 0.46 of a unit adrift
  // between 1.58s and 1.62s with the driver's own bow (a rim of 12° of swing at
  // 1.50s, against nought through the release itself), against the 0.15 the fold may
  // drift by. The hand-over is a couple of frames either side of the window's own end,
  // so the clavicle eases home instead of snapping back on one.
  const GIRDLE_HANDOVER_TIME = 0.05
  const GIRDLE_HANDOVER_LEAD = 0.03
  const foldGirdle = clamp(
    (t - (AUTHORED_SLOT_END - GIRDLE_HANDOVER_LEAD)) / GIRDLE_HANDOVER_TIME, 0, 1,
  )
  const ownGirdle = 0.97 + slot * (snap - 0.97)
  const girdle = ownGirdle + (ARM_STRETCH_MAX - ownGirdle) * foldGirdle
  // The body's own step down the mound's slope, as the caller handed it: nought at
  // the release and the whole of it by the landing (see SETTLE_TRACK), so the
  // delivery takes the step over the drive rather than at the frame the shoes touch.
  const step = settle * trackAt(SETTLE_TRACK, TIMES, authored)

  // The pole each arm hands the driver: the direction the keys authored, written out
  // at ``POLE_REACH`` from that arm's own socket, which is the place the driver reads
  // it from (see the constant's own note — at the arm's own radius the driver's socket
  // disagrees with this one by more than the fold's own ring is wide).
  const poleOut = (socket, place) => {
    const dx = place[0] - socket[0]
    const dy = place[1] - socket[1]
    const dz = place[2] - socket[2]
    const length = Math.hypot(dx, dy, dz) || 1
    const share = POLE_REACH / length
    return [socket[0] + dx * share, socket[1] + dy * share, socket[2] + dz * share]
  }

  // ...and the palm's own ask at this frame: the keys' facing, carried with the arm across
  // the cock (see `heldPalm` and PALM_HOLD) — the wrist keeps the angle the layback left it
  // in while the arm swings, instead of re-turning to hold a facing that stands still in the
  // rig's frame. The arm it is carried on is this frame's own: the line the hand is drawn
  // along (the axis the wrist's turn is about) and the elbow's own direction off the socket
  // the driver is asked to hang it from.
  const palmAskDir = heldPalm(
    handPalm,
    trackAt(PALM_HOLD_TRACK, PALM_HOLD_TIMES, authored),
    trackAt(HOLD_ROLL_TRACK, HOLD_ROLL_TIMES, authored),
    throwingSocket,
    aim,
    _elbow,
    s,
  )

  // ...and the throwing arm *rides the trunk as it stands*: the ball, the wrist's line and
  // the elbow are one arm off one socket, so they take one turn together, and taking it
  // together is what keeps the arm's own shape — the reach from the socket, the elbow's place
  // on its ring, the hand's line off the forearm — while its direction comes round with the
  // chest that is standing up under it.
  //
  // The turn is the *stand's*, not the finish's: the frame it is read from is the trunk at the
  // crossing (its own top, FINISH_FOLD at FINISH_STAND_FROM), where the keys have finished
  // with the arm and the finish begins to stand the body up out of it. Read against the keys'
  // body instead (see `rideShape` above) it would carry the throw's own sweep off the frames
  // it was authored on — measured, the arm goes from 0.29 to 0.68 of its own travel between
  // two frames of that hand-over and the crossing moves 32 mm off the plate's line the keys
  // draw it on. Read against the crossing's trunk it is the *identity* on that frame (the two
  // folds are one), so there is nothing to hand over and nothing to step: what it turns is
  // the arm as the body leaves the top of its fold, which is the one thing the keys never
  // wrote — their places are rig places, and a rig place stands in the world while the body
  // stands up under it (measuring the arm's own line on the body, that is the 0.16 of a unit
  // it trailed the chest by between 1.9 s and the pause).
  //
  // It is held through the hold and given back over the recovery: the recovery's keys are
  // drawn for a body standing up — the arm long and down at his side — so by the frame the
  // keys' own standing body is back the place is the keys' again, to the millimetre (see
  // FINISH_RIDE: the fold's *pace* is not this clock's, so the trunk has stood before the
  // ride has unwound, and what is left is the arm settling down the body it has finished
  // standing on).
  //
  // The places are ridden *here* rather than where they are read, because everything above is
  // authored machinery: the ball is the chord the fold's ring is composed about and the wrist
  // the sweep's own angle is read from, so a place turned underneath those reads turns the
  // ring with it (measured, with the ride taken at the source instead: the arm's own travel
  // stepping 2.78x its neighbours' on the frame at 1.678 s, and a 14 mm hop at 2.00 s).
  // ...held to the pause — the beat's own last key — and given back over the recovery, where
  // the keys' own places take the arm again: they are drawn for a body standing up, so by the
  // frame the stand ends the ride is nought and the place is the keys' to the millimetre.
  //
  // The hand-over is read on a *warped* clock because the ride is not free to take its time:
  // it is a rotation of places that are themselves travelling toward the plate through the
  // recovery, and a stand turning a place that has moved forward *lifts* it. Measured on the
  // evenly-eased share the ride used to have, the throwing upper arm climbed seventeen
  // degrees of elevation out of the pause (39.5° under the socket, up to 23.4° at 2.42 s)
  // before it fell the fifty-six to his side — the arm flapped out from the body before it
  // let the throw go. Front-loaded, the ride is spent while the keys' places are still nearly
  // where the hold left them (three fifths of it in the first fifth of the window), and what
  // is left for the rest of the recovery is the keys' own fall to the thigh: zero rate at
  // both ends still, so the pause and the resting place are both undamaged.
  const STAND_RIDE_END = KEY_AT(2.10).t
  const standShare = (() => {
    if (authored < FINISH_STAND_FROM) return 0
    if (authored <= STAND_RIDE_END) return 1
    if (authored >= FINISH_RIDE) return 0
    const u = (authored - STAND_RIDE_END) / (FINISH_RIDE - STAND_RIDE_END)
    const warp = 1 - (1 - u) * (1 - u)
    return 1 - warp * warp * (3 - 2 * warp)
  })()
  // A slerp of two *directions*, with the near-parallel case read as a lerp (the two are the
  // same place on the frames either side of it). Shared by the ride and the hang below.
  const slerpDir = (a, b, k, out) => {
    const cos = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)
    if (cos > 0.9995 || cos < -0.9995) {
      for (let axis = 0; axis < 3; axis += 1) out[axis] = a[axis] + (b[axis] - a[axis]) * k
    } else {
      const theta = Math.acos(cos)
      const sin = Math.sin(theta)
      const wa = Math.sin((1 - k) * theta) / sin
      const wb = Math.sin(k * theta) / sin
      for (let axis = 0; axis < 3; axis += 1) out[axis] = a[axis] * wa + b[axis] * wb
    }
    const length = Math.hypot(out[0], out[1], out[2]) || 1
    out[0] /= length
    out[1] /= length
    out[2] /= length
    return out
  }
  if (standShare > 0) {
    // The trunk the stand began from, and this frame's trunk, mixed by the share: the ride is
    // the rotation between the two, taken about the chest's own lateral (see `trunkLean`).
    const fromTrunk = trunkLean(s * at.chestYaw, FINISH_FOLD, s * at.leanSide + tilt)
    const fromTurn = upperTurn(s * at.chestYaw, -fromTrunk.leanX, -fromTrunk.leanZ)
    // ...and the *whole* of the ride is the crossing's turn onto this frame's own, which is
    // what the arm is turned by while it is held on the trunk (the share below mixes the two
    // places the hand-over is between, so what the ride itself is stays one rotation).
    const rideOf = (v, out) => {
      unturnVector(fromTurn, v, out)
      turnVector(turn, out, out)
      return out
    }
    // ...and the hand-over itself is a blend between two *places*, not a turn about the
    // chest. A rotation about the chest's lateral is the right way to carry an arm the keys
    // have stopped writing (see above: their places are rig places, and the body stands up
    // under them), but it is the wrong way to hand the arm *back*: a place turned about the
    // chest from where the stand left it to where the recovery's key puts it travels the
    // rotation's own arc, and that arc is longer than the change it is making. Blended along
    // the arc the two directions actually subtend, the arm reads one settle from the pause to
    // the thigh: the direction is slerped, the reach is lerped, and both ends are exact (the
    // blend is the identity at the hold and at the keys' standing body, so neither end moves
    // by so much as a millimetre). Measured on the realised skeleton, the upper arm goes from
    // 39.5° under the socket at the pause to 79.1° at the rest, through 44.1° at 2.35 s — one
    // descent, two degrees of wobble at worst where the stand's last turn meets the
    // recovery's own fall, and the last tenth of a second moves the elbow a tenth of a
    // millimetre.
    //
    const handOver = (dir) => {
      rideOf(dir, _rideAt)
      slerpDir(dir, _rideAt, standShare, dir)
      return dir
    }
    const standPlace = (socket, place) => {
      // The keys' own place, and the place the ride would have it at, as offsets from the
      // socket the arm hangs on.
      for (let axis = 0; axis < 3; axis += 1) _rideAt[axis] = place[axis] - socket[axis]
      const keyed = Math.hypot(_rideAt[0], _rideAt[1], _rideAt[2]) || 1
      rideOf(_rideAt, _rideRidden)
      const ridden = Math.hypot(_rideRidden[0], _rideRidden[1], _rideRidden[2]) || 1
      for (let axis = 0; axis < 3; axis += 1) {
        _rideKeyed[axis] = _rideAt[axis] / keyed
        _rideRidden[axis] /= ridden
      }
      slerpDir(_rideKeyed, _rideRidden, standShare, _rideDir)
      const reach = keyed + (ridden - keyed) * standShare
      for (let axis = 0; axis < 3; axis += 1) place[axis] = socket[axis] + _rideDir[axis] * reach
      return place
    }
    standPlace(throwingSocket, ball)
    standPlace(throwingSocket, _elbow)
    // ...and the *lines* keep the chest's own turn — a scaled one, mixed by the same share —
    // rather than the blend: a line is not a place, and the hand's carry is read along it, so
    // what a line does is turn with the body that holds it. Turned by the chest it reads as
    // the hand's own roll on a settling arm; taken along the places' own short arc it would
    // carry the wrist with it by the carry's own length.
    const leanX = fromTrunk.leanX + (trunk.leanX - fromTrunk.leanX) * standShare
    const leanZ = fromTrunk.leanZ + (trunk.leanZ - fromTrunk.leanZ) * standShare
    const mixedTurn = upperTurn(s * at.chestYaw, -leanX, -leanZ)
    const rideLine = (dir) => {
      unturnVector(fromTurn, dir, _rideAt)
      turnVector(mixedTurn, _rideAt, dir)
      return dir
    }
    rideLine(aim)
    rideLine(palmAskDir)
  }

  const pose = {
    hip: {
      yaw: s * at.hipYaw,
      // The trunk's own two numbers, as the driver has to be handed them: the pair
      // the keys authored (the fold at the plate, then the fold toward the throwing
      // side) carried back through the body's own turn, so that what the driver
      // leans is the trunk the delivery asked for rather than one folded off the
      // pitch's line by however far the body has come round (see trunkLean).
      leanX: trunk.leanX,
      leanZ: trunk.leanZ,
      // ...and the pair the *keys* authored, beside it: the fold at the plate and
      // the fold toward the throwing side, as the delivery means them. The pose
      // carries both because they are two different promises — what the trunk is
      // asked to be, and what the driver has to be handed to make it so — and the
      // suite reads the first where it is checking the shape and the second where
      // it is checking the drive (see the browser suite's trunk reading).
      fold,
      foldSide: s * at.leanSide,
      // ...and the trunk's own roll toward the throwing side this frame, in radians: the
      // third promise about the same trunk (the fold at the plate, the side fold the keys
      // authored, and the roll the pitch's own line asked for), and the delivery's whole
      // lateral lever (see `pitcherRelease`). It is already folded into the trunk the
      // driver is handed — ``leanX``/``leanZ`` above carry it, and the driver's own
      // euler carries it *with* the pelvis, so the two blocks agree about up exactly (see
      // its own separation check) — and what is reported is the angle the pose drew.
      // What it costs is the pelvis's own height and nothing else: a roll turns about the
      // body's own midline, so it is the drive-side hip socket it carries up, and the
      // lift below sets that socket back where the stance put it (see `rollLift`) —
      // the feet stand where they stood and the drive leg keeps its chord.
      tilt,
      // ...and the roll the pelvis' own height was paid for, reported beside it: the two
      // part company over the kick (see TILT_LIFT_TRACK), and a suite reading what the
      // levers cost the body's height has to read the number the height was solved at
      // rather than the number the body is rolling by.
      tiltLift: liftTilt,
      rock: 0,
      // ...and the *body's* own carry of the same line, in the rig's own x: the metres the
      // trunk's roll could not reach, paid for by the step (see STANCE_SIDE_MAX and
      // STEP_TRACK). It is a translation of the pelvis like the height below it — the
      // stride foot's own place is authored across by the same metres, so the body goes
      // where its step goes — and the leg under the *drive* foot answers it, which is the
      // trade the two levers are: the drive leg slants under a pelvis that has come off
      // it, and the sink below leaves it a straight rod while it does (see `stanceDip`).
      offsetX: stanceAcross,
      offsetY: at.hipY - sink - foldSink,
      offsetZ: -at.drive * stride,
    },
    torsoYawExtra: s * (at.chestYaw - at.hipYaw),
    torsoOffsetZ: 0,
    head: {
      // The head keeps its own eyes on the plate: the chest's whole turn and fold
      // come off it, which is why the neck's own numbers here are a counter-motion
      // rather than a pose. There are two solves to hand it, and the delivery's own
      // clock is which: ``hold`` at one is the line the *stance* stands in, which is
      // what a windup turns the body under (see STANCE_PIN), and ``tracked`` at one is
      // the eyes on the zone the ball is going to, level, whatever the body is doing
      // under them. One hands over to the other across the drive, and a share of neither
      // is the head handed to the shoulders it is falling over, which is what both lines
      // *are* at nought. The pin's own share is not ``look`` outright because a neck has
      // a limit (see LOOK_SEPARATION_MAX): past it the zone is no longer a look this body
      // can hold, and the shoulders take the head back.
      yaw: hold * stanceYaw + tracked * pinnedYaw,
      // ...and the same cross-over for the nod, off the neck's own pair: half of a
      // solved look is not a look at anything, but it is the shape of letting go of
      // one — and what the nod settles into is the key's own ``headPitch``, the head
      // going where the shoulders carry it.
      pitch: hold * stancePitch + tracked * pinnedPitch + (1 - hold - tracked) * at.headPitch,
    },
    // ...and the striding leg's own step goes out with the body: its foot's place is
    // shifted by the carry in the rig's own x — the one place a foot's own numbers are
    // written in the *keys'* frame rather than the rig's, so the shift is mirrored into it
    // (see `leg`, which names a foot's lateral by the side it stands on) — because a step
    // that is authored across is a step the whole leg keeps its own shape in, where a body
    // carried over a planted foot is a leg slanted out from under the pelvis.
    legs: [leg(s, pivotFoot, 'stance'), leg(-s, frontFoot, 'body')],
    arms: [
      {
        side: s,
        // The ball is where the pose says it is; the wrist that puts the palm
        // there is less the carry down the hand's own line.
        hand: [
          ball[0] - aim[0] * handCarry,
          ball[1] - aim[1] * handCarry,
          ball[2] - aim[2] * handCarry,
        ],
        aim,
        // ...and while the hands are together the *same* grip, written where the
        // glove's own numbers are: the glove's place read from *this* arm's own
        // shoulder (half the shoulders' width the other side of the midline) and the
        // glove's own line. Both hands are then read through the frame the driver's
        // chest is really holding rather than through this pose's estimate of it, so
        // they land on one place however far the trunk has come round between the
        // keys — which is what keeps the hand in the mitt. Authored the other way (a
        // place in the rig frame, as above), the estimate and the chest disagree by a
        // few degrees once the trunk leans, and a few degrees at the hands' own
        // radius is a hand's width down the glove's line: read off the realised
        // skeleton, the bare hand's wrist sat 3.5 of a rig unit's hundredths *out of
        // the mitt's mouth* at the set and 5 at the gather, with 15% of the hand's
        // own silhouette showing past the mitt from behind the mound. The glove's own
        // hand has no such choice — it is authored this way already (below), so the
        // two are one place by construction rather than by two estimates agreeing.
        local: throwLocal,
        aimLocal: gloveAim,
        // Which of the two forms this frame is written in: nought — the glove's own
        // frame — while the hands are together, easing out to one (the rig-frame
        // place above) as the break parts them. The two agree at the keys either
        // way; what this crosses over is which *body* the hand is read on.
        mix: 1 - clasped,
        // Authored as a place, like the ball (and mirrored with it, above): the
        // keys' own numbers sit next to the ball's, and the release window's ride
        // the release point with it. Handed over along that place's own direction at
        // ``POLE_REACH`` — a pole is a direction, and this arm's socket estimate stands
        // far enough from the driver's to spoil one written at the arm's own radius
        // (see the constant's own note).
        elbow: poleOut(throwingSocket, _elbow),
        // The arm's own *straightness*, handed to the driver beside its place: this is
        // the arm the pitch leaves on, and the pose asks for the release's own chord
        // (see RELEASE_ELBOW, and `straightChord`) rather than for the model's bow.
        // Written with a place alone, the driver answers with its own two bows — the
        // girdle swings the clavicle under any ask past 0.97 of the span, which moves
        // the socket the arm hangs from and folds the elbow back to hold a wrist the
        // body has already reached, and the elbow itself is refused past its limit.
        // Both are right for a hand held near the body and wrong for a release: what a
        // pitch needs there is the chord, held straight, which is what the release
        // window asks for. (Measured before either was handed over: 4° of clavicle and
        // 1.9 cm of socket at the release, and 18° of elbow on it.)
        straight: armStraight,
        // The pose's own read of the socket the arm hangs from, handed over beside
        // the arm it belongs to (see the estimate's own note above): the suite reads
        // how far it stands from the joint the driver actually solved on.
        socket: [throwingSocket[0], throwingSocket[1], throwingSocket[2]],
        // ...and the frame's own share of the *sweep* (see SWEEP_IN_TIME): the frames
        // the place above is the throw's own *line* rather than a place, which the
        // driver answers by putting the wrist out on it at the chord the frame's bend
        // allows — the line is the pose's, and the length is the arm's own. Written
        // as a place alone the driver folds the elbow to hold the estimate's error:
        // measured on the realised skeleton, 118° of elbow at 1.37 s on a frame whose
        // own ``straight`` asks for 168° (see the driver's own note).
        // ...and it is handed *down* on the frames the body gives beside it: the sweep
        // puts the wrist out on the pose's line at the frame's chord, which is right
        // where the line is an estimate's and wrong on the one frame the ball's place
        // is the pitch's — a wrist carried out to the chord carries the ball out with
        // it, and at this end of the arm's range a millimetre of chord is worth two
        // degrees of elbow (see RELEASE_ELBOW). So the two hand-overs are one: what the
        // body gives the arm (``graze``) is what the line gives the ball, and the
        // release's own frame is read as the place it is authored as.
        sweep: Math.min(1, sweep * (1 - graze / RELEASE_GRAZE)),
        // ...and how far the body gives the arm on this frame, in a rig unit, which the
        // driver spends on the two rules that would otherwise move the release point:
        // the fold that keeps the arm out of the trunk, and the push that keeps a hand
        // out of it (see RELEASE_GRAZE).
        graze,
        // ...and the *ball*'s own carry down the hand's line, which the hand above
        // has given the straighter reach back out of (see ``handCarry``): the driver
        // carries the ball it is holding down the hand's own line, and the number is
        // the pose's here for the same reason the arm is — the release's own ask is
        // not the model's own palm's, and a driver left to the model's would carry the
        // ball a few millimetres past a release point the pose has pinned exactly.
        carry: handCarry,
        shoulderBend: girdle,
        curl: at.curl,
        // ...and the same *palm*: the hand the ball is in is on the same side of it
        // as the glove's own palm is, which is the whole of the roll the model's own
        // hand has to turn through to sit inside the mitt (151°, measured) — asked
        // for as the clasp's own share of that turn, so the grip eases out of it as
        // the break opens the hands rather than snapping the hand round in the frame
        // the ask left (see ``palmMix`` in the driver). Where the *ball* leaves the
        // hand the facing is a different one, though: from the break on the palm is the
        // pitch's own bearing rather than the mitt's (see ``handPalm`` above), so the
        // share of the turn asked for is the greater of the clasp's own and the release
        // window's — the hand is turned to one facing *or* the other, never half of
        // neither — and the direction the ask is written on eases between them across
        // the window's own ramp. Across the cock it is not written in the rig's frame at
        // all: what the hold keeps is the *wrist's own angle*, so the ask travels with the
        // arm instead (see `heldPalm`, and the hold's own track above).
        palm: palmAskDir,
        palmMix: Math.max(clasped, slot, palmAsk),
      },
      {
        side: -s,
        // The glove is held in front of the chest, so it is authored from its own
        // shoulder in the chest's frame: the chest can turn under it.
        local: gloveLocal,
        aimLocal: gloveAim,
        // Which way the glove's palm faces, in the rig's own frame: the twist of
        // the hand is the *delivery's* number rather than the chest's, so it is
        // written where the pitch goes (see the keys' own ``glovePalm``).
        palm: glovePalm,
        // ...read from the glove's own socket, for the same reason and the same way (see
        // ``POLE_REACH``: a pole is only ever a direction off the socket it hangs from).
        elbow: poleOut(gloveShoulder, gloveElbow),
        curl: at.gloveCurl,
      },
    ],
    ball,
  }
  if (step === 0) return pose
  // ...and the step itself: the whole pose comes down with the hip — the arms' own
  // places, the ball, and *both* legs' targets, planted ones included. It is one
  // translation of the body rather than a shape, and the legs are in it for the
  // reason the delivery is authored in one piece: the knee's own target is a
  // *place* the driver reads the leg's plane off as much as a length (see the leg
  // solve), so a planted leg left behind by the hip is a leg whose knee is aimed at
  // where the foot used to be — the body stepping down *out* of its own stance
  // rather than down it. (What the ground holds is still the ground's own: a
  // planted shoe is stood on the surface under it by the driver's rule, which reads
  // the dirt, not this — see `standOn` in playerRig.js. The two agree because the
  // caller solves this step off that rule's own answer; see Pitcher.jsx.)
  const lower = (place) => [place[0], place[1] + step, place[2]]
  pose.hip.offsetY += step
  for (const leg of pose.legs) {
    leg.knee = lower(leg.knee)
    leg.ankle = lower(leg.ankle)
  }
  for (const arm of pose.arms) {
    // The lead arm's own places are written in the chest's frame and ride it; only
    // the throwing arm is carried in the rig's.
    if (arm.side !== s) continue
    arm.hand = lower(arm.hand)
    arm.elbow = lower(arm.elbow)
  }
  pose.ball = lower(pose.ball)
  return pose
}

// A direction is mirrored by negating its lateral axis and nothing else: the
// delivery is authored for a right-hander, and a lefty's hand points along the
// same line the other way round the body, not at the same place it was written.
const normalize = (v, s) => {
  const out = [s * v[0], v[1], v[2]]
  const length = Math.hypot(out[0], out[1], out[2]) || 1
  return [out[0] / length, out[1] / length, out[2] / length]
}

/**
 * The idle between pitches: the set stance, breathing. The same joint targets the
 * delivery is authored in, so the stance the windup starts from is the stance the
 * pitcher was standing in.
 *
 * @param {number} clock seconds since the component started idling
 * @param {object} ctx the same context `pitcherPose` takes
 * @returns {object} the pose
 */
export function pitcherIdle(clock, ctx) {
  const wave = Math.sin(clock * IDLE_BREATHE_HZ * Math.PI * 2)
  return pitcherPose(0, { ...ctx, idle: { breathe: wave, fade: 1 } })
}

/**
 * Blends two poses of the driver's contract, which is how the delivery and the
 * idle cross over: every joint target and every angle, linearly. Both are
 * authored in the same frame and both are the set stance at the moment they meet,
 * so what the blend does between them is a shorter walk from one to the other and
 * nothing stranger.
 *
 * @param {object} a the pose to start from
 * @param {object} b the pose to end on
 * @param {number} k 0 = a, 1 = b
 * @returns {object} the blended pose
 */
export function blendPose(a, b, k) {
  if (k <= 0) return a
  if (k >= 1) return b
  const mix = (x, y) => x + (y - x) * k
  const vec = (x, y) => [mix(x[0], y[0]), mix(x[1], y[1]), mix(x[2], y[2])]
  const arms = a.arms.map((from, i) => {
    const to = b.arms[i]
    const out = { side: from.side, curl: mix(from.curl ?? 0, to.curl ?? 0) }
    if (from.hand && to.hand) out.hand = vec(from.hand, to.hand)
    // Which of an arm's two forms of *place* each side is written in, crossed over
    // with the place itself: a blend that dropped it would hand the arm back to the
    // other frame at the moment one of them took over, and on a clasped frame those
    // two frames are a hand's width apart down the glove's own line. The driver's
    // own reading of an arm with no ``mix`` is what an absent one means here too
    // (one — the rig frame — for a place written outright, nought for a local one).
    const share = (arm) => (arm.hand ? (arm.mix ?? 1) : 0)
    out.mix = mix(share(from), share(to))
    if (from.local && to.local) out.local = vec(from.local, to.local)
    out.aim = from.aim && to.aim ? vec(from.aim, to.aim) : (from.aim ?? to.aim)
    if (from.aimLocal && to.aimLocal) out.aimLocal = vec(from.aimLocal, to.aimLocal)
    // The palm's own facing crosses over with the rest of the hand: a blend that
    // dropped it would hand the arm back to the rig's own roll at the moment the
    // delivery takes over, which is a wrist snapping round on the cross-fade.
    if (from.palm && to.palm) out.palm = vec(from.palm, to.palm)
    // ...and the share of that roll the pose asks for, which eases with the grip it
    // belongs to: a blend that dropped it would have a half-open grip's hand stand
    // up against the other half's.
    if (from.palmMix != null || to.palmMix != null) {
      out.palmMix = mix(from.palmMix ?? 0, to.palmMix ?? 0)
    }
    out.elbow = vec(from.elbow, to.elbow)
    return out
  })
  return {
    hip: {
      yaw: mix(a.hip.yaw, b.hip.yaw),
      leanX: mix(a.hip.leanX, b.hip.leanX),
      leanZ: mix(a.hip.leanZ, b.hip.leanZ),
      rock: mix(a.hip.rock ?? 0, b.hip.rock ?? 0),
      offsetY: mix(a.hip.offsetY, b.hip.offsetY),
      offsetZ: mix(a.hip.offsetZ, b.hip.offsetZ),
    },
    torsoYawExtra: mix(a.torsoYawExtra, b.torsoYawExtra),
    torsoOffsetZ: mix(a.torsoOffsetZ ?? 0, b.torsoOffsetZ ?? 0),
    head: {
      yaw: mix(a.head.yaw, b.head.yaw),
      pitch: mix(a.head.pitch, b.head.pitch),
    },    legs: a.legs.map((from, i) => {
      const to = b.legs[i]
      const dir = from.kneeDir && to.kneeDir
        ? [mix(from.kneeDir[0], to.kneeDir[0]), mix(from.kneeDir[1], to.kneeDir[1])]
        : (from.kneeDir ?? to.kneeDir)
      return {
        side: from.side,
        knee: vec(from.knee, to.knee),
        kneeDir: dir,
      ankle: vec(from.ankle, to.ankle),
      footYaw: mix(from.footYaw, to.footYaw),
      // How much of the leg hangs off its knee crosses over with the rest of the
      // pose: a blend that dropped it would hand a lifted leg back to the ground
      // rule and let it fold.
      hang: mix(from.hang ?? 0, to.hang ?? 0),
        // The ground's own rule is part of the pose, so it crosses over with the
        // rest of it: a blended frame whose feet both sides call planted is a frame
        // the driver still has to stand on the ground (see the driver's leg solve),
        // and dropping the flag here is how a cross-fade puts the shoes back in the
        // dirt. A foot either side is carrying — the kick, the peel off the rubber —
        // is left where the blend put it.
        planted: !!(from.planted && to.planted),
        // ...and the roll the pose asks for crosses over with the rest of the leg:
        // a cross-fade that dropped it would leave the shoes on their corners for
        // however long the blend lasts, which is a foot's width of knee.
        flat: mix(from.flat ?? 0, to.flat ?? 0),
        carry: 0,
      }
    }),
    arms,
    ball: vec(a.ball, b.ball),
  }
}
