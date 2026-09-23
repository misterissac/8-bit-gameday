import { defineConfig, devices } from '@playwright/test'
// Imported rather than read off the global: the project's lint config declares
// browser globals only.
import { env } from 'node:process'

// Visual-regression suite for the batter. The Node unit tests in ./test keep
// running under `npm test` (node:test); only ./e2e is picked up here.
//
// Determinism matters more than realism in the launch args: rendering is forced
// onto ANGLE's SwiftShader software rasterizer so the same WebGL output is
// produced on any machine, and every device-scale / color-profile source of
// pixel drift is pinned. Baselines are therefore generated once and compared
// pixel-for-pixel.
const PORT = 5179
// Vite 8's default host resolves to IPv6 ::1 only, which Chromium refuses to
// connect to when it resolves localhost to 127.0.0.1, so bind both ends of the
// loopback explicitly.
const HOST = `http://127.0.0.1:${PORT}`
const HARNESS_PATH = '/e2e/harness/batter.html'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!env.CI,
  retries: 0,
  // Several tests walk all four phases of the swing in one test (each phase is a
  // page load plus a render), which is well past the 30s default.
  timeout: 90000,
  reporter: [['list']],
  outputDir: '.playwright/artifacts',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  expect: {
    timeout: 20000,
    toHaveScreenshot: {
      // WebGL antialiasing can jitter by a hairline on a few pixels; anything
      // beyond that is a real pose regression.
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    baseURL: HOST,
    viewport: { width: 960, height: 720 },
    deviceScaleFactor: 1,
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
        launchOptions: {
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--force-color-profile=srgb',
            '--hide-scrollbars',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `${HOST}${HARNESS_PATH}`,
    reuseExistingServer: !env.CI,
    timeout: 120000,
  },
})
