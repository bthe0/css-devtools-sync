import fs from "node:fs";
import path from "node:path";

/**
 * Client-caused path error. The server error handler maps this to HTTP 400.
 * SECURITY: every filesystem read/write the server performs funnels through
 * jailResolve() below — no write can escape DEV_SYNC_WORKSPACE_ROOT.
 */
export class WorkspaceError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** lstat-based existence check: sees dangling symlinks (existsSync would not). */
function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `candidate` (relative to the workspace root, or absolute) to a REAL
 * absolute path that is provably inside the workspace root.
 *
 * Defeats both attack shapes:
 * - `..` traversal: the candidate is path.resolve()d and the final real path
 *   must be under the real root.
 * - symlink escape: the deepest EXISTING ancestor of the target is
 *   realpath-resolved before the containment check, so a symlink inside the
 *   root pointing outside (including dangling symlinks, which a naive
 *   realpath would miss and a later write would follow) is rejected.
 */
export function jailResolve(workspaceRoot: string, candidate: string): string {
  const realRoot = fs.realpathSync(workspaceRoot);
  const resolved = path.resolve(realRoot, candidate);

  // Walk up to the deepest lstat-existing ancestor, remembering the remainder.
  let existing = resolved;
  const rest: string[] = [];
  while (!lexists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // filesystem root
    rest.unshift(path.basename(existing));
    existing = parent;
  }

  let realTarget: string;
  try {
    // Throws on dangling symlinks -> rejected below. This is deliberate:
    // writing "through" a dangling symlink would create a file at the link
    // target, which may be outside the jail.
    realTarget = path.join(fs.realpathSync(existing), ...rest);
  } catch {
    throw new WorkspaceError("path resolves through a broken symlink");
  }

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new WorkspaceError("path escapes the workspace root");
  }
  return realTarget;
}

/**
 * Turn a stylesheet sourceURL (http(s) URL, webpack:// URL, file path, ...)
 * into a workspace-relative path candidate. Returns null when the URL cannot
 * name a workspace file (inline sheets, chrome-extension URLs, ...).
 * Throws WorkspaceError when the URL smuggles `..` segments.
 */
export function sourceURLToRelativePath(sourceURL: string): string | null {
  if (!sourceURL) return null;
  let p = sourceURL;

  // webpack-style scheme prefixes: webpack:///./src/x.css, webpack://ns/src/x.css
  p = p.replace(/^webpack:\/\/\/?[^/]*\//, "");

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      if (u.protocol === "chrome-extension:" || u.protocol === "data:" || u.protocol === "blob:") {
        return null;
      }
      p = decodeURIComponent(u.pathname);
    } catch {
      // not parseable as a URL — treat as a plain path
    }
  }

  const noQuery = p.split("?")[0] ?? "";
  const noHash = noQuery.split("#")[0] ?? "";
  const trimmed = noHash.replace(/^\/+/, "").replace(/^\.\//, "");
  if (!trimmed) return null;

  const segments = trimmed.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new WorkspaceError("path traversal segment in source URL");
  }
  return segments.join("/");
}

/**
 * Best-effort mapping of a sourceURL to an EXISTING file under the workspace
 * root. Dev servers serve from nested roots, so progressively strip leading
 * path segments until a jailed candidate exists. Returns null when nothing
 * matches (caller skips the change with a reason).
 */
export function resolveExistingFile(workspaceRoot: string, sourceURL: string): string | null {
  const rel = sourceURLToRelativePath(sourceURL);
  if (!rel) return null;
  const segments = rel.split("/");
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(i).join("/");
    try {
      const abs = jailResolve(workspaceRoot, candidate);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch {
      // candidate escaped or broke — try the next strip level
    }
  }
  return null;
}

/** Jailed read. `target` may be absolute or workspace-relative. */
export function readWorkspaceFile(workspaceRoot: string, target: string): string {
  const abs = jailResolve(workspaceRoot, target);
  return fs.readFileSync(abs, "utf8");
}

/** Jailed write — the ONLY way the server writes files. */
export function writeWorkspaceFile(workspaceRoot: string, target: string, content: string): string {
  const abs = jailResolve(workspaceRoot, target);
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

/** Workspace-relative path for ApplyOutcome.file. */
export function toWorkspaceRelative(workspaceRoot: string, absPath: string): string {
  const rel = path.relative(fs.realpathSync(workspaceRoot), absPath);
  return rel === "" ? "." : rel;
}
