import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { addChamferedBox } from '../src/util/roundedGeometry.js'

// ---------------------------------------------------------------------------
// The chamfered box is what stops the park's cast props reading as cuboids, so
// the things that make it a solid are worth pinning: it is closed, it faces
// outward, it still fills the box it was asked for, and the band along a
// chamfer continues the face it borders (a padded wall's caution rail, not a
// smear of the whole texture squeezed into the facet).
// ---------------------------------------------------------------------------

const build = (opts = {}) => {
  const positions = []
  const normals = []
  const colors = []
  const uvs = []
  addChamferedBox(positions, normals, colors, uvs, {
    cx: 0, cy: 0, cz: 0, sx: 2, sy: 1, sz: 3,
    col: new THREE.Color('#808080'),
    bevel: 0.2,
    ...opts,
  })
  return { positions, normals, colors, uvs }
}

const triangles = (positions, normals, uvs) => {
  const tris = []
  for (let i = 0; i < positions.length; i += 9) {
    const first = i / 3
    tris.push({
      points: [0, 3, 6].map((k) => positions.slice(i + k, i + k + 3)),
      normals: [0, 3, 6].map((k) => normals.slice(i + k, i + k + 3)),
      uvs: [0, 1, 2].map((j) => [uvs[(first + j) * 2], uvs[(first + j) * 2 + 1]]),
    })
  }
  return tris
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const key = (p) => p.map((v) => Math.round(v * 1e6)).join(',')

const volume = (tris) =>
  tris.reduce((sum, { points: [a, b, c] }) => sum + dot(a, cross(b, c)) / 6, 0)

test('a chamfered box is a closed, outward-facing solid', () => {
  const { positions, normals, uvs } = build()
  assert.equal(positions.length / 3, 132, 'six faces, twelve bands, eight corners')
  const tris = triangles(positions, normals, uvs)
  assert.equal(tris.length, 44)

  // Outward: each triangle's geometric normal agrees with its own vertices'
  // normals, and those normals are unit length.
  for (const { points: [a, b, c], normals: ns } of tris) {
    const geometric = cross(sub(b, a), sub(c, a))
    for (const n of ns) {
      assert.ok(dot(geometric, n) > 0, 'the triangle faces outward')
      assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6, 'the normal is unit length')
    }
  }

  // Closed: every directed edge has exactly one twin running the other way.
  const edges = new Map()
  for (const { points } of tris) {
    for (const [p, q] of [[points[0], points[1]], [points[1], points[2]], [points[2], points[0]]]) {
      const k = `${key(p)}>${key(q)}`
      edges.set(k, (edges.get(k) ?? 0) + 1)
    }
  }
  for (const [edge, count] of edges) {
    const [from, to] = edge.split('>')
    assert.equal(count, 1)
    assert.equal(edges.get(`${to}>${from}`), 1, `edge ${edge} is unmatched`)
  }
})

test('the bevel is cut out of the box, not added to it', () => {
  const boxVolume = 2 * 1 * 3
  const sharp = build({ bevel: 1e-4 })
  const soft = build({ bevel: 0.2 })

  // It keeps the box's own extents...
  for (const axis of [0, 1, 2]) {
    const values = soft.positions.filter((_, i) => i % 3 === axis)
    const half = [1, 0.5, 1.5][axis]
    assert.ok(Math.abs(Math.max(...values) - half) < 1e-9)
    assert.ok(Math.abs(Math.min(...values) + half) < 1e-9)
  }

  // ...and loses only the corners and edges it chamfered.
  const vSharp = volume(triangles(sharp.positions, sharp.normals, sharp.uvs))
  const vSoft = volume(triangles(soft.positions, soft.normals, soft.uvs))
  assert.ok(Math.abs(vSharp - boxVolume) < 0.01)
  assert.ok(vSoft < vSharp)
  assert.ok(vSoft > boxVolume * 0.9)
})

test('a chamfer band keeps the UVs of the face it borders', () => {
  const pad = [0.004, 0.1, 0.004, 0.1]
  const faceUvs = [[0, 0, 1, 1], pad, pad, pad, pad, pad]
  const { positions, normals, uvs } = build({ faceUvs, sy: 0.9, sz: 0.26, bevel: 0.075 })
  const tris = triangles(positions, normals, uvs)

  // The top-front band: its normal is the average of the front's and the top's,
  // and it must run the front face's whole width at v = 1 (the caution band at
  // the top of that texture) rather than across the texture's diagonal.
  const band = tris.filter(({ normals: ns }) => {
    const n = ns[0]
    return Math.abs(n[0]) < 1e-9 && Math.abs(n[1] - Math.SQRT1_2) < 1e-6
      && Math.abs(n[2] + Math.SQRT1_2) < 1e-6
  })
  assert.equal(band.length, 2)
  const vValues = band.flatMap(({ uvs: t }) => t.map(([, v]) => v))
  for (const v of vValues) assert.ok(Math.abs(v - 1) < 1e-9, `band v ${v} should be 1`)
  const uValues = band.flatMap(({ uvs: t }) => t.map(([u]) => u))
  assert.ok(Math.abs(Math.min(...uValues)) < 1e-9)
  assert.ok(Math.abs(Math.max(...uValues) - 1) < 1e-9)
})

test('the member is turned by yaw and pitch like every other box in the park', () => {
  const { positions } = build({ yaw: Math.PI / 2 })
  const xs = positions.filter((_, i) => i % 3 === 0)
  const zs = positions.filter((_, i) => i % 3 === 2)
  // The 2 m side now runs along z and the 3 m side along x.
  assert.ok(Math.abs(Math.max(...zs) - 1) < 1e-9)
  assert.ok(Math.abs(Math.max(...xs) - 1.5) < 1e-9)
})
