import test from 'node:test'
import assert from 'node:assert/strict'
import { Bone, Group, Quaternion, Vector3 } from 'three'
import { BATTER_RUN_TAKEOFF_SECONDS, batterRunFrame } from '../src/util/batterRunner.js'
import { blendSnapshot, poseSnapshot } from '../src/util/playerClips.js'
import { STATE_AT_BASE, STATE_RUN, STATE_SLIDE, runFrame } from '../src/util/playCast.js'
import { buildRuns } from '../src/util/playPlan.js'
import { FIELD } from '../src/constants/field.js'

// The batter's own body as the batter-runner: the body that swung walks the
// plan's own walk (see test/playCast.test.js for the walk itself). These are the
// three things only *this* body has to do — leave from where it stood rather than
// from the plate, on the play's own clock rather than the schedule's own beat,
// and be eased out of the stance it left rather than cut into the run's stride.

// Somewhere out of the box: a right-handed batter's stance, a stride off the
// plate's centre (the plan's own walk starts on the plate — see playPlan).
const BOX = new Vector3(-0.9, 0, 0.7)

// The batter-runner's own walk: the plate to first, on his own takeoff.
const run = () => buildRuns([{ start: null, end: '1B' }])[0]

test("he leaves from where he stood, and is on the plan's own path by the end of the takeoff", () => {
  const walk = run()
  const start = walk.legs[0].start
  // The handoff frame is exactly where the swing left him: nought of the takeoff
  // is through, so the offset that carries him out of the box is the whole
  // distance between the two, and the run's own share of the turn is nought.
  const atHandoff = batterRunFrame(walk, BOX, start, start)
  assert.ok(atHandoff.position.distanceTo(BOX) < 1e-12)
  assert.equal(atHandoff.takeoff, 0)
  // The clip he is blending into is the run's from this very frame — the takeoff
  // frame is the walk's first frame, with nought of it showing yet.
  assert.equal(atHandoff.state, STATE_RUN)
  // Half a window later he is between the two — off the box, not yet on the path.
  const half = batterRunFrame(walk, BOX, start + BATTER_RUN_TAKEOFF_SECONDS / 2, start)
  const onPath = runFrame(walk, start + BATTER_RUN_TAKEOFF_SECONDS / 2).position
  assert.ok(Math.abs(half.takeoff - 0.5) < 1e-12)
  assert.ok(Math.abs(half.position.distanceTo(onPath) - BOX.distanceTo(runFrame(walk, start).position) / 2) < 1e-9)
  // ...and once the window is up he *is* the plan's own walk, to the millimetre:
  // from here on the batter-runner and the schedule are the same body.
  for (const t of [BATTER_RUN_TAKEOFF_SECONDS, walk.legs[0].duration * 0.5, walk.arriveAt]) {
    const frame = batterRunFrame(walk, BOX, start + t, start)
    assert.equal(frame.takeoff, 1)
    assert.ok(frame.position.distanceTo(runFrame(walk, start + t).position) < 1e-12, `t ${t}`)
  }
  const arrived = batterRunFrame(walk, BOX, walk.arriveAt, start)
  assert.deepEqual(arrived.position.toArray(), [FIELD.BASE.FIRST.x, 0, FIELD.BASE.FIRST.z])
  assert.equal(arrived.state, STATE_AT_BASE, '...and he is waiting on the bag he reached')
  assert.equal(batterRunFrame(walk, BOX, walk.slideAt, start).state, STATE_SLIDE)
})

test('the takeoff is anchored to the frame he left on, not to the clock a reader sees', () => {
  const walk = run()
  const start = walk.legs[0].start
  // A late handoff — the plan can be built after its own takeoff, when a live
  // hit's runners land a poll or two behind it — still starts where he stood: the
  // offset is read at the moment he left, so nothing teleports him into the
  // basepath. (What it costs is the crossing itself: he walks that offset off
  // over the same window rather than in it, which is a body cutting across to the
  // line rather than a body appearing on it.)
  const late = start + 1.4
  const first = batterRunFrame(walk, BOX, late, late)
  assert.ok(first.position.distanceTo(BOX) < 1e-12)
  assert.equal(first.takeoff, 0)
  const caughtUp = late + BATTER_RUN_TAKEOFF_SECONDS
  const frame = batterRunFrame(walk, BOX, caughtUp, late)
  assert.equal(frame.takeoff, 1)
  assert.ok(frame.position.distanceTo(runFrame(walk, caughtUp).position) < 1e-12)
  // Before the handoff (a reader that asks early) he is simply where he stood, on
  // the plate-side spot — the same frame as the handoff's own, not a negative one.
  const early = batterRunFrame(walk, BOX, start - 0.5, start)
  assert.ok(early.position.distanceTo(BOX) < 1e-12)
  assert.equal(early.takeoff, 0)
})

test('a snapshot is the pose the body is about to leave, and the blend eases it out', () => {
  const root = new Group()
  const hip = new Bone()
  hip.position.set(0.1, 1.2, 0.2)
  hip.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), -0.6)
  const knee = new Bone()
  hip.add(knee)
  knee.position.set(0, 0.5, 0)
  knee.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.9)
  root.add(hip)

  const snapshot = poseSnapshot(root)
  assert.equal(snapshot.length, 2, 'both bones are kept')
  // The pose the clip is about to write, on the same bones: stood up, facing
  // round toward the basepath.
  const poseRun = () => {
    hip.position.set(0.4, 0.9, -0.3)
    hip.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 2.1)
    knee.position.set(0, 0.45, 0.05)
    knee.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.2)
  }

  // Nought of the run: the body is exactly the pose the snapshot holds — the
  // handoff frame, where the swing's stance has just been authored for the last
  // time and the mixer has already written over it.
  poseRun()
  blendSnapshot(snapshot, 0)
  assert.ok(hip.position.distanceTo(new Vector3(0.1, 1.2, 0.2)) < 1e-12)
  assert.ok(hip.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.6)) < 1e-12)

  // Half of it: the two poses are one — the position is the midpoint, and the
  // rotation is on the shortest arc between them, which for a spine turned most
  // of the way round is the whole point of blending it as a quaternion.
  poseRun()
  blendSnapshot(snapshot, 0.5)
  assert.ok(hip.position.distanceTo(new Vector3(0.25, 1.05, -0.05)) < 1e-12)
  const halfTurn = hip.quaternion.clone()
  assert.ok(Math.abs(halfTurn.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.6)) - 1.35) < 1e-6, '...on the shortest arc between the two')
  assert.ok(Math.abs(halfTurn.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 2.1)) - 1.35) < 1e-6)

  // All of it: the clip's own pose, untouched.
  poseRun()
  blendSnapshot(snapshot, 1)
  assert.ok(hip.position.distanceTo(new Vector3(0.4, 0.9, -0.3)) < 1e-12)
  assert.ok(hip.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 2.1)) < 1e-12)
  // ...and a body with no snapshot (asked before there is one) is left alone.
  poseRun()
  blendSnapshot(null, 0)
  assert.ok(hip.position.distanceTo(new Vector3(0.4, 0.9, -0.3)) < 1e-12)
})

test("the yaw he is run at faces him down the basepath, half turn and all", () => {
  const walk = run()
  const start = walk.legs[0].start
  const at = start + BATTER_RUN_TAKEOFF_SECONDS
  const frame = batterRunFrame(walk, BOX, at, start)
  // His own frame is the asset's turned half round (Batter.jsx turns the body π:
  // the whole swing is authored facing the pitcher), so the body's *front* in that
  // frame is the frame's -Z — and that is the one a runner's yaw has to aim, or he
  // runs the basepath facing the way he came.
  const front = new Vector3(0, 0, -1).applyAxisAngle(new Vector3(0, 1, 0), frame.yaw)
  const to = frame.lookTarget.clone().sub(frame.position).setY(0).normalize()
  assert.ok(front.dot(to) > 1 - 1e-9, `${front.toArray()} should point at ${frame.lookTarget.toArray()}`)
  // Which is exactly the half turn: the same yaw with the asset's own front would
  // put his face on the base he is leaving.
  const other = new Vector3(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), frame.yaw)
  assert.ok(other.dot(to) < -1 + 1e-9)
})

test('the takeoff window is short enough to read as going, long enough to turn round', () => {
  // The whole handoff — the box walked off, the stance given up and the run's
  // first stride taken — happens inside this. A stride is ~0.15 s at a sprint;
  // this is a body standing up out of a crouch and turning most of the way round
  // on its way into the first two steps.
  assert.ok(BATTER_RUN_TAKEOFF_SECONDS >= 0.3 && BATTER_RUN_TAKEOFF_SECONDS <= 0.6, `${BATTER_RUN_TAKEOFF_SECONDS}`)
})
