import crypto from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import {
  CapturePayloadSchema,
  DescribeTemplateRequestSchema,
  VerifyRequestSchema,
} from "@dev-sync/contract";
import type { Config } from "./config.js";
import { applyPayload, describeTemplate } from "./apply.js";
import { SkipChangeError } from "./errors.js";
import { registerJournalRoutes } from "./routes-journal.js";
import { verifyChecks } from "./verify.js";
import { WorkspaceError } from "./workspace.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — a sync batch is small

const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * SECURITY (prior MEDIUM): the old check accepted ANY chrome-extension
 * id-shaped origin, so any installed extension (not just this project's)
 * could hit the sync server. When EXTENSION_ID is configured, only that
 * exact origin is trusted — in every environment, dev included, since
 * setting it is an explicit tightening signal. Without it we fall back to
 * the old wildcard match, but ONLY outside production (fail-closed default:
 * an unconfigured production deployment accepts no chrome-extension origin
 * at all). Localhost dev origins follow the same dev-only rule.
 */
export function isOriginAllowed(origin: string, cfg: Pick<Config, "appEnv" | "extensionId">): boolean {
  const isDev = cfg.appEnv !== "production";
  if (cfg.extensionId) {
    if (origin === `chrome-extension://${cfg.extensionId}`) return true;
  } else if (isDev && CHROME_EXTENSION_ORIGIN.test(origin)) {
    return true;
  }
  return isDev && LOCALHOST_ORIGIN.test(origin);
}

/** Constant-time string compare so token checks don't leak length/prefix via timing. */
function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still perform a same-cost compare so failure timing doesn't vary with length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * SECURITY: optional shared-token gate for /apply and /verify. A no-op when
 * SYNC_TOKEN is unset (default). When set, every request must carry a
 * matching x-sync-token header or is rejected 401 before touching the
 * filesystem.
 */
function requireSyncToken(cfg: Pick<Config, "syncToken">) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!cfg.syncToken) return;
    const header = req.headers["x-sync-token"];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || !timingSafeEqualString(provided, cfg.syncToken)) {
      void reply.code(401).send({ error: "unauthorized" });
    }
  };
}

interface ZodIssueLike {
  path: PropertyKey[];
  message: string;
}

function issueSummary(issues: ZodIssueLike[]): { path: string; message: string }[] {
  return issues.slice(0, 20).map((i) => ({
    path: i.path.map(String).join("."),
    message: i.message,
  }));
}

export async function buildServer(cfg: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: cfg.appEnv === "test" ? "silent" : "info",
      redact: {
        paths: ["req.headers.authorization", "req.headers['x-api-key']", "req.headers.cookie"],
        censor: "[redacted]",
      },
    },
    bodyLimit: MAX_BODY_BYTES,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser callers (curl, extension service worker fetches without an
      // Origin header) are same-machine only — the server binds 127.0.0.1.
      if (!origin) {
        cb(null, true);
        return;
      }
      const allowed = isOriginAllowed(origin, cfg);
      cb(allowed ? null : new Error("origin not allowed"), allowed);
    },
  });

  // Global error handler: log the full error (request-id correlated), return
  // only a sanitized message — never fs paths, stacks, or internals.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request failed");
    if (err instanceof WorkspaceError) {
      void reply.code(400).send({ error: "invalid path: escapes the workspace root" });
      return;
    }
    const rawStatus = (err as { statusCode?: unknown }).statusCode;
    const statusCode = typeof rawStatus === "number" ? rawStatus : 500;
    if (statusCode >= 400 && statusCode < 500) {
      void reply.code(statusCode).send({
        error:
          statusCode === 413
            ? "payload too large"
            : statusCode === 403
              ? "forbidden"
              : "bad request",
      });
      return;
    }
    void reply.code(500).send({ error: "internal server error" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/apply", { preHandler: requireSyncToken(cfg) }, async (req, reply) => {
    const parsed = CapturePayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid CapturePayload",
        issues: issueSummary(parsed.error.issues),
      });
    }
    return applyPayload(parsed.data, cfg, req.log);
  });

  app.post("/describe", { preHandler: requireSyncToken(cfg) }, async (req, reply) => {
    const parsed = DescribeTemplateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid DescribeTemplateRequest",
        issues: issueSummary(parsed.error.issues),
      });
    }
    try {
      return describeTemplate(parsed.data.element, cfg);
    } catch (err) {
      if (err instanceof WorkspaceError) throw err; // -> 400 (generic) via error handler
      if (err instanceof SkipChangeError) {
        // The reason concerns the client's own element (its data-source-* input),
        // not server internals, so surfacing it is safe and actionable.
        return reply.code(404).send({ error: err.message });
      }
      throw err; // -> 500 (sanitized) via error handler
    }
  });

  app.post("/verify", { preHandler: requireSyncToken(cfg) }, async (req, reply) => {
    const parsed = VerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid VerifyRequest",
        issues: issueSummary(parsed.error.issues),
      });
    }
    return verifyChecks(parsed.data);
  });

  // GET /journal + POST /undo — same shared-token gate as /apply.
  registerJournalRoutes(app, cfg, requireSyncToken(cfg));

  return app;
}

/** Bind 127.0.0.1 ONLY — this server edits local files and must never be reachable off-box. */
export async function startServer(cfg: Config): Promise<FastifyInstance> {
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: "127.0.0.1" });
  return app;
}
