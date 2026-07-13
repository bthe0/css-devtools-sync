// stamp-svelte.ts — build-time Svelte stamper (dev only).
//
// The React path stamps `__srcLoc` via a composed callback ref (Babel plugin).
// Svelte has no JSX ref, but it has `use:` actions: an action is called with
// the mounted DOM node, which is exactly what we need. This Svelte
// PREPROCESSOR parses each component, injects `use:__ds_srcloc={{…}}` onto
// every STATIC element (skipping components and `<svelte:*>` specials), and
// imports the framework-neutral `stampSrcLoc` runtime into the instance script.
//
// Only additive, same-line insertions are made — no existing byte moves to a
// new line — so every element's source LINE is preserved and matches what the
// server's line-anchored SFC markup tier expects. Add this preprocessor FIRST
// (before TS/others) so it sees original source and stamps correct lines.
import path from "node:path";
import MagicString from "magic-string";
import { parse } from "svelte/compiler";

/** Specifier the runtime `stampSrcLoc` helper is imported from (matches the Babel plugin). */
const RUNTIME_SOURCE = "@dev-sync/babel-plugin-source-locator/runtime";
/** Local alias for the imported action — unlikely to collide with user code. */
const ACTION = "__ds_srcloc";

export interface SvelteStampOptions {
  /** Project root used to relativise stamped source paths. Default: process.cwd(). */
  root?: string;
}

/** Minimal Svelte PreprocessorGroup shape (avoids a type dep on svelte/compiler internals). */
export interface SveltePreprocessor {
  name: string;
  markup: (input: { content: string; filename?: string }) => { code: string; map?: object } | undefined;
}

interface AstNode {
  type?: string;
  name?: string;
  start?: number;
  [key: string]: unknown;
}

/** 1-based source line of a char offset. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Collect every static HTML element (RegularElement) in the template. Generic
 * recursion over child fragments/arrays means block types ({#if}, {#each}, …)
 * are handled without hardcoding each one; `attributes` subtrees are skipped so
 * we never descend into attribute expressions.
 */
function collectElements(root: AstNode): AstNode[] {
  const out: AstNode[] = [];
  const seen = new Set<AstNode>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as AstNode;
    if (seen.has(n)) return;
    seen.add(n);
    if (n.type === "RegularElement" && typeof n.name === "string" && typeof n.start === "number") {
      out.push(n);
    }
    for (const [key, val] of Object.entries(n)) {
      if (key === "attributes" || key === "type" || key === "name" || key === "parent") continue;
      if (Array.isArray(val)) {
        for (const v of val) visit(v);
      } else if (val && typeof val === "object") {
        visit(val);
      }
    }
  };
  visit(root);
  return out;
}

/** Serialize a loc object as a Svelte action param literal (double-quoted, escaped). */
function locLiteral(rel: string, line: number, component: string): string {
  const q = (s: string) => JSON.stringify(s);
  return `{dataSourceFile:${q(rel)},dataSourceLine:${String(line)},dataSourceComponent:${q(component)}}`;
}

/**
 * Build the Svelte preprocessor. Wire it into plugin-svelte's `preprocess`
 * option (first), e.g. `svelte({ preprocess: [sourceLocatorSveltePreprocess()] })`.
 */
export function sourceLocatorSveltePreprocess(opts: SvelteStampOptions = {}): SveltePreprocessor {
  const root = opts.root ?? process.cwd();
  return {
    name: "dev-sync:stamp-svelte",
    markup({ content, filename }) {
      if (!filename || !filename.endsWith(".svelte")) return undefined;

      let ast: { fragment?: AstNode; instance?: AstNode | null };
      try {
        ast = parse(content, { filename, modern: true }) as unknown as typeof ast;
      } catch {
        // Let plugin-svelte surface the real parse error; don't mask it here.
        return undefined;
      }

      const elements = ast.fragment ? collectElements(ast.fragment) : [];
      if (elements.length === 0) return undefined;

      const rel = path.relative(root, filename).split(path.sep).join("/");
      const component = path.basename(filename).replace(/\.svelte$/, "");
      const ms = new MagicString(content);

      for (const el of elements) {
        const start = el.start!;
        const nameEnd = start + 1 + el.name!.length;
        const line = lineOf(content, start);
        ms.appendLeft(nameEnd, ` use:${ACTION}={${locLiteral(rel, line, component)}}`);
      }

      const importStmt = `\nimport { stampSrcLoc as ${ACTION} } from ${JSON.stringify(RUNTIME_SOURCE)};`;
      if (ast.instance && typeof ast.instance.start === "number") {
        // Inject right after the instance `<script …>` open tag.
        const gt = content.indexOf(">", ast.instance.start);
        if (gt !== -1) ms.appendLeft(gt + 1, importStmt);
      } else {
        // No instance script — prepend one.
        ms.prepend(`<script>${importStmt}\n</script>\n`);
      }

      return { code: ms.toString(), map: ms.generateMap({ hires: true, source: filename }) };
    },
  };
}
