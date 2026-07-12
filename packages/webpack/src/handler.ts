import type { IncomingMessage, ServerResponse } from "node:http";
import { configFromRoot, createApplyMiddleware } from "@dev-sync/server/engine";

/**
 * Drop this into a Next **pages/api** catch-all so the apply engine runs on the
 * app's own origin:
 *
 * ```ts
 * // pages/api/__dev-sync/[...path].ts
 * import { createDevSyncHandler, engineApiConfig } from "@dev-sync/webpack/handler";
 * export const config = engineApiConfig; // engine reads the raw body itself
 * export default createDevSyncHandler();
 * ```
 *
 * `withDevSync` rewrites the page-origin `/__dev-sync/*` onto `/api/__dev-sync/*`,
 * which this handler serves. The engine middleware is connect-style `(req,res,next)`
 * and a `NextApiRequest`/`NextApiResponse` extend Node's `IncomingMessage`/
 * `ServerResponse`, so it plugs straight in.
 */
export interface DevSyncHandlerOptions {
  /** Workspace root every engine write is jailed under. Defaults to `process.cwd()`. */
  root?: string;
}

/** Next needs the raw request stream intact — the engine buffers the body itself. */
export const engineApiConfig = { api: { bodyParser: false } } as const;

/** Strip the mount prefix so the engine middleware sees its own route (`/apply`, …). */
export function toEnginePath(url: string): string {
  const stripped = url.replace(/^\/api\/__dev-sync/, "").replace(/^\/__dev-sync/, "");
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

export function createDevSyncHandler(
  options: DevSyncHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const cfg = configFromRoot(options.root ?? process.cwd());
  const middleware = createApplyMiddleware(cfg);

  return function devSyncApiHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.url = toEnginePath(req.url ?? "");
    // The engine ends `res` out-of-band; resolve when the response closes so Next
    // sees the handler complete (otherwise it warns "resolved without a response").
    return new Promise<void>((resolve) => {
      res.once("close", () => resolve());
      middleware(req, res, () => {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "not found" }));
      });
    });
  };
}

export default createDevSyncHandler;
