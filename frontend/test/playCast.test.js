import test from 'node:test'
import assert from 'node:assert/strict'
import { Vector3 } from 'three'
import {
  BASE_ORDER,
  CATCH_HOLD_SECONDS,
  STATE_AT_BASE,
  STATE_CATCH_GROUND,
  STATE_CATCH_HIGH,
  STATE_CATCH_MID,
  STATE_NEUTRAL,
  STATE_RUN,
  STATE_SLIDE,
  STATE_THROW,
  THROW_RECEIVE_SECONDS,
  THROW_WINDUP_SECONDS,
  BATTER_ACTOR,
  ballCarrierAt,
  baseIndex,
  castLineup,
  defenseSpot,
  evaluateCast,
  facingYaw,
  idleHome,
  idleLookTarget,
  idleStateFor,
  offenseSpot,
  PITCHER_ACTOR,
  pitcherFrameAt,
  pitcherIsInvolved,
  resetFrames,
  runFrame,
} from '../src/util/playCast.js'
import { buildPlan } from '../src/util/playPlan.js'
import { FIELD } from '../src/constants/field.js'

const LAUNCH = new Vector3(0, 1.0, -0.43)

// A grounder to short with a man on first, both out: the same classic 6-4-3 the
// plan tests use, because it exercises every state this cast has (a sprint, a
// catch, a putout run, two throws, two receivers, two runners).
const doublePlay = () => ({
  coordX: 100,
  coordY: 120,
  launchSpeed: 88,
  launchAngle: 3,
  sprayAngle: -12,
  fielder: 'SS',
  wasCaught: false,
  eventType: 'grounded_into_double_play',
  runners: [
    { start: '1B', end: null, outBase: '2B', isOut: true, credits: [{ position: 'SS', credit: 'f_fielded_ball' }, { position: '2B', credit: 'f_putout' }] },
    { start: null, end: '1B', isOut: false, credits: [{ position: 'SS', credit: 'f_assist' }, { position: '1B', credit: 'f_putout' }] },
  ],
})

const frameOf = (frames, kind, key) => frames.find((f) => f.kind === kind && f.key === key)

// A comebacker: the ball is hit back at the pitcher, he fields it and throws the
// batter-runner out at first. The feed sends those to "1" (see the backend's own
// hit-location table), which is how a plan ends up naming the pitcher at all.
const comebacker = () => ({
  coordX: 125,
  coordY: 130,
  launchSpeed: 85,
  launchAngle: 2,
  sprayAngle: 0,
  fielder: 'P',
  wasCaught: false,
  eventType: 'fielders_choice',
  runners: [
    {
      start: null,
      end: '1B',
      isOut: false,
      credits: [
        { position: 'P', credit: 'f_fielded_ball' },
        { position: 'P', credit: 'f_assist' },
        { position: '1B', credit: 'f_putout' },
      ],
    },
  ],
})

// The comebacker the pitcher gloves and then takes to the bag himself: the feed's
// own credits put `f_fielded_ball` and `f_putout` on the same line, so the plan
// gives him *two* legs — the sprint to the ball, and the walk to first with it in
// his hand — and nobody to throw to.
const unassistedComeback = () => ({
  coordX: 125,
  coordY: 130,
  launchSpeed: 85,
  launchAngle: 2,
  sprayAngle: 0,
  fielder: 'P',
  wasCaught: false,
  eventType: 'fielders_choice',
  runners: [
    {
      start: null,
      end: null,
      outBase: '1B',
      isOut: true,
      credits: [
        { position: 'P', credit: 'f_fielded_ball' },
        { position: 'P', credit: 'f_putout' },
      ],
    },
  ],
})

// The grounder to the right side the pitcher is credited with the *putout* on: the
// second baseman fields it and he covers first base himself. The plan credits him
// with the out, so the bag is his to run to (a `putoutMoves` entry, the same run
// every cast body with a putout makes).
const coverFirst = () => ({
  coordX: 88,
  coordY: 128,
  launchSpeed: 86,
  launchAngle: 1,
  sprayAngle: 20,
  fielder: '2B',
  wasCaught: false,
  eventType: 'grounded_into_double_play',
  runners: [
    {
      start: null,
      end: null,
      outBase: '1B',
      isOut: true,
      credits: [
        { position: '2B', credit: 'f_fielded_ball' },
        { position: '2B', credit: 'f_assist' },
        { position: 'P', credit: 'f_putout' },
      ],
    },
  ],
})

// ── Bases and spots ───────────────────────────────────────────────────────
test('the base order is the reference\'s own, and a batter-runner starts on the plate', () => {
  assert.deepEqual(BASE_ORDER, [null, '1B', '2B', '3B', 'score'])
  assert.equal(baseIndex(null), 0)
  assert.equal(baseIndex('B'), 0)
  assert.equal(baseIndex('1B'), 1)
  assert.equal(baseIndex('score'), 4)
  assert.equal(baseIndex('dugout'), -1, 'a key the feed invented is not a base')
  // The plate, and the bags: the offense's own spots (y = 0 — a body stands on
  // the ground, and the model is authored from its feet up).
  assert.deepEqual(offenseSpot('B').toArray(), [FIELD.BASE.HOME.x, 0, FIELD.BASE.HOME.z])
  assert.deepEqual(offenseSpot('2B').toArray(), [FIELD.BASE.SECOND.x, 0, FIELD.BASE.SECOND.z])
  assert.deepEqual(defenseSpot('SS').toArray(), [FIELD.DEFENSE.SS.x, 0, FIELD.DEFENSE.SS.z])
})

test('the lineup is the seven fielding spots this app owns, plus a body per runner', () => {
  const lineup = castLineup([{ actor: '1B' }, { actor: 'B' }])
  assert.deepEqual(lineup.defense.map((a) => a.key), ['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'])
  assert.deepEqual(lineup.offense.map((a) => a.key), ['1B'])
  // ...and the batter-runner is not one of them, though his run is: the plan
  // keeps the walk (it is what the play's own length is read off), but the body
  // that runs it is the batter's own — the one already standing at the plate
  // swinging. Drawing him here as well is what used to put two bodies there;
  // Batter.jsx hands his own body to the run instead (util/batterRunner.js).
  assert.ok(!lineup.offense.some((a) => a.key === BATTER_ACTOR))
  // The pitcher and the catcher have their own components; they are never a
  // body of this cast either.
  assert.ok(!lineup.defense.some((a) => a.key === 'P' || a.key === 'C'))
  for (const actor of lineup.defense) assert.equal(actor.kind, 'defense')
})

// ── The alignment the reset returns to ────────────────────────────────────
test('every body has an idle alignment: its own spot, its own clip, no ball', () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  const rest = resetFrames(plan)
  for (const actor of [...plan.cast.defense, ...plan.cast.offense]) {
    const frame = rest.get(`${actor.kind}:${actor.key}`)
    assert.ok(frame, `${actor.key} should have a reset frame`)
    assert.deepEqual(frame.position.toArray(), idleHome(actor).toArray())
    assert.equal(frame.hasBall, false, 'nobody is holding the ball after the play')
    if (actor.kind === 'defense') {
      assert.equal(frame.state, STATE_NEUTRAL)
      // ...and a fielder faces the plate, which is where the game is.
      assert.deepEqual(frame.lookTarget.toArray(), [FIELD.BASE.HOME.x, 0, FIELD.BASE.HOME.z])
    } else {
      assert.equal(frame.state, STATE_AT_BASE)
      // A runner is looking at the next base he would go to: the man on second
      // watches third, the batter-runner watches first.
      const next = actor.key === '1B' ? FIELD.BASE.SECOND : FIELD.BASE.FIRST
      assert.deepEqual(frame.lookTarget.toArray(), [next.x, 0, next.z])
    }
  }
  // The reset is the plan's lineup and nothing else: a body the plan does not
  // use has no alignment because it is not on the field at all.
  assert.equal(rest.size, plan.cast.defense.length + plan.cast.offense.length)
})

test('the idle state follows what the body is: a runner waits on his base, a fielder stands', () => {
  assert.equal(idleStateFor('offense'), STATE_AT_BASE)
  assert.equal(idleStateFor('defense'), STATE_NEUTRAL)
  assert.deepEqual(idleLookTarget({ kind: 'offense', key: '3B' }).toArray(), [FIELD.BASE.HOME.x, 0, FIELD.BASE.HOME.z])
  assert.deepEqual(idleLookTarget({ kind: 'offense', key: 'B' }).toArray(), [FIELD.BASE.FIRST.x, 0, FIELD.BASE.FIRST.z])
})

// ── The play itself ───────────────────────────────────────────────────────
test('at the first frame of the play every fielder is on his spot and every runner on his base', () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  const frames = evaluateCast(plan, 0)
  for (const key of ['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']) {
    const fielder = frameOf(frames, 'defense', key)
    assert.deepEqual(fielder.position.toArray(), [FIELD.DEFENSE[key].x, 0, FIELD.DEFENSE[key].z], key)
  }
  // The shortstop is already running (he chases the ball at t = 0); the others
  // are not. The man on first is running too — he was forced, and the reference
  // sends a forced runner on the ball, not on the catch.
  assert.equal(frameOf(frames, 'defense', 'SS').state, STATE_RUN)
  assert.equal(frameOf(frames, 'defense', 'LF').state, STATE_NEUTRAL)
  assert.equal(frameOf(frames, 'defense', '2B').state, STATE_RUN, 'he is running to the bag for the putout')
  // The batter-runner is not a body of this cast at all (see castLineup), and
  // the man on first is already gone — the reference sends a forced runner on
  // the ball, not on the catch.
  assert.equal(frameOf(frames, 'offense', 'B'), undefined)
  const forced = frameOf(frames, 'offense', '1B')
  assert.deepEqual(forced.position.toArray(), [FIELD.BASE.FIRST.x, 0, FIELD.BASE.FIRST.z])
  assert.equal(forced.state, STATE_RUN)
})

test('the chaser sprints, catches, holds the ball, then throws it', () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  const chaser = plan.chaser
  const sprintEnd = plan.chaserSegments[0].start + plan.chaserSegments[0].duration
  // Mid-sprint: running, at the spot the schedule puts him (he has left his
  // defensive position).
  const mid = frameOf(evaluateCast(plan, sprintEnd * 0.5), 'defense', chaser)
  assert.equal(mid.state, STATE_RUN)
  assert.notDeepEqual(mid.position.toArray(), [FIELD.DEFENSE[chaser].x, 0, FIELD.DEFENSE[chaser].z])
  // He arrives at the fielding point and waits under the ball (he is faster
  // than a grounder rolling at him): waiting is the fielding pose as well, but
  // the ball is still on its way and is not in his hand yet.
  const waiting = frameOf(evaluateCast(plan, sprintEnd), 'defense', chaser)
  assert.equal(waiting.state, STATE_CATCH_GROUND)
  assert.equal(waiting.hasBall, false, 'the ball has not reached him yet')
  assert.equal(ballCarrierAt(plan, sprintEnd), null)
  assert.ok(sprintEnd <= plan.ballCatch.t, 'he is there before it is')
  // At the catch it is in his hand — and it stays there through his wind-up.
  const caught = frameOf(evaluateCast(plan, plan.ballCatch.t), 'defense', chaser)
  assert.equal(caught.state, STATE_CATCH_GROUND)
  assert.equal(caught.hasBall, true)
  assert.equal(ballCarrierAt(plan, plan.ballCatch.t), chaser)
  // ...he holds the catch pose until he starts his throw (a fielder who gloves
  // it and throws it never stands up in between), and then his throwing clip
  // takes over, with the ball still riding his hand.
  const windupStart = plan.throws[0].start - THROW_WINDUP_SECONDS
  assert.ok(windupStart > sprintEnd, 'the throw comes after the catch')
  const holding = (sprintEnd + Math.min(windupStart, sprintEnd + CATCH_HOLD_SECONDS)) / 2
  assert.equal(frameOf(evaluateCast(plan, holding), 'defense', chaser).state, STATE_CATCH_GROUND)
  assert.equal(frameOf(evaluateCast(plan, windupStart + 0.05), 'defense', chaser).state, STATE_THROW)
  assert.equal(frameOf(evaluateCast(plan, windupStart + 0.05), 'defense', chaser).hasBall, true, 'the ball is in the hand through the wind-up')
  assert.equal(ballCarrierAt(plan, (windupStart + plan.throws[0].start) / 2), chaser)
  // ...and it is in the air once the throw leaves, with nobody carrying it.
  const thrown = plan.throws[0]
  assert.equal(ballCarrierAt(plan, thrown.start + thrown.duration * 0.5), null)
  assert.equal(frameOf(evaluateCast(plan, thrown.start + thrown.duration * 0.5), 'defense', chaser).hasBall, false)
})

test('a hit with no throw in it still ends with the ball in the fielder\'s hand', () => {
  // A single: somebody fields it and nobody is put out, so there is no throw to
  // follow — the ball is in his glove for the rest of the play (the man who
  // fielded a clean hit holds it; it does not hang in the air over the spot).
  const plan = buildPlan({
    coordX: 120, coordY: 90, launchSpeed: 92, launchAngle: 12, sprayAngle: 24, fielder: 'RF', wasCaught: false, eventType: 'single',
    runners: [{ start: null, end: '1B' }],
  }, LAUNCH)
  assert.deepEqual(plan.throws, [])
  assert.equal(ballCarrierAt(plan, plan.ballCatch.t), 'RF')
  assert.equal(ballCarrierAt(plan, (plan.ballCatch.t + plan.endTime) / 2), 'RF')
  assert.equal(frameOf(evaluateCast(plan, plan.ballCatch.t + 0.5), 'defense', 'RF').hasBall, true)
  assert.equal(ballCarrierAt(plan, plan.endTime), null, 'and the reset takes it away')
})

test('a ball caught in the air is the catching pose, not the fielding one', () => {
  const plan = buildPlan({
    coordX: 130, coordY: 130, launchSpeed: 100, launchAngle: 30, fielder: 'CF', wasCaught: true, runners: [],
  }, LAUNCH)
  const sprintEnd = plan.chaserSegments[0].start + plan.chaserSegments[0].duration
  assert.equal(frameOf(evaluateCast(plan, sprintEnd), 'defense', 'CF').state, STATE_CATCH_HIGH)
  // Nothing is thrown, so the ball stays in his glove to the end of the play:
  // it is never left hanging at the spot it was caught.
  assert.equal(ballCarrierAt(plan, plan.ballCatch.t), 'CF')
  assert.equal(ballCarrierAt(plan, (plan.ballCatch.t + plan.endTime) / 2), 'CF')
  assert.equal(ballCarrierAt(plan, plan.endTime), null, 'the play is over, the reset takes the ball away')
})

test('the receiver of a throw is catching it, and is back to neutral half a second later', () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  const first = plan.throws[0]
  const landing = first.start + first.duration
  // While the ball is in the air toward him he is catching it, and has nothing
  // in his hand yet.
  const incoming = frameOf(evaluateCast(plan, first.start + first.duration * 0.5), 'defense', first.toActor)
  assert.equal(incoming.state, STATE_CATCH_MID)
  assert.equal(incoming.hasBall, false)
  // The moment it lands it is in his glove...
  assert.equal(ballCarrierAt(plan, landing + 0.01), first.toActor)
  // ...and on a double play that is also the moment he starts his own throw, so
  // his throwing clip takes over from the catch (the reference does the same:
  // the receiver is the next thrower, and his wind-up begins as the ball lands).
  const second = plan.throws[1]
  assert.ok(second, 'a 6-4-3 has a second throw')
  assert.equal(second.fromActor, first.toActor)
  assert.equal(frameOf(evaluateCast(plan, landing + 0.05), 'defense', first.toActor).state, STATE_THROW)
  // The man who receives the last throw keeps the ball from the moment it
  // lands until the play is over — it is in the first baseman's glove at the
  // end of a double play, not hanging in the air where he caught it.
  const last = plan.throws[plan.throws.length - 1]
  const landed = last.start + last.duration
  assert.equal(ballCarrierAt(plan, landed + 0.01), last.toActor)
  assert.equal(frameOf(evaluateCast(plan, landed + 0.01), 'defense', last.toActor).hasBall, true)
  assert.equal(ballCarrierAt(plan, plan.endTime), null, 'and the reset takes it away')
  // By the end of his hold he is standing again.
  const done = landed + THROW_RECEIVE_SECONDS + 0.01
  assert.equal(frameOf(evaluateCast(plan, done), 'defense', last.toActor).state, STATE_NEUTRAL)
})

test('a runner runs, slides the last half second, and stands on the base he reached', () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  const runner = plan.runs.find((r) => r.actor === '1B')
  const midLeg = runner.legs[0].start + runner.legs[0].duration * 0.5
  assert.equal(frameOf(evaluateCast(plan, midLeg), 'offense', '1B').state, STATE_RUN)
  // The reference switches to the slide when less than half a second of the run
  // is left, and the body arrives still sliding.
  assert.equal(frameOf(evaluateCast(plan, runner.slideAt + 0.01), 'offense', '1B').state, STATE_SLIDE)
  assert.equal(frameOf(evaluateCast(plan, runner.arriveAt + 0.01), 'offense', '1B').state, STATE_AT_BASE)
  // ...on the base he was going to.
  const arrived = frameOf(evaluateCast(plan, runner.arriveAt + 0.01), 'offense', '1B')
  assert.deepEqual(arrived.position.toArray(), [FIELD.BASE.SECOND.x, 0, FIELD.BASE.SECOND.z])
  // A body the plan never moves does not move: the man on first is the only
  // runner the feed moved, so there is no body at third at all.
  assert.equal(frameOf(evaluateCast(plan, runner.arriveAt), 'offense', '3B'), undefined)
})

test("a runner's own walk: on his base, on his feet, into his slide, and settled again", () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  const runner = plan.runs.find((r) => r.actor === '1B')
  // Before his first leg he is standing on the base he starts from, in his own
  // idle clip (the batter-runner's own body reads this same frame — see
  // batterRunner.js — so his takeoff looks exactly like the other runners').
  const before = runFrame(runner, -0.5)
  assert.deepEqual(before.position.toArray(), [FIELD.BASE.FIRST.x, 0, FIELD.BASE.FIRST.z])
  assert.equal(before.state, STATE_AT_BASE)
  assert.equal(before.lookTarget, null, 'a settled body\'s own look is its caller\'s business')
  // On the leg he is on his feet, running, and looking at the bag he is going to.
  const mid = runFrame(runner, runner.legs[0].start + runner.legs[0].duration * 0.5)
  assert.equal(mid.state, STATE_RUN)
  assert.deepEqual(mid.lookTarget.toArray(), runner.legs[0].to.toArray())
  assert.ok(mid.position.distanceTo(runner.legs[0].from) > 1, 'he is off the base he left')
  // The last half-second of the leg is the slide, and the leg's end is the base.
  assert.equal(runFrame(runner, runner.slideAt).state, STATE_SLIDE)
  const arrived = runFrame(runner, runner.arriveAt)
  assert.deepEqual(arrived.position.toArray(), [FIELD.BASE.SECOND.x, 0, FIELD.BASE.SECOND.z])
  assert.equal(arrived.state, STATE_AT_BASE)
})

test('a fielder looks at the man he is throwing to, and a chaser at the ball', () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  const thrower = plan.throws[0].fromActor
  const receiver = plan.throws[0].toActor
  const midWindup = plan.throws[0].start - THROW_WINDUP_SECONDS / 2
  const aiming = frameOf(evaluateCast(plan, midWindup), 'defense', thrower).lookTarget
  assert.deepEqual(aiming.toArray(), plan.throws[0].toPos.toArray(), 'he is looking at his target')
  // A fielder the play asks nothing of watches the plate — the pitch and the swing
  // are the only thing happening until the ball is hit, and his job is to be ready
  // for it. (The left fielder is nobody's man on this grounder.)
  const standing = frameOf(evaluateCast(plan, 0), 'defense', 'LF').lookTarget
  assert.deepEqual(standing.toArray(), [FIELD.BASE.HOME.x, 0, FIELD.BASE.HOME.z], 'nothing to do: at the plate')
  // ...and the receiver here is *not* standing: he is the man covering the bag the
  // throw is going to, and that leg of his starts with the bat — so the bag is what
  // he is facing from the plan's own first frame, not the plate.
  const covering = frameOf(evaluateCast(plan, 0), 'defense', receiver).lookTarget
  assert.deepEqual(covering.toArray(), plan.putoutMoves[0].to.toArray(), 'the bag he is covering')
  // The chaser watches the ball he is running down.
  const chasing = frameOf(evaluateCast(plan, plan.chaserSegments[0].duration * 0.5), 'defense', plan.chaser).lookTarget
  assert.deepEqual(chasing.toArray(), plan.catchLocation.toArray())
})

test('the facing yaw points the body at what it is looking at', () => {
  // A body at the plate facing first base: the bag is out along +x and -z in
  // this app's frame, so the yaw is the atan2 of that offset.
  const yaw = facingYaw(new Vector3(0, 0, 0), { x: FIELD.BASE.FIRST.x, y: 0, z: FIELD.BASE.FIRST.z })
  assert.ok(Math.abs(yaw - Math.atan2(FIELD.BASE.FIRST.x, FIELD.BASE.FIRST.z)) < 1e-12)
  assert.equal(facingYaw(new Vector3(1, 0, 1), { x: 1, y: 0, z: 1 }), null, 'no facing for a target he is standing on')
  // ...and it is a yaw a body *faces*: the frame's own +Z, turned by it, points at
  // the target. That is the direction the asset's body faces in its own rest frame
  // (util/batterLook.js paints the face on that side of it), so a body drawn in
  // that frame — every fielder, every runner, the catcher — carries no half turn
  // of its own. The batter's body is the one that does, and adds it back where his
  // frame is yawed (see test/batterRunner.test.js and BATTER_FRAME_TURN).
  const front = new Vector3(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), yaw)
  const to = new Vector3(FIELD.BASE.FIRST.x, 0, FIELD.BASE.FIRST.z).setY(0).normalize()
  assert.ok(front.dot(to) > 1 - 1e-12, `${front.toArray()} should point at the bag`)
})

// ── The pitcher's own half of the play ─────────────────────────────────────
// He is not a body of this cast (Pitcher.jsx draws him, off his own delivery), but
// his share of a play is still read here and handed over: the reference's own pool,
// one body at a time. These are the four answers the component layer needs — who he
// is involved for, where the schedule has him, what he is playing, and whether the
// ball is in his hand.
test('a plan that never names the pitcher leaves him to his own delivery', () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  assert.equal(pitcherIsInvolved(plan), false, 'a 6-4-3 short of him is none of his business')
  assert.equal(pitcherFrameAt(plan, 1), null)
  assert.equal(pitcherIsInvolved(null), false)
  assert.equal(pitcherFrameAt(null, 1), null)
  // A ball charged to the man behind the plate is nobody's body here either: the
  // catcher is drawn by his own component and never fields a play (see the note at
  // the top of playCast.js), so the pitcher's own half must not claim it.
  const toTheCatcher = buildPlan({ ...doublePlay(), fielder: 'C' }, LAUNCH)
  assert.equal(toTheCatcher.chaser, 'C')
  assert.equal(pitcherIsInvolved(toTheCatcher), false)
  assert.equal(pitcherFrameAt(toTheCatcher, 1), null)
})

test('a comebacker is fielded by the body on the mound: the sprint, the catch, the throw', () => {
  const plan = buildPlan(comebacker(), LAUNCH)
  assert.equal(plan.chaser, PITCHER_ACTOR)
  assert.ok(pitcherIsInvolved(plan), 'he is the man the ball was hit to')
  // He starts on his own spot — the mound — and he is a fielder like any other:
  // the sprint, the catch pose and the throw are the same states and the same
  // schedule the cast's bodies play, off the same plan.
  const start = pitcherFrameAt(plan, 0)
  assert.deepEqual(start.position.toArray(), [FIELD.DEFENSE.P.x, 0, FIELD.DEFENSE.P.z])
  assert.equal(start.state, STATE_RUN, 'he is on the ball from the first frame')
  assert.equal(start.hasBall, false, 'and it is not in his hand yet')
  const sprintEnd = plan.chaserSegments[0].start + plan.chaserSegments[0].duration
  const mid = pitcherFrameAt(plan, sprintEnd * 0.5)
  assert.equal(mid.state, STATE_RUN)
  const leftTheMound = Math.hypot(mid.position.x - FIELD.DEFENSE.P.x, mid.position.z - FIELD.DEFENSE.P.z)
  assert.ok(leftTheMound > 0.5, `he has only come ${leftTheMound.toFixed(2)} m off the mound`)
  // At the ball he is a fielder who has gloved it — the ball is in his hand, and it
  // rides it through his wind-up and out on the throw.
  const caught = pitcherFrameAt(plan, plan.ballCatch.t)
  assert.equal(caught.state, STATE_CATCH_GROUND)
  assert.equal(caught.hasBall, true)
  assert.equal(ballCarrierAt(plan, plan.ballCatch.t), PITCHER_ACTOR)
  const th = plan.throws[0]
  assert.equal(th.fromActor, PITCHER_ACTOR, 'the throw is his to make')
  assert.equal(pitcherFrameAt(plan, th.start - THROW_WINDUP_SECONDS + 0.05).state, STATE_THROW)
  assert.equal(pitcherFrameAt(plan, th.start - THROW_WINDUP_SECONDS + 0.05).hasBall, true)
  // ...and nobody is carrying it once it is in the air.
  assert.equal(pitcherFrameAt(plan, th.start + th.duration * 0.5).hasBall, false)
  assert.equal(ballCarrierAt(plan, th.start + th.duration * 0.5), null)
})

test('a body under way faces the place it is going; only a standing one watches the plate', () => {
  // The comebacker he gloves *and* carries to the bag himself: two legs of his own,
  // and the second of them is five seconds long — a body that watched the plate down
  // all of it would be jogging to first base backwards (see `defenseLookTarget`, and
  // `runFrame` for the same rule on a runner: a leg is a direction, and a body on one
  // is aimed down it).
  const plan = buildPlan(unassistedComeback(), LAUNCH)
  const [sprint, carry] = plan.chaserSegments
  const toTheBall = pitcherFrameAt(plan, sprint.start + sprint.duration * 0.5)
  assert.equal(toTheBall.state, STATE_RUN)
  assert.deepEqual(toTheBall.lookTarget.toArray(), plan.catchLocation.toArray(), 'the ball he is running down')
  const withIt = pitcherFrameAt(plan, carry.start + carry.duration * 0.5)
  assert.equal(withIt.hasBall, true, 'he is carrying it himself')
  assert.deepEqual(
    withIt.lookTarget.toArray(),
    [FIELD.BASE.FIRST.x, 0, FIELD.BASE.FIRST.z],
    'the bag he is walking it to',
  )
  // ...and that aim is the way he is really travelling, not a square to it: the yaw
  // is what `facingYaw` answers, and the frame's own +Z turned by it points at the
  // bag — the direction his feet are going.
  const front = new Vector3(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), facingYaw(withIt.position, withIt.lookTarget))
  const travel = FIELD.BASE.FIRST.clone().sub(withIt.position).setY(0).normalize()
  assert.ok(front.dot(travel) > 1 - 1e-9, `he faces ${front.toArray()} and is going ${travel.toArray()}`)
  // ...and the plate is still what a body with no leg of its own watches. The chaser
  // watches the ball from the first frame of the plan (it is coming to him), so the
  // standing body read here is the man covering the bag in the other plan: before his
  // leg starts he is a fielder standing on his spot, and the plate is where the game is.
  const covering = buildPlan(coverFirst(), LAUNCH)
  assert.deepEqual(
    pitcherFrameAt(covering, -0.5).lookTarget.toArray(),
    [FIELD.BASE.HOME.x, 0, FIELD.BASE.HOME.z],
  )
})

test('a fielder running to cover a bag faces the bag the whole way', () => {
  // The grounder to the right side: the second baseman fields it and the pitcher has
  // the out to make at first, so the bag is his own leg — and the whole of it is run
  // facing the bag rather than standing at the plate watching the pitch.
  const plan = buildPlan(coverFirst(), LAUNCH)
  const move = plan.putoutMoves.find((m) => m.fielder === PITCHER_ACTOR)
  assert.ok(move, 'he is the man with an out to make')
  for (const share of [0.05, 0.5, 0.95]) {
    const frame = pitcherFrameAt(plan, move.duration * share)
    assert.equal(frame.state, STATE_RUN)
    assert.deepEqual(
      frame.lookTarget.toArray(),
      [FIELD.BASE.FIRST.x, 0, FIELD.BASE.FIRST.z],
      `at ${share} of the run to the bag he is not facing it`,
    )
  }
})

test('the pitcher covers the bag when the play credits him with the putout there', () => {
  const plan = buildPlan(coverFirst(), LAUNCH)
  assert.equal(plan.chaser, '2B', 'the ball was hit to the right side, not at him')
  assert.ok(pitcherIsInvolved(plan), 'the feed credited him with the putout')
  const move = plan.putoutMoves.find((m) => m.fielder === PITCHER_ACTOR)
  assert.ok(move, 'he is the man with an out to make')
  // He leaves the mound for the bag — a body running, off his spot — and is on it,
  // with the throw in his glove, the moment the ball arrives.
  const half = pitcherFrameAt(plan, move.duration * 0.5)
  assert.equal(half.state, STATE_RUN)
  const off = Math.hypot(half.position.x - FIELD.DEFENSE.P.x, half.position.z - FIELD.DEFENSE.P.z)
  assert.ok(off > 1, `he has only come ${off.toFixed(2)} m off the mound`)
  const putout = plan.throws[plan.throws.length - 1]
  assert.equal(putout.toActor, PITCHER_ACTOR)
  const atTheBag = pitcherFrameAt(plan, putout.start + putout.duration)
  assert.deepEqual(atTheBag.position.toArray(), [FIELD.BASE.FIRST.x, 0, FIELD.BASE.FIRST.z])
  assert.equal(atTheBag.state, STATE_CATCH_MID, 'he is taking the throw')
  assert.equal(atTheBag.hasBall, true)
  assert.equal(ballCarrierAt(plan, putout.start + putout.duration), PITCHER_ACTOR)
  // ...and he stays there with it: a putout at the bag is the end of the play for
  // the ball (the last throw's receiver keeps it — see ballCarrierAt).
  assert.equal(ballCarrierAt(plan, plan.endTime - 0.01), PITCHER_ACTOR)
})

test('the pitcher is in nobody\'s cast: he is handed his own half, not drawn by one', () => {
  const plan = buildPlan(comebacker(), LAUNCH)
  // The lineup is unchanged by his involvement — the seven fielding spots this app
  // owns and a body per runner, and no body on the mound (Pitcher.jsx's own).
  assert.deepEqual(plan.cast.defense.map((a) => a.key), ['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'])
  assert.ok(!plan.cast.defense.some((a) => a.key === PITCHER_ACTOR))
  assert.equal(frameOf(evaluateCast(plan, plan.ballCatch.t), 'defense', PITCHER_ACTOR), undefined)
})
