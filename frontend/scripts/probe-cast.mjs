// Throwaway: the cast through a real play — the fielder on his spot, the
// sprint, the ball in his hand, the runners on their way, and then the reset
// that puts every body back before the next cycle replays it.
//
// The clock is the whole problem on a loaded machine: a software-rendered frame
// can take seconds of wall time, and the shared clock advances by that delta, so
// a play is stepped clean over between two frames. The probe therefore runs the
// simulation very slowly (0.05 — the slider's own floor) so every rendered frame
// is a ~0.15 s slice of the play, and waits long enough for the frames to come.
//
//   node scripts/probe-cast.mjs [double|single|fly] [timeScale] [seconds]
import { argv } from 'node:process'

const BASE = 'http://127.0.0.1:5179'
const PLAY = argv[2] ?? 'double'
const SCALE = Number(argv[3] ?? 0.05)
const SECONDS = Number(argv[4] ?? 150)

const browser = await (await import('@playwright/test')).chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 420, height: 320 } })
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
await page.goto(`${BASE}/e2e/harness/cast.html?play=${PLAY}&t=${Date.now()}`)
await page.waitForFunction(() => window.__vr?.ready === true, null, { timeout: 120000 })
const meta = await page.evaluate(() => ({ spots: window.__vr.spots, bases: window.__vr.bases, hit: window.__vr.hit }))
// Wind the shared clock up to just before the pitch reaches the plate, so the
// play is what this run is looking at rather than the windup before it.
await page.evaluate((s) => { window.__vr.setTimeScale(s); window.__vr.wind(0.3) }, SCALE)

const FIELD_1B = meta.bases['offense:1B']
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const samples = []
const started = Date.now()
let lastFrames = -1
while (Date.now() - started < SECONDS * 1000) {
  const sample = await page.evaluate(() => ({ ...window.__vr.probeCast(), stats: window.__vr.stats() }))
  if (!sample) continue
  // One sample per rendered frame: two samples of the same frame say nothing.
  if (sample.stats.frames === lastFrames) {
    await page.waitForTimeout(60)
    continue
  }
  lastFrames = sample.stats.frames
  samples.push({ wall: (Date.now() - started) / 1000, ...sample })
}
const frames = samples[samples.length - 1]?.stats.frames ?? 0
console.log('# clock', JSON.stringify(samples[samples.length - 1]?.stats), 'frames rendered', frames, 'in', ((samples[samples.length - 1]?.wall ?? 0)).toFixed(1), 's')

const place = (s) => s.bodies.map((b) => `${b.name.replace('cast:', '').split(':').reverse().join('|')}${b.visible ? '' : '#'}@${b.x},${b.z}`).join(' ')
if (samples.length === 0) {
  console.log('no samples — the harness never rendered a cast')
  await browser.close()
  throw new Error('no samples')
}
console.log('hit', meta.hit)
console.log('# initial (first sample — before the ball is hit)')
console.log(place(samples[0]))
console.log('# samples')
const bf = (s) => (s.batter ? `batter@${s.batter.x},${s.batter.z} bat=${s.batter.batVisible ? 'in-hand' : 'DROPPED'} hand=${s.batter.hand ? `${s.batter.hand.x},${s.batter.hand.y.toFixed(2)},${s.batter.hand.z}` : 'none'}` : 'batter=none')
const atHome = (b) => Math.hypot(b.x - meta.bases['offense:home'].x, b.z - meta.bases['offense:home'].z)
for (const s of samples) {
  const plate = s.batter ? `${atHome(s.batter).toFixed(2)}m` : 'none'
  const handOff = s.ball && s.hand ? Math.hypot(s.ball.x - s.hand.x, s.ball.y - s.hand.y, s.ball.z - s.hand.z) : null
  console.log(`t=${s.wall.toFixed(1)}s frame=${s.stats.frames} sim=${s.stats.simTime} play=${s.playClock == null ? 'none' : s.playClock.toFixed(2)} batter-from-plate=${plate} cast-at-plate=${s.castAtPlate ? s.castAtPlate.length : '-'}[${(s.castAtPlate ?? []).join(' ')}] ball=${s.ball ? `${s.ball.x},${s.ball.y.toFixed(2)},${s.ball.z}` : 'none'} hand=${s.hand ? `${s.hand.x},${s.hand.y.toFixed(2)},${s.hand.z}${handOff == null ? '' : ` off=${handOff.toFixed(3)}`}` : 'no'}`)
  console.log('   ', place(s))
  console.log('   ', bf(s))
}

// ── What the probe is for ────────────────────────────────────────────────
const spots = meta.spots
const bodies = (s, name) => s.bodies.find((b) => b.name === `cast:${name}`)
const summary = { players: Object.keys(spots).length + Object.keys(meta.bases).length }
summary.everOffSpot = {}
for (const key of Object.keys(spots)) {
  const moved = samples.filter((s) => bodies(s, key)?.visible).map((s) => dist(bodies(s, key), spots[key])).sort((a, b) => b - a)
  summary.everOffSpot[key] = { max: Number((moved[0] ?? 0).toFixed(2)), first: Number((moved[0] ?? 0).toFixed(2)) }
}
summary.offenseSeen = {}
for (const key of Object.keys(meta.bases)) {
  const seen = samples.filter((s) => bodies(s, key)?.visible)
  if (seen.length === 0) continue
  const from = bodies(seen[0], key)
  const away = Math.max(...seen.map((s) => dist(bodies(s, key), meta.bases[key])))
  summary.offenseSeen[key] = {
    fromBase: Number(dist(from, meta.bases[key]).toFixed(2)),
    maxAway: Number(away.toFixed(2)),
  }
}
// The ball in a fielder's hand: where it was, and whether it tracked the hand
// it was supposed to be riding (the whole reason the cast publishes one).
const carried = samples.filter((s) => s.hand)
summary.carried = carried.length
summary.carriedOffHand = carried.filter((s) => s.ball && Math.hypot(s.ball.x - s.hand.x, s.ball.z - s.hand.z) > 0.02).length
summary.carriedBallY = carried.filter((s) => s.ball).map((s) => s.ball.y)
summary.carriedWorst = carried.filter((s) => s.ball)
  .map((s) => ({ frame: s.stats.frames, off: Number(Math.hypot(s.ball.x - s.hand.x, s.ball.y - s.hand.y, s.ball.z - s.hand.z).toFixed(3)) }))
  .sort((a, b) => b.off - a.off).slice(0, 4)
summary.handMoved = carried.length > 1
  ? Number(Math.max(...carried.map((s) => Math.hypot(s.hand.x - carried[0].hand.x, s.hand.z - carried[0].hand.z))).toFixed(2))
  : 0
// The reset, seen from outside: samples where every fielder is on his own spot
// and nobody is holding the ball — what the cycle between plays must look like.
const aligned = (s) => Object.keys(spots).every((key) => {
  const b = bodies(s, key)
  return b?.visible && dist(b, spots[key]) < 0.2
})
summary.alignedSamples = samples.filter((s) => aligned(s) && !s.hand).length
summary.movingSamples = samples.filter((s) => !aligned(s)).length
// ── The batter's own body: one body at the plate, and then the runner ──────
// The point of the whole handoff: the body at the plate is the batter's own,
// and no cast body ever stands there with him. Whoever is there, drives away.
// Where he stood in the box: the first sample that has his own body at all and
// his bat in his hands (the model loads after the harness reports ready, and the
// bat is only in his hands on the plate side of the takeoff).
const boxSample = samples.find((s) => s.batter && s.batter.batVisible)
const box = boxSample ? { x: boxSample.batter.x, z: boxSample.batter.z } : null
summary.batterBox = box
summary.castBodiesOnPlate = [...new Set(samples.flatMap((s) => s.castAtPlate ?? []))]
summary.bodiesAtPlate = summary.castBodiesOnPlate.length
  ? 'a cast body stood at the plate'
  : 'the batter is the only body at the plate'
summary.samplesWithBatterAtPlate = samples.filter((s) => s.batter && atHome(s.batter) <= 1.6).length
// Only the samples that have his own body at all: the model loads a few frames
// after the harness reports itself ready, so the first samples have no batter.
const withBatter = samples.filter((s) => s.batter)
const lastBatter = withBatter[withBatter.length - 1]?.batter ?? null
if (box && lastBatter) {
  const offBox = withBatter.map((s) => Math.hypot(s.batter.x - box.x, s.batter.z - box.z))
  summary.batterLeftBox = Number(Math.max(...offBox).toFixed(2))
  summary.batterAtFirst = {
    x: FIELD_1B.x,
    z: FIELD_1B.z,
    last: Number(Math.hypot(lastBatter.x - FIELD_1B.x, lastBatter.z - FIELD_1B.z).toFixed(2)),
    closest: Number(Math.min(...withBatter.map((s) => Math.hypot(s.batter.x - FIELD_1B.x, s.batter.z - FIELD_1B.z))).toFixed(2)),
  }
  summary.batterBackInBox = Number(Math.hypot(lastBatter.x - box.x, lastBatter.z - box.z).toFixed(2))
}
// The bat goes with the batter, not with the pitch: it is in his hands while he
// is in the box and gone the moment he runs (he is not carrying it down the line).
const running = box ? withBatter.filter((s) => Math.hypot(s.batter.x - box.x, s.batter.z - box.z) > 0.5) : []
summary.batDroppedWhileRunning = running.filter((s) => s.batter.batVisible === false).length
summary.batHeldWhileRunning = running.filter((s) => s.batter.batVisible === true).length
// The bat left on the dirt (Batter.jsx's dropBat): the frame it appears on, where
// it lies, how flat, and whether the reset clears it away again.
const drops = withBatter.map((s) => s.batter.dropped).filter(Boolean)
const seen = drops.filter((d) => d.visible)
summary.droppedBat = {
  appearedAt: seen.length ? seen[0] : null,
  samplesVisible: seen.length,
  samplesHidden: drops.length - seen.length,
  bothDrawn: drops.filter((d) => d.bothDrawn).length,
  ground: seen.length ? [Math.min(...seen.map((d) => d.ground)), Math.max(...seen.map((d) => d.ground))] : null,
  span: seen.length ? [Math.min(...seen.map((d) => d.span)), Math.max(...seen.map((d) => d.span))] : null,
  barrelTilt: seen.length ? Math.max(...seen.map((d) => Math.abs(d.barrel.y))) : null,
  // Whether it stayed put while he ran: the greatest distance between where it was
  // first left and where it is in any later sample.
  moved: seen.length > 1
    ? Number(Math.max(...seen.map((d) => Math.hypot(d.x - seen[0].x, d.z - seen[0].z))).toFixed(3))
    : 0,
  visibleAfterReset: (() => {
    const lastDrop = withBatter[withBatter.length - 1]?.batter?.dropped
    return lastDrop ? lastDrop.visible : null
  })(),
  last: seen[seen.length - 1] ?? null,
}
// A pose being played, not a body slid along the ground: the hand travels
// between samples that the schedule itself barely moves.
const handXs = withBatter.filter((s) => s.batter.hand).map((s) => s.batter.hand)
summary.handTravel = handXs.length > 1
  ? Number(Math.max(...handXs.map((h) => Math.hypot(h.x - handXs[0].x, h.y - handXs[0].y, h.z - handXs[0].z))).toFixed(2))
  : 0
summary.handHeights = [...new Set(handXs.map((h) => h.y.toFixed(2)))].length
summary.last = samples[samples.length - 1]
summary.backOnSpot = Object.fromEntries(Object.keys(spots).map((key) => {
  const s = summary.last
  const b = bodies(s, key)
  return [key, b?.visible ? Number(dist(b, spots[key]).toFixed(2)) : 'absent']
}))
console.log('# summary', JSON.stringify(summary, null, 1))

// ── The per-frame log: the frames a sample can miss ─────────────────────────
// The probe samples one per rendered frame, but a handoff that comes undone
// happens *between* two of them: the frame log (written last in the frame, so
// what it records is what the batter reads on the next frame) shows the clock,
// the published run and the batter's own group, frame by frame. Any step of the
// batter's own position bigger than a stride is printed with its neighbours.
const rows = await page.evaluate(() => window.__vr.probeLog())
console.log('# frames (every rendered frame: the play\'s clock, the run published, the batter\'s own group; `>` marks a step over 0.6 m in one frame)')
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  const prev = rows[i - 1]
  const step = prev && prev.x != null && r.x != null ? Math.abs(r.x - prev.x) + Math.abs(r.z - prev.z) : 0
  console.log(`  ${step > 0.6 ? '>' : ' '} f=${r.f} sim=${r.sim} play=${r.play == null ? 'none' : r.play.toFixed(2)} run=${r.run ?? 'none'} x=${r.x} z=${r.z} bat=${r.bat ? 'in-hand' : 'DROPPED'} drop=${r.drop == null ? 'none' : r.drop ? `on-dirt@${r.dropX},${r.dropZ}` : 'hidden'}`)
}
console.log('# frame log rows', rows.length, 'of', rows[rows.length - 1]?.f)
await browser.close()
