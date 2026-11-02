// Throwaway: the catcher through a live page — the body, the clip he is playing,
// the crouch it puts him in, which way he faces, the kit he is wearing, and the
// fade a camera behind the strike zone gets.
//
//   node scripts/probe-catcher.mjs [kit] [seconds]
import { argv } from 'node:process'

const BASE = 'http://127.0.0.1:5179'
const KIT = argv[2] ?? 'home'
const SECONDS = Number(argv[3] ?? 20)

const browser = await (await import('@playwright/test')).chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
await page.goto(`${BASE}/e2e/harness/catcher.html?kit=${KIT}&field=0&t=${Date.now()}`)
await page.waitForFunction(() => window.__vr?.ready === true, null, { timeout: 120000 })
const read = () => page.evaluate(() => window.__vr.probe())

// Let the clip run a moment, then read the body, the meshes and the kit.
await page.waitForTimeout(1200)
const start = Date.now()
let sample = await read()
while (sample.catcher === null && Date.now() - start < SECONDS * 1000) {
  await page.waitForTimeout(400)
  sample = await read()
}
if (!sample.catcher) {
  console.log('no catcher in the scene — the body never appeared')
  await browser.close()
  throw new Error('no catcher')
}

const c = sample.catcher
const facing = (body) => (body.toeL && body.heelL ? Number((body.toeL.z - body.heelL.z).toFixed(4)) : null)
console.log('# catcher')
console.log('  spot', JSON.stringify(sample.catcherSpot), 'at', JSON.stringify(c.position), 'yaw', c.yaw, 'visible', c.visible)
console.log('  head y', c.head?.y, 'neck y', c.neck?.y, 'spine y', c.spine?.y)
console.log('  posed box', JSON.stringify(c.box))
console.log('  toeL', JSON.stringify(c.toeL), 'heelL', JSON.stringify(c.heelL), 'footL', JSON.stringify(c.footL))
console.log('  facing (toe.z - heel.z, negative = facing the pitcher at -Z):', facing(c))
console.log('  kit', sample.kit, '| meshes', JSON.stringify(Object.fromEntries(Object.entries(c.meshes).map(([k, v]) => [k, v ? `${v.visible ? '' : 'HIDDEN '}${v.map ?? v.material}` : 'none']))))
console.log('  materials', JSON.stringify(c.materials))
console.log('# reference body (the batter, whose facing the app’s own baselines pin)')
console.log('  toeL', JSON.stringify(sample.batter.toeL), 'heelL', JSON.stringify(sample.batter.heelL), 'facing', facing(sample.batter))
console.log('  box', JSON.stringify(sample.batter.box), 'bat in hand', sample.batInHand)

// The clip is playing if the head bone moves: a frozen mixer holds one height.
const heads = await page.evaluate(() => window.__vr.samples())
const moved = Math.max(...heads) - Math.min(...heads)
console.log('# clip', JSON.stringify(heads.slice(0, 8)), 'head range', moved.toFixed(4))

// The fade: a camera brought up behind the plate. The ramp is the reference's own
// clamp((distance - 3) / 8, 0, 1) on the distance to the catcher's own group.
console.log('# fade')
for (const back of [0.5, 1.2, 3, 5, 7.2, 10]) {
  await page.evaluate((d) => window.__vr.setCamera(0, 1.5, 1.83 + d), back)
  await page.waitForTimeout(350)
  const shot = await read()
  const cam = shot.camera
  const distance = Math.hypot(cam.x - shot.catcherSpot.x, cam.y - 0, cam.z - shot.catcherSpot.z)
  const expected = Math.max(0, Math.min(1, (distance - 3) / 8))
  const opacities = shot.catcher.materials.opacity
  const ok = opacities.every((o) => Math.abs(o - expected) < 1e-3)
  console.log(`  back=${back} cameraZ=${cam.z} distance=${distance.toFixed(3)} expected=${expected.toFixed(3)} read=${JSON.stringify(opacities)} ${ok ? 'ok' : 'MISMATCH'}`)
}
// ...and a view of him from the front, for the eye.
await page.evaluate(() => window.__vr.setCamera(0, 1.6, -2.2))
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/catcher-front.png' })
await page.evaluate(() => { window.__vr.setCamera(3.2, 1.9, 3.4); window.__vr.lookAt(0, 0.9, 1.6) })
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/catcher-side.png' })
console.log('# screenshots /tmp/catcher-front.png /tmp/catcher-side.png')
await browser.close()
