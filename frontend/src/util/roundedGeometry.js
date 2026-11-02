import * as THREE from 'three'

// ---------------------------------------------------------------------------
// A box whose twelve edges and eight corners are cut back by `bevel`.
//
// A park built out of cuboids reads as scaffolding: every edge is a hard
// ninety-degree crease, so a seat cushion, a floodlight pod or a scoreboard
// housing looks like a crate rather than a moulded part. This is the same box
// with its arrises taken off -- each edge becomes a narrow chamfer facet and
// each corner a small triangle -- so the silhouette rolls instead of cutting,
// and the chamfer bands catch a light of their own.
//
// It deliberately mirrors Ballpark's addTransformedBox: same arguments, same
// face order (front, back, left, right, top, bottom), same `faceColors` and
// `faceUvs`, and the same pitch-then-yaw transform, so a call can be swapped
// for the other without any other change. UVs, when asked for, are taken from
// whichever of the two faces a chamfer meets, so every band continues the face
// it borders (the top edge of a padded wall keeps the padded wall's top rail).
// ---------------------------------------------------------------------------

const CORNER_SIGNS = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
]

// The same face definition as addTransformedBox, so colours and UV rectangles
// land on the same sides.
const FACE_CORNERS = [
  [0, 1, 2, 3], // 0: front (-Z)
  [5, 4, 7, 6], // 1: back (+Z)
  [4, 0, 3, 7], // 2: left (-X)
  [1, 5, 6, 2], // 3: right (+X)
  [3, 2, 6, 7], // 4: top (+Y)
  [4, 5, 1, 0], // 5: bottom (-Y)
]
const FACE_AXIS = [2, 2, 0, 0, 1, 1]
const FACE_SIGN = [-1, 1, -1, 1, 1, -1]

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const unit = (a) => {
  const len = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / len, a[1] / len, a[2] / len]
}

function faceNormal(f) {
  const n = [0, 0, 0]
  n[FACE_AXIS[f]] = FACE_SIGN[f]
  return n
}

function mixColors(list) {
  const c = new THREE.Color(0, 0, 0)
  for (const k of list) {
    c.r += k.r
    c.g += k.g
    c.b += k.b
  }
  c.r /= list.length
  c.g /= list.length
  c.b /= list.length
  return c
}

/**
 * Append a chamfered box to the given attribute arrays.
 *
 * @param {number[]} positions
 * @param {number[]} normals
 * @param {number[]} colors
 * @param {number[]|object|null} maybeUvs  UV array, or the options (as in
 *   addTransformedBox), when no UVs are wanted.
 * @param {object} maybeOpts
 *   cx, cy, cz, sx, sy, sz, yaw, pitch, col, faceColors, faceUvs,
 *   bevel (metres; defaults to a fifth of the thin side)
 */
export function addChamferedBox(positions, normals, colors, maybeUvs, maybeOpts) {
  let uvs = null
  let opts = maybeOpts
  if (maybeOpts === undefined) {
    opts = maybeUvs
  } else {
    uvs = maybeUvs
  }
  const {
    cx, cy, cz, sx, sy, sz, yaw = 0, pitch = 0, col, faceColors, faceUvs,
  } = opts
  const half = [sx / 2, sy / 2, sz / 2]
  const thin = Math.min(sx, sy, sz)
  // A chamfer deeper than the thin side's half would turn the box inside out.
  const bevel = Math.max(1e-4, Math.min(opts.bevel ?? thin * 0.2, thin * 0.45))

  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  const cosP = Math.cos(pitch)
  const sinP = Math.sin(pitch)

  const toWorld = (p) => {
    const y1 = p[1] * cosP - p[2] * sinP
    const z1 = p[1] * sinP + p[2] * cosP
    return [
      cx + p[0] * cosY + z1 * sinY,
      cy + y1,
      cz - p[0] * sinY + z1 * cosY,
    ]
  }
  const turn = (n) => {
    const y1 = n[1] * cosP - n[2] * sinP
    const z1 = n[1] * sinP + n[2] * cosP
    return [n[0] * cosY + z1 * sinY, y1, -n[0] * sinY + z1 * cosY]
  }

  // One of a face's four corners, pulled in along the face by the bevel: the
  // corner of the inset rectangle the face is really drawn as.
  const inset = (f, k) => {
    const c = CORNER_SIGNS[k]
    const p = [c[0] * half[0], c[1] * half[1], c[2] * half[2]]
    const axis = FACE_AXIS[f]
    for (let a = 0; a < 3; a++) {
      if (a !== axis) p[a] -= Math.sign(p[a]) * bevel
    }
    return p
  }

  const faceUv = (f, p) => {
    const [u0, v0, u1, v1] = (faceUvs && faceUvs[f]) ? faceUvs[f] : [0, 0, 1, 1]
    const k = FACE_CORNERS[f]
    const c0 = inset(f, k[0])
    const c1 = inset(f, k[1])
    const c3 = inset(f, k[3])
    const du = sub(c1, c0)
    const dv = sub(c3, c0)
    const d = sub(p, c0)
    const s = dot(d, du) / (dot(du, du) || 1)
    const t = dot(d, dv) / (dot(dv, dv) || 1)
    return [u0 + s * (u1 - u0), v0 + t * (v1 - v0)]
  }

  const faceColor = (f) => ((faceColors && faceColors[f]) ? faceColors[f] : col)

  // Push a convex polygon (triangle or quad) with one flat normal, facing
  // outward: the winding is flipped when it would face the wrong way, so every
  // caller can list its corners in whatever order is convenient.
  const emit = (pts, normal, colour, uvList) => {
    const geometric = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]))
    if (dot(geometric, normal) < 0) {
      pts = [...pts].reverse()
      if (uvList) uvList = [...uvList].reverse()
    }
    const push = (p, uv) => {
      positions.push(p[0], p[1], p[2])
      normals.push(normal[0], normal[1], normal[2])
      colors.push(colour.r, colour.g, colour.b)
      if (uvs) uvs.push(uv[0], uv[1])
    }
    for (let i = 2; i < pts.length; i++) {
      push(pts[0], uvList ? uvList[0] : [0, 0])
      push(pts[i - 1], uvList ? uvList[i - 1] : [0, 0])
      push(pts[i], uvList ? uvList[i] : [0, 0])
    }
  }

  // The six faces, inset by the bevel on all four sides.
  for (let f = 0; f < 6; f++) {
    const corners = FACE_CORNERS[f]
    const local = corners.map((k) => inset(f, k))
    const pts = local.map(toWorld)
    const uvsList = local.map((p) => faceUv(f, p))
    emit(pts, turn(faceNormal(f)), faceColor(f), uvsList)
  }

  // The twelve edge chamfers: each between the two faces that share the edge,
  // carrying the average of their colours and their normals.
  for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 6; b++) {
      const shared = FACE_CORNERS[a].filter((k) => FACE_CORNERS[b].includes(k))
      if (shared.length !== 2) continue
      const [k0, k1] = shared
      const pA0 = inset(a, k0)
      const pA1 = inset(a, k1)
      const pB0 = inset(b, k0)
      const pB1 = inset(b, k1)
      const pts = [pA0, pA1, pB1, pB0].map(toWorld)
      // The band takes its UVs from the first face only, along the shared edge:
      // mixing one face's UVs with the other's would drag the whole texture
      // through the narrow facet and smear the artwork across it.
      const uvList = [
        faceUv(a, pA0), faceUv(a, pA1), faceUv(a, pA1), faceUv(a, pA0),
      ]
      const normal = unit([
        faceNormal(a)[0] + faceNormal(b)[0],
        faceNormal(a)[1] + faceNormal(b)[1],
        faceNormal(a)[2] + faceNormal(b)[2],
      ])
      emit(pts, turn(normal), mixColors([faceColor(a), faceColor(b)]), uvList)
    }
  }

  // The eight corner facets: the three inset corners that meet there.
  for (let k = 0; k < 8; k++) {
    const faces = [0, 1, 2, 3, 4, 5].filter((f) => FACE_CORNERS[f].includes(k))
    const local = faces.map((f) => inset(f, k))
    const pts = local.map(toWorld)
    const uv = faceUv(faces[0], local[0])
    const uvList = [uv, uv, uv]
    const n = faceNormal(faces[0])
    for (let i = 1; i < faces.length; i++) {
      const m = faceNormal(faces[i])
      n[0] += m[0]
      n[1] += m[1]
      n[2] += m[2]
    }
    emit(pts, turn(unit(n)), mixColors(faces.map(faceColor)), uvList)
  }
}

/** A standalone chamfered box geometry, centred on its own origin. */
export function createChamferedBoxGeometry({
  size = [1, 1, 1], bevel = 0.08, color = '#ffffff',
} = {}) {
  const positions = []
  const normals = []
  const colors = []
  addChamferedBox(positions, normals, colors, {
    cx: 0, cy: 0, cz: 0, sx: size[0], sy: size[1], sz: size[2], bevel,
    col: new THREE.Color(color),
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  return geometry
}
