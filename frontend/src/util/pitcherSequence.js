import { clamp } from './MathUtil.js'

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

/**
 * How far the body folds forward at the release, by how high the pitch is
 * released: a deep fold at the bottom of the slot range, a nearly upright torso
 * at the top.
 */
export function releaseLean(height) {
  const share = clamp((height - SLOT_LOW_M) / (SLOT_HIGH_M - SLOT_LOW_M), 0, 1)
  return LEAN_LOW + (LEAN_HIGH - LEAN_LOW) * share
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
 * @returns {{x: number, y: number, z: number, aim: number[], lean: number,
 *   height: number}} the ball's place, the hand's own line there, the lean the
 *   body holds at the release, and the height the pose could actually hold (an
 *   arm has only so much lift in it: past that the body's placement covers the
 *   difference, see Pitcher.jsx)
 */
export function pitcherRelease({ rig, hand = 'R', height, hipY = 0, drive = 0 }) {
  const s = hand === 'L' ? -1 : 1
  const carry = releaseCarry(rig, hand)
  // The arm hangs from a *clavicle*: the socket the driver solves from rides a
  // centimetre or so on the chest's own, inboard of the line the model measures the
  // span along, so the anchor carries that much less reach than the bones alone. What
  // it buys is the last centimetre of the release: without it the pose asks for the
  // release point from an arm at full stretch and the drawn ball lands five
  // millimetres short of the point the pitch is thrown from.
  const CLAVICLE_SLACK = 0.01
  const reach = rig.arm.upper + rig.arm.fore + carry - CLAVICLE_SLACK
  const lean = releaseLean(height)
  // The shoulder the anchor hangs off is the *delivery's* own: the chest leaned at
  // the plate by the slot's lean and turned by the yaw the release key holds, which
  // is the same rotation the driver realises the trunk with (see trunkLean). A
  // shoulder modelled as a fold alone — the way this read while the trunk's lean was
  // the body's own — is a centimetre or two out once the body is a quarter of the way
  // round, and the release point is where a centimetre is the pitch's.
  const key = KEYS[TIMES.indexOf(AUTHORED_RELEASE_TIME)]
  // The keys are authored for the right hand, so a lefty's anchor comes off the
  // mirrored body — the same rule the pose's own frame follows (see pitcherPose).
  const trunk = trunkLean(s * key.chestYaw, lean, s * key.leanSide)
  const turn = upperTurn(s * key.chestYaw, -trunk.leanX, -trunk.leanZ)
  const turned = turnVector(turn, [
    0,
    rig.shoulder.y - rig.hip.y,
    rig.shoulder.z - rig.hip.z,
  ])
  const shoulder = {
    x: turned[0],
    y: rig.hip.y + turned[1] + hipY,
    z: rig.hip.z + turned[2] - drive,
  }
  // The ball leaves just off the arm's own socket, which is half a shoulder's width
  // along the body's shoulder line — *that* line, not the rig's: a body a quarter of
  // the way round carries its shoulders round with it, and an anchor pinned to the
  // rig's lateral axis would leave the hand a hand's width out to the side.
  const socket = turnVector(turn, [s * rig.shoulder.halfWidth, 0, 0])
  const held = clamp(height, rig.shoulder.y * 0.78, shoulder.y + reach * 0.94)
  // How much of the arm's own span the vertical gap takes, and the rest of the
  // line going forward at the plate.
  const up = clamp((held - shoulder.y) / reach, -0.75, 0.86)
  const ahead = Math.sqrt(Math.max(1e-6, 1 - up * up))
  const armX = shoulder.x + socket[0]
  const x = armX + s * rig.shoulder.halfWidth * 0.05
  const y = held
  const z = shoulder.z - reach * ahead
  const aim = [x - armX, y - shoulder.y, z - shoulder.z]
  const length = Math.hypot(aim[0], aim[1], aim[2]) || 1
  return {
    x,
    y,
    z,
    aim: [aim[0] / length, aim[1] / length, aim[2] / length],
    lean,
    height: held,
  }
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
    t: 0.34,
    clasp: true,
    hipYaw: -1.605, chestYaw: -1.625, lean: 0.13, leanSide: 0.015, hipY: -0.06, drive: -0.055,
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
    t: 0.58,
    clasp: true,
    hipYaw: -1.760, chestYaw: -1.820, lean: 0.09, leanSide: 0.035, hipY: -0.015, drive: -0.095,
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
    t: 0.80,
    clasp: true,
    hipYaw: -2.090, chestYaw: -2.170, lean: 0.05, leanSide: 0.060, hipY: -0.025, drive: -0.135,
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
    // eleven centimetres of ground toward the plate. Read as a list of joints a
    // delivery is a stand-up, a coil and an uncoil; read as a *body* it is the weight
    // leaving the back foot first and the turn arriving after the fall, and this key
    // is that order written down: the pelvis has turned 2° since the balance and
    // travelled 11 cm, and by the break it is 35° and 30 cm.
    //
    // The knee's own cock is what the fall leaves longest: the leg is up and pointed
    // where the coil pointed it (``cock`` carries the wound angle it held at the
    // balance, and the chest it is read against has not moved either), so the kicking
    // leg's unwind, the step out of it and the arms' break all still wait on the
    // break below — which is what "the ball is thrown by the body that has already
    // fallen" looks like from the outside.
    t: 0.92,
    clasp: true,
    hipYaw: -2.070, chestYaw: -2.150, lean: 0.06, leanSide: 0.050, hipY: -0.045, drive: -0.060,
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
    // is spent in the twelfth of a second between the fall and here: the pivot shoe
    // comes round 44° while the pelvis turns 35° and the chest 31°, so the order the
    // turn runs in is the hip, then the body, then the shoulders — and across the step
    // out that follows the pelvis passes the shoe up (54° of it to the shoe's 44° by
    // the plant), which is the hip handing the turn over rather than trailing it.
    //
    // The turn's own *rate* is what this key is shaped for, and it is the one number
    // of the break that is authored against the release: the unwind gathers speed
    // from the fall to the release and never spends it early. Taken quickly — the
    // body already most of the way round by here — a delivery snaps round at the
    // break, stalls behind the plant and snaps again into the release: one that turns
    // in two pieces rather than in one, with its fastest frame of spin a quarter of a
    // second *before* the ball goes (which is what an earlier authoring of this key
    // did). Read across the break, the plant, the high cock and the coming-through
    // key, the chest's own turn is a ramp of 308, 354, 407 and 448°/s into the
    // release's own 466 (see the browser suite's reading of the three speeds the
    // delivery makes, which is where that promise is held). The coil goes with it
    // rather than jumping: the chest sits 5° under the pelvis at the balance, 9° at
    // the break and 26° at the plant — trailing further as the drive hands the turn
    // up the chain — and then 17° at the high cock and 8° at the release as the
    // shoulders come round last.
    //
    // What the turn does *not* carry is the fold. The trunk comes over the hips in
    // the last fraction of a second before the ball goes and not before it: the
    // body turns its way through the stride standing nearly as upright as it stood
    // in the set, and the fold is what the release is *made* of rather than
    // something carried into it from the plant. This key is where the lean begins,
    // and it begins gently: a tenth of a radian here against the release's half,
    // with the plant and the high cock the two steps between — half a radian a
    // second across the break, one and a sixth into the cock, two and a third over
    // the come-through and the release's own last two hundredths six and a half (see
    // the browser suite's reading of the lean's *speed*, which is the fastest of the
    // delivery on the release frame).
    t: 1.00,
    hipYaw: -1.580, chestYaw: -1.750, lean: 0.08, leanSide: 0.02, hipY: -0.08, drive: 0.040,
    headPitch: 0.04,
    pivot: { x: 0.118, lift: 0, z: 0.200, yaw: -0.900, bend: 0.26, hang: 0 },
    // The lift is the *knee's* own height while the leg is carried (see the pose
    // assembly's ``hang``): a carried foot hangs its shin plumb from the knee, so the
    // height a kick's foot rides at is set by how high the knee goes, and the knee
    // has to go higher as the hips drop under it — a leg left at the kick's own
    // number would hang its foot into the dirt by the reach.
    front: { x: -0.166, lift: 0.60, z: -0.180, yaw: 0.0, bend: 0.16, hang: 1, cock: 0.10 },
    ball: [0.26, 0.94, 0.18], aim: [0.30, -0.80, 0.52], curl: 1.4,
    elbow: [0.32, 1.18, 0.10],
    glove: [0.130, -0.110, -0.400], gloveAim: [0.0, -0.70, -0.71], gloveCurl: 0.8,
    gloveElbow: [-0.26, 0.16, -0.18],
    glovePalm: [0.06, -0.14, -0.99],
  },
  {
    // The reach: the front leg is thrown out to the length of its stride — the foot
    // over the place it is going to land on — and the throwing arm swings up past the
    // shoulder on its way to the cock. The pelvis is already square while the chest is
    // still closed and turning: the body's turn runs up the chain, and the shoulders
    // are the last thing before the arm.
    //
    // The foot is *out* but not down: the stride's own end is the plant, and the plant
    // waits for the ball (see the front leg's note). What the reach is, then, is the
    // leg at the length it will land at with the shoe still a hand's width up and
    // coming down: the delivery stands on the drive leg alone from the break to just
    // past the release, and the stride is the front leg's own *reach* — out and under
    // the body that is turning over it — rather than something the weight arrives on.
    //
    // The fold holds off: the trunk is still nearly upright here — under a sixth
    // of a radian over the hips, and the whole of what the stride has leaned it
    // by — because what the reach is is the body's turn and its travel (see the
    // break's own note above, and the finish below for the other end of it).
    t: 1.12,
    hipYaw: -0.490, chestYaw: -0.980, lean: 0.16, leanSide: 0.0, hipY: -0.20, drive: 0.405,
    headPitch: 0.05,
    pivot: { x: 0.130, lift: 0, z: 0.215, yaw: 0.010, bend: 0.34, hang: 0 },
    front: { x: 0.174, lift: 0.72, z: -0.610, yaw: 0.500, bend: 0.30, hang: 1, cock: 0.25 },
    ball: [0.32, 1.15, 0.06], aim: [0.24, 0.30, 0.92], curl: 1.3,
    elbow: [0.38, 1.25, 0.00],
    glove: [0.010, -0.170, -0.495], gloveAim: [-0.20, -0.88, -0.43], gloveCurl: 0.3,
    gloveElbow: [-0.30, -0.05, -0.30],
    glovePalm: [0.10, -0.16, -0.98],
  },
  {
    // The high cock: the arm at the top of the cock (up and behind the shoulder),
    // the glove tucked to the chest — and the shoulders *over the plate already*,
    // with the pelvis a good way past them. This is the hand-off the delivery's
    // momentum is: by the time the arm starts down and through, the body it is
    // thrown by is facing the target, so what unwinds from here is the arm and not
    // the turn. From here to the follow-through the arm is authored from the
    // release point.
    // And the fold is only half spent here: the trunk comes over the hips across
    // the two frames between this key and the release, so the body the arm unwinds
    // off is still standing tall with the shoulders over the plate.
    t: 1.24,
    release: true, slot: 1,
    hipYaw: 0.150, chestYaw: -0.220, lean: 0.28, leanSide: 0.0, hipY: -0.26, drive: 0.710,
    headPitch: 0.06,
    pivot: { x: 0.150, lift: 0.05, z: 0.050, yaw: 0.050, bend: 0.28, hang: 0 },
    // The foot has reached the place it will land on and is on its way down: the
    // release is a hand's width above the dirt for it (see the plant below).
    front: { x: 0.000, lift: 0.22, z: -0.880, yaw: -0.120, bend: 0.36, hang: 0, cock: 0 },
    // The cock's own ball is *above and behind the shoulder*, which is what a
    // cocked arm holds: written off the release, that is well below it and well
    // back along it, not a hand's width higher than the release itself.
    ball: [-0.03, -0.14, 0.80], aim: [0.10, 0.58, 0.81], curl: 1.0,
    elbow: [0.45, 0.22, 0.72],
    glove: [-0.190, -0.260, -0.420], gloveAim: [-0.40, -0.85, -0.34], gloveCurl: 0.3,
    gloveElbow: [-0.32, -0.08, -0.24],
    glovePalm: [0.14, -0.20, -0.97],
  },
  {
    // Coming through: the chest unwinds, the arm comes over the top, and the hand
    // is nearly on the ball's own line.
    t: 1.30,
    release: true, slot: 1,
    hipYaw: 0.460, chestYaw: 0.240, lean: 0.41, leanSide: 0.0, hipY: -0.17, drive: 0.915,
    headPitch: 0.08,
    pivot: { x: 0.175, lift: 0.06, z: -0.280, yaw: 0.060, bend: 0.24, hang: 0 },
    front: { x: 0.000, lift: 0.17, z: -0.940, yaw: -0.460, bend: 0.30, hang: 0, cock: 0 },
    ball: [0.03, 0.05, 0.30], aim: [0.02, 0.02, -0.99], curl: 0.9,
    elbow: [0.35, -0.03, 0.44],
    glove: [-0.250, -0.280, -0.400], gloveAim: [-0.30, -0.87, -0.39], gloveCurl: 0.3,
    gloveElbow: [-0.34, -0.10, -0.20],
    glovePalm: [0.15, -0.25, -0.96],
  },
  {
    // The release frame itself: the hand is on the ball's own place and the
    // fingers are opening off it.
    t: AUTHORED_RELEASE_TIME,
    release: true, slot: 1,
    hipYaw: 0.62, chestYaw: 0.48, lean: AUTHORED_RELEASE_LEAN, leanSide: 0.0, hipY: -0.14, drive: 1.00,
    headPitch: 0.10,
    pivot: { x: 0.200, lift: 0.07, z: -0.360, yaw: 0.090, bend: 0.20, hang: 0 },
    front: { x: 0.000, lift: 0.155, z: -0.940, yaw: -0.600, bend: 0.28, hang: 0, cock: 0 },
    ball: [0.0, 0.0, 0.0], aim: [0.03, -0.07, -0.996], curl: 0.6,
    elbow: [0.30, -0.28, 0.34],
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
    hipYaw: 0.86, chestYaw: 1.10, lean: 0.44, leanSide: 0.0, hipY: -0.15, drive: 1.175,
    headPitch: 0.16,
    // The drive leg is *thrown* out from under the body rather than left behind: the
    // shoe is off the plate's own line and a good hand's width up, and the leg has
    // begun to swing round on the hip that has outrun it — the arc the next three
    // keys draw. The lift is where the swing's own width comes from (see the swing's
    // widest frame below).
    pivot: { x: 0.826, lift: 0.27, z: -1.135, yaw: 0.200, bend: 0.13, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.860, bend: 0.26, hang: 0, cock: 0 },
    ball: [-0.36, -0.45, -0.21], aim: [-0.58, -0.70, -0.42], curl: 0.4,
    elbow: [-0.18, -0.26, 0.20],
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
    hipYaw: 0.95, chestYaw: 1.350, lean: 0.37, leanSide: 0.0,    hipY: -0.13, drive: 1.255,
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
    pivot: { x: 0.596, lift: 0.29, z: -1.793, yaw: 0.550, bend: 0.11, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -0.950, bend: 0.25, hang: 0, cock: 0 },
    ball: [-0.59, -0.77, -0.21], aim: [-0.48, -0.75, -0.44], curl: 0.35,
    elbow: [-0.14, -0.34, 0.13],
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
    hipYaw: 1.01, chestYaw: 1.550, lean: 0.32, leanSide: 0.0,    hipY: -0.13, drive: 1.34,
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
    pivot: { x: 0.034, lift: 0.30, z: -2.149, yaw: 0.900, bend: 0.10, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.010, bend: 0.24, hang: 0, cock: 0 },
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
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.023125, bend: 0.23425, hang: 0, cock: 0 },
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
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.03625, bend: 0.2285, hang: 0, cock: 0 },
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
    // here the foot carries *in* as it comes down (see the middles below).
    pivot: { x: -0.536, lift: 0.301, z: -1.760, yaw: 1.750, bend: 0.14, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.171, bend: 0.217, hang: 0, cock: 0 },
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
    pivot: { x: -0.516, lift: 0.255, z: -1.720, yaw: 2.050, bend: 0.16, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.238, bend: 0.21275, hang: 0, cock: 0 },
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
    pivot: { x: -0.471, lift: 0.214, z: -1.700, yaw: 2.350, bend: 0.18, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.305, bend: 0.2085, hang: 0, cock: 0 },
    ball: [-0.3368, 0.8224, -1.6460], aim: [-0.4136, -0.8336, -0.3592], curl: 0.2160,
    elbow: [-0.2536, 0.5656, -1.9197],
    glove: [-0.2555, -0.5195, -0.272], gloveAim: [-0.3875, -0.428, -0.8135], gloveCurl: 0.283,
    gloveElbow: [-0.305, -0.195, -0.105],
    glovePalm: [0.261, -0.7405, -0.6075],
  },
  {
    // The arc's own last step before the foot is down: it is a third of a rig unit out
    // to the glove side of the body's own line and nearly on the ground, the shoe's line
    // a quarter turn past the plate's, and the leg — held at its own length the whole
    // way round — coming down on the place it lands on, which from here is the whole of
    // the rest of its travel: the last fifth of a second of it is spent carrying the
    // foot back in *under* the body while the shoe goes on round with the shin (see the
    // landing's own note). The same middle key, one more time (see the two above).
    //
    // Every other track is the frame's own place between its neighbours.
    t: 1.6625,
    slot: 0.125,
    hipYaw: 1.373, chestYaw: 1.805, lean: 0.092, leanSide: 0.0, hipY: -0.035, drive: 1.338,
    headPitch: 0.105,
    pivot: { x: -0.300, lift: 0.107, z: -1.578, yaw: 2.700, bend: 0.20, hang: 0 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.373, bend: 0.20425, hang: 0, cock: 0 },
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
    // release's and it only ever slows after it (466°/s on the ball, 300 by 1.4, 200 by
    // 1.48, 130 by 1.64 and 70 on this frame), so the last of it is *spent* arriving
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
    // to travel on to reach) while coming back *across* toward the body's own line: an
    // eighth of a rig unit to the glove side of it (0.130), against the two fifths the
    // swing set it down at before. The two numbers are one decision, and it is the
    // *finish's* own: two feet 0.53 of a unit apart put the weight between them, where a
    // trail foot left at the end of the swing's own arc (0.60) leaves the hips' shadow
    // sitting over *it* — a body leaning on its back foot rather than standing between
    // the two of them. Read off the realised skeleton, the pelvis' own line stands 0.20
    // of a unit short of this foot's ankle and 0.32 past the front one's — between the
    // two of them either way, and 0.06 of a unit *past* their own midpoint, which is the
    // weight a touch on the lead leg rather than behind the middle of the stance, and it
    // is the same number at the hold to the thousandth. So the
    // weight the finish stands on is *between* the
    // legs rather than over the trail foot the swing threw out to the side. That is what
    // a body dragged round by its own turn does with its back leg — the leg is
    // carried *through* by the same momentum the chest is, and the hips go on forward
    // over it rather than stopping at the plant they made earlier (see the finish's
    // own note above, and ``drive``). Where it lands is where the weight arrives, and
    // where the weight arrives is where the delivery ends: the frame this foot lands in
    // is the frame he is left standing in, with nothing to settle onto it and nothing to
    // stand up out of (see the hold below).
    pivot: { x: -0.130, lift: 0, z: -1.455, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    glovePalm: [0.20, -0.70, -0.68],
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.440, bend: 0.45, hang: 0, cock: 0, flat: 1 },
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
    // turn and the fold are spent with the travel (the chest is 104° round on the
    // plate's line and the trunk three degrees off upright by the landing — see the two
    // keys above), so nothing is left to ease. Held to the frame rather than eased: a
    // pose that drifted across the second would be a pitcher swaying in the hold, and
    // what a hold is is a *stop*.
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
    pivot: { x: -0.130, lift: 0, z: -1.455, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.440, bend: 0.45, hang: 0, cock: 0, flat: 1 },
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
    pivot: { x: -0.130, lift: 0, z: -1.455, yaw: 2.900, bend: 0.50, hang: 0, flat: 1 },
    front: { x: 0.000, lift: 0, z: -0.940, yaw: -1.440, bend: 0.45, hang: 0, cock: 0, flat: 1 },
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
// (0.92) has the weight going forward with the coil still held and the pelvis' own travel
// still *behind* it (-0.02); the break (1.00) is the front leg driving out with 0.17 of that
// travel spent. The hip crosses its own nought between the two, and that is the frame the
// drive starts on. The look is *finished* by then (see LOOK_SETTLE), and the two moments are
// exported together because the promise is the pair of them: the eyes are on the zone before
// the legs take the body anywhere.
export const AUTHORED_DRIVE_TIME = 0.93
// ...and how long the eyes take to come onto the zone: the whole of the turn the head has to
// make, which is a right angle off the stance's own line. 0.31 of a second for 90° is 290 a
// second, against the 466 the body turns at its fastest frame — and it is the unwind's own
// 0.32 read the other way round, the look taking as long to come on as it takes to come off.
const LOOK_TAKEUP = 0.31
// ...and where it *lands*, which is what the take-up is measured back from: on the zone, and
// finished before the drive leg fires — a look is picked up before the legs take the body
// anywhere, and what stays quiet through the drive is the head, not the body. A settled
// thirteenth of a second buys that (0.80 against the drive's 0.93), and it puts the lock on
// the balance point, the key where the coil is deepest and the knee at its highest: the eyes
// are on the target from there through the fall, the drive, the break and the throw.
const LOOK_SETTLE = 0.13
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
function chestFrameAt(rig, key) {
  const trunk = trunkLean(key.chestYaw, key.lean, key.leanSide)
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
function claspTracks(rig) {
  const carry = releaseCarry(rig, 'R')
  const halfWidth = rig.shoulder.halfWidth
  for (let i = 0; i < KEYS.length; i += 1) {
    if (!CLASP_KEYS[i]) continue
    const key = KEYS[i]
    const { turn, centre } = chestFrameAt(rig, key)
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
function mirrorTracks(rig) {
  const halfWidth = rig.shoulder.halfWidth
  for (let i = 0; i < KEYS.length; i += 1) {
    if (!MIRROR_TRACK[i]) continue
    const { turn, centre } = chestFrameAt(rig, KEYS[i])
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
function trackRelease(values, release, s, t, out) {
  _releaseAt[0] = release.x
  _releaseAt[1] = release.y
  _releaseAt[2] = release.z
  for (let axis = 0; axis < 3; axis += 1) {
    // The keys are authored for a right-hander, so the lateral axis is mirrored
    // for a lefty. The *anchor* is already the hand's own (pitcherRelease mirrors
    // it), so this is the authored part of the track and nothing else.
    const hand = axis === 0 ? s : 1
    for (let i = 0; i < KEYS.length; i += 1) {
      _axis[i] = hand * values[i][axis] + (RELEASE_KEYS[i] ? _releaseAt[axis] : 0)
    }
    out[axis] = trackAt(_axis, TIMES, t)
  }
  return out
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
 * @param {number} [ctx.idle] the idle showing under the delivery: ``breathe``
 *   (a -1..1 wave) and ``fade`` (its strength)
 * @returns {object} the driver's pose, plus ``ball``: where the ball is this
 *   frame, in the rig frame
 */
export function pitcherPose(t, ctx) {
  const {
    rig,
    hand = 'R',
    height = null,
    releaseTime = AUTHORED_RELEASE_TIME,
    idle = null,
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
    ...RELEASE_HIPS,
  })

  const at = {}
  for (const track of NUMBER_TRACKS) at[track.key] = trackAt(track.values, TIMES, authored)
  // The pitch's own slot, applied to the release-window lean: the keys author the
  // delivery for AUTHORED_RELEASE_HEIGHT, and a pitch released elsewhere leans by
  // the difference (see SLOT_TRACK).
  const slot = trackAt(SLOT_TRACK, TIMES, authored)
  let lean = at.lean + slot * (release.lean - releaseLean(AUTHORED_RELEASE_HEIGHT))
  // ...and the share of the chest's own turn the head takes off its look (see
  // LOOK_PIN, which is read on its own clock).
  const look = trackAt(LOOK_TRACK, LOOK_TIMES, authored)
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
  // The clasp's own two tracks (see claspTracks), and the trail arm's own mirror of
  // the lead arm's elbow (see mirrorTracks), are written before they are read: they
  // are places in the rig frame like every other target, and the rig is what turns
  // them.
  if (HAS_CLASP) claspTracks(rig)
  mirrorTracks(rig)
  trackRelease(BALL_TRACK, release, s, authored, _ball)
  trackRelease(ELBOW_TRACK, release, s, authored, _elbow)

  // The idle's own breath, under the delivery: it fades out as the windup takes
  // over rather than being switched off, so a pitcher waiting on the rubber is
  // moving in the same joint targets the delivery moves.
  if (idle && idle.fade > 0) {
    const w = idle.breathe * idle.fade
    at.hipY += 0.012 * w
    lean += 0.02 * w
    at.leanSide += 0.012 * w
    at.headPitch += 0.02 * w
  }

  const carry = releaseCarry(rig, hand)
  const aim = normalize(at.aim, s)
  const gloveAim = normalize(at.gloveAim, s)
  // The glove's palm, as the direction it faces rather than the line the hand runs
  // along: the one turn of a hand a place and a line leave free, and the one the
  // delivery is read by (see the keys' own ``glovePalm``).
  const glovePalm = normalize(at.glovePalm, s)
  const ball = [_ball[0], _ball[1], _ball[2]]

  // The elbows are authored, like the ball, as *places* in the rig frame (see the
  // driver's open-arm solve: a pole reads only the direction from the shoulder to
  // it). The glove is held in front of the chest, so its own pole is written in the
  // chest's frame and measured off *its* socket — a pole is only a direction from
  // the socket the arm hangs from, and one measured off the other arm's would send
  // the glove's elbow across the chest. Both the frame and the socket are read off
  // the pose: the chest's turn, and the centre of the two sockets (the leaned
  // shoulder, moved by the pelvis' own height and its drive).
  const trunk = trunkLean(s * at.chestYaw, lean, s * at.leanSide)
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
  chestAt[1] += rig.hip.y + at.hipY
  chestAt[2] += rig.hip.z - at.drive
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
        s * spec.x + bend.x * spec.bend,
        // A carried leg's knee is asked for by its own height — the lift is the
        // kick's, so it reads up the leg's own line — and a standing one's by the
        // knee's own travel, which is what the driver reads it for: a shape, not a
        // place. The height is the same ``rise`` the direction above is built from,
        // so the line the solve is pointed at and the line it is handed as a place
        // are the same line wherever the bend's own push is the thigh's own length.
        rig.hip.y + rise,
        spec.z + bend.z * spec.bend,
      ],
      ankle: [s * spec.x, rig.ankleY + spec.lift, spec.z],
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

  return {
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
      fold: lean,
      foldSide: s * at.leanSide,
      rock: 0,
      offsetY: at.hipY,
      offsetZ: -at.drive,
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
    legs: [leg(s, foot.pivot, 'stance'), leg(-s, foot.front, 'body')],
    arms: [
      {
        side: s,
        // The ball is where the pose says it is; the wrist that puts the palm
        // there is less the carry down the hand's own line.
        hand: [
          ball[0] - aim[0] * carry,
          ball[1] - aim[1] * carry,
          ball[2] - aim[2] * carry,
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
        curl: at.curl,
        // ...and the same *palm*: the hand the ball is in is on the same side of it
        // as the glove's own palm is, which is the whole of the roll the model's own
        // hand has to turn through to sit inside the mitt (151°, measured) — asked
        // for as the clasp's own share of that turn, so the grip eases out of it as
        // the break opens the hands rather than snapping the hand round in the frame
        // the ask left (see ``palmMix`` in the driver).
        palm: glovePalm,
        palmMix: clasped,
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
