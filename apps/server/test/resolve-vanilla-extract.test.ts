import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StyleSheetRef } from "@dev-sync/contract";
import { resolveTargetForChange } from "../src/resolve.js";

/**
 * apps/server/test/resolve-vanilla-extract.test.ts — proves resolve.ts
 * recognizes a vanilla-extract virtual `.vanilla.css` stylesheet id (never a
 * real on-disk file) and resolves it to the real `.css.ts` source that
 * produced it, kind:"vanilla-extract". VE has no sourcemap, so this must be
 * an early, sourcemap-independent branch.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeWorkspace(relPath: string, content: string): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-ve-resolve-"));
  tmpDirs.push(root);
  const dest = path.join(root, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
  return { root: fs.realpathSync(root) };
}

function sheet(sourceURL: string): StyleSheetRef {
  return { id: "s1", sourceURL, sourceMapURL: undefined, origin: "regular" };
}

const CSS_TS = [
  'import { style } from "@vanilla-extract/css";',
  'export const card = style({ padding: "20px" });',
  "",
].join("\n");

describe("resolveTargetForChange — vanilla-extract virtual stylesheet", () => {
  it("strips the .vanilla.css suffix and resolves the real .css.ts source, kind:\"vanilla-extract\"", () => {
    const { root } = makeWorkspace("src/card.css.ts", CSS_TS);
    const target = resolveTargetForChange(root, sheet("/src/card.css.ts.vanilla.css"), null);
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("vanilla-extract");
    expect(target?.file.endsWith("card.css.ts")).toBe(true);
    expect(target?.line).toBeNull();
    expect(target?.column).toBeNull();
    expect(target?.viaSourceMap).toBe(false);
  });

  it("strips a trailing query string before matching the .vanilla.css suffix", () => {
    const { root } = makeWorkspace("src/card.css.ts", CSS_TS);
    const target = resolveTargetForChange(root, sheet("/src/card.css.ts.vanilla.css?used"), null);
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("vanilla-extract");
    expect(target?.file.endsWith("card.css.ts")).toBe(true);
  });

  it("returns null when the stripped .css.ts source does not exist on disk", () => {
    const { root } = makeWorkspace("src/other.txt", "unrelated");
    const target = resolveTargetForChange(root, sheet("/src/missing.css.ts.vanilla.css"), null);
    expect(target).toBeNull();
  });

  it("does not misfire for a normal (non-VE) sourceURL", () => {
    const { root } = makeWorkspace("src/plain.css", ".card { padding: 1px; }");
    const target = resolveTargetForChange(root, sheet("/src/plain.css"), null);
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("css");
  });
});
