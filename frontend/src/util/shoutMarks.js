// ---------------------------------------------------------------------------
// The shout marks: the cartoon wedges that flick off a cheering row.
//
// These used to be little pixel bursts that drifted up out of the crowd like
// speech bubbles. Sound does not float: it is *emitted*, from a place, on a
// beat. So each shouting row now gets two marks — one over each top corner of
// the row, where a cartoonist would ink them — and each mark is three long thin
// wedges, each riding its own lane across the mark, springing from the corner's
// own side. The narrow ends rest on the row's corner, and the wedges lean *up
// and out* — a diagonal toward the corner's own side of the group, the picture a
// cartoonist inks over a shouting crowd — so the mark reads as a shout thrown
// off the end of the row rather than as a flagpole standing over it.
//
// The mark is billboarded to the camera by CrowdShow, so the lean is chosen in
// the *screen* plane: the angles below are the mark's own left/right, and the
// component flips the sign when a corner appears on the other side of the group
// (looking at the row from behind, say), so the mark on the left of the screen
// always leans left and the one on the right always leans right.
//
// The motion is a *boil*, not a drift: the wedges' angles and lengths are
// sampled from a clock quantised to a cartoon frame rate, so they snap between
// poses the way hand-inked effects do, and they never rise. Each burst then
// swells on the row's beat in a handful of whole steps — thrown out of the corner
// at a nub, grown in jumps to full size through the middle of the shout, away
// again before the next one — and while it is up its root also twitches a couple
// of centimetres, which is the only position change it has.
//
// Everything here is a pure function of (time, the row): the layout is drawn
// from the group's id, so a row keeps the same three wedges from show to show,
// and the same numbers can be checked in a test without a renderer.
// ---------------------------------------------------------------------------

// Three wedges to a mark, fanned so each leaves the corner at its own lean.
export const SHOUT_RAYS = 3

// The cartoon frame rate the boil is sampled at. Twelve a second reads as
// hand-drawn animation; the app runs at sixty, so the wedges hold each pose for
// five frames and then jump.
export const SHOUT_FRAME = 1 / 12

// A burst is up for this fraction of its own beat, and snaps in and out over
// this much of it.
export const SHOUT_ON = 0.62
export const SHOUT_FADE = 0.14

// The swell: a shout is thrown, not switched on. Over the visible part of the
// beat the mark grows out of its corner over the first third, holds at full
// size through the middle, and shrinks away over the last third.
export const SHOUT_GROW = 0.34
export const SHOUT_SHRINK = 0.38

// ...in *steps*, not smoothly. Everything else about these marks is drawn at a
// cartoon frame rate and in whole texels, so the size snaps through four steps
// too: a burst is drawn at a nub, then a bigger nub, then nearly full, then
// full, like a hand-inked effect whose frames each fill in a bit more. Each
// step holds for about one twelve-a-second cartoon frame as the burst is
// thrown, and the jump is roughly four of the wedge texture's own texels.
export const SHOUT_SWELL_STEPS = [0.34, 0.55, 0.76, 1]
export const SHOUT_MIN_SCALE = SHOUT_SWELL_STEPS[0]

// How far a burst's root twitches while it is up, in metres, and how far each
// wedge's angle swings from its base, in radians.
export const SHOUT_TWITCH = 0.025
export const SHOUT_WOBBLE_MIN = (7 * Math.PI) / 180
export const SHOUT_WOBBLE_MAX = (10 * Math.PI) / 180

// The wedges' base angles from upright — all three lean up and outboard, so the
// mark opens away from the crowd it came from without lying down: the first,
// nearest the corner, is the most diagonal (a shout thrown off the end of the
// row), the last is the most upright — but even that one, at its widest swing,
// still leans off upright, so the mark never turns into a flagpole. Both corners
// mirror each other.
const BASE_ANGLES_DEG = [48, 37, 26]

// ...and they are spaced *sideways* as well as fanned, because leaning the three
// off one point is not enough to see them as three: at the plate camera the
// whole mark is only a dozen-odd pixels across, and a shared origin draws the
// three wedges as one thick band with a frayed tip. Each wedge gets its own lane
// across the mark's own width — the most diagonal one outboard, the most upright
// one inboard — so every streak keeps a gap of clean sky from its neighbours
// along its whole length, the way three drawn sound lines do. The component
// mirrors the lanes with the lean, so the outboard wedge stays outboard on
// either side of the group.
export const SHOUT_LANE = 0.15

export function hashSeed(str) {
  let h = 2166136261
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One row's two marks, in the row's own coordinates: ``along`` is the offset
// from the row's centre along its axis (util/fanSprites.rowRight), ``height`` is
// metres above the row's anchor (its seated line), and the wedges are in
// radians/units for a quad whose narrow end sits at the root.
export function shoutBursts(id, span) {
  const rng = mulberry32(hashSeed(`${id}-marks`))
  const half = Math.max(0.2, span / 2)
  // One beat for the whole row: the two corners take it in turns, and because
  // they share the clock they keep taking it in turns as long as the show runs,
  // instead of drifting apart until both fall quiet at once.
  const beat = 0.8 + rng() * 0.24
  return [-1, 1].map((side, corner) => ({
    side,
    // Just past the last fan at that end of the row.
    along: side * (half + 0.16),
    // The roots sit clear of the raised banner (whose top edge is ~1.3 m above
    // the seats) and of the row's heads.
    height: 1.42 + rng() * 0.16,
    // The corners alternate, half a beat apart, so the row never falls quiet.
    beat,
    phase: corner * 0.5 + rng() * 0.1,
    seed: rng() * Math.PI * 2,
    // The boil's angle swing belongs to the *mark*, not to each wedge: all
    // three swing together, so their leans keep the same order and gaps however
    // hard the hand swings. Swinging each wedge on its own phase let neighbouring
    // wedges pass through each other on their way, which is what collapsed the
    // fan into the one thick band these lanes exist to break up.
    swing: { rate: 1.7 + rng() * 1.5, phase: rng() * Math.PI * 2 },
    rays: BASE_ANGLES_DEG.map((deg, i) => ({
      // ``side`` turns the whole fan out of the group: the right-hand corner's
      // wedges lean right, the left-hand corner's left.
      angle: (side * deg * Math.PI) / 180,
      // How far this wedge swings with the mark's shared swing.
      wobble: SHOUT_WOBBLE_MIN + rng() * (SHOUT_WOBBLE_MAX - SHOUT_WOBBLE_MIN),
      // Only the length boil is each wedge's own.
      phase: rng() * Math.PI * 2,
      // Which lane across the mark this streak rides: negative for the most
      // diagonal wedge, positive for the most upright, so the three are drawn
      // side by side rather than all off the same point.
      lane: (i - 1) * SHOUT_LANE,
      // Each wedge's narrow end starts further out along its own line than the
      // last, so the three are read as three streaks instead of one thick
      // brush stroke that happens to fray.
      offset: 0.05 + i * 0.075 + rng() * 0.03,
      // Long and thin: a metre-ish wedge, a hand's width at its widest (the
      // tip) — so it reads as a streak, not a flag.
      length: 1.0 + rng() * 0.4,
      width: 0.16 + rng() * 0.05,
    })),
  }))
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

// Where a burst is in its own beat at ``time``: whether it is up, how solid, how
// big (``swell``, a multiplier on the whole mark), and the twitch to add to its
// root (``nudge``, in metres along the row and up).
export function markBeat(burst, time) {
  const cycle = (time / burst.beat + burst.phase) % 1
  const frame = Math.floor(time / SHOUT_FRAME)
  const up = Math.min(clamp01(cycle / SHOUT_FADE), clamp01((SHOUT_ON - cycle) / SHOUT_FADE))
  const alpha = clamp01(up)
  // The swell runs across the visible beat: out of the corner in the first
  // third, full size through the middle, away again in the last third. The
  // growth is eased out, so a shout is thrown and then holds rather than
  // inflating at a constant rate, and it is snapped to the step ladder, so the
  // mark jumps a whole size at a time instead of inflating smoothly.
  const progress = clamp01(cycle / SHOUT_ON)
  const held = Math.min(clamp01(progress / SHOUT_GROW), clamp01((1 - progress) / SHOUT_SHRINK))
  const thrown = SHOUT_MIN_SCALE + (1 - SHOUT_MIN_SCALE) * (1 - (1 - held) ** 2)
  const swell = SHOUT_SWELL_STEPS.reduce(
    (best, step) => (Math.abs(step - thrown) < Math.abs(best - thrown) ? step : best),
    SHOUT_MIN_SCALE,
  )
  return {
    cycle,
    visible: alpha > 0.01,
    alpha,
    swell,
    nudge: {
      along: Math.sin(frame * 2.3 + burst.seed) * SHOUT_TWITCH,
      up: Math.sin(frame * 3.1 + burst.seed * 1.7) * SHOUT_TWITCH,
    },
  }
}

// A wedge's pose on the current cartoon frame: its angle about the root and its
// length. Quantised with ``markBeat`` — hold, then jump — and bounded by the
// wedge's own wobble, so no amount of time turns a twitch into a drift. The
// swing itself comes from the burst, so the three wedges lean and twitch as one
// fan and can never cross each other; only the length boil is per wedge.
export function raySwing(burst, ray, time) {
  const frame = Math.floor(time / SHOUT_FRAME)
  const swing = Math.sin(frame * burst.swing.rate + burst.swing.phase)
  return {
    angle: ray.angle + swing * ray.wobble,
    length: ray.length * (0.86 + 0.18 * Math.sin(frame * 1.7 + ray.phase * 2)),
  }
}
