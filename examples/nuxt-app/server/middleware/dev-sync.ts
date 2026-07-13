// Nuxt/Nitro mount for the embedded apply engine (dev only).
//
// Every other example mounts the engine on Vite's connect stack via
// `devSync()`'s `server.middlewares.use("/__dev-sync", …)`. That seam does NOT
// work under Nuxt: Nuxt runs Vite in middleware-mode inside Nitro (H3), and
// Nitro owns HTTP routing — it SSRs `/__dev-sync/*` with its catch-all renderer
// BEFORE Vite's connect middleware ever sees the request. So the engine must be
// mounted on Nitro instead. A Nitro server middleware runs ahead of the SSR
// catch-all, so this intercepts `/__dev-sync/*` first.
//
// `createApplyMiddleware` matches routes RELATIVE to its mount prefix (it owns
// `/apply`, `/journal`, …, not `/__dev-sync/apply`). On Vite, connect strips the
// prefix; here we strip it by hand before delegating, then restore nothing —
// a handled request has already been answered, an unmatched one 404s via the
// engine's own `next()` (which continues into Nitro's normal handling).
import { createApplyMiddleware, configFromRoot, type ConnectMiddleware } from "@dev-sync/server/engine";

const MOUNT_PREFIX = "/__dev-sync";

// Build once. `import.meta.dev` is compiled out of production, so `engine`
// stays null in the built server and this middleware is a no-op pass-through.
const engine: ConnectMiddleware | null = import.meta.dev
  ? createApplyMiddleware(configFromRoot(process.cwd()))
  : null;

export default fromNodeMiddleware((req, res, next) => {
  if (!engine || !req.url?.startsWith(MOUNT_PREFIX)) return next();
  // Strip the mount prefix so the engine sees its relative routes.
  req.url = req.url.slice(MOUNT_PREFIX.length) || "/";
  engine(req, res, next);
});
