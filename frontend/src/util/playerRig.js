import * as THREE from 'three'

// ---------------------------------------------------------------------------
// player.glb bone driver.
//
// The batter's animation is authored in Batter.jsx as a set of joint targets in
// *rig units* (feet at y = 0, the batter facing -Z so the pitcher is at -Z, the
// body SPRITE_NOMINAL_HEIGHT_M tall). This module keeps that tuning — the front
// leg's step, the back leg's drive, the hip thrust, the torso turn and the
// follow-through are all still the numbers the component computes — and maps it
// onto the skinned player model from solomon-gumball: the same hip, leg, arm and
// head targets pose the real skeleton through 2-bone IK, so the data-driven
// contact geometry (attack angle, swing path tilt, sweet spot) is untouched. The
// bat is still placed analytically from the trajectory and the hands are pulled
// onto it.
//
// Frames:
//   * rig units   - the tuning's frame: feet at y = 0, +x / +z world-aligned,
//                   SPRITE_NOMINAL_HEIGHT_M tall. Everything Batter.jsx computes
//                   (and every target this driver receives) is in this frame.
//   * model space - the glTF's own frame: the model rests facing +Z. The two
//                   differ by a half turn and a uniform scale, and the component
//                   places the model with exactly that transform, so the mapping
//                   is all this module needs (the model's position in the scene
//                   never enters the maths).
//
// Bone rotations are built as "turn the bone's rest orientation onto the desired
// one", which keeps the twist the reference rig authored instead of fighting
// Blender's bone rolls.
//
// GLTFLoader sanitizes node names, so the authored ``spine.002`` arrives as
// ``spine002`` and ``shoulder.L`` as ``shoulderL``.
// ---------------------------------------------------------------------------

export const PLAYER_BONES = {
  spine: 'spine',
  spine01: 'spine001',
  spine02: 'spine002',
  neck: 'neck',
  head: 'spine006',
}

// Bones that hold the bat's handle: ``upperArm`` is the shoulder joint,
// ``hand`` the wrist, ``fingers`` the hand's aim direction, and ``thumb`` the
// thumb — the four fingers are one bone in this rig, and it and the thumb are
// the two that close round the handle (see FINGER_CURL).
export const ARM_BONES = {
  L: {
    shoulder: 'shoulderL',
    upperArm: 'upper_armL',
    forearm: 'forearmL',
    hand: 'handL',
    fingers: 'fingersL',
    thumb: 'thumbL',
  },
  R: {
    shoulder: 'shoulderR',
    upperArm: 'upper_armR',
    forearm: 'forearmR',
    hand: 'handR',
    fingers: 'fingersR',
    thumb: 'thumbR',
  },
}
export const LEG_BONES = {
  L: { hip: 'thighL', knee: 'shinL', ankle: 'footL', toe: 'toeL' },
  R: { hip: 'thighR', knee: 'shinR', ankle: 'footR', toe: 'toeR' },
}

// Meshes the batter does not wear: the cap and both gloves (a batter wears a
// helmet and holds the bat with bare hands). Same choice the reference makes for
// its offensive players.
export const HIDDEN_MESHES = ['CAP', 'GloveL', 'GloveR']

// How many samples the shoulder's reach is solved over.
const SHOULDER_STEPS = 12
// How far the clavicle may swing to close the gap to the grip. The shoulder
// girdle is part of the arm's reach, but it is a *clavicle*: a real one
// protracts and elevates a couple of dozen degrees, and its skin carries the
// whole upper chest, so a bigger swing shoves the ribcage around the way the
// pelvis turned — the chest visibly twisting away from the torso. Past this the
// arm stretches instead (see ARM_STRETCH_MAX).
const SHOULDER_MAX_SWING = THREE.MathUtils.degToRad(20)
// How much of the arm's span the clavicle's swing aims to leave the arm needing:
// the shoulder reaches until the hand is within this share of the arm's own
// length, not until the arm is stretched straight. A straight arm has no elbow
// to steer — the two-bone IK's elbow sits on the shoulder-to-hand line and the
// elbow hint only slides it a millimetre either way — so an arm solved to the
// very edge of its reach lies along that line, and that line is a chord across
// the chest wherever the hands are held near the body. Leaving this much slack
// gives the elbow a couple of centimetres of bow to be pushed out of the chest
// with, which is what the hint is for.
const ARM_SHOULDER_BEND = 0.97
// How far the arm's bones may stretch. The reference rig's limbs were elastic
// cylinders (its forearm nearly doubled in length through the swing), and the
// tuning's hand path is authored against that: at contact, and mid-swing, its
// hands sit further from the shoulder than this model's arms can span. Bone
// scale along the bones' own axes reproduces the old rig's reach, and the glove
// compensates so it is not stretched with the arm.
const ARM_STRETCH_MAX = 1.25

// The two limits every wrist is held to (see the arm solve): the fist may not
// bend more than WRIST_BEND_MAX off its own forearm in any direction, and may not
// roll more than WRIST_TWIST_MAX about it. Where they are answered: the twist, by
// the forearm itself — a roll of the bone about its own axis, which is where a
// real arm's pronation lives and which leaves the hand, and the handle in it,
// exactly where the grip put them. The bend, by the elbow's own circle and by the
// fist's own roll *about the barrel*: a fist can turn about the handle with its
// palm's channel still on it, and that roll sweeps the hand's own direction (its
// knuckles' line) around the bat — which is the one free axis a grip leaves, and
// is what `fistRoll` in the arm solve spends.
//
// 30 degrees is as tight as the swing's own geometry closes, and the windows it
// does not close are the arm's own stretch rather than the solve's. Measured over
// the cycle, taking the elbow to every point of its circle and the roll to the
// best of its whole turn (dev-measure, 0.005 s steps, both read off the posed
// bones), the floor a wrist can be held at is under 30 degrees everywhere except
// three windows — 0.52-0.62 s, 0.82-0.90 s and 1.27-1.33 s — where it reads 31
// to 52. All three are the same pose: the arm is at the end of its span, so the
// elbow's own circle has no width to swing the forearm's line on. Through
// 0.52-0.62 s the shoulder-to-grip distance reads 0.676-0.793 rig units against
// the arm's own 0.743 (stretched to 1.068 of its length at 0.54 s), and at 0.60 s
// — 0.715, or 96% of the span — the circle is a nought-wide ring on the
// shoulder-to-grip line itself. There the forearm's own angle to the barrel is
// whatever the straight arm makes it, and the roll's floor (|90 minus that angle|)
// is all the wrist has left. Closing the rest is a question for the pose — where
// the hand path puts the grip relative to the shoulder, and the bat's own tilt —
// not for the solve, and the driver reports the floor it could not reach
// (debug.arms[].bendFloor) rather than pretending the limit held.
// Exported because the suite asserts against the same numbers it reads here.
export const WRIST_BEND_MAX = THREE.MathUtils.degToRad(30)
export const WRIST_TWIST_MAX = THREE.MathUtils.degToRad(10)
// And how upright the plane's own normal has to be before "below the plane" is a
// direction at all. The plane's normal is taken as its upward half, so as the bat
// comes back up over the shoulder the normal sweeps through horizontal and its own
// sign changes with it — the half-space that holds the ground is one thing on one
// side of that moment and the other thing on the other. It is not a bug in the
// reading: a plane standing on edge does not have a below. So the lead arm's two
// plane rules relax over the last stretch of the sweep, by the arm's own span at a
// fully upright normal and by nothing at a normal `PLANE_UP_MIN` or more off
// vertical, which is a continuous fade through the pose where the flip happens
// (measured: the sweep takes ~0.03 s, and a rule that held on to a fixed side of
// the plane snapped the lead fist a whole reach sideways across it). The suite's
// own reading of the elbow against the plane rides the same fade.
const PLANE_UP_MIN = 0.25
// The same hair for the wrist's own side of it, which the fist's roll answers
// for: a wrist sitting exactly in the plane reads as under it, so a pose that can
// only put it on the plane is not chased past it.
const WRIST_PLANE_SLACK = 1e-4
// How finely the elbow's own circle is sampled when the bend has to move it.
// Only reached where no roll can hold the limit, which the pose measures at a
// handful of samples a cycle.
const ELBOW_SEARCH_STEPS = 48
// The samples are a coarse net over the circle, and the answer is then *solved
// for* inside the bracket they leave: the nearest point an elbow can sit that
// holds the limit where one exists, and the lowest floor it can reach where none
// does. Picking the nearest sample instead leaves the elbow hopping a sample's
// own arc — measured at 48 steps, 0.17 rig units of hand height between two
// frames of the follow-through, which is the flicker this refinement removes.
const ELBOW_REFINE_STEPS = 18
// How many times the fist's roll and the elbow's own rules are settled against
// the arm they produce: each pass poses the arm at the answers so far, reads the
// arm that pose gives, and moves each answer a step towards where *that* pose's
// own rule would put it. The two are coupled — rolling the fist swings its reach
// round the handle and carries the wrist with it, so the circle the elbow can sit
// on and the forearm its rules are asked about both move with the roll — and this
// is what lets each rule stay a plain function of the pose it is asked about
// while the pair of them still lands together. Four is where the roll's own damped
// step reaches its answer, and the passes are not free: with the roll's window open
// (see GRIP_ROLL_MAX) every candidate's roll is a real answer rather than a skipped
// one, so the walk costs several times what it did when the window held the roll at
// the pose's own, and the sweep of a whole cycle is what notices.
const ARM_SOLVE_PASSES = 4
// How much of each step towards a rule's answer is taken. The two rules are not
// contractions of each other, so an undamped pass rings: measured, half a step
// settles the pair within a degree or two by the eighth pass, where taking the
// whole step hopped the roll -63, -6, -81, +16 and +24 degrees across five frames
// of the unwind.
const ROLL_SETTLE = 0.5

// How much of the turn beyond the hips is taken by the waist band, with any rest
// going onto the ribcage above it. It is deliberately all of it: the swing's
// hip-to-shoulder separation is a *torsion*, and the torso is carried by three
// skin regions (the pelvis, the waist and the ribcage). Taking it all at the one
// joint between the pelvis and the ribcage leaves both regions rigid and wrings
// only the short band of skin at the waist; spreading it over the two joints
// instead rolls the whole abdomen along the leaning spine, which is what reads as
// a towel being wrung.
const WAIST_TWIST_SHARE = 1

// The body as rigid parts joined by narrow bands.
//
// A skinned mesh only deforms where two bones' skin regions blend: inside one
// region the surface moves rigidly with that bone. player.glb's own weights are
// soft, though — they spend a third of the pelvis's skin on the *thigh* bones and
// a fifth of the torso's on the pelvis — so the hips bend across a band nearly
// half a torso tall, and a lean leaves the belt shearing into the stomach while
// the pelvis itself stays put with the legs. The driver instead cuts the weights
// into the parts the animation really models — an artist's doll:
//
//   legs    - each thigh/shin/foot, kept as the model authored them, so the knee
//             and ankle bands stay the model's own
//   pelvis  - the trunks, from the hip crease up to the waistband
//   torso   - the waist, the ribcage and everything up to the neck
//   head    - the head and the helmet, hinged at the neck so the look turns the
//             head instead of wringing the neck and the collar with it
//
// Bones the driver turns *together* can be blended freely: any blend of them
// reproduces the same rigid motion. So a part keeps its own internal detail (the
// knee's thigh/shin split, the hip muscles' blend) while the *boundaries* between
// parts are re-cut by height, and every joint's motion is absorbed by the narrow
// band of skin between two parts rather than smeared through them.

// The bones of each part. Exported because the weight cut is the thing the tests
// and the pose sheet need to talk about in the same terms the driver cuts it:
// which bones carry which part, and nothing else.
export const PELVIS_BONES = [PLAYER_BONES.spine, 'pelvisL', 'pelvisR']
export const TORSO_BONES = [PLAYER_BONES.spine01, PLAYER_BONES.spine02]
export const LEG_BONES_ALL = Object.values(LEG_BONES).flatMap((side) => [side.hip, side.knee, side.ankle, side.toe])
// The head: the model turns it with the neck bone and carries it on the head
// bone, and those two are the driver's own turn (``setRotation(PLAYER_BONES.neck,
// ...)``, the head's look relative to the torso), so blending them is free.
export const HEAD_BONES = [PLAYER_BONES.neck, PLAYER_BONES.head]

// Where the bands between them sit, in rig units. The hip crease is placed on the
// hip joints themselves (thighL / thighR rest at rig 1.158), which is where a
// doll's legs hinge. The waistband is not a constant at all: it is the uniform's
// own trouser band, read off the model's base-color texture at load time (see
// ``measureWaistband``), so another player model or another uniform still gets
// its twist taken at its own waistband. Each band is left as wide as the
// reference skinning's own (its 25-75% spanned ~0.12), since a narrower one
// pinches.
const HIP_BAND_BOTTOM = 1.10
const HIP_BAND_TOP = 1.18
// The neck, where the head hinges, placed on the neck joint itself (the neck bone
// rests at rig 1.885) the way the hip crease is placed on the hip joints — read
// off the model's own skeleton rather than hard-coded. The model blends the
// ribcage into the head across 1.87-1.93, so the band is that joint's own
// neighbourhood: half a band's width either side of it, the same 0.08 the hip
// crease is given.
const NECK_BAND_HALF_WIDTH = 0.04
// And *which* skin turns with the head. The model's own weights do not make the
// distinction a neck needs: it spends a fifth to three quarters of the trapezius
// — skin at the *shoulder joints'* own radius, carried by the clavicles — on the
// head's bones too, so the batter's look coming round wrings the top of the chest
// along with the neck. That is the neck twisting like a towel. The distinction
// that *is* in the model: the neck's own skin is weighted to the body's parts,
// and the trapezius to the arms'. So a vertex turns with the head only where the
// model put at least this much of it on the body rather than on the arms — where
// the shoulder joints' own skin begins, the head's motion stops.
const NECK_BODY_SHARE = 0.5

// How the waistband is looked for, when the texture is read. The search runs from
// the hip socket up to half way to the neck: a waistband is between the hips and
// the ribs, and stating the window as a share of the model's own hip-to-neck span
// keeps it right for a rig of any proportions.
const WAIST_SEARCH_SHARE = 0.5
// And where the band is taken to be when the texture *cannot* be read — a model
// with no base-color image, or a canvas the browser will not hand back its pixels
// for. These are the same shares of the hip-to-neck span that the uniform's band
// measures on the model this was developed against (rig 1.26-1.30 on a 0.727 span),
// so the fallback is the recorded band, restated in proportions rather than in
// rig units.
const WAISTBAND_FALLBACK = [0.14, 0.2]

// Reading the band off the texture: the trunk's ring is sampled every 0.005 rig
// units, each sample counting for the 0.015 either side of it (the mesh is too
// coarse to read a 0.04 band off single heights), and the waistband is the lowest
// run of heights where most of the ring is drawn in the uniform's trim colour.
// Half the ring is the test that separates a waistband from a *stripe* — a trouser
// stripe covers a sliver of the ring at every height, a waistband goes all the way
// round — and the run has to be at least a band and no taller than a waistband.
const WAISTBAND_STEP = 0.005
const WAISTBAND_SPAN = 0.015
const WAISTBAND_SHARE = 0.5
const WAISTBAND_MIN_SAMPLES = 4
const WAISTBAND_MIN_WIDTH = 0.02
const WAISTBAND_MAX_WIDTH = 0.12
// The trim colour, as the texture draws it: the belt's own red. The test is on
// the model's samples rather than on the material — a texel is trim when it is
// bright enough to be lit cloth rather than shadow, and red-dominant by more than
// a shade's worth of shading. A different uniform drawn in a different trim
// colour is re-pointed by changing these two numbers; the heights are the model's
// either way.
const WAISTBAND_TRIM_MIN = 0.3
const WAISTBAND_TRIM_GAP = 0.15

// The belt is a *cut*, not a band. Everything the swing turns lives between the
// hips and the shoulders, and the belt is where the trousers meet the jersey —
// two pieces of clothing, not one piece of skin. A band of skin across the belt
// can only answer the turn by stretching, and the belt is 0.08 rig units tall
// against a 0.139 rig unit pull, which is what read as the jersey wrung over the
// hips. So the surface is cut open along the belt's own top edge instead (the
// uniform draws the jersey's hem there), the skin below belongs to the pelvis and
// the skin above to the torso, and the two edges slide over one another the way
// the clothing does. Nothing spans the cut, so nothing there can stretch.

// What hides under the cut: a duplicate of the body's own surface either side of
// it, inset toward the body's axis and weighted rigidly to the pelvis — the belt
// continuing under the jersey, rather than a hole and the body's inside.
//
// ``MARGIN`` is how far past the cut it runs: the surface's own faces at the belt
// are 0.03-0.04 rig units tall, and a spin about the body's up axis carries a ring
// perpendicular to it onto itself, so the seam opens by a fraction of that.
//
// ``INSET`` is how much smaller than the body it is, as a share of its radius, and
// it is not a small number for a reason worth recording: the waist's section is
// much wider than it is deep, so the swing *rotates* that section past the belt,
// and where the section is widest the jersey's hem swings inward by a fifth of the
// radius — a sleeve any bigger than that is poked through by the jersey it is
// meant to hide under. The suite measures that swing in every phase
// (`probeSleeve`) and requires the inset to cover it.
const SLEEVE_MARGIN = 0.09
const SLEEVE_INSET = 0.25

// How much of the torso's own forward drive the pelvis carries. The drive is
// authored in Batter.jsx as the upper body coming forward over the hips — the
// reference rig's upper group sliding forward inside the lower one — and in a
// single skinned mesh that slide is a *translation* between two blocks of skin.
// A band can only answer a translation by stretching, and the belt band is 0.08
// rig units wide: left on the torso it is pulled 0.33 rig units further than the
// pelvis at mid-swing, more than the band is tall, which is exactly the gap that
// reads as the torso having slid off the pelvis. Given to the pelvis instead,
// the whole lower body travels forward *with* the torso — the two blocks keep
// their distance, the belt only ever takes the swing's turn, and what the hip
// crease absorbs is the legs' angle, which is the joint's own motion. Either way
// the chest lands in the same place, so the swing's geometry, the arm solves and
// the bat's contact are untouched. Measured on the cut: the belt band is pulled
// 0.465 rig units apart at mid-swing with the slide left on the torso and 0.139
// with it given to the pelvis (0.373/0.043 at contact), while the hip crease
// reads 0.179 either way — the tear moves off the belt without landing anywhere
// else.
const PELVIS_DRIVE_SHARE = 1

// The parts, by the bones that carry them, for anything that has to name them
// from outside the driver (the strain probe the suite and the pose sheet use).
export const PART_BONES = {
  pelvis: PELVIS_BONES,
  torso: TORSO_BONES,
  legs: LEG_BONES_ALL,
  head: HEAD_BONES,
}

// Each bone's own axis runs to the joint it drives, so the solver knows which
// way the bone points before it aims it.
const AIM_CHILD = {
  shoulderL: 'upper_armL',
  shoulderR: 'upper_armR',
  thighL: 'shinL',
  shinL: 'footL',
  footL: 'toeL',
  thighR: 'shinR',
  shinR: 'footR',
  footR: 'toeR',
  upper_armL: 'forearmL',
  forearmL: 'handL',
  handL: 'fingersL',
  upper_armR: 'forearmR',
  forearmR: 'handR',
  handR: 'fingersR',
}

const UP = new THREE.Vector3(0, 1, 0)
// The model's own left-right axis; a link's turn is reported as where it ends up.
const RIGHT_AXIS = new THREE.Vector3(1, 0, 0)

// Where the model's own bat-holding rig says the handle sits in each palm: the
// node names, and the scratch used to solve the fist onto it (see handFrames and
// fistRotation).
const PALM_HANDLES = { L: 'palm_handleL', R: 'palm_handleR' }
// The model's own two-hand grip, stated as one IK target per hand. How far apart
// the rig stacks them along the handle is the separation the two fists should be
// gripped at — read rather than tuned, because it is the spacing this model's
// hands were modelled for: they are moulded with the fingers curled, so stacking
// them back to back instead of at the rig's own spacing drives one hand's fingers
// into the other (see measurePlayerRig).
const BAT_HAND_TARGETS = ['BatBottomHandIK', 'BatTopHandIK']
// How far the fingers and the thumb are closed round the handle, in radians. A
// hand solved onto the bat has its *palm* on the handle — the palm is what the
// rig places — but the model's fists are moulded open, with the four fingers (one
// bone) running past the handle and away from it, so the fingers lie alongside
// the barrel instead of gripping it. Measured off the posed skin: every one of
// the fingers' own vertices sat on the palm's side of the handle's axis, further
// from it than the palm's own skin.
//
// A fist closes about the bar it is holding: the fingers hinge on the knuckle
// line, which is parallel to the bar, so the fold is a turn about the handle's
// own axis — the same axis the palm was turned onto — taken through the knuckle
// (see curlGrip). The thumb comes at the handle from the other side and closes
// the other way, being the shorter, thicker digit.
const FINGER_CURL = 2.15
const THUMB_CURL = 0.3
// Which way round the handle each hand closes. The two hands are mirror images,
// so the same fold turns opposite ways once the axis is written in each hand's
// own rest frame — and *which* way is a fact about the model, not about us: the
// sign is read off the hand's own knuckle and the handle's own point in the palm
// (see curlSign), so another model's mirroring is still its own.
// Scratch for the elbow's own rules: the circle a middle joint can ride, the
// direction a rule moved it to (held across the passes of one arm's solve), and
// the flat the bat swings in. The hand's own frame is built and rebuilt per
// pass, so its quaternions are kept across passes too.
const _barrel = new THREE.Vector3()
const _planePerp = new THREE.Vector3()
const _planeNormal = new THREE.Vector3()
const _circleCentre = new THREE.Vector3()
const _circleAxis = new THREE.Vector3()
const _elbowPoint = new THREE.Vector3()
const _handAim = new THREE.Vector3()
const _foreAim = new THREE.Vector3()
const _perpHand = new THREE.Vector3()
const _perpFore = new THREE.Vector3()
const _perpNormal = new THREE.Vector3()
const _circleAcross = new THREE.Vector3()
const _circleV = new THREE.Vector3()
const _candidate = new THREE.Vector3()
const _candidateDir = new THREE.Vector3()
// The direction the elbow's own rules moved it to (held across the passes of one
// arm's solve, since a rule that has moved an elbow has no reason to move it
// back), and the two candidates the bend's search keeps as it walks the circle.
const _wantedDir = new THREE.Vector3()
const _bestDir = new THREE.Vector3()
// The floor the last `readAt` in the elbow's own search found, in radians.
let _floorHere = 0
const _lowestDir = new THREE.Vector3()
const _fistHome = new THREE.Quaternion()
const _rollTurn = new THREE.Quaternion()
const _handTurn = new THREE.Quaternion()
const _upperTurn = new THREE.Quaternion()
const _foreTurn = new THREE.Quaternion()
const _twistTurn = new THREE.Quaternion()
const _relative = new THREE.Quaternion()
// The hand's own direction and the fist's reach *at the pose's own roll*: the two
// questions a roll answers are both asked of these, since a roll about the barrel
// turns either of them with the hand, and their own angles to the barrel are what
// their answers are built from.
const _handHome = new THREE.Vector3()
const _reachHome = new THREE.Vector3()
const _elbowPosed = new THREE.Vector3()
const _elbowShift = new THREE.Vector3()
// The square parts of two vectors about an axis — what a roll about that axis
// actually moves — and the axis crossed with the first of them: what
// `squareAngle` reads its answer off.
const _squareFrom = new THREE.Vector3()
const _squareTo = new THREE.Vector3()
const _squarePivot = new THREE.Vector3()

/**
 * Where a two-bone chain's middle joint can be: the circle the two bone lengths
 * put it on, about the line from the root to the target. The two-bone solve above
 * builds the same numbers to place one elbow; the rules that *move* an elbow move
 * it on this circle, so they can ask a candidate point what it would do (which
 * direction the forearm would take, and which side of a plane the elbow would be
 * on) without solving the chain again.
 *
 * @param {THREE.Vector3} root the chain's first joint
 * @param {THREE.Vector3} target the joint being reached
 * @param {number} length1 the first bone's length
 * @param {number} length2 the second bone's length
 * @returns {{centre: THREE.Vector3, axis: THREE.Vector3, radius: number}}
 */
function middleJointCircle(root, target, length1, length2) {
  _circleAxis.copy(target).sub(root)
  const distance = Math.min(_circleAxis.length(), (length1 + length2) * 0.999)
  _circleAxis.normalize()
  const along = (length1 * length1 - length2 * length2 + distance * distance) / (2 * distance)
  _circleCentre.copy(root).addScaledVector(_circleAxis, along)
  return {
    centre: _circleCentre,
    axis: _circleAxis,
    radius: Math.sqrt(Math.max(0, length1 * length1 - along * along)),
  }
}

/**
 * An angle folded into the half turn either side of zero — the shortest way round
 * to it. A roll's own angle is read this way everywhere below, so that the band of
 * rolls holding a limit can be stated as a clamp on a difference rather than as a
 * branch, and so that a roll of 350 degrees is understood as the ten it really is.
 */
function halfTurn(angle) {
  if (angle > Math.PI) return angle - Math.PI * 2
  if (angle < -Math.PI) return angle + Math.PI * 2
  return angle
}

/**
 * The angle a roll about `axis` has to turn `from` by to line up as much of it
 * with `to` as a roll can: both vectors are cut back to their square parts (what
 * the roll actually moves) and the signed angle between those parts is read off a
 * basis built on the first of them. This is the whole of what a roll about a
 * barrel has to say — the bend at a wrist bottoms out at this angle, and so does
 * a fist's own reach against the bat's plane. Zero where either vector lies along
 * the axis, since neither then has a square part to line up.
 */
function squareAngle(from, to, axis) {
  _squareFrom.copy(from).addScaledVector(axis, -from.dot(axis))
  _squareTo.copy(to).addScaledVector(axis, -to.dot(axis))
  if (_squareFrom.lengthSq() < 1e-12 || _squareTo.lengthSq() < 1e-12) return 0
  _squareFrom.normalize()
  _squareTo.normalize()
  return Math.atan2(
    _squareTo.dot(_squarePivot.crossVectors(axis, _squareFrom)),
    _squareTo.dot(_squareFrom),
  )
}

// The bend the roll `fistRoll` last chose leaves between the hand and the forearm,
// and the lowest bend any roll could reach there, both in radians. A caller that
// has just asked for a roll wants the first as much as the roll itself — it is
// what the roll spent the rest of its turn on — and the second is the number that
// says whether a limit was kept or was past the arm's own reach. Reading either
// back here costs nothing where working it out again would be the same arithmetic
// a second time. (Same contract as ``_floorHere`` in the elbow's own search.)
let _rollBend = 0
let _rollFloor = 0
// Where the roll's two rules would each have put it, and how wide the arc either
// of them can be held over, all in radians off the pose's own roll: the plane's own
// ideal (the roll that sinks the wrist as deep as the reach can go) and the bend's
// (the roll that lines the knuckles' line up with the forearm). Reported by the arm
// solve so a pose can be read against the window a grip actually has (GRIP_ROLL_MAX).
let _rollPlaneIdeal = 0
let _rollPlaneHalf = 0
// The deepest side of the plane the wrist can be put at by any turn inside the fist's
// own window (see the arm solve's `rollWindow`): the number that says whether a wrist
// found over the plane is a limit the roll *could* have kept — nought where the whole
// window is spent and the wrist is still over means the pose's own phase is what is
// left, and not the rule.
let _rollWindowDeepest = 0
let _rollBendIdeal = 0
let _rollBendHalf = 0

// How far the fist may turn on the handle before the grip's own mesh stops being a
// grip. The roll is the one degree of freedom a fist leaves, but only so far: the
// model's palm closes on the handle in one particular turn (its own ``palm_handle``
// channel), and a fist rolled far round the barrel is a hand turned *around* the
// bat rather than holding it. What that costs is *nothing the suite can see*: the
// handle is in the palm at every roll (the roll is about the barrel's own axis, so
// the channel it turns the fist around is the one the handle runs through), the
// fingers still fold round it, and the readings that were blamed on it — the lead
// palm 0.0109 rig off the handle's axis at contact, the trail palm's skin leaving
// the handle's near side — read 0.0109 and worse with the window at nought and at
// fifteen degrees, so they were never the roll's.
//
// What the *bend* wants is the whole alignment, and the bend cannot have it: the
// bend is the angle between the hand's own axis and the forearm's, and it bottoms
// out when the fist's roll lines the knuckles' line up with the forearm's own part
// square to the bat — measured, the pose authors that alignment 15 to 80 degrees
// out over the cycle (the trail arm asks 55 at the set stance, 76 through the
// follow-through), and freeing the roll to take it took the trail's floor from
// 114.8 degrees to 30.0. But the grip pays for every degree of it *at the frames
// the suite pins*: with the window at a right angle the set stance's right palm
// reads 0.0332 rig off the handle's axis where the test allows 0.01 — the fist's
// own grip geometry, not the roll's reach (the same frame reads 0.0004 with the
// roll held at the pose's). Fifteen degrees is what the stance holds with room to
// spare (0.0004 there, and the palm's own swing stays inside the bound), and it is
// the honest limit of the window: the phase is the *grip's* to author, not the
// solve's, and a pose that wants the rest of it has to move the fist itself.
const GRIP_ROLL_MAX = THREE.MathUtils.degToRad(15)
// Why the lead wrist's own rule does not get a wider one, though it is the rule that
// would use it: the turn is what sinks that wrist under the bat's plane, and the
// plane sweeps across the arm by a hundred and fifty degrees through the push, so a
// wider window really does buy the plane — measured, the lead wrist over the plane
// falls from 19 samples of 67 to 6 as the window goes 15 -> 75 degrees. It is paid for
// in *continuity*, and the price is steep: the deepest turn inside a window sits at
// whichever edge is nearer the plane's own answer, so as that answer sweeps past the
// window's far side the fist flips a whole window wide in one frame. Measured at
// 0.35 s, one frame of the follow-through: the lead hand moves 0.237 rig units with
// the roll held to the pose's own (which is the swing itself moving), 0.237 with the
// window at fifteen, 0.295 at thirty, 0.394 at sixty and 0.418 at seventy-five — and
// the roll itself jumps 112 degrees in that frame at sixty. A glitch of a fifth of a
// rig unit is exactly what the fist is not allowed to do, so the window stays where
// the grip puts it and the plane keeps whatever the fist's own fifteen degrees can
// give it (see `fistRoll`, `reachRollWindow` for the other half of the bound).
// How much of that window the *arm* has, as opposed to the fist: the roll carries
// the wrist round the handle with it, and a wrist a roll asks for that sits further
// from the shoulder than the arm can span is a palm off the handle rather than a
// hold. Measured with the roll free to turn to the plane's own answer, the contact's
// lead arm needed 1.31 of its own span and left the hand 0.044 rig off the grip it
// was holding — so the window a rule may use is the fraction of ARM_STRETCH_MAX
// left to it, read off the same closed form as the rest (see `reachRollWindow`).
// The arm is allowed the whole of that stretch here and no more: the budget is the
// arm's own stated limit, and the rules inside the window are ranked as usual.

/**
 * Where the fist's own roll about the barrel goes: the one axis a grip leaves
 * free, and the one the two wrist rules are answered on.
 *
 * A fist can turn about the handle with its palm's channel still on it, and that
 * one degree of freedom moves two things at once. It sweeps the hand's own
 * direction — its knuckles' line, which the model's grip puts square across the
 * handle — around the barrel, which is the bend at the wrist; and it swings the
 * fist's own reach from the wrist to the handle, which moves the wrist, which is
 * half of where the lead forearm sits against the bat's own plane (the elbow is
 * the other half, and is the elbow's own circle to answer for).
 *
 * Both are cosines in the roll, and that is the whole of the method here. Take any
 * two vectors a roll moves (`hand` and the forearm's own direction; the reach and
 * the plane's normal): the angle between them reads
 *
 *   cos(angle(r)) = a1·b1 + sqrt(1-a1²)·sqrt(1-b1²)·cos(r - r0)
 *
 * where a1 and b1 are their parts along the barrel and r0 is the roll that lines
 * their square parts up. So each rule's best roll is a closed form, the rolls that
 * hold its limit are an arc around it, and choosing between the arcs is a handful
 * of candidates — the two bests, the four edges, the pose's own roll, and the
 * nearest point of each arc to it — rather than a search. Nothing here is a model
 * of the arm: the amplitudes come off the posed bones, and the clamp of the arc's
 * own half-width collapses by itself where no roll can hold the limit at all.
 *
 * The order between them is the arm solve's own, and it is the elbow's rule that
 * comes first there: where the bend cannot be held *and* the wrist brought to the
 * plane's own side, the bend is what the roll stays inside, and the plane is sunk
 * as deep as that limit allows — the roll is the hand's own axis and a fist folded
 * past its own wrist limit onto the bat is a broken wrist, which reads as a fault
 * in a way a hand a hand's length off the plane does not. (Measured: a whole circle
 * of elbows and a whole turn of roll cannot hold both at 0.25 s, where the roll
 * that puts the wrist under the plane is almost exactly opposite the roll that
 * lines the hand up with the forearm — 133 degrees of bend against the 30 asked
 * for.) Where the two *can* both be held, both are.
 *
 * How much plane the wrist itself is answerable for comes in as `allowedSide` (see
 * the arm solve), which is the deepest side the *bone* is being held to: the wrist
 * may come as high as that and no higher, so where the elbow's own end is over the
 * plane the wrist is free to follow the bend, and as the elbow comes under the
 * wrist is drawn under with it. That boundary is a continuous function of the
 * pose — which matters more than it sounds: the plane sweeps across the lead arm
 * in a few hundredths of a second through the wind-up, and a rule that switched on
 * at a fixed side would snap the fist a whole reach sideways across that sweep.
 *
 * @param {THREE.Vector3} handHome the hand's own direction at the pose's roll
 * @param {THREE.Vector3} foreAim the forearm's own direction, elbow to wrist
 * @param {THREE.Vector3} reach the fist's reach, wrist to grip, at the pose's roll
 * @param {THREE.Vector3} barrel the handle's own direction, unit
 * @param {THREE.Vector3} normal the bat's plane's upward normal, unit
 * @param {number} allowedSide the highest side of that plane the wrist may sit
 *   at — `Infinity` for an arm the plane is no rule for at all
 * @param {boolean} planeFirst whether the wrist's own side of the plane outranks
 *   the bend. The lead wrist is held in the region between the bat's plane and the
 *   ground — the plane passes through the grip, so that region is the whole of what
 *   is under the hands — and a wrist is not a joint: folding one past its own limit
 *   reads as a broken wrist, but a fist a whole reach above the bat's own plane
 *   reads as a hand turned around the bat. The lead arm therefore takes the plane
 *   first and the bend as what is left, which is the same order the lead *elbow* is
 *   held to (see the arm solve). The trail arm is the plane's own with a wrist above
 *   it, so its side is `Infinity` and the order is moot.
 * @param {number} window how far off the pose's own roll this fist may turn at all:
 *   the grip's own window (GRIP_ROLL_MAX) less as much of it as the arm's reach
 *   cannot answer for (see `reachRollWindow`). The pose's own roll is always a
 *   candidate, so a window of nought is a fist that stays where the pose put it.
 * @returns {number} the roll, in radians, off the pose's own; `_rollBend` is what
 *   it leaves for the bend and `_rollFloor` the lowest it could have
 */
function fistRoll(
  handHome,
  foreAim,
  reach,
  barrel,
  normal,
  allowedSide,
  planeFirst = false,
  window = GRIP_ROLL_MAX,
) {
  const handAlong = handHome.dot(barrel)
  const handSquare = Math.sqrt(Math.max(0, 1 - handAlong * handAlong))
  const foreAlong = foreAim.dot(barrel)
  const foreSquare = Math.sqrt(Math.max(0, 1 - foreAlong * foreAlong))
  const bendAlong = handAlong * foreAlong
  const bendSquare = handSquare * foreSquare
  const bendRoll = squareAngle(handHome, foreAim, barrel)
  const bendAt = (roll) => Math.acos(THREE.MathUtils.clamp(
    bendAlong + bendSquare * Math.cos(roll - bendRoll), -1, 1))
  _rollFloor = bendAt(bendRoll)
  // The arc of rolls holding the bend: around the roll that bottoms it out, half
  // as wide either way as it takes to reach the limit. A half-width of nought is
  // what an unreachable limit reads as, and the candidate that bottoms the bend
  // out is what the ranking below falls back on for the rest of the gap.
  const bendHalf = bendSquare > 1e-9
    ? Math.acos(THREE.MathUtils.clamp(
      (Math.cos(WRIST_BEND_MAX) - bendAlong) / bendSquare, -1, 1))
    : 0
  // The same three numbers for the wrist's own side of the plane. The side is
  // read the way the elbow's rule reads it — positive over the plane — and the
  // reach being the grip less the wrist is what makes it a *negative* cosine here.
  const reachAlong = reach.dot(barrel)
  const reachSquare = Math.sqrt(Math.max(0, reach.lengthSq() - reachAlong * reachAlong))
  const normalAlong = normal.dot(barrel)
  const normalSquare = Math.sqrt(Math.max(0, 1 - normalAlong * normalAlong))
  const planeAlong = reachAlong * normalAlong
  const planeSquare = reachSquare * normalSquare
  const planeRoll = squareAngle(reach, normal, barrel)
  const sideAt = (roll) => -(planeAlong + planeSquare * Math.cos(roll - planeRoll))
  // The plane's own edge, as an arc: the rolls that put the wrist at or under the
  // side it is being held to, out of `sideAt`'s own cosine. (Where the reach
  // cannot cross that side at all, the arc is empty and the side's own key below
  // is what sinks it as deep as it goes.)
  const planeEdge = planeSquare > 1e-9
    ? Math.acos(THREE.MathUtils.clamp(
      (-allowedSide - planeAlong) / planeSquare, -1, 1))
    : 0
  _rollPlaneIdeal = planeRoll
  _rollPlaneHalf = planeEdge
  _rollBendIdeal = bendRoll
  _rollBendHalf = bendHalf
  // The nearest turn inside the window to the plane's own ideal — the deepest the
  // window can go — clamped into it the way the arcs above are read.
  _rollWindowDeepest = sideAt(THREE.MathUtils.clamp(halfTurn(planeRoll), -window, window))
  // The nearest point of an arc to the pose's own roll: where the clamp's own
  // projection lands, which is a band's best point whenever the pose's own roll
  // sits outside it.
  const into = (centre, half) => centre + THREE.MathUtils.clamp(halfTurn(-centre), -half, half)
  const rolls = [
    0,
    bendRoll,
    planeRoll,
    bendRoll - bendHalf,
    bendRoll + bendHalf,
    planeRoll - planeEdge,
    planeRoll + planeEdge,
    into(bendRoll, bendHalf),
    into(planeRoll, planeEdge),
  ]
  // The window's own edges are candidates too — but only for the arm a rule is
  // *ranked* on: "sink as deep as the fist can" is the deepest turn inside the
  // window, and without an edge in the list a rule whose answer lies past it has no
  // candidate at the boundary and stays where the pose put it, which reads as a rule
  // that does nothing. Where the window is only a filter the arm's own turn is asked
  // for (the trail arm's bend), the boundary is not a point of the rule at all and
  // the roll keeps the candidates it always had.
  if (planeFirst) {
    rolls.push(window, -window)
  }
  // Ranked by what a roll is for, in the order the arm solve's rules are: how far
  // the bend is over its own limit first (nought while it holds — the bend is a
  // limit of the *joint*, and the roll is the joint's own axis), then how far the
  // wrist is over the side of the plane it is answerable for (nought while it is
  // under, and how far over it is where it is not, so a plane the bend will not let
  // the roll reach is still sunk as deep as the bend allows), and last how far the
  // roll has been moved off the pose's own — the fist's whole look is authored
  // there, and a roll that holds both rules where the pose put it is a fist that
  // never moved.
  const better = (first, second) => {
    for (let i = 0; i < first.length; i += 1) {
      if (first[i] < second[i] - 1e-12) return true
      if (first[i] > second[i] + 1e-12) return false
    }
    return false
  }
  let chosen = 0
  let best = null
  for (const roll of rolls) {
    // Only the turns this fist has are candidates at all (see GRIP_ROLL_MAX and
    // `reachRollWindow`): a roll that holds both rules by turning the fist off the
    // handle, or by carrying the wrist past what the arm can span, is not a roll the
    // fist can hold.
    if (Math.abs(halfTurn(roll)) > window + 1e-12) continue
    const bendOver = Math.max(0, bendAt(roll) - WRIST_BEND_MAX)
    const planeOver = Math.max(0, sideAt(roll) - allowedSide + WRIST_PLANE_SLACK)
    const score = planeFirst
      ? [planeOver, bendOver, Math.abs(halfTurn(roll))]
      : [bendOver, planeOver, Math.abs(halfTurn(roll))]
    if (best === null || better(score, best)) {
      best = score
      chosen = roll
    }
  }
  _rollBend = bendAt(chosen)
  return chosen
}

// The grip less the shoulder, squared to the barrel: the offset from the shoulder to
// the centre of the circle the wrist turns on (see `reachRollWindow`).
const _reachAxial = new THREE.Vector3()

/**
 * How far a fist may turn on its handle before the wrist that turn asks for is out
 * of the arm's reach. The wrist is the grip less the fist's reach, and a roll turns
 * that reach about the barrel — so the wrist runs round a circle centred on the grip,
 * in the barrel's own square plane, and the distance from the shoulder to a point of
 * that circle is `sqrt((axial - along)^2 + across^2 + square^2 - 2 across square
 * cos(roll - centre))`: a cosine in the roll again, so the rolls the arm can close on
 * are an arc around `centre`, in closed form like every other rule here.
 *
 * What a caller wants is not that arc but the *window*: how far the roll may turn off
 * the pose's own and stay inside it, which is the arc's half-width less how far its
 * centre sits from the pose's own roll — and nought where the pose's own roll is
 * already outside the arc, or where the roll cannot move the wrist at all and the
 * pose's own distance is past the budget.
 *
 * @param {THREE.Vector3} shoulder the arm's own shoulder joint
 * @param {THREE.Vector3} grip where the fist closes on the handle
 * @param {THREE.Vector3} reach the fist's reach, wrist to grip, at the pose's roll
 * @param {THREE.Vector3} barrel the handle's own direction, unit
 * @param {number} budget the distance from the shoulder the wrist may sit at
 * @returns {number} the half-window, in radians, off the pose's own roll
 */
function reachRollWindow(shoulder, grip, reach, barrel, budget) {
  _reachAxial.copy(grip).sub(shoulder)
  const axial = _reachAxial.dot(barrel)
  _reachAxial.addScaledVector(barrel, -axial)
  const across = _reachAxial.length()
  const along = reach.dot(barrel)
  const square = Math.sqrt(Math.max(0, reach.lengthSq() - along * along))
  // The roll cannot move the wrist at all (the reach lies along the barrel, or the
  // shoulder stands on the circle's own axis): either the pose is inside the budget
  // and every roll is, or it is outside and none is.
  if (square * across < 1e-9) {
    return shoulder.distanceTo(grip) <= budget ? GRIP_ROLL_MAX : 0
  }
  const centre = squareAngle(reach, _reachAxial, barrel)
  const half = Math.acos(THREE.MathUtils.clamp(
    ((along - axial) * (along - axial) + square * square + across * across - budget * budget)
      / (2 * square * across),
    -1, 1,
  ))
  return Math.max(0, half - Math.abs(halfTurn(centre)))
}

const _curlAxis = new THREE.Vector3()
const _curlJoint = new THREE.Vector3()
const _curlHandle = new THREE.Vector3()
const _curlToe = new THREE.Vector3()
const _curlTurn = new THREE.Vector3()
const _fistLocal = new THREE.Matrix4()
const _fistWorld = new THREE.Matrix4()
const _fistAxes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
const _handAxes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
const _fingerAxis = new THREE.Vector3(0, 1, 0)
const _rollRef = new THREE.Vector3()
const _foreRef = new THREE.Vector3()
const _fistReach = new THREE.Vector3()
const _palmRef = new THREE.Vector3()
const _handRotation = new THREE.Matrix4()
const _qHand = new THREE.Quaternion()
const _qHandRest = new THREE.Quaternion()
const _qCurl = new THREE.Quaternion()

/**
 * The model's own statement of how its hands hold a bat. Its rig came with a
 * two-hand bat grip — the IK targets that place the hands on the handle, and a
 * ``palm_handle`` node in each palm — and the palm node is read here: its local
 * translation is the point of the handle the fist closes on, and its own +Y (a
 * handle node's own axis) is the direction the handle runs through the palm,
 * both in the hand's own frame. Read rather than assumed, so the fist can be
 * solved onto whatever bat the animation is holding.
 *
 * @param {THREE.Object3D} modelRoot the loaded model
 * @param {Map} [restPose] the skeleton's resting local transforms
 * @returns {object} per side: ``{ point, handle }``, or nothing if this model
 *   does not carry the node
 */
export function handFrames(modelRoot, restPose) {
  const frames = {}
  for (const [side, name] of Object.entries(PALM_HANDLES)) {
    const node = modelRoot.getObjectByName(name)
    if (!node) continue
    const local = restPose?.get(node) ?? node
    frames[side] = {
      point: local.position.clone(),
      handle: new THREE.Vector3(0, 1, 0).applyQuaternion(local.quaternion).normalize(),
    }
  }
  return frames
}

// A right-handed basis from an axis and a reference direction: the axis first,
// the reference squared up to it second, their cross product third.
function basisInto(axes, axis, reference) {
  const [x, y, z] = axes
  x.copy(axis).normalize()
  y.copy(reference).addScaledVector(x, -reference.dot(x))
  if (y.lengthSq() < 1e-8) y.copy(UP).cross(x)
  if (y.lengthSq() < 1e-8) y.set(0, 0, 1).cross(x)
  y.normalize()
  z.copy(x).cross(y).normalize()
  return axes
}

/**
 * The turn one fist has to take to close on the bat: the model's handle axis
 * inside the palm is carried onto the bat's own barrel direction, and the
 * fingers' line — the knuckles' own axis in the palm, turned square to the barrel
 * — is carried onto `foreLine`. Both frames are built from an axis and a
 * reference, so the roll of the fist falls out of the arm's own direction rather
 * than being another number to tune.
 *
 * The reference this *builds* the fist with is the chord the arm reaches along
 * (shoulder to grip), which is the fist's first cut: a hand closing on a handle
 * turns with the arm that is driving it, and the arm's own reach is what the pose
 * knows before the solve has placed an elbow. It is not, however, the line the
 * bend at the wrist is *stated* about — that is the forearm, elbow to grip — and
 * the two part by 15 to 80 degrees over the cycle wherever the elbow is bent. The
 * arm solve then re-authors the roll on the forearm it actually poses (see the
 * `fist align` block there), which is what lines the knuckles' line up with the
 * bone the limit belongs to.
 *
 * @param {{point: THREE.Vector3, handle: THREE.Vector3}} fist the model's palm
 *   marker, in the hand's own frame
 * @param {THREE.Vector3} barrel the bat's handle -> barrel direction
 * @param {THREE.Vector3} grip where the fist has to close on the handle
 * @param {THREE.Vector3} shoulder the arm's own shoulder joint
 * @param {number} palmUp how much of that roll to take from the hand's *own*
 *   "back of the palm up" instead: 0 leaves the roll on the arm's reach, 1
 *   takes all of it (see below)
 * @param {boolean} palmHeld whether that share is a *held* roll — the pose the
 *   follow-through and the way home hold — rather than the swing's own (see
 *   the weight below)
 * @param {THREE.Matrix4} into the hand's world orientation
 * @returns {THREE.Matrix4} ``into``
 */
function fistRotation(fist, barrel, grip, shoulder, palmUp, palmHeld, into) {
  basisInto(_fistAxes, fist.handle, _fingerAxis)
  _rollRef.copy(grip).sub(shoulder).normalize()
  // The free axis the fist turns on is its roll, and taking it from the direction
  // the arm reaches in is right while the bat is being swung — a wrist rolls with
  // the swing it is driving — and wrong for a pose *held* in front of the chest,
  // where the two reach directions the finish and the load put the arm on are
  // opposite and the wrist rolls the whole way over between them.
  //
  // The reference that instead leaves the back of the palm facing the sky is the
  // axis perpendicular to the barrel and to the vertical — ``up x barrel``, which
  // the basis' own cross product turns into a third axis as close to ``up`` as
  // anything perpendicular to the barrel can be. It is only available as far as
  // the barrel is off vertical (a bat standing straight up leaves the roll free,
  // and there the reach direction is as good a guide as any), so the blend is
  // weighted by that tilt.
  // ...and which way round *this* hand reads it: the basis above is built from the
  // handle and the fingers, and the two hands are mirror images, so on one of them
  // the third axis is the back of the palm and on the other it is the palm's own
  // facing. The handle sits on the palm's side of the hand, so the handle's own
  // offset in the hand's frame decides which — a third axis leaning that way is
  // the palm's side and has to be turned round to stand the back of the palm up.
  _palmRef.copy(UP).cross(barrel)
  if (_fistAxes[2].dot(fist.point) > 0) _palmRef.negate()
  const tilted = _palmRef.length()
  if (palmUp > 0 && tilted > 1e-4) {
    // How much of the reference the blend takes. Where the roll is the swing's
    // own it is the caller's share *of the tilt* — the reference is a nudge on a
    // wrist that is driving, and that is how the swing was tuned. Where the roll
    // is *held* it is the caller's share outright, gated only for the barrel
    // standing near enough upright that the axis stops meaning anything: the
    // axis is ill-defined at vertical and perfectly well defined at 30 degrees,
    // and scaling a held roll by the tilt is what let the wrists roll over — at
    // half tilt the caller's 0.5 became 0.25, and a blend that takes less than
    // half of a reference is not taking it: it passes *through* the reference's
    // own opposite, and the palm comes out the far side. Measured through the
    // way home, the lead palm ran 0.25 -> -0.50 over 0.05 s at 0.87-0.92 s with
    // the weight scaled, and holds 0.44 there with it gated.
    const gate = THREE.MathUtils.clamp((tilted - 0.1) / 0.2, 0, 1)
    const smooth = gate * gate * (3 - 2 * gate)
    const weight = palmHeld ? palmUp * smooth : palmUp * tilted
    _rollRef.lerp(_palmRef.multiplyScalar(1 / tilted), Math.min(1, weight))
  }
  basisInto(_handAxes, barrel, _rollRef)
  _fistLocal.makeBasis(_fistAxes[0], _fistAxes[1], _fistAxes[2])
  _fistWorld.makeBasis(_handAxes[0], _handAxes[1], _handAxes[2])
  // The two frames are orthonormal, so the local one's inverse is its transpose.
  return into.copy(_fistWorld).multiply(_fistLocal.transpose())
}
const ONE = new THREE.Vector3(1, 1, 1)
const IDENTITY = new THREE.Quaternion()
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _q3 = new THREE.Quaternion()
const _q4 = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _matrix = new THREE.Matrix4()
// A quaternion's turn axis against a direction: what a twist about that direction
// would measure (see the swing-twist split in the leg diagnostics).
const dot3 = (q, v) => q.x * v.x + q.y * v.y + q.z * v.z

function drivenBoneNames() {
  const names = new Set()
  for (const group of [PLAYER_BONES, ARM_BONES.L, ARM_BONES.R, LEG_BONES.L, LEG_BONES.R]) {
    for (const name of Object.values(group)) names.add(name)
  }
  return Array.from(names)
}

function collectBones(root) {
  const bones = {}
  for (const name of drivenBoneNames()) {
    const bone = root.getObjectByName(name)
    if (!bone) throw new Error(`player.glb is missing the "${name}" bone`)
    bones[name] = bone
  }
  return bones
}

/**
 * Reads the model once and returns the joint metrics Batter.jsx's animation
 * tuning needs, in rig units, so they can stand in for the constants the
 * procedural rig hard-coded.
 *
 * @param {THREE.Object3D} scene loaded player.glb scene at its rest pose
 * @param {object} options
 * @param {number} options.spriteNominalHeightM height of the tuning's body frame
 * @returns {object} metrics in rig units, plus unitScale and the model's height
 */
export function measurePlayerRig(scene, { spriteNominalHeightM }) {
  scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(scene)
  const modelHeight = box.max.y - box.min.y
  const unitScale = spriteNominalHeightM / modelHeight

  const pos = (name) => {
    const bone = scene.getObjectByName(name)
    if (!bone) throw new Error(`player.glb is missing the "${name}" bone`)
    return bone.getWorldPosition(new THREE.Vector3())
  }
  // Model-local -> rig units (negate x/z for the half turn between the frames).
  const rig = (p) => new THREE.Vector3(-p.x * unitScale, p.y * unitScale, -p.z * unitScale)

  const upperArmL = rig(pos(ARM_BONES.L.upperArm))
  const forearmL = rig(pos(ARM_BONES.L.forearm))
  const handL = rig(pos(ARM_BONES.L.hand))
  const fingersL = rig(pos(ARM_BONES.L.fingers))
  const thighL = rig(pos(LEG_BONES.L.hip))
  const shinL = rig(pos(LEG_BONES.L.knee))
  const footL = rig(pos(LEG_BONES.L.ankle))
  const toeL = rig(pos(LEG_BONES.L.toe))
  const spine = rig(pos(PLAYER_BONES.spine))
  const neck = rig(pos(PLAYER_BONES.neck))
  const head = rig(pos(PLAYER_BONES.head))
  // The model's own two-hand grip, in rig units: the two hand targets its rig
  // carries, and the gap between them (see BAT_HAND_TARGETS). A model without
  // them reports null and the driver falls back to its own constant.
  const handTargets = BAT_HAND_TARGETS.map((name) => scene.getObjectByName(name))
  const gripSeparation = handTargets.every(Boolean)
    ? handTargets[0].getWorldPosition(new THREE.Vector3())
      .distanceTo(handTargets[1].getWorldPosition(new THREE.Vector3())) * unitScale
    : null

  return {
    modelHeight,
    unitScale,
    // Torso pivot: where the upper body turns and leans.
    hipY: spine.y,
    // Shoulder joints: the arm reach and the elbow choreography hang off these.
    shoulder: { y: upperArmL.y, halfWidth: Math.abs(upperArmL.x), z: upperArmL.z },
    arm: {
      upper: forearmL.distanceTo(upperArmL),
      fore: handL.distanceTo(forearmL),
      hand: fingersL.distanceTo(handL),
    },
    // How far apart the two fists grip the handle (see BAT_HAND_TARGETS).
    grip: { separation: gripSeparation },
    // Leg sockets: where the hips sit (the leg targets are anchored to them, and
    // the component shifts the model so their z lands on the body centreline),
    // how far apart they are, the foot's rest height, and the toe's offset from
    // the ankle.
    hip: { y: thighL.y, halfWidth: Math.abs(thighL.x), z: thighL.z },
    ankleY: footL.y,
    toeOffset: toeL.clone().sub(footL),
    leg: {
      thigh: shinL.distanceTo(thighL),
      shin: footL.distanceTo(shinL),
    },
    neckY: neck.y,
    headY: head.y,
  }
}

// Which part each of the body's bones belongs to.
function partOfBone(name) {
  for (const [part, bones] of Object.entries(PART_BONES)) if (bones.includes(name)) return part
  return null
}

/**
 * The share of a vertex's body weights each part takes at that height: one part
 * inside a part, and the two of them blended across the band between them.
 *
 * The body is a stack of parts — legs, pelvis, torso, head — so this is a walk up
 * it: each band hands over between the part below and the part above, and the
 * chest and the head are the two ends.
 *
 * @param {number} height in rig units
 * @param {number} cut the waistband's own top edge, which is where the surface
 *   changes hands from the pelvis to the torso (see ``measureWaistband``)
 * @param {number[]} neck the neck band, [bottom, top], from the model's own neck
 *   joint (see ``NECK_BAND_HALF_WIDTH``)
 */
function partShares(height, cut, neck) {
  if (height < HIP_BAND_TOP) {
    const up = THREE.MathUtils.smoothstep(height, HIP_BAND_BOTTOM, HIP_BAND_TOP)
    return { legs: 1 - up, pelvis: up, torso: 0, head: 0 }
  }
  if (height >= neck[1]) return { legs: 0, pelvis: 0, torso: 0, head: 1 }
  if (height >= neck[0]) {
    const up = THREE.MathUtils.smoothstep(height, neck[0], neck[1])
    return { legs: 0, pelvis: 0, torso: 1 - up, head: up }
  }
  // The belt is a hard split, not a blend: the geometry is cut there too (see
  // ``cutBeltAndSleeve``), so no triangle can carry both parts' bones.
  if (height < cut) return { legs: 0, pelvis: 1, torso: 0, head: 0 }
  return { legs: 0, pelvis: 0, torso: 1, head: 0 }
}

// The model's base-color texture, as readable pixels: one canvas per image, read
// once and shared by every vertex that samples it.
const texturePixels = new WeakMap()

function textureData(image) {
  if (!image || typeof image.width !== 'number') return null
  if (texturePixels.has(image)) return texturePixels.get(image)
  let pixels = null
  // A loaded model always has a document; a headless unit test may not.
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context) {
      try {
        context.drawImage(image, 0, 0)
        pixels = {
          data: context.getImageData(0, 0, image.width, image.height).data,
          width: image.width,
          height: image.height,
        }
      } catch {
        // An image the browser will not hand back pixels for (a cross-origin
        // texture, say): the waistband falls back to its recorded proportions.
        pixels = null
      }
    }
  }
  texturePixels.set(image, pixels)
  return pixels
}

/**
 * What colour the model's own base-color texture draws at a vertex's UV, as
 * [r, g, b] in 0..1, or null when the texture cannot be read.
 *
 * The texel the UV falls *in* is sampled rather than filtered between its
 * neighbours: the model's clothing colours are flat regions of the atlas, and a
 * vertex sitting on a boundary would otherwise be blended with the colour next to
 * it.
 */
function texelAt(mesh, u, v) {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const map = material?.map
  const pixels = textureData(map?.image)
  if (!pixels) return null
  // glTF's UVs start at the image's top left (``flipY`` false); an image flipped
  // on upload is read the other way up.
  const row = map.flipY ? 1 - v : v
  const x = Math.min(pixels.width - 1, Math.max(0, Math.floor(u * pixels.width)))
  const y = Math.min(pixels.height - 1, Math.max(0, Math.floor(row * pixels.height)))
  const at = (y * pixels.width + x) * 4
  return [pixels.data[at] / 255, pixels.data[at + 1] / 255, pixels.data[at + 2] / 255]
}

// Is this texel drawn in the uniform's trim colour — the belt's own red, as
// opposed to the trousers', the jersey's, or the shading of either?
function isTrimColor([r, g, b]) {
  return r > WAISTBAND_TRIM_MIN && r - Math.max(g, b) > WAISTBAND_TRIM_GAP
}

/**
 * The waistband from a profile of the trunk's own ring by height: the *lowest*
 * run of heights where most of the ring is drawn in the trim colour, at least a
 * band and no taller than a waistband. Exported because it is the whole of the
 * rule, and the rule is what has to be right on the model — see the unit tests.
 *
 * @param {{height: number, count: number, trim: number}[]} profile one entry per
 *   height, bottom first: how many samples the ring has there and how many of
 *   them are trim-coloured
 * @returns {{bottom: number, top: number, share: number}|null} the band in rig
 *   units, and the *worst* share of the ring inside it, or null for no band
 */
export function waistbandFromShares(profile) {
  // Heights are reported to a millionth of a rig unit: a band's edge is a height,
  // not the tail of a floating-point accumulation.
  const at = (value) => Number(value.toFixed(6))
  let run = null
  let found = null
  const close = () => {
    if (!run) return
    const width = run.top - run.bottom
    if (!found && width >= WAISTBAND_MIN_WIDTH && width <= WAISTBAND_MAX_WIDTH) found = { ...run }
    run = null
  }
  let previous = null
  for (const { height, count, trim } of profile) {
    const share = count ? trim / count : 0
    const onBand = count >= WAISTBAND_MIN_SAMPLES && share >= WAISTBAND_SHARE
    // A height joins the run while it is the next step up from the one before it,
    // rather than whenever it rounds into the run's own top.
    const contiguous = run && previous !== null && Math.abs(height - previous - WAISTBAND_STEP) < 1e-6
    if (!onBand) {
      close()
    } else if (contiguous) {
      run.top = at(height + WAISTBAND_STEP)
      run.share = Math.min(run.share, share)
    } else {
      run = { bottom: height, top: at(height + WAISTBAND_STEP), share }
    }
    previous = height
  }
  close()
  return found
}

/**
 * Where the model's own uniform puts its waistband, in rig units: the trouser
 * band the base-color texture draws, read off the texture at load time rather
 * than hard-coded, so another player model or another uniform still gets its
 * twist taken at its own waistband.
 *
 * The read is on the *trunk's* vertices — the ones the model's own skinning
 * weights to a spine or pelvis bone — because the band is what the body's ring is
 * wearing, and a sleeve or a shoe drawn in the same trim colour is not the waist.
 * Each vertex's UV is looked up in the model's base-color map, and the waistband
 * is the lowest band of heights, inside the waist window, where most of the ring
 * is drawn in the trim colour (see ``waistbandFromShares``).
 *
 * @param {THREE.Object3D} root the loaded model, at its rest pose
 * @param {object} metrics result of measurePlayerRig
 * @returns {{bottom: number, top: number, source: string, window: number[],
 *   samples: number, share: number|null, trim: number[]|null}} the band in rig
 *   units, whether it came off the texture (`'texture'`) or from the recorded
 *   proportions (`'fallback'`), the window it was looked for in, and what the
 *   band's own colour measures — all of it for the tests and the README
 */
export function measureWaistband(root, metrics) {
  const span = metrics.neckY - metrics.hip.y
  const from = metrics.hip.y
  const window = [from, from + WAIST_SEARCH_SHARE * span]
  const fallback = {
    bottom: from + WAISTBAND_FALLBACK[0] * span,
    top: from + WAISTBAND_FALLBACK[1] * span,
    source: 'fallback',
    window,
    samples: 0,
    share: null,
    trim: null,
  }

  const trunk = new Set([...PELVIS_BONES, ...TORSO_BONES])
  const samples = []
  root.traverse((node) => {
    if (!node.isSkinnedMesh) return
    const { position, uv, skinIndex, skinWeight } = node.geometry.attributes
    if (!position || !uv || !skinIndex || !skinWeight) return
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const height = position.getY(vertex) * metrics.unitScale
      if (height < window[0] || height > window[1]) continue
      // The trunk, by the model's own skinning rather than by height: the arms
      // and the legs are weighted to their own bones, wherever they hang.
      let onTrunk = false
      for (let slot = 0; slot < 4 && !onTrunk; slot += 1) {
        if (skinWeight.array[vertex * 4 + slot] < 0.2) continue
        const bone = node.skeleton.bones[skinIndex.array[vertex * 4 + slot]]
        if (bone && trunk.has(bone.name)) onTrunk = true
      }
      if (!onTrunk) continue
      const colour = texelAt(node, uv.getX(vertex), uv.getY(vertex))
      if (colour) samples.push({ height, colour })
    }
  })
  if (!samples.length) return fallback

  const profile = []
  for (let at = window[0]; at <= window[1] + 1e-9; at += WAISTBAND_STEP) {
    let count = 0
    let trim = 0
    for (const sample of samples) {
      if (Math.abs(sample.height - at) > WAISTBAND_SPAN) continue
      count += 1
      if (isTrimColor(sample.colour)) trim += 1
    }
    profile.push({ height: at, count, trim })
  }

  const band = waistbandFromShares(profile)
  if (!band) return { ...fallback, samples: samples.length }

  // What the band's own colour measures: the mean of the trim samples inside it.
  // Reported rather than assumed, so the README can quote the uniform's belt
  // instead of the name of a colour.
  const inside = samples.filter(
    (sample) => sample.height >= band.bottom && sample.height <= band.top && isTrimColor(sample.colour),
  )
  const trim = inside.length
    ? [0, 1, 2].map((channel) => inside.reduce((sum, s) => sum + s.colour[channel], 0) / inside.length)
    : null

  return { bottom: band.bottom, top: band.top, source: 'texture', window, samples: samples.length, share: band.share, trim }
}

/**
 * Where the torso's twist *reads*: the height at which the pelvis's share of the
 * pelvis-plus-torso skin crosses 0.5, in rig units. With the weights cut into
 * parts at the waistband's top edge this is that edge — which is the point of the
 * cut: the twist reads where the uniform's trousers meet the jersey, not smeared
 * up the stomach.
 */
function waistBandContour(root, metrics) {
  const lower = new Set(PELVIS_BONES)
  const upper = new Set(TORSO_BONES)
  const samples = []
  root.traverse((node) => {
    if (!node.isSkinnedMesh) return
    const { skinIndex, skinWeight, position } = node.geometry.attributes
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      let low = 0
      let high = 0
      for (let slot = 0; slot < 4; slot += 1) {
        const bone = node.skeleton.bones[skinIndex.array[vertex * 4 + slot]]
        const weight = skinWeight.array[vertex * 4 + slot]
        if (!bone || !weight) continue
        if (lower.has(bone.name)) low += weight
        else if (upper.has(bone.name)) high += weight
      }
      if (low + high < 0.1) continue
      samples.push([position.getY(vertex) * metrics.unitScale, high / (low + high)])
    }
  })
  if (!samples.length) return null
  samples.sort((a, b) => a[0] - b[0])
  // The first crossing of a half, interpolated between the two vertices that
  // straddle it (the torso is low-poly; there may be no vertex on the contour).
  for (let i = 1; i < samples.length; i += 1) {
    const [beforeY, beforeShare] = samples[i - 1]
    const [afterY, afterShare] = samples[i]
    if (beforeShare >= 0.5 || afterShare < 0.5) continue
    const span = afterShare - beforeShare
    return beforeY + (afterY - beforeY) * (span > 0 ? (0.5 - beforeShare) / span : 0)
  }
  return null
}

/**
 * Cuts the model's soft skin weights into the rigid parts, by re-splitting each
 * vertex's part weights along the model's height. Weights that belong to no part
 * (the arms', the shoulders') are left exactly as the model authored them, and
 * inside a part the model's own internal detail is kept: only the *boundary*
 * weights move between parts.
 *
 * A vertex carries at most four bones, so the parts' bones are packed back into
 * its own slots, a bone keeping the slot it already had. What will not fit is
 * folded into the vertex's heaviest weight — a sliver, on a mesh this coarse — and
 * never dropped: the weights have to keep summing to one, or the vertex collapses
 * toward the origin.
 *
 * @param {object} metrics result of measurePlayerRig
 * @param {{bottom: number, top: number}} waistband where the uniform's waistband
 *   is, in rig units (see ``measureWaistband``)
 * @returns {{hip: number[], waist: number[], neck: number[], leaks: object,
 *   contour: number|null}} the bands, the worst residual each part's skin still
 *   carries of another part's bones, and where the twist reads
 */
function shapeRigidParts(root, metrics, waistband) {
  // The belt's own top edge: where the surface changes hands from the pelvis to
  // the torso, and where the geometry is cut open to match.
  const cut = waistband.top
  // The neck band, on the joint the model hinges the head about.
  const neck = [metrics.neckY - NECK_BAND_HALF_WIDTH, metrics.neckY + NECK_BAND_HALF_WIDTH]
  // Where a part's weight goes when the vertex carries none of that part's own
  // bones at all: any bone of a rigid part moves it the same way, so the part's
  // lowest joint is used — and for a leg, the side the vertex sits on (the model
  // rests facing +Z, so its own +x is its left).
  const fallback = (part, x) => {
    if (part === 'pelvis') return PLAYER_BONES.spine
    if (part === 'torso') return PLAYER_BONES.spine01
    if (part === 'head') return PLAYER_BONES.neck
    return x < 0 ? LEG_BONES.R.hip : LEG_BONES.L.hip
  }
  const leaks = { pelvis: 0, legs: 0, torso: 0, head: 0 }

  root.traverse((node) => {
    if (!node.isSkinnedMesh) return
    const geometry = node.geometry.clone()
    const { skinIndex, skinWeight, position } = geometry.attributes
    const skeleton = node.skeleton
    const boneByName = new Map(skeleton.bones.map((bone) => [bone.name, bone]))
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const at = vertex * 4
      // What the vertex carries now, by part. The skeleton's joint numbers are
      // not slot numbers — a vertex has only four slots — so a slot's bone is
      // read from the skeleton and both the weights and the writes land on this
      // vertex only.
      const slots = []
      const carried = { pelvis: new Map(), torso: new Map(), legs: new Map(), head: new Map() }
      const totals = { pelvis: 0, torso: 0, legs: 0, head: 0 }
      for (let slot = 0; slot < 4; slot += 1) {
        const bone = skeleton.bones[skinIndex.array[at + slot]]
        const weight = skinWeight.array[at + slot]
        const part = bone ? partOfBone(bone.name) : null
        slots.push({ bone, part, weight })
        if (!part || weight <= 0) continue
        carried[part].set(bone.name, (carried[part].get(bone.name) ?? 0) + weight)
        totals[part] += weight
      }
      const body = totals.pelvis + totals.torso + totals.legs + totals.head
      // A glove, a hand, a shoulder pad: nothing of the four parts is here.
      if (body <= 0.001) continue

      const height = position.getY(vertex) * metrics.unitScale
      const shares = partShares(height, cut, neck)
      // The head is what the model itself skinned to the head, and only where the
      // neck is. A collar, a shoulder or a chest strap that happens to sit at the
      // neck's height is still the torso, so a vertex keeps none of the head's
      // motion unless the model gave it the head's bones *and* carried it on the
      // body rather than on the arms (see NECK_BODY_SHARE).
      if (shares.head > 0 && (carried.head.size === 0 || body < NECK_BODY_SHARE)) {
        shares.torso += shares.head
        shares.head = 0
      }
      const wanted = []
      for (const part of ['pelvis', 'torso', 'legs', 'head']) {
        const weight = shares[part] * body
        if (weight <= 0.0005) continue
        const bones = carried[part]
        const sum = [...bones.values()].reduce((total, value) => total + value, 0)
        if (sum <= 0) {
          wanted.push([fallback(part, position.getX(vertex)), weight])
          continue
        }
        for (const [name, own] of bones) wanted.push([name, weight * (own / sum)])
      }

      // Pack the parts' bones back into the vertex's own slots: the slot a bone
      // already had first, then a slot the parts just vacated, then one carrying
      // so little (under 0.15, an arm's or the head's sliver) that folding it in
      // is invisible. What still will not fit is folded into the heaviest weight.
      for (const slot of slots) if (slot.part) slot.weight = 0
      wanted.sort((a, b) => b[1] - a[1])
      const placed = new Set()
      const take = (name, weight) => {
        let index = slots.findIndex((slot) => slot.bone?.name === name)
        if (index < 0) index = slots.findIndex((slot) => slot.part && slot.weight <= 0)
        if (index < 0) index = slots.findIndex((slot) => slot.weight <= 0)
        if (index < 0) {
          for (let slot = 0; slot < 4; slot += 1) {
            if (slots[slot].weight > 0 && slots[slot].weight < 0.15 && (!slots[slot].bone || partOfBone(slots[slot].bone.name) === null)) {
              if (index < 0 || slots[slot].weight < slots[index].weight) index = slot
            }
          }
        }
        if (index < 0) return false
        // A folded-in slot's own weight is not thrown away: it moves to the
        // heaviest weight already placed. If there is none, the bone cannot be
        // placed after all and the caller folds its weight in instead.
        const displaced = slots[index].weight
        let heir = -1
        for (let slot = 0; slot < 4; slot += 1) {
          if (slot === index || slots[slot].weight <= 0) continue
          if (heir < 0 || slots[slot].weight > slots[heir].weight) heir = slot
        }
        if (displaced > 0 && heir < 0) return false
        if (heir >= 0) slots[heir].weight += displaced
        slots[index] = { bone: boneByName.get(name), part: partOfBone(name), weight }
        placed.add(name)
        return true
      }
      const leftOver = []
      for (const [name, weight] of wanted) if (!take(name, weight)) leftOver.push(weight)
      const slack = leftOver.reduce((total, weight) => total + weight, 0)
      if (slack > 0) {
        let heaviest = 0
        for (let slot = 0; slot < 4; slot += 1) if (slots[slot].weight > slots[heaviest].weight) heaviest = slot
        slots[heaviest].weight += slack
      }

      for (let slot = 0; slot < 4; slot += 1) {
        skinIndex.array[at + slot] = slots[slot].bone ? skeleton.bones.indexOf(slots[slot].bone) : 0
        skinWeight.array[at + slot] = Math.max(0, slots[slot].weight)
      }

      // What the parts' own skin still carries of another part: inside a part
      // this has to be nothing, which is what makes the part rigid. Inside a
      // *band* the two neighbouring parts are both expected, which is what the
      // band is for.
      const after = { pelvis: 0, torso: 0, legs: 0, head: 0 }
      for (const slot of slots) if (slot.part && slot.weight > 0) after[slot.part] += slot.weight
      if (height <= HIP_BAND_BOTTOM) leaks.legs = Math.max(leaks.legs, after.pelvis + after.torso + after.head)
      else if (height >= HIP_BAND_TOP && height <= waistband.bottom) {
        leaks.pelvis = Math.max(leaks.pelvis, after.legs + after.torso + after.head)
      } else if (height >= cut && height <= neck[0]) {
        leaks.torso = Math.max(leaks.torso, after.pelvis + after.legs + after.head)
      } else if (height >= neck[1]) {
        leaks.head = Math.max(leaks.head, after.pelvis + after.legs + after.torso)
      }
    }
    skinIndex.needsUpdate = true
    skinWeight.needsUpdate = true
    node.geometry = geometry
  })

  return {
    hip: [HIP_BAND_BOTTOM, HIP_BAND_TOP],
    waist: [waistband.bottom, waistband.top],
    neck: [neck[0], neck[1]],
    // Where the surface is *cut* open rather than blended: the belt's own top
    // edge, from which the jersey's hem is what turns with the torso (see
    // ``cutBeltAndSleeve``).
    cut,
    leaks,
    contour: waistBandContour(root, metrics),
  }
}

/**
 * Opens the body's surface along the belt and hides a sleeve under the opening.
 *
 * The weight cut makes each part rigid, but a vertex can only belong to one part:
 * where the *surface* spans two parts, its skin is pulled between them and has to
 * stretch, and at the belt that stretch is the whole of what read as the jersey
 * being wrung over the hips. So the surface is cut open at the belt instead —
 * every triangle the cut plane crosses is split along it, and each side of the cut
 * gets its own vertices, so the belt's skin belongs to the pelvis and the jersey's
 * to the torso. Nothing spans the cut, so nothing there can stretch.
 *
 * Under the opening sits a sleeve: a duplicate of the body's own surface either
 * side of the cut, inset toward the body's axis and weighted rigidly to the
 * pelvis. The jersey's hem slides over it, which is what the clothing does, and
 * there is no hole to see the body's inside through. It keeps the surface's own
 * normals and UVs, so it shows the belt under the hem rather than a seam.
 *
 * @param {THREE.Object3D} root the model, with its weights already cut into parts
 * @param {object} metrics result of measurePlayerRig
 * @param {{top: number}} waistband where the uniform's waistband is (its top edge
 *   is the cut: see ``measureWaistband``)
 * @returns {{cut: number, margin: number, inset: number, seam: number, sleeve: number,
 *   axis: number[], ring: number[][]}} the cut height in rig units, the sleeve's own
 *   numbers, how many vertices the cut and the sleeve added, and the cut's own ring —
 *   its body axis in the mesh's space and one point per direction of the seam, which
 *   is what `probeSleeve` measures the sleeve's coverage against
 */
function cutBeltAndSleeve(root, metrics, waistband) {
  const cutY = waistband.top / metrics.unitScale
  const marginY = SLEEVE_MARGIN / metrics.unitScale
  const shape = {
    cut: waistband.top,
    margin: SLEEVE_MARGIN,
    inset: SLEEVE_INSET,
    seam: 0,
    sleeve: 0,
    axis: [0, 0],
    ring: [],
  }

  // The cut's own ring, kept as one point per direction around the body: what the
  // sleeve has to stay inside and cover is measured on it (`probeSleeve`).
  const RING_SAMPLES = 12
  const ringSamples = new Array(RING_SAMPLES).fill(null)

  root.traverse((node) => {
    if (!node.isSkinnedMesh) return
    const geometry = node.geometry
    const source = geometry.index
    const position = geometry.attributes.position
    if (!source || !position) return
    const skeleton = node.skeleton
    const pelvisBone = skeleton.bones.findIndex((bone) => bone.name === PLAYER_BONES.spine)
    const torsoBone = skeleton.bones.findIndex((bone) => bone.name === PLAYER_BONES.spine01)
    if (pelvisBone < 0 || torsoBone < 0) throw new Error('player.glb is missing its spine bones')

    // The mesh's attributes, as plain arrays the new vertices can be appended to.
    // Every attribute is carried over unchanged — position, normal, uv and the
    // uniform's own vertex colours — so a cut face keeps looking like the surface
    // it came from; only the skin weights are rewritten.
    const attributes = {}
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      attributes[name] = {
        values: Array.from(attribute.array),
        itemSize: attribute.itemSize,
        normalized: attribute.normalized,
        array: attribute.array.constructor,
      }
    }
    const vertices = position.count
    let added = 0
    const weightsFor = (bone) => {
      const index = new Array(attributes.skinIndex.itemSize).fill(0)
      const weight = new Array(attributes.skinWeight.itemSize).fill(0)
      index[0] = bone
      weight[0] = 1
      return { skinIndex: index, skinWeight: weight }
    }
    // ``sources`` is one vertex, or two and a blend between them, so a cut face
    // interpolates the surface it was cut out of; ``weights`` says which part's
    // skin it is. Returns the new vertex's own number.
    const push = (sources, weights) => {
      for (const [name, attribute] of Object.entries(attributes)) {
        if (name === 'skinIndex' || name === 'skinWeight') {
          attributes[name].values.push(...weights[name])
          continue
        }
        for (let k = 0; k < attribute.itemSize; k += 1) {
          let value = 0
          for (const [sourceVertex, share] of sources) {
            value += attribute.values[sourceVertex * attribute.itemSize + k] * share
          }
          attributes[name].values.push(value)
        }
      }
      added += 1
      return vertices + added - 1
    }

    // How wide the surface is around the cut, so the sleeve can be inset toward
    // the body's own axis there rather than toward the origin.
    let axisX = 0
    let axisZ = 0
    let inBand = 0
    for (let vertex = 0; vertex < vertices; vertex += 1) {
      const y = position.array[vertex * 3 + 1]
      if (Math.abs(y - cutY) > marginY) continue
      axisX += position.array[vertex * 3]
      axisZ += position.array[vertex * 3 + 2]
      inBand += 1
    }
    if (!inBand) return
    axisX /= inBand
    axisZ /= inBand

    const pelvis = weightsFor(pelvisBone)
    const torso = weightsFor(torsoBone)
    const opened = []
    const sleeved = []
    for (let triangle = 0; triangle < source.count; triangle += 3) {
      const corners = [source.getX(triangle), source.getX(triangle + 1), source.getX(triangle + 2)]
      const heights = corners.map((vertex) => position.array[vertex * 3 + 1])
      const above = heights.map((y) => y >= cutY)
      const lifted = above.filter(Boolean).length
      if (lifted === 0 || lifted === 3) {
        opened.push(corners)
      } else {
        // Cycle the winding so the lone vertex comes first: a cyclic rotation is
        // the same winding, so every triangle the cut makes faces the way the
        // surface did.
        const lone = above.indexOf(lifted === 1)
        const ring = [corners[lone], corners[(lone + 1) % 3], corners[(lone + 2) % 3]]
        const [top, middle, bottom] = [heights[lone], heights[(lone + 1) % 3], heights[(lone + 2) % 3]]
        const along = [
          [(top - cutY) / (top - middle), ring[0], ring[1]],
          [(top - cutY) / (top - bottom), ring[0], ring[2]],
        ]
        // Each crossing gets a vertex on *both* sides of the cut: they coincide
        // now and come apart when the parts move, which is what the sleeve hides.
        for (const [t, from, to] of along) {
          const x = position.array[from * 3] + (position.array[to * 3] - position.array[from * 3]) * t
          const z = position.array[from * 3 + 2] + (position.array[to * 3 + 2] - position.array[from * 3 + 2]) * t
          const bucket = Math.floor(
            ((Math.atan2(z - axisZ, x - axisX) + Math.PI) / (2 * Math.PI)) * RING_SAMPLES,
          ) % RING_SAMPLES
          if (!ringSamples[bucket]) ringSamples[bucket] = [x, cutY, z]
        }
        const [one, two] = along.map(([t, from, to]) => [
          push([[from, 1 - t], [to, t]], lifted === 1 ? torso : pelvis),
          push([[from, 1 - t], [to, t]], lifted === 1 ? pelvis : torso),
        ])
        const near = lifted === 1 ? one : two
        const far = lifted === 1 ? two : one
        opened.push([ring[0], near[0], far[0]])
        opened.push([near[1], ring[1], ring[2]])
        opened.push([near[1], ring[2], far[1]])
        shape.seam += 4
      }
      // And the sleeve: the same surface, in the band around the cut, again with
      // its own vertices so it can move rigidly with the pelvis alone. The inset
      // goes on the copy's own position — the body's surface again, scaled toward
      // the body's axis — so the sleeve is the belt continuing under the jersey.
      const centre = (heights[0] + heights[1] + heights[2]) / 3
      if (Math.abs(centre - cutY) > marginY) continue
      const copies = corners.map((vertex) => {
        const copy = push([[vertex, 1]], pelvis)
        const at = copy * 3
        attributes.position.values[at] = axisX + (attributes.position.values[at] - axisX) * (1 - SLEEVE_INSET)
        attributes.position.values[at + 2] = axisZ + (attributes.position.values[at + 2] - axisZ) * (1 - SLEEVE_INSET)
        return copy
      })
      sleeved.push(copies)
      shape.sleeve += 3
    }
    if (!sleeved.length) return

    for (const [name, attribute] of Object.entries(attributes)) {
      geometry.setAttribute(
        name,
        new THREE.BufferAttribute(
          attribute.array.from(attribute.values),
          attribute.itemSize,
          attribute.normalized,
        ),
      )
    }
    geometry.setIndex(
      new THREE.BufferAttribute(
        source.array.constructor.from([...opened.flat(), ...sleeved.flat()]),
        1,
      ),
    )
    geometry.computeBoundingSphere()
    shape.axis = [axisX, axisZ]
    shape.ring = ringSamples.filter(Boolean)
  })

  return shape
}

/**
 * A driver for the loaded player model. Every target handed to ``applyPose`` is
 * in rig units; the driver converts to the skeleton's frame and writes the
 * bones.
 *
 * @param {THREE.Object3D} modelRoot the mounted model (its own frame is the
 *   space bone transforms are read in, so the model's placement is irrelevant)
 * @param {object} metrics result of measurePlayerRig
 * @param {Map<THREE.Object3D, {position: THREE.Vector3, quaternion: THREE.Quaternion}>}
 *   restPose the skeleton's local transforms before it was ever posed
 * @param {number[]} [placement=[0, 0, 0]] where the model sits inside the rig
 *   frame, in rig units — the offset the component gives it (the same one its
 *   JSX uses). Targets are authored against the rig frame's origin, so the
 *   driver has to subtract it before solving.
 */
export function createPlayerRig(modelRoot, metrics, restPose, placement = [0, 0, 0]) {
  if (!modelRoot.getObjectByName('armature')) throw new Error('player.glb is missing its armature')
  const bones = collectBones(modelRoot)

  // Rig units -> the skeleton's own frame, as the component places the model:
  // unwind the uniform scale the model was given and the half turn that faces it
  // at the pitcher. Everything below works in that frame.
  const toModel = new THREE.Matrix4()
    .makeScale(1 / metrics.unitScale, 1 / metrics.unitScale, 1 / metrics.unitScale)
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI))
  // Directions and lengths only (a translation of the hips, the toe's offset
  // from the ankle).
  const toModelVector = (point) => new THREE.Vector3(point[0], point[1], point[2]).applyMatrix4(toModel)
  const modelOrigin = toModelVector(placement)
  // Positions in the rig frame: where the model actually sits is subtracted out.
  const toModelPoint = (point) => toModelVector(point).sub(modelOrigin)
  // Uniform, but read it rather than assume: a rig-unit length becomes this many
  // model units.
  const unitLength = _v3.set(0, 1, 0).applyMatrix4(toModel).length()
  const len = (value) => value * unitLength
  // The same mapping the other way, for reporting a solved joint back in the
  // units the animation is authored in.
  const toRigVector = (point) => new THREE.Vector3(-point.x * metrics.unitScale, point.y * metrics.unitScale, -point.z * metrics.unitScale)
  // The model's own palm markers, read once (see handFrames).
  const handGrip = handFrames(modelRoot, restPose)
  // Which way round the handle each hand closes (see FINGER_CURL), read off the
  // model rather than assumed. A fist folds about the bar it is closing on, so
  // the axis is the handle's own direction; the *sign* is the fact about this
  // model: the knuckle is where the rig puts the fingers' joint, a finger
  // reaches the way the hand runs out to that joint, and the fold has to carry
  // the fingers toward the handle's own point in the palm. Whichever turn takes
  // the fingers that way is the one this hand closes with — and it is the same
  // turn for every pose, since it is written in the fist's own frame.
  const curlSign = {}
  for (const [side, names] of Object.entries(ARM_BONES)) {
    const fist = handGrip[side]
    if (!fist) continue
    // The knuckle, in the hand's own frame: the fingers' joint, sitting out
    // along the hand's axis.
    const joint = (restPose?.get(bones[names.fingers]) ?? bones[names.fingers]).position
    _curlJoint.copy(joint).normalize()
    _curlHandle.copy(fist.point).sub(joint)
    // Only the part of that offset that crosses the handle counts: a fold turns
    // the fingers about the handle's own direction.
    _curlHandle.addScaledVector(_curlAxis.copy(fist.handle), -_curlHandle.dot(_curlAxis))
    // Which way a finger starts to swing when it folds: the handle's direction
    // crossed with the direction the finger reaches in.
    _curlTurn.crossVectors(_curlAxis, _curlJoint).normalize()
    curlSign[side] = Math.sign(_curlTurn.dot(_curlHandle)) || 1
  }

  // --- Forward kinematics over the driven chain ------------------------------
  // Bones are written from the root down, so accumulating their local transforms
  // is exact within a frame without touching three's world matrices (the model
  // may be mid-frame). The chain stops at the model's own root, which keeps the
  // rest pass and the live pass in the same frame.
  const makeChain = (locals) => {
    const cache = new Map()
    // The transform above each bone that is not itself a bone (the armature)
    // still bends the chain, and is static, so it is folded in once.
    const above = new Map()
    for (const bone of Object.values(bones)) {
      const nodes = []
      for (let node = bone.parent; node && node !== modelRoot; node = node.parent) nodes.push(node)
      const matrix = new THREE.Matrix4()
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        nodes[i].updateMatrix()
        matrix.multiply(nodes[i].matrix)
      }
      above.set(bone, matrix)
    }
    // Local transforms the skeleton is read with: the live bones while posing,
    // or the snapshot of the resting skeleton for everything the pose is
    // relative to. A snapshot has no scale of its own (the rig rests unscaled).
    const localOf = (bone) => (locals ? locals.get(bone) : bone)
    const scaleOf = (local) => local.scale ?? ONE
    const of = (bone) => {
      const hit = cache.get(bone)
      if (hit) return hit
      const local = localOf(bone)
      let entry
      if (bone.parent?.isBone) {
        const parent = of(bone.parent)
        entry = {
          quaternion: parent.quaternion.clone().multiply(local.quaternion),
          // Every offset between two joints in this rig runs along its parent's
          // own bone axis, so the parent's scale can be applied to the offset
          // component-wise and still place the joint exactly.
          position: local.position.clone().multiply(parent.scale)
            .applyQuaternion(parent.quaternion).add(parent.position),
          scale: parent.scale.clone().multiply(scaleOf(local)),
        }
      } else {
        const matrix = above.get(bone).clone().multiply(_matrix.compose(local.position, local.quaternion, scaleOf(local)))
        entry = {
          quaternion: new THREE.Quaternion().setFromRotationMatrix(matrix),
          position: new THREE.Vector3().setFromMatrixPosition(matrix),
          scale: scaleOf(local),
        }
      }
      cache.set(bone, entry)
      return entry
    }
    const parentQuaternion = (bone) => (bone.parent?.isBone
      ? of(bone.parent).quaternion
      : _q3.setFromRotationMatrix(above.get(bone)).clone())
    const invalidate = (bone) => {
      cache.delete(bone)
      for (const child of bone.children) if (child.isBone) invalidate(child)
    }
    return { of, parentQuaternion, invalidate, clear: () => cache.clear() }
  }

  const restChain = makeChain(restPose)
  const liveChain = makeChain(null)

  // The pose is authored relative to the resting skeleton: each bone's resting
  // orientation, and the axis its own joint points along.
  const rest = new Map()
  for (const [name, bone] of Object.entries(bones)) {
    const entry = restChain.of(bone)
    const child = AIM_CHILD[name] ? bones[AIM_CHILD[name]] : null
    rest.set(name, {
      position: (restPose?.get(bone) ?? bone).position,
      quaternion: (restPose?.get(bone) ?? bone).quaternion,
      orientation: entry.quaternion.clone(),
      axis: child
        ? restChain.of(child).position.clone().sub(entry.position).normalize()
        : UP.clone(),
    })
  }

  // Writes a bone's rotation, given as a turn about the body applied to its
  // resting orientation, into the live chain.
  const setRotation = (name, rotation) => {
    const bone = bones[name]
    const orientation = _q1.copy(rotation).multiply(rest.get(name).orientation)
    bone.quaternion.copy(orientation).premultiply(_q2.copy(liveChain.parentQuaternion(bone)).invert())
    liveChain.invalidate(bone)
  }

  // The turn a bone's parent has taken, relative to the rest pose. A joint that
  // keeps its rest orientation inside its parent — a limb's roll, a clavicle at
  // rest — has to carry this. Writing an absolute "no rotation" instead cancels
  // the parent's turn and tears the body apart at the waist: that is exactly how
  // the shoulders ended up ~110 degrees out from the pelvis at the set stance.
  const parentDelta = (bone, into) => {
    const parent = bone.parent
    if (!parent?.isBone) return into.identity()
    return into.copy(liveChain.of(parent).quaternion)
      .multiply(_q4.copy(restChain.of(parent).quaternion).invert())
  }

  // Sets a bone's turn *relative to its parent*, so the parent's turn carries
  // through and the joint only absorbs what it adds of its own.
  const setRelative = (name, delta) => {
    setRotation(name, _q3.copy(parentDelta(bones[name], _q1)).multiply(delta))
  }

  // Points a bone's own axis at a target in the model's frame, carrying the
  // parent's turn so the joint twists by what it has to and no more.
  const aim = (name, target) => {
    const bone = bones[name]
    const from = liveChain.of(bone).position
    _v1.copy(target).sub(from).normalize()
    // Solve in the parent's turned frame: the carried turn goes onto the joint's
    // own axis, and comes off the direction it is aimed at.
    parentDelta(bone, _q1)
    _v1.applyQuaternion(_q2.copy(_q1).invert())
    setRelative(name, _q2.setFromUnitVectors(rest.get(name).axis, _v1))
  }

  // Swings a bone toward a target only as far as it needs to go: the clavicle is
  // part of the arm's reach (a batter reaches across the plate with the shoulder
  // as well as the elbow), but turning it whenever it could would fold the arm
  // into a stub at the loaded stance, where the hands are already at the back
  // shoulder. The turn is sampled from none to all of it and the first sample
  // that brings the joint within ``maxDistance`` of the target wins — so a
  // reachable target costs nothing and an out-of-reach one gets the whole
  // shoulder.
  const reachWithShoulder = (name, child, target, maxDistance) => {
    const info = rest.get(name)
    const bone = bones[name]
    let atRest = 0
    parentDelta(bone, _q1)
    // Where the grip lies in the chest's own turned frame.
    _v1.copy(target).sub(liveChain.of(bone).position).normalize()
      .applyQuaternion(_q2.copy(_q1).invert())
    const full = _q3.setFromUnitVectors(info.axis, _v1).clone()
    // The clavicle's budget: the swing is sampled up to this much of the way
    // toward pointing at the grip, and no further.
    const fullSwing = 2 * Math.acos(Math.min(1, Math.abs(full.w)))
    const budget = fullSwing > 1e-6 ? Math.min(1, SHOULDER_MAX_SWING / fullSwing) : 1
    // None is the first sample: a target the arm can already reach must leave the
    // clavicle exactly at its rest orientation inside the chest, or every pose
    // would start with the shoulder girdle swung a fraction of a full turn — a
    // fraction of a large angle is still a large angle when the clavicle is this
    // long, and the chest reads as twisted even in the set stance.
    let chosen = budget
    for (let step = 0; step <= SHOULDER_STEPS; step += 1) {
      const amount = (budget * step) / SHOULDER_STEPS
      setRelative(name, _q2.copy(IDENTITY).slerp(full, amount))
      const distance = liveChain.of(bones[child]).position.distanceTo(target)
      if (step === 0) atRest = distance
      if (distance <= maxDistance) {
        chosen = amount
        break
      }
    }
    setRelative(name, _q2.copy(IDENTITY).slerp(full, chosen))
    // How far the clavicle had to swing, and what the arm would have needed if
    // the shoulder had not helped at all.
    return { amount: chosen, swing: chosen * fullSwing, atRest }
  }
  // Two-bone IK: places the middle joint so the chain reaches ``target`` from
  // ``root``, bending toward ``pole``.
  const twoBoneIK = (root, target, length1, length2, pole) => {
    const toTarget = _v1.copy(target).sub(root)
    const distance = Math.min(toTarget.length(), (length1 + length2) * 0.999)
    const direction = toTarget.normalize()
    const along = (length1 * length1 - length2 * length2 + distance * distance) / (2 * distance)
    const out = Math.sqrt(Math.max(0, length1 * length1 - along * along))
    const perpendicular = _v2.copy(pole).sub(root).normalize()
    perpendicular.addScaledVector(direction, -perpendicular.dot(direction))
    if (perpendicular.lengthSq() < 1e-8) perpendicular.copy(UP).cross(direction).normalize()
    return root.clone().addScaledVector(direction, along).addScaledVector(perpendicular.normalize(), out)
  }

  // Rolls a foot up onto its own toe when the hips have been driven past the
  // leg's length: the ankle turns about the toe — the point the tuning put the
  // ball of the foot on — by as much as the leg needs and no more, moving
  // ``ankle`` in place. The toe itself never moves, so the shoe pivots on the
  // ground the way a real drive leg gives.
  //
  // The hinge is the shoe's own: horizontal and square to the direction the foot
  // points, which is the axis a foot flexes about. The roll runs from flat to the
  // ankle directly above the toe (past that the shoe would be tipping the other
  // way, i.e. the toe lifting instead). A foot that is not helped by rolling —
  // the front foot, whose shoe points away from the hips and which the tuning
  // lifts on purpose — is left alone; and if even a full roll is not enough, the
  // ankle lifts the rest of the way, so a leg the hips have outrun still cannot
  // stretch.
  const rollFootOnToe = (hip, ankle, toe, legLength) => {
    footLever.copy(ankle).sub(toe)
    footAxis.set(footLever.x, 0, footLever.z)
    if (footAxis.lengthSq() < 1e-8) return
    footAxis.crossVectors(UP, footAxis).normalize()
    // How far the roll can go: until the ankle stands directly over the toe.
    const maxRoll = Math.acos(Math.min(1, Math.max(-1, footLever.y / footLever.length())))
    if (maxRoll < 1e-4) return
    const rolledAt = (angle) => footRolled.copy(footLever)
      .applyQuaternion(footRoll.setFromAxisAngle(footAxis, angle))
      .add(toe)
    const distanceAt = (angle) => {
      const point = rolledAt(angle)
      return Math.hypot(hip.x - point.x, hip.y - point.y, hip.z - point.z)
    }
    // Which way round the hinge lifts the heel: the ankle rises as it comes
    // forward over the toe. Picked by the height rather than assumed, so the
    // foot's own side and yaw cannot turn the roll into the ground.
    if (rolledAt(1e-3).y < ankle.y) footAxis.negate()
    const flat = distanceAt(0)
    const full = distanceAt(maxRoll)
    // Rolling has to be the direction that gives. A foot the roll pulls *away*
    // from the hips — the front foot, whose shoe points away from them — keeps
    // the lift below instead.
    if (full > flat) return
    if (full >= legLength) {
      ankle.copy(rolledAt(maxRoll))
      const drop = hip.y - ankle.y
      const horizontal = Math.hypot(hip.x - ankle.x, hip.z - ankle.z)
      ankle.y += drop - Math.sqrt(Math.max(0, legLength * legLength - horizontal * horizontal))
      return
    }
    // The least roll that reaches, scanned rather than solved: the distance is
    // not monotone in general (raising the ankle shortens the leg, carrying it
    // forward does not), and the least roll is the least foot movement.
    const STEPS = 32
    let step = 1
    while (step < STEPS && distanceAt((maxRoll * step) / STEPS) > legLength) step += 1
    let lo = (maxRoll * (step - 1)) / STEPS
    let hi = (maxRoll * Math.min(step, STEPS)) / STEPS
    for (let refine = 0; refine < 12; refine += 1) {
      const mid = (lo + hi) / 2
      if (distanceAt(mid) > legLength) lo = mid
      else hi = mid
    }
    ankle.copy(rolledAt(hi))
  }

  // The horizontal part of the pelvis's drive, recomputed each frame: how far
  // the feet are carried with it (see the leg solve).
  const legCarry = new THREE.Vector3()
  // Scratch for the foot's toe (the point a shoe rolls over) and for the roll's
  // own axis, lever and answer.
  const footToe = new THREE.Vector3()
  const footAxis = new THREE.Vector3()
  const footLever = new THREE.Vector3()
  const footRolled = new THREE.Vector3()
  const footRoll = new THREE.Quaternion()
  const hipsRotation = new THREE.Quaternion()
  const leanRotation = new THREE.Quaternion()
  const upperRotation = new THREE.Quaternion()
  // The pelvis's own turn, as the chain ended up carrying it, kept for the leg
  // diagnostics below.
  const hipsDelta = new THREE.Quaternion()

  // Diagnostics for the last frame: the arms' joint targets and how hard the arm
  // had to work to reach them, in rig units, how far the pelvis, chest and head
  // actually turned, and the axis the pelvis and the chest turned *apart* on.
  // Kept on the model's userData so a test can tell whether the body is holding
  // the bat, whether the torso is following the hips rather than fighting them,
  // and whether the pelvis is leaning with the torso or standing upright under
  // it.
  const debug = { metrics, arms: [], legs: [], torso: {}, waistBand: null }

  // The turn a link has taken, relative to the rest pose, about the body's own
  // up axis (a yaw), read from the bone's accumulated orientation.
  const recordJoint = (key, name) => {
    const accumulated = liveChain.of(bones[name]).quaternion
    const restAccumulated = restChain.of(bones[name]).quaternion
    const delta = accumulated.clone().multiply(restAccumulated.clone().invert())
    // The turn's own axis, so a lean about the hip pivot does not read as yaw.
    _v1.copy(RIGHT_AXIS).applyQuaternion(accumulated)
    _v2.copy(RIGHT_AXIS).applyQuaternion(restAccumulated)
    debug.torso[key] = {
      // How far this link's left-right axis has turned, in the model's frame.
      yaw: Math.atan2(_v1.x, _v1.z),
      // The whole turn this link has taken, however it is composed.
      turn: 2 * Math.acos(Math.min(1, Math.abs(delta.w))),
    }
  }

  const driver = {
    debug,

    /**
     * Applies one frame of the batter animation.
     *
     * @param {object} pose every point in rig units, in the rig's frame
     * @param {object} pose.hip { yaw, leanX, leanZ, offsetY, offsetZ } — the hips'
     *   turn, the upper body's lean about the hip pivot, and the hips' own
     *   translation (the settle/drive)
     * @param {number} pose.torsoYawExtra shoulder turn beyond the hips
     * @param {number} pose.torsoOffsetZ the torso's own forward drive
     * @param {object} pose.head { yaw, pitch }
     * @param {Array<{side:number,knee:Array,ankle:Array,footYaw:number}>} pose.legs
     * @param {Array<{side:number,elbow:Array,grip:Array}>} pose.arms
     */
    applyPose(pose) {
      liveChain.clear()
      debug.arms.length = 0
      debug.legs.length = 0
      debug.torso = {}
      debug.pose = {
        hip: { ...pose.hip },
        torsoYawExtra: pose.torsoYawExtra,
        torsoOffsetZ: pose.torsoOffsetZ,
        head: { ...pose.head },
      }

      // --- Hips, torso and head ---------------------------------------------
      // The upper body's orientation is authored in one piece by the tuning: the
      // torso yaws to bodyYaw, then leans by leanX / leanZ about the world's
      // fore-aft and sideways axes (the 'YXZ' order the component's groups
      // use). The model is the same body facing the other way, so the yaw
      // carries over and the two lean axes flip. The skeleton carries that same
      // rotation, split across the spine by *region* rather than by degrees:
      //
      //   chest  - the authored upper body, exactly
      //   waist  - the same, so the waist and the ribcage rotate as one rigid
      //            block
      //   pelvis - the same block with its yaw rolled back by the swing's
      //            hip-to-shoulder separation
      //
      // so the whole separation is taken by the one short band of skin at the
      // waist, and a batter bent over the plate twists at the waist instead of
      // rolling his whole abdomen.
      //
      // The pelvis's roll is about the body's own (leaning) up axis, which
      // leaves the spine's segments collinear: the joints end up exactly where
      // a rigid torso hinged at the hip puts them, so nothing downstream of the
      // torso — not the legs' sockets, not the arm solves — has to move.
      const bodyYaw = pose.hip.yaw + pose.torsoYawExtra
      upperRotation.setFromAxisAngle(UP, bodyYaw)
      leanRotation.setFromEuler(_euler.set(-pose.hip.leanX, 0, -pose.hip.leanZ, 'YXZ'))
      upperRotation.multiply(leanRotation)
      hipsRotation.copy(upperRotation)
        .multiply(_q1.setFromAxisAngle(UP, -pose.torsoYawExtra))

      const spine = bones[PLAYER_BONES.spine]
      setRotation(PLAYER_BONES.spine, hipsRotation)
      const hipOffset = toModelVector([0, pose.hip.offsetY, pose.hip.offsetZ])
      // The torso's own drive, split between the two blocks the belt sits
      // between (see PELVIS_DRIVE_SHARE). Written on the spine (which is in the
      // pelvis's frame) a share of it carries the whole lower body with the
      // torso; written above the waistband the rest slides the torso over a
      // pelvis that stays behind.
      //
      // The drive is a *forward* push — toward the pitcher — and it is written in
      // the rig's own frame rather than down the pelvis's own axis. Turning it by
      // the pelvis's pose (what this did) sends it wherever the batter happens to
      // be facing, and the set stance faces the *plate*: at the set the drive's
      // own direction is 112 degrees off the pitcher's line, so a push meant to
      // carry the batter into the pitch slid the whole body sideways toward the
      // plate instead — 0.109 m of it at mid-swing, with the legs and feet
      // following the pelvis into the strike zone and out of the box. The rig's
      // -Z is the direction the tuning, the contact geometry and the bat's own
      // frame all assume.
      //
      // The share the *waist* takes is still turned into the pelvis's frame, so
      // the chest ends up in exactly the same place for any share: this is a
      // redistribution of one motion rather than a second one.
      const drive = toModelVector([0, 0, pose.torsoOffsetZ])
      const pelvisDrive = drive.clone().multiplyScalar(PELVIS_DRIVE_SHARE)
      const torsoDrive = drive
        .clone()
        .multiplyScalar(1 - PELVIS_DRIVE_SHARE)
        .applyQuaternion(_q1.copy(liveChain.of(spine).quaternion).invert())
      spine.position.copy(rest.get(PLAYER_BONES.spine).position)
        .add(hipOffset)
        .add(pelvisDrive)
      liveChain.invalidate(spine)

      // The waist takes the twist the pelvis was rolled back by. With the share
      // at 1 this leaves the waist and the ribcage at the same orientation —
      // the rigid block the pelvis is hinged to — and the ribcage only picks up
      // whatever a future share below 1 hands it.
      const spine01 = bones[PLAYER_BONES.spine01]
      setRotation(PLAYER_BONES.spine01, _q1.copy(upperRotation)
        .multiply(_q2.setFromAxisAngle(UP, -pose.torsoYawExtra * (1 - WAIST_TWIST_SHARE))))
      spine01.position.copy(rest.get(PLAYER_BONES.spine01).position).add(torsoDrive)
      liveChain.invalidate(spine01)
      // The ribcage: the chest, and so the shoulders, the arm solves and the
      // head's reference, end up exactly where the tuning put the upper body.
      setRotation(PLAYER_BONES.spine02, upperRotation)

      // The head's look is relative to the torso, like the marker it is solved
      // from, and takes the same yaw and forward tilt.
      _q1.setFromEuler(_euler.set(-pose.head.pitch, pose.head.yaw, 0, 'YXZ'))
      setRotation(PLAYER_BONES.neck, _q2.copy(upperRotation).multiply(_q1))

      // What the chain ended up doing, in the model's own frame (the axis each
      // link's left-right direction points along, as a yaw).
      recordJoint('hips', PLAYER_BONES.spine)
      recordJoint('waist', PLAYER_BONES.spine01)
      recordJoint('chest', PLAYER_BONES.spine02)
      recordJoint('neck', PLAYER_BONES.neck)

      // What the pelvis and the chest actually differ by, read back off the chain
      // that was just written rather than off the rotations that were asked for.
      // The swing's hip-to-shoulder separation is a *spin*, so the two may differ
      // by a turn about the body's own up axis and by nothing else: a pelvis left
      // out of the lean while the torso bends over it tips this axis by the lean
      // itself, which is the shear that tore the belt away from the pelvis. The
      // angle is the separation the pose ended up with, so a test can check it
      // against the one the tuning authored.
      hipsDelta.copy(liveChain.of(spine).quaternion)
        .multiply(_q2.copy(restChain.of(spine).quaternion).invert())
      _q3.copy(liveChain.of(bones[PLAYER_BONES.spine02]).quaternion)
        .multiply(_q2.copy(restChain.of(bones[PLAYER_BONES.spine02]).quaternion).invert())
      // Note the scratch hand-off: the chest's delta goes into _q4 *before*
      // _q2 is reused for the pelvis's inverse, or the product would be the
      // inverse multiplied by itself.
      _q4.copy(_q3).multiply(_q2.copy(hipsDelta).invert())
      debug.torso.separation = {
        angle: 2 * Math.acos(Math.min(1, Math.abs(_q4.w))),
        // Which way the two blocks each think is up. The swing's separation is a
        // spin about the body's own axis, so it leaves that axis exactly where it
        // was and the two have to agree; a *shear* — the pelvis standing upright
        // under a torso that bends over it — is precisely a disagreement about up,
        // and reads here as the lean's own angle. Read off the two up axes rather
        // than off the separation's own axis, which is all float noise when the
        // two are near enough identical (as they are at the stance, where the
        // swing asks for no separation at all).
        shear: _v1.copy(UP).applyQuaternion(hipsDelta).angleTo(_v2.copy(UP).applyQuaternion(_q3)),
      }

      // --- Legs: hips -> knee -> ankle, feet planted on the targets ---------
      const legLength = len(metrics.leg.thigh + metrics.leg.shin)
      const toeOffset = toModelVector(metrics.toeOffset.toArray())
      for (const leg of pose.legs) {
        const names = leg.side === 1 ? LEG_BONES.R : LEG_BONES.L
        const hip = liveChain.of(bones[names.hip]).position
        // The drive moves the whole body forward, and a foot may or may not be
        // carried with it: the tuning marks each foot with how much of the ride
        // it takes (``leg.carry``), because the two feet are not the same foot.
        // The pelvis's own share of the drive carries both feet — it is the body
        // moving over them, and a leg cannot be asked to span it. The hips' own
        // drive (the lunge the back leg fires) is taken only by the foot that is
        // stepping: the front foot rides it forward, while the back foot is the
        // pivot the whole swing turns on and stays planted, with what the lunge
        // asks for past the leg's length coming out of the shoe rolling on to its
        // toe (below). Carrying *both* feet the whole way was what walked the
        // batter across the plate: with the pelvis facing the plate at the set,
        // the ride dragged the feet sideways into the strike zone. Horizontal
        // only: a foot stays on the ground.
        legCarry.copy(pelvisDrive)
        if (leg.carry) legCarry.add(hipOffset)
        legCarry.y = 0
        const ankle = toModelPoint(leg.ankle).add(legCarry)
        // The foot's own toe — where the tuning puts the ball of the foot, on the
        // ground — is the point the shoe rolls over *and* the point the foot bone
        // is aimed at. Reading it off the target (rather than off wherever the
        // ankle ends up) is what keeps it planted: the ankle may move, the toe
        // does not.
        const toe = footToe.copy(ankle).add(
          _v2.copy(toeOffset).applyAxisAngle(UP, leg.footYaw),
        )
        // A rigid skeleton cannot stretch: when the hips are driven beyond the
        // leg's length the *shoe rolls onto its toe*. The ankle turns about the
        // toe, which lifts the heel and carries the ankle forward at the same
        // time — the way a real drive leg gives — instead of the ankle rising
        // straight up and taking the whole shoe off the ground with it (which is
        // what the old vertical lift did: the drive foot floated 0.09 rig units
        // through the swing, toe and all). Only what the foot's own geometry can
        // absorb comes out of the roll; past that the ankle lifts, so a leg the
        // hips have outrun still cannot stretch.
        const reach = Math.hypot(hip.y - ankle.y, Math.hypot(hip.x - ankle.x, hip.z - ankle.z))
        if (reach > legLength) rollFootOnToe(hip, ankle, toe, legLength)
        const knee = twoBoneIK(
          hip,
          ankle,
          len(metrics.leg.thigh),
          len(metrics.leg.shin),
          toModelPoint(leg.knee).add(legCarry),
        )
        aim(names.hip, knee)
        aim(names.knee, ankle)
        // The foot aims at the toe it is rolling over, so the roll's own rotation
        // is carried by the shoe rather than the ball of the foot sliding.
        aim(names.ankle, toe)

        // What the hip crease has to absorb: how far the thigh's own turn has
        // come off the pelvis's, read back off the chain. The leg is *not* asked
        // to lean with the torso — the foot is planted and the IK points the
        // thigh at the knee — so this is the hip joint's own rotation, and it is
        // what the band of skin between the trunks and the leg takes. Split into
        // the part that twists about the leg's own axis (which a roughly
        // cylindrical thigh hides) and the rest, which the crease has to crease.
        _q3.copy(liveChain.of(bones[names.hip]).quaternion)
          .multiply(_q2.copy(restChain.of(bones[names.hip]).quaternion).invert())
        _q4.copy(_q3).multiply(_q2.copy(hipsDelta).invert())
        _v1.copy(liveChain.of(bones[names.knee]).position).sub(liveChain.of(bones[names.hip]).position).normalize()
        // The thigh points down its own +Y, so the twist about it is the rotation
        // component the surface cannot see.
        const twist = Math.abs(2 * Math.atan2(dot3(_q4, _v1), _q4.w))
        debug.legs.push({
          side: leg.side,
          turn: 2 * Math.acos(Math.min(1, Math.abs(_q4.w))),
          twist: Math.min(twist, Math.PI),
        })
      }

      // --- Arms: pull the hands onto the bat's handle -----------------------
      //
      // The grip is one constraint on an arm and not the whole of it: a fist
      // turns to put its palm on the handle whatever that costs its wrist, and an
      // elbow hint points wherever the pose wanted it however far that leaves it
      // from the bat. So two joint limits are enforced here as well:
      //
      //   * the lead arm keeps its whole *forearm* in the region below the flat
      //     the bat swings in — the plane the barrel's own line and the swing's
      //     own axis make — which is two rules about one bone, since the bone is
      //     a segment and a segment is worst at an end: the elbow end is the
      //     elbow's own circle's to answer for, and the wrist end is the fist's
      //     roll's (the roll swings the reach that places the wrist). Where the
      //     plane is past what that arm can reach at all — the push to contact,
      //     where the whole circle of elbows is over it — the elbow sinks to the
      //     deepest point its circle has, and where the *elbow* end cannot be
      //     brought under, the roll stops answering for the wrist: sinking the
      //     wrist alone under a plane the elbow is over tilts the bone across the
      //     plane rather than lifting it clear of it, so the roll is left to the
      //     bend instead;
      //   * every wrist is held to WRIST_BEND_MAX of bend and WRIST_TWIST_MAX of
      //     roll off its own forearm, measured off the posed bones — and where
      //     that bend limit and the plane's own side of the wrist disagree, the
      //     bend is what the roll stays inside and the plane is sunk as deep as
      //     the bend allows (see `fistRoll` for why).
      //
      // What answers the wrist's limits is the one axis of a grip that is free,
      // and the same axis answers the forearm's second rule: a fist can roll
      // *about the barrel* with its palm's channel still on the handle, and that
      // roll sweeps the hand's own direction — its knuckles line, which the
      // model's own grip puts square across the handle (measured, 89.3 degrees)
      // — around the bat, while carrying the fist's reach, and so the wrist, with
      // it. Both of the numbers the roll has to hold are cosines in it, so where
      // it goes is arithmetic (`fistRoll`) rather than a search or an iteration,
      // and it is only *recomputed* per pass because the elbow's own rules move
      // the forearm it is measured against. The elbow's circle handles what the
      // roll cannot: a bend no roll can bring inside the limit, and an elbow that
      // has to come out from under the plane.
      for (const arm of pose.arms) {
        const names = arm.side === 1 ? ARM_BONES.R : ARM_BONES.L
        const side = arm.side === 1 ? 'R' : 'L'
        const grip = toModelPoint(arm.grip)
        // The fist closes on the *palm*, not on the wrist. `palm_handle` is the
        // reference rig's own marker for the handle inside the palm (see
        // handFrames): where the handle's point is in the hand's own frame, and
        // which way the handle runs through the fist. A hand is a hand long, so a
        // wrist pulled onto the grip leaves the bat running past the fist's own
        // edge — measured, the handle passed 1.4 to 1.9 hand-radii off the
        // fist's centre, which is what reads as the palms lying flat against the
        // bat instead of closing on it. Solving the palm onto the grip and
        // turning the fist until its own handle axis lies along the bat closes
        // them around the handle in every pose.
        const fist = handGrip[side]
        // The bat's own plane: the barrel's line crossed with the axis the
        // swing's own yaw turns about — the horizontal perpendicular to the
        // barrel's ground projection, which is the one axis the bat's tilt rides
        // on — with "up" the upward half of its normal. A bat standing straight
        // up leaves that perpendicular undefined, and there one is as good as
        // another: the plane is vertical either way, and so is the limit.
        const barrel = _barrel.copy(toModelVector(arm.axis)).normalize()
        _planePerp.set(-barrel.z, 0, barrel.x)
        if (_planePerp.lengthSq() < 1e-8) _planePerp.set(1, 0, 0)
        _planePerp.normalize()
        const normal = _planeNormal.crossVectors(_planePerp, barrel).normalize()
        if (normal.y < 0) normal.negate()
        const handleOverPlane = grip.dot(normal)
        const span = len(metrics.arm.upper + metrics.arm.fore)
        // How much of the plane's own "below" there is to hold the lead arm to,
        // in rig units: nought where the plane is upright enough for the rule to
        // bite, and the arm's own span where the plane stands on edge and has no
        // below at all (see PLANE_UP_MIN).
        const planeMargin = (1 - Math.min(1, normal.y / PLANE_UP_MIN)) * span
        const restHand = rest.get(names.hand)
        const restFore = rest.get(names.forearm)
        // The fist's own turn onto the handle, at the pose's own roll. Every roll
        // the rules below consider is a turn off this one, and this is where they
        // leave the fist whenever the pose's own roll can hold the limits. The
        // roll this authors is the first cut — the arm's own reach — and the solve
        // below re-authors it on the forearm it poses (see `the fist's own roll,
        // on the forearm`): the reference the knuckles' line is measured on is the
        // bone the bend is stated about, not the chord the arm reaches along.
        fistRotation(
          fist,
          barrel,
          grip,
          liveChain.of(bones[names.upperArm]).position,
          arm.palmUp ?? 0,
          arm.palmHeld ?? false,
          _handRotation,
        )
        _fistHome.setFromRotationMatrix(_handRotation)
        // The fist's own reach at the pose's roll — the wrist's own place is the
        // grip less this vector — and the four numbers every roll's answer about
        // the plane is built from: the reach's own part along the barrel and its
        // square part against it, and the same two for the plane's own normal. A
        // roll turns the reach with the hand, so neither of the reach's angles
        // changes as it turns: read once here, and every roll's wrist is a cosine
        // off these.
        _reachHome.copy(fist.point).applyQuaternion(_fistHome)
        const reachAlong = _reachHome.dot(barrel)
        const reachSquare = Math.sqrt(Math.max(0, _reachHome.lengthSq() - reachAlong * reachAlong))
        const normalAlong = normal.dot(barrel)
        const normalSquare = Math.sqrt(Math.max(0, 1 - normalAlong * normalAlong))
        // How deep the fist's whole reach could ever put the wrist under the
        // plane, by any roll: the reach's square part lined up with the normal's
        // own (see `fistRoll`).
        const reachDepth = reachAlong * normalAlong + reachSquare * normalSquare
        // How the arm is solved, in three poses. The fist's roll and the elbow's
        // own circle are two decisions about one arm, and each of them moves the
        // other's evidence — a roll carries the wrist round the handle, which
        // moves the forearm the elbow's rules read; an elbow moves the forearm
        // the roll's rule reads. Solving the two as a fixed point was tried and
        // is *not* what happens here (see `fistRoll`): the roll is decided once,
        // from the pose's own arm, and the elbow's rules are then asked about the
        // arm that roll leaves. Both decisions are therefore plain functions of
        // the animation, which is what keeps the fist and the forearm moving as
        // smoothly as the pose does.
        let roll = 0
        let moved = false
        let wrist = grip
        let shoulder = grip
        let elbow = grip
        let circle = null
        let stretch = 1
        let shoulderReach = null
        let cone = 0
        let lean = 0
        let bend = 0
        let deepest = 0
        let bendFloor = 0
        // The fist's own roll, re-authored on the forearm: how far the pose's own
        // roll was from the alignment when it was read (radians), how much of it
        // the arm could hold, and the bend that leaves before the rules touch it.
        let foreAlign = 0
        let foreShare = 1
        let fistBend = 0
        // The readings each step of the solve was taken from, for the suite and
        // for debugging a pose by hand: what the pose asked for, what the roll it
        // got left, and what the elbow's rules made of that.
        const steps = []
        // The arm's own turn and stretch, from the pass before: what the fist's
        // reach is carried through on the way to the world (see `fistReachAt`),
        // and the one thing about this arm that a pass cannot read before it has
        // placed a wrist — the stretch is measured from the wrist it is placing.
        let upperTurn = null
        let reachStretch = 1
        // The fist's own reach, as the *bones* will give it: the hand's own
        // counterscale, the fist's turn, and then the arm's stretch — which sits
        // *between* the upper arm's turn and the wrist's own, because three.js
        // composes a parent's scale with a child's rotation as a matrix product:
        // the scale acts on the marker's offset before the upper arm's turn rather
        // than simply scaling it. The model's plain `hand·point` therefore misses
        // the marker by however much of that offset lies across the stretch, which
        // is the palm 0.0109 rig off the handle the suite has been reading at
        // contact (the one frame the arm is stretched at, 1.154 of its own span)
        // against its 0.01 bound. The two turns it is read through are the previous
        // pass's, which is the same settle the roll and the elbow ride.
        const fistReachAt = (handTurn) => {
          _fistReach.copy(fist.point)
          if (Math.abs(reachStretch - 1) > 1e-6) _fistReach.y /= reachStretch
          _fistReach.applyQuaternion(handTurn)
          if (upperTurn && Math.abs(reachStretch - 1) > 1e-6) {
            _fistReach.applyQuaternion(_twistTurn.copy(upperTurn).invert())
            _fistReach.y *= reachStretch
            _fistReach.applyQuaternion(upperTurn)
          }
          return _fistReach
        }
        // Pose the chain for whatever the rules have settled on so far: the roll
        // the fist was given, the wrist that reach puts it at, the shoulder's own
        // swing toward it, the stretch that covers what the shoulder cannot, and
        // the elbow the rules last chose (or the pose's own hint where they have
        // not moved one). Everything the rules read is read off this, which is
        // what keeps them reading the arm on screen rather than a model of it.
        const poseChain = () => {
          _qHand.copy(_rollTurn.setFromAxisAngle(barrel, roll)).multiply(_fistHome)
          // The wrist that puts the palm there: the handle point the fist closes
          // on, less the fist's own reach from the wrist. (This is why the roll is
          // an axis to move the wrist on: it carries the reach round the handle
          // with it, and the wrist — and so the forearm's whole line — follows.)
          fistReachAt(_qHand)
          wrist = grip.clone().sub(_fistReach)
          // The shoulder swings its socket toward the hand before the arm solves:
          // the clavicle is the arm's first lever, and reaching across the plate
          // with the shoulder is what a real batter does. It only goes as far as a
          // clavicle can, though, and takes no part of a target the arm can already
          // span — the stretch below covers the rest.
          shoulderReach = reachWithShoulder(
            names.shoulder,
            names.upperArm,
            wrist,
            span * ARM_SHOULDER_BEND,
          )
          shoulder = liveChain.of(bones[names.upperArm]).position
          // What the grip asks of the arm, and so how far the arm's bones have to
          // stretch to hold it (never shorter than the model's own proportions).
          stretch = THREE.MathUtils.clamp(shoulder.distanceTo(wrist) / span, 1, ARM_STRETCH_MAX)
          circle = middleJointCircle(
            shoulder,
            wrist,
            len(metrics.arm.upper) * stretch,
            len(metrics.arm.fore) * stretch,
          )
          // The elbow's bend hint rides the fist: it is authored as a fraction of
          // the way from the shoulder to the hand, so the same walk back to the
          // wrist has to come off it as well or the pole would sit a hand's length
          // out past the arm and bend the elbow the wrong way.
          const hinted = twoBoneIK(
            shoulder,
            wrist,
            len(metrics.arm.upper) * stretch,
            len(metrics.arm.fore) * stretch,
            toModelPoint(arm.elbow).sub(_fistReach),
          )
          elbow = moved
            ? _elbowPoint.copy(circle.centre).addScaledVector(_wantedDir, circle.radius)
            : hinted
          aim(names.upperArm, elbow)
          // The stretch itself. A bone's scale reaches its child's offset, so the
          // upper arm carries the whole arm's stretch — its own segment and the
          // forearm's, which is why the forearm's own scale stays 1 — and the hand
          // cancels it again, leaving the glove its own size. It goes on before the
          // forearm is aimed, since the forearm hangs off the stretched elbow.
          bones[names.upperArm].scale.y = stretch
          bones[names.hand].scale.y = 1 / stretch
          liveChain.invalidate(bones[names.upperArm])
          aim(names.forearm, wrist)
          // The hand's own turn, written as the roll on screen before anything is
          // measured: every rule below reads the hand's own direction off the
          // chain, and a hand still carrying last pass's turn would have the rules
          // deciding about a fist nobody is going to see. (The forearm's roll,
          // which the hand is finally turned against, is written at the end: it is
          // decided from the twist, and the twist is this turn's.)
          _handTurn.copy(_qHand).multiply(_twistTurn.copy(restHand.orientation).invert())
          setRotation(names.hand, _handTurn)
          // ...and what the *next* pass reads the reach through: the arm's own
          // turn, as the aim just left it, and the stretch it was solved with.
          reachStretch = stretch
          upperTurn = _upperTurn.copy(liveChain.of(bones[names.upperArm]).quaternion)
        }
        // What the pose ended up with, read off the chain the way the suite reads
        // it: the hand's own direction and the forearm's, against each other and
        // against the barrel.
        const readAim = () => {
          _handAim.copy(liveChain.of(bones[names.fingers]).position)
            .sub(liveChain.of(bones[names.hand]).position).normalize()
          // The forearm, read off the posed bones rather than from the elbow the
          // solve's own model put there. The two differ by however far the whole
          // arm misses its own targets — the model is exact about where the circle
          // of elbows is, and the pose is not exactly on it, since the shoulder,
          // the clavicle's swing and the stretch all arrive a little off it — and
          // it is the bones that the bend is a bend *of*. Measured, the gap runs
          // to 12.6 degrees exactly where the arm folds through the follow-through,
          // which is where the bend is at its own limit: reading the model's elbow
          // there put the driver 18.6 degrees away from the arm on screen.
          _elbowPosed.copy(liveChain.of(bones[names.forearm]).position)
          _foreAim.copy(liveChain.of(bones[names.hand]).position)
            .sub(_elbowPosed).normalize()
          // How far the model's own elbow sits from the posed one. The circle below
          // is the shape the bones *can* reach, and every candidate on it misses
          // the pose by this much too, so the shift is carried by each candidate
          // the walk reads — that is what keeps the model's forecast of a candidate
          // honest against the arm the bones would actually pose.
          _elbowShift.copy(_elbowPosed).sub(elbow)
          cone = Math.acos(THREE.MathUtils.clamp(_handAim.dot(barrel), -1, 1))
          lean = Math.acos(THREE.MathUtils.clamp(_foreAim.dot(barrel), -1, 1))
          bend = Math.acos(THREE.MathUtils.clamp(_handAim.dot(_foreAim), -1, 1))
        }
        // --- The arm's own rules ----------------------------------------------
        // The arm solves for two things at once: where the fist's roll about the
        // barrel goes, and where the elbow's own rules put it on the circle its
        // bones allow. They are coupled — rolling the fist swings its reach round
        // the handle and carries the wrist with it, which moves both the circle
        // and the forearm the elbow's rules are asked about — so they are settled
        // together, a little at a time: each pass poses the arm at the answers so
        // far, reads the arm that pose gives, and moves each answer a step towards
        // where that pose's own rule would put it. Every rule below is a plain
        // function of the pose the pass reads, and the loop is the only place the
        // two of them meet — which is what keeps the arm a continuous function of
        // the pose rather than a fixed point found afresh each frame.
        poseChain()
        readAim()
        // The fist's own frame, read once at the roll the pose authors: the hand's
        // own direction and the fist's reach round the handle are what the roll is
        // a turn *of*, and asking the rule about those rather than about the frame
        // the solve currently holds is the other half of what keeps it a function
        // of the pose alone.
        _handHome.copy(_handAim)
        // --- The fist's own roll, authored on the forearm ------------------------
        // The roll the preamble authored is the arm's *reach*, and the line the bend
        // at the wrist is measured against is the *forearm*. Those are the same
        // line only with the elbow straight: over the cycle they part by 15 to 80
        // degrees (the trail arm asking 55 at the set stance and 76 through the
        // follow-through), and a fist rolled onto the chord rather than onto the
        // bone is a bend no elbow on its own circle can close — measured, the trail
        // wrist's floor ran 114.8 degrees against the 30 degree limit with the
        // reference on the chord. So the pose's own roll is re-authored here, on the
        // forearm the arm is actually posed with, and the rules below are asked
        // about *that* fist: the knuckles' line then runs along the bone the limit
        // is stated about, and what the roll has left to answer for is the residue
        // (reported as `wristRollRule`).
        //
        // What bounds the re-authoring is the arm's own reach, because a roll
        // carries the wrist round the handle with it (the wrist is the grip less the
        // fist's reach): the whole alignment can ask for a span the bones do not
        // have, and where that happens the palm leaves the handle rather than the
        // fist turning — measured with the alignment taken whole, the set stance's
        // lead palm read 0.0332 rig off the handle's axis against the suite's 0.01.
        // So the alignment is taken in the share of it the arm can still close on:
        // whole while the wrist it asks for is inside ARM_STRETCH_MAX of the arm's
        // own span, and shed in proportion past that. Both halves are continuous in
        // the pose, which is what keeps the fist from hopping between them.
        const posedBend = bend
        foreAlign = halfTurn(squareAngle(_handHome, _foreAim, barrel))
        foreShare = 1
        if (Math.abs(foreAlign) > 1e-4) {
          _rollTurn.setFromAxisAngle(barrel, foreAlign).multiply(_fistHome)
          fistReachAt(_rollTurn)
          const asked = shoulder.distanceTo(_v1.copy(grip).sub(_fistReach)) / span
          const held = shoulder.distanceTo(wrist) / span
          foreShare = asked <= held
            ? 1
            : THREE.MathUtils.clamp(
              (ARM_STRETCH_MAX - held) / Math.max(1e-6, asked - held), 0, 1)
          if (foreShare > 1e-4) {
            // The pose's own frame turns with it — and with the frame, the two
            // readings the rules below ask about: the hand's own direction and the
            // fist's reach, both of which a roll about the barrel carries with the
            // hand (their own angles to the barrel do not change as it turns).
            _rollTurn.setFromAxisAngle(barrel, foreAlign * foreShare)
            _fistHome.premultiply(_rollTurn)
            _handHome.applyQuaternion(_rollTurn)
            _reachHome.applyQuaternion(_rollTurn)
          }
        }
        steps.push({ step: 'posed', roll: 0, bend: THREE.MathUtils.radToDeg(bend) })
        // How far this arm's fist may turn at all: the grip's own window, less as
        // much of it as the arm's reach cannot answer for (see `reachRollWindow`).
        // It is fixed for the whole solve — the shoulder the reach is measured from
        // and the grip and the reach it turns are all the pose's own, and only the
        // *answer* moves between passes — and it is what keeps a rule that wants a
        // wrist past the arm's span from buying it with the palm.
        const rollWindow = Math.min(
          GRIP_ROLL_MAX,
          reachRollWindow(shoulder, grip, _reachHome, barrel, span * (ARM_STRETCH_MAX - 0.02)),
        )
        for (let pass = 0; pass < ARM_SOLVE_PASSES; pass += 1) {
          if (pass > 0) {
            // The arm at the answers the passes before settled on.
            poseChain()
            readAim()
          }
          // --- Where the fist's roll goes --------------------------------------
          // The rule's own answer, read off the arm this pass holds: the hand's
          // own direction at the pose's roll, and the forearm the pose's own elbow
          // hint gives. Both of the numbers the roll answers for are cosines in it
          // (see `fistRoll`), so this is arithmetic and not a search — and the step
          // towards it is damped (ROLL_SETTLE), because the answer moves with the
          // arm it is asked about.
          //
          // Whether the wrist's own side of the plane is the roll's to answer for
          // is the *lead* arm's alone, and there it is answered unconditionally:
          // the whole of the forearm's lower end — wrist as much as elbow — is held
          // in the region between the bat's plane and the ground, and where the two
          // rules of that region cannot both be had, the wrist's is the one the roll
          // holds (see `fistRoll`): the elbow's own circle below does the rest. The
          // roll is the only thing that *can* move the wrist — the fist's reach is
          // what puts it where it is — and its own window is a grip's fifteen
          // degrees (GRIP_ROLL_MAX), so where the plane needs more turn than a fist
          // has, the wrist sinks as far as the turn goes and the residue is what the
          // `wristOverPlane` reading below is for.
          roll += ROLL_SETTLE * halfTurn(
            fistRoll(
              _handHome,
              _foreAim,
              _reachHome,
              barrel,
              normal,
              arm.lead ? planeMargin : Infinity,
              arm.lead,
              rollWindow,
            ) - roll,
          )
          bendFloor = _rollFloor
          // Whether the roll could bring *this* wrist inside the limit at the arm
          // it left. Where it could not, the circle below is walked for an elbow
          // the roll *can* hold — which is a question about the forearm's own
          // direction, and so about the elbow, rather than about the roll — and
          // where no elbow on it can, the roll's own floor is what the wrist is
          // left with (reported as `bendFloor`).
          const rollHeld = _rollBend <= WRIST_BEND_MAX + 1e-3
          // --- The elbow's own circle -----------------------------------------
          // An elbow can only ever sit on this circle, so both rules about where
          // it belongs are rules about a point on it, and they are answered
          // together, by one walk. Each rule is a filter on the walk — the lead
          // elbow's side of the plane first, the bend the roll leaves second —
          // rather than a case that moves the elbow to its own idea of where the
          // arm should be. Measured, the case-per-rule version hopped the elbow
          // 0.29 rig units in a single frame at the hold: a pose drifting between
          // "the roll holds the bend, so walk to the plane's boundary" and "it does
          // not, so walk to the bend's" moves the answer between two different
          // points.
          _perpNormal.copy(normal).addScaledVector(circle.axis, -normal.dot(circle.axis))
          const across = _perpNormal.length()
          const base = circle.centre.dot(normal) - handleOverPlane
          // How deep the circle of elbows goes: its deepest point's side of the
          // plane. Where the whole circle is over the plane the arm cannot reach
          // under it at all, and that deepest point *is* the rule — sink as far as
          // the arm can. (Where the pose's own elbow sits against it is `elbowSide`,
          // read above — the roll's own rules asked it whether that end of the
          // forearm's rule was theirs to answer for.)
          deepest = base - circle.radius * across
          const planeAtAll = arm.lead && across > 1e-4
          if (planeAtAll) _perpNormal.divideScalar(across)
          // The elbow's own direction around the circle, and how far from it a
          // candidate has to be read.
          _circleAcross.copy(elbow).sub(circle.centre)
          const elbowReach = _circleAcross.length()
          if (elbowReach > 1e-6) _circleAcross.divideScalar(elbowReach)
          // ...and squared to the circle's own plane, which is the plane every
          // candidate below is a *point of*. The elbow this pass inherits sits near
          // that plane rather than in it — the wrist it was solved to has moved
          // since, whenever the fist's roll moved it — so the direction to it has
          // a part along the axis, and a point laid at the circle's perpendicular
          // radius off a direction like that lands *inside* the circle by however
          // much. Measured with the roll re-authored on the forearm, the placed
          // elbow came out 0.029 rig short of the circle and the palm 0.032 rig off
          // the handle: the arm was aimed at an elbow it could not reach from, so
          // its own forearm fell short of the wrist it was aimed at.
          if (circle.radius > 1e-6) {
            _circleAcross.addScaledVector(circle.axis, -_circleAcross.dot(circle.axis))
            if (_circleAcross.lengthSq() < 1e-12) {
              _circleAcross.copy(UP).cross(circle.axis)
              if (_circleAcross.lengthSq() < 1e-12) _circleAcross.set(1, 0, 0).cross(circle.axis)
            }
            _circleAcross.normalize()
          }
          // What the elbow's own search found, for the debug trace: the lowest
          // bend the roll reaches anywhere on the circle, and whether any point of
          // it holds the bend inside the limit at all. With the roll alone it is
          // the roll's own reading where the pose's own elbow sits.
          let circleBest = _rollBend
          let circleFound = rollHeld
          let chosen = false
          if (circle.radius > 1e-6 && elbowReach > 1e-6) {
            // The circle is walked for the point nearest the pose's own elbow that
            // (a) clears the plane where the lead arm is asked to and (b) leaves the
            // forearm's own direction one that the roll can bring the bend inside
            // the limit on. Where the plane leaves no such point at all, the point
            // with the lowest bend the roll can reach wins, so the arm still gives
            // as much of the limit as it can — and where not even that clears the
            // plane, the deepest point on the circle is what the arm has.
            _circleV.crossVectors(circle.axis, _circleAcross)
            // The plane's own half of every question below, which the two arms
            // answer from opposite sides: the lead elbow belongs *under* the bat's
            // plane, and the trail elbow *over* it — that arm comes round the
            // chest rather than across it, which is what the suite's own reading
            // holds it to, and a bend rule that walked the trail elbow to the far
            // side of the plane would be trading one limit for another.
            // A point of the circle by its own angle: where its elbow sits, where
            // the forearm then points, and the bend that leaves.
            const readAt = (theta) => {
              _candidateDir.copy(_circleAcross).multiplyScalar(Math.cos(theta))
                .addScaledVector(_circleV, Math.sin(theta))
              // The candidate is a point of the circle the arm's *bones* can close
              // on, so the chain lands on the wrist target from it and the palm
              // stays where the grip put it. The shift is carried by the direction
              // forecast only: the pose's own elbow sits that far off the model's
              // point, so the forearm that would hang there points from the shifted
              // elbow — but placing the *bone* off the circle would leave the arm
              // short of the target, which is the palm 0.012 rig off the handle it
              // was measured at before this separation.
              _candidate.copy(circle.centre).addScaledVector(_candidateDir, circle.radius)
              _foreAim.copy(wrist).sub(_elbowShift).sub(_candidate).normalize()
              // What the roll's own rule would leave at this candidate. The elbow
              // is asked for the *shape* it gives the roll to work with rather than
              // for the bend at whatever roll the pose happened to author — the
              // roll is the other half of this solve, and it moves. Every candidate
              // here is on the plane's own side of the lead arm, so the wrist is
              // held to the plane itself.
              fistRoll(
                _handHome,
                _foreAim,
                _reachHome,
                barrel,
                normal,
                arm.lead ? planeMargin : Infinity,
                false,
                rollWindow,
              )
              _floorHere = _rollBend
              // The candidate's own side of the plane, read off the point rather
              // than off the circle's geometry: the shift above moves the point,
              // and the plane's rule is about where the elbow *is*.
              const side = _candidate.dot(normal) - handleOverPlane
              // Only the *lead* arm answers to the plane. The trailing elbow is
              // free to sit wherever its own hint puts it: held over the plane, a
              // bat that comes round flat puts that elbow above the hands — and
              // above its own shoulder — for the whole follow-through, because
              // "over the plane" with a horizontal plane *is* above the hands.
              // Measured over the follow-through and the hold, that restraint was
              // what kept the trail elbow at +0.48 of the upper arm's length above
              // its own shoulder (see the suite's own reading) once the bat ended
              // flat, and the hint that asks for it *down* had no say at all.
              return arm.lead ? side <= planeMargin : true
            }
            const feasibleAt = (theta) => readAt(theta) && _floorHere <= WRIST_BEND_MAX
            let bestAway = Infinity
            let lowestFloor = Infinity
            let lowestAway = Infinity
            let found = false
            let haveLowest = false
            for (let step = 0; step < ELBOW_SEARCH_STEPS; step += 1) {
              const theta = (step / ELBOW_SEARCH_STEPS) * Math.PI * 2
              if (!readAt(theta)) continue
              const here = _floorHere
              // How far round the circle the candidate is from the pose's own
              // elbow: what a tie between two candidates is broken by.
              const away = theta > Math.PI ? Math.PI * 2 - theta : theta
              if (here <= WRIST_BEND_MAX && away < bestAway) {
                bestAway = away
                found = true
                _bestDir.copy(_candidateDir)
              }
              if (here < lowestFloor - 1e-6 ||
                (Math.abs(here - lowestFloor) <= 1e-6 && away < lowestAway)) {
                lowestFloor = here
                lowestAway = away
                haveLowest = true
                _lowestDir.copy(_candidateDir)
              }
            }
            if (haveLowest) circleBest = lowestFloor
            circleFound = found
            // The pose's own elbow is over the limit, so the circle is walked
            // *from* it: the sample that clears is a bracket, and the boundary
            // between the two — where the floor reads exactly the limit, or
            // where the plane is met, whichever comes first — is solved for by
            // halving. That boundary is a continuous function of the pose, so
            // the elbow follows the pose instead of snapping between samples.
            const step = (Math.PI * 2) / ELBOW_SEARCH_STEPS
            if (found) {
              const side = _bestDir.dot(_circleV) >= 0 ? 1 : -1
              let near = 0
              let far = side * bestAway
              readAt(near)
              for (let i = 0; i < ELBOW_REFINE_STEPS; i += 1) {
                const mid = (near + far) / 2
                if (feasibleAt(mid)) far = mid
                else near = mid
              }
              readAt(far)
              _wantedDir.copy(_candidateDir)
              chosen = true
            } else if (haveLowest && planeAtAll) {
              // The circle can clear the plane but not with the bend inside the
              // limit, and the lead elbow's own rule outranks the wrist's: it
              // goes to the deepest point the circle has — as far under the
              // plane as that arm can reach — rather than trading the plane for a
              // straighter wrist. (Measured at 0.82-0.83 s the other way round,
              // trading the plane bought about six degrees of bend and left the
              // elbow 0.023 rig *over* — a flick of the elbow off the plane in
              // the one window the pose holds it flat.)
              _wantedDir.copy(_perpNormal).negate()
              chosen = true
            } else if (haveLowest) {
              // No plane rule to answer to: the lowest floor is the best the arm
              // can do, and the sample that found it is refined the same way — a
              // golden-section inside one sample's step either side of it, on the
              // floor alone.
              const side = _lowestDir.dot(_circleV) >= 0 ? 1 : -1
              const centre = side * lowestAway
              const golden = (Math.sqrt(5) - 1) / 2
              let a = centre - step
              let b = centre + step
              let c = b - golden * (b - a)
              let d = a + golden * (b - a)
              readAt(c)
              let fc = _floorHere
              readAt(d)
              let fd = _floorHere
              for (let i = 0; i < ELBOW_REFINE_STEPS; i += 1) {
                if (fc < fd) {
                  b = d
                  d = c
                  fd = fc
                  c = b - golden * (b - a)
                  readAt(c)
                  fc = _floorHere
                } else {
                  a = c
                  c = d
                  fc = fd
                  d = a + golden * (b - a)
                  readAt(d)
                  fd = _floorHere
                }
              }
              readAt((a + b) / 2)
              _wantedDir.copy(_candidateDir)
              chosen = true
            } else if (planeAtAll) {
              // Not one point of the circle clears the plane: the arm cannot reach
              // under it at all, so it sinks as far as it can — the deepest point
              // the circle has — and the plane's own rule has done its best.
              _wantedDir.copy(_perpNormal).negate()
              chosen = true
            }
          }
          if (chosen) moved = true
          // The floor, as the walk found it: the lowest bend the fist's own roll
          // leaves anywhere on the circle of elbows this arm can reach — which is
          // the honest "could the arm have done better" reading, since the roll is
          // the pose's (see GRIP_ROLL_MAX). It is what tells a limit the solve kept
          // from one the arm's own reach could not.
          bendFloor = circleBest
          steps.push({
            step: 'pass',
            pass,
            roll: THREE.MathUtils.radToDeg(roll),
            bend: THREE.MathUtils.radToDeg(bend),
            // What the roll leaves for the bend at the arm it is asked about, and
            // what the circle's own walk found.
            held: THREE.MathUtils.radToDeg(_rollBend),
            floor: THREE.MathUtils.radToDeg(bendFloor),
            circleBest: THREE.MathUtils.radToDeg(circleBest),
            found: circleFound,
          })
        }
        // --- The settled pose -------------------------------------------------
        // What the two decisions add up to, posed: the roll the fist holds, the
        // elbow on its own circle, and the chain solved onto the grip from there.
        // The arm on screen, the arm the readings are taken from and the arm the
        // suite measures are then one and the same rather than one step apart.
        poseChain()
        readAim()
        fistBend = Math.acos(THREE.MathUtils.clamp(_handHome.dot(_foreAim), -1, 1))
        steps.push({ step: 'settled', roll: THREE.MathUtils.radToDeg(roll), bend: THREE.MathUtils.radToDeg(bend) })
        // And what the rules would say about the arm they settled on: the roll
        // they would choose is read back here rather than assumed to be the one it
        // holds — a mismatch is what a rule that is not a plain function of the
        // pose looks like from outside — and the floor comes with it, which is the
        // number that tells a limit the solve kept from one the arm's own reach
        // could not.
        _handHome.copy(_handAim).applyQuaternion(_twistTurn.setFromAxisAngle(barrel, -roll))
        const rollSettled = fistRoll(
          _handHome,
          _foreAim,
          _reachHome,
          barrel,
          normal,
          arm.lead ? planeMargin : Infinity,
          arm.lead,
          rollWindow,
        )
        // Where the wrist's own rule and the bend's each wanted the fist, and how
        // wide the arc around each is that holds its own limit: read off the same
        // call that chose the roll the arm holds, so a pose can be told apart from
        // a solve that failed it — a plane whose ideal turn is outside the grip's
        // window (GRIP_ROLL_MAX) is a wrist no roll this fist owns can sink.
        const rollWanted = {
          planeIdeal: _rollPlaneIdeal,
          planeHalf: _rollPlaneHalf,
          bendIdeal: _rollBendIdeal,
          bendHalf: _rollBendHalf,
          windowDeepest: _rollWindowDeepest,
        }
        // The hand: the fist's own frame from above, rolled about the barrel by
        // whatever the bend limit asked for, written as the hand's world
        // orientation. The hand keeps the model's own rig — its fingers and thumb
        // ride their rest offsets from the hand bone — so turning the hand turns
        // the whole fist around the handle it is closing on, and the wrist keeps
        // the roll it was rigged with, which is what the model's grip is shaped
        // for.
        // The wrist's own twist, read the way the suite reads it (see probeAxes):
        // the hand's turn off the forearm's, and how much of that is a roll about
        // the forearm's own live axis. The reading is what the suite takes, so the
        // forearm's correction below can be applied and trusted rather than
        // argued: an angle's own sign conventions are easy to get backwards, and
        // a reading is not.
        const wristTwist = () => {
          _foreAim.copy(liveChain.of(bones[names.hand]).position)
            .sub(liveChain.of(bones[names.forearm]).position).normalize()
          // The hand's turn off the forearm, *in the world*: `fore⁻¹ · hand` is
          // the same relative turn, but stated in the forearm's own frame, and
          // projecting that on the forearm's live direction — which is a world
          // direction — mixes two frames and reads noise. Measured, that noise
          // was what the forearm's roll was being asked to cancel, and it
          // answered a roll of 46 degrees with 21, or with nothing at all.
          _relative.copy(liveChain.of(bones[names.hand]).quaternion)
            .multiply(_twistTurn.copy(liveChain.of(bones[names.forearm]).quaternion).invert())
          // Read as an angle, this comes back through the quaternion's own half
          // angle, which has a branch a whole turn wide: the same twist reads as
          // 333 degrees as readily as it does as -27. A turn is not a twist, so
          // it is folded into the half turn either side of zero before anything
          // is decided from it — the roll a turn of correction asks for is a roll
          // the other way round, and *measured*, leaving it unfolded walked the
          // forearm 323 degrees the long way and left the wrist twisted twice as
          // far as it started.
          const reading = 2 * Math.atan2(
            _relative.x * _foreAim.x +
              _relative.y * _foreAim.y +
              _relative.z * _foreAim.z,
            _relative.w,
          )
          return reading > Math.PI ? reading - Math.PI * 2
            : reading < -Math.PI ? reading + Math.PI * 2 : reading
        }
        // The forearm carries the roll the hand's grip still asks for off it: the
        // wrist's own limit is WRIST_TWIST_MAX of roll about the forearm, and
        // everything past that is what a forearm's pronation is for. It is taken
        // on the forearm's *own* axis — a turn of the bone about itself — which
        // leaves the hand (and the handle in it) exactly where the grip put them:
        // the arm turns under the grip rather than the grip turning on the bat.
        //
        // The forearm is written *before* the hand, and that order is the whole of
        // it: a bone's world orientation is written through its parent's, so the
        // hand's turn has to be read against the forearm it ends up on. Written the
        // other way round the hand inherits the forearm's roll with it — measured,
        // that took the palms 90 degrees off the handle and left the twist at the
        // wrist where it started.
        const rollForearm = (angle) => {
          _foreTurn.copy(liveChain.of(bones[names.forearm]).quaternion)
            .multiply(_twistTurn.copy(restFore.orientation).invert())
            .multiply(_twistTurn.setFromAxisAngle(restFore.axis, angle))
          setRotation(names.forearm, _foreTurn)
          // ...and the hand is written *again* here, keeping the world turn it
          // already had. This is the whole of why the roll does anything: a
          // bone's world orientation is written through its parent's, so a hand
          // that is only written once rolls *with* the forearm and its own turn
          // off it — which is what the reading is — does not change at all.
          // Measured, the reading came back identical before and after every
          // roll until this line was added: the forearm turned, the joint did
          // not.
          setRotation(names.hand, _handTurn)
        }
        let twist = wristTwist()
        let taken = 0
        let after = twist
        if (Math.abs(twist) > WRIST_TWIST_MAX + 1e-6) {
          // The correction the reading asks for is the gap between it and the
          // limit, taken off in the direction the roll moves it: read this way
          // — world to world, about the forearm's live axis — a roll of the
          // forearm about its own bone turns the reading by exactly the angle
          // rolled, so one correction lands the joint on the limit.
          const excess = twist - THREE.MathUtils.clamp(twist, -WRIST_TWIST_MAX, WRIST_TWIST_MAX)
          rollForearm(excess)
          taken = excess
          after = wristTwist()
          if (Math.abs(after) > Math.abs(twist) - 1e-6) {
            // It read the other way round after all: take the whole correction
            // back the other way and read it again.
            rollForearm(-2 * excess)
            taken = -excess
          } else if (Math.abs(after) > WRIST_TWIST_MAX + 1e-3) {
            // A hair left over: the remainder goes on too.
            const rest = THREE.MathUtils.clamp(after, -WRIST_TWIST_MAX, WRIST_TWIST_MAX) - after
            rollForearm(rest)
            taken += rest
          }
        }
        setRotation(names.hand, _handTurn)
        const twistLeft = wristTwist()
        // The bend, re-read after the hand's own turn is written: the pass loop
        // measures what the pass before it left, so its own last reading is one
        // write behind — and a write can be a whole roll.
        _handAim.copy(liveChain.of(bones[names.fingers]).position)
          .sub(liveChain.of(bones[names.hand]).position).normalize()
        _foreAim.copy(wrist).sub(elbow).normalize()
        const bendLeft = Math.acos(THREE.MathUtils.clamp(_handAim.dot(_foreAim), -1, 1))
        debug.arms.push({
          side: arm.side,
          lead: !!arm.lead,
          // Where the fist should close on the handle (rig units), where the
          // wrist that puts it there has to sit, and how far the shoulder had to
          // reach against the arm's own length.
          target: [...arm.grip],
          // Back in the frame the targets are authored in: the model's own frame
          // has the body's placement taken out of it (see toModelPoint), so the
          // placement goes back on here rather than being read as a fifth of a
          // rig unit of error by every test that checks the solve reached.
          wrist: toRigVector(wrist).add(_v3.set(placement[0], placement[1], placement[2])).toArray(),
          reach: span / unitLength,
          required: shoulder.distanceTo(wrist) / unitLength,
          // What the arm would have had to span if the clavicle had stayed at
          // rest, how far the clavicle itself swung, and how much the arm was
          // stretched to cover what the clavicle could not.
          requiredAtRest: shoulderReach.atRest / unitLength,
          shoulderTurn: shoulderReach.amount,
          shoulderSwing: shoulderReach.swing,
          stretch,
          // The wrist's own two limits, as the solve left them: how far the hand
          // is bent off the forearm and how far it is rolled about it, the roll
          // the fist was given about the barrel to hold the bend, and the roll
          // the forearm took off the hand. `wristTwist` is what the wrist itself
          // is left with, which is the bound the suite asserts; `bendFloor` is as
          // deep as any roll could have taken the bend at the elbow the solve
          // settled on, which is what tells a limit the solve kept from one the
          // arm's own reach could not.
          wristBend: bendLeft,
          bendPosed: posedBend,
          bendFloor,
          // The two angles the bend's own floor is made of, at the arm the solve
          // settled on: how far the hand's own direction is off the barrel, and
          // how far the forearm is (the bend bottoms out at the gap between the
          // two, so a forearm that lies along the barrel is a wrist no roll can
          // straighten).
          handCone: cone,
          foreLean: lean,
          wristTwist: twistLeft,
          twistRaw: twist,
          twistAfter: after,
          // The hand's and the forearm's own turns, off the chain, at the moment
          // the solve left them: what the reading above is taken from.
          twists: [
            liveChain.of(bones[names.forearm]).quaternion.toArray(),
            liveChain.of(bones[names.hand]).quaternion.toArray(),
          ],
          wristAxis: _foreAim.toArray(),
          wristRoll: roll,
          wristRollRule: rollSettled,
          // The fist's own roll, at the re-authored reference: the alignment the
          // pose's own roll was asked for, the share of it the arm's reach could
          // hold, and the bend the pose's own roll leaves before the rules touch
          // it — the number the re-authoring is worth on its own.
          fistAlign: foreAlign,
          fistShare: foreShare,
          fistBend,
          forearmRoll: taken,
          steps,
          // The whole forearm against the bat's plane, both of its ends read the
          // driver's own way: the elbow's side (the rule above), the wrist's own
          // (the roll's rule), and the deepest side either of them could reach —
          // the elbow's by its circle, the wrist's by the fist's reach turned on
          // any roll at all.
          // Does the chain land where it was aimed? The wrist target is what the
          // palm's own place on the handle is bought with (`wrist = grip - reach`),
          // the elbow is where the model's circle put it, and the two bone lengths
          // are the arm the IK reasons about — so a palm adrift is one of these
          // four numbers adrift, and which one says whose fault it is.
          handMiss: liveChain.of(bones[names.hand]).position.distanceTo(wrist) / unitLength,
          elbowMiss: liveChain.of(bones[names.forearm]).position.distanceTo(elbow) / unitLength,
          // Split the elbow's own error into the two halves a two-bone solve has:
          // how far it sits from the shoulder against the upper bone's length, and
          // from the wrist against the forearm's.
          elbowFromShoulder: liveChain.of(bones[names.forearm]).position.distanceTo(shoulder)
            / (len(metrics.arm.upper) * stretch),
          aimGap: THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(
            _v1.copy(liveChain.of(bones[names.forearm]).position).sub(shoulder).normalize()
              .dot(_v2.copy(elbow).sub(shoulder).normalize()), -1, 1))),
          elbowFromWrist: liveChain.of(bones[names.forearm]).position.distanceTo(wrist)
            / (len(metrics.arm.fore) * stretch),
          elbowCircle: (liveChain.of(bones[names.forearm]).position.distanceTo(circle.centre)
            - circle.radius) / unitLength,
          foreRatio: liveChain.of(bones[names.hand]).position
            .distanceTo(liveChain.of(bones[names.forearm]).position)
            / (len(metrics.arm.fore) * stretch),
          upperRatio: liveChain.of(bones[names.forearm]).position
            .distanceTo(liveChain.of(bones[names.upperArm]).position)
            / (len(metrics.arm.upper) * stretch),
          elbowOverPlane: _elbowPosed.dot(normal) - handleOverPlane,
          elbowDeepest: deepest,
          elbowMoved: moved,
          wristOverPlane: wrist.dot(normal) - handleOverPlane,
          wristDeepest: -reachDepth,
          // ...and the same reading for the turn this fist *has*: the deepest any roll
          // inside its own window could put that wrist (see `_rollWindowDeepest`).
          wristWindowDeepest: rollWanted.windowDeepest,
          wristPlaneIdeal: THREE.MathUtils.radToDeg(rollWanted.planeIdeal),
          wristPlaneHalf: THREE.MathUtils.radToDeg(rollWanted.planeHalf),
          wristBendIdeal: THREE.MathUtils.radToDeg(rollWanted.bendIdeal),
          wristBendHalf: THREE.MathUtils.radToDeg(rollWanted.bendHalf),
          gripRollMax: THREE.MathUtils.radToDeg(GRIP_ROLL_MAX),
          planeMargin,
        })
        // ...and the fingers and the thumb close on it (see FINGER_CURL). The
        // fold is a turn about the handle through the knuckle, written the way
        // the relative helper wants it: as an axis in the rest pose's own terms,
        // so the fingers turn on their own joint instead of swinging about the
        // body. Set after the hand, since the fist's frame is what the handle's
        // own direction is stated in.
        _curlAxis.copy(fist.handle).applyQuaternion(restHand.orientation)
        setRelative(
          names.fingers,
          _qCurl.setFromAxisAngle(_curlAxis, curlSign[side] * FINGER_CURL),
        )
        setRelative(
          names.thumb,
          _qCurl.setFromAxisAngle(_curlAxis, curlSign[side] * THUMB_CURL),
        )
      }
    },
  }

  // The last frame's joint solves, kept on the model: a small window into the
  // driver for tests and for debugging a pose in the browser.
  // Where this model's own uniform puts its waistband, read off its base-color
  // texture before anything is cut: everything below is taken at that height.
  const waistband = measureWaistband(modelRoot, metrics)
  debug.waistBand = { ...waistband, contour: null }
  // The reshaped skin: the bands it was cut into, the worst residual any part's
  // own skin still carries of another part, and where the twist now reads.
  const parts = shapeRigidParts(modelRoot, metrics, waistband)
  debug.parts = parts
  debug.waistBand.contour = parts.contour
  // The belt cut open, and the sleeve hidden under it: the numbers the tests
  // read back (how tall the cut's own faces are, and how many vertices each
  // added).
  debug.sleeve = cutBeltAndSleeve(modelRoot, metrics, waistband)
  modelRoot.userData.playerRig = debug
  return driver
}
