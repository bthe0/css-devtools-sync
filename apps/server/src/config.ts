import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Treat empty-string env vars as unset so defaults apply. */
const emptyToUndef = (v: unknown): unknown => (v === "" ? undefined : v);

/** Chrome extension ids are 32 lowercase a-p characters (base16 over that alphabet). */
const EXTENSION_ID_RE = /^[a-p]{32}$/;

const EnvSchema = z.object({
  DEV_SYNC_WORKSPACE_ROOT: z.preprocess(emptyToUndef, z.string().min(1)),
  PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(65535).default(7777)),
  APP_ENV: z.preprocess(
    emptyToUndef,
    z.enum(["development", "test", "production"]).default("development"),
  ),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  /** When set, CORS allows ONLY chrome-extension://<this id> (see server.ts). */
  EXTENSION_ID: z.preprocess(
    emptyToUndef,
    z.string().regex(EXTENSION_ID_RE, "EXTENSION_ID must be 32 lowercase a-p characters").optional(),
  ),
  /** When set, /apply and /verify require a matching x-sync-token header. */
  SYNC_TOKEN: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  /**
   * Workspace-relative stylesheet that promoted inline-style edits are written
   * into (as `.csync-* { ... }` rules). Must already be imported globally by
   * the app so the generated class takes effect. Defaults to src/index.css.
   */
  DEV_SYNC_OVERRIDES_FILE: z.preprocess(emptyToUndef, z.string().min(1).default("src/index.css")),
  /**
   * Base directory the append-only write journal lives under (one JSONL file
   * per workspace). Deliberately OUTSIDE the workspace jail. Unset → the
   * journal module's default (`~/.dev-sync/journal`). Primarily a test/CI
   * escape hatch so runs never pollute the real home directory.
   */
  DEV_SYNC_JOURNAL_DIR: z.preprocess(emptyToUndef, z.string().min(1).optional()),
});

export interface Config {
  /** realpath-resolved absolute workspace root; every write is jailed under it. */
  readonly workspaceRoot: string;
  readonly port: number;
  readonly appEnv: "development" | "test" | "production";
  readonly anthropicApiKey: string | undefined;
  readonly extensionId: string | undefined;
  readonly syncToken: string | undefined;
  /** Workspace-relative overrides stylesheet for promoted inline-style edits. */
  readonly overridesFile: string;
  /**
   * Base dir for the write journal (one JSONL per workspace), OUTSIDE the jail.
   * Undefined → journal module default (`~/.dev-sync/journal`).
   */
  readonly journalDir?: string;
}

/**
 * Build a Config for an in-process (embedded) apply engine, e.g. when a bundler
 * plugin mounts the middleware on its own dev server rather than running the
 * standalone Fastify server. No environment is read: the workspace root is the
 * bundler's project root, everything else takes a dev-safe default. `port` is
 * unused in embedded mode (the middleware rides the dev server's own socket).
 */
export function configFromRoot(root: string, overrides: Partial<Config> = {}): Config {
  const resolved = fs.realpathSync(path.resolve(root));
  return {
    workspaceRoot: resolved,
    port: overrides.port ?? 0,
    appEnv: overrides.appEnv ?? "development",
    anthropicApiKey: overrides.anthropicApiKey,
    extensionId: overrides.extensionId,
    syncToken: overrides.syncToken,
    overridesFile: overrides.overridesFile ?? "src/index.css",
    journalDir: overrides.journalDir,
  };
}

/** Read + validate configuration from the environment. Throws (fail fast) on any problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "env"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${detail}`);
  }

  const rootInput = path.resolve(parsed.data.DEV_SYNC_WORKSPACE_ROOT);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(rootInput);
  } catch {
    throw new Error(`Invalid configuration: DEV_SYNC_WORKSPACE_ROOT does not exist: ${rootInput}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Invalid configuration: DEV_SYNC_WORKSPACE_ROOT is not a directory: ${rootInput}`,
    );
  }

  return {
    workspaceRoot: fs.realpathSync(rootInput),
    port: parsed.data.PORT,
    appEnv: parsed.data.APP_ENV,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    extensionId: parsed.data.EXTENSION_ID,
    syncToken: parsed.data.SYNC_TOKEN,
    overridesFile: parsed.data.DEV_SYNC_OVERRIDES_FILE,
    journalDir: parsed.data.DEV_SYNC_JOURNAL_DIR,
  };
}
