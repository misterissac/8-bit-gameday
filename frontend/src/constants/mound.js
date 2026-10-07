import { BufferGeometry, Float32BufferAttribute } from 'three'
import { feetToM } from '../util/MathUtil.js'
import { FIELD } from './field.js'

// ---------------------------------------------------------------------------
// The pitcher's mound, as Ballpark draws it.
//
// One description of the mound's own shape, so that the mound the scene renders
// and the surface the pitcher's feet stand on cannot drift apart: Ballpark builds
// its mound and its rubber plate from these numbers, and the pitcher reads the
// surface off them (`moundSurfaceY`, which Pitcher.jsx hands the rig driver as its
// ground — see playerRig.js's leg solve).
//
// The mound is a circle 18 ft across at its base with a level plateau 5.6 ft
// across, and it stands 0.22 m over the field's own plane (Ballpark's 0.024 m
// surface) — eight and two thirds of an inch, which is the ten-inch mound this
// app draws, less the plane it sits on. On the plateau's own centre lies the
// pitcher's rubber: a 24 by 6 in plate whose top stands its own thickness proud
// of the plateau, which is the one place on this mound a pitcher's foot *must*
// stand (a delivery's pivot foot is on the rubber by rule).
//
// The mound is centred half a plate *behind* the rubber's front edge, and the
// edge is the line that matters: sixty feet six inches from the plate's own
// origin — the line the backend reconstructs a pitch's release point from
// (``60.5 ft - extension``) and the line the delivery's own stance is pinned to
// (RUBBER_Z in util/pitcherSequence.js). Drawn as a plate centred *on* that line,
// the rubber a pitcher's foot is promised would stand 6 in in front of the one the
// pitch data measures from; drawn behind it, the plate a delivery is authored to
// stand on is the plate the eye sees, which is what this whole description is for
// (and what FIELD.DEFENSE.P's own note, that the defense's P sits on that line,
// always meant).
//
// Everything a pitcher's shoe can touch is one of those three surfaces: the
// slant, the level plateau, and the plate standing on it. The rise is linear in
// the radius between the plateau's edge and the base — the same law
// `createSmoothPitcherMoundGeometry` draws its rings with — so the surface the
// feet are solved against is the surface the eye sees, a shade under twelve
// degrees down the slope.
// ---------------------------------------------------------------------------
export const MOUND = {
  // The mound's own centre, and with it the plate's: the rubber's front edge
  // stands on the defense's own P, so the plate (and the mound it lies on) is
  // centred half the plate's own depth behind it. This is the point the mound is
  // drawn about and the point the surface is measured from.
  centre: [FIELD.DEFENSE.P.x, FIELD.DEFENSE.P.z - feetToM(0.25)],
  plateau: feetToM(2.8),
  base: feetToM(9),
  rise: 0.22,
  // The field's own surface under the mound — Ballpark's grass plane, which the
  // mound's base ring meets flush (see its own 0.024 m group).
  surface: 0.024,
  // The rubber plate: 24 in across, 6 in deep, its top 0.03 m over the plateau.
  rubber: { halfWidth: feetToM(1), halfDepth: feetToM(0.25), rise: 0.03 },
}

/**
 * The mound's own rise over the field's surface at a radius, in metres: the
 * plateau's own height across the level top, down its slant to the field at the
 * base, and the field's own level beyond it.
 */
export function moundRiseAt(radius) {
  if (radius <= MOUND.plateau) return MOUND.rise
  if (radius >= MOUND.base) return 0
  return MOUND.rise * (1 - (radius - MOUND.plateau) / (MOUND.base - MOUND.plateau))
}

/** Whether a world point stands over the rubber's own plate. */
export function overRubber(x, z) {
  return Math.abs(x - MOUND.centre[0]) <= MOUND.rubber.halfWidth
    && Math.abs(z - MOUND.centre[1]) <= MOUND.rubber.halfDepth
}

/**
 * The world height of whatever surface a pitcher stands on at (x, z): the
 * rubber's own top where the point is over the plate, the mound's plateau or
 * slant elsewhere on it, and the field's own surface beyond the base.
 */
export function moundSurfaceY(x, z) {
  if (overRubber(x, z)) return MOUND.surface + MOUND.rise + MOUND.rubber.rise
  const radius = Math.hypot(x - MOUND.centre[0], z - MOUND.centre[1])
  return MOUND.surface + moundRiseAt(radius)
}

/**
 * The mound's own geometry — a fan of rings from the plateau's centre out to the
 * base, the plateau's own rings held level and the rest falling with
 * `moundRiseAt` — in the mound's own frame (its origin on the centre, at the
 * field's surface). Ballpark mounts it at MOUND.centre and draws the plate beside
 * it, so the rings the eye sees are the surface `moundSurfaceY` solves: the two
 * are one description read twice.
 */
export function createMoundGeometry(radialSegments = 64, rings = 24) {
  const geom = new BufferGeometry()
  const positions = []
  const uvs = []
  const indices = []

  // Center vertex at apex of top plateau
  positions.push(0, MOUND.rise, 0)
  uvs.push(0.5, 0.5)

  // Concentric rings from center to base
  for (let i = 1; i <= rings; i++) {
    let r
    if (i <= 6) {
      // Level top plateau around pitcher's rubber
      r = (i / 6) * MOUND.plateau
    } else {
      // Smooth continuous slant down to field level
      r = MOUND.plateau + ((i - 6) / (rings - 6)) * (MOUND.base - MOUND.plateau)
    }
    const y = moundRiseAt(r)

    for (let j = 0; j < radialSegments; j++) {
      const theta = (j / radialSegments) * Math.PI * 2
      const x = r * Math.sin(theta)
      const z = -r * Math.cos(theta)
      positions.push(x, y, z)
      // Planar UV projection to match field dirt seamlessly
      uvs.push(0.5 + x / (2 * MOUND.base), 0.5 + z / (2 * MOUND.base))
    }
  }

  // First ring triangles (connecting center vertex to ring 1)
  for (let j = 0; j < radialSegments; j++) {
    const nextJ = (j + 1) % radialSegments
    indices.push(0, 1 + j, 1 + nextJ)
  }

  // Triangular grid for subsequent rings
  for (let i = 1; i < rings; i++) {
    const rowStart = 1 + (i - 1) * radialSegments
    const nextRowStart = 1 + i * radialSegments
    for (let j = 0; j < radialSegments; j++) {
      const nextJ = (j + 1) % radialSegments
      const a = rowStart + j
      const b = rowStart + nextJ
      const c = nextRowStart + j
      const d = nextRowStart + nextJ
      indices.push(a, c, b)
      indices.push(b, c, d)
    }
  }

  geom.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geom.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geom.setIndex(indices)
  geom.computeVertexNormals()
  return geom
}
