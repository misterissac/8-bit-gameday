import { test, expect } from '@playwright/test'
import { SHOUT_SWELL_STEPS } from '../src/util/shoutMarks.js'

// ---------------------------------------------------------------------------
// The shout marks, seen in the park.
//
// test/shoutMarks.test.js pins the layout's arithmetic; this suite pins what the
// park does with it, because the failure this feature was written to fix was a
// *motion* one — voice marks that drifted up out of the crowd like bubbles. That
// cannot be read off a layout: it is a thing the rendered meshes do over time.
//
// So the harness is opened on a shouting row with its show held mid-act
// (?crowdHold=all, util/showMotion.js), and the marks' own meshes are sampled for
// a second and a half. Over that window:
//
//   * each mark stays within a few centimetres of its corner — no climb, and no
//     wandering either, only the boil's twitch;
//   * each mark grows out of a nub and shrinks away over its beat in whole
//     sizes, rather than sitting at one size and blinking, or inflating a pixel
//     at a time;
//   * both corners are up for most of the window, and never both quiet for long;
//   * the three wedges point up and out of the group — up the screen and away
//     from the row's own centre, and fanning the same way — so the mark is a
//     shout thrown off the corner, not three flagpoles; and the three are drawn
//     in their own lanes, with daylight between the streaks rather than one
//     thick band.
//
// The marks are found by the names CrowdShow gives them, and the row's layout is
// read back from `window.__crowdLayouts`, so the suite describes the real row it
// was given rather than a hard-coded one.
// ---------------------------------------------------------------------------

const HOLD = 'crowdHold=all&crowdHoldT=2.5'
// Long enough to see a climb that a slow headless renderer can show: the marks
// used to rise a third of a metre a second, so a few seconds of frames is a
// metre of drift to catch, against a quarter of a metre of allowed twitch. It
// also has to be long enough to catch the small end of the swell ladder, which
// the mark only holds for a fraction of its beat.
const SHOW_SECONDS = 5

const openRow = async (page) => {
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(String(error)))
  // The harness renders at twice the viewport (dpr 2), so a small window is
  // what keeps the sampling loop's frames coming.
  await page.setViewportSize({ width: 900, height: 560 })
  await page.goto(`/e2e/harness/crowd.html?${HOLD}&group=0&dist=9.5&height=2.6&dpr=1`)
  await page.waitForFunction(() => window.__crowd?.ready === true)
  await page.waitForFunction(() => (window.__crowdLayouts ?? []).length > 0)
  return problems
}

test.describe('a shouting row’s marks', () => {
  test.describe.configure({ timeout: 120000 })

  test('stand over both top corners, three wedges each, and do not climb', async ({ page }) => {
    const problems = await openRow(page)

    const layout = await page.evaluate(() => window.__crowdLayouts[0])
    expect(layout.role).toBe('shout')
    expect(layout.bursts).toHaveLength(2)
    // One mark over each end of the row, clear of the last fan, and in the air
    // over the heads rather than among the seats.
    expect(layout.bursts.map((b) => b.side).sort()).toEqual([-1, 1])
    for (const burst of layout.bursts) {
      expect(Math.abs(burst.along)).toBeGreaterThanOrEqual(layout.span / 2)
      expect(Math.abs(burst.along)).toBeLessThan(layout.span / 2 + 0.4)
      expect(Math.sign(burst.along)).toBe(burst.side)
      expect(burst.height).toBeGreaterThan(1.2)
      // Three long thin wedges, each starting further out along its own line
      // than the last so the mark is read as three streaks.
      expect(burst.rays).toHaveLength(3)
      const offsets = burst.rays.map((ray) => ray.offset)
      expect(offsets[0]).toBeLessThan(offsets[1])
      expect(offsets[1]).toBeLessThan(offsets[2])
      // ...and each rides its own lane across the mark, the diagonal one
      // outboard and the upright one inboard, further apart than a wedge is
      // wide: three streaks, not one thick band.
      const lanes = burst.rays.map((ray) => ray.lane)
      expect(lanes[0]).toBeLessThan(lanes[1])
      expect(lanes[1]).toBeLessThan(lanes[2])
      expect(lanes[2] - lanes[0]).toBeGreaterThan(Math.max(...burst.rays.map((ray) => ray.width)))
      expect(lanes[1] - lanes[0]).toBeGreaterThan(0.1)
      expect(lanes[2] - lanes[1]).toBeGreaterThan(0.1)
      for (const ray of burst.rays) {
        expect(ray.length / ray.width).toBeGreaterThan(4)
        // Up and out: each wedge leans the way its corner faces, off upright
        // but well short of lying down.
        expect(Math.sign(ray.angle)).toBe(burst.side)
        expect(Math.abs(ray.angle)).toBeGreaterThan(0.25)
        expect(Math.abs(ray.angle)).toBeLessThan(0.95)
        expect(Math.cos(ray.angle)).toBeGreaterThan(0.5)
      }
    }

    // Sample the rendered marks: world position, whether they are up, and which
    // way each wedge's own +y points.
    const names = layout.bursts.map((_, i) => `crowd-mark-${layout.id}-${i}`)
    const samples = await page.evaluate(async ({ names: roots, seconds }) => {
      const { scene, THREE } = window.__crowd
      // Resolve the meshes once: the park is a big scene, and a lookup in a
      // frame loop costs more than the frames do.
      const entries = roots.map((name) => ({
        name,
        root: scene.getObjectByName(name),
        rays: [0, 1, 2].map((ri) => scene.getObjectByName(`${name}-${ri}`)),
        frames: [],
      }))
      const up = new THREE.Vector3()
      const tip = new THREE.Vector3()
      const position = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      const started = performance.now()
      while (performance.now() - started < seconds * 1000) {
        for (const entry of entries) {
          if (!entry.root) continue
          entry.root.getWorldPosition(position)
          const frame = {
            x: position.x,
            y: position.y,
            z: position.z,
            visible: entry.root.visible,
            scale: entry.root.scale.x,
            // Each wedge's own +y, world space: which way the streaks point...
            rayDirs: [],
            // ...and each wedge's own far end, so the gaps between the three
            // streaks can be measured as drawn rather than as planned.
            rayTips: [],
            rayWidths: [],
          }
          for (const ray of entry.rays) {
            if (!ray) continue
            ray.getWorldQuaternion(quaternion)
            up.set(0, 1, 0).applyQuaternion(quaternion)
            frame.rayDirs.push(up.x, up.y, up.z)
            tip.set(0, 1, 0).applyMatrix4(ray.matrixWorld)
            frame.rayTips.push(tip.x, tip.y, tip.z)
            // The wedge's width as drawn, taken from the same matrix as its tip
            // so the two cannot be a frame apart.
            const e = ray.matrixWorld.elements
            frame.rayWidths.push(Math.hypot(e[0], e[1], e[2]))
          }
          entry.frames.push(frame)
        }
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      return entries.map(({ name, frames }) => ({
        name,
        frames,
        anchor: window.__crowd.framing.anchor,
      }))
    }, { names, seconds: SHOW_SECONDS })

    const span = (values) => Math.max(...values) - Math.min(...values)
    for (const entry of samples) {
      expect(entry.frames.length).toBeGreaterThan(10)
      // The failure this replaced: these climbed a third of a metre a second.
      // A burst only twitches (±2.5 cm) and rides the row's own step, which the
      // held clock keeps still.
      expect(span(entry.frames.map((f) => f.y))).toBeLessThan(0.12)
      expect(span(entry.frames.map((f) => f.x))).toBeLessThan(0.12)
      expect(span(entry.frames.map((f) => f.z))).toBeLessThan(0.12)
      // Up for most of the window (a burst is up for 62% of its beat), and — the
      // point of the swell — it is not one size while it is: each shout is
      // thrown at a nub and grows to full size before it goes.
      const shown = entry.frames.filter((f) => f.visible)
      expect(shown.length / entry.frames.length).toBeGreaterThan(0.35)
      const scale = shown.map((f) => f.scale)
      expect(Math.max(...scale)).toBeGreaterThan(0.9)
      expect(Math.min(...scale)).toBeLessThan(0.6)
      expect(span(scale)).toBeGreaterThan(0.4)
      // ...and it grows in whole steps, not smoothly: every size the rendered
      // mark takes is one of the ladder's own, and it takes more than one.
      for (const s of scale) {
        expect(SHOUT_SWELL_STEPS.some((step) => Math.abs(step - s) < 1e-3)).toBe(true)
      }
      expect(new Set(scale.map((s) => s.toFixed(3))).size).toBeGreaterThan(1)
      // Sideways, and all one way: the three wedges are thrown off the group
      // (the narrow ends stay on the corner), not raised over it, and they fan
      // out rather than criss-crossing into a star.
      const dirs = shown.flatMap((f) => f.rayDirs)
      const horizontal = []
      for (let i = 0; i < dirs.length; i += 3) {
        // Up and out: a clear vertical component, and a clear sideways one.
        expect(dirs[i + 1]).toBeGreaterThan(0.45)
        expect(dirs[i + 1]).toBeLessThan(0.95)
        const across = Math.hypot(dirs[i], dirs[i + 2])
        expect(across).toBeGreaterThan(0.25)
        // ...and the sideways part is *away* from the row it came from: the
        // wedges lean off the group's own side, up and to the left at the left
        // corner and up and to the right at the right one, which is the whole
        // picture this feature is for.
        const frame = shown[Math.floor(i / 9)]
        const dx = frame.x - entry.anchor.x
        const dz = frame.z - entry.anchor.z
        const off = Math.hypot(dx, dz) || 1
        expect((dirs[i] * dx + dirs[i + 2] * dz) / off).toBeGreaterThan(0.15)
        horizontal.push([dirs[i], dirs[i + 2]])
      }
      for (let i = 1; i < horizontal.length; i++) {
        const [x0, z0] = horizontal[0]
        const [x1, z1] = horizontal[i]
        expect(x0 * x1 + z0 * z1).toBeGreaterThan(0)
      }
      // Separate streaks: the drawn far ends of neighbouring wedges stand
      // further apart than the wedges are wide, so daylight shows between them
      // at every size of the swell. This is the thing the lanes are for —
      // without them the three lean off one point and the plate camera draws a
      // single thick band with a frayed tip.
      for (const frame of shown) {
        const tips = frame.rayTips
        const widths = frame.rayWidths
        for (let i = 1; i < widths.length; i++) {
          const d = Math.hypot(
            tips[i * 3] - tips[(i - 1) * 3],
            tips[i * 3 + 1] - tips[(i - 1) * 3 + 1],
            tips[i * 3 + 2] - tips[(i - 1) * 3 + 2],
          )
          const daylight = d - (widths[i] + widths[i - 1]) / 2
          expect(daylight).toBeGreaterThan(0.02)
        }
      }
      const meanUp = dirs.reduce((sum, _, i) => (i % 3 === 1 ? sum + dirs[i] : sum), 0) / (dirs.length / 3)
      expect(meanUp).toBeLessThan(0.85)
    }
    // The corners alternate, so the row is shouting from one side or the other
    // nearly all the time rather than falling quiet as one mark fades.
    const together = samples[0].frames.map((frame, i) => frame.visible || samples[1].frames[i].visible)
    expect(together.filter(Boolean).length / together.length).toBeGreaterThan(0.95)

    expect(problems).toEqual([])
  })

  test('lean away from the group from either side of the row', async ({ page }) => {
    // The mark billboards to the camera, so its lean is picked in the screen
    // plane: viewed from behind the row, the mark on the left of the screen must
    // still point up and left. Away from the row's centre is the invariant that
    // covers both views.
    for (const view of ['', '&back=1']) {
      await page.setViewportSize({ width: 900, height: 560 })
      await page.goto(`/e2e/harness/crowd.html?crowdHold=all&crowdHoldT=2.9&group=0&dist=9&height=2.6&dpr=1${view}`)
      await page.waitForFunction(() => window.__crowd?.ready === true)
      await page.waitForFunction(() => (window.__crowdLayouts ?? []).length > 0)
      const { anchor, marks } = await page.evaluate(async () => {
        const { scene, THREE } = window.__crowd
        const layout = window.__crowdLayouts[0]
        // Let the camera settle and the frame loop place the marks.
        for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r))
        const out = []
        for (let bi = 0; bi < 2; bi++) {
          const root = scene.getObjectByName(`crowd-mark-${layout.id}-${bi}`)
          const ray = scene.getObjectByName(`crowd-mark-${layout.id}-${bi}-1`)
          const p = new THREE.Vector3()
          root.getWorldPosition(p)
          const q = new THREE.Quaternion()
          ray.getWorldQuaternion(q)
          const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
          out.push({ visible: root.visible, x: p.x, z: p.z, dx: dir.x, dy: dir.y, dz: dir.z })
        }
        return { anchor: window.__crowd.framing.anchor, marks: out }
      })
      const shown = marks.filter((mark) => mark.visible)
      expect(shown.length).toBeGreaterThan(0)
      for (const mark of shown) {
        const ox = mark.x - anchor.x
        const oz = mark.z - anchor.z
        const off = Math.hypot(ox, oz) || 1
        // Up the screen...
        expect(mark.dy).toBeGreaterThan(0.35)
        // ...and away from the group, never back across it.
        expect((mark.dx * ox + mark.dz * oz) / off).toBeGreaterThan(0.15)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The music row's instruments.
//
// The drums and horns are cut-out cards, not voxels: the drum wears the fan's
// own plane and beats between two drawn stick frames, the horn stands across
// that plane and bobs its bell through four poses. What this suite pins is the
// *motion* — that the cards really change on the playing clock rather than
// sitting still — and that they stay in the hands they were laid out for: the
// drum's card is rigid, only its texture beats, so the sticks never leave the
// palms; the horn's only rotation is the bob about its grip.
// ---------------------------------------------------------------------------

test.describe('a music row’s instruments', () => {
  test.describe.configure({ timeout: 120000 })

  test('are cut-outs, played in steps, and stay in the players’ hands', async ({ page }) => {
    const problems = []
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text())
    })
    page.on('pageerror', (error) => problems.push(String(error)))
    await page.setViewportSize({ width: 900, height: 560 })
    const open = async (group) => {
      await page.goto(`/e2e/harness/crowd.html?crowdHold=all&crowdHoldT=2.6&group=${group}&dist=6&height=2.2&dpr=1`)
      await page.waitForFunction(() => window.__crowd?.ready === true)
      await page.waitForFunction(() => (window.__crowdLayouts ?? []).length > 0)
    }
    await open(0)
    const music = await page.evaluate(() => window.__crowdLayouts.findIndex((l) => l.role === 'music'))
    expect(music).toBeGreaterThanOrEqual(0)
    await open(music)

    // The row is posed by instrument: a fan wearing the drum pose is the one
    // handed a drum, and the drum is worn at the waist while the horn is blown
    // at the chin. The assignment is read off the row's own fans and props, so
    // a change to either side that loses the other is caught here.
    const posing = await page.evaluate(() => {
      const layout = window.__crowdLayouts.find((l) => l.role === 'music')
      const group = window.__crowdGroups.find((g) => g.id === layout.id)
      return {
        seatY: layout.seatY,
        poses: group.fans.map((fan) => fan.pose),
        instruments: layout.instruments.map((inst) => ({ kind: inst.kind, y: inst.y })),
      }
    })
    expect(posing.poses.filter((pose) => pose === 'play').length).toBeGreaterThan(0)
    expect(posing.poses.filter((pose) => pose === 'drum').length).toBeGreaterThan(0)
    posing.instruments.forEach((inst, i) => {
      expect(inst.kind).toBe(posing.poses[i] === 'drum' ? 'drum' : 'trumpet')
    })
    const drumHeights = posing.instruments.filter((i) => i.kind === 'drum').map((i) => i.y - posing.seatY)
    const hornHeights = posing.instruments.filter((i) => i.kind === 'trumpet').map((i) => i.y - posing.seatY)
    for (const height of drumHeights) {
      expect(height, 'a drum is worn at the waist').toBeGreaterThan(0.02)
      expect(height, 'and below the chest').toBeLessThan(0.2)
    }
    for (const height of hornHeights) {
      expect(height, 'a horn is blown at the chin').toBeGreaterThan(0.25)
    }
    expect(Math.max(...drumHeights)).toBeLessThan(Math.min(...hornHeights) - 0.1)

    // The horns are formed at an angle to the row, not square to it: a card
    // aimed straight downfield is edge-on to any camera there and all but
    // vanishes, while an alternating cant keeps a silhouette open from both
    // sides without turning the props to the camera. The bell mouth faces down
    // each horn's own aim, so the instrument still reads as an open bell from
    // the plate when the card itself is nearly edge-on.
    const aiming = await page.evaluate(() => {
      const layout = window.__crowdLayouts.find((l) => l.role === 'music')
      const right = [layout.facing[2], 0, -layout.facing[0]]
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      return {
        facing: layout.facing,
        instruments: layout.instruments.map((inst) => ({
          kind: inst.kind,
          against: inst.aim ? dot(inst.aim, layout.facing) : null,
          along: inst.aim ? dot(inst.aim, right) : null,
          up: inst.aim ? inst.aim[1] : null,
          bellAt: inst.bellAt,
        })),
      }
    })
    const horns = aiming.instruments.filter((inst) => inst.kind === 'trumpet')
    expect(horns.length).toBeGreaterThan(1)
    for (const horn of horns) {
      expect(horn.against, 'a horn still blows out over the field').toBeGreaterThan(0.8)
      expect(Math.abs(horn.along), 'and is never edge-on to it').toBeGreaterThan(0.25)
      expect(horn.up, 'the bell climbs as before').toBeGreaterThan(0.2)
      expect(horn.bellAt).toBeGreaterThan(0.25)
      expect(horn.bellAt).toBeLessThan(0.42)
    }
    const cantSigns = horns.map((horn) => Math.sign(horn.along))
    cantSigns.forEach((sign, i) => {
      if (i === 0) return
      expect(sign, 'the formation alternates down the row').toBe(-cantSigns[i - 1])
    })

    // Every horn's bell mouth is a disc at the bell, its face down the horn's
    // own aim, and it is a child of the horn so it bobs with the playing.
    const bells = await page.evaluate(() => {
      const { scene, THREE } = window.__crowd
      const layout = window.__crowdLayouts.find((l) => l.role === 'music')
      return layout.instruments.map((inst, i) => {
        const root = scene.getObjectByName(`${layout.id}-inst-${i}`)
        const bell = root?.getObjectByName(`${layout.id}-inst-${i}-bell`)
        if (!bell) return null
        bell.updateWorldMatrix(true, false)
        const normal = new THREE.Vector3(0, 0, 1)
          .applyQuaternion(bell.getWorldQuaternion(new THREE.Quaternion()))
        return {
          normal: normal.toArray(),
          local: root.worldToLocal(bell.getWorldPosition(new THREE.Vector3())).toArray(),
        }
      })
    })
    const [, , facingZ] = aiming.facing
    const facingX = aiming.facing[0]
    aiming.instruments.forEach((inst, i) => {
      const bell = bells[i]
      if (inst.kind === 'drum') {
        expect(bell).toBeNull()
        return
      }
      expect(bell, 'a horn has a bell mouth').not.toBeNull()
      // The card bobs on the playing clock, so the bell's face is the aim
      // given a few degrees of nod.
      expect(Math.abs(bell.local[0] - inst.bellAt)).toBeLessThan(1e-6)
      expect(Math.abs(bell.local[1])).toBeLessThan(1e-6)
      expect(Math.abs(bell.local[2])).toBeLessThan(1e-6)
      expect(bell.normal[0] * facingX + bell.normal[2] * facingZ,
        'the bell’s mouth is open at the field').toBeGreaterThan(0.8)
    })

    const sample = await page.evaluate(async () => {
      const { scene } = window.__crowd
      const layout = window.__crowdLayouts.find((l) => l.role === 'music')
      const instruments = layout.instruments.map((inst, i) => ({
        kind: inst.kind,
        root: scene.getObjectByName(`${layout.id}-inst-${i}`),
      }))
      const frames = []
      const started = performance.now()
      while (performance.now() - started < 1600) {
        frames.push(instruments.map((inst) => {
          const card = inst.root?.children[0]
          if (!card) return null
          return {
            visible: inst.root.visible,
            map: card.material.map.uuid,
            q: inst.root.quaternion.toArray().map((v) => +v.toFixed(6)),
          }
        }))
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      return {
        kinds: instruments.map((inst) => inst.kind),
        cards: instruments.map((_, i) => ({
          quaternions: [...new Set(frames.map((f) => f[i]?.q).filter(Boolean).map((q) => q.join(',')))],
          maps: [...new Set(frames.map((f) => f[i]?.map).filter(Boolean))],
          shown: frames.filter((f) => f[i]?.visible).length,
        })),
        frames: frames.length,
      }
    })

    expect(sample.frames).toBeGreaterThan(10)
    // The row alternates horns and drums, both in the players' act pose.
    expect(sample.kinds.length).toBeGreaterThan(2)
    expect(new Set(sample.kinds)).toEqual(new Set(['trumpet', 'drum']))
    sample.cards.forEach((card, i) => {
      expect(card.shown).toBeGreaterThan(sample.frames * 0.9)
      if (sample.kinds[i] === 'drum') {
        // Two stick frames beat against each other on the playing clock…
        expect(card.maps).toHaveLength(2)
        // …while the card itself holds perfectly still: the hands are on its
        // corners, so a wobble here would tear the sticks out of the palms.
        expect(card.quaternions).toHaveLength(1)
      } else {
        // The horn's one silhouette is moved instead: its bell nods through
        // more than one of the four poses in the sampled beat.
        expect(card.quaternions.length).toBeGreaterThan(1)
        expect(card.maps).toHaveLength(1)
      }
    })

    expect(problems).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The show rows sit on their own seats.
//
// A show is laid out from the seats its fans were given. It used to be
// re-spaced onto the straight chord between its end seats, which kept the
// banner's cloth flat but lifted every middle fan up to a seat's width off its
// chair — most visibly when the row stood, because the chair it had left was
// not the one behind it. This pins the rule at the source: every show fan keeps
// its seat's position and yaw, and the row's only derived number is `s`, the
// along-row coordinate the wave and the props are written in. It also pins the
// window itself: the crowd fill keeps every seat in a show's window filled, so
// the row is an unbroken line of neighbours rather than a run with holes.
// ---------------------------------------------------------------------------

test.describe('a show row’s seats', () => {
  test.describe.configure({ timeout: 120000 })

  test('are the chairs the fans were given, not a redrawn line', async ({ page }) => {
    const problems = []
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text())
    })
    page.on('pageerror', (error) => problems.push(String(error)))
    await page.setViewportSize({ width: 900, height: 560 })
    await page.goto('/e2e/harness/crowd.html?crowdHold=all&crowdHoldT=2.5&group=0&dist=9&height=2.4&dpr=1')
    await page.waitForFunction(() => window.__crowd?.ready === true)
    await page.waitForFunction(() => (
      (window.__crowdSeats ?? []).length > 0 && (window.__crowdGroups ?? []).length > 0
    ))

    const groups = await page.evaluate(() => {
      const seats = new Map(window.__crowdSeats.map((seat) => [
        `${seat.block}:${seat.row}:${seat.seatIdx}`,
        seat,
      ]))
      return window.__crowdGroups.map((group) => ({
        id: group.id,
        role: group.role,
        from: group.from,
        to: group.to,
        fans: group.fans.map((fan) => {
          const seat = seats.get(`${fan.block}:${fan.row}:${fan.seatIdx}`)
          return {
            seatIdx: fan.seatIdx,
            s: fan.s,
            x: fan.x,
            y: fan.y,
            z: fan.z,
            yaw: fan.yaw,
            seatX: seat?.x ?? null,
            seatY: seat?.y ?? null,
            seatZ: seat?.z ?? null,
            seatYaw: seat?.yaw ?? null,
          }
        }),
      }))
    })

    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      expect(group.fans.length, `${group.id} has a row`).toBeGreaterThan(1)
      // The window is unbroken: every chair in it is filled, so the cloth has a
      // hand on each seat and the instruments alternate without a gap.
      expect(
        group.fans.map((fan) => fan.seatIdx).sort((a, b) => a - b),
        `${group.id} fills its whole window`,
      ).toEqual(Array.from({ length: group.to - group.from }, (_, i) => group.from + i))
      expect(group.fans[0].s).toBe(0)
      expect(group.fans[group.fans.length - 1].s).toBe(1)
      group.fans.forEach((fan, i) => {
        // The fan is exactly on the chair it was dealt: not a chord, not a
        // re-spacing, not the row's mean yaw.
        expect(fan.seatX, `${group.id} seat ${fan.seatIdx} is a real seat`).not.toBeNull()
        expect(fan.x, `${group.id} seat ${fan.seatIdx} x`).toBe(fan.seatX)
        expect(fan.y, `${group.id} seat ${fan.seatIdx} y`).toBe(fan.seatY)
        expect(fan.z, `${group.id} seat ${fan.seatIdx} z`).toBe(fan.seatZ)
        expect(fan.yaw, `${group.id} seat ${fan.seatIdx} yaw`).toBe(fan.seatYaw)
        // Numbered along the row: `s` is a coordinate, not a new layout. (The
        // seat numbers run either way along a block, so the row is ordered by
        // `s`, not by the index the seat grid gave each fan.)
        if (i > 0) {
          expect(fan.s).toBeGreaterThan(group.fans[i - 1].s)
          // ...and the neighbours along the row are neighbours on the concrete:
          // no seat was skipped between them.
          expect(Math.abs(fan.seatIdx - group.fans[i - 1].seatIdx), 'seats are adjacent').toBe(1)
        }
      })
      expect(new Set(group.fans.map((fan) => fan.seatIdx)).size).toBe(group.fans.length)
    }
    expect(problems).toEqual([])
  })
})
