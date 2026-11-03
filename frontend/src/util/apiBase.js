// Where the FastAPI backend lives.
//
// One switch, three deployment shapes:
//   vite dev            → unset, DEV build       → http://localhost:8000
//   Oracle VM           → unset, production      → '' (same origin; Caddy
//                          serves dist/ and reverse-proxies /api to uvicorn)
//   GitHub Pages        → VITE_API_BASE=https://<backend-host> at build time
//
// Trailing slashes are stripped so callers can always append `/api/...`.
// `import.meta.env` only exists under Vite; the guards keep this module
// importable from plain Node (util/playerKit.js is loaded by node --test).
const configured = String(import.meta.env && import.meta.env.VITE_API_BASE || '')
  .trim()
  .replace(/\/+$/, '');

const isDev = !!(import.meta.env && import.meta.env.DEV);

export const API_BASE = configured || (isDev ? 'http://localhost:8000' : '');

// Absolute-or-same-origin URL for one API path.
export const apiUrl = (path) =>
  `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
