import { Vector3 } from 'three'
import { FIELD } from '../constants/field.js'

// ---------------------------------------------------------------------------
// The cast: which bodies stand on the field during a play, where each one
// stands, and what each one is doing at a given second of the choreography.
//
// Ported from solomon-gumball:baseball-sim-main (kept as a read-only
// reference): `Constants.tsx`'s base order + `getLocationForBaseCode`, and
// `components/Players.tsx`'s `PlayerControls` — the same player.glb (our copy
// carries the identical 14 clips) driven by an AnimationMixer, with the
// animation states and their rules taken from `setAnimationState`:
//
//   * `Running` is the base-running/sprinting clip, played at 4x
//     (`setEffectiveTimeScale(4)`) because the baked clip is a jog;
//   * `SlideStop`, `StandingNeutral`, `CatchHI`, `CatchMid` and `AssistThrow`
//     are one-shot: played once and held on their last frame
//     (`clampWhenFinished` + `LoopOnce`), so a fielder stays in the pose he
//     finished in rather than snapping back;
//   * every state change cross-fades (0.2 s) rather than cutting;
//   * a fielder catches what he ran down — `CatchHI` for a ball caught in the
//     air, `CatchGround` for one fielded off the ground — and throws with
//     `AssistThrow`, the receiver answering with `CatchMid`;
//   * a runner who is not running stands in `RunnerAtBaseIdle` on his base, a
//     fielder who is not moving stands in `StandingNeutral`.
//
// Two bodies on the field are *not* in this cast: the pitcher (Pitcher.jsx
// owns him at the mound, and he is authored procedurally from the delivery, not
// played back as a clip) and the catcher (Catcher.jsx's own body, on the
// asset's own CatcherIdle clip — the same body and the same plumbing, but he
// stands where he stands all game and this cast is the men a *play* moves).
//
// The pitcher's own half of a play is still read here — `pitcherFrameAt` is his
// schedule, off the same plan and the same rules as every other fielder's, and it
// is handed to the component that draws him (Pitcher.jsx) exactly as the
// batter-runner's walk is handed to Batter.jsx — so a comebacker he fields, the
// bag he covers and the throw he makes are played by the body standing on the
// mound, the reference's pool one body at a time. The catcher's is not: a ball the
// man behind the plate fields still flies, rolls and is thrown along the plan with
// no body of ours to move, and that is the one place this cast is narrower than
// the reference's (which draws both from the same pool as the other seven).
//
// Pure: no clock, no three scene graph, no React. `evaluateCast(plan, t)` is
// the whole API the component layer needs, and it is unit-tested directly.
// ---------------------------------------------------------------------------

// The reference's own base order (`BASE_ORDER` in LiveGameView): the plate
// first (a batter-runner starts there), then the three bags, then home again
// for a runner who scores. `null` is the batter's slot in the feed's movement
// data, and 'score' is how the feed spells touching home.
export const BASE_ORDER = [null, '1B', '2B', '3B', 'score']

// The batter's own slot in the feed's movement data (his start is spelled as a
// missing value) — the key of the run the batter's own body owns, rather than one
// of this cast's bodies (see `castLineup`).
export const BATTER_ACTOR = 'B'

// The reference's `getBaseIndexForMovementKey`: -1 means "not a base we can
// walk to" (an unknown key), which makes the run unplayable and skips it.
export function baseIndex(key) {
  switch (key) {
    case null: return 0
    case 'B': return 0
    case '1B': return 1
    case '2B': return 2
    case '3B': return 3
    case 'score':
    case 'home':
    case '4B': return 4
    default: return -1
  }
}

// Where a runner stands for a base key (`getLocationForBaseCode(code,
// 'offense')` in the reference). A batter-runner stands at the plate; a runner
// who scores crosses it; the bags are the bags. y = 0: every one of them
// stands on the ground, and the model is authored from its feet up.
export function offenseSpot(key) {
  const v = (base) => new Vector3(base.x, 0, base.z)
  switch (key) {
    case null:
    case 'B':
    case 'score':
      return v(FIELD.BASE.HOME)
    case '1B': return v(FIELD.BASE.FIRST)
    case '2B': return v(FIELD.BASE.SECOND)
    case '3B': return v(FIELD.BASE.THIRD)
    default: return v(FIELD.BASE.HOME)
  }
}

// Where a fielder stands (`getLocationForBaseCode(code, 'defense')`): the
// standard defensive alignment, FIELD.DEFENSE's own spots.
export function defenseSpot(key) {
  const home = FIELD.DEFENSE[key]
  return home ? new Vector3(home.x, 0, home.z) : new Vector3(FIELD.DEFENSE.CF.x, 0, FIELD.DEFENSE.CF.z)
}

// The seven fielding spots this cast owns: the whole alignment except the
// pitcher and the catcher, who are their own components (see the note above).
export const FIELD_CAST_SPOTS = ['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']
export const OWNED_SPOTS = new Set(FIELD_CAST_SPOTS)

// Whether a spot is one this cast can put a body on. A ball fielded by the
// pitcher or the catcher (or by a position the feed invented) has no actor.
export const isCastSpot = (key) => OWNED_SPOTS.has(key)

// The lineup for one play: the seven fielders on their spots, plus one runner
// for every base the plan has a run from. `runs` is playPlan's own list.
//
// The batter-runner is deliberately *not* one of these bodies. His run is the
// plan's (`runs` keeps it — the play's own length is read off it), but the body
// that runs it is the one that swung: the batter's own, in Batter.jsx, which
// leaves its box for the basepath the moment the swing has resolved. That is why
// the cast draws seven fielders and the runners on the bases and nothing else —
// the third body on the field with its own component, after the pitcher and the
// catcher (see the note at the top of this file). Drawing him here as well is
// what used to put two bodies at the plate: one swinging, one standing on it.
export function castLineup(runs = []) {
  const defense = FIELD_CAST_SPOTS.map((key) => ({ key, kind: 'defense', home: defenseSpot(key) }))
  const offense = runs
    .filter((run) => run.actor !== BATTER_ACTOR)
    .map((run) => ({ key: run.actor, kind: 'offense', home: offenseSpot(run.actor) }))
  return { defense, offense }
}

// ── Animation states (Players.tsx's CharacterAnimationState, the subset the
// fielding and baserunning choreography uses) ──────────────────────────────
export const STATE_RUN = 'Running'
export const STATE_SLIDE = 'SlideStop'
export const STATE_NEUTRAL = 'StandingNeutral'
export const STATE_AT_BASE = 'RunnerAtBaseIdle'
export const STATE_CATCH_HIGH = 'CatchHI'
export const STATE_CATCH_GROUND = 'CatchGround'
export const STATE_CATCH_MID = 'CatchMid'
export const STATE_THROW = 'AssistThrow'

// `Running` is played at 4x, exactly as the reference sets it.
export const RUN_TIME_SCALE = 4
// Every state change cross-fades over this long (the reference's 0.2 s).
export const STATE_FADE_SECONDS = 0.2
// One-shot states: played once and held (the reference's LoopOnce +
// clampWhenFinished list, narrowed to the clips this cast uses).
export const ONE_SHOT_STATES = new Set([STATE_SLIDE, STATE_NEUTRAL, STATE_CATCH_HIGH, STATE_CATCH_MID, STATE_THROW])

// The reference throws with a wind-up: it attaches the ball to the thrower's
// hand and waits 750 ms before the throw arc starts, so the throw reads as a
// body throwing rather than a ball leaving a glove.
export const THROW_WINDUP_SECONDS = 0.75
// How long a catcher of a throw holds `CatchMid` before returning to neutral.
export const THROW_RECEIVE_SECONDS = 0.5
// How long the chaser holds his catch pose before the play moves on.
export const CATCH_HOLD_SECONDS = 0.4

// Evaluate a piecewise-linear motion schedule (list of {from, to, start,
// duration}) at time t. Before a segment starts the actor holds at that
// segment's ``from``; during it they lerp ``from`` -> ``to``; after the last
// segment they hold at its ``to``. The same evaluator the reference's
// `playerAnimateToLocation` implements with its promise chain.
export function evalSegments(segments, t) {
  if (!segments || segments.length === 0) return null
  for (const seg of segments) {
    if (t < seg.start) return seg.from.clone()
    if (t < seg.start + seg.duration) {
      const p = Math.min(Math.max((t - seg.start) / seg.duration, 0), 1)
      return seg.from.clone().lerp(seg.to, p)
    }
  }
  return segments[segments.length - 1].to.clone()
}

// Which segment of a schedule is live at t (null between segments and after
// the last one) — the reference keys an actor's `Running` state off exactly
// this: the clip plays while a leg is in progress and drops the moment it
// ends.
function activeSegment(segments, t) {
  if (!segments) return null
  for (const seg of segments) {
    if (t >= seg.start && t < seg.start + seg.duration) return seg
  }
  return null
}

// The actor holding the ball at time t, or null while the ball is in the air
// on its own (a batted ball in flight, or a throw). Mirrors the reference's
// `attachBallToHand` bookkeeping: the ball is in the chaser's hand from the
// moment he catches it until the first throw leaves, and in the thrower's hand
// through each wind-up.
export function ballCarrierAt(plan, t) {
  if (!plan) return null
  const throws = plan.throws || []
  for (let i = 0; i < throws.length; i++) {
    const th = throws[i]
    const windupStart = th.start - THROW_WINDUP_SECONDS
    if (t >= windupStart && t < th.start) return th.fromActor
  }
  // Between the catch and the first throw's wind-up the ball is in the chaser's
  // glove — and it stays there for the rest of the play when nobody throws it:
  // a caught fly ball is never thrown anywhere, and a ball the chaser carries
  // to the bag himself is carried, not rolled.
  // ...and the man who receives the last throw keeps it too: a double play ends
  // with the ball in the first baseman's glove, not in the air where he caught
  // it.
  const last = throws[throws.length - 1]
  if (last && t >= last.start + last.duration && t < plan.endTime) return last.toActor
  const firstThrow = throws[0]
  const carryFrom = plan.ballCatch?.t
  // With nothing thrown after it, the chaser keeps the ball to the end of the
  // play — a caught fly stays in the glove that caught it, a ball carried to a
  // bag is carried all the way, and a clean hit's ball ends up in the hand of
  // the man who fielded it rather than hanging in the air where he picked it up.
  const carryTo = firstThrow ? firstThrow.start - THROW_WINDUP_SECONDS : plan.endTime
  if (carryFrom != null && t >= carryFrom && t < carryTo) return plan.chaser
  return null
}

// ── Per-actor evaluation ───────────────────────────────────────────────────
// A defense actor's schedule: the chaser's own legs (defensive spot -> the
// fielding point, plus the walk to the bag for an unassisted putout), or a
// putout fielder's run to the bag, or nothing at all.
function defenseSchedule(plan, actor) {
  if (actor.key === plan.chaser) return plan.chaserSegments || []
  const move = (plan.putoutMoves || []).find((m) => m.fielder === actor.key)
  if (!move) return []
  return [{ from: move.from, to: move.to, start: 0, duration: move.duration }]
}

// Where a body stands and what it does when the plan is not asking it to do
// anything: its own spot (its base, or its defensive position), facing the next
// base it would run to (offense) or the plate (defense). This is the alignment
// every play starts from and the reset returns to — the same pose the whole
// cycle replays from.
export function idleHome(actor) {
  return actor.kind === 'offense' ? offenseSpot(actor.key) : defenseSpot(actor.key)
}

export function idleLookTarget(actor) {
  if (actor.kind !== 'offense') return new Vector3(FIELD.BASE.HOME.x, 0, FIELD.BASE.HOME.z)
  const from = baseIndex(actor.key === BATTER_ACTOR ? null : actor.key)
  const next = BASE_ORDER[Math.min(Math.max(from, 0) + 1, BASE_ORDER.length - 1)]
  if (next === 'score') return new Vector3(FIELD.BASE.HOME.x, 0, FIELD.BASE.HOME.z)
  return offenseSpot(next)
}

export const idleStateFor = (kind) => (kind === 'offense' ? STATE_AT_BASE : STATE_NEUTRAL)

function defenseActorAt(plan, actor, t, carrier) {
  const schedule = defenseSchedule(plan, actor)
  const position = schedule.length ? evalSegments(schedule, t) : actor.home.clone()
  const running = activeSegment(schedule, t)
  // The sprint's own end: the reference sets the catch pose when the fielder
  // arrives, which for a ball he runs down is the end of his first leg.
  const sprintEnd = plan.chaserSegments?.length && actor.key === plan.chaser
    ? plan.chaserSegments[0].start + plan.chaserSegments[0].duration
    : null

  // The states are applied weakest first, so the strongest one at t wins:
  // standing → running (a live leg) → the catch (the frame the sprint ends) →
  // the throw chain. The throw chain is last on purpose: a fielder who gloves
  // the ball and immediately winds up a throw is *throwing* from the moment the
  // ball is in his hand, not holding the pose he caught it in.
  let state = STATE_NEUTRAL
  if (running) state = STATE_RUN
  // The catch itself: the chaser, from the instant his sprint ends.
  if (actor.key === plan.chaser && sprintEnd != null && t >= sprintEnd && t < sprintEnd + CATCH_HOLD_SECONDS) {
    state = plan.wasCaught ? STATE_CATCH_HIGH : STATE_CATCH_GROUND
  }
  // The throw chain: wind-up and release, then the receiver's catch.
  for (const th of plan.throws || []) {
    const windupStart = th.start - THROW_WINDUP_SECONDS
    if (th.fromActor === actor.key && t >= windupStart && t < th.start + THROW_RECEIVE_SECONDS) {
      state = STATE_THROW
    }
    if (th.toActor === actor.key && t >= th.start && t < th.start + th.duration + THROW_RECEIVE_SECONDS) {
      state = STATE_CATCH_MID
    }
  }

  return {
    key: actor.key,
    kind: 'defense',
    position,
    state,
    // Whether the ball is in this fielder's hand right now (the same answer
    // `ballCarrierAt` gives the ball's own renderer): true from the moment he
    // gloves it until the throw leaves, which is what makes the ball ride his
    // hand through the catch and the wind-up instead of sitting on the dirt.
    hasBall: carrier === actor.key,
    // A fielder looks at what he is doing: the ball while he runs it down,
    // the bag (and the man he is throwing to) otherwise.
    lookTarget: defenseLookTarget(plan, actor, t),
  }
}

function defenseLookTarget(plan, actor, t) {
  // A throw only claims his eyes once it is his to make or to catch: a fielder
  // stares at the plate while the pitch is coming, turns to the bag as he winds
  // the throw up, and watches the man throwing at him while the ball is on its
  // way. (Looking at a base he will not throw to for another three seconds
  // reads as a body that already knows the future.)
  const th = (plan.throws || []).find((x) => (
    (x.fromActor === actor.key && t >= x.start - THROW_WINDUP_SECONDS)
    || (x.toActor === actor.key && t >= x.start && t < x.start + x.duration)
  ))
  if (th) {
    const to = th.fromActor === actor.key ? th.toPos : th.fromPos
    if (to) return to.clone()
  }
  // A fielder who is *under way* looks where he is going — the place the leg he is
  // on ends at. For the chaser that is the fielding point, so the ball he is running
  // down is what he is aimed at for the whole of his sprint; for a man covering a bag
  // it is the bag, and it is that leg rather than the plate that decides it, because a
  // body that ran to a place while watching the plate would be running backwards. It
  // is the rule a runner is already on (`runFrame`), and the reason the schedule is
  // read here rather than the chase alone: the walk to the bag is the same walk
  // whoever makes it.
  const leg = activeSegment(defenseSchedule(plan, actor), t)
  if (leg) return leg.to.clone()
  // ...and a body that is not going anywhere watches the ball he is waiting for: the
  // chaser before the catch, at the fielding point the ball is coming to. (A chaser
  // the schedule never moved — a ball hit right at him — is on the same errand, and
  // this is also the frame between his sprint's end and the ball's arrival.)
  if (actor.key === plan.chaser && t < (plan.ballCatch?.t ?? 0)) return plan.catchLocation.clone()
  // Everyone else watches the plate: the pitch and the swing are the only thing
  // happening until it is hit, and a fielder's job is to be ready for it.
  return new Vector3(FIELD.BASE.HOME.x, 0, FIELD.BASE.HOME.z)
}

// One runner's own walk, at time t: where he stands on it, what he is playing
// while he is there, and where he is looking. A runner is *in* a leg (and so on
// his feet) from that leg's start until it ends, goes into his slide over its
// last RUN_SLIDE_SECONDS, and waits in his own idle clip on the base he reached
// once the last leg is behind him. The batter-runner's own body reads this too
// (see util/batterRunner.js), so the two ways of drawing the same walk can never
// disagree about where on it he is.
export function runFrame(run, t) {
  const position = evalSegments(run.legs, t)
  const leg = activeSegment(run.legs, t)
  let state = STATE_AT_BASE
  if (leg) state = t >= run.slideAt ? STATE_SLIDE : STATE_RUN
  return {
    position,
    state,
    // A runner looks where he is going (the reference re-faces the runner
    // toward the next location every frame while he is more than a metre out),
    // and looks at the next base along once he has arrived and settled — which
    // for a settled body is its own actor's business, so that half is the
    // caller's to fill in (see `offenseActorAt`, and batterRunner's idle look).
    lookTarget: leg ? leg.to.clone() : null,
  }
}

function offenseActorAt(plan, actor, t) {
  const run = (plan.runs || []).find((r) => r.actor === actor.key)
  if (!run) {
    return { key: actor.key, kind: 'offense', position: actor.home.clone(), state: STATE_AT_BASE, hasBall: false, lookTarget: idleLookTarget(actor) }
  }
  const frame = runFrame(run, t)
  return {
    key: actor.key,
    kind: 'offense',
    position: frame.position,
    state: frame.state,
    hasBall: false,
    lookTarget: frame.lookTarget ?? idleLookTarget(actor),
  }
}

// The alignment the cast resets to: every body back on its own spot, in its own
// idle clip, facing the way it faces before a pitch. Every play starts from
// this and returns to it once its choreography has finished, which is what lets
// the next cycle replay the same play — and what the user means by "reset
// everything after each choreography": no body keeps a position, a pose or the
// ball across plays.
//
export function resetFrames(plan) {
  const frames = new Map()
  if (!plan?.cast) return frames
  for (const actor of [...plan.cast.defense, ...plan.cast.offense]) {
    frames.set(`${actor.kind}:${actor.key}`, {
      key: actor.key,
      kind: actor.kind,
      position: idleHome(actor),
      state: idleStateFor(actor.kind),
      hasBall: false,
      lookTarget: idleLookTarget(actor),
    })
  }
  return frames
}

// Everything the component layer needs for one frame: the position, facing,
// animation state and ball possession of every body in the cast, at time t of
// the play.
export function evaluateCast(plan, t) {
  if (!plan?.cast) return []
  const carrier = ballCarrierAt(plan, t)
  const out = []
  for (const actor of plan.cast.defense) out.push(defenseActorAt(plan, actor, t, carrier))
  for (const actor of plan.cast.offense) out.push(offenseActorAt(plan, actor, t))
  return out
}

// ── The pitcher's own half of the play ──────────────────────────────────────
// The pitcher is one of the nine, and a plan choreographs him like the rest: he
// chases a comebacker (a ball the feed's own hit location sends to "1"), he runs
// to the bag for a putout the feed credits him with, and his arm is a link in the
// assist chain (`throws` names him from or to). What he is not is a *body* here:
// Pitcher.jsx draws him, off his own delivery rather than off the asset's clips
// (see the note at the top of this file), so his schedule is evaluated here and
// handed over — the same split the batter-runner's run has (castLineup).
export const PITCHER_ACTOR = 'P'

// His own actor record: the spot he stands on between plays, and the kind that
// makes `defenseActorAt` read him as a fielder (a glove, no bat, a thrower).
const pitcherActor = () => ({ key: PITCHER_ACTOR, kind: 'defense', home: defenseSpot(PITCHER_ACTOR) })

/**
 * Whether a plan hands the pitcher anything to do at all: he is the man the ball
 * was hit to, he is credited with a putout (the grounder to the right side he
 * covers first on), or he throws or receives in the assist chain. A plan that
 * never names him leaves him to his own component — the delivery, and the set
 * stance between pitches.
 *
 * It is a property of the *plan* and not of a second of one, so a body handed over
 * at the launch stays handed over until the play is over.
 *
 * @param {object|null} plan util/playPlan.js's own plan
 * @returns {boolean}
 */
export function pitcherIsInvolved(plan) {
  if (!plan) return false
  if (plan.chaser === PITCHER_ACTOR) return true
  if ((plan.putoutMoves || []).some((move) => move.fielder === PITCHER_ACTOR)) return true
  return (plan.throws || []).some((th) => th.fromActor === PITCHER_ACTOR || th.toActor === PITCHER_ACTOR)
}

/**
 * The pitcher's own frame of the play at time `t` — where he stands, which clip he
 * is playing, whether the ball is in his hand and where he is looking — or null
 * when this plan never gives him anything to do (see `pitcherIsInvolved`).
 *
 * It is the same evaluation the cast's own bodies get: `defenseActorAt` reads a
 * *plan*, not a lineup, so the pitcher's play is the chaser's legs, a putout run to
 * the bag, and the throw chain — exactly the choreography he would be given if he
 * were one of the bodies in this cast. His root's own place is his spot on the
 * mound, so a play that only asks him to catch a throw has him standing there
 * waiting for it.
 *
 * @param {object|null} plan util/playPlan.js's own plan
 * @param {number} t seconds since the ball was hit (the play's own clock)
 * @returns {object|null} the same frame shape `evaluateCast` answers with
 */
export function pitcherFrameAt(plan, t) {
  if (!pitcherIsInvolved(plan)) return null
  return defenseActorAt(plan, pitcherActor(), t, ballCarrierAt(plan, t))
}

// The yaw that points a body at a target: a plain atan2 of the offset, which
// turns the frame's own +Z toward what the body is looking at. The asset's body
// faces +Z in its own rest frame (see util/batterLook.js, which paints the face),
// so every body drawn in that frame is turned straight by this and carries no
// half turn of its own — the cast (FieldCast.jsx) and the catcher
// (Catcher.jsx). The one body that is not is the batter's: his own frame is the
// asset's turned half round, because the whole swing is authored facing the
// pitcher (-Z). That half turn is added back where *his* frame is yawed — see
// util/batterRunner.js's own BATTER_FRAME_TURN.
export function facingYaw(position, target) {
  if (!target) return null
  const dx = target.x - position.x
  const dz = target.z - position.z
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return null
  return Math.atan2(dx, dz)
}
