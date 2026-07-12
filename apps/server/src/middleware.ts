import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import {
  CapturePayloadSchema,
  DescribeTemplateRequestSchema,
  JournalListSchema,
  UndoRequestSchema,
  UndoResultSchema,
  VerifyRequestSchema,
} from "@dev-sync/contract";
import type { Config } from "./config.js";
import { SkipChangeError } from "./errors.js";
import { WorkspaceError } from "./workspace.js";
import { applyPayload, describeTemplate } from "./apply.js";
import { verifyChecks } from "./verify.js";
import { readJournal, undo } from "./journal.js";

/** Connect-style middleware: (req, res, next). Matches Vite's `server.middlewares` and webpack devServer. */
export type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

/** Cap the request body before buffering — the engine never needs a large payload. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Routes this middleware owns (relative to its mount prefix) and their method. */
const ROUTES: Record<string, "GET" | "POST"> = {
  "/apply": "POST",
  "/describe": "POST",
  "/verify": "POST",
  "/undo": "POST",
  "/journal": "GET",
};

const JOURNAL_DEFAULT_LIMIT = 50;
const JOURNAL_MIN_LIMIT = 1;
const JOURNAL_MAX_LIMIT = 200;

/** Clamp an arbitrary `?limit=` into [1, 200], defaulting when absent/invalid. */
function clampLimit(raw: string | null): number {
  if (raw === null) return JOURNAL_DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return JOURNAL_DEFAULT_LIMIT;
  return Math.min(JOURNAL_MAX_LIMIT, Math.max(JOURNAL_MIN_LIMIT, n));
}

class PayloadTooLargeError extends Error {}

/** Minimal Zod issue view for the response — never leak the raw error object. */
interface ZodIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}
function issueSummary(issues: readonly ZodIssueLike[]): { path: string; message: string }[] {
  return issues.slice(0, 20).map((i) => ({
    path: i.path.map(String).join("."),
    message: i.message,
  }));
}

/**
 * Console-backed logger shaped like Fastify's (pino) `(obj, msg)` signature.
 * The engine only calls `.error`/`.warn`/`.info`; the rest are no-ops so we can
 * satisfy `FastifyBaseLogger` without pulling pino into the dev-server process.
 */
function consoleLogger(): FastifyBaseLogger {
  const noop = (): void => {};
  const emit =
    (fn: (...a: unknown[]) => void) =>
    (...args: unknown[]): void =>
      fn("[dev-sync]", ...args);
  const log = {
    error: emit(console.error),
    warn: emit(console.warn),
    info: emit(console.info),
    debug: noop,
    trace: noop,
    fatal: emit(console.error),
    silent: noop,
    level: "info",
    child() {
      return log;
    },
  };
  return log as unknown as FastifyBaseLogger;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handle(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  log: FastifyBaseLogger,
): Promise<void> {
  // GET /journal has no body — read the limit from the query string.
  if (route === "/journal") {
    const url = new URL(req.url ?? "/", "http://embedded");
    const limit = clampLimit(url.searchParams.get("limit"));
    const entries = await readJournal(cfg, limit, log);
    sendJson(res, 200, JournalListSchema.parse({ entries }));
    return;
  }

  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw) : undefined;
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  if (route === "/undo") {
    const parsed = UndoRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "invalid UndoRequest", issues: issueSummary(parsed.error.issues) });
      return;
    }
    sendJson(res, 200, UndoResultSchema.parse(await undo(cfg, parsed.data, log)));
    return;
  }

  if (route === "/apply") {
    const parsed = CapturePayloadSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: "invalid CapturePayload", issues: issueSummary(parsed.error.issues) });
      return;
    }
    sendJson(res, 200, await applyPayload(parsed.data, cfg, log));
    return;
  }

  if (route === "/describe") {
    const parsed = DescribeTemplateRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, {
        error: "invalid DescribeTemplateRequest",
        issues: issueSummary(parsed.error.issues),
      });
      return;
    }
    try {
      sendJson(res, 200, describeTemplate(parsed.data.element, cfg));
    } catch (err) {
      if (err instanceof WorkspaceError) throw err; // -> 400 in the outer catch
      if (err instanceof SkipChangeError) {
        // Concerns the client's own element input, safe + actionable to surface.
        sendJson(res, 404, { error: err.message });
        return;
      }
      throw err; // -> 500 in the outer catch
    }
    return;
  }

  // route === "/verify"
  const parsed = VerifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "invalid VerifyRequest", issues: issueSummary(parsed.error.issues) });
    return;
  }
  sendJson(res, 200, verifyChecks(parsed.data));
}

/**
 * Build the embedded apply-engine middleware. Mount it under a prefix on the
 * dev server (Vite: `server.middlewares.use("/__dev-sync", mw)`), so the
 * extension POSTs the inspected page's own origin — no separate port or CORS.
 * Requests to paths this middleware doesn't own fall through via `next()`.
 */
export function createApplyMiddleware(cfg: Config): ConnectMiddleware {
  const log = consoleLogger();
  return function devSyncApplyMiddleware(req, res, next) {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    const expectedMethod = ROUTES[pathname];
    if (!expectedMethod) {
      next();
      return;
    }
    if ((req.method ?? "").toUpperCase() !== expectedMethod) {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    // Same-origin embed usually leaves syncToken unset; honour it when present.
    if (cfg.syncToken) {
      const token = req.headers["x-sync-token"];
      if (token !== cfg.syncToken) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }
    void handle(pathname, req, res, cfg, log).catch((err: unknown) => {
      if (err instanceof WorkspaceError) {
        sendJson(res, 400, { error: "invalid path: escapes the workspace root" });
        return;
      }
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }
      log.error({ err }, "dev-sync middleware error");
      sendJson(res, 500, { error: "internal server error" });
    });
  };
}
