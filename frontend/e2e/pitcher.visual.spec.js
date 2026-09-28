import { test, expect } from '@playwright/test'
import {
  AUTHORED_CLIP_END,
  AUTHORED_HANDOFF_TIME,
  AUTHORED_LOOK_LOCK_TIME,
  AUTHORED_RELEASE_TIME,
  AUTHORED_ZONE_TIME,
} from '../src/util/pitcherSequence.js'

// ---------------------------------------------------------------------------
// Pitcher delivery suite: the numbers the delivery promises.
//
// The delivery is driven by joint targets in the model's own rig
// (src/util/pitcherSequence.js) rather than by the reference project's canned
// RightHandPitch clip, and what that buys is that the release is *placed*: the body
// stands wherever its own release frame puts the ball on the pitch's trajectory's
// first sample (see Pitcher.jsx). The Node unit tests in ./test hold the sequence's
// invariants as pure numbers; what can only be checked with the real model in the
// scene is that the pose the driver *realises* is the pose the sequence asked for —
// the ball in the hand, the arm's reach, the feet — which is what this file reads
// off the harness's own probe (frontend/e2e/harness/pitcherMain.jsx).
//
// No pixel baselines: the numbers are the promise, and a pose can be a centimetre
// out while still looking plausible.
// ---------------------------------------------------------------------------

const HARNESS = '/e2e/harness/pitcher.html'
const RELEASE = AUTHORED_RELEASE_TIME
// What the driver will stretch a bone to hold a target it cannot reach
// (ARM_STRETCH_MAX in src/util/playerRig.js). Nothing at the release should need it.
const STRETCH_MAX = 1.25

/** The angle at the elbow, off the posed joints, in degrees. */
const elbowAngle = (arm) => {
  const a = arm.shoulder
  const b = arm.elbow
  const c = arm.wrist
  const ab = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cb = [c[0] - b[0], c[1] - b[1], c[2] - b[2]]
  const dot = ab[0] * cb[0] + ab[1] * cb[1] + ab[2] * cb[2]
  const length = Math.hypot(...ab) * Math.hypot(...cb)
  return (Math.acos(Math.max(-1, Math.min(1, dot / length))) * 180) / Math.PI
}

/** Open the harness pinned to one frame of the delivery and read the probe. */
const openAt = async (page, clip, query = '') => {
  await page.goto(`${HARNESS}?clip=${clip}${query}`)
  await page.waitForFunction(() => window.__vr?.ready === true && window.__vr.probe() !== null)
  return page.evaluate(() => window.__vr.probe())
}

test('the release frame lands the hand on the pitch’s own release point', async ({ page }) => {
  const at = await openAt(page, RELEASE)
  // The pitch's own release point in world space, and where the *posed hand* is
  // carrying the ball: this is the whole reason the delivery is authored in the
  // model's own frame, and it is the number the body's placement is solved from.
  expect(at.miss).toBeLessThan(0.002)
  // ...reached with the arm the model has, not a stretched one: the stretch is the
  // driver's word for an ask past the model's proportions.
  expect(at.arm.stretch).toBeLessThanOrEqual(1.02)
  // And it is a pitch's arm at the release — extended, not folded — rather than the
  // hand arriving at the release point off a cramped elbow.
  expect(elbowAngle(at.arm)).toBeGreaterThan(120)
})

test('the delivery realises the pose it was authored from', async ({ page }) => {
  // Every frame the sequence promises a place for the ball (`pitcherData.ball`, the
  // pose's own answer) and the driver answers with where the hand actually carries
  // it (`ballRig`, read off the posed skeleton). Off the release the two may differ
  // by whatever the arm had to borrow; *at* the release there is nothing between
  // them, because that is the frame the ball leaves on.
  for (const clip of [1.12, 1.24, 1.42, 1.62]) {
    const at = await openAt(page, clip)
    const promised = at.pitcherData.ball
    const drawn = at.ballRig
    const distance = Math.hypot(...promised.map((v, axis) => v - drawn[axis]))
    expect(distance, `at ${clip}s the ball is drawn ${distance} from where the pose put it`)
      .toBeLessThan(0.005)
    expect(at.arm.stretch).toBeLessThanOrEqual(STRETCH_MAX)
  }
  // While the hands are together the promise is the *grip's*, and it is a stronger one:
  // the ball is in the glove, so it is the glove's own palm and the hand carrying it is
  // the glove's own hand — read through the chest frame the driver really holds rather
  // than through the pose's estimate of it (see the clasp correction in
  // pitcherSequence.js). So what is checked here is that the two are one place: the two
  // hands' wrists coincide to the millimetre, and the drawn ball rides the glove's own
  // realised line off it, a carry down it. The pose's own `ball` is allowed to be a few
  // centimetres out at these frames — that *is* the pose's estimate of the chest the
  // driver holds, and it is why the clasped frames are authored in the glove's frame at
  // all.
  for (const clip of [0, 0.58, 0.8]) {
    const at = await openAt(page, clip)
    const glove = at.arms.find((arm) => arm.side === 'L')
    const hand = at.arms.find((arm) => arm.side === 'R')
    const wrists = Math.hypot(...hand.wrist.map((v, axis) => v - glove.wrist[axis]))
    expect(wrists, `at ${clip}s the two hands' wrists are ${wrists.toFixed(4)} apart: the grip is two places`)
      .toBeLessThan(0.002)
    const from = glove.wrist.map((v, axis) => at.ballRig[axis] - v)
    const along = glove.aim.reduce((sum, v, axis) => sum + v * from[axis], 0)
    const off = Math.hypot(...from.map((v, axis) => v - along * glove.aim[axis]))
    expect(off, `at ${clip}s the ball is drawn ${off.toFixed(4)} off the glove's own line`)
      .toBeLessThan(0.003)
    expect(
      along,
      `at ${clip}s the ball is drawn ${along.toFixed(3)} rig units down the glove's own line: it is not in the mitt`,
    ).toBeGreaterThan(0.06)
    expect(
      along,
      `at ${clip}s the ball is drawn ${along.toFixed(3)} rig units down the glove's own line: it is out past the mitt's fingers`,
    ).toBeLessThan(0.2)
    expect(at.arm.stretch).toBeLessThanOrEqual(STRETCH_MAX)
  }
  const release = await openAt(page, RELEASE)
  expect(Math.hypot(...release.pitcherData.ball.map((v, axis) => v - release.ballRig[axis])))
    .toBeLessThan(0.002)
})

test('the stride reaches out unplanted, and the drive leg peels off behind it', async ({ page }) => {
  // The delivery stands on the drive leg alone from the break until *past* the
  // release: the striding leg reaches its own length out and holds the shoe up while
  // the ball goes, which is what leaves the body nothing to catch itself on through
  // the throw but the drive leg's own turn. So at the release the throwing side's own
  // leg is the pivot — by then the body has driven far enough forward to have left
  // the ground behind it — and the striding leg is *in the air*, a hand's width up.
  const at = await openAt(page, RELEASE)
  const pivot = at.legs.find((leg) => leg.side === 1)
  const front = at.legs.find((leg) => leg.side === -1)
  expect(pivot.target[1]).toBeGreaterThan(0.15)
  expect(
    front.planted,
    'the striding foot is already standing on the ground at the release',
  ).toBe(false)
  expect(
    front.ankle[1] - 0.0852,
    `the striding foot is only ${(front.ankle[1] - 0.0852).toFixed(3)} rig units up at the release: the stride has already landed`,
  ).toBeGreaterThan(0.08)
  // ...and it comes down a tenth of a second later, standing *on* the ground: `sink`
  // is how far the shoe itself ended up out of it, read off the model's own geometry
  // (see the driver's leg solve), so a foot left in the dirt or hanging above it reads
  // here — and solved where the delivery asked: a leg that had to give reports it as
  // `miss` (see rollFootOnToe).
  const planted = await openAt(page, 1.42)
  const landed = planted.legs.find((leg) => leg.side === -1)
  expect(landed.planted, 'the stride never comes down').toBe(true)
  expect(Math.abs(landed.sink)).toBeLessThan(0.002)
  expect(landed.miss).toBeLessThan(0.005)
  expect(pivot.miss).toBeLessThan(0.005)
})

const DEG = 180 / Math.PI
const sub = (a, b) => a.map((value, axis) => value - b[axis])
const length = (v) => Math.hypot(...v)
const unit = (v) => v.map((value) => value / length(v))
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** The glove's arm: the side the pose names for it (see the arms the pose carries). */
const leadArm = (frame) => frame.arms.find((arm) => arm.side === 'L')

/** How far the lead hand is from its own socket, as a share of the arm's span: what
 * "the lead arm straightens" means, and nought-to-one of a bone chain's own length. */
const leadStraightness = (frame) => {
  const arm = leadArm(frame)
  return length(sub(arm.wrist, arm.shoulder)) / arm.reach
}

/** The lead forearm's own angle below the horizontal, in degrees. */
const leadForearm = (frame) => {
  const arm = leadArm(frame)
  const fore = sub(arm.wrist, arm.elbow)
  return Math.asin(Math.max(-1, Math.min(1, fore[1] / length(fore)))) * DEG
}

/** The middle of the two hip sockets, and of the two shoulder sockets. */
const pelvisOf = (frame) => {
  const hips = frame.legs.map((leg) => leg.hip)
  return hips[0].map((value, axis) => (value + hips[1][axis]) / 2)
}

/**
 * The trunk's own sideways tilt, in degrees, off the axis the hips' own line says it
 * should be on: the chest's up against the pelvis' left-right line (the two hip
 * sockets). A torso turning about the axis it is folded along keeps *this* near
 * nought — and it does not, quite, because the shoulders lead the hips by the
 * swing's separation, which across a body leaning forward is worth a degree or two
 * of it by geometry alone (measured: at most 3° over the whole turn, against a
 * delivery's own fold of 30-odd).
 */
const trunkRoll = (frame) => {
  const lateral = unit(sub(frame.legs[0].hip, frame.legs[1].hip))
  return Math.asin(Math.max(-1, Math.min(1, dot(frame.torso.up, lateral)))) * DEG
}

/**
 * How far the shoulder line has come round from the set's own line, in degrees.
 *
 * The line runs socket to socket, and the frame it is read in is the rig's own: the
 * pitch goes along -z, so the line lying along z is the set's side-on stance (nought
 * here) and the line lying along x is the body square to the plate (ninety) — which
 * is what "the shoulders open" measures, and what a sign on it means: wound further
 * off the plate than side-on is negative, and past square is past ninety.
 */
const shoulderLine = (frame) => {
  const throwing = frame.arms.find((arm) => arm.side === 'R')
  const glove = frame.arms.find((arm) => arm.side === 'L')
  return (
    (Math.atan2(
      throwing.shoulder[0] - glove.shoulder[0],
      throwing.shoulder[2] - glove.shoulder[2],
    ) * 180) / Math.PI
  )
}

/** The trailing arm: the side the pose names for it (see the arms the pose carries). */
const trailArm = (frame) => frame.arms.find((arm) => arm.side === 'R')

/**
 * One arm's own *shape*, as the place its elbow sits relative to the socket it hangs
 * from. This is the reading a clavicle cannot move: each shoulder swings toward its
 * own hand (see the driver's `reachWithShoulder`), and the two hands of a clasp are
 * one place reached for from two sockets, so the *sockets* are a few centimetres
 * from being each other's mirror while the arms hanging off them are not.
 */
const armShape = (arm) => sub(arm.elbow, arm.shoulder)

/** The middle of the two shoulder sockets, and how far the torso is folded over the
 * pelvis: the angle between `up` and the line from the hip's own centre to the
 * chest's, so a torso standing straight over its hips is nought degrees. */
const chestFold = (frame) => {
  const chest = frame.arms.map((arm) => arm.shoulder)
  const middle = chest[0].map((value, axis) => (value + chest[1][axis]) / 2)
  const pelvis = pelvisOf(frame)
  return (
    (Math.atan2(pelvis[2] - middle[2], middle[1] - pelvis[1]) * 180) / Math.PI
  )
}

/**
 * How far the trunk itself is leaned forward of plumb, in degrees: the ribcage's own
 * up axis's tilt toward the plate (the rig's -z), which is what "the torso leans into
 * the throw" is a number for.
 *
 * Read off the ribcage's own bone rather than off the chest's *place* over the pelvis
 * (see `chestFold`): the two agree while the body stands over its hips and part
 * company when the drive leaves the pelvis behind — a chest a fixed distance in front
 * of a pelvis that keeps travelling reads as a deeper and deeper fold while the trunk
 * itself is standing up out of it, which is the mistake this reading exists to
 * avoid.
 */
const trunkLean = (frame) => Math.atan2(-frame.torso.up[2], frame.torso.up[1]) * DEG

/** How far a bone is from plumb, in degrees: a shin that hangs is a shin at nought. */
const fromVertical = (a, b) => {
  const bone = a.map((v, axis) => v - b[axis])
  return (Math.acos(Math.min(1, Math.abs(bone[1]) / Math.hypot(...bone))) * 180) / Math.PI
}

/** Every frame of the delivery, from the top of the windup to the set again. */
/** One window of the delivery, at the step a *rate* can be read off: the whole
 * delivery's own sweep is a fortieth of a second, which is coarser than the last
 * twentieth of the drive, so a test that reads speeds takes its own. */
const sweepWindow = async (page, from, to, step) => {
  await page.goto(`${HARNESS}?clip=${from}`)
  await page.waitForFunction(() => window.__vr?.ready === true && window.__vr.probe() !== null)
  return page.evaluate(
    ([start, end, size]) => window.__vr.sweep(start, end, size),
    [from, to, step],
  )
}

// The delivery, walked frame by frame. The default window is the throw's own half of
// the clip — the windup through the landing and just into the hold — because that is
// what most of the suite reads, and a frame inside the hold is the hold's own pose (it
// is a second of one pose to the frame); the tests that read the clip's tail (the
// finish he stands in, the recovery, and the stance the loop comes home to) ask for the
// whole of it.
const sweepDelivery = async (page, to = 2.083) => {
  await page.goto(`${HARNESS}?clip=0`)
  await page.waitForFunction(() => window.__vr?.ready === true && window.__vr.probe() !== null)
  return page.evaluate((end) => window.__vr.sweep(0, end, 0.04), to)
}

test('the windup winds the shoulders off the plate and the drive hands them the turn', async ({ page }) => {
  // The pose the delivery is thrown by turns in one order and comes round in one
  // piece: the set is square-side-on (the shoulder line along the way the pitch
  // goes), the windup *winds* it further off — the kick and the swivel carry the
  // pelvis round under a chest that stays closed over it — and then the back leg's
  // drive unwinds the whole of it, so that by the release the shoulders are already
  // past square rather than arriving with them. The turn the arm is left to make is
  // therefore only the arm's; what is left over is the momentum, and it is why the
  // line carries on round after the ball has gone rather than stopping with it.
  //
  // Read off the realised sockets, because this is the one promise that is a
  // *shape*: the numbers that author it (chestYaw under hipYaw at the cock, over it
  // after the plant) are the sequence's, and the point of reading the model is that
  // the two are the same turn. The window is the whole clip, because the recovery it
  // reads the turn's own let-go at is at the far end of it.
  const frames = await sweepDelivery(page, AUTHORED_CLIP_END)
  const at = (clip) => {
    const frame = frames.find((row) => Math.abs(row.clip - clip) < 0.02)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return shoulderLine(frame)
  }
  expect(Math.abs(at(0)), 'the set should stand square-side-on').toBeLessThan(4)
  // Wound *past* side-on, away from the plate: the cock is a coil, not a stance.
  expect(at(0.8), `the cock holds the shoulders at ${at(0.8).toFixed(0)}°`).toBeLessThan(-12)
  // Then the drive hands them over: past square (90°) before the release, and
  // further round after it than they were square — the over-spin.
  // (Read off the sockets, the plant's own turn is 37°: the sequence now holds the
  // coil through the fall and the break — the pelvis is 2° off the balance's own
  // winding at 0.92s and the chest is still 116° off the plate at the plant — so
  // what the plant carries is the *start* of the unwind rather than most of it (see
  // the sequence's fall key). What is pinned is the order, not the size: the line
  // has come off the cock's own wound angle (−33° here) and is climbing, and the
  // whole of the over-spin below is still made after the release.)
  expect(at(1.12), `the plant has the shoulders at ${at(1.12).toFixed(0)}°`).toBeGreaterThan(28)
  // Past square by the release (90°) with the whole of the turn's *whip* after it —
  // and read off the realised sockets, which the trunk's own fold carried back onto
  // the plate line (see trunkLean) cost a few degrees of: the body that was handed
  // the uncompensated lean read 115 here with its trunk folded 70° off the pitch's
  // line, and this one reads 110 with the trunk turning on its own axis. The pins
  // that hold the whip are the over-spin ones below.
  expect(at(RELEASE), `the release has them at ${at(RELEASE).toFixed(0)}°`).toBeGreaterThan(106)
  const after = frames.filter((row) => row.clip >= RELEASE && row.clip <= 1.72)
  const over = Math.max(...after.map(shoulderLine))
  expect(over, `the shoulders only reach ${over.toFixed(0)}°: the momentum does not carry them past the plate`)
    .toBeGreaterThan(145)
  expect(
    over - at(RELEASE),
    `the shoulders turn ${(over - at(RELEASE)).toFixed(0)}° after the ball goes: the turn dies with the release`,
  ).toBeGreaterThan(25)
  // And it is a whip, not a spin: the shoulders wind back toward the set as the
  // body recovers, rather than staying wound round the plate.
  expect(at(3.14), `the recovery leaves the shoulders at ${at(3.14).toFixed(0)}°`).toBeLessThan(60)
})

test('the kick rocks the weight onto the drive leg', async ({ page }) => {
  // The windup is stood on one foot: as the front leg comes up the body rocks *onto*
  // the drive leg — which is why the shoe on the rubber stays where it is through the
  // windup — and it is the hips that have to have gone there. The pelvis' own centre
  // line stands over the drive shoe rather than between the two feet (measured: 13-14
  // cm from the drive ankle at the worst frame of the kick, against 37-39 to the
  // kicking foot's, which is a hand's width off the ground by the top of the kick).
  // Read off the ankles and the hip sockets, so it is the realised skeleton that has
  // to be carrying the weight and not the authoring.
  const frames = await sweepDelivery(page)
  let worst = 0
  let nearest = Infinity
  for (const frame of frames) {
    if (frame.clip < 0.5 || frame.clip > 0.82) continue
    const drive = frame.legs.find((leg) => leg.side === 1)
    const front = frame.legs.find((leg) => leg.side === -1)
    expect(drive.planted, `the drive foot comes off the rubber at ${frame.clip}s`).toBe(true)
    expect(front.planted, `the kicking foot is on the ground at ${frame.clip}s`).toBe(false)
    const pelvis = pelvisOf(frame)
    const toDrive = Math.hypot(pelvis[0] - drive.ankle[0], pelvis[2] - drive.ankle[2])
    const toFront = Math.hypot(pelvis[0] - front.ankle[0], pelvis[2] - front.ankle[2])
    worst = Math.max(worst, toDrive)
    nearest = Math.min(nearest, toFront / toDrive)
  }
  expect(
    worst,
    `the pelvis stands ${(worst * 100).toFixed(0)} cm off the drive shoe through the kick`,
  ).toBeLessThan(0.16)
  expect(
    nearest,
    `the pelvis is only ${nearest.toFixed(1)} times nearer the drive foot than the kicking one`,
  ).toBeGreaterThan(2)
  console.log(
    `weight: the pelvis stands at most ${(worst * 100).toFixed(0)} cm from the drive shoe's own ` +
      `ankle through the kick, and ${nearest.toFixed(1)}x nearer it than the kicking foot`,
  )
})

test('the drive carries the whole body over the plant, and the torso goes with it', async ({ page }) => {
  // The delivery's forward half, read off the body's own joint sockets: the pelvis
  // travels toward the plate under the front foot's step — the drive is the whole
  // body's, not the legs' — and the torso is *launched* by folding further over the
  // pelvis as it goes, so that at the release the chest is a good way ahead of the
  // hips rather than standing up out of them. The fold is the angle the chest's own
  // centre makes with the vertical over the pelvis' centre: nought is a body
  // standing straight up.
  const frames = await sweepDelivery(page, AUTHORED_CLIP_END)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.02)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  // The step: how far ahead of the pivot foot the front one lands, against where it
  // stood in the set. The set's own spread is a stance's (0.28 rig units); a stride
  // is most of a metre of it.
  const split = (clip) => {
    const frame = row(clip)
    const pivot = frame.legs.find((leg) => leg.side === 1)
    const front = frame.legs.find((leg) => leg.side === -1)
    return pivot.ankle[2] - front.ankle[2]
  }
  const stance = split(0)
  const planted = split(1.12)
  expect(
    planted - stance,
    `the stride steps ${(planted - stance).toFixed(2)} rig units further than the stance: it is a shuffle`,
  ).toBeGreaterThan(0.6)
  // ...and the body is carried by it: the pelvis' own travel toward the plate from
  // the top of the windup to the release.
  const drive = pelvisOf(row(0.8))[2] - pelvisOf(row(RELEASE))[2]
  expect(drive, `the pelvis lands ${drive.toFixed(2)} rig units forward of the cock: it drives in place`)
    .toBeGreaterThan(0.6)
  // The launch: out of the set, off a trunk that is still nearly upright at the
  // plant, and laid over hard by the release — the ball goes with the body over the
  // front foot rather than off a torso that has stood back up. The fold waiting for
  // the release is the delivery's own promise (see the sequence's break and plant),
  // and it is the *speed* the lean arrives at that is the other half of it (see the
  // three speeds below).
  const fold = (clip) => chestFold(row(clip))
  expect(Math.abs(fold(0)), `the set is folded ${fold(0).toFixed(0)}° over its own hips`).toBeLessThan(3)
  expect(
    fold(1.12),
    `the plant is already folded ${fold(1.12).toFixed(0)}° over its hips: the lean does not wait for the release`,
  ).toBeLessThan(26)
  expect(
    fold(1.24) > fold(1.12),
    `the torso unfolds from ${fold(1.12).toFixed(0)}° at the plant to ${fold(1.24).toFixed(0)}° at the cock: it is not launched into the throw`,
  ).toBe(true)
  expect(
    fold(RELEASE) - fold(1.12),
    `the trunk lays over only ${(fold(RELEASE) - fold(1.12)).toFixed(0)}° across the whole of the last of the stride`,
  ).toBeGreaterThan(12)
  expect(fold(RELEASE), `the release is folded ${fold(RELEASE).toFixed(0)}°`).toBeGreaterThan(35)
})

test('the lead arm lifts with the leg and then hands the shoulders round', async ({ page }) => {
  // The glove arm is the delivery's other engine. It comes up *with* the kick (a
  // windup lifts its arms as it lifts its leg), and then it does two things that
  // are the whole of how the body is turned after the break: its elbow rises while
  // the glove holds its own height — the forearm pointing down off a raised elbow
  // — and then the forearm is thrown out away from the body and *straightens*,
  // reaching nearly the whole of the arm's span by the middle of the follow-through
  // and coming down from there. The turn follows the hand that is thrown: measured
  // on the realised skeleton, the chest's own turn is smaller into the glove's own
  // cross of the body's midline than it is after it.
  //
  // What this pins is the *shape*, which is the one thing the pose cannot answer for
  // itself: the keys name where the glove's elbow goes and the solve is what puts it
  // there, so the elbow's own height and the forearm's own angle are read off the
  // model (see the probe's `arms`).
  const frames = await sweepDelivery(page)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.02)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const elbowBelowShoulder = (clip) => leadArm(row(clip)).elbow[1] - leadArm(row(clip)).shoulder[1]
  const gloveBelowShoulder = (clip) => leadArm(row(clip)).wrist[1] - leadArm(row(clip)).shoulder[1]
  // The arms come up with the leg: the glove travels from the belt to the chest over
  // the windup (a stance's hands hang at the belt and a windup's are at the chest),
  // and the elbow comes up further still once the knee is at the top of the kick.
  expect(
    gloveBelowShoulder(0.8) - gloveBelowShoulder(0),
    'the hands do not come up with the kick',
  ).toBeGreaterThan(0.08)
  // ...and it is *both* of them, not the glove's alone: the clasp the two are holding
  // rises a hand's width against the chest's own centre as the knee comes up (measured
  // 12 cm from the set to the top of the kick, which is the shape a windup's high hands
  // are — the ball under the chin rather than down at the belt).
  const chestMid = (clip) => {
    const sockets = row(clip).arms.map((arm) => arm.shoulder)
    return sockets[0].map((value, axis) => (value + sockets[1][axis]) / 2)
  }
  const handsUp = (clip) => row(clip).ballRig[1] - chestMid(clip)[1]
  expect(
    handsUp(0.8) - handsUp(0),
    `the clasp only comes up ${((handsUp(0.8) - handsUp(0)) * 100).toFixed(0)} cm toward the chest over the kick`,
  ).toBeGreaterThan(0.09)
  // The sample the rise is read from is the sweep's own (0.6s, a fifth of a second
  // before the top of the kick), and the rise is *how much nearer the shoulder the
  // elbow ends up*: the elbow's own height above the shoulder, now less the same
  // reading then.
  expect(
    elbowBelowShoulder(0.8) - elbowBelowShoulder(0.6),
    `the lead elbow rises ${(elbowBelowShoulder(0.8) - elbowBelowShoulder(0.6)).toFixed(3)} rig units over the kick`,
  ).toBeLessThan(0.06)
  // ...and the rise is authored *late*: the leg comes up, the body falls forward onto
  // the drive leg and only then does the elbow come up (see the sequence's fall), so
  // the reading is the two halves of it — what the kick does not move, and what the
  // fall does.
  expect(
    elbowBelowShoulder(1.0) - elbowBelowShoulder(0.8),
    `the lead elbow only rises ${(elbowBelowShoulder(1.0) - elbowBelowShoulder(0.8)).toFixed(3)} rig units over the fall`,
  ).toBeGreaterThan(0.2)
  // ...and the glove does not rise with it: the elbow does the rising, so the forearm
  // ends up pointing down off it rather than the hand coming up to meet it.
  expect(
    Math.abs(gloveBelowShoulder(1.0) - gloveBelowShoulder(0.8)),
    'the glove rose with the elbow rather than holding its own height',
  ).toBeLessThan(0.09)
  // ...and it hangs *down off* that raised elbow: with the elbow brought up to within
  // a few centimetres of its own shoulder and the glove left at the chest, the
  // forearm is the whole of the drop between them, which is a good 45° below the
  // horizontal — the raised-elbow shape the windup is for, not the 5° a level arm
  // reads (measured on the realised skeleton: 33° at the elbow's own top).
  const fore = leadForearm(row(1.0))
  expect(fore, `the lead forearm points ${fore.toFixed(0)}° at the top of the kick`)
    .toBeLessThan(-25)
  expect(fore).toBeGreaterThan(-65)
  // Then the throw: from the plant the lead arm only ever gets *longer*, and it is
  // nearly straight by the middle of the follow-through. Read to the finish and no
  // further: the fold back toward the set that comes after it is the recovery's own,
  // and a lead arm that came down to the fielding posture without ever folding would
  // be the arm held out rather than let down.
  let longest = 0
  let previous = 0
  for (let clip = 1.12; clip <= 1.68 + 1e-9; clip += 0.04) {
    const now = leadStraightness(row(clip))
    expect(
      now,
      `the lead arm folds back from ${previous.toFixed(3)} to ${now.toFixed(3)} of its span at ${clip}s: it is not straightening through the throw`,
    ).toBeGreaterThan(previous - 0.01)
    previous = now
    longest = Math.max(longest, now)
  }
  expect(
    longest,
    `the lead arm only reaches ${(longest * 100).toFixed(0)}% of its span: the forearm never straightens`,
  ).toBeGreaterThan(0.95)
  // ...and it *lowers* from there to the finish, which is the follow-through letting
  // the arm down rather than holding it out.
  expect(
    gloveBelowShoulder(RELEASE) - gloveBelowShoulder(1.68),
    'the lead glove does not come down over the follow-through',
  ).toBeGreaterThan(0.05)
})

test('the glove shows the plate with its palm as the elbow comes up', async ({ page }) => {
  // The windup's glove hand is the delivery's own way of showing the ball, and the
  // showing is a *twist*: the hand hangs off the raised elbow and its palm comes round
  // to face the strike zone — the one turn a hand has left once the aim has placed its
  // fingers, taken about the hand's own line. Read here three ways on the realised
  // skeleton, all in the rig frame the pitch runs along -z in: the palm marker's own
  // facing (``palmFacing`` — the model's statement of the palm's normal, the same node
  // the bat grip is solved on), the line the hand's own fingers run along, and the
  // facing the pose asked the palm for (see the keys' own ``glovePalm``).
  const frames = await sweepDelivery(page)
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * DEG
  const palmOffPlate = (frame) => angle(leadArm(frame).palm, [0, 0, -1])
  // How far the hand's own line is off the forearm's: a wrist may hang a hand off a
  // bone, but it is not a joint that points *sideways* — and the whole of what the
  // palm did here it did by rolling about the line it was given.
  const wristBend = (frame) => {
    const arm = leadArm(frame)
    return angle(arm.aim, sub(arm.wrist, arm.elbow))
  }
  let worst = 0
  let worstBend = 0
  let worstAsk = 0
  for (const frame of frames) {
    if (frame.clip < 0.92 || frame.clip > 1.3) continue
    worst = Math.max(worst, palmOffPlate(frame))
    worstBend = Math.max(worstBend, wristBend(frame))
    worstAsk = Math.max(worstAsk, angle(leadArm(frame).palm, leadArm(frame).palmAsk))
  }
  expect(
    worst,
    `the glove's palm is ${worst.toFixed(0)}° off the plate from the elbow's top to the release`,
  ).toBeLessThan(22)
  expect(
    worstBend,
    `the hand stands ${worstBend.toFixed(0)}° off its own forearm: the palm was pointed at the zone rather than rolled onto it`,
  ).toBeLessThan(70)
  expect(
    worstAsk,
    `the palm misses the facing the pose asked for by ${worstAsk.toFixed(0)}°: a roll cannot reach it`,
  ).toBeLessThan(30)
  // ...and it is showing the zone *before* the shoulders get there, which is the
  // picture a palm-led unwind is: at the elbow's own top the palm is on the plate
  // while the shoulder line is still wound *off* it — ninety-odd degrees short of
  // square (see the windup's own reading of that line) — and it holds through the
  // break, the striding plant, the cock and the release.
  const top = frames.find((frame) => Math.abs(frame.clip - 1.0) < 0.02)
  expect(top, 'the sweep should cover the elbow\u2019s own top').not.toBeUndefined()
  expect(
    palmOffPlate(top),
    `the palm is ${palmOffPlate(top).toFixed(0)}° off the plate at the elbow\u2019s own top`,
  ).toBeLessThan(14)
  expect(
    shoulderLine(top),
    `the shoulders are already at ${shoulderLine(top).toFixed(0)}° by the elbow's top: the palm did not get there first`,
  ).toBeLessThan(20)
  console.log(
    `palm: the glove holds the plate within ${worst.toFixed(0)}° from the elbow's own top (1.0s, ` +
      `with the shoulders still ${(90 - shoulderLine(top)).toFixed(0)}° short of square) to the ` +
      `release · the hand's own line never more than ${worstBend.toFixed(0)}° off its forearm`,
  )
})

test('the glove closes over the ball while the hands are together', async ({ page }) => {
  // A grip showing is a glove left open on the palm the ball is sitting on. While the
  // hands are together — the set and the whole of the windup up to the break — the
  // ball is inside the glove (see the unit suite's clasp read: the pose's own ball is
  // the glove's own palm, the two hands one hand's worth of place), so what the batter
  // is shown is the *glove*: its palm turned away from the plate, so the mitt's own
  // back is what he is looking at, and its fingers closed over the hand the ball is
  // in. Both are read here off the realised hand — the palm's own facing, and the curl
  // the driver has put into the fingers' bone — because either one can be authored
  // and then spent elsewhere: a palm ask the hand's own line cannot reach is rolled
  // back onto it (see the driver's palm solve), and a curl is only closed if the
  // driver was told to close it.
  //
  // The closure is the clasp's own and not a clenched glove: it is authored to open
  // over the same fifth of a second that parts the hands, so the glove that comes up
  // to show the plate (see the palm test above) is an open one. The plate is at the
  // rig's -z — the pitch goes that way — so away from it is +z here.
  const claw = async (clip) => {
    const at = await openAt(page, clip)
    const glove = at.arms.find((arm) => arm.side === 'L')
    const offset = sub(at.ballRig, glove.wrist)
    return {
      clip,
      curl: glove.curl,
      palm: glove.palm,
      // How much of the ball's own offset from the wrist is down the glove's own hand
      // line: one is a ball carried in the glove's palm, nought is one beside it.
      carried: dot(offset, unit(glove.aim)) / length(offset),
    }
  }
  for (const clip of [0, 0.34, 0.58, 0.8, 0.92]) {
    const at = await claw(clip)
    expect(
      at.curl,
      `at ${clip}s the glove's fingers are only ${at.curl.toFixed(2)} rad closed, with the ball in its palm`,
    ).toBeGreaterThan(1.3)
    expect(
      at.carried,
      `at ${clip}s the ball sits ${(100 * at.carried).toFixed(0)}% down the glove's own hand line: it is not in the glove`,
    ).toBeGreaterThan(0.9)
  }
  // ...and the palm is turned away while he stands in the stance and rocks: the
  // batter sees the back of the mitt, not the ball riding its palm.
  for (const clip of [0, 0.34]) {
    const at = await claw(clip)
    expect(
      at.palm[2],
      `at ${clip}s the glove's palm faces ${(at.palm[2]).toFixed(2)} of the way at the plate: the grip is being shown`,
    ).toBeGreaterThan(0.8)
  }
  // The break opens it: by the plant the glove is the open one the plate is shown.
  for (const clip of [1.12, 1.24]) {
    const at = await claw(clip)
    expect(
      at.curl,
      `the glove's fingers are still ${at.curl.toFixed(2)} rad closed at ${clip}s: it comes to the plate as a fist`,
    ).toBeLessThan(0.6)
  }
  const set = await claw(0)
  const open = await claw(1.24)
  console.log(
    `clasp: the glove closes ${set.curl.toFixed(2)} rad over the ball through the set and the windup ` +
      `(its palm ${(100 * set.palm[2]).toFixed(0)}% away from the plate there, the ball ` +
      `${(100 * set.carried).toFixed(0)}% down its own hand line) and is open to ${open.curl.toFixed(2)} rad by the plant`,
  )
})

test('the windup hangs both elbows, and the trail arm is the lead arm’s mirror', async ({ page }) => {
  // The windup's own two promises, both read off the realised skeleton.
  //
  // The first is that the *hands* come up and the elbows do not: a windup lifts its
  // arms to the chest with the elbows hanging under them, and what this pins is the
  // failure of that — the throwing elbow riding up with the hands, which is a wing.
  // On the delivery before this it came up 15 cm by the gather, level with its own
  // shoulder (−0.113 of a rig unit under it at the set against −0.007 at the gather),
  // while the glove elbow hung where it was put.
  //
  // The second is that while the hands are together the two arms are *one shape*:
  // the throwing arm is the glove arm's own mirror about the body's midline, so the
  // two elbows hang level with each other on their own sides instead of one high and
  // one low. The sequence derives the second arm from the first rather than authoring
  // it twice (see its `mirrorTracks`), and that the derivation is exact is the unit
  // suite's reading; what this reads is what the *driver* makes of it.
  //
  // Both readings are of the realised joints, because what the pose asks for is a
  // *hint*: the driver is what bends the arm to it (see the driver's open-arm solve),
  // and the arms' own reach moves the sockets they hang from. So each elbow is read
  // as the *shape* of its own arm — where it sits relative to the socket it hangs
  // from — which is the reading a clavicle that swung for its own hand cannot carry.
  //
  // The elbow *raise* itself — the glove elbow coming up through the kick and cock
  // with the glove held where it was and the forearm left pointing down off it — is
  // the lead-arm test above's; what is pinned here is the level it comes up to, and
  // the hang it starts from.
  const frames = await sweepDelivery(page)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.02)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const winding = frames.filter((frame) => frame.clip <= 0.58 + 1e-9)
  expect(winding.length, 'the sweep should cover the windup').toBeGreaterThan(12)
  const set = row(0)
  // The hands come up to the chest over the windup — a stance's hands hang at the
  // belt and a windup's are at the chest — and the elbows hold while they do it: in
  // the world to within the body's own settle (the pelvis drops two centimetres at
  // the rocker and stands up five over the gather), and, under their own shoulders,
  // to within a couple of centimetres, which is the promise no settle can move.
  expect(
    leadArm(row(0.56)).wrist[1] - leadArm(set).wrist[1],
    'the hands do not come up to the chest over the windup',
  ).toBeGreaterThan(0.08)
  let held = 0
  let hang = 0
  let mirrored = 0
  for (const frame of winding) {
    const lead = leadArm(frame)
    const trail = trailArm(frame)
    held = Math.max(
      held,
      Math.abs(lead.elbow[1] - leadArm(set).elbow[1]),
      Math.abs(trail.elbow[1] - trailArm(set).elbow[1]),
    )
    hang = Math.max(
      hang,
      Math.abs(armShape(lead)[1] - armShape(leadArm(set))[1]),
      Math.abs(armShape(trail)[1] - armShape(trailArm(set))[1]),
    )
    mirrored = Math.max(mirrored, length(sub(armShape(lead), armShape(trail))))
  }
  console.log(
    `windup: elbows held to ${(held * 100).toFixed(1)} cm in the world and ` +
      `${(hang * 100).toFixed(1)} cm of their own shape · the two arms' shapes ` +
      `${(mirrored * 100).toFixed(1)} cm apart`,
  )
  // The bounds are the measured worsts, with none of the slack a rule that has stopped
  // holding could hide in: 6.1 cm of body for the world, 2.5 cm of arm for the shape,
  // and 5.1 cm for the two arms against each other. The same three readings on the
  // delivery whose throwing elbow rode up with the hands are 15 cm, 11 cm and 29 cm —
  // each of these reddens on it.
  expect(
    held,
    `an elbow moves ${held.toFixed(3)} rig units over the windup: the hands carry it up`,
  ).toBeLessThan(0.07)
  expect(
    hang,
    `an elbow hangs ${hang.toFixed(3)} rig units off where its own shoulder had it`,
  ).toBeLessThan(0.035)
  expect(
    mirrored,
    `the two arms are ${mirrored.toFixed(3)} rig units apart in shape: the trail arm is not the lead arm's mirror`,
  ).toBeLessThan(0.06)
  // Then the kick and cock: the glove elbow comes up — that rise is the test above's
  // — and it comes up to *almost level with the throwing one*, which is the shape the
  // windup is for. Neither runs away from the other: the two elbows are a hand's
  // width apart at the widest over the whole of it, and level to within a few
  // centimetres at the top of the kick.
  let widest = 0
  for (let clip = 0; clip <= 0.56 + 1e-9; clip += 0.04) {
    const frame = row(clip)
    widest = Math.max(
      widest,
      Math.abs(leadArm(frame).elbow[1] - trailArm(frame).elbow[1]),
    )
  }
  // What each elbow is doing *under its own shoulder* at the elbow's own top, which
  // is the reading the two arms' own shapes are: the lead has come up to nearly level
  // with the shoulder it hangs from, and the throwing arm — which the mirror let go of
  // across the fall — is still hanging its own quarter of a unit under its own. (The
  // top is 1.0s rather than the top of the kick: the rise is authored *late* — the
  // kick lifts the leg and the hands, and the elbow comes up over the fall — see the
  // sequence's fall key and the lead-arm test above.)
  const under = (frame, arm) => arm(frame).shoulder[1] - arm(frame).elbow[1]
  const leadUnder = under(row(1.0), leadArm)
  const trailUnder = under(row(1.0), trailArm)
  const raised = leadArm(row(1.0)).elbow[1] - leadArm(row(0.56)).elbow[1]
  const glove = Math.abs(leadArm(row(1.0)).wrist[1] - leadArm(row(0.56)).wrist[1])
  console.log(
    `kick: elbows at most ${(widest * 100).toFixed(1)} cm apart through the windup · ` +
      `at the elbow's own top the lead is ${(leadUnder * 100).toFixed(1)} cm under its shoulder ` +
      `and the throwing one ${(trailUnder * 100).toFixed(1)} cm under its own · lead elbow up ` +
      `${(raised * 100).toFixed(1)} cm · glove moved ${(glove * 100).toFixed(1)} cm`,
  )
  expect(
    widest,
    `the two elbows are ${widest.toFixed(3)} rig units apart somewhere in the windup`,
  ).toBeLessThan(0.07)
  expect(raised, 'the lead elbow does not come up over the fall').toBeGreaterThan(0.08)
  // The rise is the *lead* arm's: it comes up to almost its own shoulder height —
  // which is what makes the forearm slant down off it to the glove — while the
  // throwing arm, whose mirror it was through the windup, holds its own hang.
  expect(
    leadUnder,
    `the lead elbow is ${leadUnder.toFixed(3)} rig units under its shoulder at its own top: it did not come up to the shoulder`,
  ).toBeLessThan(0.08)
  // ...and the rise is the *lead* arm's own work rather than a pair of elbows going up
  // together: while the hands are clasped the two are one shape (the mirror sees to
  // it, and the fall is the last of that — 8.6 and 8.3 cm under their own shoulders at
  // 0.92s), and by the plant they have gone their own ways. The lead is a hand's width
  // under its shoulder with the glove still at the chest; the throwing arm has climbed
  // *above* its own into the cock.
  const planted = (arm) => under(row(1.12), arm)
  expect(
    planted(leadArm) - planted(trailArm),
    `the two elbows are only ${((planted(leadArm) - planted(trailArm)) * 100).toFixed(1)} cm apart in their own hang at the plant`,
  ).toBeGreaterThan(0.10)
  // ...with the glove left where it was while the elbow went up under it, which is
  // what makes the forearm point down off a raised elbow rather than the hand coming
  // up to meet it (the test above reads the forearm's own angle).
  // ...and the glove comes *with* it a little, which is the windup's own lift: the
  // hands are taken up under a raised elbow (the gather and the balance key carry the
  // clasp up to the chin), so the hand rises with the elbow rather than the elbow
  // rising out from under a hand that stays put — but only a fraction of what the
  // elbow's own rise is, which is what leaves the forearm slanting *down* off the
  // elbow rather than the hand coming up to meet a folded arm (the test above reads
  // the forearm's own angle, and it is the shape this pair is guarding).
  expect(
    glove,
    `the glove rises ${glove.toFixed(3)} rig units against the elbow's ${raised.toFixed(3)}: the raise is the hand's own rather than the elbow's`,
  ).toBeLessThan(raised * 0.35)
})

test('the whole body travels with the pitch, and the back foot follows it', async ({ page }) => {
  // The delivery's travel finishes in the *feet*: the hips go through the spot the
  // front foot planted on — a body carried by its own momentum does not stop at the
  // foot it stepped onto — and the pivot foot, which the drive peeled off the rubber
  // at the break, swings round the front leg and comes down well past that plant,
  // on the glove's own side, which is where a body turned this far round puts a
  // foot. Read off the two ankles and the two hip sockets, so it is the skeleton
  // that has to have travelled and not merely the pose's own numbers.
  const frames = await sweepDelivery(page)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.02)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const pivotOf = (frame) => frame.legs.find((leg) => leg.side === 1)
  const frontOf = (frame) => frame.legs.find((leg) => leg.side === -1)
  // The pelvis' own travel from the top of the windup to the finish: a whole rig
  // unit toward the plate.
  const drive = pelvisOf(row(0.8))[2] - pelvisOf(row(1.68))[2]
  expect(drive, `the pelvis travels ${drive.toFixed(2)} rig units with the pitch`)
    .toBeGreaterThan(0.9)
  // ...through the front foot's own plant place, which stands still: the hips go by
  // it rather than stopping over it.
  const front = frontOf(row(1.64))
  expect(
    pelvisOf(row(1.64))[2],
    `the pelvis stops ${(pelvisOf(row(1.64))[2] - front.ankle[2]).toFixed(3)} rig units short of the foot it planted on`,
  ).toBeLessThan(front.ankle[2])
  // And the back foot follows: off the rubber (airborne at the release, which the
  // drive peeled it off) and down beyond the front foot's plant, on the glove's side
  // of it — with the whole of that travel made from where the rubber left it.
  expect(pivotOf(row(RELEASE)).planted, 'the pivot foot is still on the rubber at the release').toBe(false)
  const landed = pivotOf(row(1.68))
  const lead = leadArm(row(1.68)).wrist[0]
  expect(landed.planted, 'the back foot never lands').toBe(true)
  expect(Math.abs(landed.sink), 'the back foot lands in the dirt rather than on it').toBeLessThan(0.002)
  expect(
    frontOf(row(1.68)).ankle[2] - landed.ankle[2],
    'the back foot lands behind the front foot rather than past its own plant',
  ).toBeGreaterThan(0.05)
  expect(
    Math.sign(landed.ankle[0] - frontOf(row(1.68)).ankle[0]),
    `the back foot lands on the other side of the front one from the glove (glove at ${lead.toFixed(2)}, foot at ${landed.ankle[0].toFixed(2)})`,
  ).toBe(Math.sign(lead))
  const travel = Math.hypot(
    landed.ankle[0] - pivotOf(row(RELEASE)).ankle[0],
    landed.ankle[2] - pivotOf(row(RELEASE)).ankle[2],
  )
  expect(travel, `the back foot swings ${travel.toFixed(2)} rig units round to its landing`)
    .toBeGreaterThan(0.8)
  // And the swing's *length* is more than the stride's: the delivery's momentum
  // carries the drive leg through the swing and lands it past the stride's own
  // reach, out beyond the lead foot the front leg planted on — because that is what
  // the body has left to go to: the hips are drawn forward over a foot they have
  // not travelled to yet, and stop *later* for it (see the finish, and the three
  // speeds below). What keeps it a swing rather than a leg thrown out after a body
  // that has gone is the leg's own reach — the driver rolls a foot it cannot place
  // — so the extra is a share of the stride and not a step of its own.
  //
  // The *share* is most of another stride, and that is the finish's own authoring
  // rather than the swing's temper: the landing is placed so that the pelvis stands
  // between the two feet it stands on (see the pose's finish note), and a trail foot
  // the hips' own shadow has to fall between is a foot a good deal further on than
  // the stride's plant — the whole of the stride again and a little on top, against
  // the half the swing left it at before. Past a stride and a fifth it would stop
  // being an arc at all: a foot the leg's own length cannot draw a circle to is a
  // step, so the bound is where the swing's own radius runs out.
  const rubber = pivotOf(row(0)).ankle
  // The stride's own reach is read where the striding foot has *arrived*, at 1.32s,
  // rather than at the old 1.12s: the kick is carried longer now, so the foot is
  // still coming down through 1.12 and it is not until 1.32 that it stands at the
  // place it plants on (see the lead leg's own note in the assembly).
  const planted = frontOf(row(1.32)).ankle
  const stride = Math.hypot(planted[0] - rubber[0], planted[2] - rubber[2])
  const forward = rubber[2] - landed.ankle[2]
  const across = rubber[0] - landed.ankle[0]
  console.log(
    `swing: the back foot travels ${forward.toFixed(2)} rig units forward against a stride of ` +
      `${stride.toFixed(2)} · ${across.toFixed(2)} of the swing is across the body`,
  )
  expect(
    forward - stride,
    `the back foot travels ${forward.toFixed(3)} rig units forward against a stride of ${stride.toFixed(3)}: it lands where the stride already had it`,
  ).toBeGreaterThan(0.2)
  expect(
    forward - stride,
    `the back foot travels ${forward.toFixed(3)} rig units forward against a stride of ${stride.toFixed(3)}: it is reaching for a place the body has already gone by`,
  ).toBeLessThan(1.2)
  // ...and the landing foot is *ahead* of the lead foot's own plant, which is the
  // place the hips are still travelling to: what the extra length buys is a body
  // with somewhere to go on the follow-through, rather than one stopped on a foot.
  expect(
    frontOf(row(1.68)).ankle[2] - landed.ankle[2],
    'the drive leg lands level with the foot the stride planted on, so the hips have nowhere left to travel',
  ).toBeGreaterThan(0.2)
})

test('the back leg spins out to its landing rather than stepping forward', async ({ page }) => {
  // The follow-through's back leg comes *round*. The pivot foot is planted on the
  // rubber and the body turns over it, so the shoe's line is what the leg bends in
  // (see the pose's own leg solve) and the drive brings that line round onto the
  // plate's by the plant; from the release the same yaw is what spins the leg out,
  // and a shoe left pointing at the plate while the foot travels forward and across
  // is a leg *stepping* — the foot goes by and the thigh, the knee and the shin stay
  // where they were pointing. Read off the pose's own knee hint, which is the shoe's
  // yaw in the rig frame (the hint is the plane's own direction, so its angle against
  // the foot's own place *is* the shoe's line), and off the leg's own line, the
  // hip-to-ankle chord, which is the way the swing actually went. Positive is out to
  // the glove side, which is the side the back foot swings to.
  //
  // The suite reads the plane off the pose rather than off the bent leg because a
  // nearly straight leg shows its own rotation in its joints barely at all: the chord
  // from the hip to the landing foot is within 15° of the plate's line in every frame
  // of the follow-through whether or not the shoe has come round, and what the eye
  // reads as the spin is the shoe and the shin riding in that line.
  const frames = await sweepDelivery(page)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.01)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const pivotOf = (frame) => frame.legs.find((leg) => leg.side === 1)
  // The shoe's own line: the knee's hint direction, which the driver bends the leg
  // over, read in the ground plane.
  const plane = (clip) => {
    const leg = pivotOf(row(clip))
    return Math.atan2(-(leg.hint[0] - leg.target[0]), -(leg.hint[2] - leg.target[2]))
  }
  // How far the leg's own line has swung from the plate's: the chord, out to the
  // glove side of it, in the same sign as the plane above it.
  const swing = (clip) => {
    const leg = pivotOf(row(clip))
    return Math.atan2(-(leg.ankle[0] - leg.hip[0]), -(leg.ankle[2] - leg.hip[2]))
  }
  // By the middle of the swing the shoe has come a good way round — a hand's width of
  // turn's worth, against the few degrees the drive left it at — and it is still going
  // the same way every key of the way to the landing.
  expect(plane(1.56) * DEG, `the pivot shoe is only ${(plane(1.56) * DEG).toFixed(1)}° round mid-swing`)
    .toBeGreaterThan(25)
  for (const clip of [1.4, 1.44, 1.48, 1.52, 1.56, 1.6, 1.64]) {
    expect(
      plane(clip + 0.04) * DEG,
      `the pivot shoe turns back the other way at ${clip + 0.04}s: ${(plane(clip) * DEG).toFixed(1)}° then ${(plane(clip + 0.04) * DEG).toFixed(1)}°`,
    ).toBeGreaterThan(plane(clip) * DEG - 1)
  }
  // At the landing the shoe is well out to the glove side of the plate's line...
  expect(plane(1.68) * DEG, `the back foot lands with its shoe only ${(plane(1.68) * DEG).toFixed(1)}° round`)
    .toBeGreaterThan(45)
  // ...and it *rides the swing* to the end: the shoe's own line against the line it
  // held a fifth of a second before the foot is down, within a hand's width of turn.
  // That is the spin read as the eye reads it — the shoe and the shin going on round
  // with the leg rather than the foot arriving under a shoe left behind — and it is
  // read against the frame *before* the landing rather than against the direction the
  // foot itself came in on, which is what this used to hold. The two are not the same
  // line any more, and the difference is the finish's own doing: the trail foot lands
  // under the body's own line now (the hips' shadow between the feet — see the pose's
  // finish note), so the last fifth of a second of the foot's path is *across* the
  // line the swing came round on while the shoe goes on round with the shin. A foot
  // that came down on the pivot rather than along its own path is exactly what a
  // trail foot does; a shoe that had stopped turning while the foot travelled on
  // would be the skid this test is here for.
  const landed = pivotOf(row(1.68)).ankle
  const before = pivotOf(row(1.6)).ankle
  const along = Math.atan2(-(landed[0] - before[0]), -(landed[2] - before[2]))
  // The two lines are compared as *directions* rather than as numbers: the swing
  // carries the shoe most of the way round (a foot the leg has been flung round comes
  // down pointing back the way the turn came), so both readings have wrapped by then
  // and a raw subtraction of them reads most of a turn rather than the few degrees
  // the two lines actually differ by.
  const between = (a, b) => Math.abs((((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)) * DEG
  expect(
    plane(1.68) * DEG,
    `the shoe lands ${(plane(1.68) * DEG).toFixed(1)}° round, back from ${(plane(1.64) * DEG).toFixed(1)}° a fifth of a second earlier: the foot arrives under a shoe that has stopped turning`,
  ).toBeGreaterThan(plane(1.64) * DEG)
  expect(
    between(plane(1.68), plane(1.64)),
    `the shoe turns ${between(plane(1.68), plane(1.64)).toFixed(1)}° across the landing: it snaps round rather than riding the swing`,
  ).toBeLessThan(45)
  console.log(
    `landing: the foot comes in ${(along * DEG).toFixed(0)}° across the line, and the shoe rides the swing ` +
      `${(plane(1.64) * DEG).toFixed(0)}° -> ${(plane(1.68) * DEG).toFixed(0)}°`,
  )
  console.log(
    `spin: the pivot shoe turns ${(plane(1.4) * DEG).toFixed(0)}° -> ${(plane(1.56) * DEG).toFixed(0)}° -> ` +
      `${(plane(1.68) * DEG).toFixed(0)}° round through the swing · the leg lands ${(swing(1.68) * DEG).toFixed(0)}° out`,
  )
})

test('the drive leg stays long as the body carries it round', async ({ page }) => {
  // The drive leg is *straight* when it launches the body: the hips have been driven
  // past the leg's own length by the plant, so the solve has nothing left to bend it
  // with (see the drive above) — and a leg that has once been thrown long is not
  // tensed again as the turn carries it round. What the hips' own rotation does with
  // it is *sweep* it: the trailing leg swings out on the circle its own span draws
  // about a hip that has outrun it, rather than folding up under the body it trails.
  // A leg folded at the knee reads in two numbers, and both are here: the knee's own
  // bend (the angle between the thigh and the shin, nought for a leg the driver posed
  // straight) and the leg's own reach across the ground — the hip-to-ankle chord's
  // *horizontal* length, which is what "the foot is out on the circle rather than
  // tucked under the hips" means when the hips are this far above it.
  const frames = await sweepDelivery(page)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.01)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const pivotOf = (frame) => frame.legs.find((leg) => leg.side === 1)
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * DEG
  const kneeBend = (clip) => {
    const leg = pivotOf(row(clip))
    return angle(sub(leg.knee, leg.hip), sub(leg.ankle, leg.knee))
  }
  const outward = (clip) => {
    const leg = pivotOf(row(clip))
    return Math.hypot(leg.ankle[0] - leg.hip[0], leg.ankle[2] - leg.hip[2])
  }
  // The window is the swing and not the landing: the foot comes down at the end of it
  // and the body's own weight arrives on it, which is a knee with a job to do rather
  // than one being carried. The bound is the fold itself and not the millimetres of it:
  // the crossing frame reads 24° here off the posed joints, and what the pin is for is
  // the limb it is *not* — a leg tucked under the hips on the end of its own socket
  // folds past a quarter turn (the authoring this replaced reached 104°).
  let worstBend = 0
  let worstFrame = 0
  let tightest = Infinity
  for (const clip of [1.44, 1.48, 1.52, 1.56, 1.6, 1.64]) {
    const bend = kneeBend(clip)
    if (bend > worstBend) {
      worstBend = bend
      worstFrame = clip
    }
    expect(
      bend,
      `the drive leg folds ${bend.toFixed(0)}° at the knee at ${clip}s as the turn carries it round`,
    ).toBeLessThan(28)
    // ...and the foot is out on its own circle rather than tucked in under the hips.
    // Read through the swing's *carrying* half (1.44–1.56): the last fifth of a second
    // brings the foot in under the body onto the place it lands on — a trail foot under
    // the pelvis rather than out at the side of it, which is what the landing and the
    // finish are authored to (see the sequence's landing key) — so what this bound is
    // about is the arc the leg is flung round on, not the arrival at its own place.
    if (clip <= 1.56) {
      tightest = Math.min(tightest, outward(clip))
      expect(
        outward(clip),
        `the drive foot swings only ${outward(clip).toFixed(2)} rig units out from the hip at ${clip}s: the leg is folding up under the body rather than hanging off it`,
      ).toBeGreaterThan(0.5)
    }
  }
  console.log(
    `swing: the drive leg's knee bends at most ${worstBend.toFixed(0)}° through the swing (at ` +
      `${worstFrame}s) and never comes closer to its own hip than ${tightest.toFixed(2)} rig units out`,
  )
})

test('the drive leg swings out and around, and its knee comes outside the body', async ({ page }) => {
  // The two readings that make the follow-through a *swing* rather than a step, and
  // the earlier authoring had both of them wrong in the same way. The foot's path was
  // written as most of a chord: it crossed the body's own line early and then ran *at*
  // its landing spot, near enough dead straight from there, so what the eye read was a
  // foot posted to a place rather than a limb the turn was flinging round. And with the
  // foot on that line the knee rode *under* the torso the whole way, which is the one
  // reading a leg being carried round never has: a leg thrown out from under a body it
  // has been left behind by goes *out* on the way round, and its knee goes with it.
  //
  // Both readings are of the ground plane. The first is the foot's own path against the
  // single chord from the release to its landing: how far that path bulges off the
  // chord — a step bulges not at all and the wider the arc the more it does — and how
  // much longer the path itself is than the chord it could have been. The second is the
  // knee against the body's own outline, which is the line the two hip sockets draw:
  // the leg hangs off its socket, so a knee outside that line is a knee out past the
  // body's own silhouette rather than one tucked under it — and the swing has to carry
  // it there from *inside* it, rather than holding it out the whole way, which is what
  // makes the clearance something the turn does rather than a leg posed wide.
  //
  // Measured on the realised skeleton: the foot's path bulges 0.88 of a rig unit off
  // the line to its landing and is two and a half times as long as that line; the knee
  // sweeps 0.52 of a rig unit across the sockets' line, 0.39 of one *outside* it by
  // 1.48s — the middle of the swing, where the leg is being flung — having started
  // inside the body's own outline at the top of it. (The *landing* is read apart: the
  // foot comes in under the body onto the place it lands on — a trail foot under the
  // pelvis rather than out at the side of it, which is what the landing and the finish
  // are authored to — and the knee comes in under it with the foot.)
  const frames = await sweepDelivery(page)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.01)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const pivotOf = (frame) => frame.legs.find((leg) => leg.side === 1)
  const leadOf = (frame) => frame.legs.find((leg) => leg.side === -1)
  const release = pivotOf(row(1.32)).ankle
  const landed = pivotOf(row(1.68)).ankle
  const dx = landed[0] - release[0]
  const dz = landed[2] - release[2]
  const chord = Math.hypot(dx, dz)
  // Square to the chord: how far off the straight line to the landing the foot is.
  const perp = [-dz / chord, dx / chord]
  let bulge = 0
  let bulgeAt = 0
  let path = 0
  let previous = release
  let outside = -Infinity
  let outsideAt = 0
  let inside = Infinity
  let insideAt = 0
  let landedClear = 0
  let lateral = []
  for (const clip of [1.32, 1.36, 1.4, 1.44, 1.48, 1.52, 1.56, 1.6, 1.64, 1.68]) {
    const leg = pivotOf(row(clip))
    const lead = leadOf(row(clip))
    const foot = leg.ankle
    const off = (foot[0] - release[0]) * perp[0] + (foot[2] - release[2]) * perp[1]
    path += Math.hypot(foot[0] - previous[0], foot[2] - previous[2])
    previous = foot
    if (clip > 1.32 + 1e-9 && Math.abs(off) > Math.abs(bulge)) {
      bulge = off
      bulgeAt = clip
    }
    // The knee's own lateral in the pelvis' frame: the sockets' line is its axis, so
    // the reading is the knee against the body's outline rather than against the world.
    const sx = leg.hip[0] - lead.hip[0]
    const sz = leg.hip[2] - lead.hip[2]
    const spread = Math.hypot(sx, sz) || 1
    const axis = [sx / spread, sz / spread]
    const centre = [(leg.hip[0] + lead.hip[0]) / 2, (leg.hip[2] + lead.hip[2]) / 2]
    const kneeLat = (leg.knee[0] - centre[0]) * axis[0] + (leg.knee[2] - centre[1]) * axis[1]
    lateral.push(kneeLat)
    const clearance = Math.abs(kneeLat) - spread / 2
    if (clearance > outside) {
      outside = clearance
      outsideAt = clip
    }
    // The knee's own place *at the top of the swing*, which is what the swing carried
    // it out from — read over the turn's first half rather than over the whole of it,
    // because the arrival is the other end of the same motion and reads as its mirror
    // (see the landing's own reading below).
    if (clip <= 1.44 && clearance < inside) {
      inside = clearance
      insideAt = clip
    }
    if (Math.abs(clip - 1.68) < 1e-9) landedClear = clearance
  }
  // The arc is an arc: the foot's own path swings a rig unit clear of the line to its
  // landing, and travels more than three times as far as that line is long.
  expect(
    Math.abs(bulge),
    `the foot's path only bulges ${bulge.toFixed(2)} rig units off the line to its landing (at ${bulgeAt}s): it is travelling at the landing rather than round to it`,
  ).toBeGreaterThan(0.35)
  expect(
    path / chord,
    `the foot's path is ${(path / chord).toFixed(2)}x the line to its landing: the swing is a step with a detour in it`,
  ).toBeGreaterThan(1.3)
  // ...and the knee comes *out* to make it: outside the sockets' own line by a hand's
  // width by the middle of the swing, from well inside it when the swing starts.
  expect(
    outside,
    `the knee only comes ${outside.toFixed(2)} rig units outside the body's own outline (at ${outsideAt}s): the leg is tucking under the torso rather than swinging out past it`,
  ).toBeGreaterThan(0.1)
  expect(
    inside,
    `the knee is already ${inside.toFixed(2)} rig units outside the body's outline at the top of the swing (${insideAt}s): the swing is not what put it there`,
  ).toBeLessThan(-0.05)
  expect(
    Math.max(...lateral) - Math.min(...lateral),
    `the knee sweeps only ${(Math.max(...lateral) - Math.min(...lateral)).toFixed(2)} rig units across the body's own line: it is carried past the body rather than thrown out and round it`,
  ).toBeGreaterThan(0.2)
  // ...and by the time the foot is down the leg is under the body rather than beside
  // it: the swing's whole travel is spent by the landing, and what it lands on is the
  // place the finish stands on (see the landing key and the finish's own note).
  //
  // The landing is read apart for the reason its own key gives: the two feet land
  // *straight-legged* (see the landing and finish notes, and the test below), and a
  // straight leg's knee lies on the socket-to-foot chord rather than tucked under the
  // hips — the drive foot comes down 0.09 of a unit ahead of its own socket, so the
  // knee comes down 2.5 mm past the sockets' half-line, which is *level with the hip
  // it hangs from* rather than inside it. What is promised here is that the swing's
  // whole clearance is spent getting there: the knee comes out 0.38 of a unit past
  // the body's line at the middle of the swing and gives 0.38 of it back by the
  // landing, so what the foot lands on is the place the finish stands on and the leg
  // has arrived under the body rather than beside it.
  expect(
    landedClear,
    `the knee is still ${(landedClear * 100).toFixed(1)} cm beyond the sockets' own line where the foot lands: the leg is arriving at the foot's place rather than under the body`,
  ).toBeLessThan(0.01)
  expect(
    landedClear - outside,
    `the knee gives back only ${(outside - landedClear).toFixed(2)} of the ${outside.toFixed(2)} rig units it came out by at ${outsideAt}s: the swing is still travelling at the landing`,
  ).toBeLessThan(-0.3)
  console.log(
    `arc: the foot's path bulges ${Math.abs(bulge).toFixed(2)} rig units off the line to its landing (at ` +
      `${bulgeAt}s) and is ${(path / chord).toFixed(2)}x as long · the knee sweeps ` +
      `${(Math.max(...lateral) - Math.min(...lateral)).toFixed(2)} across the sockets' line, from ` +
      `${inside.toFixed(2)} inside it (${insideAt}s) to ${outside.toFixed(2)} outside it (${outsideAt}s), ` +
      `and ${Math.abs(landedClear).toFixed(2)} back inside it by the landing`,
  )
})

test('the finish turns a little of his back to the plate, and he lands in it', async ({ page }) => {
  // Where the delivery *ends*, which is not where the ball left it. The drive foot
  // comes down ahead of the foot the stride planted on (the hips have gone through the
  // plant rather than stopping at it), and the turn the pitch handed the body is spent
  // *into* that foot: a tenth of a second before it lands the shoulders are still a
  // dozen degrees short of square, and on the frame it lands they are through square
  // and a little past it — a little of his back to the strike zone. The pose the foot
  // comes down in is therefore the pose he stands in: the give this delivery used to
  // land in has been removed (see the sequence's landing note), so there is nothing
  // left for the body to spend after the foot is down, and what the tail of the clip
  // is is a pitcher standing in his follow-through rather than turning on through his
  // own landing.
  //
  // The shoulder line is the reading, off the realised sockets, and it *wraps*: past
  // square it comes back out of the probe as -170° rather than 190°, so the first
  // thing here is to unwrap it (see ``shoulderLine``, whose nought is the set's own
  // side-on line and whose ninety is square).
  const frames = await sweepDelivery(page, AUTHORED_CLIP_END)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.02)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const pivotOf = (frame) => frame.legs.find((leg) => leg.side === 1)
  const leadOf = (frame) => frame.legs.find((leg) => leg.side === -1)
  const line = (clip) => {
    const at = shoulderLine(row(clip))
    return at < 0 ? at + 360 : at
  }
  // The landing itself: the drive foot comes down on the glove's side of the lead
  // foot and *ahead* of it — a good deal closer to the plate than the stride's own
  // plant — which is the hips' own forwardness arriving in a foot.
  const ahead = leadOf(row(1.68)).ankle[2] - pivotOf(row(1.68)).ankle[2]
  expect(
    ahead,
    `the drive foot only lands ${ahead.toFixed(2)} rig units ahead of the plant: the finish is behind the body rather than in front of it`,
  ).toBeGreaterThan(0.42)
  // The turn: the foot lands at the *end* of it. A sixth of a second before the drive
  // foot is down the shoulders are still short of square, and on the frame it lands
  // they are through and nine degrees past it — the whole crossing of the plate's own
  // line happens inside the last of the turn, which is what "the foot lands at the end
  // of it" means: the pose the foot comes down in is the pose the body has finished
  // turning in, rather than one the body turns on through (see the sequence's tail
  // keys, which were re-profiled when the give came out: the turn that used to be
  // spent over the settle is spent into the landing, at a rate that only falls).
  const crossing = line(1.52)
  const landed = line(1.68)
  expect(
    crossing,
    `the shoulders are already ${(crossing - 180).toFixed(0)}° past square a sixth of a second before the drive foot lands: there is no turn left for the foot to arrive on`,
  ).toBeLessThan(180)
  expect(
    landed - crossing,
    `the shoulders turn ${(landed - crossing).toFixed(0)}° between 1.52s and the landing: the last of the turn is a quarter of the body's own`,
  ).toBeLessThan(25)
  expect(
    landed - 180,
    `the finish leaves the shoulders ${(landed - 180).toFixed(1)}° past square: none of his back is to the strike zone`,
  ).toBeGreaterThan(5)
  expect(
    landed - line(RELEASE),
    `the shoulders only turn ${(landed - line(RELEASE)).toFixed(0)}° between the release and the landing: the body stops turning with the ball`,
  ).toBeGreaterThan(60)
  // ...and then it is *held*: the pose he lands in is the pose a second and a half later,
  // to the frame. A landing that went on moving after the foot was down would be the
  // give back again (see the test below, which is the same fact read on the legs). The
  // reading is the chest's own turn, with the lean divided out (the probe's ``torso.yaw``
  // — see the harness note on why the yaw and not a line), because a *line* across the
  // two sockets is not the body alone: the girdle carries the arms, and the arms the
  // hold stands in are not the arms the throw left — *both* of them settle over this
  // window (see the sequence's hold note: the throwing hand comes down to the thigh,
  // and the lead arm comes down off its swing at the same time), and each one's
  // clavicle swings its own socket with it (``reachWithShoulder``). That is 2.1° of the
  // socket line between the landing and the hold, which is the arms' and not the
  // body's; the body's own turn does not move a hundredth of a degree. Across the hold
  // itself the line is dead flat, which is the same fact read where the arms have
  // finished: what the settle does it does by 1.9, and the pose it lands the arms in is
  // the pose they are held in.
  const heldTurn = row(1.68).torso.yaw
  const held = line(2.80)
  for (const clip of [1.92, 2.0, 2.8]) {
    const rolled = Math.abs(row(clip).torso.yaw - heldTurn) * DEG
    expect(
      rolled,
      `the chest turns ${rolled.toFixed(1)}° from the landing to ${clip}s: the pose he lands in is not the pose he holds`,
    ).toBeLessThan(0.05)
    expect(
      Math.abs(line(clip) - held),
      `the shoulder line drifts ${Math.abs(line(clip) - held).toFixed(1)}° across the hold: the pose he stands in is not the pose he stands in`,
    ).toBeLessThan(0.05)
  }
  expect(
    Math.abs(held - landed),
    `the shoulder line moves ${Math.abs(held - landed).toFixed(1)}° between the landing and the hold: more than the two arms coming down under it`,
  ).toBeLessThan(2.5)
  expect(
    Math.abs(pelvisOf(row(2.80))[1] - pelvisOf(row(1.68))[1]),
    'the pelvis moves across the hold',
  ).toBeLessThan(0.002)
  expect(
    Math.abs(held - line(0)),
    `a second after the drive foot lands the body is back in the set: the finish was never held`,
  ).toBeGreaterThan(150)
  console.log(
    `finish: the drive foot lands ${ahead.toFixed(2)} rig units ahead of the plant · the shoulders come ` +
      `${line(RELEASE).toFixed(0)}° -> ${crossing.toFixed(0)}° -> ${landed.toFixed(0)}° (release, a sixth before the foot, the foot), ` +
      `${(landed - 180).toFixed(1)}° past square at the landing and held to ${Math.max(...[1.92, 2.0, 2.8].map((clip) => Math.abs(row(clip).torso.yaw - heldTurn) * DEG)).toFixed(2)}° for the ${(2.8 - 1.68).toFixed(1)}s after it (the sockets the line is read off come ${Math.abs(held - landed).toFixed(1)}° back with the arms' own settle)`,
  )
})

test('the drive leg lands straight and firm, and the weight that arrives on it does not fold it', async ({ page }) => {
  // What a body does with the leg it lands on, and this delivery's answer is *nothing*.
  // The swing throws the leg straight (the turn has nothing left to bend it with — see
  // the two tests above), it comes down at its own length, and it stays there: the fold
  // this delivery spends is spent in the stride, over the plant, with the ball still in
  // the hand. The give that used to land it — a couple of degrees of knee and two
  // centimetres of pelvis onto the foot the swing put down — is gone (see the sequence's
  // landing note, which is where it went and why), and the test that used to hold the
  // give now holds its absence: a body that arrives on a folded knee has to unfold out
  // of it before it can pitch again, and a body that sags onto the leg *after* the foot
  // is down is a body whose landing was never finished.
  //
  // The reading is the leg's own length. A leg is two bones and a knee, so its bend and
  // the *chord* from its socket to the foot it stands on are one number read twice:
  // measured on the realised skeleton, the drive leg lands 0.8519 of a rig unit from
  // socket to ankle against a 0.8546 limb — 99.68 per cent of it, which a two-bone chain
  // can only be with 9.2° of knee in it — and the lead leg within a tenth of a per cent
  // of the same (0.8511, 10.3°). Both of them read the same on every frame of the hold
  // that follows: nine tenths of a second later the numbers agree to the thousandth.
  // *That* is what "firm" is here: not a leg held stiff against the weight, but a leg
  // with nothing left to give it.
  //
  // The last two and a half per cent is the *shoe*, and it is the pose's own: a planted
  // shoe is stood on the dirt by its own lowest corner (see the driver's ground rule),
  // so a shoe left on whichever corner the leg's turn made lowest carries the *ankle* up
  // by that much — and a socket-to-foot line short by that much is a knee with that much
  // bend in it. Measured with the shoes' own ``flat`` left off these keys, the ground
  // rule has to carry the ankles 0.0316 and 0.0281 of a unit up to get a corner of each
  // shoe down and the knees read 31.4° and 29.7°; with the sole rolled level (``flat`` 1,
  // see the pose assembly and the driver's ``rollSoleFlat``) the ankles come back down to
  // 0.0016 and 0.0022 and the knees read 9.2° and 10.3°.
  const frames = await sweepDelivery(page, AUTHORED_CLIP_END)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.021)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const legAt = (clip, side) => row(clip).legs.find((leg) => leg.side === side)
  const kneeBend = (leg) => {
    const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * DEG
    return angle(sub(leg.knee, leg.hip), sub(leg.ankle, leg.knee))
  }
  const bendAt = (clip, side = 1) => kneeBend(legAt(clip, side))
  // How much of its own span the leg stands on: socket to ankle over the two bones it is
  // made of — one at the whole of its length, nought at the fold.
  const chordAt = (clip, side) => {
    const { hip, knee, ankle } = legAt(clip, side)
    return Math.hypot(...sub(ankle, hip)) / (Math.hypot(...sub(knee, hip)) + Math.hypot(...sub(ankle, knee)))
  }
  // The knee's own place off the leg's own chord: how far the driver's pose pushed it
  // sideways out of the plane the socket and the ankle draw — which is the "plane the
  // leg is standing in" reading.
  const pushAt = (clip) => {
    const { hip, knee, ankle } = legAt(clip, 1)
    const dx = ankle[0] - hip[0]
    const dz = ankle[2] - hip[2]
    const span = Math.hypot(dx, dz)
    return Math.abs((knee[0] - hip[0]) * (-dz / span) + (knee[2] - hip[2]) * (dx / span))
  }
  // The leg is *thrown* straight rather than stepped: at the release it is the limb the
  // swing has been carrying, within a few degrees of its own span.
  expect(
    bendAt(1.32),
    `the drive leg is already ${bendAt(1.32).toFixed(0)}° bent at the release: it is not a leg being thrown`,
  ).toBeLessThan(20)
  // The arrival: on the frame both feet are down each leg is at its own length, which is
  // the straightest a bone chain with a knee in it can stand.
  for (const side of [1, -1]) {
    const share = chordAt(1.68, side)
    expect(
      share,
      `the ${side === 1 ? 'drive' : 'lead'} leg lands ${((1 - share) * 100).toFixed(2)} per cent short of its own length: the knee is folded under the landing`,
    ).toBeGreaterThan(0.995)
  }
  // ...and the weight that arrives on it does not fold it: the half second after the foot
  // is down is the pose rather than the settle — each knee within a degree of the frame
  // the foot landed in, and the pelvis no lower than it.
  for (const clip of [1.72, 1.76, 1.8, 1.92, 2.0, 2.8]) {
    for (const side of [1, -1]) {
      const moved = bendAt(clip, side) - bendAt(1.68, side)
      expect(
        Math.abs(moved),
        `the ${side === 1 ? 'drive' : 'lead'} knee moves ${moved.toFixed(2)}° between the landing and ${clip}s: the leg gives under the weight`,
      ).toBeLessThan(1)
    }
  }
  const floor = pelvisOf(row(1.68))[1]
  const lowest = Math.min(
    ...frames.filter((frame) => frame.clip >= 1.68 && frame.clip <= 2.8).map((frame) => pelvisOf(frame)[1]),
  )
  expect(
    floor - lowest,
    `the pelvis sits ${((floor - lowest) * 100).toFixed(1)} cm below the frame it landed in: the landing is a dip he stands up out of, not a pose`,
  ).toBeLessThan(0.002)
  // ...and the leg's own plane is the landing's: once the weight is on the foot the knee
  // does not swing back in under the thigh it has stopped swinging either.
  expect(
    Math.abs(pushAt(1.92) - pushAt(1.68)),
    `the knee's own push off its chord moves ${Math.abs(pushAt(1.92) - pushAt(1.68)).toFixed(3)} rig units once the weight is on the leg: the leg relaxes its landing plane`,
  ).toBeLessThan(0.005)
  // ...on *both* feet, and level with each other: the two knees end within a few degrees,
  // which is what makes the pose he lands in the *stance's* rather than one leg's.
  const balances = Math.abs(bendAt(2.0) - bendAt(2.0, -1))
  expect(
    balances,
    `the two knees stand ${balances.toFixed(1)}° apart at the finish: it is one leg's pose, not the stance's`,
  ).toBeLessThan(10)
  expect(
    bendAt(2.8),
    'the legs move across the hold',
  ).toBeCloseTo(bendAt(2.0), 3)
  console.log(
    `landing: the drive leg arrives at ${(chordAt(1.68, 1) * 100).toFixed(2)}% of its own length ` +
      `(${bendAt(1.68).toFixed(1)}° of knee) with the lead leg at ${(chordAt(1.68, -1) * 100).toFixed(2)}% ` +
      `(${bendAt(1.68, -1).toFixed(1)}°) · across the ${(2.8 - 1.68).toFixed(1)}s that follow, neither knee moves ` +
      `more than ${Math.max(...[1.72, 1.76, 1.8, 1.92, 2.0, 2.8].flatMap((clip) => [Math.abs(bendAt(clip) - bendAt(1.68)), Math.abs(bendAt(clip, -1) - bendAt(1.68, -1))])).toFixed(2)}° ` +
      `and the pelvis never goes below the frame it landed in (the knee's own push off its chord holds at ${pushAt(1.68).toFixed(3)} rig units)`,
  )
})

test('the drive, the fold and the turn all peak at the release', async ({ page }) => {
  // The delivery's own shape, as three speeds: the pelvis's travel toward the plate,
  // the trunk's lean over it, and the body's own turn. All three build through the
  // stride and are at their *fastest frame* on the frame the ball leaves on, and all
  // three are slower afterwards than they were into it — the windup is the delivery
  // gathering speed and the follow-through is it spending the speed it gathered.
  //
  // This is what the earlier authoring got wrong in two ways: the body's fastest turn
  // was a quarter of a second *before* the ball went, with a stall behind the plant
  // between the two snaps (the turn gathered, spent, gathered and spent again), and
  // the pelvis's own travel peaked a fifth of a second late rather than driving the
  // whole way to the release.
  //
  // Read off the realised skeleton, and off the bones each reading is actually about.
  // The pelvis's travel is the *spine root's* own place, which is the pelvis as the
  // driver built it: a hip socket's midpoint is not, because the leg solve drags a
  // socket after a front leg the drive has outrun (measured: the sockets are 6 cm out
  // of level at the release, which reads as travel the body is not making). The
  // trunk's lean is the ribcage's own up axis off plumb (see `trunkLean`) and its turn
  // is the ribcage's own yaw with that lean divided out (the harness's `torso.yaw`) —
  // the one reading of "the body is spinning" that no arm's solve can write, where
  // the shoulder line is the two sockets and the throwing arm's own climb past its
  // shoulder at the break is worth several hundred degrees a second of turn the body
  // is not making.
  const frames = await sweepWindow(page, 1.0, 1.74, 0.02)
  expect(frames.length, 'the drive window should be swept whole').toBeGreaterThan(30)
  const at = (i) => frames[i]
  const indexOf = (clip) => {
    const index = frames.findIndex((frame) => Math.abs(frame.clip - clip) < 0.011)
    expect(index, `the window should cover ${clip}s`).toBeGreaterThan(-1)
    return index
  }
  const RELEASE_AT = indexOf(RELEASE)
  // A rate per frame, backwards: what the value did into this frame. The plate is at
  // the rig's -z, so the pelvis's travel is the *fall* in its own z, and the turn is
  // the rise in the body's yaw.
  const rate = (key) => frames.map((frame, index) => (
    index === 0 ? 0 : (key(frame) - key(at(index - 1))) / (frame.clip - at(index - 1).clip)
  ))
  const drive = rate((frame) => -frame.torso.base[2])
  const spin = rate((frame) => frame.torso.yaw * DEG)
  const fold = frames.map(trunkLean)
  // ...and the lean's own *rate*: the trunk coming over the hips, which is a speed
  // like the other two rather than only a place. The keys hold the fold off through
  // the stride — a tenth of a radian at the break, a sixth at the plant — so the
  // speed it arrives at the release with is the delivery's fastest frame of it (see
  // the unit suite's trunk reading, which is where the held-off fold is authored).
  const leanRate = rate(trunkLean)
  const fastest = (values) => values.indexOf(Math.max(...values.slice(1)))
  const peakOf = (index) => frames[index].clip
  // The fastest frame of each speed: within a frame of the release, which is the
  // promise the whole windup's authoring is shaped for.
  for (const [name, values] of [['the pelvis\'s travel', drive], ['the body\'s turn', spin], ['the trunk\'s lean', leanRate]]) {
    expect(
      peakOf(fastest(values)),
      `${name} is fastest at ${peakOf(fastest(values))}s rather than the release`,
    ).toBeGreaterThan(RELEASE - 0.021)
    expect(peakOf(fastest(values))).toBeLessThan(RELEASE + 0.021)
  }
  // The lean is a *place* as well as a speed: it is deepest over the release — the
  // trunk keeps folding all the way into the throw, and its fastest frame of all is
  // the release's (see the rate above) — and it comes back up out of the fold over
  // the follow-through, which is the same statement made of a place.
  const deepest = fold.indexOf(Math.max(...fold))
  expect(
    peakOf(deepest),
    `the trunk leans deepest at ${peakOf(deepest)}s rather than the release`,
  ).toBeGreaterThan(RELEASE - 0.021)
  expect(peakOf(deepest)).toBeLessThan(RELEASE + 0.041)
  expect(
    fold[RELEASE_AT] - fold[indexOf(1.24)],
    `the trunk is no deeper in the lean at the release than at the high cock`,
  ).toBeGreaterThan(0.5)
  expect(
    fold[RELEASE_AT] - fold[indexOf(1.68)],
    `the trunk is still folded as deep at the finish as at the release`,
  ).toBeGreaterThan(8)
  // And the follow-through spends what the windup gathered: each speed is slower a
  // fifth of a second later, and slower again by the finish, rather than holding its
  // speed or picking it back up. The lean is the one that has *reversed* by then: the
  // trunk is coming back up out of the fold it has just laid over, which is the same
  // statement about the same place (see the fold above).
  const speedAt = (values, clip) => values[indexOf(clip)]
  expect(
    leanRate[RELEASE_AT],
    `the trunk leans at only ${leanRate[RELEASE_AT].toFixed(0)}°/s on the release frame`,
  ).toBeGreaterThan(200)
  expect(
    speedAt(leanRate, 1.52),
    `the trunk is still folding over at 1.52s: ${speedAt(leanRate, 1.52).toFixed(0)}°/s`,
  ).toBeLessThan(0)
  for (const [name, values] of [['travel', drive], ['turn', spin]]) {
    expect(
      speedAt(values, 1.52),
      `the ${name} is not slowing down through the follow-through: ${speedAt(values, 1.52).toFixed(2)} at 1.52s against ${values[RELEASE_AT].toFixed(2)} at the release`,
    ).toBeLessThan(values[RELEASE_AT])
    expect(
      speedAt(values, 1.68),
      `the ${name} is not letting go by the finish: ${speedAt(values, 1.68).toFixed(2)} at 1.68s against ${speedAt(values, 1.52).toFixed(2)} at 1.52s`,
    ).toBeLessThan(speedAt(values, 1.52))
  }
  // ...and how much of the travel is still *in hand* a fifth of a second later is
  // the other half of the same promise: a delivery that has spent its forward motion
  // by then has stopped on the foot it planted on, while this one goes on over ground
  // its own swing bought it — the drive leg lands past the lead foot's plant (see the
  // swing above), so the hips have that much further to go and go it later.
  expect(
    speedAt(drive, 1.52) / drive[RELEASE_AT],
    `the pelvis has only ${(100 * speedAt(drive, 1.52) / drive[RELEASE_AT]).toFixed(0)}% of its release speed left at 1.52s: the travel is spent as the ball goes`,
  ).toBeGreaterThan(0.4)
  // And the body has *arrived* on the plant when the ball goes: the pelvis is level
  // with the lead foot's own ankle by the release — the hips catch the foot they
  // planted on rather than stopping short of it — and a third of a rig unit past it
  // by the finish, which is the weight going on through the throw. What the earlier
  // authoring did with the same step was peak its travel *at* the plant: the foot
  // landed a fifth of a second before the body, and the release was spent catching up
  // with a step instead of coming through it.
  const planted = frames.map((frame) => frame.legs.find((leg) => leg.side === -1).ankle[2])
  const travel = (clip) => at(indexOf(clip)).torso.base[2]
  expect(
    Math.abs(travel(RELEASE) - planted[RELEASE_AT]),
    `the pelvis is ${(travel(RELEASE) - planted[RELEASE_AT]).toFixed(3)} rig units off the lead foot's own line at the release`,
  ).toBeLessThan(0.05)
  expect(
    planted[RELEASE_AT] - travel(1.68),
    'the pelvis has not driven past the plant over the follow-through',
  ).toBeGreaterThan(0.25)
  console.log(
    `drive: the pelvis is level with the lead foot's own line at the release (${(planted[RELEASE_AT] - travel(RELEASE)).toFixed(2)} rig ` +
      `units behind it) and ${(planted[RELEASE_AT] - travel(1.68)).toFixed(2)} past it by the finish · ` +
      `fastest frame of travel ${peakOf(fastest(drive))}s at ${drive[fastest(drive)].toFixed(2)} rig/s, ` +
      `of turn ${peakOf(fastest(spin))}s at ${spin[fastest(spin)].toFixed(0)}°/s, of lean ` +
      `${peakOf(fastest(leanRate))}s at ${leanRate[fastest(leanRate)].toFixed(0)}°/s, deepest lean ${peakOf(deepest)}s ` +
      `at ${fold[RELEASE_AT].toFixed(0)}° off plumb · a fifth of a second later the travel is down to ` +
      `${(100 * speedAt(drive, 1.52) / speedAt(drive, RELEASE)).toFixed(0)}% of its release speed and the turn to ` +
      `${(100 * speedAt(spin, 1.52) / speedAt(spin, RELEASE)).toFixed(0)}%`,
  )
})

test('the throwing arm lets the throw go, and hangs limp and straight at his side through the hold', async ({ page }) => {
  // What the arm does once the pitch is over, off the realised skeleton. The landing
  // is the pose the throw left it in — the hand down across the front of the body, the
  // wrist cocked back off a bent elbow, which is what a follow-through *is* — and the
  // hold is the arm the throw has finished with: straight, limp, and hanging at the
  // side of the body rather than out across it.
  //
  // Three readings, all off the driver's own report, and each of them a number the
  // driver also has a *limit* for. The bend at the elbow: it holds a bare arm to
  // ELBOW_BEND_MAX (165°), so "straight" is a number with a ceiling on it, and what
  // the arm was doing before this was authored is a 118° hook with the elbow out in
  // front of the hip. The wrist: the angle between the forearm the driver built and
  // the hand's own line, held to WRIST_BEND_MAX (30°) — the landing asks for all 32° of
  // it (a hand still cocked off the throw) and the hold asks for none. And where the
  // hand *is*: hanging below its own socket by most of the arm's length, along the arm
  // rather than folded, clear of the trunk, and not in front of the body.
  const landing = await openAt(page, 1.68)
  const hold = await openAt(page, 1.9)
  const ended = await openAt(page, 2.8)
  const chord = (at) => Math.hypot(...at.arm.wrist.map((v, axis) => v - at.arm.shoulder[axis]))
  const hang = (at) => at.arm.shoulder[1] - at.arm.wrist[1]
  /** The angle between the forearm the driver built and the hand's own line: what a
   * cocked wrist is, in degrees. */
  const wrist = (at) => {
    const fore = at.arm.wrist.map((v, axis) => v - at.arm.elbow[axis])
    const length = Math.hypot(...fore) || 1
    const dot = fore.reduce((sum, v, axis) => sum + v * at.arm.aim[axis], 0) / length
    return Math.acos(Math.max(-1, Math.min(1, dot))) * DEG
  }
  // The throw's own arm: bent, and its hand still cocked off it.
  expect(wrist(landing), `the landing's wrist is only ${wrist(landing).toFixed(0)}° off the forearm`).toBeGreaterThan(20)
  expect(
    landing.arm.elbowDegrees,
    `the landing's elbow is already ${landing.arm.elbowDegrees.toFixed(0)}° — the follow-through is over before it began`,
  ).toBeLessThan(140)
  // ...and the arm the throw has finished with: opened most of the way to the span,
  // hanging down with the hand level with the thigh, and asking for none of the wrist
  // the follow-through asked for.
  expect(
    hold.arm.elbowDegrees,
    `the hold's elbow is still ${hold.arm.elbowDegrees.toFixed(0)}° bent`,
  ).toBeGreaterThan(140)
  expect(
    chord(hold) / hold.arm.reach,
    `the hold's arm hangs ${(chord(hold) / hold.arm.reach).toFixed(3)} of its own span out of its socket`,
  ).toBeGreaterThan(0.95)
  expect(
    hold.arm.elbow[1] < hold.arm.shoulder[1] && hold.arm.wrist[1] < hold.arm.elbow[1],
    'the arm is not hanging: the hand is not below the elbow below the socket',
  )
  expect(
    hang(hold),
    `the hand hangs only ${hang(hold).toFixed(3)} below its own socket`,
  ).toBeGreaterThan(0.5)
  expect(wrist(hold), `the hold's wrist is still ${wrist(hold).toFixed(0)}° off the forearm`).toBeLessThan(10)
  expect(
    hold.arm.depth,
    `the hanging arm is ${hold.arm.depth} rig units into the trunk`,
  ).toBeLessThan(-0.02)
  // ...and it is *held*: the arm does not come up out of the hold the way it will on
  // the way back to the set (see the recovery key, where it is doing something again).
  for (const axis of [0, 1, 2]) {
    expect(Math.abs(ended.arm.wrist[axis] - hold.arm.wrist[axis]), 'the arm drifts across the hold').toBeLessThan(0.002)
    expect(Math.abs(ended.arm.elbow[axis] - hold.arm.elbow[axis]), 'the elbow drifts across the hold').toBeLessThan(0.002)
  }
  console.log(
    `arm: the elbow opens ${landing.arm.elbowDegrees.toFixed(0)}° -> ${hold.arm.elbowDegrees.toFixed(0)}° (of the driver's 165° ceiling), ` +
      `the wrist ${wrist(landing).toFixed(0)}° -> ${wrist(hold).toFixed(0)}° off the forearm it hangs on, ` +
      `the hand ${(chord(hold) / hold.arm.reach).toFixed(2)} of the arm's own span below its socket and ${(-hold.arm.depth).toFixed(3)} rig units clear of the trunk`,
  )
})

test('both arms come down out of the throw as one motion, and are stood in by the hold', async ({ page }) => {
  // What the two arms do *between* the frames the test above pins. The landing and the
  // hold are both poses; what a follow-through is made of is the way one becomes the
  // other, and there are two things an arm can do wrong there that no single frame
  // shows. It can *stop*: a track that runs its whole crossing at one rate and then
  // dies at the landing is a swing and a settle rather than a throw being let go (see
  // the sequence's own easing note). And it can be a *pose*: the lead arm left exactly
  // where the throw put it, held for a second with the ball gone, is an arm frozen in a
  // shape it did once — the glove's own settle is what this reads (see the hold note).
  //
  // The window is a fiftieth of a second across the crossing and the settle, which is
  // the step a *rate* can be read off: the hands are a few centimetres apart from frame
  // to frame here, and a slice of the delivery this short has to be sampled finer than
  // the delivery's own fortieth.
  const frames = await sweepWindow(page, 1.44, 2.2, 0.02)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.012)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const handOf = (frame, side) => frame.arms.find((arm) => arm.side === side).wrist
  const speedOf = (side, clip) => (
    Math.hypot(...handOf(row(clip), side).map((v, axis) => v - handOf(row(clip - 0.02), side)[axis]))
    / 0.02
  )
  // Two readings, because there are two ways an arm can arrive: *one* deceleration, and
  // a deceleration that is not interrupted. The first samples the crossing coarsely from
  // the whip's own speed at the top of the window down to the crawl the hold is reached
  // at, and each frame of it is slower than the one before it. A track written as a
  // share of each segment in proportion to its time reads flat there instead — measured
  // before the easing, a level 1.5 rig units a second from the middle of the crossing to
  // the landing and a dead stop on it — which is the swing-then-settle the easing note
  // in the sequence is about.
  const crossing = [1.52, 1.56, 1.6, 1.64, 1.68, 1.8, 1.86, 1.9]
  const speeds = crossing.map((clip) => speedOf('R', clip))
  for (let i = 1; i < speeds.length; i += 1) {
    expect(
      speeds[i],
      `the throwing hand is not slowing down through the follow-through: ${speeds[i].toFixed(2)} at ${crossing[i]}s against ${speeds[i - 1].toFixed(2)} at ${crossing[i - 1]}s`,
    ).toBeLessThan(speeds[i - 1] + 1e-6)
  }
  // ...and the second samples the settle frame by frame, where the two halves of a
  // *two-part* move meet: the hand may hold a rough rate on the way down (a hand coming
  // down off a throw does), but it may not pick speed back up on the way, because speed
  // picked back up is the second motion — the throw stopping where the follow-through
  // left it and a settle starting from rest — that reads as one pose handing over to
  // another. Every frame of the settle is slower than the frame the foot landed in,
  // which is the frame the throw let the arm go in.
  const landing = speedOf('R', 1.68)
  for (const clip of [1.7, 1.72, 1.74, 1.76, 1.78, 1.8, 1.82, 1.84, 1.86, 1.88]) {
    expect(
      speedOf('R', clip),
      `the throwing hand takes the settle up again: ${speedOf('R', clip).toFixed(2)} rig units a second at ${clip}s against ${landing.toFixed(2)} in the frame the drive foot lands`,
    ).toBeLessThan(landing)
  }
  expect(
    landing,
    `the throwing hand is already stopped when the drive foot lands (${landing.toFixed(2)} rig units a second): the follow-through is over before it began`,
  ).toBeGreaterThan(0.4)
  expect(
    speeds[speeds.length - 1],
    `the throwing hand is still doing ${speeds[speeds.length - 1].toFixed(2)} rig units a second a tenth of a second before the hold`,
  ).toBeLessThan(0.5)
  // And the lead arm settles too, rather than stopping: it is moving through the
  // window the throwing arm is (its own hand comes back over the thigh by the hold),
  // and it is *standing in* the hang by the hold — static from the frame after it,
  // with the hand well below the socket it hangs from.
  const leadAt = (clip) => row(clip).arms.find((arm) => arm.side === 'L')
  const moveOf = (clip) => Math.hypot(...leadAt(clip).wrist.map((v, axis) => v - leadAt(1.68).wrist[axis]))
  expect(
    speedOf('L', 1.74),
    `the glove is ${speedOf('L', 1.74).toFixed(2)} rig units a second through the settle: it is frozen in its throw pose`,
  ).toBeGreaterThan(0.3)
  expect(
    moveOf(1.9),
    `the glove's own hand moves only ${moveOf(1.9).toFixed(3)} rig units off the landing's place: that is not a settle`,
  ).toBeGreaterThan(0.04)
  expect(
    leadAt(1.9).shoulder[1] - leadAt(1.9).wrist[1],
    `the glove's hand hangs only ${(leadAt(1.9).shoulder[1] - leadAt(1.9).wrist[1]).toFixed(3)} below its socket at the hold`,
  ).toBeGreaterThan(0.5)
  // ...and it is *stood in* rather than still arriving: the last three tenths of a
  // second of the window (the hold's own first stretch, the delivery being over) move
  // the hand not at all in any axis.
  for (const axis of [0, 1, 2]) {
    expect(
      Math.abs(leadAt(2.18).wrist[axis] - leadAt(1.98).wrist[axis]),
      `the glove's hand drifts across the hold (${axis})`,
    ).toBeLessThan(0.002)
  }
  console.log(
    `settle: the throwing hand comes down out of the whip at ${speeds[0].toFixed(1)} -> ${speedOf('R', 1.86).toFixed(1)} a fifth of a second before the hold -> ` +
      `${speeds[speeds.length - 1].toFixed(1)} at it, in one fall with no frame of it faster than the last, ` +
      `still moving at ${landing.toFixed(1)} when the drive foot lands; ` +
      `the glove comes down beside it at ${speedOf('L', 1.74).toFixed(1)} into the settle and ${speedOf('L', 1.9).toFixed(1)} at the hold, ` +
      `ending ${moveOf(1.9).toFixed(2)} rig units off the place the throw left it in and ${(leadAt(1.9).shoulder[1] - leadAt(1.9).wrist[1]).toFixed(2)} below its own socket, and it does not move again`,
  )
})

/**
 * The head's own line, as a bearing off the pitch's own line in degrees: nought is
 * looking down the pitch (the rig's -z, which is where the plate is), and the sign
 * is the way the body turns. Read off the realised head bone — the harness's
 * `torso.head`, a direction in the rig frame — so a neck turned in a frame the look
 * did not mean shows up here as the difference, where the yaw the pose wrote would
 * not (see the sequence's `look`).
 */
const headLine = (frame) => (Math.atan2(frame.torso.head[0], -frame.torso.head[2]) * DEG)
// ...and how *level* that line is: the head bone's own line has a height in the rig
// frame, and the direction the eyes look along is a direction in the world, so this is
// the gaze's elevation off the horizontal — nought is looking at the horizon, and what
// a pitcher looking at the zone 18 metres away is looking at is a couple of degrees
// below it (the zone is at 0.9 of a metre and his eyes at 1.6).
const headLevel = (frame) => (Math.asin(Math.max(-1, Math.min(1, frame.torso.head[1]))) * DEG)

test('the head holds the line it stands in, takes the zone before the drive fires, and is the body\'s again at the hand-off', async ({ page }) => {
  // A delivery's look, read off the realised skeleton: the promise has three parts, and the
  // first of them is what the look is *not*.
  //
  // The set is not a look at the zone. A pitcher stands in the set looking straight ahead
  // down his own line — side-on, the plate at right angles to him and off his own side — and
  // the front of the coil turns the *body* under a head that holds that line: a windup is the
  // body winding under eyes that keep theirs, and a head carried round with the shoulders has
  // stopped looking at anything.
  //
  // The look is picked up *before* the legs take the body anywhere: the head sweeps off its
  // own line and onto the zone over the windup's lift, and it is there by the balance point
  // (``AUTHORED_LOOK_LOCK_TIME``) — a settled thirteenth of a second ahead of the drive
  // (``AUTHORED_DRIVE_TIME``: the frame the hip crosses its own nought on its way to the
  // plate). What stays quiet through the drive is the head, not the body.
  //
  // From there it *is* a look, and it is the whole of what "looking at the strike zone" is.
  // The *bearing*: the eyes are on the zone the ball is going to from the balance point to
  // the hand-off (``AUTHORED_HANDOFF_TIME``: the release plus 70% of the delivery's own
  // 0.44 s of flight, a twentieth of a second before the trail foot lands), with the body
  // coming round *under* them — the shoulders more than five score degrees further round
  // than they threw it from — which is what a pitcher throwing looks like from behind the
  // plate. What it costs is the neck, and it is the whole of the coil: at the balance the
  // chest is a hundred and twenty-odd degrees off the plate and every degree of it is in the
  // neck, with the eyes still. The *level* of it: the head holds the zone's line and not the
  // trunk's, so it does not tip down with the fold the pitch is thrown out of. That is the
  // promise the old authoring missed outright — it took the chest's *turn* off the neck and
  // nothing else, so the head rode the trunk's 33° fold on the release frame down with it
  // and the gaze read 35° below level, looking at the plate's own line through the dirt the
  // pitch was thrown over (see the sequence's own solve, which takes the trunk's fold off as
  // well by solving the neck's two angles for the direction itself).
  //
  // ...and then the look is the body's again — handed over *early*, on a chest that is
  // still coming round onto its finish, so the first of the unwind rides shoulders that
  // are moving under it. The neck unwinds the rest, and the clip comes home to the stance
  // it opened in, with the head the chest's at both ends of it.
  //
  const frames = await sweepDelivery(page, AUTHORED_CLIP_END)
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.021)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const line = (clip) => headLine(row(clip))
  const level = (clip) => headLevel(row(clip))
  const chest = (clip) => row(clip).torso.yaw * DEG
  // The set and the front of the windup: the head holds the line it stood in — level, on
  // the horizon — while the shoulders start to coil under it. That is the two halves of the
  // promise at once: the *bearing* stays where it was (the head did not come round with the
  // body), and so does the *level* of it (it did not tip with the trunk either: the model
  // stands with its ribcage tipped ten degrees over its hips at rest, and a gaze that rode
  // that was the eyes on the floor).
  for (const clip of [0, 0.2, 0.32, 0.48]) {
    expect(
      Math.abs(line(clip) - line(0)),
      `at ${clip}s the head is looking ${(line(clip) - line(0)).toFixed(1)}° off the line it stood in, on a chest ${(chest(clip) - chest(0)).toFixed(0)}° further off the plate: it came round with the body`,
    ).toBeLessThan(1)
    expect(
      Math.abs(level(clip)),
      `at ${clip}s the head's line is ${level(clip).toFixed(1)}° off level: it is riding the trunk's fold`,
    ).toBeLessThan(2)
  }
  expect(
    Math.abs(chest(0.8) - chest(0)),
    `the windup only winds the shoulders ${(chest(0.8) - chest(0)).toFixed(0)}° off the set: there is nothing for the neck to be carrying`,
  ).toBeGreaterThan(20)
  // ...and the look is *finished* before the drive does anything: on the plate's own line and
  // level by the balance point, still on it on the last frame before the drive fires (0.92,
  // the frame before the hip crosses its own nought), and on it for the rest of the throw —
  // which is the whole of what "looking at the strike zone" is.
  for (const clip of [AUTHORED_LOOK_LOCK_TIME, 0.92, 1.12, RELEASE, 1.42, 1.52, 1.6, 1.62]) {
    expect(
      Math.abs(line(clip)),
      `at ${clip}s the head is looking ${line(clip).toFixed(1)}° off the plate`,
    ).toBeLessThan(2)
    expect(
      Math.abs(level(clip)),
      `at ${clip}s the head's line is ${level(clip).toFixed(1)}° off level: it is riding the trunk's fold`,
    ).toBeLessThan(2)
  }
  expect(
    Math.abs(line(0.92) - line(AUTHORED_LOOK_LOCK_TIME)),
    `the head moves ${(line(0.92) - line(AUTHORED_LOOK_LOCK_TIME)).toFixed(1)}° between the balance and the eve of the drive: the turn is not finished when the drive fires`,
  ).toBeLessThan(2)
  // ...and it holds it while the body comes round under it: from that balance point to the
  // hand-off the shoulders turn more than five score degrees and the head's own line turns
  // none of them.
  const shoulders = chest(AUTHORED_HANDOFF_TIME) - chest(AUTHORED_LOOK_LOCK_TIME)
  expect(
    Math.abs(shoulders),
    `the shoulders only come round ${shoulders.toFixed(0)}° between the balance and the hand-off: nothing to stay still against`,
  ).toBeGreaterThan(90)
  expect(
    Math.abs(line(AUTHORED_HANDOFF_TIME) - line(AUTHORED_LOOK_LOCK_TIME)),
    `the head's line turns ${(line(AUTHORED_HANDOFF_TIME) - line(AUTHORED_LOOK_LOCK_TIME)).toFixed(1)}° with the shoulders' ${shoulders.toFixed(0)}°: the eyes are coming round with the body`,
  ).toBeLessThan(2)
  // The hand-off is early by design, and that is a promise the harness can read: the
  // chest is still coming round when the head is let go (it is held from the landing on,
  // 1.68, and the hand-off is 0.05 s short of it).
  expect(
    AUTHORED_ZONE_TIME - AUTHORED_HANDOFF_TIME,
    'the look is handed over after the ball has already arrived',
  ).toBeGreaterThan(0.1)
  expect(
    chest(1.68) - chest(1.64),
    `the chest is already square at the hand-off: there is nothing under the head to follow`,
  ).toBeGreaterThan(1)
  // The frame it happens on is one the delivery's own grid straddles, so it is read on
  // its own: the eyes are *still* on the zone at the moment the ball is 70% of the way
  // there, on a head the realised skeleton agrees with.
  const handoff = await openAt(page, AUTHORED_HANDOFF_TIME)
  expect(
    Math.abs(headLine(handoff)),
    `the head is ${Math.abs(headLine(handoff)).toFixed(1)}° off the plate at the hand-off itself`,
  ).toBeLessThan(2)
  expect(
    Math.abs(headLevel(handoff)),
    `the head is ${Math.abs(headLevel(handoff)).toFixed(1)}° off level at the hand-off itself`,
  ).toBeLessThan(2)
  // And the arrival is on the *walk* rather than at the start of it: the ball crosses
  // the plate with the head a third of the way off the zone, on a chest it has not yet
  // caught up with — a right angle short of the way the body faces, which is what makes
  // this a hand-off rather than a step. (What the old clock did with the same promise
  // was start handing the look back on the release itself, so that by the time the ball
  // arrived the head was a third of the way round off a body stopped dead.)
  // Read off the plate's own line, which is the bearing nought: the head is still a third
  // of the way round the zone the ball is crossing when it crosses it.
  const arrival = line(AUTHORED_ZONE_TIME)
  expect(
    Math.abs(arrival),
    `the head is still ${Math.abs(arrival).toFixed(0)}° on the plate when the ball arrives: the hand-off is doing nothing`,
  ).toBeGreaterThan(20)
  expect(
    Math.abs(line(AUTHORED_ZONE_TIME) + chest(AUTHORED_ZONE_TIME)),
    `the head is already the shoulders' at the ball's own arrival: the hand-off is a step`,
  ).toBeGreaterThan(30)
  // Then it is the body's: the neck unwinds the counter-rotation it has been holding —
  // a hundred and some degrees of it — and the *shoulders* are stopped for all of it
  // but the first few degrees (the finish is held from the landing on, see the test
  // above), so what carries the head round the rest of the way is the neck letting go.
  const turned = line(2.4) - line(AUTHORED_ZONE_TIME)
  const shouldersHeld = chest(2.4) - chest(1.68)
  expect(
    Math.abs(shouldersHeld),
    `the shoulders turn ${shouldersHeld.toFixed(1)}° from the landing to the hold: nothing was handed over`,
  ).toBeLessThan(1)
  expect(
    Math.abs(turned),
    `the head comes round only ${turned.toFixed(0)}° once the ball has gone: it never lets go of the zone`,
  ).toBeGreaterThan(60)
  // ...and it comes round the one way, with nothing swinging back toward a zone the ball
  // has already left (the neck's counter-rotation unwinding is a turn, not a wobble).
  let previous = line(1.6)
  for (let clip = 1.64; clip <= 2.4 + 1e-9; clip += 0.04) {
    expect(
      line(clip),
      `the head holds ${line(clip).toFixed(1)}° at ${clip.toFixed(2)}s, back from ${previous.toFixed(1)}°: it is not turning with the body`,
    ).toBeLessThanOrEqual(previous + 1e-9)
    previous = line(clip)
  }
  // And by the hold it is the shoulders': the head's own line *is* the line the chest is
  // facing. What the harness reads as the chest's yaw is the same axis as the head's own
  // line taken the other way round (a yaw off the bone's own left-right axis against the
  // direction its facing runs), so what agrees between the two is the pair's own
  // magnitude — and it agrees to a fifth of a degree.
  const held = row(2.8)
  expect(
    Math.abs(line(2.8) + held.torso.yaw * DEG),
    `the head looks ${(line(2.8) + held.torso.yaw * DEG).toFixed(1)}° off the way the torso faces at the hold`,
  ).toBeLessThan(2)
  // ...and the head comes home with the body it is on and then onto its own line: the look
  // is nought for the finish and the hold, and the last of the recovery turns it back onto
  // the line it stands in as the body squares up under it.
  for (const clip of [3.16, AUTHORED_CLIP_END]) {
    expect(
      Math.abs(line(clip) - line(0)),
      `at ${clip}s the head is looking ${(line(clip) - line(0)).toFixed(1)}° off the line it began on: it has not come home into its stance`,
    ).toBeLessThan(3)
    expect(
      Math.abs(level(clip)),
      `at ${clip}s the head's line is ${level(clip).toFixed(1)}° off level: it has not come home into its stance`,
    ).toBeLessThan(2)
  }
  const pinned = [
    ...frames.filter(
      (frame) => frame.clip >= AUTHORED_LOOK_LOCK_TIME - 1e-9 && frame.clip <= AUTHORED_HANDOFF_TIME + 1e-9,
    ),
    handoff,
  ]
  const off = Math.max(...pinned.map((frame) => Math.abs(headLine(frame))))
  const tilt = Math.max(...pinned.map((frame) => Math.abs(headLevel(frame))))
  console.log(
    `look: the head holds its own line to the sweep, is on the plate from the balance point ` +
      `(a thirteenth of a second before the drive fires) and the body's again past the hand-off, ` +
      `holding the plate within ${off.toFixed(1)}° of bearing and ${tilt.toFixed(1)}° of level ` +
      `while the shoulders come round ${shoulders.toFixed(0)}° and the trunk folds 33° under it, ` +
      `out to the hand-off at ${AUTHORED_HANDOFF_TIME.toFixed(3)}s (${(1.68 - AUTHORED_HANDOFF_TIME).toFixed(2)}s before the trail foot lands), ` +
      `with the chest still turning ${(chest(1.68) - chest(1.64)).toFixed(1)}° onto its finish under it: ` +
      `the ball arrives with the head already ${Math.abs(arrival).toFixed(0)}° round on a chest ` +
      `${Math.abs(line(AUTHORED_ZONE_TIME) + chest(AUTHORED_ZONE_TIME)).toFixed(0)}° the other side of it, ` +
      `and the rest of the ${Math.abs(turned).toFixed(0)}° is the neck's off shoulders that move ` +
      `${Math.abs(shouldersHeld).toFixed(1)}° from the landing on; the recovery has the head ` +
      `${Math.abs(line(AUTHORED_CLIP_END) - line(0)).toFixed(1)}° off the line it began on, which is where it stands`,
  )
})

test('the trunk turns on the axis it is folded along', async ({ page }) => {
  // The torso is turned by the pitch and does not tumble off its own axis doing it:
  // the pelvis and the chest lean as *one* block (the driver's own shear between
  // their up axes, nought for a torso hinged at the hip), and the trunk's up stays on
  // the pelvis' own left-right line as the body comes round the plate. What is left
  // over is the swing's hip-to-shoulder separation, which across a leaning body is a
  // degree or two of the same measure by geometry — and the delivery's own separation
  // is a *wound* one now (the coil is held until the break, so the chest trails the
  // pelvis by up to 26° through the plant), which puts the floor of this measure near
  // five degrees rather than three; a torso that leaned toward the glove hand as it
  // came round would be tens of degrees of it, and a lean applied in the world's
  // frame rather than the body's — the mistake this is here to catch — would grow
  // with the turn itself.
  const frames = await sweepDelivery(page)
  const turning = frames.filter((frame) => frame.clip >= 1.0 && frame.clip <= 1.76)
  expect(turning.length, 'the turn should be swept whole').toBeGreaterThan(15)
  let worstRoll = 0
  let worstShear = 0
  for (const frame of turning) {
    worstRoll = Math.max(worstRoll, Math.abs(trunkRoll(frame)))
    worstShear = Math.max(worstShear, frame.separation.shear * DEG)
    expect(
      frame.torso.up[1],
      `at ${frame.clip}s the trunk stands ${(Math.acos(Math.min(1, frame.torso.up[1])) * DEG).toFixed(1)}° off upright: it turns standing up, and a roll read off it is a plumb body's own noise`,
    ).toBeLessThan(0.9995)
  }
  // ...and a lean that has *arrived* by the cock: the late one the delivery is
  // authored with leaves the break and the plant nearly upright by design (the
  // pivot's own 6° at the top of the turn), so the fold this test is about is the
  // one it turns on from 1.24 on — a trunk properly over, and turning on its axis.
  //
  // The window ends where the *turn's* own work does rather than at the finish: the
  // trunk comes back up out of the fold as the delivery spends itself — the release's
  // fold is the deepest of it, and the landing is a body *standing* (the finish's own
  // lean is three degrees off upright once he is in it; see the sequence's landing and
  // finish notes), so the frames past 1.6 are that stand rather than the turn's own
  // ground. What is read below is the fold the turn was spent on, and its floor is the
  // 13.6° the trunk still holds at 1.6.
  const folded = turning.filter((frame) => frame.clip >= 1.24 && frame.clip <= 1.6)
  expect(folded.length, 'the cock and the drive should be swept whole').toBeGreaterThan(8)
  const flattest = folded.reduce(
    (flat, frame) => (frame.torso.up[1] > flat.torso.up[1] ? frame : flat),
    folded[0],
  )
  expect(
    flattest.torso.up[1],
    `at ${flattest.clip}s the trunk stands only ${(Math.acos(Math.min(1, flattest.torso.up[1])) * DEG).toFixed(1)}° off upright: the drive is thrown off a body standing back up`,
  ).toBeLessThan(0.99)
  expect(worstShear, `the two blocks of the trunk disagree about up by ${worstShear.toFixed(2)}°`)
    .toBeLessThan(1)
  expect(
    worstRoll,
    `the trunk leans ${worstRoll.toFixed(1)}° off the pelvis' own line while it turns`,
  ).toBeLessThan(6)
})

test('every planted foot stands on the ground rather than in it', async ({ page }) => {
  // The ground rule reads the *shoe* — the model's own lowest vertices, skinned by
  // the bones the leg solve has just written — rather than a bone inside the
  // leather, because an ankle has no joint to roll on and the shoe's own corner is
  // what dips under the surface when the leg turns it (with the bone-level read,
  // this model's shoes sat 1.2 to 2.5 cm under the dirt through the whole delivery).
  //
  // And it is a rule the foot *converges* on rather than one lift: the shoe is aimed
  // at the toe, so dropping the ankle turns it about the toe and the leather comes
  // down by only a fraction of the ankle's travel. At one pass the delivery's own
  // standing feet hung 3.0-5.6 mm over the dirt (worst through the kick); with the
  // passes iterated they stand on it. The bound is the measured worst, 0.01 mm, with
  // room to spare but none for a rule that has stopped landing the foot: at the old
  // 3 mm a return to the one-pass read would pass this test.
  const frames = await sweepDelivery(page)
  let planted = 0
  for (const frame of frames) {
    for (const leg of frame.legs) {
      if (!leg.planted) continue
      planted += 1
      expect(
        Math.abs(leg.sink),
        `the ${leg.side === 1 ? 'pivot' : 'front'} foot at ${frame.clip}s stands ${leg.sink} rig units out of the ground`,
      ).toBeLessThan(0.0005)
    }
  }
  expect(planted).toBeGreaterThan(20)
})

test('the kick hangs its shin straight down', async ({ page }) => {
  // A leg the delivery is *carrying* is lifted, not pulled: the pose names where the
  // knee is going and the shin dangles under it, so the foot hangs below the knee
  // rather than being folded back over its own place (see the ``hang`` share in the
  // pose assembly, and the driver's leg solve). A shin folded back across the body
  // reads as a leg being dragged — measured off the pole the foot's own place gives,
  // the kick's shin sat 20-40° off plumb through the lift with the knee two hand
  // widths across from its own foot — and the share is therefore the foot's own height
  // off the ground rather than a ramp across the lift, so the leg hangs from the
  // moment it leaves the dirt: what is left at the very take-off is the foot swinging
  // out from under the body, over the first hand's width of the lift.
  const frames = await sweepDelivery(page)
  let carried = 0
  for (const frame of frames) {
    if (frame.clip < 0.42 || frame.clip > 1.03) continue
    const front = frame.legs.find((leg) => leg.side === -1)
    expect(front.planted, `the kick's foot is on the ground at ${frame.clip}s`).toBe(false)
    carried += 1
    const plumb = fromVertical(front.knee, front.ankle)
    expect(plumb, `the kick's shin hangs ${plumb.toFixed(1)}° off plumb at ${frame.clip}s`)
      .toBeLessThan(2)
  }
  expect(carried, 'the kick should be carried for a good part of a second').toBeGreaterThan(12)
})

test('the hip cock turns the lead leg about the vertical axis', async ({ page }) => {
  // The cock is the lead leg's own *turn*: with the knee up and the shin hanging under
  // it, the thigh comes round toward the back leg and the knee's height does not move
  // with it. What makes it a turn is that the direction the knee is pointed along is
  // handed to the solve in two pieces — the azimuth the cock turns, and the elevation
  // the lift owns (see the pose assembly's ``kneeDir``) — so there is nothing left for
  // the cock to move the knee up or down with. Read before that, the tilt came off the
  // knee's own place, and the pitch's bend dragged the knee 4 cm upward through the
  // cock instead of swinging it round.
  // ...and the height is read *over the lead hip*, not over the ground: the windup
  // rides the pelvis up and down as the weight goes onto the drive leg (that is the
  // windup's own bob, and its own test), and the knee's world height carries all of
  // it — 15 mm of pelvis over this window. What the cock owns is where the knee sits
  // against its own socket, and that is what is pinned here: the pelvis may rock
  // under it as much as the windup asks.
  const frames = await sweepDelivery(page)
  const heights = []
  let first = null
  let last = null
  for (const frame of frames) {
    if (frame.clip < 0.58 || frame.clip > 0.82) continue
    const lead = frame.legs.find((leg) => leg.side === -1)
    const pivot = frame.legs.find((leg) => leg.side === 1)
    heights.push(lead.knee[1] - lead.hip[1])
    // How square the lead thigh is to the line from its own hip to the back foot: the
    // cock is the knee coming round onto that line, and the plate is the other way.
    const thigh = [lead.knee[0] - lead.hip[0], lead.knee[2] - lead.hip[2]]
    const back = [pivot.ankle[0] - lead.hip[0], pivot.ankle[2] - lead.hip[2]]
    const align = (thigh[0] * back[0] + thigh[1] * back[1]) /
      (Math.hypot(thigh[0], thigh[1]) * Math.hypot(back[0], back[1]))
    if (first === null) first = align
    last = align
  }
  expect(first, 'the cock should be swept whole').not.toBeNull()
  expect(
    last,
    `the lead knee ends ${(Math.acos(last) * (180 / Math.PI)).toFixed(1)}° off the back leg: the cock did not turn it toward it`,
  ).toBeGreaterThan(0.95)
  // The turn is read as the *angle* the thigh still makes with that line rather than
  // as the cosine of it: the cosine is what the alignment is, and near the line it
  // is flat — a knee that comes from 21° off the line to 5° off it has turned 16°
  // while the cosine moved a tenth (see the windup's own hips, which are a hand's
  // width further back than they were when this was first written).
  expect(
    (Math.acos(Math.min(1, first)) - Math.acos(Math.min(1, last))) * (180 / Math.PI),
    `the lead knee comes only ${((Math.acos(Math.min(1, first)) - Math.acos(Math.min(1, last))) * (180 / Math.PI)).toFixed(1)}° closer to the back leg's own line through the cock`,
  ).toBeGreaterThan(12)
  const rise = Math.max(...heights) - Math.min(...heights)
  expect(
    rise,
    `the lead knee moves ${(rise * 1000).toFixed(1)} mm against its own hip through the cock: the hip cock is lifting the leg, not turning it`,
  ).toBeLessThan(0.006)
})

test('the back leg drives in the plane it drives in', async ({ page }) => {
  // The pivot foot is planted on the rubber and the body turns *on* it, so the leg
  // it carries goes on bending in one plane: the knee travels forward toward the
  // plate and the shin does not swing out sideways across the body with the hips.
  // The hips come round 113° through the drive, and a knee whose bend plane was read
  // off the body's own facing swings through all of it — measured before the pivot
  // shoe's yaw was authored in the foot's own frame, the pivot knee crossed the
  // body's midline by 17 cm at the release while its own foot was 14 cm the other
  // side of it.
  //
  // What the plane holds is the *outside* of the leg: the hip cocks the knee out
  // over the outside of its own foot as the drive starts (6 cm at its worst, just
  // after the break) and it never crosses to the inside of the foot or over the
  // body's midline — measured before the cock was authored, the knee was on the
  // wrong side of its own foot by 17 cm.
  const frames = await sweepDelivery(page)
  let drive = 0
  for (const frame of frames) {
    if (frame.clip < 1.0 || frame.clip > 1.32) continue
    const pivot = frame.legs.find((leg) => leg.side === 1)
    drive += 1
    const inside = pivot.ankle[0] - pivot.knee[0]
    expect(
      inside,
      `the pivot knee is ${inside} rig units inside its own foot at ${frame.clip}s`,
    ).toBeLessThan(0.03)
    expect(
      pivot.knee[0],
      `the pivot knee is across the body's own midline at ${frame.clip}s`,
    ).toBeGreaterThan(0)
    expect(
      pivot.knee[2],
      `the pivot knee is behind its own foot at ${frame.clip}s, not driving over it`,
    ).toBeLessThan(pivot.ankle[2])
  }
  expect(drive, 'the drive should be swept whole').toBeGreaterThan(6)
})

test('neither arm is carried through the body, and neither elbow locks', async ({ page }) => {
  // Both rules are the driver's own (see the open-arm solve): the arm is held clear
  // of the trunk's own volume by its own reaches — the hand's place, the elbow's
  // ring, and the fold the arm takes when neither can keep it out — and it may not
  // straighten past ELBOW_BEND_MAX, because a chain with no bend left in it reads as
  // a hyper-extended limb however it was scaled to get there. The delivery crosses
  // the throwing arm over the body after the release, which is exactly the pose that
  // used to put it through the chest: measured before the guard, the elbow sat 17 cm
  // inside the trunk and both arms disappeared into the jersey.
  const frames = await sweepDelivery(page)
  for (const frame of frames) {
    for (const arm of frame.arms) {
      expect(
        arm.depth,
        `the ${arm.side} arm at ${frame.clip}s is ${arm.depth} rig units inside the trunk`,
      ).toBeLessThan(0.012)
      expect(arm.fold, `the ${arm.side} arm at ${frame.clip}s folded off the pose`).toBeLessThanOrEqual(1)
      expect(
        arm.elbowDegrees,
        `the ${arm.side} elbow at ${frame.clip}s is ${arm.elbowDegrees}° — a locked arm`,
      ).toBeLessThan(170)
    }
  }
})

// The waist, cropped and compared tightly — and the one place in this file where a
// picture is the promise rather than a number.
//
// The belt is where three surfaces meet: the jersey, the belt, and the naked body
// the uniform is worn over, and the cut opens the two of them that belong to the
// clothing. What went wrong there was a *look*, not a pose: the backing under the
// cut sat a quarter of the radius inside — deeper than the body — so the few
// millimetres the hem slides off the belt at the set and the windup showed bare
// skin and the body's inside in ragged patches instead of cloth. Every number in
// this file was already right when that happened, and the probe can only say the
// uniform is whole (``holes``), since the second surface along a ray through the
// waist is as often the far side of the body as the near side of it. So the set
// and the windup are pinned as pixels, the way the batter's own belt is, at a
// tolerance tight enough that a torn belt cannot fit inside it.
test.describe('the belt, close up', () => {
  // The waist in the suite's own 960x720 frame, with the glove-side view held out
  // far enough that the belt fills the crop.
  const BELT_CLIP = { x: 300, y: 330, width: 340, height: 140 }
  for (const [phase, file] of [
    ['set', 'pitcher-belt-set.png'],
    ['windup', 'pitcher-belt-windup.png'],
  ]) {
    test(`${phase} keeps the belt whole`, async ({ page }) => {
      const clip = phase === 'set' ? 0 : 0.05
      await openAt(page, clip, '&view=glove&zoom=3.4')
      // What the uniform's own surface is here, as a floor on what the picture may
      // contain: a ray that finds nothing has gone through it into the body.
      const belt = await page.evaluate(() => window.__vr.probeBelt())
      expect(belt, 'the harness should measure the belt').not.toBeNull()
      expect(belt.holes, `${phase}: the uniform should be whole at the waist`).toBe(0)
      console.log(
        `${phase}: ${belt.rays} rays across the waist · ${belt.holes} through it · ` +
          `${belt.through} meeting the sleeve first · sleeve inset ${(belt.inset * 100).toFixed(0)}%`,
      )
      await expect(page).toHaveScreenshot(file, { clip: BELT_CLIP, maxDiffPixelRatio: 0.001 })
    })
  }
})

test('a left-handed delivery mirrors the right-handed one', async ({ page }) => {
  const right = await openAt(page, RELEASE)
  const left = await openAt(page, RELEASE, '&hand=L')
  // The other arm throws...
  expect(right.arm.side).toBe('R')
  expect(left.arm.side).toBe('L')
  // ...and it reaches the same release point by the same delivery, the other way
  // round the body: the world point is the pitch's, and every lateral number is the
  // right-hander's mirrored.
  expect(left.miss).toBeLessThan(0.002)
  expect(left.ballRig[0]).toBeCloseTo(-right.ballRig[0], 3)
  expect(left.ballRig[1]).toBeCloseTo(right.ballRig[1], 3)
  expect(left.ballRig[2]).toBeCloseTo(right.ballRig[2], 3)
})
