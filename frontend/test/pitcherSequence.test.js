import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARM_ANGLE_BAND,
  AUTHORED_CLIP_END,
  AUTHORED_DRIVE_TIME,
  AUTHORED_LANDING_TIME,
  AUTHORED_LOOK_LOCK_TIME,
  AUTHORED_LOOK_SWEEP_TIME,
  AUTHORED_RELEASE_HEIGHT,
  AUTHORED_HANDOFF_TIME,
  AUTHORED_RELEASE_TIME,
  AUTHORED_SLOT_END,
  AUTHORED_ZONE_TIME,
  PIVOT_AHEAD,
  PIVOT_BEHIND,
  PIVOT_SIDE,
  PROPORTION_BANDS,
  RELEASE_ELBOW,
  RUBBER_Y,
  STANCE_DIP_MAX,
  STANCE_SIDE_MAX,
  TILT_LANDING_SHARE,
  STATURE_BAND,
  STRIDE_BAND,
  TRUNK_TILT_MAX,
  armAngle,
  blendPose,
  clampProportions,
  headTrackShare,
  pitcherIdle,
  pitcherPlacement,
  pitcherPose,
  pitcherProfile,
  pitcherRelease,
  releaseCarry,
  releaseLean,
  releasePosture,
  releaseShoulderShare,
  stanceDip,
  straightChord,
  statureOf,
  rollLift,
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
  // The boot's own two ends against the ankle, as measurePlayerRig reads them off the
  // model's skin: the shoe runs 0.1384 of a rig unit to the toe bone and 0.0997 the other
  // way to the rear of its own leather. Only the rear one does any work here — it is what
  // a planted shoe turns about once the body comes round over it (see FRONT_HEEL_SWEEP
  // in util/pitcherSequence.js) — and the lateral five millimetres the left boot's own
  // rear carries are left where they were measured: the turn is about a point on the
  // shoe's own line, and the two boots are each other's mirror anyway.
  toeOffset: { x: 0, y: -0.0685, z: -0.1203 },
  heelOffset: { x: -0.0053, y: -0.0953, z: 0.0997 },
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
  0, 0.46, 0.8, 1.0, 1.05, 1.12, 1.2, 1.26, 1.3, AUTHORED_RELEASE_TIME, 1.42, 1.62,
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

test('the release socket is measured from the pivot the driver hinges the whole upper body on', () => {
  // The release anchor is the one place in the pose that is a *world* place the driver
  // has to land on, so it is the one place the pose's own estimate of the chest cannot
  // be wrong — and the driver hinges the upper body on the *spine*, not on the hip
  // sockets the legs hang from (see `torsoPivot`, and measurePlayerRig's own hipY/hipZ,
  // which is where the pivot the driver really turns about is read from). Built off
  // the hip sockets — which is what it was — the socket comes out a couple of
  // centimetres from the body the driver builds, the arm is asked for its straightest
  // chord from that phantom socket, and the elbow folds to hold a wrist the body has
  // already reached: measured at the release, 2.8 cm of socket and 24 degrees of
  // elbow, where the ask was the chord.
  //
  // The pin is the placement itself, against the one place the driver can be read: a
  // rig is handed a pivot a hand's width off its hip sockets, and the pose's own
  // shoulder has to come out where rotating the chest's offset about *that* pivot puts
  // it — and a centimetre or more from where the hip sockets put it, which is the whole
  // of what a silent return to them costs.
  const rig = { ...RIG, hipY: RIG.hip.y - 0.041, hipZ: RIG.hip.z + 0.023 }
  const height = AUTHORED_RELEASE_HEIGHT
  const posture = releasePosture({ rig, hand: 'R', height })
  // The rotation the anchor is read through is the pose's *own*, handed back rather than
  // re-authored here (see `releasePosture`'s ``turn``): it is the release key's own chest
  // turn — the square-on-the-plate one the delivery is authored with (see the assembly's
  // own note on that frame) — and the fold the slot solves. A stub written beside the
  // test drifts the moment the delivery is re-authored, and this one is the whole point
  // of the pin: the shoulder has to come out where *that* rotation about the pivot puts it.
  const swing = (pivot) => turnVector(
    posture.turn,
    [0, rig.shoulder.y - pivot.y, rig.shoulder.z - pivot.z],
  )
  const about = swing({ y: rig.hipY, z: rig.hipZ })
  const sockets = swing({ y: rig.hip.y, z: rig.hip.z })
  assert.ok(
    Math.hypot(
      posture.shoulder.x - about[0],
      posture.shoulder.y - (rig.hipY + about[1]),
      posture.shoulder.z - (rig.hipZ + about[2]),
    ) < 1e-12,
    'the release shoulder is not the chest offset rotated about the torso pivot',
  )
  assert.ok(
    Math.hypot(
      posture.shoulder.y - (rig.hip.y + sockets[1]),
      posture.shoulder.z - (rig.hip.z + sockets[2]),
    ) > 0.01,
    'the release shoulder is where the hip sockets put it: the pivot has been lost again',
  )
})

test('the wrist the pose asks for carries the ball the release’s own carry down the hand line', () => {
  // The driver puts the wrist where the pose asks and carries the ball down the
  // hand's own line from there by whatever carry the pose hands it (see
  // solveOpenArm's ball). The pose has to solve the inverse of that, or the anchor
  // above is a carry out — and at the release the carry is the *release's* own: the
  // arm is handed a straighter chord than the model's own limit (see RELEASE_ELBOW),
  // and the reach that adds comes back out of the carry, so the ball goes on riding
  // the release point the anchor was placed at while the wrist stands the straighter
  // chord from the socket it hangs off.
  const palm = releaseCarry(RIG, 'R')
  const give = straightChord(RIG.arm.upper, RIG.arm.fore, RELEASE_ELBOW)
    - straightChord(RIG.arm.upper, RIG.arm.fore)
  for (const height of HEIGHTS) {
    const pose = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height }))
    const { hand: wrist, aim, carry } = pose.arms[0]
    assert.ok(Math.abs(Math.hypot(...aim) - 1) < 1e-12, 'the aim is not a unit line')
    assert.ok(
      Math.abs(carry - (palm - give)) < 1e-12,
      `the release hands the driver a carry of ${carry}, not the release's own ${palm - give}`,
    )
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
  // release is the *posture's* — solved from the slot's own arm angle (see
  // `releasePosture`), not authored — and a higher slot stands the body further up
  // out of it.
  const forward = []
  let folded = Infinity
  for (const height of HEIGHTS) {
    const pose = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height }))
    const posture = releasePosture({ rig: RIG, hand: 'R', height })
    // The release key carries the whole of the posture (its own ``slot`` weight is
    // one there), so the pose's fold is the solved one outright.
    assert.ok(
      Math.abs(pose.hip.fold - posture.lean) < 1e-9,
      `at ${height} the body leans ${pose.hip.fold}, not the posture's ${posture.lean}`,
    )
    // ...and the posture is monotone in the slot: a taller release is a shallower
    // fold, all the way up the band.
    assert.ok(
      pose.hip.fold < folded - 1e-9,
      `a taller slot folded deeper: ${folded} -> ${pose.hip.fold}`,
    )
    folded = pose.hip.fold
    forward.push(pose.ball[2])
  }
  for (let i = 1; i < forward.length; i += 1) {
    assert.ok(
      forward[i] > forward[i - 1] - 1e-9,
      `a taller slot reached further forward: ${forward[i - 1]} -> ${forward[i]}`,
    )
  }
  // The band's own ends: a low slot folds the trunk most of a right angle over the
  // hips, and an over-the-top one stands it up out of the fold entirely.
  const low = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height: HEIGHTS[0] })).hip.fold
  const high = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height: HEIGHTS[HEIGHTS.length - 1] })).hip.fold
  assert.ok(low > 0.55, `the bottom of the band folds only ${low}`)
  assert.ok(high < 0, `the top of the band still folds ${high} forward`)
})

test('the keys are authored for the reference height they claim', () => {
  // AUTHORED_RELEASE_HEIGHT is the height the keys' own leans were written for, so
  // the authored shape is that height's own — and the reference is *derived* from the
  // release key's lean (see the constants), so the two cannot drift: the height whose
  // authored slot lean is the key's lean.
  // ...and the key's own lean is the *deepened* release fold (the reference's PS-12:
  // the trunk bent further forward at the end of the release than the old 0.57), which
  // is what the derivation above is pinned to.
  assert.ok(
    Math.abs(releaseLean(AUTHORED_RELEASE_HEIGHT) - 0.92) < 1e-9,
    `the reference height's own lean is ${releaseLean(AUTHORED_RELEASE_HEIGHT)}`,
  )
  // What the *delivery* stands at there is the solved posture's fold, not the
  // authored track's: the keys carry the shape, and the slot's own arm angle is what
  // the trunk comes out of. The two are different numbers, which is the whole point
  // of the posture being solved — so the release frame has to hold the solved one.
  const pose = pitcherPose(AUTHORED_RELEASE_TIME, ctx({ height: AUTHORED_RELEASE_HEIGHT }))
  const posture = releasePosture({ rig: RIG, hand: 'R', height: AUTHORED_RELEASE_HEIGHT })
  assert.ok(
    Math.abs(pose.hip.fold - posture.lean) < 1e-9,
    `the reference height stands at ${pose.hip.fold}, not the posture's ${posture.lean}`,
  )
  // ...and the solved fold is *not* the authored one, or the solve would be a
  // no-op: the reference slot is high enough to stand the body up out of the keys'
  // own fold.
  assert.ok(
    posture.lean < releaseLean(AUTHORED_RELEASE_HEIGHT) - 0.1,
    `the reference height's solved fold (${posture.lean}) is the authored one (${releaseLean(AUTHORED_RELEASE_HEIGHT)})`,
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
  // own body turns at something like 900 degrees a second through the stride and
  // better than twenty-five hundred on the throw itself (a violent delivery is thrown
  // by a body that snaps), which is 0.13 and 0.36 rad in a frame this size — so the bound
  // is the delivered clip's own speed rather than a fraction of the figures below, and
  // what it is there to catch is a track that steps rather than turns. The fastest frames
  // the clip makes are the release's own: the pelvis's yaw 0.186 rad in a frame (1281
  // degrees a second) and the trunk's own fold, carried back through the body's turn,
  // 0.210 (1442) — and they arrive at the end of a ramp that has been climbing through
  // the plant and the cock rather than at a crest inside the stride (see the keys' own
  // note on the burst's rate).
  //
  // The ball's and the arm's are the throw's own: the hand is *whipped* — most of a rig
  // unit of travel across the two frames before the ball goes, which is 0.349 of a rig
  // unit in a frame of this size, or 42 rig units a second at the hand — and that is not a
  // style: a 94 mph four-seamer *is* 42 rig units a second (see ZONE_FLIGHT, which is
  // this delivery's own flight), so the last two frames of the whip carry the ball at
  // the speed the pitch itself leaves at. A delivery authored with a longer cock-and-throw
  // path would spend the same frames moving the hand less; this one spends them on the
  // snap, and the bound is that snap's own number rather than the old 0.24, a figure that
  // was the previous, gentler throw's measurement.
  //
  // The *arm's* own bound is the wrist's rather than the ball's, and it is the larger
  // of the two for a reason the release now makes plain: the wrist is the ball less the
  // carry down the *hand's own line* (see the pose's ``hand``), and that line turns
  // through the throw — at the cock the hand is still cocked back off the arm, and by
  // the release a straight arm's hand runs on down the line the arm reaches along (see
  // `writeReleaseArm`). So the wrist carries the young throw's own rotation as well as
  // its travel, and the measured worst frame moves it 0.411 of a rig unit against the
  // ball's 0.349 — 49 rig units a second at the wrist against 42 at the ball, which is
  // what a hand at the end of a whip does. Anything below the ball's own 0.36 would
  // make the release's straight line impossible to reach.
  //
  // The foot's belongs to the swing's own tail: the trail leg comes round and *down*
  // onto its landing in the last two keys, and where that landing is nearer the lead
  // foot the same swing has less room to put the foot in. Measured at 12.8 rig/s over
  // the last two keys (the swing's own speed before that is under 5; the stride's own
  // reach is 12), which is 0.13 in a frame of this size — so the bound is 0.14.
  const bounds = { ball: 0.36, arm: 0.45, foot: 0.14, angle: 0.22 }
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
  const balance = pitcherPose(1.0, ctx())
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
  const breakAt = since(pitcherPose(1.12, ctx()))
  assert.ok(
    breakAt.thigh > breakAt.hip && breakAt.hip > breakAt.chest,
    `at the break the thigh has turned ${(breakAt.thigh * DEG).toFixed(1)}°, the pelvis ` +
      `${(breakAt.hip * DEG).toFixed(1)}° and the chest ${(breakAt.chest * DEG).toFixed(1)}°: the turn is not running up the chain from the hip`,
  )
  const plant = since(pitcherPose(1.2, ctx()))
  assert.ok(
    plant.hip > plant.thigh,
    `at the plant the pelvis has turned ${(plant.hip * DEG).toFixed(1)}° against the thigh's ` +
      `${(plant.thigh * DEG).toFixed(1)}°: the hip did not hand the turn over to the body`,
  )
  for (const t of [1.12, 1.2, 1.26, AUTHORED_RELEASE_TIME]) {
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
  // The foot's own *arrival* is read at the release rather than at the plant: the kick
  // is carried longer than it was — the leg hangs off its knee while the body turns
  // under it and only comes down into the step from about the break (see the front
  // foot's own notes in the assembly), so through the plant and the cock the pose's
  // ankle is still the carried leg's own place rather than the place it plants on.
  // Reads the *realised* model the same way at the same time (see the browser suite's
  // stride).
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
  // ...and what that turn is authored *to* has two halves: the shoulders are square on
  // the plate at the frame the ball goes — the chest's own turn there is the couple of
  // degrees the trunk's fold costs the bearing, and the last of the coil is spent on the
  // two frames before it — and the opening past the line is the follow-through's, where
  // the chest carries on past the plate by a good share of a right angle under a hand
  // that has already let the ball go. What leads through the release is the *pelvis*: it
  // is a hand's width past the chest at the release and the shoulders ride round after
  // it, which is the order the body's own turn is thrown in.
  assert.ok(
    Math.abs(chest(AUTHORED_RELEASE_TIME)) < 0.06 && chest(1.42) > 0.85,
    `the chest is ${(chest(AUTHORED_RELEASE_TIME) * DEG).toFixed(0)}° off the line at the release and ` +
      `${(chest(1.42) * DEG).toFixed(0)}° over the follow-through: the shoulders are not square on the plate`,
  )
  assert.ok(
    hip(AUTHORED_RELEASE_TIME) - chest(AUTHORED_RELEASE_TIME) > 0.15,
    `the pelvis is only ${((hip(AUTHORED_RELEASE_TIME) - chest(AUTHORED_RELEASE_TIME)) * DEG).toFixed(0)}° past the shoulders at the release`,
  )
  // And the *lead arm* is what opens them: the glove hand has crossed the body's own
  // line by the high cock, with the chest still a good way closed, and the chest's
  // biggest turn comes after that cross rather than before it.
  const gloveX = (t) => gloveOf(pitcherPose(t, ctx())).wrist[0]
  assert.ok(
    gloveX(1.26) < gloveX(1.2) - 0.08,
    `the lead hand is at ${gloveX(1.26).toFixed(3)} at the high cock against ${gloveX(1.2).toFixed(3)} at the plant: it did not cross the body`,
  )
  const toTheCock = chest(1.26) - chest(1.2)
  const pastIt = chest(1.42) - chest(1.26)
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
  for (let t = 1.12; t <= AUTHORED_CLIP_END + 1e-9; t += 0.02) {
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
    // Signed: the forward fold is toward the plate (the rig's -z), and the trunk now
    // folds *back* as the back leg fires (see the drive keys), which an unsigned angle
    // cannot read — ``acos`` reports a -3° back lean as +3°.
    const tilt = Math.atan2(-up[2], up[1]) * DEG
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
  // ...and the fold is still *deep* by the frame the trail foot lands in, though no longer
  // the whole of it: the trunk comes over the front foot at the crossing and the stand leaves
  // that top on the next frame (see holdShareAt), so the landing stands in 33.7° of the
  // 60.2° the finish was thrown into — a little under the keys' own deepest frame (39.2° at
  // the release) and over half of every other frame the beat has, and deep enough that the
  // legs can stand it because the hips give under the trunk as it comes over them (see
  // FINISH_SINK, and the pose's own leg test, which reads every foot against its own socket
  // at every height). The stand is paced at two and a half times the keys' own tail
  // (STAND_PACE), so the crossing's top is spent faster than the fold was reached and the
  // landing catches 33.7° where the keys' own pace left 48°; the pace is the reason the
  // landing no longer stands in more fold than the release does. What the test still holds
  // is that the finish's fold is not given back before the shoe is down: the landing is
  // still better than halfway over the front foot, and the stand has a second of the beat
  // and the whole of the recovery still to spend.
  const landed = pitcherPose(1.68, ctx())
  assert.ok(
    landed.hip.fold > 0.5,
    `the trunk is folded ${(landed.hip.fold * DEG).toFixed(0)}° when the foot lands: the fold is given back on the frames he lands on`,
  )
  // ...and the plant is *behind* upright: as the back leg fires the trunk tilts back over
  // the drive foot (the drive keys' own back tilt, which the lean-in walk does not reach
  // yet), and the forward fall that carries the body over the foot comes after it, so
  // the fold the pitch is thrown from is reached by the release rather than at the plant.
  const planted = pitcherPose(1.2, ctx()).hip.fold
  assert.ok(
    planted < 0,
    `the plant is folded ${(planted * DEG).toFixed(0)}°: the trunk does not tilt back as the back leg fires`,
  )
  assert.ok(
    planted < thrown.hip.fold,
    `the plant is already folded the whole of the release's ${(thrown.hip.fold * DEG).toFixed(0)}°: the last of the lean-in is not the release's own`,
  )
})

test('the lean is walked in from the kick, and it is settled by the time the ball goes', () => {
  // The forward lean's own clock, which is longer than the release window's by design:
  // a delivery that has to lean over the plate leans *in* — the trunk starts coming
  // forward as the front leg does, and it is a body already over the plate that throws
  // rather than one stood up and then laid over on the last of the stride (see
  // LEAN_IN_TRACK, and the keys' own notes). Read off the pose's own fold, frame by
  // frame, because what "more time for the lean-in" is worth is a shape: a fold that
  // rises from the rocker to the fire, comes *back* over the drive foot as the back leg
  // fires, and then falls into the pitch's own through the plant — a rate that is the
  // walk's own rather than a jump on any frame of it.
  const DEG = 180 / Math.PI
  const foldAt = (t) => pitcherPose(t, ctx()).hip.fold
  const frame = 1 / 60
  const rocker = 0.46   // the rocker key: the last frame the stride foot stands on the dirt
  // The set is upright and the rocker is the *keys'* own fold — the rock-back's couple of
  // degrees and nothing of the pitch's: the lean-in's own clock has not started while the
  // stride foot is still standing on the dirt.
  for (const t of [0, 0.3, rocker]) {
    assert.ok(
      foldAt(t) - foldAt(0) < 0.11,
      `at ${t}s the trunk is already ${((foldAt(t) - foldAt(0)) * DEG).toFixed(1)}° into a lean of the pitch's own`,
    )
  }
  // ...and from there it only rises: every frame of the kick, the balance, the drive and
  // the release is a frame the trunk is further into the pitch than the last.
  // The fall to the plant: the trunk tilts *back* from the very frame the torso starts
  // falling forward (the reference's PS-1 — the lean-back is as early as the fall, not
  // saved for the back leg's own fire) and only then falls forward over the drive foot
  // (see the drive keys), so that window is the one place the fold is allowed to come
  // back out. It is read for its own shape below.
  const BACK_TILT_START = 1.0
  const BACK_TILT_END = 1.2
  // ...and the *other* frame it is allowed to come back out on is the gather, on the two
  // hundredths of a second before the ball: the finish's own clock is already running there
  // (see FINISH_RIP_LEAD) and what it does is ease the trunk a degree or two *off* the
  // posture it is held at and gather, so that the rip crosses the release at the whip's own
  // rate rather than setting off from it. That is the finish's movement rather than the
  // walk's, so it is read apart from the lean-in and *bounded* rather than forbidden: the
  // lean-in's own promise is that the fold has arrived, and it is whole on the frame the
  // ball goes (the fall test below holds it to the solved posture to the decimal there, and
  // reads the gather's own depth).
  const GATHER_FROM = AUTHORED_RELEASE_TIME - 0.02
  let was = foldAt(rocker)
  let steepest = 0
  let steepestAt = rocker
  let climbs = 0
  for (let t = rocker + frame; t <= AUTHORED_RELEASE_TIME + 1e-9; t += frame) {
    const now = foldAt(t)
    if (t > BACK_TILT_START + 1e-9 && t <= BACK_TILT_END + 1e-9) {
      steepest = Math.max(steepest, Math.abs(now - was))
      was = now
      continue
    }
    if (t > GATHER_FROM + 1e-9) {
      const off = foldAt(AUTHORED_RELEASE_TIME) - now
      assert.ok(
        off < 0.055,
        `at ${t.toFixed(3)}s the trunk is ${(off * DEG).toFixed(1)}° off the posture it is handed: deeper than the gather the finish's own clock asks for`,
      )
      was = now
      continue
    }
    assert.ok(
      now >= was - 1e-9,
      `at ${t.toFixed(2)}s the trunk comes back out of the lean: ${(was * DEG).toFixed(1)}° then ${(now * DEG).toFixed(1)}°`,
    )
    if (now - was > steepest) { steepest = now - was; steepestAt = t }
    if (now > was + 1e-9) climbs += 1
    was = now
  }
  // ...on most of the frames it spends (a lean-in is a motion, not a pose), and never so
  // fast that a single frame of it is a step: the window this used to be is a sixtieth of
  // a second seventy-five degrees deep, which is the snap this replaced.
  assert.ok(
    climbs > 0.6 * ((AUTHORED_RELEASE_TIME - rocker) / frame),
    `the trunk stands still for all but ${climbs} of the lean-in's own frames`,
  )
  // The fall over the drive foot is the fastest motion in the window: the trunk comes from
  // the back tilt through the fall at its steepest about 14.8° a frame at 60 fps (~885°/s,
  // at 1.18s), which is a trunk being thrown rather than a step. This is the *deeper* arch
  // the reference pitch bows back over the rubber — most of the way to a right angle of
  // back-tilt at its plant — and the bound is set for that depth's own fall: the shallow
  // arch's 10.7° a frame was its number, and the bound is that fall's ceiling rather than
  // a snap's floor. It still rules out the 75°-in-a-sixtieth step this test replaced (a
  // real snap is five times this), so what it holds is "thrown, not teleported".
  assert.ok(
    foldAt(BACK_TILT_END) < 0,
    `the trunk is folded ${(foldAt(BACK_TILT_END) * DEG).toFixed(1)}° at the plant: it does not tilt back as the back leg fires`,
  )
  assert.ok(
    steepest * DEG < 16,
    `the lean moves ${(steepest * DEG).toFixed(2)}° in one frame (at ${steepestAt.toFixed(3)}s): it is a step rather than a walk-in`,
  )
  // ...and it is a *walk-in* by the time the knee is at the top of the kick: the trunk is
  // a couple of degrees further into the pitch at the gather than it was at the rocker,
  // which is what "the lean begins as the leg does" means as a number.
  assert.ok(
    foldAt(0.8) - foldAt(rocker) > 0.02,
    `the top of the kick is only ${((foldAt(0.8) - foldAt(rocker)) * DEG).toFixed(1)}° further into the lean than the rocker`,
  )
  assert.ok(
    foldAt(1.0) > foldAt(0.8),
    `the trunk stops leaning between the gather and the balance: ${(foldAt(0.8) * DEG).toFixed(1)}° then ${(foldAt(1.0) * DEG).toFixed(1)}°`,
  )
  // ...and the release's frame is the *posture's* own fold — the slot's solved one, the
  // lean-in's share whole there and nowhere earlier — and it is held whole for the whole
  // of the window the ball rides the anchor on, because the anchor is built on it (see
  // SLOT_TRACK and AUTHORED_SLOT_END).
  const solved = releasePosture({ rig: RIG, hand: 'R', height: 1.85 }).lean
  assert.ok(
    Math.abs(foldAt(AUTHORED_RELEASE_TIME) - solved) < 1e-9,
    `the release stands in ${(foldAt(AUTHORED_RELEASE_TIME) * DEG).toFixed(1)}° where the slot solved ${(solved * DEG).toFixed(1)}°`,
  )
  for (const t of [1.42, 1.48, AUTHORED_SLOT_END]) {
    assert.ok(
      foldAt(t) > foldAt(AUTHORED_RELEASE_TIME) + 0.02,
      `the trunk stops folding at ${t}s: ${(foldAt(t) * DEG).toFixed(1)}° against the release's ${(foldAt(AUTHORED_RELEASE_TIME) * DEG).toFixed(1)}°`,
    )
  }
  // ...and the *follow-through* goes on folding over the front foot after the ball has
  // gone, which is the finish's own share of the fold (see FINISH_TILT): the body is
  // thrown after the pitch rather than stopping at the posture it threw from, and the
  // deepest frame of the delivery's fold is the finish's, not the release's.
  assert.ok(
    foldAt(1.48) > foldAt(1.42) + 0.02,
    `the finish folds ${(foldAt(1.48) * DEG).toFixed(1)}° at 1.48s against ${(foldAt(1.42) * DEG).toFixed(1)}° at 1.42s: the body is not being thrown after the ball`,
  )
  // ...and the *finish* is that fold thrown rather than reached: it goes on over the front
  // foot with the whip and tops out on the frame the back foot sweeps across the body's
  // line toward the plate on (1.54 — see FINISH_STAND_FROM), with the shoe still out on its
  // arc, and the trunk is standing back up out of the fold from that frame on while the leg
  // comes round to land. That is the request's own order: the stand is under way before the
  // shoe is down, and the landing is a body already coming up rather than a body landing in
  // the deepest fold it has.
  assert.ok(
    foldAt(1.68) > foldAt(AUTHORED_RELEASE_TIME) + 0.3,
    `the landing stands in ${(foldAt(1.68) * DEG).toFixed(0)}° against the release's ${(foldAt(AUTHORED_RELEASE_TIME) * DEG).toFixed(0)}°: the finish's fold is spent on the frames the feet land on`,
  )
  assert.ok(
    foldAt(1.54) > foldAt(1.68) + 0.02,
    `the trunk is ${(foldAt(1.54) * DEG).toFixed(1)}° on the crossing and ${(foldAt(1.68) * DEG).toFixed(1)}° at the landing: the fold is not thrown over the foot by the time the shoe is down`,
  )
  // ...and from the crossing to the recovery's own key it only comes up: every frame of the
  // beat is a frame the trunk is further out of its fold than the last — the stand is the
  // delivery's last movement and it is spent over the beat rather than saved for the walk
  // back — and what it is by the pause is most of the way out of the fold it peaked in.
  let wasFolded = foldAt(1.54)
  for (let t = 1.54 + 1 / 120; t <= 2.8 + 1e-9; t += 1 / 120) {
    const now = foldAt(t)
    assert.ok(
      now <= wasFolded + 1e-9,
      `at ${t.toFixed(3)}s the trunk goes back into its fold: ${(wasFolded * DEG).toFixed(1)}° then ${(now * DEG).toFixed(1)}°`,
    )
    wasFolded = now
  }
  assert.ok(
    foldAt(2.1) < foldAt(1.54) - 0.3,
    `the trunk is still ${(foldAt(2.1) * DEG).toFixed(0)}° at the pause against the crossing's ${(foldAt(1.54) * DEG).toFixed(0)}°: the stand has not begun`,
  )
  // ...and it is the keys' own standing body by the recovery's own key, where the keys'
  // fold is 0.05 rad again (see FINISH_STAND).
  assert.ok(
    Math.abs(foldAt(2.8)) < 0.1,
    `the trunk is ${(foldAt(2.8) * DEG).toFixed(1)}° at the recovery's key: the stand is not finished by the walk back`,
  )
})

test('the arch is the plant’s own, and the fold comes over the foot across the whip', () => {
  // The delivery's own two shapes about the trunk, read off the pose's fold:
  //
  // *The arch* is a place the delivery stands in at the plant — the trunk bowed back
  // over the drive foot with the back leg firing — and not the couple of degrees of
  // back-tilt that reads as a body stood up out of its coil (see the plant key's own
  // note). What the reference pitch shows there is a chest carried up over the rubber,
  // and what a camera sees of it is the whole trunk's angle: measured off the pose,
  // three tenths of a radian back, whole at the plant and paid for before the ball goes.
  const foldAt = (t) => pitcherPose(t, ctx()).hip.fold
  const solved = releasePosture({ rig: RIG, hand: 'R', height: 1.85 }).lean
  assert.ok(
    foldAt(1.18) < 0,
    `the trunk is ${(foldAt(1.18) * 180 / Math.PI).toFixed(1)}° at 1.18s: it has not arched as the back leg fires`,
  )
  assert.ok(
    foldAt(1.2) < -0.28,
    `the plant's arch is ${(foldAt(1.2) * 180 / Math.PI).toFixed(1)}°: the trunk stands up over its drive foot rather than bowing back over it`,
  )
  // ...and the bow is a *window* around the plant rather than the trunk being stood
  // back the whole delivery: forward through the kick and the gather (the fall has not
  // started while the weight is still on the back foot), deeply bowed at the plant, and
  // coming back out of it by the cock. The leading edge is the *fall's own first frame*
  // (1.0, where the back-tilt window opens — see BACK_TILT_START above) and not the old
  // 1.16: the reference's PS-1 leans the torso back as early as the torso starts falling
  // forward, so on a bow this deep the trunk is already coming back over the rubber as
  // the fall begins, and pinning it forward past the fall's own start would put the
  // lean-back after the thing it is answering.
  assert.ok(
    foldAt(1.0) > 0 && foldAt(1.22) > foldAt(1.2),
    'the arch is not a window: the trunk is bowed back before and after it',
  )
  // ...and *the fold* comes over the foot across the whole of the whip rather than
  // between the plant and the cock: the trunk is still short of the release posture's
  // own fold at the high cock (see FOLD_ARRIVE), and the fall is one motion into the ball
  // up to the come-through — every frame of it deeper than the one before, with nothing
  // given back on the way.
  assert.ok(
    foldAt(1.26) < solved - 0.05,
    `the trunk is folded ${(foldAt(1.26) * 180 / Math.PI).toFixed(1)}° at the cock against the posture's ${(solved * 180 / Math.PI).toFixed(1)}°: the fall is spent before the whip`,
  )
  let was = foldAt(1.2)
  for (let t = 1.2 + 1 / 120; t <= 1.3 + 1e-9; t += 1 / 120) {
    const now = foldAt(t)
    assert.ok(
      now >= was - 1e-9,
      `at ${t.toFixed(3)}s the trunk comes back out of the fall: ${(was * 180 / Math.PI).toFixed(1)}° then ${(now * 180 / Math.PI).toFixed(1)}°`,
    )
    was = now
  }
  assert.ok(
    Math.abs(foldAt(1.3) - solved) < 1e-9 && Math.abs(foldAt(AUTHORED_RELEASE_TIME) - solved) < 1e-9,
    `the fold is ${(foldAt(1.3) * 180 / Math.PI).toFixed(1)}° at the come-through against the posture's ${(solved * 180 / Math.PI).toFixed(1)}°`,
  )
  // ...and from the come-through out the trunk is on the *rip's* own clock, which is
  // started before the ball rather than after it (see FINISH_RIP_LEAD): the fold gathers
  // the last degree or two *off* the posture it landed on over the two hundredths of a
  // second before the ball, comes back through the posture's own value with the whip's own
  // rate on it, and is handed to the rip *on the frame the ball goes* — so the trunk is
  // still moving on the release's own frames rather than standing at rest on them with the
  // rip beginning behind it. Measured on the pose: the posture's own 15.4° at 1.300 s,
  // 13.05° at 1.3125 (the gather's floor, 2.4° under it), 15.45° again at 1.320 with 922°/s
  // on the frame, 1160 on the frame after it and 26.0° by 1.330. The gather is *paid for* by
  // the rate it is handed to the rip at (the share's own Hermite — the steeper the rip, the
  // deeper the gather: the finish's shape leaves the ball at 4.03 shares a second of its own
  // clock where the cubic left it at 3), so what is held here is that it is a degree or two
  // and not a fold of its own.
  const rateAt = (t) => (foldAt(t + 0.0025) - foldAt(t - 0.0025)) / 0.005
  let gathered = Infinity
  for (let t = 1.3; t <= AUTHORED_RELEASE_TIME + 1e-9; t += 0.0025) {
    gathered = Math.min(gathered, foldAt(t))
  }
  assert.ok(
    solved - gathered > 0.015 && solved - gathered < 0.055,
    `the trunk gathers ${((solved - gathered) * 180 / Math.PI).toFixed(1)}° off the release posture across the ball's own approach: the release's frames are either holding the posture outright or being moved off it by more than a gather`,
  )
  const ripRate = (rateAt(AUTHORED_RELEASE_TIME) * 180) / Math.PI
  assert.ok(
    ripRate > 600,
    `the fold is only ${ripRate.toFixed(0)}°/s on the ball's own frame: the trunk is at rest on it and the rip starts after the release`,
  )
  // ...and it is the rip's own rate that the ball's frame carries, with the gather's turn
  // still in front of it: the rate comes back through nought inside the release's own two
  // frames and is on the rip's side of it by the time the ball goes.
  assert.ok(
    rateAt(AUTHORED_RELEASE_TIME - 0.0075) < 0 && rateAt(AUTHORED_RELEASE_TIME - 0.0025) > 0,
    `the gather turns over at ${((AUTHORED_RELEASE_TIME - 0.0075) * 1000).toFixed(0)}-${((AUTHORED_RELEASE_TIME - 0.0025) * 1000).toFixed(0)} ms: the fold is not gathering into the rip`,
  )
  // ...and the rip is never given back: from the gather's floor out past the ball, every
  // frame of the fold is deeper than the one before it.
  let deepest = foldAt(1.315)
  for (let t = 1.315 + 1 / 120; t <= 1.54 + 1e-9; t += 1 / 120) {
    const now = foldAt(t)
    assert.ok(
      now >= deepest - 1e-9,
      `at ${t.toFixed(3)}s the trunk comes back out of the fold it was thrown into: ${(deepest * 180 / Math.PI).toFixed(1)}° then ${(now * 180 / Math.PI).toFixed(1)}°`,
    )
    deepest = now
  }
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
    front(0.46).hang,
    0,
    'the rocker stands the foot on the ground: the kick should not be hanging off its knee yet',
  )
  for (const t of [0.55, 0.65, 0.75, 0.9]) {
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
  const top = front(0.8)
  const cocked = front(1.0)
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
  for (const t of [1.2, 1.26, AUTHORED_RELEASE_TIME]) {
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
  for (const t of [1.2, 1.26, AUTHORED_RELEASE_TIME]) {
    const leg = pitcherPose(t, ctx()).legs[0]
    const across = leg.knee[0] - leg.ankle[0]
    assert.ok(
      Math.abs(across) < 0.03,
      `the pivot knee is asked for ${across.toFixed(3)} rig units across its own foot at ${t}s`,
    )
  }
})

test('the lead shoe turns with the body, on the ankle the plant put down', () => {
  // The lead leg's turn, and the ground it is made on — the two halves of one shape, read
  // off the pose's own numbers and read again on the realised skeleton in the browser suite.
  //
  // The first half: the stride foot is put down pointing at the plate (that is what the keys
  // down to the plant spend the stride on), and from that frame on the shoe turns with the
  // *body*. It is handed the whole of the body's turn through the pitch and not the share
  // that falls after the plant: the chest comes round 61.0° between the release and the plant
  // and a further 41.2° by the landing, so a shoe given only the second of those is a lead
  // foot left standing in a finish the body has come most of the way round over — the trail
  // shoe spins 155° over the same frames, and this one turned less than a third of it and
  // stopped pointing a hand's width off the plate's line while the chest was square to it.
  // Handed the first, the shoe turns 101.9°: the body's own turn from the release, in the
  // trunk's own shape, at 2.474 times the trunk's rate over the frames it has on the dirt
  // (see FRONT_SHOE_TURN_SHARE in util/pitcherSequence.js).
  //
  // The second: a shoe the dirt is holding cannot skid, so the point it turns about is one of
  // its own, and for the lead foot that point is the *ankle* — the leg's own base, which
  // keeps the spot the plant gave it to the last decimal. The heel is what the trail shoe
  // turns about; anchoring the lead one there carries its ankle round a circle the boot's own
  // length behind it, which is 0.155 of a rig unit at 101.9°, and the front leg — standing at
  // 101 per cent of its own length on the landing already, and rolling the shoe onto its toe
  // for the last centimetre — has 0.070. Asked for more it comes out torn straight, the ankle
  // 7 cm short of the place it was asked for and the shoe 8 cm off the dirt (measured on the
  // skeleton). So what sweeps the dirt is the shoe rather than the leg: 0.155 of a unit of
  // heel travel between the plant and the landing, which is the chord of the turn about the
  // ankle to the decimal, and the cost of a foot coming round with a body that has come round
  // over it.
  const pose = (t) => pitcherPose(t, ctx())
  const front = (t) => pose(t).legs[1]
  const trunk = (t) => pose(t).hip.yaw + pose(t).torsoYawExtra
  // The shoe's own rear, in the rig frame: the ankle plus the boot's own length back along
  // the line the shoe points (the rig's +z is behind it, the plate being at -z).
  const heel = (t) => {
    const leg = front(t)
    return [
      leg.ankle[0] + Math.sin(leg.footYaw) * RIG.heelOffset.z,
      leg.ankle[2] + Math.cos(leg.footYaw) * RIG.heelOffset.z,
    ]
  }
  const DEG = 180 / Math.PI
  const PLANT = 1.42
  const LANDING = 1.68
  const RELEASE = AUTHORED_RELEASE_TIME
  // ...it is put down on the plate's own line ...
  assert.ok(
    Math.abs(front(PLANT).footYaw) < 0.03,
    `the stride foot is planted ${(front(PLANT).footYaw * DEG).toFixed(1)}° off the plate's line: the stride has not been spent on it`,
  )
  // ...and from there it carries the body's own turn, all of it: the trunk's turn since the
  // plant scaled by the share the body's whole turn is worth.
  const share = (trunk(LANDING) - trunk(RELEASE)) / (trunk(LANDING) - trunk(PLANT))
  assert.ok(
    share > 2.4 && share < 2.6,
    `the lead shoe takes ${share.toFixed(3)} times the trunk's turn after the plant: the body's whole turn is 2.474 of it`,
  )
  for (const t of [1.48, 1.54, 1.5575, 1.575, 1.61, 1.645, 1.68, 1.9, 2.8]) {
    const shoe = front(t).footYaw - front(PLANT).footYaw
    const above = (trunk(t) - trunk(PLANT)) * share
    assert.ok(
      Math.abs(shoe - above) < 1e-9,
      `by ${t}s the lead shoe has turned ${(shoe * DEG).toFixed(3)}° where the body's own turn over it is ${(above * DEG).toFixed(3)}°: the shoe is not turning with the torso`,
    )
  }
  const turned = (front(LANDING).footYaw - front(PLANT).footYaw) * DEG
  assert.ok(
    turned > 100 && turned < 103,
    `the lead shoe turns ${turned.toFixed(1)}° between the plant and the landing: the body's own turn over those frames is 101.9°`,
  )
  assert.ok(
    Math.abs(front(LANDING).footYaw - (trunk(LANDING) - trunk(RELEASE))) < 1e-9,
    'the shoe does not end the finish where the body turned from the release has put it',
  )
  // ...and the turn has no stall in it: out of rest on the plant's own frame, up to its peak,
  // and then one decay, each frame's turn no larger than the frame before's.
  const firstStep = (front(PLANT + 0.02).footYaw - front(PLANT).footYaw) * DEG
  assert.ok(
    firstStep > 4 && firstStep < 10,
    `the lead shoe picks its turn up at ${firstStep.toFixed(2)}° in the frame after the plant: it either lurches or hesitates`,
  )
  let last = Infinity
  for (let t = PLANT + 0.04; t <= 1.68 - 0.02 + 1e-9; t += 0.02) {
    const step = (front(t + 0.02).footYaw - front(t).footYaw) * DEG
    assert.ok(
      step <= last + 0.15,
      `the lead shoe turns ${step.toFixed(2)}° across ${t.toFixed(2)}-${(t + 0.02).toFixed(2)}s, against ${last.toFixed(2)}° before it: the shoe's turn is not a decay`,
    )
    last = step
  }
  // ...and the shoe is held where the landing put it: the trunk stops turning on that frame,
  // and the shoe stops with it, to the last decimal the pose has.
  for (const t of [1.9, 2.8]) {
    assert.ok(
      Math.abs(front(t).footYaw - front(1.68).footYaw) < 1e-9,
      `the lead shoe turns ${((front(t).footYaw - front(1.68).footYaw) * DEG).toFixed(3)}° after the landing: the pose he lands in is not the pose he holds`,
    )
  }
  // The ankle it turns on is the spot the plant left it on — held to the last decimal.
  for (const t of [1.5, 1.6, 1.68, 1.9, 2.8]) {
    const drift = Math.hypot(front(t).ankle[0] - front(PLANT).ankle[0], front(t).ankle[2] - front(PLANT).ankle[2])
    assert.ok(
      drift < 1e-9,
      `the lead ankle is ${drift.toFixed(4)} rig units off the spot the plant put it on by ${t}s: the leg's base is being dragged round with the turn`,
    )
  }
  // What that costs is the shoe's own sole, and it is the arc of the turn exactly: the heel
  // it was put down by comes round the ankle by the chord, 2 r sin(Δ/2), and nothing else.
  const spot = heel(PLANT)
  const landed = heel(LANDING)
  const sweepLength = Math.hypot(landed[0] - spot[0], landed[1] - spot[1])
  assert.ok(
    sweepLength > 0.145 && sweepLength < 0.165,
    `the lead heel sweeps ${sweepLength.toFixed(4)} rig units across the dirt between the plant and the landing: 0.155 is the chord of a 101.9° turn about the ankle`,
  )
  assert.ok(
    Math.abs(sweepLength - 2 * RIG.heelOffset.z * Math.sin((turned * Math.PI) / 360)) < 1e-9,
    `the heel travels ${sweepLength.toFixed(4)} of a unit where the chord of the shoe's own turn is ${(2 * RIG.heelOffset.z * Math.sin((turned * Math.PI) / 360)).toFixed(4)}`,
  )
  // ...and the same on the other hand, where the pose is this one's mirror: the rig's
  // own x is mirrored and its z is not, so a left-hander's shoe comes round the other
  // way and its ankle stays put just the same. The authored delivery is
  // one delivery for both hands (see the mirror test), so the numbers are the same ones.
  const leftPose = (t) => pitcherPose(t, { ...ctx(), hand: 'L' })
  const leftFront = (t) => leftPose(t).legs[1]
  const leftHeel = (t) => {
    const leg = leftFront(t)
    return [
      leg.ankle[0] + Math.sin(leg.footYaw) * RIG.heelOffset.z,
      leg.ankle[2] + Math.cos(leg.footYaw) * RIG.heelOffset.z,
    ]
  }
  for (const t of [1.68, 1.9, 2.8]) {
    const drift = Math.hypot(leftFront(t).ankle[0] - leftFront(PLANT).ankle[0], leftFront(t).ankle[2] - leftFront(PLANT).ankle[2])
    assert.ok(
      drift < 1e-9,
      `a left-hander's lead ankle is ${drift.toFixed(4)} rig units off the plant's spot by ${t}s`,
    )
    const shoe = leftFront(t).footYaw - leftFront(PLANT).footYaw
    const above = (leftPose(t).hip.yaw + leftPose(t).torsoYawExtra)
      - (leftPose(PLANT).hip.yaw + leftPose(PLANT).torsoYawExtra)
    assert.ok(
      Math.abs(Math.abs(shoe) - Math.abs(above) * share) < 1e-9,
      `a left-hander's lead shoe turns ${(shoe * DEG).toFixed(3)}° where the body's own turn over it is ${(above * share * DEG).toFixed(3)}°`,
    )
  }
  const leftSpot = leftHeel(PLANT)
  const leftLanded = leftHeel(LANDING)
  const leftSweep = Math.hypot(leftLanded[0] - leftSpot[0], leftLanded[1] - leftSpot[1])
  assert.ok(
    Math.abs(leftSweep - sweepLength) < 1e-9,
    `a left-hander's heel sweeps ${leftSweep.toFixed(4)} where a right-hander's sweeps ${sweepLength.toFixed(4)}: the turn is one turn, mirrored`,
  )
})

test('the hands are clasped in the glove until the gather parts them', () => {
  // The ball is *in* the glove while the pitcher stands in the set and winds up: the
  // pose's own ball is the glove's own palm and the two hands run along one line,
  // which is what hides the grip — and what a change to the stance cannot silently
  // pull apart (see claspTracks). The clasp keys are the windup's own: the set, the
  // rocker and the gather, up to the *gather* that parts them — the frame the lift tops
  // out on, which is where the leg is highest and the throwing arm is let go, so that
  // the whole of the rest of the windup is the arm's to fall and come back up in.
  const carry = releaseCarry(RIG, 'R')
  for (const t of [0, 0.2, 0.46, 0.7, 0.8]) {
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
  // The gather is where they come apart: the throwing hand swings down beside the hip
  // while the glove goes out in front of the chest — so by the balance the mitt it is
  // off is a third of a metre away and still opening.
  const parted = pitcherPose(1.0, ctx())
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
  for (const t of [0, 0.2, 0.46, 0.7, 0.8]) {
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
  for (const t of [1.0, 1.2]) {
    const pose = pitcherPose(t, ctx())
    const gap = distance(mirrorShape(pose, shapeOf(pose, -1)), shapeOf(pose, 1))
    assert.ok(
      gap > 0.2,
      `at ${t}s the trail arm is still the lead arm's mirror, to ${gap.toFixed(3)} of the arm's own shape`,
    )
  }
})

test('the shoulders come square on the frame the ball goes', () => {
  // A throw's power is a chain: the pelvis turns, the torso is handed that turn and
  // turns the shoulders, and the arm comes round last of all — so the body the ball is
  // thrown by is *facing the plate* on the frame the ball goes, with the pelvis a good
  // way past the shoulders it is carrying. The chest's own last few degrees are the
  // turn's own clock rather than the keys' (see TURN_GATHER_LEAD): the keys cross the
  // square a hundredth early, and the gather holds the last of the coil closed over the
  // two hundredths before the ball and hands it over *on* the release's own frame, so
  // the frame the ball goes is the frame the shoulders are square on — read here as the
  // two ends of it: nothing squares early (the last frame before the ball is still
  // closed, with the ball still in hand), and the release's own frame is square.
  const release = pitcherPose(AUTHORED_RELEASE_TIME, ctx())
  assert.ok(
    release.hip.yaw + release.torsoYawExtra > -0.02,
    `the chest is at ${((release.hip.yaw + release.torsoYawExtra) * 180) / Math.PI}° on the release: it is not square on the frame the ball goes`,
  )
  assert.ok(
    release.hip.yaw - (release.hip.yaw + release.torsoYawExtra) > 0.15,
    'the shoulders squared with the pelvis still behind them',
  )
  assert.ok(release.hip.yaw > 0.1, 'the pelvis was not past square either')
  // ...and the square is spent *on* that frame and not before it: the chest is still
  // closed on every frame of the lead, and the last of them has the ball short of the
  // release point — the arm's own unwind (the elbow opening out of its right angle) is
  // still in front of it rather than behind it (see the come-through key's own note).
  let last = null
  for (let t = 1.2; t < AUTHORED_RELEASE_TIME - 1e-9; t += 1 / 240) {
    const pose = pitcherPose(t, ctx())
    assert.ok(
      pose.hip.yaw + pose.torsoYawExtra < -0.02,
      `the chest comes square at ${t}s, with the ball still ${(release.ball[2] - pose.ball[2]).toFixed(3)} of a rig unit in hand: the coil is spent before the ball goes`,
    )
    last = { t, pose }
  }
  assert.ok(last, 'the lead should be walked in frames')
  assert.ok(
    last.pose.ball[2] > release.ball[2],
    `at ${last.t}s the shoulders squared with the arm already at the release: the ball was at ${last.pose.ball[2]}, the release at ${release.ball[2]}`,
  )
})

test('the wrist keeps its own angle through the cock', () => {
  // What a wrist holds while the arm cocks is an *angle*, not a facing: the hand's one
  // free turn is about the line it runs along (the driver rolls the palm about exactly
  // that axis — see its own ``palmFacing``), so a facing the pose names square to that
  // line is a facing the wrist can answer outright, and one it names *relative to the
  // arm* is one it can hold while the arm swings. Named in the rig's frame instead, the
  // ask is a direction in the world, and the wrist spends the cock re-turning to keep it:
  // measured on the realised skeleton before the hold, that re-turn was 60° between the
  // layback and the come-through — a wrist working against the arm it hangs on.
  //
  // The reading below is the pose's own: the ask, in the frame the driver builds the arm
  // from — the line the hand runs along, and the elbow's own direction off the socket
  // squared up out of it — at the frames the hold spans. What it holds is that the ask
  // does not move in that frame (the wrist's own angle), and that it stays square to the
  // hand's line (which is the part of a facing a roll *can* answer).
  const armOfPose = (t) => {
    const pose = pitcherPose(t, ctx())
    const arm = pose.arms[0]
    const socket = shoulderOf(pose, arm.side)
    const line = arm.aim
    const elbow = [
      arm.elbow[0] - socket[0], arm.elbow[1] - socket[1], arm.elbow[2] - socket[2],
    ]
    const length = Math.hypot(...elbow) || 1
    const pole = elbow.map((value) => value / length)
    return { pose, arm, line, pole }
  }
  const squareOf = (v, axis) => v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]
  const turnOf = (v, line, pole) => {
    // The pole squared up out of the hand's line, and the axis square to both: the
    // frame the elbow's own side of the arm is written in.
    const lean = squareOf(pole, line)
    const up = [pole[0] - line[0] * lean, pole[1] - line[1] * lean, pole[2] - line[2] * lean]
    const length = Math.hypot(...up) || 1
    const plane = up.map((value) => value / length)
    const side = [
      line[1] * plane[2] - line[2] * plane[1],
      line[2] * plane[0] - line[0] * plane[2],
      line[0] * plane[1] - line[1] * plane[0],
    ]
    return Math.atan2(squareOf(v, side), squareOf(v, plane)) * (180 / Math.PI)
  }
  const holds = []
  // The hand's roll spans the *swing up the back*, and the hold the *cock*: the hands part
  // with the ball hand turned to the plate, the fall turns it square to first base as it
  // reaches the pitcher's side (1.00 s), and from there the forearm is what rolls — the palm
  // turning over with it, through the sky and the ground to the pitcher's own back (see
  // HOLD_ROLL) — until the layback lands it at 1.12 s and the wrist is *loaded*: it keeps
  // that one angle through the cock and does not turn again until the throw unwinds it. So
  // the reading is one turn of a joint either way, and what it holds is that the ask never
  // *chases* the arm: across the swing the wrist rolls one way
  // monotonically (a forearm turning over, not a hand re-pointing to each rig facing the
  // swing passes), and across the cock it does not move at all.
  // The turn's *direction* is the delivery's own and is not the test's to prescribe: the
  // break shows the palm out the pitcher's back and PS-2 turns it onto the ground, so the
  // forearm rolls one way through the throwing side (see HOLD_ROLL). What is prescribed is
  // that it turns *one way* — a wrist that reverses mid-roll is a hand re-pointing itself
  // at the facings the swing passes through rather than a forearm turning over.
  const FALL_END = 1.12   // the layback: where the roll lands and the load begins
  const roll = []
  const load = []
  for (let t = 1.04; t <= 1.26 + 1e-9; t += 0.01) {
    const { arm, line, pole } = armOfPose(t)
    const ask = arm.palm
    assert.ok(
      Math.abs(squareOf(ask, line)) < 0.02,
      `at ${t}s the palm is asked for a facing ${squareOf(ask, line).toFixed(3)} of the way down the hand's own line: no roll can answer that`,
    )
    if (t <= FALL_END + 1e-9) roll.push(turnOf(ask, line, pole))
    else load.push(turnOf(ask, line, pole))
    holds.push(turnOf(ask, line, pole))
  }
  // The roll: one turn, one way, across the whole of the fall.
  const way = Math.sign(roll[roll.length - 1] - roll[0]) || 1
  for (let i = 1; i < roll.length; i += 1) {
    assert.ok(
      way * (roll[i] - roll[i - 1]) >= -1e-9,
      `the wrist reverses its roll mid-fall (${roll[i - 1].toFixed(1)}° then ${roll[i].toFixed(1)}°): that is a hand chasing the swing, not a forearm rolling`,
    )
  }
  assert.ok(
    Math.abs(roll[roll.length - 1] - roll[0]) > 25,
    `the forearm rolls only ${Math.abs(roll[roll.length - 1] - roll[0]).toFixed(1)}° across the fall: that is not the palm turning over the sky and the ground to the back`,
  )
  // ...and the load: the angle the layback landed on, held through the cock.
  const loadSpread = Math.max(...load) - Math.min(...load)
  assert.ok(
    loadSpread < 5,
    `the wrist's own angle moves ${loadSpread.toFixed(1)}° through the cock (${load.map((v) => v.toFixed(0)).join(', ')}): the forearm is not loaded`,
  )
  // ...and what the hand is *left* turned to as it reaches the pitcher's side is the ball
  // shown to **first base**: the arm is down by the *balance* (1.00 s) — the break is three
  // frames further on and the forearm has already begun rolling the palm off the base
  // (see HOLD_ROLL) — so "out of his back" is that bearing, written where the pose
  // authors it, which is the rig's frame and NOT
  // the world's. The rig is the world turned a half turn about its up axis (the driver's
  // ``toRigVector`` negates x and z, which is what stands the plate at -Z here while it is
  // at +Z out on the field), so first base — 63.4 ft down the line and 2.9 ft beyond the
  // rubber, nearly square to the pitch — is (-0.999, 0, 0.046) here and not the mirror of
  // it: written the way it reads in the world the ask lands on *third* base, which is a hand
  // a half turn round from the one the delivery means, and that is what the report "the palm
  // is facing 3B for a RHP" was. Mirrored by ``s`` a lefty shows his to third, which is the
  // back *he* is turning to.
  const sidePalm = pitcherPose(1.00, ctx()).arms[0].palm
  const FIRST_BASE = [-0.9990, 0, 0.0457]
  const offFirstBase = (v) => Math.acos(Math.min(1, Math.max(-1, squareOf(v, FIRST_BASE)))) * (180 / Math.PI)
  assert.ok(
    offFirstBase(sidePalm) < 10,
    `the balance asks the palm for (${sidePalm.map((v) => v.toFixed(2)).join(', ')}): ${offFirstBase(sidePalm).toFixed(0)}° off first base`,
  )
  // ...and it is *let go* rather than held to the end: by the release's own frame the ask
  // is the pitch's bearing again (see the browser suite's reading of it), which is the
  // wrist's turn the throw unloads through.
  for (const t of [AUTHORED_RELEASE_TIME, AUTHORED_RELEASE_TIME + 0.04]) {
    assert.ok(
      Math.abs(squareOf(pitcherPose(t, ctx()).arms[0].palm, armOfPose(t).line)) > 0.4,
      `at ${t}s the palm is still held square to the hand's line: the wrist never unloads`,
    )
  }
})

test('the hand coming out of the mitt turns the ball to first base as it drops', () => {
  // The ball leaves the mitt on the plate's own bearing — a clasp shows the hitter the
  // ball (see the clasp's reading, and the glide's own ``glovePalm``) — so what the drop
  // has to do is turn it over, and *from that frame on*: the hand goes on round as the arm
  // falls, so that by the time the arm is at the pitcher's side the palm is square to
  // **first base**, which is the pitcher's own back while he stands sideways to the plate.
  //
  // The turn is a held joint rather than a facing named in the rig's frame (see
  // PALM_HOLD), and the frames in between are why: the hand's own line turns end over end
  // as the arm comes down (the cock runs the fingers back off the forearm and the arm
  // swings through it), so for a third of the fall a *direction* in the world is one no
  // roll can answer — on those frames the ask stands most of the way down the hand's own
  // line, and the driver squared it up to whatever was left. What is checked here is the
  // two ends of that turn and that no frame of it is a snap; the shape between them is
  // HOLD_ROLL's own, and the unit tests that read a wrist's angle (the wind/unwind read
  // above) are the ones that hold it to being one turn.
  const palmAt = (t, over) => pitcherPose(t, ctx(over)).arms[0].palm
  // First base's bearing *in the rig's frame* (see the break's own note: the rig is the
  // world turned a half turn about its up axis, so x and z are negated). The plate's is
  // (0, 0, -1) there, for the same reason.
  const FIRST_BASE = [-0.9990, 0, 0.0457]
  const offFirstBase = (v) => (
    Math.acos(Math.min(1, Math.max(-1, v[0] * FIRST_BASE[0] + v[1] * FIRST_BASE[1] + v[2] * FIRST_BASE[2])))
    * (180 / Math.PI)
  )
  // It comes out of the mitt on the plate's bearing: 90° from first base, which is the
  // facing the clasp's own palm had it turned to — and it comes out at the gather (0.80 s),
  // the frame the lift tops out on, with the whole of the fall to make the turn in.
  assert.ok(
    Math.abs(offFirstBase(palmAt(0.80)) - 90) < 8,
    `at 0.80s the palm reads ${offFirstBase(palmAt(0.80)).toFixed(0)}° off first base: the hand left the mitt already turned away from the plate`,
  )
  // ...and by the frame the arm is at his side it is on the bearing, and stays there while
  // the arm hangs: the side is 0.98-1.02 s, and that band is read on every frame of it.
  // (It was 1.11-1.15 s, when the arm was let go of at the balance and the hip was reached
  // at 1.125: the mitt now parts at the gather — see the clasp's own note — so the side is
  // reached on the balance's own frame and the lift has taken the arm out of it by 1.04 s.
  // What the band is for — the ball shown to the infield while the arm is at his side — is
  // the hang and the two frames either side of it, and it reads 12° at its worst.)
  for (let t = 0.98; t <= 1.02 + 1e-9; t += 0.01) {
    const palm = palmAt(t)
    assert.ok(
      offFirstBase(palm) < 16,
      `at ${t.toFixed(2)}s the palm reads (${palm.map((v) => v.toFixed(2)).join(', ')}): ${offFirstBase(palm).toFixed(0)}° off first base with the arm at the pitcher's side`,
    )
  }
  // ...and the mirror of it: a lefty's arm is this one across the chest, so what his palm
  // comes round to is *third* base — the back he is turning to — on the same frames.
  const mirrored = palmAt(1.00, { hand: 'L' })
  assert.ok(
    mirrored[0] * FIRST_BASE[0] + mirrored[1] * FIRST_BASE[1] + mirrored[2] * FIRST_BASE[2] < -0.94,
    `a lefty's side asks the palm for (${mirrored.map((v) => v.toFixed(2)).join(', ')}): not third base`,
  )
  // ...and it is a *turn* of the wrist rather than a flip through the middle of the
  // hand: no frame of a hundred-and-twentieth carries it more than half a right angle,
  // which is what a hand leaving a mitt covers and what a re-pointed facing does not.
  const STEP = 1 / 120
  let worst = 0
  let when = 0
  let prev = palmAt(0.80)
  for (let t = 0.80 + STEP; t <= 1.16 + 1e-9; t += STEP) {
    const now = palmAt(t)
    const turn = Math.acos(Math.min(1, Math.max(-1,
      now[0] * prev[0] + now[1] * prev[1] + now[2] * prev[2]))) * (180 / Math.PI)
    if (turn > worst) { worst = turn; when = t }
    prev = now
  }
  assert.ok(
    worst < 55,
    `the palm turns ${worst.toFixed(0)}° in one frame at ${when.toFixed(3)}s: the wrist snaps rather than turning`,
  )
})

test('the upper arm screws one way round its own chord through the cock, and the fold is what unwinds', () => {
  // "Screw the arm up and unwind it" is a *direction* rather than a place, and the one the
  // upper arm has is a turn about the chord from its socket to the wrist — the axis the
  // fold's own ring is drawn about, and the one a humerus turns about when it winds a throw
  // up. Signed about the chord in the ring frame this test builds for itself — the world's
  // up across the chord, and the ring's own up off that — so nought is the elbow out on the
  // throwing side and a quarter turn is it under the chord.
  //
  // What the delivery owes is the *shape* of that turn: one way and unbroken through the
  // cock — the arm screwing up rather than hunting for the side of its own ring — and then
  // the arm *opening* as the throw spends it. The second half is the fold, not the ring:
  // through the cock the elbow is held at its right angle (which is what keeps the laid-back
  // forearm laid back), and the release's frames are the unfold — 90° of bend to 175° in two
  // hundredths of a second, which is the whip the ball is thrown on.
  //
  // Read as a *place* instead, the frames either side of PS-8 crossed each other: the
  // shoulder-plane rule folded the elbow under the plane on the frame before the key while
  // the authored pole beside it had already carried the arm up and back, so the upper arm
  // turned 60° one way and 60° back across two hundredths of a second. Read as an angle
  // off the chord's own frame (see the swivel's own turn in `pitcherSequence`), that is a
  // reading of a side the ring cannot lose, and the turn is a turn.
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const unit = (v) => {
    const length = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / length, v[1] / length, v[2] / length]
  }
  const armAt = (t) => {
    const pose = pitcherPose(t, ctx())
    const arm = pose.arms[0]
    const socket = shoulderOf(pose, arm.side)
    const chord = unit([arm.hand[0] - socket[0], arm.hand[1] - socket[1], arm.hand[2] - socket[2]])
    const pole = unit([arm.elbow[0] - socket[0], arm.elbow[1] - socket[1], arm.elbow[2] - socket[2]])
    // The ring's own frame, off the world's up across the chord — the frame the pose's whip
    // rolls the pole in (see `whipPole`).
    const lateral = unit([-chord[2], 0, chord[0]])
    const ringUp = [
      lateral[1] * chord[2] - lateral[2] * chord[1],
      lateral[2] * chord[0] - lateral[0] * chord[2],
      lateral[0] * chord[1] - lateral[1] * chord[0],
    ]
    const along = dot(pole, chord)
    const flat = [pole[0] - chord[0] * along, pole[1] - chord[1] * along, pole[2] - chord[2] * along]
    return {
      roll: Math.atan2(dot(flat, ringUp), dot(flat, lateral)),
      bend: (Math.acos(Math.min(1, Math.max(-1,
        dot(unit([arm.elbow[0] - socket[0], arm.elbow[1] - socket[1], arm.elbow[2] - socket[2]]),
          unit([arm.hand[0] - arm.elbow[0], arm.hand[1] - arm.elbow[1], arm.hand[2] - arm.elbow[2]])),
      ))) * 180) / Math.PI,
    }
  }
  // The turn each frame makes, in degrees: the roll unwrapped between the frames (a ring
  // angle has no branch while the arm is turning one way), and the bend's own change.
  const turns = (from, to, read) => {
    const out = []
    let prev = armAt(from)
    for (let t = from + 0.01; t <= to + 1e-9; t += 0.01) {
      const now = armAt(t)
      if (read === 'roll') {
        let step = now.roll - prev.roll
        while (step > Math.PI) step -= Math.PI * 2
        while (step < -Math.PI) step += Math.PI * 2
        out.push((step * 180) / Math.PI)
      } else {
        out.push(now.bend - prev.bend)
      }
      prev = now
    }
    return out
  }
  // The reach the frame asks for, as a share of the arm's own span: the chord the fold is
  // drawn about. Held, it is the cock; spent, it is the release.
  const reachOf = (t) => {
    const pose = pitcherPose(t, ctx())
    const arm = pose.arms[0]
    const socket = shoulderOf(pose, arm.side)
    return Math.hypot(arm.hand[0] - socket[0], arm.hand[1] - socket[1], arm.hand[2] - socket[2])
      / (ctx().rig.arm.upper + ctx().rig.arm.fore)
  }
  const WIND_START = 1.19   // the lift's own key: the elbow comes out from under the arm
  const WIND_END = 1.25     // the last frame before the cock's own key settles it
  const wind = turns(WIND_START, WIND_END, 'roll')
  const reach = []
  for (let t = WIND_END + 0.01; t <= AUTHORED_RELEASE_TIME + 1e-9; t += 0.01) reach.push(reachOf(t))
  console.log(
    'WIND', wind.map((v) => v.toFixed(1)).join(','),
    'REACH', reach.map((v) => v.toFixed(2)).join(','),
  )
  for (let i = 1; i < wind.length; i += 1) {
    assert.ok(
      Math.sign(wind[i]) === Math.sign(wind[0]),
      `the upper arm reverses its wind at ${(WIND_START + 0.01 * (i + 1)).toFixed(2)}s `
        + `(${wind[i - 1].toFixed(1)}° then ${wind[i].toFixed(1)}°): it is hunting for the side of its own ring, not screwing up`,
    )
  }
  const wound = wind.reduce((sum, value) => sum + value, 0)
  assert.ok(
    Math.abs(wound) > 100,
    `the upper arm turns only ${wound.toFixed(0)}° through the whole of the cock: it is not winding the throw up`,
  )
  // ...and then the arm comes open: the fold the cock held at its right angle is *spent*
  // through the release. Read on the reach rather than on the bend, because the reach is what
  // the arm can promise — the chord the fold is drawn about — and the keys author it directly
  // (see STRAIGHT_TRACK): the cock holds it at 0.70 of the arm's span, and the release's own
  // frames take it to the 0.99 a thrown arm reaches.
  assert.ok(
    reach[0] < 0.78,
    `the arm is already ${(reach[0] * 100).toFixed(0)}% of its span at ${(WIND_END + 0.01).toFixed(2)}s: the fold is spent before the throw`,
  )
  assert.ok(
    reach[reach.length - 1] > 0.95,
    `the arm only reaches ${(reach[reach.length - 1] * 100).toFixed(0)}% of its span at the release: it is not coming open`,
  )
  for (let i = 1; i < reach.length; i += 1) {
    assert.ok(
      reach[i] >= reach[i - 1] - 0.02,
      `the arm folds back from ${reach[i - 1].toFixed(3)} to ${reach[i].toFixed(3)} of its span at `
        + `${(WIND_END + 0.01 * (i + 1)).toFixed(2)}s: it is not the whip`,
    )
  }
  // ...and it is spent *faster* than the cock spent winding it: the unfold is the delivery's
  // fastest shape, and that is what makes it read as a throw rather than as an arm being put
  // somewhere.
  const fastestReach = Math.max(...reach.map((value, i) => (i === 0 ? 0 : value - reach[i - 1])))
  assert.ok(
    fastestReach > 0.04,
    `the arm opens ${(fastestReach * 100).toFixed(0)}% of its span in its fastest frame: that is not a whip`,
  )
})

test('the whip turns the upper arm about its own chord, and never crosses it', () => {
  // The whip's frames are the ones the authored *places* could not draw: as the socket
  // drives out from under the arm, the line between two of them cuts across the chord and
  // the elbow walks onto it — the one reading the two-bone solve cannot take a side from.
  // What the whip authors instead is a turn about that chord (see `whipPole`): the arm's
  // own travel from the direction the pole track left it in to the direction the release
  // key draws, rolled about the chord on the way. The readings that hold it are three:
  // the elbow keeps a real lean off the chord on every frame of it, the upper arm's own
  // direction never steps, and both ends of the window are the arms the tracks draw either
  // side of it — the cock's frame is the pole track's, the release's is the key's.
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const unit = (v) => {
    const length = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / length, v[1] / length, v[2] / length]
  }
  const degrees = (a, b) => (Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) * 180) / Math.PI
  const armAt = (t) => {
    const pose = pitcherPose(t, ctx())
    const arm = pose.arms[0]
    const socket = shoulderOf(pose, arm.side)
    return {
      pole: unit([arm.elbow[0] - socket[0], arm.elbow[1] - socket[1], arm.elbow[2] - socket[2]]),
      chord: unit([arm.hand[0] - socket[0], arm.hand[1] - socket[1], arm.hand[2] - socket[2]]),
    }
  }
  const FRAME = 1 / 120
  const FROM = 1.26
  const TO = AUTHORED_RELEASE_TIME
  let lean = Infinity
  let leanAt = FROM
  let step = 0
  let stepAt = FROM
  let prev = armAt(FROM)
  for (let index = 1; index * FRAME <= TO - FROM + 1e-9; index += 1) {
    const t = FROM + index * FRAME
    const now = armAt(t)
    const off = degrees(now.pole, now.chord)
    if (off < lean) { lean = off; leanAt = t }
    const turned = degrees(prev.pole, now.pole)
    if (turned > step) { step = turned; stepAt = t }
    prev = now
  }
  assert.ok(
    lean > 30,
    `the elbow walks to ${lean.toFixed(0)}° of its own chord at ${leanAt.toFixed(3)}s: `
      + 'the frames are on the line the solve has no side to read',
  )
  assert.ok(
    step < 35,
    `the upper arm steps ${step.toFixed(0)}° in a frame at ${stepAt.toFixed(3)}s: `
      + 'the whip is reading two arms instead of turning one',
  )
  // ...and both hand-overs are one arm: half a frame before the cock's key the pose is
  // still on the pole track's own elbow, and half a frame past the release it is on the
  // release key's, so the whip neither starts nor ends on a reading of its own.
  assert.ok(
    degrees(armAt(FROM).pole, armAt(FROM - FRAME / 2).pole) < 10,
    'the whip starts on an elbow the pole track did not leave it on',
  )
  assert.ok(
    degrees(armAt(TO).pole, armAt(TO + FRAME / 2).pole) < 10,
    'the whip ends on an elbow the release key does not draw',
  )
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

test('he lands still travelling, comes to rest in the finish, and nothing moves after it', () => {
  // There is no *give* in this finish: the body comes up out of the stride's fold and
  // the pose it comes to rest in is the pose he stands in for the rest of the beat. The
  // rise is the swing's own — the tail keys carry the pelvis up a tenth of a rig unit
  // over the last tenth of a second (see the sequence's own note) — because a leg is a
  // fixed length: it can only be straight in the frame its foot plants in if the pelvis
  // is already over it by then, and a pelvis that arrives low and stands up afterwards
  // is a knee that gives under the weight (which is what this delivery used to do and
  // what the landing is now authored not to).
  //
  // What the pelvis *does* keep doing is travelling: the stride's plant is a stride
  // further out than it was — the front shoe lands a foot further down the mound, so
  // there is room over it that there was not — and the delivery spends that room over
  // the follow-through rather than arriving at a standstill on the frame the trail foot
  // lands in and holding there. So the finish is no longer one frame: the hips go on
  // forward past the landing, at a rate that only falls (nought of it re-accelerates),
  // and they stop in the frame the hold holds. What is left of the promise is the one
  // that matters and it is the *hold*'s: from the frame the body comes to rest in to
  // the end of the clip nothing moves at all.
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
  // ...and the travel is what the finish is made of: the hips are still going on the
  // frame the trail foot lands in, they go on every frame after it, and every step of it
  // is shorter than the one before it — a rate that decays into the hold rather than a
  // second acceleration once the foot is down.
  const landing = pitcherPose(1.68, ctx())
  const hold = pitcherPose(1.9, ctx())
  const travel = (t) => pitcherPose(t, ctx()).hip.offsetZ
  const follow = [1.68, 1.71, 1.745, 1.78, 1.82, 1.86, 1.9]
  const steps = []
  for (let i = 1; i < follow.length; i += 1) {
    assert.ok(
      travel(follow[i]) < travel(follow[i - 1]),
      `the pelvis stops travelling at ${follow[i]}s: the stride's plant has room it is not being spent in`,
    )
    steps.push(travel(follow[i - 1]) - travel(follow[i]))
  }
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(
      steps[i] < steps[i - 1] + 1e-9,
      `the pelvis travels ${(steps[i] * 100).toFixed(1)} cm on the ${i}th frame of the follow-through against ${(steps[i - 1] * 100).toFixed(1)} on the one before: the finish is re-accelerating`,
    )
  }
  assert.ok(
    travel(1.68) - travel(1.9) > 0.05,
    `the pelvis only travels ${((travel(1.68) - travel(1.9)) * 100).toFixed(1)} cm through the follow-through`,
  )
  // ...and the number the landing does *not* move on is its turn: a body that went on
  // turning across its own finish would be the follow-through turning rather than
  // travelling. Its *height* does move, and it is the stand's own give-back: the fold tops
  // out on the crossing (see FINISH_STAND_FROM), so the hips are paid back the sink they
  // gave it as the trunk comes up — the pelvis rises a few millimetres between the landing
  // and the beat, which is a body standing out of its squat and not a step.
  assert.ok(
    Math.abs(landing.hip.yaw - hold.hip.yaw) < 1e-9,
    `the pelvis turns ${((hold.hip.yaw - landing.hip.yaw) * (180 / Math.PI)).toFixed(3)}° between the landing and the beat`,
  )
  const givenBack = hold.hip.offsetY - landing.hip.offsetY
  assert.ok(
    givenBack > 0 && givenBack < 0.016,
    `the hips move ${(givenBack * 1000).toFixed(1)} mm between the landing and 1.9s: the stand is not the sink being given back`,
  )
  // Both feet are the pitcher's own in the frame he lands in: a finish that plants one
  // foot and leaves the other hanging off its knee is a body leaning on the drive leg
  // rather than standing on its own two feet.
  for (const leg of [...landing.legs, ...hold.legs]) {
    assert.equal(leg.planted, true, 'a foot of the finish is off the ground')
    assert.equal(leg.hang, 0, 'a foot of the finish hangs off its knee')
  }
  // ...and across the hold the *keys'* body is the pause's to the last decimal — the travel
  // is spent by the beat's own first frame, and the turn and both feet are where they were
  // — while what moves over it is the trunk: it is coming up out of the fold all the way to
  // the pause (see the finish's own test), and the hips it was paid out of come up with it.
  // Nothing else does: a step taken on the frames the arm lets the throw go would be a foot,
  // or the pelvis' travel, and neither moves.
  const pause = pitcherPose(2.1, ctx())
  const still = (pose) => [
    pose.hip.offsetZ, pose.hip.yaw,
    ...pose.legs.flatMap((leg) => [...leg.ankle, ...leg.knee]),
  ]
  const held = still(hold)
  const paused = still(pause)
  for (let i = 0; i < held.length; i += 1) {
    assert.ok(
      Math.abs(held[i] - paused[i]) < 1e-9,
      `the ${i}th number of the held finish moves ${(paused[i] - held[i]).toFixed(6)} across the hold`,
    )
  }
  // ...read as a share rather than as an angle: the fold at 1.9 s is already most of the way
  // spent (the stand is paced at two and a half times the keys' tail, see STAND_PACE), so what
  // the beat still owes is the last of it — under half of what the landing frame carried, and
  // what is left by the pause is the keys' own standing lean.
  assert.ok(
    pause.hip.fold < hold.hip.fold * 0.5,
    `the trunk is ${(pause.hip.fold * (180 / Math.PI)).toFixed(1)}° at the pause against ${(hold.hip.fold * (180 / Math.PI)).toFixed(1)}° at 1.9s: the stand is not spent over the beat`,
  )
  assert.ok(
    pause.hip.offsetY - hold.hip.offsetY > 0.001,
    `the hips come up ${((pause.hip.offsetY - hold.hip.offsetY) * 1000).toFixed(1)} mm between 1.9s and the pause: the sink is not given back as the trunk stands`,
  )
  // ...and what the *recovery* finishes is the same movement: the trunk is the keys' own
  // standing body by the walk back (see FINISH_STAND), with both shoes and the pelvis'
  // travel where the hold left them — a body standing up out of what it has done, and not a
  // step taken on the frames the arm lets the throw go.
  // ...and the stand is *finished* by the recovery rather than carried into the walk back:
  // the trunk at 2.8 s is the keys' own standing body (2.9° at the plate) against the 33.7°
  // the landing stood in and the 60.2° the crossing was thrown into. Read against the hold
  // rather than the landing it is a short step — the stand is paced at two and a half times
  // the keys' tail (see STAND_PACE), so 1.9 s is already 8.5° — which is what "stands back
  // up out of the fold by the walk back" means now: the beat is spent standing, and the
  // recovery's own body is the one it stands into.
  const recovered = pitcherPose(2.8, ctx())
  assert.ok(
    recovered.hip.fold < landing.hip.fold - 0.3,
    `the trunk is still folded ${(recovered.hip.fold * 180 / Math.PI).toFixed(0)}° at 2.8s against the landing's ${(landing.hip.fold * 180 / Math.PI).toFixed(0)}°: the torso never stands back up`,
  )
  // ...and the sink is given back where the stand is spent: the pelvis rises 0.017 of a rig
  // unit between the landing and the pause, which is the whole of the FINISH_SINK the fold
  // was paid out of — by 1.9 s only 0.003 of it is left (the stand is paced at two and a
  // half times the keys' tail, see STAND_PACE), so the recovery has next to nothing of it to
  // give. Read over the beat it is the squat standing up, and read after the pause it would
  // be nothing at all.
  assert.ok(
    pause.hip.offsetY - landing.hip.offsetY > 0.015,
    `the hips come up only ${((pause.hip.offsetY - landing.hip.offsetY) * 1000).toFixed(1)} mm between the landing and the pause: the sink is not given back as the trunk stands`,
  )
  assert.ok(
    Math.abs(recovered.hip.offsetY - pause.hip.offsetY) < 0.001,
    `the hips move ${((recovered.hip.offsetY - pause.hip.offsetY) * 1000).toFixed(1)} mm after the pause: the sink is being given back twice`,
  )
  for (let leg = 0; leg < hold.legs.length; leg += 1) {
    for (const place of ['ankle', 'knee']) {
      const moved = distance(hold.legs[leg][place], recovered.legs[leg][place])
      assert.ok(
        moved < 1e-9,
        `a foot of the finish moves ${moved.toFixed(6)} of a rig unit as the trunk stands up: the stand is a step`,
      )
    }
  }
})

test('the mound steps the whole body down its slope, and the pose keeps its own shape', () => {
  // The body's own step down the mound (see ``settle`` in the sequence): the finish
  // lands a metre and a half out in front of the rubber, on ground that is lower than
  // the plateau the stance was solved from, so the frames that drive and land carry the
  // pose down by it rather than dropping onto it at the frame the shoes touch the dirt
  // (see Pitcher.jsx, which solves the step's *depth* off the mound and the ground
  // rule). What the pose has to promise is that the step is a *translation*: every
  // place it carries — the pelvis, both legs' own knee and ankle targets (planted ones
  // and carried ones alike, because a planted leg left behind by its own pelvis is a
  // knee aimed at where the foot used to be — see the step's own note), the throwing
  // arm's places and the ball — comes down by the same amount, and nothing moves along
  // the ground.
  const step = -0.065
  const at = (t, settle = 0) => pitcherPose(t, ctx({ settle }))
  const places = (pose) => [
    ['the pelvis', [pose.hip.yaw, pose.hip.offsetY, pose.hip.offsetZ]],
    ...pose.legs.flatMap((leg, i) => [
      [`leg ${i}'s knee`, leg.knee],
      [`leg ${i}'s ankle`, leg.ankle],
    ]),
    ["the throwing arm's hand", pose.arms[0].hand],
    ["the throwing arm's elbow", pose.arms[0].elbow],
    ['the ball', pose.ball],
  ]
  for (const clip of [1.62, 1.68, 1.9, 2.8]) {
    const flat = places(at(clip))
    const moved = places(at(clip, step))
    let share = null
    for (let i = 0; i < moved.length; i += 1) {
      const [name, [x, y, z]] = moved[i]
      const [, [fx, fy, fz]] = flat[i]
      assert.ok(
        Math.abs(x - fx) < 1e-9 && Math.abs(z - fz) < 1e-9,
        `${name} slides across the ground at ${clip}s (see the step's own note)`,
      )
      const lift = y - fy
      if (share === null) share = lift
      assert.ok(
        Math.abs(lift - share) < 1e-9,
        `${name} steps ${lift.toFixed(4)} of a unit at ${clip}s against ${share.toFixed(4)} everywhere else: the step is a shape rather than a translation`,
      )
    }
    // ...and the pose is not stepped at all until the drive carries it: nought through
    // the release, the whole of it by the landing (see SETTLE_TRACK), which is what the
    // frames either side of the clip are handed.
    const full = clip >= 1.68 ? step : null
    if (full === null) {
      assert.ok(
        share < 0 && share > step,
        `the step is ${share.toFixed(4)} of a unit at ${clip}s: it is not on its way down the slope`,
      )
    } else {
      assert.ok(Math.abs(share - step) < 1e-9, `the step is ${share.toFixed(4)} of a unit at the hold: not the depth it was handed`)
    }
  }
  // The release's own frame does not move under the ball: the placement pins the ball's
  // place on the pitch's own point there, so the step has nothing to spend yet.
  const release = at(AUTHORED_RELEASE_TIME)
  const stepped = at(AUTHORED_RELEASE_TIME, step)
  assert.ok(
    Math.abs(stepped.hip.offsetY - release.hip.offsetY) < 1e-9,
    'the body steps under the release frame: the ball cannot be pinned where it moves',
  )
})

test('the throwing arm lets the throw go straight, folds about the elbow it holds, and pauses there', () => {
  // What the arm does once the pitch is over, in the four movements the delivery asks
  // for. It leaves the release on the arm's own *chord* (see RELEASE_ELBOW and
  // `straightChord`) and it goes on holding it: every frame from the release to the one
  // the crossing lands on is within a whisker of the span, because a wrist handed a
  // place *inside* the chord is an elbow the driver folds to hold it — measured before
  // the sweep's own keys were authored, 21% of the span at 1.36s, which is an elbow 73°
  // off straight on the frames right after the throw (see those keys).
  //
  // What it is straight *for* is the crossing: the upper arm carries the throw down and
  // across the **plate's own line** — the line the pitch goes down, which the pose's
  // frame puts at x = 0 and which holds still under the whole of the delivery — and the
  // elbow is out on the throwing side of it at 1.36s (0.09 of a rig unit) and a couple
  // of centimetres across it by the frame the fold takes the arm over on. That is the
  // landmark the request's "past the strike zone" names, and it is deliberately *not*
  // the torso's own centre line: the chest turns under the arm the whole way through,
  // so a reading taken against the body's own midline drifts with the turn, while the
  // plate's line does not move. What the arm does from there is the request's own three
  // movements, and they are three because they are three different things. The upper arm
  // *reaches its own final spot*: the pose writes the pole at the elbow it means on the
  // fold's own keys, so the direction from the socket to the pole is the upper arm's own
  // line, and across the fold that direction comes down off the throwing shoulder (its own
  // up 0.279 of a unit *down* at the hand-over) and in to the body's own side — the up
  // travelling 0.608 of a unit and the lateral 0.921, so the lateral falls from 0.960 to
  // 0.039 — and *forward of it* by 0.436 (0.024 to 0.460) — and from the frame the travel
  // arrives on (1.745s) it is one number for the whole of the rest of the swing and the
  // hold, so what moves under the forearm is the arm alone. The *forearm* is the pendulum the request asks
  // for: let off the throw's own line it falls to its own bottom (the hand 0.221 of a rig
  // unit under the joint it hangs from at the stop) and then swings back up the *glove*
  // side of the body about that held elbow, its own lateral across the chest's frame from
  // 0.998 at the hand-over through -0.432 at the stop to -0.949 at the rest — falling at
  // every key and never once coming back. And it *decelerates* into the rest, which is the
  // last of the request's own words: the angle it turns through between two keys falls at
  // every step of the swing, 14.1° off the stop through 10.7, 10.3, 8.1 and 6.6 to 4.4° on
  // the last of them, and then to nought. What it settles on is the rest the request
  // names: the forearm level — nought to within a degree of the world's own horizontal —
  // with the elbow at the chest's own side and the *wrist* carried 0.032 of a rig unit
  // across the torso's own centre line.
  //
  // ...and then the pause is the same numbers again on the next key: nothing about the
  // arm moves across the better part of a fifth of a second, which is what makes the
  // recovery's own key (2.80s, the arm long and down at his side) read as the separate
  // movement it is. What the *driver* realises of all this — the elbow's own bend and
  // the wrist's — is the browser suite's to read (see the arm test there).
  const span = RIG.arm.upper + RIG.arm.fore
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  /** A direction from one place to another, as the pose writes the two. */
  const toward = (from, to) => {
    const out = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
    const length = Math.hypot(...out) || 1
    return out.map((value) => value / length)
  }
  /**
   * The arm at one frame: its socket and wrist, where the elbow is, and what the
   * forearm does from there. ``upper`` picks the way the pose names the upper arm —
   * "chord" while the arm is straight (the elbow is on the arm's own line and the pole
   * is dead: see the straight keys' own note), "pole" once the fold has started, where
   * the pose writes the pole *at* the elbow it means.
   */
  const armOf = (t, upper = 'chord') => {
    const pose = pitcherPose(t, ctx())
    const arm = pose.arms[0]
    const socket = shoulderOf(pose, arm.side)
    const wrist = placeOf(pose, arm)
    const reach = distance(wrist, socket)
    const line = upper === 'pole' ? toward(socket, arm.elbow) : toward(socket, wrist)
    const elbow = socket.map((value, index) => value + line[index] * RIG.arm.upper)
    const fore = toward(elbow, wrist)
    // The two places that matter, in the body's own frame: the chest's lateral (the
    // midline's own normal), its up and its forward — the frame the request's "centre
    // line" and "upwards" are written in.
    const centre = chestOf(pose)
    const turn = upperTurnOf(pose)
    const axes = {
      lateral: turnVector(turn, [1, 0, 0]),
      up: turnVector(turn, [0, 1, 0]),
      forward: turnVector(turn, [0, 0, -1]),
    }
    const ofBody = (v) => ({
      lateral: dot(v, axes.lateral),
      up: dot(v, axes.up),
      forward: dot(v, axes.forward),
    })
    return {
      reach,
      // The upper arm's own line in the *rig's* frame, beside the same line in the body's:
      // the keys author their places in the rig, so a place the keys hold is a line that
      // does not move *there* — while the body's own frame turns under it as the trunk
      // stands up, which is the body's movement and not the arm's (see the hold below).
      upperRig: line,
      foreRig: fore,
      // The elbow's own place in the *rig's* frame as well as the body's: the sweep's
      // landmark is the *plate's* own line — the line the pitch goes down, which the
      // pose's frame puts at x = 0 (see `plateBearing`, and the anchor's own solve:
      // the plate is on the rig's midline whatever the pitch's own lateral is) — and
      // the body's frame is what the *torso* is read in, which is a different
      // landmark and the one this test used to name.
      elbowRig: [elbow[0], elbow[1], elbow[2]],
      elbow: ofBody([elbow[0] - centre[0], elbow[1] - centre[1], elbow[2] - centre[2]]),
      upper: ofBody(line),
      foreBody: ofBody(fore),
      // ...and where the *wrist* is, in the same frame: the swing's own end is written at
      // the hand, and "across the torso's centre line" is what that is read against (see
      // the fold's own block).
      wristBody: ofBody([wrist[0] - centre[0], wrist[1] - centre[1], wrist[2] - centre[2]]),
      // The forearm's own elevation off the level, in the world's own sense, and how
      // far the hand stands over the elbow it hangs from.
      elev: (Math.asin(Math.max(-1, Math.min(1, fore[1]))) * 180) / Math.PI,
      rise: wrist[1] - elbow[1],
      handY: wrist[1],
      // ...and the fold *about* the joint: the angle between the upper arm the pose
      // holds and the forearm that hangs off it, which is what a swing about the elbow
      // is a change in. (Nought on the straight keys, whose pole is dead: see `line`.)
      bend: (Math.acos(Math.max(-1, Math.min(1, dot(line, fore)))) * 180) / Math.PI,
      // How much of the hand's own line runs on down the arm it is on: a hand left
      // cocked off its own forearm is a wrist the driver has to bend to hold.
      wrist: dot(lineOf(pose, arm), fore),
    }
  }
  // Straight out of the release and across the body, in the terms the *pose* can
  // promise. The release's own frame is the chord — it is the frame the body is placed
  // by, so its chord is the pitch's own release point — and the window's own keys are
  // authored *long* of it: a share of the span past one, and inside the 1.25 the
  // driver's own bones will stretch to. They have to be, because a straight arm has no
  // slack to answer the one thing the pose cannot know: the driver hangs the arm off
  // the socket its body really carries, the pose writes a ball off the socket it
  // *estimates*, and the two are a few centimetres apart on the frames right after a
  // throw. Measured on the realised skeleton, a key that asked for the chord off the
  // pose's own estimate came back 19% of the span *inside* it at 1.38s — an elbow 73°
  // off straight — so each window key carries the direction the throw already had with
  // the wrist put back out on the driver's own chord, which is the number the browser
  // suite reads (see its own arm test, and the keys' note).
  const window = [1.32, 1.34, 1.36, 1.38, 1.4, 1.42, 1.44, 1.46, 1.48, 1.5, 1.51, 1.52, 1.54]
  for (const t of window) {
    const share = armOf(t).reach / span
    assert.ok(
      share > 0.99 && share < 1.25,
      `the arm reads ${share.toFixed(3)} of its own span at ${t}s: the throw's own line is not the straight one`,
    )
  }
  // ...and *long* of it on every frame the throw's own window is written on: an arm
  // asked for a share inside the chord is an arm the driver folds, whatever the keys
  // around it meant (see the note above).
  for (const t of [1.36, 1.38, 1.4, 1.42, 1.44, 1.46, 1.48, 1.5, 1.51]) {
    const share = armOf(t).reach / span
    assert.ok(
      share > 1.1,
      `the window's own arm is only ${share.toFixed(3)} of its span at ${t}s: it is inside the chord, which is an elbow`,
    )
  }
  // ...and it is the *upper arm* that carries it across the **plate's own line**:
  // still out on the throwing side at the plant, and a couple of centimetres across it
  // by the frame the fold takes the upper arm over on. That is the landmark the shape
  // is about, and not the torso's own centre line: the *torso* turns under the arm the
  // whole way through — read against the chest's own midline the same elbow crosses it
  // a frame or two earlier and the reading drifts with the chest's turn — where the
  // plate's line is the line the pitch goes down and holds still under all of it.
  assert.ok(
    armOf(1.36).elbowRig[0] > 0.05,
    `the elbow is already ${armOf(1.36).elbowRig[0].toFixed(3)} across the plate's own line at 1.36s`,
  )
  assert.ok(
    armOf(1.54, 'pole').elbowRig[0] < -0.03,
    `the elbow is still ${armOf(1.54, 'pole').elbowRig[0].toFixed(3)} on its own side of the plate's line at 1.54s`,
  )
  // The fold and the pause, key by key, off the pole the pose writes from the frame the
  // crossing lands on. The *crossing* key's own pole is the arm's own line rather than
  // the held one — it is the hand-over frame, and the ring the driver hangs the elbow
  // on is read from it (see that key's own note) — so the direction the fold *holds* is
  // the one the key after it writes, and every frame from there is read against it.
  const fold = [1.54, 1.5575, 1.575, 1.61, 1.6275, 1.645, 1.6625, 1.68]
  // ...and the swing's own keys: the stop, the six frames the forearm's arc is written on
  // between it and the rest, and the pause the rest is held through.
  const held = [1.68, 1.71, 1.745, 1.78, 1.82, 1.86, 1.9, 2.1]
  const handed = armOf(1.5575, 'pole')
  const stop = armOf(1.68, 'pole')
  const pause = armOf(1.9, 'pole')
  // ...and the frame the arm's own travel *ends* on: the swing's own third key, from which
  // the line is held for the rest of the beat and out to the pause (see the easing below).
  const home = armOf(1.745, 'pole')
  // The keys the travel is written on: the fall's own last key, the two keys of the swing
  // it is eased over, and the frame it arrives on.
  const travel = [1.6625, 1.68, 1.71, 1.745]
  // The upper arm *travels* to its own final spot: the request's own words are that it
  // reaches the spot and the forearm swings under it, and what the pose writes is that —
  // the direction from the socket to the pole comes down off the throwing shoulder (its
  // own up 0.279 of the unit *down* at the hand-over) and in to the body's own side, where
  // the whole of its lateral is spent as well: its up from -0.279 to -0.887 and its
  // lateral from 0.960 to 0.039, so the elbow the throw left slung out over the shoulder
  // is carried *down* the side of the chest and comes to rest under the socket it hangs
  // from — and *forward of it*, a hand's own length in front of the chest's own centre
  // (0.145 of a rig unit, against the 0.005 the hand-over's own elbow stands at), which is
  // the room the forearm's own sweep across the body's front is read in (see the keys'
  // own note, and the browser suite's arm test).
  //
  // The travel *eases out* rather than stopping where the fall leaves it: the whole arm
  // swings on the arc the socket draws, and a line that arrives at its own spot in one key
  // is a line the *hand* has to be stopped by. The fall brings the arm round at several
  // rig units a second (see the browser suite's reading of the whip), so the last of its
  // travel spent in a single frame drives the hand's own sweep to a full stop in the
  // middle of the swing and starts it again: measured on the realised skeleton before the
  // easing, the hand's own lateral step fell to 0.0001 of a unit at 1.70s and came back to
  // -0.008 on the very next step — a hitch, and one the arm's own line is the only thing
  // that can pay for. So the travel is spread over the swing's first three keys as an
  // ease-out — 0.45 of it by 1.68s, 0.80 by 1.71s and the whole of it by 1.745s, each step
  // smaller than the one before it — and what the elbow's line is *held* on from there is
  // the final spot.
  assert.ok(
    handed.upper.up - home.upper.up > 0.5,
    `the upper arm's own up travels only ${(handed.upper.up - home.upper.up).toFixed(3)} of a unit from the hand-over to its own final spot`,
  )
  // ...and it closes on that spot at *every* step of the travel rather than turning round
  // on it: read as the angle between the line and the line it is going to, the arm backs
  // away from its own spot on no frame of the travel — which is the request's own "no snap"
  // as a number, since a line that reverses is a hand that stops and starts again.
  const toSpot = (t) => {
    const now = armOf(t, 'pole').upper
    const end = home.upper
    const cos = now.up * end.up + now.lateral * end.lateral + now.forward * end.forward
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  }
  let backed = 0
  let backedAt = 0
  for (let t = 1.6625 + 0.0025; t <= 1.745 + 1e-9; t += 0.0025) {
    const step = toSpot(t) - toSpot(t - 0.0025)
    if (step > backed) { backed = step; backedAt = t }
  }
  assert.ok(
    backed < 1e-3,
    `the upper arm's own line backs away from its final spot by ${backed.toFixed(5)} of a degree at ${backedAt.toFixed(4)}s: the travel turns round on its way in`,
  )
  // ...and the *ease* is a schedule rather than a hope: read as the share of the travel's
  // own chord each key has spent, the shares climb and the steps between them fall — the
  // arm arriving at the spot rather than being stopped on it.
  const chord = (() => {
    const from = armOf(travel[0], 'pole').upper
    const to = armOf(travel[travel.length - 1], 'pole').upper
    const d = ['up', 'lateral', 'forward'].map((which) => to[which] - from[which])
    const length = d[0] ** 2 + d[1] ** 2 + d[2] ** 2
    return (t) => {
      const now = armOf(t, 'pole').upper
      const moved = ['up', 'lateral', 'forward'].map((which, i) => (now[which] - from[which]) * d[i])
      return (moved[0] + moved[1] + moved[2]) / length
    }
  })()
  const eased = travel.slice(1, -1).map(chord)
  assert.ok(
    eased[0] > 0.3 && eased[1] > eased[0] && eased[1] < 0.9,
    `the arm carries ${eased[0].toFixed(2)} and then ${eased[1].toFixed(2)} of its own travel at 1.68s and 1.71s: the travel is not spread over the swing`,
  )
  assert.ok(
    eased[0] > eased[1] - eased[0] && eased[1] - eased[0] > 1 - eased[1],
    `the arm's own steps are ${eased[0].toFixed(2)}, ${(eased[1] - eased[0]).toFixed(2)} and ${(1 - eased[1]).toFixed(2)} of the travel: it is not easing into its spot`,
  )
  // ...and it stays on the throwing side of the body's own midline the whole way in, and
  // never rises on the way: the elbow is what the swing turns about, and an elbow carried
  // across the chest's centre is a forearm swinging *through* the body rather than past
  // it. Read at every step of the travel rather than at the keys, because the track
  // between two keys is its own curve.
  let least = 1
  let turning = 0
  for (let t = 1.5575 + 0.005; t <= 1.745 + 1e-9; t += 0.005) {
    const now = armOf(t, 'pole').upper
    const before = armOf(t - 0.005, 'pole').upper
    least = Math.min(least, now.lateral)
    turning = Math.max(turning, now.up - before.up)
  }
  assert.ok(
    least > 0.02,
    `the upper arm's own line comes within ${least.toFixed(3)} of the body's own centre: the elbow crosses the midline on its way to the stop`,
  )
  assert.ok(
    turning < 0.005,
    `the upper arm's travel turns round before it stops: its up comes back up by ${turning.toFixed(4)} of a unit in a two-hundredth of a second`,
  )
  // ...and from the frame the travel arrives on it *is* held, which is what makes the
  // swing's own second half the forearm's movement rather than the arm's: the line `home`
  // writes is the line every key after it writes — all three of the direction's own
  // numbers, to a thousandth of a unit — because the tracks either side are equal and the
  // interpolator's own tangents fall to nought where two keys are.
  //
  // Read in the *body's* own frame rather than the rig's: the keys hold their places on the
  // body they drew, and the pose carries those places with the chest as it stands up out of
  // the finish (see the sequence's `standShare`: whole from the crossing out, so a place the
  // keys wrote is a place on the trunk, turned with it). What that leaves moving in the rig
  // is the chest's own stand and nothing of the arm's, and what it leaves *still* is the
  // line read on the body the arm hangs from — which is the promise: the arm is held, and
  // the body is what carries it up. The shift the socket's travel puts under it (see
  // `foldRide`) is a translation of the whole arm and so moves no line at all.
  //
  // What the body reads is the arm held against the *crossing's* fold while the fold comes
  // off under it: the ride turns the places by the stand since that top, so the keys' own
  // arm is fixed in the world while the chest stands out of the fold, and the line on the
  // body drifts by however far the fold has come up — 0.007 at 1.78 s and 0.0175 at the
  // pause, where the trunk has stood 21.3° under it. At the keys' own pace the same drift
  // was under 0.012 by the pause (the trunk had stood 25.3°); the stand being two and a half
  // times as quick is what spends it sooner rather than further, because the fold it turns
  // by the pause is that much shallower. It is a drift on the body and not a step (the
  // browser suite reads the realised joints frame by frame), and the shape the arm holds —
  // reach, elbow on its ring, hand off its forearm — does not move.
  const settled = armOf(1.9, 'pole').upper
  for (const t of held.filter((key) => key > 1.9)) {
    const now = armOf(t, 'pole').upper
    const body = Math.hypot(now.lateral - settled.lateral, now.up - settled.up, now.forward - settled.forward)
    assert.ok(
      body < 0.02,
      `the upper arm's own line moves ${body.toFixed(4)} of a rig unit on the body between the travel's own end at 1.745s and ${t}s: it is still travelling`,
    )
  }
  // ...and the elbow it holds hangs *down* off its own shoulder, which is the one thing the
  // world says about a throw's arm that the chest's own frame cannot: the trunk comes over
  // the arm through the follow-through, so read against the chest's own lateral the held
  // elbow walks a quarter of a rig unit across the body as the fold deepens (0.484 at the
  // finish's 60°, against the 0.223 the shallower finish read) — and that reading is the
  // *trunk's* movement, not the arm's, because the chest is what turned under it (0.223 of
  // a unit out is the shoulder's own half-width, and the elbow is a socket's width further
  // out again along its own line). In the world the line is the arm's own, and it is the
  // one the swing arrives on: down and a hand's width out from the shoulder, on the frame
  // the travel ends on and on every frame of the hold after it. The *body* is what carries
  // it from there: the pelvis, the trunk and the feet are the landing key's own numbers on
  // every key of the swing and the hold, so what moves under the forearm is the arm alone.
  const hangOf = (at) => {
    const pose = pitcherPose(at, ctx())
    const arm = pose.arms[0]
    return toward(shoulderOf(pose, arm.side), arm.elbow)
  }
  const hang = hangOf(1.745)
  // ...down and out, with the stand's own pace on it: at the frame the travel ends the trunk
  // is 28.9° folded (it was 43° at the keys' own pace), so the arm is carried a little less
  // far over and down the world's vertical — 0.857 of its unit *under* the socket against
  // 0.9, with the same hand's width out (0.279) — and the body is what takes the rest of the
  // carry as it stands. The bound holds the hang rather than the number.
  assert.ok(
    hang[1] < -0.8 && hang[0] < -0.1 && hang[0] > -0.4,
    `the held upper arm points ${hang.map((value) => value.toFixed(3)).join(', ')}: it does not hang down and out from its own shoulder`,
  )
  // The world's own up is *not* the held promise any more: the arm rides the trunk as it
  // stands (see the sequence's `standShare`), so the line that is held on the body lifts in
  // the world as the chest comes up under it — measured over the whole of the hold, 0.236 of
  // the unit at 2.1 s, which is the trunk's own 21.3° of stand between 1.745 s and the pause
  // (35.1° off the crossing's top) and not a swing of the arm's: on the body the same line
  // holds to 0.02 (see above). At the keys' own pace the same carry read 0.158, because the
  // fold at 1.745 s was deeper and there was more of it to spend — the same carry, in less
  // stand. What a windmill would do is many times that, so the bound holds the shape rather
  // than the number: the hang stays a hang.
  for (const at of [1.78, 1.9, 2.1]) {
    const later = hangOf(at)
    assert.ok(
      Math.abs(later[1] - hang[1]) < 0.3,
      `the held upper arm's own up moves ${(later[1] - hang[1]).toFixed(4)} between 1.745s and ${at}s: the arm swings while the body stands`,
    )
  }
  // The *forearm*, then, and it is the pendulum: let off the throw's own line it falls to
  // its own bottom — the hand 0.214 of a rig unit *under* the joint at the stop, against
  // 0.139 at the hand-over — and comes back up the *glove* side of the body about the elbow
  // it holds: read in the chest's own frame the forearm's lateral falls from 0.998 of the
  // unit at the hand-over through the stop's -0.432 to -0.949 at the rest, which is the
  // request's "strictly towards the glove side" as a number.
  assert.ok(
    handed.rise < -0.1 && stop.rise < -0.2,
    `the hand is ${handed.rise.toFixed(3)} of a rig unit over the joint at the hand-over and ${stop.rise.toFixed(3)} at the stop: the forearm never drops`,
  )
  const swing = [1.5575, 1.575, 1.61, 1.6275, 1.645, 1.6625, 1.68, 1.71, 1.745, 1.78, 1.82, 1.86, 1.9]
  const arc = swing.map((t) => armOf(t, 'pole'))
  // What the arc does from the frame the throw lets the arm go is *fall*: read in the
  // world — the frame a hanging arm is read in, and the one the keys' own place decides —
  // the forearm's elevation only goes down from the hand-over to the hold, and the last of
  // it is under the joint rather than level with it. The first frames are the ride's own
  // (the fold is at its top by then, so the socket has already been carried the whole way),
  // and they are bounded rather than ordered, so a deeper fold cannot turn the fall into a
  // windmill.
  const SETTLED = 1.78
  for (let i = 1; i < arc.length; i += 1) {
    if (swing[i] <= SETTLED) {
      assert.ok(
        arc[i].elev - arc[i - 1].elev < 6,
        `the forearm climbs ${(arc[i].elev - arc[i - 1].elev).toFixed(1)}° at ${swing[i]}s: the ride is throwing the arm up rather than letting it down`,
      )
      continue
    }
    assert.ok(
      arc[i].elev < arc[i - 1].elev + 3,
      `the forearm comes back up to ${arc[i].elev.toFixed(1)}° at ${swing[i]}s from ${arc[i - 1].elev.toFixed(1)}°: the arm is climbing again`,
    )
  }
  // ...and strictly toward the glove side *between* the keys as well as on them: the track
  // the keys are joined on is its own curve, and what it may not do is carry the forearm
  // back out toward the throwing side. On the keys the swing is monotone outright — every
  // step of the list above is a fall — and the curve they are joined on is monotone to a
  // ten-thousandth of a unit but for one seam, the hand-over's own (1.5575 to 1.575s),
  // where it overshoots: a fiftieth of one frame's travel there, and the one place in the
  // delivery the fold's asks run *in* toward the socket while the arm is still stretched
  // to hold them (the asks were brought in on those keys so the arm's own stretch — the
  // driver's answer to a place past its reach — can carry the fold through the hand-over,
  // and so the pose's own clamp stays on the frames the asks are inside the reach it
  // holds; see the fold's keys in util/pitcherSequence.js), so the interpolated places
  // move with them. The reading is in the *chest's* frame, which is the finish's to turn:
  // the fold carries the trunk over most of a right angle through those frames (60.2° at
  // the finish, arriving at about 160°/s through the whip — see FINISH_FOLD), so a seam in
  // the world projects a hundredth of a unit onto the chest's own lateral where it used to
  // project a half-thousandth — a fraction of a millimetre of forearm at each frame of the
  // turn, and 0.012 measured at 1.61 s where the fold's own rate is fastest. The reading
  // below holds it under two hundredths, which is a fiftieth of the step a reversal of the
  // swing would make.
  // ...and the fall does not carry the forearm back up between the keys either: the track
  // they are joined on is its own curve, and what a hang may not do is windmill — the
  // elevation is read frame by frame from the hand-over to the pause, and no step of it
  // may climb more than a couple of degrees.
  let back = 0
  let backAt = 0
  for (let t = 1.745 + 0.0025; t <= 2.1 + 1e-9; t += 0.0025) {
    const step = armOf(t).elev - armOf(t - 0.0025).elev
    if (step > back) { back = step; backAt = t }
  }
  assert.ok(
    back < 2,
    `the forearm climbs ${back.toFixed(2)}° between two frames at ${backAt.toFixed(4)}s: the fall turns round on its way into the hang`,
  )
  // ...and the climb is read in the *world*, which is where a pendulum swings: the chest is
  // folded over the elbow through the swing (see FINISH_FOLD), so the same rise projects onto
  // the chest's own up as nought — the forearm's own line at the stop is already the chest's
  // own down — and what the arm does across the beat is 23° of elevation against the world's
  // own level (-70.7° at the stop, -47.8° at the rest). It was 48° at the keys' own pace
  // (-55.1° and -6.9°): the stand now carries the trunk upright by the pause, so the arm it
  // hangs from is the standing body's and the hand sits at the hip rather than held out level.
  // The *chest's* frame is where the arm's own held shape is read, and the bound below holds
  // the world's climb rather than that.
  assert.ok(
    pause.elev < -60 && pause.elev - stop.elev < 8,
    `the forearm reads ${pause.elev.toFixed(1)}° at the pause, ${(pause.elev - stop.elev).toFixed(1)}° off the frame the throw let it go: it is still climbing over the elbow rather than hanging under it`,
  )
  // ...and the hand ends *under the socket it fell from* rather than swung across the
  // body: what the hold is worth by now is the arm's height off its own shoulder. The arm
  // has been let go of by here (see the keys' own note): nothing is holding it out, so it
  // hangs — the hand the better part of a rig unit under the socket, on the throwing side
  // of the body's own centre line.
  const rest = pitcherPose(1.9, ctx())
  const socketOf = (at) => {
    const pose = pitcherPose(at, ctx())
    return shoulderOf(pose, pose.arms[0].side)
  }
  const drop = socketOf(1.9)[1] - rest.arms[0].hand[1]
  assert.ok(
    drop > 0.45 && rest.arms[0].hand[0] < -0.02,
    `the hand hangs ${drop.toFixed(3)} of a rig unit under its own socket, ${rest.arms[0].hand[0].toFixed(3)} of one across the body's centre line: the arm is not hanging down the throwing side`,
  )
  const arcOf = (from, to) => {
    const a = armOf(from, 'pole').foreBody
    const b = armOf(to, 'pole').foreBody
    const cos = a.lateral * b.lateral + a.up * b.up + a.forward * b.forward
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  }
  // ...and the fall *settles* rather than stopping: the arm's own last steps into the
  // hold are smaller than the ones that brought it down, and across the beat itself it
  // does not move at all — the pause is the same numbers on the next key.
  assert.ok(
    arcOf(1.86, 1.9) < 25 && arcOf(1.9, 2.1) < 1,
    `the swing's own last step is ${arcOf(1.86, 1.9).toFixed(2)}° and the hold's is ${arcOf(1.9, 2.1).toFixed(3)}°: the arm is still travelling across the beat`,
  )
  // ...and what it settles into is the rest the keys' own hold place draws: a forearm hanging
  // down the standing body's side, the hand under the joint it hangs from, and the *wrist*
  // carried across the torso's own centre line: 0.27 of a rig unit on the far side of it, so
  // the hand the swing is written at stands across the body's own midline with the palm's
  // own length past it.
  //
  // The arm *rides the trunk as it stands* (see the sequence's `standShare`), so what the rest
  // reads in the world is the chest's own stand on it as much as the arm's: at 1.9 s the trunk
  // is 8.5° folded and by the pause it is the standing body's 2.9°, so the forearm hangs
  // **52.6° under the world's horizontal** with the hand 0.222 of a unit under the joint it
  // hangs from — the arm at his side, carried by a body that has finished standing rather
  // than held out level over a folded trunk (‑6.9° and ‑0.005 at the keys' own pace, where
  // the stand had a third of the beat still to go at the pause). On the body the rest is the
  // shape the keys drew, whatever the world says; the bounds below hold that the arm hangs
  // down and across rather than standing out, and what they still catch is an arm left up.
  assert.ok(
    pause.elev < -60 && pause.rise < -0.3,
    `the forearm is ${pause.elev.toFixed(1)}° at the pause with the hand ${pause.rise.toFixed(3)} of a unit over its own elbow: the arm has not come to rest hanging`,
  )
  // ...and it is read against the *body's* centre line in the rig's own frame rather than
  // through the chest's axes: the trunk is folded 60° over the hand at the rest (see
  // FINISH_FOLD), so a place in front of the chest projects *along* its lateral and the
  // reading becomes the fold's number rather than the hand's. The body's own midline is
  // the same line at every fold — the pelvis is on it and the chest turns about it — and
  // the wrist stands 0.26 of a rig unit on the glove side of it.
  assert.ok(
    rest.arms[0].hand[0] < -0.02,
    `the wrist stands ${rest.arms[0].hand[0].toFixed(3)} across the body's centre line: the hand is not across the body`,
  )
  // ...and the hand rides the swing rather than hanging off it: the line the keys write for
  // the hand *is* the line the forearm takes on the fold's own keys, so the driver has no
  // wrist to fold back on to the arm's own bones while the throw is still on him. (The keys
  // of the hold are the arm at rest, and the hand's own line there is the pose's — see the
  // keys' own note.)
  for (const t of fold) {
    assert.ok(
      armOf(t, 'pole').wrist > 0.75,
      `the hand's own line is ${armOf(t, 'pole').wrist.toFixed(3)} of the way down the forearm at ${t}s`,
    )
  }
  // ...and the swing's own arc runs the hand *up* rather than dropping it back down the arm:
  // the hand's world height climbs at every key from the swing's own bottom — the 1.645 key,
  // where the fall off the throw is spent and the hand hangs 0.252 of a rig unit under the
  // joint — to the rest. A whisker of the trunk's own ride is allowed for: the hand is
  // carried by the socket it hangs from, and the socket is on its way *down* under the fold
  // (see FINISH_SINK), so the last of the fold is worth four millimetres against the swing's
  // own hand's width across the same frames — two at the keys' own pace, and more since the
  // stand is paced at two and a half times that tail (see STAND_PACE), because a place turned
  // by a stood trunk is a place carried a little way *down* the forward lean it was drawn in.
  // What the check holds is that the arm is doing the work, not the body: a hand dropped back
  // down the arm would be ten times that.
  // ...read off the *socket* rather than the ground: the body stands up under the arm
  // through these frames (see FINISH_STAND_FROM), so a world height would rise with the
  // trunk whatever the arm did. What the arm does is lengthen down the body: the hand's
  // own drop under the socket grows from the hand-over to the hold.
  const bottom = 1.71
  const dropOf = (at) => {
    const pose = pitcherPose(at, ctx())
    const arm = pose.arms[0]
    return shoulderOf(pose, arm.side)[1] - placeOf(pose, arm)[1]
  }
  let hung = dropOf(bottom)
  for (const t of held.filter((key) => key > bottom && key < 2.1)) {
    const now = dropOf(t)
    assert.ok(
      now > hung - 0.03,
      `the hand comes back up the body from ${hung.toFixed(3)} to ${now.toFixed(3)} of a rig unit under the socket at ${t}s`,
    )
    hung = now
  }
  // ...and the hold is a stop *of the arm's*: nothing about the places the keys wrote moves
  // across the better part of a fifth of a second — read on the *body*, because that is the
  // body the arm rides as the chest stands up under it (see the sequence's `standShare`).
  // Read in the rig instead, the hold shows exactly the stand: 0.189 of the upper arm's own
  // line and 0.191 of the forearm between the rest and the pause (0.308 and 0.378 between
  // the landing and the pause), all of it the trunk's 11.6° of rise across that window
  // carrying a body-held arm with it. That is the ride's promise rather than a leak in the
  // swing's, and what it leaves the rig is the chest's movement and nothing else.
  const pauseEnd = armOf(2.1, 'pole')
  for (const axis of ['lateral', 'up', 'forward']) {
    const upperMoved = Math.abs(pauseEnd.upper[axis] - pause.upper[axis])
    const foreMoved = Math.abs(pauseEnd.foreBody[axis] - pause.foreBody[axis])
    assert.ok(
      upperMoved < 0.02 && foreMoved < 0.02,
      `the arm's own ${axis} moves across the hold (${upperMoved.toFixed(4)} of the upper arm, ${foreMoved.toFixed(4)} of the forearm): the swing is still travelling`,
    )
  }
  const down = armOf(2.8)
  assert.ok(
    down.reach > span * 0.95 && down.elev < -60 && down.rise < -0.2 && down.elbow.up < -0.2,
    `the arm comes home at ${(down.reach / span).toFixed(2)} of its span with the forearm ${down.elev.toFixed(1)}° below the level at 2.80s`,
  )
})

// ---------------------------------------------------------------------------
// The delivery's own two lateral levers. A pitch thrown wide of the rubber's own line
// is the only one that asks for them (see `pitcherRelease`): the arm's cone carries the
// release as far across as the arm's own lateral reach goes, and the rest of the ask is
// the *body's* — the trunk's roll out toward the side the pitch is thrown from, and the
// metres of carry the step pays for. The two run on different clocks, and what each of
// them costs is why. The roll is paid in *height* — a rolled pelvis comes down on the
// socket the drive leg hangs from by a hip half-width of the roll, and the pelvis is stood
// back up by exactly that (see `rollLift`) — so it can come out over the *kick*, where the
// reach the cock is drawn back off is built, and it does: the trunk comes across over the
// leg the weight is on as the knee comes up over it. The *carry* is paid in the drive
// leg's own line — the pelvis crosses a planted ankle and the leg, a rigid span, comes off
// the vertical by exactly that much — so it waits for the *drive*, where the step is what
// pays for the metres and the front foot's own place is authored across by them: the body
// goes where its step goes rather than the step sliding under a body that stayed.
// ---------------------------------------------------------------------------

test('the trunk leans out over the rubber as the leg kicks, and the step carries what the lean cannot', () => {
  const DEG = 180 / Math.PI
  // The default game's own pitch, body for body: its left-hander's release point stands
  // 1.22 m across the mound — the widest ask a real pitch makes of this body — and the
  // one the browser suite watches (see the visual spec's own game-pitch block).
  const profile = pitcherProfile({
    rig: RIG,
    hand: 'L',
    height: 0.8851,
    release: [1.2157, 0.8851, -16.4025],
    pitcherHeight: 76 * 0.0254,
    side: 1.2157,
  })
  // The ask's own side is the side the roll goes: the keys are authored for a
  // right-hander (whose throwing side is the rig's own +x) and a lefty's delivery is
  // their mirror, so this pitch's body leans out over its own throwing side.
  assert.ok(profile.side < 0, `the game's own lefty is asked for ${profile.side.toFixed(4)}`)
  // The roll is the whole of what a trunk may take — a body asked this wide leans to the
  // end of its own allowance before the step is asked for anything (see TRUNK_TILT_MAX)
  // — and the carry is what the roll's own sine could not reach.
  assert.ok(profile.tilt < 0, `the trunk leans the wrong way: ${(profile.tilt * DEG).toFixed(2)}°`)
  assert.ok(
    Math.abs(profile.tilt + TRUNK_TILT_MAX) < 1e-9,
    `the trunk rolled ${(profile.tilt * DEG).toFixed(2)}° of its own ${(TRUNK_TILT_MAX * DEG).toFixed(2)}° allowance`,
  )
  assert.ok(
    Math.abs(profile.stance) > 0.2 && Math.abs(profile.stance) <= STANCE_SIDE_MAX + 1e-9,
    `the step carried ${profile.stance.toFixed(4)} m`,
  )
  // ...and the three levers are the ask: what the arm's own cone carried (`spent`), what
  // the trunk's roll carried and what the step carried are the pitch's own line, with
  // nothing left over (see ``sideShortfall``).
  assert.ok(Math.abs(profile.sideShortfall) < 1e-9, `the pitch came up ${profile.sideShortfall.toFixed(4)} m short`)
  assert.ok(
    Math.abs(profile.side - (profile.stance + profile.tiltX + profile.release.spent)) < 1e-9,
    `the ask is ${profile.side.toFixed(4)} and the answer ${(profile.stance + profile.tiltX + profile.release.spent).toFixed(4)}`,
  )
  const pose = (t) => pitcherPose(t, ctx({
    hand: 'L', height: profile.rigHeight, stride: profile.stride, side: profile.side,
  }))
  const bare = (t) => pitcherPose(t, ctx({ hand: 'L', height: profile.rigHeight, stride: profile.stride }))
  const tiltAt = (t) => pose(t).hip.tilt
  const liftAt = (t) => pose(t).hip.tiltLift
  const acrossAt = (t) => pose(t).hip.offsetX
  const near = (value, want, what) => assert.ok(
    Math.abs(value - want) < 1e-9,
    `${what}: ${value} against ${want}`,
  )
  // The set and the rocker carry none of it: the stance the clip opens (and closes) in is
  // the stance the profile reads, and a pitcher in the set stands on his own two feet
  // rather than out over the rubber's edge. The kick's own first frame is the rocker — the
  // last frame the stride shoe is on the dirt — and the roll begins with it (see
  // TILT_TRACK).
  for (const t of [0, 0.46]) {
    near(tiltAt(t), 0, `the trunk is already rolling at ${t}s`)
    near(acrossAt(t), 0, `the body has already been carried at ${t}s`)
  }
  // ...and then it comes across over the leg the kick is standing on, in one motion with
  // it: up through the gather and the balance, and the drive spends the last of it. Read as
  // shares of the release's own roll and walked frame by frame, because one motion's
  // promise is its shape — up from the rocker, monotone, and standing by the plant.
  const rolling = [0.6, 0.8, 1.0, 1.05, 1.12].map((t) => tiltAt(t) / profile.tilt)
  const shares = rolling.map((share) => `${(share * 100).toFixed(0)}%`).join(' -> ')
  assert.ok(rolling[0] > 0, `the kick carries none of the roll: ${shares}`)
  for (let frame = 1; frame < rolling.length; frame += 1) {
    assert.ok(
      rolling[frame] > rolling[frame - 1],
      `the roll does not come out across the kick: ${shares}`,
    )
  }
  // ...and the last of it is the drive's rather than the kick's, which is the same shape
  // read at its far end: a roll already whole before the back leg fires would be a body
  // that had answered the ask and then stood on it.
  assert.ok(
    rolling[rolling.length - 1] < 1,
    `the roll is already whole before the plant: ${shares}`,
  )
  // ...and the *height* it costs the legs is not on the same clock: the pelvis' own lift
  // follows the drive (see TILT_LIFT_TRACK), so the frames the kick's roll is coming out on
  // carry none of it — a body rolled over the leg it is standing on, with the leg under it
  // left alone to stand there — and the lift ramps in with the drive, so the two are one
  // motion again from the plant on. (Between the fall and the plant the roll is the more
  // advanced of the two, which is the same fact read the other way: the body is already
  // rolled further over the leg that is carrying it than the height it is charged for, and
  // what the socket really pays over those frames is measured in TILT_LIFT_TRACK.)
  near(liftAt(0.46), 0, 'the pelvis is already paying for the roll at the rocker')
  near(liftAt(0.8), 0, 'the pelvis is paying for the roll before the back leg drives')
  near(liftAt(1.05), 0, 'the pelvis is paying for the roll at the fall')
  assert.ok(
    tiltAt(1.12) / profile.tilt > liftAt(1.12) / profile.tilt,
    'the roll is not ahead of the height it costs over the drive',
  )
  for (const t of [1.2, AUTHORED_RELEASE_TIME, 1.42, 1.68]) {
    near(liftAt(t), tiltAt(t), `the roll and the height it costs are two motions at ${t}s`)
  }
  // ...and the roll is under way on the frames *before* the eyes come off the line they
  // stand in, which is the ordering the kick is chosen for: the head's own clock takes the
  // gaze off the stance and onto the zone between AUTHORED_LOOK_SWEEP_TIME and its lock
  // (see LOOK_PIN), and the body the eyes stand over is already coming across before the
  // sweep starts. Read on both clocks, because what has to hold is which moved first.
  const sweepShare = tiltAt(AUTHORED_LOOK_SWEEP_TIME) / profile.tilt
  assert.ok(
    sweepShare > 0,
    'the trunk is still square when the head starts turning for the zone: the roll is behind the look’s own clock',
  )
  assert.ok(
    sweepShare < rolling[1],
    `the roll is already ${(sweepShare * 100).toFixed(0)}% of the way across by the gather: it is not one motion with the kick`,
  )
  near(tiltAt(1.20), profile.tilt, 'the roll is not complete by the plant')
  // ...and it is complete before the ball goes: the anchor the pitch is placed by is
  // built on the whole of it, so it holds through the window the ball rides the anchor on.
  near(tiltAt(1.30), profile.tilt, 'the roll is not complete by the come-through')
  for (const t of [AUTHORED_RELEASE_TIME, 1.42, 1.48]) {
    near(tiltAt(t), profile.tilt, `the trunk unwound under a ball still riding the anchor at ${t}s`)
  }
  // ...and the follow-through *spends* it: the chest goes on round, the arm sweeps across
  // and the trunk comes up out of the lean it threw from, so what is left of the roll by
  // the frame the back foot lands in is the lean the *finish* stands in (see
  // TILT_LANDING_SHARE) — not the whole of it, and never nought of it on whatever frame
  // the swing happened to reach. Read as shares of the release's own roll, frame by frame,
  // because what "it decays rather than being dropped" is worth is a shape rather than a
  // number: monotone across the follow-through, and still standing at the landing.
  const spent = [1.54, 1.575, 1.61, AUTHORED_LANDING_TIME].map((t) => tiltAt(t) / profile.tilt)
  assert.ok(
    spent[0] > spent[spent.length - 1] + 0.4,
    `the roll comes off the body before the foot is down (${(spent[0] * 100).toFixed(0)}% then ${(spent[spent.length - 1] * 100).toFixed(0)}%)`,
  )
  for (let frame = 1; frame < spent.length; frame += 1) {
    assert.ok(
      spent[frame] < spent[frame - 1],
      `the roll is not coming off across the follow-through: ${spent.map((share) => `${(share * 100).toFixed(0)}%`).join(' -> ')}`,
    )
  }
  // ...and what it is left standing in is *small*, which is the stance's own doing rather
  // than the tempo's: the trail foot lands on the swing's own circle, so the roll a
  // landing can be stood under is the roll whose weight line the two feet the swing puts
  // down already carry (see the landing key's own note). A share read here as a fraction
  // of the ask — 0.10, which is 2.9° of the wide pitch's 28.65°, and the body's own line
  // 0.02 of a unit out of the pelvis against the 0.13 the trail foot's place stands
  // across (both read off the realised skeleton, the second against the same body
  // delivered with no ask at all — see the visual spec's own game-pitch block).
  assert.ok(
    spent[spent.length - 1] > 0.02 && spent[spent.length - 1] < 0.25,
    `the finish stands in ${(spent[spent.length - 1] * 100).toFixed(0)}% of the roll, not the lean a landing stands in`,
  )
  near(
    tiltAt(AUTHORED_LANDING_TIME),
    profile.tilt * TILT_LANDING_SHARE,
    'the landing does not stand in the lean the follow-through left it',
  )
  // ...and it comes off *gently*, which is the request's own shape read twice over: the
  // body does not stand up out of its follow-through on a frame, and the swing comes up
  // out of the lean it threw from and then *settles* onto the finish rather than stopping
  // dead on the frame the shoe touches. Read a sixtieth of a second at a time from the
  // frame the slot ends — where the ball has gone and the follow-through owns the body —
  // through to the clip's own end, on the magnitude of the roll.
  const frame = 1 / 60
  const closing = AUTHORED_LANDING_TIME - frame
  const mag = (t) => Math.abs(tiltAt(t))
  let steepest = 0
  let lastTenth = 0
  let settling = 0
  let rolledBack = false
  let was = mag(AUTHORED_SLOT_END)
  for (let t = AUTHORED_SLOT_END + frame; t <= AUTHORED_CLIP_END + 1e-9; t += frame) {
    const now = mag(t)
    const moved = (was - now) * DEG
    if (moved < -1e-9) rolledBack = true
    steepest = Math.max(steepest, moved)
    if (t > closing) lastTenth = Math.max(lastTenth, moved)
    if (t > AUTHORED_LANDING_TIME) settling = Math.max(settling, moved)
    was = now
  }
  assert.ok(
    steepest < 7,
    `the roll comes off ${steepest.toFixed(1)}° in a single frame: the body stands up out of its own follow-through`,
  )
  assert.ok(
    lastTenth < 0.5 * steepest,
    `the roll is still coming off at ${lastTenth.toFixed(1)}°/frame on the frame the shoe lands, against ${steepest.toFixed(1)}° at its steepest: the follow-through was still spending it when the foot arrived`,
  )
  assert.ok(
    settling * 10 < steepest,
    `the last of the roll goes at ${settling.toFixed(2)}°/frame after both feet are down, against the follow-through's ${steepest.toFixed(2)}°: it is not eased out of the body, it is left standing`,
  )
  assert.ok(
    !rolledBack,
    'the trunk rolled back into the finish after coming up out of it',
  )
  // ...and what is left of it is the *finish*: held to the frame for the whole of the
  // hold — nothing above the legs moves in a hold (see the landing's own note) — and then
  // given up gently as the delivery turns and steps back into the set it began in, so the
  // clip closes in the stance it opened in.
  for (const t of [1.9, 2.8]) {
    near(tiltAt(t), profile.tilt * TILT_LANDING_SHARE, `the trunk moved across the hold at ${t}s`)
  }
  near(tiltAt(AUTHORED_CLIP_END), 0, 'the trunk is still rolled in the set at the clip’s end')
  // The step's own clock is the drive's, and the same window the roll comes out on: nought
  // through the kick — the body the front knee is coming up over has not moved, and the
  // drive leg hangs plumb under it — then out with the back leg's own drive, whole by the
  // plant, so the foot comes down where the body has come to rather than the body arriving
  // after it is down. (The *authored* foot steps across on those frames too: the keys hold
  // the front shoe out until the fall and have it across by the plant.)
  near(acrossAt(1.00), 0, 'the body is carried across the balance, before the back leg drives')
  near(acrossAt(1.05), 0, 'the body is carried across the kick before the back leg drives')
  const midDrive = acrossAt(1.12) / profile.stance
  assert.ok(
    midDrive > 0 && midDrive < 1,
    `the step is ${(midDrive * 100).toFixed(1)}% out halfway through the drive`,
  )
  near(acrossAt(1.20), profile.stance, 'the step is not out by the plant')
  for (const t of [AUTHORED_RELEASE_TIME, 1.42, 1.48]) {
    near(acrossAt(t), profile.stance, `the body came back off its carry at ${t}s`)
  }
  // ...and the carry is held for the same reason the roll is: both feet are on the ground
  // from the plant to the walk-back, what is standing on the ground does not slide, and a
  // carry paid back out from under the finish is the *stride* shoe skating across the
  // mound with the body. So it is held through the whole of the follow-through and the
  // finish, and the walk-back is what carries it home — with the step it was paid in with.
  for (const t of [1.54, AUTHORED_LANDING_TIME, 1.9, 2.8]) {
    near(acrossAt(t), profile.stance, `the body came back off its carry at ${t}s`)
  }
  // ...and the *feet* are held with it, which is the same claim read off the ground the
  // finish is standing on: the trail shoe lands in the frame the hold stands in — one pose,
  // not one that travelled on across the second (the landing key and the two hold keys
  // are the same foot written three times) — so a planted shoe that moved after the weight
  // arrived on it, or a body that settled onto the foot it caught, is caught here.
  const landedLegs = pose(AUTHORED_LANDING_TIME).legs
  for (const t of [1.9, 2.8]) {
    const heldLegs = pose(t).legs
    for (const [index, leg] of landedLegs.entries()) {
      const who = index === 0 ? 'drive' : 'front'
      for (let axis = 0; axis < 3; axis += 1) {
        near(
          leg.ankle[axis],
          heldLegs[index].ankle[axis],
          `the ${who} foot moved ${['across', 'up', 'fore/aft'][axis]} across the hold`,
        )
      }
    }
  }
  const walkedHome = acrossAt(3.14) / profile.stance
  assert.ok(
    walkedHome > 0 && walkedHome < 0.5,
    `the body is ${(walkedHome * 100).toFixed(0)}% of the way back across at the recovery’s own key`,
  )
  near(acrossAt(AUTHORED_CLIP_END), 0, 'the body is still carried in the set at the clip’s end')
  // The two levers move the *body*, and never the foot that stands on the rubber: while
  // the shoe is on it — the whole of the windup, the drive and the release, see
  // PIVOT_RIDE_TRACK — the drive foot's own place is the keys' at every frame, whatever
  // the ask is.
  for (const t of [0.9, 1.0, 1.05, 1.2, AUTHORED_RELEASE_TIME]) {
    const drive = pose(t).legs[0].ankle
    const stillDrive = bare(t).legs[0].ankle
    for (let axis = 0; axis < 3; axis += 1) {
      near(drive[axis], stillDrive[axis], `the drive foot moved ${['across', 'up', 'fore/aft'][axis]} at ${t}s`)
    }
    // ...and what the pair of them costs is the pelvis's own height and nothing else: the
    // roll carries the drive socket down by half a hip's width of its sine (see `rollLift`,
    // which is handed the roll on the *drive's* own clock — the body is rolling with the
    // kick by these frames, and the height the legs are charged for is the share the drive
    // pays: see TILT_LIFT_TRACK), and the carry takes the leg's own span off the vertical,
    // so the body comes up by the one and down by the other and the leg under it stays a
    // straight rod — which is the whole of what a *planted* drive foot's slant costs it.
    near(
      bare(t).hip.offsetY - pose(t).hip.offsetY,
      stanceDip({ rig: RIG, lean: Math.abs(acrossAt(t)) })
        - rollLift({ rig: RIG, tilt: liftAt(t) }),
      `the levers cost the legs something other than their own geometry at ${t}s`,
    )
  }
  // ...and once the delivery has carried it *off* the rubber the drive foot is a foot in
  // the air like the striding one, so its place is a place on the body rather than a place
  // on the field: it rides the body's own carry by the same metres the stride foot's does
  // (see PIVOT_RIDE_TRACK), the leg the swing hangs from keeps the shape its own keys were
  // authored with at every ask, and where it lands is where the body it has to hold up
  // stands. What the swing costs the body's height is the roll's own lift and nothing of
  // the carry's sink: a foot the body is carrying is not a leg the body has to span.
  for (const t of [AUTHORED_SLOT_END, AUTHORED_LANDING_TIME, 1.9, 2.8]) {
    const drive = pose(t).legs[0].ankle
    const front = pose(t).legs[1].ankle
    const stillDrive = bare(t).legs[0].ankle
    const stillFront = bare(t).legs[1].ankle
    near(
      drive[0] - stillDrive[0],
      acrossAt(t),
      `the drive foot did not ride the body's own carry at ${t}s`,
    )
    near(front[0] - stillFront[0], acrossAt(t), `the step's own foot did not go out with the body at ${t}s`)
    near(
      bare(t).hip.offsetY - pose(t).hip.offsetY,
      -rollLift({ rig: RIG, tilt: liftAt(t) }),
      `a foot the body is carrying costs it something other than the roll at ${t}s`,
    )
  }
  // The widest ask this body can be given is the end of the step's own band, and the
  // leaning body that comes out of it is still solved: a pitch asked past both levers
  // comes back with what it could not reach reported rather than a body slid along the
  // rubber (see ``sideShortfall`` and `pitcherPlacement`).
  const past = pitcherRelease({ rig: RIG, hand: 'L', height: 0.8851, side: -2.4 })
  assert.ok(Math.abs(past.tilt + TRUNK_TILT_MAX) < 1e-9, 'a pitch past the levers leaned past the trunk')
  assert.ok(Math.abs(past.stance + STANCE_SIDE_MAX) < 1e-9, `the step gave ${past.stance.toFixed(4)} m`)
  assert.ok(
    Math.abs(past.sink - (STANCE_DIP_MAX - rollLift({ rig: RIG, tilt: past.tilt }))) < 1e-9,
    `the sink is ${past.sink.toFixed(4)} where the levers' own geometry is ${(STANCE_DIP_MAX - rollLift({ rig: RIG, tilt: past.tilt })).toFixed(4)}`,
  )
})

// ---------------------------------------------------------------------------
// The pitcher a pitch is thrown by. Everything above is the *delivery* — the shape a
// body throws — and every test in it hands the shape the model's own rig, because
// that is the frame it is authored in. What follows is the body itself: the
// proportions it is allowed to have (see PROPORTION_BANDS), the stance on the rubber,
// and the release the delivery is aimed at. It is one call per pitch — see
// `pitcherProfile` — which in this app is how a new pitcher is a new body rather than
// the same one throwing from somewhere else.

/** What `clampProportions` holds a body to, read off a rig the way it reads them. */
function proportionsOf(rig, stature) {
  const arm = rig.arm.upper + rig.arm.fore + rig.arm.hand
  return {
    arm: arm / stature,
    armSpan: (arm * 2 + rig.shoulder.halfWidth * 2) / stature,
    forearm: rig.arm.fore / rig.arm.upper,
    leg: (rig.hip.y - rig.ankleY) / stature,
    shin: rig.leg.shin / rig.leg.thigh,
    trunk: (rig.shoulder.y - rig.hip.y) / stature,
    neck: (rig.neckY - rig.shoulder.y) / stature,
    head: (rig.headY - rig.neckY) / stature,
    shoulder: (rig.shoulder.halfWidth * 2) / stature,
    hip: (rig.hip.halfWidth * 2) / stature,
  }
}

/** A number of feet in metres: the pitch data's own unit for a release's distance. */
const feet = (n) => n * 0.3048
/** The pitch's own release point in the world, out of a round number of feet of
 * extension: the frame `pitcherProfile` and `pitcherPlacement` both work in (x is
 * across the rubber, the height is up, and the plate is -z — see RUBBER_Y).
 *
 * ``pitcher`` is the pitcher's own listed height in metres — the feed's
 * ``pitcher_height`` — which is the body's own stature rather than a size the slot
 * asks for (see `pitcherProfile`); left out, the model's own stature stands in. */
const pitchAt = ({ ext, slot, lat = 0, hand = 'R', pitcher = null }) => ({
  hand,
  slot,
  pitcher,
  release: [lat, slot, -feet(60.5 - ext)],
})

// The rubber's own front edge in the world, and the band the drive foot's ankle may
// stand in while some part of the *shoe* is still on it (see PIVOT_AHEAD).
const RUBBER_Z = -RUBBER_Y
const SHOE = [RUBBER_Z - PIVOT_BEHIND, RUBBER_Z + PIVOT_AHEAD]

/** One pitch's whole body: the profile and the placement, as Pitcher.jsx reads them. */
function bodyFor(pitch) {
  const profile = pitcherProfile({
    rig: RIG,
    hand: pitch.hand,
    height: pitch.slot,
    release: pitch.release,
    pitcherHeight: pitch.pitcher,
    // The pitch's own release x is the lateral the *arm* is asked for, which is what
    // Pitcher.jsx hands over: the stance stands on the rubber's own line, and a pitch
    // thrown wide of it is met by the hand coming across rather than by the feet
    // walking after it (see ``side`` in pitcherSequence.js and `pitcherPlacement`).
    side: pitch.release[0],
  })
  return { profile, place: pitcherPlacement({ profile, release: pitch.release, line: 0 }) }
}

test('a body a real staff spans is left alone, and one outside it is driven into it', () => {
  // The model's own body is the reference: every one of its ratios is inside the band
  // a staff spans, so the clamp must not touch it — the delivery is authored in this
  // frame, and a clamp that re-sculpted its owner would move every number above.
  const kept = clampProportions(RIG)
  assert.equal(kept.stature, statureOf(RIG))
  for (const [name, row] of Object.entries(kept.bands)) {
    assert.equal(row.factor, 1, `${name} was moved on a body inside its band`)
  }
  assert.deepEqual(kept.rig.arm, RIG.arm)
  assert.deepEqual(kept.rig.leg, RIG.leg)
  assert.equal(kept.rig.hip.y, RIG.hip.y)
  assert.equal(kept.rig.shoulder.y, RIG.shoulder.y)
  // A body no staff has: an arm off a longer man, legs off a shorter one, a giraffe's
  // neck, a tackle's shoulders and a welterweight's hips.
  const odd = {
    ...RIG,
    arm: { upper: 0.52, fore: 0.30, hand: 0.16 },
    leg: { thigh: 0.36, shin: 0.28 },
    hip: { ...RIG.hip, y: RIG.ankleY + 0.36 + 0.28, halfWidth: 0.21 },
    shoulder: { ...RIG.shoulder, y: RIG.ankleY + 0.64 + 0.52, halfWidth: 0.36 },
  }
  const fitted = clampProportions(odd)
  const moved = []
  for (const [name, row] of Object.entries(fitted.bands)) {
    // What the band promises: the row that comes back is inside it — the rig's own
    // number where it was already there, and the band's own edge where it was not.
    assert.ok(
      row.measured * row.factor >= row.band[0] - 1e-9 && row.measured * row.factor <= row.band[1] + 1e-9,
      `${name} came out at ${row.measured * row.factor}, outside ${row.band}`,
    )
    if (row.factor !== 1) moved.push(name)
  }
  assert.ok(moved.length >= 4, `the odd body was only moved in ${moved.join(', ')}: it is barely out of proportion`)
  // ...and what comes back is a *skeleton*, not a set of numbers that disagree: every
  // ratio read off the fitted rig is inside its band...
  for (const [name, value] of Object.entries(proportionsOf(fitted.rig, fitted.stature))) {
    const band = PROPORTION_BANDS[name]
    assert.ok(
      value >= band[0] - 1e-9 && value <= band[1] + 1e-9,
      `the fitted rig reads ${name} at ${value}, outside ${band}`,
    )
  }
  // ...the joints the chains hang from are still the joints they were: the leg is
  // what the pelvis stands on, the shoulder socket a trunk above the hip, the neck and
  // the head above that, and the two limbs' own bones resized rather than re-divided
  // out of nothing.
  const rig = fitted.rig
  assert.ok(Math.abs(rig.hip.y - (rig.ankleY + rig.leg.thigh + rig.leg.shin)) < 1e-12)
  assert.ok(rig.shoulder.y > rig.hip.y, 'the shoulder socket is below the hip')
  assert.ok(rig.neckY > rig.shoulder.y, 'the neck joint is below the shoulder socket')
  assert.ok(rig.headY > rig.neckY, 'the head joint is below the neck')
  assert.ok(rig.hip.halfWidth > 0 && rig.shoulder.halfWidth > 0)
  assert.ok(
    rig.leg.thigh > odd.leg.thigh && rig.leg.shin > odd.leg.shin,
    'the short legs were divided rather than lengthened',
  )
  assert.ok(
    rig.arm.upper < odd.arm.upper,
    'the long arm was re-divided rather than brought in',
  )
  assert.ok(
    rig.arm.fore / rig.arm.upper > odd.arm.fore / odd.arm.upper,
    'the short forearm was not brought up to the upper arm it sits on',
  )
})

test('the arm\'s angle is the release point\'s own elevation, as a slot is read', () => {
  // Statcast's own reading of a slot, and the number the rest of the profile is named
  // for: the angle the line from the *shoulder* to the *ball* makes with the
  // horizontal — nought is level with the shoulder (a sidearmer), a right angle is
  // straight over the top, and negative is under it (a submarine). What a pitch's own
  // release coordinates say about the slot is then a fact about those coordinates.
  assert.equal(armAngle([0, 1.5, 0], [1, 1.5, 0]), 0)
  assert.equal(armAngle([0, 1.5, 0], [0, 2.5, 0]), 90)
  assert.equal(armAngle([0, 1.5, 0], [0.5, 1, 0]), -45)
  assert.equal(armAngle([0, 1.5, 0], [0, 1, 0]), -90)
  // ...and a pitch's own anchor reads the angle its own coordinates make. The
  // shoulder it is measured from is the ball less the arm it reaches along (the
  // anchor's own line times the reach the profile reports), which is exactly what
  // the release is built from — so the profile's angle is that line's elevation and
  // not an estimate of it.
  for (const pitch of [
    pitchAt({ ext: 6.5, slot: 1.78 }),
    pitchAt({ ext: 5.0, slot: 1.45, hand: 'L' }),
    pitchAt({ ext: 7.5, slot: 2.05 }),
  ]) {
    const { profile } = bodyFor(pitch)
    const reach = profile.release.reach
    const line = profile.release.aim
    const ball = [profile.release.x, profile.release.y, profile.release.z]
    const shoulder = ball.map((value, axis) => value - line[axis] * reach)
    assert.ok(
      Math.abs(armAngle(shoulder, ball) - profile.armAngle) < 1e-9,
      `the profile reads ${profile.armAngle} where the anchor's own coordinates say ${armAngle(shoulder, ball)}`,
    )
  }
})

test('the set stands both feet on the ground, with the shoe on the rubber', () => {
  const pitch = pitchAt({ ext: 6.5, slot: 1.78, lat: -0.55 })
  const { profile, place } = bodyFor(pitch)
  // The stance the profile promises is the *authored* set — the pose's own first key —
  // read rather than re-authored, and what makes it a stance is that it is a pitcher
  // standing on his own two feet: both ankles at the model's own rest height above the
  // soles, neither shoe lifted, and both held flat on the dirt (see the pose's own
  // ``flat`` and ``planted``).
  assert.equal(profile.set.drive[1], RIG.ankleY)
  assert.equal(profile.set.stride[1], RIG.ankleY)
  assert.equal(profile.set.lift, 0)
  assert.equal(profile.set.flat, 1)
  assert.equal(profile.set.planted, true)
  assert.ok(profile.set.spread > 0.2, `the stance's own spread is ${profile.set.spread}`)
  const pose = pitcherPose(0, {
    rig: profile.rig, hand: pitch.hand, height: profile.rigHeight, stride: profile.stride,
  })
  for (const leg of pose.legs) {
    assert.equal(leg.ankle[1], RIG.ankleY, 'a foot is not standing at its own rest height')
    assert.equal(leg.planted, true, 'a foot of the set is not on the ground')
  }
  // ...and the *drive* foot is the one the rubber is pinned to: where its ankle comes
  // out in the world is inside the shoe's own leather, which is the promise the whole
  // placement is solved for (see the sweep below for every pitch the body can hold).
  assert.ok(place.foot[2] >= SHOE[0] - 1e-9 && place.foot[2] <= SHOE[1] + 1e-9)
  assert.ok(Math.abs(place.stance - (RUBBER_Z + profile.contact)) < 1e-12)
  // ...and it is the *drive* foot that is on the rubber and not the striding one: the
  // set stands them that way round in its own frame (the plate is -z, so the foot the
  // body drives off is the one further back), and it is that one the rule names.
  assert.ok(
    profile.set.drive[2] > profile.set.stride[2],
    'the set stands the striding foot behind the drive foot',
  )
})

test('every pitch the body can hold leaves the hand on its own release point, from the rubber', () => {
  // The whole contract, in one sweep: the *ball* leaves the hand the pitch is drawn
  // from — the trajectory's first sample, which is what the app flies — the *drive
  // foot* is on the rubber while it does, the arm at that frame is the straightest the
  // body has, and the body itself is a person's. The three instruments are spent in
  // that order and every one of them is bounded: the stance along the rubber by the
  // shoe's own leather, the delivery's length by the stride band, and the slot by the
  // statures a staff spans.
  // The pitcher each slot belongs to: a release point is a body's own reach, so a
  // higher slot is a taller man — five foot eight under a 1.5 m slot, six foot six
  // under a 2.05 m one, and the middle of the staff in between (see `pitcherProfile`,
  // which stands the body at his own height rather than sizing it for the pitch).
  const pitcherFor = (slot) => Math.max(STATURE_BAND[0], Math.min(STATURE_BAND[1], 1.85 + (slot - 1.78) * 0.9))
  const pitches = []
  for (const ext of [4.5, 5.5, 6.0, 6.5, 7.0, 7.5]) {
    for (const slot of [1.5, AUTHORED_RELEASE_HEIGHT, 1.9, 2.05]) {
      for (const lat of [-0.6, 0, 0.35]) {
        for (const hand of ['R', 'L']) {
          pitches.push(pitchAt({ ext, slot, lat, hand, pitcher: pitcherFor(slot) }))
        }
      }
    }
  }
  let worst = 0
  let held = 0
  let heldWide = 0
  for (const pitch of pitches) {
    const { profile, place } = bodyFor(pitch)
    const where = `${pitch.hand} ${pitch.slot}m/${pitch.release[2].toFixed(2)}m`
    // A pitch the body *cannot* hold is not one of this sweep's: the arm's own cone is
    // what carries a release standing across the mound (see ``side``), so the widest
    // asks meet the longest extensions at pitches whose lateral is past the arm's own
    // reach and whose delivery is past its own length. Those are the shortfall tests'
    // own (the absurd extension below, and the real staff's lowest slot), and they are
    // skipped here rather than asserted at; the two counts below keep the sweep from
    // quietly emptying itself.
    if (Math.abs(profile.sideShortfall) > 1e-3 || profile.shortfall > 1e-3) continue
    held += 1
    if (pitch.release[0] !== 0) heldWide += 1
    // The pitch's own distance in front of the rubber's front edge is the number the
    // delivery's travel and the stance together have to answer for, and the profile
    // says as much: what the delivery carries, plus where the stance stands, plus what
    // neither could, is that distance — reckoned rather than promised.
    assert.ok(
      Math.abs(profile.needed - (pitch.release[2] + RUBBER_Y)) < 1e-12,
      `${where}: the pitch's own extension is not the distance it is in front of the rubber`,
    )
    assert.ok(
      Math.abs(profile.scale * profile.travel + profile.contact + profile.shortfall - profile.needed) < 1e-9,
      `${where}: the delivery and the stance account for ${
        (profile.scale * profile.travel + profile.contact + profile.shortfall).toFixed(4)
      } of the pitch's own ${profile.needed.toFixed(4)}`,
    )
    // The ball leaves from the pitch's own point, laterally and in depth always, and
    // in height at the arm's own reach: the body stands at the *pitcher's* stature
    // rather than at a size the slot asks for, so what the hand comes out at is the
    // anchor's own height at that stature, and the gap to the slot — nought for every
    // pitch a staff throws — is what the profile reports (see `heightShortfall`).
    assert.ok(Math.abs(place.ball[0] - pitch.release[0]) < 1e-3, `${where}: the ball is off the pitch's own line`)
    assert.ok(Math.abs(place.ball[2] - pitch.release[2]) < 1e-3, `${where}: the ball is not at its own depth`)
    // ...and the pivot shoe keeps the rubber while it does: the pitch's own lateral is
    // the *arm's* to reach for (see ``side``), and the stance's own line is held inside
    // the shoe's leather across the mound whatever the ask is — a body slid along the
    // rubber is the one thing a release's own width may not buy (see `pitcherPlacement`).
    assert.ok(
      Math.abs(place.line) <= PIVOT_SIDE + 1e-9,
      `${where}: the drive shoe stands at ${place.line.toFixed(4)}, outside the shoe's own leather across the rubber (${PIVOT_SIDE.toFixed(4)})`,
    )
    assert.ok(
      Math.abs(place.ball[1] - profile.scale * profile.release.y) < 1e-9,
      `${where}: the ball is at ${place.ball[1].toFixed(4)} against the arm's own ${(profile.scale * profile.release.y).toFixed(4)}`,
    )
    assert.ok(
      Math.abs(profile.heightShortfall - (pitch.slot - profile.scale * profile.release.y)) < 1e-9,
      `${where}: the profile's own height shortfall is not the gap between the slot and the arm's reach`,
    )
    // ...and the body is the pitcher's own: his own listed height, at the scale that is
    // that height over the rig's own stature — and it is clamped, not solved.
    assert.ok(
      Math.abs(profile.stature - Math.max(STATURE_BAND[0], Math.min(STATURE_BAND[1], pitch.pitcher))) < 1e-12,
      `${where}: the body stands at ${profile.stature} rather than at the pitcher's own ${pitch.pitcher}`,
    )
    assert.ok(
      Math.abs(profile.scale - profile.stature / statureOf(RIG)) < 1e-12,
      `${where}: the body is stood at ${profile.scale} rather than at the pitcher's own stature over the rig's`,
    )
    assert.equal(place.position[1], 0, `${where}: the body is floated off the ground`)
    // ...and the drive foot is on the rubber: the shoe's own leather is where a pitcher
    // stands rather than wherever a search for a body size left him.
    // The band is the *stance's* own line (the profile holds `contact` inside the shoe's
    // leather, see PIVOT_AHEAD): the foot that comes back is that line spun by the yaw
    // the pitch's own lateral turns the body through, which is worth a few millimetres
    // of it on the widest asks (1.4 mm measured on this grid).
    assert.ok(
      place.foot[2] >= SHOE[0] - 5e-3 && place.foot[2] <= SHOE[1] + 5e-3,
      `${where}: the drive foot is at ${place.foot[2].toFixed(3)}, the rubber's own line ${RUBBER_Z.toFixed(3)} and the shoe's ${SHOE[0].toFixed(3)}..${SHOE[1].toFixed(3)}`,
    )
    // How far the foot came out of the stance's own line is the shortfall the profile
    // reported — to within the centimetre or two the yaw itself is worth here: the
    // stance's own line is a line on the *rubber*, and the delivery that reaches the
    // pitch's point is turned off that line by the pitch's own lateral offset (a body
    // faces home plate from where it stands), which carries the ball a shoulder's width
    // across the body a degree or so round, and its z the couple of centimetres this
    // tolerance is. What is exact is the two promises either side of it: the shoe is on
    // the rubber's own leather, and the ball is on the pitch's own point.
    assert.ok(
      Math.abs(place.slide - profile.shortfall) < 0.02,
      `${where}: the shoe is ${place.slide.toFixed(4)} out of the stance's line against a reported shortfall of ${profile.shortfall.toFixed(4)}`,
    )
    // The arm at the release: the straightest chord the driver builds (see
    // `straightChord`), the ball one palm on down its line, and the angle that line
    // makes with the horizontal inside the band a staff's arms span.
    const carry = releaseCarry(profile.rig, pitch.hand)
    assert.ok(
      Math.abs(profile.release.wristReach - straightChord(profile.rig.arm.upper, profile.rig.arm.fore)) < 1e-12,
      `${where}: the wrist is not on the straightest chord the arm has`,
    )
    assert.ok(Math.abs(profile.release.reach - (profile.release.wristReach + carry)) < 1e-12)
    const low = (ARM_ANGLE_BAND.low * 180) / Math.PI
    const high = (ARM_ANGLE_BAND.high * 180) / Math.PI
    assert.ok(
      profile.armAngle >= low - 1e-9 && profile.armAngle <= high + 1e-9,
      `${where}: the arm's angle at the release is ${profile.armAngle.toFixed(1)}°, outside the band's ${low}°..${high}°`,
    )
    // ...and the angle is the release point's own: the elevation of the line from the
    // socket the arm hangs from to the ball, which is how Statcast reads a slot.
    const line = profile.release.aim
    assert.ok(Math.abs(Math.hypot(...line) - 1) < 1e-12, `${where}: the hand's own line is not a line`)
    assert.ok(
      Math.abs(profile.armAngle - (Math.asin(Math.max(-1, Math.min(1, line[1]))) * 180) / Math.PI) < 1e-9,
      `${where}: the angle is not the one the release point's own line makes`,
    )
    // The body: proportions a person's — read against the stature the rig's own joints
    // make, which is the frame the clamp is read in and the frame a uniform scale leaves
    // alone — a stature inside the band of statures, and a slot the arm can hold.
    for (const [name, value] of Object.entries(proportionsOf(profile.rig, profile.rigStature))) {
      const band = PROPORTION_BANDS[name]
      assert.ok(
        value >= band[0] - 1e-9 && value <= band[1] + 1e-9,
        `${where}: the body reads ${name} at ${value.toFixed(3)}, outside ${band}`,
      )
    }
    assert.equal(profile.rigStature, statureOf(RIG))
    assert.ok(profile.stature >= STATURE_BAND[0] - 1e-9 && profile.stature <= STATURE_BAND[1] + 1e-9)
    assert.ok(profile.stride >= STRIDE_BAND[0] - 1e-9 && profile.stride <= STRIDE_BAND[1] + 1e-9)
    // ...and the pose that throws it is handed this body and this release: the release
    // frame's own ball is the anchor the profile placed, so what the component flies
    // and what the delivery puts in the air are one place.
    const pose = pitcherPose(AUTHORED_RELEASE_TIME, {
      rig: profile.rig, hand: pitch.hand, height: profile.rigHeight, stride: profile.stride,
      side: profile.side,
    })
    assert.ok(
      distance(pose.ball, [profile.release.x, profile.release.y, profile.release.z]) < 1e-9,
      `${where}: the delivery's own release frame is not the anchor the profile placed`,
    )
    worst = Math.max(worst, profile.heightShortfall)
  }
  assert.ok(
    held > 100 && heldWide > 40,
    `the sweep kept ${held} pitches (${heldWide} of them standing across the mound): the grid is not being swept`,
  )
  // The sweep above is a sweep of pitches the body can *hold*: what it must not be is a
  // sweep of pitches nothing reaches (see the shortfall test below), because every one
  // of them is a release point off the arm of the man who threw it — and a slot nothing
  // can reach would be a slot the profile had to report rather than stand up to.
  assert.ok(worst < 1e-9, `a slot in the sweep is saturated by ${worst}`)
})

test('the delivery\'s length is the pitch\'s own extension, and the stance takes what is left', () => {
  // The two instruments, and the order they are spent in. The pitch's own extension is
  // the stride's: a pitcher whose release is closer to the plate than the authored
  // delivery reaches throws a shorter one — the *same* shape taken less far — and the
  // stance along the rubber only takes the small differences the shoe's own leather
  // can. What neither can carry is reported rather than absorbed.
  // The authored delivery's own reach, in metres, at the slot the rest of this test
  // throws from: read off a profile that was asked for no particular release point, so
  // what it is is the model's own delivery at its own stride (see `pitcherProfile`).
  const own = pitcherProfile({ rig: RIG, hand: 'R', height: AUTHORED_RELEASE_HEIGHT })
  const reach = own.scale * own.travel
  // A difference the shoe's own leather covers (see PIVOT_AHEAD): the delivery is the
  // authored one and the *stance* is what moves.
  const near = bodyFor(pitchAt({ ext: (reach - PIVOT_AHEAD / 2) / 0.3048, slot: AUTHORED_RELEASE_HEIGHT }))
  assert.equal(near.profile.stride, 1, 'a difference the stance can take moved the delivery')
  assert.ok(Math.abs(near.profile.contact + PIVOT_AHEAD / 2) < 1e-9)
  assert.equal(near.profile.shortfall, 0)
  // A pitch the shoe cannot reach: the delivery itself is shorter, and the ball still
  // leaves the pitch's own point with the stance back on the rubber.
  const short = bodyFor(pitchAt({ ext: (reach - PIVOT_BEHIND - 0.1) / 0.3048, slot: AUTHORED_RELEASE_HEIGHT }))
  assert.ok(short.profile.stride < 1, `a short release moved nothing: the stride is ${short.profile.stride}`)
  assert.ok(Math.abs(short.profile.stride - 1) > 0.02, 'the stride barely moved')
  assert.equal(short.profile.shortfall, 0)
  assert.ok(short.place.foot[2] >= SHOE[0] - 1e-9 && short.place.foot[2] <= SHOE[1] + 1e-9)
  // ...and the other end: a pitch that reaches further than the authored delivery does.
  const far = bodyFor(pitchAt({ ext: (reach + PIVOT_AHEAD + 0.3) / 0.3048, slot: AUTHORED_RELEASE_HEIGHT }))
  assert.ok(far.profile.stride > 1, `a long release moved nothing: the stride is ${far.profile.stride}`)
  assert.equal(far.profile.shortfall, 0)
  assert.ok(far.place.foot[2] >= SHOE[0] - 1e-9 && far.place.foot[2] <= SHOE[1] + 1e-9)
  // ...and what neither can carry: a release point no delivery of this body's reaches
  // (a pitch thrown from half way to the plate). The stride stops at the band's own
  // edge, the ball still leaves the pitch's own point, and the shoe leaves the rubber
  // by exactly what the profile reports — the app's priority, in one number.
  const absurd = bodyFor(pitchAt({ ext: (reach + 2.4) / 0.3048, slot: AUTHORED_RELEASE_HEIGHT }))
  assert.equal(absurd.profile.stride, STRIDE_BAND[1])
  assert.ok(absurd.profile.shortfall > 0.5, `the shortfall is only ${absurd.profile.shortfall}`)
  assert.ok(Math.abs(absurd.place.slide - absurd.profile.shortfall) < 0.02)
  // ...the ball is the pitch's own point to the millimetre, and it is the *shoe* that
  // gave: the app will not fly a pitch from anywhere but where the pitch says it was
  // thrown, whatever the body it has did.
  assert.ok(Math.abs(absurd.place.ball[2] - absurd.profile.needed + RUBBER_Y) < 1e-3, 'the ball gave way instead of the shoe')
  assert.ok(absurd.place.foot[2] > SHOE[1], 'the shoe stayed on the rubber: the ball must have given instead')
})

test('a new pitcher is a new body, and every one of them is placed for his own pitch', () => {
  // The app carries no roster: a pitch is a release point, a hand and a height, and the
  // profile is one call per pitch — so a new pitcher is a new release point, and the
  // body, the stance and the release all follow from it. What this holds is that they
  // *do* follow: three different pitchers throw from three different places, and no two
  // of them are the same body.
  const staff = [
    // a sidearming left-hander, low and close to the plate
    pitchAt({ ext: 5.0, slot: 1.35, lat: 0.45, hand: 'L', pitcher: 1.8034 }),
    // a tall right-hander reaching out over it
    pitchAt({ ext: 7.5, slot: 1.98, lat: -0.25, hand: 'R', pitcher: 2.0828 }),
    // and a three-quarters' own
    pitchAt({ ext: 6.2, slot: AUTHORED_RELEASE_HEIGHT, lat: 0.1, hand: 'R', pitcher: 1.8796 }),
  ]
  const bodies = staff.map(bodyFor)
  for (let i = 0; i < bodies.length; i += 1) {
    const { profile, place } = bodies[i]
    assert.ok(Math.abs(place.ball[0] - staff[i].release[0]) < 1e-3)
    assert.ok(Math.abs(place.ball[2] - staff[i].release[2]) < 1e-3)
    assert.ok(place.foot[2] >= SHOE[0] - 1e-9 && place.foot[2] <= SHOE[1] + 1e-9)
    // The release's own arm angle is the body's own answer for that slot, and the
    // three of them are three different answers: a low slot under a sidearmer's arm
    // and a tall one over a reach is what makes a staff read as different pitchers.
    const low = (ARM_ANGLE_BAND.low * 180) / Math.PI
    const high = (ARM_ANGLE_BAND.high * 180) / Math.PI
    assert.ok(profile.armAngle >= low - 1e-9 && profile.armAngle <= high + 1e-9)
  }
  assert.ok(
    bodies[0].profile.armAngle < bodies[2].profile.armAngle && bodies[2].profile.armAngle < bodies[1].profile.armAngle,
    `the staff's three slots read ${bodies.map((b) => b.profile.armAngle.toFixed(1)).join(', ')}: the angle does not follow the slot`,
  )
  // ...and the deliveries follow the extensions the three throw with, which is the
  // other thing that makes a staff a staff: the short release is thrown out of a
  // shorter delivery and the long one out of a longer, over the same two statures.
  assert.ok(
    bodies[0].profile.stride < bodies[2].profile.stride && bodies[2].profile.stride < bodies[1].profile.stride,
    `the staff's three extensions read ${bodies.map((b) => b.profile.stride.toFixed(2)).join(', ')}: the delivery does not follow the pitch`,
  )
  // ...and every body is *his* own: the stature the feed lists him at, held inside the
  // statures a staff spans, stood at the scale that stature is worth over the rig's own
  // — so the tall one is the big man he is and the short one the small man, rather than
  // one model sized by whatever slot each pitch asked for.
  for (let i = 0; i < bodies.length; i += 1) {
    assert.ok(
      Math.abs(bodies[i].profile.stature - staff[i].pitcher) < 1e-12,
      `the staff's number ${i} stands at ${bodies[i].profile.stature} rather than at his own ${staff[i].pitcher}`,
    )
    assert.ok(
      Math.abs(bodies[i].profile.scale - staff[i].pitcher / statureOf(RIG)) < 1e-12,
      `the staff's number ${i} is stood at ${bodies[i].profile.scale} rather than at his own height over the rig's stature`,
    )
    assert.equal(bodies[i].profile.heightShortfall, 0, `the staff's number ${i} could not hold his own slot`)
  }
  assert.ok(
    bodies[1].profile.scale > bodies[2].profile.scale && bodies[2].profile.scale > bodies[0].profile.scale,
    `the staff's three sizes are ${bodies.map((b) => b.profile.scale.toFixed(3)).join(', ')}`,
  )
  // What a new pitcher does *not* change is the model's own body: the proportions are
  // the rig's, one clamp for all of them, and what a pitch changes is the stature it is
  // stood at and how it throws — which is the app's honest reading of "a new pitcher"
  // with one model in the box (see `pitcherProfile`).
  assert.deepEqual(bodies[1].profile.rig.arm, bodies[0].profile.rig.arm)
  assert.deepEqual(bodies[1].profile.rig.leg, bodies[0].profile.rig.leg)
  // ...and the two hands are the same body mirrored rather than two bodies: the anchor
  // comes off the other socket, and the stance's own lateral is the other way.
  const lefty = bodies[0]
  // ...and the *pitch* mirrored with them: a staff's own release stands on his own
  // side of the mound, so the same lateral on the other hand is a different pitch —
  // one thrown across the body, which the arm reaches for out of a different cone
  // (see ``side``) — and the mirror two bodies are compared at is the mirrored one.
  const righty = bodyFor({
    ...staff[0],
    hand: 'R',
    release: [-staff[0].release[0], staff[0].release[1], staff[0].release[2]],
  })
  assert.equal(lefty.profile.stature, righty.profile.stature)
  assert.equal(lefty.profile.stride, righty.profile.stride)
  assert.ok(Math.abs(lefty.profile.release.x + righty.profile.release.x) < 1e-9)
  assert.ok(Math.abs(lefty.place.foot[0] - righty.place.foot[0]) > 0.1)
})

test('a pitcher\'s own height is his body, and a slot past its reach is reported', () => {
  // The feed carries a pitcher's listed height the way it carries a batter's (see the
  // backend's ``pitcher_height``), and that number is the body's own stature: what the
  // pitch decides is where the body *stands* and how it throws, never how big it is.
  // The two halves of the stance's own solve meet exactly here — the height the body is
  // stood at, and the arm's own angle at the release point — so the same pitch point out
  // of two different men is two different stances: the taller one reaches it from
  // further back along the rubber, off the higher shoulder, which is the *lower* slot
  // for the same ball (Statcast's own reading of an arm's angle, see `armAngle`).
  // Six feet of extension: inside the delivery the band allows *both* of these bodies
  // (see STRIDE_BAND, which is a share of the authored delivery rather than a distance —
  // the extension a body covers scales with its own size, so the shorter of the two is
  // the one the band's own edge reaches first, and 6.5 ft is at that edge for him: the
  // band's ends, and what happens at them, are the test above's).
  const pitch = { ext: 6.0, slot: 1.78, lat: -0.55 }
  const world = -feet(60.5 - pitch.ext)
  const short = bodyFor(pitchAt({ ...pitch, pitcher: 1.83 }))
  const tall = bodyFor(pitchAt({ ...pitch, pitcher: 2.03 }))
  const fitted = clampProportions(RIG).rig
  for (const body of [short, tall]) {
    // The body is one model's, clamped once: the pitcher's own height decides the scale
    // it is stood at, not the shape it has, and the stance is solved as before — the ball
    // on the pitch's own point, the shoe on the rubber, the feet on the ground. The
    // proportions are read against the rig's own stature: a uniform scale is a body of
    // the same shape at another size, so the two reads are one body.
    for (const [name, value] of Object.entries(proportionsOf(body.profile.rig, body.profile.rigStature))) {
      const band = PROPORTION_BANDS[name]
      assert.ok(
        value >= band[0] - 1e-9 && value <= band[1] + 1e-9,
        `the body reads ${name} at ${value.toFixed(3)}, outside ${band}`,
      )
    }
    assert.deepEqual(body.profile.rig, fitted)
    assert.equal(body.profile.shortfall, 0)
    assert.equal(body.profile.heightShortfall, 0)
    assert.equal(body.place.position[1], 0, 'the body is floated off the ground')
    assert.ok(body.place.foot[2] >= SHOE[0] - 1e-9 && body.place.foot[2] <= SHOE[1] + 1e-9)
    assert.ok(Math.abs(body.place.ball[0] - pitch.lat) < 1e-3)
    assert.ok(Math.abs(body.place.ball[2] - world) < 1e-3)
  }
  assert.ok(Math.abs(short.profile.stature - 1.83) < 1e-12)
  assert.ok(Math.abs(tall.profile.stature - 2.03) < 1e-12)
  assert.ok(short.profile.scale < 1 && tall.profile.scale > 1, 'the two bodies are the same size')
  // ...and the stance follows the two together: the taller man's own reach carries the
  // ball to the pitch's point from further back, and the arm that carries it there hangs
  // at the lower angle off his higher shoulder.
  assert.ok(
    tall.profile.contact < short.profile.contact,
    `the taller man stands at ${tall.profile.contact.toFixed(3)} against the shorter one's ${short.profile.contact.toFixed(3)}`,
  )
  assert.ok(
    tall.profile.armAngle < short.profile.armAngle,
    `the taller man's arm reads ${tall.profile.armAngle.toFixed(1)}° against the shorter one's ${short.profile.armAngle.toFixed(1)}°`,
  )
  // A slot above what his own arm can hold is *not* a bigger body: the body stays his,
  // the pose is handed the arm's own ceiling, and the metres between it and the pitch's
  // own slot are what ``heightShortfall`` reports.
  const small = { ext: 6.5, lat: -0.2, pitcher: 1.70 }
  const smallWorld = -feet(60.5 - small.ext)
  const held = bodyFor(pitchAt({ ...small, slot: 1.5 }))
  // The slot is inside the body's own envelope, so the shoe is on the rubber's own
  // leather and nothing is left over: the stance covers the pitch's distance outright.
  assert.ok(held.place.foot[2] >= SHOE[0] - 1e-9 && held.place.foot[2] <= SHOE[1] + 1e-9)
  assert.equal(held.profile.shortfall, 0)
  const over = bodyFor(pitchAt({ ...small, slot: 2.05 }))
  // The pitch is past what the arm can lift a ball to: the metres between its own slot
  // and the arm's own ceiling are reported (the rest is answered by the body standing
  // taller than its own rest — see `slotCeiling`, which is where the ceiling comes
  // from).
  assert.ok(over.profile.heightShortfall > 0.08, `a 1.70 m body held a 2.05 m slot: ${over.profile.heightShortfall}`)
  assert.equal(held.profile.heightShortfall, 0)
  assert.equal(over.profile.stature, held.profile.stature)
  assert.equal(over.profile.scale, held.profile.scale)
  assert.ok(
    Math.abs(over.profile.ceiling - over.profile.scale * over.profile.release.y) < 1e-9,
    'a slot the arm cannot hold did not come out standing at the arm’s own ceiling',
  )
  assert.ok(
    Math.abs(over.profile.heightShortfall - (2.05 - over.profile.ceiling)) < 1e-9,
    'the reported shortfall is not the gap between the slot and the arm’s own ceiling',
  )
  assert.ok(
    over.profile.rigHeight < 2.05 / over.profile.scale - 1e-6,
    'the pose was handed the pitch’s own slot rather than the arm’s own ceiling',
  )
  // ...and the stance's own promises hold to the millimetre even there: the feet are on
  // the ground, the ball is on the pitch's own line — only its *height* is the arm's
  // rather than the pitch's. What gives is the *shoe*: a body stood at its own ceiling
  // has its arm nearly vertical, so it reaches less far *forward* than it does at any
  // slot inside its band, and the delivery's stride band runs out before the ball is
  // as far in front of the rubber as the pitch's own point asks. The leftover is
  // ``shortfall``, reported in metres, and it is the stance that comes off the rubber
  // by exactly that much rather than the pitch that comes off its own point (see
  // `pitcherProfile` and `pitcherPlacement`, which is where the two promises are
  // ordered).
  assert.equal(over.place.position[1], 0)
  assert.ok(over.profile.shortfall > 0.1, `the over-slot delivery came out with ${over.profile.shortfall} m of shortfall`)
  // ...to within the yaw's own coupling, which is what the *spun* foot costs against
  // the stance's own line (see the sweep's note above): 1.4 mm on this pitch.
  assert.ok(
    Math.abs(over.place.foot[2] - (RUBBER_Z + PIVOT_AHEAD + over.profile.shortfall)) < 5e-3,
    `the shoe is at ${over.place.foot[2].toFixed(3)}, not the leather's own edge plus the ${over.profile.shortfall.toFixed(3)} m of shortfall`,
  )
  // ...and the stance's own line is the leather's edge for the same reason (the spun
  // foot's own millimetre, see above).
  assert.ok(
    Math.abs(over.place.slide - over.profile.shortfall) < 5e-3,
    `the shoe came ${over.place.slide.toFixed(4)} out of the stance for ${over.profile.shortfall.toFixed(4)} m of shortfall`,
  )
  assert.ok(Math.abs(over.place.ball[0] - (-0.2)) < 1e-3)
  assert.ok(Math.abs(over.place.ball[2] - smallWorld) < 1e-3)
  assert.ok(Math.abs(over.place.ball[1] - over.profile.ceiling) < 1e-9)
  // The band a staff spans is still the band, though: a listed height outside it is the
  // data's own typo rather than a body, and the clamp answers it rather than the pitch.
  const giant = pitcherProfile({ rig: RIG, hand: 'R', pitcherHeight: 2.6 })
  const child = pitcherProfile({ rig: RIG, hand: 'R', pitcherHeight: 1.2 })
  assert.equal(giant.stature, STATURE_BAND[1])
  assert.equal(child.stature, STATURE_BAND[0])
  // ...and the rig a height outside the band is stood at is the same clamped one, bone
  // for bone: it is the *stature* the number is held to, not the body it is read against.
  assert.deepEqual(giant.rig, fitted)
  assert.deepEqual(child.rig, fitted)
})

// ---------------------------------------------------------------------------
// The real staff, at the two ends of it.
//
// Everything above is the model on round numbers. This section is the *real* league's
// own two ends, recorded out of the live feed the app itself parses (the backend's
// `_pitch_parameters_from_event`: the 50-ft measurements back-propagated to the
// reported extension — a reconstruction that reproduces Baseball Savant's own
// `release_pos_x`/`release_pos_z` for these very pitches to the centimetre, and the
// Savant `arm_angle` each pitch is quoted with is its own published reading):
//
//   * Trey Yesavage ("6' 4"", RHP, 2025-09-27, gamePk 776159): released 2.13-2.20 m
//     up, which is 1.10-1.14 of his own stature, with Savant arm angles of 55-65° —
//     the top of the league's release heights (his 679 pitches of the 2025 season and
//     postseason run 2.08-2.24 m and 55-73°);
//   * Tyler Rogers ("6' 3"", RHP, 2025-09-25, gamePk 776187): released 0.36-0.40 m up,
//     which is 0.19-0.21 of his own stature, with Savant arm angles of -60 to -63° —
//     the lowest release point in the league (his 991 pitches run 0.31-0.49 m and
//     -67 to -53°).
//
// What holds for both of them is everything the round-number pitches above hold: the
// body is his own stature, the proportions are a person's, the stance accounts for the
// pitch's own distance with the shoe on the rubber and the feet on the ground, and the
// ball is on the release point's own lateral and depth — and, now, the release's own
// *height* as well, which is the thing this section exists to pin.
//
// What makes that hold is the release posture being *solved* rather than authored (see
// `releasePosture`): a real staff's release shoulder is not one posture, it is the
// slot's own — a submarine's folds down toward 0.53 of the stature, an over-the-top
// arm's stands at 0.78 — and the two are one solve, because the slot's own arm angle
// names both at once. The law is `releaseShoulderShare`: the shoulder's share read off
// the arm's own sine, laid across the band's two ends (ARM_ANGLE_BAND, which is the
// real staff's own span: Savant reads a season from -67° to +73°). With it, the
// model's own envelope is the arm's reach over that shoulder at the two ends of the
// band — 1.143 of the stature at the top and 0.181 at the bottom, against the 0.985
// and 0.474 of the old, one-posture model — and both of these men's real pitches come
// off the arm with **no** shortfall at all.
//
// What is *left* of the old failure is the arm's own angle: the model's arm is the
// short end of a person's (0.38 of the stature over the reach a release is thrown
// with), so standing a real top-of-the-league slot on the model's own shoulder asks a
// steeper angle than Savant's own reading of the same pitch — 10-11° at Yesavage's
// worst, 3° at Rogers's. That is the honest reading of a model whose arm is short: the
// ball comes off the same place on the same body, and what differs is how high the
// line from the socket to it stands. The alternative — growing the arm, or standing
// the body taller than the man — is what `heightShortfall` is for and is exactly what
// this section is here to say does *not* happen any more.
// ---------------------------------------------------------------------------

/**
 * Six pitches each, as the app's own pipeline reads them: the world release point
 * [x, height, z] (`pitcherProfile`'s ``release``), the listed height in inches off the
 * same gameData lookup the frontend uses, and Savant's own arm angle for that pitch.
 */
const REAL_STAFF = [
  {
    name: 'Trey Yesavage',
    listed: '6\' 4"',
    heightIn: 76,
    hand: 'R',
    game: '2025-09-27 (gamePk 776159)',
    // His own arm angles imply a release shoulder of 0.74-0.80 of his stature.
    shoulderShare: [0.74, 0.80],
    pitches: [
      { type: 'FF', speed: 95.2, release: [-0.1666, 2.1496, -16.5478], savant: 62.6 },
      { type: 'SL', speed: 90.2, release: [-0.2162, 2.1781, -16.6490], savant: 61.2 },
      { type: 'FS', speed: 83.9, release: [-0.1612, 2.1978, -16.6297], savant: 65.4 },
      { type: 'FF', speed: 96.9, release: [-0.1755, 2.1345, -16.5637], savant: 59.0 },
      { type: 'SL', speed: 89.2, release: [-0.2296, 2.1412, -16.5765], savant: 57.0 },
      { type: 'SL', speed: 86.4, release: [-0.2807, 2.1250, -16.5816], savant: 55.3 },
    ],
  },
  {
    name: 'Tyler Rogers',
    listed: '6\' 3"',
    heightIn: 75,
    hand: 'R',
    game: '2025-09-25 (gamePk 776187)',
    // His own arm angles imply a release shoulder of 0.51-0.58 of his stature.
    shoulderShare: [0.51, 0.58],
    pitches: [
      { type: 'SI', speed: 83.7, release: [-1.1025, 0.3985, -16.5832], savant: -62.4 },
      { type: 'SI', speed: 84.0, release: [-1.1376, 0.3668, -16.6400], savant: -63.5 },
      { type: 'SI', speed: 84.1, release: [-1.1302, 0.3585, -16.6446], savant: -61.6 },
      { type: 'SI', speed: 83.1, release: [-1.1152, 0.3922, -16.5966], savant: -61.8 },
      { type: 'SI', speed: 84.1, release: [-1.1157, 0.3798, -16.6248], savant: -61.8 },
      { type: 'SI', speed: 85.2, release: [-1.1571, 0.3977, -16.6153], savant: -60.4 },
    ],
  },
]

test('the real staff\'s two ends hold everything, release height and all', () => {
  for (const pitcher of REAL_STAFF) {
    const stature = pitcher.heightIn * 0.0254
    // The model's own body for this man, asked for no particular release point: what
    // comes back is the envelope the section header is about — the tallest release his
    // arm's own band lifts the ball to with the shoulder at the body's own highest
    // stand, and the shoulder it hangs from, read back out of that ceiling (the ceiling
    // *is* the shoulder plus a straight arm's reach over it, which is what makes this
    // the model's own shoulder rather than a second estimate of it).
    const own = pitcherProfile({ rig: RIG, hand: pitcher.hand, pitcherHeight: stature })
    const reach = straightChord(own.rig.arm.upper, own.rig.arm.fore) + releaseCarry(own.rig, pitcher.hand)
    // ...in rig units first (the ceiling is reported in world metres, see `pitcherProfile`),
    // then in the world: the shoulder is what the arm's top hangs off, and the floor is
    // what the *law's* own bottom end reaches — the shoulder it names at the bottom of
    // the band plus the arm's own drop under it, which is a deeper fold than the
    // ceiling's own stand and is where the envelope's bottom really is.
    const shoulderRig = own.ceiling / own.scale - reach * Math.sin(ARM_ANGLE_BAND.high)
    const shoulder = shoulderRig * own.scale
    const floorShare = releaseShoulderShare(ARM_ANGLE_BAND.low) + (reach / own.rigStature) * Math.sin(ARM_ANGLE_BAND.low)
    const floor = own.scale * own.rigStature * floorShare
    const envelope = `the model's own release envelope at ${stature.toFixed(3)} m`
    // The ceiling's own shoulder is the body's own highest stand — the fold that puts
    // the throwing socket topmost, which is where the law's top end is answered from
    // when a body cannot stand it (see `releaseStand`, and `slotCeiling`, which takes the
    // lower of the two). This model's own stand is a hand's width under the law's end:
    // 0.773 of the stature against the law's 0.780, which is the same short shoulder the
    // section's own arm-angle note is about — the socket sits at 0.772 of the stature
    // before a fold is asked of it at all.
    const standShare = shoulderRig / own.rigStature
    const lawTop = releaseShoulderShare(ARM_ANGLE_BAND.high)
    assert.ok(
      Math.abs(shoulder / stature - 0.773) < 0.005,
      `${envelope}: the shoulder stands at ${(shoulder / stature).toFixed(3)} of the stature`,
    )
    // ...and the law's own top end and the body's own highest stand are one *body's* worth
    // of each other: the law names a real staff's over-the-top shoulder, and a model that
    // cannot quite stand it is what makes `slotCeiling` take the lower of the two rather
    // than the law outright. A hand's width of the stature is the whole of the difference.
    assert.ok(
      Math.abs(lawTop - standShare) < 0.012,
      `${envelope}: the law's own top is ${lawTop} and the body's own stand is ${standShare.toFixed(3)}`,
    )
    // The ceiling, exactly as the two ends are written: the lower of the law's top and the
    // body's own stand, with the arm's own reach over it at the top of its band.
    const reachShare = reach / own.rigStature
    assert.ok(
      Math.abs(own.ceiling / stature - (Math.min(lawTop, standShare) + reachShare * Math.sin(ARM_ANGLE_BAND.high))) < 1e-6,
      `${envelope}: the arm's own ceiling is ${own.ceiling.toFixed(3)} m = ${(own.ceiling / stature).toFixed(3)} of the stature`,
    )
    assert.ok(
      Math.abs(floor / stature - 0.181) < 0.005,
      `${envelope}: the arm's own floor is ${floor.toFixed(3)} m = ${(floor / stature).toFixed(3)} of the stature`,
    )
    // ...and the two ends of the law are the two ends the header quotes: the shoulder
    // the arm hangs off falls from three quarters to a half as the arm goes under the
    // horizontal, and it is *one* line rather than two postures.
    assert.ok(
      Math.abs(releaseShoulderShare(ARM_ANGLE_BAND.high) - 0.78) < 1e-9,
      `the law's own top is ${releaseShoulderShare(ARM_ANGLE_BAND.high)}`,
    )
    assert.ok(
      Math.abs(releaseShoulderShare(ARM_ANGLE_BAND.low) - 0.53) < 1e-9,
      `the law's own bottom is ${releaseShoulderShare(ARM_ANGLE_BAND.low)}`,
    )
    const implied = []
    for (const pitch of pitcher.pitches) {
      const slot = pitch.release[1]
      const { profile, place } = bodyFor({
        hand: pitcher.hand, slot, pitcher: stature, release: pitch.release,
      })
      const where = `${pitcher.name} ${pitch.type} ${pitch.speed}mph at ${slot.toFixed(3)} m`
      // The body is *his*, pitch after pitch — his listed height, at the scale that
      // stature is worth over the rig's own — and its proportions are a person's.
      assert.equal(profile.stature, stature, `${where}: the body is not his own height`)
      assert.ok(
        Math.abs(profile.scale - stature / own.rigStature) < 1e-12,
        `${where}: the body is stood at ${profile.scale}`,
      )
      for (const [name, value] of Object.entries(proportionsOf(profile.rig, profile.rigStature))) {
        const band = PROPORTION_BANDS[name]
        assert.ok(
          value >= band[0] - 1e-9 && value <= band[1] + 1e-9,
          `${where}: the body reads ${name} at ${value.toFixed(3)}, outside ${band}`,
        )
      }
      // The stance is solved exactly as it is for any other pitch: the delivery's own
      // travel and the shoe's own place account for the pitch's distance in front of the
      // rubber, the stride is inside its band, the shoe is on the rubber's own leather,
      // and the body's feet are on the ground.
      assert.ok(
        Math.abs(profile.scale * profile.travel + profile.contact + profile.shortfall - profile.needed) < 1e-9,
        `${where}: the delivery and the stance do not account for the pitch's own distance`,
      )
      assert.equal(profile.shortfall, 0, `${where}: ${profile.shortfall} m of the pitch's extension was left over`)
      assert.ok(profile.stride >= STRIDE_BAND[0] - 1e-9 && profile.stride <= STRIDE_BAND[1] + 1e-9)
      assert.ok(
        place.foot[2] >= SHOE[0] - 1e-9 && place.foot[2] <= SHOE[1] + 1e-9,
        `${where}: the shoe is off the rubber at ${place.foot[2].toFixed(3)}`,
      )
      assert.equal(place.position[1], 0, `${where}: the body is floated off the ground`)
      // ...and the release's own line, laterally and in depth. The depth is the pitch's
      // own whatever its height does; the lateral is the pitch's own *as far as the
      // arm's own cone reaches it* — a submarine's release stands further across the
      // mound than a low slot leaves an arm for (see ``side``), so what it cannot carry
      // is reported as ``sideShortfall`` and the ball comes off its line by no more
      // than that (the shoe's own leather takes the rest of it, see `pitcherPlacement`),
      // rather than by a stance walked across the rubber after it.
      assert.ok(
        Math.abs(place.ball[0] - pitch.release[0]) <= Math.abs(profile.sideShortfall) + 1e-3,
        `${where}: the ball is ${Math.abs(place.ball[0] - pitch.release[0]).toFixed(4)} off the pitch's own line`
        + ` against the arm's own ${Math.abs(profile.sideShortfall).toFixed(4)} shortfall`,
      )
      assert.ok(
        Math.abs(place.line) <= PIVOT_SIDE + 1e-9,
        `${where}: the drive shoe stands at ${place.line.toFixed(4)}, outside the leather across the rubber`,
      )
      assert.ok(Math.abs(place.ball[2] - pitch.release[2]) < 1e-3, `${where}: the ball is not at its own depth`)
      // The arm's own angle is inside the band a staff's arms are held to — the real
      // league's own span (see ARM_ANGLE_BAND) — and the *shoulder* it hangs from is
      // the posture's, which is what makes these pitches hold at all: the release's
      // own height is on the pitch's point and ``heightShortfall`` is nought.
      const lowDeg = (ARM_ANGLE_BAND.low * 180) / Math.PI
      const highDeg = (ARM_ANGLE_BAND.high * 180) / Math.PI
      assert.ok(profile.armAngle >= lowDeg - 1e-9 && profile.armAngle <= highDeg + 1e-9, `${where}: ${profile.armAngle}°`)
      assert.equal(profile.heightShortfall, 0, `${where}: the arm came up ${profile.heightShortfall.toFixed(4)} m short of the slot`)
      assert.ok(
        Math.abs(place.ball[1] - profile.scale * profile.release.y) < 1e-9,
        `${where}: the ball is not at the anchor's own height`,
      )
      assert.ok(
        Math.abs(place.ball[1] - slot) < 1e-9,
        `${where}: the ball is at ${place.ball[1].toFixed(4)} m rather than the pitch's own ${slot.toFixed(4)} m`,
      )
      // The posture is the slot's own: the shoulder the ball came off stands at the
      // share the law names for the arm's own angle, to the millimetre — which is what
      // the solve promises and what the model's old single posture could not do. Past
      // the body's own highest stand the law is clamped by it, which is the one place
      // the two differ: the stand is a body's limit, not the law's.
      const share = profile.release.shoulderShare
      // (The reading is to a thousandth of a share rather than the last bit: the
      // anchor's own lateral offset — a twentieth of a shoulder's width, see
      // `pitcherRelease` — tips the line from the socket to the ball a fraction of a
      // degree off the arm's own solved angle, which is worth a hundredth of that.)
      const law = releaseShoulderShare((profile.armAngle * Math.PI) / 180)
      const standShare = shoulderRig / own.rigStature
      assert.ok(
        Math.abs(share - Math.min(law, standShare)) < 1e-3,
        `${where}: the shoulder stands at ${share.toFixed(5)} where the law names ${law.toFixed(5)} over a body whose own stand is ${standShare.toFixed(5)}`,
      )
      // ...and it is inside the band this man's own arm angles imply: a real staff's
      // release shoulder is the slot's, not one number for the whole staff.
      const [lowShare, highShare] = pitcher.shoulderShare
      assert.ok(
        share >= lowShare - 1e-9 && share <= highShare + 1e-9,
        `${where}: the model stands his shoulder at ${share.toFixed(3)} of his stature, outside the ${lowShare}-${highShare} his own arm angles imply`,
      )
      // The arm's own angle against the real one, for the record: the model's arm is
      // the short end of a person's, so standing the same slot on the same shoulder
      // asks a steeper angle than Savant read — but it is the same *ball on the same
      // body*, and it is inside the band, which is what makes it a pitch rather than a
      // reported failure. The bound is the whole of the difference this model has: a
      // rig whose arm is 0.38 of its stature against a staff's 0.5 reads the same slot
      // about a tenth of a radian steeper.
      implied.push({ delta: profile.armAngle - pitch.savant, share })
    }
    // What the *real* arm reads there, for the record: the release shoulder Savant's
    // own angle for each pitch implies — the slot less the arm's own reach along that
    // angle, as a share of the stature. It is the posture the model now solves, and
    // the two have to be in the same place: the model's own shoulder share sits inside
    // the band this man's real readings imply, and the worst angle it had to borrow to
    // get there is the short arm's own price.
    const worst = implied.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a))
    assert.ok(
      Math.abs(worst.delta) < 11,
      `${pitcher.name}: the model's worst angle is ${worst.delta.toFixed(1)}° off Savant's own reading of the same pitch`,
    )
    console.log(
      `${pitcher.name}: ${implied.length} real pitches hold, shoulder ${Math.min(...implied.map((i) => i.share)).toFixed(3)}-` +
        `${Math.max(...implied.map((i) => i.share)).toFixed(3)} of the stature, worst angle ${worst.delta.toFixed(1)}° off Savant`,
    )
  }
})
