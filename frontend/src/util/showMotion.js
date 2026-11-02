// ---------------------------------------------------------------------------
// The crowd shows' clock, in one place.
//
// A show's fans and its props are drawn by two different components — the
// spectators by Ballpark's instanced meshes, the banner and the instruments by
// CrowdShow — and they have to move as one body: the row stands up to wave its
// banner, the banner rides the row's hands up and down, and every raised hand
// stays on the cloth through the whole wave. So the motion is a pure function
// of (time, position along the row) here, and both components evaluate it from
// the same frame clock instead of each inventing its own animation.
//
// ``s`` is the row's own coordinate: 0 at the left-hand holder's centre, 1 at
// the right-hand one. The wave is an integer number of crests across the row,
// so ``bobAt(0) === bobAt(1)``: the two ends of the cloth (and so the two fans
// holding it) ride up and down together, and the cloth ripples between them
// rather than tearing away from either end.
// ---------------------------------------------------------------------------

// Each group shouts/plays for ACTIVE_SECONDS every PERIOD seconds, on its own
// phase so two groups never fire together.
export const ACTIVE_SECONDS = 5.5

// How long the banner takes to rise out of the holders' hands, and to be
// folded back down into them.
export const UNROLL_SECONDS = 0.7

// How long the row takes to lift its hands into the act, and to drop them once
// the act is over. The cloth is raised only after the arms are most of the way
// up and is gone before they come down, so a row with nothing to display has
// its hands at its sides rather than pumping an empty banner's worth of sky.
export const ARM_SECONDS = 0.45

// How far a show row rises to stand through its act, and how long the rise and
// the sit back down take. A spectator's sprite is anchored at the seat, so
// standing is a lift of the whole figure off it.
export const STAND_HEIGHT = 0.23
export const STAND_SECONDS = 0.9
export const SIT_SECONDS = 0.75

// A standing row also steps out of its seats, toward the field, so it is
// standing in front of them (and so the legs drawn under a standing fan are not
// buried inside the seat it was sitting on). Props, hands and drapes all take
// this same step, which is why it belongs to the clock and not to one of them.
export const STAND_FORWARD = 0.24

// The cloth's wave: how far it rides above and below the hands' line, how many
// crests travel along the row, and how fast they run. Integer crests are what
// keeps the two ends in step with each other and with the cloth.
export const BOB_AMPLITUDE = 0.05
export const BOB_WAVES = 2
export const BOB_RATE = 2.4

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const easeOut = (x) => 1 - (1 - x) * (1 - x)

// Harness hook: pin a group's show mid-burst so a screenshot can catch an
// intermittent show deterministically (see e2e/harness/crowd.html).
// ``?crowdHold=<id>|all`` pins from page load (``?crowdHoldT=<seconds>`` picks
// the beat, default 2.5); ``window.__crowdHold`` pins at runtime. Never
// affects playback without it.
const URL_CROWD_HOLD = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('crowdHold')
  : null
const URL_CROWD_HOLD_T = (() => {
  const raw = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('crowdHoldT')
    : null
  const t = raw == null ? NaN : parseFloat(raw)
  return Number.isFinite(t) ? t : 2.5
})()

// Where a group is in its own cycle: ``t`` seconds into the act, and whether
// the act is running at all.
export function groupCycle(time, index, id) {
  const hold = (typeof window !== 'undefined' ? window.__crowdHold : null) || URL_CROWD_HOLD
  if (hold === 'all' || hold === id) {
    const t = (typeof window !== 'undefined' ? window.__crowdHoldT : null) ?? URL_CROWD_HOLD_T
    return { active: true, t }
  }
  const period = 12 + ((index * 3.7) % 8)
  const phase = (index * 4.3) % period
  const cycle = (time + phase) % period
  return { active: cycle < ACTIVE_SECONDS, t: cycle }
}

// 0..1 — how far the row has raised its hands. The arms come up over the first
// ARM_SECONDS of the act and drop over the last ones; between acts they are
// down, with nothing in them.
export function armProgress(t) {
  if (!(t >= 0) || t > ACTIVE_SECONDS) return 0
  const up = easeOut(clamp01(t / ARM_SECONDS))
  const down = easeOut(clamp01((ACTIVE_SECONDS - t) / ARM_SECONDS))
  return Math.min(up, down)
}

// Whether the row is wearing its act pose — hands up, holding something —
// rather than its resting pose, hands empty at its sides. The two poses are
// different sprites, so this is a step and not a blend: the spectators swap
// sprites on it, and every prop the act holds is shown on the same step, so a
// hand never appears (or disappears) with something still in it.
export function actPoseUp(t) {
  return armProgress(t) >= 0.5
}

// 0..1 — how far the banner has risen out of the holders' hands. It comes up
// from the hands once they are most of the way up, and is folded away before
// they drop: the row lowers the banner, then lowers its arms.
const REVEAL_IN = ARM_SECONDS * 0.7
export function bannerReveal(t) {
  if (!(t >= 0) || t > ACTIVE_SECONDS) return 0
  const inP = clamp01((t - REVEAL_IN) / UNROLL_SECONDS)
  const outP = clamp01((ACTIVE_SECONDS - ARM_SECONDS - t) / UNROLL_SECONDS)
  return easeOut(Math.min(inP, outP))
}

// 0..1 — how far the row has stood up: rising over the first moments of the
// act, sitting back down over the last ones, and 0 the rest of the time.
export function standProgress(t) {
  if (!(t >= 0) || t > ACTIVE_SECONDS) return 0
  const up = easeOut(clamp01(t / STAND_SECONDS))
  const down = easeOut(clamp01((ACTIVE_SECONDS - t) / SIT_SECONDS))
  return Math.min(up, down)
}

// The cloth's own height at ``s`` along the row, in metres above the hands'
// line. Two crests travel from the right-hand holder to the left one, so the
// row reads as pumping the banner rather than as one rigid slab bouncing.
export function bobAt(s, time) {
  return BOB_AMPLITUDE * Math.sin(BOB_RATE * time - Math.PI * 2 * BOB_WAVES * s)
}

// How far a fan (or the patch of cloth it holds) stands above its seat at
// ``s`` along the row, ``t`` seconds into the show: the stand-up itself, and,
// once it is up, the wave it rides. Both fade with ``standProgress``, so the
// motion arrives and leaves with the act and a seated row is perfectly still.
export function rowLift(t, time, s) {
  return standProgress(t) * (STAND_HEIGHT + bobAt(s, time))
}

// How far a standing fan — and everything it holds — has stepped out of its
// seat toward the field, in metres along the crowd's facing.
export function rowStep(t) {
  return standProgress(t) * STAND_FORWARD
}

// How a musician plays: in whole steps, not a smooth slide. The drum's sticks
// strike on one step and the other, and the horns bob through four poses, all
// on the same six-a-second clock — fast enough to read as playing, slow enough
// that the cut-out changes are seen as steps, like sprites, rather than smeared
// into motion. The phase keeps neighbouring players off one another's beat.
export const PLAY_RATE = 6
export const PLAY_STEPS = 4

export function playStep(time, phase = 0) {
  return Math.floor(time * PLAY_RATE + phase) % PLAY_STEPS
}

// The horn's bob, in radians about the grip: a two-step nod into the
// mouthpiece, so a row of horns reads as blowing rather than as bobbing props.
export const HORN_BOB = [0.09, -0.04, 0.05, -0.07]
