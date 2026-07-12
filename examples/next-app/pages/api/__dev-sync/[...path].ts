// Mounts the css-devtools-sync apply engine on this app's own origin.
// `withDevSync` (next.config.ts) rewrites /__dev-sync/* → /api/__dev-sync/*,
// which this catch-all serves. Writes are jailed under process.cwd() (this app).
import { createDevSyncHandler, engineApiConfig } from "@dev-sync/webpack/handler";

export const config = engineApiConfig; // engine reads the raw body itself

// overridesFile: promoted inline-style rules must land in a sheet this app
// actually imports — App Router loads app/globals.css (via layout.tsx), never
// the Vite-default src/index.css, so point promotion there.
export default createDevSyncHandler({ overridesFile: "app/globals.css" });
