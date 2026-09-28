import { test, expect } from '@playwright/test'
import {
  BAT_SIDE,
  CONTACT_TIME_S,
  CONTACT_WORLD,
  HOLD_END_S,
  PHASES,
  RECOVERY_WINDOW,
  SWING_START_S,
  WAY_HOME_WINDOW,
  WINDUP_WINDOW,
} from './harness/fixture.js'
import { SWEET_SPOT_FRACTION } from '../src/util/batterSwing.js'
import { DEFAULT_TUNING } from '../src/constants/tuning.js'
import { WRIST_BEND_MAX, WRIST_TWIST_MAX } from '../src/util/playerRig.js'
import { PLATE_FRONT_Y } from '../src/util/MathUtil.js'

// The rulebook's batter's box: 4 ft wide by 6 ft long, drawn with its inner line
// six inches from the side of the 17-inch plate. Only the inner line is needed
// here (the line the feet have to stay behind, laterally); the front and back
// lines are 6 ft apart and the stance sits well inside them either way.
const PLATE_HALF_WIDTH_M = PLATE_FRONT_Y / 2
const SIX_INCHES_M = 0.1524
const BOX_INNER_LINE_M = PLATE_HALF_WIDTH_M + SIX_INCHES_M

// ---------------------------------------------------------------------------
// Batter visual-regression suite.
//
// Renders the real <Batter> component on the test harness stage
// (frontend/e2e/harness/batter.html) at each phase of the swing and compares it
// against committed baselines in ./__screenshots__. On top of the pixels, the
// contact phase is checked geometrically against the live scene graph: the
// barrel's world-space axis must pass through the pitch's plate crossing with
// the sweet spot on the ball. The pixels catch pose regressions; the geometry
// catches the quiet accuracy ones (attack angle, swing plane, bat length) that
// can be wrong while still looking plausible.
//
// Regenerate baselines with `npm run test:visual:update` after an intentional
// change to the batter's look, and eyeball the diffs before committing them.
// ---------------------------------------------------------------------------

const SHOTS = [
  { phase: 'stance', file: 'batter-stance.png' },
  { phase: 'take', file: 'batter-take.png' },
  { phase: 'midSwing', file: 'batter-mid-swing.png' },
  { phase: 'contact', file: 'batter-contact.png' },
  { phase: 'followThrough', file: 'batter-follow-through.png' },
  { phase: 'recovery', file: 'batter-recovery.png' },
]

// Which arm is which, for the fixture's batter: the *lead* arm swings across the
// body and the *trail* arm comes last, and the two sit on opposite sides. A right-
// handed batter holds the bat with the left hand low (on the knob) and the right
// hand above it, so the trail hand — the one further from the pitcher — is the one
// up the handle. The animation names them the same way: the back arm is the arm on
// the batter's own side of the plate.
const TRAIL_SIDE = BAT_SIDE === 'L' ? 'L' : 'R'
const LEAD_SIDE = TRAIL_SIDE === 'L' ? 'R' : 'L'

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (v, s) => [v[0] * s, v[1] * s, v[2] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (v) => Math.hypot(v[0], v[1], v[2])
const degrees = (radians) => (radians * 180) / Math.PI

// Camera-relative slack allowed on the barrel axis: the sweet spot is a point on
// that axis, so a correctly built swing lands the ball within a couple of
// centimetres of it.
const AXIS_TOLERANCE_M = 0.05

const openPhase = async (page, phaseName, extraQuery = '') => {
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(String(error)))

  await page.goto(`/e2e/harness/batter.html?phase=${phaseName}${extraQuery}`)
  await page.waitForFunction(() => window.__vr?.ready === true)
  // A few frames on the pinned clock so every part has rendered at the phase.
  await page.evaluate(
    () => new Promise((resolve) => {
      let remaining = 4
      const tick = () => (remaining-- > 0 ? requestAnimationFrame(tick) : resolve())
      requestAnimationFrame(tick)
    }),
  )
  return problems
}

// A page-side diff of two PNG data URLs (the browser already has a decoder):
// what share of the frame changes at all, and by how much per channel where it
// does. Used to say what a fade *does* rather than only what it looks like.
const diffShots = async ([plainShot, fadedShot]) => {
  const load = (source) =>
    new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = `data:image/png;base64,${source}`
    })
  const [plain, faded] = await Promise.all([load(plainShot), load(fadedShot)])
  const pixelsOf = (image) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    return context.getImageData(0, 0, image.width, image.height).data
  }
  const before = pixelsOf(plain)
  const after = pixelsOf(faded)
  let changed = 0
  let total = 0
  for (let i = 0; i < before.length; i += 4) {
    // Per channel, so a hairline antialiasing jitter does not read as a change.
    const delta =
      (Math.abs(before[i] - after[i]) +
        Math.abs(before[i + 1] - after[i + 1]) +
        Math.abs(before[i + 2] - after[i + 2])) /
      3
    total += delta
    if (delta > 4) changed += 1
  }
  return { share: changed / (before.length / 4), mean: total / Math.max(changed, 1) }
}

const readBat = async (page) => {
  const bat = await page.evaluate(() => window.__vr.probeBat())
  expect(bat, 'the bat mesh should be present in the harness scene').not.toBeNull()
  return bat
}

// Bat + world of the pitch it is swinging at, for the geometry assertions.
const readSwingState = async (page) => {
  const bat = await readBat(page)
  const offset = sub(CONTACT_WORLD, bat.origin)
  const along = dot(offset, bat.axis)
  const axisPoint = add(bat.origin, mul(bat.axis, along))
  return {
    bat,
    // How far the ball is off the barrel's line, and how far down the barrel it sits.
    lateral: norm(sub(CONTACT_WORLD, axisPoint)),
    barrelFraction: along / bat.length,
    // The sweet spot is SWEET_SPOT_FRACTION down the barrel from the handle.
    sweetSpot: add(bat.origin, mul(bat.axis, bat.length * SWEET_SPOT_FRACTION)),
    tip: add(bat.origin, mul(bat.axis, bat.length)),
  }
}

test.describe('batter poses', () => {
  for (const { phase, file } of SHOTS) {
    test(`${phase} matches its baseline`, async ({ page }) => {
      const problems = await openPhase(page, phase)
      await expect(page).toHaveScreenshot(file)
      expect(problems, `console errors while rendering the ${phase} pose`).toEqual([])
    })
  }
})

// The belt, cropped and compared tightly. What the sleeve changes at the belt is
// a fraction of a per cent of the whole frame — thin seams and a hem standing off
// a belt — so the pose baselines above cannot pin it: the change fits inside their
// 0.2% tolerance. Cropped to the belt it is most of the picture, and the failure
// this is here for (a sleeve big enough to be poked through by the hem it hides
// under) took 8% of the crop when the inset was first got wrong.
test.describe('the belt, close up', () => {
  const BELT_CLIP = { x: 430, y: 250, width: 240, height: 130 }
  for (const [phase, file] of [
    ['midSwing', 'batter-belt-mid-swing.png'],
    ['contact', 'batter-belt-contact.png'],
  ]) {
    test(`${phase} keeps the hem over the belt`, async ({ page }) => {
      await openPhase(page, phase)
      await expect(page).toHaveScreenshot(file, { clip: BELT_CLIP, maxDiffPixelRatio: 0.001 })
    })
  }
})

test.describe('batter swing geometry', () => {
  test('contact puts the sweet spot on the ball', async ({ page }) => {
    await openPhase(page, 'contact')
    const state = await readSwingState(page)

    const sweetSpotMiss = norm(sub(state.sweetSpot, CONTACT_WORLD))
    console.log(
      `contact: ball off barrel axis ${state.lateral.toFixed(4)} m · ` +
      `sweet spot off ball ${sweetSpotMiss.toFixed(4)} m · ` +
      `contact at ${(state.barrelFraction * 100).toFixed(1)}% of the barrel`,
    )

    // The ball sits on the barrel's line, near the sweet spot (78% down the
    // barrel) rather than on the handle or the very tip.
    expect(state.lateral).toBeLessThan(AXIS_TOLERANCE_M)
    expect(sweetSpotMiss).toBeLessThan(AXIS_TOLERANCE_M)
    expect(state.barrelFraction).toBeGreaterThan(0.55)
    expect(state.barrelFraction).toBeLessThan(0.98)
  })

  test('the barrel rides the swing plane into contact and follows through', async ({ page }) => {
    await openPhase(page, 'midSwing')
    const midSwing = await readSwingState(page)
    await openPhase(page, 'contact')
    const contact = await readSwingState(page)
    // The swing's own end: the pose the follow-through's own path ends on, which the
    // fixture's `followThrough` phase pins its default time to and the hold holds.
    await openPhase(page, 'followThrough')
    const followThrough = await readSwingState(page)

    console.log(
      `barrel tip: mid-swing y=${midSwing.tip[1].toFixed(3)} z=${midSwing.tip[2].toFixed(3)} · ` +
      `contact y=${contact.tip[1].toFixed(3)} z=${contact.tip[2].toFixed(3)} · ` +
      `follow-through y=${followThrough.tip[1].toFixed(3)} z=${followThrough.tip[2].toFixed(3)}`,
    )


    // The barrel starts steep on the swing plane (Statcast swing_path_tilt) and
    // is flattening onto the attack angle by the time it reaches the ball.
    expect(midSwing.tip[1]).toBeGreaterThan(contact.tip[1])
    // The hands drive forward into the pitch across the swing.
    expect(contact.bat.origin[2]).toBeLessThan(midSwing.bat.origin[2])
    expect(followThrough.bat.origin[2]).toBeLessThan(midSwing.bat.origin[2])
    // Every phase is a distinct pose (guards the pinned clock silently freezing).
    expect(norm(sub(followThrough.bat.origin, midSwing.bat.origin))).toBeGreaterThan(0.05)
  })
})

// Reads the posed skeleton back in the batter's own frame (the units the
// animation is authored in), so it can be compared with the joint targets the
// bone driver was handed for the same frame.
const readRig = async (page) => {
  const state = await page.evaluate(() => ({
    body: window.__vr.probeBones(),
    solve: window.__vr.probeSolve(),
    strain: window.__vr.probeStrain(),
  }))
  expect(state.body, 'the batter skeleton should be in the harness scene').not.toBeNull()
  const { origin, scale } = state.body
  const toRig = (p) => [(p[0] - origin[0]) / scale, (p[1] - origin[1]) / scale, (p[2] - origin[2]) / scale]
  return {
    bone: (name) => toRig(state.body.bones[name]),
    // The same point back in world metres, for anything that has to be compared
    // with the plate or the box rather than with the animation's own frame.
    world: (p) => [origin[0] + p[0] * scale, origin[1] + p[1] * scale, origin[2] + p[2] * scale],
    // And the other way: a world point read as the animation's own units, which is
    // what the pitch's own places (the plate, the pitcher) are given in.
    toRig: (p) => toRig(p),
    solve: state.solve,
    strain: state.strain,
  }
}

test.describe('the body holds the bat', () => {
  // The bat is placed analytically from the pitch data, and the body is posed by
  // a bone driver solving the arms onto it. These are the two halves that must
  // agree: each hand has to end up on the grip it was given, the arms must not
  // hyperextend, and the feet must stay on the ground while they drive.
  const HAND_TOLERANCE_RIG = 0.02 // rig units: ~1.2 cm at the rendered scale
  // The clavicle is the arm's first lever and the arm's bones the second: the
  // grip can sit beyond this model's arm span, because the reference rig's limbs
  // were elastic cylinders the hand path was authored against. Both are bounded
  // — a big clavicle swing drags the ribcage around with it.
  const SHOULDER_SWING_MAX_DEG = 20.5
  const ARM_STRETCH_MAX = 1.25


  test('both hands solve onto the bat in every phase', async ({ page }) => {
    // The driver aims the *palm* at the grip — the fist closes on the handle, and
    // the wrist that puts it there is offset from the grip by the fist's own
    // reach — so the grip it reports is the palm's target, and the wrist to land
    // is the one it solved for. That the palm then actually closes on the handle
    // is its own test (`the palms close on the handle`); this one is about the
    // solve reaching: the skeleton has to end up where the arms were aimed, with
    // the shoulder girdle doing its share and the arm stretching for the rest.
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const rig = await readRig(page)
      // The driver reports the arms it solved this frame. None means the body
      // was never driven at all: it would be sitting in the skeleton's rest
      // pose while the bat swung on its own, and the per-arm assertions below
      // would pass vacuously.
      expect(rig.solve, `${phase}: the body should have a bone driver`).not.toBeNull()
      expect(rig.solve.arms.length, `${phase}: both arms should have been solved this frame`).toBe(2)
      for (const arm of rig.solve.arms) {
        const wrist = rig.bone(arm.side === 1 ? 'handR' : 'handL')
        const miss = norm(sub(wrist, arm.wrist))
        console.log(
          `${phase} ${arm.side === 1 ? 'R' : 'L'} wrist off where the palm was solved for it ${miss.toFixed(4)} rig`,
        )
        expect(miss, `${phase}: the ${arm.side === 1 ? 'right' : 'left'} wrist should land where the solve put it`).toBeLessThan(HAND_TOLERANCE_RIG)
        // The reach past the clavicle's budget is taken by stretching the arm
        // bones along their own axes, which is how the reference rig's elastic
        // limbs behaved. Bounded at both ends: never shorter than the model's
        // own proportions, and never longer than the skin can take.
        expect(arm.stretch, `${phase}: the arm should not shrink below the model's span`).toBeGreaterThanOrEqual(1)
        expect(arm.stretch, `${phase}: the arm should not stretch past its budget`).toBeLessThanOrEqual(ARM_STRETCH_MAX)
        expect(degrees(arm.shoulderSwing), `${phase}: the clavicle should stay within a human swing`)
          .toBeLessThanOrEqual(SHOULDER_SWING_MAX_DEG)
      }
    }
  })

  test('the chest turns with the pelvis instead of against it', async ({ page }) => {
    // Read from the posed skeleton's own joint positions, not from anything the
    // driver reports about itself: the line between the two hip sockets is the
    // pelvis's facing, the line between the two shoulders is the chest's, and
    // the tuning only ever asks them to differ by the hip-shoulder separation of
    // the swing (nothing at the set stance, ~30 degrees at the widest).
    const angleBetween = (a, b) => {
      const cosine = dot(a, b) / (norm(a) * norm(b))
      return (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI
    }
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const rig = await readRig(page)
      const pelvis = sub(rig.bone('thighR'), rig.bone('thighL'))
      const chest = sub(rig.bone('upper_armR'), rig.bone('upper_armL'))
      const separation = angleBetween(pelvis, chest)
      console.log(`${phase} hip-vs-shoulder separation ${separation.toFixed(1)}°`)
      // The stance is square: the whole body faces the pitcher together. A body
      // whose shoulders are left behind by a turning pelvis shows up here as a
      // separation of 100 degrees or more.
      expect(separation, `${phase}: the chest should face where the pelvis faces`).toBeLessThan(phase === 'stance' ? 12 : 45)
    }
  })

  test('the waist takes the whole turn and leaves the ribcage rigid', async ({ page }) => {
    // The swing's hip-to-shoulder separation is a *torsion*, and the torso is
    // three skin regions — the pelvis, the waist and the ribcage — carried by
    // three bones. Rolling the turn through all three wrings the whole abdomen
    // along whatever way the torso has leaned, which is what a towel looks like;
    // taking it all at the one joint between the pelvis and the ribcage leaves
    // the two regions rigid and the twist in the short band of skin between
    // them. This pins that: the ribcage must turn exactly as far as the waist
    // does, and the pelvis must trail it by the separation the tuning asks for.
    // A heading near +-180 wraps, so a small joint turn can read as a large one.
    const unwrap = (delta) => ((delta + 540) % 360) - 180

    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const rig = await readRig(page)
      const { hips, waist, chest } = rig.solve.torso
      const extra = degrees(rig.solve.pose.torsoYawExtra)
      const waistTurn = unwrap(degrees(waist.yaw - hips.yaw))
      const chestTurn = unwrap(degrees(chest.yaw - waist.yaw))
      console.log(
        `${phase} torso turn: pelvis->waist ${waistTurn.toFixed(1)}° · waist->ribcage ${chestTurn.toFixed(1)}° ` +
        `(tuning asks for ${extra.toFixed(1)}°)`,
      )
      // The ribcage rotates with the waist: no roll above the waist band at all.
      expect(Math.abs(chestTurn), `${phase}: the ribcage should not twist against the waist`).toBeLessThan(0.5)
      // And the pelvis trails the waist by the separation the tuning authored
      // (measured as a heading, so a leaning torso reads a degree or two shy).
      expect(Math.abs(waistTurn - extra), `${phase}: the waist should carry the swing's separation`).toBeLessThan(3)
    }
  })

  test('the twist reads at the waistband, on a band the width of a joint', async ({ page }) => {
    // A skinned mesh only shows a joint's rotation across the blend between the
    // two bones' regions, so the skin has to be cut into parts whose boundaries
    // *are* the joints the animation turns: the swing's hip-to-shoulder turn is
    // taken at the uniform's own trouser band, and the legs hinge at the hip
    // joints (thighL / thighR rest at rig 1.158), where an artist's doll's legs
    // hinge. Both bands have to stay narrow, or the turn is smeared through the
    // abdomen instead of taken at a joint; getting the waistband's height wrong
    // is what put the twist in the stomach, at 1.47, before the parts were cut.
    //
    // The waistband's height is not a constant any more: the driver reads it off
    // the model's own base-color texture at load time (`measureWaistband`), so
    // another player model or uniform still gets its twist at its own belt. This
    // pins the read itself — the texture was readable, not fallen back on; the
    // band is inside the window the model's own skeleton sets; the colour it found
    // is the uniform's trim; and the band still measures what the uniform's belt
    // measured when this was built by eye, 1.26-1.30 rig units.
    const RECORDED = [1.26, 1.3]
    await openPhase(page, 'stance')
    const rig = await readRig(page)
    const { hip, waist } = rig.solve.parts
    const band = rig.solve.waistBand
    const { contour } = band
    const hipJoint = rig.bone('thighL')[1]
    const middle = (band.window[0] + band.window[1]) / 2
    console.log(
      `bands: hip crease ${hip[0]}..${hip[1]} (hip joints at ${hipJoint.toFixed(3)}) · ` +
      `waistband ${waist[0].toFixed(3)}..${waist[1].toFixed(3)} from the ${band.source} ` +
      `(${band.samples} trunk samples, ${(band.share * 100).toFixed(0)}% of the ring in ` +
      `rgb ${band.trim?.map((c) => c.toFixed(2)).join(',')}) · twist reads at ${contour?.toFixed(3)}`,
    )

    // The read: the texture itself, inside the window, and the window is the
    // model's own hip-to-neck span rather than a pair of heights.
    expect(band.source, 'the waistband should be read off the model, not fallen back on').toBe('texture')
    expect(band.samples, 'the trunk should have texture samples to read').toBeGreaterThan(50)
    expect(band.window[0], 'the search window starts at the hip socket').toBeCloseTo(rig.solve.metrics.hip.y, 6)
    expect(band.window[1], 'and ends half way up to the neck').toBeCloseTo(
      rig.solve.metrics.hip.y + (rig.solve.metrics.neckY - rig.solve.metrics.hip.y) / 2,
      6,
    )
    expect(band.bottom, 'the band should be inside its own window').toBeGreaterThanOrEqual(band.window[0])
    expect(band.top, 'the band should be inside its own window').toBeLessThanOrEqual(band.window[1])
    expect(band.share, 'most of the ring should be the uniform’s trim colour').toBeGreaterThanOrEqual(0.5)
    // The uniform's trim, as the texture draws it: the belt's red.
    const [r, g, b] = band.trim
    expect(r - Math.max(g, b), 'the band should be the uniform’s trim colour').toBeGreaterThan(0.15)

    // And it is the belt this uniform actually draws: the band still measures
    // what the recorded 1.26-1.30 was, so a read that drifted off the belt — onto
    // the hem, the trouser stripe or the ground — fails here rather than quietly
    // cutting the body somewhere else.
    expect(
      Math.abs((band.bottom + band.top) / 2 - (RECORDED[0] + RECORDED[1]) / 2),
      'the derived band should sit on the belt the recorded numbers described',
    ).toBeLessThan(0.03)
    expect(contour, 'the band should have a measurable contour').not.toBeNull()
    expect(contour, 'the twist should be taken at the band’s own top edge').toBeCloseTo(band.top, 3)
    expect(waist[1] - waist[0], 'the waistband band should be narrow').toBeLessThanOrEqual(0.1)
    expect(waist[1] - waist[0], 'the waistband band should be a band, not a line').toBeGreaterThanOrEqual(0.02)
    expect(hip[1] - hip[0], 'the hip band should be narrow').toBeLessThanOrEqual(0.1)
    expect(hip[0], 'the hip crease should sit on the hip joints').toBeLessThanOrEqual(hipJoint)
    expect(hipJoint, 'the hip crease should sit on the hip joints').toBeLessThanOrEqual(hip[1])
    expect(middle, 'the window should be able to hold a waistband').toBeGreaterThan(band.top)
  })

  test('the body is rigid parts joined by narrow bands', async ({ page }) => {
    // What makes a lean (or a turn) read as a body rather than as cloth: the
    // pelvis, the torso and each leg have to move as *blocks*, with the joint's
    // motion absorbed by the band between them. That only holds while no part's
    // skin carries another part's bones — weights that do are exactly the shear
    // that dragged the belt into the stomach when the batter bent over, because
    // a third of the pelvis's skin was on the thigh bones and so stayed with the
    // legs while the torso leaned away from it. The driver reports the worst
    // residual each part carries inside itself; anything above a sliver means the
    // parts are soft again.
    await openPhase(page, 'stance')
    const rig = await readRig(page)
    const { leaks } = rig.solve.parts
    console.log(
      `cross-part weight inside a part: pelvis ${leaks.pelvis.toFixed(4)} · ` +
      `torso ${leaks.torso.toFixed(4)} · legs ${leaks.legs.toFixed(4)} · head ${leaks.head.toFixed(4)}`,
    )
    for (const part of ['pelvis', 'torso', 'legs', 'head']) {
      expect(leaks[part], `the ${part} should not carry another part's bones`).toBeLessThan(0.02)
    }

    // And the pelvis has to *tilt with the torso* as the batter leans, which is
    // the whole point of the pelvis being a part rather than a hinge for the
    // legs: the legs give at the hip crease, not the pelvis. The swing's turn is
    // a *spin* about the body's own up axis, so the pelvis and the chest may
    // differ by that spin and by nothing else. A pelvis left upright while the
    // torso bends over it is a *shear*, which tips the body's up axis — measured
    // on the chain the driver wrote, by the lean's own angle instead of by
    // nothing. (This is the failure that used to run a third of the pelvis's skin
    // on the thigh bones and drag the belt down the stomach when the batter bent
    // over the plate.)
    // And the two halves have to stay *joined*. Leaning together is not enough:
    // a translation between the two blocks has to be answered somewhere, and the
    // drive written on the torso alone pulled it 0.465 rig units apart at
    // mid-swing (582% of the band's own height), so the torso read as having
    // slipped off the hips. Where it is answered is the belt: the surface is cut
    // open along its own top edge and a band of the same surface is hidden under
    // it, so a hem that stands over the belt rather than with the hips *slides*
    // along it instead of tearing anything — the belt's own test measures that
    // seam against the sleeve's coverage, and this one may not ask for more than
    // it. The drive's sink is exactly that: the pelvis drops onto the lead leg
    // while the chest, the arms and the bat keep the frame the contact geometry
    // authors (see REACH_SLACK in Batter.jsx), which parts the two edges by the
    // sink — 0.081 rig at the contact, 0.131 at the follow-through — against a
    // sleeve cut to 0.14. What this still refuses is a slide the belt cannot
    // cover, or one the pose did not ask for. The pelvis's joint and the torso's
    // base are offset from one another, and that distance is measured at the set
    // stance — where the swing asks for no drive at all — and holds within the
    // sleeve's own coverage in every phase.
    let joinedAtStance = null
    let sleeveCoverage = null
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const rig = await readRig(page)
      const { separation } = rig.solve.torso
      const authored = degrees(rig.solve.pose.torsoYawExtra)
      const joined = norm(sub(rig.bone('spine001'), rig.bone('spine')))
      if (phase === 'stance') {
        joinedAtStance = joined
        // The belt's own sleeve, as the belt's own test reads it: how far past the
        // cut the hidden band runs, which is how far the hem may slide over it.
        sleeveCoverage = rig.solve.sleeve.margin
      }
      console.log(
        `${phase}: pelvis/chest separation ${degrees(separation.angle).toFixed(1)}° ` +
        `(tuning asks for ${authored.toFixed(1)}°) · shears the body's up axis ` +
        `${degrees(separation.shear).toFixed(2)}° · pelvis to torso ${joined.toFixed(3)} rig`,
      )
      expect(
        degrees(separation.shear),
        `${phase}: the pelvis and the torso should differ by a spin alone, never by a shear`,
      ).toBeLessThan(1)
      expect(
        Math.abs(degrees(separation.angle) - Math.abs(authored)),
        `${phase}: the pelvis should lag the chest by exactly the swing's separation`,
      ).toBeLessThan(2)
      expect(
        joined,
        `${phase}: the torso should not slide further off the pelvis than the belt covers`,
      ).toBeLessThan(joinedAtStance + sleeveCoverage)
    }
  })

  test('the head turns as a block, hinged at the neck, without wringing the chest', async ({ page }) => {
    // The batter's look is a big *relative* rotation — the set stance has the
    // chest closed to the plate while the head watches the pitcher, and the
    // driver writes it onto the neck bone — so where it is absorbed is what the
    // neck looks like. Left to the model's own weights the head had no rigid
    // region at all (its own skin only reached spine006 by 1.94, and the ribcage
    // was blended in from 1.87), and the trapezius — skin at the *shoulder
    // joints'* own radius — was 20-70% on the head's bones, so the look dragged
    // the top of the chest round with it. That is the neck twisting like a towel.
    //
    // The head is a part of the body like the pelvis and the torso: rigid, hinged
    // at the neck joint by a narrow band of skin below it, and only where the
    // model carried the vertex on the *body* rather than on the arms.
    await openPhase(page, 'stance')
    const rig = await readRig(page)
    const neck = rig.solve.parts.neck
    const neckJoint = rig.solve.metrics.neckY
    console.log(
      `neck: band ${neck[0].toFixed(3)}..${neck[1].toFixed(3)} (neck joint at ${neckJoint.toFixed(3)}) · ` +
      `head lean on the arms' skin ${rig.solve.parts.leaks.head.toFixed(4)}`,
    )
    // On the neck joint, and narrow: a full joint's band, not a neck's worth of
    // torso softening the look into the chest.
    expect(neck[0], 'the band should sit on the neck joint').toBeLessThanOrEqual(neckJoint)
    expect(neckJoint, 'the band should sit on the neck joint').toBeLessThanOrEqual(neck[1])
    expect(neck[1] - neck[0], 'the neck band should be narrow').toBeLessThanOrEqual(0.1)
    // And the joint has to be *in* the body it is cut into: the head's skin may
    // carry no other part's bones, and nothing may still be blending the head and
    // the torso outside the band.
    expect(rig.solve.parts.leaks.head, 'the head should not carry another part’s bones').toBeLessThan(0.02)
    expect(rig.solve.parts.leaks.torso, 'the torso should not carry the head’s bones').toBeLessThan(0.02)
    // And the head's motion reaches *only* that skin. Two ways it could not: the
    // arms' own skin (the trapezius, which the model also spent 20-70% of on the
    // head's bones) turning with the look, and the head's skin blending down into
    // the chest outside the band — which is what the model's own weights do, 1.87
    // up, and what makes the neck look wrung rather than hinged.
    console.log(
      `head: on the arms' skin ${rig.strain.head.onArms.toFixed(4)} · ` +
      `blending outside the band ${rig.strain.head.outside.toFixed(4)}`,
    )
    expect(rig.strain.head.onArms, 'the arms’ skin should not turn with the look').toBeLessThan(0.02)
    expect(rig.strain.head.outside, 'the head should not blend into the chest outside the band').toBeLessThan(0.2)

    // And the handover happens *only* there. The skin that blends the head and
    // the torso is the band and nothing else: no other height in the body may be
    // partly the head, or the look is smeared down the chest again (which is
    // exactly what the model's own weights do, 1.87 up).
    const jointSkin = rig.strain.bands['head/torso']?.shared
    expect(jointSkin, 'the harness should find the skin the neck band shares').toBeTruthy()
    expect(jointSkin.vertices, 'the neck band should have skin in it').toBeGreaterThan(0)
    console.log(
      `neck: the shared skin runs rig ${jointSkin.low.toFixed(3)}..${jointSkin.high.toFixed(3)}`,
    )
    expect(jointSkin.low, 'nothing below the band should blend the head and the torso').toBeGreaterThanOrEqual(
      neck[0] - 0.02,
    )
    expect(jointSkin.high, 'nothing above the band should blend the head and the torso').toBeLessThanOrEqual(
      neck[1] + 0.02,
    )
  })

  test('the bands report how far the parts pull the skin between them', async ({ page }) => {
    // The parts are rigid, so *all* of a joint's motion is absorbed by the strip
    // of skin joining them, and that strip can only stretch. The number that says
    // how much is the gap between the two parts' own answers at a band vertex,
    // measured against the band's width: with a band this narrow, the skin there
    // has to span that fraction of its own height. The bands are measured and
    // reported here rather than assumed, because they are where the pose's own
    // motion lands — a hip that rotates 46 degrees at mid-swing has to go
    // somewhere. These bounds are the current cut's numbers with headroom, so the
    // weight cut or the drive cannot quietly tear the skin further.
    //
    // The hip crease is the only band left that *reports*: the belt is cut open
    // rather than blended, so no skin spans it and there is nothing there to
    // stretch (see the next test).
    // Five phases, five harness loads, and the probe runs over the whole body on
    // each of them: past the suite's own timeout, so say so.
    test.slow()
    // Bounds on the skin each joint's band really *shares* (the harness reports
    // both that and the whole band, which a shoulder vertex's sliver of the neck
    // can dominate). The neck's is the loosest of the three, because the look it
    // has to take is the largest relative rotation in the animation: the set
    // stance closes the chest to the plate while the head watches the pitcher, and
    // the band absorbs that whole turn — 0.293 rig units pulled apart at the
    // stance, 0.029 at contact — on the thinnest skin in the body. That is the
    // *pose's* number, not the cut's: a wider band would lower the fraction by
    // spreading the look into the chest, which is the towel this is here to stop.
    const LIMITS = { 'legs/pelvis': 2.6, 'head/torso': 4.2 }
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const rig = await readRig(page)
      expect(rig.strain, 'the harness should measure the bands').not.toBeNull()
      // What the hip crease is absorbing, per leg: the leg's own turn relative to
      // the pelvis. It is a *rotation about the socket* — which is why the band
      // between them is pulled apart — and it is the pose's, not the cut's.
      const hips = rig.solve.legs
        .map((leg) => `${leg.side === 1 ? 'R' : 'L'} ${degrees(leg.turn).toFixed(0)}°`)
        .join(' / ')
      for (const [key, band] of Object.entries(rig.strain.bands)) {
        console.log(
          `${phase}: hip ${hips} · ${key} band pulled ${band.worst.toFixed(3)} rig apart ` +
          `= ${(band.share * 100).toFixed(0)}% of its ${band.vertices} vertices' band, worst at rig ${band.rigY.toFixed(2)} ` +
          `· on the joint's own skin ${(band.shared?.share * 100).toFixed(0)}% ` +
          `(${band.shared?.vertices ?? 0} of them)`,
        )
        expect(
          band.share,
          `${phase}: the ${key} band should not be torn further than it is (${(band.share * 100).toFixed(0)}% of its width)`,
        ).toBeLessThan(LIMITS[key])
        expect(
          band.shared?.share,
          `${phase}: the ${key} band's own skin should not be torn further than that`,
        ).toBeLessThan(LIMITS[key])
      }
    }
  })

  test('the belt is cut open, with a sleeve hidden under it', async ({ page }) => {
    // The belt is where the trousers meet the jersey: two pieces of clothing, not
    // one piece of skin. Blended across a band of skin it could only answer the
    // swing's turn by stretching — 174% of the band's own height at mid-swing,
    // which is what read as the jersey being wrung over the hips. So the surface is
    // cut open along the belt's top edge instead: the belt belongs to the pelvis,
    // the jersey above it to the torso, and a duplicate of the surface either side
    // of the cut is hidden under it, so the hem slides over the belt rather than
    // dragging it.
    //
    // Three things this pins. Nothing spans the cut. The sleeve runs far enough
    // past it to cover the seam. And either side of the seam stands a hair off the
    // other, so the two do not sit in the same place (see the driver's SEAM_LIP).
    //
    // The sleeve is a copy *carrying the skin of the vertex it copies*, which is
    // what decides where it may be placed: a copy placed by the same matrices as
    // the surface is the surface contracted toward the body's axis, so it is inside
    // it whatever the pose does, and it may sit the few millimetres inside the
    // uniform that keep it off the surface — and outside the naked body the uniform
    // is worn over. It used to be weighted rigidly to the pelvis and sized against
    // the swing instead ("a quarter of the radius, or the hem is poked through"),
    // and that is what made the belt ragged on a body that turns hard at the waist:
    // a quarter of the radius is deeper than the body, so the tear in the uniform
    // showed bare skin where the sleeve was meant to be. What that rule asked is
    // gone with the placement it described; the sleeve's *appearance* is pinned by
    // the belt crops below, and the pitcher's own suite measures the tear itself.
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const rig = await readRig(page)
      const sleeve = rig.solve.sleeve
      const held = await page.evaluate(() => window.__vr.probeSleeve())
      expect(held, 'the harness should measure the sleeve').not.toBeNull()
      expect(sleeve.seam, `${phase}: the cut should have its own faces`).toBeGreaterThan(0)
      expect(sleeve.sleeve, `${phase}: the sleeve should be there`).toBeGreaterThan(0)
      expect(sleeve.ring.length, `${phase}: the cut's ring should be sampled`).toBeGreaterThan(4)
      expect(
        rig.strain.bands['pelvis/torso'],
        `${phase}: the belt should be a cut, not a band of skin between two parts`,
      ).toBeUndefined()

      expect(held.open, `${phase}: the sleeve should run far enough past the cut to cover the seam`).toBeLessThan(
        sleeve.margin,
      )
      console.log(
        `${phase}: spin ${degrees(Math.abs(rig.solve.torso.separation.angle)).toFixed(1)}° · the seam opens ` +
          `${held.open.toFixed(4)} rig vertically (margin ${sleeve.margin}) · the hem stands ` +
          `${(sleeve.lip * 100).toFixed(1)}% of the radius off the belt · the sleeve is inset ` +
          `${(sleeve.inset * 100).toFixed(0)}%`,
      )
    }
  })

  test('the feet stay on the ground through the drive', async ({ page }) => {
    // Both ends: a foot must not sink through the ground, and it must not be left
    // floating either. The tuning drives the hips further forward than the leg
    // can reach, and the *drive* is what moves the pelvis, so the feet are carried
    // with it (they ride forward with the pelvis rather than being left behind
    // under it). Without that, the drive's own 0.33 rig units of travel would be
    // taken by the skeleton lifting the feet out of the ground instead, which is
    // the floating foot these bounds catch.
    //
    // What the drive asks for past the leg's length has to come out of the feet,
    // and the two feet give differently. The *back* foot is the pivot the swing
    // turns on: it rolls onto its toe, which keeps the toe where it was planted
    // while the heel lifts. The *lead* foot may not — the whole swing rides a heel
    // that stays on the dirt, with the toe as the end that comes up, in the
    // follow-through (see legFrontToeLift) — so it skids back along the ground
    // instead: the ankle target slides in toward the socket until the leg spans
    // it, at the height the pose asked for, and the shoe stays flat with its heel
    // down. Rolling it instead is what this test used to catch: the lead foot's
    // own heel read 0.318 rig through contact, a shoe standing on its toe, which
    // is a batter stepping out of his own swing rather than turning on a planted
    // front foot.
    const LIFTED = { toeL: 0.16, toeR: 0.16, footL: 0.24, footR: 0.24 }
    // A toe stands at 0.021 rig in the model's rest pose; the front foot is
    // deliberately unplanted as the drive fires, so the bound is on the *lower*
    // of the two, with 0.02 rig (~3 cm) of headroom.
    const TOE_PLANTED = 0.04
    // The lead heel's own bound: it stands at 0.001 rig in the set stance, and
    // 0.06 rig (~4 cm) is what the shoe's own roll onto its front corner can cost
    // it as the body turns over it — half the shoe's height, and nothing like the
    // 0.3 the toe pivot took it to.
    const LEAD_HEEL_MAX = 0.06
    // ...and how far the lead toe comes up over that heel at the finish.
    const TOE_UP_MIN = 0.03
    // The lead shoe turns *with* the hips rather than holding its own line: the
    // swing's turn is the pelvis's to do and the front foot rides it (see
    // frontFootPivot), so the shoe's angle against the hips' own line is the same
    // at the finish as it is in the set stance. A foot left behind — the usual
    // failure, the shoe staying put while the body turns over it — reads as that
    // angle collapsing toward nothing, and the ankle then carries the whole turn.
    const LEAD_TURN_DRIFT_MAX = 12
    const flatline = (a, b) => (Math.atan2(b[0] - a[0], b[2] - a[2]) * 180) / Math.PI
    const against = (rig) => flatline(rig.bone('heel02L'), rig.bone('toeL'))
      - flatline(rig.bone('thighR'), rig.bone('thighL'))
    // The shortest way round from one angle to another, so a reading that wraps
    // past ±180 is not read as a half turn.
    const wrap = (degrees) => ((((degrees + 180) % 360) + 360) % 360) - 180
    let stanceLeadTurn = null
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const rig = await readRig(page)
      for (const name of ['toeL', 'toeR', 'footL', 'footR']) {
        const height = rig.bone(name)[1]
        console.log(`${phase}: ${name} at ${height.toFixed(3)} rig`)
        expect(height, `${phase}: ${name} should be at ground level`).toBeGreaterThan(-0.05)
        expect(height, `${phase}: ${name} should not be left floating`).toBeLessThan(LIFTED[name])
      }
      const lowestToe = Math.min(rig.bone('toeL')[1], rig.bone('toeR')[1])
      console.log(`${phase}: lowest toe at ${lowestToe.toFixed(3)} rig`)
      expect(
        lowestToe,
        `${phase}: the shoes should roll onto a toe, not both leave the ground`,
      ).toBeLessThan(TOE_PLANTED)
      const lead = rig.bone('footL')[1] - rig.bone('heel02L')[1]
      console.log(`${phase}: the lead foot stands ${lead.toFixed(3)} rig above its own heel`)
      expect(
        rig.bone('heel02L')[1],
        `${phase}: the lead foot's heel should be on the ground, not standing the shoe on its toe`,
      ).toBeLessThan(LEAD_HEEL_MAX)
      // ...and only at the finish does the toe end come up off it: through the
      // drive the shoe is flat, so the toe is below the ankle and not above it.
      const toeOverHeel = rig.bone('toeL')[1] - rig.bone('heel02L')[1]
      console.log(`${phase}: its toe stands ${toeOverHeel.toFixed(3)} rig over that heel`)
      if (phase === 'followThrough') {
        expect(
          toeOverHeel,
          'the lead toe should point up out of the ground in the follow-through, with the heel still on it',
        ).toBeGreaterThan(TOE_UP_MIN)
      }
      const leadTurn = against(rig)
      const drift = stanceLeadTurn === null ? 0 : wrap(leadTurn - stanceLeadTurn)
      console.log(`${phase}: the lead shoe holds ${leadTurn.toFixed(1)} of the hips' own line (drift ${drift.toFixed(1)})`)
      if (phase === 'stance') stanceLeadTurn = leadTurn
      expect(
        Math.abs(drift),
        `${phase}: the lead shoe should turn with the hips instead of holding its own line`,
      ).toBeLessThan(LEAD_TURN_DRIFT_MAX)
    }
  })

  test('the torso turns back to the set stance with the arms, not behind them', async ({ page }) => {
    // The swing fires as a chain — hips, then torso, then hands — and it unwinds
    // as *one* motion: the torso turns back on the very clock the shoulders and
    // the bat ride. Handing the torso a late start of its own is not something the
    // body can do. The old tuning held the torso's pull-side turn for the first
    // 22% of the recovery while the arms unwound, and since the arms are solved
    // onto a grip that rides the arms' clock, a chest still turned 30 degrees open
    // made the hands fold in across the middle of the body instead of staying out
    // by the shoulder — which is the shoulder/torso twist this pins against.
    // Sampled inside the window rather than at its ends: the failure is a *rate*,
    // so it only shows part way through. The chest's own turn is read back off the
    // posed skeleton, normalised against the window's own start and end, and
    // required to track the window's own progress.
    const unwrap = (delta) => ((delta + 540) % 360) - 180
    const window = RECOVERY_WINDOW
    const chestAt = async (time) => {
      await openPhase(page, 'recovery', `&time=${time.toFixed(4)}`)
      const rig = await readRig(page)
      return degrees(rig.solve.torso.chest.yaw)
    }
    const start = await chestAt(window.start)
    const end = await chestAt(window.end)
    const span = unwrap(end - start)
    console.log(
      `recovery: the chest turns from ${start.toFixed(1)}° to ${end.toFixed(1)}° ` +
      `= ${span.toFixed(1)}° open at the finish`,
    )
    expect(Math.abs(span), 'the finish pose should be the one the recovery has to undo').toBeGreaterThan(30)
    for (const fraction of [0.25, 0.5, 0.75]) {
      const time = window.start + (window.end - window.start) * fraction
      const turned = unwrap((await chestAt(time)) - start) / span
      console.log(
        `recovery ${(fraction * 100).toFixed(0)}% through: the torso is ` +
        `${(turned * 100).toFixed(0)}% of the way back to its set turn`,
      )
      expect(
        Math.abs(turned - fraction),
        `${(fraction * 100).toFixed(0)}% through the recovery the torso should be about that far back, ` +
        `not sitting on its finish turn while the arms unwind`,
      ).toBeLessThan(0.15)
    }
    // And it arrives: both blocks of the torso land on the set stance's own yaw,
    // with nothing left between them. Compared as what the pose *asked* for,
    // because the skeleton's read-back yaw of a leaning torso is a couple of
    // degrees shy of it by construction (that coupling is pinned by the shear
    // check below, in the rigid-parts test).
    await openPhase(page, 'recovery', `&time=${window.end.toFixed(4)}`)
    const finish = await readRig(page)
    await openPhase(page, 'stance')
    const stance = await readRig(page)
    console.log(
      `recovery: the set turn is ${degrees(stance.solve.pose.hip.yaw).toFixed(2)}°; ` +
      `the recovery lands on ${degrees(finish.solve.pose.hip.yaw).toFixed(2)}° ` +
      `with ${degrees(finish.solve.pose.torsoYawExtra).toFixed(2)}° left between the blocks`,
    )
    expect(
      Math.abs(unwrap(degrees(finish.solve.pose.hip.yaw) - degrees(stance.solve.pose.hip.yaw))),
      'the recovery should land the hips back on the set stance',
    ).toBeLessThan(0.25)
    expect(
      Math.abs(degrees(finish.solve.pose.torsoYawExtra)),
      'the torso should have no turn left against the pelvis at the end of the recovery',
    ).toBeLessThan(0.25)
  })

  test('the front foot steps straight at the front line, and stays in the box', async ({ page }) => {
    // The stance is squared: both feet on the batter's own centreline, one
    // behind the other, so the line through them runs straight at the front line
    // of the box and the stride is a straight step at that line. The tuning's
    // own footprint, turned by a stance that faces the plate, staggers the feet
    // *sideways* as well — and a step between two staggered footprints has to
    // travel across the box as it goes forward, which is what walked the batter's
    // foot in beside the plate and out of the box.
    //
    // Two things are measured: the step is forward with no more travel across
    // than the body's own turn carries it, and neither ankle leaves the box. The
    // ankles are what is checked rather than the toes: the shoes point in at the
    // plate, as a batter's do, so a shoe *tip* crosses the line while the foot it
    // belongs to stands inside.
    const SQUARED_RIG = 0.02
    const STRAIGHT_RIG = 0.05
    const STRIDE_RIG = 0.4
    // ...and how far the rear shoe's own footprint may travel all swing. Measured
    // from the set stance to the contact: 0.068 rig, which is the tuning's own
    // 0.05 of push forward along the line the shoe stands on (legBackPushForward)
    // plus the shoe's own levelling roll carrying the toe a further 0.018.
    const BACK_PLANT_RIG = 0.08
    await openPhase(page, 'stance')
    const stance = await readRig(page)
    await openPhase(page, 'contact')
    const contact = await readRig(page)

    const square = Math.abs(stance.bone('footL')[0] - stance.bone('footR')[0])
    console.log(`stance: the two ankles are ${square.toFixed(3)} rig apart across the box`)
    expect(square, 'the set stance should be squared to the front line').toBeLessThan(SQUARED_RIG)

    // The front foot steps at the front line. The rear foot is the other kind of
    // foot: it is the plant the swing turns on, so what is read there is the
    // *footprint* it stands on — the ball of the shoe, which is the toe bone's own
    // place — and not its ankle, which rides the shoe's pivot about that ball and
    // may travel either way (see the drive's own bound in Batter.jsx). The ball
    // itself may move only by the tuning's own push forward.
    for (const [name, bone, minForward, maxForward] of [
      ['front', 'footL', STRIDE_RIG, Infinity],
      ['rear', 'toeR', 0, BACK_PLANT_RIG],
    ]) {
      const from = stance.bone(bone)
      const to = contact.bone(bone)
      const across = Math.abs(to[0] - from[0])
      const forward = from[2] - to[2]
      console.log(`${name} ${bone}: ${across.toFixed(3)} rig across, ${forward.toFixed(3)} rig forward`)
      expect(forward, `the ${name} ${bone} should travel toward the pitcher`).toBeGreaterThan(minForward)
      expect(
        forward,
        `the ${name} ${bone} should stay on the footprint it was planted on`,
      ).toBeLessThan(maxForward)
      expect(
        across,
        `the ${name} ankle should step straight at the front line, not across the box`,
      ).toBeLessThan(STRAIGHT_RIG)
    }

    for (const [phase, rig] of [['stance', stance], ['contact', contact]]) {
      for (const bone of ['footL', 'footR']) {
        const ankle = rig.world(rig.bone(bone))
        console.log(`${phase}: the ${bone} ankle is at world x ${ankle[0].toFixed(3)} m`)
        expect(
          Math.abs(ankle[0]),
          `${phase}: the ${bone} ankle should stand inside the batter's box`,
        ).toBeGreaterThan(BOX_INNER_LINE_M)
      }
    }

    // And the body stays *behind* the plate: the drive carries the pelvis the
    // whole way (0.50 m at contact), and over the plate's own footprint is where
    // it must not end up.
    const pelvis = contact.world(contact.bone('spine'))
    console.log(`contact: the pelvis is at world z ${pelvis[2].toFixed(3)} m`)
    expect(pelvis[2], 'the batter should drive behind the plate, not over it').toBeGreaterThan(0)
  })

  test('the batter stands back off the zone, and the bat pays for it', async ({ page }) => {
    // The stance is set back along the line from home plate's own centre out
    // through the batter (`STANCE_SETBACK_M`, 0.10 m), which is what takes the
    // bat's own path away from the body and gives both arms their room. Three
    // things move together, and each is measured at the pose it shows in — with
    // the numbers the setback removed reads, so a rule stated here cannot be
    // satisfied by standing where the batter used to:
    //
    //   the feet stand *clear* of the box's inner line — 0.079 m at the stance
    //   against 0.039 m with it removed, and at contact 0.076 m for the front
    //   ankle and 0.056 m for the back one against 0.036 m / 0.016 m. The back
    //   ankle is the tightest of the four because the drive rolls it up onto its
    //   toe (see `FOOT_PIVOT`), which carries it inboard. The feet are where the
    //   setback is a *place* rather than a pose: every angle above them is the
    //   tuning's own (see `STANCE_SETBACK_M`).
    //
    //   the bat grows to cover the extra distance — 0.692 m rendered at contact
    //   against 0.600 m, i.e. 55% of a 1.25 m batter against 48% (a real bat is
    //   46%). It is not decoration: the model reaches the ball *with the bat*,
    //   so the whole of the setback comes off the bat's length.
    //
    //   and the ball stands further off the bat's own handle — 2.106 rig at the
    //   stance against 1.956, which is the distance the longer bat is paying for.
    //
    // The sweet spot still lands on the ball at the long bat (`contact puts the
    // sweet spot on the ball`), and `BAT_LENGTH_MAX` is what bounds how far back
    // this can go at all: 0.15 m would need 1.170 of its 1.18 rig clamp, so the
    // first pitch a little further away would clamp and come off the sweet spot.
    const CLEARANCE_M = { stance: 0.06, contact: 0.05 }
    const BAT_MIN_M = 0.65
    const BALL_MIN_RIG = 2.0
    await openPhase(page, 'stance')
    const stance = await readRig(page)
    const stanceBat = await readBat(page)
    await openPhase(page, 'contact')
    const contact = await readRig(page)
    const contactBat = await readBat(page)

    for (const [phase, rig] of [['stance', stance], ['contact', contact]]) {
      for (const bone of ['footL', 'footR']) {
        const ankle = rig.world(rig.bone(bone))
        const clearance = Math.abs(ankle[0]) - BOX_INNER_LINE_M
        console.log(
          `${phase}: the ${bone} ankle stands ${clearance.toFixed(3)} m clear of the box's inner line`,
        )
        expect(
          clearance,
          `${phase}: the ${bone} ankle should stand back off the box's inner line, not on it`,
        ).toBeGreaterThan(CLEARANCE_M[phase])
      }
    }

    console.log(`contact: the rendered bat is ${contactBat.length.toFixed(3)} m long`)
    expect(
      contactBat.length,
      'the bat should be long enough to reach the ball from the set-back stance',
    ).toBeGreaterThan(BAT_MIN_M)

    const handle = stance.toRig(stanceBat.origin)
    const ball = stance.toRig(CONTACT_WORLD)
    const ballFromHandle = norm(sub(ball, handle))
    console.log(`stance: the ball stands ${ballFromHandle.toFixed(3)} rig from the bat's own handle`)
    expect(
      ballFromHandle,
      'the ball should stand off the handle at the distance the setback bought',
    ).toBeGreaterThan(BALL_MIN_RIG)
  })

  test('the hands stay out of the torso, through the swing and all the way back', async ({ page }) => {
    // The body is one skinned mesh and the arms are solved onto a grip that rides
    // the bat, so "the hands go through the chest" is a question about the posed
    // *skin*: for every vertex the forearm and hand bones carry, which side of the
    // nearest piece of trunk skin it has ended up on, and how deep (probeTrunk).
    // A few centimetres of contact is what arms resting against a body look like;
    // the numbers that matter are the depth — a hand 5 cm inside the shoulder is
    // a hand through the body — and how much of the arm is on the wrong side.
    //
    // Where the arms were: the recovery ran the hands back on a straight line
    // from the finish pose to the load position, which is a line through the
    // chest (91 of the arm's 116 skin vertices inside the trunk at its midpoint,
    // 0.17 rig deep), and both follow-through elbow targets were tucked behind
    // the torso's front surface.
    // A sanity bound on how *much* of the arm is at the trunk, not on how deep:
    // the depth is held to the probe's own floor below, and the arm rides against
    // the chest through the follow-through on purpose — it is the arm the swing
    // brings across the body. The failure this guards against is wholesale burial
    // (the old straight-line recovery put 91 of the arm's 116 vertices inside the
    // trunk). Measured: 13 of 116 at the follow-through, worst 0.021 rig, all of
    // it the lead arm's own skin at the chest's surface.
    const MAX_INSIDE_SHARE = 0.15
    // The reset is where the re-authored way home spends the lead arm's bend (see
    // LEAD_SHOULDER_FROM_HOLD in the component): the hands come back nearer that
    // arm's own shoulder than the line between the two pinned poses does, which is
    // what turns a 175-degree reach into a 131-degree bend — and the same shorter
    // reach is what brings the arms against the trunk. Measured at 0.96 s, 24 of
    // the arms' 116 skin vertices read inside (16 lead, 8 trail), worst 0.042 rig
    // against the trunk's own 0.015 noise floor, i.e. 2.6 cm of contact. Every
    // pinned pose either side of it is unchanged — 0 of 116 at all five — so the
    // reset carries its own bound rather than the shots' bounds being loosened for
    // it.
    const RESET_MAX_INSIDE_SHARE = 0.25
    // The shadow the arms cast on the trunk is read from the trunk's *own* skin,
    // which the same measurement reads as slightly inside itself wherever the
    // surface turns (its normals are per-vertex, and the trunk is low-poly). So
    // the arm is held to the probe's own floor rather than to an absolute number:
    // no deeper inside the trunk than the trunk's skin reads against itself.
    const PROBE_FLOOR_SLACK = 0.01
    // ...and the same, for the reset's own contact (0.042 rig of it, above).
    const RESET_PROBE_FLOOR_SLACK = 0.035
    // The pose the arms come home through: the reset is where the hands used to
    // run back through the chest on a straight line.
    const RESET_SAMPLES = [0.25, 0.5, 0.75].map(
      (share) => ['reset', RECOVERY_WINDOW.start + (RECOVERY_WINDOW.end - RECOVERY_WINDOW.start) * share],
    )
    const poses = [...SHOTS.map(({ phase }) => [phase, null]), ...RESET_SAMPLES]
    for (const [label, time] of poses) {
      await openPhase(page, label === 'reset' ? 'recovery' : label, time === null ? '' : `&time=${time}`)
      const name = time === null ? label : `${label} @${time.toFixed(2)}s`
      const trunk = await page.evaluate(() => window.__vr.probeTrunk())
      expect(trunk, `${name}: the harness should be able to measure the arms against the trunk`)
        .not.toBeNull()
      const { arms } = trunk
      console.log(
        `${name}: ${arms.inside}/${arms.vertices} arm vertices inside the trunk ` +
        `(lead ${arms.sides[TRAIL_SIDE === 'R' ? 'L' : 'R']}, trail ${arms.sides[TRAIL_SIDE]}), ` +
        `worst ${arms.worst.toFixed(3)} rig (the trunk's own floor ${arms.selfCheck.min.toFixed(3)})`,
      )
      // The probe's own calibration: the trunk's skin measured against itself is
      // inside by ~0 when its surface normals are consistent.
      expect(
        Math.abs(arms.selfCheck.mean),
        `${name}: the trunk probe should be calibrated against the trunk itself`,
      ).toBeLessThan(0.01)
      const atReset = label === 'reset'
      expect(
        arms.worst,
        `${name}: the hands and forearms should stay out of the torso`,
      ).toBeGreaterThan(
        arms.selfCheck.min - (atReset ? RESET_PROBE_FLOOR_SLACK : PROBE_FLOOR_SLACK),
      )
      expect(
        arms.inside / arms.vertices,
        `${name}: most of the arm should not be buried in the torso`,
      ).toBeLessThan(atReset ? RESET_MAX_INSIDE_SHARE : MAX_INSIDE_SHARE)
      // The arm the swing brings across the body is the lead one. The trail arm
      // comes down and back beside the ribs and reads nothing inside the trunk at
      // any pinned pose: if it does, the reset is dragging it through the chest
      // again. The reset itself now has a figure of its own — 8 of the arms' 116
      // at 0.96 s — for the same reason the reset's own bound above moved: both
      // hands are on one handle, so the grip coming back nearer the *lead* shoulder
      // brings the trail arm's own elbow round with it. The five pinned poses still
      // read 0.
      expect(
        arms.sides[TRAIL_SIDE],
        `${name}: the trail arm should stay outside the trunk`,
      ).toBeLessThan(atReset ? 9 : 1)
    }
  })

  test('the trail arm comes round the chest, not across it, at the finish', async ({ page }) => {
    // The forearm probe above watches the hands and the forearms. This watches
    // the half of the arm they hang from — and the span it is using to get there.
    //
    // Through the carry, both hands are on one bat and that bat is carried 0.74
    // rig across the body, so the trail arm is the one posed at the end of its own
    // reach: measured on the swing's own path, the chord from its shoulder to its
    // grip (0.253 rig up the handle) runs 1.05 of the arm's span at the across pose
    // with a 175-degree elbow — a straight chord laid on the ribs, its upper arm's
    // skin 24 of its 230 vertices 0.048 rig inside the trunk — and no placement of
    // the grip fixes that: the hand's place on the handle, its roll, the carry's
    // direction and its length, and the body's own turn were each measured against
    // it and every one of them spends the lead hand's own bend or the fists' own room
    // before it fits (see the README's frontier table). What fixes it is the bat's
    // own place: carried 0.42 rig *round* the trailing shoulder (see
    // TRAIL_REACH_CLEAR in Batter.jsx) that chord leaves the bicep clear of the ribs
    // — nought of its 230-odd upper-arm skin vertices inside the trunk and 0.029 rig
    // of daylight at the finish and the hold — and it does it *with the arm straight*:
    // measured, 175 to 176 degrees at every frame from the swing's own extension to
    // the end of the hold, its chord 1.12 of its span at the carry and 1.19 at the
    // finish and through it. That is the shape a two-handed follow-through has, and it
    // is what the reach bound (TRAIL_REACH_MAX) is *not* allowed to touch any more:
    // held over the swing it read 0.93 of the span with a 136-to-151-degree elbow that
    // flicked 40 degrees about its own elbow between frames, and took a 150-degree
    // step in the frame after contact. So the bound belongs to the reset, and the span
    // here sits at the arm's own reach instead — inside the 1.25 the rig's own bones
    // allow (ARM_STRETCH_MAX in src/util/playerRig.js).
    //
    // So this reads the arm through the carry, the finish and the hold: the poses
    // where both hands are on one bat and the trail arm is *extended*, which is what
    // it must read, and the ones where it must not be inside the torso. The depth
    // bound is the one that holds everywhere, and it is *not* allowed to be a
    // resting-on-the-chest bound: the pose where the arm folded into the ribs and its
    // hand ended behind the chest read 18 to 23 vertices up to 0.031 rig inside the
    // trunk, and the floor below sits just under the 0.023 to 0.029 rig of clearance
    // the carried pose has read, so that pose fails here rather than passing as a
    // press. The elbow bound is the *other* half of the same guard, and it points the
    // other way now: it read ``< 180``, which nothing can fail, and it reads the
    // straightness the pose is authored for instead — a bent trail arm (136 to 151
    // degrees) fails it.
    const SAMPLES = [
      // [name, phase, query, max span, min elbow, max vertices inside the trunk]
      // The carry is read at 0.44 s, the first frame the follow-through's own curve is
      // fully in charge of the pose. The arm is straight across the whole carry rather
      // than at one frame of it (measured at 0.41/0.42/0.43/0.44/0.45/0.46/0.47 s:
      // 114%/175deg, 110%/175, 108%/175, 104%/175, 102%/175, 101%/175, 105%/175, none
      // of them inside the trunk), so this samples the window rather than a boundary.
      { name: 'the carry', phase: 'followThrough', extra: '&time=0.44', maxSpan: 1.25, minElbow: 165, maxInside: 8 },
      { name: 'the finish', phase: 'followThrough', extra: '', maxSpan: 1.25, minElbow: 165, maxInside: 8 },
      { name: 'the hold', phase: 'followThrough', extra: '&time=0.68', maxSpan: 1.25, minElbow: 165, maxInside: 8 },
    ]
    const DEPTH_FLOOR = -0.005
    // The elbow's own angle, off the posed skeleton: upper arm, forearm, hand.
    const elbowAt = (bones) => {
      const u = sub(bones.upper_armR, bones.forearmR)
      const v = sub(bones.handR, bones.forearmR)
      return degrees(
        Math.acos(Math.min(1, Math.max(-1, dot(u, v) / (norm(u) * norm(v))))),
      )
    }
    for (const { name, phase, extra, maxSpan, minElbow, maxInside } of SAMPLES) {
      await openPhase(page, phase, extra)
      const { trunk, solve, bones } = await page.evaluate(() => ({
        trunk: window.__vr.probeTrunk(),
        solve: window.__vr.probeSolve(),
        bones: window.__vr.probeBones(),
      }))
      expect(trunk, `${name}: the harness should be able to measure the arms`).not.toBeNull()
      const trail = solve.arms.find((arm) => arm.side > 0)
      const span = trail.required / trail.reach
      const elbow = elbowAt(bones.bones)
      console.log(
        `${name}: the trail arm reaches ${(span * 100).toFixed(0)}% of its span, ` +
        `elbow ${elbow.toFixed(0)}deg, upper arm ${trunk.upper.sides[TRAIL_SIDE]}/${trunk.upper.vertices} ` +
        `inside the trunk (worst ${trunk.upper.worstBySide[TRAIL_SIDE].toFixed(3)})`,
      )
      expect(
        span,
        `${name}: the trail arm should come round the chest rather than lie across it`,
      ).toBeLessThan(maxSpan)
      expect(
        elbow,
        `${name}: the trail arm should stay extended while the swing carries the bat`,
      ).toBeGreaterThan(minElbow)
      expect(
        trunk.upper.sides[TRAIL_SIDE],
        `${name}: the trail upper arm should stay out of the torso`,
      ).toBeLessThan(maxInside)
      expect(
        trunk.upper.worstBySide[TRAIL_SIDE],
        `${name}: the trail upper arm should not be sunk into the ribs`,
      ).toBeGreaterThan(DEPTH_FLOOR)
    }
  })

  test('the bat is carried round and off the batter at the end of the follow-through', async ({ page }) => {
    // The two tests above are about the *arms*; this is about the bat they are
    // holding. A follow-through is the bat being carried round the body by the
    // turn that is still opening, and the pose it ends on is the one a viewer
    // reads as *finished*: the grip out past the batter's own side of his body
    // rather than in front of the middle of his chest, and the barrel — a metre
    // of it, swung from a shoulder — nowhere near him while it goes. Both halves
    // are read here, over the follow-through's own end and the whole hold (which
    // is where the swing's own lift carries the bat back across the shoulder and
    // is by measurement the closest it comes to him anywhere in the swing).
    //
    //   the *crossing*, as the grip's own place against the plane through the lead
    //   shoulder (the vertical plane through that shoulder, perpendicular to the
    //   front line of the box), read back off the posed skeleton (probeBones' origin
    //   and scale) rather than taken from the pose's own authored units, so this
    //   reads the pose that is on screen. The swing *arrives* on that plane: the
    //   bat's own carry is written onto the follow-through's path now (see
    //   FOLLOW_CARRY_FROM in Batter.jsx), so the crossing is taken up by the swing
    //   itself and the knob's own standoff falls through the follow-through to
    //   nought by the time the path ends — the pose the hold then holds. Measured,
    //   the knob stands 0.295 rig on the batter's side of the plane at 0.44 s,
    //   0.052 at the follow-through's own end (0.54 s, where the pose arrives) and
    //   0.007 by the hold, against the lead shoulder's own -0.146. The pose before
    //   the carry was authored onto the path reads 0.235 at the finish and 0.13
    //   through the hold — the bat never gets within 0.4 of the plane and has to be
    //   translated sideways into it after the swing has stopped, which is what this
    //   is here to catch.
    //
    //   and the *clearance*, off the posed skin: probeBatBody runs the bat's own
    //   axis against every vertex the arm that holds the handle does *not* carry,
    //   and reports the nearest. Two readings, because the bat's own far half is
    //   not always the half the body is near: the nearest such vertex *along the
    //   bat's own barrel* (past 0.4 of its length), and — since a bat thrown out
    //   across the body can leave that half empty of the body's skin altogether,
    //   which is why the barrel reading comes back null rather than pooled — the
    //   nearest vertex to the bat's own line anywhere, which always exists. Measured
    //   over the window, the barrel's own nearest skin is empty at every sample (the
    //   bat is out in clear air past the fists) and the nearest skin to the bat's
    //   line anywhere reads 0.266 rig at its closest, against the 0.170 the pre-carry
    //   pose read on the barrel and the 0.25 bound below.
    const CROSSING_MAX = 0.05
    const CARRY_START_MIN = 0.2
    const NEAREST_MIN = 0.25
    await page.goto(`/e2e/harness/batter.html?phase=followThrough&time=${WAY_HOME_WINDOW.start - 0.1}`)
    await page.waitForFunction(() => window.__vr?.ready === true)
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeBones', 'probeBatBody', 'probeBat']),
      [WAY_HOME_WINDOW.start - 0.1, RECOVERY_WINDOW.start, 0.02],
    )
    expect(rows.length, 'the carry and the hold should be swept, not sampled').toBeGreaterThan(10)
    const readings = rows.map((row) => {
      const { origin, scale, bones } = row.probeBones
      const rig = (p) => [(p[0] - origin[0]) / scale, (p[1] - origin[1]) / scale, (p[2] - origin[2]) / scale]
      const grip = rig(row.probeBat.origin)
      const tip = rig([0, 1, 2].map((i) => row.probeBat.origin[i] + row.probeBat.axis[i] * row.probeBat.length))
      const shoulderL = rig(bones.upper_armL)
      return {
        time: row.time,
        // How far the knob still stands on the batter's own side of the plane
        // through the lead shoulder. Nought is the plane itself.
        crossing: grip[0] - shoulderL[0],
        // ...and the same for the far end of the bat, which is the half of it the
        // carry actually throws: the whole bat goes across, knob and all.
        tipCrossing: tip[0] - shoulderL[0],
        clearance: row.probeBatBody?.barrel?.distance ?? null,
        part: row.probeBatBody?.barrel?.part ?? null,
        nearest: row.probeBatBody?.closest?.distance ?? null,
        nearestPart: row.probeBatBody?.closest?.part ?? null,
      }
    })
    const carried = readings.filter((reading) => reading.clearance !== null)
    const tight = readings.reduce((a, b) => (b.nearest < a.nearest ? b : a))
    const worst = carried.length ? carried.reduce((a, b) => (b.clearance < a.clearance ? b : a)) : null
    const last = readings[readings.length - 1]
    console.log(
      `the bat over ${rows.length} samples from ${readings[0].time.toFixed(2)}s to ${last.time.toFixed(2)}s: ` +
      `the knob stands ${readings[0].crossing.toFixed(3)} rig off the lead shoulder's plane at the start and ` +
      `${last.crossing.toFixed(3)} by the hold, and the body's nearest skin to the bat's own line reads ` +
      `${tight.nearest.toFixed(3)} rig at its closest (${tight.time.toFixed(2)}s, ${tight.nearestPart})` +
      (worst
        ? ` — the barrel's own nearest skin runs ${carried.map((reading) => reading.clearance.toFixed(3)).join(' / ')}, ` +
          `closest ${worst.clearance.toFixed(3)} at ${worst.time.toFixed(2)}s (${worst.part})`
        : " — and nothing of the body lies along the bat's own barrel half at any sample"),
    )
    // The bat is thrown round by the swing's own path: the knob starts the carry on
    // the batter's own side of the plane and has arrived on it by the hold, which is
    // the pose the way home starts from — so the arm's own bound (see the next test)
    // and the throw meet on this number.
    expect(
      readings[0].crossing,
      'the carry should start with the bat out on the batter\'s own side of the plane',
    ).toBeGreaterThan(CARRY_START_MIN)
    expect(
      last.crossing,
      'the bat should be carried round until the knob has almost crossed the plane through the lead shoulder',
    ).toBeLessThan(CROSSING_MAX)
    // ...and it goes past it on the way: both hands are on the handle at the hold, with
    // the bat carried out across the body, so the barrel is past the plane while the
    // knob is on it.
    expect(
      last.tipCrossing,
      'the whole bat should be thrown across the plane, barrel end and all',
    ).toBeLessThan(-0.5)
    expect(
      tight.nearest,
      'the bat should not come near the batter on the way round at the end of the follow-through',
    ).toBeGreaterThan(NEAREST_MIN)
    expect(
      carried
        .filter(({ clearance }) => clearance < NEAREST_MIN)
        .map(({ time, clearance }) => `${time.toFixed(2)}s ${clearance.toFixed(3)}`),
      'the barrel should not come near the batter on the way round at the end of the follow-through',
    ).toEqual([])
  })

  test('the lead arm keeps a real bend on the way home', async ({ page }) => {
    // The test above is the *trail* arm's span at the four pinned moments. This
    // is the lead arm's, between them. Both hands are on one handle, so the way
    // home's own path is the only thing that decides how far that arm reaches,
    // and left where the follow-through puts them it runs to the end of its own
    // reach: its shoulder-hand chord reads 1.07 of its span from the hold to
    // 0.95 s — the clavicle spends its whole 20-degree budget and the two bones
    // are stretched 7% past their own length to cover the rest, so the arm is
    // straight and over its own span for the third of a second the hands take to
    // come back (see LEAD_SHOULDER_FROM_HOLD in the component, which is the pull
    // that undoes it).
    //
    // Read as the rig's own solve rather than off the bones: `required` is the
    // shoulder-to-wrist distance and `reach` the two bones' own span, so their
    // ratio is 1 exactly when the arm is straight and over 1 when the clavicle's
    // swing has been spent and the bones are being stretched to cover the rest.
    //
    // Swept, for the same reason the palm and the elbows are: what the pull has
    // to hold is the *whole* reset, and the arm's longest frame in it is not one
    // of the pinned moments. Measured at the finish, the reset opens at
    // **1.149** (the hold's own pose: the finish's carry holds the bat out across the
    // body and leaves both arms extended — see the trail-arm test above) and the
    // take-up over the recovery's own first fifth, the pull that hands the held pose
    // back (see RECOVERY_UNWIND_SHARE and TRAIL_REACH_UNWIND in Batter.jsx), brings it
    // to **0.964 four frames in** (0.86 s) and to **0.576 at 0.97 s** as the retrace
    // takes the pose over; with the pulls zeroed the same sweep peaks at **1.067**
    // (0.93 s), which is the reading this bound exists to catch.
    const LEAD_SPAN_MAX = 0.9
    // ...and the bound the *whole* way home is read against, which is not the same
    // number. The seam is the hold's, and the hold's pose is long by design: the
    // finish's own carry takes the knob away from the body (see FINISH_DEPTH in the
    // component — and, with the reach bound off the swing's own carry, the arm the
    // pose is read on reads 1.149 of its span and 176 degrees there), so the reset
    // inherits 1.149 and the arm answers to the hold until the unwind hands it back.
    // Read as `> 0.9` across that stretch, this bound would be asking the finish not
    // to carry the bat away from the body. What is read instead is the pose that reads as a straight arm
    // laid on the ribs — the arm *past its own reach*, 1.067 with the pull zeroed —
    // plus when the bend starts and that it holds from there.
    const STRETCHED_MAX = 1.0
    // ...and the tail's own reading, which is not the bend bound either: the retrace
    // hands the pose back to the load over the last third of the way home, and the
    // pose it passes through is the one the swing came *out* of — the lead arm's own
    // longest frame in the reset, 0.912 of its span at 1.10 s (a 150-degree elbow),
    // against 0.876 with the finish's turn left where it was. Read against the 0.9
    // bend bound that bump is 1% over; what this bound is here to catch is the arm
    // running out of reach altogether, which is the 1.067 above.
    const TAIL_SPAN_MAX = 0.95
    const BENDS_WITHIN = 0.15
    await page.goto(`/e2e/harness/batter.html?phase=followThrough&time=${WAY_HOME_WINDOW.start}`)
    await page.waitForFunction(() => window.__vr?.ready === true)
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeSolve']),
      [WAY_HOME_WINDOW.start, WAY_HOME_WINDOW.end, 0.01],
    )
    expect(rows.length, 'the window should be swept, not sampled').toBeGreaterThan(70)
    const spanOf = (solve) => {
      const lead = solve.arms.find((arm) => arm.side < 0)
      return lead.required / lead.reach
    }
    const spans = rows.map((row) => ({ time: row.time, span: spanOf(row.probeSolve) }))
    const reset = spans.filter(({ time }) => time >= RECOVERY_WINDOW.start - 1e-6)
    expect(reset.length, 'the reset should be in the sweep').toBeGreaterThan(50)
    const peak = reset.reduce((a, b) => (b.span > a.span ? b : a))
    const low = reset.reduce((a, b) => (b.span < a.span ? b : a))
    const straight = spans.filter(({ time }) => time <= WAY_HOME_WINDOW.start + 1e-6)
    const bent = reset.find(({ span }) => span <= LEAD_SPAN_MAX)
    console.log(
      `the lead arm over ${rows.length} samples at 0.01 s: the way home starts from ` +
        `${straight[0].span.toFixed(3)} of its span (the finish pose) and the reset runs ` +
        `${peak.span.toFixed(3)} at its longest (${peak.time.toFixed(2)}s) to ` +
        `${low.span.toFixed(3)} at its shortest (${low.time.toFixed(2)}s), inside its own ` +
        `bend bound from ${bent ? `${(bent.time - RECOVERY_WINDOW.start).toFixed(2)}s in` : 'never'}`,
    )
    // Non-vacuous, and read from the same page: the finish pose is over the bent
    // bound, so the pull is what has to bend the arm on the way home.
    expect(
      straight[0].span,
      'the finish pose should be over the bound the pull bends the arm to',
    ).toBeGreaterThan(LEAD_SPAN_MAX)
    // A frozen column is the shape this reading takes when the probe hands back a
    // live reference across a sweep (see the harness's copyPlain): the arm would
    // read the same at every sample. It moves 0.4 rig of its span over the reset.
    expect(
      peak.span - low.span,
      'the lead arm\'s span should vary from frame to frame, not read as a constant',
    ).toBeGreaterThan(0.15)
    // Read from where the hold's own pose has been handed back rather than from the
    // hold's own frame: that pose is authored with the bat carried out across the body
    // and both arms extended, and this pull is what brings the lead arm in. Measured,
    // the arm is inside its own reach from 0.86 s — four frames in, the window the
    // handback runs over — so the bound is read from the end of that window rather
    // than being loosened for it, and the count is held to the handback's own length.
    const UNWIND_SHARE = 0.18
    const unwindEnd = RECOVERY_WINDOW.start +
      (RECOVERY_WINDOW.end - RECOVERY_WINDOW.start) * UNWIND_SHARE
    expect(
      reset
        .filter(({ time, span }) => time >= unwindEnd && span > STRETCHED_MAX)
        .map(({ time, span }) => `${time.toFixed(2)}s ${span.toFixed(3)}`),
      'the lead arm should never be past its own reach once the hold has been handed back',
    ).toEqual([])
    expect(
      reset.filter(({ span }) => span > STRETCHED_MAX).length,
      'the way home should not open over its own bound for longer than the handback',
    ).toBeLessThan(6)
    expect(bent, 'the lead arm should come inside its bend bound on the way home').toBeDefined()
    expect(
      bent.time - RECOVERY_WINDOW.start,
      'the arm should bend within a beat of the hold, not a third of a second later',
    ).toBeLessThan(BENDS_WITHIN)
    expect(
      reset.slice(reset.indexOf(bent)).filter(({ span }) => span > TAIL_SPAN_MAX)
        .map(({ time, span }) => `${time.toFixed(2)}s ${span.toFixed(3)}`),
      'the lead arm should keep a bend from there to the end of the way home',
    ).toEqual([])
  })

  test('the trailing arm goes out to the line of the pitch before it folds, and folds one way', async ({ page }) => {
    // The two tests above are about where the arm's *span* goes. This is about the
    // arm's own direction, and the shape of the way home in it: the bat is carried
    // out until the trailing arm's chord lies square to the front line of the box —
    // straight at the pitcher — with the arm still nearly straight, and only then
    // does it fold inwards into the set stance.
    //
    // Read off the bones rather than the solve, because this is a question of which
    // way the arm *points*: the chord from the trailing shoulder to the trailing
    // wrist, its span as a share of the arm's own reach, and the elbow's own bend.
    // The heading is the chord's direction in the plane of the ground, nought
    // pointing at the pitcher (world -z).
    //
    // The bound that bites is the *pairing* of the two readings: an arm laid on the
    // line of the pitch has to still be nearly straight when it gets there. Measured,
    // the way home crosses the perpendicular at **1.08 s** with its chord **1.3
    // degrees** off it, its span **0.964** of its reach and its elbow at
    // **165.4 degrees**, and with the carry off — the pose left where the hold put
    // it — it crosses instead with the arm already folded to **0.874** of its reach
    // (a 152.5-degree elbow), so the fold runs through the crossing rather than
    // after it. That is the difference this test exists to hold.
    const PERP_TOL = 12 // how near the perpendicular the chord has to come
    const PERP_SAMPLES = 4 // ...and for how many 0.01 s frames
    const STRAIGHT = 0.9 // the share of its own reach the arm has to read there
    const ELBOW_ON_LINE = 158 // ...and the elbow's own bend, 180 being straight
    const SWEEP_MAX = 170 // degrees the whole way home may turn the chord in all
    const STEP_MAX = 15 // ...and what one 0.01 s frame of it may turn
    const CLOSE_MIN = 25 // how far the elbow has to fold in after the crossing
    const OPEN_MAX = 2 // ...and how far it may re-open from its running minimum
    await page.goto(`/e2e/harness/batter.html?phase=followThrough&time=${RECOVERY_WINDOW.start}`)
    await page.waitForFunction(() => window.__vr?.ready === true)
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeBones', 'probeSolve']),
      [RECOVERY_WINDOW.start, RECOVERY_WINDOW.end, 0.01],
    )
    expect(rows.length, 'the window should be swept, not sampled').toBeGreaterThan(40)
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const unit = (v) => {
      const n = Math.hypot(...v) || 1
      return v.map((c) => c / n)
    }
    const deg = (rad) => (rad * 180) / Math.PI
    const samples = []
    for (const row of rows) {
      const { bones, scale } = row.probeBones
      const reach = row.probeSolve?.arms?.find((arm) => arm.side > 0)?.reach ?? 0.743
      const fore = sub(bones.forearmR, bones.upper_armR)
      const hand = sub(bones.handR, bones.upper_armR)
      samples.push({
        time: row.time,
        span: Math.hypot(...hand) / scale / reach,
        // The elbow's own bend, 180 being straight: the angle the two bones make
        // with each other, read from where each points off the shoulder.
        bend: 180 - deg(Math.acos(Math.min(1, Math.max(-1, dot(unit(fore), unit(hand)))))),
        heading: deg(Math.atan2(-unit(hand)[0], -unit(hand)[2])),
      })
    }
    // Non-vacuous, and read from the same page: the arm really is folded at some
    // point of the way home, so the sweep is covering the fold and not a pose.
    expect(
      Math.min(...samples.map((s) => s.span)),
      'the trailing arm should fold on the way home',
    ).toBeLessThan(0.7)
    let swept = 0
    let worst = { turn: 0, time: 0 }
    for (let i = 1; i < samples.length; i += 1) {
      let delta = samples[i].heading - samples[i - 1].heading
      while (delta > 180) delta -= 360
      while (delta < -180) delta += 360
      swept += delta
      if (Math.abs(delta) > Math.abs(worst.turn)) worst = { turn: delta, time: samples[i].time }
    }
    console.log(
      `the trailing arm's chord sweeps ${swept.toFixed(1)} degrees of heading over `
      + `${samples.length} samples at 0.01 s, its largest single frame ${worst.turn.toFixed(1)}`
      + ` at ${worst.time.toFixed(2)}s`,
    )
    expect(
      Math.abs(swept),
      'the trailing arm should not flip through its own socket on the way home',
    ).toBeLessThan(SWEEP_MAX)
    expect(
      Math.abs(worst.turn),
      'no frame of the way home should snap the arm round',
    ).toBeLessThan(STEP_MAX)
    const nearest = samples.reduce((a, b) => (Math.abs(b.heading) < Math.abs(a.heading) ? b : a))
    const onLine = samples.filter((s) => Math.abs(s.heading) <= PERP_TOL)
    console.log(
      `it lies within ${PERP_TOL} degrees of the perpendicular at ${onLine.length} samples`
      + (onLine.length ? ` (${onLine[0].time.toFixed(2)}-${onLine[onLine.length - 1].time.toFixed(2)}s)` : '')
      + `, nearest the line at ${nearest.time.toFixed(2)}s: ${nearest.heading.toFixed(1)} degrees off,`
      + ` span ${nearest.span.toFixed(3)} (a ${nearest.bend.toFixed(1)}-degree elbow)`,
    )
    expect(onLine.length, 'the chord should come out to the line of the pitch').toBeGreaterThanOrEqual(PERP_SAMPLES)
    expect(
      onLine.filter((s) => s.span < STRAIGHT).map((s) => `${s.time.toFixed(2)}s ${s.span.toFixed(3)}`),
      'the arm should still be straight when the chord is out at the line',
    ).toEqual([])
    expect(
      onLine.filter((s) => s.bend < ELBOW_ON_LINE).map((s) => `${s.time.toFixed(2)}s ${s.bend.toFixed(1)}`),
      'and the elbow should have nearly all of its bend left to give',
    ).toEqual([])
    // The fold itself, from the crossing on: inwards, one way, and all the way in.
    const crossing = samples.findIndex((s) => s.time >= nearest.time)
    const folds = samples.slice(crossing)
    const floor = Math.min(...folds.map((s) => s.bend))
    expect(
      folds[0].bend - floor,
      'the elbow should fold inwards once the chord is out at the line',
    ).toBeGreaterThan(CLOSE_MIN)
    let running = folds[0].bend
    expect(
      folds.filter((s) => {
        const opened = s.bend - running > OPEN_MAX
        running = Math.min(running, s.bend)
        return opened
      }).map((s) => `${s.time.toFixed(2)}s ${s.bend.toFixed(1)}`),
      'and it should fold one way, not open and close again',
    ).toEqual([])
  })

  test('the hands finish where the shoulders went, and the arm comes round the lead one', async ({ page }) => {
    // The test above is about where each arm is. This is about the pair of them:
    // the crossed-arms pose at the end of a follow-through, where one arm has
    // swung past the other and the two forearms lie in an X across the chest.
    //
    // Read in plan as which side of the lead arm's own line the trail arm's own
    // *line* is on — its shoulder and the elbow it hangs from. Shoulder and elbow
    // on the same side means the trail arm comes round the lead one; the far half
    // of one arm past the other is what a crossed-arms finish looks like.
    //
    // What is *not* read is the trail hand, and that is the change this pose made.
    // Both fists are on one handle now (see the carry test): the trailing fist
    // grips 0.253 rig *above* the lead one, so when the bat is carried across the
    // plane the knob and the lead hand go there first and the trail hand — a
    // quarter of a rig unit further up the same handle — is carried past the lead
    // arm's line by the grip's own order. That is the handle's business, not the
    // arms': measured at the late follow-through, the trail hand sits 0.030 rig on
    // the far side of the line while its shoulder (+0.121) and its elbow (+0.052)
    // are both on its own side. (Its own reading used to be the bound here, while
    // the finish was one-handed and the released fist hung beside the hip; that pose
    // no longer exists, and the hand it read is now the one that grips.)
    const CARRIED = [
      ['the late follow-through', '&time=0.68'],
      ['the hold', '&time=0.76'],
    ]
    // Which side of the line o->a the point c falls on, in plan (x/z).
    const side = (o, a, c) => (a[0] - o[0]) * (c[2] - o[2]) - (a[2] - o[2]) * (c[0] - o[0])
    for (const [name, extra] of CARRIED) {
      await openPhase(page, 'followThrough', extra)
      const bones = await page.evaluate(() => window.__vr.probeBones().bones)
      expect(bones, `${name}: the harness should be able to measure the skeleton`).toBeTruthy()
      const atShoulder = side(bones.upper_armL, bones.handL, bones.upper_armR)
      const atElbow = side(bones.upper_armL, bones.handL, bones.forearmR)
      const atHand = side(bones.upper_armL, bones.handL, bones.handR)
      console.log(
        `${name}: the trail shoulder is ${atShoulder.toFixed(3)} off the lead arm's line, ` +
        `its elbow ${atElbow.toFixed(3)}, its hand ${atHand.toFixed(3)} ` +
        `${Math.sign(atShoulder) === Math.sign(atElbow) ? '(the arm comes round)' : '(THE ARMS CROSS)'}`,
      )
      expect(
        Math.sign(atElbow),
        `${name}: the trail arm should come round the lead one, not through it`,
      ).toBe(Math.sign(atShoulder))
    }
  })

  test('the back of the palm stays up the whole way home, at every sample between the poses', async ({ page }) => {
    // What the pose has to hold. The fist's roll is the one axis of a grip that
    // nothing else pins down: the palm has to sit on the handle and the fingers
    // have to close round it, but which way round the knuckles end up is whatever
    // the arm's own reach direction happens to give. Through the swing that is
    // right — a wrist rolls with the swing it is driving — and for a pose *held*
    // up in front of the chest it is not: the reach direction there runs from a
    // shoulder behind the body out to a grip in front of it, and through the
    // follow-through and the way home it swings the palm the whole way over.
    // Measured off the posed skeleton before the held roll was gated, the lead
    // hand's back faced 0.69 and 0.54 *down* at the finish and the hold and ran
    // 0.25 → -0.50 over 0.05 s at 0.87-0.92 s, and the trail hand's ran to -0.50
    // at 1.22-1.37 s (a 180-degree step in the frame the hand-back started on).
    //
    // This is swept rather than sampled, and the window it is swept over is the
    // one the fixture calls the way home: the follow-through's end, the hold, and
    // the whole reset. Four chosen moments cannot see a pop between them — the
    // roll-overs above all sat *between* the four — so the bounds here are
    // per-sample, and the four moments are kept as the tighter pose bound.
    //
    // probePalms reads the hand's own axes with the model's own statement of which
    // way round the palm sits (its handle marker is on the palm's side of the
    // hand), so +1 is the back of the palm facing the sky and -1 is it facing the
    // ground. A bat standing on end leaves the roll free — there is no direction
    // up for a hand whose only free axis is round the barrel — so samples with the
    // barrel under half a rig unit off vertical are skipped, and the count of the
    // ones that are not is asserted, or a pose that never tilts the bat would
    // pass this vacuously.
    //
    // The two whole-window bounds are set from what the pose measures rather than
    // from round numbers, because both of them are read at the one place the held
    // roll is *handed back* to the hand's own: the last fifth of the way home,
    // where the two references are still more than a right angle apart and the
    // blend necessarily passes the hand through them. Measured there, the back
    // hand tips 0.08 past edge-on for 0.04 s (1.25-1.29 s) and turns 0.64 rig in
    // its single fastest step, against -0.50 for a fifth of a second and a 1.34
    // step before the roll was gated; everywhere else in the window nothing tips
    // past 0.19 or moves more than 0.19. Handing the roll back *later* was tried
    // and measured worse, not better: spreading it over 0.35 and 0.5 of the reset
    // leaves the weight under half while the arm's own reach is still turned
    // round the other way, and the palm rolls the whole way over (-0.87 and
    // -0.88).
    const PALM_DOWN_MAX = -0.1 // how far past edge-on the palm may tip
    const PALM_UP_AT_POSES = 0.25 // the bound the four moments were held to
    const PALM_STEP_MAX = 0.7 // how far the palm may turn in one 0.01 s step
    const BARREL_TILT_MIN = 0.5
    const POSES = [
      ['the finish', 0.54],
      ['the late follow-through', 0.68],
      ['the hold', 0.82],
      ["the reset's midpoint", RECOVERY_WINDOW.start + (RECOVERY_WINDOW.end - RECOVERY_WINDOW.start) / 2],
    ]
    await page.goto(`/e2e/harness/batter.html?phase=followThrough&time=${WAY_HOME_WINDOW.start}`)
    await page.waitForFunction(() => window.__vr?.ready === true)
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probePalms', 'probeBones']),
      [WAY_HOME_WINDOW.start, WAY_HOME_WINDOW.end, 0.01],
    )
    expect(rows.length, 'the window should be swept, not sampled').toBeGreaterThan(60)
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    const rolled = []
    const popped = []
    const worst = { L: { up: Infinity, at: 0 }, R: { up: Infinity, at: 0 } }
    let steps = { L: 0, R: 0 }
    let checked = 0
    let previous = null
    for (const row of rows) {
      const palms = row.probePalms
      for (const side of ['L', 'R']) {
        const palm = palms[side]
        if (palm.tilt < BARREL_TILT_MIN) continue
        checked += 1
        if (palm.up < worst[side].up) worst[side] = { up: palm.up, at: row.time }
        if (palm.up < PALM_DOWN_MAX) rolled.push(`${row.time.toFixed(2)}s:${side} ${palm.up.toFixed(2)}`)
        if (previous) {
          const moved = Math.hypot(...sub(palm.back, previous[side]))
          if (moved > steps[side]) steps[side] = moved
          if (moved > PALM_STEP_MAX) popped.push(`${row.time.toFixed(2)}s:${side} ${moved.toFixed(2)}`)
        }
        if (POSES.some(([, at]) => Math.abs(row.time - at) < 0.006)) {
          const pose = POSES.find(([, at]) => Math.abs(row.time - at) < 0.006)[0]
          expect(
            palm.up,
            `${pose} (${row.time.toFixed(2)}s): the back of the ${side} palm should still face up`,
          ).toBeGreaterThan(PALM_UP_AT_POSES)
        }
      }
      previous = { L: palms.L.back, R: palms.R.back }
    }
    console.log(
      `the way home, ${rows.length} samples at 0.01 s (${checked} with the barrel off vertical): ` +
        `the L palm bottoms at ${worst.L.up.toFixed(2)} at ${worst.L.at.toFixed(2)}s, ` +
        `the R palm at ${worst.R.up.toFixed(2)} at ${worst.R.at.toFixed(2)}s; ` +
        `the largest step is ${Math.max(steps.L, steps.R).toFixed(2)} rig per 0.01 s`,
    )
    expect(checked, 'the bat should be off vertical for most of the window').toBeGreaterThan(100)
    expect(
      rolled,
      `the back of the palm should not be rolled over anywhere in the way home: ${rolled.join(', ')}`,
    ).toEqual([])
    expect(
      popped,
      `the palm should not roll between samples: ${popped.join(', ')}`,
    ).toEqual([])
  })

  test('the elbows keep their own directions, at every sample between the poses', async ({ page }) => {
    // Two things a follow-through reads by, and the direction each arm's own
    // elbow points is both of them. The lead arm's elbow belongs *out* beside the
    // shoulder (it has the bat's own line to follow round, and folded in against
    // the body it reads as an arm held on to rather than swung); the trail arm's
    // elbow belongs *down*, which is where a batter's trail arm relaxes to as the
    // swing unwinds and what keeps the trailing upper arm from pointing at the
    // sky over the top of the lead one. Measured, the trail elbow finished 0.44 of
    // the upper arm's length above its own shoulder at the end of the
    // follow-through, and the lead elbow is carried outward through the reset.
    //
    // Swept rather than sampled, for the same reason the palm is: the trail arm's
    // elbow used to *switch* its target on the reset's first frame — the finish
    // hint's forward push was gated off by ``isRecovering`` — and its direction
    // stepped 1.40 rig between 0.82 s and 0.83 s, a right-angle flick that none
    // of the four moments falls on (they are 0.54, 0.68, 0.82 and the reset's
    // midpoint).
    //
    // The outward bound is stated where the pose holds it. The lead forearm
    // legitimately ends the reset pointing inboard from an elbow carried outside:
    // the load's grip is in front of the chest and the set stance's own reading is
    // -0.21, so the bound runs to the reset's midpoint and past that the sweep's
    // own continuity bound is what holds.
    // The lead elbow's own carry, out beside its shoulder rather than in against
    // the ribs. It was 0.2 rig and the pose held it (the old way home reads no
    // sample under 0.2 before the reset's midpoint, its lowest being -0.20 at
    // 1.32 s, after it). Re-authoring the way home to bend that arm folds the
    // elbow in with the hands instead: 0.12-0.19 through the hold and the reset's
    // start, then down through zero to -0.22 at 1.06 s, because a folded arm's
    // elbow sits beside the ribcage rather than out beside the shoulder. The floor
    // moves with the pose — what it still guards is the elbow folding *past* that,
    // through the chest and out the other side — and it is the second of the two
    // things the bend costs this test.
    const OUT_MIN = -0.25
    // The trail elbow's own downward point, held over the *whole* cycle rather
    // than the way home: it is the direction that keeps the trailing upper arm
    // from pointing at the sky over the top of the lead one, and the swing is
    // where the arm is busiest.
    // It used to be 0.14, and it was 0.14 because the pose read +0.13: the way
    // home's first re-authoring carried the hands back toward the lead shoulder
    // *with* a lift (see LEAD_SHOULDER_FROM_HOLD), and the trail arm is solved
    // onto the same bat, so the grip's own height rode the trail wrist up over
    // its shoulder and took the elbow with it — +0.13 between 0.91 s and 1.10 s
    // where the pose before that held it at or below 0 for every sample. The
    // lift is out of the way home's bow now (see LEAD_SHOULDER_FROM_PATH) and the
    // drive pitches the trunk further forward over the arms (see DRIVE_LEAN), so
    // the bound is where it belongs — a real 0, with the pose reading -0.021 at
    // its highest (1.06 s) and -0.09 or below either side of it.
    const DOWN_MAX = 0 // rig units up the elbow may point, as a fraction of the arm
    // The lead elbow's own point, the same way: out beside the shoulder is where
    // it belongs and the outward bound below is what holds *that*, but it also
    // comes down, and it is now the lower of the two elbows — -0.23 of the upper
    // arm's length below horizontal at the hold, -0.67 by the end of the reset.
    const LEAD_DOWN_MAX = -0.1
    // Set from what the pose measures, not from a round number: the trail elbow's
    // fastest step in the window is 0.28 rig (at 1.24 s, where the held roll is
    // handed back and the arm's own reach sweeps the wrist round with it) and
    // nothing else in the window reaches 0.2. The switch this replaces moved it
    // 1.40.
    const ELBOW_STEP_MAX = 0.35 // how far an elbow may swing in one 0.01 s step
    const OUT_HELD_UNTIL = RECOVERY_WINDOW.start + (RECOVERY_WINDOW.end - RECOVERY_WINDOW.start) / 2
    // Swept from the top of the cycle rather than from the way home: the elbows'
    // own directions are held over the swing as well (`DOWN_MAX` above), while
    // the bounds that belong to the pose the reset unwinds from are applied to
    // the way-home samples alone.
    await page.goto(`/e2e/harness/batter.html?phase=midSwing&time=0`)
    await page.waitForFunction(() => window.__vr?.ready === true)
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeBones']),
      [0, WAY_HOME_WINDOW.end, 0.01],
    )
    expect(rows.length, 'the window should be swept, not sampled').toBeGreaterThan(120)
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const unit = (v) => {
      const n = Math.hypot(...v) || 1
      return v.map((c) => c / n)
    }
    const up = []
    const leadUp = []
    const inward = []
    const popped = []
    let worst = { lead: Infinity, leadAt: 0, trail: -Infinity, trailAt: 0, leadDown: -Infinity, leadDownAt: 0 }
    let steps = { lead: 0, trail: 0 }
    let previous = null
    for (const row of rows) {
      const bones = row.probeBones.bones
      // The body's own lateral axis, lead shoulder -> trail shoulder, so a
      // positive reading is an elbow carried out away from the midline.
      const lateral = unit(sub(bones.upper_armR, bones.upper_armL))
      const lead = unit(sub(bones.forearmL, bones.upper_armL))
      const trail = unit(sub(bones.forearmR, bones.upper_armR))
      const out = dot(lead, lateral)
      const atWayHome = row.time >= WAY_HOME_WINDOW.start
      if (out < worst.lead) worst = { ...worst, lead: out, leadAt: row.time }
      if (trail[1] > worst.trail) worst = { ...worst, trail: trail[1], trailAt: row.time }
      if (lead[1] > worst.leadDown) {
        worst = { ...worst, leadDown: lead[1], leadDownAt: row.time }
      }
      if (trail[1] > DOWN_MAX) up.push(`${row.time.toFixed(2)}s ${trail[1].toFixed(2)}`)
      if (lead[1] > LEAD_DOWN_MAX) leadUp.push(`${row.time.toFixed(2)}s ${lead[1].toFixed(2)}`)
      if (atWayHome && row.time <= OUT_HELD_UNTIL && out < OUT_MIN) {
        inward.push(`${row.time.toFixed(2)}s ${out.toFixed(2)}`)
      }
      if (atWayHome && previous) {
        for (const [name, now] of [['lead', lead], ['trail', trail]]) {
          const moved = Math.hypot(...sub(now, previous[name]))
          if (moved > steps[name]) steps[name] = moved
          if (moved > ELBOW_STEP_MAX) popped.push(`${row.time.toFixed(2)}s:${name} ${moved.toFixed(2)}`)
        }
      }
      previous = atWayHome ? { lead, trail } : null
    }
    console.log(
      `the cycle, ${rows.length} samples at 0.01 s: the lead elbow bottoms at ` +
        `${worst.lead.toFixed(2)} outward (${worst.leadAt.toFixed(2)}s) and ` +
        `${worst.leadDown.toFixed(2)} up (${worst.leadDownAt.toFixed(2)}s), the trail elbow at ` +
        `${worst.trail.toFixed(2)} up (${worst.trailAt.toFixed(2)}s); the largest step is ` +
        `${Math.max(steps.lead, steps.trail).toFixed(2)} rig per 0.01 s`,
    )
    expect(
      up,
      `the trail elbow should point down for the whole cycle: ${up.join(', ')}`,
    ).toEqual([])
    expect(
      leadUp,
      `the lead elbow should point down for the whole cycle: ${leadUp.join(', ')}`,
    ).toEqual([])
    expect(
      inward,
      `the lead elbow should stay out beside the shoulder: ${inward.join(', ')}`,
    ).toEqual([])
    expect(
      popped,
      `an elbow should not swing between samples: ${popped.join(', ')}`,
    ).toEqual([])
  })

  test('the arm on the pitcher\'s side stays in front of the torso', async ({ page }) => {
    // The forearm measurement above starts at the wrist. The *upper* arm is the
    // half of the arm a swing lays across the chest, and it is the half a batter
    // cannot see: it is under the jersey's own shoulder cap, so it can be sunk
    // into the ribs while the sleeve still looks attached. probeTrunk measures
    // it in its own pass — every vertex the upper arm's own bone carries, past a
    // skirt at the shoulder (see SHOULDER_SKIRT) — and this is the invariant the
    // pose is held to: the arm on the pitcher's side is *in front of* the torso.
    //
    // Where it was: the lead arm's upper arm sat 0.042 rig inside the ribs at the
    // loaded stance (2.5 cm) with the elbow hint pushed the way it was authored,
    // and the same term, flipped, reads 0.061 rig of clear air instead — the hint
    // is authored in the body's turned frame, and in that frame the sign pointed
    // into the chest.
    //
    // The skirt used to sit at 0.85 of the upper arm's length, which measured only
    // the last sixth of the arm, next to the elbow: the whole bicep could lie
    // inside the ribs and the reading would still say the arm was clear. At 0.5
    // the measurement starts where the deltoid's own cap ends, and the load's
    // own elbow hint and the lead arm's flare were both retuned against it — the
    // load went from 15 of 231 vertices inside to 1, and the depth from 0.043 to
    // 0.049 rig of the one vertex left, on a pose that also reads clear of the
    // chest from the pitcher's view (see the coverage test below).
    // How much of either arm may be reading inside, over the whole swing. The
    // arms are one continuous piece of skin with the shoulders, so a handful of
    // vertices at the joint's own cap reads inside whatever the arm does; what
    // this bounds is wholesale burial — the old straight-line recovery put 91 of
    // the arm's 116 vertices inside the trunk. Measured with the skirt at 0.5:
    // 1/231 at the loaded stance, 37/236 at mid-swing, 29/243 at contact,
    // 36/229 at the follow-through, 18/228 at the hold, and 0 to 18 through the
    // reset. The two arms bury at opposite ends of the swing — the lead arm
    // crossing the chest on the way to the ball, the trail arm being dragged
    // across it on the way out — and both are nearly straight chords from a
    // shoulder to a grip, which no elbow hint can lift off the chest.
    const MAX_INSIDE_VERTICES = 45
    // The deepest any part of either upper arm ever reads. The straight chord is
    // the reason it is a bound and not a floor: a straight arm's own skin touches
    // the chest it crosses. 0.053 rig (3 cm) is the measured worst, at the
    // follow-through's trail bicep; the old straight-line recovery read 0.17 rig
    // here.
    const DEPTH_FLOOR = -0.06
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const trunk = await page.evaluate(() => window.__vr.probeTrunk())
      expect(trunk, `${phase}: the harness should be able to measure the arms`).not.toBeNull()
      const { upper, arms } = trunk
      // The measurement has to have seen the arm, or a clean reading is nothing.
      expect(upper.vertices, `${phase}: the upper arm should be measured`).toBeGreaterThan(20)
      console.log(
        `${phase}: upper arms ${upper.inside}/${upper.vertices} inside ` +
        `(pitcher-side ${upper.sides[LEAD_SIDE]}, worst ${upper.worstBySide[LEAD_SIDE].toFixed(3)}, ` +
        `trail ${upper.sides[TRAIL_SIDE]}, worst ${upper.worstBySide[TRAIL_SIDE].toFixed(3)}, ` +
        `trunk floor ${arms.selfCheck.min.toFixed(3)})`,
      )
      expect(
        upper.worst,
        `${phase}: no part of either arm should be buried in the torso`,
      ).toBeGreaterThan(DEPTH_FLOOR)
      expect(
        upper.inside,
        `${phase}: most of both upper arms should be outside the torso`,
      ).toBeLessThanOrEqual(MAX_INSIDE_VERTICES)
      // The load and the way back to it — the poses this turn is about: the arm
      // the pitcher sees is the one that has to clear the chest. Measured: 1
      // vertex at the loaded stance, 0 through the recovery, and 4 or fewer at
      // the load end of the reset. (Before, with the skirt at 0.85, the probe
      // never looked at the bicep at all: the whole upper arm could sit inside
      // the ribs while the reading said the arm was clear.)
      if (phase === 'stance' || phase === 'recovery') {
        expect(
          upper.inside,
          `${phase}: the arms should be clear of the torso at the set and on the way back to it`,
        ).toBeLessThanOrEqual(4)
      }
    }
  })

  test('the trunk starts the swing turned toward the arms, not away from them', async ({ page }) => {
    // The arms are held toward the pitcher's line — that is where the bat has to
    // come through — while the set stance faces the plate, which is broadside to
    // the pitcher. The angle between the two is the separation that has to go
    // somewhere: the further the trunk faces away from the arms, the more of the
    // upper arm has to lie across the chest, and the more of it the torso covers
    // from the pitcher. settings.stanceArmFacing turns the trunk — and the pelvis
    // with it, by the same amount, so none of it lands in the waist — that share
    // of the way from the plate-facing yaw toward the pitcher's line.
    //
    // The yaw a pose is authored at, in the rig's own frame, where 0 is the
    // pitcher's line and the chest's own facing is what the driver was given.
    const TRUNK_YAW = async (page) =>
      page.evaluate(() => {
        const pose = window.__vr.probeSolve()?.pose
        return {
          trunk: ((pose.hip.yaw + pose.torsoYawExtra) * 180) / Math.PI,
          hips: (pose.hip.yaw * 180) / Math.PI,
          extra: (pose.torsoYawExtra * 180) / Math.PI,
        }
      })
    // The plate-facing stance yaw the fixture's tuning produces, and the share of
    // it the stance is turned off (settings.stanceArmFacing). A band rather than a
    // number: the point is that the trunk is *turned toward* the arms at the set,
    // by a tenth to a quarter of the separation, and that a future edit cannot
    // drift it back to a plate-facing stance or overshoot the pitcher unnoticed.
    const PLATE_FACING_DEG = 112
    const SHARE = [0.1, 0.25]
    const expectTurned = (turned, label) => {
      const off = Math.abs(turned)
      console.log(`${label}: trunk ${turned.toFixed(1)}° off the pitcher's line (plate-facing is ${PLATE_FACING_DEG}°)`)
      expect(off, `${label}: the trunk should face toward the arms, not away from them`)
        .toBeLessThan(PLATE_FACING_DEG * (1 - SHARE[0]))
      expect(off, `${label}: the trunk should not have given up the whole stance`)
        .toBeGreaterThan(PLATE_FACING_DEG * (1 - SHARE[1]))
    }
    await openPhase(page, 'stance')
    const set = await TRUNK_YAW(page)
    expectTurned(set.trunk, 'set stance')
    // The pelvis comes with it: the turn is taken off the arms' angle, not added
    // to the waist's own twist (which the belt's own test holds to its band).
    expect(
      Math.abs(set.trunk - set.hips),
      'the pelvis should turn with the trunk at the set',
    ).toBeLessThan(1)
    // ...and the swing comes back to the same turned stance rather than unwinding
    // past it to the plate: the last of the reset is where the arm the pitcher
    // sees would otherwise be swallowed again.
    const RESET_END = RECOVERY_WINDOW.start + (RECOVERY_WINDOW.end - RECOVERY_WINDOW.start) * 0.9
    await openPhase(page, 'recovery', `&time=${RESET_END}`)
    const back = await TRUNK_YAW(page)
    expectTurned(back.trunk, 'reset, nine tenths home')
    expect(Math.abs(back.trunk - back.hips), 'the pelvis should turn with the trunk on the way home').toBeLessThan(1)
  })

  test('the upper arms are not hidden behind the torso', async ({ page }) => {
    // The penetration probes say whether an arm is *inside* the torso. This says
    // whether the torso is in front of it — the same test the eye makes, and the
    // one an arm lying along the chest fails while reading perfectly outside the
    // surface: probeCover projects the posed skin onto a view and asks, for every
    // upper-arm vertex, whether some body vertex is nearer the camera and lands
    // on top of it.
    //
    // The three views are the ones this pose is judged from: the suite's own
    // three-quarter shot, the pitcher's side of the plate, and the game camera's
    // view from behind it. Measured at the set: 3 of 396 vertices hidden in the
    // three-quarter, 19 in the pitcher's view (the trail arm behind the chest,
    // where it stays for any batter who holds the bat over the back shoulder),
    // none from behind the plate — where the same battery of shots read 42 in the
    // three-quarter view before the trunk started turning toward the arms.
    const VIEWS = ['three-quarter', 'front', 'back']
    const HIDDEN_SHARE = { 'three-quarter': 0.08, front: 0.08, back: 0.2 }
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const covers = await page.evaluate((views) => {
        const out = {}
        for (const view of views) out[view] = window.__vr.probeCover(view)
        return out
      }, VIEWS)
      for (const view of VIEWS) {
        const cover = covers[view]
        expect(cover, `${phase}/${view}: the harness should be able to measure the coverage`).not.toBeNull()
        expect(cover.total, `${phase}/${view}: the arms should have been measured`).toBeGreaterThan(100)
        console.log(
          `${phase}/${view}: ${cover.hidden}/${cover.total} upper-arm vertices hidden ` +
          `(${(cover.share * 100).toFixed(0)}%, lead ${cover.L.hidden}/${cover.L.total}, ` +
          `trail ${cover.R.hidden}/${cover.R.total}, deepest ${cover.worst.deepest} m)`,
        )
        expect(
          cover.share,
          `${phase}/${view}: the torso should not be covering the upper arms`,
        ).toBeLessThanOrEqual(HIDDEN_SHARE[view])
      }
    }
  })

  test('the swing keeps opening after contact, until the chest faces the pitcher', async ({ page }) => {
    // Contact is not the end of the body's turn. A batter's chest carries on
    // round through the follow-through, past the pitcher's line, and the hold
    // drifts a little further still — that continued turn is what makes room for
    // the arms, and a swing whose body stops turning at contact folds them across
    // a chest that has stopped moving. Measured off the posed skeleton: the chest
    // faces 21 degrees short of the pitcher at contact, is 27 degrees past his line
    // by the end of the follow-through, and 31 through the hold.
    //
    // How far past him the *finish* goes is the bat's own business now, and it is
    // the thing that carries the whole bat across the plane through the lead
    // shoulder (see the carry test): both fists stay on the handle, the trailing
    // one grips a quarter of a rig unit up it, and that arm's own reach is what
    // bounds where the bat can be — so the knob comes round to the plane with the
    // *shoulders*, i.e. the body turns to meet it. The numbers below are the turn
    // that buys, read the same way as before.
    //
    // Where the body used to go: the finish's turn was read as a magnitude and
    // always subtracted the same way as the contact turn, so the chest went *back*
    // from 21 short of the pitcher to 37 short of him — the swing visibly stalled
    // and then closed up at the exact moment a real one is still opening.
    const CONTACT_SHORT_DEG = 8
    const ON_LINE_DEG = 5
    // ...and how far past his line the finish is allowed to carry it. The cap is
    // not a bound on the turn — the test below this is the one about the swing
    // still opening — but a guard against the body over-rotating: the pose is
    // measured at 27 degrees past the pitcher (31 through the hold) and read
    // against 40.
    const FINISH_PAST_DEG = 40
    const HIPS_FOLLOW_DEG = 3
    const samples = [
      ['contact', 'contact', ''],
      ['finish', 'followThrough', ''],
      ['hold', 'followThrough', '&time=0.70'],
      ['peak', 'followThrough', `&time=${RECOVERY_WINDOW.start}`],
    ]
    const facing = {}
    for (const [name, phase, extra] of samples) {
      await openPhase(page, phase, extra)
      facing[name] = await page.evaluate((plate) => {
        const body = window.__vr.probeBones()
        // A left/right bone pair's facing, in degrees off the pitcher's line:
        // 0 is dead at the pitcher, positive is short of him on the batter's own
        // side of the plate. cross(up, R - L) is that facing either way round, so
        // the sign is fixed by the plate, which the set stance's chest and pelvis
        // both point at — otherwise the number comes out mirrored.
        const facingOf = (pair) => {
          const left = body.bones[pair[0]]
          const right = body.bones[pair[1]]
          const dx = right[0] - left[0]
          const dz = right[2] - left[2]
          const toPlate = [plate[0] - body.origin[0], 0, plate[2] - body.origin[2]]
          const length = Math.hypot(toPlate[0], toPlate[2])
          toPlate[0] /= length
          toPlate[2] /= length
          // cross(up, R - L) is the pair's forward, and it points at the plate on
          // whichever side of the body that comes out — the set stance's chest
          // and pelvis both face it, so the plate fixes the sign.
          const sign = dz * toPlate[0] - dx * toPlate[2] > 0 ? 1 : -1
          const fx = sign * dz
          const fz = -sign * dx
          return (Math.atan2(fx, -fz) * 180) / Math.PI
        }
        return {
          chest: facingOf(['shoulderL', 'shoulderR']),
          hips: facingOf(['pelvisL', 'pelvisR']),
        }
      }, [0, 0, CONTACT_WORLD[2]])
    }
    console.log(
      Object.entries(facing)
        .map(([name, row]) => `${name}: chest ${row.chest.toFixed(1)}deg hips ${row.hips.toFixed(1)}deg`)
        .join(' | '),
    )
    // Contact happens with the body still short of the pitcher's line: the ball
    // is met before the chest has finished turning, which is what the turn after
    // contact is for.
    expect(facing.contact.chest, 'contact should still be short of the pitcher').toBeGreaterThan(
      CONTACT_SHORT_DEG,
    )
    // ...and by the end of the follow-through the chest is round past his line.
    expect(
      facing.finish.chest,
      'the follow-through should have carried the chest past the pitcher',
    ).toBeLessThan(-ON_LINE_DEG)
    expect(
      facing.finish.chest,
      'the follow-through should not over-rotate past the pitcher',
    ).toBeGreaterThan(-FINISH_PAST_DEG)
    // The body keeps opening: every later sample is further round than the last.
    expect(facing.finish.chest, 'the finish should be further round than contact').toBeLessThan(
      facing.contact.chest,
    )
    expect(facing.hold.chest, 'the hold should keep opening').toBeLessThan(facing.finish.chest)
    // And the hold overshoots the pitcher's line — the arms' own momentum carrying
    // the chest past him, which is where a real follow-through ends.
    expect(facing.peak.chest, 'the peak of the follow-through should overshoot the pitcher').toBeLessThan(0)
    // The legs and the pelvis come with it, not just the shoulders: the whole
    // lower body is open with the chest by the finish, which is what leaves the
    // waist band nothing to absorb.
    for (const name of ['finish', 'hold', 'peak']) {
      expect(
        Math.abs(facing[name].hips - facing[name].chest),
        `${name}: the pelvis should finish open with the chest`,
      ).toBeLessThan(HIPS_FOLLOW_DEG)
    }
  })

  test('the palms close on the handle, and the trail hand grips up it', async ({ page }) => {
    // The two fists are solved onto the handle separately, and the model's rig
    // says where each one belongs: a ``palm_handle`` node in each palm (the point
    // of the handle the fist closes on, and the direction the handle runs through
    // the palm), plus one IK target per hand whose spacing is the grip the hands
    // were modelled for. probeGrip reads the *posed* result back against all of
    // it, so this is the difference between "the hands were aimed at the bat" and
    // "the hands are holding it".
    //
    // Where they were: both hands were aimed at the *wrist*, which left the palms
    // lying flat against the handle (the handle passing 1.4 to 1.9 palm-radii off
    // the fist's own centre), and both gripped the same spot, so the pair read as
    // one lump with the hand away from the pitcher *below* the one nearer him.
    const PALM_RADIAL_MAX = 0.01 // rig units: the palm point within ~6 mm of the axis
    const PALM_ALONG_MIN = 0.99 // the handle runs through the palm, not across it
    const GRIP_MATCH = 0.012 // the fists grip at the spacing the rig authored
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const grip = await page.evaluate(() => window.__vr.probeGrip())
      expect(grip, `${phase}: the harness should be able to measure the grip`).not.toBeNull()
      expect(grip.targets, `${phase}: the rig should carry its own two hand targets`).toBeGreaterThan(0)
      console.log(
        `${phase}: palms at ${grip.hands.L.marker.along.toFixed(3)}/${grip.hands.R.marker.along.toFixed(3)} ` +
        `along the handle, ${grip.separation.toFixed(3)} rig apart (the rig's own ${grip.targets.toFixed(3)}), ` +
        `off the axis ${grip.hands.L.marker.radial.toFixed(4)}/${grip.hands.R.marker.radial.toFixed(4)}`,
      )
      for (const side of ['L', 'R']) {
        const hand = grip.hands[side]
        expect(hand.marker.radial, `${phase}: the ${side} palm should close on the handle`)
          .toBeLessThan(PALM_RADIAL_MAX)
        expect(hand.marker.alongHandle, `${phase}: the handle should run through the ${side} palm`)
          .toBeGreaterThan(PALM_ALONG_MIN)
      }
      // The grip the hands were modelled for, not a number of the animation's
      // own: the fists end up exactly as far apart as the rig's two hand targets.
      expect(
        Math.abs(grip.separation - grip.targets),
        `${phase}: the fists should grip at the rig's own spacing`,
      ).toBeLessThan(GRIP_MATCH)
      // The hand away from the pitcher — the trail hand, the one the swing turns
      // last — grips *up* the handle toward the barrel; the lead hand closes on
      // the knob end. And the two are stacked rather than overlapping: the trail
      // fist starts where the lead fist ends.
      expect(
        grip.hands[TRAIL_SIDE].marker.along,
        `${phase}: the hand away from the pitcher should grip up toward the barrel`,
      ).toBeGreaterThan(grip.hands[LEAD_SIDE].marker.along)
      expect(
        grip.hands[TRAIL_SIDE].along[0],
        `${phase}: the two fists should be stacked along the handle, not overlapped`,
      ).toBeGreaterThanOrEqual(grip.hands[LEAD_SIDE].along[1])
    }
  })

  test('the fingers fold round the handle instead of lying along it', async ({ page }) => {
    // The fist meshes are their own meshes — the body carries no hand skin — and
    // the model authors them with the fingers already curled, so the *hinge* is
    // what the driver has to move: left in the mesh's own pose, the fingers point
    // along the handle beside the palm and the fist reads as a hand held next to
    // the bat rather than closed on it. probeGrip splits each fist's skin by the
    // bone that carries it and reads every group against the handle's axis, with
    // the handle's own line taken *from the fist* (the bat's axis through the
    // fist's centre), so the numbers say where the fingers sit round the handle
    // rather than where the bat happens to be.
    //
    // Measured with the curl off (FINGER_CURL = 0), the fingers' own skin stops
    // 0.034 rig *short* of the handle's far side and sits 43 mm off it — outside
    // the palm's own 24 mm, which is the fingers lying along the bat. Curled, the
    // same skin crosses 0.035 to 0.042 rig past the axis in every phase, with its
    // closest point 2 to 7 mm off the handle against the palm's 38 to 43 mm.
    const CROSS_MIN = 0.01 // rig units past the handle's axis: the fold, itself
    const PALM_NEAR_MIN = 0.005 // the back of the hand stays on the near side
    for (const { phase } of SHOTS) {
      await openPhase(page, phase)
      const grip = await page.evaluate(() => window.__vr.probeGrip())
      expect(grip, `${phase}: the harness should be able to measure the grip`).not.toBeNull()
      for (const side of ['L', 'R']) {
        const { palm, fingers, thumb } = grip.hands[side].groups
        console.log(
          `${phase} ${side}: fingers cross ${(-fingers.straddle[0]).toFixed(3)} past the axis, ` +
          `closest skin ${fingers.radial.min.toFixed(3)} (palm ${palm.radial.min.toFixed(3)}), ` +
          `thumb ${thumb.radial.min.toFixed(3)}`,
        )
        expect(fingers.count, `${phase}: the ${side} fingers should be measured`).toBeGreaterThan(20)
        // The fingers' own skin ends up on the far side of the handle: that is a
        // fold. Their near-side extent alone would not say it — a hand laid along
        // the bat has that too.
        expect(
          -fingers.straddle[0],
          `${phase}: the ${side} fingers should fold past the far side of the handle`,
        ).toBeGreaterThan(CROSS_MIN)
        // ...and they fold *inside* the palm's own radius from the handle, which
        // is what a closed fist does and a straight one cannot.
        expect(
          fingers.radial.min,
          `${phase}: the ${side} fingers should come closer to the handle than the palm does`,
        ).toBeLessThan(palm.radial.min)
        expect(
          thumb.radial.min,
          `${phase}: the ${side} thumb should close onto the handle as well`,
        ).toBeLessThan(palm.radial.min)
        // The hand itself stays out: it is the fingers that wrap, not the palm.
        expect(
          palm.straddle[0],
          `${phase}: the back of the ${side} hand should stay on the near side of the handle`,
        ).toBeGreaterThan(PALM_NEAR_MIN)
      }
    }
  })

  test('the trailing arm never changes places with the leading one', async ({ page }) => {
    // Both hands are on the one handle, 0.253 rig apart up it, so the two arms
    // are only ever ordered against each other by *where their elbows ride*: the
    // trail elbow out on its own side of the bat and the lead one on its own
    // holds the two chains apart, and the moment the trail elbow falls onto the
    // lead arm's side they swap — the forearms passing through each other on the
    // way. Measured before the ordering rule, over the whole swing and the whole
    // way home, the two chains came 0.001 rig apart (through each other) at
    // 0.96 s, and again 0.004 rig at 1.00 s, with the trail elbow's own offset
    // over the lead arm's side of the bat down to 0.069 rig. Held apart they
    // read 0.081 rig at their closest over the same window, and the trail elbow
    // never comes within 0.26 rig of the lead arm's own side of the bat.
    //
    // Swept rather than sampled: the crossing lives between the poses — the
    // nearest approach is at 0.96 s, between the reset's own two moments — and a
    // switch would show as a *flick* of one elbow between one hundredth of a
    // second and the next.
    const GAP_MIN = 0.05 // rig units: the closest the two arm chains may come
    const SIDE_MIN = 0.15 // ...and the trail elbow's own carry over the lead's
    const ELBOW_STEP_MAX = 0.35 // how far an elbow may swing in one 0.01 s step
    // "They swap" is a question about the *forearms*, which are the two chains'
    // only segments that run together, and it is a question about which of the
    // two is on top where they meet. Where the pair are far apart, one passing
    // the other reads as nothing — the swing has them 0.31 rig apart or more, and
    // the trail forearm is below the lead's for the whole of it. Where they are
    // *together* it reads as a warp, so the order is held there: within this
    // distance the trail forearm's own closest point has to stay above the lead
    // one's. Measured before the pose was re-authored, they came within it from
    // 0.80 s with the trail forearm crossing below the lead's at 1.08 s (0.190 rig
    // apart), -0.027 and -0.032 at 1.09 and 1.11 s; the pose now holds the order
    // at +0.022 or above for every sample inside the same distance, its closest
    // being +0.030 at 1.09 s.
    const CLOSE = 0.3 // rig units: close enough for their order to be visible
    const SAMPLES_MIN = 20 // ...and the window has to actually contain some
    const SWING_BACK = 0.2 // seconds of the swing before contact in the window
    await page.goto(`/e2e/harness/batter.html?phase=midSwing&time=${CONTACT_TIME_S - SWING_BACK}`)
    await page.waitForFunction(() => window.__vr?.ready === true)
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeBones', 'probeBat']),
      [CONTACT_TIME_S - SWING_BACK, RECOVERY_WINDOW.end, 0.01],
    )
    expect(rows.length, 'the window should be swept, not sampled').toBeGreaterThan(100)
    // The closest approach of two segments, which is what "the arms are apart"
    // means: the bones are capsules, and it is the segments that intersect.
    const unit = (v) => mul(v, 1 / (norm(v) || 1))
    // The closest approach of two segments *and the two points that take it*: the
    // arms' distance is a distance between segments, and the ordering question is
    // about where the two forearms are at the one point they are nearest.
    const segClosest = (p1, q1, p2, q2) => {
      const d1 = sub(q1, p1)
      const d2 = sub(q2, p2)
      const r = sub(p1, p2)
      const a = dot(d1, d1)
      const e = dot(d2, d2)
      const f = dot(d2, r)
      let s
      let t
      if (a <= 1e-9 && e <= 1e-9) return { dist: norm(r), c1: [...p1], c2: [...p2] }
      if (a <= 1e-9) {
        s = 0
        t = Math.min(1, Math.max(0, f / e))
      } else {
        const c = dot(d1, r)
        if (e <= 1e-9) {
          t = 0
          s = Math.min(1, Math.max(0, -c / a))
        } else {
          const b = dot(d1, d2)
          const denom = a * e - b * b
          s = denom > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0
          t = (b * s + f) / e
          if (t < 0) {
            t = 0
            s = Math.min(1, Math.max(0, -c / a))
          } else if (t > 1) {
            t = 1
            s = Math.min(1, Math.max(0, (b - c) / a))
          }
        }
      }
      const c1 = add(p1, mul(d1, s))
      const c2 = add(p2, mul(d2, t))
      return { dist: norm(sub(c1, c2)), c1, c2 }
    }
    const segDist = (p1, q1, p2, q2) => segClosest(p1, q1, p2, q2).dist
    const closest = []
    const wrongSide = []
    const popped = []
    const swaps = []
    let together = 0
    let worst = { gap: Infinity, gapAt: 0, side: Infinity, sideAt: 0, order: Infinity, orderAt: 0 }
    let previous = null
    for (const row of rows) {
      const { origin, scale: s } = row.probeBones
      const rig = (p) => mul(sub(p, origin), 1 / s)
      const bones = row.probeBones.bones
      const shT = rig(bones[`upper_arm${TRAIL_SIDE}`])
      const elT = rig(bones[`forearm${TRAIL_SIDE}`])
      const wrT = rig(bones[`hand${TRAIL_SIDE}`])
      const shL = rig(bones[`upper_arm${LEAD_SIDE}`])
      const elL = rig(bones[`forearm${LEAD_SIDE}`])
      const wrL = rig(bones[`hand${LEAD_SIDE}`])
      const fore = segClosest(elT, wrT, elL, wrL)
      const gap = Math.min(
        segDist(shT, elT, shL, elL),
        segDist(shT, elT, elL, wrL),
        segDist(shL, elL, elT, wrT),
        fore.dist,
      )
      // Which forearm is on top, read where the two are closest: the trail
      // forearm's own nearest point is above the lead one's (the trail hand grips
      // 0.25 rig up the handle, so it is the trail forearm that has to ride over).
      const order = fore.c1[1] - fore.c2[1]
      if (fore.dist < CLOSE) {
        together += 1
        if (order < worst.order) worst = { ...worst, order, orderAt: row.time }
        if (order <= 0) {
          swaps.push(`${row.time.toFixed(2)}s ${order.toFixed(3)} at ${fore.dist.toFixed(3)} rig apart`)
        }
      }
      // The trail elbow's own side of the bat: the bat-perpendicular part of the
      // shoulder line (lead shoulder -> trail shoulder, so positive *is* the
      // trail arm's side), read from the trail elbow against the lead one.
      const axis = norm(row.probeBat.axis) > 1e-6 ? mul(row.probeBat.axis, 1 / norm(row.probeBat.axis)) : [0, 0, 1]
      const shoulderLine = sub(shT, shL)
      const outAxis = unit(sub(shoulderLine, mul(axis, dot(shoulderLine, axis))))
      const side = dot(sub(elT, elL), outAxis)
      if (gap < worst.gap) worst = { ...worst, gap, gapAt: row.time }
      if (side < worst.side) worst = { ...worst, side, sideAt: row.time }
      if (gap < GAP_MIN) closest.push(`${row.time.toFixed(2)}s ${gap.toFixed(3)}`)
      if (side < SIDE_MIN) wrongSide.push(`${row.time.toFixed(2)}s ${side.toFixed(3)}`)
      if (previous) {
        for (const [name, now, before] of [['lead', elL, previous.lead], ['trail', elT, previous.trail]]) {
          const moved = norm(sub(now, before))
          if (moved > ELBOW_STEP_MAX) popped.push(`${row.time.toFixed(2)}s:${name} ${moved.toFixed(2)}`)
        }
      }
      previous = { lead: elL, trail: elT }
    }
    console.log(
      `the two arms over ${rows.length} samples at 0.01 s: closest ${worst.gap.toFixed(3)} rig at ` +
        `${worst.gapAt.toFixed(2)}s, the trail elbow's own carry over the lead's ${worst.side.toFixed(3)} ` +
        `rig at ${worst.sideAt.toFixed(2)}s; the forearms are within ${CLOSE} rig at ${together} of ` +
        `them, the trail forearm's own nearest point being lowest at ${worst.order.toFixed(3)} ` +
        `(${worst.orderAt.toFixed(2)}s)`,
    )
    expect(
      together,
      'the two forearms should be close enough, and often enough, for their order to matter',
    ).toBeGreaterThan(SAMPLES_MIN)
    expect(
      swaps,
      `the forearms should not change places while they are that close: ${swaps.join(', ')}`,
    ).toEqual([])
    expect(closest, `the two arms should not pass through each other: ${closest.join(', ')}`).toEqual([])
    expect(
      wrongSide,
      `the trail elbow should stay on its own side of the lead arm's: ${wrongSide.join(', ')}`,
    ).toEqual([])
    expect(popped, `an elbow should not switch between samples: ${popped.join(', ')}`).toEqual([])
  })

  test('the trail elbow comes down and back through the reset', async ({ page }) => {
    // The way the swing comes back is half of what it reads as. The trail arm is
    // the one the follow-through leaves folded across the chest, and unwinding it
    // along the path it arrived on sends its elbow forward — at the pitcher — with
    // the forearm folded across the body (measured mid-reset: 0.29 rig toward
    // him), which is an elbow pointing the wrong way round. A batter's trail
    // elbow comes *down and back* on the way to the load, so from the reset's own
    // midpoint on, the elbow has to sit on the far side of the shoulder-to-hand
    // line, and it has to get well back there.
    //
    // The first fifth is held to its own bound rather than to that one, and the
    // reason is measured: the trail elbow is what orders the two arms against
    // each other on the way home (see the ordering test above), and the carry that
    // keeps the two chains apart sits 0.17 rig on the pitcher's side of the line
    // at the reset's first frame, falling through it by 1.07 s. Held behind the
    // line instead, the two arms pass through each other at 0.96 s. That bound is
    // the old pose's own failure — 0.29 rig, with the trail elbow ridden onto the
    // lead arm's side of the bat — so this is a real bound, not a vacuous one.
    const TOWARD_MAX = 0.01 // rig units: never on the pitcher's side of the line
    // ...and it sits further forward still since the way home was re-authored to
    // bend the lead arm: the same shorter, nearer grip rotates the trail arm's own
    // frame, and at 0.90 s the elbow reads 0.241 rig toward the pitcher against
    // 0.170 as it was. The bound moves with it, and the carry's own 0.2 is why the
    // number is not larger.
    const TOWARD_EARLY_MAX = 0.25
    const EARLY_SHARE = 0.3 // up to this share of the reset, which bound applies
    const AWAY_MIN = 0.15 // and it has to actually get there
    const BENDS_MIN = 0.1 // ...with a bent arm, or "the elbow is behind the line"
    const samples = [0.15, 0.3, 0.5, 0.7, 0.9].map(
      (share) => RECOVERY_WINDOW.start + (RECOVERY_WINDOW.end - RECOVERY_WINDOW.start) * share,
    )
    let furthestAway = -Infinity
    let mostBent = 0
    for (const [index, time] of samples.entries()) {
      await openPhase(page, 'recovery', `&time=${time}`)
      const rig = await readRig(page)
      // The direction the pitch comes from, in the batter's own frame: from the
      // batter toward the plate crossing, which is the line to the pitcher.
      const toPitcher = rig.toRig(CONTACT_WORLD)
      const unit = mul(toPitcher, 1 / norm(toPitcher))
      const shoulder = rig.bone(`upper_arm${TRAIL_SIDE}`)
      const hand = rig.bone(`hand${TRAIL_SIDE}`)
      const elbow = rig.bone(`forearm${TRAIL_SIDE}`)
      const mid = mul(add(shoulder, hand), 0.5)
      const off = sub(elbow, mid)
      const toward = dot(off, unit)
      furthestAway = Math.min(furthestAway, toward)
      mostBent = Math.max(mostBent, norm(off))
      console.log(
        `${time.toFixed(2)}s: the trail elbow sits ${toward.toFixed(3)} rig along the line to the pitcher ` +
        `(${norm(off).toFixed(3)} rig off the shoulder-hand line)`,
      )
      expect(
        toward,
        index < samples.length * EARLY_SHARE
          ? `the trail elbow should not be thrown at the pitcher while it orders the arms`
          : `the trail elbow should not point at the pitcher through the reset`,
      ).toBeLessThan(index < samples.length * EARLY_SHARE ? TOWARD_EARLY_MAX : TOWARD_MAX)
    }
    // Non-vacuous: the arm bends, and the elbow does come down and back.
    expect(mostBent, 'the trail arm should bend through the reset').toBeGreaterThan(BENDS_MIN)
    expect(furthestAway, 'the trail elbow should come back away from the pitcher').toBeLessThan(-AWAY_MIN)
  })

  test('the elbows ride either side of the plane the bat swings in', async ({ page }) => {
    // The bat has a plane of its own, and it is what the two arms are ordered
    // against: the flat the barrel sweeps in, taken from the bat's own geometry —
    // the barrel's line (the bat node's local -Z) and the axis it sweeps about
    // (the swing frame's local X, the one axis the bat's tilt rides on) — with
    // "up" the upward half of its normal. Measured through the bat's own handle,
    // a positive reading is above that plane. The lead elbow belongs under it and
    // the trail elbow over it: both hands come off the one handle, and the arm
    // that comes over the top of the bat is the one carrying the swing.
    //
    // One half of that cannot be required everywhere, and the reason is geometry
    // rather than pose, so it is worth stating exactly. **The lead elbow cannot
    // be under that plane through the swing**: at contact the plane passes 0.5 m
    // below the lead shoulder and the upper arm is 0.25 m long, so the closest
    // the elbow can ever come is 0.34 rig above it — measured, the elbow sits
    // 0.39 rig from its own shoulder in every pose while the shoulder is 0.80 rig
    // over the plane. The plane tilts with the attack angle the pitch data gives
    // it (12° here), so it lies nearly flat under a pair of shoulders that are
    // always above the hands. Pitch the torso forward and it does not move: the
    // bat is a child of that torso, so the frame the plane and the shoulders
    // share rotates as one — swept from 6° to 51° of forward lean, the lead
    // shoulder's own side of the plane reads 0.80 at every value, and 0.76 with
    // the swing's own lean raised 0.3 -> 0.7 rad. Standing the batter further
    // back from the plate does not move it either: the whole pose is authored in
    // the body's frame.
    //
    // So the split is pinned over the windows where it is the pose's own fact,
    // each with its measured edges and its reason:
    //
    //   the set stance and the load (0.00-0.22s) — the lead elbow under the
    //   plane, measured -0.21 falling to -0.12 as the bat comes up onto it. This
    //   is the pose a viewer reads before the swing starts.
    //
    //   the push to contact (0.30-0.49s) — not a rule about the elbows but about
    //   the plane: it is *past the lead arm's whole reach* there (the shoulder's
    //   own side of it, minus a 0.39 rig upper arm, reads +0.11 to +0.38 rig), so
    //   the lead elbow (also over it, +0.25 to +0.45) could not be put under it
    //   by any pose. Recorded, so that the frames the lead's own rule cannot
    //   apply to are the ones the arm cannot reach and not an unexplained hole in
    //   the sweep.
    //
    //   the bat carrying through (0.30-1.09s) — the trail elbow *over* the plane,
    //   measured +0.06 at its closest (1.09s) rising to +0.45 at the hold. It is
    //   the arm the swing is built on, and it stays on the bat's upper side all
    //   the way home to within a tenth of a second of the load.
    //
    //   the way home (0.62-1.00s) — both halves at once: the lead elbow under the
    //   plane (-0.11 to -0.04) with the trail elbow over it (+0.16 to +0.28),
    //   which is the crossing this exists to forbid: the arms are unwinding
    //   across the body with the bat between them.
    //
    // Two bands sit outside those windows and are not enforced, because in each
    // the *plane itself* is swinging across the body's own shoulder line rather
    // than the arms being on the wrong side of it: the wind-up's turn onto the
    // plane (0.23-0.28s, where the lead elbow rises from -0.08 to +0.25 as the
    // bat comes forward and the plane sweeps down past that shoulder), and the
    // bat climbing back over the shoulder into the load (1.02-1.25s, where the
    // lead elbow rides 0.00 to +0.25 over a plane whose sign flips twice as the
    // barrel comes back up). Both are logged by this test, so a change that
    // widens either one shows up in the summary rather than only in the eye.
    //
    // The load's *trail* elbow reads -0.25 at the set stance, falling to -0.45 by
    // the end of that window, and is not required to be over the plane: at the set
    // stance the bat is cocked (the plane through its own handle tilts ~56 degrees,
    // its normal still 0.56 upward) and both elbows therefore sit on the batter's
    // side of it — the plane is a wall standing between the hands and the pitcher
    // with the whole body behind it, not a bat sweeping over anything. Enforcing
    // "over" there would mean an elbow reaching across the cocked bat toward the
    // pitcher. The rule bites once the bat is on its swing plane, and that is
    // where it is pinned.
    const LEAD_UNDER_SLACK = 0.02 // rig units a lead elbow may sit over the plane and still read "under"
    const WINDOWS = {
      load: [0, 0.22], // the set stance and the load
      push: [0.3, 0.49], // the plane is past the lead arm's own reach
      carry: [0.3, 1.09], // the bat carrying the swing through to the load
      home: [0.62, 1.0], // the two elbows unwinding across the body
      // The two bands the rules above deliberately leave out, swept only so the
      // summary reports them (see the note above).
      gap: [0.23, 0.28],
      climb: [1.02, 1.25],
    }
    await page.goto(`/e2e/harness/batter.html?phase=midSwing&time=${CONTACT_TIME_S}`)
    await page.waitForFunction(() => window.__vr?.ready === true)
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeBat', 'probeBones', 'probeSolve']),
      [0, WAY_HOME_WINDOW.end, 0.01],
    )
    expect(rows.length, 'the cycle should be swept, not sampled').toBeGreaterThan(120)

    const unit = (v) => mul(v, 1 / (norm(v) || 1))
    const cross = (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ]
    // The bat's swing plane at the bat's own handle: up is the upward half of
    // (the axis the barrel sweeps about) x (the barrel's own line).
    const planeNormal = (bat) => {
      const n = unit(cross(unit(bat.sweep), unit(bat.axis)))
      return n[1] < 0 ? mul(n, -1) : n
    }

    // One reading per sample, in the batter's own frame: each elbow's side of the
    // plane through the handle, and how far over that plane the lead shoulder sits
    // beyond what its own upper arm can span (positive = out of the elbow's
    // whole reach).
    const seen = { load: [], push: [], carry: [], home: [], gap: [], climb: [] }
    for (const row of rows) {
      const { origin, scale } = row.probeBones
      const rig = (p) => mul(sub(p, origin), 1 / scale)
      const bones = row.probeBones.bones
      const handle = rig(row.probeBat.origin)
      const n = planeNormal(row.probeBat)
      const side = (name) => dot(sub(rig(bones[name]), handle), n)
      const arm = norm(sub(rig(bones[`forearm${LEAD_SIDE}`]), rig(bones[`upper_arm${LEAD_SIDE}`])))
      // What the lead elbow's own rule left: the deepest side of the plane the
      // whole circle of elbows that arm can reach has (see probeSolve's
      // elbowDeepest). Where that is itself over the plane the arm cannot get
      // under it at all, and sinking to that point *is* the rule — so a sample is
      // only an offender when the elbow is over the plane *and* not already as
      // deep as its own reach goes.
      // The lead elbow is read the *driver's* way for the rule below — its side
      // of the plane is taken from the grip the arm is holding, and how deep its
      // own circle goes from the same origin — because the two have to be
      // compared with each other: the suite's own reading of the side is taken
      // from the bat's handle instead, a fixed shift away, which would make the
      // circle's deepest look a different distance deep than the elbow it put
      // there. The bones' own reading is still what the *spans* above use, and
      // the trail elbow's rule below.
      const lead = row.probeSolve.arms.find((entry) => entry.side === -1)
      const reading = {
        time: row.time,
        lead: side(`forearm${LEAD_SIDE}`),
        leadSolved: lead ? lead.elbowOverPlane : 0,
        trail: side(`forearm${TRAIL_SIDE}`),
        beyond: side(`upper_arm${LEAD_SIDE}`) - arm,
        deepest: lead ? lead.elbowDeepest : 0,
      }
      for (const [name, [from, to]] of Object.entries(WINDOWS)) {
        if (row.time >= from && row.time <= to) seen[name].push(reading)
      }
    }
    const span = (name, key) => {
      const values = seen[name].map((reading) => reading[key])
      return `${Math.min(...values).toFixed(2)}..${Math.max(...values).toFixed(2)}`
    }
    const offenders = (name, key, bound) =>
      seen[name]
        .filter((reading) => {
          if (key !== 'lead') return reading[key] <= bound
          // Over the plane and not already as deep as its own circle reaches
          // (both read the driver's way, off the same origin): that, and only
          // that, is a lead elbow the rule failed to sink.
          return reading.leadSolved > bound
            && reading.leadSolved - reading.deepest > bound
        })
        .map((reading) => `${reading.time.toFixed(2)}s ${reading[key].toFixed(3)}`)
    console.log(
      `the bat's own plane, ${rows.length} samples at 0.01 s — the load: lead ${span('load', 'lead')} ` +
        `trail ${span('load', 'trail')}; the push: lead ${span('push', 'lead')} with the plane ` +
        `${span('push', 'beyond')} rig past that arm's whole reach; the carry: trail ` +
        `${span('carry', 'trail')}; the way home: lead ${span('home', 'lead')} trail ${span('home', 'trail')}; ` +
        `outside them the wind-up reads lead ${span('gap', 'lead')} trail ${span('gap', 'trail')} and the bat ` +
        `climbing back over the shoulder reads lead ${span('climb', 'lead')} trail ${span('climb', 'trail')}`,
    )
    expect(
      offenders('load', 'lead', LEAD_UNDER_SLACK).concat(offenders('home', 'lead', LEAD_UNDER_SLACK)),
      'the lead elbow should stay under the plane the bat swings in, at the load and on the way home, '
        + 'and at the deepest reach of its own circle wherever the arm cannot get under it at all',
    ).toEqual([])
    expect(
      offenders('carry', 'trail', 0),
      'the trail elbow should stay over that plane from contact through to the load',
    ).toEqual([])
    expect(
      offenders('push', 'beyond', 0),
      "the plane should be past the lead arm's own reach through the push to contact",
    ).toEqual([])
    // Non-vacuous: every window has to actually bind, and each has to be read over
    // real samples — a window that quietly emptied would otherwise pass.
    for (const name of Object.keys(WINDOWS)) {
      expect(seen[name].length, `the ${name} window should be swept, not skipped`).toBeGreaterThanOrEqual(5)
    }
  })

  test('the lead wrist keeps to the region between the bat plane and the ground', async ({ page }) => {
    // The forearm has two ends, and the test above rules on only one of them: the
    // lead *elbow* belongs under the bat's plane, and the lead *wrist* — the arm's
    // other end, and the end nearer the bat — belongs in the region between that
    // plane and the ground. Both readings are the driver's own, off the grip the
    // arm is holding (`wristOverPlane`, `elbowOverPlane`): positive is over the
    // plane the bat lies in, whose "up" is the upward half of the barrel's own
    // square.
    //
    // What can put the wrist there is the fist's *roll*. The wrist is the grip
    // less the fist's own reach, and a roll turns that reach about the barrel — so
    // the wrist runs round the handle, and its side of the plane is a cosine in the
    // roll. The reach can always get under the plane: measured, the deepest any
    // turn at all could put the lead wrist is -0.127 rig units at every sample of
    // the cycle. So this is a rule about the fist's *window* rather than about the
    // pose's geometry, and the arm solve spends that window on it (see `fistRoll`):
    // within GRIP_ROLL_MAX of the pose's own turn of the fist, the roll holds the
    // plane wherever it can, and where it cannot it is as deep as the window goes
    // — which is what `wristWindowDeepest` reads back.
    //
    // Measured over the cycle: the lead wrist sits over the plane on 19 samples of
    // 67, every one of them inside the two bands the elbow's own test leaves
    // unenforced — the wind-up's turn onto the plane (0.22-0.28 s, where the plane
    // itself sweeps down across the arm) and the push to contact (0.30-0.51 s, where
    // it is past the arm's whole reach) — and in every one of them the window is
    // spent to within 0.002 rig units. Everywhere else the rule holds: the set
    // stance and the load, the carry and the hold, and every sample of the way home.
    const LEAD_UNDER_SLACK = 0.02 // rig units a lead wrist may sit over the plane and still read "under"
    // The windows the rule is *pinned* over, which are the elbow's own: the pose a
    // viewer reads before the swing starts, and the way home. Both the bands left
    // between them are the ones the plane sweeps across the arm in (see the test
    // above), and both are reported rather than asserted.
    const HOLD_WINDOWS = { load: [0, 0.22], home: [0.62, 1.0] }
    await page.goto(`/e2e/harness/batter.html?phase=midSwing&time=${CONTACT_TIME_S}`)
    await page.waitForFunction(() => window.__vr?.ready === true)
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeSolve']),
      [0, WAY_HOME_WINDOW.end, 0.01],
    )
    expect(rows.length, 'the cycle should be swept, not sampled').toBeGreaterThan(120)
    const lead = []
    for (const row of rows) {
      const arm = row.probeSolve.arms.find((entry) => entry.lead)
      if (!arm) continue
      lead.push({
        time: row.time,
        over: arm.wristOverPlane,
        window: arm.wristWindowDeepest,
        reach: arm.wristDeepest,
      })
    }
    expect(lead.length, 'the lead arm should be solved at every sample').toBe(rows.length)
    const over = lead.filter((reading) => reading.over > LEAD_UNDER_SLACK)
    const inWindow = (reading, [from, to]) => reading.time >= from && reading.time <= to
    const held = []
    for (const [name, window] of Object.entries(HOLD_WINDOWS)) {
      held.push(...lead.filter((reading) => inWindow(reading, window)))
    }
    const span = (list) => (list.length
      ? `${Math.min(...list.map((r) => r.over)).toFixed(3)}..${Math.max(...list.map((r) => r.over)).toFixed(3)}`
      : 'none')
    console.log(
      `the bat's plane and the lead wrist, ${lead.length} samples at 0.01 s: the load and the way home read `
      + `${span(held)} (${held.length} samples), the rest of the cycle reads `
      + `${span(lead.filter((r) => !held.includes(r)))}; over the plane: ${over.length} samples reading `
      + `${span(over)}, with the fist's own window reaching `
      + `${over.length ? Math.max(...over.map((r) => r.window)).toFixed(3) : 'n/a'} at its deepest`,
    )
    // The rule itself: a wrist over the plane is only allowed where the fist's own
    // whole turn could not have put it under — over it *and* not already as deep as
    // that turn goes.
    expect(
      over
        .filter((reading) => reading.over - reading.window > LEAD_UNDER_SLACK)
        .map((reading) => `${reading.time.toFixed(2)}s ${reading.over.toFixed(3)} over, window ${reading.window.toFixed(3)}`),
      "the lead wrist should be in the region between the bat's plane and the ground wherever a fist's own "
        + 'turn can put it there, and spend that whole turn wherever it cannot',
    ).toEqual([])
    // ...and the samples the rule cannot hold are the two bands the plane sweeps
    // across the arm, not a silent hole anywhere else.
    expect(
      over
        .filter((reading) => Object.values(HOLD_WINDOWS).some((window) => inWindow(reading, window)))
        .map((reading) => `${reading.time.toFixed(2)}s`),
      'the lead wrist should be under the plane at the load and on the way home',
    ).toEqual([])
    // The reach itself can always get under the plane (above): a pose it could not
    // would make every reading below vacuous, so it is pinned too.
    expect(
      lead.filter((reading) => reading.reach > 0).map((reading) => `${reading.time.toFixed(2)}s`),
      "the fist's own reach should be able to put the lead wrist under the plane at every sample",
    ).toEqual([])
    // Non-vacuous: the over-band has to be real, and the rule has to bite on either
    // side of it.
    expect(over.length, 'the wind-up and the push should be samples the rule cannot hold').toBeGreaterThan(5)
    expect(held.length, 'the pinned windows should be swept, not skipped').toBeGreaterThan(50)
  })

  test('each wrist closes on the bat inside its own bend and twist', async ({ page }) => {
    // Two limits ride on the grip, and both are read here off the driver's own
    // report of what it left (see probeSolve), sample by sample through the
    // whole cycle:
    //
    //   the *twist* — how far the hand is rolled about the forearm's own live
    //   axis — is ±10°, the forearm taking everything past that as pronation. It
    //   is the hard one: measured over 280 samples of the cycle both wrists sit
    //   inside 10.01° at every one of them, the trail at exactly 10.00 through
    //   the whole carry where the grip asks for more than the joint has.
    //
    //   the *bend* — the hand's own direction against the forearm's, the angle a
    //   wrist is bent through — is 30°. It cannot be held everywhere, and the
    //   reason is the pose's rather than the solve's: a fist closed on a handle
    //   has its knuckles' line square across the bat (measured, the hand's own
    //   direction is 89.3° off the barrel at every sample), so the bend bottoms
    //   out at |89.3° − the forearm's own angle off the barrel|. That is under 30
    //   whenever the forearm is 60-120° off the bat, which is the swing proper;
    //   through the load and the way home the forearm lies nearer along the bat
    //   (measured, 44° at the hold) and no roll and no elbow on the arm's own
    //   circle can close the gap.
    //
    // So the bend is pinned exactly where it is answerable: at every sample whose
    // own floor — the lowest bend any roll could reach at the elbow the solve
    // settled on — is inside the limit, the wrist's bend has to be inside it too
    // (within a couple of degrees, which is what the roll's damped step leaves).
    // Every sample where the bend is over the limit is required to be one whose
    // floor is over it as well: the arm's own reach, not a limit the solve let go.
    // Where the floor is over it, the sample is reported rather than asserted, so
    // the window a pose change opens up shows in the summary.
    const BEND_SLACK = (5 * Math.PI) / 180 // what the roll's own step may leave on the table
    await page.goto(`/e2e/harness/batter.html?phase=midSwing&time=${CONTACT_TIME_S}`)
    await page.waitForFunction(() => window.__vr?.ready === true)
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeBones', 'probeSolve']),
      [0, WAY_HOME_WINDOW.end, 0.01],
    )
    expect(rows.length, 'the cycle should be swept, not sampled').toBeGreaterThan(120)
    const deg = (rad) => (rad * 180) / Math.PI
    const fold = (rad) => Math.atan2(Math.sin(rad), Math.cos(rad))
    const unit = (v) => {
      const length = Math.hypot(v[0], v[1], v[2]) || 1
      return [v[0] / length, v[1] / length, v[2] / length]
    }
    const twisters = []
    const lost = []
    const overReach = []
    const naughty = []
    let worstMismatch = 0
    let worstAt = 0
    for (const row of rows) {
      const { origin, scale } = row.probeBones
      const rig = (p) => [(p[0] - origin[0]) / scale, (p[1] - origin[1]) / scale, (p[2] - origin[2]) / scale]
      const bones = row.probeBones.bones
      for (const [side, label] of [['L', 'left'], ['R', 'right']]) {
        const solve = row.probeSolve.arms.find((arm) => arm.side === (side === 'L' ? -1 : 1))
        if (!solve) continue
        // The driver's own report against the bones it was posed into: the two
        // readings are the same quantity, so a divided solve would show up here
        // rather than only in the glasses — measured, they agree within 4.03°.
        const elb = rig(bones[`forearm${side}`])
        const wri = rig(bones[`hand${side}`])
        const fin = rig(bones[`fingers${side}`])
        const foreAim = unit([wri[0] - elb[0], wri[1] - elb[1], wri[2] - elb[2]])
        const handAim = unit([fin[0] - wri[0], fin[1] - wri[1], fin[2] - wri[2]])
        const bonesBend = Math.acos(Math.min(1, Math.max(-1,
          handAim[0] * foreAim[0] + handAim[1] * foreAim[1] + handAim[2] * foreAim[2])))
        // The driver's own reading against the bones' — the same angle read twice,
        // once from the model and once from the pose it left. It is a *reported*
        // number rather than an asserted one because the one window where the two
        // decide against each other is the window the arm is at its own limit: the
        // worst gap measured is 12.87° at 0.21s, against the 18.6° a model reading
        // the wrong elbow at all used to leave here.
        const gap = Math.abs(deg(solve.wristBend) - deg(bonesBend))
        if (gap > worstMismatch) {
          worstMismatch = gap
          worstAt = row.time
        }
        const twist = Math.abs(fold(solve.wristTwist))
        if (twist > WRIST_TWIST_MAX + (0.5 * Math.PI) / 180) {
          twisters.push(`the ${label} wrist at ${row.time.toFixed(2)}s: ${deg(solve.wristTwist).toFixed(1)}°`)
        }
        const bend = solve.wristBend
        // The floor has to be a floor: it is the lowest bend the walk found anywhere
        // on the circle of elbows that arm can reach, so a floor above the bend the
        // solve left would mean the two are read off different arms — a few degrees
        // over is the model's own error (the floor is forecast from the model's
        // elbow, the bend measured on the bones), which is why this is reported
        // rather than asserted.
        if (solve.bendFloor > bend + (2 * Math.PI) / 180) {
          naughty.push(`${label} ${row.time.toFixed(2)}s floor ${deg(solve.bendFloor).toFixed(0)}° `
            + `bend ${deg(bend).toFixed(0)}°`)
        }
        if (bend > WRIST_BEND_MAX + BEND_SLACK) {
          if (solve.bendFloor <= WRIST_BEND_MAX - BEND_SLACK) {
            lost.push(`the ${label} wrist at ${row.time.toFixed(2)}s: bend ${deg(bend).toFixed(1)}°, `
              + `floor ${deg(solve.bendFloor).toFixed(1)}°`)
          } else {
            overReach.push(`${row.time.toFixed(2)}s ${deg(solve.bendFloor).toFixed(0)}°`)
          }
        }
      }
    }
    console.log(
      `the two wrists, ${rows.length * 2} readings — over the 30° bend with a floor that could have held `
        + `it: ${lost.length}; over it where the arm's own reach could not `
        + `(the sample and the floor that arm had): ${overReach.length} `
        + `[${[...new Set(overReach)].slice(0, 8).join(' ')}]; the twist outside ±10°: ${twisters.length}; `
        + `the driver's own reading against the bones: ${worstMismatch.toFixed(2)}° at ${worstAt.toFixed(2)}s; `
        + `floors above the bend they belong to: ${naughty.length} [${naughty.slice(0, 4).join('; ')}]`,
    )
    expect(twisters, 'a wrist rolled more than ±10° about its own forearm').toEqual([])
    expect(lost, 'a wrist bent past 30° where the arm itself could have closed the gap').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The swing's joints, sampled finely.
//
// How fast the bat travels is one thing; a *joint* that cannot hold a direction is
// another, and it is the one the eye reads as a jerk. The trailing forearm used to
// turn over about its own elbow through the follow-through -- 136 to 151 degrees,
// reversing every few frames -- and nothing here caught it: every other test reads
// a pose at a moment, or sweeps one quantity against a bound, and a limb that
// changes its mind three times between two poses leaves both poses exactly where
// they were. So the whole swing cycle is swept at 0.005 s (from the swing's own
// start through the end of the hold: the way home *reverses* the swing on purpose,
// so it turns every joint again by construction) and each joint's own angle is read
// off the posed skeleton.
//
// A joint may turn -- an elbow bends through the load and straightens through the
// swing, which is one turn -- and it may not turn *back on itself*: a reversal pair
// close enough together (0.1 s) that the limb never settled into the new direction
// is a flick, and every joint's list of them has to be empty. The turns each joint
// is allowed are the ones the swing is authored with, listed per joint below; a
// flick of the size this is here for (the 40-degree elbow) shows up as both.
//
// The wrists are deliberately not in the set: their own angle read from bone
// positions rolls with the fist's own reference, so it turns every time the rig
// rolls the hand on the handle (measured, 10 and 11 turns at these steps). The two
// wrist tests above cover what the wrist's bend and twist may do instead.
test.describe('a limb never flickers about its own joint', () => {
  const STEP = 0.005
  // Under this the solve itself is breathing; the flick this is here for moved 40.
  const DEADBAND = 0.4
  // A flick is a turn *and a turn back*: two reversals close enough together that
  // the angle never settled, with both legs visible.
  const FLICK_LEG_DEG = 8
  const FLICK_WITHIN_S = 0.1
  const JOINTS = {
    elbowL: (b) => [b.forearmL, b.upper_armL, b.handL],
    elbowR: (b) => [b.forearmR, b.upper_armR, b.handR],
    shoulderL: (b) => [b.shoulderL, b.spine002, b.upper_armL],
    shoulderR: (b) => [b.shoulderR, b.spine002, b.upper_armR],
    kneeL: (b) => [b.shinL, b.thighL, b.footL],
    kneeR: (b) => [b.shinR, b.thighR, b.footR],
    hipL: (b) => [b.thighL, b.spine, b.shinL],
    hipR: (b) => [b.thighR, b.spine, b.shinR],
    spine: (b) => [b.spine001, b.spine, b.spine002],
    neck: (b) => [b.neck, b.spine002, b.spine006],
  }
  // What each joint's own angle does over the swing cycle: the swing's own loading
  // and turn (knees, hips), the arms straightening and coming round, the chest
  // turning back under. These are the counts this build reads, one turn of headroom
  // each rather than a number nothing can reach: a change that adds a turn to a joint
  // fails here, next to the flick check that catches the ones that turn back where
  // they came from. (Measured on the build this was written against: elbowL 8,
  // elbowR 4, shoulderL 5, shoulderR 1, knees 0/0, hipL 0, hipR 5, spine 3, neck 0.)
  const TURN_BUDGET = {
    elbowL: 9, elbowR: 5, shoulderL: 6, shoulderR: 2,
    kneeL: 1, kneeR: 1, hipL: 1, hipR: 6, spine: 4, neck: 1,
  }

  test('no joint turns back on itself between the swing and the hold', async ({ page }) => {
    await openPhase(page, 'followThrough')
    const rows = await page.evaluate(
      ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeBones']),
      [SWING_START_S, HOLD_END_S, STEP],
    )
    const angleAt = ([apex, a, c]) => {
      const u = sub(a, apex)
      const v = sub(c, apex)
      const cosine = dot(u, v) / (norm(u) * norm(v) || 1)
      return degrees(Math.acos(Math.min(1, Math.max(-1, cosine))))
    }
    // Every turn the angle makes, with how far it travelled to get there: the leg's
    // excursion is what tells a flick from a joint honestly changing direction.
    const turns = (sequence) => {
      const out = []
      let direction = 0
      let start = sequence[0].angle
      let extreme = sequence[0]
      for (const point of sequence) {
        if (direction === 0) {
          if (Math.abs(point.angle - start) > DEADBAND) {
            direction = Math.sign(point.angle - start)
            extreme = point
          }
          continue
        }
        const delta = point.angle - extreme.angle
        const back = direction > 0 ? delta < -DEADBAND : delta > DEADBAND
        if (back) {
          out.push({
            time: extreme.time,
            excursion: Math.abs(extreme.angle - start),
          })
          direction = -direction
          start = extreme.angle
          extreme = point
        } else if (Math.sign(delta) === direction) {
          extreme = point
        }
      }
      return out
    }

    const offenders = []
    console.log(`swept the swing cycle ${SWING_START_S}-${HOLD_END_S}s at ${STEP}s:`)
    for (const [name, partsOf] of Object.entries(JOINTS)) {
      const sequence = rows.map((row) => ({
        time: row.time,
        angle: angleAt(partsOf(row.probeBones.bones)),
      }))
      const all = turns(sequence)
      const flicks = []
      for (let i = 1; i < all.length; i += 1) {
        const gap = all[i].time - all[i - 1].time
        const leg = Math.min(all[i].excursion, all[i - 1].excursion)
        if (gap <= FLICK_WITHIN_S && leg > FLICK_LEG_DEG) {
          flicks.push(`${all[i - 1].time.toFixed(3)}s (${leg.toFixed(0)}deg in ${(gap * 1000).toFixed(0)}ms)`)
        }
      }
      console.log(
        `  ${name.padEnd(9)} turns ${String(all.length).padStart(2)} of ${TURN_BUDGET[name]} ` +
        `(over 2deg: ${all.filter((t) => t.excursion > 2).length}) · flicks ${flicks.length}`,
      )
      expect(
        all.length,
        `${name}: the joint should not turn more often than the swing asks it to`,
      ).toBeLessThanOrEqual(TURN_BUDGET[name])
      if (flicks.length) offenders.push(`${name}: ${flicks.join(' ')}`)
    }
    expect(offenders, 'a joint turned back on itself inside the swing').toEqual([])
  })
})

test.describe("the batter's kit", () => {
  // The look pass (src/util/batterLook.js) shapes the helmet, the eyes and the
  // jersey. These read the shipped model's own geometry — every separate shell of
  // each mesh, in the model's rest frame, in which the model's own +x is its left —
  // rather than the pass's report of what it did, so the numbers below are facts
  // about the kit rather than about the code that made it.
  //
  // A flap is a shell that hangs below the crown and lies wholly on one side of
  // the midline; the brim is what juts to the front-most z, and its underside is
  // the lowest vertex of the helmet drawn that far forward.
  const FLAP_MIN_VERTS = 8
  const FLAP_TOP_MAX_Y = 1.86
  const FLAP_SIDE_MIN_X = 0.04
  // What the eyes have to be: clear of the brim, and the reference's own size. The
  // body-parts model's eye is 0.265 of its head's height and this head is 0.355
  // tall, so the reference's own eye would be 0.094 here; this one reads 0.104,
  // a shade bigger, which is what was asked for.
  const EYE_CLEARANCE_M = 0.005
  const EYE_HEIGHT_RANGE = [0.085, 0.13]
  // A uniform shrink keeps the modelled plate's own shape: its width was 0.515 of
  // its height.
  const EYE_ASPECT_RANGE = [0.45, 0.6]
  // What the eyes have to do about the head they are on. A plate is flat and the face
  // is not, so a plate laid on it sinks in at its edges — measured off the shipped
  // model's own surfaces, *half* of each eye's 53 vertices (36 of them) were inside the
  // head, up to 0.026 rig deep at the inner corner, and what is inside the head is not
  // drawn. So every eye vertex has to be in front of the head's own surface at its place
  // on the face, by a hair at least.
  const EYE_CLEAR_MIN = 0.001
  // The jersey's opening: a line drawn on the cloth down the chest, from the belt (the
  // trunks' band runs y 1.258-1.293) up to the collar's crease at 1.58, with hollow
  // buttons beside it from the top of it to the bottom. A *line*: measured, the ribbon
  // it replaced was 0.007 rig across, and a line on a chest this size is a third of that.
  const LINE_WIDTH_MAX = 0.005
  const LINE_BOTTOM_MAX_Y = 1.296 // it has to reach the belt...
  const LINE_TOP_MIN_Y = 1.54 // ...and up to the jersey's own collar...
  const LINE_TOP_MAX_Y = 1.5544 // ...whose rim is here: the neck and the jaw are above it
  const BUTTONS_MIN = 6 // from top to bottom, not clustered in the middle
  // ...and that it reads along its whole length: down to the belt, nearly every vertex of
  // it with cloth behind it, and never stepping back into the body where the cloth's own
  // front has stopped.
  const LINE_READ_BOTTOM_MAX_Y = 1.3
  const LINE_READ_MIN = 160 // of the opening's and the buttons' own 194 vertices
  const LINE_STATIONS_MIN = 20 // the line's own stations, from the belt to the collar
  const LINE_STEP_BACK_MAX = 0.02
  const BUTTON_REACH_MAX = 0.08 // read off vertices rather than off the surface, the cloth
  // ...runs up to this far from any one of them where the chest is coarse
  const BUTTON_END_MARGIN = 0.02 // the first and last sit within this of the line's own ends
  const BUTTON_GAP_MAX = 0.05 // standing off the cloth, but within a touch of it
  // The opening's own grey: a seam in pale-blue cloth is *darker* than the cloth it is
  // sewn in. Measured, the cloth is 0.69 in luminance, and the grey the opening used to
  // be drawn in — 0.78 of the cloth for the seam and 0.94 for the buttons, 0.54 and
  // 0.65 — was lighter than the cloth's own shading and did not read on it. Both are
  // darker than this now.
  const OPENING_GREY_MAX = 0.6
  // The brows: one over each eye, in the face's own tone taken down. Measured, the face
  // is 0.775 in luminance and the eyes are painted black at 0.05, so a brow has to sit
  // between the two of them to read as a brow rather than as more face or more eye.
  const BROWS_MIN = 2
  // Dark: a brow is nearer the painted eye below it than the skin around it. Measured,
  // the face is 0.775 in luminance, the eye 0.05, and the brow 0.161 — against 0.226
  // when it was first drawn, which read as barely darker than the skin it sits on.
  const BROW_GREY_MAX = 0.2
  const BROW_WIDTH_MIN = 0.05 // wide enough to be a brow over an eye 0.054 rig wide
  const BROW_HEIGHT_MIN = 0.012
  const BROW_OUT_MIN = 0.018 // how far past the corner of its eye it runs, towards the ear
  // ...and the skin the brow sits over: measured, the strip above an eye used to be
  // 0.008 rig with the brow laid from there, and the eye and the brow read as one shape.
  // A brow *above* its eye needs a band of face between the two of them.
  const BROW_SKIN_MIN = 0.009
  const BROW_SKIN_MAX = 0.02
  const BROW_REACH_MAX = 0.04 // how far its own ends may be from the nearest body vertex
  // The shoes: laces across the instep with a tongue under them, and nothing worn above
  // the shoe's own rim — the trousers already cover the leg down past it. Measured, the
  // kit used to wear a white band above each ankle (a cuff above the rim with a collar
  // over the shoe's own opening), and its laces — twelve bars of them — were wound
  // face-down into the shoe, so the renderer never drew one of them.
  const LACE_BARS_MIN = 10 // five a foot, evenly spaced down the instep
  const TONGUES_MIN = 2 // and a tongue down each instep, under the laces
  const SHOE_GAP_MAX = 0.05

  const readKit = async (page) => {
    const kit = await page.evaluate(() => window.__vr.probeKit())
    expect(kit, 'the batter should be in the harness scene with its kit on').not.toBeNull()
    return kit
  }

  test('the helmet carries one ear flap, on the pitcher side, over the jaw', async ({ page }) => {
    await openPhase(page, 'stance')
    const kit = await readKit(page)
    const flaps = kit.helmet.shells.filter((shell) => shell.verts >= FLAP_MIN_VERTS
      && shell.box.y[1] < FLAP_TOP_MAX_Y
      && (shell.box.x[0] >= FLAP_SIDE_MIN_X || shell.box.x[1] <= -FLAP_SIDE_MIN_X))
    console.log(`the helmet's shells (${kit.helmet.shells.length}), flaps at ${flaps
      .map((flap) => `x[${flap.box.x}] y[${flap.box.y}] z[${flap.box.z}]`).join(' ')}`)
    console.log(`the ear cover either side: ${JSON.stringify(kit.helmet.earCover)}`)
    expect(
      flaps.length,
      'a batting helmet has one ear flap, not two and not none',
    ).toBe(1)
    // A right-handed batter turns his left side to the pitcher and wears the flap
    // over that ear; a lefty wears it over the other one. The model's own +x is
    // its left, so the flap has to be on the side the lead arm is on.
    const [flap] = flaps
    const leadIsModelLeft = BAT_SIDE !== 'L'
    const onLeadSide = leadIsModelLeft ? flap.box.x : flap.box.x.map((x) => -x)
    expect(
      onLeadSide[0],
      `the flap belongs over the ear on the pitcher's side (batting ${BAT_SIDE})`,
    ).toBeGreaterThanOrEqual(FLAP_SIDE_MIN_X)
    // A jaw guard, not an ear muff: the guard comes down level with the jaw (measured,
    // its lowest vertex is at 1.5467, against 1.5652 where the shipped one stopped —
    // the head's own ear runs y 1.7346 to 1.8165, so it hangs clear of it), and the
    // deepest part of it flares forward over the cheek as it goes (z 0.207 against
    // 0.1966, the brim's own front being 0.2318).
    // The head's own ear, as the model has it: y 1.7346 to 1.8165 at |x| 0.147 to
    // 0.1725, z -0.0187 to 0.0531. Half of it is 1.7756, and that is where the shell's
    // lower edge belongs on the side that carries no flap.
    const EAR_LOW_Y = 1.7346
    const EAR_MID_Y = 1.7756
    const EAR_HIGH_Y = 1.8165
    const { lead, trail } = kit.helmet.earCover
    console.log(`the ear cover: lead hangs to ${lead.hungY} (${lead.belowBrim} below the brim)
      and over the ear to ${lead.earY}; trail to ${trail.hungY} (${trail.belowBrim}) and over
      the ear to ${trail.earY}; rims ${JSON.stringify({ lead: lead.rim, trail: trail.rim })}`)
    expect(
      flap.box.y[0],
      'the guard should come down to the jaw, not stop at the ear',
    ).toBeLessThanOrEqual(1.555)
    expect(lead.hungY, 'and be the lowest thing the helmet draws on that side')
      .toBeLessThanOrEqual(1.555)
    // The ear cover that goes: the helmet hangs off the brim beside each ear, and the
    // one a batting helmet does *not* have is still the one that read as a rear flap
    // when only the flap shell and the lobe had been taken off — the rim they left
    // behind went down to 1.6442, 0.15 below the brim, beside that ear. So on the
    // trailing side the shell has to stop above the ear, with the nape behind it left to
    // the helmet's own back.
    expect(
      trail.belowBrim,
      'the trailing side should carry no ear cover: its rim sweeps into the nape',
    ).toBeLessThan(0.16)
    // ...and nothing hangs below the line it comes off by: the shell's own lower edge on
    // that side *is* that line, because the cover is folded back up onto it rather than
    // cut off (the band and the shell it hangs from are one surface, so a cut leaves
    // either a ragged rim or — measured, until this was changed — a plate of the cover
    // hanging 0.162 rig below the line, a jaw guard where there is no flap). The line
    // reaches the nape's own height at its lowest, 1.6584, and the mesh's own resolution
    // leaves the rim a hair above that.
    expect(
      trail.hungY,
      'and nothing of the helmet should hang below the nape\'s own line behind the ear',
    ).toBeGreaterThan(1.65)
    expect(
      trail.hungY,
      'the trailing rim should be the fold line itself, not a cover left hanging under it',
    ).toBeLessThan(1.7)
    expect(trail.hungY, 'the two sides should not read like a pair')
      .toBeGreaterThan(lead.hungY + 0.08)
    // How much of that ear the shell covers. A rim hung to the ear's own bottom (where
    // the first pass put it, at 1.72) is not a rim at all: it is a lobe of shell hanging
    // 0.075 below the brim beside an ear that has no flap over it, which reads as a jaw
    // guard — measured, that is what a rim at the ear's bottom looked like. So the edge
    // comes down to the *middle* of the ear: the top half of it covered, the bottom half
    // showing below.
    expect(
      trail.earY,
      'the trailing side still carries a cover over the whole ear where it has no flap',
    ).toBeGreaterThan(EAR_LOW_Y + 0.02)
    expect(
      trail.earY,
      'and it should not stop above the ear either: half of it is covered',
    ).toBeLessThan(EAR_HIGH_Y - 0.02)
    expect(
      Math.abs(trail.earY - EAR_MID_Y),
      'the edge over the ear should sit at the ear\'s own middle, half of it either side',
    ).toBeLessThan(0.02)
    // Where the cover came off, the helmet's own edge sweeps: lowest over the ear's own
    // middle, up in front of it to meet the brim's underside, and away behind it into the
    // nape. This is the shape — an edge run *level* past the ear is a straight line with
    // a step at either end, which is what reads as a cutout, and one cut with a step in it
    // reads a jump between two of these windows. All three are read on the same side, off
    // the vertices the helmet actually draws.
    expect(
      trail.rim.forward - trail.rim.beside,
      'the trailing rim should rise going forward, not run level past the ear',
    ).toBeGreaterThan(0.008)
    expect(
      trail.rim.beside - trail.rim.behind,
      'and fall away behind the ear into the nape, which is the helmet\'s own back',
    ).toBeGreaterThan(0.05)
  })

  test("the eyes sit clear under the brim and on the face, at the reference's own size", async ({ page }) => {
    await openPhase(page, 'stance')
    const kit = await readKit(page)
    // The brim is the shell that juts to the helmet's own front-most z — read as the
    // front-most rather than as a number, so a flap that flares out past it is caught by
    // the eye assertions below rather than quietly becoming "the brim".
    const frontZ = Math.max(...kit.helmet.shells.map((shell) => shell.box.z[1]))
    const forward = kit.helmet.shells.filter((shell) => shell.box.z[1] >= frontZ - 0.005)
    expect(forward.length, 'the helmet should have a brim jutting forward').toBeGreaterThan(0)
    const brimUnderside = Math.min(...forward.map((shell) => shell.box.y[0]))
    const eyes = kit.eyes
    const heightOf = (eye) => eye.box.y[1] - eye.box.y[0]
    const widthOf = (eye) => eye.box.x[1] - eye.box.x[0]
    console.log(`brim underside ${brimUnderside.toFixed(4)}; eyes: ${eyes
      .map((eye) => `${heightOf(eye).toFixed(4)}x${widthOf(eye).toFixed(4)} top ${eye.box.y[1].toFixed(4)}, `
        + `${eye.buried} of ${eye.verts} behind the head (worst ${eye.deepest}), margin ${eye.margin}`)
      .join(' | ')}`)
    expect(eyes.length, 'there are two eyes on the face').toBe(2)
    for (const eye of eyes) {
      expect(
        eye.box.y[1],
        'an eye must not reach up behind the brim, where the helmet hides it',
      ).toBeLessThanOrEqual(brimUnderside - EYE_CLEARANCE_M)
      expect(heightOf(eye), 'the eye should read like the reference model\'s, not smaller')
        .toBeGreaterThanOrEqual(EYE_HEIGHT_RANGE[0])
      expect(heightOf(eye), 'and not so big that the helmet swallows it')
        .toBeLessThanOrEqual(EYE_HEIGHT_RANGE[1])
      expect(
        widthOf(eye) / heightOf(eye),
        'the plate should keep its own shape (the shrink is uniform)',
      ).toBeGreaterThanOrEqual(EYE_ASPECT_RANGE[0])
      expect(widthOf(eye) / heightOf(eye)).toBeLessThanOrEqual(EYE_ASPECT_RANGE[1])
      // ...and it has to be *out* of the face it is drawn on. The plate is flat and the
      // face is not; as they shipped, half of each eye was inside the head (36 of 53
      // vertices, 0.026 rig deep at the inner corner, where the nose and the cheek are).
      expect(
        eye.buried,
        'no part of an eye may sit inside the head, where it is not drawn',
      ).toBe(0)
      expect(
        eye.margin,
        'every vertex should be in front of the face it is drawn on',
      ).toBeGreaterThanOrEqual(EYE_CLEAR_MIN)
    }
    expect(
      Math.abs(heightOf(eyes[0]) - heightOf(eyes[1])),
      'the two eyes are the same eye mirrored',
    ).toBeLessThan(0.002)
  })

  test('the jersey carries a placket on its front, with buttons', async ({ page }) => {
    await openPhase(page, 'stance')
    const kit = await readKit(page)
    const jersey = kit.jersey
    expect(jersey, 'the jersey should have a front on it').not.toBeNull()
    const line = jersey.shells.reduce((a, b) => (b.verts > a.verts ? b : a))
    // A button is a ring, so its own piece has all of its vertices a little way out from
    // its centre with the cloth showing through the hole; the two readings are taken off
    // the same shells, in the same order.
    const buttons = jersey.shells
      .map((shell, at) => ({ shell, piece: jersey.pieces[at] }))
      .filter(({ shell, piece }) => shell !== line && piece && piece.inner >= 0.003 && piece.outer <= 0.02)
    const rings = buttons.map(({ piece }) => piece)
    console.log(`the jersey's opening: ${(line.box.x[1] - line.box.x[0]).toFixed(4)} across, `
      + `y ${line.box.y[0]}-${line.box.y[1]}; ${rings.length} buttons from `
      + `${buttons.length ? Math.min(...buttons.map(({ shell }) => shell.box.y[0])).toFixed(4) : '-'} to `
      + `${buttons.length ? Math.max(...buttons.map(({ shell }) => shell.box.y[1])).toFixed(4) : '-'}`)
    expect(jersey.parent, 'the detail is skinned with the body it sits on')
      .toBe(kit.body.parent)
    expect(jersey.boundToBody, 'and rides the body\'s own skeleton').toBe(true)
    expect(jersey.vertexColors, 'the opening is drawn in the uniform\'s own greys')
      .toBe(true)
    // The opening is a *line* on the cloth, not a ribbon laid on it: down the middle of
    // the chest, from the belt up under the collar. Measured, the ribbon it replaced was
    // 0.007 rig across and stopped short of both ends (y 1.302 to 1.576).
    expect(line.box.x[1] - line.box.x[0], 'a line, not a strip of fabric')
      .toBeLessThanOrEqual(LINE_WIDTH_MAX)
    expect(line.box.x[1] - line.box.x[0], 'but drawn, not invisible').toBeGreaterThan(0)
    expect(Math.abs((line.box.x[0] + line.box.x[1]) / 2), 'down the middle of the chest')
      .toBeLessThanOrEqual(0.01)
    expect(line.box.y[0], 'from the belt').toBeLessThanOrEqual(LINE_BOTTOM_MAX_Y)
    expect(line.box.y[1], 'to the collar').toBeGreaterThanOrEqual(LINE_TOP_MIN_Y)
    // ...and *to the jersey's* collar, not past it. The neck's own front stands proud of
    // the collar (z 0.1003 against 0.0143 at y 1.5586) and the jaw is above that, so an
    // opening read off the body's front near the midline climbs off the jersey and onto
    // the face — which is where this line used to run, up to 1.588.
    expect(
      line.box.y[1],
      'the opening must stop at the jersey\'s own collar, not climb onto the neck and jaw',
    ).toBeLessThanOrEqual(LINE_TOP_MAX_Y)
    // The buttons, hollow rings beside it, from the top of the line to the bottom: what
    // was asked for is a column down the opening, not a few gathered at the chest.
    expect(rings.length, 'a column of buttons down the opening').toBeGreaterThanOrEqual(BUTTONS_MIN)
    for (const ring of rings) {
      expect(ring.inner, 'a button is a ring, not a disc: the cloth shows through it')
        .toBeGreaterThan(0)
      expect(ring.inner / ring.outer, 'and the hole is a real one')
        .toBeLessThan(0.7)
    }
    const buttonTop = Math.max(...buttons.map(({ shell }) => shell.box.y[1]))
    const buttonBottom = Math.min(...buttons.map(({ shell }) => shell.box.y[0]))
    expect(line.box.y[1] - buttonTop, 'the top button sits at the top of the opening')
      .toBeLessThanOrEqual(BUTTON_END_MARGIN)
    expect(buttonBottom - line.box.y[0], 'and the bottom one at its bottom')
      .toBeLessThanOrEqual(BUTTON_END_MARGIN)
    // Standing off the cloth is what makes the detail read at all, and it has to hug the
    // jersey rather than hover in front of it. Read against the cloth's own *surface*,
    // which runs between its vertices: measured against the nearest vertex instead, an
    // opening drawn properly on the chest reads as sinking into it wherever the surface
    // bulges forward of the vertices on either side of the point.
    expect(jersey.surfaceOff, 'the opening should be readable against the cloth').not.toBeNull()
    console.log(`the opening stands ${jersey.surfaceOff.off[0]} to ${jersey.surfaceOff.off[1]} `
      + `rig off the cloth's own surface (${jersey.surfaceOff.count} of its vertices read)`)
    expect(
      jersey.surfaceOff.off[0],
      'every vertex of the opening should be in front of the cloth, not inside it',
    ).toBeGreaterThan(0)
    expect(jersey.surfaceOff.off[1], '...and within a touch of it, not hovering')
      .toBeLessThan(BUTTON_GAP_MAX)
    expect(jersey.standOff.gap[1], 'and near the cloth\'s own vertices as well')
      .toBeLessThan(BUTTON_REACH_MAX)
    // ...and *along the whole opening*: the cloth's own front stops below the collar, and a
    // station the cloth does not reach has to hold the height of the one below it rather
    // than fall back to a default — which is what had the opening diving a third of the way
    // into the body under the collar, 0.033 rig behind the cloth's own front, so that its
    // top three stations read nothing at all.
    expect(
      jersey.surfaceOff.fromY,
      'the opening has to read all the way down to the belt',
    ).toBeLessThanOrEqual(LINE_READ_BOTTOM_MAX_Y)
    expect(
      jersey.surfaceOff.count,
      'with nearly every vertex of it in front of the cloth',
    ).toBeGreaterThanOrEqual(LINE_READ_MIN)
    // ...and it has to run *on* the cloth the whole way up. The cloth's own front stops
    // below the collar, so a station above that holds the height of the one below it; what
    // it must not do is fall back to a default, which leaves a step in the line — measured,
    // the opening's top three stations stepped 0.031 rig *backwards* into the body and came
    // back 0.047 forward again at the collar.
    const steps = jersey.line.slice(1).map(([, z], at) => Number((jersey.line[at][1] - z).toFixed(4)))
    console.log(`the opening's own line, station by station: y ${jersey.line[0][0]} to `
      + `${jersey.line[jersey.line.length - 1][0]}, worst step backwards ${Math.max(...steps)}`)
    expect(jersey.line.length, 'the line is read station by station').toBeGreaterThanOrEqual(LINE_STATIONS_MIN)
    expect(
      Math.max(...steps),
      'no station of the opening may step backwards into the body',
    ).toBeLessThan(LINE_STEP_BACK_MAX)
    // The buttons are the opening's own tone — they are the seam's colour, sewn beside
    // it — so what is asserted is that the two agree rather than that they differ.
    expect(
      Math.abs(jersey.tones.max - jersey.tones.min),
      'the buttons and the seam are one tone, not two',
    ).toBeLessThan(0.01)
    // And both of them *dark*: a seam in pale-blue fabric reads darker than the cloth,
    // so an opening drawn lighter than the cloth it is on is not drawn at all.
    expect(jersey.tones.max, 'the opening is drawn darker than the cloth it sits on')
      .toBeLessThanOrEqual(OPENING_GREY_MAX)
  })

  test('the batter wears eyebrows, over each eye', async ({ page }) => {
    // The face has nothing drawn on it above the eyes, and the eyes are painted flat
    // black, so a brow has to be *added*: a bar over the top of each eye plate, in the
    // face's own tone taken down.
    await openPhase(page, 'stance')
    const kit = await readKit(page)
    const brows = kit.brows
    const eyes = kit.eyes
    // The brim, read the way the eyes' own test reads it: the shell that juts to the
    // helmet's own front-most z, and the lowest vertex of it.
    const frontZ = Math.max(...kit.helmet.shells.map((shell) => shell.box.z[1]))
    const brimUnderside = Math.min(...kit.helmet.shells
      .filter((shell) => shell.box.z[1] >= frontZ - 0.005)
      .map((shell) => shell.box.y[0]))
    console.log(`the brows: ${JSON.stringify(brows)}`)
    expect(brows, 'the face should wear brows').not.toBeNull()
    expect(eyes.length, 'two eyes to wear them').toBe(2)
    expect(brows.count, 'one brow per eye').toBe(BROWS_MIN)
    expect(brows.pieces.length, 'and one piece each').toBe(BROWS_MIN)
    for (const [at, brow] of brows.pieces.entries()) {
      const eye = eyes[at]
      const width = brow.box.x[1] - brow.box.x[0]
      const height = brow.box.y[1] - brow.box.y[0]
      // Over its own eye: the brow sits across the same side of the face, reaches down
      // over the eye's own top edge, and stops under the brim.
      const sameSide = (brow.box.x[0] > 0) === (eye.box.x[0] > 0)
      expect(sameSide, 'each brow is over its own eye, not the other one').toBe(true)
      expect(
        width,
        'a brow is a bar across the eye it belongs to',
      ).toBeGreaterThanOrEqual(BROW_WIDTH_MIN)
      expect(height, 'and a bar rather than a line').toBeGreaterThanOrEqual(BROW_HEIGHT_MIN)
      // A brow sits *over* its eye with skin between the two: laid on the eye's own top
      // edge the brow and the black plate below it read as one long dark shape, which is
      // what an eye with no brow above it looks like.
      expect(
        brow.box.y[0] - eye.box.y[1],
        'skin has to show between the brow and the eye it is over',
      ).toBeGreaterThanOrEqual(BROW_SKIN_MIN)
      expect(
        brow.box.y[0] - eye.box.y[1],
        '...but only a little: it is a brow over an eye, not a hat brim',
      ).toBeLessThanOrEqual(BROW_SKIN_MAX)
      expect(
        brow.box.y[1],
        'and stays under the brim, which is the whole of the room above an eye',
      ).toBeLessThanOrEqual(brimUnderside - 0.002)
      // Where the two ends of it go. A brow runs on out towards the temple and stops
      // short of the nose, so its own outer end reaches further past the corner of the
      // eye than its inner end does towards the midline — measured, 0.024 out against
      // 0.010 in, where the first pass gave both ends the same 0.016.
      const outboard = eye.box.x[1] > 0
      const outOver = outboard ? brow.box.x[1] - eye.box.x[1] : eye.box.x[0] - brow.box.x[0]
      const inOver = outboard ? eye.box.x[0] - brow.box.x[0] : brow.box.x[1] - eye.box.x[1]
      expect(
        outOver,
        'a brow should run on past the corner of its eye, towards the ear',
      ).toBeGreaterThanOrEqual(BROW_OUT_MIN)
      expect(
        outOver - inOver,
        'and reach further that way than it does in towards the nose',
      ).toBeGreaterThan(0.008)
      expect(
        inOver,
        'its inner end still reaches past the eye it is over, towards the nose',
      ).toBeGreaterThan(0)
    }
    // The two brows are the same brow mirrored, and both are hung on the face: in front
    // of the head's own surface, close to it, and in the face's own tone taken down
    // (measured, the face is 0.775 in luminance and the eyes are painted black at 0.05).
    expect(
      Math.abs(brows.pieces[0].box.x[1] + brows.pieces[1].box.x[0]),
      'the two brows are mirrored about the midline',
    ).toBeLessThan(0.002)
    expect(brows.standOff.out[1], 'a brow stands proud of the face it is drawn on')
      .toBeGreaterThan(0)
    // ...and follows it: the brow hugs the face where it crosses it, and its own ends run
    // on past the outer corner of the eye, where the face falls away behind it — so the
    // nearest *vertex* of the body is further off there than along the middle.
    expect(brows.standOff.gap[0], 'a brow hugs the face it is drawn on')
      .toBeLessThan(0.02)
    expect(brows.standOff.gap[1], '...and its own ends stay on the face as well')
      .toBeLessThan(BROW_REACH_MAX)
    expect(brows.tones.max, 'a brow is darker than the face it sits on, and lighter than the eye')
      .toBeLessThanOrEqual(BROW_GREY_MAX)
    expect(brows.tones.min, 'and not black: it is not more eye')
      .toBeGreaterThan(0.05)
  })

  test('the shoes are laced, and wear no sock above their own rim', async ({ page }) => {
    // Two things are being held here. First that the laces are *drawn*: twelve bars of
    // them were on the model and not one on screen, because a bar built across the foot
    // and along it comes out wound face-down into the shoe, which is a face the renderer
    // draws from behind and so never draws. Second that nothing is worn above the shoe's
    // own rim: measured, the trousers already cover the leg down past it (the leg shell
    // reaches y 0.2716 against the shoes' 0.2992), so the band that used to sit there
    // read as a sock pulled out over the trouser rather than as part of the shoe.
    await openPhase(page, 'stance')
    const kit = await readKit(page)
    const feet = kit.feet
    const shoes = kit.shoes
    console.log(`the shoes: rim ${feet?.rim}, laces ${feet?.laceBars} `
      + `(${feet?.laceUpFaces} faces looking up), tongues ${feet?.tongues}, `
      + `pieces ${feet?.pieces}, sock bands ${feet?.sockBands} (highest ${feet?.sockTop})`)
    expect(shoes, 'the shoes should have their detail on').not.toBeNull()
    expect(feet, 'and the body its own shoes').not.toBeNull()
    expect(shoes.parent, 'the detail is skinned with the body it sits on').toBe(kit.body.parent)
    expect(shoes.boundToBody, 'and rides the body\'s own skeleton').toBe(true)
    expect(shoes.vertexColors, 'the laces are a shade of the uniform\'s own tone').toBe(true)
    // Laces across the instep: five a foot at least, which on a foot this size is a bar
    // every 0.024 rig down it. Every face of them has to look up or away from the shoe,
    // which is what the winding above is for — and what the count cannot show: they were
    // all there, and all invisible, when the winding was the other way round.
    expect(feet.laceBars, 'the shoes should be laced, not plain')
      .toBeGreaterThanOrEqual(LACE_BARS_MIN)
    expect(
      feet.laceUpFaces,
      'and every bar drawn: a lace is laid on the shoe\'s top surface, so it has to be '
      + 'wound out of it, or the renderer draws it from behind and never draws it at all',
    ).toBeGreaterThanOrEqual(feet.laceBars)
    // The tongue under them, running down the instep.
    expect(feet.tongues, 'a tongue on each instep, under the laces')
      .toBeGreaterThanOrEqual(TONGUES_MIN)
    // And nothing above the shoe's own rim.
    expect(feet.sockBands, 'nothing should be worn over the trouser above the shoe')
      .toBe(0)
    expect(feet.sockTop, 'so the highest piece of detail is at the rim itself')
      .toBeLessThanOrEqual(feet.rim + 0.01)
    // The shoe's own two pieces — the edge of its sole and the tongue — are welded into
    // the shoe's own mesh, so what they carry in their vertex colours is the *share* of
    // the leather there they are drawn at, which the model's own material multiplies into
    // the texel under it (see weldDetail in src/util/batterLook.js): both are the shoe
    // taken down, and the sole's edge is the darker of the two.
    expect(shoes.tones.max, 'the shoe\'s own pieces are the leather taken down')
      .toBeLessThan(1)
    expect(shoes.tones.min, 'the sole\'s edge is darker than the tongue above it')
      .toBeLessThan(shoes.tones.max)
    // ...and a lace is not the shoe at all: it is the kit's own pale cloth, drawn in a
    // tone of its own on its own mesh, well clear of anything the leather can say.
    expect(kit.laces, 'the laces are a piece of the kit in their own right').not.toBeNull()
    expect(kit.laces.tones.max, 'a lace tone, close to white')
      .toBeGreaterThan(0.8)
    expect(kit.laces.tones.min, 'and every lace the same pale tone')
      .toBeGreaterThan(0.7)
    // It has to stand off the shoe to be drawn at all, and hug it rather than hover.
    expect(shoes.standOff.out[1], 'the detail should stand proud of the shoe somewhere')
      .toBeGreaterThan(0)
    expect(shoes.standOff.gap[1], 'and stay within a touch of it').toBeLessThan(SHOE_GAP_MAX)
  })
})

test.describe('harness', () => {
  test('the debug fade reaches the parts it names', async ({ page }) => {
    // `npm run pose-sheet -- --fade=arms,head` is how a pose gets inspected by
    // hand, and it warns rather than renders when a fade does not apply — but it
    // is only run when someone reaches for it, and the fade reaches into the
    // model's skinning: the body is one mesh, so a region is only separable
    // while the bones that drive it are still the ones the weights name. This
    // keeps that true.
    await page.goto('/e2e/harness/batter.html?phase=contact&fade=arms,head')
    await page.waitForFunction(() => window.__vr?.ready === true)
    const state = await page.evaluate(() => ({ fade: window.__vr.fade, meshes: window.__vr.fadedMeshes }))
    expect(state.fade).toEqual(['arms', 'head'])
    expect(state.meshes, 'the body and the helmet should both carry a faded part').toBeGreaterThanOrEqual(2)
  })

  test('the debug fade survives all the way to the pixels', async ({ page }) => {
    // The fade is only useful if it is *visible*, and it is easy to break
    // silently: it clones each mesh's geometry to carry a per-vertex fade share,
    // and a mesh that keeps drawing its original geometry looks completely
    // unfaded while every count still reads correctly. So a baseline pins what
    // it should look like: the same contact pose with the arms and head drawn
    // translucent.
    await openPhase(page, 'contact', '&fade=arms,head')
    await expect(page).toHaveScreenshot('batter-contact-faded.png')
  })

  test('the fade is translucent where it lands, not a hole or a no-op', async ({ page }) => {
    // The baseline above pins what the faded pose looks like; this pins what the
    // fade *does*, as numbers, because its two failure modes are opposites and a
    // regenerated baseline absorbs either one. A fade that stops applying leaves
    // the frame identical to the plain pose — no change at all — and one that
    // over-applies punches the parts out of the body, a hole where an arm was.
    // So the same contact pose is rendered plain and then faded, and the two are
    // compared: the faded parts have to cover a real, bounded share of the frame
    // and change it hard where they do.
    await openPhase(page, 'contact')
    const plain = (await page.screenshot({ animations: 'disabled', scale: 'css' })).toString('base64')
    await openPhase(page, 'contact', '&fade=arms,head')
    const faded = (await page.screenshot({ animations: 'disabled', scale: 'css' })).toString('base64')
    const seen = await page.evaluate(diffShots, [plain, faded])
    console.log(
      `fade: ${(seen.share * 100).toFixed(1)}% of the frame changes, ` +
        `${seen.mean.toFixed(1)} per channel where it does`,
    )
    expect(seen.share, 'the fade should be visible').toBeGreaterThan(0.005)
    expect(seen.share, 'the fade should cover the arms and head, not the body').toBeLessThan(0.12)
    expect(seen.mean, 'a faded part should change the pixels it covers').toBeGreaterThan(8)
  })

  test('every phase is reachable and pins its own clock time', async ({ page }) => {
    for (const [phase, { time }] of Object.entries(PHASES)) {
      await openPhase(page, phase)
      const state = await page.evaluate(() => ({ time: window.__vr.time, frames: window.__vr.frames }))
      expect(state.time).toBe(time)
      expect(state.frames).toBeGreaterThan(3)
    }
  })
})

// ---------------------------------------------------------------------------
// The set stance's idle bounce.
//
// The batter is never still while he waits on a pitch, and the one thing that
// bounce must never do is lift a foot: a batter's weight comes off his feet only
// when he *decides* to move them. The old stance bob was authored as a hip height
// that rose and fell around the stance, and above the stance the rig's legs are at
// full stretch — so the ankles rose with the hips and the shoes came off the
// ground, 3.9 cm of it, heel first (the driver rolls a foot onto its toe the moment
// a hip outruns its leg). It shipped like that for as long as it did because the
// suite's `stance` phase renders with the idle held off: the defect only exists in
// the frames between the shots.
//
// This sweeps the idle's own clock (which the harness pins when `?idle=1` is
// asked for, see sweepIdle) across a whole period and holds the bounce to what it
// claims to be: the feet do not move, the hips never rise above the stance, and
// the travel there is the knees' own.
test.describe("the set stance's idle bounces off the knees, not the feet", () => {
  // The idle's own period, from the tuning that drives it (sin/cos of
  // elapsed * swaySpeed), and a step fine enough that a foot lifting between two
  // samples cannot hide.
  const PERIOD_S = (2 * Math.PI) / DEFAULT_TUNING.batter.swaySpeed
  const STEP_S = 0.01
  // A foot that is planted moves by nothing at all; 2 mm is the width of the
  // antialiasing on the shoe. The old bob moved the ankles 39 mm.
  const FOOT_TRAVEL_MAX = 0.002
  // The bounce has to be there: the reference idle's own pelvis travels 4.4 cm.
  const TRAVEL_MIN = 0.03
  // ...and it has to be the knees carrying it, not a body sliding up and down.
  const KNEE_TRAVEL_MIN = 10

  test('both feet stay planted through the whole bounce', async ({ page }) => {
    // The stance's own pose first, with the idle held off: the frame every
    // reading below is measured against.
    await openPhase(page, 'stance')
    const rest = await readRig(page)
    const restFoot = {
      ankleL: rest.bone('footL'),
      ankleR: rest.bone('footR'),
      toeL: rest.bone('toeL'),
      toeR: rest.bone('toeR'),
    }
    const restHip = rest.bone('spine')[1]

    await openPhase(page, 'stance', '&idle=1')
    const rows = await page.evaluate(
      ([to, step]) => window.__vr.sweepIdle(0, to, step, ['probeBones', 'probeBat']),
      [PERIOD_S, STEP_S],
    )
    expect(rows.length, 'the idle period should be swept in several samples').toBeGreaterThan(20)

    const named = {
      ankleL: 'footL', ankleR: 'footR', toeL: 'toeL', toeR: 'toeR',
    }
    // A joint's own interior angle, the same reading the flicker test uses.
    const angleAt = (apex, a, c) => {
      const u = sub(a, apex)
      const v = sub(c, apex)
      return degrees(Math.acos(Math.min(1, Math.max(-1, dot(u, v) / (norm(u) * norm(v) || 1)))))
    }
    const travel = {}
    let hipLow = Infinity
    let hipHigh = -Infinity
    let kneeLow = Infinity
    let kneeHigh = -Infinity
    let batYawLow = Infinity
    let batYawHigh = -Infinity

    for (const row of rows) {
      const { origin, scale, bones } = row.probeBones
      const rig = (p) => [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]].map((v) => v / scale)
      for (const [label, bone] of Object.entries(named)) {
        const y = rig(bones[bone])[1]
        travel[label] = travel[label] ?? { low: y, high: y }
        travel[label].low = Math.min(travel[label].low, y)
        travel[label].high = Math.max(travel[label].high, y)
      }
      const hip = rig(bones.spine)[1]
      hipLow = Math.min(hipLow, hip)
      hipHigh = Math.max(hipHigh, hip)
      const knee = angleAt(bones.shinL, bones.thighL, bones.footL)
      kneeLow = Math.min(kneeLow, knee)
      kneeHigh = Math.max(kneeHigh, knee)
      // The bat's own line: how far the barrel has swung away from straight ahead
      // is the waggle (the harness reports the barrel's world direction).
      if (row.probeBat) {
        const yaw = degrees(Math.atan2(row.probeBat.axis[0], -row.probeBat.axis[2]))
        batYawLow = Math.min(batYawLow, yaw)
        batYawHigh = Math.max(batYawHigh, yaw)
      }
    }

    for (const [label, bone] of Object.entries(named)) {
      const restY = restFoot[label][1]
      const span = travel[label].high - travel[label].low
      expect(span, `${bone} should not move vertically while the batter waits (was ${(span * 1000).toFixed(1)} mm)`)
        .toBeLessThanOrEqual(FOOT_TRAVEL_MAX)
      expect(Math.abs(travel[label].high - restY), `${bone} should not sit above its planted height`)
        .toBeLessThanOrEqual(FOOT_TRAVEL_MAX)
      expect(Math.abs(travel[label].low - restY), `${bone} should not sit below its planted height`)
        .toBeLessThanOrEqual(FOOT_TRAVEL_MAX)
    }

    expect(hipHigh - restHip, 'the hips should never rise above the set stance')
      .toBeLessThanOrEqual(FOOT_TRAVEL_MAX)
    expect(restHip - hipLow, `the crouch should be there (hips travel ${((restHip - hipLow) * 100).toFixed(1)} cm)`)
      .toBeGreaterThanOrEqual(TRAVEL_MIN)
    expect(kneeHigh - kneeLow, `the knees should carry the crouch (they move ${(kneeHigh - kneeLow).toFixed(1)} degrees)`)
      .toBeGreaterThanOrEqual(KNEE_TRAVEL_MIN)
    expect(batYawHigh - batYawLow, `the bat should waggle in the hands (it turns ${(batYawHigh - batYawLow).toFixed(1)} degrees)`)
      .toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// The pre-pitch read: the batter is leaning in, and holding it, before the ball
// is thrown.
//
// The lean-in is a ramp across the pitcher's windup, and the windup is the one
// window of the cycle nothing else here reads: the shots are taken at 0.00-1.10 s
// of the clock, and every sweep starts at the swing (0.18 s) or the way home. So
// the ramp could sit at "arrives exactly on the release frame, held for no time at
// all" with the suite green — which is what it did. At that reading the batter is
// only just arriving at his lean as the ball leaves the hand, where the moment
// should read as a batter already set and waiting on it.
//
// The lean is a rotation the driver writes on the upper body, so it is read off the
// bones' own axes rather than off where they sit (their positions stay at rest): the
// chest's up axis, tipped along the way the batter leans. The harness renders the
// stance's idle off by default, so the reading is the authored lean alone.
// ---------------------------------------------------------------------------
test('the batter is fully leaned in before the ball is released', async ({ page }) => {
  const STEP_S = 0.01
  // The lean's own travel across the windup: the set lean (setLean) is 0.3 rad, and
  // its whole excursion has to be there to be held.
  const LEAN_TRAVEL_MIN = 10
  // The set is two beats — the lean in, then the weight shift onto the back leg that
  // opens *from* it — so the lean's lead is not its own tuning alone: it has to be in by
  // the time the coil needs to start, or the batter would be loading before he had
  // leaned in, which is the defect this replaced. Both authored leads are floors (see
  // loadLead in the tuning) and two steps of the sweep are allowed either way: this is a
  // clock, and the assertion is that the authored lead is honoured, not that a sample
  // lands on it.
  const LEAD_S = Math.max(
    DEFAULT_TUNING.batter.leanLead,
    DEFAULT_TUNING.batter.loadTime + DEFAULT_TUNING.batter.loadLead,
  )
  const LEAD_TOLERANCE_S = 2 * STEP_S
  // What the trunk may do *after* the lean lands: the coil settles it back over the back
  // leg by loadLeanBack, which is a beat of its own and not the lean coming undone — so
  // the settle is bounded by a share of the lean itself rather than by a constant. Under
  // half: the batter keeps the lean he leaned in for while he shifts his weight. (It
  // reads 3.3 degrees against 11.8 of travel at the shipped loadLeanBack of 0.08 rad, and
  // doubling that back-settle reddens this.)
  const LEAN_SETTLE_SHARE = 0.5
  // The reading may never go back *up* past the lean it arrived at: the batter settling
  // onto his back leg tips the trunk back, never forward again.
  const LEAN_RISE_DEG = 0.05
  // "Complete" to within a quarter of a degree — half the deadband the joint test
  // calls breathing, and a fiftieth of the lean's own travel.
  const LEAN_DONE_DEG = 0.25
  // What the lean may not be: one that snaps into place instead of leaning. The
  // shipped ramp covers its travel in 1.2 s, so a step carries an eighth of a
  // degree; 1.5 degrees in one step is 125 deg/s, an order of magnitude past
  // anything the body does at the set, and still far under a snap.
  const MAX_STEP_DEG = 1.5
  // 1.3 s of window at 10 ms steps is 133 settled frames in one page, and the sweep
  // is one long evaluate: on a loaded machine that outruns the suite's own timeout.
  test.slow()

  await openPhase(page, 'followThrough')
  const rows = await page.evaluate(
    ([from, to, step]) => {
      // probeAxes reads whichever bones it is handed, and a sweep calls a probe with
      // no argument, so the page's own default is re-aimed at the pelvis and the
      // chest — the two the lean runs between.
      const readAxes = window.__vr.probeAxes
      window.__vr.probeAxes = () => readAxes(['spine', 'spine002'])
      return window.__vr.sweep(from, to, step, ['probeAxes'])
    },
    [WINDUP_WINDOW.start, WINDUP_WINDOW.end, STEP_S],
  )
  expect(rows.length, 'the windup should be swept, not sampled').toBeGreaterThan(100)

  // The direction the lean is *read along* is the lean's own motion: the chord from the
  // chest's direction while the batter stands to its direction at the release. A lean
  // read as a projection onto a single frame's direction keeps the sideways wobble of
  // the idle and the body's own turn out of the number, but only the chord reads the
  // whole excursion at its own scale — the release frame is *after* the coil has settled
  // the trunk back onto the back leg, so taking the axis from it alone mis-scales the
  // same lean (measured on the shipped build: 8.3 degrees along the release frame's own
  // direction against 11.8 along the motion).
  const standDir = rows[0].probeAxes?.spine002?.y?.dir
  const releaseDir = rows[rows.length - 1].probeAxes?.spine002?.y?.dir
  expect(releaseDir && standDir, 'the harness should report the chest bone').toBeTruthy()
  const flat = (dir) => {
    const length = Math.hypot(dir[0], dir[2]) || 1
    return [dir[0] / length, dir[2] / length]
  }
  const standFlat = flat(standDir)
  const releaseFlat = flat(releaseDir)
  const chordX = releaseFlat[0] - standFlat[0]
  const chordZ = releaseFlat[1] - standFlat[1]
  const chord = Math.hypot(chordX, chordZ) || 1
  const leanAxis = [chordX / chord, chordZ / chord]
  const readings = rows.map((row) => {
    const dir = row.probeAxes?.spine002?.y?.dir
    // The chest's own up axis, tipped off the world's up and read along the lean's
    // direction, signed: a tilt, with the direction kept.
    return {
      time: row.time,
      lean: dir
        ? degrees(Math.asin(Math.min(1, Math.max(-1, dir[0] * leanAxis[0] + dir[2] * leanAxis[1]))))
        : NaN,
    }
  })
  expect(readings.every((reading) => Number.isFinite(reading.lean)), 'every sample should read a lean').toBe(true)

  // The lean's own completeness is read off the windup itself rather than off the last
  // frame: the coil settles the trunk a fraction of a degree back over the back leg once
  // it opens, so the release frame is not where the lean's full value lives.
  const full = Math.max(...readings.map((reading) => reading.lean))
  const start = readings[0].lean
  expect(
    full - start,
    `the windup should carry the whole lean (the chest travels ${(full - start).toFixed(1)} degrees) `
      + `— it reaches ${full.toFixed(1)} and is ${start.toFixed(1)} when the windup starts`,
  ).toBeGreaterThanOrEqual(LEAN_TRAVEL_MIN)

  // The ask itself: when the lean is complete, and that it does not come undone after.
  const complete = readings.find((reading) => reading.lean >= full - LEAN_DONE_DEG)
  expect(complete, 'the lean should complete somewhere in the windup').toBeTruthy()
  const held = WINDUP_WINDOW.end - complete.time
  expect(
    held,
    `the batter should be fully leaned in before the release (it settles ${held.toFixed(2)} s before the ball is thrown)`,
  ).toBeGreaterThanOrEqual(LEAD_S - LEAD_TOLERANCE_S)
  const settled = readings.slice(readings.indexOf(complete))
  const rose = settled.find((reading) => reading.lean > full + LEAN_RISE_DEG)
  expect(
    rose,
    'the trunk should tip back onto the back leg as it coils, never forward off the lean'
      + (rose ? ` (it came back up to ${rose.lean.toFixed(2)} at ${rose.time.toFixed(2)}s)` : ''),
  ).toBeUndefined()
  const lowest = Math.min(...settled.map((reading) => reading.lean))
  expect(
    full - lowest,
    `the trunk should settle onto the back leg while it coils, not unwind off the lean `
      + `(it falls ${(full - lowest).toFixed(2)} of the ${(full - start).toFixed(2)} degrees it `
      + `leaned in, after settling at ${complete.time.toFixed(2)}s)`,
  ).toBeLessThanOrEqual(LEAN_SETTLE_SHARE * (full - start))

  let worst = { degrees: 0, at: 0 }
  for (let i = 1; i < readings.length; i += 1) {
    const step = Math.abs(readings[i].lean - readings[i - 1].lean)
    if (step > worst.degrees) worst = { degrees: step, at: readings[i].time }
  }
  expect(
    worst.degrees,
    `the lean should arrive by leaning, not by jumping (worst step ${worst.degrees.toFixed(2)} degrees `
      + `in ${STEP_S} s, at ${worst.at.toFixed(2)} s)`,
  ).toBeLessThanOrEqual(MAX_STEP_DEG)
})

// ---------------------------------------------------------------------------
// The *other* half of the set: the weight shift onto the back leg opens from the
// leaned-in pose, and is finished — coiled and held — before the arm comes through.
//
// The load used to be timed off the swing: it opened on the release frame itself and
// ran into the ball's flight, so the batter was still sinking onto his back leg as
// the pitch came to him and only read as loaded once the ball was halfway in. The
// lean test above cannot see that, because the trunk is exactly what the coil
// settles; the weight shift owns the *hips*, so it is read off the pelvis's own
// height — the driver drops the whole upper body by hipSettle * load, and with the
// idle rendered off by the harness nothing else in the window moves it (the stride
// lifts the front foot, not the hips).
//
// Two bounds make the read, and they pull against each other, which is the point:
// the shift may not open before the lean lands (or the batter is leaning and loading
// on one frame again), and it must be finished and holding by the release (or he is
// still loading as the arm comes through).
// ---------------------------------------------------------------------------
test('the batter coils from the leaned-in pose, and is coiled before the ball is released', async ({ page }) => {
  const STEP_S = 0.01
  const LOAD_TIME = DEFAULT_TUNING.batter.loadTime
  const LOAD_LEAD = DEFAULT_TUNING.batter.loadLead
  const TOLERANCE_S = 2 * STEP_S
  // "Complete" to within a quarter of a degree — half the deadband the joint test
  // calls breathing, and a fiftieth of the lean's own travel. The same reading the
  // lean test makes, so the frame the coil opens on is the frame that test calls the
  // lean's arrival.
  const LEAN_DONE_DEG = 0.25
  // A frame where the hips have moved, and where they have stopped: a fifth of a
  // millimetre, well under the 3.8 cm the coil carries, and above the sweep's own
  // float noise.
  const MOVED_RIG = 0.0002
  // What the coil is worth: it has to be a real transfer of weight onto the back leg.
  // Measured 0.038 rig at the shipped hipSettle of 0.06.
  const COIL_DROP_MIN_RIG = 0.025
  test.slow()

  await openPhase(page, 'followThrough')
  const rows = await page.evaluate(
    ([from, to, step]) => {
      // probeAxes reads whichever bones it is handed, and a sweep calls a probe with
      // no argument, so the page's own default is re-aimed at the chest — the bone the
      // lean is read off, in the same sweep as the hips.
      const readAxes = window.__vr.probeAxes
      window.__vr.probeAxes = () => readAxes(['spine', 'spine002'])
      return window.__vr.sweep(from, to, step, ['probeBones', 'probeAxes'])
    },
    [WINDUP_WINDOW.start, WINDUP_WINDOW.end, STEP_S],
  )
  expect(rows.length, 'the windup should be swept, not sampled').toBeGreaterThan(100)

  const samples = rows.map((row) => ({
    time: row.time,
    hips: row.probeBones?.bones?.spine?.[1] ?? NaN,
    chest: row.probeAxes?.spine002?.y?.dir ?? null,
  }))
  expect(samples.every((sample) => Number.isFinite(sample.hips)), 'every sample should read the pelvis').toBe(true)
  expect(samples.every((sample) => sample.chest), 'every sample should read the chest').toBe(true)

  // When the lean lands, on the same reading the lean test makes (see it for why the
  // axis is the lean's own motion rather than one frame's direction).
  const flat = (dir) => {
    const length = Math.hypot(dir[0], dir[2]) || 1
    return [dir[0] / length, dir[2] / length]
  }
  const stand = flat(samples[0].chest)
  const end = flat(samples[samples.length - 1].chest)
  const chord = Math.hypot(end[0] - stand[0], end[1] - stand[1]) || 1
  const leanAxis = [(end[0] - stand[0]) / chord, (end[1] - stand[1]) / chord]
  const leans = samples.map((sample) => degrees(Math.asin(
    Math.min(1, Math.max(-1, sample.chest[0] * leanAxis[0] + sample.chest[2] * leanAxis[1])),
  )))
  const leanFull = Math.max(...leans)
  const leanAt = leans.findIndex((lean) => lean >= leanFull - LEAN_DONE_DEG)
  expect(leanAt, 'the lean should land somewhere in the windup').toBeGreaterThan(0)
  const leanLand = samples[leanAt].time

  // The coil's own clock, read off the hips: when they first leave the height they
  // hold while the batter stands, the bottom they settle to, and that they hold there.
  const rest = samples[0].hips
  const opened = samples.find((sample) => rest - sample.hips > MOVED_RIG)
  expect(opened, 'the hips should settle onto the back leg somewhere in the windup').toBeTruthy()
  const lowest = samples.reduce((best, sample) => (sample.hips < best.hips ? sample : best), samples[0])
  const bottom = samples.find((sample) => Math.abs(lowest.hips - sample.hips) < MOVED_RIG)
  expect(bottom, 'the hips should reach the bottom of the coil').toBeTruthy()

  // The ask itself: the shift starts *from* the leaned-in pose. It is timed off the
  // lean for exactly this reason — a coil that opens before the batter has leaned in is
  // the leaning-and-loading-on-one-frame read this replaced.
  expect(
    opened.time,
    `the weight shift should open from the leaned-in pose, not before it (the hips start `
      + `settling at ${opened.time.toFixed(2)}s, the lean lands at ${leanLand.toFixed(2)}s)`,
  ).toBeGreaterThanOrEqual(leanLand - STEP_S)

  // ...and the arm comes through with the batter already coiled and holding it.
  const lead = WINDUP_WINDOW.end - bottom.time
  expect(
    lead,
    `the batter should be coiled and waiting before the ball is released (it reaches the `
      + `bottom ${lead.toFixed(2)} s before the ball is thrown)`,
  ).toBeGreaterThanOrEqual(LOAD_LEAD - TOLERANCE_S)
  const after = samples.filter((sample) => sample.time > bottom.time)
  const drift = Math.max(...after.map((sample) => Math.abs(sample.hips - lowest.hips)))
  expect(
    drift,
    `the coil should hold from its bottom to the release, not keep sinking (it drifts `
      + `${(drift * 100).toFixed(2)} cm after its bottom at ${bottom.time.toFixed(2)}s)`,
  ).toBeLessThanOrEqual(MOVED_RIG * 2)

  // The coil is its own authored beat, not whatever is left of the windup: it takes
  // loadTime. (The ease leaves and arrives flat, so the readings bracket it from
  // inside — a sixth of the coil either way.)
  const coil = bottom.time - opened.time
  expect(
    coil,
    `the coil should take its own loadTime (it takes ${coil.toFixed(2)} s of ${LOAD_TIME.toFixed(2)})`,
  ).toBeGreaterThanOrEqual(LOAD_TIME - 0.06)
  expect(coil, `the coil should take its own loadTime (it takes ${coil.toFixed(2)} s)`)
    .toBeLessThanOrEqual(LOAD_TIME + TOLERANCE_S)

  // And it has to be worth reading as a weight shift at all.
  expect(
    rest - lowest.hips,
    `the batter should shift his weight onto the back leg (the hips drop ${((rest - lowest.hips) * 100).toFixed(2)} cm)`,
  ).toBeGreaterThanOrEqual(COIL_DROP_MIN_RIG)
})

// ---------------------------------------------------------------------------
// The take's own coil.
//
// A taken pitch used to be a batter who never shifted his weight: the coil was
// computed only when the swing was called for, so a take got the lean-in and the
// stride and nothing else — the batter stood in his stance with his hands up while
// the ball went by. A batter taking a pitch is not idle. He sets himself on the
// pitcher's clock exactly as he does for a swing, holds the coil while the ball
// comes, and lets it go once it has passed: the hold is what a take reads as.
//
// So the take's coil is held to the same two bounds the swing's is — it opens from
// the leaned-in pose, and it is complete and holding before the release — and then
// to the two things a take has to do with it: hold it through the ball's crossing,
// and come back out of it afterwards rather than standing coiled until the next
// pitch. The swing is also witnessed *not* to have fired, because a take that turned
// out to be a swing would satisfy every one of those bounds.
// ---------------------------------------------------------------------------
test('the batter coils on a taken pitch, and holds it while the ball comes', async ({ page }) => {
  const STEP_S = 0.01
  const LOAD_TIME = DEFAULT_TUNING.batter.loadTime
  const LOAD_LEAD = DEFAULT_TUNING.batter.loadLead
  const LEAN_OUT = DEFAULT_TUNING.batter.leanOutTime
  const TOLERANCE_S = 2 * STEP_S
  // A frame where the hips have moved, and where they have stopped: the same
  // fifth-of-a-millimetre the swing's own coil test reads them at.
  const MOVED_RIG = 0.0002
  // What the coil is worth on a take as much as on a swing: a real transfer of
  // weight onto the back leg. This take reads 0.060 rig of hip drop, and the swing's
  // own coil test reads the same 3.8 cm of it — its sweep hands back world metres,
  // this one reads the animation's own frame — so the two are one and the same
  // motion on two different pitches.
  const COIL_DROP_MIN_RIG = 0.025
  // The take's own clock: the ball crosses the plate at CONTACT_TIME_S, and the
  // coil, the front foot and the stride all come home over the LEAN_OUT after that
  // (see takeSettleEnd in Batter.jsx).
  const SETTLE_END_S = CONTACT_TIME_S + LEAN_OUT
  // The bat on a take stays in the load. The coil now carries the hands back with
  // it, which swings the tip 0.147 rig off the stance's own place, and the idle's
  // waggle is frozen at one phase for both readings. The swing's contact frame, on
  // the same reading, is 1.668 rig away — so the load is bounded well inside it.
  const BAT_TAKE_SLACK_RIG = 0.3
  const SWING_OFF_STANCE_MIN_RIG = 0.3
  test.slow()

  const tipOf = async () => {
    const bat = await readBat(page)
    return add(bat.origin, mul(bat.axis, bat.length))
  }
  // The idle is frozen at one phase of its own bounce, so every pose read below
  // carries the same amount of it — and it stays frozen through the sweeps, which is
  // what makes their readings comparable at all.
  await openPhase(page, 'take', '&idleTime=0')
  const take = await readRig(page)
  const takeHips = take.bone('spine')[1]
  // A sweep hands back probeBones' own readings, which are world metres; the pelvis
  // is read in the animation's own units, as every other reading in this suite is.
  const hipsOf = (rows) => rows.map((row) => ({
    time: row.time,
    hips: take.toRig([0, row.probeBones?.bones?.spine?.[1] ?? NaN, 0])[1],
  }))
  const takeTip = await tipOf()

  // The pitch itself, swept from the release through the flight and on into the set
  // the take comes back to; then the windup that set the batter in the first place.
  const hold = hipsOf(await page.evaluate(
    ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeBones']),
    [0, SETTLE_END_S + LEAN_OUT + 0.4, STEP_S],
  ))
  const windup = hipsOf(await page.evaluate(
    ([from, to, step]) => window.__vr.sweep(from, to, step, ['probeBones']),
    [WINDUP_WINDOW.start, WINDUP_WINDOW.end, STEP_S],
  ))
  expect(hold.length, 'the take should be swept, not sampled').toBeGreaterThan(100)
  expect(windup.length, 'and so should the windup it was taken from').toBeGreaterThan(50)
  expect(hold.every((sample) => Number.isFinite(sample.hips)), 'every sample should read the pelvis').toBe(true)

  // The height the take settles back to: the tail of the sweep, once the coil and
  // the stride are both home. Read here rather than off the stance phase so it is
  // the same page, the same idle phase and the same clock as the rest of it.
  const settled = hold.filter((sample) => sample.time >= SETTLE_END_S + LEAN_OUT + 0.05)
  const rest = Math.max(...settled.map((sample) => sample.hips))
  expect(
    Math.max(...settled.map((sample) => Math.abs(sample.hips - rest))),
    'the take should settle onto the stance, not drift about it',
  ).toBeLessThanOrEqual(MOVED_RIG * 2)

  // The ask itself: a take shifts the batter's weight onto his back leg, and holds
  // it. Both halves are read — the drop, and the frame the ball crosses inside it.
  const flight = hold.filter((sample) => sample.time <= SETTLE_END_S)
  const lowest = Math.min(...flight.map((sample) => sample.hips))
  console.log(
    `the take: hips ${takeHips.toFixed(4)} against a settled stance at ${rest.toFixed(4)} `
      + `(${((rest - takeHips) * 100).toFixed(2)} cm down); through the flight the coil sits at `
      + `${lowest.toFixed(4)} and moves ${((Math.max(...flight.map((s) => s.hips)) - lowest) * 100).toFixed(2)} cm`,
  )
  expect(
    rest - takeHips,
    `a taken pitch has to shift the batter's weight onto the back leg (the hips drop ${((rest - takeHips) * 100).toFixed(2)} cm)`,
  ).toBeGreaterThanOrEqual(COIL_DROP_MIN_RIG)
  expect(
    Math.max(...flight.map((sample) => sample.hips)) - lowest,
    'the coil should hold through the ball\'s crossing, not keep moving',
  ).toBeLessThanOrEqual(MOVED_RIG * 2)
  expect(
    Math.abs(takeHips - lowest),
    'and the frame the ball crosses is inside that hold, which is the pose a take is read as',
  ).toBeLessThanOrEqual(MOVED_RIG * 2)

  // ...and it lets the coil go once the ball has passed, on the take's own clock,
  // rather than standing coiled until the next pitch.
  const back = hold.find((sample) => sample.time >= SETTLE_END_S + LEAN_OUT
    && Math.abs(sample.hips - rest) <= MOVED_RIG * 2)
  expect(back, 'the coil should unwind after the pitch, on the take\'s own clock').toBeTruthy()
  expect(
    back.time,
    `it should be back at the stance within the take's own settle (by ${(SETTLE_END_S + LEAN_OUT).toFixed(2)} s)`,
  ).toBeLessThanOrEqual(SETTLE_END_S + LEAN_OUT + TOLERANCE_S)

  // The windup, on the take's own clock: the coil takes loadTime, and it is finished
  // and holding before the ball leaves the pitcher's hand — the same two bounds the
  // swing's coil is held to, because it is the same set.
  const opened = windup.find((sample) => rest - sample.hips > MOVED_RIG)
  expect(opened, 'the batter should coil somewhere in the windup he takes the pitch from').toBeTruthy()
  const bottom = windup.reduce((best, sample) => (sample.hips < best.hips ? sample : best), windup[0])
  const coil = bottom.time - opened.time
  expect(
    coil,
    `the coil should take its own loadTime (it takes ${coil.toFixed(2)} s of ${LOAD_TIME.toFixed(2)})`,
  ).toBeGreaterThanOrEqual(LOAD_TIME - 0.06)
  expect(coil, `and not run on past it (it takes ${coil.toFixed(2)} s)`)
    .toBeLessThanOrEqual(LOAD_TIME + TOLERANCE_S)
  const lead = WINDUP_WINDOW.end - bottom.time
  expect(
    lead,
    `the batter should be coiled and waiting when the ball is released (${lead.toFixed(2)} s before)`,
  ).toBeGreaterThanOrEqual(LOAD_LEAD - TOLERANCE_S)

  // And the swing did not fire: the bat is where the load leaves it, while the same
  // frame of the swing has it out on the ball (witnessed, so this cannot pass by
  // reading a batter that never moves at all).
  await openPhase(page, 'stance', '&idleTime=0')
  const stanceTip = await tipOf()
  await openPhase(page, 'contact', '&idleTime=0')
  const contactTip = await tipOf()
  const takeOffStance = norm(sub(takeTip, stanceTip))
  const swingOffStance = norm(sub(contactTip, stanceTip))
  console.log(
    `the bat: on the take it sits ${takeOffStance.toFixed(3)} rig off the stance's own place, `
      + `where the swing's contact frame is ${swingOffStance.toFixed(3)} away`,
  )
  expect(swingOffStance, 'the swing a take is read against should be a real swing')
    .toBeGreaterThan(SWING_OFF_STANCE_MIN_RIG)
  expect(
    takeOffStance,
    'a take leaves the bat in the load: it is a take, not a swing',
  ).toBeLessThan(BAT_TAKE_SLACK_RIG)
})
