import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
//
// `base` is the subpath the built app is served from. Leave it unset for a
// domain root (the Oracle VM, user.github.io, a custom domain) and set
// VITE_BASE=/<repo>/ when the build goes to a GitHub Pages project site.
// `import.meta.env.BASE_URL` (see src/util/assetUrl.js) follows this value.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const base = env.VITE_BASE || '/'

  return {
    base,
    plugins: [react()],
  }
})
