#!/usr/bin/env node
// Pose sheet: render the batter at each phase of the swing, from one or more
// views, into a single self-contained HTML page.
//
// It is the manual counterpart to the visual-regression suite: same harness, same
// lighting, same frozen clock, but it writes a sheet to look at instead of
// comparing pixels to a baseline, and it can take parts of the body out of the
// way (`--fade=arms,head` draws them translucent) so the torso's own shape and
// twist can be read through them.
//
//   npm run pose-sheet
//   npm run pose-sheet -- --fade=arms,head --views=front,side --zoom=1.4
//   npm run pose-sheet -- --phases=midSwing --focus=torso --fade=arms,head,legs
//   npm run pose-sheet -- --dot=1.17,1.23,1.29 --focus=torso --zoom=2
//   npm run pose-sheet -- --phases=recovery --time=1.10,1.20,1.30 --focus=torso
//
// Output: .playwright/pose-sheet/index.html (gitignored), printed when it is done.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
// Imported rather than read off the global: the project's lint config declares
// browser globals only.
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = '/e2e/harness/batter.html'
const PHASES = ['stance', 'midSwing', 'contact', 'followThrough', 'recovery']
const VIEWS = ['three-quarter', 'front', 'side', 'side-trail', 'back', 'top', 'low']

const { values } = parseArgs({
  options: {
    views: { type: 'string' },
    phases: { type: 'string' },
    zoom: { type: 'string' },
    focus: { type: 'string' },
    fade: { type: 'string' },
    'fade-opacity': { type: 'string' },
    // Height aids: ?mark=1 draws the harness's ruler (rings every 0.05 rig units,
    // magenta on the tenths), ?ring=1.2,1.3 draws just those heights, and
    // ?dot= draws a small coloured dot either side of the body at each height.
    mark: { type: 'boolean' },
    ring: { type: 'string' },
    dot: { type: 'string' },
    // Clock times to pin inside each phase's own window (a comma list, rendered
    // as extra columns). The harness understands ?time=|, so a moment between the
    // named shots — the arms unwinding off the torso mid-recovery, say — is one
    // command away instead of a new phase.
    time: { type: 'string' },
    port: { type: 'string' },
    out: { type: 'string' },
  },
})

const list = (value, fallback) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : fallback)
const views = list(values.views, VIEWS)
const phases = list(values.phases, PHASES)
const zoom = values.zoom || '1'
const focus = values.focus ? `&focus=${values.focus}` : ''
const fade = list(values.fade, [])
const fadeOpacity = values['fade-opacity'] || '0.18'
const fadeQuery = fade.length ? `&fade=${fade.join(',')}&fadeOpacity=${fadeOpacity}` : ''
const rings = (value) => list(value, []).filter((height) => Number.isFinite(Number(height))).join(',')
const markQuery = values.mark ? '&mark=1' : ''
const ringQuery = rings(values.ring) ? `&ring=${rings(values.ring)}` : ''
const dotQuery = rings(values.dot) ? `&dot=${rings(values.dot)}` : ''
const times = list(values.time, []).filter((time) => Number.isFinite(Number(time)))
// One column per (phase, time) pair; no --time means the phase's own pin.
const sheetColumns = phases.flatMap((phase) => (
  times.length
    ? times.map((time) => ({ phase, label: `${phase} @${time}s`, time }))
    : [{ phase, label: phase, time: null }]
))
const port = Number(values.port || 5188)
const out = resolve(ROOT, values.out || '.playwright/pose-sheet/index.html')
const origin = `http://127.0.0.1:${port}`

for (const phase of phases) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase "${phase}" (expected one of ${PHASES.join(', ')})`)
}
for (const view of views) {
  if (!VIEWS.includes(view)) throw new Error(`unknown view "${view}" (expected one of ${VIEWS.join(', ')})`)
}

const alive = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
    return response.ok
  } catch {
    return false
  }
}

// Reuse whatever is already serving this port (a dev server someone left running),
// and only own — and so only stop — a server this script started.
let server = null
const startServer = async () => {
  if (await alive(`${origin}${HARNESS}`)) return
  console.log(`starting a dev server on ${origin} …`)
  server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  })
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (await alive(`${origin}${HARNESS}`)) return
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`the dev server never answered on ${origin}`)
}

const stopServer = () => {
  if (!server) return
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

const run = async () => {
  await startServer()
  // Same rendering setup as the suite (software rasterizer, pinned color
  // profile) so a sheet tile and a baseline are directly comparable.
  const browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
    ],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 })
    const tiles = []
    for (const view of views) {
      for (const column of sheetColumns) {
        const timeQuery = column.time ? `&time=${column.time}` : ''
        const url = `${origin}${HARNESS}?phase=${column.phase}${timeQuery}&view=${view}&zoom=${zoom}${focus}${fadeQuery}${markQuery}${ringQuery}${dotQuery}`
        await page.goto(url)
        await page.waitForFunction(() => window.__vr?.ready === true, null, { timeout: 60000 })
        const state = await page.evaluate(() => ({ faded: window.__vr.fadedMeshes }))
        if (fade.length && !state.faded) throw new Error(`the fade did not apply (${url})`)
        await page.waitForTimeout(100)
        tiles.push({ view, phase: column.label, png: (await page.screenshot()).toString('base64') })
      }
    }
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, sheet(tiles, { zoom, fade }))
    console.log(
      `wrote ${out}\n` +
      `${views.length} view(s) × ${sheetColumns.length} column(s)` +
      (fade.length ? ` · faded ${fade.join(', ')} to ${fadeOpacity}` : '') +
      `\nZoom: ${zoom}${focus ? ` · focused on ${values.focus}` : ''}`,
    )
  } finally {
    await browser.close()
    stopServer()
  }
}

const sheet = (tiles, { zoom, fade }) => {
  const columns = [...new Set(tiles.map((tile) => tile.phase))]
  const caption = (tile) => `${tile.view} · ${tile.phase}`
  return `<!doctype html><meta charset="utf-8"><title>Batter pose sheet</title><style>
body{margin:0;background:#111;color:#eee;font:12px/1.5 -apple-system,system-ui,sans-serif}
header{padding:8px 10px;opacity:.85}
.grid{display:grid;grid-template-columns:repeat(${columns.length},1fr);gap:2px;padding:0 2px 8px}
figure{margin:0}
img{width:100%;display:block;background:#8fc4ec}
figcaption{padding:2px 4px;opacity:.8}
</style>
<header>Batter pose sheet — zoom ${zoom}${fade.length ? ` · ${fade.join(', ')} drawn translucent` : ''}</header>
<div class="grid">
${tiles.map((tile) => `<figure><img src="data:image/png;base64,${tile.png}"><figcaption>${caption(tile)}</figcaption></figure>`).join('\n')}
</div>`
}

await run()
