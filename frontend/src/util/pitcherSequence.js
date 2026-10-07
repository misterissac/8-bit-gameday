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
const LEAN_LOW = 0.80
const LEAN_HIGH = 0.40

// The release height the keys' own leans were written for, and the lean they hold
// there: the release key is authored at AUTHORED_RELEASE_LEAN, and the height is
// the one whose slot lean *is* that lean — derived from the pair of them rather
// than picked, so the delivery's own shape and the slot it is corrected from can
// never drift apart. Every other height turns the release window's lean by the
// difference between its own slot lean and this one (see the ``slot`` track), so a
// high slot stands the body up out of the fold instead of asking the same fold to
// reach higher.
const AUTHORED_RELEASE_LEAN = 0.57
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
    glove: [0.245, -0.330, -0.290], gloveAim: [0.0, -0.30, -0.954], gloveCurl: 1.55,
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
    clasp: true,
    hipYaw: -1.760, chestYaw: -1.820, lean: 0.16, leanSide: 0.035, hipY: -0.015, drive: -0.095,
    headPitch: 0.04,
    // The weight is *on* the drive leg by here and the shoe has taken it: the pivot
    // foot's own place is carried back with the hips (see the pivot leg's note), so
    // what the kick rises over is the back leg rather than the space between them.
    pivot: { x: 0.110, lift: 0, z: 0.180, yaw: -1.340, bend: 0.22, hang: 0 },
    front: { x: -0.150, lift: 1.13, z: 0.030, yaw: 0.0, bend: 0.34, hang: 1, cock: 0 },
    glove: [0.235, -0.170, -0.290], gloveAim: [0.72, 0.28, -0.62], gloveCurl: 1.55,
    gloveElbow: [-0.10, -0.20, -0.02],
    glovePalm: [-0.01, 0.36, 0.94],
    curl: 1.5,
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
    t: 1.00,
    clasp: true,
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
    curl: 1.5,
    // The throwing arm's own elbow hangs down and behind the hands it is clasped
    // into: with the hands up at the chest its pole has to fall back out of their
    // own line, or the two-bone solve has no side to bend the arm to (see the
    // chord guard in the unit tests — this key's pole sat a millimetre off it once
    // the clasp came up to the chest).
    elbow: [0.30, 1.10, 0.42],
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
    // a half centimetres here, the pelvis a single degree of turn, and the throwing
    // hand has not left the glove at all. Read as *rates* — which is what the eye reads
    // a delivery by — the five hundredths of a second the fall spans are slow on all
    // three at once, and what follows is one build from here to the ball rather than a
    // step out of the coil and then a windup (see the break's own note on the starts,
    // and the browser suite's reading of the three speeds, which holds each of them to
    // its fastest frame on the release rather than a crest inside the stride).
    //
    // The knee's own cock is what the fall leaves longest: the leg is up and pointed
    // where the coil pointed it (``cock`` carries the wound angle it held at the
    // balance, and the chest it is read against has not moved either), so the kicking
    // leg's unwind, the step out of it and the arms' break all still wait on the
    // break below — which is what "the ball is thrown by the body that has already
    // fallen" looks like from the outside.
    t: 1.05,
    clasp: true,
    hipYaw: -2.075, chestYaw: -2.160, lean: 0.175, leanSide: 0.050, hipY: -0.045, drive: -0.090,
    headPitch: 0.035, curl: 1.45,
    pivot: { x: 0.113, lift: 0, z: 0.198, yaw: -1.525, bend: 0.25, hang: 0 },
    front: { x: -0.169, lift: 1.14, z: 0.008, yaw: -0.10, bend: 0.42, hang: 1, cock: -0.30 },
    // The hands are where the balance put them — up at the chest and still clasped —
    // with the glove drifting forward off it: the *elbow* is what has not moved, and
    // it is authored to arrive late (see the break). The palm is already on its way
    // round to the plate with it: the showing is the elbow's own rise's passenger.
    glove: [0.230, -0.130, -0.300], gloveAim: [0.50, -0.80, 0.32], gloveCurl: 1.35,
    gloveElbow: [-0.22, 0.06, -0.12],
    glovePalm: [0.03, -0.02, -1.0],
  },
  {
    // The break: the front leg drives out toward the plate and the hands come
    // apart — the throwing hand swings down beside the hip while the glove goes out
    // in front of the chest — with the pelvis already turning ahead of the
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
    // What the turn does *not* carry is the fold. The trunk comes over the hips in
    // the last fraction of a second before the ball goes and not before it: the
    // body turns its way through the stride standing nearly as upright as it stood
    // in the set, and the fold is what the release is *made* of rather than
    // something carried into it from the plant. This key is where the lean begins,
    // and it begins gently: a tenth of a radian here against the release's half,
    // with the plant and the high cock the two steps between — one and a tenth of a
    // radian a second across the break, three fifths into the cock, one and nine tenths
    // over the come-through — and then, in the last two hundredths of a second before
    // the ball goes, the third of a radian the whole fold is: twenty-six radians a
    // second, the fastest the trunk moves anywhere in the delivery (see the browser
    // suite's reading of the lean's *speed*, which finds it on the release frame).
    t: 1.12,
    hipYaw: -1.640, chestYaw: -1.900, lean: 0.18, leanSide: 0.02, hipY: -0.08, drive: 0.040,
    headPitch: 0.04,
    pivot: { x: 0.118, lift: 0, z: 0.200, yaw: -0.950, bend: 0.26, hang: 0 },
    // The lift is the *knee's* own height while the leg is carried (see the pose
    // assembly's ``hang``): a carried foot hangs its shin plumb from the knee, so the
    // height a kick's foot rides at is set by how high the knee goes, and the knee
    // has to go higher as the hips drop under it — a leg left at the kick's own
    // number would hang its foot into the dirt by the reach.
    front: { x: -0.166, lift: 0.60, z: -0.180, yaw: 0.0, bend: 0.16, hang: 1, cock: 0.10 },
    ball: [0.245, 0.995, 0.150], aim: [0.30, -0.80, 0.52], curl: 1.4,
    elbow: [0.31, 1.20, 0.09],
    glove: [0.130, -0.110, -0.400], gloveAim: [-0.092, -0.700, -0.704], gloveCurl: 0.8,
    gloveElbow: [-0.26, 0.16, -0.18],
    glovePalm: [0.02, -0.07, -0.997],
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
    // The fold is most of the way in by now: the trunk has been *walked* into the lean
    // the pitch is thrown from since the rocker (see LEAN_IN_TRACK), and this is the key
    // the walk arrives at the foot on — the body's own lean is the share of the release's
    // fold the walk has spent, which is most of it but not the whole, because the last of
    // the lean-in belongs to the release's own frame. Beside that, what the reach is is
    // the body's turn and its travel (see the break's own note above, and the finish
    // below for the other end of it).
    t: 1.20,
    hipYaw: -0.560, chestYaw: -1.030, lean: 0.19, leanSide: 0.0, hipY: -0.20, drive: 0.405,
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
    ball: [0.33, 1.20, -0.05], aim: [0.24, 0.30, 0.92], curl: 1.3,
    elbow: [0.40, 1.30, 0.00],
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
    // And the fold is whole by here: the lean-in's own walk arrives on the frame the ball
    // goes (see LEAN_IN_TRACK), so from this key on the trunk is the release posture's own
    // fold — the body the arm unwinds off is already most of the way over the hips it is
    // throwing from, with the shoulders still on their way round.
    t: 1.26,
    release: true, slot: 1,
    // The cock's own elbow: a right angle, which is where a throw is drawn back *to* —
    // the forearm folded up and the ball held behind the shoulder on it (see the arm's
    // own note above, and the straightness track the pose reads). Straight here, the
    // elbow has no ring to be pulled on and the pole below is worth nothing.
    straight: (90 * Math.PI) / 180,
    hipYaw: -0.070, chestYaw: -0.700, lean: 0.20, leanSide: 0.0, hipY: -0.13, drive: 0.580,
    headPitch: 0.06,
    pivot: { x: 0.150, lift: 0.05, z: 0.050, yaw: 0.050, bend: 0.28, hang: 0 },
    // The foot has reached the place it will land on and is on its way down: the
    // release is a hand's width above the dirt for it (see the plant below).
    front: { x: 0.000, lift: 0.22, z: -0.880, yaw: -0.120, bend: 0.36, hang: 0, cock: 0 },
    // The cock's own ball is *above and behind the shoulder*, which is what a
    // cocked arm holds: written off the release, that is well below it and well
    // back along it, not a hand's width higher than the release itself. Here it is
    // drawn back 1.68 rig units across the chest's own plane — a whole stride's worth
    // of whip to come, and further back than any other key in the window by a unit and
    // a half (the come-through carries 0.66 of its own line and less than a third of
    // it across the plane, see its own note) — and all of that extra is the trail's
    // own price. The elbow's place is read against the ball (see the pole below), and
    // the deeper the ball is laid back across the plane the further *behind* it the
    // ring lets the elbow come: measured on the realised skeleton, the same pole and
    // the same fold that leave the elbow a seventh of a rig unit behind that plane on
    // the old ball leave it a third of one behind on this. The draw-back costs the
    // throw nothing — it *buys* it: the whip's own speed is spent in the twenty
    // milliseconds before the release, which this key's ball does not touch (it is
    // spent over the *four* frames to the come-through, worth a fiftieth of a unit a
    // frame more than before), and flattening the ramp into the release takes the
    // pose's worst frame step down from 0.328 of a rig unit to 0.319 (see the unit
    // suite's speed test, whose bound is 0.36).
    ball: [-0.23, -0.04, 1.67], aim: [0.10, 0.58, 0.81], curl: 1.0,
    // ...and the elbow's pole is written *up and behind the shoulder*, which is where
    // a cocked arm's elbow is: the throw's own first half is the *torso* carrying the
    // arm through — the chest unwinds off the hips with the upper arm still laid back
    // on it, and the arm catches up and is spent past it by the time the ball goes.
    // The old pole here was the ring's forward-most point, which put the elbow *ahead*
    // of the plane from the reach on (measured: 0.09 ahead at this key, and 0.12 at
    // the come-through): the arm was throwing itself while the body rode along, which
    // is the wrong way round. This one leaves the elbow on the ring's back side — 0.22
    // of a rig unit behind the chest's own shoulder plane at this key, the deepest the
    // body allows at the cock (the trunk's own clearance answers for the rest) — and
    // what the two frames between the keys make of it is the pull: the plane's lead is
    // back to nought by 1.29 and 0.15 the *other* way by the release, so the chest has
    // come a quarter turn past the elbow before the arm has finished passing it (see
    // the browser suite's own reading of the trail).
    elbow: [-0.12, 0.10, 1.91],
    glove: [-0.190, -0.260, -0.420], gloveAim: [-0.40, -0.85, -0.34], gloveCurl: 0.3,
    gloveElbow: [-0.32, -0.08, -0.24],
    glovePalm: [0.14, -0.20, -0.97],
  },
  {
    // Coming through: the arm is over the top with the hand nearly on the ball's own
    // line — and the *chest* is still coming round behind the hips it is riding, 38°
    // back of them, which is the widest separation the delivery makes: the shoulders
    // are the last thing in the chain still wound. The two hundredths of a second that
    // follow are the throw: the hips' travel, the body's turn and the trunk's fold all
    // have their fastest frame on the release (see the browser suite's reading of the
    // three speeds), and the ball covers seven tenths of a rig unit of its own path in
    // them (see the keys' own note on the ramp, at the break).
    t: 1.30,
    release: true, slot: 1,
    // The arm is *coming open* here rather than already open: a hundred and sixty-eight
    // degrees of the chord the release is thrown on, so what the two frames left of the
    // whip straighten is the last of the fold — the elbow leads it open (see the pole
    // below) rather than riding a locked arm through the ball.
    straight: (168 * Math.PI) / 180,
    hipYaw: 0.240, chestYaw: -0.420, lean: 0.21, leanSide: 0.0, hipY: -0.05, drive: 0.760,
    headPitch: 0.08,
    pivot: { x: 0.175, lift: 0.06, z: -0.280, yaw: 0.060, bend: 0.24, hang: 0 },
    front: { x: 0.000, lift: 0.17, z: -0.940, yaw: -0.460, bend: 0.30, hang: 0, cock: 0 },
    ball: [0.05, 0.03, 0.660], aim: [0.02, 0.02, -0.99], curl: 0.9,
    // The elbow's pole is at the ring's forward-most point again, which is as far as a
    // folded arm's elbow can *get* toward the plate: the ball is drawn back a hand's
    // width further at the cock above, and what the two frames between the keys make of
    // it is the lead — measured off the realised skeleton, the elbow is a hand's width
    // ahead of the ball along the ball's own line to the release from the cock through
    // the come-through. Not here, though: this key is the *last* of the whip, and the
    // lead is spent with it. The ball's own travel across its last two frames is what
    // the whip is made of, and the delivery's own bound on it is the pitch's speed (0.36
    // of a rig unit in a frame of a hundred-and-twentieth: 42 rig units a second, which
    // is what a 94 mph four-seamer leaves at — see the unit suite's speed test), so a
    // ball drawn back *here* to buy the elbow more room buys it out of the throw's own
    // speed: 0.78 of a rig unit behind the release ran the hand at 50 rig units a second
    // and broke that promise to keep this one. What is left is the pole, which is free,
    // and which is where the old keys had the elbow out to the throwing side instead.
    elbow: [0.47, 0.44, 0.91],
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
    front: { x: 0.000, lift: 0.155, z: -0.940, yaw: -0.600, bend: 0.28, hang: 0, cock: 0 },
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
    // whole sweep outside the trunk: the arm's own radius from the socket is the
    // three or four hand widths a bent arm has, at every frame of it.
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
    hipYaw: 0.86, chestYaw: 1.10, lean: 0.44, leanSide: 0.0, hipY: -0.04, drive: 1.175,
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
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.860, bend: 0.26, hang: 0, cock: 0 },
    ball: [-0.44, -0.50, -0.26], aim: [-0.58, -0.70, -0.42], curl: 0.4,
    // ...and the pole is written *down and in front of* the arm's own line, which is the
    // shape the whole follow-through is: the arm is folded again by here (the hand has
    // come off the ball and is being carried down and across the chest), so the elbow
    // has a ring to lead on — and leading is what it does, down and across the front of
    // the body the chest is folding over. Written *behind* the line instead (which is
    // where a relaxed arm's elbow hangs, and what this key used to author), the elbow
    // rides the last of the turn *behind* the shoulders: measured off the realised
    // skeleton, the arm is the better part of a quarter of a rig unit behind the
    // chest's own plane at 1.40s, and what the throw leaves behind is the arm.
    elbow: [-0.45, -0.60, -3.60],
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
    // socket, with the arm's own reach still three quarters of a span. The elbow's
    // pole rides up and out to the throwing side with it, which is the shape the
    // whole frame is: an elbow leading a forearm that is coming across the body.
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
    hipYaw: 0.95, chestYaw: 1.350, lean: 0.37, leanSide: 0.0,    hipY: -0.07, drive: 1.255,
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
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.25, hang: 0, cock: 0 },
    ball: [-0.59, -0.77, -0.21], aim: [-0.48, -0.75, -0.44], curl: 0.35,
    // The sweep's own pole carries on down and in front of the line with it: the elbow
    // is the leading point of the arm all the way through the follow-through, which is
    // what the hand being carried across the body *is* (see the key above).
    elbow: [-0.50, -0.70, -4.00],
    glove: [-0.295, -0.350, -0.340], gloveAim: [-0.37, -0.40, -0.83], gloveCurl: 0.275,
    gloveElbow: [-0.33, -0.16, -0.13],
    glovePalm: [0.40, -0.80, -0.45],
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
    hipYaw: 1.01, chestYaw: 1.550, lean: 0.32, leanSide: 0.0,    hipY: -0.10, drive: 1.34,
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
    pivot: { x: 0.034, lift: 0.40, z: -2.149, yaw: 0.900, bend: 0.10, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.24, hang: 0, cock: 0 },
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
    // the hand's own speed falls from 1.9 rig units a second across the crossing to
    // 0.7 at the landing, and the settle carries the same fall on to nothing. A
    // follow-through that ran its whole length at the speed it
    // left the hand with is a hand that arrives at the foot the body is standing on
    // at a crawl and stops there — two motions, a swing and then a settle, which is
    // not what letting a throw go looks like.
    ball: [-0.32, 0.94, -1.52], aim: [-0.38, -0.80, -0.46], curl: 0.3,
    elbow: [-0.22, 0.70, -1.76],
    glove: [-0.290, -0.380, -0.320], gloveAim: [-0.34, -0.50, -0.79], gloveCurl: 0.25,
    gloveElbow: [-0.32, -0.18, -0.12],
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
    // Every other track is the frame's own place between its neighbours.
    t: 1.5575,
    slot: 0.875,
    hipYaw: 1.023125, chestYaw: 1.600, lean: 0.311, leanSide: 0.0, hipY: -0.115, drive: 1.315,
    headPitch: 0.135,
    pivot: { x: -0.144, lift: 0.30, z: -2.020, yaw: 1.100, bend: 0.11, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.23425, hang: 0, cock: 0 },
    ball: [-0.3236, 0.9151, -1.5466], aim: [-0.3871, -0.8071, -0.4387], curl: 0.2822,
    elbow: [-0.2271, 0.6716, -1.7938],
    glove: [-0.28775, -0.40475, -0.311], gloveAim: [-0.34875, -0.489, -0.79425], gloveCurl: 0.254,
    gloveElbow: [-0.3175, -0.1825, -0.1175],
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
    t: 1.575,
    slot: 0.75,
    hipYaw: 1.03625, chestYaw: 1.645, lean: 0.302, leanSide: 0.0, hipY: -0.120, drive: 1.33,
    headPitch: 0.13,
    // The swing's own middle: out over the hip it hangs from with the foot still a
    // hand's width up and the leg at its length — the arc written down.
    pivot: { x: -0.311, lift: 0.30, z: -1.970, yaw: 1.300, bend: 0.12, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.2285, hang: 0, cock: 0 },
    ball: [-0.3268, 0.8924, -1.5710], aim: [-0.3936, -0.8136, -0.4192], curl: 0.2660,
    elbow: [-0.2336, 0.6456, -1.8246],
    glove: [-0.2855, -0.4295, -0.302], gloveAim: [-0.3575, -0.478, -0.7985], gloveCurl: 0.258,
    gloveElbow: [-0.315, -0.185, -0.115],
    glovePalm: [0.386, -0.7905, -0.4675],
  },
  {
    // The swing's own way out: out to the glove side of the body's own line now and on
    // its way down, the shoe turned well out the way the swing went and the knee out
    // beyond it — the side the swing comes round on. This is the last frame before the
    // foot is put down, so it is also where the leg gives up the last of its height.
    t: 1.61,
    slot: 0.5,
    hipYaw: 1.171, chestYaw: 1.720, lean: 0.218, leanSide: 0.0, hipY: -0.105, drive: 1.334,
    headPitch: 0.12,
    // Out to the glove side of the body's own line now, still a hand's width up and on
    // its way down, with the shoe turned well out the way the swing went and the knee
    // out beyond it — the side the swing comes round on, and the far end of it: from
    // here the foot carries *in* as it comes down, across the body's own line and on to
    // the far side of it, which is where the finish stands (see the middles below).
    pivot: { x: -0.536, lift: 0.301, z: -1.760, yaw: 1.750, bend: 0.14, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.217, hang: 0, cock: 0 },
    ball: [-0.3324, 0.8531, -1.6131], aim: [-0.4048, -0.8248, -0.3856], curl: 0.2380,
    elbow: [-0.2448, 0.6007, -1.8779],
    glove: [-0.281, -0.479, -0.284], gloveAim: [-0.375, -0.456, -0.807], gloveCurl: 0.266,
    gloveElbow: [-0.310, -0.190, -0.110],
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
    // Every other track is the frame's own place between its neighbours.
    t: 1.6275,
    slot: 0.375,
    hipYaw: 1.238, chestYaw: 1.755, lean: 0.176, leanSide: 0.0, hipY: -0.085, drive: 1.336,
    headPitch: 0.115,
    pivot: { x: -0.364, lift: 0.255, z: -1.720, yaw: 2.050, bend: 0.16, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.21275, hang: 0, cock: 0 },
    ball: [-0.3348, 0.8367, -1.6307], aim: [-0.4095, -0.8295, -0.3715], curl: 0.2262,
    elbow: [-0.2495, 0.5819, -1.9002],
    glove: [-0.26825, -0.49925, -0.278], gloveAim: [-0.38125, -0.442, -0.81025], gloveCurl: 0.2745,
    gloveElbow: [-0.3075, -0.1925, -0.1075],
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
    t: 1.645,
    slot: 0.25,
    hipYaw: 1.305, chestYaw: 1.785, lean: 0.134, leanSide: 0.0, hipY: -0.060, drive: 1.337,
    headPitch: 0.11,
    pivot: { x: -0.193, lift: 0.214, z: -1.700, yaw: 2.350, bend: 0.18, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.2085, hang: 0, cock: 0 },
    ball: [-0.3368, 0.8224, -1.6460], aim: [-0.4136, -0.8336, -0.3592], curl: 0.2160,
    elbow: [-0.2536, 0.5656, -1.9197],
    glove: [-0.2555, -0.5195, -0.272], gloveAim: [-0.3875, -0.428, -0.8135], gloveCurl: 0.283,
    gloveElbow: [-0.305, -0.195, -0.105],
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
    slot: 0.125,
    hipYaw: 1.373, chestYaw: 1.805, lean: 0.092, leanSide: 0.0, hipY: -0.035, drive: 1.338,
    headPitch: 0.105,
    pivot: { x: -0.021, lift: 0.107, z: -1.578, yaw: 2.700, bend: 0.20, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.20425, hang: 0, cock: 0 },
    ball: [-0.3386, 0.8101, -1.6592], aim: [-0.4171, -0.8371, -0.3487], curl: 0.2072,
    elbow: [-0.2571, 0.5515, -1.9363],
    glove: [-0.24275, -0.53975, -0.266], gloveAim: [-0.39375, -0.414, -0.81675], gloveCurl: 0.2915,
    gloveElbow: [-0.3025, -0.1975, -0.1025],
    glovePalm: [0.2305, -0.72025, -0.64375],
  },
  {
    // The finish: upright out of the fold, the throwing arm done across the body, and
    // the *back* foot landed — the whole body's travel finishes in the feet, which is
    // what a delivery's weight going with the pitch looks like. The pelvis is a full
    // rig unit toward the plate by here, which is 0.36 of a unit past the spot the front
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
    // landing is half a rig unit ahead of the lead foot's own place (0.515, against the
    // 0.604 it stood at before the drive leg's plant was brought in toward that foot —
    // see below), because what the finish has to stand on
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
    t: 1.68,
    // The slot's own say in the lean runs out with the follow-through: the arm's own
    // keys are still in the window, and the recovery below is not.
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.338,
    headPitch: 0.10,
    // ...and it comes down half a rig unit *past* the foot the stride planted on (0.515:
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
    // either way (0.150 across and 0.515 of the stride's own forward travel), the same
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
    pivot: { x: 0.150, lift: 0, z: -1.455, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    glovePalm: [0.20, -0.70, -0.68],
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.34, 0.80, -1.67], aim: [-0.42, -0.84, -0.34], curl: 0.2,
    elbow: [-0.26, 0.54, -1.95],
    glove: [-0.230, -0.560, -0.260], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.30, -0.20, -0.10],
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
    // The throwing arm *lets the throw go*: the landing is the pose the pitch left it
    // in — down across the body, the hand cocked back off a bent elbow, which is what
    // a follow-through *is* — and what the hold stands in is the arm the throw has
    // finished with. It hangs at the side of the body, straight and limp: the hand
    // comes down to the thigh (a hand's width out from it, level with the knee), the
    // elbow opens most of the way to the driver's own limit of what a bare arm may
    // straighten to (see ELBOW_BEND_MAX), and the hand's line runs *on down the arm*
    // instead of cocked back off it (the pose asked for 32° of wrist at the landing,
    // which is past the 30 the driver allows, and asks for none of it here). Both of
    // the numbers are written the way every arm place is — in the frame the body
    // stands in — and the body is 104° round by here, so "beside the body" is most of
    // a right angle off the plate's line: the arm hangs down and *behind* the plate's
    // own line, on the side of him the throw came from.
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
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.338,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.455, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.303, 0.70, -1.648], aim: [-0.42, -0.88, -0.24], curl: 0.3,
    elbow: [-0.12, 0.88, -1.56],
    glove: [-0.220, -0.550, -0.215], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.265, -0.225, -0.085],
    glovePalm: [0.20, -0.70, -0.68],
  },
  {
    // ...the same pose, nine tenths of a second later, to the frame: the hold. Nothing
    // in the body has moved across it — the keys either side are the same numbers, so
    // the track reads flat — and what that buys is the beat a delivery's own
    // follow-through has, where nothing happens: the pitcher standing in what he has
    // just done rather than snapping back to the rubber the moment the trail foot is
    // down. Held
    // to the frame rather than eased: a pose that drifted across the second would be a
    // pitcher swaying in the hold, and what a hold is is a *stop*.
    t: 2.80,
    hipYaw: 1.44, chestYaw: 1.819, lean: 0.05, leanSide: 0.0, hipY: -0.0245, drive: 1.338,
    headPitch: 0.10,
    pivot: { x: 0.150, lift: 0, z: -1.455, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.86, bend: 0.45, hang: 0, cock: 0, flat: 1 },
    ball: [-0.303, 0.70, -1.648], aim: [-0.42, -0.88, -0.24], curl: 0.3,
    elbow: [-0.12, 0.88, -1.56],
    glove: [-0.220, -0.550, -0.215], gloveAim: [-0.40, -0.40, -0.82], gloveCurl: 0.3,
    gloveElbow: [-0.265, -0.225, -0.085],
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
    heightShortfall: slot - scale * anchor.y,
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
for (const key of KEYS) {
  if (!key.ball && !key.clasp) {
    throw new Error(`pitcherSequence: the key at ${key.t}s carries neither a ball nor a clasp`)
  }
  // The same promise about the *trail* arm: a pole is authored per key, or taken
  // from a clasped key's own glove (see mirrorTracks). A key with neither would
  // pose the throwing arm's elbow at the rig's own origin, so it is refused here.
  if (!key.elbow && !key.clasp) {
    throw new Error(`pitcherSequence: the key at ${key.t}s carries neither an elbow nor a clasp to mirror it from`)
  }
}

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
const STRAIGHT_TRACK = KEYS.map((key) => key.straight ?? RELEASE_ELBOW)

// The key the delivery lands in — the first after the release that stands on both
// feet — and the last key of the hold it is left standing in. Read off the keys
// rather than listed, so a re-timed delivery carries its own landing with it: the
// hold is the run of keys the landing's own drive is still written on (the recovery
// below it is not, and neither is the set).
const STANDING = (key) => key.pivot.lift === 0 && key.front.lift === 0
const LANDING_KEY = KEYS.findIndex((key) => key.t > AUTHORED_RELEASE_TIME && STANDING(key))
const HOLD_KEY = KEYS.filter((key, index) => (
  index >= LANDING_KEY && STANDING(key) && key.drive === KEYS[LANDING_KEY].drive
)).pop()
const LANDING_TIME = KEYS[LANDING_KEY].t
const HOLD_END_TIME = HOLD_KEY === undefined ? LANDING_TIME : HOLD_KEY.t

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
// whole of it out with the *drive*, in one motion rather than two: the fall is the frame
// the kick is stood and the back leg starts to carry the body, the plant is the frame the
// stride is out and the front foot has landed, and the roll is complete between them (see
// TILT_DRIVE_TIME and TILT_FULL_TIME, which are those two frames).
//
// The drive and not the kick, and the difference is what the tilt *is*: the body standing
// over the leg the back leg has driven it across. A kick is the front knee coming up over
// a back leg that has not moved the body yet, so a trunk rolled on those frames is a trunk
// leaning off a leg that is still plumb under it — and the roll is not free, because the
// body's own sideways metres are the drive leg's own angle: the pelvis carries the socket
// the leg hangs from across a planted ankle, and a leg is a rigid span, so what crosses
// the pelvis takes off the vertical is the leg's (`stanceDip` is the same triangle read
// the other way — the pelvis comes down by exactly what the slant takes off the span,
// which is what leaves the leg a straight rod rather than a folded one). Measured on the
// game's own wide pitch, taking the roll and the step out of the kick is what stops the
// drive leg swinging: the sidestep had already carried 0.28 m of the 0.45 m it ends on by
// the balance — most of it, on a motion no drive had asked for — and 0.28 m across a
// 0.85 m leg is the better part of twenty degrees off the vertical, at a frame the front
// knee is only coming up. Out with the drive instead, the tilt is one motion with the
// stride: the back leg carries the pelvis forward and across, the front foot goes where
// the body goes (see the step below), and the trunk standing over the leg that carried it
// is the roll. It is complete by the plant, so the anchor the pitch is placed by is built
// on the whole of it.
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
  const from = KEYS[4].t   // the fall: the kick is stood, and the back leg drives the body out
  const full = KEYS[6].t   // the plant: the stride is out, and the foot is where the body is going
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
// body is turning down onto the plant — and it arrives whole at the frame the ball goes,
// so the last of the lean-in is the release's own (see the pose's own read of it).
const LEAN_IN_START_TIME = KEYS[1].t   // the rocker: the last frame the stride foot is on the dirt
const LEAN_IN_TRACK = KEYS.map((key) => {
  if (key.t <= LEAN_IN_START_TIME) return 0
  if (key.t >= AUTHORED_RELEASE_TIME) return key.slot ?? 0   // ...and the window's own share from there on
  const through = (key.t - LEAN_IN_START_TIME) / (AUTHORED_RELEASE_TIME - LEAN_IN_START_TIME)
  return through * through
})

// The frame the stride foot's own turn stops being the keys' and becomes the ground's: the
// frame the shoe is put down on the plate's own line, which is the plant end of the
// stride — the last key the front foot's own place and bearing still move on, and the key
// the boot is left standing on the dirt by (the stretch's own ``lift`` reaches nought
// there, see the key's own note). Read off the keys rather than listed, so a delivery
// whose stride lands on another frame carries its own plant with it.
//
// What it is read *for* is the shoe's own pivot: a shoe the dirt is holding turns about
// its own heel rather than about its ankle, so from this frame on the pose carries the
// ankle round the arc the shoe's own turn sweeps (see the ``leg`` solve below) — a tenth
// of a rig unit of arc rather than the nought the keys' own place would spend.
const FRONT_HEEL_SWEEP = KEYS[10]
const FRONT_HEEL_SWEEP_TIME = FRONT_HEEL_SWEEP.t
// ...and how much of that turn the *ground* is holding, key by key: all of it from the
// plant through the finish, and nought by the clip's own end, because the finish is a
// stance the shoe is stood *out* of — the delivery comes home to the set over the
// walk-back, and the shoe comes up out of the finish and steps back with the body rather
// than being dragged round the dirt on the way (the clip ends in the set it began in, see
// the last key). Shared rather than switched, like every other window here, so the arc the
// ankle is carried round is handed back over the recovery's own frames.
const FRONT_HEEL_TRACK = KEYS.map((key) => {
  if (key.t < FRONT_HEEL_SWEEP_TIME) return 0
  if (key.t <= HOLD_END_TIME) return 1
  if (key.t >= AUTHORED_CLIP_END) return 0
  return (AUTHORED_CLIP_END - key.t) / (AUTHORED_CLIP_END - HOLD_END_TIME)
})

const TILT_DRIVE_TIME = KEYS[4].t   // the fall: the kick is stood, and the back leg drives
const TILT_FULL_TIME = KEYS[6].t    // the plant: the stride is out, and the tilt is standing
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
const TILT_TRACK = (() => {
  return KEYS.map((key) => {
    if (key.t <= TILT_DRIVE_TIME) return 0
    if (key.t < TILT_FULL_TIME) {
      return (key.t - TILT_DRIVE_TIME) / (TILT_FULL_TIME - TILT_DRIVE_TIME)
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
})()

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
// Which frames the hands are together on: the same ``clasp`` the two tracks above
// are built from, read as a weight, so the correction below is full while they are
// clasped and eases out with the break that parts them.
const CLASP_TRACK = KEYS.map((key) => (key.clasp ? 1 : 0))
// Which frames the trail arm is the *lead* arm's own mirror on: a key that leaves
// the elbow number out is one the arm is not doing its own work on, read as a
// weight — full through the clasped windup and eased out across the segment that
// ends at the balance key, which is the elbow raise (see `mirrorTracks` and the
// correction below).
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
const GLOVE_ELBOW_TRACK = KEYS.map((key) => key.gloveElbow ?? [
  key.glove[0] * 0.5 - 0.18,
  key.glove[1] * 0.5,
  key.glove[2] * 0.35 + 0.14,
])

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
    if (!CLASP_KEYS[i]) continue
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
function trackRelease(values, release, s, t, out, stride, shift = null) {
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
function writeReleaseArm(release, s) {
  const aim = release.aim
  const index = RELEASE_KEY_INDEX
  // The key's own aim, as authored: what the pole's own side is read against below.
  // The track is authored for the right hand and mirrored on the way out (see
  // `normalize`), so a lefty's line is stored the other way round its own lateral axis.
  const authored = [_claspAim[index][0], _claspAim[index][1], _claspAim[index][2]]
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

const _ball = [0, 0, 0]
const _elbow = [0, 0, 0]
const _pinned = [0, 0, 0]
const _stance = [0, 0, 0]

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
  // levers: the tilt the anchor solved is handed in over the back leg's *drive* (see
  // TILT_TRACK) and what it could not reach goes out with the *step* (see STEP_TRACK), on
  // the same window — the trunk comes out over the rubber as the back leg carries the body
  // out, the front foot comes with the body it is on, and the two stay there through the
  // throw. The *sink* is the pair's own geometry rather than a number of its own (see
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
  const stanceTrack = trackAt(STEP_TRACK, TIMES, authored)
  const stanceAcross = release.stance * stanceTrack
  const ride = trackAt(PIVOT_RIDE_TRACK, TIMES, authored)
  const sink = stanceDip({ rig, lean: Math.abs(stanceAcross) }) * (1 - ride) - rollLift({ rig, tilt })
  // ...and both of them in the rig's own x, which is the frame the places *outside* the
  // release window are written in and so have to be carried by (see `trackRelease` below).
  const leanAcross = stanceAcross + release.tiltX * tiltTrack

  const at = {}
  for (const track of NUMBER_TRACKS) at[track.key] = trackAt(track.values, TIMES, authored)
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
  // a frame is either inside the release window, or inside the walk, and the walk is the
  // longer of them.
  const leanIn = trackAt(LEAN_IN_TRACK, TIMES, authored)
  const foldShare = slot > leanIn ? slot : leanIn
  // The arm's own straightness this frame, off the keys' own folds (see STRAIGHT_TRACK):
  // the release's chord across the window, and the cock's right angle at the top of it,
  // with the frames between them the ramp the throw straightens on.
  const armStraight = trackAt(STRAIGHT_TRACK, TIMES, authored)
  // The trunk's own fold at the plate, as the pose holds it, beside the *lateral* the
  // pelvis carries (see ``leanAcross`` above): the two are different levers, and the
  // pose is the one place they meet.
  let fold = at.lean + foldShare * (release.lean - at.lean)
  // ...and the share of the chest's own turn the head takes off its look (see
  // LOOK_PIN, which is read on its own clock).
  const look = trackAt(LOOK_TRACK, LOOK_TIMES, authored)
  // The release frame's own hand line is the *arm's*, written from the anchor rather
  // than authored: a straight arm's hand runs on down the line the arm reaches along
  // (see `writeReleaseArm`).
  const releaseArm = writeReleaseArm(release, s)
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
  // goes down (see FRONT_HEEL_SWEEP): what the body had come by on that frame is part of
  // where the shoe was put, and the sweep below anchors its arc on that place rather than
  // on this frame's, so the foot is not carried out with the body a second time.
  const plantAcross = release.stance * trackAt(STEP_TRACK, TIMES, FRONT_HEEL_SWEEP_TIME)
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
  const carried = [leanAcross, 0, 0]
  trackRelease(BALL_TRACK, release, s, authored, _ball, stride, carried)
  trackRelease(ELBOW_TRACK, release, s, authored, _elbow, stride, carried)

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
  const aim = normalize(at.aim, s)
  const gloveAim = normalize(at.gloveAim, s)
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
  const plateBearing = normalize([-release.x, 0.02, -RELEASE_TO_PLATE], 1)
  // ...asked for as the clasp's palm *eased* into the pitch's across the release window,
  // on the same share the arm's own reach is handed over by (see SLOT_TRACK): the hands
  // part with the wrist still turned into the mitt it was holding, and the twist comes
  // round to the throw over the frame or two the arm is coming over. The mitt's own
  // facing and the plate's bearing are a dozen degrees apart on the slotted delivery, so
  // what crosses over is a wrist's own small turn rather than a snap.
  const handPalm = normalize([
    glovePalm[0] + (plateBearing[0] - glovePalm[0]) * slot,
    glovePalm[1] + (plateBearing[1] - glovePalm[1]) * slot,
    glovePalm[2] + (plateBearing[2] - glovePalm[2]) * slot,
  ], 1)
  const ball = [_ball[0], _ball[1], _ball[2]]

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
  chestAt[1] += rig.hip.y + at.hipY - sink
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
  const askedOut = [
    ball[0] - aim[0] * handCarry - throwingSocket[0],
    ball[1] - aim[1] * handCarry - throwingSocket[1],
    ball[2] - aim[2] * handCarry - throwingSocket[2],
  ]
  const asked = Math.hypot(askedOut[0], askedOut[1], askedOut[2])
  const armSpan = rig.arm.upper + rig.arm.fore
  // The chord the pose would take on its own: the bones at the stretch the ask is worth.
  const stretch = clamp(asked / armSpan, 1, ARM_STRETCH_MAX)
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
  if (asked - held > ASK_WHISKER) {
    const reach = reachHeld / asked
    for (let axis = 0; axis < 3; axis += 1) {
      ball[axis] = throwingSocket[axis] + askedOut[axis] * reach + aim[axis] * handCarry
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
  const clasped = trackAt(CLASP_TRACK, TIMES, authored)
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
    for (let axis = 0; axis < 3; axis += 1) {
      ball[axis] += (palm[axis] - ball[axis]) * clasped
      aim[axis] += (line[axis] - aim[axis]) * clasped
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
    const shoeYaw = shoeFrame === 'stance'
      ? s * spec.yaw
      : s * (at.hipYaw + spec.yaw)
    // Where the shoe stands, at this pitch's own stride. A longer delivery is the
    // *same* shape taken further, and a foot is a place in the frame the body stands
    // in rather than a place in the world: the feet ride the extra the pelvis carries
    // them by — the difference between the stroke this pitch is thrown with and the
    // authored one, at this frame's own drive — so the leg's own geometry (what the
    // authored delivery's asks are all sized to) is the same at every stride, and the
    // shoe goes with the hips rather than being left behind by them. The set does not
    // scale: a stance is a stance, and at the set the drive is nought, so a delivery
    // thrown at half a stride still stands on the same two feet.
    const z = spec.z - (stride - 1) * at.drive
    // ...and the lead shoe's own turn once the dirt has it. The stride foot is put down
    // pointing at the plate (that is what the keys down to the plant spend the stride on),
    // and from that frame on the shoe is the *ground's* rather than the keys': the keys
    // author the shoe's angle to the body there, so every degree the pelvis comes round
    // over the foot, the shoe turns with it — which is the whole of the follow-through's
    // own yaw. What a shoe the dirt is holding cannot do is skid round its own ankle, so
    // what the turn really pivots about is the shoe's own heel — the tenth of a rig unit
    // behind the ankle the keys name (see FRONT_HEEL_SWEEP) — and the *ankle* is carried
    // round the arc that turn sweeps while the heel keeps the place the plant left it on.
    // That is the difference between a leg coming round with the body and a body wringing
    // over a foot that stood its ground: the keys' own place spends nought on it, and the
    // arc is 0.057 of a unit between the plant and the landing, which is what the heel
    // would otherwise drag across the dirt. Written in the keys' own frame — mirrored into
    // it by the hand the pose is read on, like every other place the keys author.
    const plantYaw = s * (FRONT_HEEL_SWEEP.hipYaw + FRONT_HEEL_SWEEP.front.yaw)
    const sweep = trackAt(FRONT_HEEL_TRACK, TIMES, authored)
    const plantZ = FRONT_HEEL_SWEEP.front.z - (stride - 1) * FRONT_HEEL_SWEEP.drive
    // ...and the plant's own lateral, which is the foot's own place *plus* the carry the
    // body had come by on that frame (see ``frontFoot``): read at the plant rather than
    // here, because the metres the body has spent getting out over the rubber are part of
    // where the shoe went down, and a sweep anchored on the frame's own carry would carry
    // the foot out with the body a second time.
    const plantX = FRONT_HEEL_SWEEP.front.x + s * plantAcross
    const swept = shoeFrame !== 'body' || sweep === 0
      ? { x: 0, z: 0 }
      : {
        // The plant's own place, less this frame's, plus the arc the shoe's turn sweeps
        // about its heel. The place's own part is written in the keys' frame and so is
        // mirrored into it; the arc is a turn of the shoe's *bearing*, which is already
        // the rig's own number with the hand's mirror in it, so it is added as it stands —
        // a left-hander's shoe comes round the other way and its heel stays put just the
        // same (see the mirror test's own reading of this).
        x: sweep * (
          s * (plantX - spec.x)
          + (Math.sin(plantYaw) - Math.sin(shoeYaw)) * rig.heelOffset.z
        ),
        z: sweep * (
          plantZ - z
          + (Math.cos(plantYaw) - Math.cos(shoeYaw)) * rig.heelOffset.z
        ),
      }
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
        s * spec.x + swept.x + bend.x * spec.bend,
        // A carried leg's knee is asked for by its own height — the lift is the
        // kick's, so it reads up the leg's own line — and a standing one's by the
        // knee's own travel, which is what the driver reads it for: a shape, not a
        // place. The height is the same ``rise`` the direction above is built from,
        // so the line the solve is pointed at and the line it is handed as a place
        // are the same line wherever the bend's own push is the thigh's own length.
        rig.hip.y + rise,
        z + swept.z + bend.z * spec.bend,
      ],
      ankle: [s * spec.x + swept.x, rig.ankleY + spec.lift, z + swept.z],
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
  // The body's own step down the mound's slope, as the caller handed it: nought at
  // the release and the whole of it by the landing (see SETTLE_TRACK), so the
  // delivery takes the step over the drive rather than at the frame the shoes touch.
  const step = settle * trackAt(SETTLE_TRACK, TIMES, authored)

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
      rock: 0,
      // ...and the *body's* own carry of the same line, in the rig's own x: the metres the
      // trunk's roll could not reach, paid for by the step (see STANCE_SIDE_MAX and
      // STEP_TRACK). It is a translation of the pelvis like the height below it — the
      // stride foot's own place is authored across by the same metres, so the body goes
      // where its step goes — and the leg under the *drive* foot answers it, which is the
      // trade the two levers are: the drive leg slants under a pelvis that has come off
      // it, and the sink below leaves it a straight rod while it does (see `stanceDip`).
      offsetX: stanceAcross,
      offsetY: at.hipY - sink,
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
        local: [
          s * (at.glove[0] - 2 * rig.shoulder.halfWidth),
          at.glove[1],
          at.glove[2],
        ],
        aimLocal: gloveAim,
        // Which of the two forms this frame is written in: nought — the glove's own
        // frame — while the hands are together, easing out to one (the rig-frame
        // place above) as the break parts them. The two agree at the keys either
        // way; what this crosses over is which *body* the hand is read on.
        mix: 1 - clasped,
        // Authored as a place, like the ball (and mirrored with it, above): the
        // keys' own numbers sit next to the ball's, and the release window's ride
        // the release point with it.
        elbow: [_elbow[0], _elbow[1], _elbow[2]],
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
        // ...and the *ball*'s own carry down the hand's line, which the hand above
        // has given the straighter reach back out of (see ``handCarry``): the driver
        // carries the ball it is holding down the hand's own line, and the number is
        // the pose's here for the same reason the arm is — the release's own ask is
        // not the model's own palm's, and a driver left to the model's would carry the
        // ball a few millimetres past a release point the pose has pinned exactly.
        carry: handCarry,
        shoulderBend: 0.97 + slot * (snap - 0.97),
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
        // the window's own ramp.
        palm: handPalm,
        palmMix: clasped > slot ? clasped : slot,
      },
      {
        side: -s,
        // The glove is held in front of the chest, so it is authored from its own
        // shoulder in the chest's frame: the chest can turn under it.
        local: [s * at.glove[0], at.glove[1], at.glove[2]],
        aimLocal: gloveAim,
        // Which way the glove's palm faces, in the rig's own frame: the twist of
        // the hand is the *delivery's* number rather than the chest's, so it is
        // written where the pitch goes (see the keys' own ``glovePalm``).
        palm: glovePalm,
        elbow: gloveElbow,
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
