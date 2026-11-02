import test from 'node:test'
import assert from 'node:assert/strict'
import { CylinderGeometry, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import { droppedBatPose, measureBat } from '../src/util/droppedBat.js'

// Where a dropped bat comes to rest, pinned: the two reads this module exists to
// make — which way a bat's barrel points in its own frame, and the transform that
// lays it on the dirt keeping the lean it was let go with (see the module's own
// header for the three decisions that are the lie itself).

const UP = new Vector3(0, 1, 0)

// A bat of the asset's own shape: one cylinder, a 37 mm barrel on 868 mm of bat,
// its knob at the object's origin and the barrel up its +Y (public/models/parts/
// bat.glb, measured). The geometry is translated rather than the mesh, so the bat's
// own frame really is the frame its box is read in.
const bat = ({ length = 0.868, radius = 0.0372, at = 0 } = {}) => {
  const geometry = new CylinderGeometry(radius, radius, length, 8)
  geometry.translate(0, at + length / 2, 0)
  const root = new Group()
  root.add(new Mesh(geometry, new MeshStandardMaterial()))
  return root
}

test('a bat measures its own barrel, radius and length off its own box', () => {
  const measured = measureBat(bat())
  assert.ok(measured.barrel.distanceTo(UP) < 1e-12, `barrel ${measured.barrel.toArray()}`)
  // Loosely: the box is read off the geometry's own vertices, which are float32
  // (868 mm comes back 44 microns short, which is not a length anyone can see).
  assert.ok(Math.abs(measured.length - 0.868) < 1e-5, `length ${measured.length}`)
  assert.ok(Math.abs(measured.radius - 0.0372) < 1e-5, `radius ${measured.radius}`)
  // The barrel is the end the box reaches *further* from the object's origin,
  // because that origin is the grip: the same cylinder hung above the origin (a
  // grip with an offset in it) still reads barrel-up...
  assert.ok(measureBat(bat({ at: 0.12 })).barrel.distanceTo(UP) < 1e-12)
  // ...and one whose body runs *below* its own origin reads barrel-down, which is
  // the same bat modelled the other way up.
  assert.ok(measureBat(bat({ at: -0.9 })).barrel.distanceTo(new Vector3(0, -1, 0)) < 1e-12)
})

test('a dropped bat lies flat along the lean it was let go with', () => {
  // Let go over the shoulder: the barrel up and out toward +X, 45 degrees off
  // straight up, which is the sort of lean the follow-through leaves it in.
  const lean = new Vector3(Math.SQRT1_2, Math.SQRT1_2, 0)
  const released = {
    position: new Vector3(-0.7, 1.2, 0.5),
    quaternion: new Quaternion().setFromUnitVectors(UP, lean),
  }
  const pose = droppedBatPose({
    position: released.position,
    quaternion: released.quaternion,
    barrel: UP,
    radius: 0.037,
  })
  // The barrel keeps the direction it was leaning, flattened onto the ground...
  const barrel = UP.clone().applyQuaternion(pose.quaternion)
  assert.ok(barrel.distanceTo(new Vector3(1, 0, 0)) < 1e-9, `barrel ${barrel.toArray()}`)
  // ...the grip stays where the hands let it go (in plan: x and z unmoved)...
  assert.equal(pose.position.x, -0.7)
  assert.equal(pose.position.z, 0.5)
  // ...and the bat is down on the dirt: its axis stands off the ground by its own
  // radius, which is where a cylinder of that radius comes to rest.
  assert.equal(pose.position.y, 0.037)
  // The frame it was let go in is not written to — the pose is a read of it.
  assert.deepEqual(released.position.toArray(), [-0.7, 1.2, 0.5])
  assert.ok(UP.clone().applyQuaternion(released.quaternion).distanceTo(lean) < 1e-12)
})

test("a bat standing in the hands has no lean, so it falls along the caller's own direction", () => {
  const standing = {
    position: new Vector3(1, 1.3, 2),
    quaternion: new Quaternion(), // straight up: the barrel is +Y, exactly
  }
  // The batter's own side of the plate, which is where a bat let go from one
  // standing on end goes down.
  const fallback = new Vector3(-1, 0, 0.45)
  const pose = droppedBatPose({
    position: standing.position,
    quaternion: standing.quaternion,
    barrel: UP,
    radius: 0.04,
    fallback,
  })
  const barrel = UP.clone().applyQuaternion(pose.quaternion)
  assert.ok(Math.abs(barrel.y) < 1e-9, `barrel ${barrel.toArray()} should be flat`)
  assert.ok(barrel.dot(fallback.clone().normalize()) > 1 - 1e-9, '...and along the fallback')
  assert.equal(pose.position.y, 0.04)
  // A bat that is *almost* standing — within the few degrees that have no lean
  // worth reading — falls the same way rather than lying in a direction it never
  // leaned in.
  const nearly = new Quaternion().setFromUnitVectors(UP, new Vector3(0.1, 0.995, 0).normalize())
  const leaning = droppedBatPose({ position: standing.position, quaternion: nearly, barrel: UP, radius: 0.04, fallback })
  assert.ok(UP.clone().applyQuaternion(leaning.quaternion).dot(fallback.clone().normalize()) > 1 - 1e-6)
  // With nothing to fall toward it keeps the orientation it had: there is no
  // direction to lie it in (the caller always has one — a batter has a side of the
  // plate — so this is the degenerate case, and it still sets it down).
  const alone = droppedBatPose({ position: standing.position, quaternion: standing.quaternion, barrel: UP, radius: 0.04 })
  assert.ok(UP.clone().applyQuaternion(alone.quaternion).distanceTo(UP) < 1e-12)
  assert.equal(alone.position.y, 0.04)
})

test('a dropped bat is a turn of the frame it was let go in, not a re-modelling of it', () => {
  // Anything can be a bat as far as this is concerned: the barrel is whatever the
  // caller measured. One pointing out of its own -Z comes to rest along -Z, and
  // the only scale in the answer at all is the radius it is set down by.
  const quaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3)
  const pose = droppedBatPose({
    position: new Vector3(0, 0, 0),
    quaternion,
    barrel: new Vector3(0, 0, -1),
    radius: 0.05,
    fallback: new Vector3(0, -1, 0),
  })
  const barrel = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion)
  assert.ok(barrel.dot(new Vector3(0, 0, -1)) > 1 - 1e-9, `barrel ${barrel.toArray()}`)
  assert.equal(pose.position.y, 0.05)
  // ...and the pose it hands back is a frame like the one it was given: a real
  // rotation, nothing but the bat's own radius written anywhere.
  assert.ok(Math.abs(pose.quaternion.length() - 1) < 1e-12)
})
