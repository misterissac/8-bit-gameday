import test from 'node:test'
import assert from 'node:assert/strict'
import { Vector3 } from 'three'
import {
  PLAY_SETTLE_SECONDS,
  RUN_BATTER_DELAY_SECONDS,
  RUN_LEG_JITTER_SECONDS,
  RUN_LEG_SECONDS,
  RUN_SLIDE_SECONDS,
  batterTakeoffSeconds,
  buildPlan,
  buildRuns,
} from '../src/util/playPlan.js'
import { CATCH_HOLD_SECONDS, FIELD_CAST_SPOTS, THROW_WINDUP_SECONDS } from '../src/util/playCast.js'
import { DEFAULT_TUNING } from '../src/constants/tuning.js'
import { FIELD } from '../src/constants/field.js'

// The spot the pitch was hit from (the front of the plate, bat height) — the
// same launch point BattedBall hands the builder.
const LAUNCH = new Vector3(0, 1.0, -0.43)

// A ball hit to a spot, with whatever the feed says the runners did. The
// defaults are the sample grounder: a slow roller to the shortstop's left.
const hitTo = (over = {}) => ({
  coordX: 100,
  coordY: 120,
  launchSpeed: 88,
  launchAngle: 3,
  sprayAngle: -12,
  fielder: 'SS',
  wasCaught: false,
  runners: [],
  ...over,
})

// A grounder to short with a man on first, both out — the classic 6-4-3. The
// feed credits the shortstop with the ball, the second baseman with the putout
// at the bag, and the first baseman with the putout on the batter-runner.
const doublePlay = () => hitTo({
  eventType: 'grounded_into_double_play',
  runners: [
    {
      start: '1B',
      end: null,
      outBase: '2B',
      isOut: true,
      credits: [
        { position: 'SS', credit: 'f_fielded_ball' },
        { position: '2B', credit: 'f_putout' },
      ],
    },
    {
      start: null,
      end: '1B',
      outBase: null,
      isOut: false,
      credits: [
        { position: 'SS', credit: 'f_assist' },
        { position: '1B', credit: 'f_putout' },
      ],
    },
  ],
})

const runOf = (plan, actor) => plan.runs.find((r) => r.actor === actor)

// ── The runners' own walk ─────────────────────────────────────────────────
test('a runner walks one leg per base gap, from where he stood to where he ended', () => {
  const runs = buildRuns([
    { start: '1B', end: '3B', isOut: false },
    { start: null, end: '1B', isOut: false },
  ])
  const manOnFirst = runs.find((r) => r.actor === '1B')
  const batter = runs.find((r) => r.actor === 'B')
  assert.equal(manOnFirst.legs.length, 2, 'first to third is two gaps')
  assert.equal(batter.legs.length, 1, 'the batter-runner only has first to reach')
  // Each leg starts where the last one finished, so the walk is continuous.
  assert.deepEqual(manOnFirst.legs[1].from.toArray(), manOnFirst.legs[0].to.toArray())
  assert.equal(manOnFirst.legs[1].start, manOnFirst.legs[0].start + manOnFirst.legs[0].duration)
  // ...and the bases are the bases: first is first, second is second.
  assert.deepEqual(manOnFirst.legs[0].from.toArray(), [FIELD.BASE.FIRST.x, 0, FIELD.BASE.FIRST.z])
  assert.deepEqual(manOnFirst.legs[0].to.toArray(), [FIELD.BASE.SECOND.x, 0, FIELD.BASE.SECOND.z])
  assert.deepEqual(manOnFirst.legs[1].to.toArray(), [FIELD.BASE.THIRD.x, 0, FIELD.BASE.THIRD.z])
})

test('the batter-runner goes off his own follow-through, and never plays the recovery', () => {
  const runs = buildRuns([{ start: null, end: '1B' }, { start: '1B', end: '2B' }])
  // The batter's own body runs his leg (see util/batterRunner.js), and that body
  // is still swinging until its follow-through is whole (the follow-through and the
  // beat it holds its finish on): the run starts when the pose does, so the two can
  // never disagree about the moment the box was left. The *way home* — the recovery —
  // is not waited out and not played at all: a man who has put a ball in play drops
  // the bat and goes (see the takeoff's own note in util/playPlan.js).
  const swing = DEFAULT_TUNING.batter
  const followed = swing.followThrough + swing.followHold
  assert.equal(runs.find((r) => r.actor === 'B').legs[0].start, batterTakeoffSeconds())
  assert.equal(batterTakeoffSeconds(swing), followed)
  assert.ok(followed > RUN_BATTER_DELAY_SECONDS, 'his follow-through is longer than the reference\'s bat drop')
  assert.ok(
    batterTakeoffSeconds(swing) < followed + swing.recoveryTime,
    'the takeoff still waits out the recovery: he is a runner, not a hitter between pitches',
  )
  // ...and the recovery itself is untouched — it is what a swing that produces no
  // play still rides home (see Batter.jsx), and the takeoff is the only clock that
  // leaves it out.
  assert.ok(swing.recoveryTime > 0, 'the swing has no way home left to skip')
  // A tuning that swings and resets faster than the reference's 300 ms is not a
  // negative delay: the reference's own floor still stands.
  assert.equal(batterTakeoffSeconds({ followThrough: 0.05, followHold: 0.05, recoveryTime: 0.1 }), RUN_BATTER_DELAY_SECONDS)
  assert.equal(runs.find((r) => r.actor === '1B').legs[0].start, 0)
})

test('a run is timed in the reference\'s own 2.9 s a leg, and identically every time', () => {
  const first = buildRuns([{ start: '1B', end: '3B' }])[0]
  const second = buildRuns([{ start: '1B', end: '3B' }])[0]
  const leg = first.legs[0].duration
  assert.ok(Math.abs(leg - RUN_LEG_SECONDS) <= RUN_LEG_JITTER_SECONDS / 2 + 1e-9, `leg ${leg}`)
  // The reference draws its ±200 ms of jitter at random; ours is keyed to the
  // runner, because the play loops and every cycle must replay identically.
  assert.deepEqual(
    first.legs.map((l) => l.duration),
    second.legs.map((l) => l.duration),
    'the same runner takes the same time on a rebuild',
  )
  assert.equal(first.arriveAt, first.legs[first.legs.length - 1].start + first.legs[first.legs.length - 1].duration)
  // ...and the slide starts a fixed beat before he arrives.
  assert.equal(first.slideAt, first.arriveAt - RUN_SLIDE_SECONDS)
})

test('a movement the feed cannot resolve to two bases is not played at all', () => {
  const runs = buildRuns([
    { start: 'dugout', end: '1B' },
    { start: '1B', end: 'moon' },
    { start: '2B', end: '3B' },
  ])
  assert.equal(runs.length, 1, 'only the playable movement')
  assert.equal(runs[0].actor, '2B')
})

test('one run per body: a runner the feed moves twice walks it in one go', () => {
  const runs = buildRuns([
    { start: '1B', end: '2B' },
    { start: '1B', end: '3B' },
  ])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].endKey, '3B')
  assert.equal(runs[0].legs.length, 2)
})

test('a runner who scores walks home, and a home run is the whole circuit', () => {
  const scoring = buildRuns([{ start: '2B', end: 'score' }])[0]
  assert.equal(scoring.legs.length, 2, 'second to third, third to home')
  assert.equal(scoring.endKey, 'score')
  const homer = buildRuns([{ start: null, end: 'score' }])[0]
  assert.equal(homer.legs.length, 4, 'the batter tours all four bags')
})

// ── The whole play ────────────────────────────────────────────────────────
test('a 6-4-3 double play: both men run, the ball goes through the chain, two outs', () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  // The men: the runner from first heads for second (the base he was forced
  // to), and the batter-runner heads for first.
  assert.deepEqual(plan.runs.map((r) => r.actor).sort(), ['1B', 'B'])
  assert.equal(runOf(plan, '1B').endKey, '2B')
  assert.equal(runOf(plan, 'B').endKey, '1B')
  // The ball: fielded by the shortstop, thrown to the second baseman, thrown on
  // to first.
  assert.equal(plan.chaser, 'SS')
  assert.deepEqual(plan.throws.map((t) => [t.fromActor, t.toActor]), [['SS', '2B'], ['2B', '1B']])
  // Every throw is preceded by the reference's 750 ms wind-up, in which the
  // ball is still in the thrower's hand (nothing is teleported to a receiver) —
  // and the first one follows the beat the fielder holds the ball in after the
  // catch himself.
  let release = plan.ballCatch.t + CATCH_HOLD_SECONDS + THROW_WINDUP_SECONDS
  for (const th of plan.throws) {
    assert.ok(Math.abs(th.start - release) < 1e-9, `${th.fromActor}'s throw leaves at ${th.start}, expected ${release}`)
    release = th.start + th.duration + THROW_WINDUP_SECONDS
  }
  // The out at the bag is recorded when the throw arrives, not when it left.
  const bagThrow = plan.throws[0]
  assert.equal(plan.outs.length, 1, 'the man forced at second')
  assert.ok(Math.abs(plan.outs[0].time - (bagThrow.start + bagThrow.duration)) < 1e-9)
  assert.equal(plan.outs[0].text, 'OUT')
  // The play is not over until the last body has stopped moving.
  const lastArrival = Math.max(...plan.runs.map((r) => r.arriveAt))
  const lastThrow = plan.throws[plan.throws.length - 1]
  assert.ok(plan.endTime >= lastArrival - 1e-9, 'the last runner fits inside the play')
  assert.ok(plan.endTime >= lastThrow.start + lastThrow.duration - 1e-9, 'so does the last throw')
})

test('a ball caught in the air is one out at the catch, and nobody runs who was not moved', () => {
  const plan = buildPlan(hitTo({ fielder: 'CF', wasCaught: true, coordX: 130, coordY: 130, launchSpeed: 100, launchAngle: 30, totalDistance: 360 }), LAUNCH)
  assert.equal(plan.wasCaught, true)
  assert.deepEqual(plan.runs, [])
  assert.equal(plan.outs.length, 1)
  assert.ok(Math.abs(plan.outs[0].time - plan.ballCatch.t) < 1e-9, 'the out is the catch')
  assert.equal(plan.resultText, null, 'a caught ball is not a hit')
})

test('a single sends the batter-runner to first and names the hit', () => {
  const plan = buildPlan(hitTo({ eventType: 'single', runners: [{ start: null, end: '1B', isOut: false }] }), LAUNCH)
  assert.equal(plan.outs.length, 0)
  assert.equal(plan.resultText, 'SINGLE')
  const batter = runOf(plan, 'B')
  assert.equal(batter.legs.length, 1)
  // The runner's own arrival is what ends the play, even though the ball was
  // fielded and thrown long before he got there — plus the settle the reference
  // holds the play open for after its last event.
  assert.equal(plan.endTime, batter.arriveAt + PLAY_SETTLE_SECONDS)
})

test('a double and a triple read off the base the batter-runner reached', () => {
  const double = buildPlan(hitTo({ fielder: 'RF', eventType: 'double', runners: [{ start: null, end: '2B' }] }), LAUNCH)
  assert.equal(double.resultText, 'DOUBLE')
  assert.equal(runOf(double, 'B').legs.length, 2)
  const triple = buildPlan(hitTo({ fielder: 'RF', eventType: 'triple', runners: [{ start: null, end: '3B' }] }), LAUNCH)
  assert.equal(triple.resultText, 'TRIPLE')
  assert.equal(runOf(triple, 'B').legs.length, 3)
})

test('a home run names itself and trots the whole circuit, whatever the ball did', () => {
  const plan = buildPlan(hitTo({
    fielder: 'CF',
    eventType: 'home_run',
    launchSpeed: 104,
    launchAngle: 28,
    totalDistance: 420,
    // Past the wall (330 ft, 100.6 m): Statcast's own coordinates, landing
    // 180 m from the plate.
    coordX: 250,
    coordY: 400,
    runners: [{ start: null, end: 'score' }],
  }), LAUNCH)
  assert.equal(plan.resultText, 'HOME RUN')
  const batter = runOf(plan, 'B')
  assert.equal(batter.legs.length, 4)
  assert.ok(plan.endTime >= batter.arriveAt - 1e-9, 'the trot sets the length of the play')
  assert.ok(plan.wallExit, 'and the ball still clears the wall on its own flight')
})

test('a foul has no runners, no outs and no hit to name', () => {
  const plan = buildPlan(hitTo({ eventType: 'foul', fielder: 'C', wasCaught: false, runners: [] }), LAUNCH)
  assert.deepEqual(plan.runs, [])
  assert.equal(plan.outs.length, 0)
  assert.equal(plan.resultText, null)
})

// ── The cast the plan hands the component layer ───────────────────────────
test('the cast is the seven fielders this app owns, plus a body per runner', () => {
  const plan = buildPlan(doublePlay(), LAUNCH)
  assert.deepEqual(plan.cast.defense.map((a) => a.key), FIELD_CAST_SPOTS)
  // The runners who start on a base are bodies of the cast's; the batter-runner
  // is the batter's own body, which is already at the plate (see castLineup), so
  // the plan keeps his walk and hands it to Batter.jsx rather than drawing him.
  assert.deepEqual(plan.cast.offense.map((a) => a.key).sort(), ['1B'])
  // The pitcher and the catcher are their own components — never in this cast.
  assert.ok(!plan.cast.defense.some((a) => a.key === 'P' || a.key === 'C'))
  // Every body carries the spot it stands on between plays.
  for (const actor of [...plan.cast.defense, ...plan.cast.offense]) {
    assert.ok(actor.home && Number.isFinite(actor.home.x) && Number.isFinite(actor.home.z), actor.key)
  }
})

test('the body the feed spells as a missing start is the batter-runner', () => {
  const plan = buildPlan(hitTo({ runners: [{ start: null, end: '1B' }] }), LAUNCH)
  // The only runner on the play is the batter's own: no body of the cast's moves
  // at all, and his own walk still starts where the basepath does (the plate).
  assert.deepEqual(plan.cast.offense.map((a) => a.key), [])
  assert.deepEqual(runOf(plan, 'B').legs[0].from.toArray(), [0, 0, 0], 'he starts at the plate')
  assert.equal(runOf(plan, 'B').legs[0].start, batterTakeoffSeconds(), 'and on his own takeoff')
})
