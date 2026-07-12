// Mounts the css-devtools-sync apply engine on this app's own origin.
// `withDevSync` (next.config.ts) rewrites /__dev-sync/* → /api/__dev-sync/*,
// which this catch-all serves. Writes are jailed under process.cwd() (this app).
import { createDevSyncHandler, engineApiConfig } from "@dev-sync/webpack/handler";

export const config = engineApiConfig; // engine reads the raw body itself

export default createDevSyncHandler();
