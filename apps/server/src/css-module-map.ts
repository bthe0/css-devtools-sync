import type { CssModuleMap } from "@dev-sync/contract";

/**
 * apps/server/src/css-module-map.ts — reverse a SERVED CSS Modules selector
 * (hashed class names) back to a source-matching selector using the build-time
 * export map the client captured.
 *
 * Why this exists: a `<style module>` / `*.module.css` class `.title` is
 * compiled to `._title_HASH_N`; the CSSOM the extension reads carries only the
 * hash, which name-matches nothing in source, and the extension sends no usable
 * range for these (the CSSOM coordinates don't line up with the served compiled
 * sheet — see devtools.js). The reverse map is the framework's OWN `{local ->
 * hash}` export read at runtime, so this is correct under any custom
 * `generateScopedName` — we never parse the hash string.
 */

export interface ReversedModuleSelector {
  /** Source file that owns the module (`.vue` SFC or plain `.module.css`). */
  file: string;
  /** The selector with every hashed token replaced by its source-local name. */
  selector: string;
}

/** Class tokens in a selector: the `foo` in `.foo`, hashes included (`_title_1ah9a_9`). */
const CLASS_TOKEN_RE = /\.([A-Za-z0-9_-]+)/g;

/**
 * Reverse `selector` via `map`. Returns null (leave it to skip-with-reason)
 * when: the map is empty/absent, NO token is a known module hash (a plain
 * selector — not ours to rewrite), or the hashed tokens resolve to MORE than
 * one source file (a cross-component selector we can't safely target — refuse
 * rather than guess). Non-module tokens (global classes, `.is-active`) and all
 * non-class syntax (combinators, `:hover`, `[attr]`) pass through byte-identical.
 */
export function reverseCssModuleSelector(
  selector: string,
  map: CssModuleMap | undefined,
): ReversedModuleSelector | null {
  if (!map) return null;

  let file: string | null = null;
  let matched = false;
  let ambiguous = false;
  let out = "";
  let last = 0;

  CLASS_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_TOKEN_RE.exec(selector)) !== null) {
    const entry = map[m[1] as string];
    if (!entry) continue; // not a module hash — leave the token untouched
    matched = true;
    if (file === null) file = entry.file;
    else if (file !== entry.file) ambiguous = true;
    out += selector.slice(last, m.index) + "." + entry.local;
    last = m.index + m[0].length;
  }

  if (!matched || file === null || ambiguous) return null;
  out += selector.slice(last);
  return { file, selector: out };
}
