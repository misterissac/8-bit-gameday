import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// The blank middle and the seated corners, read off the scene.
//
// The bleachers run round past each foul pole to the corner's section line, and
// that line is a radius of the plate rather than a chord across the ring, so the
// corner's brick wall lies along the fans' sight lines instead of across them.
// The rows, the deck, the rear facade and the wall all stop on it, half a metre
// clear, and the wall is one brick panel per row -- stepped in height, flush in
// plan, with a stone cap and a pier at each end. The blue padding carries on
// past both foul poles to that same line, so the field wall does not change
// character at the corner (see createCornerWallGeometry in
// components/Ballpark.jsx). The side stand's own end is cut back to the line
// too: it closes the court beside the corner instead of running across the
// bleachers' frontage. The two ends stand apart: the notch their rear ends leave
// is open to the sky and to the outside of the park, and the court inside it is
// planted with kerbed bushes (createCornerBedGeometry,
// createCornerBedKerbGeometry).
//
// Its brick is dressed to two datums -- a course at 0.62 m and another at
// 1.82 m -- under a deep bed-and-crown cornice, so the faces read as masonry
// rather than as panels. The side stand's end is the one wall allowed to climb:
// from the corner's section line it rakes up with the bleacher rows behind the
// court to the bleachers' own rear wall (6.09 m of brick), then dies into a
// pier carried to the stand's 7.6 m rear facade.
//
// Both buildings' eaves are capped in the block's stone -- a coping whose top is
// each facade's own top, so the corner's abutment piers stop against a finished
// band rather than on a bare edge (see createBleacherCopingGeometry and
// createGrandstandCopingGeometry).
//
// The eye is the mirror of that idea. It used to stand in front of the crowd;
// now its bay is cut out of the seating — no seats and no fans behind the
// screen — and the cloth is set in a concrete frame (two piers and a cap) that
// ties it to the stand.
//

// Each check is summarised inside the page and only the numbers are shipped
// back, because the seat mesh alone is hundreds of thousands of vertices.
// ---------------------------------------------------------------------------

const FT = 0.3048
const WALL_RADIUS = 330 * FT
const WALL_HEIGHT = 8 * FT
const BLEACHER_FRONT_R = 332 * FT
const TIER_DEPTH = 1.35
const TIER_HEIGHT = 0.52
const TIERS = 7
const DECK_BOTTOM_Y = 2.45 // the first tier's tread, over the field wall
const RING_BACK_R = BLEACHER_FRONT_R + TIERS * TIER_DEPTH
const FACADE_TOP_Y = 7.6 // the rear stadium facade's top
const SEAT_INSET = 0.4 // the cushion's setback from its tier's back edge
// The corner: the radius the rows and the wall stop on, and the clear deck kept
// between the last cushion and the brick.
const CORNER_ANGLE = (47.3 * Math.PI) / 180
const WALL_CLEAR = 0.5
// The stone dressing round the corner's brick: the cornice over every wall in
// the block, and the stone band each facade's eave wears (see MASONRY in
// components/Ballpark.jsx).
const CORNICE = 0.36
// The bleachers' own rear wall, brick top: the datum the end wall's rake stops
// at. Each facade's eave is the top of its coping, so the corner's piers and the
// walls that carry them stop against a finished band.
const BLEACHER_FACADE_Y = DECK_BOTTOM_Y + TIERS * TIER_HEIGHT + 1.2

// The batter's eye: the span it closes, its frame's depth, and the screen's own
// top (the top row's deck plus the rise over it).
const EYE_HALF_ANGLE = 0.1187
const EYE_PIER_DEPTH = 1.7
const EYE_TOP_Y = DECK_BOTTOM_Y + TIERS * TIER_HEIGHT + 0.35
const EYE_BAY_HALF_ANGLE = EYE_HALF_ANGLE + (0.9 + 0.3) / BLEACHER_FRONT_R

const openPark = async (page) => {
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(String(error)))
  await page.goto('/e2e/harness/crowd.html?view=stadium')
  await page.waitForFunction(() => window.__crowd?.ready === true)
  await page.waitForTimeout(600)
  return problems
}

// The bleachers' seating and the crowd's own positions, both reduced to counts
// of what stands inside the eye's bay and what stands either side of it.
const probeBay = ({ frontR, ringBackR, deckBottomY, bayHalf }) => {
  const scene = window.__crowd.scene
  const THREE = window.__crowd.THREE
  const polar = (x, z) => ({ r: Math.hypot(x, z), angle: Math.atan2(x, -z) })
  const out = { seatsInBay: 0, seatsBeside: 0, fansInBay: 0, fans: 0 }

  const seats = scene.getObjectByName('stands-seats')
  if (seats) {
    const position = seats.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i += 1) {
      const { r, angle } = polar(position.getX(i), position.getZ(i))
      if (r < frontR - 0.5 || r > ringBackR + 0.5) continue
      if (Math.abs(angle) <= bayHalf - 1e-3) out.seatsInBay += 1
      else if (Math.abs(angle) > bayHalf + 0.02 && Math.abs(angle) < 1.2) out.seatsBeside += 1
    }
  }

  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  scene.traverse((node) => {
    if (!node.isInstancedMesh || !/^fans-/.test(node.name)) return
    for (let i = 0; i < node.count; i += 1) {
      node.getMatrixAt(i, matrix)
      position.setFromMatrixPosition(matrix)
      out.fans += 1
      const { r, angle } = polar(position.x, position.z)
      if (Math.abs(angle) < bayHalf + 0.0012 && r > frontR - 1 && r < ringBackR + 1 && position.y > deckBottomY) {
        out.fansInBay += 1
      }
    }
  })
  return out
}

const probeEye = ({ frontR, facadeTop, eyeTop, eyeHalf, pierDepth }) => {
  const scene = window.__crowd.scene
  const polar = (x, z) => ({ r: Math.hypot(x, z), angle: Math.atan2(x, -z) })
  const bounds = (name) => {
    const mesh = scene.getObjectByName(name)
    if (!mesh) return null
    const p = mesh.geometry.getAttribute('position')
    const out = {
      verts: p.count,
      minR: Infinity, maxR: -Infinity,
      maxAbsAngle: 0, maxY: -Infinity,
      front: 0, back: 0, left: 0, right: 0,
      outsideSpan: 0,
    }
    for (let i = 0; i < p.count; i += 1) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      const { r, angle } = polar(x, z)
      out.minR = Math.min(out.minR, r)
      out.maxR = Math.max(out.maxR, r)
      out.maxAbsAngle = Math.max(out.maxAbsAngle, Math.abs(angle))
      out.maxY = Math.max(out.maxY, y)
      if (r < frontR + 0.05) out.front += 1
      else out.back += 1
      if (x < 0) out.left += 1
      else out.right += 1
      if (Math.abs(angle) > eyeHalf + 1e-3) out.outsideSpan += 1
    }
    return out
  }
  return {
    eye: bounds('batters-eye'),
    frame: bounds('batters-eye-frame'),
    eyeTop,
    facadeTop,
    pierDepth,
    clothPanel: scene.getObjectByName('corner-screens') !== undefined,
  }
}


// The bleachers' rows, as the seat mesh draws them: the furthest angle each
// row's cushions reach, asked of the given seat radii.
const probeCornerSeats = ({ seatRadii }) => {
  const scene = window.__crowd.scene
  const mesh = scene.getObjectByName('stands-seats')
  const rows = seatRadii.map((r) => ({ r, end: 0 }))
  const left = { seats: 0 }
  const right = { seats: 0 }
  if (mesh) {
    const position = mesh.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i)
      const z = position.getZ(i)
      const r = Math.hypot(x, z)
      const angle = Math.atan2(x, -z)
      let nearest = -1
      let best = 0.5
      for (let k = 0; k < rows.length; k += 1) {
        const d = Math.abs(r - rows[k].r)
        if (d < best) { best = d; nearest = k }
      }
      if (nearest < 0) continue
      rows[nearest].end = Math.max(rows[nearest].end, Math.abs(angle))
      if (angle < -Math.PI / 4) left.seats += 1
      if (angle > Math.PI / 4) right.seats += 1
    }
  }
  return { rows, left: left.seats, right: right.seats }
}

// A corner wall as the scene's own mesh has it: where each vertex stands, how
// far it sits off the corner's radial section line (zero is the line itself, the
// wall's own thickness is beyond it), and what it is coloured.
const probeWall = ({ name, angle: section, eaves = null }) => {
  const scene = window.__crowd.scene
  const mesh = scene.getObjectByName(name)
  if (!mesh) return null
  const position = mesh.geometry.getAttribute('position')
  const color = mesh.geometry.getAttribute('color')
  const out = {
    verts: position.count,
    left: 0, right: 0,
    minY: Infinity, maxY: -Infinity,
    minR: Infinity, maxR: -Infinity,
    minAngle: Infinity, maxAngle: -Infinity,
    minOff: Infinity, maxOff: -Infinity, flush: 0,
    atBleacherEave: 0, atStandEave: 0,
    warm: 0, cool: 0,
  }
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i)
    const y = position.getY(i)
    const z = position.getZ(i)
    const side = x < 0 ? -1 : 1
    const r = Math.hypot(x, z)
    const angle = Math.abs(Math.atan2(x, -z))
    // Signed distance from the radial section line, positive into the corner.
    const off = side * x * Math.cos(section) + z * Math.sin(section)
    out.minY = Math.min(out.minY, y)
    out.maxY = Math.max(out.maxY, y)
    out.minR = Math.min(out.minR, r)
    out.maxR = Math.max(out.maxR, r)
    out.minAngle = Math.min(out.minAngle, angle)
    out.maxAngle = Math.max(out.maxAngle, angle)
    out.minOff = Math.min(out.minOff, off)
    out.maxOff = Math.max(out.maxOff, off)
    if (Math.abs(off) < 0.01) out.flush += 1
    if (eaves) {
      if (Math.abs(y - eaves.bleacher) < 0.02) out.atBleacherEave += 1
      if (Math.abs(y - eaves.stand) < 0.02) out.atStandEave += 1
    }
    if (x < 0) out.left += 1
    else out.right += 1
    if (color) {
      const cr = color.getX(i)
      const cg = color.getY(i)
      const cb = color.getZ(i)
      if (cr > cg * 1.15 && cr > cb * 1.15) out.warm += 1
      else out.cool += 1
    }
  }
  return out
}

// The padded field wall, as the scene's own mesh has it: how far round it runs,
// at what radius and height, and whether it still carries its padding texture.
const probeFieldWall = () => {
  const scene = window.__crowd.scene
  const mesh = scene.getObjectByName('outfield-wall-pads')
  if (!mesh) return null
  const position = mesh.geometry.getAttribute('position')
  const out = {
    verts: position.count,
    minAngle: Infinity, maxAngle: -Infinity,
    minR: Infinity, maxR: -Infinity,
    minY: Infinity, maxY: -Infinity,
    textured: !!(mesh.material && mesh.material.map),
  }
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i)
    const y = position.getY(i)
    const z = position.getZ(i)
    const r = Math.hypot(x, z)
    out.minY = Math.min(out.minY, y)
    out.maxY = Math.max(out.maxY, y)
    out.minR = Math.min(out.minR, r)
    out.maxR = Math.max(out.maxR, r)
    out.minAngle = Math.min(out.minAngle, Math.atan2(x, -z))
    out.maxAngle = Math.max(out.maxAngle, Math.atan2(x, -z))
  }
  return out
}

// The corner seats' own lines to the strike zone, cast at the corner's masonry.
// If any of it stands between a seat and the plate, that seat is looking at
// brick instead of the pitcher.
const probeCornerSight = ({ seats, walls }) => {
  const scene = window.__crowd.scene
  const THREE = window.__crowd.THREE
  const ray = new THREE.Raycaster()
  const origin = new THREE.Vector3()
  const target = new THREE.Vector3(0, 0.85, 0.05)
  const meshes = walls.map((name) => scene.getObjectByName(name)).filter(Boolean)
  const hits = []
  for (const seat of seats) {
    origin.set(seat.x, seat.eye, seat.z)
    ray.set(origin, target.clone().sub(origin).normalize())
    ray.far = origin.distanceTo(target)
    const first = ray.intersectObjects(meshes, true)[0]
    if (first) {
      hits.push({ t: seat.t, deg: seat.deg, y: Number(first.point.y.toFixed(2)), what: first.object.name })
    }
  }
  return hits
}

// A rear facade's coping, as the scene's own mesh has it: how high the band sits,
// how far off its facade it stands, how far round it runs, and what it is
// coloured.
const probeCoping = ({ name }) => {
  const scene = window.__crowd.scene
  const mesh = scene.getObjectByName(name)
  if (!mesh) return null
  const position = mesh.geometry.getAttribute('position')
  const color = mesh.geometry.getAttribute('color')
  const out = {
    verts: position.count,
    minY: Infinity, maxY: -Infinity,
    minR: Infinity, maxR: -Infinity,
    minAngle: Infinity, maxAngle: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
    minX: Infinity, maxX: -Infinity,
    warm: 0, cool: 0,
  }
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i)
    const y = position.getY(i)
    const z = position.getZ(i)
    const r = Math.hypot(x, z)
    out.minY = Math.min(out.minY, y)
    out.maxY = Math.max(out.maxY, y)
    out.minR = Math.min(out.minR, r)
    out.maxR = Math.max(out.maxR, r)
    out.minAngle = Math.min(out.minAngle, Math.atan2(x, -z))
    out.maxAngle = Math.max(out.maxAngle, Math.atan2(x, -z))
    out.minZ = Math.min(out.minZ, z)
    out.maxZ = Math.max(out.maxZ, z)
    out.minX = Math.min(out.minX, x)
    out.maxX = Math.max(out.maxX, x)
    if (color) {
      const cr = color.getX(i)
      const cg = color.getY(i)
      const cb = color.getZ(i)
      if (cr > cg * 1.15 && cr > cb * 1.15) out.warm += 1
      else out.cool += 1
    }
  }
  return out
}

// The bank's planting in the round, as the scene's own mesh has it. A clump is a
// box, so its vertices come in whole boxes (36 a box); the tops are read in
// buckets round the corner, because a bush row drawn on one even line would
// show up as the same height in every bucket.
const probeClumps = () => {
  const scene = window.__crowd.scene
  const mesh = scene.getObjectByName('corner-bed-clumps')
  const bed = scene.getObjectByName('corner-bed')
  if (!mesh || !bed) return null
  // The turf's own crest on each corner, so a bush is measured against the
  // bank it grows on rather than the taller corner's.
  const turf = bed.geometry.getAttribute('position')
  const crest = { left: -Infinity, right: -Infinity }
  for (let i = 0; i < turf.count; i += 1) {
    const key = turf.getX(i) < 0 ? 'left' : 'right'
    crest[key] = Math.max(crest[key], turf.getY(i))
  }
  const position = mesh.geometry.getAttribute('position')
  const sides = {
    left: { verts: 0, minY: Infinity, maxY: -Infinity, minAngle: Infinity, maxAngle: -Infinity, pts: [] },
    right: { verts: 0, minY: Infinity, maxY: -Infinity, minAngle: Infinity, maxAngle: -Infinity, pts: [] },
  }
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i)
    const y = position.getY(i)
    const z = position.getZ(i)
    const side = x < 0 ? sides.left : sides.right
    const angle = Math.abs(Math.atan2(x, -z))
    side.verts += 1
    side.minY = Math.min(side.minY, y)
    side.maxY = Math.max(side.maxY, y)
    side.minAngle = Math.min(side.minAngle, angle)
    side.maxAngle = Math.max(side.maxAngle, angle)
    side.pts.push([angle, y])
  }
  const out = { verts: position.count, left: null, right: null }
  for (const key of ['left', 'right']) {
    const side = sides[key]
    if (!side.verts) continue
    const span = side.maxAngle - side.minAngle || 1
    const BUCKETS = 12
    const tops = new Array(BUCKETS).fill(-Infinity)
    for (const [angle, y] of side.pts) {
      const bucket = Math.min(BUCKETS - 1, Math.floor(((angle - side.minAngle) / span) * BUCKETS))
      tops[bucket] = Math.max(tops[bucket], y)
    }
    out[key] = {
      verts: side.verts,
      minY: side.minY,
      maxY: side.maxY,
      crest: crest[key],
      tops: tops.filter((top) => top > -Infinity),
    }
  }
  return out
}

// The bleachers' own deck, counted at the corner's section line: the treads and
// the rear facade have to reach it, or the corner's cushions hang over the wedge
// with nothing under them.
const probeDeckAtLine = ({ angle }) => {
  const scene = window.__crowd.scene
  const deck = scene.getObjectByName('outfield-stands')
  if (!deck) return 0
  const position = deck.geometry.getAttribute('position')
  let atLine = 0
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i)
    const z = position.getZ(i)
    const side = x < 0 ? -1 : 1
    const off = side * x * Math.cos(angle) + z * Math.sin(angle)
    if (Math.abs(off) < 0.02 && Math.abs(x) > 60) atLine += 1
  }
  return atLine
}


test.describe('the blank sections', () => {
  test('the batter’s eye’s bay carries no seats and no crowd', async ({ page }) => {
    const problems = await openPark(page)
    const bay = await page.evaluate(probeBay, {
      frontR: BLEACHER_FRONT_R,
      ringBackR: RING_BACK_R,
      deckBottomY: DECK_BOTTOM_Y,
      bayHalf: EYE_BAY_HALF_ANGLE,
    })

    expect(bay.seatsInBay, 'no cushion may stand in the eye’s bay').toBe(0)
    // ...and the rows either side are still full, so the bay is a cut and not a
    // section the stand forgot to furnish.
    expect(bay.seatsBeside).toBeGreaterThan(200)
    expect(bay.fans, 'the crowd should still be seated').toBeGreaterThan(500)
    expect(bay.fansInBay, 'nobody may sit behind the screen').toBe(0)
    expect(problems).toEqual([])
  })

  test('the eye is set into a frame of the stand, not propped against it', async ({ page }) => {
    await openPark(page)
    const result = await page.evaluate(probeEye, {
      frontR: BLEACHER_FRONT_R,
      facadeTop: FACADE_TOP_Y,
      eyeTop: EYE_TOP_Y,
      eyeHalf: EYE_HALF_ANGLE,
      pierDepth: EYE_PIER_DEPTH,
    })

    const { eye, frame } = result
    expect(eye, 'the batter’s eye should be in the scene').not.toBeNull()
    expect(frame, 'the eye should have a concrete frame').not.toBeNull()

    // The cloth closes the middle of the frontage, just behind the padded wall,
    // and the span it covers is no wider than it says it is.
    expect(eye.outsideSpan).toBe(0)
    expect(eye.minR).toBeGreaterThan(BLEACHER_FRONT_R - 0.2)
    expect(eye.maxR).toBeLessThan(BLEACHER_FRONT_R + 0.5)
    expect(eye.maxY).toBeGreaterThan(DECK_BOTTOM_Y + TIERS * TIER_HEIGHT + 0.2)
    expect(eye.maxY).toBeLessThan(FACADE_TOP_Y)
    // Both faces: the screen the batter reads, and the back of the wall.
    expect(eye.front).toBeGreaterThan(0)
    expect(eye.back, 'the eye should be a wall with a back, not a sheet').toBeGreaterThan(0)

    // The frame is built, not painted on: piers either side, a cap over the
    // cloth, and depth to stand on the deck behind the screen.
    expect(frame.left).toBeGreaterThan(100)
    expect(frame.right).toBeGreaterThan(100)
    expect(frame.maxR, 'the piers should run back onto the deck').toBeGreaterThan(
      BLEACHER_FRONT_R + EYE_PIER_DEPTH - 0.1,
    )
    expect(frame.maxAbsAngle, 'the piers should sit outside the cloth').toBeGreaterThan(
      EYE_HALF_ANGLE + 0.004,
    )
    expect(frame.maxY).toBeGreaterThan(EYE_TOP_Y)
    expect(frame.maxY).toBeLessThan(FACADE_TOP_Y)
  })

  test('the corner rows run on past the foul pole, to the radial section line', async ({ page }) => {
    await openPark(page)
    const seatRadii = Array.from(
      { length: TIERS },
      (_, t) => BLEACHER_FRONT_R + (t + 1) * TIER_DEPTH - SEAT_INSET,
    )
    const corner = await page.evaluate(probeCornerSeats, { seatRadii })

    const ends = []
    for (const row of corner.rows) {
      // The row ends on the section line, clear of the brick: the last cushion is
      // within a seat pitch of it (the rows pack at a fixed 0.92 m, so a block's
      // leftover is split between its two ends).
      const end = CORNER_ANGLE - WALL_CLEAR / row.r
      expect(Math.abs(row.end - end) * row.r, 'the row should fill up to the wall').toBeLessThan(0.92)
      // ...and the line is past the foul pole, not on it.
      expect(row.end, 'every row should run on past the foul pole').toBeGreaterThan(Math.PI / 4 + 0.02)
      ends.push(row.end)
    }
    // One line for every row: the corner is squared off in plan, because its
    // section is a radius of the plate rather than a chord the rows stop at.
    const spread = Math.max(...ends) - Math.min(...ends)
    expect(spread, 'the rows should end on one radius, not a stepped chord').toBeLessThan(
      1.2 / BLEACHER_FRONT_R,
    )

    // Both corners are seated, not just one.
    expect(corner.left).toBeGreaterThan(12)
    expect(corner.right).toBeGreaterThan(12)
  })

  test('a radial brick wall closes the corner, flush with the deck', async ({ page }) => {
    await openPark(page)
    const wall = await page.evaluate(probeWall, { name: 'corner-wall', angle: CORNER_ANGLE })
    expect(wall, 'the corner wall should be in the scene').not.toBeNull()

    // One run each side, standing on the radius the rows stop on: its inner face
    // is the section line itself, and its thickness is the only thing past it.
    expect(wall.left).toBeGreaterThan(200)
    expect(wall.right).toBeGreaterThan(200)
    expect(wall.flush, 'the wall’s inner face should be the section line').toBeGreaterThan(40)
    expect(wall.minOff).toBeGreaterThan(-0.4)
    expect(wall.maxOff, 'the wall should be one wall thick, not a block').toBeLessThan(1.0)

    // It runs the bleachers' whole depth, from the padded wall to the rear
    // facade, so it closes the corner rather than stopping inside it.
    expect(wall.minR).toBeLessThan(BLEACHER_FRONT_R + 0.2)
    expect(wall.minR).toBeGreaterThan(BLEACHER_FRONT_R - 0.8)
    expect(wall.maxR).toBeCloseTo(RING_BACK_R, 0)

    // ...and rises from the ground to over the last row's deck: it is a wall, not
    // a rail along the back of the seats. Its rear pier is carried past the last
    // step to the bleachers' own rear facade and stopped level with it, so the
    // block is tied into that building rather than ending beside it.
    expect(wall.minY).toBeLessThan(0.2)
    expect(wall.maxY).toBeGreaterThan(DECK_BOTTOM_Y + TIERS * TIER_HEIGHT)
    expect(wall.maxY, 'the rear pier stands at the bleachers’ facade').toBeCloseTo(
      BLEACHER_FACADE_Y, 1,
    )
    expect(wall.maxY).toBeLessThan(FACADE_TOP_Y)

    // Brick, not the stands' concrete: every panel and pier is warm, with the
    // stone caps the only cool part of the run.
    expect(wall.warm, 'the wall should be brick, not concrete').toBeGreaterThan(500)
    expect(wall.cool, 'the stone caps should be there too').toBeGreaterThan(300)

    // The brick wears its own courses. The wall is one mesh, split into material
    // groups by the colour of each triangle: the warm ones take the brick map
    // (dark mortar in a running bond, each brick a shade off its neighbours),
    // the pale ones keep the stands' stone. Without that map the wall was one
    // flat red field at any distance -- a painted panel, not masonry.
    const face = await page.evaluate(() => {
      const mesh = window.__crowd.scene.getObjectByName('corner-wall')
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const groups = mesh.geometry.groups
      const brickGroups = groups.filter((group) => group.materialIndex === 0)
      const canvas = mats[0] && mats[0].map ? mats[0].map.image : null
      let mortar = 0
      let bricks = 0
      if (canvas) {
        const ctx = canvas.getContext('2d')
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        for (let i = 0; i < data.length; i += 4) {
          const luma = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11
          if (luma < 90) mortar += 1
          else if (luma > 180) bricks += 1
        }
      }
      return {
        mats: mats.length,
        mapped: !!canvas,
        groups: groups.length,
        brickGroups: brickGroups.length,
        brickTris: brickGroups.reduce((sum, group) => sum + group.count / 3, 0),
        mortar,
        bricks,
        texels: canvas ? canvas.width * canvas.height : 0,
      }
    })
    expect(face.mats, 'the wall should wear brick and stone').toBe(2)
    expect(face.mapped, 'the brick should carry a course map').toBe(true)
    expect(face.groups, 'the wall should be split into brick and stone runs').toBeGreaterThan(2)
    expect(face.brickGroups, 'the brick should be its own runs').toBeGreaterThan(0)
    expect(face.brickTris, 'the brick should be a run, not a token patch').toBeGreaterThan(150)
    expect(face.mortar / face.texels, 'the courses should be drawn in mortar').toBeGreaterThan(0.03)
    expect(face.mortar / face.texels, 'and no more than joints').toBeLessThan(0.4)
    expect(face.bricks / face.texels, 'the bricks should be the face of the tile').toBeGreaterThan(0.4)

    // The deck runs out flush with the brick, so the corner's cushions stand on
    // the stand's own treads rather than hanging over the wedge.
    const deck = await page.evaluate(probeDeckAtLine, { angle: CORNER_ANGLE })
    expect(deck, 'the deck should reach the wall').toBeGreaterThan(2 * TIERS)
  })

  test('the side stand’s end begins at the corner and never crosses the bleachers', async ({ page }) => {
    await openPark(page)
    const end = await page.evaluate(probeWall, { name: 'side-end-wall', angle: CORNER_ANGLE })
    expect(end, 'the side stand should have an end wall').not.toBeNull()

    // The wall used to start at the foul pole and run across the corner's
    // frontage, standing in front of the bleachers that carry on past the pole
    // to the section line. It is cut back to that line: every vertex is on the
    // corner's side of it now, and none of the wall stands in front of a seat.
    expect(end.minAngle, 'the wall should start at the corner line').toBeGreaterThan(
      CORNER_ANGLE - 0.01,
    )
    expect(end.minOff, 'nothing should stand in front of the section line').toBeGreaterThan(0)
    expect(end.minR, 'and nothing in front of the bleacher deck').toBeGreaterThan(
      BLEACHER_FRONT_R - 0.1,
    )
    expect(end.maxAngle).toBeGreaterThan((50.5 * Math.PI) / 180)
    expect(end.maxR).toBeGreaterThan(WALL_RADIUS + 3.0)

    // Brick, from the ground up to the stand's rear facade at its very end:
    // stone over the top rather than above the building beside it.
    expect(end.warm, 'the side stand’s end should be brick').toBeGreaterThan(120)
    expect(end.cool, 'the cornice and both courses should be stone').toBeGreaterThan(200)
    expect(end.minY).toBeLessThan(0.2)
    expect(end.maxY, 'the abutment reaches the stand’s rear facade').toBeCloseTo(FACADE_TOP_Y, 1)
    expect(end.maxY).toBeLessThan(FACADE_TOP_Y + 0.05)

    // It rakes up from the corner to the stand's own rear facade: the wall is a
    // court wall now, not an end elevation across the corner's seats, so its
    // lowest top is the corner's own parapet height and its tallest the pier.
    expect(end.minY).toBeLessThan(0.2)
    expect(end.maxY, 'the rear pier should reach the facade').toBeCloseTo(FACADE_TOP_Y, 1)
  })

  test('both rear facades are capped in stone, at the height the corner climbs to', async ({ page }) => {
    await openPark(page)

    // The bleachers: one stone band along the top of their rear facade, from one
    // corner's section line to the other. Its top is that facade's own top -- the
    // height the corner wall's rear pier stops at -- and its bed is the corner's
    // own cornice, so the pier's cap and the coping finish on one line.
    const bleacher = await page.evaluate(probeCoping, { name: 'bleacher-coping' })
    expect(bleacher, 'the bleachers’ eave should carry a coping').not.toBeNull()
    expect(bleacher.maxY).toBeCloseTo(BLEACHER_FACADE_Y, 2)
    expect(bleacher.minY).toBeCloseTo(BLEACHER_FACADE_Y - CORNICE, 2)
    expect(bleacher.cool, 'the coping should be stone').toBeGreaterThan(1000)
    expect(bleacher.warm, 'and stone all through, not a course of brick').toBe(0)
    // It stands proud of the facade toward the field, and only just behind it:
    // a saddle over the eave, not a ledge on the crowd's side of it.
    expect(bleacher.minR).toBeCloseTo(RING_BACK_R - 0.24, 1)
    expect(bleacher.maxR).toBeGreaterThan(RING_BACK_R)
    expect(bleacher.maxR).toBeLessThan(RING_BACK_R + 0.1)
    // Both ends land on a corner's section line, where the abutment piers stand.
    expect(bleacher.minAngle).toBeLessThan(-CORNER_ANGLE + 0.002)
    expect(bleacher.minAngle).toBeGreaterThan(-CORNER_ANGLE - 0.02)
    expect(bleacher.maxAngle).toBeGreaterThan(CORNER_ANGLE - 0.002)
    expect(bleacher.maxAngle).toBeLessThan(CORNER_ANGLE + 0.02)

    // The grandstand: the same band at its own facade's top, carried from foul
    // pole to foul pole, so the side walls' rear posts meet a coping too.
    const grandstand = await page.evaluate(probeCoping, { name: 'grandstand-coping' })
    expect(grandstand, 'the grandstand’s eave should carry the same coping').not.toBeNull()
    expect(grandstand.maxY).toBeCloseTo(FACADE_TOP_Y, 2)
    expect(grandstand.minY).toBeCloseTo(FACADE_TOP_Y - CORNICE, 2)
    expect(grandstand.cool, 'the same stone as the corner').toBeGreaterThan(1500)
    expect(grandstand.warm).toBe(0)
    // Round behind the backstop, and on to both poles: the band ends where the
    // side stand's rear posts stand, a stand's depth out from each foul pole.
    expect(grandstand.maxZ, 'the coping should run round behind the plate').toBeGreaterThan(27)
    expect(grandstand.minX, 'it should reach the left-field end').toBeLessThan(-78)
    expect(grandstand.maxX, 'it should reach the right-field end').toBeGreaterThan(78)
    expect(grandstand.minX).toBeGreaterThan(-82)
    expect(grandstand.maxX).toBeLessThan(82)
  })

  test('every corner seat sees over the end wall to the strike zone', async ({ page }) => {
    await openPark(page)

    // The bleachers, row by row, right round to the corner: every seat that
    // looks along the corner block rather than across the field at it, at a
    // cushion's eye height, both sides.
    const seats = []
    for (let t = 0; t < TIERS; t += 1) {
      const r = BLEACHER_FRONT_R + (t + 1) * TIER_DEPTH - SEAT_INSET
      const eye = DECK_BOTTOM_Y + t * TIER_HEIGHT + 1.15
      for (let deg = 30; deg <= 47.0; deg += 0.5) {
        const a = (deg * Math.PI) / 180
        for (const side of [-1, 1]) {
          seats.push({
            t,
            deg: side * deg,
            x: side * r * Math.sin(a),
            z: -r * Math.cos(a),
            eye,
          })
        }
      }
    }

    const hits = await page.evaluate(probeCornerSight, {
      seats,
      walls: ['corner-wall', 'side-end-wall', 'corner-bed', 'corner-bed-clumps'],
    })
    expect(hits, 'nothing in the corner block may cut a seat’s line to the plate').toEqual([])
  })

  test('the corner is open across the back, over a planted court', async ({ page }) => {
    await openPark(page)

    // The two things that used to join the stands across the corner -- the wall
    // that spanned the notch and the hip that bridged the two roofs -- are gone,
    // so the court between the end walls is open to the sky and to the outside.
    const open = await page.evaluate(() =>
      ['corner-back', 'corner-roof'].map((name) => !!window.__crowd.scene.getObjectByName(name)),
    )
    expect(open, 'the corner’s back wall and roof hip should be gone').toEqual([false, false])

    // What is left in the notch is planted, on both corners: a bank of turf, not
    // a panel. It climbs away from the plate with the bleachers' rows and is cut
    // back to the ground at the mouth, so its heights run from the field to the
    // rear copings -- high enough to show over the stepped corner wall from home
    // plate, and low enough never to stand over either building's eave.
    const bed = await page.evaluate(probeWall, { name: 'corner-bed', angle: CORNER_ANGLE })
    expect(bed, 'the vacant court should carry a grass bank').not.toBeNull()
    expect(bed.left).toBeGreaterThan(4)
    expect(bed.right).toBeGreaterThan(4)
    expect(bed.minY, 'the bank should run down to the ground at the mouth').toBeLessThan(0.1)
    expect(bed.maxY, 'the crest should reach the rear copings').toBeGreaterThan(
      BLEACHER_FACADE_Y - 0.5,
    )
    expect(bed.maxY, 'and stay under the taller stand’s eave').toBeLessThan(FACADE_TOP_Y - 0.05)
    expect(bed.maxY - bed.minY, 'a bank, not a panel').toBeGreaterThan(6.5)

    // It sits inside the court: behind the padded field wall, out to the mouth
    // the back wall left, and past the section line the bleachers end on.
    expect(bed.minR, 'the bank should stand clear of the field wall').toBeGreaterThan(WALL_RADIUS + 0.4)
    expect(bed.maxR, 'and run back to the mouth').toBeGreaterThan(RING_BACK_R - 1.2)
    expect(bed.maxR, 'without passing the rear facades').toBeLessThan(RING_BACK_R + 0.2)
    expect(bed.minAngle).toBeGreaterThan(Math.PI / 4 + 0.002)
    expect(bed.maxAngle).toBeLessThan((52 * Math.PI) / 180)

    // Its edge is the block's own stone, laid round all three walls.
    const kerb = await page.evaluate(probeWall, { name: 'corner-bed-kerb', angle: CORNER_ANGLE })
    expect(kerb, 'the bed should have a stone edge').not.toBeNull()
    expect(kerb.left).toBeGreaterThan(30)
    expect(kerb.right).toBeGreaterThan(30)
    expect(kerb.maxY).toBeCloseTo(0.16, 2)
    expect(kerb.minY).toBeLessThan(0.05)
    expect(kerb.warm, 'the edge should be stone, not brick').toBe(0)
    expect(kerb.cool).toBeGreaterThan(60)
    expect(kerb.minR).toBeGreaterThan(WALL_RADIUS + 0.4)
    expect(kerb.maxR).toBeLessThan(RING_BACK_R + 0.2)

    // The bank is planted in the round, not drawn on its plane: blocky leaf
    // clumps make up its crest and its batter. A clump is a box (36 vertices),
    // so the mesh's vertex count is whole boxes, and its fringe stands over the
    // turf's crest instead of following the slope's drawn edge. The tops are
    // read in buckets along the corner: an even bush row would sit on one line,
    // while the crest is meant to break into brows and notches.
    const clumps = await page.evaluate(probeClumps)
    expect(clumps, 'the bank should carry leaf clumps in the round').not.toBeNull()
    expect(clumps.verts % 36, 'every clump should be a box').toBe(0)
    for (const side of ['left', 'right']) {
      const corner = clumps[side]
      expect(corner, `the ${side} corner should be planted`).not.toBeNull()
      expect(corner.verts, 'a crop of bushes, not a token few').toBeGreaterThan(300)
      expect(corner.maxY, 'the bushes should stand over the bank’s crest').toBeGreaterThan(
        corner.crest + 0.1,
      )
      // The bank's mass stays under the taller stand's eave, but its leaves may
      // crown a hand's width over the coping: that fringe is what reads as
      // planting over the stepped wall from the plate.
      expect(corner.maxY, 'and only its leaves over the taller stand’s eave').toBeLessThan(
        FACADE_TOP_Y + 0.5,
      )
      expect(corner.minY, 'the planting should spill down to the mouth').toBeLessThan(0.8)
      expect(corner.tops.length, 'bushes along the whole run').toBeGreaterThan(8)
      expect(
        Math.max(...corner.tops) - Math.min(...corner.tops),
        'the skyline should be ragged, not one drawn line',
      ).toBeGreaterThan(0.2)
    }
  })

  test('the blue padding runs past both poles to the corner walls', async ({ page }) => {
    await openPark(page)

    // The bleachers carry on past the foul poles to the section line, so the
    // padding carries on with them: the field wall keeps its navy bays and its
    // yellow rail round the corner instead of changing to brick at the pole.
    const front = await page.evaluate(probeFieldWall)
    expect(front, 'the padded wall should be in the scene').not.toBeNull()
    expect(front.textured, 'the wall should still wear its padding texture').toBe(true)

    expect(front.minAngle, 'the pads should reach the left-field corner').toBeLessThan(
      -CORNER_ANGLE + 0.005,
    )
    expect(front.maxAngle, 'and the right-field corner').toBeGreaterThan(CORNER_ANGLE - 0.005)
    expect(front.maxAngle).toBeLessThan(CORNER_ANGLE + 0.02)

    // ...at the wall's own line and height: the same ring as between the poles.
    expect(front.minR).toBeGreaterThan(WALL_RADIUS - 0.35)
    expect(front.maxR).toBeLessThan(WALL_RADIUS + 0.35)
    expect(front.minY).toBeLessThan(0.1)
    expect(front.maxY).toBeCloseTo(WALL_HEIGHT, 2)

    // There is no separate masonry run carrying the pads round the corner now.
    expect(
      await page.evaluate(() => !!window.__crowd.scene.getObjectByName('corner-front')),
      'the corner should have no brick apron',
    ).toBe(false)
  })

})
