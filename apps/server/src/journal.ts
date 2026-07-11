import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import {
  JournalEntrySchema,
  type JournalEntry,
  type UndoRequest,
  type UndoResult,
  type UndoSkip,
} from "@css-sync/contract";
import { readWorkspaceFile, writeWorkspaceFile } from "./workspace.js";

/**
 * Config surface journal.ts needs. Deliberately a superset the real server
 * Config satisfies structurally (journalDir is optional) — tests can override
 * where the journal lives without ever touching ~/.css-sync, and the real
 * server just passes its Config through untouched.
 */
export interface JournalConfig {
  /** realpath-resolved absolute workspace root (same value as Config.workspaceRoot). */
  readonly workspaceRoot: string;
  /**
   * Overrides the base directory the per-workspace journal file lives under
   * (default `~/.css-sync/journal`). Test-only escape hatch so tests never
   * touch the real home directory.
   */
  readonly journalDir?: string;
}

/** Cap on retained entries — rotation rewrites the file once either cap is exceeded. */
const MAX_ENTRIES = 500;
/** Soft byte cap (~5 MB) enforced alongside MAX_ENTRIES on rotation. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Per-file append/rotate serialization. `fs.appendFile` is a single write() but
 * an entry carries full before/after file contents, so a line routinely exceeds
 * PIPE_BUF (4 KB) — two concurrent /apply requests could interleave their bytes
 * and corrupt the JSONL, and a rotate rename racing an append could drop lines.
 * Chain every mutation of a given journal file through one promise so appends
 * and rotations run strictly one-at-a-time per workspace.
 */
const journalLocks = new Map<string, Promise<unknown>>();

export function withJournalLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = journalLocks.get(filePath) ?? Promise.resolve();
  // Run fn after prev settles, regardless of whether prev resolved or rejected.
  const next = prev.then(fn, fn);
  // Store a swallowed tail so a rejection here never surfaces as unhandled and
  // never poisons the next waiter (which still runs via the `fn, fn` above).
  journalLocks.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function defaultJournalDir(): string {
  return path.join(os.homedir(), ".css-sync", "journal");
}

/** sha256(workspaceRoot) hex, first 16 chars — stable per-workspace journal filename. */
function workspaceHash(workspaceRoot: string): string {
  return crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function journalPathFor(cfg: JournalConfig): string {
  const dir = cfg.journalDir ?? defaultJournalDir();
  return path.join(dir, `${workspaceHash(cfg.workspaceRoot)}.jsonl`);
}

/** Read the journal file's raw lines, tolerating a missing file (-> []). */
async function readRawLines(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Rewrite the journal file, keeping only the newest entries within both the
 * MAX_ENTRIES and MAX_BYTES caps. Atomic: write to a temp file, then rename
 * over the original so a crash mid-write never corrupts the journal.
 */
async function rotateIfNeeded(filePath: string, log?: FastifyBaseLogger): Promise<void> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return; // file doesn't exist yet — nothing to rotate
  }

  const lines = await readRawLines(filePath);
  if (lines.length <= MAX_ENTRIES && size <= MAX_BYTES) return;

  let kept = lines.slice(-MAX_ENTRIES); // newest MAX_ENTRIES, oldest-first order preserved
  while (kept.length > 0 && Buffer.byteLength(kept.join("\n") + "\n", "utf8") > MAX_BYTES) {
    kept = kept.slice(1); // drop the oldest until under the byte cap too
  }

  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmpPath, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
  await fs.rename(tmpPath, filePath);
  log?.info({ kept: kept.length, dropped: lines.length - kept.length }, "journal rotated");
}

/**
 * Append one committed write to the per-workspace journal, assigning id + ts.
 * Creates the journal directory (outside the workspace jail) if missing.
 */
export async function appendJournal(
  cfg: JournalConfig,
  entry: Omit<JournalEntry, "id" | "ts">,
  log?: FastifyBaseLogger,
): Promise<JournalEntry> {
  const full: JournalEntry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    ...entry,
  };
  const filePath = journalPathFor(cfg);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Serialize append + rotate so concurrent writers can't interleave/clobber.
  await withJournalLock(filePath, async () => {
    await fs.appendFile(filePath, `${JSON.stringify(full)}\n`, "utf8");
    await rotateIfNeeded(filePath, log);
  });
  return full;
}

/**
 * Read the most-recent `limit` journal entries, newest first. Tolerates a
 * missing journal file (-> []) and skips malformed lines individually rather
 * than failing the whole read.
 */
export async function readJournal(
  cfg: JournalConfig,
  limit = 50,
  log?: FastifyBaseLogger,
): Promise<JournalEntry[]> {
  const filePath = journalPathFor(cfg);
  const lines = await readRawLines(filePath);

  const entries: JournalEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JournalEntrySchema.parse(JSON.parse(line)));
    } catch (err) {
      log?.warn({ err }, "skipping malformed journal line");
    }
  }

  entries.reverse(); // newest first
  return entries.slice(0, Math.max(0, limit));
}

/**
 * Revert one journal entry (explicit `req.id`, or the single most-recent
 * entry when omitted). Refuses to clobber a hand-edit: reverts only when the
 * file's current content still matches what the original write produced
 * (`entry.after`). A successful revert is itself journaled (before/after
 * swapped) so undo is itself undoable and the log stays a truthful history
 * of every write, including reverts.
 */
export async function undo(
  cfg: JournalConfig,
  req: UndoRequest,
  log?: FastifyBaseLogger,
): Promise<UndoResult> {
  const reverted: JournalEntry[] = [];
  const skipped: UndoSkip[] = [];

  // Read enough history to find an explicit id even if it isn't the newest.
  const entries = await readJournal(cfg, MAX_ENTRIES, log);

  let target: JournalEntry | undefined;
  if (req.id) {
    target = entries.find((e) => e.id === req.id);
    if (!target) {
      skipped.push({ id: req.id, file: "", reason: "no journal entry with that id" });
      return { reverted, skipped };
    }
  } else {
    target = entries[0];
    if (!target) return { reverted, skipped }; // empty journal — nothing to undo
  }

  let current: string;
  try {
    current = readWorkspaceFile(cfg.workspaceRoot, target.file);
  } catch (err) {
    log?.warn({ err, file: target.file }, "undo target file unreadable");
    skipped.push({ id: target.id, file: target.file, reason: "file missing or unreadable" });
    return { reverted, skipped };
  }

  if (current !== target.after) {
    skipped.push({
      id: target.id,
      file: target.file,
      reason: "file changed since sync (hand-edit detected), refusing to clobber",
    });
    return { reverted, skipped };
  }

  writeWorkspaceFile(cfg.workspaceRoot, target.file, target.before);
  reverted.push(target);

  // The undo is itself a write — journal it (swapped before/after) so it can
  // be undone too and the log never lies about what happened on disk.
  await appendJournal(
    cfg,
    {
      file: target.file,
      mode: target.mode,
      confidence: target.confidence,
      before: target.after,
      after: target.before,
    },
    log,
  );

  return { reverted, skipped };
}
