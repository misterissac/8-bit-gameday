import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Which club each body is wearing, read off the cloth.
//
// One body is dressed by one material, and that material's map is the club's
// atlas (util/playerKit.js): the home atlas paints its team colour red, the
// visitors' blue. So this suite does not compare pictures — it reads the atlas a
// body is actually wearing, counts its pixels by hue, and asks which club's colour
// is on it. That is what a screenshot of a fielder twenty metres away cannot say,
// and it is the whole of the promise the kit makes:
//
//   * every body of the side in the field wears one kit, and the side at bat wears
//     the other (the catcher included — he is the man behind the plate, not a
//     body of the cast's);
//   * the two swap when the half inning turns over.
//
// The hue bands are the two atlases' own: a warm team colour under 30° (the home
// red), and the visitors' 214°. The jersey's own pale blue is left out by its
// saturation, so what is counted is cloth the club painted, not the uniform every
// club shares.
// ---------------------------------------------------------------------------

const TEAM_RED_MAX_HUE = 30
const TEAM_RED_MIN_HUE = 330
const TEAM_BLUE_HUE = 214
const TEAM_BLUE_SLACK = 24
const TEAM_MIN_SATURATION = 0.3

// Every kit material a body of this name is drawn in, reduced to which club's
// colour the atlas behind it carries. Runs in the page: the atlas may be an
// <img> (the home kit as it ships) or a <canvas> (the visitors', recoloured), and
// both can be sampled the same way.
const readKit = ({ name, bands }) => {
  const scene = window.__vr.scene
  const body = scene?.getObjectByName(name)
  if (!body) return { name, kit: 'missing' }
  let map = null
  // The look pass's two hung-beside-the-body pieces (util/batterLook.js): the eyes
  // and the shoe laces are geometry it adds, so a body carrying them is a body put
  // through the same face-and-shoe pass the batter and the pitcher are.
  const look = { brows: false, laces: false }
  body.traverse((child) => {
    if (child.name === 'BrowDetail') look.brows = true
    if (child.name === 'LaceDetail') look.laces = true
    if (map || !child.isMesh) return
    const material = Array.isArray(child.material) ? child.material[0] : child.material
    // The kit is the material the atlas is drawn over the body with — the look
    // pass's detail pieces and the glove's leather keep materials of their own.
    if (material?.vertexColors && material.map?.image) map = material.map
  })
  if (!map) return { name, kit: 'undressed', look }
  const image = map.image
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0)
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  let red = 0
  let blue = 0
  // Every eighth pixel in each direction: the cloth is large flat areas, and four
  // megapixels of arithmetic per body is not what this needs.
  const stride = 8 * 4
  for (let at = 0; at < data.length; at += stride) {
    const r = data[at] / 255
    const g = data[at + 1] / 255
    const b = data[at + 2] / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const chroma = max - min
    if (chroma === 0) continue
    const lightness = (max + min) / 2
    const saturation = chroma / (1 - Math.abs(2 * lightness - 1))
    if (saturation < bands.minSaturation) continue
    let hue
    if (max === r) hue = ((g - b) / chroma + 6) % 6
    else if (max === g) hue = (b - r) / chroma + 2
    else hue = (r - g) / chroma + 4
    hue *= 60
    if (hue < bands.redMax || hue > bands.redMin) red += 1
    else if (Math.abs(hue - bands.blue) < bands.blueSlack) blue += 1
  }
  let kit = 'mixed'
  if (red > blue * 3) kit = 'home'
  else if (blue > red * 3) kit = 'away'
  return { name, kit, red, blue, look }
}

const kitOf = async (page, name) =>
  page.evaluate(readKit, {
    name,
    bands: {
      minSaturation: TEAM_MIN_SATURATION,
      redMax: TEAM_RED_MAX_HUE,
      redMin: TEAM_RED_MIN_HUE,
      blue: TEAM_BLUE_HUE,
      blueSlack: TEAM_BLUE_SLACK,
    },
  })

// A body, the club it is drawn in, and the look pass it has been through — with a
// sentence naming what failed.
const expectKit = async (page, name, kit) => {
  const read = await kitOf(page, name)
  expect(read.kit, `${name} should be dressed in the ${kit} kit (read ${JSON.stringify(read)})`).toBe(kit)
  expect(read.look, `${name} should wear the batter’s own face and shoes (read ${JSON.stringify(read.look)})`)
    .toEqual({ brows: true, laces: true })
}

test.describe('every body wears its club, half inning by half inning', () => {
  test.describe.configure({ timeout: 120000 })

  test('the visitors bat in the top: the home side fields, and the plate is the visitors’', async ({ page }) => {
    await page.goto('/e2e/harness/cast.html?play=fly&half=top')
    await page.waitForFunction(() => window.__vr?.ready === true)
    await page.waitForFunction(() => (window.__vr.probeCast()?.bodies ?? []).length > 0, null, { timeout: 60000 })
    // The shortstop is one of the seven in the field; the batter is the club at bat.
    await expectKit(page, 'cast:defense:SS', 'home')
    await expectKit(page, 'cast:defense:CF', 'home')
    await expectKit(page, 'batter', 'away')
  })

  test('the home side bats in the bottom: the visitors field, and the plate is the home club’s', async ({ page }) => {
    await page.goto('/e2e/harness/cast.html?play=fly&half=bottom')
    await page.waitForFunction(() => window.__vr?.ready === true)
    await page.waitForFunction(() => (window.__vr.probeCast()?.bodies ?? []).length > 0, null, { timeout: 60000 })
    await expectKit(page, 'cast:defense:SS', 'away')
    await expectKit(page, 'cast:defense:CF', 'away')
    await expectKit(page, 'batter', 'home')
  })

  for (const kit of ['home', 'away']) {
    test(`the catcher wears the fielding side’s kit — ${kit}`, async ({ page }) => {
      await page.goto(`/e2e/harness/catcher.html?kit=${kit}&field=0`)
      await page.waitForFunction(() => window.__vr?.ready === true)
      await page.waitForTimeout(2500)
      await page.waitForFunction(() => !!window.__vr.probe?.()?.catcher, null, { timeout: 60000 })
      await expectKit(page, 'catcher', kit)
      // ...and the man in the box beside him is in the other club's colours: the
      // catcher is the fielding side, never the batter's.
      await expectKit(page, 'batter', kit === 'home' ? 'away' : 'home')
    })
  }
})
