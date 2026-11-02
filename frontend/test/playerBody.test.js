import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { buildPlayerBody } from '../src/util/playerBody.js'
import { ARM_BONES, LEG_BONES, PLAYER_BONES } from '../src/util/playerRig.js'

// The shared body plumbing, pinned: what both actors get when they hand it the loaded
// asset — a body of their own, dressed for their own part, and the resting skeleton kept
// as the pose is authored *relative* to (see the module's own header for why the order
// matters). The look pass is left out here (``look: null``): it needs a real mesh with a
// uv, a skin and the atlas behind it, and both actors run it in the e2e suite instead.
//
// The body is one of ours rather than player.glb, because what is being pinned is the
// plumbing and not the asset: the bones the rig measures — it throws on a missing one —
// at plausible places, and one skinned mesh bound to its own skeleton, which is the thing
// ``SkeletonUtils.clone`` exists to rebind.
const BONES = [
  // [name, x, y, z]: a body two metres tall, hips at 0.9, neck at 1.5.
  [PLAYER_BONES.spine, 0, 1.0, 0],
  [PLAYER_BONES.neck, 0, 1.5, 0],
  [PLAYER_BONES.head, 0, 1.65, 0],
  [ARM_BONES.L.upperArm, 0.2, 1.45, 0],
  [ARM_BONES.L.forearm, 0.45, 1.45, 0],
  [ARM_BONES.L.hand, 0.7, 1.45, 0],
  [ARM_BONES.L.fingers, 0.78, 1.45, 0],
  [ARM_BONES.R.upperArm, -0.2, 1.45, 0],
  [ARM_BONES.R.forearm, -0.45, 1.45, 0],
  [ARM_BONES.R.hand, -0.7, 1.45, 0],
  [ARM_BONES.R.fingers, -0.78, 1.45, 0],
  [LEG_BONES.L.hip, 0.1, 0.9, 0],
  [LEG_BONES.L.knee, 0.1, 0.48, 0],
  [LEG_BONES.L.ankle, 0.1, 0.08, 0],
  [LEG_BONES.L.toe, 0.1, 0.03, 0.12],
  [LEG_BONES.L.heel, 0.1, 0.03, -0.05],
  [LEG_BONES.R.hip, -0.1, 0.9, 0],
  [LEG_BONES.R.knee, -0.1, 0.48, 0],
  [LEG_BONES.R.ankle, -0.1, 0.08, 0],
  [LEG_BONES.R.toe, -0.1, 0.03, 0.12],
  [LEG_BONES.R.heel, -0.1, 0.03, -0.05],
]
// The meshes the actors are asked about: the body the batter and the pitcher both wear,
// the helmet one of them does, and the cap and gloves that are the batter's to hide
// (see HIDDEN_MESHES in playerRig.js).
const MESHES = ['JOINED', 'Helmet', 'CAP', 'GloveL', 'GloveR']

// A box, skinned end to end to the first bone: the skinning is a formality here, but the
// attributes have to be there — three's own bounding box is read off the *skinned*
// vertices, and ``measurePlayerRig`` takes the model's height off that box.
const skinnedBox = (size, skeleton) => {
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2])
  // Stood on the ground rather than centred on the origin, so the box the measure takes
  // off the model is the body's own height (feet at 0, head at the top).
  geometry.translate(0, size[1] / 2, 0)
  const count = geometry.getAttribute('position').count
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(
    Float32Array.from({ length: count * 4 }, (_, at) => (at % 4 === 0 ? 1 : 0)),
    4,
  ))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
  // Bound to the identity: the rest pose is the geometry, so the box that comes back is
  // the mesh's own size whatever the bones are doing.
  mesh.bind(skeleton, new THREE.Matrix4())
  return mesh
}

const makePlayer = () => {
  const root = new THREE.Group()
  root.name = 'armature'
  const bones = BONES.map(([name, x, y, z]) => {
    const bone = new THREE.Bone()
    bone.name = name
    bone.position.set(x, y, z)
    root.add(bone)
    return bone
  })
  const skeleton = new THREE.Skeleton(bones)
  const body = skinnedBox([0.6, 2, 0.3], skeleton)
  body.name = 'JOINED'
  root.add(body)
  for (const name of MESHES.filter((mesh) => mesh !== 'JOINED')) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial())
    mesh.name = name
    mesh.position.set(0, 1.7, 0)
    root.add(mesh)
  }
  root.updateMatrixWorld(true)
  // The skinned box is read off the *current* bone matrices, so they are brought up to
  // date here rather than left at whatever the constructor left them at (all zeros).
  skeleton.calculateInverses()
  skeleton.update()
  return root
}

const of = (root, name) => root.getObjectByName(name)

const bonesOf = (root) => {
  const bones = []
  root.traverse((node) => { if (node.isBone) bones.push(node) })
  return bones
}

test('the body is its own clone: posing it cannot move the cached asset', () => {
  const asset = makePlayer()
  const body = buildPlayerBody(asset)
  assert.notEqual(body.model, asset, 'the body is a clone, not the loaded asset')
  // Every bone is a bone of the body, not the asset's — and the skin is rebound to the
  // clone's own, which is the whole reason the clone is SkeletonUtils' rather than
  // Object3D's: three's own clone would leave the mesh bound to the asset's skeleton.
  assert.equal(bonesOf(body.model).length, BONES.length)
  for (const [name] of BONES) {
    assert.notEqual(of(body.model, name), of(asset, name), `${name} should be the body's own`)
  }
  const assetMesh = of(asset, 'JOINED')
  const clonedMesh = of(body.model, 'JOINED')
  assert.notEqual(clonedMesh.skeleton, assetMesh.skeleton)
  for (const bone of clonedMesh.skeleton.bones) {
    assert.equal(bone, of(body.model, bone.name), 'the skeleton should carry the clone’s bones')
  }
  // ...and posing it is the proof: the pose is written to these bones every frame.
  const assetNeck = of(asset, PLAYER_BONES.neck)
  const clonedNeck = of(body.model, PLAYER_BONES.neck)
  const restY = clonedNeck.position.y
  clonedNeck.position.y = 9
  clonedNeck.quaternion.set(1, 0, 0, 0)
  assert.equal(assetNeck.position.y, 1.5, 'the asset’s neck should not have moved')
  assert.deepEqual(assetNeck.quaternion.toArray(), [0, 0, 0, 1])
  // The geometry, though, *is* the asset's: nothing is copied until a pass copies it,
  // which is why the look pass clones the geometry it edits (see applyBatterLook).
  assert.equal(clonedMesh.geometry, assetMesh.geometry)
  // Two bodies off one asset are two bodies.
  const other = buildPlayerBody(asset)
  assert.notEqual(other.model, body.model)
  assert.notEqual(of(other.model, PLAYER_BONES.neck), clonedNeck)
  assert.equal(of(other.model, PLAYER_BONES.neck).position.y, restY)
})

test('the meshes the actor does not wear come back hidden, and the asset is untouched', () => {
  const asset = makePlayer()
  const batter = buildPlayerBody(asset, { hide: ['CAP', 'GloveL', 'GloveR'] })
  for (const name of ['CAP', 'GloveL', 'GloveR']) {
    assert.equal(of(batter.model, name).visible, false, `${name} should be hidden`)
    assert.equal(of(asset, name).visible, true, `the asset’s ${name} should still be there`)
  }
  for (const name of ['JOINED', 'Helmet']) {
    assert.equal(of(batter.model, name).visible, true, `${name} should still be worn`)
  }
  // The actor that hides nothing wears all of it (the pitcher's cap and glove).
  const pitcher = buildPlayerBody(asset)
  for (const name of MESHES) assert.equal(of(pitcher.model, name).visible, true)
  // Shadows are the body's own too: every mesh is solid, and the asset is not written to.
  for (const body of [batter, pitcher]) {
    for (const name of MESHES) {
      const mesh = of(body.model, name)
      assert.ok(mesh.castShadow && mesh.receiveShadow, `${name} should cast and receive`)
    }
  }
  for (const name of MESHES) assert.equal(of(asset, name).castShadow, false)
})

test('the rest pose is a snapshot of every bone, taken off the body it belongs to', () => {
  const asset = makePlayer()
  const body = buildPlayerBody(asset)
  const bones = bonesOf(body.model)
  assert.equal(body.restPose.size, bones.length, 'every bone, and nothing that is not one')
  for (const bone of bones) {
    const at = body.restPose.get(bone)
    assert.ok(at, `${bone.name} should be in the rest pose`)
    assert.deepEqual(at.position.toArray(), bone.position.toArray())
    assert.deepEqual(at.quaternion.toArray(), bone.quaternion.toArray())
    // Copies, not windows onto the skeleton: the driver writes to the bones per frame,
    // and the pose it writes is authored relative to *this* pose.
    assert.notEqual(at.position, bone.position)
    assert.notEqual(at.quaternion, bone.quaternion)
  }
  // Which is the point of taking it: a bone moved afterwards leaves the snapshot alone,
  // and the snapshot is the clone's, not the asset's.
  const neck = of(body.model, PLAYER_BONES.neck)
  const pose = body.restPose.get(neck)
  neck.position.y = 9
  neck.quaternion.set(1, 0, 0, 0)
  assert.equal(pose.position.y, 1.5)
  assert.deepEqual(pose.quaternion.toArray(), [0, 0, 0, 1])
  assert.equal(pose.position.y, of(asset, PLAYER_BONES.neck).position.y)
})

test('the frame is the caller’s: the model’s own units, or the sprite’s', () => {
  const asset = makePlayer()
  // The pitcher's: no nominal height, so one rig unit is one model unit and the joints
  // come back as the metres the delivery is authored in.
  const metres = buildPlayerBody(asset)
  assert.equal(metres.metrics.unitScale, 1)
  assert.ok(Math.abs(metres.metrics.modelHeight - 2) < 1e-9, `height ${metres.metrics.modelHeight}`)
  assert.ok(Math.abs(metres.metrics.hip.y - 0.9) < 1e-9, `hip ${metres.metrics.hip.y}`)
  assert.ok(Math.abs(metres.metrics.neckY - 1.5) < 1e-9)
  // The batter's: the same body in a frame of its own, every joint scaled by the unit —
  // which is what lets one animation be authored in the sprite's numbers on any model.
  const sprite = buildPlayerBody(asset, { spriteNominalHeightM: 2.48 })
  assert.ok(Math.abs(sprite.metrics.unitScale - 2.48 / 2) < 1e-12, `unit ${sprite.metrics.unitScale}`)
  assert.ok(Math.abs(sprite.metrics.modelHeight - 2) < 1e-9)
  for (const [joint, model, scaled] of [
    ['hip', metres.metrics.hip.y, sprite.metrics.hip.y],
    ['neckY', metres.metrics.neckY, sprite.metrics.neckY],
    ['headY', metres.metrics.headY, sprite.metrics.headY],
  ]) {
    assert.ok(
      Math.abs(scaled - model * sprite.metrics.unitScale) < 1e-12,
      `${joint} should be the model’s own, in the caller’s frame`,
    )
  }
})
