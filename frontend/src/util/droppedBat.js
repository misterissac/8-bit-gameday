import { Box3, Quaternion, Vector3 } from 'three'

// ---------------------------------------------------------------------------
// The bat, once he has let it go: where a dropped bat comes to rest, and what a
// bat's own box says about the bat that is being dropped.
//
// Batter.jsx draws a bat in the swing's hands (one clone inside the groups the
// swing poses) and, at the takeoff, hides it — he is not carrying it down the
// line. What a play then reads as is a bat left lying on the dirt where he let it
// go, so the component keeps a *second* copy of the asset, drawn outside every
// group the swing and the run move, and this module works out the two things that
// copy needs: which way its barrel points (the bat the app draws is the
// reference's own cylinder, and a copy has to be measured before it can be laid
// down) and the transform that lays it flat.
//
// The lie itself is three decisions, and each is what the eye is checking:
//
//   1. it stays where he let it go. The copy is placed from the *live* in-hand
//      bat's own frame on the handoff frame — the last frame the swing authored,
//      the one the play's takeoff reads — so the knob lands under the hands that
//      dropped it rather than at some tidy spot beside the plate.
//
//   2. it lies the way it was already leaning. The barrel keeps whatever way it
//      was pointed, flattened to the ground: a bat let go over the shoulder falls
//      out along the lean it had, so `droppedBatPose` keeps that direction and
//      only takes the *tilt* out of it. A bat within a few degrees of straight up
//      has no lean worth reading, and falls along `fallback` instead — the caller's
//      own direction, and on a real batter the side of the plate he stands on.
//
//   3. it rests on the dirt, not in it. The axis is raised by the bat's own
//      radius, which is the half-width of its box: the barrel — the thickest part
//      — touches the ground and the handle lies just above it, the way a bat
//      actually sits (measured off the asset: a 37 mm barrel on an 868 mm bat).
// ---------------------------------------------------------------------------

// How square to vertical a bat has to be before there is no lean of its own left
// to lie along: the sine of the angle between its barrel and straight up, so 0.2
// is a bat within about 11 degrees of standing on end.
const STANDING_LIMIT = 0.2
const STANDING_LIMIT_SQ = STANDING_LIMIT * STANDING_LIMIT

// Scratch: the pose is worked out once per play, but it is worked out in the
// frame loop's own branch, and a frame loop allocating per frame is a frame loop
// the GC gets to run during a play.
const _box = new Box3()
const _size = new Vector3()
const _barrel = new Vector3()
const _lying = new Vector3()
const _tilt = new Quaternion()

/**
 * What a bat's own bounding box says about it, in the bat's *own* frame: which way
 * its barrel points, how thick it is, and how long.
 *
 * The box is read the way three reads it, so the object has to be measured before
 * it is parented to anything (a bat inside a turned group measures as the box
 * around the turned bat, which for a bat on a diagonal is nothing like the bat).
 * The asset's own bat is one cylinder with its knob at the object's origin, so the
 * longest side of its box is the bat, and the barrel is the end of that side
 * farther from the origin. Nothing else is assumed: a bat modelled with the grip
 * at its middle would come back with the longer half as its barrel, which is still
 * the direction a dropped bat should lie in.
 *
 * @param {THREE.Object3D} object the bat, in its own frame
 * @returns {{barrel: THREE.Vector3, radius: number, length: number}} the unit
 *   direction from grip to barrel in the bat's frame, and the metres the bat's
 *   axis stands off the ground when it lies on it
 */
export function measureBat(object) {
  _box.setFromObject(object)
  _box.getSize(_size)
  // The bat's own long side: the box is the bat's, so the largest of the three is
  // its length (a 37 mm barrel against 868 mm of bat).
  let along = 1
  if (_size.x >= _size.y && _size.x >= _size.z) along = 0
  else if (_size.z > _size.y) along = 2
  const across = [0, 1, 2].filter((axis) => axis !== along)
  const barrel = new Vector3()
  // The end the box reaches *further* from the object's own origin: the origin is
  // the grip (the hands hold the knob), so that end is the barrel's.
  const far = Math.abs(_box.max.getComponent(along)) >= Math.abs(_box.min.getComponent(along))
  barrel.setComponent(along, far ? 1 : -1)
  return {
    barrel,
    radius: Math.max(_size.getComponent(across[0]), _size.getComponent(across[1])) / 2,
    length: _size.getComponent(along),
  }
}

/**
 * Where a dropped bat lies: its own frame again, with the barrel laid flat and the
 * whole bat set down on the ground.
 *
 * @param {object} drop
 * @param {THREE.Vector3} drop.position the bat's frame where it was let go — the
 *   grip's place, in the frame the dropped copy is drawn in
 * @param {THREE.Quaternion} drop.quaternion the bat's own orientation there
 * @param {THREE.Vector3} drop.barrel which way the barrel points in the bat's own
 *   frame (from `measureBat`)
 * @param {number} [drop.radius] the bat's own radius, from `measureBat`: how far
 *   its axis stands off the ground when it lies on it
 * @param {THREE.Vector3|null} [drop.fallback] the direction to lie in for a bat
 *   that was standing straight up in the hands and so has no lean of its own
 *   (horizontal only — its own y is read as the ground)
 * @returns {{position: THREE.Vector3, quaternion: THREE.Quaternion}} the frame the
 *   dropped copy is drawn at
 */
export function droppedBatPose({ position, quaternion, barrel, radius = 0, fallback = null }) {
  const pose = { position: position.clone(), quaternion: quaternion.clone() }
  _barrel.copy(barrel).applyQuaternion(pose.quaternion).normalize()
  // The barrel's own lean, flattened: the direction the bat falls out along.
  _lying.set(_barrel.x, 0, _barrel.z)
  if (_lying.lengthSq() < STANDING_LIMIT_SQ && fallback) _lying.set(fallback.x, 0, fallback.z)
  if (_lying.lengthSq() > 0) {
    // The shortest turn that takes the barrel from where it points to where it
    // lies — applied ahead of the bat's own orientation, because it is read in the
    // frame the copy is drawn in rather than in the bat's frame.
    pose.quaternion.premultiply(_tilt.setFromUnitVectors(_barrel, _lying.normalize()))
  }
  // ...and down on the dirt: the axis sits its own radius up, which is where a
  // cylinder of this radius comes to rest.
  pose.position.y = radius
  return pose
}
