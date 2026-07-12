import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  jailResolve,
  resolveExistingFile,
  sourceURLToRelativePath,
  WorkspaceError,
  writeWorkspaceFile,
} from "../src/workspace.js";

let root: string;
let outside: string;
let realRoot: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-outside-"));
  realRoot = fs.realpathSync(root);

  fs.mkdirSync(path.join(root, "styles"), { recursive: true });
  fs.writeFileSync(path.join(root, "styles", "app.css"), ".card { color: red; }\n");
  fs.writeFileSync(path.join(outside, "secret.css"), ".leak { display: none; }\n");

  // symlink INSIDE the root pointing OUTSIDE it
  fs.symlinkSync(path.join(outside, "secret.css"), path.join(root, "escape.css"));
  // dangling symlink INSIDE the root pointing OUTSIDE it (a write would create the target)
  fs.symlinkSync(path.join(outside, "does-not-exist.css"), path.join(root, "dangling.css"));
  // symlinked DIRECTORY escaping the root
  fs.symlinkSync(outside, path.join(root, "linked-dir"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("jailResolve — the write jail", () => {
  it("accepts a normal file inside the root", () => {
    const p = jailResolve(root, "styles/app.css");
    expect(p.startsWith(realRoot + path.sep)).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toContain(".card");
  });

  it("accepts a not-yet-existing path inside the root (new file creation)", () => {
    const p = jailResolve(root, "styles/new-file.css");
    expect(p).toBe(path.join(realRoot, "styles", "new-file.css"));
  });

  it("rejects ../ traversal", () => {
    expect(() => jailResolve(root, "../../etc/passwd")).toThrow(WorkspaceError);
  });

  it("rejects deep ../ traversal hidden mid-path", () => {
    expect(() => jailResolve(root, "styles/../../outside.css")).toThrow(WorkspaceError);
  });

  it("rejects absolute paths outside the root", () => {
    expect(() => jailResolve(root, "/etc/passwd")).toThrow(WorkspaceError);
    expect(() => jailResolve(root, path.join(outside, "secret.css"))).toThrow(WorkspaceError);
  });

  it("rejects a symlink escaping the root", () => {
    expect(() => jailResolve(root, "escape.css")).toThrow(WorkspaceError);
  });

  it("rejects a DANGLING symlink escaping the root (write-through attack)", () => {
    expect(() => jailResolve(root, "dangling.css")).toThrow(WorkspaceError);
  });

  it("rejects paths through a symlinked directory escaping the root", () => {
    expect(() => jailResolve(root, "linked-dir/secret.css")).toThrow(WorkspaceError);
  });

  it("writeWorkspaceFile never writes outside the root", () => {
    expect(() => writeWorkspaceFile(root, "../pwned.css", ".x{}")).toThrow(WorkspaceError);
    expect(() => writeWorkspaceFile(root, "escape.css", ".x{}")).toThrow(WorkspaceError);
    // outside dir stays untouched
    expect(fs.existsSync(path.join(path.dirname(realRoot), "pwned.css"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "secret.css"), "utf8")).toContain(".leak");
  });
});

describe("sourceURLToRelativePath / resolveExistingFile", () => {
  it("maps a dev-server URL to a workspace file", () => {
    const p = resolveExistingFile(root, "http://localhost:5173/styles/app.css");
    expect(p).toBe(path.join(realRoot, "styles", "app.css"));
  });

  it("strips leading segments served from nested roots", () => {
    const p = resolveExistingFile(root, "http://localhost:3000/static/styles/app.css");
    expect(p).toBe(path.join(realRoot, "styles", "app.css"));
  });

  it("handles webpack:// scheme prefixes", () => {
    expect(sourceURLToRelativePath("webpack:///./styles/app.css")).toBe("styles/app.css");
    // 3-slash form with a REAL leading dir (Next's map sources look like this):
    // the dir must survive so app/globals.css resolves — regression for the old
    // `[^/]*\/` strip that collapsed it to just "globals.css".
    expect(sourceURLToRelativePath("webpack:///app/globals.css")).toBe("app/globals.css");
    // 2-slash namespace form: the namespace stays as a leading segment for
    // resolveExistingFile's progressive strip to peel off.
    expect(sourceURLToRelativePath("webpack://_N_E_/src/App.css")).toBe("_N_E_/src/App.css");
  });

  it("resolves a 3-slash webpack:/// map source with a real leading dir", () => {
    // Next's inline CSS map sources are `webpack:///<dir>/<file>` — the leading
    // dir must survive the scheme strip so the nested file resolves on disk.
    const abs = resolveExistingFile(root, "webpack:///styles/app.css");
    expect(abs).toBe(path.join(realRoot, "styles", "app.css"));
  });

  it("returns null for inline/constructed sheets", () => {
    expect(resolveExistingFile(root, "")).toBeNull();
  });

  it("throws on raw ../ smuggled in a path-style sourceURL", () => {
    expect(() => sourceURLToRelativePath("../../etc/passwd")).toThrow(WorkspaceError);
  });

  it("returns null for unknown files instead of throwing", () => {
    expect(resolveExistingFile(root, "http://localhost/nope/missing.css")).toBeNull();
  });
});
