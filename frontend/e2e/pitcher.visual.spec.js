import { test, expect } from '@playwright/test'
import {
  ARM_ANGLE_BAND,
  AUTHORED_CLIP_END,
  AUTHORED_HANDOFF_TIME,
  AUTHORED_LOOK_LOCK_TIME,
  AUTHORED_RELEASE_TIME,
  AUTHORED_SLOT_END,
  AUTHORED_ZONE_TIME,
  PIVOT_AHEAD,
  PIVOT_BEHIND,
  PIVOT_SIDE,
  RELEASE_ELBOW,
  RUBBER_Y,
  STANCE_SIDE_MAX,
  STATURE_BAND,
  straightChord,
  STRIDE_BAND,
  TRUNK_TILT_MAX,
} from '../src/util/pitcherSequence.js'
import { FIELD } from '../src/constants/field.js'
import { MOUND, moundSurfaceY } from '../src/constants/mound.js'

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
// The default game's own last pitch: a left-hander's 76 inches whose slot is 0.885 m
// up, 16.4 m out in front of the rubber's own line and 1.216 m across it — the widest
// lateral any pitch in the feed asks a body to answer for, and the one the levers are
// read on (see the game pitch's own block below).
const GAME = '&x=1.2157&hand=L&height=76&up=0.8851&out=16.4025'
// ...the same body and the same slot with the *ask* taken away: the release stood over
// the body's own midline, so neither of the delivery's two lateral levers is spent and
// the pose is the un-asked delivery's own. It is the reading the kick below is held
// against — what the wide pitch's drive leg does *before* the back leg drives it.
const GAME_UNASKED = GAME.replace('&x=1.2157', '&x=0')
// How much lower a cap is worn than a helmet: the two hats' brim undersides, each
// measured off its own mesh (see BRIM_UNDERSIDE in src/util/batterLook.js). It is the
// whole of what the hat has to say about the face under it — the eyes are read under
// whichever brim is above them, so the pitcher's sit this much lower than the batter's.
const BRIM_DROP = 1.7954 - 1.7835

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
  // hand arriving at the release point off a cramped elbow. The pose hands the throwing
  // arm its *own* elbow limit and girdle budget (see RELEASE_ELBOW and the pose's arm
  // output: the driver's default 165° bow is the arm of a hand held near the body, not
  // the arm a pitch leaves on), measured from the socket the law's own share names
  // rather than from the chest's centre (see `pitcherRelease`, which is where the
  // anchor is built), and what comes back off the posed skeleton is that arm as the
  // driver's own socket really stands.
  //
  // This is the regression check on that one promise, and it is worth one because the
  // elbow folds as the *square root* of how far inside the chord the ball sits: a pose
  // whose estimate of the socket drifts a couple of centimetres — or an anchor that
  // stops asking for the chord, or a driver left to answer with its own bows — folds
  // the one arm a pitch is read on, and nothing else in the delivery reports it.
  // Measured on the way here: building the pose's socket off the hip sockets instead
  // of the spine pivot the driver really hinges the upper body on put it 2.8 cm out
  // and read 141.6° (the unit suite pins that pivot), the pivot alone read 147.1°, the
  // girdle's budget at the chord closed 18° more of it (the clavicle was swinging a 4°
  // bow under an ask it thought was past the arm's span, which moved the socket 1.9 cm
  // and folded the elbow back to hold a wrist the body had already reached), and what
  // the release asks for *now* is its own limit rather than the model's: a chord of
  // 0.5994 of the 0.600 the two bones span, 174.9° off the posed skeleton, held from
  // the cock (89° at 1.26s) through the release — the bound below is that chord's own
  // angle, with a few degrees of room for the millimetres between the pose's socket
  // estimate and the body's.
  // ...and read at the harness's own default pitch, this body's release stands 0.55 m
  // off the plate's own line — what a right-hander's own release is worth, and the
  // pitch the harness throws — so the arm is asked to *reach across* for it (see
  // ``side`` in pitcherRelease) rather than the whole body being slid under the ball,
  // which is what keeps the pivot shoe on the rubber (see `pitcherPlacement`, and the
  // shoe's own reading below). A body that reaches across an ask that far without
  // leaning after it carries a few degrees of the ask in its elbow: 168.5° measured,
  // off a socket the pose estimates and a clavicle the driver swings for a line the
  // pitch has moved (the lateral lean the release posture still owes, see the file's
  // own notes). What the ask may not do is fold the arm: a pitch leaves on a nearly
  // straight one, and the *centred* release — the same delivery with no lateral to
  // reach for at all — is held to the release's own chord outright.
  expect(elbowAngle(at.arm)).toBeGreaterThan(165)
  // ...and what a pitch's release *is*: the two bones within a few degrees of one line,
  // which is the shape a ball leaves an arm on (see RELEASE_ELBOW). The ask is a limit
  // and the reading is always a whisker inside it, so this is the number the delivery
  // actually promises — read off the realised skeleton at the frame the ball goes, and
  // not off the pose's own chord.
  // The bound is 174.8 rather than 175 because that is what this ask *realises*: the
  // pose hands the driver the release's own chord (see RELEASE_ELBOW, whose note carries
  // the measurement), and the driver's chain answers a whisker inside it — 174.87° — for
  // the millimetres between the rig the pose's metrics describe and the limb the driver
  // actually builds. Past that ask the pose's own wrist stands outside the metric span
  // and the driver *stretches* the bones to hold it, which reads 173.7°: the straightest
  // arm the delivery has is this one, and it is an extended arm — the two bones five
  // degrees inside a straight line at the frame the ball goes.
  expect(
    elbowAngle(at.arm),
    `the release's elbow reads ${elbowAngle(at.arm).toFixed(2)}° — not an extended arm`,
  ).toBeGreaterThan(174.8)
  const centred = await openAt(page, RELEASE, '&x=0')
  expect(centred.pitcherData.profile.side).toBeCloseTo(0, 9)
  expect(elbowAngle(centred.arm)).toBeGreaterThan(173)
  // ...and the *hand* is turned for the throw rather than for the arm's own line. What
  // a hand can face is bounded by the limb it hangs on: the palm's own plane is
  // perpendicular to the forearm, so a palm asked for a bearing the arm is *pointing*
  // along is answered by the wrist's own turn — the closest direction the hand's plane
  // comes to it (see the pose's ``handPalm``, and the driver's ``palmFacing``). The
  // release asks the palm for the *plate's* own bearing, so what comes back is a hand
  // turned toward the zone rather than one turned down the arm's own line: measured off
  // the realised skeleton, the palm's facing has most of nine tenths of its length along
  // the bearing it was asked for, and the ask itself is the zone to within a few
  // degrees (its own lateral is the anchor's, carried back over the pitch's length).
  // ...and what a hand on a *reaching* arm can do about it is bounded by its own
  // anatomy: the palm's plane is perpendicular to the forearm, so a hand at the end of an
  // arm extended toward the zone can turn its palm *across* the throw but never down it —
  // the ask is answered by the wrist's own turn, and what comes back is the closest the
  // hand's plane comes to the bearing (measured: 0.33 of the asked bearing for this
  // body's own release, where the arm itself is pointing at the zone). What the readings
  // below hold is the half of it that *is* a promise: the pose asks the palm for the
  // plate's own bearing rather than for the arm's line, and the hand answers *toward* it
  // rather than away — which is the turn the ball leaves on (see the pose's ``handPalm``).
  // The line the hand itself runs along is held above with the aim it is written from.
  for (const pitch of [at, centred]) {
    const facing = dot(pitch.arm.palm, pitch.arm.palmAsk)
    const aimed = dot(pitch.arm.aim, pitch.arm.palmAsk)
    expect(
      pitch.arm.palmAsk[2],
      `the release's palm is asked for a bearing ${pitch.arm.palmAsk[2].toFixed(3)} of the way to the plate`,
    ).toBeLessThan(-0.9)
    expect(
      facing,
      `the realised palm sits ${(Math.acos(Math.max(-1, Math.min(1, facing))) * (180 / Math.PI)).toFixed(0)}° off the bearing it was asked for`,
    ).toBeGreaterThan(0.25)
    // (The hand's own *line* is not asked this: a pitch's hand leaves the wrist along the
    // arm's own chord rather than level at the zone (see the pose's ``writeReleaseArm``,
    // and the wide slot the harness throws — the socket stands half a metre across from
    // the ball, so that line is well off the plate's bearing by construction and the
    // palm is what is turned toward it). Measured for the record: 60° here.)
    expect(aimed, 'the hand line is pointing away from the plate').toBeGreaterThan(0)
  }
  // ...and the shoe's own line is what the lateral does not move: the drive shoe's
  // ankle stands inside the leather across the rubber — the rubber's own half-width
  // and a shoe's own beside it (see PIVOT_SIDE) — whatever the pitch's release asks of
  // the arm.
  for (const pitch of [at, centred]) {
    expect(
      Math.abs(pitch.pitcherData.placement.line),
      `the drive shoe stands ${pitch.pitcherData.placement.line.toFixed(4)} across the rubber's own line`,
    ).toBeLessThanOrEqual(PIVOT_SIDE)
  }
  // ...and the pitch the whole placement was read off: the default game's own last pitch
  // — a left-hander's 76 inches of body, the ball released 0.885 m up and 16.4 m out and
  // 1.216 m across the rubber's own line (the harness carries all four as ``?hand``,
  // ``?height``, ``?up``, ``?out`` and ``?x``). The hand is asked for a release point
  // more than a metre off the body's own midline, which is the ask the old placement
  // answered by *sliding the body* out from under the shoe: measured then, the drive
  // shoe stood half a metre past the rubber's edge with the ball still 13 mm off the
  // pitch's own lateral (see the placement's own notes). The three readings below are
  // what the fix is for: the ball on the pitch's own point, the shoe inside the leather
  // across the rubber, and no shortfall reported against either.
  const game = await openAt(page, RELEASE, GAME)
  expect(game.miss, `the game's own pitch misses its release point by ${game.miss}`).toBeLessThan(0.002)
  expect(
    Math.abs(game.pitcherData.placement.line),
    `the game's own pitch stands its drive shoe ${game.pitcherData.placement.line.toFixed(4)} across the rubber`,
  ).toBeLessThanOrEqual(PIVOT_SIDE)
  expect(
    game.pitcherData.profile.sideShortfall,
    `the game's own pitch reports a lateral shortfall of ${game.pitcherData.profile.sideShortfall}`,
  ).toBeLessThan(0.002)
  expect(
    game.pitcherData.profile.shortfall,
    `the game's own pitch reports a shortfall of ${game.pitcherData.profile.shortfall}`,
  ).toBeLessThan(0.002)
  // ...and the two levers that ask spends are the *body's*: a metre off the midline is
  // past any arm's own cone, so the trunk rolls out over the rubber and the step carries
  // the rest — read off the delivered pose at the release frame, and read as what the
  // pose *drew* rather than as what the ask was worth (see `pitcherRelease`).
  const { tilt, offsetX } = game.pose.hip
  expect(
    Math.abs(tilt),
    `the game's own pitch leans its trunk ${(tilt * DEG).toFixed(1)}° of the ${(TRUNK_TILT_MAX * DEG).toFixed(1)}° a trunk may take`,
  ).toBeGreaterThan(0.4)
  expect(Math.abs(tilt)).toBeLessThanOrEqual(TRUNK_TILT_MAX + 1e-9)
  expect(
    Math.abs(offsetX),
    `the game's own pitch carries its body ${offsetX.toFixed(4)} m across the stance`,
  ).toBeGreaterThan(0.15)
  expect(Math.abs(offsetX)).toBeLessThanOrEqual(STANCE_SIDE_MAX + 1e-9)
  // ...toward the side the pitch is thrown from: the left-hander's own throwing side is
  // the rig's -x (the keys are authored for a right-hander and his delivery is their
  // mirror), and both levers go that way with the ask.
  expect(tilt, `the trunk leaned ${(tilt * DEG).toFixed(1)}° off the throwing side`).toBeLessThan(0)
  expect(offsetX, `the body was carried ${offsetX.toFixed(4)} m off the throwing side`).toBeLessThan(0)
  // ...and it is *realised* rather than asked for and dropped: the trunk's roll is a
  // rotation of the whole upper body about its own midline, so the pelvis under it comes
  // down on the throwing side with it — read off the delivered skeleton as the two hip
  // sockets' own line. What that line's angle is worth in the world is not the tilt
  // outright: the roll turns about the body's own midline, and the body is folded 40°
  // over its hips by the release, so the socket comes down by the roll's own share of
  // the fold (measured: 21.3° of it for the tilt's 28.65°, against 8.5° of line the same
  // delivery shows with no lateral ask to answer at all — which is a stance's own lean,
  // and the number the bound below is read against).
  const sockets = game.legs.map((leg) => leg.hip)
  const lower = Math.sign(sockets[0][0] - sockets[1][0]) === Math.sign(tilt) ? sockets[0] : sockets[1]
  const higher = lower === sockets[0] ? sockets[1] : sockets[0]
  const dropped = Math.atan2(higher[1] - lower[1], length(sub(higher, lower))) * DEG
  expect(
    dropped,
    `the hip socket on the side the trunk leans on stands ${dropped.toFixed(1)}° above its fellow`,
  ).toBeGreaterThan(15)
  // ...and the trunk is not merely *twisted* off the pelvis it stands on: read as the
  // ribcage's own up axis against the hip sockets' line, the two agree about which way
  // is up (see `trunkRoll`, and the driver's own ``separation``), which is what makes
  // the roll the whole body's rather than the chest's.
  expect(
    Math.abs(trunkRoll(game)),
    `the trunk stands ${trunkRoll(game).toFixed(1)}° off the axis the pelvis' own sockets give it`,
  ).toBeLessThan(4)
  // ...and the carry is the *pelvis'* rather than the drive foot's — read off the
  // realised skeleton at the two ends of the window the carry spends: the top of the
  // kick, where the *step* has not been paid yet (it comes out with the drive, past the
  // fall; see STEP_TRACK) and the drive leg is standing where the un-asked delivery
  // stands it, and the plant, with the trunk rolled the whole of a trunk's tilt and the
  // carry full. What has to hold is which of the two moved: the body is carried across
  // the rubber and the shoe it stands on is not, so the stance the drive foot was placed
  // at is still the stance (which is why the shoe's own line above is read at all).
  const kick = await openAt(page, 0.8, GAME)
  const plant = await openAt(page, 1.2, GAME)
  const kickDrive = kick.legs.find((leg) => leg.planted)
  expect(kickDrive, 'the drive foot should be the foot on the ground at the top of the kick').not.toBeUndefined()
  const plantDrive = plant.legs.find((leg) => leg.side === kickDrive.side)
  const slid = Math.abs(plantDrive.ankle[0] - kickDrive.ankle[0])
  expect(
    slid,
    `the drive foot slid ${slid.toFixed(4)} m across the body while the pelvis was carried ${Math.abs(offsetX).toFixed(4)} m:`
    + ' the step is spending the shoe, not the body',
  ).toBeLessThan(0.03)
  const travelled = Math.abs(plantDrive.hip[0] - kickDrive.hip[0])
  expect(
    travelled,
    `the pelvis stands only ${travelled.toFixed(4)} m from where the same delivery had it before the levers were spent`,
  ).toBeGreaterThan(0.3)
  // ...and the leg under it pays for the carry with its own slant rather than by being
  // stretched to a foot it can no longer reach: the chord from the hip socket to the
  // ankle is inside the leg's own length, and it leans a long way across the hip's own
  // line — which is the relaxation the carry needs, since nothing asks a drive leg to
  // stand plumb along the pitch's own direction.
  const span = sub(plantDrive.ankle, plantDrive.hip)
  expect(
    length(span),
    `the drive leg's chord is ${length(span).toFixed(4)} of its ${plantDrive.legLength.toFixed(4)} leg: it is stretched to hold a foot it cannot reach`,
  ).toBeLessThanOrEqual(plantDrive.legLength + 1e-3)
  expect(
    Math.abs(span[0]) / length(span),
    `the drive foot stands only ${(Math.abs(span[0]) / length(span)).toFixed(3)} of the leg across its own hip's line: the leg is a plumb rod under a carried pelvis`,
  ).toBeGreaterThan(0.3)
  // ...and the leg only takes that line on the frames the back leg *drives* on: through
  // the whole of the kick the wide pitch's drive leg stands where the same body with the
  // ask taken away stands it — the same chord out of the same hip socket, the same slant
  // off the vertical. The *carry* is why that has to be: the body's own metres cost the
  // leg its line (the readings above), so nothing about the ask may swing the drive leg
  // out from under a body the kick has not moved — which is why the metres wait for the
  // drive (see STEP_TRACK), asserted outright below. The delivery's *other* lever runs on
  // the *kick's* own clock (the roll is what carries the socket the throw hangs from
  // across, and the cock is drawn back off it — see TILT_TRACK), and what keeps it free is
  // that the *height* it costs the legs is on the drive's clock instead (see
  // TILT_LIFT_TRACK), charged by `rollLift` against a socket that by measurement barely
  // moves while the pelvis is coiled: the roll comes out over the leg the weight is on and
  // leaves the chord that leg hangs by alone.
  //
  // Three readings, because the ask reaches the realised leg along three roads. The
  // *carry* is the promise outright: nought on every frame before the fall (asserted
  // below), so there is nothing in the posed body for the leg to be swung out by. The
  // *roll* is standing on the kick's own frames and has to cost the leg nothing (the lean
  // below, which is the reading this block is here for). And the *skeleton* the driver
  // builds off that pose then still differs a little between the two deliveries, because
  // the two are asked for different pitches — the trunk's own fold, the pelvis' place
  // along the rubber and the ground the foot is solved onto are none of them the same in
  // the two solves, and the leg reads the difference: measured 1.9° at the gather and 3.0°
  // at the fall with the roll 46% and 80% of the way out (logged below), against the 0.1°
  // the rocker itself carries with none of the roll yet in the body.
  const slantOf = (pitch) => {
    const leg = pitch.legs.find((candidate) => candidate.planted)
    expect(leg, 'the drive foot should be the foot on the ground through the kick').not.toBeUndefined()
    const chord = sub(leg.ankle, leg.hip)
    return Math.atan2(chord[0], -chord[1]) * DEG
  }
  // The rocker is the kick's own first frame; the two readings after it are the frames the
  // leg is coming up over. None of the roll on the first (the kick has not started), a
  // *share* of it on the ones after — the roll is one motion with the leg, so it is
  // neither waiting for the drive nor whole by the gather — and the carry exactly nought
  // on every one of them (the step waits for the drive).
  for (const t of [0.46, 0.8, 1.05]) {
    const asked = await openAt(page, t, GAME)
    const unasked = await openAt(page, t, GAME_UNASKED)
    const roll = Math.abs(asked.pose.hip.tilt)
    // The whole of the ask's roll, read off the *plant*'s own frame: the tilt is standing
    // by the plant (see TILT_TRACK), so every frame below it carries a share of this one
    // rather than a number of its own.
    const whole = Math.abs(plant.pose.hip.tilt)
    if (t <= 0.46) {
      expect(roll, `the roll is ${roll} at ${t}s: the kick has not started`).toBeLessThan(1e-12)
    } else {
      expect(roll, `the roll is ${roll} at ${t}s: the kick carries none of it`).toBeGreaterThan(1e-6)
      expect(
        roll,
        `the roll is ${((roll / whole) * 100).toFixed(0)}% in at ${t}s: it is not one motion with the leg`,
      ).toBeLessThan(whole - 1e-6)
    }
    expect(
      Math.abs(asked.pose.hip.offsetX),
      `the carry is ${asked.pose.hip.offsetX} at ${t}s: the ask is paid before the drive`,
    ).toBeLessThan(1e-12)
    const lean = Math.abs(slantOf(asked) - slantOf(unasked))
    console.log(
      `drive leg at ${t}s: ${slantOf(asked).toFixed(2)}° asked against ${slantOf(unasked).toFixed(2)}° un-asked ` +
        `(${lean.toFixed(2)}° apart, the roll ${((roll / whole) * 100).toFixed(0)}% in and the carry nought)`,
    )
    expect(
      lean,
      `the drive leg stands ${slantOf(asked).toFixed(1)}° off the vertical at ${t}s where the un-asked delivery has the same body's at ${slantOf(unasked).toFixed(1)}°:`
      + ' the ask has swung out a leg the kick has not moved',
    ).toBeLessThan(10)
  }
  // ...and it is *that* chord rather than merely a straight-ish arm: the realised
  // chord is the release's own, to within a millimetre — and the ball still rides the
  // pitch's own release point above, because what the straighter chord adds comes back
  // out of the hand's carry rather than out of the ball's place. This is the half of
  // the regression that a fold shows up in first — the elbow's own angle moves as the
  // square root of it, so a chord asked for a couple of centimetres short reads as a
  // bent arm here while the place the ball lands on is still perfect.
  const upper = length(sub(at.arm.elbow, at.arm.shoulder))
  const fore = length(sub(at.arm.wrist, at.arm.elbow))
  const chord = straightChord(upper, fore, RELEASE_ELBOW)
  const held = length(sub(at.arm.wrist, at.arm.shoulder))
  // The wide release carries a couple of millimetres of its lateral in the chord (the
  // same socket-and-clavicle reading the elbow's own bound above is about), and the
  // centred one is the release's own chord, which is what the pose asks for there.
  expect(
    held,
    `the wrist stands ${held.toFixed(4)} from the socket, not the release's own chord (${chord.toFixed(4)})`,
  ).toBeGreaterThan(chord - 0.005)
  const centredUpper = length(sub(centred.arm.elbow, centred.arm.shoulder))
  const centredFore = length(sub(centred.arm.wrist, centred.arm.elbow))
  const centredHeld = length(sub(centred.arm.wrist, centred.arm.shoulder))
  expect(
    centredHeld,
    `the centred release's wrist stands ${centredHeld.toFixed(4)} from the socket, not its own chord`
    + ` (${straightChord(centredUpper, centredFore, RELEASE_ELBOW).toFixed(4)})`,
  ).toBeGreaterThan(straightChord(centredUpper, centredFore, RELEASE_ELBOW) - 0.002)
  // The body the pitch is thrown by, as the profile solved it: the pitch's own
  // distance in front of the rubber (its extension) is what the delivery and the
  // stance together have to answer for...
  const rubber = -RUBBER_Y
  const profile = at.pitcherData.profile
  expect(
    Math.abs(profile.needed - (at.release[2] - rubber)),
    `the delivery is answering for ${profile.needed} of the pitch's own ${(at.release[2] - rubber).toFixed(4)}`,
  ).toBeLessThan(0.002)
  // ...and it does answer for it: 54 feet is six and a half feet of extension, which is
  // inside the stride band a staff spans, so nothing is left over (see `shortfall`).
  expect(profile.stride).toBeGreaterThanOrEqual(STRIDE_BAND[0])
  expect(profile.stride).toBeLessThanOrEqual(STRIDE_BAND[1])
  expect(profile.shortfall).toBeLessThan(0.01)
  // The body the pitch is thrown by is the *pitcher's* own: the feed's listed height —
  // the harness's 6'2", off the same gameData lookup the batter's height comes from —
  // stands him at that stature, and the scale he is drawn at is that stature over the
  // rig's own (see pitcherProfile in util/pitcherSequence.js). The pitch does not size
  // him: a slot the arm cannot hold is a reported shortfall rather than a taller body.
  expect(Math.abs(profile.stature - 74 * 0.0254), 'the body is not the pitcher’s own height').toBeLessThan(1e-9)
  expect(profile.scale).toBeCloseTo(profile.stature / profile.rigStature, 9)
  expect(Math.abs(profile.heightShortfall)).toBeLessThan(1e-6)
  // The arm's own angle at that release is the release point's own — the elevation of
  // the line from the socket to the ball — and the band it is read against is the
  // staff's (see ARM_ANGLE_BAND: a submarine's arm at one end, an over-the-top arm's at
  // the other). Which slot this pitch's line is *is* the mound's business: the pitch's
  // own 1.78 m is a world height, and the mound the body stands on takes its own share
  // of it — the stance is 0.244 m up the plateau, so the arm is asked to hold 1.536 m
  // over its own feet, 0.82 of the body's stature, and the line the socket runs up to
  // that slot reads 18.9° on this body: a low three-quarters. (Read off the field's own
  // plane instead — the slot the same release is worth when the mound under the feet is
  // missed — the delivery reads about 35°, which is where this bound sat before the
  // mound was in the solve; the number the suite is for is the body's own.) The floor
  // below is a few degrees under the reading, where a collapse to a flat line shows.
  expect(profile.armAngle).toBeGreaterThan((ARM_ANGLE_BAND.low * 180) / Math.PI)
  expect(profile.armAngle).toBeLessThan((ARM_ANGLE_BAND.high * 180) / Math.PI)
  expect(profile.armAngle).toBeGreaterThan(15)
  // The drive foot, in the world: the shoe is on the rubber. The rubber's own front
  // edge is the line the pitch's own release distances are measured from (see
  // RUBBER_Y), so where the pivot foot came out along z is a fact about the *field*
  // rather than about the pose — and the band it is held in is the leather of the
  // shoe itself (see PIVOT_AHEAD, PIVOT_BEHIND).
  const foot = at.pitcherData.placement.foot
  expect(
    foot[2],
    `the drive foot stands at ${foot[2].toFixed(3)}, ${(foot[2] - rubber).toFixed(3)} from the rubber's own line`,
  ).toBeGreaterThan(rubber - PIVOT_BEHIND)
  // ...with the shoe's own leather read as the *ankle's* allowance rather than the
  // sole's: a stance the delivery's own length cannot reach any other way sits exactly
  // at the allowance, and the yaw the pitch's own lateral turns the body through swings
  // that ankle a few millimetres past it on this pitch (3.1 mm measured, the sole still
  // on the rubber — the toe's own ball is what PIVOT_AHEAD names).
  expect(foot[2]).toBeLessThan(rubber + PIVOT_AHEAD + 0.005)
  // ...and both of the set's feet are on the ground: the body stands at the ground's
  // own height — the mound's own top under the stance, 0.244 m of plateau, which is the
  // surface Pitcher.jsx's solve is handed (see constants/mound.js) rather than the
  // field's own plane — the shoe's own rest height is what the ankle sits at over it,
  // and the surface under the shoe is the mound's own to within the solve's whisker
  // (the ground is read at the stance the solve stands, and this is the round trip).
  expect(at.pitcherData.placement.position[1]).toBeCloseTo(MOUND.surface + MOUND.rise, 9)
  expect(
    Math.abs(profile.ground - moundSurfaceY(foot[0], foot[2])),
    `the stance is stood at ${profile.ground.toFixed(4)} over the mound's own ${moundSurfaceY(foot[0], foot[2]).toFixed(4)} under its foot`,
  ).toBeLessThan(0.001)
  expect(
    foot[1] - profile.ground,
    'the drive shoe should sit its own rest height over the ground, at the body’s scale',
  ).toBeCloseTo(0.0852 * profile.scale, 4)
})

test('the pitcher’s own height stands his body, and the stance is solved from it', async ({ page }) => {
  // The feed carries the pitcher's listed height beside the batter's, and it is the
  // body's own stature: the same pitch point out of two different men is the same arm on
  // a bigger body, and the stance — where along the rubber he stands, and how far he
  // strides — is solved from the height and the release point's own arm angle together.
  // ``?height=`` is that number in inches (the harness's own PITCH carries 6'2" by
  // default, see harness/pitcherMain.jsx), so the same pitch can be thrown by a staff.
  const at = await openAt(page, RELEASE)
  const tall = await openAt(page, RELEASE, '&height=78')
  const profile = at.pitcherData.profile
  const tallProfile = tall.pitcherData.profile
  // Each body stands at the height the feed listed him at — 6'2" and 6'6" — and is
  // drawn at the scale that stature is worth over the rig's own.
  expect(Math.abs(profile.stature - 74 * 0.0254), 'the body is not the pitcher’s own height').toBeLessThan(1e-9)
  expect(Math.abs(tallProfile.stature - 78 * 0.0254), 'the taller body is not the pitcher’s own height').toBeLessThan(1e-9)
  expect(profile.scale).toBeCloseTo(profile.stature / profile.rigStature, 9)
  expect(tallProfile.scale).toBeCloseTo(tallProfile.stature / tallProfile.rigStature, 9)
  expect(tallProfile.scale).toBeGreaterThan(profile.scale)
  // ...and the stance follows the two *together*, by the two levers the profile has:
  // the shoe's own place along the rubber, and the delivery's own length. The 6'2"
  // body's authored delivery carries the ball 17 cm past the pitch's own point, which
  // is inside the shoe's own leather (see PIVOT_BEHIND), so his delivery stays the
  // authored one and the *shoe* gives back down the line by that much. The 6'6" body's
  // own delivery carries it past by more than the leather can give back, so there it is
  // the *stride* that gives instead: a shorter delivery, with the shoe stood on the
  // rubber's own line. Both still land the ball on the pitch's own point, which is what
  // the accounting below reads. The arm that carries it hangs at the lower angle off
  // the taller man's own shoulder, which is Statcast's own reading of a slot (see
  // `armAngle`).
  expect(
    profile.scale * profile.travel - profile.needed,
    'the 6’2" body’s delivery should over-run the pitch’s own point, for the shoe to give it back',
  ).toBeGreaterThan(0.1)
  expect(profile.stride).toBe(1)
  expect(profile.contact).toBeLessThan(-0.1)
  expect(tallProfile.stride).toBeLessThan(profile.stride)
  expect(Math.abs(tallProfile.contact)).toBeLessThan(1e-6)
  expect(tallProfile.armAngle).toBeLessThan(profile.armAngle)
  // ...with both of them still meeting the pitch's own point: the delivery's own travel
  // and the stance's own place between them account for the pitch's distance in front of
  // the rubber, the posed hand lands on the release point, the shoe is on the rubber,
  // and the body stands on the ground.
  for (const [who, read] of [['6\'2"', at], ['6\'6"', tall]]) {
    const body = read.pitcherData.profile
    expect(
      Math.abs(body.scale * body.travel + body.contact + body.shortfall - body.needed),
      `the ${who} body's delivery and stance do not account for the pitch's own distance`,
    ).toBeLessThan(1e-6)
    expect(read.miss, `the ${who} body missed the release point`).toBeLessThan(0.002)
    expect(
      Math.abs(body.heightShortfall),
      `the ${who} body could not hold its own slot`,
    ).toBeLessThan(1e-6)
    const shoe = read.pitcherData.placement.foot
    expect(shoe[2]).toBeGreaterThan(-RUBBER_Y - PIVOT_BEHIND)
    expect(shoe[2]).toBeLessThan(-RUBBER_Y + PIVOT_AHEAD)
    // ...stand on the ground the delivery was solved from, and that ground is the
    // mound's own surface at the stance the shoe came out on.
    expect(
      read.pitcherData.placement.position[1],
      `the ${who} body does not stand on its own ground`,
    ).toBeCloseTo(body.ground, 9)
    expect(
      Math.abs(body.ground - moundSurfaceY(shoe[0], shoe[2])),
      `the ${who} body is solved from ${body.ground.toFixed(4)} while the mound under its shoe is ${moundSurfaceY(shoe[0], shoe[2]).toFixed(4)}`,
    ).toBeLessThan(0.001)
  }
  // A body clamped to the band's own floor still throws this pitch: ``?height=60`` is
  // five foot six by the time it is a body, and the arm's own envelope at that stature
  // — the law's shoulder plus a straight arm at the top of the band (see `slotCeiling`)
  // — covers the pitch's own 1.78 m slot outright, so the hand is on the release point
  // and the shortfall is nought. It is the *stride* that answers the pitch's own
  // distance: a longer delivery than the authored one, inside the band, with the feet
  // still on the ground and the shoe still on the rubber.
  const small = await openAt(page, RELEASE, '&height=60')
  const smallProfile = small.pitcherData.profile
  expect(smallProfile.stature).toBeCloseTo(STATURE_BAND[0], 9)
  expect(smallProfile.heightShortfall).toBeLessThan(1e-6)
  expect(smallProfile.stride).toBeGreaterThan(1)
  expect(small.miss).toBeLessThan(0.002)
  expect(small.pitcherData.placement.position[1]).toBeCloseTo(smallProfile.ground, 9)
  const smallShoe = small.pitcherData.placement.foot
  expect(smallShoe[2]).toBeGreaterThan(-RUBBER_Y - PIVOT_BEHIND)
  expect(smallShoe[2]).toBeLessThan(-RUBBER_Y + PIVOT_AHEAD)
  expect(
    Math.abs(smallProfile.ground - moundSurfaceY(smallShoe[0], smallShoe[2])),
  ).toBeLessThan(0.001)
  // ...and a pitch whose feed carries no height at all falls back to the rig's own
  // stature rather than to nothing: the model's own body at its own size.
  const none = await openAt(page, RELEASE, '&height=none')
  expect(none.pitcherData.profile.stature).toBeCloseTo(none.pitcherData.profile.rigStature, 9)
  expect(none.pitcherData.profile.scale).toBeCloseTo(1, 9)
  expect(none.miss).toBeLessThan(0.002)
})

test('the delivery realises the pose it was authored from', async ({ page }) => {
  // Every frame the sequence promises a place for the ball (`pitcherData.ball`, the
  // pose's own answer settled onto the ground the driver stands the body on — see
  // `give`) and the driver answers with where the hand actually carries it
  // (`ballRig`, read off the posed skeleton). Off the release the two may differ by
  // whatever the arm had to borrow; *at* the release there is nothing between them,
  // because that is the frame the ball leaves on.
  for (const clip of [1.2, 1.26, 1.42, 1.62]) {
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
  for (const clip of [0, 0.8, 1.0]) {
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
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

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
  expect(at(1.0), `the cock holds the shoulders at ${at(1.0).toFixed(0)}°`).toBeLessThan(-12)
  // Then the drive hands them over: past square (90°) before the release, and
  // further round after it than they were square — the over-spin.
  // (Read off the sockets, the plant's own turn is 32°: the sequence holds the coil
  // through the fall and the break — the pelvis is a degree off the balance's own
  // winding at the fall and the shoulders are still a good way short of square at the
  // plant — so
  // what the plant carries is the *start* of the unwind rather than most of it (see
  // the sequence's fall key). What is pinned is the order, not the size: the line
  // has come off the cock's own wound angle (−33° here) and is climbing, and the
  // whole of the over-spin below is still made after the release.)
  expect(at(1.2), `the plant has the shoulders at ${at(1.2).toFixed(0)}°`).toBeGreaterThan(28)
  // Past square by the release (90°) with the whole of the turn's *whip* after it —
  // and read off the realised sockets, which the trunk's own fold carried back onto
  // the plate line (see trunkLean) cost a few degrees of, and which the release key's
  // own turn is what asks: the ball leaves on a torso squared to the plate — the
  // release key's chestYaw is a twenty-fifth of a radian, and what the sockets read is
  // 93, three degrees past square. (It read 110 while the same key carried the chest
  // 0.48 rad round, which is a body still unwinding as it throws; the release posture
  // is solvable, so the key was squared instead — see the release key's own comment,
  // and `releasePosture`, which is where the slot's fold is solved.) The turn the
  // release still has to make is therefore all of it *after* the ball, and the pins
  // that hold it are the over-spin ones below.
  expect(at(RELEASE), `the release has them at ${at(RELEASE).toFixed(0)}°`).toBeGreaterThan(90)
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
  // line stands over the drive shoe rather than between the two feet (measured: 16 cm
  // from the drive ankle at the worst frame of the kick, against 37-39 to the kicking
  // foot's, which is a hand's width off the ground by the top of the kick — the same
  // reading was 13-14 cm while the lean-in waited for the plant, and the couple of
  // centimetres are the trunk coming forward over the hips with it, see LEAN_IN_TRACK).
  // Read off the ankles and the hip sockets, so it is the realised skeleton that has
  // to be carrying the weight and not the authoring.
  const frames = await sweepDelivery(page)
  let worst = 0
  let nearest = Infinity
  for (const frame of frames) {
    if (frame.clip < 0.7 || frame.clip > 1.02) continue
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
  console.log(
    `kick: the pelvis stands ${(worst * 100).toFixed(1)} cm off the drive shoe at its worst, and ` +
      `${nearest.toFixed(1)} times nearer it than the kicking foot`,
  )
  expect(
    worst,
    `the pelvis stands ${(worst * 100).toFixed(1)} cm off the drive shoe through the kick`,
  ).toBeLessThan(0.18)
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
  const planted = split(1.2)
  expect(
    planted - stance,
    `the stride steps ${(planted - stance).toFixed(2)} rig units further than the stance: it is a shuffle`,
  ).toBeGreaterThan(0.6)
  // ...and the body is carried by it: the pelvis' own travel toward the plate from
  // the top of the windup to the release.
  const drive = pelvisOf(row(1.0))[2] - pelvisOf(row(RELEASE))[2]
  expect(drive, `the pelvis lands ${drive.toFixed(2)} rig units forward of the cock: it drives in place`)
    .toBeGreaterThan(0.6)
  // The lean-in: the trunk *walks* forward over the plate rather than being laid over
  // on the last of the stride — it starts coming in as the front leg starts to kick,
  // and it is a body already leaning into the pitch that throws. *How deep* the lean
  // gets is the pitch's: the slot's arm angle solves it (see `releasePosture`), and the
  // delivery's own job is to be most of the way there by the plant and whole on the
  // release frame. Read against the frame the stride foot leaves the dirt on (0.5 s,
  // the rocker's own couple of degrees) and across the gather and the balance: the walk
  // is a square of the delivery's own progress to the release (see LEAN_IN_TRACK), so
  // each of those frames is further into the lean than the last — and then the walk is
  // *withdrawn* at the fall, because the back leg's fire puts the trunk back over the
  // drive foot first (see the drive keys' negative lean, and the back-tilt reading
  // below, which is the same promise at the plant).
  const fold = (clip) => chestFold(row(clip))
  expect(Math.abs(fold(0)), `the set is folded ${fold(0).toFixed(0)}° over its own hips`).toBeLessThan(3)
  expect(
    fold(0.8) - fold(0.5),
    `the top of the kick is ${(fold(0.8) - fold(0.5)).toFixed(1)}° further into the lean than the rocker: the lean does not start until the leg does`,
  ).toBeGreaterThan(2)
  expect(
    fold(1.0) > fold(0.8) && fold(1.05) < fold(1.0),
    `the trunk does not rock back over the drive foot between the gather and the fall: ${fold(0.8).toFixed(0)}° -> ${fold(1.0).toFixed(0)}° -> ${fold(1.05).toFixed(0)}°`,
  ).toBe(true)
  // The back tilt: as the back leg fires the trunk folds *back* over the drive foot, and
  // only then falls forward over it (see the drive keys).
  // Read off the ribcage's own bone (see `trunkLean`): the chest's place over the pelvis is
  // the reading the drive leaves behind, so it cannot say whether the trunk is tilted back.
  expect(
    trunkLean(row(1.2)),
    `the plant's trunk is folded ${trunkLean(row(1.2)).toFixed(1)}°: the trunk does not tilt back as the back leg fires`,
  ).toBeLessThan(0)
  expect(
    fold(1.26) >= fold(1.2),
    `the torso unfolds from ${fold(1.2).toFixed(0)}° at the plant to ${fold(1.26).toFixed(0)}° at the cock: it is not carried on into the throw`,
  ).toBe(true)
  // The forward fall over the drive foot is spent before the ball goes: the trunk is most
  // of the way into the release's fold by 1.30s (see the drive keys). The fall is read as
  // *travel from the plant's own back tilt* rather than as an angle from plumb, because
  // the arch is where it starts: a trunk that has to come from 15° back to 32° forward is
  // 65% of the way there at 17° forward, and a share of the release's own angle would call
  // that half a fall and charge the arch for it.
  expect(
    trunkLean(row(1.3)),
    `the trunk is only ${trunkLean(row(1.3)).toFixed(0)}° forward at 1.30s of the release's ${trunkLean(row(RELEASE)).toFixed(0)}°: the fall is not over the drive foot`,
  ).toBeGreaterThan(
    trunkLean(row(1.2)) + 0.65 * (trunkLean(row(RELEASE)) - trunkLean(row(1.2))),
  )
  expect(
    fold(RELEASE) - fold(1.2),
    `the last of the stride adds nothing to the lean: the release's fold is not the pitch's own either`,
  ).toBeGreaterThan(1)
  // ...and the body it is leaning *at the release* is the pitch's own: the fold is the
  // posture the slot's arm angle solves (see `releasePosture`), which is the fold the
  // lean-in's own window arrives at (see LEAN_IN_TRACK) rather than the authored key's
  // deeper one — so what the release frame holds is the solved fold, to the fraction of
  // a degree the ribbon's tilt over the pelvis is worth (see the realised trunk against
  // the pose's own number).
  const posture = (await openAt(page, RELEASE)).pose.hip.fold * DEG
  expect(
    trunkLean(row(RELEASE)),
    `the release leans ${trunkLean(row(RELEASE)).toFixed(1)}° rather than the pitch's own ${posture.toFixed(1)}°`,
  ).toBeCloseTo(posture, 0)
  expect(fold(RELEASE), `the release is folded ${fold(RELEASE).toFixed(0)}°`).toBeGreaterThan(20)
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
    gloveBelowShoulder(1.0) - gloveBelowShoulder(0),
    'the hands do not come up with the kick',
  ).toBeGreaterThan(0.08)
  // ...and it is *both* of them, not the glove's alone: the clasp the two are holding
  // rises most of the way from the belt to the chest's own centre as the knee comes up —
  // a good two hands' widths from the set to it, which is the shape a windup's high hands
  // are (the ball under the chin rather than down at the belt). It is read on the kick's
  // own top (0.80 s) rather than four frames later: the clasp's lift finishes there, and
  // by 1.00 s the throwing hand has let go of it and is down at the hip.
  const chestMid = (clip) => {
    const sockets = row(clip).arms.map((arm) => arm.shoulder)
    return sockets[0].map((value, axis) => (value + sockets[1][axis]) / 2)
  }
  const handsUp = (clip) => row(clip).ballRig[1] - chestMid(clip)[1]
  expect(
    handsUp(0.8) - handsUp(0),
    `the clasp only comes up ${((handsUp(0.8) - handsUp(0)) * 100).toFixed(0)} cm toward the chest over the kick`,
  ).toBeGreaterThan(0.09)
  // The sample the rise is read from is the sweep's own (0.72s, a good fraction of a
  // second before the top of the kick), and the rise is *how much nearer the shoulder
  // the elbow ends up*: the elbow's own height above the shoulder, now less the same
  // reading then. It is held under the fall's own rise (the bound below), because what
  // it measures is that the kick raises the elbow only some of the way and the body
  // coming forward onto the drive leg is what takes it up the rest (the two are logged
  // below, and the kick's own share of them is about a third).
  const kickRise = elbowBelowShoulder(1.0) - elbowBelowShoulder(0.72)
  const fallRise = elbowBelowShoulder(1.12) - elbowBelowShoulder(1.0)
  console.log(
    `lead elbow: rises ${kickRise.toFixed(3)} rig units over the kick and ${fallRise.toFixed(3)} over the fall ` +
      `(${((kickRise / (kickRise + fallRise)) * 100).toFixed(0)}% of it the kick's own)`,
  )
  expect(
    kickRise,
    `the lead elbow rises ${kickRise.toFixed(3)} rig units over the kick`,
  ).toBeLessThan(0.12)
  // ...and the rise is authored *late*: the leg comes up, the body falls forward onto
  // the drive leg and only then does the elbow come up (see the sequence's fall), so
  // the reading is the two halves of it — what the kick does not move, and what the
  // fall does. The bound is the measured worst with none of the slack a rule that has
  // stopped holding could hide in: 0.20 of a rig unit against the 0.22 the delivery
  // read while the lean waited for the release, because the trunk now spends the whole
  // of the fall coming in over the plate (see LEAN_IN_TRACK) and the elbow hangs off
  // the shoulder that is coming with it. What the two have to keep is the order and the
  // size: the fall's own lift is several times the kick's.
  expect(
    fallRise,
    `the lead elbow only rises ${fallRise.toFixed(3)} rig units over the fall`,
  ).toBeGreaterThan(0.19)
  // ...and the glove does not rise with it: the elbow does the rising, so the forearm
  // ends up pointing down off it rather than the hand coming up to meet it.
  expect(
    Math.abs(gloveBelowShoulder(1.12) - gloveBelowShoulder(1.0)),
    'the glove rose with the elbow rather than holding its own height',
  ).toBeLessThan(0.09)
  // ...and it hangs *down off* that raised elbow: with the elbow brought up to within
  // a few centimetres of its own shoulder and the glove left at the chest, the
  // forearm is the whole of the drop between them, which is a good 45° below the
  // horizontal — the raised-elbow shape the windup is for, not the 5° a level arm
  // reads (measured on the realised skeleton: 33° at the elbow's own top).
  //
  // Read *against the chest it hangs from*, which is the arm's own shape and the one
  // thing a delivery cannot move: the trunk leans in over the whole of the windup (see
  // LEAN_IN_TRACK), and the arm is authored in the chest's frame, so the rig's own
  // vertical reads the arm's angle less the lean's — 10° at the top of the kick, where
  // the chest is 32° into the fold, against the 33° the delivery read while the lean
  // waited for the release. Taken off the chest's own line the same arm reads 42°, which
  // is the number that has to hold.
  const chestOff = (clip) => trunkLean(row(clip))
  const fore = leadForearm(row(1.12)) - chestOff(1.12)
  expect(fore, `the lead forearm points ${fore.toFixed(0)}° off the chest it hangs from at the top of the kick`)
    .toBeLessThan(-25)
  expect(fore).toBeGreaterThan(-65)
  // ...and it is still hanging *down* in the world the pitch is thrown in, which is what
  // the hitter reads: the lean takes its own degrees and the arm keeps the rest.
  expect(
    leadForearm(row(1.12)),
    `the lead forearm points ${leadForearm(row(1.12)).toFixed(0)}° in the world: the mitt is held level`,
  ).toBeLessThan(-5)
  // Then the throw: from the plant the lead arm only ever gets *longer*, and it is
  // nearly straight by the middle of the follow-through. Read to the finish and no
  // further: the fold back toward the set that comes after it is the recovery's own,
  // and a lead arm that came down to the fielding posture without ever folding would
  // be the arm held out rather than let down.
  let longest = 0
  let previous = 0
  for (let clip = 1.2; clip <= 1.68 + 1e-9; clip += 0.04) {
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
    if (frame.clip < 1.05 || frame.clip > 1.3) continue
    worst = Math.max(worst, palmOffPlate(frame))
    worstBend = Math.max(worstBend, wristBend(frame))
    worstAsk = Math.max(worstAsk, angle(leadArm(frame).palm, leadArm(frame).palmAsk))
  }
  // The bounds below are the measured worsts, and the worsts here are the *lean-in's*
  // own cost, which is worth naming rather than hiding in a number: the mitt's hand is
  // authored in the chest's frame (see the pose's `aimLocal`, and the driver's open-arm
  // solve, which rolls the palm about the line that frame gives it), so the trunk coming
  // in over the plate across the windup turns the line by the lean's own degrees, and a
  // palm can only be rolled about that line: while the chest is a good 25-30° into the
  // fold the roll runs out of room and the mitt stops *square* to the hitter — 36° off at
  // its worst, against the 12-20° a mitt held up in front of an upright chest reads. That
  // is a real cost of walking the lean in from the kick (see LEAN_IN_TRACK) and it is the
  // one promise in this suite that the change spends: what it would take to have both is
  // the *arms*' authored numbers carried by the lean's own turn as well — the pose hands
  // the driver a place and a line in the chest's frame and a palm in the rig's, and only
  // the palm is written where the pitch goes.
  //
  // What the bounds still hold is the showing itself: the pose still *asks* for the plate
  // (within 3° of the bearing, asserted on the ask below) and the hand still gets most of
  // the way round to it — the mitt is turned to the hitter rather than away from him, and
  // the hand is still rolled about its own line (the two bounds under this one, which are
  // unmoved). A delivery that stopped asking, or a roll that stopped turning, would fail
  // them.
  expect(
    worst,
    `the glove's palm is ${worst.toFixed(0)}° off the plate from the elbow's top to the release`,
  ).toBeLessThan(40)
  expect(
    worstBend,
    `the hand stands ${worstBend.toFixed(0)}° off its own forearm: the palm was pointed at the zone rather than rolled onto it`,
  ).toBeLessThan(70)
  expect(
    worstAsk,
    `the palm misses the facing the pose asked for by ${worstAsk.toFixed(0)}°: a roll cannot reach it`,
  ).toBeLessThan(40)
  // ...and it is showing the zone *before* the shoulders get there, which is the
  // picture a palm-led unwind is: at the elbow's own top the palm is on the plate
  // while the shoulder line is still wound *off* it — ninety-odd degrees short of
  // square (see the windup's own reading of that line) — and it holds through the
  // break, the striding plant, the cock and the release.
  const top = frames.find((frame) => Math.abs(frame.clip - 1.12) < 0.02)
  expect(top, 'the sweep should cover the elbow\u2019s own top').not.toBeUndefined()
  expect(
    palmOffPlate(top),
    `the palm is ${palmOffPlate(top).toFixed(0)}° off the plate at the elbow\u2019s own top`,
  ).toBeLessThan(31)
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
  // ...and the frames are the windup's through the *parting*: the grip is let go on the
  // key that lifts the hands highest rather than over the fifth of a second after it
  // (see PART_KEYS in src/util/pitcherSequence.js — the hands part at 0.80 s, the top of
  // the kick, so the throwing arm has the whole of the fall to start from rest in), so
  // 0.80 is the last frame the two hands are one hand and 1.00 is the throw's own.
  for (const clip of [0, 0.46, 0.8]) {
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
  for (const clip of [0, 0.46]) {
    const at = await claw(clip)
    expect(
      at.palm[2],
      `at ${clip}s the glove's palm faces ${(at.palm[2]).toFixed(2)} of the way at the plate: the grip is being shown`,
    ).toBeGreaterThan(0.8)
  }
  // The break opens it: by the plant the glove is the open one the plate is shown.
  for (const clip of [1.2, 1.26]) {
    const at = await claw(clip)
    expect(
      at.curl,
      `the glove's fingers are still ${at.curl.toFixed(2)} rad closed at ${clip}s: it comes to the plate as a fist`,
    ).toBeLessThan(0.6)
  }
  const set = await claw(0)
  const open = await claw(1.26)
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
  const winding = frames.filter((frame) => frame.clip <= 0.8 + 1e-9)
  expect(winding.length, 'the sweep should cover the windup').toBeGreaterThan(12)
  const set = row(0)
  // The hands come up to the chest over the windup — a stance's hands hang at the
  // belt and a windup's are at the chest — and the elbows hold while they do it: in
  // the world to within the body's own settle (the pelvis drops two centimetres at
  // the rocker and stands up five over the gather), and, under their own shoulders,
  // to within a couple of centimetres, which is the promise no settle can move.
  expect(
    leadArm(row(0.8)).wrist[1] - leadArm(set).wrist[1],
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
  // holding could hide in: 10.5 cm of body for the world, 4.9 cm of arm for the shape,
  // and 3.7 cm for the two arms against each other — read with the clasp's lift finishing
  // on the top of the kick (see the gather's own elbow note), which is the taller of the
  // two windups this reading has been taken on. The same three readings on the delivery
  // whose throwing elbow rode up with the hands are 15 cm, 11 cm and 29 cm — each of
  // these reddens on it.
  //
  // The world reading is the one of the three that moves with the delivery, and it is
  // read in the rig's own frame: the trunk now leans in across the windup (see
  // LEAN_IN_TRACK), which carries the shoulders forward and *down* and their elbows with
  // them — that is the body coming over the plate rather than the hands carrying the arm
  // up, and it is why the world bound is the looser of the two. The arm's own shape
  // (below) is the promise no leaning can move: a hand that pulled an elbow up would
  // take it off the socket it hangs from.
  expect(
    held,
    `an elbow moves ${held.toFixed(3)} rig units over the windup: the hands carry it up`,
  ).toBeLessThan(0.11)
  expect(
    hang,
    `an elbow hangs ${hang.toFixed(3)} rig units off where its own shoulder had it`,
  ).toBeLessThan(0.05)
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
  for (let clip = 0; clip <= 0.8 + 1e-9; clip += 0.04) {
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
  // top is 1.12s rather than the top of the kick: the rise is authored *late* — the
  // kick lifts the leg and the hands, and the elbow comes up over the fall — see the
  // sequence's fall key and the lead-arm test above.)
  const under = (frame, arm) => arm(frame).shoulder[1] - arm(frame).elbow[1]
  const leadUnder = under(row(1.12), leadArm)
  const trailUnder = under(row(1.12), trailArm)
  // The pair below is read *under the chest's own line* rather than the world's, which is how
  // the forearm's angle above is read and for the same reason: the trunk leans in over the
  // whole of this window (see LEAN_IN_TRACK), and a glove whose place in the chest's frame is
  // the same on both keys travels 23 cm in the world on the chest's own account. What the
  // promise is about is the arm's own shape — the elbow going up out of the mitt's way rather
  // than the hand coming up to meet it — so that is the frame it is read in.
  const chestUp = (frame) => unit(frame.torso.up)
  const elbowUp = (frame, armOf) => dot(sub(armOf(frame).elbow, armOf(frame).shoulder), chestUp(frame))
  const wristUp = (frame, armOf) => dot(sub(armOf(frame).wrist, armOf(frame).shoulder), chestUp(frame))
  const raised = elbowUp(row(1.12), leadArm) - elbowUp(row(0.8), leadArm)
  const glove = Math.abs(wristUp(row(1.12), leadArm) - wristUp(row(0.8), leadArm))
  console.log(
    `kick: elbows at most ${(widest * 100).toFixed(1)} cm apart through the windup · ` +
      `at the elbow's own top the lead is ${(leadUnder * 100).toFixed(1)} cm under its shoulder ` +
      `and the throwing one ${(trailUnder * 100).toFixed(1)} cm under its own · lead elbow up ` +
      `${(raised * 100).toFixed(1)} cm under the chest's line · glove moved ${(glove * 100).toFixed(1)} cm`,
  )
  // The bound is the measured worst, and what the reading is worth: the two elbows'
  // heights are read in the rig's own frame over the windup, so the trunk leaning in
  // across it (see LEAN_IN_TRACK) carries the two shoulders — and so the two elbows —
  // apart on their own: 11.7 cm at the widest, where the delivery read 7 cm while the
  // lean waited for the release. What the number is here for is that the two arms are
  // *one clasp* through the windup rather than already going their own ways, which the
  // mirror's own reading above holds to 3.7 cm, and the lead elbow still comes up to
  // nearly level with its own shoulder by the elbow's top (a centimetre under it, below).
  expect(
    widest,
    `the two elbows are ${widest.toFixed(3)} rig units apart somewhere in the windup`,
  ).toBeLessThan(0.14)
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
  // 1.05s), and by the plant they have gone their own ways. The lead is a hand's width
  // under its shoulder with the glove still at the chest; the throwing arm has climbed
  // *above* its own into the cock.
  // Read across the plant-to-cock rather than on the plant's own key: the delivery holds the
  // throwing upper arm *parallel to the ground* through 1.19-1.20 s (see the swivel's window),
  // so on the plant's own frame the two elbows stand 4.4 cm apart — the divergence the mirror's
  // end is worth is the swivel's, and it is widest where the elbow goes round under the arm
  // (1.24 s: 5.2 cm under its shoulder on the lead arm against 21.6 on the throwing one, 16.4
  // cm apart). Either way round counts: what this holds is that the two arms are no longer one
  // shape, not which of the two elbows is the higher.
  let apart = 0
  let apartAt = 0
  for (let clip = 1.18; clip <= 1.26 + 1e-9; clip += 0.02) {
    const gap = Math.abs(under(row(clip), leadArm) - under(row(clip), trailArm))
    if (gap > apart) { apart = gap; apartAt = clip }
  }
  expect(
    apart,
    `the two elbows are only ${(apart * 100).toFixed(1)} cm apart in their own hang between the plant and the cock (widest at ${apartAt.toFixed(2)}s)`,
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
  //
  // The share is the measured one, and it is read in the chest's own frame for the reason
  // given above the pair: the glove's place on the two keys is nearly the same offset from
  // the same socket, so what moves the wrist in that frame is the driver's own solve and no
  // more — a third of the elbow's rise, which is what leaves the forearm slanting down off a
  // raised elbow rather than the hand coming up to meet a folded arm (the forearm's own
  // angle against the chest, pinned above).
  expect(
    glove,
    `the glove rises ${glove.toFixed(3)} rig units against the elbow's ${raised.toFixed(3)}: the raise is the hand's own rather than the elbow's`,
  ).toBeLessThan(raised * 0.55)
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
  const drive = pelvisOf(row(1.0))[2] - pelvisOf(row(1.68))[2]
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
  // rather than at the plant's own key (1.20): the kick is carried longer than it was,
  // so the foot is still coming down through the plant and it is not until the
  // release's own frame that it stands at the place it plants on (see the lead leg's
  // own note in the assembly).
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
  // the crossing frame reads 31.8° here off the realised joints, a few degrees more
  // folded than the flat-ground delivery this bound was first written on (the swing's
  // own shoe is stood on the mound's dirt by the driver's ground rule), and what the
  // pin is for is the limb it is *not* — a leg tucked under the hips on the end of its
  // own socket folds past a quarter turn (the authoring this replaced reached 104°).
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
    ).toBeLessThan(34)
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
  // Measured on the realised skeleton (the log line below prints each of them): the
  // foot's path bulges 0.86 of a rig unit off the line to its landing and is three and
  // a fifth times as long as that line; the knee sweeps 0.50 of a rig unit across the
  // sockets' line, 0.42 of one *outside* it by 1.48s — the middle of the swing, where
  // the leg is being flung — having started inside the body's own outline at the top of
  // it. (The *landing* is read apart: the
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
  // hips — the drive foot comes down 0.09 of a unit ahead of its own socket, which on
  // the flat ground the delivery is authored against puts the knee 2.5 mm past the
  // sockets' half-line: *level with the hip it hangs from* rather than inside it. On
  // the mound it is further out than that and for the mound's own reason: the finish
  // lands down the front slope and the body steps 0.065 of a unit down it (see the
  // landing test below), so the same leg comes down over a foot that is 0.065 further
  // away — measured 1.7 cm past the half-line at the landing, against a half-line of
  // 0.11, which is still the hip's own level and not a knee carried past the body.
  // What is promised here is that the swing's whole clearance is spent getting there:
  // the knee comes out 0.42 of a unit past the body's line at the middle of the swing
  // and gives all but 0.02 of it back by the landing, so what the foot lands on is the
  // place the finish stands on and the leg has arrived under the body rather than
  // beside it.
  expect(
    landedClear,
    `the knee is still ${(landedClear * 100).toFixed(1)} cm beyond the sockets' own line where the foot lands: the leg is arriving at the foot's place rather than under the body`,
  ).toBeLessThan(0.02)
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
  // ...and the turn's own *rate* is read on the chest rather than on that line, for the
  // same reason the hold below is (see its own note): a line across the two sockets is
  // projected into the rig's own plane, so the trunk standing up out of its fold drags
  // the reading with it — the chest comes off 32° of lean to 3° across this window (its
  // own `up`), which is worth seven degrees of the sockets' line on its own, and the two
  // arms' clavicles add the rest of it as they settle. Measured here: the sockets turn
  // 31.1° between 1.52s and the landing and the chest itself 24.2°, the one reading a
  // projection and the other the body. It is the body's that "the foot lands at the end
  // of the turn" is about.
  //
  // ...and the chest's reading carries a little of the fold as well, which the deeper
  // finish spends: the trunk stands 52.7° over the plate at 1.50 s now rather than 46.9°
  // at 1.53 (see the sequence's FINISH_TILT), and coming up out of that deeper fold across
  // this window moves the chest's own yaw reading from 24.2° to **27.3°** — while the
  // *authored* chest turn over the same window (1.52 to 1.68 s) is 19.2° either way. So
  // the bound below is 28 rather than 25: it still catches a body that turns on past its
  // landing by more than a third of its own turn, which is what it is for, without
  // charging the finish for a metre of lean the reading cannot separate.
  const turned = (clip) => row(clip).torso.yaw * DEG
  expect(
    crossing,
    `the shoulders are already ${(crossing - 180).toFixed(0)}° past square a sixth of a second before the drive foot lands: there is no turn left for the foot to arrive on`,
  ).toBeLessThan(180)
  expect(
    turned(1.68) - turned(1.52),
    `the body turns ${(turned(1.68) - turned(1.52)).toFixed(0)}° between 1.52s and the landing (the sockets read ${(landed - crossing).toFixed(0)}° under the lean's own projection): the last of the turn is a quarter of the body's own`,
  ).toBeLessThan(28)
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
  // The beat the finish is stood in, which is where the promise is read: the facing he
  // lands in is the facing he holds — the turn is spent by the landing and nothing about
  // it moves after — while the trunk is standing up out of its fold from the crossing on
  // (see the sequence's FINISH_STAND_FROM). That is two promises on one body, so the
  // facing is read off the pose's own numbers (the written yaw, which is the body's), and
  // the realised chest is read beside it with the room the stand needs: the harness
  // divides the lean's *factor* out of its yaw rather than the fold itself, so a trunk
  // that comes up twelve degrees across this window shows as a degree or two of yaw. The
  // stand leaves the crossing at once now (see the sequence's holdShareAt), so it comes up
  // **27.6°** across this window (48.1° at the landing to 20.5° at the pause) and the
  // reading shows **3.9°** of it, 3.2° by 2.00 s: the bound is 4 rather than 3, and the
  // role it keeps is the one this paragraph gives it — the *authored* facing is still held
  // to five hundredths of a degree below, and a body that turned on past its landing would
  // be more than a third of its own turn.
  const facing = (clip) => {
    const pose = row(clip).pose
    return (pose.hip.yaw + pose.torsoYawExtra) * DEG
  }
  const heldFacing = facing(2.1)
  const held = line(2.10)
  for (const clip of [1.92, 2.0, 2.1]) {
    expect(
      Math.abs(facing(clip) - heldFacing),
      `the body's own facing turns ${Math.abs(facing(clip) - heldFacing).toFixed(2)}° between ${clip}s and the pause: the pose he lands in is not the pose he holds`,
    ).toBeLessThan(0.05)
    const rolled = Math.abs(row(clip).torso.yaw - heldTurn) * DEG
    expect(
      rolled,
      `the chest turns ${rolled.toFixed(1)}° from the landing to ${clip}s: the pose he lands in is not the pose he holds`,
    ).toBeLessThan(4)
    expect(
      Math.abs(line(clip) - held),
      `the shoulder line drifts ${Math.abs(line(clip) - held).toFixed(1)}° across the hold: the pose he stands in is not the pose he stands in`,
    ).toBeLessThan(3)
  }
  // ...and the stand is the *beat's* now: the trunk comes up out of the finish from the
  // frame the back foot sweeps across the line on (see the sequence's FINISH_STAND_FROM)
  // and leaves that top at once (see the sequence's holdShareAt), so the beat carries most
  // of the stand and what the recovery still has to do is the last of it.
  //
  // The stand is read on the *chest's own up*, which is the movement itself. The line
  // across the two sockets is not: the girdle's clavicles carry the sockets with the chest
  // as it comes up, so the line is a projection of the stand rather than the stand, and it
  // moves 2.3° across the beat where the chest's up moves 27.6° — it read the stand when
  // the stand was slower and the projection happened to fall the other way. Measured here:
  // the chest's up is 27.6° off the landing's by the pause and 45.3° by the recovery's key,
  // so the beat carries 61 per cent of it; the socket line it drags is still to two degrees
  // after the pause, which is the half of the promise that was about the line.
  const chestUp = (clip) => row(clip).torso.up
  const angleOf = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * DEG
  const standOf = (clip) => angleOf(chestUp(1.68), chestUp(clip))
  expect(
    standOf(2.1),
    `the chest comes up only ${standOf(2.1).toFixed(1)}° off its landing across the beat: the trunk is not standing up over it`,
  ).toBeGreaterThan(20)
  expect(
    standOf(2.1) / standOf(2.8),
    `the beat carries only ${(standOf(2.1) / standOf(2.8)).toFixed(2)} of the stand: it is being saved for the walk back`,
  ).toBeGreaterThan(0.5)
  expect(
    Math.abs(line(2.80) - held),
    `the shoulder line moves ${Math.abs(line(2.80) - held).toFixed(1)}° between the pause and the recovery's end: the stand is still being spent after the beat`,
  ).toBeLessThan(2)
  // The pelvis' *height* is the one number the landing frame no longer fixes, and it is
  // the ground rule's rather than the pose's: both shoes are on the dirt from the landing
  // on, and the lead leg straightens 11.3° as the body goes over its plant (see the drive
  // leg's own test), so the two legs' own span to the ground grows by exactly that much
  // and the rule stands the pelvis 4.5 mm higher on it by the time the travel is spent —
  // 4.5 mm across the second, on a body 0.94 of a unit tall. The pose itself does not move:
  // the hip's own height is the landing key's on every frame of the hold.
  // The pelvis' *height* is the one number the landing frame does not fix: both shoes are
  // on the dirt from 1.68 on and the ground rule stands the body on them as the travel
  // comes in, so it settles a couple of centimetres into the finish — and then it comes
  // *up* again, because the trunk is standing out of the fold from the crossing on and the
  // sink it was paid (`FINISH_SINK`) is paid back with it. What the bounds below hold is
  // that the beat's own movement is the stand's and only the stand's: up, a few
  // millimetres across the pause, and the last of it over the recovery.
  expect(
    pelvisOf(row(2.10))[1] - pelvisOf(row(1.92))[1],
    'the pelvis dips across the hold: the trunk is folding rather than standing',
  ).toBeGreaterThan(-0.001)
  expect(
    pelvisOf(row(2.10))[1] - pelvisOf(row(1.92))[1],
    'the pelvis comes up more than the sink it gave the fold across the hold',
  ).toBeLessThan(0.035)
  expect(
    Math.abs(pelvisOf(row(1.92))[1] - pelvisOf(row(1.68))[1]),
    'the pelvis settles more than a hand\'s width into the finish',
  ).toBeLessThan(0.040)
  // ...and the rest of the stand is the recovery's, which is the other half of the same
  // movement: the hips finish giving the sink back over it (see FINISH_STAND). The stand
  // leaves its top at once and is 61 per cent spent by the pause (see above), so what the
  // recovery still has to give back is the 9.9 mm left of the 0.032 rather than the 18.7 a
  // five-figure tail left it: **17.1 mm** measured, the sink's own and the ground rule's
  // settle under it.
  expect(
    pelvisOf(row(2.80))[1] - pelvisOf(row(2.10))[1],
    'the hips do not come up as the trunk stands out of the finish',
  ).toBeGreaterThan(0.012)
  // ...and the *feet* are held with it, which is the same promise read off the ground:
  // the weight that arrives on the trail shoe arrives on a shoe that is standing still,
  // so a foot that travelled on across the hold — the slide the landing's own authoring
  // has to keep out of the keys — is caught here, on the realised ankles. Across the hold
  // the ankles move a millimetre (1.1 and 0.8 mm at 1.92 and 2.00 s); by the recovery's
  // key they have moved **10.4 mm** of the lead one, which is the walk back's own authoring
  // rather than a slide (the recovery's keyed ankle is that far from the landing's), so the
  // last sample has the room the walk needs and the hold has none.
  for (const clip of [1.92, 2.0, 2.8]) {
    for (const side of [1, -1]) {
      const from = (side === 1 ? pivotOf(row(1.68)) : leadOf(row(1.68))).ankle
      const held = (side === 1 ? pivotOf(row(clip)) : leadOf(row(clip))).ankle
      const moved = Math.hypot(held[0] - from[0], held[2] - from[2])
      expect(
        moved,
        `the ${side === 1 ? 'drive' : 'lead'} foot slides ${(moved * 100).toFixed(1)} cm across the hold: the shoe he landed on is not the shoe he is standing on`,
      ).toBeLessThan(clip > 2 ? 0.012 : 0.01)
    }
  }
  // ...and the shoe itself comes round with the body standing over it. The lead foot is
  // the *ground's* from the plant on, and what it turns with is the body — the whole of
  // its turn through the pitch, at the trunk's own shape (see the sequence's
  // FRONT_SHOE_TURN): the hips' keyed turn stalls at 1.555s and then takes a third of its
  // whole turn in thirty-two thousandths, which a planted shoe cannot follow without a
  // skid, while the trunk's is the pitch's own curve. Read off the knee's hint, which is
  // the shoe's own line (see the swing test's note on why the hint and not the joints),
  // 95° between 1.44s and the landing, every step of it shorter than the one before it
  // and nought of it across the hold. What it turns *about* is its own ankle: the lead
  // leg's base does not move from the spot the plant gave it (the unit suite holds that
  // to the last decimal), and the shoe's heel is what comes round the circle instead.
  const shoePlane = (clip) => {
    const leg = leadOf(row(clip))
    return Math.atan2(-(leg.hint[0] - leg.target[0]), -(leg.hint[2] - leg.target[2])) * DEG
  }
  const shoeTurn = shoePlane(1.68) - shoePlane(1.44)
  expect(
    shoeTurn,
    `the lead shoe turns ${shoeTurn.toFixed(0)}° from the plant to the landing: the foot is not coming round with the body`,
  ).toBeGreaterThan(85)
  for (const clip of [1.48, 1.56, 1.64]) {
    const step = shoePlane(clip + 0.04) - shoePlane(clip)
    const next = shoePlane(clip + 0.08) - shoePlane(clip + 0.04)
    expect(
      step,
      `the lead shoe turns ${step.toFixed(1)}° across ${clip.toFixed(2)}-${(clip + 0.04).toFixed(2)}s and ${next.toFixed(1)}° across the next: the shoe's turn is not a decay`,
    ).toBeGreaterThan(next - 0.6)
  }
  expect(
    Math.abs(shoePlane(2.0) - shoePlane(1.68)),
    'the lead shoe turns across the hold',
  ).toBeLessThan(0.05)
  expect(
    Math.abs(held - line(0)),
    `a second after the drive foot lands the body is back in the set: the finish was never held`,
  ).toBeGreaterThan(150)
  console.log(
    `finish: the drive foot lands ${ahead.toFixed(2)} rig units ahead of the plant · the shoulders come ` +
      `${line(RELEASE).toFixed(0)}° -> ${crossing.toFixed(0)}° -> ${landed.toFixed(0)}° (release, a sixth before the foot, the foot), ` +
      `${(landed - 180).toFixed(1)}° past square at the landing and held to ${Math.max(...[1.92, 2.0, 2.8].map((clip) => Math.abs(row(clip).torso.yaw - heldTurn) * DEG)).toFixed(2)}° for the ${(2.8 - 1.68).toFixed(1)}s after it (the sockets the line is read off come ${Math.abs(held - landed).toFixed(1)}° back as the trunk stands out of its fold under them)`,
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
  // of the same (0.8511, 10.3°).
  //
  // The last two and a half per cent is the *shoe*, and it is the pose's own: a planted
  // shoe is stood on the dirt by its own lowest corner (see the driver's ground rule),
  // so a shoe left on whichever corner the leg's turn made lowest carries the *ankle* up
  // by that much — and a socket-to-foot line short by that much is a knee with that much
  // bend in it. Measured with the shoes' own ``flat`` left off these keys, the ground
  // rule has to carry the ankles 0.0316 and 0.0281 of a unit up to get a corner of each
  // shoe down and the knees read 31.4° and 29.7°; with the sole rolled level (``flat`` 1,
  // see the pose assembly and the driver's ``rollSoleFlat``) the ankles come back down to
  // 0.0016 and 0.0022 and the knees read 9.2° and 10.3°. Those are the flat ground's own
  // numbers, and the mound is not that ground.
  //
  // The finish lands a metre and a half out in front of the rubber, down the mound's own
  // front slope, and the two feet do not find the same dirt there: the drive's own shoe
  // stands on 0.167 of the world's metres and the lead's — which planted 0.53 of a rig
  // unit up the slope from it — on 0.218, so the mound puts 0.051 of a unit of its own
  // fall between the two plants, through a 0.8546 limb. The body steps down the mound by
  // what the deeper foot's own shoe asks for (see Pitcher.jsx: the step's depth is the
  // ground rule's own answer rather than the surface's bare fall, because a shoe laid on
  // the slope rides its own leather), so the drive leg lands *at its own length* —
  // measured 99.90 per cent and 5.1° of knee — and the lead knee carries the difference:
  // measured 97.11 per cent, 27.6°. A fixed limb cannot span both, and which one carries
  // it is the design's own choice: the drive leg is the one the weight arrives on and
  // the one whose own ground the body's own step is solved from, so the mound's bill is
  // the lead's. (The lead's own span moved when the pelvis's travel was carried later
  // into the swing — the hips stop a hand's width closer to the lead foot than they used
  // to, see the sequence's finish note, and the leg that has to be long enough to reach
  // that foot is a leg nearer its own length: 40.6° of knee became 27.6°, and the plants
  // themselves are 0.046 of a unit closer together.)
  //
  // Both of them read the same on every frame of the hold that follows: nine tenths of a
  // second later the numbers agree to the thousandth — the drive at 99.90, the lead at
  // 97.11, each knee within a hundredth of a degree of the frame the feet landed in.
  // *That* is what "firm" is here: not a leg held stiff against the weight, but a leg
  // with nothing left to give it — the mound has already spent what the landing spends.
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
  // The arrival: on the frame both feet are down the drive leg stands at its own length
  // — the straightest a bone chain with a knee in it can stand — and the lead leg at the
  // mound's own span between the plants (see the note above: 0.93 is its own 0.051 of a
  // unit of fall through a 0.8546 limb, and it may not be met by a foot hovering over
  // the dirt; see the ground tests, which hold both shoes *on* it).
  expect(
    chordAt(1.68, 1),
    `the drive leg lands ${((1 - chordAt(1.68, 1)) * 100).toFixed(2)} per cent short of its own length: the knee is folded under the landing`,
  ).toBeGreaterThan(0.995)
  expect(
    chordAt(1.68, -1),
    `the lead leg lands ${((1 - chordAt(1.68, -1)) * 100).toFixed(2)} per cent short of its own length: the mound's own fall between the two plants is more than it carries`,
  ).toBeGreaterThan(0.93)
  // ...and the weight that arrives on it does not fold it: the half second after the foot
  // is down is the pose rather than the settle — each knee within a degree of the frame
  // the foot landed in, and the pelvis no lower than it.
  for (const clip of [1.72, 1.76, 1.8, 1.92, 2.0, 2.8]) {
    const moved = bendAt(clip, 1) - bendAt(1.68, 1)
    expect(
      Math.abs(moved),
      `the drive knee moves ${moved.toFixed(2)}° between the landing and ${clip}s: the leg gives under the weight`,
    ).toBeLessThan(1)
  }
  // The *lead* knee is the one thing the landing frame no longer fixes, and it is the
  // other half of the same shape. The pelvis goes on *through* its plant rather than
  // stopping over it (see the sequence's own keys, and the finish's travel), and a hip
  // travelling on past the foot it stands over *lengthens* the chord to that foot — so
  // the lead knee straightens the last of the bend the mound's own fall put in it: 2.9°
  // by 1.72s, 5.4 by 1.76, 7.6 by 1.80 and 11.3 by the frame the pelvis comes to rest on,
  // on a leg that lands at 0.93 of its own length and is asked to hold every degree of it
  // when the body stopped where it landed. What it may not do is the other way: a lead
  // knee that *folded* as the weight arrived is the give this test exists to catch, and
  // one that turned round and folded again would be the landing settling twice. The bound
  // is the 12° that 0.074 of a rig unit of pelvis past the plant is worth to a 0.8546
  // limb, with nothing else spent on it.
  let straightest = 0
  for (const clip of [1.72, 1.76, 1.8, 1.92, 2.0, 2.8]) {
    const moved = bendAt(clip, -1) - bendAt(1.68, -1)
    straightest = Math.min(straightest, moved)
    expect(
      moved,
      `the lead knee folds ${moved.toFixed(2)}° between the landing and ${clip}s: the weight is going through the knee rather than over the foot`,
    ).toBeLessThanOrEqual(0.2)
    expect(
      Math.abs(moved),
      `the lead knee straightens ${Math.abs(moved).toFixed(2)}° by ${clip}s: more than the pelvis' own travel past the plant is worth`,
    ).toBeLessThan(13)
  }
  expect(
    straightest,
    'the lead knee never straightens at all across the finish: the pelvis is not travelling over its plant',
  ).toBeLessThan(-0.5)
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
  // ...and it is the *landing's* plane it keeps, not the plant's: the pelvis goes on over
  // the foot it landed on by 0.074 of a rig unit (see the finish's travel), and a hip
  // travelling past a fixed ankle turns the plane the two bones draw a couple of milli-
  // metres as it goes — 5.4 mm by the frame the pelvis comes to rest on, and nought after
  // it. What the leg may not do is *relax*: a knee that let its plane go slack would move
  // the number by a centimetre and more.
  expect(
    Math.abs(pushAt(1.92) - pushAt(1.68)),
    `the knee's own push off its chord moves ${Math.abs(pushAt(1.92) - pushAt(1.68)).toFixed(3)} rig units once the weight is on the leg: the leg relaxes its landing plane`,
  ).toBeLessThan(0.008)
  // ...on *both* feet, and the two knees' own difference is the mound's rather than the
  // landing's: the slope puts 0.051 of a unit between the two plants and the legs hold
  // it at the same number for the whole hold. What makes the pose he lands in the
  // *stance's* is that the difference is *fixed* — a body that landed one way and
  // settled another is the dip the pelvis test above is hunting, read on the legs.
  const balances = Math.abs(bendAt(2.0) - bendAt(2.0, -1))
  expect(
    balances,
    `the two knees stand ${balances.toFixed(1)}° apart at the finish: the mound puts 0.051 of a unit between the two plants and this is more than that`,
  ).toBeLessThan(45)
  // ...and the spread between them closes by exactly what the lead leg straightens: the
  // drive knee holds its landing bend and the lead one gives up the bend the mound's own
  // fall put in it as the pelvis goes over its plant (11.3° — see the loop above), so the
  // two knees end nearer each other than they landed. Anything past that is the landing
  // still settling on the *drive* leg, which is the thing this test is for.
  const spread = (clip) => Math.abs(bendAt(clip) - bendAt(clip, -1))
  expect(
    Math.abs(spread(2.8) - spread(1.68)),
    `the two knees' own spread moves ${Math.abs(spread(2.8) - spread(1.68)).toFixed(2)}° across the hold: the landing is still settling`,
  ).toBeLessThan(13)
  expect(
    bendAt(2.8),
    'the legs move across the hold',
  ).toBeCloseTo(bendAt(2.0), 3)
  console.log(
    `landing: the drive leg arrives at ${(chordAt(1.68, 1) * 100).toFixed(2)}% of its own length ` +
      `(${bendAt(1.68).toFixed(1)}° of knee) with the lead leg at ${(chordAt(1.68, -1) * 100).toFixed(2)}% ` +
      `(${bendAt(1.68, -1).toFixed(1)}°) · across the ${(2.8 - 1.68).toFixed(1)}s that follow the drive knee moves ` +
      `${Math.max(...[1.72, 1.76, 1.8, 1.92, 2.0, 2.8].map((clip) => Math.abs(bendAt(clip) - bendAt(1.68)))).toFixed(2)}° ` +
      `and the lead knee straightens ${Math.abs(straightest).toFixed(2)}° as the pelvis goes past its plant, ` +
      `and the pelvis never goes below the frame it landed in (the knee's own push off its chord holds at ${pushAt(1.68).toFixed(3)} rig units)`,
  )
})

test('the drive and the turn peak on the ball, and the trunk rips off it', async ({ page }) => {
  // The delivery's own shape, as the speeds it gathers: the pelvis's travel toward the
  // plate and the body's own turn. Both build through the stride and are at their
  // *fastest frame* within one of the frame the ball leaves on, and both are slower
  // afterwards than they were into it — the windup is the delivery gathering speed and
  // the follow-through is it spending the speed it gathered. The trunk is the third thing
  // read here, and it is read as both: the fold is a *place* the pitch pins through the
  // ball (see `releasePosture` in util/pitcherSequence.js) and a *speed* it is thrown off
  // that place with — which is what the fine sweep below is for.
  //
  // This is what the earlier authoring got wrong in two ways: the body's fastest turn
  // was a quarter of a second *before* the ball went, with a stall behind the plant
  // between the two snaps (the turn gathered, spent, gathered and spent again), and
  // the pelvis's own travel peaked a fifth of a second late rather than driving the
  // whole way to the release.
  //
  // ...and the read below is what the delivery's *re-timing* is held to: the windup is
  // stretched, the coil is carried *closed* through the plant and the cock, and the
  // whole of the speed is spent in the last two hundredths of a second before the ball
  // — so the two speeds arrive together, each of them at its own fastest frame on the
  // ball. The build is spread across the quarter second before it rather than gathered
  // into the first of its frames (the shoulders' own turn — the chest's clock read on the
  // pose, five-millisecond windows — is a ramp of 580, 329, 562 and 990°/s across the
  // break, the plant, the cock and the come-through key, and 1432 on the ball's own frame,
  // and the dip in the middle of that ramp is the coil *deepening* as the pelvis runs on
  // under the shoulders), and the peak it arrives at is a good deal faster than the gentler
  // delivery's: the turn better than a thousand degrees a second where that one turned
  // six hundred, and the travel over its own last frames a twelve-rig-unit lunge the
  // hips make into the plant rather than a push they ride into it. What that buys is a *shape*: the
  // stride's own turn is where the pelvis spends most of its wind-up, and the release
  // is where the whole chain's speed lands, so the ball goes off a body that has just
  // snapped rather than one that snapped and is now holding on.
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
  //
  // What the trunk does with that speed is the contract this test was re-authored for,
  // because it is no longer the place the pitch pins. The lean is still the release
  // posture's on the frame the ball goes — its value there is the posture's to the decimal
  // (see FINISH_RIP_LEAD) — but it is not *at rest* on the release's own frames: the trunk
  // gathers the last degree or two off the posture across the two hundredths of a second
  // before the ball and is handed to the rip on them, so the frame the ball goes is
  // carrying the whip's own rate. Measured on the pose: the posture's own 15.4° at 1.300,
  // 13.05° at 1.3125 (the gather's floor, 2.4° under it), 15.45° again at 1.320 with 922°/s
  // on it, 1160 on the frame after it and 26.0° by 1.330 — where ending the fold's own clock
  // at the come-through left those frames at rest (15.4° flat from 1.30 to 1.32, nought
  // degrees a second) with the rip beginning behind them. Read on the 5 ms sweep below, the
  // rip's fastest frame is still the first one after the ball (875°/s against the 692 the
  // cubic's shape left there), 246 the one a twenty-fifth of a second later and 86 on the
  // 1.40 frame — a tenth of the rip's own peak, which is what "the deceleration is not
  // front-loaded" is a number for, and the same distance spent the other way round: the
  // cubic was still carrying 179°/s on the pose at 1.40 and had crept to nought by 1.50,
  // where this one is at 17 there and reaches nought on the crossing. What it costs is the
  // middle and it is 10 per cent of it: the pose reads 161°/s at 1.40 against the cubic's
  // 179 with the fold itself never more than two fifths of a degree off it (52.7° against
  // 53.1°). Written as the smoothstep the fold's own schedule used to be, the rate peaked a
  // third of the way across the sweep with both ends at rest, so the trunk came to rest on
  // the ball and folded a second time behind it — the one shape a throw does not have.
  //
  // ...and the *turn* is the second of the three, read on the same sweep: the chest comes
  // round through the ball and the ball is the fastest frame of it. That is a clock of its
  // own rather than the keys' (see TURN_GATHER_LEAD): a monotone curve through keys has no
  // crest on one — its rate is a quadratic on each span, and the spans either side of the
  // release put that crest a hundredth *early* (measured on the pose before the clock: 990
  // on the come-through's own window, **1187 at 1.310** and 1174 at 1.315 — a monotone
  // curve's crest sits inside a span — then **863 on the ball**, 910 and 706 behind it, so
  // the trunk braked *into* the release and set off again behind it) — so the last two
  // hundredths gather the chest a degree or two back off the track and hand it over *on*
  // the ball: 990 on the come-through's window, 712 and 871 through the dip and its return,
  // 1111, and **1432 on the release's own frame**, then 910 — a third of it gone in a
  // fortieth of a second — 706 the next, 447 by 1.345, the low of the carry, before the
  // finish's own key turns it up again. Read on the realised skeleton, which is where the
  // claim below is made: **1275°/s on the ball**, its own fastest frame, against 934 and
  // 991 on the two frames before it and 779 on the one after — where the keys' own track,
  // read the same way, ran 1052 and 1047 on 1.310 and 1.315 *before* the clock and **767
  // on the ball**: the turn crested a frame early and braked into the release, which is the
  // shape the clock answers.
  // So what the retime changed is not only that the trunk no longer begins to slow *into*
  // the ball; the turn's fastest frame is now the frame the ball goes, which is the one
  // shape a whip has — the body is handed the ball rather than having handed it over.
  // The window's own chest key at 1.40 still turns the shoulder line a radian of yaw past
  // the release's, and the carry behind the ball is what that buys: six hundredths after it
  // the trunk is at 858°/s, better than two thirds of the release's own rate, and is cut to
  // a sixteenth of *that* by 1.415 (51°/s — the key's own brake, two frames wide).
  const frames = await sweepWindow(page, 1.0, 1.74, 0.02)
  expect(frames.length, 'the drive window should be swept whole').toBeGreaterThan(30)
  // ...and the release window on a finer grid, because both of the retime's own readings
  // are shorter than the coarse sweep's twentieth of a second: the fold's rip is a frame
  // and the turn's cut happens in two.
  const fine = await sweepWindow(page, 1.28, 1.44, 0.005)
  expect(fine.length, 'the release window should be swept for the rip').toBeGreaterThan(20)
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
  // ...and the lean's own *rate*, on both grids: the coarse one for the stand (a movement
  // that lasts the beat) and the fine one for the rip (a movement that lasts a frame —
  // see the fold's own paragraph below).
  const leanRate = rate(trunkLean)
  const fineFold = fine.map(trunkLean)
  // (a rate from *degrees* per sample into degrees a second, so the lean — which `trunkLean`
  // already answers in degrees — is not converted twice)
  const fineRate = (values) => values.map((value, index) => (
    index === 0 ? 0 : (value - values[index - 1]) / (fine[index].clip - fine[index - 1].clip)
  ))
  const fineLeanRate = fineRate(fineFold)
  const fineSpin = fineRate(fine.map((frame) => frame.torso.yaw * DEG))
  // The fine readings are asked for at times the coarse grid does not have, so the nearest
  // sample is the one read rather than the exact frame.
  const near = (values, clip) => values[fine.reduce(
    (best, frame, index) => (Math.abs(frame.clip - clip) < Math.abs(fine[best].clip - clip) ? index : best),
    0,
  )]
  const fastest = (values) => values.indexOf(Math.max(...values.slice(1)))
  const peakOf = (index) => frames[index].clip
  // The two speeds the windup really gathers: the pelvis's own travel and the body's
  // own turn, each at its fastest frame within a frame of the release, which is the
  // promise the whole windup's authoring is shaped for.
  for (const [name, values] of [['the pelvis\'s travel', drive], ['the body\'s turn', spin]]) {
    expect(
      peakOf(fastest(values)),
      `${name} is fastest at ${peakOf(fastest(values))}s rather than the release`,
    ).toBeGreaterThan(RELEASE - 0.021)
    expect(peakOf(fastest(values))).toBeLessThan(RELEASE + 0.021)
  }
  // (Both of the suite's grids hold it, and it takes two moves because they are two
  // different questions. A twentieth-of-a-second window is wider than the crest is, so on
  // *that* grid the reading is the windows' own values rather than a shape: the window
  // ending on the come-through carries the whole of the run-up into it, and the chest the
  // come-through's key holds is a fiftieth of a radian deeper for exactly this (see the
  // key's own note, and its trail is 32° on the hips for it) — which takes 57°/s off that
  // window and puts it on the release's. Measured on the realised sweep: 916°/s on the
  // release's window against 865 on the one ending at 1.30, where before the key was
  // deepened it read 875 against 865 the other way round.
  // The fine grid below is the *crest's* question rather than the values', and that one is
  // the clock's: a window narrower than the crest resolves it, and the peak lands on the
  // ball. Both are asserted, the coarse one first.)
  expect(
    fastest(spin),
    `on the 20 ms grid the turn is fastest at ${peakOf(fastest(spin))}s rather than the release's own window: the coarse grid is a value's question, and the come-through's key is what answers it`,
  ).toBe(RELEASE_AT)
  // ...and the turn's brake is *behind* the ball rather than in front of it: read on the
  // fine sweep as the peak, the frame it lands on, what is left of it six hundredths
  // later, and the two hundredths it is cut down in. The peak's own frame is the strong
  // reading of the clock's contract — the fastest frame of the turn is the ball's, on the
  // sweep's own grid, with the frames either side of it slower — and the two ratios are
  // what "behind" and "abrupt" mean: the trunk is still turning at better than eight
  // hundred degrees a second a fortieth of a second before it is down to fifty.
  const turnPeak = Math.max(...fineSpin)
  // The sample the release's own frame is, read off the grid rather than by equality: a
  // sweep's clocks are sums of its own step, so 1.32 comes back as 1.3199999999999992.
  const onTheBall = fine.reduce(
    (best, frame, index) => (Math.abs(frame.clip - RELEASE) < Math.abs(fine[best].clip - RELEASE) ? index : best),
    0,
  )
  expect(
    fastest(fineSpin),
    `the turn is fastest at ${fine[fastest(fineSpin)].clip}s rather than on the ball: the chest's own gather hands the last of it over on the release's frame`,
  ).toBe(onTheBall)
  const turnHeld = near(fineSpin, RELEASE + 0.06)
  expect(
    turnHeld / turnPeak,
    `the turn is down to ${((turnHeld / turnPeak) * 100).toFixed(0)} per cent of its peak six hundredths after the ball: it is braking into the release`,
  ).toBeGreaterThan(0.6)
  expect(
    near(fineSpin, RELEASE + 0.095) / turnHeld,
    `the turn is still at ${((near(fineSpin, RELEASE + 0.095) / turnHeld) * 100).toFixed(0)} per cent of its post-ball rate a hundredth of a second later: the brake is not abrupt`,
  ).toBeLessThan(0.2)
  // The lean is a place: the pitch's own fold, held through the window — from the frame
  // it arrives on to the release — and come back up out of over the follow-through.
  // Read against the pose the driver was handed: the frame's lean is the fold the
  // sequence asked for — the slot's own solved posture, not the authored key's.
  //
  // It arrives on the come-through rather than on the high cock, and that is the PS-8
  // arch: the trunk is still bowed *back* at the top of the cock, which is what lets the
  // forearm lie straight back under a shoulder line that has tipped back with it, and the
  // fold comes over the foot across the whole of the whip (see FOLD_ARRIVE — the fold is
  // handed from the plant's own arch to the pitch's posture over the six hundredths of a
  // second between 1.24 and 1.30, so the body the arm unwinds off is over the hips it is
  // throwing from by the release rather than by the top of the cock). Both ends of that
  // are read here: the fold is the pitch's own from the come-through through the ball,
  // and the cock is still standing up out of it.
  const posture = (await openAt(page, RELEASE)).pose.hip.fold * DEG
  expect(
    fold[RELEASE_AT],
    `the trunk leans ${fold[RELEASE_AT].toFixed(1)}° at the release rather than the pitch's own ${posture.toFixed(1)}°`,
  ).toBeCloseTo(posture, 0)
  expect(
    Math.abs(fold[RELEASE_AT] - fold[indexOf(1.30)]),
    `the trunk does not hold the pitch's own lean from the come-through: ${fold[indexOf(1.30)].toFixed(1)}° there against ${fold[RELEASE_AT].toFixed(1)}° at the release`,
  ).toBeLessThan(0.6)
  expect(
    fold[RELEASE_AT] - fold[indexOf(1.26)],
    `the trunk is already folded ${fold[indexOf(1.26)].toFixed(1)}° at the cock: the arch PS-8 carries is gone`,
  ).toBeGreaterThan(8)
  // ...and the *follow-through* goes on over the foot: the finish is the delivery's
  // deepest fold, and it is deepest on the frame the back foot sweeps across the line on
  // (see the sequence's FINISH_STAND_FROM and FINISH_FOLD — 60.2° over the hips at the
  // plate against the release's own 32°), which is the body's own momentum spent rather
  // than stopped on the frame the ball goes. Read at the top rather than at the landing:
  // the stand begins on that frame, so the frame the body lands on is already a third of
  // the way back up out of the fold (measured, 33.7°) — reading the depth there asks the
  // fold to still be deepening after it has begun to come off, which is the shape this
  // finish was re-authored out of.
  const top = fastest(fold)
  expect(
    peakOf(top),
    `the trunk's deepest frame is ${peakOf(top)}s rather than the crossing: the finish is still folding after it has begun to stand up`,
  ).toBeGreaterThan(1.51)
  expect(peakOf(top)).toBeLessThan(1.551)
  expect(
    fold[top] - fold[RELEASE_AT],
    `the trunk is only ${(fold[top] - fold[RELEASE_AT]).toFixed(1)}° deeper at the top of the finish than at the release: the follow-through is not folding over the foot`,
  ).toBeGreaterThan(15)
  // ...and the rip itself: the fold is *thrown* off the posture it holds on the ball. Read
  // past the ball only — the lean's own fastest frame of the whole delivery is the arrive's
  // fall out of the arch (909°/s at 1.28, which is the whip's movement rather than the
  // follow-through's), and the claim here is about the one that launches the trunk over the
  // plant. The shape the front-loaded schedule buys is at the top of this block: the fastest
  // frame is the first one after the ball, and every frame after it is slower.
  // (the first sample the ball is behind is the one 5 ms past it — its rate is the movement
  // across (1.320, 1.325], which is the first frame the trunk has after the ball)
  const afterBall = fine.findIndex((frame) => frame.clip > RELEASE + 0.0025)
  expect(afterBall, 'the release window should run past the release').toBeGreaterThan(0)
  const rip = fineLeanRate.slice(afterBall)
  const ripPeak = Math.max(...rip)
  expect(
    ripPeak,
    `the follow-through's fold only reaches ${ripPeak.toFixed(0)}°/s: the trunk is easing off the release rather than being thrown off it`,
  ).toBeGreaterThan(600)
  expect(
    rip.indexOf(ripPeak),
    `the fold's fastest frame after the ball is ${fine[afterBall + rip.indexOf(ripPeak)].clip.toFixed(3)}s rather than the first one (${fine[afterBall].clip.toFixed(3)}s): the rip is being eased in`,
  ).toBe(0)
  expect(
    rip.every((value, index) => index === 0 || value < rip[index - 1]),
    "the fold's rip is not slowing on every frame after the ball: it is not a deceleration",
  ).toBe(true)
  expect(
    near(fineLeanRate, 1.40),
    `the fold still has ${near(fineLeanRate, 1.40).toFixed(0)}°/s at 1.40s against the rip's ${ripPeak.toFixed(0)}: the deceleration is not front-loaded`,
  ).toBeLessThan(0.2 * ripPeak)
  // And the follow-through spends what the windup gathered: each of the delivery's own
  // speeds is slower a fifth of a second later, and slower again by the finish, rather
  // than holding its speed or picking it back up. The lean is the one that has
  // *reversed* by then: the trunk is coming back up out of the fold it has been held in
  // (see the fold above) — a fifth of a second later than the speeds above, because the
  // pitch's own posture holds it through the ball.
  const speedAt = (values, clip) => values[indexOf(clip)]
  // The lean is the one the finish *adds* to, and it is the one that turns over first: the
  // trunk comes over the front foot with the whip and tops out on the frame the back foot
  // sweeps across the line on (see the sequence's FINISH_STAND_FROM), so by 1.6 s it is
  // already coming back up out of the fold it was thrown into — a fifth of a second before
  // the shoe it was thrown off is down. Read here as a rate rather than as a place, and
  // read on both sides of the top: still folding at 1.5 s, standing up at 1.6.
  expect(
    speedAt(leanRate, 1.5),
    `the trunk is already coming back up at 1.5s: ${speedAt(leanRate, 1.5).toFixed(0)}°/s`,
  ).toBeGreaterThan(0)
  expect(
    speedAt(leanRate, 1.6),
    `the trunk is still folding at 1.6s: ${speedAt(leanRate, 1.6).toFixed(0)}°/s`,
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
  // ...and that the travel is still *in hand* a fifth of a second later is the other
  // half of the same promise: a delivery that has spent its forward motion by then has
  // stopped on the foot it planted on, while this one goes on over ground its own swing
  // bought it — the drive leg lands past the lead foot's plant (see the swing above),
  // so the hips have that much further to go and go it later. Read as a *rate* rather
  // than as a share of the release's own: the release's travel is a lunge into the
  // plant now (12 rig/s over two hundredths of a second), and a share of a lunge is a
  // smaller number than a share of a push was.
  //
  // This used to be read as the 1.52 frame's own rate against 1.4 rig/s, and the bound is
  // not reachable on this stance: the lead leg's own reach is the wall — past about 0.06 of
  // a unit further on, the solve straightens the lead knee on the landing frame against the
  // bend its own key asks for (40° dropping to 29° between two frames). The finish also
  // stands the body up from the crossing now (see FINISH_STAND_FROM), so the carry is a
  // little over half the rate it was when the bound was written: the 1.52 frame reads 0.99
  // rig/s against the 1.2 that paragraph recorded. Read on every frame from 1.52 to the
  // landing instead, and as the ground it covers: it never stops (0.30 rig/s is the slowest
  // frame), and it carries the pelvis 0.14 of a unit — the last third of the rig unit the
  // swing left it to make.
  const carry = [1.52, 1.54, 1.56, 1.58, 1.6, 1.62, 1.64, 1.66].map((clip) => speedAt(drive, clip))
  expect(
    Math.min(...carry),
    `the pelvis is down to ${Math.min(...carry).toFixed(2)} rig/s inside the follow-through: it has stopped on the foot it planted on`,
  ).toBeGreaterThan(0.2)
  const carried = at(indexOf(1.52)).torso.base[2] - at(indexOf(1.68)).torso.base[2]
  expect(
    carried,
    `the pelvis only carries ${carried.toFixed(2)} of a rig unit over the follow-through: it has stopped on the foot it planted on`,
  ).toBeGreaterThan(0.09)
  // And the body has *arrived* on the plant by the time the ball has gone: the pelvis is a
  // hand's width behind the lead foot's own line on the release frame and level with it by
  // 1.40, and a third of a rig unit past it by the finish, which is the weight going on
  // through the throw. Read at the release, as this assertion used to ask, the plant's line
  // is crossed a fortieth of a second *after* the ball: the 1.32 key's own `drive` is 1.00
  // and the 1.40's is 1.133, so the last 0.14 of the unit is carried across the stretch the
  // stand begins in rather than arriving on the frame the ball goes. What the earlier
  // authoring did with the same step was peak its travel *at* the plant: the foot landed a
  // fifth of a second before the body, and the release was spent catching up with a step
  // instead of coming through it — this one is still coming through the ball.
  const planted = frames.map((frame) => frame.legs.find((leg) => leg.side === -1).ankle[2])
  const travel = (clip) => at(indexOf(clip)).torso.base[2]
  const behind = travel(RELEASE) - planted[RELEASE_AT]
  expect(
    behind,
    `the pelvis is ${behind.toFixed(3)} rig units behind the lead foot's own line on the release frame: it is a stride short of its own plant`,
  ).toBeLessThan(0.18)
  expect(
    behind,
    'the pelvis is already past the lead foot on the release frame',
  ).toBeGreaterThan(-0.05)
  expect(
    Math.abs(travel(1.40) - planted[RELEASE_AT]),
    `the hips are ${Math.abs(travel(1.40) - planted[RELEASE_AT]).toFixed(3)} rig units off the lead foot's line at 1.40: the plant is never caught`,
  ).toBeLessThan(0.05)
  expect(
    planted[RELEASE_AT] - travel(1.68),
    'the pelvis has not driven past the plant over the follow-through',
  ).toBeGreaterThan(0.25)
  console.log(
    `drive: the pelvis is ${behind.toFixed(2)} rig units behind the lead foot's own line on the ball, level with it by 1.40 ` +
      `and ${(planted[RELEASE_AT] - travel(1.68)).toFixed(2)} past it by the finish · ` +
      `fastest frame of travel ${peakOf(fastest(drive))}s at ${drive[fastest(drive)].toFixed(2)} rig/s and ` +
      `of turn ${peakOf(fastest(spin))}s at ${spin[fastest(spin)].toFixed(0)}°/s on the 20 ms grid, and ${turnPeak.toFixed(0)}°/s on the 5 ms ` +
      `one *on the ball* (${near(fineSpin, RELEASE - 0.005).toFixed(0)} on the frame before it), ` +
      `still ${((turnHeld / turnPeak) * 100).toFixed(0)}% of it sixty milliseconds after the ball and ` +
      `${((near(fineSpin, RELEASE + 0.095) / turnHeld) * 100).toFixed(0)}% of that a hundredth later · ` +
      `the trunk holds ${fold[RELEASE_AT].toFixed(1)}° off plumb on the ball, is deepest at ${peakOf(top)}s ` +
      `(${fold[top].toFixed(1)}°), and its rip is fastest on the first frame after it (${ripPeak.toFixed(0)}°/s, ` +
      `${((near(fineLeanRate, 1.4) / ripPeak) * 100).toFixed(0)}% of it left by 1.40s) · a fifth of a second later the travel is down to ` +
      `${speedAt(drive, 1.52).toFixed(2)} rig/s and the turn to ` +
      `${speedAt(spin, 1.52).toFixed(0)}°/s`,
  )
})

/**
 * How far the throwing upper arm is *ahead* of the chest's own plane, in rig units:
 * the elbow's offset from its own socket along the chest's forward — the normal of
 * the plane the shoulder line draws, which is the plane the torso faces along (see
 * the harness's `torso`). Positive is the elbow out in front of the plane, nought is
 * abreast of it, and negative is the arm laid back behind the body's own coil.
 */
const planeLead = (frame) => dot(
  sub(frame.arm.elbow, frame.arm.shoulder),
  cross(frame.torso.side, frame.torso.up),
)

/**
 * How far the ball is *behind* its own shoulder socket, in rig units: the rig's z is
 * the line the plate is on (the plate is -z), so a positive number is a hand held
 * behind the body and a negative one a hand thrown out past it. This is the reading
 * the delivery's own order is written on — the arm is carried behind the torso for
 * the whole of the wind and the whip, and only the throw puts it in front (see the
 * key's own note, and the reference's PS-11/PS-12).
 */
const behindSocket = (frame) => frame.ballRig[2] - frame.arm.shoulder[2]

/** The forearm's own line, in degrees: how far it rises above level, and how far it
 * points off straight back (+z) toward the throwing side (+x) — nought is straight
 * back at second base, and a positive bearing is off toward third base, which is the
 * side a right-hander's elbow hangs on (see the reference's own layback). */
const forearmLine = (frame) => {
  const d = sub(frame.arm.wrist, frame.arm.elbow)
  const length = Math.hypot(...d) || 1
  return {
    rise: (Math.asin(d[1] / length) * 180) / Math.PI,
    bearing: (Math.atan2(d[0], d[2]) * 180) / Math.PI,
  }
}

test('the torso pulls the throwing arm through the throw, and the arm is past it by the release', async ({ page }) => {
  // The delivery's own order, read off the realised skeleton rather than off the pose: the
  // arm is carried *behind the body* for the whole of the wind and the whip, and only the
  // throw puts it in front. That is the reading the arm's own place is written on, and it
  // is the one a viewer gets from any angle: a delivery that swings the arm out beside the
  // chest and holds it there reads as an arm throwing a body, whatever the ball's own path
  // is doing behind it.
  //
  // What it is *not* is the elbow's offset along the chest's own forward (the `planeLead`
  // below). That reading turns with the chest: through the layback the chest is closed over
  // its hips, so the elbow swung out to the throwing side — which is what puts the forearm
  // straight back behind the shoulder (see the cock's own note) — stands a quarter of a rig
  // unit *ahead* of a plane facing out at third base, without the arm being anywhere near
  // the front of the body. Read that way, the old test demanded the arm be ahead of the
  // plane through the whole of the cock, which is the shape this is thrown against.
  //
  // So the readings are the arm's own two: the ball's place behind its own socket (the arm
  // carried behind the torso), and the forearm's line (the layback the cock is drawn back
  // to). The plane is kept for the one thing it does say — the arm is past it by the
  // release, and stays past it over the wash.
  const frames = await sweepWindow(page, 1.16, 1.44, 1 / 120)
  // The sweep's own step is a frame of a hundred-and-twentieth, so a clip is read by the
  // frame *on* it rather than by the nearest one: a tolerance of half a frame's own time
  // (see the sweep's step) is what keeps a reading from taking the frame before it.
  const row = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 1 / 240)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const behind = (clip) => behindSocket(row(clip))
  // The ball is behind its own shoulder socket from the plant, through the cock, and for
  // as long as the whip is loading — the arm is drawn back over the drive leg rather than
  // swung out round the chest.
  expect(behind(1.18), `the ball is only ${behind(1.18).toFixed(2)} of a rig unit behind its socket at 1.18s`).toBeGreaterThan(0.3)
  expect(behind(1.22), `the ball is only ${behind(1.22).toFixed(2)} of a rig unit behind its socket at 1.22s`).toBeGreaterThan(0.35)
  expect(behind(1.26), `the ball is only ${behind(1.26).toFixed(2)} of a rig unit behind its socket at the cock`).toBeGreaterThan(0.4)
  expect(behind(1.28), `the ball is only ${behind(1.28).toFixed(2)} of a rig unit behind its socket at 1.28s`).toBeGreaterThan(0.25)
  // ...and it is only the throw that carries it past: on the release's own frame the hand
  // is out in front of the shoulder it hangs from, which is the crossing the ball's own
  // line to the plate is drawn on.
  expect(behind(RELEASE), `the hand is ${behind(RELEASE).toFixed(2)} of a rig unit behind its socket at the release: the arm never comes through`).toBeLessThan(-0.1)
  // The layback's own two readings, on the frames it is held over: the forearm laid level
  // behind the shoulder with its elbow out on the throwing side — the reference's PS-7 and
  // PS-8, and the shape the whole throw is loaded from (see the cock's own note). Level is
  // the middle of the band; the arm is not asked to be a plumb line.
  //
  // The hold's own two frames are the cock and the one behind it: past 1.27 the whip has
  // begun — the ball is on its way to the plate and the arm is coming open — so what 1.28
  // is asked for is only that the forearm is still pointing *behind the body* rather than
  // round it (the bearing stays inside the angle the throwing side makes).
  for (const clip of [1.26, 1.27]) {
    const line = forearmLine(row(clip))
    expect(
      Math.abs(line.rise),
      `the forearm is ${line.rise.toFixed(0)}° off level at ${clip}s: the elbow is not letting the upper arm lay it back`,
    ).toBeLessThan(30)
    expect(
      Math.abs(line.bearing),
      `the forearm points ${line.bearing.toFixed(0)}° off straight back at ${clip}s: it is swinging round the body rather than laying behind it`,
    ).toBeLessThan(20)
  }
  expect(
    Math.abs(forearmLine(row(1.28)).bearing),
    `the forearm has come ${forearmLine(row(1.28)).bearing.toFixed(0)}° round the body by 1.28s: the whip has begun before the arm was unloaded`,
  ).toBeLessThan(35)
  // ...and the layback is *reached* by the upper arm coming out and up under it: the elbow
  // hangs below its own socket through the lift and comes up level with it by the cock,
  // which is what "the elbow stays relaxed and the upper arm pulls the forearm back" is.
  //
  // Read at 1.2325 s rather than at 1.20: the upper arm is *hesitating* at 1.178-1.202 s (its
  // three frames stood parallel to the ground, see the swivel's window), and the drop that
  // hangs the elbow under the socket is walked on the turn's own travel rather than on its own
  // clock — it creeps out of the hold and reaches its fifty degrees at half the turn, 1.2325 s
  // (measured 47.5° there, against 18° at 1.215 s), so the reading is taken once it is there.
  const elbowRise = (clip) => row(clip).arm.elbow[1] - row(clip).arm.shoulder[1]
  expect(elbowRise(1.2325), `the elbow is ${elbowRise(1.2325).toFixed(2)} of a rig unit above its socket at 1.2325s: it is not hanging under the arm`).toBeLessThan(-0.2)
  expect(Math.abs(elbowRise(1.26)), `the elbow stands ${elbowRise(1.26).toFixed(2)} of a rig unit off its socket's level at the cock`).toBeLessThan(0.15)
  // The plane is kept for the one thing it says: the chest comes round under the arm, so
  // the arm is past the plane it laid back on by the release and stays past it over the
  // wash.
  expect(planeLead(row(1.34)), 'the arm is not past the chest by the release').toBeGreaterThan(0.05)
  expect(planeLead(row(1.40)), 'the arm does not stay past the chest over the follow-through').toBeGreaterThan(0.0)
  // ...and the *forearm overtakes the upper arm* through the throw, which is the other half
  // of its shape and is read at the elbow itself: the arm is drawn back *folded* at the cock
  // — the forearm laid back on a right angle — and is extended through the ball, so what the
  // frames between the two do is the forearm sweeping past the upper arm (measured on the
  // realised skeleton: 90° at the cock, the ask's chord from the come-through, and 174.87° at
  // the frame the ball goes).
  const bentAt = (clip) => elbowAngle(row(clip).arm)
  expect(bentAt(1.26), `the cock's elbow is only ${bentAt(1.26).toFixed(0)}° folded`).toBeLessThan(120)
  // ...and the arm the release leaves is *held* on it, rather than folding on the frame
  // after the ball: the window between the release and the upper arm's crossing of the
  // torso's own centre line is authored as one straight arm (see the keys' own note,
  // and the arm test below, which reads the chord), so what the frames after the throw
  // do is go on past the extension it threw on instead of breaking it. Measured: 172.4°
  // at 1.34s, against the 174.87° it throws on.
  expect(
    bentAt(1.34),
    `the elbow is ${bentAt(1.34).toFixed(1)}° at 1.34s: the arm folds on the frame after the ball instead of staying on it`,
  ).toBeGreaterThan(165)
  console.log(
    `trail: the ball is ${behind(1.18).toFixed(2)} of a rig unit behind its socket at the plant, `
    + `${behind(1.26).toFixed(2)} at the cock and ${behind(1.28).toFixed(2)} at 1.28s, and is `
    + `${(-behind(RELEASE)).toFixed(2)} out past it at the release · the forearm lies `
    + `${forearmLine(row(1.26)).rise.toFixed(0)}° off level and `
    + `${forearmLine(row(1.26)).bearing.toFixed(0)}° off straight back at the cock`,
  )
})

test('the throwing upper arm never gets above the plane the shoulders draw, in either slot', async ({ page }) => {
  // The one reading a low slot makes obvious: at the cock the pitching arm should be
  // carried *level with* its socket at the highest, never lifted above the line the
  // two sockets make across the back — so the higher the shoulders the flatter a
  // submarine arm has to lie, and the harness pitch can only ever touch that line.
  // Read on the transverse plane, through the windup, the cock and the come-through —
  // which is where it ends, on the frame *before* the come-through's own key: what the
  // chest does across the last two hundredths of a second is turn out from under the arm
  // (see the trail test), and an elbow left behind a chest folded thirty-odd degrees is
  // above that chest's plane by geometry — its own drag times the fold's sine — without
  // the arm being lifted at all (measured: 0.10 of a span at 1.30s on the 3/4 pitch,
  // against 0.21 of drag). Holding the cap through it is what flattens that drag, so the
  // reading stops on the last frame the chest is still closed over the arm.
  //
  // The frames it is allowed above that line are the hesitation's, because the upper arm
  // is carried *parallel to the ground* there rather than level with the shoulders: the
  // trunk is laid back through the layback, so its own transverse plane is tilted some
  // twenty degrees and a horizontal humerus stands a tenth of a rig unit above it. That is
  // the pose the delivery asks for (see the swivel's window), and since the lift was
  // retimed — level at 1.175 s and held to 1.217, where it used to arrive on 1.183 and be
  // taken over a couple of frames later — the arm is stood on it for the deepest of the
  // layback rather than the top of it, so the exception's own reading grows with the
  // ground the hold covers: measured 0.097 of a rig unit on the 3/4 pitch (at 1.183 s) and
  // 0.105 on the submarine slot (at 1.221 s), the humerus level to within four degrees of
  // the world's own horizontal on both. The cap is set a hundredth past that — eleven
  // hundredths — and every other frame still has to sit at or under the line the sockets
  // draw.
  const cases = [
    { label: 'the 3/4 harness pitch', query: '' },
    { label: 'a submarine slot', query: '&up=1.30&out=16.46' },
  ]
  for (const { label, query } of cases) {
    await page.goto(`${HARNESS}?clip=1.00${query}`)
    await page.waitForFunction(() => window.__vr?.ready === true, { timeout: 30000 })
    const frames = await page.evaluate(async () => {
      const sweep = await window.__vr.sweep(1.00, 1.29, 1 / 120)
      return sweep.map((frame) => {
        const arm = frame.arms.find((entry) => entry.side === 'R')
        const [sx, sy, sz] = frame.torso.side
        const [ux, uy, uz] = frame.torso.up
        const right = [sy * uz - sz * uy, sz * ux - sx * uz, sx * uy - sy * ux]
        const off = arm.elbow.map((v, i) => v - arm.shoulder[i])
        return {
          clip: frame.clip,
          above: off[0] * ux + off[1] * uy + off[2] * uz,
          span: Math.hypot(...off),
          right: off[0] * right[0] + off[1] * right[1] + off[2] * right[2],
        }
      })
    })
    const worst = frames.reduce((a, b) => (b.above > a.above ? b : a))
    const atCock = frames.reduce((a, b) => (Math.abs(b.clip - 1.26) < Math.abs(a.clip - 1.26) ? b : a))
    expect(
      worst.above,
      `${label}: the upper arm rises ${worst.above.toFixed(2)} of a rig unit above its socket, `
      + `at ${worst.clip.toFixed(2)}s`,
    ).toBeLessThanOrEqual(0.11)
    // and the level it does reach is the arm carried out to the side, not hanging under
    // its own socket — which is what reads as a layback in a slot this low.
    expect(atCock.right).toBeGreaterThan(atCock.span * 0.5)
    console.log(
      `${label}: the upper arm tops out ${worst.above.toFixed(2)} of a rig unit above its socket `
      + `(at ${worst.clip.toFixed(2)}s) and stands ${atCock.right.toFixed(2)} of ${atCock.span.toFixed(2)} `
      + 'out along the shoulders at the cock',
    )
  }
})

test('the throwing arm lets the throw go straight, crosses the body, and folds about the elbow it holds', async ({ page }) => {
  // What the arm does once the pitch is over, off the realised skeleton, and the whole
  // of it is one request: the throwing arm stays *straight* out of the release until
  // the upper arm has carried it across the plate's own line, and from there the upper
  // arm travels on to its own final spot — down the side of the chest — and is *held*
  // there while the forearm swings about the elbow like a pendulum: strictly toward the
  // glove side, decelerating as it goes, to a rest with the forearm level and the wrist
  // carried across the torso's own centre line — and then the arm pauses there before
  // the recovery takes it down to his side.
  //
  // The straight half is a promise about the *driver's* own socket rather than the
  // pose's, which is what makes it worth reading here: the pose writes a ball off the
  // socket it estimates and the driver hangs the arm off the socket its body really
  // has, and the two stand five to eleven centimetres apart on the frames right after a
  // throw — which a folded arm forgives and a straight one cannot (measured before the
  // window's keys were solved this way: 0.93 of the span at 1.36s and 0.82 at 1.40s,
  // elbows 135° and 111°). The chord below is the wrist's own distance from its socket
  // as a share of the arm's span, because that is the number an elbow is — a chord at
  // the span is a straight arm, and every centimetre inside it is a fold the driver
  // made to hold a wrist that was handed to it too close.
  const frames = await sweepWindow(page, 1.28, 2.0, 1 / 120)
  // The sweep's own step is a frame of a hundred-and-twentieth, and a clip is read by
  // the frame nearest it (see the sweep's step): what the numbers below are read off.
  const at = (clip) => frames.reduce(
    (best, row) => (Math.abs(row.clip - clip) < Math.abs(best.clip - clip) ? row : best),
    frames[0],
  )
  const chord = (frame) => Math.hypot(
    ...frame.arm.wrist.map((v, axis) => v - frame.arm.shoulder[axis]),
  ) / frame.arm.reach
  // The straight half: the release frame goes on its own chord, and no frame of the
  // window is more than a whisker inside it. The window opens *just before* the release
  // rather than at 1.30s, because the reference's own layback lock holds the elbow at
  // its 90° right up to the release — the arm is still folded across the come-through
  // and only straightens *into* the release (the whip) — so the straight half is the
  // crossing itself, from just before the ball goes. The floor of the run is the reading
  // rather than the keys' own numbers, because the keys are a twentieth of a second
  // apart through the middle of the sweep and the interpolator's path between two
  // places cuts inside the circle the socket draws — and the whip's own first frame is
  // still opening the arm off its fold, so the window's floor stands at that frame:
  // measured 0.978 of the span at its worst (a 156° elbow, the first frame of the
  // window at 1.31s) against the keys' own 0.99 to 1.01. That frame is the one still
  // unwinding off the layback lock, so the two bounds below are held a clear margin
  // under the whip rather than on it — the millimetres between the pose's socket
  // estimate and the driver's real one wobble a degree or two frame to frame, and a
  // bound set on the whip's own number reads green alone and red in a full run.
  const straight = frames.filter((row) => row.clip >= 1.31 && row.clip <= 1.48)
  expect(
    chord(at(RELEASE)),
    `the release frame reads ${chord(at(RELEASE)).toFixed(3)} of the span, which is not the throw's own chord`,
  ).toBeGreaterThan(0.99)
  const floor = straight.reduce((worst, row) => (chord(row) < chord(worst) ? row : worst))
  expect(
    chord(floor),
    `the window's own chord sags to ${chord(floor).toFixed(3)} of the span at ${floor.clip.toFixed(3)}s, an elbow ${floor.arm.elbowDegrees.toFixed(0)}°: the arm does not stay straight across the body`,
  ).toBeGreaterThan(0.92)
  for (const row of straight) {
    expect(
      row.arm.elbowDegrees,
      `the elbow is only ${row.arm.elbowDegrees.toFixed(1)}° at ${row.clip.toFixed(3)}s: the arm has folded before the crossing`,
    ).toBeGreaterThan(143)
  }
  // ...and the keys themselves hold it: every frame the window is authored on is within
  // a hair of a straight arm.
  for (const clip of [1.32, 1.36, 1.4, 1.42, 1.44, 1.48]) {
    expect(
      at(clip).arm.elbowDegrees,
      `the elbow is ${at(clip).arm.elbowDegrees.toFixed(1)}° at ${clip}s: the throw's own line is not held`,
    ).toBeGreaterThan(165)
  }
  // Where the straight half ends: the upper arm carries the throw across the **plate's
  // own line** — the plane the pitch goes down, which is the rig's own x = 0 — with the
  // elbow still well out on the throwing side at 1.40s, abreast of the line around
  // 1.51s and past it from there on. What the upper arm is asked to point past is the
  // strike zone, and the strike zone stands on the plate's line; the *torso's* own
  // centre line is the wrong landmark for it, which is worth stating because it is the
  // one that suggests itself. The chest turns *under* the arm for the whole of this
  // window — 90.1° to 103.7° of its own yaw — so a reading taken against the line the
  // two sockets draw moves with the turn rather than with the arm: measured, the same
  // elbow stands 0.58 of a rig unit off the sockets' midline at 1.44s and does not
  // reach it until the fold has all but started, which says what the chest did and not
  // where the arm went. The plate's line holds still under all of it, and it is the line
  // the pose's own keys are written across (see the sequence's window notes, and the
  // unit suite, which reads the same landmark).
  const shoulderLine = (frame) => unit(sub(frame.arms[0].shoulder, frame.arms[1].shoulder))
  const across = (frame) => frame.arm.elbow[0]
  expect(
    across(at(1.4)),
    `the elbow has already crossed to ${across(at(1.4)).toFixed(3)} of the plate's own line at 1.40s`,
  ).toBeGreaterThan(0.15)
  expect(
    Math.abs(across(at(1.52))),
    `the elbow stands ${across(at(1.52)).toFixed(3)} off the plate's line at 1.52s, which is not the crossing`,
  ).toBeLessThan(0.06)
  expect(across(at(1.54)), 'the elbow is not past the plate’s line by 1.54s').toBeLessThan(-0.04)
  // ...and from there the upper arm is *held*: the elbow's own direction off its socket
  // barely moves across the whole of the fold and the pause, and the elbow itself stays
  // a few centimetres past the plate's line while it does.
  //
  // The reading is taken in the *trunk's* own frame rather than the rig's, because that
  // is the frame the promise is written in. The pose writes the elbow's own direction
  // off the socket it estimates (see the sequence's arm output, and the unit suite,
  // which holds that direction to a hundredth of a unit through the fold), and the
  // chest the socket rides is *itself* coming round under the arm across this window —
  // its own yaw runs 90.1° to 103.7°, the better part of fourteen degrees, and the
  // sockets go with it. Read in the rig's frame, a perfectly held elbow reads that turn
  // and nothing else: the realised elbow stands 0.50 of a unit from where it was at
  // 1.58s by the landing, which is 29°, against the 0.15 this assertion used to hold it
  // to — an assertion no pose can satisfy, because the number it fails on is the
  // chest's turn. Carried into the chest's frame first, the same frames read 0.08 of a
  // unit (5°) by the middle of the fold and 0.17 (10°) by the landing, and the share of
  // that which is the *arm's* is what the bound below is: the twelve-degree bow the
  // driver spent on the fold before the pose handed it its own girdle budget there (see
  // the sequence's hand-over note) read 0.35 the same way — twice this — with the elbow
  // walked round the ring its two bones draw by a socket a dozen centimetres from the
  // pose's estimate.
  //
  // What the driver's own solve adds on top of that is the swing's far end: it hangs
  // the elbow on the ring the *hand* draws — the forearm's length out from the wrist it
  // is given — so a hand still travelling carries the ring's centre along with it, and
  // the last of the fold's swing (the hand coming up over the joint, which is the shape
  // the request asks for) walks the elbow round by most of the swing's own angle:
  // measured across the fold's last fortieth of a second, 0.27 of a unit, 16°. The
  // promise the *pose* keeps through all of it is the place: the held point on the chest
  // is one number from the hand-over to the pause, to a thousandth of a unit (see the
  // unit suite, which reads it there) — and the two together are what the bound below
  // is set to clear.
  const trunkOf = (frame) => {
    const side = unit(frame.torso.side)
    const up = unit(frame.torso.up)
    return [side, up, unit(cross(side, up))]
  }
  const inTrunk = (direction, frame) => {
    const axes = trunkOf(frame)
    return axes.map((axis) => dot(direction, axis))
  }
  const upper = (frame) => unit(sub(frame.arm.elbow, frame.arm.shoulder))
  // ...from the frame *after* the hand-over: the crossing frame is the one the pose hands
  // the upper arm over on, and the arm's direction is still travelling on it — the
  // realised elbow's own ring centre moves off the throw's line and on to the held pole
  // across it (see the sequence's hand-over note) — so the hold is read from the frame
  // the hand-over is done by, which is the frame the pose's own keys are held from.
  const held = [1.58, 1.62, 1.68, 1.9]
  const travel = (clip, from) => Math.hypot(
    ...sub(inTrunk(upper(at(clip)), at(clip)), inTrunk(upper(at(from)), at(from))),
  )
  // The line the fold settles on, read at the pause: what the upper arm's own drift is
  // measured *off* below (the stop's direction against the settled one), in the trunk's
  // own frame like the travel above.
  const settled = inTrunk(upper(at(1.9)), at(1.9))
  // The upper arm *travels* on through the fold rather than being held at the hand-over:
  // the request's own words are that it goes a little further before it stops, and what
  // the realised skeleton does is that — the socket-to-elbow direction swings the better
  // part of a unit between the hand-over and the pause, all of it the one way (down and
  // in across the chest: its own up in the trunk's frame falls from 0.16 to 0.84), where
  // the line the *pose* holds is a single number from the frame the arm's own travel
  // arrives on (1.745s: the travel is eased out across the swing's first keys, see the unit
  // suite) — and the `held` keys either side of it are read here for what the *elbow* does
  // under a pole the hand goes on carrying.
  // What is held is the *pause*: from there to the end of the hold the same reading moves
  // a twentieth of a unit and no more, which is what makes the recovery a separate
  // movement. The realised line is the driver's own answer to a pole the hand goes on
  // carrying (it hangs the elbow on the ring the *hand* draws — see the note above), so
  // the elbow's own travel is the pose's travel plus what the swing's far end adds.
  expect(
    travel(1.9, 1.58),
    `the upper arm swings only ${travel(1.9, 1.58).toFixed(3)} of a unit from the hand-over to the pause: it has not travelled`,
  ).toBeGreaterThan(0.4)
  for (const clip of [2.0, 2.2]) {
    expect(
      travel(clip, 1.9),
      `the upper arm is still travelling across the hold: ${travel(clip, 1.9).toFixed(3)} of a unit from the pause to ${clip}s`,
    ).toBeLessThan(0.25)
  }
  for (const clip of held) {
    expect(
      across(at(clip)),
      `the held elbow stands ${across(at(clip)).toFixed(3)} across the plate's own line at ${clip}s`,
    ).toBeLessThan(-0.02)
    expect(
      across(at(clip)),
      `the elbow is carried ${(-across(at(clip))).toFixed(3)} past the plate's line at ${clip}s: it is not held there`,
    ).toBeGreaterThan(-0.4)
  }
  // ...while the *forearm* does all of the travelling, and it is the pendulum the request
  // asks for: let off the throw's own line it falls to its own bottom — the hand a fifth
  // of a rig unit under the joint it hangs from — and then comes back *up* the glove side
  // of the body about the elbow it holds, strictly toward it, decelerating as it goes, and
  // what it settles into is a rest: level, with the wrist carried across the torso's own
  // centre line. Every one of those is read here off the realised skeleton rather than off
  // the pose's numbers, because the driver is what hangs the forearm it was handed and the
  // arc is its own answer to a place.
  const fore = (frame) => unit(sub(frame.arm.wrist, frame.arm.elbow))
  const elev = (frame) => Math.asin(Math.max(-1, Math.min(1, fore(frame)[1]))) * DEG
  const rise = (frame) => frame.arm.wrist[1] - frame.arm.elbow[1]
  // The *torso's* own centre line, read off the realised sockets it hangs between: the
  // request's "across the torso's centre line" is written in the body's own frame, and the
  // body's own frame is the line the two shoulders draw — with the throwing arm's side
  // positive, and *not* the plate's own line, which is the crossing's landmark above.
  const midline = (frame) => frame.arms[0].shoulder.map((v, axis) => (v + frame.arms[1].shoulder[axis]) / 2)
  const lateralOf = (place, frame) => dot(sub(place, midline(frame)), shoulderLine(frame))
  // ...the *keys* the swing is written on, and the readings the rest of this block is
  // held to.
  // ...the bottom of the fall: the swing's own lowest frame between the hand-over and the
  // rest, which is where the throw's own line is spent and the pendulum is let go.
  const bottom = frames
    .filter((row) => row.clip >= 1.58 && row.clip <= 1.8)
    .reduce((low, row) => (rise(row) < rise(low) ? row : low))
  expect(
    rise(bottom),
    `the hand only reaches ${rise(bottom).toFixed(3)} of a rig unit under its own elbow at ${bottom.clip.toFixed(3)}s: the forearm has not been let off the throw`,
  ).toBeLessThan(-0.2)
  // ...and from there the swing travels *strictly* toward the glove side: the forearm's
  // own share along the shoulders' line falls at every key the swing is written on — read
  // off the realised forearm (the driver's own elbow and the wrist it placed), not off the
  // pose's numbers, because the driver is what hangs the arm off the socket its body really
  // has. Measured, that share runs -0.45, -0.72, -0.83, -0.90, -0.94, -0.96 and -0.97 of a
  // unit along the body's own midline: the forearm turns from out past the throwing
  // shoulder, through the chest's front, to lying along the shoulders' line itself. (It
  // starts further in than the pose's own hand-over reading because the realised arm is
  // carrying the travel the pose has by 1.68s and the driver has by 1.745s: what is read
  // here is the arm the body really has, not the line the pose promises it.)
  const swing = [1.68, 1.71, 1.745, 1.78, 1.82, 1.86, 1.9]
  const share = (clip) => dot(fore(at(clip)), shoulderLine(at(clip)))
  const shares = swing.map((clip) => share(clip))
  for (let index = 1; index < shares.length; index += 1) {
    expect(
      shares[index],
      `the forearm's own share along the shoulders' line comes back to ${shares[index].toFixed(3)} at ${swing[index]}s from ${shares[index - 1].toFixed(3)}: the swing has turned round`,
    ).toBeLessThan(shares[index - 1])
  }
  // ...and between the keys the realised track never comes back *at all*: the arm sweeps
  // past the trunk on the way across, and the solve keeps it out of the body's own volume —
  // measured through this swing, the worst step back is 0.0000 of a unit on any frame of it
  // (see the log below), against the 0.069 the same reading on the same frames stood at
  // before the arm's own travel was eased out across the swing. That was the driver's own
  // depth correction doing the work: with the arm asked for the whole of its travel in the
  // frame the fall hands it over on, the hand's own sweep stalled where the two met (the
  // *pose's* own lateral step fell to 0.0001 of a unit at 1.70s, see the unit suite) and the
  // solve answered the frames either side of the stop by pushing the forearm back out of the
  // trunk. Eased, there is nothing left for it to answer.
  let back = 0
  let worstAt = bottom.clip
  for (let clip = bottom.clip + 1 / 120; clip <= 2.0 + 1e-9; clip += 1 / 120) {
    const step = share(clip) - share(clip - 1 / 120)
    if (step > back) { back = step; worstAt = clip }
  }
  expect(
    back,
    `the realised track carries the forearm back toward the throwing side by ${back.toFixed(4)} of a unit at ${worstAt.toFixed(2)}s`,
  ).toBeLessThan(0.01)
  // ...and the swing *decelerates* into the rest, which is the other half of the request:
  // the angle the realised forearm turns through between two keys falls through it, and the
  // last step before the rest is the smallest of them — so the swing's own second half
  // (1.78s to 1.9s) turns through well under what its first half does (1.68s to 1.78s) and
  // the arm arrives at the rest rather than running into it.
  const turnBetween = (from, to) => Math.acos(
    Math.max(-1, Math.min(1, dot(fore(at(from)), fore(at(to))))),
  ) * DEG
  const steps = swing.slice(1).map((clip, index) => turnBetween(swing[index], clip))
  expect(
    steps.reduce((sum, turn) => sum + turn, 0) - (steps[0] + steps[1] + steps[2]),
    `the swing turns ${steps.slice(3).reduce((sum, turn) => sum + turn, 0).toFixed(1)}° across its second half against ${steps.slice(0, 3).reduce((sum, turn) => sum + turn, 0).toFixed(1)}° across its first: it is not slowing`,
  ).toBeLessThan(steps.slice(0, 3).reduce((sum, turn) => sum + turn, 0) * 0.75)
  expect(
    steps[steps.length - 1],
    `the swing's own last step before the rest is ${steps[steps.length - 1].toFixed(1)}°, against ${Math.min(...steps.slice(0, -1)).toFixed(1)}° on the smallest of the ones before it`,
  ).toBeLessThan(Math.min(...steps.slice(0, -1)))
  // ...and what it settles into is the rest the request names: the forearm *level* — the
  // world's own elevation of it a few degrees off the horizontal (measured 3.9°, the rest of
  // it being the driver's own socket: the pose asks the forearm nought to a degree, see the
  // unit suite) — the hand within a hand's width of the joint's own height, and the *wrist*
  // carried across the torso's own centre line: 0.12 of a rig unit on the far side of it, so
  // the hand stands across the body's own midline with the palm's own length past it.
  expect(
    Math.abs(elev(at(1.9))),
    `the forearm is ${elev(at(1.9)).toFixed(1)}° at the pause: the swing has not come to rest level`,
  ).toBeLessThan(10)
  expect(
    Math.abs(rise(at(1.9))),
    `the hand stands ${rise(at(1.9)).toFixed(3)} of a rig unit off the joint's own height at the pause`,
  ).toBeLessThan(0.06)
  expect(
    lateralOf(at(1.9).arm.wrist, at(1.9)),
    `the wrist stands ${lateralOf(at(1.9).arm.wrist, at(1.9)).toFixed(3)} across the torso's own centre line: the hand is not across the body`,
  ).toBeLessThan(-0.05)
  // ...and the swing crossed the body rather than swinging through it: the forearm's own
  // share runs the whole way across, from out past the throwing shoulder at the hand-over to
  // lying along the shoulders' line at the rest, and the *wrist* goes with it — its own
  // share along the body's midline falls at every key of the swing too, from just inside the
  // throwing side to the far side of the body, so the hand travels with the forearm rather
  // than the two splitting apart.
  expect(share(1.58), `the forearm is only ${share(1.58).toFixed(3)} out along the shoulders' line at 1.58s`).toBeGreaterThan(0.4)
  expect(share(1.9), `the forearm ends at ${share(1.9).toFixed(3)} on the shoulders' line: it has not come across the body`).toBeLessThan(-0.9)
  // ...and the swing's own arc runs the *hand* up rather than dropping it back down the arm:
  // the wrist's world height climbs at every key from the bottom to the rest — and, being
  // the request's own "no snap", it climbs on *every frame* of the swing rather than on the
  // keys alone: a hand driven by an arm whose own travel stops in one frame is a hand that
  // comes down on the frame after it (measured before the easing: 0.010 of a unit between
  // 1.70s and 1.71s), and no reading taken only at the keys would see it.
  let climbed = bottom.arm.wrist[1]
  for (const clip of swing.filter((clip) => clip > bottom.clip)) {
    const now = at(clip).arm.wrist[1]
    expect(now, `the hand comes back down from ${climbed.toFixed(3)} to ${now.toFixed(3)} at ${clip}s`).toBeGreaterThan(climbed)
    climbed = now
  }
  // ...and the climb is read *off every frame* from the hand-over on, not off the keys: the
  // fall's own descent is what it is (the hand is on its way down to the bottom), and what
  // the request's "no snap" is about is everything after it — from the frame the fall hands
  // the arm over, the hand's own height goes *up* and never once comes back down. A hand
  // driven by an arm whose travel stops in one frame comes down on the frame after it
  // (measured before the easing: 0.010 of a unit between 1.70s and 1.71s), and no reading
  // taken at the keys alone would see it.
  // ...and the one frame of the swing the *body* moves the hand on is the body's own
  // landing: the drive foot's contact settles the pelvis down onto that leg and the hand
  // rides the body with it — measured 0.0053 of a unit across the frame the foot comes
  // down on, against 0.0014 across the whole of the rest of the swing — so the frames
  // either side of the contact are read as the leg's (see the drive leg's own landing
  // below, which reads that contact) and left out of the arm's own reading here.
  const landed = frames.find((row) => row.legs?.some((leg) => leg.side === 1 && leg.planted))
  expect(landed, 'the drive foot should land inside the swing').not.toBeUndefined()
  let dropped = 0
  let droppedAt = 1.66
  const after = frames.filter((row) => row.clip >= 1.66 - 1e-9 && row.clip <= 2.0 + 1e-9)
  for (let index = 1; index < after.length; index += 1) {
    if (
      Math.abs(after[index].clip - landed.clip) < 0.022
      || Math.abs(after[index - 1].clip - landed.clip) < 0.022
    ) continue
    const step = after[index - 1].arm.wrist[1] - after[index].arm.wrist[1]
    if (step > dropped) { dropped = step; droppedAt = after[index].clip }
  }
  // What is left of it is the driver's own solve rather than the keys: measured, the worst
  // frame of the whole swing comes back down by 0.0014 of a rig unit (the one frame the
  // solve has both the fall's own reach and the fold's shorter ask in hand, and the frames
  // where the arm's own travel is quiet and the body's is not), against the 0.010 of a
  // unit the same reading stood at there before the easing — so the bound is three
  // thousandths of a unit, which is a fifth of a hand's width across the whole of it.
  expect(
    dropped,
    `the hand's own height falls by ${dropped.toFixed(4)} of a rig unit in a frame at ${droppedAt.toFixed(3)}s: the swing's own climb is broken`,
  ).toBeLessThan(0.003)
  console.log(
    `swing: the forearm falls to ${rise(bottom).toFixed(3)} of a rig unit under the joint at ${bottom.clip.toFixed(2)}s and swings ` +
      `${shares.map((value) => value.toFixed(2)).join(' -> ')} along the body's own midline ` +
      `(turns ${steps.map((turn) => turn.toFixed(1)).join(', ')}°, worst reversal ${back.toFixed(4)} of a unit at ${worstAt.toFixed(2)}s), ` +
      `resting at ${elev(at(1.9)).toFixed(1)}° with the hand ${rise(at(1.9)).toFixed(3)} off the joint's height and the wrist ` +
      `${lateralOf(at(1.9).arm.wrist, at(1.9)).toFixed(3)} across the body's own centre line`,
  )
  // ...and then the pause itself: nothing about the arm moves across the better part of
  // a fifth of a second, which is what makes the recovery below a separate movement
  // rather than the fold easing back out.
  for (const axis of [0, 1, 2]) {
    expect(
      Math.abs(at(2.0).arm.wrist[axis] - at(1.9).arm.wrist[axis]),
      `the arm drifts across the hold (${axis})`,
    ).toBeLessThan(0.02)
    expect(
      Math.abs(at(2.0).arm.elbow[axis] - at(1.9).arm.elbow[axis]),
      `the elbow drifts across the hold (${axis})`,
    ).toBeLessThan(0.02)
  }
  // ...and the fall to his side is a movement again: by the recovery's own key the arm
  // is long and down, the forearm sixty degrees under the level and the hand a quarter
  // of a rig unit below the joint it hangs from.
  const down = await openAt(page, 2.8)
  const fallen = unit(sub(down.arm.wrist, down.arm.elbow))
  const drop = Math.asin(Math.max(-1, Math.min(1, fallen[1]))) * DEG
  expect(
    Math.hypot(...down.arm.wrist.map((v, axis) => v - down.arm.shoulder[axis])) / down.arm.reach,
    'the arm does not come home long at 2.80s',
  ).toBeGreaterThan(0.9)
  expect(
    drop,
    `the arm comes home with the forearm only ${drop.toFixed(1)}° below the level at 2.80s: it is still in the throw`,
  ).toBeLessThan(-45)
  expect(
    down.arm.wrist[1] - down.arm.elbow[1],
    'the hand does not hang under the elbow on the way to his side',
  ).toBeLessThan(-0.2)
  console.log(
    `arm: the throw holds its own chord across the body (${chord(at(RELEASE)).toFixed(3)} of the span at the release, ${chord(floor).toFixed(3)} at its worst — an elbow of ${floor.arm.elbowDegrees.toFixed(0)}° at ${floor.clip.toFixed(2)}s), ` +
      `the elbow crosses the plate's own line while the arm is still straight and is held ${(-across(at(1.68))).toFixed(3)} past it (drifting ${Math.hypot(...sub(inTrunk(upper(at(1.68)), at(1.68)), settled)).toFixed(2)} of a unit in the trunk's own frame) while the hand ` +
      `falls to ${rise(bottom).toFixed(3)} of a rig unit under the joint and swings back up, holds the rest to the frame for a fifth of a second, and is down at his side by 2.80s with the forearm ${drop.toFixed(0)}° below the level`,
  )
})

test('the throwing arm’s own turn steps nowhere, frame by frame through the follow-through', async ({ page }) => {
  // What the pose promises about the fold is a *plane*: the elbow hangs on the ring the
  // arm's own socket draws about the chord, and the ring turns as the body comes round the
  // drive leg (see the fold's own keys in src/util/pitcherSequence.js). The promise is
  // only half of it, though — the driver has to read it off *its* socket — and a ring the
  // pose's own track turns faster than the interpolation it wrote hands that rule a pole
  // it cannot use: the elbow comes off the ring the pose asked for and the upper arm
  // swings round it by the ring's whole radius in one frame. That is the flick across the
  // drive leg, and the way to read it is the arm's own turn, frame by frame: the
  // promise's own schedule is smooth, so a *step* in the drawn arm is the driver's and not
  // the pose's.
  //
  // Read over the whole follow-through — the release's own window through the crossing to
  // the pause — with two readings per step:
  //
  //   * the upper arm's own line, shoulder to elbow, and how far it turns;
  //   * the elbow's own place, and how far it travels.
  //
  // Both are held to their own neighbours rather than to a fixed number, because a
  // delivery that is re-timed turns its ring faster and what matters is whether any *one*
  // frame turns it faster than the frames around it; the absolute ceilings below are the
  // schedule's own numbers with room for the millimetres the socket estimate is worth.
  // Measured on the frame the flick lived at (1.6125 s): the upper arm turned 20.6°
  // against 6.7° and 8.6° either side of it — two and a half times its own neighbours —
  // and the elbow covered 0.115 of a rig unit against 0.043 and 0.052. On the fixed
  // delivery the same two frames read 4.0° (its neighbours 4.1° and 5.0°) and 0.027
  // (0.028 and 0.033), and the whole window's worst step is 5.6° and 0.037.
  const frames = await sweepWindow(page, 1.545, 1.9, 1 / 240)
  const turn = []
  const travel = []
  for (let i = 1; i < frames.length; i += 1) {
    const before = frames[i - 1].arm
    const now = frames[i].arm
    const a = unit(sub(before.elbow, before.shoulder))
    const b = unit(sub(now.elbow, now.shoulder))
    turn.push(Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * DEG)
    travel.push(length(sub(now.elbow, before.elbow)))
  }
  // The schedule's own ceiling first, so a delivery that turns its ring too fast anywhere
  // is caught even where its neighbours happen to be turning fast with it.
  const worstTurn = Math.max(...turn)
  const worstTravel = Math.max(...travel)
  const at = (i) => frames[i + 1].clip.toFixed(4)
  expect(
    worstTurn,
    `the throwing arm turns ${worstTurn.toFixed(1)}° in one frame of the follow-through: the ring is turning faster than the pose asked it to`,
  ).toBeLessThan(9)
  expect(
    worstTravel,
    `the throwing elbow covers ${worstTravel.toFixed(3)} of a rig unit in one frame: the arm's own place is stepping`,
  ).toBeLessThan(0.06)
  // ...and then the step itself: no frame may turn the arm — or carry the elbow — at more
  // than twice the rate of the frames either side of it, with the floors that keep a still
  // frame from reading as a step (a fortieth of a degree is nothing, and neither is a
  // millimetre). A flick is exactly that spike: one frame taking the arm where two could
  // not, which is what the eye reads as the arm coming up across the leg.
  let worstStep = 0
  let worstStepAt = 0
  let worstJump = 0
  let worstJumpAt = 0
  for (let i = 1; i < turn.length - 1; i += 1) {
    const neighbours = Math.max((turn[i - 1] + turn[i + 1]) / 2, 1.25)
    const step = turn[i] / neighbours
    if (step > worstStep) { worstStep = step; worstStepAt = frames[i + 1].clip }
    const carried = Math.max((travel[i - 1] + travel[i + 1]) / 2, 0.004)
    const jump = travel[i] / carried
    if (jump > worstJump) { worstJump = jump; worstJumpAt = frames[i + 1].clip }
  }
  expect(
    worstStep,
    `the throwing arm turns ${worstStep.toFixed(2)} times its own neighbours' rate on the frame at ${worstStepAt.toFixed(4)}s: the follow-through has a step in it`,
  ).toBeLessThan(2)
  expect(
    worstJump,
    `the throwing elbow travels ${worstJump.toFixed(2)} times its own neighbours' rate on the frame at ${worstJumpAt.toFixed(4)}s: the arm's own place jumps`,
  ).toBeLessThan(2)
  console.log(
    `arm turn: the follow-through's own schedule peaks at ${worstTurn.toFixed(1)}° of upper arm in one frame (at ${at(turn.indexOf(worstTurn))}s) and ${worstTravel.toFixed(3)} of a rig unit of elbow travel, and the worst step any frame takes over its own neighbours is ${worstStep.toFixed(2)}× of the turn and ${worstJump.toFixed(2)}× of the travel`,
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
  // The samples run from the frame the *swing* starts on — the stop, where the hand has
  // come down out of the throw and the forearm is let off its line — to the hold. What
  // they deliberately leave out is the fall before it (1.56s to 1.68s): that is the
  // throw's own momentum, the arm coming down through its arc, and the hand is *fastest*
  // there — measured 1.98 rig units a second at 1.56s, 9.4 at 1.60s and 21 on the
  // boundary at 1.61s, all of it the arm being carried out of the release — where the
  // fold's own promise is about what the arm does *after* it has been let go. From the
  // stop on the hand only ever slows: 2.75, 1.05, 0.63 and 0.30 rig units a second on
  // these samples, and every frame of the settle under them (see below).
  const crossing = [1.7, 1.8, 1.86, 1.9]
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
  // ...and the hand is *stood in* while the body it hangs from is not yet: what the hold's
  // own promise is about is the arm's own shape, so the reading below is the wrist's speed
  // relative to the socket it hangs from (the body is standing up out of the finish from
  // the crossing on, and a hand carried by a chest that rises is a hand that moves without
  // the arm doing anything — see the sequence's FINISH_STAND_FROM).
  const socketOf = (frame, side) => frame.arms.find((arm) => arm.side === side).shoulder
  const carriedSpeedOf = (side, clip) => {
    const now = row(clip)
    const before = row(clip - 0.02)
    const wrist = handOf(now, side).map((v, axis) => v - handOf(before, side)[axis])
    const socket = socketOf(now, side).map((v, axis) => v - socketOf(before, side)[axis])
    return Math.hypot(...wrist.map((v, axis) => v - socket[axis])) / 0.02
  }
  // ...and it is read a frame *into* the beat rather than on the hold's own key: the arm's
  // places are held from 1.86 s on, and what the driver still has to answer for is the
  // ring it solves the elbow on, which settles over the hundredth of a second either side
  // (measured, 0.7 rig units a second of the arm's own shape at 1.90 against 0.3 at 1.98).
  expect(
    carriedSpeedOf('R', 1.98),
    `the throwing arm is still doing ${carriedSpeedOf('R', 1.98).toFixed(2)} rig units a second of its own shape on the body into the hold`,
  ).toBeLessThan(0.5)
  // And the lead arm settles too, rather than stopping: it is moving through the
  // window the throwing arm is (its own hand comes back over the thigh by the hold),
  // and it is *standing in* the hang by the hold — static from the frame after it,
  // with the hand well below the socket it hangs from.
  const leadAt = (clip) => row(clip).arms.find((arm) => arm.side === 'L')
  const moveOf = (clip) => Math.hypot(...leadAt(clip).wrist.map((v, axis) => v - leadAt(1.68).wrist[axis]))
  // ...and the bound is the reading's own: **0.298** at 1.74 s with the stand leaving the
  // crossing at once (0.30 on the smoothstep, which held the top a fifth of a second), so
  // what it still catches is a glove left standing in its throw pose rather than one a
  // thousandth of a unit either side of a line.
  expect(
    speedOf('L', 1.74),
    `the glove is ${speedOf('L', 1.74).toFixed(2)} rig units a second through the settle: it is frozen in its throw pose`,
  ).toBeGreaterThan(0.25)
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
  // The samples are the *beat* the finish is stood in (1.90 to 2.10): the trunk stands up
  // over the recovery that follows it (see the sequence's FINISH_STAND), and the glove
  // hangs from the shoulders that carry it, so a sample past the pause's own frame is
  // reading the stand rather than a drift in the pose.
  for (const axis of [0, 1, 2]) {
    const shape = (clip) => leadAt(clip).wrist[axis] - leadAt(clip).shoulder[axis]
    expect(
      Math.abs(shape(2.08) - shape(1.98)),
      `the glove's own shape drifts across the hold (${axis}): the arm is still settling`,
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
  // (``AUTHORED_LOOK_LOCK_TIME``) — a settled eleventh of a second ahead of the drive
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
    Math.abs(chest(1.0) - chest(0)),
    `the windup only winds the shoulders ${(chest(1.0) - chest(0)).toFixed(0)}° off the set: there is nothing for the neck to be carrying`,
  ).toBeGreaterThan(20)
  // ...and the look is *finished* before the drive does anything: on the plate's own line and
  // level by the balance point, still on it on the last frame before the drive fires (1.08,
  // the frame before the hip crosses its own nought), and on it for the rest of the throw —
  // which is the whole of what "looking at the strike zone" is.
  for (const clip of [AUTHORED_LOOK_LOCK_TIME, 1.08, 1.12, RELEASE, 1.42, 1.52, 1.6, 1.62]) {
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
    Math.abs(line(1.08) - line(AUTHORED_LOOK_LOCK_TIME)),
    `the head moves ${(line(1.08) - line(AUTHORED_LOOK_LOCK_TIME)).toFixed(1)}° between the balance and the eve of the drive: the turn is not finished when the drive fires`,
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
  // The shoulders are read at the *pause*, which is the last frame of the beat the finish
  // is stood in: the trunk stands up out of it over the recovery that follows (see
  // FINISH_STAND), and that stand is the body's own movement rather than a drift in what
  // the neck was handed.
  // ...and the shoulders are read off the pose's own facing for the same reason the test
  // above is: the trunk is standing up out of its fold across this window (see the
  // sequence's FINISH_STAND_FROM), so the realised chest's yaw carries a few degrees of the
  // stand — 5.2° from the landing to the hold at the stand's paced rate, against 3.9° at the
  // keys' own — while the written turn does not move at all.
  const heldRow = row(2.1).pose
  const landingRow = row(1.68).pose
  const shouldersHeld = (heldRow.hip.yaw + heldRow.torsoYawExtra - landingRow.hip.yaw - landingRow.torsoYawExtra) * DEG
  expect(
    Math.abs(shouldersHeld),
    `the shoulders turn ${shouldersHeld.toFixed(2)}° from the landing to the hold: nothing was handed over`,
  ).toBeLessThan(0.05)
  expect(
    Math.abs(chest(2.1) - chest(1.68)),
    `the chest's own reading turns ${Math.abs(chest(2.1) - chest(1.68)).toFixed(1)}° from the landing to the hold, over the five the stand is worth: something was handed over`,
  ).toBeLessThan(6.5)
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
      `(an eleventh of a second before the drive fires) and the body's again past the hand-off, ` +
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
  // is a *wound* one now (the coil is held all the way through the plant and the cock,
  // so the chest trails the pelvis by up to 38° before the release), which puts the
  // floor of this measure over six degrees rather than three; a torso that leaned
  // toward the glove hand as it came round would be tens of degrees of it, and a lean
  // applied in the world's frame rather than the body's — the mistake this is here to
  // catch — would grow with the turn itself.
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
  // one it turns on from 1.26 on — a trunk properly over, and turning on its axis.
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
  ).toBeLessThan(7)
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
  //
  // The ground under it is the *mound's* rather than a plane (Pitcher.jsx hands the
  // driver `moundSurfaceY`; see constants/mound.js), so ``sink`` here is how far the
  // shoe ended up out of the surface its own place stands on — the plateau under the
  // stance, the plate's top on the rubber, the slant under the stride's landing. The
  // mound's own shape is checked against that surface in the test below.
  //
  // One thing the rule is not asked to do is reach past the leg it hangs from, and on
  // a mound it cannot be: the delivery's own *landing* is authored at the trailing
  // leg's full length (see the drive-leg test below — 99.7 per cent of its own span on
  // a flat ground), and the mound falls away under that foot by a few centimetres as
  // the swing carries it down the front of the mound. A shoe the limb has no more
  // length for is a shoe riding its ground rather than sunk into it — which is the
  // half of this promise that is the *driver's* to hold — so what is exact where the
  // leg has slack, and bounded everywhere, is the sign: never in the ground.
  //
  // Which of those a foot is, is a question about the *leg* rather than about a
  // threshold: the length it has left to spend (socket to ankle against its own limb)
  // set against the height it is short by. A leg with length to spare is a leg the
  // rule can stand on the ground, and a foot left off it is this test's failure; a
  // foot short by more than its leg has left is the limb answering for the mound,
  // and all it owes is the sign. (The spare is read along the *leg* and the float
  // straight up, so a step down the ground is a shade longer than the leg's own
  // travel — the whisker under the spare is the same lean the rule's own convergence
  // is damped for.)
  const frames = await sweepDelivery(page, AUTHORED_CLIP_END)
  let planted = 0
  let riding = 0
  let worst = 0
  for (const frame of frames) {
    for (const leg of frame.legs) {
      if (!leg.planted) continue
      planted += 1
      expect(
        leg.sink,
        `the ${leg.side === 1 ? 'pivot' : 'front'} foot at ${frame.clip}s stands ${leg.sink} rig units *in* the ground`,
      ).toBeLessThan(0.0005)
      const spare = leg.legLength - length(sub(leg.hip, leg.ankle))
      if (spare < -leg.sink + 0.002) {
        riding += 1
        worst = Math.max(worst, -leg.sink)
      } else {
        expect(
          Math.abs(leg.sink),
          `the ${leg.side === 1 ? 'pivot' : 'front'} foot at ${frame.clip}s has ${(spare * 1000).toFixed(1)} mm of its leg to spare and still stands ${leg.sink} rig units out of the ground`,
        ).toBeLessThan(0.0005)
      }
    }
  }
  expect(planted).toBeGreaterThan(20)
  expect(
    worst,
    `a foot the leg has no length for rides ${(worst * 1000).toFixed(0)} mm over the mound`,
  ).toBeLessThan(0.05)
  console.log(
    `ground: ${planted} planted feet, ${riding} of them at the limb's own length (the worst riding ` +
      `${(worst * 1000).toFixed(0)} mm over the dirt)`,
  )
})

test('the feet land on the mound\'s own surface, down its slant and on its plate', async ({ page }) => {
  // The pitcher stands on the *animated* mound, not on the field under it: Ballpark
  // draws the mound (constants/mound.js builds both its rings and the surface the
  // feet are solved against, so the two cannot drift), the placement stands the body
  // on the surface under its stance, and every planted foot is stood on the surface
  // under *its own* place — the plateau at the set, down the slant as the stride and
  // the drive carry the feet toward the plate. This test is the agreement of those
  // three: the shoe's own lowest point, in the *world*, against the mound's own
  // surface read at the place the foot stood.
  //
  // Read on the default pitch — released 0.55 m off the third-base side of the
  // rubber, which is where a right-hander's own release sits, and which places the
  // body a good hand's width off the plate's own line — so what it checks is the
  // mound (plateau and slant) under a stance the placement really produces rather
  // than a stance arranged to land on the plate (that one is the next test).
  const frames = await sweepDelivery(page, AUTHORED_CLIP_END)
  let planted = 0
  let lowest = Infinity
  let highest = 0
  let worst = 0
  for (const frame of frames) {
    for (const leg of frame.legs) {
      if (!leg.planted) continue
      planted += 1
      expect(
        leg.standing,
        `the ${leg.side === 1 ? 'pivot' : 'front'} foot at ${frame.clip}s reports no ground to stand on`,
      ).not.toBeNull()
      const { at, surface, contact } = leg.standing
      const drawn = moundSurfaceY(at[0], at[1])
      expect(
        Math.abs(surface - drawn),
        `the ground under the ${leg.side === 1 ? 'pivot' : 'front'} foot at ${frame.clip}s is ${surface.toFixed(4)}, where the mound stands ${drawn.toFixed(4)} at (${at[0].toFixed(2)}, ${at[1].toFixed(2)})`,
      ).toBeLessThan(1e-4)
      // ...and the shoe on it, wherever the leg has the length to be: the delivery
      // lands its trailing leg at its own full stretch (see the foot test above), and
      // on the mound's fall that limb is what runs out, so what the shoe is held to is
      // the ground rather than the leg's own reach (see the foot test's own note,
      // which reads the same split the same way).
      const spare = leg.legLength - length(sub(leg.hip, leg.ankle))
      if (spare < -leg.sink + 0.002) {
        expect(
          contact - drawn,
          `the ${leg.side === 1 ? 'pivot' : 'front'} shoe at ${frame.clip}s stands ${(contact - drawn).toFixed(4)} m *in* the mound's surface`,
        ).toBeGreaterThan(-0.001)
        worst = Math.max(worst, contact - drawn)
      } else {
        expect(
          Math.abs(contact - drawn),
          `the ${leg.side === 1 ? 'pivot' : 'front'} shoe at ${frame.clip}s stands ${(contact - drawn).toFixed(4)} m off the mound's surface at (${at[0].toFixed(2)}, ${at[1].toFixed(2)})`,
        ).toBeLessThan(0.002)
      }
      lowest = Math.min(lowest, drawn)
      highest = Math.max(highest, drawn)
    }
  }
  expect(planted).toBeGreaterThan(20)
  expect(worst, `a shoe the leg has no length for rides ${worst.toFixed(3)} m over the mound`).toBeLessThan(0.05)
  // ...and the delivery really *reads* the two heights a pitcher's foot is promised
  // rather than standing every foot on one plane: the highest ground a planted foot
  // stands on is the *rubber's* own top — the pivot foot starts the delivery on the
  // plate, which is what a plate is for (see the next test) — and the lowest is the
  // slant, because the drive carries the trail foot a couple of feet down the front
  // of the mound, a good 5 cm below the plateau. The mound is 0.22 m from the base
  // to the plateau over 1.89 m of radius, and the feet land inside the first half of
  // that fall.
  expect(
    highest,
    `the highest surface a foot stood on is ${highest.toFixed(3)}, not the rubber's own top ${(MOUND.surface + MOUND.rise + MOUND.rubber.rise).toFixed(3)}`,
  ).toBeCloseTo(MOUND.surface + MOUND.rise + MOUND.rubber.rise, 3)
  expect(
    MOUND.surface + MOUND.rise - lowest,
    `the lowest surface a planted foot stands on is only ${(MOUND.surface + MOUND.rise - lowest).toFixed(3)} m below the plateau: the mound's slant is not being read`,
  ).toBeGreaterThan(0.05)
  console.log(
    `mound: a planted foot's ground runs ${lowest.toFixed(3)} to ${highest.toFixed(3)} m through the delivery ` +
      `(the plateau is ${(MOUND.surface + MOUND.rise).toFixed(3)}, the plate ${(MOUND.surface + MOUND.rise + MOUND.rubber.rise).toFixed(3)}); ` +
      `the worst a leg's own length left riding is ${(worst * 1000).toFixed(0)} mm`,
  )
})

test('the set stands the pivot foot on the animated rubber', async ({ page }) => {
  // The one place a pitcher's foot must stand, and the thing the eye reads the mound
  // by: the rubber. The plate Ballpark draws is the plate the delivery is authored to
  // stand on — its front edge on the line the pitch's own release distances are
  // measured from, the mound centred half a plate behind it (see constants/mound.js)
  // — so a pitch released over the plate's own line puts the set's drive foot on the
  // plate's *top*: its leather on the 3 cm the plate stands proud of the plateau,
  // rather than the shoe standing on the dirt 3 cm inside it or beside it.
  //
  // Read at the set (clip 0, the pitch's own clock) on a release over the plate's own
  // centreline, because that is the release the placement stands the body's stance on
  // the rubber for (``?x=0``): an off-centre release is thrown by a body placed off
  // the line (see the placement in Pitcher.jsx), which is the mound's own story rather
  // than the rubber's.
  const frame = await openAt(page, 0, '&x=0')
  const pivot = frame.legs.find((leg) => leg.side === 1)
  const front = frame.legs.find((leg) => leg.side === -1)
  expect(pivot.planted, 'the set should stand the drive foot on the mound').toBe(true)
  expect(
    Math.abs(pivot.standing.at[0] - MOUND.centre[0]),
    `the pivot foot stands ${(pivot.standing.at[0] - MOUND.centre[0]).toFixed(3)} m across from the plate's own centre`,
  ).toBeLessThan(MOUND.rubber.halfWidth)
  expect(
    Math.abs(pivot.standing.at[1] - MOUND.centre[1]),
    `the pivot foot stands ${(pivot.standing.at[1] - MOUND.centre[1]).toFixed(3)} m along from the plate's own centre`,
  ).toBeLessThan(MOUND.rubber.halfDepth)
  // ...on the plate's own top, standing its thickness over the plateau...
  expect(
    pivot.standing.surface,
    `the pivot foot's ground is ${pivot.standing.surface.toFixed(4)}, not the rubber's own top`,
  ).toBeCloseTo(MOUND.surface + MOUND.rise + MOUND.rubber.rise, 4)
  expect(
    Math.abs(pivot.standing.contact - pivot.standing.surface),
    `the pivot shoe stands ${(pivot.standing.contact - pivot.standing.surface).toFixed(4)} m off the rubber's top`,
  ).toBeLessThan(0.002)
  // ...and the stride foot is on the plateau beside it, a plate's thickness lower.
  expect(front.planted, 'the set should stand the stride foot too').toBe(true)
  expect(
    Math.abs(front.standing.surface - moundSurfaceY(front.standing.at[0], front.standing.at[1])),
    'the stride foot\'s ground is not the mound\'s own surface',
  ).toBeLessThan(1e-4)
  expect(
    pivot.standing.surface - front.standing.surface,
    `the two feet stand ${(pivot.standing.surface - front.standing.surface).toFixed(4)} m apart in height: the pivot foot is not up on the plate`,
  ).toBeGreaterThan(0.02)
  console.log(
    `set: the pivot shoe is on the rubber at (${pivot.standing.at[0].toFixed(2)}, ${pivot.standing.at[1].toFixed(2)}) ` +
      `— ${(pivot.standing.surface * 100).toFixed(1)} cm up the mound, the stride foot ${(front.standing.surface * 100).toFixed(1)}`,
  )
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
    if (frame.clip < 0.58 || frame.clip > 1.18) continue
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
    if (frame.clip < 0.8 || frame.clip > 1.02) continue
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
  // The drive's own window: the break the leg pushes out of, to the frame before the
  // release. The release's own frame is left out of it because the shoe has begun to
  // *peel* off the rubber there and turn out under a knee the body has come round —
  // four centimetres of it, which is the swing's business and not the drive's (see the
  // peel below and the swing above).
  for (const frame of frames) {
    if (frame.clip < 1.12 || frame.clip > 1.32 - 1e-9) continue
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
  expect(drive, 'the drive should be swept whole').toBeGreaterThan(4)
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
  //
  // The one arm the *pose* hands a limit of its own to is the throwing one: what a
  // pitch's arm leaves on is its own chord rather than the bow a hand held near the
  // body has (see RELEASE_ELBOW, and the release's own reading above), measured 174.9°
  // off the posed skeleton — and it is handed over the window the pitch is thrown *on*
  // rather than the release's own frame: the pose's slot track is full from the cock
  // through the follow-through key (see AUTHORED_SLOT_END), and the arm the delivery
  // realises is the straight one right across it (measured 174.87° at the release and
  // again at 1.42–1.48 s, easing out of the ask after the hand-off). So the lock bound
  // is that constant's own angle across that window — where the arm is *meant* to be
  // straight — and the driver's own 165° bow everywhere else, with the few degrees
  // below it that the bones' own bow moves a solved elbow by.
  const lockBound = (frame, arm) => (
    arm.side === 'R' && frame.clip >= RELEASE - 0.02 && frame.clip <= AUTHORED_SLOT_END
      ? (RELEASE_ELBOW * 180) / Math.PI + 2
      : 170
  )
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
      ).toBeLessThan(lockBound(frame, arm))
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

// The pitcher is the same *player* as the batter — one model, one body, one face, one
// uniform — and the one thing the two do not share is the hat. Both actors load the same
// asset (public/models/player.glb: see PLAYER_MODEL_URL in Pitcher.jsx and PLAYER_URL in
// Batter.jsx) and both are put through the same look pass (src/util/batterLook.js), which
// is the whole of what makes them the same person: as the model ships, the face wears no
// brows and each eye plate sits half sunk in the head (36 of its 53 vertices inside), the
// jersey has no front, and the shoes are plain — and before this test's own subject was
// written, only the batter was put right, so the two characters were visibly two people.
//
// What is read here is the pass's own report for each body — the row it writes onto the
// model it ran on, handed back by each harness — so this is the pass saying what it did
// rather than a probe re-deriving it, and the two reports are compared *to each other*.
// The hat is the only thing allowed to differ, and it decides exactly two rows: the flap
// work (the helmet's own, left undone for a cap that has no ear cover to take off — see
// `shapeHelmet`), and the eyes (read under the worn brim, so a cap's come down with it —
// see BRIM_UNDERSIDE). Everything else has to be the same row, to the digit.
test('the pitcher wears the batter’s own face, under the cap', async ({ page }) => {
  const at = await openAt(page, RELEASE)
  const pitcher = at.look
  expect(pitcher, 'the pitcher’s body should carry the look pass’s own report').not.toBeNull()
  // Run once, on the pitcher's own clone of the asset, with the cap on.
  expect(pitcher.runs).toBe(1)
  expect(pitcher.headgear).toBe('cap')
  // ...and the helmet's ear-cover work is *the helmet's*: nothing is found, taken, folded
  // or lengthened for a hat that has no cover on it to begin with.
  expect(pitcher.flap.worn).toBe('cap')
  expect(
    pitcher.flap.found + pitcher.flap.taken + pitcher.flap.kept
      + pitcher.flap.triangles + pitcher.flap.folded + pitcher.flap.lengthened,
    'the helmet’s own work should be left undone rather than done on a mesh nobody sees',
  ).toBe(0)
  // The batter's own body, in the same scene, off the batter's own harness page: the same
  // pass, the same asset, the same numbers — with the two hat-decided rows taken out of
  // the comparison.
  await page.goto('/e2e/harness/batter.html?phase=stance')
  await page.waitForFunction(() => window.__vr?.ready === true && window.__vr.probeKit() !== null)
  const batter = await page.evaluate(() => window.__vr.probeKit().look)
  expect(batter, 'the batter’s body should carry the look pass’s own report').not.toBeNull()
  expect(batter.headgear, 'the batter’s own hat is the helmet').toBe('helmet')
  expect(batter.flap.found, 'the helmet is the one with ear cover on it').toBeGreaterThan(0)
  // The two rows the hat decides, taken out of each report before the two are compared:
  // `flap` (the helmet's own work) and `eyes` with the `brim` they were read under.
  const hatFree = (report) => {
    const rest = { ...report }
    for (const row of ['flap', 'eyes', 'headgear', 'brim']) delete rest[row]
    return rest
  }
  expect(
    hatFree(pitcher),
    'the pitcher and the batter are one body, one face and one uniform — the hat apart',
  ).toEqual(hatFree(batter))
  // The eyes, then — the one row the hat has a say in, and only in *how low* they sit: a
  // cap is worn 0.0119 rig lower than a helmet (measured off each mesh's own brim: 1.7835
  // against 1.7954), so the pitcher's come down with it, and the width asked of each
  // plate is the same share of the plate's own width on both heads (see EYE_WIDER_X — the
  // two plates are each stretched across about their own inner corner, so the clearer
  // number to hold here is the share rather than the millimetres: the two bodies' eyes are
  // scaled to different brims and so do not start from the same width).
  for (const [who, report] of [['pitcher', pitcher], ['batter', batter]]) {
    expect(report.eyes.count, `${who}: a face with two eyes on it`).toBe(2)
    expect(
      report.eyes.topAfter,
      `${who}: an eye may not reach up behind the brim the ${who} wears`,
    ).toBeLessThan(report.brim)
    expect(report.eyes.wider, `${who}: the plate is given its width back outward`)
      .toBeGreaterThan(1)
    expect(
      report.eyes.widthAfter,
      `${who}: a wider eye is a wider plate`,
    ).toBeGreaterThan(0.045)
  }
  expect(pitcher.brim).toBeCloseTo(1.7835, 4)
  expect(batter.brim).toBeCloseTo(1.7954, 4)
  // ...and the pitcher's come down with it: read off the body, the plate's top falls by
  // 0.0091 rig against the hat's own 0.0119, the difference being that the eye is already
  // at the pass's own floor of scale under a cap that low (0.5 of the plate, see
  // EYE_SCALE_MIN — the plate is not shrunk past half its size for any brim), so what is
  // pinned is the direction and the ceiling rather than the brim's own number.
  const drop = batter.eyes.topAfter - pitcher.eyes.topAfter
  console.log(`the eyes: batter top ${batter.eyes.topAfter.toFixed(4)} at scale ${batter.eyes.scale.toFixed(4)}, `
    + `pitcher top ${pitcher.eyes.topAfter.toFixed(4)} at scale ${pitcher.eyes.scale.toFixed(4)} — `
    + `${drop.toFixed(4)} lower for the cap's own ${BRIM_DROP.toFixed(4)} lower brim`)
  expect(drop, 'the pitcher’s eyes come down with the hat that is worn lower').toBeGreaterThan(0.005)
  expect(
    drop,
    'and never by more than the hat itself drops, since the plate is only taken down to clear the brim',
  ).toBeLessThanOrEqual(BRIM_DROP)
  expect(pitcher.eyes.wider, 'the same widening on both faces').toBe(batter.eyes.wider)
  expect(pitcher.brows?.count, 'a brow over each eye, on the pitcher too').toBe(2)
  expect(pitcher.jersey?.buttons, 'and the jersey’s own front on him').toBeGreaterThan(0)
  expect(pitcher.shoes?.shells, 'and the leather on his shoes').toBeGreaterThan(0)
  console.log(`the pitcher's own face: ${pitcher.eyes.count} eyes, top ${pitcher.eyes.topAfter.toFixed(4)} `
    + `under the cap's brim ${pitcher.brim} (the batter's ${batter.eyes.topAfter.toFixed(4)} under the helmet's `
    + `${batter.brim}), each plate ${(pitcher.eyes.wider * 100 - 100).toFixed(0)}% wider than the brim's `
    + `shrink left it (${pitcher.eyes.widthAfter.toFixed(4)} rig across) · `
    + `${pitcher.brows.count} brows · jersey opening ${pitcher.jersey.buttons} buttons · `
    + `${pitcher.shoes.shells} shoe pieces, laces ${pitcher.shoes.laceBars}`)
})

test('a left-handed delivery mirrors the right-handed one', async ({ page }) => {
  // The mirror itself is read over the plate's own line (``?x=0``): the pitch's own
  // lateral is what stands the two stances in different places on the mound, and with
  // it held there the mound is symmetric about the two bodies — so every number the
  // two deliveries produce is the other's mirror, to the anchor's own hair off the
  // arm's plane. The harness's own pitch is released off that line (x = −0.55), and
  // there the mound really does stand the two stances on different ground; the block
  // at the end of the test reads the promise that is the mound's rather than the
  // hands'.
  const right = await openAt(page, RELEASE, '&x=0')
  const left = await openAt(page, RELEASE, '&x=0&hand=L')
  // The other arm throws...
  expect(right.arm.side).toBe('R')
  expect(left.arm.side).toBe('L')
  // ...and it reaches the same release point by the same delivery, the other way
  // round the body: the world point is the pitch's, and every lateral number is the
  // right-hander's mirrored.
  expect(left.miss).toBeLessThan(0.002)
  expect(right.miss).toBeLessThan(0.002)
  expect(left.ballRig[0]).toBeCloseTo(-right.ballRig[0], 3)
  expect(left.ballRig[1]).toBeCloseTo(right.ballRig[1], 3)
  expect(left.ballRig[2]).toBeCloseTo(right.ballRig[2], 3)
  // ...and the two are the *same* pitcher: a hand is a hand, so the body the pitch is
  // thrown by — its stature, the size it is stood at, the delivery's own stride and
  // the pitch's own distance — is the same on both sides, and it is the ball's own
  // place that mirrors (the anchor comes off the other socket).
  // The body's own numbers, to a millionth: a hand is a hand.
  for (const key of ['stature', 'scale', 'stride', 'needed']) {
    expect(left.pitcherData.profile[key], `the two hands disagree about ${key}`)
      .toBeCloseTo(right.pitcherData.profile[key], 6)
  }
  // ...and the two the ball's own place is in, to a thousandth: the anchor is a hair
  // off the arm's own plane (a twentieth of a shoulder's half-width, see
  // `pitcherRelease`), and that hair is on the *other* side of the body for a lefty,
  // so the line's own elevation and the metres it carries differ by its share of
  // them — a millionth of an angle, which is a mirror and not a different pitcher.
  for (const key of ['armAngle', 'travel']) {
    expect(
      Math.abs(left.pitcherData.profile[key] - right.pitcherData.profile[key]),
      `the two hands disagree about ${key}`,
    ).toBeLessThan(1e-4)
  }
  // The two stances stand on either side of the pitch's own line (the anchor each
  // body is placed from is the other socket's), and the drive foot's place along the
  // rubber is the pitch's own on both sides.
  const rubber = -RUBBER_Y
  for (const side of [left, right]) {
    const foot = side.pitcherData.placement.foot
    expect(foot[2]).toBeGreaterThan(rubber - PIVOT_BEHIND)
    expect(foot[2]).toBeLessThan(rubber + PIVOT_AHEAD)
  }
  expect(Math.abs(left.pitcherData.placement.foot[0] - right.pitcherData.placement.foot[0]))
    .toBeGreaterThan(0.2)
  // ...and the one promise that is the mound's rather than the hands': on the
  // harness's own pitch, released 0.55 m off the plate's own line, the two stances
  // come out on different sides of the mound and so on different ground — the lefty's
  // drive foot lands 8 cm past the plateau's edge, on the slant, and his ground is
  // 0.234 m against the righty's 0.244. The world point is the pitch's on both sides
  // (the misses above); what each body's own frame carries is that centimetre of
  // ground, and nothing else: the ball's rig-frame height differs by exactly the two
  // grounds over the body's scale, the slot over each body's own feet is the pitch's
  // own height less its own ground (which is the centimetre of rig slot the two
  // `rigHeight`s show), and the arm's own line and the delivery move by that same
  // share. That is the mound's reading, not the hand's.
  const offRight = await openAt(page, RELEASE)
  const offLeft = await openAt(page, RELEASE, '&hand=L')
  expect(offLeft.miss).toBeLessThan(0.002)
  expect(offRight.miss).toBeLessThan(0.002)
  // ...and each body reaches that one world point with its *own* arm: the lateral ask
  // is the same in each body's own frame (the same world x, the same hands' mirror),
  // so each socket's own reach carries it and neither comes up short — which is the
  // reading of the two rig frames' agreement now that the arm, rather than the stance,
  // is what meets a pitch's own lateral (see ``side``). What used to be a mirror in the
  // rig frame was a mirror of a *slid* body: the two ball rig x's differ by the two
  // sockets' own shoulders, which is what a left-handed body is.
  expect(Math.abs(offLeft.pitcherData.profile.sideShortfall)).toBeLessThan(1e-3)
  expect(Math.abs(offRight.pitcherData.profile.sideShortfall)).toBeLessThan(1e-3)
  for (const side of [offLeft, offRight]) {
    expect(Math.abs(side.pitcherData.placement.line)).toBeLessThanOrEqual(PIVOT_SIDE)
  }
  // ...and with the pitch's own lateral met by the *arm* rather than by the stance, the
  // two bodies stand on the same ground: the stance is one line on the rubber for both
  // hands, whatever the world x the pitch comes from, which is the reading this block
  // used to take off the mound's slope — a lefty's stance slid 8 cm past the plateau's
  // edge and onto the slant, and the centimetre of ground between the two was the
  // mound's, not the hands'. The mound's own reading lives in the mound tests, which
  // walk their own pitches across it (see the slant and plateau tests below); what this
  // block's two hands share is the *body* — one stature, one ground, one slot, one
  // delivery — with the pitch's own world point met by each body's own arm.
  expect(offLeft.pitcherData.profile.ground)
    .toBeCloseTo(offRight.pitcherData.profile.ground, 9)
  expect(offLeft.pitcherData.profile.rigHeight)
    .toBeCloseTo(offRight.pitcherData.profile.rigHeight, 9)
  // ...to within the anchor's own hair: the two ball rig heights differ by 0.2 mm on
  // this pitch (a twentieth of a shoulder's half-width, seen down two mirrored lines).
  expect(offLeft.ballRig[1]).toBeCloseTo(offRight.ballRig[1], 3)
  expect(
    Math.abs(offLeft.pitcherData.profile.armAngle - offRight.pitcherData.profile.armAngle),
  ).toBeLessThan(1)
  expect(
    Math.abs(offLeft.pitcherData.profile.travel - offRight.pitcherData.profile.travel),
    `the two deliveries travel ${offLeft.pitcherData.profile.travel.toFixed(4)}`
    + ` and ${offRight.pitcherData.profile.travel.toFixed(4)}`
    + ` (strides ${offLeft.pitcherData.profile.stride.toFixed(4)} / ${offRight.pitcherData.profile.stride.toFixed(4)},`
    + ` grounds ${offLeft.pitcherData.profile.ground.toFixed(4)} / ${offRight.pitcherData.profile.ground.toFixed(4)})`,
  ).toBeLessThan(0.01)
})

test('the back foot lands on the mound’s own slant, on the very spot the hold stands on', async ({ page }) => {
  // The finish owes the trail foot two things, and they are the two halves of one shape.
  //
  // The first is the *ground*: the mound is a level plateau ringed by a slope (see
  // constants/mound.js), and the swing carries the pivot foot off the rubber and forward
  // and down that slope — so the spot it comes down on is a place where the surface is
  // *falling*, a good 0.17 m below the plateau top on this delivery and a shade past the
  // halfway mark between the plateau's edge and the mound's own base. A shoe put down on
  // the level the body was placed at, or stood on the plateau's height out on the slope,
  // is a foot in the dirt or over it; what the delivery promises is the *slant's own*
  // surface under the spot. Read here off the driver's own ground rule, which reports the
  // world point it took the surface under, the surface's own height there, and the shoe's
  // lowest point beside it: the three agreeing is the whole of it, and `sink` is the rule's
  // own gap (nought for a shoe stood on the surface it was solved against).
  const frames = await sweepDelivery(page, 2.9)
  const at = (clip) => {
    const frame = frames.find((entry) => Math.abs(entry.clip - clip) < 0.02)
    expect(frame, `the sweep should cover ${clip}s`).not.toBeUndefined()
    return frame
  }
  const driveLeg = (frame) => {
    const leg = frame.legs.find((candidate) => candidate.side === 1)
    expect(leg, 'the sweep should carry the pivot foot').not.toBeUndefined()
    return leg
  }
  const landed = driveLeg(at(1.68))
  expect(landed.planted, 'the pivot foot is not down in the frame the delivery lands in').toBe(true)
  expect(landed.standing, 'the driver did not report the surface the landing shoe was stood on').not.toBeNull()
  const spot = landed.standing
  // ...the surface the rule used is the mound's own, read at the point it names.
  expect(
    Math.abs(spot.surface - moundSurfaceY(spot.at[0], spot.at[1])),
    `the landing shoe was stood on ${spot.surface.toFixed(4)} where the mound's own surface under it is ${moundSurfaceY(spot.at[0], spot.at[1]).toFixed(4)}`,
  ).toBeLessThan(1e-6)
  // ...the shoe's lowest point is *on* it, to a millimetre, and the rule had nothing to give.
  expect(
    Math.abs(spot.contact - spot.surface),
    `the landing shoe's lowest point stands ${((spot.contact - spot.surface) * 1000).toFixed(1)} mm off the dirt under it`,
  ).toBeLessThan(0.001)
  expect(
    Math.abs(landed.sink),
    `the ground rule had to give ${(landed.sink * 1000).toFixed(1)} mm to stand the landing shoe`,
  ).toBeLessThan(0.001)
  // ...and the spot is on the *slant* rather than on the plateau or out past the base:
  // below the mound's own top and above the field's plane, with a radius the mound's
  // slope owns outright.
  const radius = Math.hypot(spot.at[0] - MOUND.centre[0], spot.at[1] - MOUND.centre[1])
  expect(
    spot.surface,
    `the landing shoe is stood on ${spot.surface.toFixed(4)}, which is the mound's plateau rather than its slant`,
  ).toBeLessThan(MOUND.surface + MOUND.rise)
  expect(
    spot.surface,
    `the landing shoe is stood on ${spot.surface.toFixed(4)}, which is the field beyond the mound's base`,
  ).toBeGreaterThan(MOUND.surface + 0.01)
  console.log(
    `landing: the back shoe is stood on the mound's own slant at (${spot.at[0].toFixed(3)}, ${spot.at[1].toFixed(3)}) — `
    + `radius ${radius.toFixed(3)} of the ${MOUND.base.toFixed(3)} base, surface ${spot.surface.toFixed(4)} `
    + `against the plateau's own ${(MOUND.surface + MOUND.rise).toFixed(4)} · sole ${((spot.contact - spot.surface) * 1000).toFixed(1)} mm over the dirt`,
  )
  // ...and the hold stands on the same spot rather than drifting off it. The *foot* is
  // where it was put down: the ankle's place is the delivery's own (the keys author it and
  // nothing along the dirt moves it), held to a millimetre against the landing's.
  //
  // The *sole* under it rolls, and since the stride's plant was lengthened the pelvis goes
  // on travelling over the plant through the follow-through (see the finish's own keys):
  // the leg standing on that shoe turns another degree or two round its own axis as the
  // hip goes by, and the shoe — a shoe, not a pin — comes round with it, so the point the
  // ground rule stands it on travels across the slant. How far depends on how much of the
  // stand has been spent by 1.90 s, which is the stand's own pace (see STAND_PACE): 9.7 mm
  // at the keys' pace, 16.8 mm at twice it, and **23.3 mm** at the two and a half times it
  // is paced on, because the trunk has come 30° out of the fold by then. That is a shoe
  // pivoting on its cleats rather than a foot skating, and what the promise holds is the
  // bound: the foot does not move (to two millimetres), and the sole's own point stays
  // inside two and a half centimetres of where it came down, on a surface whose own height
  // under it changes by a millimetre.
  //
  // ...and it rolls a good deal further than that as the trunk comes back up out of the
  // fold: the stand is the shin's own angle changing over a shoe that stays on the ground
  // (see FINISH_STAND_FROM), so the point the sole stands on runs along the shoe from the
  // ball toward the heel — 32.4 mm by 2.80s. It is the same shoe on the same foot, and the
  // ankle above it does not move (read above, to two millimetres), so the two promises are
  // read apart: a centimetre through the hold, five of them by the frame the stand is done.
  for (const clip of [1.90, 2.80]) {
    const held = driveLeg(at(clip))
    expect(
      Math.hypot(held.ankle[0] - landed.ankle[0], held.ankle[2] - landed.ankle[2]),
      `the landing foot slides ${(Math.hypot(held.ankle[0] - landed.ankle[0], held.ankle[2] - landed.ankle[2]) * 1000).toFixed(1)} mm off the place it was put down on by ${clip}s`,
    ).toBeLessThan(0.002)
    expect(
      Math.hypot(held.standing.at[0] - spot.at[0], held.standing.at[1] - spot.at[1]),
      `the landing shoe rolls ${(Math.hypot(held.standing.at[0] - spot.at[0], held.standing.at[1] - spot.at[1]) * 1000).toFixed(1)} mm off the spot it was put down on by ${clip}s`,
    ).toBeLessThan(clip > 2 ? 0.05 : 0.025)
    expect(
      Math.abs(held.standing.surface - spot.surface),
      `the surface under the landing shoe changes between the landing and the hold`,
    ).toBeLessThan(clip > 2 ? 0.006 : 0.003)
  }
})

// ---------------------------------------------------------------------------
// His own half of a *play*: which way the body is turned.
//
// A pitcher standing in his delivery faces the plate, and the same rule turns him
// once a play has him: the body is aimed at what it is looking at — the fielding
// point while he runs it down, the man he is throwing to from his wind-up on
// (util/playCast.js's `defenseLookTarget`). One aim, two frames: a body of the
// *cast* is drawn in the asset's own frame, whose front is +Z, which is the front
// `facingYaw` points at a target — but this body is authored facing -Z and is
// mounted turned half round inside its group (Pitcher.jsx's `PITCHER_FRAME_TURN`),
// so an aim written straight on the group stands him facing exactly away from it.
//
// Read here off the group the body is really yawed by (the harness reads the
// scene's own `rotation.y`, so it cannot restate what the component meant to
// write), against two targets: the look target the play hands him, and — while the
// play is not his — the plate. The delivery is the calibration and the play is the
// claim: the same reading has to hold for both, and it is the reading the whole
// fielding half of his body is turned by.
//
// The harness is the *cast* one, which mounts the app's own <BattedBall> and the
// real <Pitcher> beside it (e2e/harness/castMain.jsx), and the play is the
// comebacker: hit back at the mound, gloved, and thrown to first.
// ---------------------------------------------------------------------------
const CAST_HARNESS = '/e2e/harness/cast.html?play=comeback'

/** The bearing the body's own front points along, off the yaw its group is turned by. */
const frontOf = (yaw) => [-Math.sin(yaw), -Math.cos(yaw)]

/** The bearing from a body to a world point, in the same x/z pair. */
const bearingTo = (from, x, z) => {
  const dx = x - from.x
  const dz = z - from.z
  const length = Math.hypot(dx, dz) || 1
  return [dx / length, dz / length]
}

/** The bearing of a direction already given as an x/z pair (the line a body ran). */
const bearingOf = (direction) => bearingTo({ x: 0, z: 0 }, direction.x, direction.z)

/** How far off its target a body's own front is, in degrees. */
const offBy = (sample, x, z) => {
  const [fx, fz] = frontOf(sample.yaw)
  const [tx, tz] = bearingTo(sample, x, z)
  return (Math.acos(Math.max(-1, Math.min(1, fx * tx + fz * tz))) * 180) / Math.PI
}

test('the body is turned to what the play has him looking at', async ({ page }) => {
  test.setTimeout(300_000)
  // Stopped the instant the harness publishes its clock, before the first cycle has
  // run: the harness is on real time, so a page left to its own devices is a page
  // whose delivery and sprint went by while the model was loading. Held here, both
  // halves are read off bodies the app really rendered — and the delivery is on
  // screen *first*, because the pitch is thrown at the top of the cycle.
  await page.addInitScript(() => {
    const stop = setInterval(() => {
      if (!window.__vr) return
      window.__vr.setTimeScale(0)
      clearInterval(stop)
    }, 1)
  })
  await page.goto(CAST_HARNESS)
  await page.waitForFunction(
    () => window.__vr?.ready === true && !!window.__vr.scene?.getObjectByName('pitcher'),
  )
  const samples = []
  const read = async () => {
    let sample = null
    try {
      sample = await page.evaluate(() => window.__vr.probeCast().pitcher)
    } catch (err) {
      // A dev server reloading under the run — Vite re-optimising a dependency, say —
      // throws the page's execution context away mid-read. This test reads for minutes
      // and a cycle is the *same* cycle however many times it is played, so the run is
      // picked up again on the reloaded page rather than lost: the samples are the
      // test's own (they live here, in Node, not in the page).
      if (!/Execution context was destroyed|Execution context is not available/.test(String(err))) throw err
      console.log('  (the page reloaded under the run — picking the cycle up again on the fresh one)')
      await page.goto(CAST_HARNESS)
      await page.waitForFunction(
        () => window.__vr?.ready === true && !!window.__vr.scene?.getObjectByName('pitcher'),
      )
      await page.evaluate(() => window.__vr.setTimeScale(0.08))
      return null
    }
    if (sample) samples.push(sample)
    return sample
  }
  for (let i = 0; i < 3; i += 1) await read()
  // ...and then the cycle, live and crawling: sampled as it renders, from the pitch
  // that starts it to the reset that ends the play and puts him back in his delivery.
  const started = Date.now()
  await page.evaluate(() => window.__vr.setTimeScale(0.08))
  let ranItThrough = false
  let backInHisDelivery = 0
  const seen = new Set()
  while (Date.now() - started < 240_000) {
    const sample = await read()
    if (sample?.field) {
      seen.add(sample.field.state)
      if (sample.field.clock > 3.5) ranItThrough = true
    } else if (ranItThrough) {
      backInHisDelivery += 1
      if (backInHisDelivery >= 3 && seen.has('Running') && seen.has('AssistThrow')) break
    }
    await page.waitForTimeout(30)
  }

  // Two bodies' worth of the same reading, and both have to be there: the frames
  // the play has taken over, which carry the look target, and the frames it has
  // not, which are the delivery. A run that never ran would otherwise pass this.
  const withThePlay = samples.filter((s) => s.field?.look)
  const inHisDelivery = samples.filter((s) => s && !s.field)
  const states = [...new Set(withThePlay.map((s) => s.field.state))]
  expect(withThePlay.length, 'the play never took his body over').toBeGreaterThan(10)
  expect(inHisDelivery.length, 'he was never seen in his delivery').toBeGreaterThan(1)
  expect(ranItThrough, 'the play never reached its own end').toBe(true)
  for (const state of ['Running', 'AssistThrow']) {
    expect(states, `the play never had him ${state} (saw ${states.join(', ')})`).toContain(state)
  }

  // While the play is not his, he is a pitcher in his delivery: facing the plate.
  // (The plate is the world's own origin — see FIELD.BASE.HOME.)
  const deliveryWorst = Math.max(
    ...inHisDelivery.map((s) => offBy(s, FIELD.BASE.HOME.x, FIELD.BASE.HOME.z)),
  )
  expect(
    deliveryWorst,
    `in his delivery the body is turned ${deliveryWorst.toFixed(2)}° off the plate`,
  ).toBeLessThan(2)

  // ...and once it is, at every frame of it: the sprint at the fielding point, the
  // catch pose at the plate, the wind-up turned to the man he throws to. The band is
  // the aim's own arithmetic — this is the reading that is either the target or its
  // opposite, so a degree is already generous.
  const worst = withThePlay
    .map((s) => ({ state: s.field.state, clock: s.field.clock, off: offBy(s, s.field.look.x, s.field.look.z) }))
    .sort((a, b) => b.off - a.off)[0]
  console.log(
    `fielding: ${withThePlay.length} frames over ${states.join('/')}, worst ${worst.off.toFixed(2)}° ` +
    `(${worst.state} at ${worst.clock}s) off the target it is looking at`,
  )
  expect(
    worst.off,
    `at ${worst.clock}s of the play, ${worst.state}, the body is turned ${worst.off.toFixed(1)}° off what it is looking at`,
  ).toBeLessThan(2)

  // ...and the sprint is not merely aimed at the fielding point: he is *running*
  // facing the way he runs. Read in the walk rather than in the schedule — the line
  // he actually travelled, from the first frame the play had him running to the last,
  // against his own front at every frame of it: a body that ran to a place while
  // looking elsewhere would be running sideways, and this is the reading that says it
  // did not. A body left turned to the plate would be a quarter turn off the line it
  // ran; a body turned to the bag behind it, a half.
  //
  // The comebacker's own leg is short — 0.42 s of the play's clock, 1.68 m from the
  // rubber to the point the ball comes to, because a ball hit back at the mound is
  // gloved where it was hit — so the frames that carry it are the handful of frames
  // the software rasterizer draws inside that window. Hence the two readings here are
  // the length he really walked and the one direction he walked it in, rather than a
  // count of samples.
  const steps = []
  let previous = null
  for (const sample of withThePlay) {
    if (previous && sample.field.clock > previous.field.clock) {
      const moved = Math.hypot(sample.x - previous.x, sample.z - previous.z)
      if (moved > 0.004) steps.push({ previous, sample, moved })
    }
    previous = sample
  }
  expect(steps.length, `the play moved him ${steps.length} times between samples`).toBeGreaterThan(2)
  // He really went the leg: the sampled walk adds up to the distance from the rubber
  // to the ball, read off the body rather than off the schedule.
  const walked = steps.reduce((sum, step) => sum + step.moved, 0)
  expect(walked, `he only came ${walked.toFixed(2)} m off the rubber`).toBeGreaterThan(1.2)
  // The line is drawn from the frame the play picked his body up (the spot he stood
  // on, read on the play's very first frames whatever the frame rate) to the point the
  // ball is coming to, which is what his own look target *is* for the whole of the
  // sprint (see `defenseLookTarget`). Neither end depends on how many frames of the
  // leg the rasterizer happens to draw — a sprint this short is five or six of them,
  // and the last one can land well short of the ball.
  const running = withThePlay.filter((s) => s.field.state === 'Running')
  const stood = withThePlay[0]
  const toTheBall = running[0].field.look
  const line = { x: toTheBall.x - stood.x, z: toTheBall.z - stood.z }
  const ranFor = Math.hypot(line.x, line.z)
  expect(ranFor, `the play was only read for ${ranFor.toFixed(2)} m of the run`).toBeGreaterThan(1.2)
  // ...and his front is read where the aim is a line at all: the frames he is still
  // well short of the ball in. Inside a metre the bearing to it swings wherever it
  // likes (it is a couple of strides away by then, and closing), and that is the
  // geometry of arriving rather than a body running the wrong way. He is only ever
  // *running* on the leg itself, so the frames after the catch are not read here
  // either — a body standing where the ball came to it, with the takeoff's own slide
  // finishing under him, is not a body under way.
  const readable = running.filter((s) => Math.hypot(s.x - s.field.look.x, s.z - s.field.look.z) > 0.9)
  expect(readable.length, 'no frame of the run was read while he was still short of the ball').toBeGreaterThan(0)
  const worstTurn = readable
    .map((s) => {
      const [fx, fz] = frontOf(s.yaw)
      const [tx, tz] = bearingOf(line)
      return { off: (Math.acos(Math.max(-1, Math.min(1, fx * tx + fz * tz))) * 180) / Math.PI, clock: s.field.clock }
    })
    .sort((a, b) => b.off - a.off)[0]
  console.log(
    `walk: ${steps.length} moving frames of ${withThePlay.length}, ${walked.toFixed(2)} m off the rubber, ` +
    `run line ${ranFor.toFixed(2)} m read at ${readable.length} frames, worst ${worstTurn.off.toFixed(2)}° ` +
    `between his front and the line he ran (at ${worstTurn.clock}s)`,
  )
  expect(
    worstTurn.off,
    `at ${worstTurn.clock}s of the play, running, he is turned ${worstTurn.off.toFixed(1)}° off the line he is running`,
  ).toBeLessThan(5)
})
