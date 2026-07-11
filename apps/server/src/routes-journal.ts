import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { JournalListSchema, UndoRequestSchema, UndoResultSchema } from "@css-sync/contract";
import { readJournal, undo, type JournalConfig } from "./journal.js";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

interface JournalQuery {
  limit?: string;
}

/** Clamp an arbitrary query-string `limit` into [MIN_LIMIT, MAX_LIMIT], defaulting when absent/invalid. */
function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n));
}

/**
 * Registers GET /journal and POST /undo on `app`. Kept as a standalone
 * plugin (rather than inlined in server.ts) so the write-journal lane can be
 * built and tested independently; the orchestrator wires this into
 * buildServer() by calling registerJournalRoutes(app, cfg, preHandler).
 *
 * `preHandler` (the shared-token gate) applies to BOTH routes — /undo mutates
 * files (reverting a write) and /journal exposes source before/after content,
 * so neither should be reachable when /apply itself is token-gated.
 */
export function registerJournalRoutes(
  app: FastifyInstance,
  cfg: JournalConfig,
  preHandler?: preHandlerHookHandler,
): void {
  const opts = preHandler ? { preHandler } : {};
  app.get<{ Querystring: JournalQuery }>("/journal", opts, async (req, reply) => {
    const limit = clampLimit(req.query.limit);
    const entries = await readJournal(cfg, limit, req.log);
    return reply.code(200).send(JournalListSchema.parse({ entries }));
  });

  app.post("/undo", opts, async (req, reply) => {
    const body = req.body ?? {};
    const parsed = UndoRequestSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid UndoRequest",
        issues: parsed.error.issues.slice(0, 20).map((i) => ({
          path: i.path.map(String).join("."),
          message: i.message,
        })),
      });
    }
    const result = await undo(cfg, parsed.data, req.log);
    return reply.code(200).send(UndoResultSchema.parse(result));
  });
}
