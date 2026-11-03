// Resolve a file under `public/` against Vite's configured base.
//
// Vite rewrites the asset URLs it can see in index.html and CSS, but it does not
// touch string literals in JS. Everything in public/ lands at the build root,
// so a project-scoped deploy — GitHub Pages at /<repo>/ — needs the base
// prefixed by hand. This is the one place that happens.
//
// `import.meta.env` only exists under Vite. Node's test runner imports this
// module through util/playerKit.js, so read it defensively and fall back to the
// site root. Under Vite the member expression is replaced at build time.
const base = (import.meta.env && import.meta.env.BASE_URL) || '/';

export const assetUrl = (path) =>
  `${base}${String(path).replace(/^\/+/, '')}`;
