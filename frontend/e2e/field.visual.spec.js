import { test, expect } from '@playwright/test'
import { PLATE_FRONT_Y } from '../src/util/MathUtil.js'

// ---------------------------------------------------------------------------
// The field's own plan, read back as numbers.
//
// Renders the real <Ballpark> from the app under a straight-down camera
// (frontend/e2e/harness/field.html) and reads the plate area off the scene's own
// meshes: the plate's shape and where it stands, the two batters' boxes, and the
// catcher's box chalked between them. The rulebook's numbers are written out here
// in inches rather than imported from the constants, so this suite checks the
// drawing against the rule instead of against itself; the one constant it shares
// with the app is PLATE_FRONT_Y, which is where the ball's own world says the
// plate is (the pitch crosses the plate's point there).
//
// The plan is also the only place the *layout* is legible: three boxes drawn on
// the ground can each be the right size and still be drawn through one another,
// and a plate can be drawn backwards (17 inches with two corners cut reads the
// same either way round) or under a second, dark one.
// ---------------------------------------------------------------------------

const IN = 0.0254 // a metre, per inch
const inches = (metres) => metres / IN

// Official Baseball Rules 1.04 and its diagram, plus the standard layout for
// adult baseball's boxes:
const PLATE_ACROSS_IN = 17 // the back edge
const PLATE_DEEP_IN = 17 // the back edge to the point
const PLATE_SIDE_IN = 8.5 // each of the plate's two sides, off the midline
const BOX_WIDTH_IN = 48 // 4 ft
const BOX_DEPTH_IN = 72 // 6 ft
const BOX_INNER_OFF_PLATE_IN = 6 // the inner line, off the plate's own side
const BOX_INNER_IN = PLATE_SIDE_IN + BOX_INNER_OFF_PLATE_IN // 14.5 in
const BOX_OUTER_IN = BOX_INNER_IN + BOX_WIDTH_IN // 62.5 in
const BOX_FRONT_Z_IN = -(PLATE_SIDE_IN + BOX_DEPTH_IN / 2) // 44.5 in in front
const BOX_BACK_Z_IN = BOX_DEPTH_IN / 2 - PLATE_SIDE_IN // 27.5 in behind
const CATCHER_WIDTH_IN = 43
const CATCHER_DEPTH_IN = 96 // 8 ft, measured from the plate's apex
const CATCHER_FRONT_INSET_IN = 7 // ...in from each batter's box's back inside corner
const CATCHER_FRONT_IN = BOX_INNER_IN - CATCHER_FRONT_INSET_IN // 7.5 in, half width

/** The chalk line's own boundary, which is where the strip is centred. */
const lineZIn = (probe, name) => inches((probe.lines[name].z[0] + probe.lines[name].z[1]) / 2)
const lineXIn = (probe, name) => inches((probe.lines[name].x[0] + probe.lines[name].x[1]) / 2)
const lineWidthIn = (probe, name) => inches(probe.lines[name].z[1] - probe.lines[name].z[0])

const openField = async (page) => {
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(String(error)))

  await page.goto('/e2e/harness/field.html?x=0&z=-0.2&span=6')
  await page.waitForFunction(() => window.__vr?.ready === true)
  await page.evaluate(
    () => new Promise((resolve) => {
      let remaining = 4
      const tick = () => (remaining-- > 0 ? requestAnimationFrame(tick) : resolve())
      requestAnimationFrame(tick)
    }),
  )
  return problems
}

test.describe('the plate area', () => {
  test('the plate is the rulebook pentagon, on the plate the ball crosses', async ({ page }) => {
    const problems = await openField(page)
    const probe = await page.evaluate(() => window.__vr.probeField())

    // The slab: 17 in across the back edge, 17 in deep.
    expect(probe.plate.acrossIn).toBeCloseTo(PLATE_ACROSS_IN, 1)
    expect(probe.plate.deepIn).toBeCloseTo(PLATE_DEEP_IN, 1)

    // Its point is on the plate the pitch crosses (the ball's own world puts that
    // PLATE_FRONT_Y from the back edge, which is the foot of the baselines), and
    // the point faces the pitcher — the end the ball comes from is a single
    // vertex, and the far end is the full 17 in across.
    expect(inches(probe.plate.z[0])).toBeCloseTo(-PLATE_FRONT_Y / IN, 1)
    expect(inches(probe.plate.z[1])).toBeCloseTo(0, 1)
    expect(Math.abs(probe.plate.frontX[0])).toBeLessThan(1e-6)
    expect(Math.abs(probe.plate.frontX[1])).toBeLessThan(1e-6)
    expect(inches(probe.plate.backX[1] - probe.plate.backX[0])).toBeCloseTo(PLATE_ACROSS_IN, 1)
    expect(probe.plate.backX[0]).toBeCloseTo(-PLATE_ACROSS_IN / 2 * IN, 3)

    // One white slab and nothing else: a dark plate drawn under the white one
    // reads as a second, black home plate.
    expect(probe.plates).toEqual(['homePlate'])

    expect(problems).toEqual([])
  })

  test('each batter box is 4 ft by 6 ft, its inner line 6 in off the plate', async ({ page }) => {
    await openField(page)
    const probe = await page.evaluate(() => window.__vr.probeField())

    for (const [box, sign] of [['batterBox-3B', -1], ['batterBox-1B', 1]]) {
      // The box's two side lines — the strips are named for the world side they
      // are chalked on, so the pair is read by distance off the midline. The inner
      // one stands 6 in clear of the plate's own side, the outer one a box's 4 ft
      // further out, and both on the box's own side of the plate.
      const strips = [lineXIn(probe, `${box}-3B`), lineXIn(probe, `${box}-1B`)]
      const inner = strips.reduce((a, b) => (Math.abs(a) < Math.abs(b) ? a : b))
      const outer = strips.reduce((a, b) => (Math.abs(a) >= Math.abs(b) ? a : b))
      expect(sign * inner).toBeGreaterThan(0)
      expect(sign * outer).toBeGreaterThan(0)
      expect(Math.abs(inner)).toBeCloseTo(BOX_INNER_IN, 1)
      expect(Math.abs(outer)).toBeCloseTo(BOX_OUTER_IN, 1)
      expect(Math.abs(outer - inner)).toBeCloseTo(BOX_WIDTH_IN, 1)
      expect(Math.abs(inner) - PLATE_SIDE_IN).toBeCloseTo(BOX_INNER_OFF_PLATE_IN, 1)

      // ...and the two ends: 6 ft along, centred on the plate's own depth.
      const front = lineZIn(probe, `${box}-front`)
      const back = lineZIn(probe, `${box}-back`)
      expect(front).toBeCloseTo(BOX_FRONT_Z_IN, 1)
      expect(back).toBeCloseTo(BOX_BACK_Z_IN, 1)
      expect(back - front).toBeCloseTo(BOX_DEPTH_IN, 1)
      expect((front + back) / 2).toBeCloseTo(-PLATE_SIDE_IN, 1)
    }
  })

  test('the catcher box is chalked between the batters boxes, 43 in by 8 ft', async ({ page }) => {
    await openField(page)
    const probe = await page.evaluate(() => window.__vr.probeField())

    // Its front line runs across the gap the two batters' boxes leave at their own
    // back line, stopping 7 in short of each of their back inside corners.
    const front = lineZIn(probe, 'catcherBox-front')
    const frontHalf = inches(probe.lines['catcherBox-front'].x[1] - probe.lines['catcherBox-front'].x[0]) / 2
    expect(front).toBeCloseTo(BOX_BACK_Z_IN, 1)
    expect(frontHalf).toBeCloseTo(CATCHER_FRONT_IN, 1)
    expect(CATCHER_FRONT_IN + CATCHER_FRONT_INSET_IN).toBeCloseTo(BOX_INNER_IN, 1)

    // Its back line: the rule's own 43 in, 8 ft behind the plate's apex.
    const back = lineZIn(probe, 'catcherBox-back')
    const backHalf = inches(probe.lines['catcherBox-back'].x[1] - probe.lines['catcherBox-back'].x[0]) / 2
    expect(backHalf).toBeCloseTo(CATCHER_WIDTH_IN / 2, 1)
    expect(back - inches(probe.plate.z[0])).toBeCloseTo(CATCHER_DEPTH_IN, 1)

    // Its sides: straight chalk flaring from the front line's ends out to the back
    // line's, which is what makes the box a trapezoid and not a rectangle. Each
    // side's chalk is a strip, so its corners sit either side of the line by half
    // the chalk's own width.
    for (const side of ['catcherBox-3B', 'catcherBox-1B']) {
      const corners = probe.lines[side].corners.map(([x, z]) => [inches(x), inches(z)])
      const nearEnd = corners.filter(([, z]) => z < (front + back) / 2)
      const farEnd = corners.filter(([, z]) => z >= (front + back) / 2)
      expect(nearEnd).toHaveLength(2)
      expect(farEnd).toHaveLength(2)
      for (const [x, z] of nearEnd) {
        expect(Math.abs(Math.abs(x) - CATCHER_FRONT_IN)).toBeLessThan(lineWidthIn(probe, 'catcherBox-front'))
        expect(z).toBeCloseTo(front, 0)
      }
      for (const [x, z] of farEnd) {
        expect(Math.abs(Math.abs(x) - backHalf)).toBeLessThan(lineWidthIn(probe, 'catcherBox-front'))
        expect(z).toBeCloseTo(back, 0)
      }
    }

    // And the thing a plan view is read for: the three boxes tile the ground — no
    // chalk of any one of them stands inside another.
    expect(probe.crossings).toEqual([])
  })
})
