import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTHORED_CLIP_END,
  AUTHORED_DRIVE_TIME,
  AUTHORED_LOOK_LOCK_TIME,
  AUTHORED_LOOK_SWEEP_TIME,
  AUTHORED_RELEASE_HEIGHT,
  AUTHORED_HANDOFF_TIME,
  AUTHORED_RELEASE_TIME,
  AUTHORED_ZONE_TIME,
  blendPose,
  headTrackShare,
  pitcherIdle,
  pitcherPose,
  pitcherRelease,
  releaseCarry,
  releaseLean,
  turnVector,
  upperTurn,
} from '../src/util/pitcherSequence.js'

// The pitcher's own frame: the rest skeleton public/models/player.glb carries in
// its skin's inverse bind matrices, as measurePlayerRig reads it, with one rig unit
// being one metre. Pitcher.jsx measures the same numbers at load — these are the
// model's, not a tuned stand-in — so the invariants below are the ones the delivery
// has to hold on the model that plays it.
//
// The frame is the rig's (see the driver's header): the body faces -Z, +X is the
// throwing side, y is the ground up. The sequence is a pure function of this rig,
// so every fact about the delivery is checkable here without a renderer.
const RIG = {
  unitScale: 1,
  hip: { y: 0.9358, halfWidth: 0.1103, z: 0.1113 },
  shoulder: { y: 1.4434, halfWidth: 0.2229, z: 0.0906 },
  arm: { upper: 0.3145, fore: 0.2855, hand: 0.1440 },
  palm: { L: 0.1151, R: 0.1151 },
  leg: { thigh: 0.4278, shin: 0.4228 },
  ankleY: 0.0852,
  neckY: 1.5232,
  headY: 1.6463,
}

// The slots a staff spans: a low three-quarters, the delivery's own reference, and
// the very top of what the pitch data itself carries (Statcast's own release
// heights run to about 6.5 ft), where the arm is at the end of its reach.
const HEIGHTS = [1.35, 1.5, AUTHORED_RELEASE_HEIGHT, 1.85, 1.95, 2.1]
// The slots a real staff's arms are sized for, where the pose is held to the
// model's own proportions outright (see the reach test).
const STOCK_HEIGHTS = HEIGHTS.slice(0, 4)
// What the driver will stretch a bone to (ARM_STRETCH_MAX in playerRig.js): the
// budget the pose may borrow anywhere except at the release itself.
const STRETCH_MAX = 1.25
const TIMES = [
  0, 0.34, 0.58, 0.8, 1.0, 1.12, 1.24, 1.3, AUTHORED_RELEASE_TIME, 1.42, 1.62,
  AUTHORED_ZONE_TIME, 1.9, 2.8, 3.14, AUTHORED_CLIP_END,
]

const ctx = (over = {}) => ({
  rig: RIG,
  hand: 'R',
  height: 1.85,
  releaseTime: AUTHORED_RELEASE_TIME,
  ...over,
})

const show = (v) => `(${v.map((x) => x.toFixed(4)).join(', ')})`
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * The turn the pose's own numbers put the upper body through, as the driver
 * composes it (see `upperTurn`): the chest's yaw is the pelvis' own plus the extra
 * the pose carries, and the folds are the pose's two leans as *amounts* of fold.
 */
function upperTurnOf(pose) {
  return upperTurn(
    pose.hip.yaw + pose.torsoYawExtra,
    -pose.hip.leanX,
    -pose.hip.leanZ,
  )
}

/** The place the pose's own numbers put the upper body's own centre — the midpoint
 * of the two shoulder sockets, which is what a reach is measured from. It is the
 * shoulder's own rest offset from the hip pivot carried by the body's turn, which is
 * what the driver turns the pelvis by (see the sequence's own read of the chest). */
function chestOf(pose) {
  const turned = turnVector(upperTurnOf(pose), [
    0,
    RIG.shoulder.y - RIG.hip.y,
    RIG.shoulder.z - RIG.hip.z,
  ])
  // The hips' own drive is authored forward and written into the pose's z.
  return [
    turned[0],
    RIG.hip.y + turned[1] + pose.hip.offsetY,
    RIG.hip.z + turned[2] + pose.hip.offsetZ,
  ]
}

/**
 * The place the pose's own numbers put one of the shoulders: the socket the arm
 * hangs from, carried off the chest's centre by the body's own turn. The turn is
 * the whole of why a reach has to be measured from a *turned* socket — a body
 * side-on to the plate has its throwing shoulder half a metre around from where a
 * square one would put it.
 */
function shoulderOf(pose, side = 1) {
  const centre = chestOf(pose)
  const socket = turnVector(upperTurnOf(pose), [side * RIG.shoulder.halfWidth, 0, 0])
  socket[0] += centre[0]
  socket[1] += centre[1]
  socket[2] += centre[2]
  return socket
}

/**
 * Where the pose's own head points, in the pose's own sense: level is nought and positive
 * is toward the throwing side, like every other yaw in the file. The head's rest line is the
 * rig's own -z (measured off the realised skeleton), so the neck's two angles are that
 * direction turned by the nod and then the look — the same composition the driver makes of
 * them.
 */
function gazeOf(pose, pitch = pose.head.pitch, yaw = pose.head.yaw) {
  const dir = [-Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw)]
  const out = turnVector(upperTurnOf(pose), dir)
  return {
    elevation: Math.asin(Math.max(-1, Math.min(1, out[1]))) * (180 / Math.PI),
    bearing: Math.atan2(-out[0], -out[2]) * (180 / Math.PI),
  }
}

/** The place the pose's own numbers put a hip socket. */
function hipOf(pose, side = 1) {
  const turn = upperTurn(pose.hip.yaw, -pose.hip.leanX, -pose.hip.leanZ)
  const socket = turnVector(turn, [side * RIG.hip.halfWidth, 0, 0])
  socket[0] += 0
  socket[1] += RIG.hip.y + pose.hip.offsetY
  socket[2] += RIG.hip.z + pose.hip.offsetZ
  return socket
}

/**
 * Where an arm's own place lands, as the *driver* reads it: ``hand`` is a place in
 * the rig frame outright, ``local`` an offset from that arm's own shoulder in the
 * chest's, and an arm that wrote both — which is what a clasped grip is, so that the
 * two hands are read through one frame (see pitcherPose) — means the two mixed by
 * ``mix``. An arm written one way alone means all of it, which is the driver's own
 * rule for an absent ``mix``.
 */
function placeOf(pose, arm) {
  const turn = upperTurnOf(pose)
  const shoulder = shoulderOf(pose, arm.side)
  const local = arm.local
    ? turnVector(turn, arm.local).map((value, axis) => value + shoulder[axis])
    : null
  if (!arm.hand) return local
  if (!local) return arm.hand.slice()
  const k = arm.mix ?? 1
  return arm.hand.map((value, axis) => value * k + local[axis] * (1 - k))
}

/** The same read for the line the hand's own fingers run along. */
function lineOf(pose, arm) {
  const turn = upperTurnOf(pose)
  const local = arm.aimLocal ? turnVector(turn, arm.aimLocal) : null
  const absolute = arm.aim
  let out = null
  if (!absolute) out = local
  else if (!local) out = absolute.slice()
  else {
    const k = arm.hand ? (arm.mix ?? 1) : 0
    out = absolute.map((value, axis) => value * k + local[axis] * (1 - k))
  }
  const length = Math.hypot(out[0], out[1], out[2]) || 1
  return out.map((value) => value / length)
}

/**
 * Where the glove hand the pose authored is: its wrist — the pose writes the glove
 * as an offset from its own socket in the chest's frame — and the palm the driver
 * carries a ball to from there. Read the way the driver reads it, so what this
 * answers is the same place the pose *means*.
 */
function gloveOf(pose) {
  const arm = pose.arms.find((entry) => entry.local && !entry.hand)
  const turn = upperTurnOf(pose)
  const shoulder = shoulderOf(pose, arm.side)
  const wrist = turnVector(turn, arm.local)
  wrist[0] += shoulder[0]
  wrist[1] += shoulder[1]
  wrist[2] += shoulder[2]
  const aim = turnVector(turn, arm.aimLocal)
  const length = Math.hypot(aim[0], aim[1], aim[2]) || 1
  aim[0] /= length
  aim[1] /= length
  aim[2] /= length
  const carry = releaseCarry(RIG, arm.side === 1 ? 'R' : 'L')
  return {
    wrist,
    aim,
    palm: [wrist[0] + aim[0] * carry, wrist[1] + aim[1] * carry, wrist[2] + aim[2] * carry],
  }
}

test('the release frame puts the ball on the release anchor, at every slot', () => {
  // The delivery is authored *about* the release point: the release frame's own
  // ball has to be that point, because Pitcher.jsx places the body so the anchor
  // lands on the trajectory's first sample. If these two disagree the body is
  // placed for one point and throws at another, and the error is the pitch's.
  for (const height of HEIGHTS) {
    const pose = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height }))
    // The anchor, read back through the release frame's own hips (the pose's own
    // drive and pelvis height), which is what the delivery measures it from.
    const anchor = pitcherRelease({
      rig: RIG,
      hand: 'R',
      height,
      hipY: pose.hip.offsetY,
      drive: -pose.hip.offsetZ,
    })
    assert.ok(
      distance(pose.ball, [anchor.x, anchor.y, anchor.z]) < 1e-9,
      `ball ${show(pose.ball)} is not the anchor at height ${height}`,
    )
    // What the pose can *hold*: an arm has only so much lift in it, and past that
    // the anchor is clamped — the placement covers the difference.
    assert.equal(pose.ball[1], anchor.height)
    if (height > pose.ball[1]) {
      // A hair of a clamp is still the clamp: the ceiling is the arm's own span off
      // the *turned* shoulder (see the anchor's own shoulder), which stands a
      // centimetre or two taller at the release than the fold-only estimate this was
      // first read against — so the slot's top comes out a millimetre and a half
      // short rather than a couple of centimetres. Either way the placement carries
      // the difference (see Pitcher.jsx).
      assert.ok(
        height - pose.ball[1] > 0.001,
        `height ${height} should have been clamped, held ${pose.ball[1]}`,
      )
    }
  }
})

test('the wrist the pose asks for carries the ball one palm down the hand line', () => {
  // The driver puts the wrist where the pose asks and the ball rides the hand's
  // own line from there (see solveOpenArm's ball). The pose has to solve the
  // inverse of that, or the anchor above is a hand's length out.
  for (const height of HEIGHTS) {
    const pose = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height }))
    const { hand: wrist, aim } = pose.arms[0]
    const carry = releaseCarry(RIG, 'R')
    assert.ok(Math.abs(Math.hypot(...aim) - 1) < 1e-12, 'the aim is not a unit line')
    assert.ok(
      distance(wrist, pose.ball) - carry < 1e-9,
      `the wrist is ${distance(wrist, pose.ball)} from the ball, not a carry`,
    )
    // ...and it is the *carry* down the aim, not a carry in some other direction.
    assert.ok(
      distance([wrist[0] + aim[0] * carry, wrist[1] + aim[1] * carry, wrist[2] + aim[2] * carry], pose.ball) < 1e-9,
    )
  }
})

test('a higher release is thrown by a taller slot', () => {
  // The one thing a delivery has to do differently for a different release height
  // is stand up: the arm can only lift the ball so far above the shoulder, and
  // everything past that is the body coming out of its fold. So the lean at the
  // release is the slot's own lean, and a higher slot reaches less far forward
  // over the same body.
  const forward = []
  for (const height of HEIGHTS) {
    const pose = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height }))
    const lean = pose.hip.fold
    // Inside the authored band the lean is the height's own, moved by the same
    // difference the keys are written for.
    assert.ok(
      Math.abs(lean - releaseLean(height)) < 1e-6,
      `at ${height} the body leans ${lean}, not the slot's ${releaseLean(height)}`,
    )
    forward.push(pose.ball[2])
  }
  for (let i = 1; i < forward.length; i += 1) {
    assert.ok(
      forward[i] > forward[i - 1] - 1e-9,
      `a taller slot reached further forward: ${forward[i - 1]} -> ${forward[i]}`,
    )
  }
  const low = releaseLean(HEIGHTS[0])
  const high = releaseLean(HEIGHTS[HEIGHTS.length - 1])
  assert.ok(low > 0.6 && high < 0.42, `the slot band is ${low} to ${high}`)
})

test('the keys are authored for the reference height they claim', () => {
  // AUTHORED_RELEASE_HEIGHT is the height the keys' own leans were written for, so
  // the release key's lean has to be that height's lean — otherwise every pitch
  // carries a standing-height correction for a delivery that never had one.
  const pose = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height: AUTHORED_RELEASE_HEIGHT }))
  assert.ok(
    Math.abs(pose.hip.fold - releaseLean(AUTHORED_RELEASE_HEIGHT)) < 1e-9,
    'the reference height is corrected like any other',
  )
  // ...and the reference height is *derived* from the release key's own lean, so
  // the two cannot drift: the height whose slot lean is the key's lean.
  assert.ok(
    Math.abs(releaseLean(AUTHORED_RELEASE_HEIGHT) - 0.57) < 1e-9,
    `the reference height's own lean is ${releaseLean(AUTHORED_RELEASE_HEIGHT)}`,
  )
})

test('the delivery is a loop: the clip ends in the set it began in', () => {
  // Pitcher.jsx holds the delivery on a cycle, so the last frame has to be the
  // first one: anything else is a pitcher who snaps back into his stance between
  // pitches.
  const open = pitcherPose(0, ctx())
  const close = pitcherPose(AUTHORED_CLIP_END, ctx())
  assert.deepEqual(close.ball, open.ball)
  assert.deepEqual(close.hip, open.hip)
  assert.deepEqual(close.head, open.head)
  for (let arm = 0; arm < open.arms.length; arm += 1) {
    assert.deepEqual(close.arms[arm].hand ?? close.arms[arm].local, open.arms[arm].hand ?? open.arms[arm].local)
    assert.deepEqual(close.arms[arm].aim ?? close.arms[arm].aimLocal, open.arms[arm].aim ?? open.arms[arm].aimLocal)
    assert.deepEqual(close.arms[arm].elbow, open.arms[arm].elbow)
  }
  for (let leg = 0; leg < open.legs.length; leg += 1) {
    assert.deepEqual(close.legs[leg].ankle, open.legs[leg].ankle)
    assert.deepEqual(close.legs[leg].knee, open.legs[leg].knee)
  }
})

test('the delivery moves at a pitch\'s speed and never jumps', () => {
  // The tracks are read through a monotone interpolator precisely so a track whose
  // keys step cannot ring; what this holds is the other half: that the delivery is
  // one continuous throw at a hand's speed, not a series of poses.
  const step = 1 / 120
  // What a frame may move a joint. The angles are the fastest of them: a pitch's
  // own pelvis turns at something like 600 degrees a second (a delivery is thrown by
  // a body that spins), which is 0.09 rad in a frame this size — so the bound is the
  // pitch's own speed rather than a fraction of the figures below, and what it is
  // there to catch is a track that steps rather than turns. The delivered clip's own
  // fastest hip frame is the windup's unwind off the fall (0.975s, the pelvis's yaw:
  // 0.0835 rad in a frame, which is 574 degrees a second) — a windup that coils
  // deeper spends more of the turn across the same twelfth of a second, and this
  // bound is what holds that spending inside a pitch's own speed.
  //
  // The foot's is the fastest of the places, and it is the swing's own tail: the
  // trail leg comes round and *down* onto its landing in the last two keys, and where
  // that landing is nearer the lead foot the same swing has less room to put the foot
  // in. Measured at 12.8 rig/s over the last two keys (the swing's own speed before
  // that is under 5), which is 0.13 in a frame of this size — so the bound is 0.14,
  // which is the delivery's own tail rather than the old 0.12, a figure that was the
  // previous landing's measurement with nothing under it.
  const bounds = { ball: 0.2, arm: 0.2, foot: 0.14, angle: 0.09 }
  const worst = { ball: 0, arm: 0, foot: 0, angle: 0 }
  let previous = pitcherPose(0, ctx())
  let moved = 0
  for (let t = step; t <= AUTHORED_CLIP_END + 1e-9; t += step) {
    const pose = pitcherPose(t, ctx())
    const ball = distance(pose.ball, previous.ball)
    worst.ball = Math.max(worst.ball, ball)
    moved = Math.max(moved, ball)
    for (let arm = 0; arm < pose.arms.length; arm += 1) {
      // The place as the driver reads it, which is the one that moves a hand: an
      // arm written in both frames (the clasped grip) puts its hand where the mix
      // says, so a step in the mix is a step in the hand.
      const now = placeOf(pose, pose.arms[arm])
      const was = placeOf(previous, previous.arms[arm])
      worst.arm = Math.max(worst.arm, distance(now, was))
    }
    for (let leg = 0; leg < pose.legs.length; leg += 1) {
      worst.foot = Math.max(worst.foot, distance(pose.legs[leg].ankle, previous.legs[leg].ankle))
    }
    for (const angle of ['yaw', 'leanX', 'leanZ']) {
      worst.angle = Math.max(worst.angle, Math.abs(pose.hip[angle] - previous.hip[angle]))
    }
    previous = pose
  }
  assert.ok(worst.ball <= bounds.ball, `the ball steps ${worst.ball} in one frame`)
  assert.ok(worst.arm <= bounds.arm, `an arm target steps ${worst.arm} in one frame`)
  assert.ok(worst.foot <= bounds.foot, `a foot steps ${worst.foot} in one frame`)
  assert.ok(worst.angle <= bounds.angle, `the hips turn ${worst.angle} rad in one frame`)
  // ...and the test cannot pass on a delivery that never throws.
  assert.ok(moved > 0.08, `the fastest frame of the delivery moves the ball ${moved}`)
})

test('the pose never asks an arm or a leg for more than it has', () => {
  // The driver answers a target it cannot reach by stretching the bones; the
  // release window is the one place the ball's *place* is not negotiable, so the
  // pose has to be the one that keeps its own asks inside the model's proportions.
  const span = RIG.arm.upper + RIG.arm.fore + releaseCarry(RIG, 'R')
  const legLength = RIG.leg.thigh + RIG.leg.shin
  // The release frame is where the pose's own promise is made, so it is held to a
  // hand's width of the model's proportions at every height...
  for (const height of HEIGHTS) {
    const release = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height }))
    const reach = distance(release.arms[0].hand, shoulderOf(release))
    assert.ok(
      reach <= span * 1.1,
      `the release at ${height} asks ${reach} of a ${span} span`,
    )
  }
  // A leg the hips have outrun is answered by the shoe rolling up onto its toe
  // (see the driver's rollFootOnToe), which is worth this much of the leg's reach:
  // the lever from the toe to the ankle, less the height the ankle starts at. The
  // model's own toe joint, in the rig frame.
  const TOE = [0, -0.0685, -0.1203]
  const roll = Math.hypot(TOE[1], TOE[2]) - Math.abs(TOE[1])
  for (const height of HEIGHTS) {
    for (const t of TIMES) {
      const pose = pitcherPose(t, ctx({ height }))
      const shoulder = shoulderOf(pose)
      const wrist = pose.arms[0].hand
      // ...and the frames around it, which the driver's own stretch answers, are
      // held to the model's span outright wherever a real staff throws.
      // The pose's own shoulder model is a shoulder's rest offset turned by the lean
      // and the yaw, and the socket the arm hangs from is a clavicle's width inside
      // what the driver solves from, so the budget carries that much of its own
      // reading rather than the arm's. The high cock is the worst of it: the arm
      // folds *past* the anchor's own sphere there (the ball is drawn a hand's width
      // behind the release point), which is 11% of the span on this model — and the
      // browser suite's own read of the driver's stretch is the check that the arm
      // the driver builds is still inside its bones.
      const budget = STOCK_HEIGHTS.includes(height) ? span * 1.14 : span * STRETCH_MAX
      assert.ok(
        distance(wrist, shoulder) <= budget,
        `at ${t}s the arm asks ${distance(wrist, shoulder)} of a ${span} span`,
      )
      for (const leg of pose.legs) {
        // Each foot from *its own* hip socket: a delivery strides with one leg and
        // pivots on the other, and the two sockets are a hip's width apart.
        const hip = hipOf(pose, leg.side)
        assert.ok(
          distance(leg.ankle, hip) <= legLength + roll + 1e-9,
          `at ${t}s a foot is ${distance(leg.ankle, hip)} from the hip, ${legLength} away at longest`,
        )
        assert.ok(
          leg.ankle[1] >= RIG.ankleY - 1e-9,
          `at ${t}s a foot is ${leg.ankle[1]} below its own rest height`,
        )
      }
    }
  }
})

test('every pole keeps the elbow off the arm\'s own chord', () => {
  // An elbow hint only means something off the chord: a pole on the shoulder-to-
  // hand line leaves the two-bone IK no side to bend to, and the elbow would fall
  // wherever the axis picks.
  for (const t of TIMES) {
    const pose = pitcherPose(t, ctx())
    for (const arm of pose.arms) {
      // Each arm's own socket: the glove hand's pole is read from the glove shoulder,
      // and reading it from the throwing one measures a line the arm never took.
      const shoulder = shoulderOf(pose, arm.side)
      // A local target is authored in the chest's own frame (the glove is held in
      // front of the chest, which turns under it), so the chord it makes with the
      // socket is the turned one — the same read the driver takes.
      const target = arm.hand ?? turnVector(upperTurnOf(pose), arm.local)
      const hand = arm.hand ? target : [shoulder[0] + target[0], shoulder[1] + target[1], shoulder[2] + target[2]]
      const chord = [hand[0] - shoulder[0], hand[1] - shoulder[1], hand[2] - shoulder[2]]
      const length = Math.hypot(...chord) || 1
      const pole = [arm.elbow[0] - shoulder[0], arm.elbow[1] - shoulder[1], arm.elbow[2] - shoulder[2]]
      const along = (pole[0] * chord[0] + pole[1] * chord[1] + pole[2] * chord[2]) / length
      const off = Math.hypot(
        pole[0] - (chord[0] / length) * along,
        pole[1] - (chord[1] / length) * along,
        pole[2] - (chord[2] / length) * along,
      )
      assert.ok(
        Number.isFinite(off) && off > 0.03,
        `at ${t}s an elbow pole sits ${off} off the arm's chord`,
      )
    }
  }
})

test('a left-handed delivery is the right-handed one mirrored', () => {
  // The whole delivery is authored for a right-hander and mirrored for a lefty, so
  // the mirror is the *only* difference: same heights, same depths, the lateral
  // axis negated — and the throwing arm comes over the other shoulder.
  for (const t of TIMES) {
    const right = pitcherPose(t, ctx())
    const left = pitcherPose(t, ctx({ hand: 'L' }))
    const mirrored = (a, b) => {
      assert.ok(
        Math.abs(a[0] + b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9,
        `${show(a)} is not ${show(b)} mirrored`,
      )
    }
    mirrored(left.ball, right.ball)
    assert.equal(left.hip.yaw, -right.hip.yaw)
    assert.equal(left.hip.leanZ, -right.hip.leanZ)
    for (let arm = 0; arm < right.arms.length; arm += 1) {
      mirrored(left.arms[arm].elbow, right.arms[arm].elbow)
      for (const key of ['hand', 'local', 'aim', 'aimLocal']) {
        if (right.arms[arm][key]) mirrored(left.arms[arm][key], right.arms[arm][key])
      }
    }
    for (let leg = 0; leg < right.legs.length; leg += 1) {
      mirrored(left.legs[leg].ankle, right.legs[leg].ankle)
      mirrored(left.legs[leg].knee, right.legs[leg].knee)
      assert.equal(left.legs[leg].footYaw, -right.legs[leg].footYaw)
    }
  }
})

test('the set stands side-on to the plate, with the throwing hand trailing', () => {
  // The stance a grip is hidden in. The plate is off the pitcher's *side*: the glove
  // shoulder is the one nearer it, the throwing shoulder is back at second base —
  // trailing, so the arm the ball comes out of is behind the body until the throw
  // starts — and the head faces the way the chest does, so a man standing in the set is
  // looking down his own side of the plate rather than at it (see the look's own test
  // below, which reads where the eyes come onto it: with the drive).
  for (const t of [0, AUTHORED_CLIP_END]) {
    const set = pitcherPose(t, ctx())
    const chest = set.hip.yaw + set.torsoYawExtra
    assert.ok(chest < -1.0, `the set's chest is turned ${chest} rad, which is not side-on`)
    const throwing = shoulderOf(set, set.arms[0].side)
    const glove = shoulderOf(set, set.arms[1].side)
    assert.ok(
      glove[2] < throwing[2] - 0.25,
      `the glove shoulder ${show(glove)} and the throwing one ${show(throwing)}: too little between them`,
    )
    // And it points *directly* at the strike zone: the non-throwing socket lies on
    // the chest's own forward line — no lateral offset at all, and a full shoulder's
    // half width ahead of the chest's centre, which is the shoulder line lying along
    // the way the pitch goes. (Turned three quarters of the way there instead, the
    // socket sits 12 cm off that line and the shoulder is aimed past the zone.)
    const centre = chestOf(set)
    assert.ok(
      Math.abs(glove[0] - centre[0]) < 0.01,
      `the glove shoulder is ${(glove[0] - centre[0]) * 100} cm off the plate's line`,
    )
    assert.ok(
      Math.abs((centre[2] - glove[2]) - RIG.shoulder.halfWidth) < 0.01,
      `the glove shoulder is ${(centre[2] - glove[2]) * 100} cm ahead of the chest, not a shoulder's ${RIG.shoulder.halfWidth * 100}`,
    )
    // The *legs* are side-on with it: the pelvis is square to the plate's side too
    // (a right angle, not merely turned), and both shoes have come round with it —
    // a leg faces the way its body does (see the pose assembly's ``facing``).
    assert.ok(
      Math.abs(set.hip.yaw + Math.PI / 2) < 0.03,
      `the pelvis is ${(set.hip.yaw * 180 / Math.PI).toFixed(1)}°, not a right angle to the plate`,
    )
    for (const leg of set.legs) {
      assert.ok(
        Math.abs(leg.footYaw - set.hip.yaw) < 0.5,
        `a shoe at ${(leg.footYaw * 180 / Math.PI).toFixed(0)}° against a body at ${(set.hip.yaw * 180 / Math.PI).toFixed(0)}°: the feet did not turn with the stance`,
      )
      // ...and the knee bends the way the body faces rather than at the plate.
      const forward = leg.knee[2] - leg.ankle[2]
      assert.ok(
        Math.abs(leg.knee[0] - leg.ankle[0]) > Math.abs(forward),
        `the knee is pushed ${forward} toward the plate: the leg is not facing with the body`,
      )
    }
    assert.ok(
      throwing[2] > 0.15,
      `the throwing shoulder is at ${throwing[2]}: not trailing the body`,
    )
    // The face: looking straight ahead down the stance's own line, *level*. The model
    // stands with its ribcage tipped a good ten degrees over its hips at rest, so the
    // neck's own numbers are that fold cancelled out — which is what looking at the horizon
    // on a body that leans forward is — and what the head is *not* doing is finding the
    // plate: the look at the zone is the drive's business and not the stance's (see the
    // look's own test, which reads both ends of that).
    const at = gazeOf(set)
    assert.ok(
      Math.abs(at.elevation) < 0.5,
      `the set is looking ${at.elevation.toFixed(1)}° off level: not straight ahead`,
    )
    assert.ok(
      Math.abs(at.bearing - (chest * 180) / Math.PI) < 1,
      `the set is looking ${(at.bearing - (chest * 180) / Math.PI).toFixed(1)}° off the way the stance faces`,
    )
  }
})

test('the eyes hold their own line until the drive, then the plate\'s, until the ball is most of the way there — and then they go with a body still turning under them', () => {
  // What a delivery looks like from the drive to the zone. From the lock on, the neck
  // carries the whole of the chest's turn *and fold* off the head's line, so the look is
  // on the plate's own line and *level* whatever the shoulders are doing — a pitcher
  // throws at a zone he is looking at, and the body comes round and folds *under* his
  // eyes rather than through them. That is the sequence's own promise, and the reading below is
  // the pose's own composition of it (the same `turnVector` the pose carries its
  // chest, sockets and release anchor by): the browser suite reads the same promise
  // off the realised head, and the two agree to a third of a degree.
  //
  // The look is handed over on the *pitch's* clock rather than on a key's (see the
  // sequence's ``LOOK_PIN``), and it is handed over *early*: the eyes come off the
  // zone with the ball 70% of the way to the plate (``AUTHORED_HANDOFF_TIME``, 0.31 s
  // of flight after the release and a twentieth of a second before it lands), so the
  // head starts following the torso while the torso is still coming round, and the
  // eyes are wholly the shoulders' a third of a second after that. Both ends of the
  // clock are the *stance*'s, though: the head *holds* the line it stands in until the
  // drive starts (``AUTHORED_DRIVE_TIME``) — a coil is the body winding under eyes that
  // keep their line, and a head carried round with the shoulders has stopped looking at
  // anything — and it is the body's again for the whole of the finish, the hold and the
  // walk back to the rubber. A look at the zone is the throw's; the stances the clip
  // begins and ends in are a man looking down his own front.
  const DEG = 180 / Math.PI
  const chestYaw = (t) => {
    const pose = pitcherPose(t, ctx())
    return (pose.hip.yaw + pose.torsoYawExtra) * DEG
  }
  const gaze = (t) => gazeOf(pitcherPose(t, ctx()))
  // The set and the front of the windup: the head holds the line it stands in — level, on
  // the horizon — while the body starts to coil under it. That is the two halves of the
  // promise at once: the *bearing* stays where it was (the head did not come round with the
  // body), and so does the level of it (it did not tip with the trunk either: the model
  // stands with its ribcage tipped ten degrees over its hips at rest, and a gaze that rode
  // that fold is the eyes on the floor).
  const stance = gaze(0)
  for (let t = 0; t <= AUTHORED_LOOK_SWEEP_TIME + 1e-9; t += 0.02) {
    const at = gaze(t)
    assert.ok(
      Math.abs(at.bearing - stance.bearing) < 0.5 && Math.abs(at.elevation - stance.elevation) < 0.5,
      `at ${t.toFixed(2)}s the head is looking ${(at.bearing - stance.bearing).toFixed(2)}° off the line it stood in, with the chest ${(chestYaw(t) - chestYaw(0)).toFixed(1)}° round it: it came round with the body`,
    )
  }
  // ...and then it comes onto the zone *finished before the drive fires*: a look is picked up
  // before the legs take the body anywhere, and what stays quiet through the drive is the
  // head, not the body. The head sweeps a right angle off the stance's line over the windup's
  // own lift and is on the plate's, level, by the balance point (``AUTHORED_LOOK_LOCK_TIME``),
  // which is a settled fraction of a second ahead of the drive (``AUTHORED_DRIVE_TIME``).
  assert.ok(
    AUTHORED_LOOK_LOCK_TIME < AUTHORED_DRIVE_TIME - 0.05,
    `the eyes lock only ${(AUTHORED_DRIVE_TIME - AUTHORED_LOOK_LOCK_TIME).toFixed(2)}s before the drive fires: the turn is not finished before it`,
  )
  let swept = stance.bearing
  for (let t = AUTHORED_LOOK_SWEEP_TIME; t <= AUTHORED_LOOK_LOCK_TIME + 1e-9; t += 0.005) {
    const at = gaze(t)
    assert.ok(
      at.bearing >= swept - 1e-9 && Math.abs(at.bearing) <= Math.abs(stance.bearing) + 1e-9,
      `at ${t.toFixed(3)}s the head is at ${at.bearing.toFixed(2)}°, back from ${swept.toFixed(2)}°: the sweep does not run the one way`,
    )
    swept = at.bearing
  }
  const locked = gaze(AUTHORED_LOOK_LOCK_TIME)
  assert.ok(
    Math.abs(locked.bearing) < 0.02 && Math.abs(locked.elevation) < 0.02,
    `at the balance the head is looking ${locked.bearing.toFixed(2)}° off the plate and ${locked.elevation.toFixed(2)}° off level`,
  )
  // ...and it is still there when the drive fires, on the frame the hip crosses its own
  // nought: the eyes the throw is made with are already the ones the balance point found.
  const driving = gaze(AUTHORED_DRIVE_TIME)
  assert.ok(
    Math.abs(driving.bearing) < 0.02 && Math.abs(driving.elevation) < 0.02,
    `at ${AUTHORED_DRIVE_TIME}s the head is looking ${driving.bearing.toFixed(2)}° off the plate: the turn is not finished before the drive`,
  )
  // ...and the *neck* pays for the whole of the coil under it, which is what a head on the
  // target over a body that has wound up looks like: at the balance the chest is a hundred
  // and twenty-odd degrees off the plate and the neck is holding all of it, with the eyes still
  // (the body's own turn is what unwinds it from there — see the frames below).
  const deepest = pitcherPose(AUTHORED_LOOK_LOCK_TIME, ctx())
  assert.ok(
    Math.abs(chestYaw(AUTHORED_LOOK_LOCK_TIME) - chestYaw(0)) > 25,
    `the windup coils the chest only ${(chestYaw(AUTHORED_LOOK_LOCK_TIME) - chestYaw(0)).toFixed(1)}°: there is nothing the neck is carrying`,
  )
  assert.ok(
    Math.abs(deepest.head.yaw) * DEG > 100,
    `the neck is holding only ${(Math.abs(deepest.head.yaw) * DEG).toFixed(0)}° where the plate's own solve asks for ${Math.abs(chestYaw(AUTHORED_LOOK_LOCK_TIME) - chestYaw(0)).toFixed(0)}°-plus: the eyes are not on the target`,
  )
  assert.ok(
    Math.abs(deepest.head.pitch) * DEG > 2,
    `the head is ${(Math.abs(deepest.head.pitch) * DEG).toFixed(1)}° off level inside the shoulders at the balance: it is riding the trunk's fold rather than the zone's line`,
  )
  for (let t = AUTHORED_LOOK_LOCK_TIME; t <= AUTHORED_HANDOFF_TIME + 1e-9; t += 0.02) {
    const at = gaze(t)
    assert.ok(
      Math.abs(at.bearing) < 0.02,
      `at ${t.toFixed(2)}s the head is looking ${at.bearing.toFixed(2)}° off the plate`,
    )
    // ...and *level* with it: the trunk is folded over the plate by up to 33° on
    // these frames (see the release's own lean), and a head riding that fold is what
    // this used to be — 35° below level on the release frame, looking at the plate's
    // line through the dirt the pitch was thrown over.
    assert.ok(
      Math.abs(at.elevation) < 0.02,
      `at ${t.toFixed(2)}s the head is looking ${at.elevation.toFixed(2)}° off level`,
    )
  }
  // Nothing about the *body's* turn changed with it: the same frames that hold the
  // look still turn the chest — a lock is a counter-rotation, not a still neck.
  assert.ok(
    Math.abs(chestYaw(AUTHORED_RELEASE_TIME) - chestYaw(0.8)) > 60,
    `the chest turns ${(chestYaw(AUTHORED_RELEASE_TIME) - chestYaw(0.8)).toFixed(0)}° from the balance to the release while the eyes are locked`,
  )
  // The hand-off is a *frame* the pose's keys do not put a key on, and it is where
  // the eyes come off the zone: the ball is still short of the plate and the chest is
  // still short of its finish — the turn is held from the landing on (see the finish),
  // and the landing is a twentieth of a second after this. That is the whole of it:
  // the head is let go onto a body that is *moving* under it, rather than onto one
  // already square to the plate.
  const handoff = gaze(AUTHORED_HANDOFF_TIME)
  assert.ok(
    Math.abs(handoff.bearing) < 0.02 && Math.abs(handoff.elevation) < 0.02,
    `the eyes leave the zone ${handoff.bearing.toFixed(2)}° before the ball is 70% of the way there`,
  )
  const stillTurning = chestYaw(1.68) - chestYaw(AUTHORED_HANDOFF_TIME)
  assert.ok(
    stillTurning > 1,
    `the chest turns only ${stillTurning.toFixed(1)}° from the hand-off to the landing: there is nothing under the head to follow`,
  )
  // ...and it is on the *walk* rather than at the start of it: the ball crosses the
  // plate with the head a third of the way off the zone and the shoulders a right
  // angle the other side of it — the head has begun to go with the body and is not
  // yet the body's. The clock this replaced could not read that at all: the eyes were
  // still on the plate at the arrival, and the whole of the unwind came off a chest
  // that had been stopped for a fifth of a second.
  const arrival = gaze(AUTHORED_ZONE_TIME)
  assert.ok(
    arrival.bearing > 20,
    `the head is still ${arrival.bearing.toFixed(1)}° on the plate when the ball arrives: the hand-off is doing nothing`,
  )
  assert.ok(
    Math.abs(chestYaw(AUTHORED_ZONE_TIME) - arrival.bearing) > 30,
    `the head is already the shoulders' at the ball's own arrival: the hand-off is a step rather than a hand-off`,
  )
  // Then it is the body's: from the zone on the head's own line comes round the one
  // way, with the neck's counter-rotation unwinding — the head never swinging back
  // toward a zone the ball has already left.
  const turning = []
  for (let t = AUTHORED_HANDOFF_TIME; t <= 2.8 + 1e-9; t += 0.02) turning.push(gaze(t).bearing)
  for (let i = 1; i < turning.length; i += 1) {
    assert.ok(
      turning[i] > turning[i - 1] - 1e-9,
      `the head holds ${turning[i].toFixed(1)}° at the ${i}th frame of the follow-through, back from ${turning[i - 1].toFixed(1)}°: it is not turning with the body`,
    )
  }
  assert.ok(
    turning[turning.length - 1] > 100,
    `the head comes only ${turning[turning.length - 1].toFixed(0)}° round of the plate's line by the hold`,
  )
  // ...and by the hold it *is* the body's, which is the promise in its plainest form:
  // the head's own line is the line the torso is facing — level and all.
  const hold = pitcherPose(2.8, ctx())
  assert.ok(
    Math.abs(hold.head.yaw) < 1e-12,
    `the head is still turned ${hold.head.yaw} inside the shoulders at the hold`,
  )
  const looks = gazeOf(hold)
  const faces = gazeOf(hold, 0, 0)
  // A nod reads a shade off the horizontal, so the two lines are compared as lines of
  // sight rather than as bearings to the last digit: what is pinned is that the head
  // is not *turned* inside the shoulders, which is the promise in its plainest form.
  assert.ok(
    Math.abs(looks.bearing - faces.bearing) < 1,
    `the head is looking ${(looks.bearing - faces.bearing).toFixed(2)}° off the way the torso faces: it never left the shoulders`,
  )
  assert.ok(
    Math.abs(faces.bearing) > 100,
    `the torso only comes ${faces.bearing.toFixed(0)}° round of the plate's line: there is nothing for the head to have been handed to`,
  )
  // ...and the head comes home with the body it is on and then onto its own line, which is
  // what makes the clip's own wrap one pose: the look is nought for the finish and the hold
  // — the head the chest's, with nothing asked of the neck — and the recovery turns it back
  // onto the line it stands in as the body squares up under it, so that the stance the clip
  // closes in is the stance it opened in, head and all (see the loop test, which compares
  // the two ends outright).
  for (let t = 2.0; t <= 2.8 + 1e-9; t += 0.02) {
    const pose = pitcherPose(t, ctx())
    assert.ok(
      Math.abs(pose.head.yaw) < 1e-12,
      `at ${t.toFixed(2)}s the head is still turned ${(pose.head.yaw * DEG).toFixed(1)}° inside the shoulders: it has not been handed back to the shoulders`,
    )
  }
  for (const t of [3.14, AUTHORED_CLIP_END]) {
    const at = gaze(t)
    assert.ok(
      Math.abs(at.bearing - stance.bearing) < 0.5 && Math.abs(at.elevation - stance.elevation) < 0.5,
      `at ${t}s the head is ${(at.bearing - stance.bearing).toFixed(2)}° off the line it stands in: it is not home in its stance`,
    )
  }
})

test('the head stops tracking the zone when the neck would be turned past 170° inside the shoulders', () => {
  // The pin is a *look at the plate*: the chest's whole turn and fold are read back off the
  // eyes, so the neck's own numbers are whatever is left of them, however far round the
  // body has come. What is left has a limit, and 170° is past it — a head turned that far
  // inside its torso is looking over its own back, which no neck holds — so the pin is not
  // asked for there: the head stops tracking the zone and rides the shoulders it sits on,
  // the shape the hand-off leaves it in. The boundary is the one promise here that is read
  // off the guard itself rather than walked to, because the delivered clip never goes near
  // it: over the whole sweep, both hands and every slot, the most the pin ever asks for is
  // 124° (at the windup's deepest, the balance point) — and it is the neck that holds the
  // same 124° there, the eyes still on the plate while the chest sits a hundred and
  // twenty-odd degrees off it (see the look's own test above, which is that lock read
  // frame by frame).
  const LIMIT = (170 * Math.PI) / 180
  assert.equal(headTrackShare(LIMIT - 1e-6), 1, 'the pin is dropped this side of the limit')
  assert.equal(headTrackShare(LIMIT), 1, 'the pin is dropped at the limit itself')
  assert.equal(headTrackShare(LIMIT + 1e-6), 0, 'a head turned past the limit is still asked to look at the zone')
  const extremes = { 'the pin asks for': 0, 'the neck holds': 0 }
  for (const hand of ['R', 'L']) {
    for (const height of HEIGHTS) {
      for (let t = 0; t <= AUTHORED_CLIP_END + 1e-9; t += 0.01) {
        const pose = pitcherPose(t, ctx({ hand, height }))
        // What the pin asks for — the plate's direction read in the chest's own frame, which
        // is the same angle as the chest's forward against the plate's line in the rig's.
        const forward = turnVector(upperTurnOf(pose), [0, 0, -1])
        const asked = Math.acos(Math.min(1, Math.max(-1, -forward[2])))
        // ...and what the neck actually holds, off the pose's own two angles: the head's own
        // line about the frame's -z, which is straight ahead.
        const { yaw, pitch } = pose.head
        const held = Math.acos(Math.min(1, Math.max(-1, Math.cos(pitch) * Math.cos(yaw))))
        extremes['the pin asks for'] = Math.max(extremes['the pin asks for'], asked)
        extremes['the neck holds'] = Math.max(extremes['the neck holds'], held)
      }
    }
  }
  for (const [name, angle] of Object.entries(extremes)) {
    assert.ok(
      angle < LIMIT,
      `${name} ${(angle * 180 / Math.PI).toFixed(1)}° inside the shoulders: the head is looking over its own back rather than at the zone`,
    )
  }
})

test('the windup cocks the hip, and the hip is what turns the body', () => {
  // The back hip is the engine of the turn. It *cocks* in the windup — the thigh
  // carries the shin round with the pelvis' coil, in the direction the torso is going
  // (toward the back leg) — and then opens toward the plate and through the drive,
  // with the pelvis and *then* the shoulders following it. Which of the three leads
  // is a number: how far each has turned since the top of the windup, and the order
  // is what "the hip drives the torso turn" means.
  const DEG = 180 / Math.PI
  const set = pitcherPose(0, ctx())
  const balance = pitcherPose(0.8, ctx())
  const cocked = balance.hip.yaw * DEG
  assert.ok(
    cocked < -95,
    `the windup turns the pelvis to ${cocked.toFixed(1)}°: a side-on stance with no cock in it`,
  )
  const coil = balance.hip.yaw + balance.torsoYawExtra
  assert.ok(
    coil < balance.hip.yaw,
    `the chest is at ${(coil * DEG).toFixed(1)}° over a pelvis at ${cocked.toFixed(1)}°: coiled under it`,
  )
  const thigh = balance.legs[0].footYaw * DEG
  assert.ok(
    thigh < set.legs[0].footYaw * DEG - 4,
    `the pivot thigh is at ${thigh.toFixed(1)}°, the set's shoe at ${(set.legs[0].footYaw * DEG).toFixed(1)}°: it did not carry the shin with the cock`,
  )
  // How far each has turned *open* since the top of the windup: the poses open
  // toward the plate, so a turn made is the difference from the balance's own angle.
  const since = (pose) => ({
    thigh: pose.legs[0].footYaw - balance.legs[0].footYaw,
    hip: pose.hip.yaw - balance.hip.yaw,
    chest: pose.hip.yaw + pose.torsoYawExtra - coil,
  })
  const breakAt = since(pitcherPose(1.0, ctx()))
  assert.ok(
    breakAt.thigh > breakAt.hip && breakAt.hip > breakAt.chest,
    `at the break the thigh has turned ${(breakAt.thigh * DEG).toFixed(1)}°, the pelvis ` +
      `${(breakAt.hip * DEG).toFixed(1)}° and the chest ${(breakAt.chest * DEG).toFixed(1)}°: the turn is not running up the chain from the hip`,
  )
  const plant = since(pitcherPose(1.12, ctx()))
  assert.ok(
    plant.hip > plant.thigh,
    `at the plant the pelvis has turned ${(plant.hip * DEG).toFixed(1)}° against the thigh's ` +
      `${(plant.thigh * DEG).toFixed(1)}°: the hip did not hand the turn over to the body`,
  )
  for (const t of [1.0, 1.12, 1.24, AUTHORED_RELEASE_TIME]) {
    const there = since(pitcherPose(t, ctx()))
    assert.ok(
      there.hip > there.chest,
      `at ${t}s the pelvis has turned ${(there.hip * DEG).toFixed(1)}° and the chest ` +
        `${(there.chest * DEG).toFixed(1)}°: the shoulders opened with the hips, not after them`,
    )
  }
})

test('the drive launches the body, and the momentum spins it past the plate', () => {
  // What the authoring promises about the delivery's own two halves: the step the
  // front leg takes and the push the pelvis makes under it, then the turn that outlives
  // the throw. (The browser suite reads the same two off the realised skeleton — the
  // plant's own numbers, and the over-spin the follow-through pictures.)
  const DEG = 180 / Math.PI
  const set = pitcherPose(0, ctx())
  // The foot's own *arrival* is read at 1.32s rather than at 1.12s: the kick is
  // carried longer than it was — the leg hangs off its knee while the body turns
  // under it and only comes down into the step from about 1.12 (see the front foot's
  // own notes in the assembly), so before 1.24 the pose's ankle is still the carried
  // leg's own place rather than the place it plants on. Reads the *realised* model
  // the same way at the same time (see the browser suite's stride).
  const plant = pitcherPose(1.32, ctx())
  // The step is the front foot's own travel from where it stood in the set, and a
  // stride is most of a rig unit of it. (The browser suite reads the same promise
  // off the realised model as the split — how far ahead of the pivot foot the front
  // one lands — because a step is a *distance between two bones*, and this reads the
  // pose's own answer for it.)
  const step = distance(set.legs[1].ankle, plant.legs[1].ankle)
  assert.ok(step > 0.65, `the front foot steps ${step.toFixed(2)} rig units: not a stride's step`)
  // ...and the body goes with it: the pelvis's own push toward the plate, which is
  // what carries the whole delivery forward (the feet do not ride it — see the pose).
  const release = pitcherPose(AUTHORED_RELEASE_TIME, ctx())
  assert.ok(
    -release.hip.offsetZ > 0.55,
    `the pelvis drives ${(-release.hip.offsetZ).toFixed(2)} rig units at the release: it lunges rather than launches`,
  )
  // The shoulders open further than they did, and past the plate's own line before the
  // ball goes: the chest at the release and again over the follow-through.
  const chest = (t) => {
    const pose = pitcherPose(t, ctx())
    return pose.hip.yaw + pose.torsoYawExtra
  }
  const hip = (t) => pitcherPose(t, ctx()).hip.yaw
  assert.ok(
    chest(AUTHORED_RELEASE_TIME) > 0.35 && chest(1.42) > 0.85,
    `the chest is ${(chest(AUTHORED_RELEASE_TIME) * DEG).toFixed(0)}° past the line at the release and ` +
      `${(chest(1.42) * DEG).toFixed(0)}° over the follow-through: the shoulders did not open`,
  )
  // And the *lead arm* is what opens them: the glove hand has crossed the body's own
  // line by the high cock, with the chest still a good way closed, and the chest's
  // biggest turn comes after that cross rather than before it.
  const gloveX = (t) => gloveOf(pitcherPose(t, ctx())).wrist[0]
  assert.ok(
    gloveX(1.24) < gloveX(1.12) - 0.08,
    `the lead hand is at ${gloveX(1.24).toFixed(3)} at the high cock against ${gloveX(1.12).toFixed(3)} at the plant: it did not cross the body`,
  )
  const toTheCock = chest(1.24) - chest(1.12)
  const pastIt = chest(1.42) - chest(1.24)
  assert.ok(
    pastIt > toTheCock,
    `the chest turns ${(pastIt * DEG).toFixed(0)}° after the lead arm's cross and only ${(toTheCock * DEG).toFixed(0)}° into it`,
  )
  // Then the momentum: after the release the pelvis is all but done and the *chest*
  // carries the turn on past the line — the whip's own order, and what "the torso spins
  // past the plate" means. (The pelvis's own turn after the release is a fraction of
  // what it turned into it, and the chest's share is the larger one.)
  assert.ok(
    chest(1.62) - chest(AUTHORED_RELEASE_TIME) > hip(1.62) - hip(AUTHORED_RELEASE_TIME),
    'the chest does not carry the turn past the release any further than the pelvis does',
  )
  assert.ok(
    chest(1.62) > 0.95,
    `the chest finishes ${(chest(1.62) * DEG).toFixed(0)}° past the plate's line: it did not spin past it`,
  )
  // ...and read as a *rate*, because the two windows are a fifth of a second and a
  // tenth of one: the pelvis now carries a real share of the follow-through's turn —
  // the finish lands square (see the sequence's own note), so the hips' spin is spent
  // *into* the foot rather than being over before the ball is — and what has to hold is
  // that it is slower doing it than it was into the release.
  const intoIt = (hip(1.42) - hip(AUTHORED_RELEASE_TIME)) / (1.42 - AUTHORED_RELEASE_TIME)
  const after = (hip(1.62) - hip(1.42)) / (1.62 - 1.42)
  assert.ok(
    after < intoIt,
    `the pelvis turns ${(after * DEG).toFixed(0)}°/s through the follow-through against ${(intoIt * DEG).toFixed(0)}°/s into the release: it does not slow after the ball is gone`,
  )
})

test('the trunk turns on the axis it is folded along', () => {
  // What the delivery's turn is: through the whole of it the trunk's fold points at
  // the *plate* — the line the pitch goes on — and what the body's yaw does with the
  // rest is rotate it, about the axis the forward fold has already leaned it on. The
  // keys author that pair directly (``fold`` at the plate, ``foldSide`` toward the
  // throwing side), and the driver leans in the body's own frame, so the two are not
  // the same numbers once the body has come round: what makes them agree is the
  // compensation in ``trunkLean``, and this is the reading that says it does. A
  // delivery without it comes round with its trunk folded 70° off the pitch's line
  // at the finish, which is a body falling off its own axis toward the glove hand
  // rather than one the pitch is carrying. Held against the browser suite's own read
  // of the realised skeleton, which is where the trunk's *up* can be measured.
  const DEG = 180 / Math.PI
  for (let t = 1.0; t <= AUTHORED_CLIP_END + 1e-9; t += 0.02) {
    const pose = pitcherPose(t, ctx())
    // ...the realised trunk, driven by the pair the pose hands over: the yaw, then
    // the two folds — the driver's own composition (see its applyPose), read in the
    // rig's frame (the model's turned about Y).
    // ...the *chest's* yaw, which is the hips' plus the separation the pose carries
    // (the driver turns the ribcage and the waist by bodyYaw and rolls the pelvis
    // back by the extra — see its applyPose).
    const turn = upperTurn(
      pose.hip.yaw + pose.torsoYawExtra,
      -pose.hip.leanX,
      -pose.hip.leanZ,
    )
    // The chest bone's own up rather than the rig's: the shoulders are hinged to a
    // spine that already leans over its own hips (the driver's frame carries it as
    // 0.984 of upright), which is the same rest tilt the browser suite measures the
    // realised skeleton with.
    const up = turnVector(turn, [0, 0.984, 0.18])
    const length = Math.hypot(...up)
    const sideways = Math.asin(Math.max(-1, Math.min(1, up[0] / length))) * DEG
    assert.ok(
      Math.abs(sideways) < 3,
      `at ${t}s the trunk leans ${sideways.toFixed(1)}° off the pitch's line, toward the glove hand`,
    )
    // ...and it is the fold the keys asked for, not a corner of one.
    const tilt = Math.acos(Math.max(-1, Math.min(1, up[1] / length))) * DEG
    assert.ok(
      Math.abs(tilt - pose.hip.fold * DEG) < 2,
      `at ${t}s the trunk stands ${tilt.toFixed(1)}° off upright, not the ${(pose.hip.fold * DEG).toFixed(1)}° it was folded by`,
    )
  }
  // The turn itself is untouched by the compensation: the *body* is still the one the
  // keys turned, so the trunk's fold is a real one at the two ends of the throw — the
  // release, which the fold is most of (the trunk is thrown over the hips across the
  // last of the stride rather than carried into it), and the finish, where the
  // momentum is still carrying the body over the front foot.
  const thrown = pitcherPose(AUTHORED_RELEASE_TIME, ctx())
  assert.ok(
    Math.abs(thrown.hip.fold) > 0.2,
    `at the release the trunk is folded ${(thrown.hip.fold * DEG).toFixed(0)}° forward: nothing to turn on`,
  )
  // ...and the fold is *spent* by the frame the trail foot lands in, which is what
  // leaves both legs at their own length there (see the finish below): the body stands
  // up out of the throw over its own two feet rather than landing sitting in the fold
  // and standing up out of it afterwards.
  const landed = pitcherPose(1.68, ctx())
  assert.ok(
    Math.abs(landed.hip.fold) < 0.1,
    `the trunk is still folded ${(landed.hip.fold * DEG).toFixed(0)}° when the foot lands: he lands in the fold rather than standing out of it`,
  )
  // ...and the other half of that promise is the plant: the trunk is still nearly
  // upright there, because the fold is the release's own work and not something the
  // stride hands it (see the keys' own notes, and the browser suite's reading of the
  // lean's speed, which is the delivery's fastest on the release frame).
  const planted = pitcherPose(1.12, ctx()).hip.fold
  assert.ok(
    planted < 0.2,
    `the plant is already folded ${(planted * DEG).toFixed(0)}° forward: the lean does not wait for the release`,
  )
})

test('a carried leg hangs off its knee, and the cock only turns it', () => {
  // The lead leg's own two promises, both read off the realised skeleton in the
  // browser suite as well (see e2e/pitcher.visual.spec.js); here is the authoring
  // they rest on.
  //
  // First: the share of the leg that hangs off its knee is *in* as soon as the foot
  // is off the ground. The share is the foot's own height rather than a ramp across
  // the lift, because eased in across the whole pick-up the shin spends the first half
  // of the kick folded back over its own foot — the boot trailing across the body
  // while the knee is already out at its own side, which is the shape of a leg being
  // dragged up rather than lifted.
  const front = (t) => pitcherPose(t, ctx()).legs[1]
  assert.equal(
    front(0.34).hang,
    0,
    'the rocker stands the foot on the ground: the kick should not be hanging off its knee yet',
  )
  for (const t of [0.4, 0.48, 0.56, 0.7]) {
    assert.ok(
      front(t).hang > 0.99,
      `at ${t}s only ${front(t).hang.toFixed(2)} of the kick hangs off its knee: the shin is being folded, not lifted`,
    )
  }
  // Second: the hip cock is a *turn* and nothing else. At one lift the direction the
  // knee is pointed along has the same elevation before and after it — the elevation
  // is the lift's own number, so ``cock`` has only the azimuth to turn — and that
  // azimuth comes round from the way the torso faces toward the back leg, which is the
  // +z side of the rig frame (the plate is at -z, the pivot foot at +z).
  const top = front(0.58)
  const cocked = front(0.8)
  assert.ok(
    Math.abs(top.kneeDir[1] - cocked.kneeDir[1]) < 1e-9,
    `the cock moves the knee's own height by ${top.kneeDir[1] - cocked.kneeDir[1]}: it is lifting the leg rather than turning it`,
  )
  assert.ok(
    cocked.kneeDir[2] > top.kneeDir[2] + 0.3,
    `the cock turns the knee to ${cocked.kneeDir[2].toFixed(2)} of the rig's +z against the pick-up's ${top.kneeDir[2].toFixed(2)}: it did not come round toward the back leg`,
  )
  // The knee the solve is *pointed* at and the knee it is handed as a place are one
  // line: the place is the direction, a thigh out from the socket, so the hanging
  // solve has nothing to blend between while the share is coming in.
  for (const [name, pose] of [['the pick-up', top], ['the cock', cocked]]) {
    const rise = (pose.knee[1] - RIG.hip.y) / RIG.leg.thigh
    assert.ok(
      Math.abs(rise - pose.kneeDir[1]) < 1e-9,
      `${name} asks for the knee at ${rise.toFixed(4)} of the thigh and points it at ${pose.kneeDir[1].toFixed(4)}`,
    )
  }
})

test('the pivot foot turns onto the plate line, so the drive leg keeps its plane', () => {
  // The pivot foot is planted on the rubber and the body turns *on* it, so its yaw
  // is the shoe's own rather than a rider on the pelvis' turn — and that yaw *is* the
  // knee's own plane (see the pose assembly). What it buys is read off the realised
  // skeleton in the browser suite: a knee whose plane rides the body's facing swings
  // through the hips' whole 113° turn and crosses the body's midline by 17 cm, while
  // this one cocks out over the outside of its own foot and never crosses it. Here is
  // the authoring the guard rests on: the windup turns the shoe out with the hip's
  // cock, and the drive brings it round onto the plate's own line and holds it there.
  const set = pitcherPose(0, ctx())
  assert.ok(
    Math.abs(set.legs[0].footYaw) > 1.0,
    `the pivot shoe is at ${(set.legs[0].footYaw * 180 / Math.PI).toFixed(0)}°: turned with the body rather than planted`,
  )
  for (const t of [1.12, 1.24, AUTHORED_RELEASE_TIME]) {
    const leg = pitcherPose(t, ctx()).legs[0]
    const shoe = (leg.footYaw * 180) / Math.PI
    assert.ok(
      Math.abs(shoe) < 9,
      `the pivot shoe is ${shoe.toFixed(1)}° off the plate line at ${t}s, so the knee is bending across it`,
    )
  }
  // ...and the line is *given up* after that, a tenth of a second past the release:
  // the follow-through's swing is the same yaw coming round the other way, so the
  // shoe is a hand's width of turn off the plate's line by the frame the front foot
  // lands on, and well out to the glove side by the time it lands itself (see the
  // finish, and the browser suite's reading of the spin).
  const swung = (pitcherPose(1.42, ctx()).legs[0].footYaw * 180) / Math.PI
  assert.ok(
    swung > 9 && swung < 16,
    `the pivot shoe is ${swung.toFixed(1)}° off the plate line at 1.42s: the swing has not begun`,
  )
  for (const t of [1.12, 1.24, AUTHORED_RELEASE_TIME]) {
    const leg = pitcherPose(t, ctx()).legs[0]
    const across = leg.knee[0] - leg.ankle[0]
    assert.ok(
      Math.abs(across) < 0.03,
      `the pivot knee is asked for ${across.toFixed(3)} rig units across its own foot at ${t}s`,
    )
  }
})

test('the hands are clasped in the glove until the break parts them', () => {
  // The ball is *in* the glove while the pitcher stands in the set and winds up: the
  // pose's own ball is the glove's own palm and the two hands run along one line,
  // which is what hides the grip — and what a change to the stance cannot silently
  // pull apart (see claspTracks). The clasp keys are the windup's own: the set, the
  // rocker, the gather and the balance, up to the break that parts them.
  const carry = releaseCarry(RIG, 'R')
  for (const t of [0, 0.2, 0.34, 0.5, 0.58, 0.7, 0.8]) {
    const pose = pitcherPose(t, ctx())
    const glove = gloveOf(pose)
    assert.ok(
      distance(pose.ball, glove.palm) < 0.001,
      `at ${t}s the ball is ${show(pose.ball)} and the glove's palm ${show(glove.palm)}`,
    )
    // The throwing hand's own line is the glove's own, and its wrist is the glove's
    // wrist: the two hands are one hand's worth of place, with the ball a carry out
    // along the line from it — at every frame of the window and not only at its own
    // keys (see the clasp correction in pitcherPose).
    //
    // Read *as the driver reads them*, which is the promise that matters: the pose
    // writes the clasped hand in the glove's own frame (``local``/``aimLocal``) as
    // well as the rig-frame place the keys' own numbers put, and the driver mixes the
    // two by the clasp's own weight — so through the windup the hand is the glove's
    // own place *by construction*, on the chest the driver really holds, and the rig
    // frame's estimate is what it eases out to as the break parts them.
    const hand = placeOf(pose, pose.arms[0])
    const aim = lineOf(pose, pose.arms[0])
    const line = aim[0] * glove.aim[0] + aim[1] * glove.aim[1] + aim[2] * glove.aim[2]
    assert.ok(
      line > 1 - 1e-12,
      `at ${t}s the two hands run ${(Math.acos(Math.min(1, line)) * 180 / Math.PI).toFixed(2)} degrees apart`,
    )
    assert.ok(
      distance(hand, glove.wrist) < 1e-9,
      `at ${t}s the wrists are ${distance(hand, glove.wrist)} apart`,
    )
    // ...and the rig-frame form the keys' own numbers write is the same place, as
    // far as the pose's own estimate of the chest can tell: that is what the two
    // forms are easing between.
    assert.ok(
      distance(pose.arms[0].hand, glove.wrist) < 0.001,
      `at ${t}s the rig-frame place is ${distance(pose.arms[0].hand, glove.wrist)} off the glove's wrist`,
    )
    assert.ok(
      Math.abs(distance(pose.ball, hand) - carry) < 1e-9,
      'the ball does not ride the hand\'s own line',
    )
    // ...and the clasp is held *clear of the body*: the driver refuses to put a hand
    // where the trunk already is, so a clasp written inside the chest would be moved
    // out of it, and the two hands with it.
    const centre = chestOf(pose)
    assert.ok(
      Math.hypot(pose.ball[0] - centre[0], pose.ball[2] - centre[2]) > 0.22,
      `at ${t}s the clasp is inside the trunk (${show(pose.ball)} against ${show(centre)})`,
    )
  }
  // The break is where they come apart: the throwing hand swings down beside the
  // hip while the glove goes out at the plate.
  const parted = pitcherPose(1.1, ctx())
  assert.ok(
    distance(parted.ball, gloveOf(parted).palm) > 0.2,
    'the hands never come apart',
  )
})

test('the trail arm mirrors the lead arm while the hands are clasped', () => {
  // The windup's two arms are *one shape*: with the hands together the throwing arm
  // is the glove arm's own mirror about the body's midline, so the two elbows hang
  // level with each other and both forearms point the same way. The pose derives the
  // second arm rather than authoring it (see `mirrorTracks`), because two sets of
  // numbers for one shape have to be tuned against each other and pull apart
  // invisibly — and the failure it is there to stop is the throwing elbow coming up
  // with the hands, which is a wing rather than a windup.
  //
  // The mirror is about the body's own midline, which is the chest's centre and the
  // lateral axis the two sockets sit on: reflecting the glove elbow in that plane is
  // the same height, the same distance in front of the body and the same distance
  // out to its own side, which is what leaves the two arms symmetrical.
  const reflect = (pose, point) => {
    const centre = chestOf(pose)
    const lateral = shoulderOf(pose, 1).map((value, axis) => value - centre[axis])
    const length = Math.hypot(...lateral)
    const normal = lateral.map((value) => value / length)
    const away = point.map((value, axis) => value - centre[axis])
    const along = away[0] * normal[0] + away[1] * normal[1] + away[2] * normal[2]
    return away.map((value, axis) => centre[axis] + value - 2 * along * normal[axis])
  }
  const armOf = (pose, side) => pose.arms.find((arm) => arm.side === side)
  // The clasped windup: the set, the rocker and the gather, up to just before the
  // glove elbow starts to rise.
  for (const t of [0, 0.2, 0.34, 0.5, 0.58]) {
    const pose = pitcherPose(t, ctx())
    const mirrored = reflect(pose, armOf(pose, -1).elbow)
    assert.ok(
      distance(mirrored, armOf(pose, 1).elbow) < 1e-9,
      `at ${t}s the trail elbow is ${show(armOf(pose, 1).elbow)}, not the lead's own ${show(mirrored)}`,
    )
  }
  // ...and it is let go at the elbow raise: the balance key authors the throwing
  // arm's own place, so the cock — and everything after it — is the arm's own work.
  //
  // Read as each arm's own *shape* — its elbow's offset from the socket it hangs
  // from — and not as two places in the rig. The two arms are authored in different
  // frames (the throwing arm is a place the keys write outright, the glove an offset
  // from its own shoulder in the chest's frame), so the two *places* swing together
  // and apart as the body turns under them: at the break, with the body already two
  // thirds of the way round the plate, the lead elbow's own mirror of its place
  // lands within a hand's width of the throwing elbow's while the two arms are
  // nothing like each other — one hanging a quarter of a unit under its own socket
  // and the other raised to within a few centimetres of its own.
  const shapeOf = (pose, side) => {
    const arm = armOf(pose, side)
    return arm.elbow.map((value, axis) => value - shoulderOf(pose, side)[axis])
  }
  const mirrorShape = (pose, offset) => {
    const centre = chestOf(pose)
    const lateral = shoulderOf(pose, 1).map((value, axis) => value - centre[axis])
    const length = Math.hypot(...lateral)
    const normal = lateral.map((value) => value / length)
    const along = offset[0] * normal[0] + offset[1] * normal[1] + offset[2] * normal[2]
    return offset.map((value, axis) => value - 2 * along * normal[axis])
  }
  for (const t of [0.8, 1.0]) {
    const pose = pitcherPose(t, ctx())
    const gap = distance(mirrorShape(pose, shapeOf(pose, -1)), shapeOf(pose, 1))
    assert.ok(
      gap > 0.2,
      `at ${t}s the trail arm is still the lead arm's mirror, to ${gap.toFixed(3)} of the arm's own shape`,
    )
  }
})

test('the shoulders are square before the arm unwinds', () => {
  // A throw's power is a chain: the pelvis turns, the torso is handed that turn and
  // turns the shoulders, and the arm comes round last of all — so by the time the
  // hand starts down and through, the body it is thrown by is already facing the
  // plate. What that reads as here: the frame the chest comes square on is a frame
  // the arm is still cocked at, with the pelvis a good way past it.
  const release = pitcherPose(AUTHORED_RELEASE_TIME, ctx())
  let square = null
  for (let t = 1.2; t <= AUTHORED_RELEASE_TIME + 1e-9; t += 1 / 240) {
    const pose = pitcherPose(t, ctx())
    if (pose.hip.yaw + pose.torsoYawExtra > -0.02) {
      square = { t, pose }
      break
    }
  }
  assert.ok(square, 'the chest never comes square on the plate')
  assert.ok(
    square.pose.ball[2] > release.ball[2] + 0.15,
    `at ${square.t}s the shoulders squared with the arm already through: the ball was at ${square.pose.ball[2]}, the release at ${release.ball[2]}`,
  )
  assert.ok(
    square.pose.hip.yaw - (square.pose.hip.yaw + square.pose.torsoYawExtra) > 0.15,
    'the shoulders squared with the pelvis still behind them',
  )
  assert.ok(square.pose.hip.yaw > 0.1, 'the pelvis was not past square either')
})

test('the delivery stretches with the release clock', () => {
  // The app syncs the pitch to the tuning's own release time, and the delivery is
  // authored on its own clock: a tuning that moves the release has to move the
  // whole delivery by the same factor, or the ball appears while the arm is still
  // cocked.
  for (const k of [0.6, 1.5, 2.2]) {
    const releaseTime = AUTHORED_RELEASE_TIME * k
    for (const t of TIMES) {
      const stretched = pitcherPose(t * k, ctx({ releaseTime }))
      const authored = pitcherPose(t, ctx())
      assert.ok(
        distance(stretched.ball, authored.ball) < 1e-9,
        `at ${t}s (x${k}) the ball is ${show(stretched.ball)}, not ${show(authored.ball)}`,
      )
      assert.ok(Math.abs(stretched.hip.yaw - authored.hip.yaw) < 1e-9)
      assert.ok(Math.abs(stretched.arms[0].curl - authored.arms[0].curl) < 1e-9)
    }
  }
})

test('the idle is the set stance, breathing', () => {
  // What the pitcher does between pitches is the pose the delivery starts from, so
  // the windup cannot begin from anywhere but where he was standing.
  const set = pitcherPose(0, ctx())
  assert.deepEqual(pitcherIdle(0, ctx()), set)
  const wave = pitcherIdle(1, ctx())
  assert.notEqual(wave.hip.offsetY, set.hip.offsetY, 'the stance does not breathe')
  assert.ok(Math.abs(wave.hip.offsetY - set.hip.offsetY) < 0.02, 'the breath is a breath')
  for (let leg = 0; leg < set.legs.length; leg += 1) {
    assert.deepEqual(wave.legs[leg].ankle, set.legs[leg].ankle, 'a breathing stance moves its feet')
  }
})

test('the blend crosses between two poses without leaving them', () => {
  // The cross-fade between the idle and the delivery is a blend of joint targets,
  // and both ends are the set stance where they meet: 0 and 1 are the poses
  // themselves, and everything between is between them.
  const idle = pitcherIdle(0.6, ctx())
  const pitch = pitcherPose(AUTHORED_RELEASE_TIME, ctx())
  assert.equal(blendPose(idle, pitch, 0), idle)
  assert.equal(blendPose(idle, pitch, 1), pitch)
  const half = blendPose(idle, pitch, 0.5)
  for (const axis of [0, 1, 2]) {
    // The blend's own arithmetic is ``x + (y - x) * k`` rather than the midpoint,
    // which is the midpoint to within a bit of floating point.
    assert.ok(Math.abs(half.ball[axis] - (idle.ball[axis] + pitch.ball[axis]) / 2) < 1e-12)
  }
  assert.equal(half.arms.length, idle.arms.length)
  assert.equal(half.legs.length, idle.legs.length)
  // The ground's own rule is part of the pose and crosses over with the rest of
  // it: a blended frame is a frame the driver poses, so a blend that dropped the
  // flag would answer "this foot is being carried" about a foot standing on the
  // dirt, and the shoe would be free to sink into it for as long as the cross-fade
  // lasts (the driver only holds up a foot it was told is planted).
  for (let leg = 0; leg < half.legs.length; leg += 1) {
    assert.equal(typeof half.legs[leg].planted, 'boolean', 'a blended leg should carry the ground rule')
  }
  const stance = blendPose(pitcherIdle(0.3, ctx()), pitcherPose(0, ctx()), 0.5)
  for (const leg of stance.legs) {
    assert.equal(leg.planted, true, 'a blend of two set stances stands on the ground')
  }
  for (let arm = 0; arm < half.arms.length; arm += 1) {
    const low = Math.min(idle.arms[arm].curl, pitch.arms[arm].curl)
    const high = Math.max(idle.arms[arm].curl, pitch.arms[arm].curl)
    assert.ok(half.arms[arm].curl >= low && half.arms[arm].curl <= high)
    const from = idle.arms[arm].hand ?? idle.arms[arm].local
    const to = pitch.arms[arm].hand ?? pitch.arms[arm].local
    for (const axis of [0, 1, 2]) {
      const between = half.arms[arm].hand ?? half.arms[arm].local
      assert.ok(between[axis] >= Math.min(from[axis], to[axis]) - 1e-9)
      assert.ok(between[axis] <= Math.max(from[axis], to[axis]) + 1e-9)
    }
  }
})

test('he lands standing in the pose he holds, and nothing moves across the hold', () => {
  // There is no *give* in this finish: the body comes up out of the stride's fold
  // *into* the frame the trail foot lands in, and the pose that frame carries is the
  // pose he stands in for the rest of the beat. The rise is the swing's own — the tail
  // keys carry the pelvis up a tenth of a rig unit over the last tenth of a second (see
  // the sequence's own note) — because a leg is a fixed length: it can only be straight
  // in the frame its foot plants in if the pelvis is already over it by then, and a
  // pelvis that arrives low and stands up afterwards is a knee that gives under the
  // weight (which is what this delivery used to do and what the landing is now authored
  // not to). What this checks is the *lever*: the pelvis is on its way up all the way
  // to the landing, the landing frame *is* the hold's frame, both feet are on the
  // ground with nothing hanging off a knee, and nothing moves across the hold.
  const pelvis = (t) => pitcherPose(t, ctx()).hip.offsetY
  const tail = [1.575, 1.61, 1.6275, 1.645, 1.6625, 1.68]
  const climb = tail.map(pelvis)
  for (let i = 1; i < climb.length; i += 1) {
    assert.ok(
      climb[i] > climb[i - 1],
      `the pelvis is not on its way up at ${tail[i]}s: it dips into the landing`,
    )
  }
  assert.ok(
    pelvis(1.68) - pelvis(1.575) > 0.08,
    `the pelvis only comes up ${(pelvis(1.68) - pelvis(1.575)).toFixed(3)} of a rig unit out of the stride's fold`,
  )
  // ...and the frame the foot lands in is the frame the hold keeps, to the thousandth:
  // the give this replaces was 0.020 of a rig unit of pelvis and 4° of knee, and what
  // took it out was moving that travel *into* the swing's tail.
  const landing = pitcherPose(1.68, ctx())
  const hold = pitcherPose(1.9, ctx())
  for (const place of ['offsetY', 'offsetZ', 'yaw']) {
    assert.ok(
      Math.abs(landing.hip[place] - hold.hip[place]) < 1e-9,
      `the pelvis' ${place} moves ${(hold.hip[place] - landing.hip[place]).toFixed(6)} between the landing and the hold`,
    )
  }
  // Both feet are the pitcher's own in the frame he lands in: a finish that plants one
  // foot and leaves the other hanging off its knee is a body leaning on the drive leg
  // rather than standing on its own two feet.
  for (const leg of [...landing.legs, ...hold.legs]) {
    assert.equal(leg.planted, true, 'a foot of the finish is off the ground')
    assert.equal(leg.hang, 0, 'a foot of the finish hangs off its knee')
  }
  // ...and across the hold nothing moves at all: the keys either side of it are the same
  // numbers, so the frame he is left standing in is the frame the delivery ends in, down
  // to the last place he stands on.
  const end = pitcherPose(2.8, ctx())
  const settled = (pose) => [
    pose.hip.offsetY, pose.hip.offsetZ, pose.hip.yaw,
    ...pose.legs.flatMap((leg) => [...leg.ankle, ...leg.knee]),
  ]
  const held = settled(hold)
  const ended = settled(end)
  for (let i = 0; i < held.length; i += 1) {
    assert.ok(
      Math.abs(held[i] - ended[i]) < 1e-9,
      `the ${i}th number of the held finish moves ${(ended[i] - held[i]).toFixed(6)} across the hold`,
    )
  }
})

test('the throwing arm lets the throw go: it hangs limp and straight beside the body', () => {
  // What the arm does once the pitch is over. The landing is the pose the throw left it
  // in — the hand down across the *front* of the body, the upper arm reaching forward
  // off a bent elbow, which is what a follow-through *is* — and the hold is the arm the
  // throw has finished with: straight (the chord from its own socket to the wrist all
  // but the whole of the arm's span), hanging (that chord and the pole that shapes the
  // elbow both down beside the body rather than out in front of it), and limp, which at
  // this level is the hand's own line *run on down the arm* rather than left cocked off
  // it: the aim the key writes is the direction the forearm really takes, so the driver
  // has no wrist to fold back on to its bones (the realised bend is the browser suite's
  // to read — 1° at the hold against 27° at the landing).
  const span = RIG.arm.upper + RIG.arm.fore
  const armOf = (t) => {
    const pose = pitcherPose(t, ctx())
    const arm = pose.arms[0]
    const socket = shoulderOf(pose, arm.side)
    const wrist = arm.hand
    const chord = [wrist[0] - socket[0], wrist[1] - socket[1], wrist[2] - socket[2]]
    const length = Math.hypot(...chord) || 1
    // How much of the pole's own direction is *horizontal*: an upper arm reaching out
    // in front of the body is a pole leaning away from the vertical, and one hanging
    // at the side of it is not.
    const pole = [arm.elbow[0] - socket[0], arm.elbow[1] - socket[1], arm.elbow[2] - socket[2]]
    const poleLength = Math.hypot(...pole) || 1
    const aim = lineOf(pose, arm)
    return {
      chord: length,
      down: socket[1] - wrist[1],
      lean: Math.hypot(pole[0], pole[2]) / poleLength,
      // ...and how much of the hand's own line is *down*: a limp hand hangs along the
      // arm it is on.
      droop: -aim[1],
    }
  }
  const landing = armOf(1.68)
  const hold = armOf(1.9)
  const ended = armOf(2.8)
  // The throw's own arm: bent, and reaching out in front of the body with the hand
  // across it.
  assert.ok(
    landing.chord < span * 0.95 && landing.lean > 0.35,
    `the landing's arm is ${(landing.chord / span).toFixed(2)} of its span out with its elbow leaned ${landing.lean.toFixed(2)} off the vertical: the follow-through never crossed the body`,
  )
  // ...and the arm the throw has finished with: opened most of the way to the span,
  // hanging with the hand level with the thigh, and at the side of the body.
  assert.ok(
    hold.chord > landing.chord + 0.02 && hold.chord > span * 0.96,
    `the arm only opens to ${hold.chord.toFixed(3)} of a ${span.toFixed(3)} span (from ${landing.chord.toFixed(3)})`,
  )
  assert.ok(
    hold.lean < 0.25,
    `the hold's upper arm is still leaned ${hold.lean.toFixed(2)} off the vertical: the elbow is out in front of the body`,
  )
  assert.ok(
    hold.down > 0.5 && hold.down < 0.6,
    `the hand hangs ${hold.down.toFixed(3)} below its own socket: not beside the body`,
  )
  assert.ok(hold.droop > 0.8, `the hand's own line hangs only ${hold.droop.toFixed(2)} of the way down`)
  // ...and it is held: the arm does not come up out of the hold the way it will on the
  // way back to the set (see the recovery key, where it is doing something again).
  for (const part of ['chord', 'lean', 'down', 'droop']) {
    assert.ok(
      Math.abs(ended[part] - hold[part]) < 1e-9,
      `the arm's ${part} moves ${(ended[part] - hold[part]).toFixed(6)} across the hold`,
    )
  }
})
