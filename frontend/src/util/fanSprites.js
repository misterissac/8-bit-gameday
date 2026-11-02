import * as THREE from 'three'

// ---------------------------------------------------------------------------
// The crowd's sprite geometry, in one place.
//
// Every spectator is one 32 × 32 pixel sprite on a 0.55 × 0.72 m plane whose
// bottom edge sits on the seat cushion (`fanQuadGeom` in Ballpark), leaned
// back a little and yawed to face the field. The show clusters wear a cheer
// pose drawn by Ballpark's `createPixelFanTextureCheer` — this module owns the
// *hold points* on those poses, so the banner, the trumpets and the drums can
// be put exactly where the hands the sprite draws actually are, instead of
// floating near the fans.
//
// The texel pairs below must stay in step with that drawing: `raise` is the
// both-arms-overhead pose (hands three pixels wide, at the very top of the
// sprite, so the cloth they hold clears the heads under it), `play` reaches
// both hands forward to the mouthpiece at the chin, and `drum` puts them out at
// the waist where a marching drum's sticks are gripped. A test pins the
// projection; the harness page (e2e/harness/crowd.html) is how the drawing
// itself is checked.
// ---------------------------------------------------------------------------

export const FAN_SPRITE = {
  // The plane's size (Ballpark's fanQuadGeom)…
  width: 0.55,
  height: 0.72,
  // …and its lean, the -0.08 rad about X every fan is drawn with.
  lean: -0.08,
  // The sprite is 32 × 32 texels.
  texels: 32,
}

// The centre of the grip a pose's hand draws, in texel coordinates (a texel
// covers [col, col + 1) × [row, row + 1), so a three-texel block spanning
// columns 4-6 has its centre at 5.5).
//
// The two music poses reach *forward* rather than up: `play` brings both hands
// in to the mouthpiece at the chin, the horn's brace between the palms, and
// `drum` puts them out at the waist, a drum's width apart, where a marching
// drum's sticks are gripped. Neither is drawn beside the head any more -- a row
// of hands up at its ears read as a cheer, whatever was floating near them.
export const CHEER_HANDS = {
  raise: { left: [5.5, 1.5], right: [26.5, 1.5] },
  play: { left: [10.5, 15.5], right: [21.5, 15.5] },
  drum: { left: [8.5, 21.5], right: [23.5, 21.5] },
}

// Which instrument the nth musician in a music row plays: trumpets and drums
// alternate along the row. Both the sprite the fan wears and the prop laid in
// its hands read the assignment here, so a drummer is never handed a horn's
// grip and the row never shows two different shuffles.
export function musicInstrument(i) {
  return i % 2 === 0 ? 'trumpet' : 'drum'
}

export function musicPose(i) {
  return musicInstrument(i) === 'drum' ? 'drum' : 'play'
}

// A point on the fan's own plane, in metres from the sprite's bottom-centre
// (the plane is anchored at the feet, +x to the fan's right). ``col`` and
// ``row`` are texel *centres*, so a three-texel hand spanning columns 4-6 is
// (5.5, 4.5).
export function texelToPlane([col, row], scaleX = 1, scaleY = 1) {
  const { width, height, texels } = FAN_SPRITE
  return {
    x: (col / texels - 0.5) * width * scaleX,
    y: (1 - row / texels) * height * scaleY,
  }
}

// Where a fan's hand is in the park: the pose's texel taken onto the sprite's
// leaned plane, then that plane yawed to face the field, then sat on the seat.
//
// The rotation is the one the sprite is *drawn* with: three's Euler order
// `XYZ`, which is `Rx(lean) · Ry(yaw)` — the lean is taken about the park's own
// x axis, after the yaw, not about the sprite's own one. So a hand at height y
// leans by `y · sin(lean)` in world z, and the yaw shortens the sprite's x by
// `cos(lean)`. Laying the grip out in the sprite's own frame instead puts it up
// to 6 cm off the plane the sprite is drawn on, which is enough to bury a held
// trumpet inside the fan blowing it.
export function fanHand(fan, texel) {
  const { x, y } = texelToPlane(texel, fan.scaleX ?? 1, fan.scaleY ?? 1)
  const cosLean = Math.cos(FAN_SPRITE.lean)
  const sinLean = Math.sin(FAN_SPRITE.lean)
  const cos = Math.cos(fan.yaw)
  const sin = Math.sin(fan.yaw)
  return new THREE.Vector3(
    fan.x + x * cos,
    fan.y + y * cosLean + x * sinLean * sin,
    fan.z - x * sin * cosLean + y * sinLean,
  )
}

// The direction a fan faces: the sprite's own +z, yawed. (Ballpark yaws every
// fan as atan2(-n.x, -n.z) toward the field, so this is the field-ward line.)
export function fanFacing(yaw, target = new THREE.Vector3()) {
  return target.set(Math.sin(yaw), 0, Math.cos(yaw))
}

// The row's own axis as the field sees it: + is the viewer's right. A banner,
// a row of fans and the wave that runs along them all use this line.
export function rowRight(facing, target = new THREE.Vector3()) {
  const theta = Math.atan2(facing.x, facing.z)
  return target.set(Math.cos(theta), 0, -Math.sin(theta))
}

// A pose's two hands, in world space.
export function handsOf(fan, pose = 'raise') {
  const grip = CHEER_HANDS[pose]
  return {
    left: fanHand(fan, grip.left),
    right: fanHand(fan, grip.right),
  }
}

// The frame a banner held between two hands needs: the two grips lie on its
// bottom corners, the cloth stands up from them, and it faces the field with
// its text the right way round (u = 0 at the field's left).
//
// `facing` is the crowd's field-ward direction. With the plane's +z on it, +x
// has to run from the viewer's left hand to the right one — so the two grips
// are ordered by their projection onto the viewer's own right ((cos θ, 0,
// -sin θ), the way a camera on the field sees them), not by seat order.
export function bannerFrame(leftHand, rightHand, facing, height) {
  const width = new THREE.Vector3().subVectors(rightHand, leftHand).setY(0).length()
  // The reading direction, from one grip to the other. It is flipped if need
  // be so that the plane's face — (-x.z, 0, x.x) for a yaw-only rotation —
  // turns toward the field instead of away from it: the cloth seen from
  // behind would print its slogan mirrored. Yaw only, so the cloth can never
  // come out upside down on a row whose fans face an awkward way.
  const dir = new THREE.Vector3().subVectors(rightHand, leftHand).setY(0).normalize()
  if (dir.x * facing.z - dir.z * facing.x < 0) dir.negate()
  const theta = Math.atan2(-dir.z, dir.x)

  const position = new THREE.Vector3().addVectors(leftHand, rightHand).multiplyScalar(0.5)
  position.y += height / 2
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, theta, 0))
  return { position, quaternion, width, direction: dir }
}

// The fan sprite's own plane: the lean and the yaw the instanced quad is drawn
// with (three's XYZ order is Rx(lean) · Ry(yaw)). A prop that is meant to read
// as part of the cut-out — the drum — takes this rotation whole, so it lies in
// the same plane as the fan instead of standing plumb in front of a leaning
// sprite.
export function fanPlaneQuaternion(yaw) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(FAN_SPRITE.lean, yaw, 0, 'XYZ'))
}

// A drum held flat with the fan's cut-out: a card in the sprite's own plane,
// its top edge across the two drum-pose grips and its body hanging between and
// below them, at the waist. The sticks are drawn on the card's top corners,
// where those hands are, so the player is visibly holding the sticks rather
// than resting their hands on an instrument floating in front of them.
//
// The card is nudged a centimetre along the plane's normal, toward the field,
// so its cut-out sits over the torso without z-fighting the sprite behind it.
export const DRUM = {
  // The card's height, in metres: the grip row at the top, the drum hanging
  // under it over the player's belt. Its width is taken from the hands, not
  // fixed, so it fits every row's fan scale.
  height: 0.22,
  float: 0.012,
  // How far the card hangs below the palms, so the hands show above its top
  // edge. The sticks' grips are at the card's top corners, which still land
  // inside the three-texel hand they are held in.
  drop: 0.02,
}

export function drumHold(fan, {
  height = DRUM.height,
  float = DRUM.float,
  drop = DRUM.drop,
  pose = 'drum',
} = {}) {
  const { left, right } = handsOf(fan, pose)
  const mid = new THREE.Vector3().addVectors(left, right).multiplyScalar(0.5)
  const quaternion = fanPlaneQuaternion(fan.yaw)
  const inverse = quaternion.clone().invert()
  // The grips' own half-span in the card's plane, measured rather than assumed:
  // the card's top corners then land exactly on the two hands, whatever the
  // fan's scale or the row's yaw.
  const halfWidth = Math.abs(left.clone().sub(mid).applyQuaternion(inverse).x)
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion)
  const position = mid.clone()
    .addScaledVector(normal, float)
    .addScaledVector(up, -height / 2 - drop)
  return { position, quaternion, width: halfWidth * 2, height, ends: [left, right] }
}

// The banner a whole row holds.
//
// Every fan in a show row wears the raised pose, so *both* hands of the two
// end fans are up — and the cloth spans from the left holder's outer hand to
// the right holder's, which is the only way every raised hand in the row ends
// up on it: the inner hands of the holders and both hands of everyone between
// them all lie on the cloth's bottom edge, and nobody is left pumping an empty
// fist at the sky. (Gripping with the inner hands only left each end fan's
// outer arm waving beside the banner.)
//
// The row keeps its own seats (Ballpark's `seatRow`): the holders are the end
// fans, and the cloth is the chord between their hands. The seats' own bow bends
// the row up to a hand's width away from that chord in depth, but not in height,
// so every grip still shares the cloth's bottom edge and `sAt` is linear along
// it: the returned ``sLeft`` / ``sSpan`` map a point on the cloth's own x axis to
// the row's coordinate ``s`` (0 at the left holder, 1 at the right), which is
// what the wave in util/showMotion.js is written in.
export const BANNER = {
  // How tall the cloth stands above the hands, clear of the row's heads.
  height: 0.42,
  // Its bottom edge rests a little above the grip, so the fingers show on it.
  lift: 0.012,
  // How far the cloth reaches past each palm.
  overhang: 0.14,
  // A banner texel's world height; its length is cut to match (one pixel per
  // texel), so the slogan is never stretched along the row.
  texelHeight: 0.0175,
}

export function bannerHold(fans, facing, {
  height = BANNER.height,
  lift = BANNER.lift,
  overhang = BANNER.overhang,
} = {}) {
  const right = rowRight(facing)
  const along = (v) => right.x * v.x + right.z * v.z
  const ordered = [...fans].sort((a, b) => along(a) - along(b))
  const leftFan = ordered[0]
  const rightFan = ordered[ordered.length - 1]
  // The holders' outer hands: the cloth reaches past them by `overhang`.
  const leftGrip = handsOf(leftFan, 'raise').left
  const rightGrip = handsOf(rightFan, 'raise').right

  const frame = bannerFrame(leftGrip, rightGrip, facing, height)
  const width = frame.width + overhang
  const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(frame.quaternion)
  const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(frame.quaternion)
  // The cloth's own bottom-left corner: the pivot the roll starts from, sitting
  // in the palms rather than through them.
  const leftEnd = frame.position.clone()
    .addScaledVector(yAxis, lift)
    .addScaledVector(xAxis, -width / 2)
    .addScaledVector(yAxis, -height / 2)

  // The row coordinate at the cloth's left end and across its width, so the
  // wave can be sampled at any point on the cloth.
  const rowSpan = along(rightFan) - along(leftFan)
  const alongLeft = along(leftEnd)
  const alongRight = along(new THREE.Vector3().copy(leftEnd).addScaledVector(xAxis, width))
  const sLeft = (alongLeft - along(leftFan)) / rowSpan
  const sSpan = (alongRight - alongLeft) / rowSpan

  return {
    leftEnd,
    quaternion: frame.quaternion,
    width,
    ends: [leftGrip, rightGrip],
    holders: [leftFan, rightFan],
    sLeft,
    sSpan,
    // A point ``u`` of the way across the cloth (0 = left end, 1 = right end),
    // as the row coordinate the wave is written in.
    sAt: (u) => sLeft + u * sSpan,
  }
}

// The step a spectator's feet stand on: the seat cushion is this far above it.
// (Ballpark sits every fan at `floor + SEAT_RISE`; a standing fan's legs reach
// from the step under the seat up to the sprite's hip.)
export const SEAT_RISE = 0.16

// A standing fan's legs: the strip Ballpark stretches from the step under the
// seat up to the sprite's hip. The sprites are drawn from the hips up, so a row
// that stands to wave or to play is otherwise a row of torsos floating over its
// seats. The strip is kept vertical and stretched to exactly reach the hip, so
// its length is the seat's rise plus however far the row has lifted.
export const LEGS = {
  width: 0.30,
  height: 0.42,
  // The trousers/shirt colours are the cheer poses' own colourways; the socks
  // and shoes are the same on all of them.
  sock: '#f2f3ee',
  shoe: '#171b22',
}

export function legLength(lift) {
  return SEAT_RISE + Math.max(0, lift)
}

// A trumpet is a flat cut-out, like the fans and the drum — but its card lies
// *across* theirs. A fan's plane faces the field; a horn's plane stands on that
// facing and on the row's upright, so its normal is close to the row's own axis
// and the card is seen side-on as the bell points out at the field. Laid in the
// fan's plane it would read as a sticker on the player's chest; standing on the
// facing the way a real horn points keeps it a prop in the crowd's world.
//
// The bell is the exception: its *mouth* is a disc whose normal is the horn's
// aim, so a camera in front of the row — where the profile card is edge-on and
// all but invisible — still finds the instrument. See `HORN.cant` for the
// formation angle that keeps the card itself off the edge-on line.
//
// The card is built from its grip: local +x is the horn's axis (up and at the
// field), local +y is upright in the card, and local +z is the row's axis. The
// hands stand on either side of that plane at the grip, so they hold the tube
// instead of resting behind a mouthpiece held out in the air.
export const HORN = {
  // Mouthpiece to bell rim, in metres.
  length: 0.44,
  // How far the bell climbs above the mouthpiece over that length (~17°).
  tilt: 0.3,
  // Where the hands close on the tube, measured back from the bell rim: the
  // brace on the lead pipe, with the valve block just beyond the palms and the
  // mouthpiece reaching back at the player.
  grip: 0.09,
  // The card's height, so the art and the layout agree on the bell's size.
  height: 0.17,
  // The bell's own diameter, so the art and the layout agree on its size.
  bell: 0.15,
  // How far each horn is turned off the row's field-ward line, alternating
  // along the row. A card aimed exactly at the field is *edge-on* to a camera
  // there: the profile is a one-pixel line and the player reads as holding
  // nothing. A fixed cant of the formation (not a turn to the camera) keeps
  // every other horn's silhouette open from the plate while the bells still
  // point at the field to within 22°; taken along the row it alternates, so no
  // side of the park ever sees a row of bare hands.
  cant: 0.38,
}

// The frame of a flat horn held in both hands: ``position`` is the grip between
// the palms, local +x runs out along the bell (up and at the field), and local
// +y is the card's own upright. The card itself is centred on
// ``length / 2 - grip`` from the grip.
export function hornCutout(leftHand, rightHand, facing, {
  length = HORN.length,
  tilt = HORN.tilt,
  grip = HORN.grip,
  height = HORN.height,
  cant = 0,
} = {}) {
  const position = new THREE.Vector3().addVectors(leftHand, rightHand).multiplyScalar(0.5)
  // The bell's line: the row's field-ward direction swung by the horn's cant
  // about the park's vertical, then lifted through the tilt. It is still a
  // line in the park, not a line at the camera, so the horn holds a direction
  // of its own from every seat and every view.
  const cos = Math.cos(cant)
  const sin = Math.sin(cant)
  const direction = new THREE.Vector3(
    facing.x * cos + facing.z * sin,
    0,
    -facing.x * sin + facing.z * cos,
  )
    .normalize()
    .multiplyScalar(Math.cos(tilt))
    .setY(Math.sin(tilt))
  // The row axis is the card's normal; upright in the card is the third axis.
  // The basis is built rather than rolled, so the valve caps sit on top of the
  // tube from any yaw instead of tipping with it.
  const zAxis = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0)).normalize()
  const yAxis = new THREE.Vector3().crossVectors(zAxis, direction).normalize()
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(direction, yAxis, zAxis),
  )
  const bell = position.clone().addScaledVector(direction, length - grip)
  const mouth = position.clone().addScaledVector(direction, -grip)
  return { position, quaternion, direction, mouth, bell, length, grip, height, cant }
}

// Which way a horn is canted, by its musician's index in the row: alternate
// horns turn opposite ways, so the row's formation is a zig-zag of bells and
// no camera is ever shown every player's card edge-on. (The instruments
// alternate trumpet/drum on the same index, so this is the horn's ordinal.)
export function hornCant(i) {
  return ((Math.floor(i / 2) % 2 === 0) ? 1 : -1) * HORN.cant
}
