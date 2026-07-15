// stamp-vue.ts — build-time Vue stamper (dev only).
//
// The React path stamps `__srcLoc` via a composed callback ref; Svelte uses a
// `use:` action. Vue's equivalent seam is the `onVnodeMounted` vnode hook — it
// fires with the mounted vnode, whose `.el` is the DOM node. This is a Vite
// `enforce: "pre"` transform that runs BEFORE `@vitejs/plugin-vue`, rewriting
// the RAW `.vue` source: it parses the SFC, injects `:onVnodeMounted='…'` onto
// every STATIC element (skipping components/slots/templates), and imports the
// framework-neutral `stampSrcLoc` runtime into `<script setup>` so the template
// can reference it as a setup binding.
//
// Only additive, same-line insertions are made — no existing byte moves to a
// new line — so every element's source LINE is preserved and matches what the
// server's line-anchored SFC markup tier expects.
import path from "node:path";
import MagicString from "magic-string";
import { parse } from "vue/compiler-sfc";
import type { Plugin } from "vite";

/** Specifier the runtime `stampSrcLoc` helper is imported from (matches the Babel plugin). */
const RUNTIME_SOURCE = "@dev-sync/babel-plugin-source-locator/runtime";
/** Local alias for the imported helper — unlikely to collide with user code. */
const HELPER = "__ds_srcloc";

export interface VueStampOptions {
  /** Project root used to relativise stamped source paths. Default: process.cwd(). */
  root?: string;
}

interface AstNode {
  type?: number;
  tag?: string;
  tagType?: number;
  loc?: { start?: { offset?: number } };
  children?: unknown;
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
 * Collect every static HTML element in the template AST. `type === 1` is an
 * element; `tagType === 0` is a plain element (1=Component, 2=Slot, 3=Template)
 * — only plain elements get a vnode hook, mirroring Svelte's component skip.
 * Generic recursion over `children` handles v-if/v-for blocks without
 * hardcoding each structural node.
 */
function collectElements(root: AstNode): AstNode[] {
  const out: AstNode[] = [];
  const seen = new Set<AstNode>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as AstNode;
    if (seen.has(n)) return;
    seen.add(n);
    if (n.type === 1 && n.tagType === 0 && typeof n.tag === "string" && typeof n.loc?.start?.offset === "number") {
      out.push(n);
    }
    const kids = n.children;
    if (Array.isArray(kids)) for (const c of kids) visit(c);
    // v-if / v-for wrap their content in branches/`.children`; a branch also
    // carries `.children`, so the array walk above reaches nested elements.
  };
  visit(root);
  return out;
}

/** Serialize the loc object as a JS literal (double-quoted, JSON-escaped). */
function locLiteral(rel: string, line: number, component: string): string {
  const q = (s: string) => JSON.stringify(s);
  return `{dataSourceFile:${q(rel)},dataSourceLine:${String(line)},dataSourceComponent:${q(component)}}`;
}

/**
 * Vite plugin that stamps Vue SFC elements with their source location. Add it
 * BEFORE `@vitejs/plugin-vue` (its `enforce: "pre"` already guarantees this)
 * and gate it to dev — `apply: "serve"` ships nothing to production builds.
 *
 * ```ts
 * export default defineConfig({ plugins: [sourceLocatorVue(), vue(), devSync()] });
 * ```
 */
export function sourceLocatorVue(opts: VueStampOptions = {}): Plugin {
  const root = opts.root ?? process.cwd();
  return {
    name: "dev-sync:stamp-vue",
    enforce: "pre",
    apply: "serve",
    transform(code, id) {
      const [file, query] = id.split("?");
      // Only the top-level `.vue` request — sub-blocks (`?vue&type=…`) are the
      // compiled output of plugin-vue and must not be touched.
      if (query || !file || !file.endsWith(".vue")) return undefined;

      let descriptor;
      try {
        ({ descriptor } = parse(code, { filename: file }));
      } catch {
        // Let plugin-vue surface the real parse error; don't mask it here.
        return undefined;
      }

      const ast = descriptor.template?.ast as AstNode | undefined;
      if (!ast) return undefined;
      const elements = collectElements(ast);
      if (elements.length === 0) return undefined;

      const rel = path.relative(root, file).split(path.sep).join("/");
      const component = path.basename(file).replace(/\.vue$/, "");
      const ms = new MagicString(code);

      for (const el of elements) {
        const start = el.loc!.start!.offset!;
        const tagNameEnd = start + 1 + el.tag!.length;
        const line = lineOf(code, start);
        // Single-quoted attribute so the JSON double-quotes inside nest cleanly.
        // The handler runs on mount with the vnode; `vnode.el` is the DOM node.
        ms.appendLeft(
          tagNameEnd,
          ` :onVnodeMounted='(__v)=>${HELPER}(__v.el,${locLiteral(rel, line, component)})'`,
        );
      }

      const importStmt = `\nimport { stampSrcLoc as ${HELPER} } from ${JSON.stringify(RUNTIME_SOURCE)};`;
      if (descriptor.scriptSetup) {
        // Inject at the start of the <script setup> CONTENT (loc excludes the tags).
        ms.appendLeft(descriptor.scriptSetup.loc.start.offset, importStmt);
      } else {
        // No <script setup> — prepend one so the template can see the binding.
        ms.prepend(`<script setup>${importStmt}\n</script>\n`);
      }

      return { code: ms.toString(), map: ms.generateMap({ hires: true, source: file }) };
    },
  };
}
