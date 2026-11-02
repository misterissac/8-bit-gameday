import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import {
  CHEER_HANDS,
  DRUM,
  FAN_SPRITE,
  HORN,
  LEGS,
  SEAT_RISE,
  bannerFrame,
  bannerHold,
  drumHold,
  fanFacing,
  fanHand,
  fanPlaneQuaternion,
  handsOf,
  hornCant,
  hornCutout,
  legLength,
  musicInstrument,
  musicPose,
  rowRight,
  texelToPlane,
} from '../src/util/fanSprites.js'

const near = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} should be ${expected}`)

const fan = (over = {}) => ({ x: 0, y: 0, z: 0, yaw: 0, scaleX: 1, scaleY: 1, ...over })

test('a texel sits where the 0.55 × 0.72 m plane puts it', () => {
  // The bottom-left corner texel, and the centre of the raised left hand.
  const corner = texelToPlane([0, 31])
  near(corner.x, -FAN_SPRITE.width / 2)
  near(corner.y, FAN_SPRITE.height / 32)

  const hand = texelToPlane(CHEER_HANDS.raise.left)
  near(hand.x, (5.5 / 32 - 0.5) * 0.55) // the grip is centred on texels 4-6
  near(hand.y, (1 - CHEER_HANDS.raise.left[1] / 32) * 0.72) // …and three rows tall

  // The sprite's own scale stretches the point with it.
  const scaled = texelToPlane(CHEER_HANDS.raise.left, 1.1, 0.9)
  near(scaled.x, hand.x * 1.1)
  near(scaled.y, hand.y * 0.9)
})

test('the raised hands stand at the top of the sprite, mirrored either side', () => {
  const { left, right } = handsOf(fan(), 'raise')
  const grip = texelToPlane(CHEER_HANDS.raise.left)
  near(left.x, -right.x)
  near(left.y, right.y)
  near(left.y, grip.y * Math.cos(FAN_SPRITE.lean))
  assert.ok(left.y > 0.65, 'overhead pose: hands at the top of the 0.72 m sprite')
  // The plane's own lean puts the hand slightly behind its feet.
  near(left.z, grip.y * Math.sin(FAN_SPRITE.lean), 1e-9)

  // The two music poses reach forward, not up: the horn's hands meet at the
  // mouthpiece under the chin, the drum's sit out at the waist. Neither is
  // anywhere near the overhead grip.
  const play = handsOf(fan(), 'play')
  assert.ok(play.left.y < left.y - 0.25, 'the horn is blown below the raised hands')
  assert.ok(play.left.y > 0.28, 'at the chin, not down on the chest')
  assert.ok(Math.abs(play.left.x) < 0.1, 'with the hands brought in to the mouthpiece')
  assert.ok(Math.abs(play.left.x) > 0.03, 'either side of it, not on the centreline')

  const drum = handsOf(fan(), 'drum')
  assert.ok(drum.left.y < play.left.y - 0.05, 'the drum is worn below the horn')
  assert.ok(drum.left.y > 0.18, 'but above the hips, not over the legs')
  assert.ok(Math.abs(drum.left.x) > 0.12, 'and gripped a drum’s width apart')
})

test('a fan sits its hands on its own seat, facing the way it is yawed', () => {
  const seat = fan({ x: 3, y: 2.5, z: -8, yaw: Math.PI / 2 })
  const hand = fanHand(seat, CHEER_HANDS.raise.right)
  const facing = fanFacing(seat.yaw)
  near(facing.x, 1)
  near(facing.z, 0)
  // Yawed a quarter turn, the sprite's +x now runs along -z: the right hand
  // (at +x in the sprite) ends up 0.18 m along -z, and the lean's backward
  // 0.055 m goes into world z as well (the lean is about the park's x axis).
  const grip = texelToPlane(CHEER_HANDS.raise.right)
  const sinLean = Math.sin(FAN_SPRITE.lean)
  const cosLean = Math.cos(FAN_SPRITE.lean)
  near(hand.x, 3, 1e-9)
  near(hand.z, -8 - grip.x * cosLean + grip.y * sinLean, 1e-9)
  near(hand.y, 2.5 + grip.y * cosLean + grip.x * sinLean, 1e-9)
})

test('the grips sit on the plane the sprite is actually drawn with', () => {
  // three's Euler order `XYZ` multiplies Rx · Ry — the lean is taken about the
  // park's x axis *after* the yaw, not about the sprite's own one. A grip laid
  // out any other way drifts off the drawn plane (up to 6 cm at these sizes),
  // which is enough for a banner to hang off the palms and for a trumpet to
  // disappear inside the fan holding it.
  for (const yaw of [0, 0.35, 2.2, -2.8]) {
    const seat = fan({ x: 4, y: 1.5, z: -6, yaw, scaleX: 1.03, scaleY: 0.97 })
    const drawn = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(FAN_SPRITE.lean, yaw, 0, 'XYZ'),
    )
    for (const pose of ['raise', 'play']) {
      for (const side of ['left', 'right']) {
        const grip = texelToPlane(CHEER_HANDS[pose][side], seat.scaleX, seat.scaleY)
        const onPlane = new THREE.Vector3(grip.x, grip.y, 0)
          .applyMatrix4(drawn)
          .add(new THREE.Vector3(seat.x, seat.y, seat.z))
        assert.ok(
          fanHand(seat, CHEER_HANDS[pose][side]).distanceTo(onPlane) < 1e-9,
          `${pose} ${side} at yaw ${yaw} should land on the plane the sprite is drawn on`,
        )
      }
    }
  }
})

test('a banner hangs from the two hands it is held by, facing the field', () => {
  const facing = fanFacing(0)
  const { left, right } = handsOf(fan(), 'raise')
  const height = 0.3
  const frame = bannerFrame(left, right, facing, height)

  // The bottom corners of the cloth are the two grips.
  const toWorld = (u, v) => new THREE.Vector3(u, v, 0)
    .applyQuaternion(frame.quaternion)
    .add(frame.position)
  const bottomLeft = toWorld(-frame.width / 2, -height / 2)
  const bottomRight = toWorld(frame.width / 2, -height / 2)
  assert.ok(bottomLeft.distanceTo(left) < 1e-6, 'left end sits in the left hand')
  assert.ok(bottomRight.distanceTo(right) < 1e-6, 'right end sits in the right hand')
  near(frame.width, right.x - left.x)
  near(frame.position.y, left.y + height / 2)

  // Upright, and its face on the field.
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(frame.quaternion)
  assert.ok(normal.distanceTo(facing) < 1e-6)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(frame.quaternion)
  assert.ok(up.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6)
})

test('the banner keeps its text the right way round seen from the field', () => {
  // A row running along -x to +x, crowd facing +z (the field): the cloth's
  // left end (u = 0) must be the -x hand, so the slogan reads left to right.
  const facing = fanFacing(0)
  const hands = handsOf(fan(), 'raise')
  const frame = bannerFrame(hands.left, hands.right, facing, 0.3)
  const leftEnd = new THREE.Vector3(-frame.width / 2, 0, 0)
    .applyQuaternion(frame.quaternion)
    .add(frame.position)
  assert.ok(leftEnd.x < 0, 'u = 0 end is at -x')

  // Turn the crowd around: the same rule holds from the other side.
  const away = fanFacing(Math.PI)
  const turned = bannerFrame(hands.left, hands.right, away, 0.3)
  const turnedLeft = new THREE.Vector3(-turned.width / 2, 0, 0)
    .applyQuaternion(turned.quaternion)
    .add(turned.position)
  assert.ok(turnedLeft.x > 0, 'seen from -z, u = 0 is now the +x hand')
})

test('a row that runs askew to its facing still holds an upright, unmirrored cloth', () => {
  // The infield stands' spline row is not perpendicular to the crowd's average
  // facing, which is what flipped an orthogonalised basis and printed the
  // slogan backwards. The frame is yaw-only now: up is always up, and the face
  // always turns toward the field.
  const facing = fanFacing(2.33)
  const left = new THREE.Vector3(-0.2, 0.62, 0)
  const right = new THREE.Vector3(0.2, 0.62, 0)
  const frame = bannerFrame(left, right, facing, 0.42)

  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(frame.quaternion)
  assert.ok(up.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9, 'the cloth is upright')
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(frame.quaternion)
  assert.ok(normal.dot(facing) > 0, 'its face turns toward the field, not away')
  near(frame.width, 0.4)
  const ends = [-1, 1].map((s) => new THREE.Vector3(s * frame.width / 2, -0.21, 0)
    .applyQuaternion(frame.quaternion)
    .add(frame.position))
  assert.ok(Math.min(ends[0].distanceTo(left), ends[1].distanceTo(left)) < 1e-6)
  assert.ok(Math.min(ends[0].distanceTo(right), ends[1].distanceTo(right)) < 1e-6)
})

// A show row on its own seats: ten seats shoulder to shoulder, which on the
// stands' arc bow the row a few centimetres out of the chord the cloth spans.
// The cloth is straight, so what a hand may not do is fall off its *height*:
// the fans keep their own seats, and the row's bow is depth, not level.
test('every raised hand along a show row lands on the cloth it holds', () => {
  const check = (facing, bow = 0) => {
    // The row runs across the facing, not across the world: a fan's own right
    // is what its hands are measured along. The bow is the stands' arc, so it
    // is depth — along the facing — and leaves the row's level alone.
    const right = rowRight(facing)
    const row = Array.from({ length: 10 }, (_, i) => {
      const at = (i - 4.5) * 1.3
      const bend = bow * Math.sin((Math.PI * i) / 9)
      return fan({
        x: right.x * at + facing.x * bend,
        y: 2.64,
        z: -18 + right.z * at + facing.z * bend,
        yaw: Math.atan2(facing.x, facing.z),
        scaleX: 1.02,
        scaleY: 0.98,
      })
    })
    const hold = bannerHold(row, facing)
    const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(hold.quaternion)
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(hold.quaternion)
    const edgeLeft = hold.leftEnd
    const edgeRight = edgeLeft.clone().addScaledVector(xAxis, hold.width)
    const along = rowRight(facing)
    const aL = along.dot(edgeLeft)
    const aR = along.dot(edgeRight)
    const aMin = Math.min(aL, aR)
    const aMax = Math.max(aL, aR)

    // The cloth is level along a levelled row (to the sprites' own lean, which
    // lifts one hand of a pair a little more than the other), and reaches past
    // both holders.
    near(edgeLeft.y, edgeRight.y, 0.03)
    assert.ok(hold.width > 9 * 1.3, 'the cloth spans the whole row')

    // The cloth is numbered by the same coordinate the spectators are: the
    // holders sit at s = 0 and s = 1, so the hands on the cloth's ends and the
    // ends of the cloth ride the identical point of the wave.
    const sOfPoint = (p) => hold.sLeft + ((along.dot(p) - aL) / (aR - aL)) * hold.sSpan
    const holderS = [sOfPoint(row[0]), sOfPoint(row[row.length - 1])].sort((a, b) => a - b)
    near(holderS[0], 0, 1e-9)
    near(holderS[1], 1, 1e-9)

    // Both hands of the two holders are on it — the outer one is what holds
    // the corner — and so are both hands of everyone between them. Nobody is
    // left pumping an empty fist beside the banner.
    for (const member of row) {
      const hands = handsOf(member, 'raise')
      for (const hand of [hands.left, hands.right]) {
        const a = along.dot(hand)
        assert.ok(a > aMin && a < aMax, 'the hand is inside the cloth’s span')
        assert.ok(
          Math.abs(hand.y - edgeLeft.y) < 0.035,
          `the hand is on the cloth’s bottom edge (${(hand.y - edgeLeft.y).toFixed(3)} m off)`,
        )
        // The seat's own bow may stand a hand a little behind the straight
        // cloth; it may not carry it off the row.
        assert.ok(
          Math.abs(hand.clone().sub(edgeLeft).dot(normal)) < 0.12,
          `the hand is within the row’s bow of the cloth (${Math.abs(hand.clone().sub(edgeLeft).dot(normal)).toFixed(3)} m off)`,
        )
      }
    }
    // The cloth's two ends sit within a palm's width of a hand.
    for (const end of [edgeLeft, edgeRight]) {
      const nearest = Math.min(...row.flatMap((member) => {
        const hands = handsOf(member, 'raise')
        return [hands.left.distanceTo(end), hands.right.distanceTo(end)]
      }))
      assert.ok(nearest < 0.1, 'a hand holds the cloth at its end')
    }
  }

  check(fanFacing(0))
  // The infield row is yawed well off the park's own axes, where the sprites'
  // lean lifts one hand of a pair more than the other.
  check(fanFacing(2.33))
  // ...and its seats bow out of the chord the cloth spans.
  check(fanFacing(2.33), 0.09)
})

test('a music row alternates horns and drums, each with its own grip', () => {
  // The row's sprites and its props must agree on who is holding what: the
  // instrument assignment is one function, read by both.
  assert.deepEqual([0, 1, 2, 3, 4].map(musicInstrument), [
    'trumpet', 'drum', 'trumpet', 'drum', 'trumpet',
  ])
  assert.deepEqual([0, 1, 2, 3].map(musicPose), ['play', 'drum', 'play', 'drum'])

  // A drum hangs from the drum pose's hands, which are below the horn's: the
  // drum is worn at the waist, the horn is blown at the chin.
  const record = fan()
  const drum = drumHold(record)
  const hornHands = handsOf(record, 'play')
  for (const end of drum.ends) {
    assert.ok(end.y < hornHands.left.y - 0.05, 'the drum is held below the horn')
  }
})

test('a horn is a cut-out standing across the fan, borne by both hands', () => {
  const facing = fanFacing(0)
  const hands = handsOf(fan({ x: 2, y: 3, z: -9 }), 'play')
  const horn = hornCutout(hands.left, hands.right, facing)

  // The grip is the midpoint between the palms, on the valve block, and the
  // card runs out from it along its own +x to the bell. The mouthpiece end
  // reaches back from the grip toward the player's face, not through it.
  const mid = new THREE.Vector3().addVectors(hands.left, hands.right).multiplyScalar(0.5)
  assert.ok(horn.position.distanceTo(mid) < 1e-9, 'held between the palms')
  near(horn.length, HORN.length)
  near(horn.mouth.distanceTo(horn.position), HORN.grip, 1e-9)
  assert.ok(horn.mouth.clone().sub(mid).dot(facing) < -0.05, 'the mouthpiece is at the player')
  assert.ok(horn.bell.clone().sub(mid).dot(facing) > 0.3, 'the bell is out over the field')
  assert.ok(horn.bell.y > mid.y, 'and climbs above the hands')

  // A horn aimed square to the field points out along it and up: its only aim
  // components are the field line and the climb, so no seat and no view can
  // turn it.
  near(horn.direction.dot(facing), Math.cos(HORN.tilt), 1e-9)
  near(horn.direction.dot(rowRight(facing)), 0, 1e-9)
  near(horn.direction.y, Math.sin(HORN.tilt), 1e-9)
  assert.ok(horn.direction.dot(facing) > 0.9, 'the bell is aimed at the field')

  // A canted horn — how the row is formed — is that same horn swung about the
  // park's vertical: it keeps its climb, loses only cos(cant) of its reach
  // downfield, and opens a component along the row. That component is what
  // stops the profile card from being edge-on to a camera in front of the row.
  const canted = hornCutout(hands.left, hands.right, facing, { cant: HORN.cant })
  near(canted.direction.dot(facing), Math.cos(HORN.tilt) * Math.cos(HORN.cant), 1e-9)
  near(canted.direction.dot(rowRight(facing)), Math.cos(HORN.tilt) * Math.sin(HORN.cant), 1e-9)
  near(canted.direction.y, Math.sin(HORN.tilt), 1e-9)
  near(canted.direction.length(), 1, 1e-9)
  assert.ok(canted.direction.dot(facing) > 0.85, 'a canted bell still aims at the field')
  assert.ok(Math.abs(canted.direction.dot(rowRight(facing))) > 0.25, 'and is not edge-on to it')
  assert.ok(canted.position.distanceTo(mid) < 1e-9, 'it turns about the brace in the palms')
  // The formation alternates down the row, so neither side of the park is
  // shown a line of edge-on cards.
  assert.ok(hornCant(0) > 0, 'the first horn opens one way')
  assert.ok(hornCant(2) < 0, 'the next the other')
  assert.ok(hornCant(4) > 0, 'and so on down the row')
  near(Math.abs(hornCant(9)), HORN.cant)

  // The card stands *across* the fan's plane: its normal is the row's axis, so
  // the field sees it edge-on with the bell out at them, and the neighbours in
  // the row are the ones who see the silhouette. Flat in the fan's own plane
  // it would read as a sticker on the player's chest.
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(horn.quaternion)
  near(normal.y, 0, 1e-9)
  near(Math.abs(normal.dot(rowRight(facing))), 1, 1e-9)
  // Local +y is upright in the card, so the valve caps sit on the tube rather
  // than tipped with the row's yaw.
  const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(horn.quaternion)
  assert.ok(yAxis.y > 0.9)
  // ...and the palms are on either side of that plane, closing on the tube.
  const dl = hands.left.clone().sub(horn.position).dot(normal)
  const dr = hands.right.clone().sub(horn.position).dot(normal)
  assert.ok(dl * dr < 0, 'one hand each side of the horn’s card')
  near(dl + dr, 0, 1e-9)

  // Canted, the card's normal turns with the horn by the same angle: it still
  // stands on the horn's own line rather than on a line to any camera.
  const cantedNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(canted.quaternion)
  near(cantedNormal.y, 0, 1e-9)
  near(Math.abs(cantedNormal.dot(rowRight(facing))), Math.cos(HORN.cant), 1e-9)
  const dcL = hands.left.clone().sub(canted.position).dot(cantedNormal)
  const dcR = hands.right.clone().sub(canted.position).dot(cantedNormal)
  assert.ok(dcL * dcR < 0, 'the palms stay either side of a canted card')

  // The same rule holds on a row yawed the other way.
  const away = fanFacing(2.33)
  const turned = hornCutout(hands.left, hands.right, away)
  near(turned.direction.dot(away), Math.cos(HORN.tilt), 1e-9)
  near(turned.direction.dot(rowRight(away)), 0, 1e-9)
})

test("a standing fan's legs run from the step under the seat to its hip", () => {
  // Every spectator sits SEAT_RISE above the step its feet would stand on, so
  // the leg strip is that rise plus however far the row has lifted — and never
  // shorter than the seat, so a seated fan's strip is collapsed to nothing
  // rather than left dangling under the seat.
  near(legLength(0), SEAT_RISE)
  near(legLength(0.23), SEAT_RISE + 0.23)
  near(legLength(-0.05), SEAT_RISE)
  const stretch = legLength(0.23) / LEGS.height
  assert.ok(stretch > 0.8 && stretch < 1.1, 'the strip of that height suits the stand')
  assert.ok(LEGS.width < FAN_SPRITE.width, 'the legs are narrower than the sprite')
})

test('a drum hangs flat in the fan’s plane, gripped at its top corners', () => {
  const record = fan({ x: 1, y: 3, z: -5 })
  const hands = handsOf(record, 'drum')
  const drum = drumHold(record)

  // The card wears the fan's own rotation — lean and all — so it lies *in* the
  // cut-out's plane instead of standing plumb in front of a leaning sprite.
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(drum.quaternion)
  const plane = new THREE.Vector3(0, 0, 1).applyQuaternion(fanPlaneQuaternion(record.yaw))
  assert.ok(normal.distanceTo(plane) < 1e-9)

  // Its top corners are the play pose's two hands, a centimetre out toward the
  // field so the cut-out clears the torso: the hands hold the sticks drawn on
  // those corners, and the drum hangs under them.
  const card = new THREE.Matrix4().compose(
    drum.position,
    drum.quaternion,
    new THREE.Vector3(1, 1, 1),
  )
  const corner = (side) => new THREE.Vector3(side * drum.width / 2, drum.height / 2, 0)
    .applyMatrix4(card)
  for (const [point, hand] of [[corner(-1), hands.left], [corner(1), hands.right]]) {
    // The corner is nudged out toward the field and dropped a little under the
    // palm, so the hand reads above the drum's top edge instead of behind it.
    near(point.distanceTo(hand), Math.hypot(DRUM.float, DRUM.drop), 1e-6)
    assert.ok(point.y < hand.y, 'the card hangs below the palms')
  }
  assert.ok(drum.position.y < (hands.left.y + hands.right.y) / 2, 'the body hangs below the grips')
})
