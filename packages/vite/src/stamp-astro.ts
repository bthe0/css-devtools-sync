// stamp-astro.ts — build-time Astro stamper (dev only).
//
// React stamps `__srcLoc` via a callback ref; Svelte via a `use:` action; Vue
// via an `onVnodeMounted` vnode hook. Astro has no per-element client runtime —
// components render to static SSR HTML with no mount seam — so it uses a
// transient DOM attribute instead: this `enforce: "pre"` Vite transform rewrites
// the RAW `.astro` source, injecting `data-devloc="<rel>:<line>"` onto every
// STATIC element (skipping components and non-visual tags). A tiny client
// harvest script (injected once per PAGE) then reads every `[data-devloc]`,
// stamps the framework-neutral `__srcLoc` JS property, and STRIPS the attribute
// — so the served DOM is clean and the invariant "no DOM pollution" holds after
// first paint. Astro's compiler emits the attribute verbatim into SSR output.
//
// Only additive, same-line insertions are made — no existing byte moves to a
// new line — so every element's source LINE is preserved and matches what the
// server's line-anchored SFC markup tier expects.
import path from "node:path";
import MagicString from "magic-string";
import { parse } from "@astrojs/compiler-rs";
import type { Plugin } from "vite";

/** Specifier the runtime `stampSrcLoc` helper is imported from (matches the Babel plugin). */
const RUNTIME_SOURCE = "@dev-sync/babel-plugin-source-locator/runtime";
/** Attribute the stamp is emitted under; harvested and stripped client-side. */
const MARKER_ATTR = "data-devloc";

/**
 * Tags that render no editable visual host (or none at all): document scaffold,
 * metadata, the scoped `<style>`/`<script>` blocks, and Astro's `<slot>`
 * placeholder (replaced at render, never a real DOM node). Skipping them keeps
 * the harvested set to elements a DevTools edit could actually target.
 */
const NON_VISUAL = new Set([
  "html",
  "head",
  "title",
  "meta",
  "link",
  "base",
  "style",
  "script",
  "slot",
  "template",
  "noscript",
]);

export interface AstroStampOptions {
  /** Project root used to relativise stamped source paths. Default: process.cwd(). */
  root?: string;
}

interface JsxNode {
  type?: string;
  openingElement?: { start?: number; selfClosing?: boolean; name?: { name?: string } };
  children?: unknown;
  [key: string]: unknown;
}

/** 1-based source line of a char offset. (ASCII sources: byte offset == char offset.) */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Collect every static, plain HTML element in the template. A JSXElement whose
 * tag starts lowercase is an HTML element; a capitalized tag (`<Card>`) is a
 * component and is skipped — but we still recurse INTO its children, so slotted
 * host elements (e.g. a `<p>` passed to `<Card>`) are reached. We only descend
 * `children` (never expression subtrees), so elements nested inside a JS
 * expression (`{cond && <div/>}`) stay unstamped — that's dynamic, out of v1.
 */
function collectElements(body: unknown): JsxNode[] {
  const out: JsxNode[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as JsxNode;
    if (n.type === "JSXElement") {
      const tag = n.openingElement?.name?.name;
      if (typeof tag === "string" && /^[a-z]/.test(tag) && !NON_VISUAL.has(tag) && typeof n.openingElement?.start === "number") {
        out.push(n);
      }
    }
    const kids = n.children;
    if (Array.isArray(kids)) for (const c of kids) visit(c);
  };
  if (Array.isArray(body)) for (const n of body) visit(n);
  return out;
}

/**
 * Client harvest script (dev only). Imported/bundled by Astro as a processed
 * module `<script>`, deferred, so it runs after the DOM parses. It stamps each
 * marked node's `__srcLoc` and removes the marker attribute so the DOM is clean.
 */
function harvestScript(): string {
  return `<script>
import { stampSrcLoc as __ds_srcloc } from ${JSON.stringify(RUNTIME_SOURCE)};
function __ds_harvest() {
  for (const el of document.querySelectorAll("[${MARKER_ATTR}]")) {
    const raw = el.getAttribute("${MARKER_ATTR}");
    const i = raw.lastIndexOf(":");
    const file = raw.slice(0, i);
    const line = Number(raw.slice(i + 1));
    const base = file.split("/").pop() || file;
    __ds_srcloc(el, { dataSourceFile: file, dataSourceLine: line, dataSourceComponent: base.replace(/\\.astro$/, "") });
    el.removeAttribute("${MARKER_ATTR}");
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", __ds_harvest);
else __ds_harvest();
</script>
`;
}

/**
 * Vite plugin that stamps Astro elements with their source location. Add it to
 * Astro's Vite config BEFORE Astro's own plugins (`enforce: "pre"` guarantees
 * this); `apply: "serve"` ships nothing to production builds.
 *
 * ```js
 * // astro.config.mjs
 * export default defineConfig({ vite: { plugins: [sourceLocatorAstro(), devSync()] } });
 * ```
 */
export function sourceLocatorAstro(opts: AstroStampOptions = {}): Plugin {
  const root = opts.root ?? process.cwd();
  return {
    name: "dev-sync:stamp-astro",
    enforce: "pre",
    apply: "serve",
    transform(code, id) {
      const [file, query] = id.split("?");
      // Only the top-level `.astro` request — Astro's compiled sub-requests
      // (`?astro&type=…`) must not be touched.
      if (query || !file || !file.endsWith(".astro")) return undefined;

      // `parse` is synchronous and always emits node byte offsets (`start`).
      let ast: { body?: unknown };
      try {
        ({ ast } = parse(code) as { ast: { body?: unknown } });
      } catch {
        // Let Astro surface the real parse error; don't mask it here.
        return undefined;
      }

      const elements = collectElements(ast.body);
      // Pages (under src/pages) get the client harvest script even if they have
      // no stampable element of their own — they host stamped component markup.
      const rel = path.relative(root, file).split(path.sep).join("/");
      const isPage = rel.startsWith("src/pages/") || rel.startsWith("pages/");
      if (elements.length === 0 && !isPage) return undefined;

      const ms = new MagicString(code);
      for (const el of elements) {
        const start = el.openingElement!.start!;
        const tag = el.openingElement!.name!.name!;
        const nameEnd = start + 1 + tag.length;
        const line = lineOf(code, start);
        ms.appendLeft(nameEnd, ` ${MARKER_ATTR}=${JSON.stringify(`${rel}:${line}`)}`);
      }

      // Astro processed-`<script>` blocks must live INSIDE the document root —
      // a script appended after `</html>` breaks the compiler's parse boundary
      // (template JSX leaks into the script's JS module). Inject before the
      // closing `</body>` when present, else before `</html>`, else append.
      if (isPage) {
        const script = `\n${harvestScript()}`;
        const closeBody = code.search(/<\/body\s*>/i);
        const closeHtml = code.search(/<\/html\s*>/i);
        const at = closeBody !== -1 ? closeBody : closeHtml;
        if (at !== -1) ms.appendLeft(at, script);
        else ms.append(script);
      }

      return { code: ms.toString(), map: ms.generateMap({ hires: true, source: file }) };
    },
  };
}
