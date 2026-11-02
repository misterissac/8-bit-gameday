import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SHOUT_FRAME,
  SHOUT_LANE,
  SHOUT_MIN_SCALE,
  SHOUT_ON,
  SHOUT_RAYS,
  SHOUT_SWELL_STEPS,
  SHOUT_TWITCH,
  markBeat,
  raySwing,
  shoutBursts,
} from '../src/util/shoutMarks.js'
import { BANNER } from '../src/util/fanSprites.js'

// ---------------------------------------------------------------------------
// The shout marks, as numbers.
//
// The promise they make is all in where they are and how they move, and none of
// it needs a renderer: two marks, one over each top corner of the row, each
// three long thin wedges whose narrow ends rest on the corner and which lean up
// and out of the group on their own side, drawn in separate lanes across the
// mark so there is daylight between them; and motion that is a cartoon boil —
// quantised, bounded, never rising — thrown at a nub and swelling to full size
// in whole steps before it goes.
//
// The row these tests dress is a real one's size: nine metres or so of seats,
// which is what the bleacher clusters span.
// ---------------------------------------------------------------------------

const SPAN = 9
const ROW = 'shout-cf-left'

// What a show row's root is drawn from: the seats' own line. The banner's hands
// stand about 0.85 m above the cushion and the cloth reaches 0.42 m over them,
// so anything below 1.27 m would be inside the banner.
const HANDS_ABOVE_SEATS = 0.85

test('a row shouts from both of its top corners, not from the middle', () => {
  const bursts = shoutBursts(ROW, SPAN)
  assert.equal(bursts.length, 2, 'one mark per corner')
  assert.deepEqual(bursts.map((b) => b.side), [-1, 1], 'one at each end of the row')
  for (const burst of bursts) {
    // Past the last fan at that end: the mark hangs over the corner of the
    // block, not over the middle of the row.
    assert.ok(Math.abs(burst.along) >= SPAN / 2, `${burst.along} should clear the row's half-span`)
    assert.ok(Math.abs(burst.along) < SPAN / 2 + 0.4, 'and not be stranded far off the end')
    assert.equal(Math.sign(burst.along), burst.side)
    // In the air over the row's heads, clear of the raised banner.
    assert.ok(burst.height > HANDS_ABOVE_SEATS + BANNER.height,
      `${burst.height} m should clear the hands (${HANDS_ABOVE_SEATS}) and the cloth (${BANNER.height})`)
    assert.ok(burst.height < 2, 'and stay a corner mark rather than a banner of its own')
    assert.ok(burst.beat > 0.5 && burst.beat < 1.5, 'a shout comes about once a second')
  }
  // The corners alternate on one shared clock: their phases are half a beat
  // apart, so one is up while the other is not — and because the beat is the
  // same number for both, they keep alternating instead of drifting into a
  // moment where the row falls quiet altogether.
  const [left, right] = bursts
  assert.equal(left.beat, right.beat, 'the corners share the row’s clock')
  const apart = Math.abs(((right.phase - left.phase) % 1 + 1) % 1)
  assert.ok(Math.abs(apart - 0.5) < 0.15, `corners should alternate (${apart})`)
})

test('each mark is three long thin wedges, or rather three for a wedge count', () => {
  for (const burst of shoutBursts(ROW, SPAN)) {
    assert.equal(burst.rays.length, SHOUT_RAYS)
    for (const ray of burst.rays) {
      // Long and thin: a metre-ish in length, a hand's width across at its
      // widest — a streak, several times longer than it is wide.
      assert.ok(ray.length > 0.8 && ray.length < 1.5, `${ray.length} m long`)
      assert.ok(ray.width > 0.1 && ray.width < ray.length / 4,
        `${ray.width} m should be thin against ${ray.length} m`)
      assert.ok(ray.offset > 0 && ray.offset < 0.4, 'the narrow end starts out along its own line')
      // Every wedge points up and out: its corner's own side is the way it
      // leans (never back over the row it came from), it stays on the diagonal
      // rather than lying down, and it keeps a clear upward component.
      assert.equal(Math.sign(ray.angle), burst.side, 'outside the corner, never back over the row')
      const deg = (Math.abs(ray.angle) * 180) / Math.PI
      assert.ok(deg > 15 && deg < 55, `${deg}° should point up and out`)
      assert.ok(Math.cos(ray.angle) > 0.5, 'the wedges lean out, they do not lie down')
      // The wobble is an oscillation about that base, never a wander off it.
      assert.ok(ray.wobble > 0 && ray.wobble < Math.PI / 6)
    }
    // The wedges splay: each one further out from the row's centre is more
    // splayed than the last, and its narrow end starts further out too — the
    // pair of rules that keeps three wedges from piling into one another and
    // makes the mark read as one burst rather than one thick stroke.
    const splay = burst.rays.map((ray) => Math.abs(ray.angle))
    assert.ok(splay[0] > splay[1] && splay[1] > splay[2], `${splay} should fan out`)
    const offsets = burst.rays.map((ray) => ray.offset)
    assert.ok(offsets[0] < offsets[1] && offsets[1] < offsets[2], `${offsets} should stagger`)
    // They also ride separate lanes across the mark's own width, a lane apart
    // by more than the widest wedge is across: leaning three wedges off one
    // point still draws them as a single thick band at the plate camera, and
    // the lanes are what put sky between the streaks.
    const lanes = burst.rays.map((ray) => ray.lane)
    assert.ok(lanes[0] < lanes[1] && lanes[1] < lanes[2], `${lanes} should be side by side`)
    assert.ok(lanes[0] < 0 && lanes[2] > 0, 'the diagonal wedge outboard, the upright one inboard')
    const widest = Math.max(...burst.rays.map((ray) => ray.width))
    assert.ok(lanes[2] - lanes[0] > widest, 'the lanes spread wider than one wedge')
    assert.equal(Math.abs(lanes[0]), Math.abs(lanes[2]), 'the mark is centred on its corner')
    assert.ok(SHOUT_LANE > 0.1 && SHOUT_LANE < 0.25, `${SHOUT_LANE} m is a readable lane`)
    // Measured on the drawn wedges, mirrored the way the component draws them:
    // the ends of neighbouring streaks are further apart than their own
    // half-widths, so the three have a gap between them all the way out.
    for (const lean of [1, -1]) {
      const drawn = burst.rays.map((ray) => {
        const a = Math.abs(ray.angle) * lean
        return {
          base: { x: -Math.sin(a) * ray.offset + ray.lane * lean, y: Math.cos(a) * ray.offset },
          dir: { x: -Math.sin(a), y: Math.cos(a) },
          ray,
        }
      })
      for (let i = 1; i < drawn.length; i++) {
        const [a, b] = [drawn[i - 1], drawn[i]]
        const tip = (w) => ({ x: w.base.x + w.dir.x * w.ray.length, y: w.base.y + w.dir.y * w.ray.length })
        const [ta, tb] = [tip(a), tip(b)]
        const halfWidth = (a.ray.width + b.ray.width) / 2
        const atTip = Math.hypot(ta.x - tb.x, ta.y - tb.y) - halfWidth
        const atRoot = Math.hypot(a.base.x - b.base.x, a.base.y - b.base.y) - halfWidth / 3
        assert.ok(atTip > 0.06, `${atTip.toFixed(3)} m of daylight between the tips`)
        assert.ok(atRoot > 0.03, `${atRoot.toFixed(3)} m of daylight between the roots`)
      }
    }
    // Mirrored across the row: the two corners open away from the crowd.
    const mirror = shoutBursts(ROW, SPAN).find((b) => b.side === -burst.side)
    burst.rays.forEach((ray, i) => {
      assert.ok(Math.abs(ray.angle + mirror.rays[i].angle) < 1e-12, 'the corners mirror each other')
      assert.equal(ray.lane, mirror.rays[i].lane, 'and share the same lanes across the mark')
    })
  }
})

test('the layout is drawn from the row, so a mark keeps its wedges', () => {
  const once = shoutBursts(ROW, SPAN)
  const twice = shoutBursts(ROW, SPAN)
  assert.deepEqual(once, twice, 'the same row lays out the same mark')
  assert.notDeepEqual(once, shoutBursts('shout-cf-right', SPAN), 'another row has its own')
  // A longer row puts its marks further apart.
  const wide = shoutBursts(ROW, SPAN * 2)
  assert.ok(Math.abs(wide[0].along) > Math.abs(once[0].along) + 3)
})

test('a burst pops on its beat, and is up for the share it advertises', () => {
  const [burst] = shoutBursts(ROW, SPAN)
  // Sampled finely over four of its beats: up for SHOUT_ON of the time, and the
  // alpha is a real fade only at the two edges.
  let up = 0
  let total = 0
  let peak = 0
  for (let t = 0; t < burst.beat * 4; t += burst.beat / 2000) {
    const beat = markBeat(burst, t)
    total += 1
    if (beat.visible) up += 1
    peak = Math.max(peak, beat.alpha)
    assert.ok(beat.alpha >= 0 && beat.alpha <= 1)
  }
  assert.ok(Math.abs(up / total - SHOUT_ON) < 0.02, `${up / total} should be ${SHOUT_ON}`)
  assert.ok(peak > 0.99, 'a shout reaches full strength')
  // Between beats it is not merely faint: it is gone.
  const off = []
  for (let cycle = SHOUT_ON + 0.02; cycle < 1; cycle += 0.02) {
    off.push(markBeat(burst, (cycle - burst.phase) * burst.beat))
  }
  assert.equal(off.every((beat) => beat.alpha === 0 && !beat.visible), true)
})

test('each shout is thrown in whole steps: four sizes, out and away', () => {
  const [burst] = shoutBursts(ROW, SPAN)
  // ``at`` puts the beat's clock at a given point in its own cycle.
  const at = (cycle) => markBeat(burst, (((cycle - burst.phase) % 1 + 1) % 1) * burst.beat)
  // The ladder itself: a nub, two bigger nubs, full size — nothing between.
  assert.equal(SHOUT_SWELL_STEPS[0], SHOUT_MIN_SCALE)
  assert.equal(SHOUT_SWELL_STEPS.at(-1), 1)
  for (let i = 1; i < SHOUT_SWELL_STEPS.length; i++) {
    assert.ok(SHOUT_SWELL_STEPS[i] > SHOUT_SWELL_STEPS[i - 1], 'the ladder only climbs')
  }
  // A nub on the corner when the shout starts, full size through the middle,
  // a nub again as it goes: the mark swells rather than blinking at one size.
  assert.ok(at(0.004).swell < SHOUT_MIN_SCALE + 0.03)
  assert.equal(at(SHOUT_ON * 0.5).swell, 1)
  assert.ok(at(SHOUT_ON * 0.995).swell < SHOUT_MIN_SCALE + 0.03)
  // Growth is monotone *and* stepped: no sample is smaller than the one before,
  // every size is one of the ladder's own, and the mark passes through several
  // of them on the way out rather than inflating at every frame.
  const grow = []
  for (let u = 0.01; u <= 0.4; u += 0.01) grow.push(at(SHOUT_ON * u).swell)
  for (let i = 1; i < grow.length; i++) assert.ok(grow[i] >= grow[i - 1], `${grow} should grow`)
  assert.ok(new Set(grow).size >= 3, `${grow} should climb through the ladder`)
  assert.deepEqual([0.4, 0.5, 0.6].map((u) => at(SHOUT_ON * u).swell), [1, 1, 1], 'held at full size')
  const shrink = []
  for (let u = 0.62; u < 0.995; u += 0.01) shrink.push(at(SHOUT_ON * u).swell)
  for (let i = 1; i < shrink.length; i++) assert.ok(shrink[i] <= shrink[i - 1], `${shrink} should shrink`)
  assert.ok(new Set(shrink).size >= 3, `${shrink} should climb back down the ladder`)
  // Bounded, never zero, and always exactly one step: the mark is always
  // something on the corner, and it is the beat's alpha that takes it away.
  const sizes = new Set()
  for (let t = 0; t < burst.beat * 4; t += burst.beat / 500) {
    const swell = markBeat(burst, t).swell
    assert.ok(swell >= SHOUT_MIN_SCALE - 1e-12 && swell <= 1 + 1e-12, `${swell} out of bounds`)
    assert.ok(SHOUT_SWELL_STEPS.includes(swell), `${swell} is not one of the steps`)
    sizes.add(swell)
  }
  assert.equal(sizes.size, SHOUT_SWELL_STEPS.length, 'the mark uses the whole ladder')
})

test('the marks boil on a cartoon clock and never climb', () => {
  const [burst] = shoutBursts(ROW, SPAN)
  const ray = burst.rays[0]
  // Held, then jumped: inside one twelve-a-second frame the pose does not move
  // at all — no smooth drift, which is what made the old particles float.
  for (const frame of [1, 20, 76]) {
    // Inside one frame, from just after its start to just before its end.
    const start = frame * SHOUT_FRAME + 1e-6
    const held = raySwing(burst, ray, start)
    const lateInFrame = raySwing(burst, ray, start + SHOUT_FRAME * 0.9)
    assert.equal(held.angle, lateInFrame.angle)
    assert.equal(held.length, lateInFrame.length)
    // ...and the next frame is a different pose.
    assert.notEqual(raySwing(burst, ray, start + SHOUT_FRAME * 1.1).angle, held.angle)
  }
  // The pose does change from frame to frame, and never leaves the wedge's own
  // bounds: the swing is an oscillation, so no elapsed time turns it into a
  // climb or a spin.
  const seen = new Set()
  for (let frame = 0; frame < 600; frame++) {
    const pose = raySwing(burst, ray, frame * SHOUT_FRAME)
    seen.add(pose.angle.toFixed(6))
    assert.ok(Math.abs(pose.angle - ray.angle) <= ray.wobble + 1e-12)
    assert.ok(pose.length > 0.5 * ray.length && pose.length < 1.1 * ray.length)
  }
  assert.ok(seen.size > 20, 'the wedges take many poses')
  // The three wedges swing as one mark, so they never cross: on every cartoon
  // frame their leans keep the same order and a clear gap between neighbours.
  assert.ok(Math.abs(burst.swing.rate) > 1 && burst.swing.rate < 4, 'one swing clock for the mark')
  for (let frame = 0; frame < 600; frame++) {
    const angles = burst.rays.map((r) => raySwing(burst, r, frame * SHOUT_FRAME).angle)
    for (let i = 1; i < angles.length; i++) {
      const gap = Math.abs(angles[i - 1]) - Math.abs(angles[i])
      assert.ok(gap > (7 * Math.PI) / 180, `${(gap * 180 / Math.PI).toFixed(1)}° gap closed`)
    }
  }
  // ...and the mark's root only twitches, bounded in both directions.
  for (let t = 0; t < 12; t += 0.017) {
    const beat = markBeat(burst, t)
    assert.ok(Math.abs(beat.nudge.along) <= SHOUT_TWITCH + 1e-12)
    assert.ok(Math.abs(beat.nudge.up) <= SHOUT_TWITCH + 1e-12)
  }
})
