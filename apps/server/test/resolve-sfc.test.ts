import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceMapGenerator } from "source-map-js";
import type { StyleSheetRef } from "@dev-sync/contract";
import { isSfcLike, resolveTargetForChange } from "../src/resolve.js";

/**
 * apps/server/test/resolve-sfc.test.ts — proves resolve.ts recognizes a
 * `.vue`/`.svelte` sourcemap source as an SFC target (kind:"sfc") instead of
 * falling through to `target === null` (the pre-fix behavior: `.vue` matches
 * neither isCssLike nor isJsLike, so the change was skipped as "source file
 * not found").
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeWorkspace(relPath: string, content: string): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-sfc-resolve-"));
  tmpDirs.push(root);
  const dest = path.join(root, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
  return { root: fs.realpathSync(root) };
}

function dataUriSourceMap(source: string, line: number, column: number): string {
  const gen = new SourceMapGenerator();
  gen.addMapping({ generated: { line: 1, column: 0 }, original: { line, column }, source });
  const json = JSON.stringify(gen.toJSON());
  return `data:application/json;charset=utf-8;base64,${Buffer.from(json, "utf8").toString("base64")}`;
}

describe("isSfcLike", () => {
  it("recognizes .vue, .svelte and .astro, case-insensitively", () => {
    expect(isSfcLike("src/Card.vue")).toBe(true);
    expect(isSfcLike("src/Card.VUE")).toBe(true);
    expect(isSfcLike("src/Widget.svelte")).toBe(true);
    expect(isSfcLike("src/Card.astro")).toBe(true);
    expect(isSfcLike("src/Card.ASTRO")).toBe(true);
  });

  it("rejects plain css/js/other extensions", () => {
    expect(isSfcLike("src/Card.css")).toBe(false);
    expect(isSfcLike("src/Card.module.css")).toBe(false);
    expect(isSfcLike("src/Card.tsx")).toBe(false);
    expect(isSfcLike("src/Card.vue.bak")).toBe(false);
  });
});

describe("resolveTargetForChange — SFC sourcemap sources", () => {
  const RELPATH = "src/components/ScopedCard.vue";
  const VUE_SFC = [
    "<script setup lang=\"ts\"></script>",
    "",
    "<template>",
    "  <article class=\"card\"></article>",
    "</template>",
    "",
    "<style scoped>",
    ".card {",
    "  padding: 20px;",
    "}",
    "</style>",
    "",
  ].join("\n");

  function sheet(root: string, line: number, column: number): StyleSheetRef {
    return {
      id: "s1",
      sourceURL: "",
      sourceMapURL: dataUriSourceMap(RELPATH, line, column),
      origin: "regular",
    };
  }

  it("with a CDP range, a .vue sourcemap source resolves to kind:\"sfc\" with line/column", () => {
    const { root } = makeWorkspace(RELPATH, VUE_SFC);
    const target = resolveTargetForChange(root, sheet(root, 9, 2), {
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 5,
    });
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("sfc");
    expect(target?.file.endsWith("ScopedCard.vue")).toBe(true);
    expect(target?.line).toBe(9);
    expect(target?.column).toBe(2);
    expect(target?.viaSourceMap).toBe(true);
  });

  it("without a usable CDP range, the map.sources fallback still picks the .vue source over nothing, with kind:\"sfc\" and null line/column", () => {
    const { root } = makeWorkspace(RELPATH, VUE_SFC);
    const target = resolveTargetForChange(root, sheet(root, 9, 2), null);
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("sfc");
    expect(target?.file.endsWith("ScopedCard.vue")).toBe(true);
    expect(target?.line).toBeNull();
    expect(target?.column).toBeNull();
  });
});

describe("resolveTargetForChange — SFC via sourceURL compiled fallback", () => {
  // vite-plugin-svelte emits `"sources":["Card.svelte"]` (bare, no directory),
  // which resolveExistingFile can't locate under the workspace, so the
  // sourcemap sfc pass misses. sheet.sourceURL still resolves the real file →
  // the `if (compiled)` fallback must classify it kind:"sfc", NOT "css"
  // (handing a .svelte's <script>/markup to PostCSS fails to parse).
  const RELPATH = "src/lib/Card.svelte";
  const SVELTE_SFC = [
    "<script lang=\"ts\">",
    "  let { title }: { title: string } = $props();",
    "</script>",
    "",
    "<article class=\"card\">{title}</article>",
    "",
    "<style>",
    "  .card {",
    "    padding: 20px;",
    "  }",
    "</style>",
    "",
  ].join("\n");

  it("classifies a .svelte file reached via the sourceURL fallback as kind:\"sfc\" (viaSourceMap:false), not \"css\"", () => {
    const { root } = makeWorkspace(RELPATH, SVELTE_SFC);
    const target = resolveTargetForChange(
      root,
      {
        id: "s1",
        // sourceURL resolves the real file; sourcemap source is bare + unresolvable.
        sourceURL: RELPATH,
        sourceMapURL: dataUriSourceMap("Card.svelte", 8, 4),
        origin: "regular",
      },
      null,
    );
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("sfc");
    expect(target?.file.endsWith("Card.svelte")).toBe(true);
    expect(target?.viaSourceMap).toBe(false);
  });
});

describe("resolveTargetForChange — Astro mapless inline <style> via viteId sourceURL", () => {
  // Astro's scoped <style> is served as an inline <style data-vite-dev-id="…">
  // with NO href and NO inline sourceMappingURL. The extension now forwards the
  // viteId (a full module path WITH a ?astro&type=style&… query) as sourceURL —
  // the only resolution signal. This is the exact path that regressed as "source
  // file not found": resolveExistingFile must strip the query + progressive-strip
  // the abs prefix, and the `if (compiled)` fallback must classify .astro as sfc.
  const RELPATH = "src/components/Card.astro";
  const ASTRO_SFC = [
    "---",
    'const title = "Hi";',
    "---",
    '<article class="card"><h2>{title}</h2></article>',
    "",
    "<style>",
    "  .card { padding: 20px; }",
    "</style>",
    "",
  ].join("\n");

  it("classifies a mapless .astro inline sheet (viteId-with-query sourceURL, no map) as kind:\"sfc\"", () => {
    const { root } = makeWorkspace(RELPATH, ASTRO_SFC);
    const target = resolveTargetForChange(
      root,
      {
        id: "eval:" + `${root}/${RELPATH}?astro&type=style&index=0&`,
        // The viteId is an absolute fs path + Astro's style query — no map at all.
        sourceURL: `${root}/${RELPATH}?astro&type=style&index=0&`,
        sourceMapURL: "",
        origin: "regular",
      },
      null,
    );
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("sfc");
    expect(target?.file.endsWith("Card.astro")).toBe(true);
    expect(target?.viaSourceMap).toBe(false);
  });
});
