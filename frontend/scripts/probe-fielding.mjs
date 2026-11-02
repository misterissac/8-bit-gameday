// Throwaway: two things the cast harness can answer that the unit suite cannot.
//
//   1. the *pitcher's* half of a play. He is not a body of the cast's (see
//      util/playCast.js): Pitcher.jsx draws him, and hands him the plan's own
//      schedule when the play is his to field. The harness mounts the real
//      <Pitcher> beside the cast, so `?play=comeback` — a ball hit back at the
//      mound — is played by the body that stands there, and this probe watches it:
//      off the mound, at the ball, the ball in his hand, the throw, and the reset.
//
//   2. the fade. Every body is drawn at its own distance from the camera
//      (util/playerKit.js's playerFadeOpacity), which is what makes the
//      fielder-cam replay watchable: the camera sits at the chasing fielder's own
//      head, so *his* body is the one that goes and the rest of the field is drawn
//      whole. The probe stands the camera inside each body in turn and reads what
//      every body is drawn at.
//
//   node scripts/probe-fielding.mjs [play] [timeScale] [seconds]
import { argv } from 'node:process'

const BASE = 'http://127.0.0.1:5179'
const PLAY = argv[2] ?? 'comeback'
const SCALE = Number(argv[3] ?? 0.05)
const SECONDS = Number(argv[4] ?? 150)

const browser = await (await import('@playwright/test')).chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 420, height: 320 } })
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
await page.goto(`${BASE}/e2e/harness/cast.html?play=${PLAY}&t=${Date.now()}`)
await page.waitForFunction(() => window.__vr?.ready === true, null, { timeout: 120000 })
const meta = await page.evaluate(() => ({ spots: window.__vr.spots, pitcher: window.__vr.pitcherSpot, hit: window.__vr.hit }))
await page.evaluate((s) => { window.__vr.setTimeScale(s); window.__vr.wind(0.3) }, SCALE)

const samples = []
const started = Date.now()
let lastFrames = -1
while (Date.now() - started < SECONDS * 1000) {
  const sample = await page.evaluate(() => ({ ...window.__vr.probeCast(), stats: window.__vr.stats() }))
  if (!sample) continue
  if (sample.stats.frames === lastFrames) {
    await page.waitForTimeout(60)
    continue
  }
  lastFrames = sample.stats.frames
  samples.push({ wall: (Date.now() - started) / 1000, ...sample })
  // Stand the camera at the pitcher's own head while the play has him: the fade is
  // read on the *next* sample, because it is written on the frame after the camera
  // moves (see util/playerKit.js's playerFadeOpacity). His own spot is close to the
  // mound, so the camera is pulled off it again when he is back in his delivery —
  // which is how the two answers are told apart: 0 while the play has him, 1 while
  // it does not (a delivery is drawn whole, whoever the camera is standing in).
  if (sample.pitcher?.field) {
    await page.evaluate(([x, y, z]) => window.__vr.setCamera(x, y, z), [sample.pitcher.x, sample.pitcher.y + 1.8, sample.pitcher.z])
  } else if (sample.pitcher) {
    await page.evaluate(([x, y, z]) => window.__vr.setCamera(x, y, z), [sample.pitcher.x + 20, 12, sample.pitcher.z + 20])
  }
}
if (samples.length === 0) {
  console.log('no samples — the harness never rendered')
  await browser.close()
  throw new Error('no samples')
}
const last = samples[samples.length - 1]
console.log('# hit', meta.hit, '| clock', JSON.stringify(last.stats), '| frames', last.stats.frames, 'in', last.wall.toFixed(1), 's')

// ── The pitcher's own half of the play ──────────────────────────────────────
const off = (s) => s.pitcher?.offMound ?? null
const handOff = (s) => (s.ball && s.hand ? Number(Math.hypot(s.ball.x - s.hand.x, s.ball.y - s.hand.y, s.ball.z - s.hand.z).toFixed(3)) : null)
console.log('# samples')
for (const s of samples) {
  const p = s.pitcher
  console.log(`t=${s.wall.toFixed(1)} play=${s.playClock == null ? 'none' : s.playClock.toFixed(2)} pitcher=${p ? `${p.x},${p.y.toFixed(2)},${p.z}${p.visible ? '' : '#'} off-mound=${p.offMound}${p.field ? ` state=${p.field.state}${p.field.hasBall ? ' HAS-BALL' : ''}` : ' (delivery)'}` : 'none'} ball=${s.ball ? `${s.ball.x},${s.ball.y.toFixed(2)},${s.ball.z}` : 'none'} hand=${s.hand ? `off=${handOff(s)}` : 'no'}`)
}
const withPitcher = samples.filter((s) => s.pitcher)
const fielding = withPitcher.filter((s) => s.pitcher.field)
const summary = {
  samples: samples.length,
  pitcherSeen: withPitcher.length,
  fieldingSamples: fielding.length,
  fieldingStates: [...new Set(fielding.map((s) => s.pitcher.field.state))],
  leftTheMound: Number(Math.max(...withPitcher.map(off)).toFixed(2)),
  farthest: fielding.length ? fielding.map((s) => ({ off: off(s), state: s.pitcher.field.state })).sort((a, b) => b.off - a.off)[0] : null,
  // The ball in *his* hand: the frames the plan has him holding it, and how far the
  // drawn ball is from the hand it is supposed to be riding.
  hasBallSamples: withPitcher.filter((s) => s.pitcher.field?.hasBall).length,
  // The camera is stood at his own head through the play (see the loop): the body it
  // is inside is the one that must go, and only while the play has him.
  fadeWhileFielding: [...new Set(fielding.map((s) => s.pitcher.opacity.join('/')))],
  fadeInHisDelivery: [...new Set(withPitcher.filter((s) => !s.pitcher.field).map((s) => s.pitcher.opacity.join('/')))],
  carriedSamples: withPitcher.filter((s) => s.hand).length,
  carriedWorstOff: (() => {
    const offs = withPitcher.filter((s) => s.hand && s.ball).map((s) => handOff(s))
    return offs.length ? Number(Math.max(...offs).toFixed(3)) : null
  })(),
  // ...and the hand it rode was his, not another body's: a hand published while he
  // does *not* have the ball would be the cast's (or a leftover).
  handWhileNotHis: withPitcher.filter((s) => s.hand && s.pitcher.field && !s.pitcher.field.hasBall).length,
  backOnTheMound: off(last),
  lastPitcher: last.pitcher,
}
console.log('# summary', JSON.stringify(summary, null, 1))

// ── The fade: each body drawn at its own distance from the camera ───────────
// The harness's own spot table, keyed by the body's name (`cast:defense:SS`).
const spots = Object.fromEntries(Object.entries(meta.spots).map(([k, v]) => [`cast:${k}`, v]))
const nearest = Object.keys(spots)[0]
const probeCamera = async (x, y, z) => {
  await page.evaluate(([px, py, pz]) => window.__vr.setCamera(px, py, pz), [x, y, z])
  // Two frames: the fade is written on the frame the new camera is read on, and the
  // second is what a read-back can trust.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return page.evaluate(() => window.__vr.opacities())
}
const insideSpot = spots[nearest]
// The fielder cam's own view: the fielder's head, a head height over his feet.
const insideFade = await probeCamera(insideSpot.x, 1.8, insideSpot.z)
console.log('# camera inside', nearest, 'at', JSON.stringify(insideSpot), 'head height ->', JSON.stringify(insideFade))
// ...and far away, which is every other view of the field.
const far = await probeCamera(insideSpot.x + 40, 20, insideSpot.z + 40)
console.log('# camera ~56 m away ->', JSON.stringify(far))
// ...and through the band itself, where the fade is a share rather than a switch:
// 3.25 m from his feet is the midpoint of a 2 m to 4.5 m band.
const ramp = await probeCamera(insideSpot.x + 3.25, 0, insideSpot.z)
console.log('# camera 3.25 m away ->', JSON.stringify(ramp))
// ...and just outside the band, where the fade should be done.
const nearMiss = await probeCamera(insideSpot.x + 6, 1.8, insideSpot.z + 6)
console.log('# camera ~8.5 m away ->', JSON.stringify(nearMiss))
const flat = (o, skip) => [...new Set(Object.entries(o).filter(([k]) => k !== skip).map(([, v]) => v.join('/')))]
const fade = {
  inside: insideFade[nearest],
  othersInside: flat(insideFade, nearest),
  far: far[nearest],
  farOthers: flat(far, nearest),
  rampAt3_25m: ramp[nearest],
  nearMiss: nearMiss[nearest],
}
console.log('# fade', JSON.stringify(fade))
await browser.close()
