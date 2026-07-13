import { applyCssChange, type CssChange, type RulePosition } from "./apply-css.js";
import { SkipChangeError } from "./errors.js";

/**
 * apps/server/src/apply-sfc.ts — the SFC (`.vue`/`.svelte`) style-block apply
 * tier. Framework-agnostic and dependency-free on purpose: no @vue/compiler-sfc,
 * just regex extraction of `<style>` blocks plus reuse of apply-css.ts's pure
 * PostCSS editor for the CSS text inside them.
 *
 * KNOWN LIMITATION: `<style module>` blocks compile class names to opaque
 * hashes (`._card_HASH_N`) that cannot be reversed back to the source
 * selector (`.card`) without the build tool's module export map, and the
 * extension sends no CDP range for these. That case is expected to skip with
 * a clear SkipChangeError reason (see applySfcChange below) — not
 * over-engineered here.
 */

export interface StyleBlock {
  /** Raw attribute string between `<style` and the closing `>`, e.g. ` scoped lang="scss"`. */
  attrs: string;
  lang: "css" | "scss";
  module: boolean;
  scoped: boolean;
  /** Byte offset (into the full SFC text) of the first char of the block's inner CSS. */
  innerStart: number;
  /** Byte offset (exclusive) of the last char of the block's inner CSS. */
  innerEnd: number;
  /** The block's inner text — always equal to `sfc.slice(innerStart, innerEnd)`. */
  css: string;
}

/** Trailing/embedded Vue scoped-style attribute selector, e.g. `[data-v-c7059591]`. */
const VUE_SCOPED_ATTR_RE = /\[data-v-[0-9a-f]+\]/gi;
/** Svelte's scoping class suffix appended to compiled selectors, e.g. `.svelte-1a2b3c`. */
const SVELTE_SCOPED_CLASS_RE = /\.svelte-[0-9a-z]+/gi;
/** Astro's scoping attribute selector appended to compiled selectors, e.g. `[data-astro-cid-yk4hkwyg]`. */
const ASTRO_SCOPED_ATTR_RE = /\[data-astro-cid-[0-9a-z]+\]/gi;

/**
 * Reduce a SERVED (scoped) selector back to what the source `<style>` block
 * actually contains, by stripping the compiler-injected scoping hooks. Plain
 * selectors pass through unchanged.
 *
 * KNOWN LIMITATION: Svelte's scope class is a base36 hash (`.svelte-1a2b3c`),
 * indistinguishable from a hand-authored class literally named `.svelte-*`. A
 * user class like `.svelte-foo` would be stripped here. Requiring a digit
 * wouldn't help (hashes aren't guaranteed to contain one), so we accept the
 * (rare) false positive rather than break real hash stripping.
 */
export function stripScopedAttr(selector: string): string {
  return selector
    .replace(VUE_SCOPED_ATTR_RE, "")
    .replace(SVELTE_SCOPED_CLASS_RE, "")
    .replace(ASTRO_SCOPED_ATTR_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

const STYLE_BLOCK_RE = /<style([^>]*)>([\s\S]*?)<\/style>/gi;

function parseLang(attrs: string): "css" | "scss" {
  const m = /\blang\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const lang = (m?.[1] ?? m?.[2] ?? "").toLowerCase();
  return lang === "scss" || lang === "sass" ? "scss" : "css";
}

function hasBooleanAttr(attrs: string, name: string): boolean {
  return new RegExp(`(^|\\s)${name}(\\s|=|$)`, "i").test(attrs);
}

/**
 * Regex-extract every `<style ...>...</style>` block from an SFC's raw text,
 * with an EXACT byte range for the inner CSS so callers can splice an edit
 * back in without disturbing anything else in the file (template/script
 * sections, other style blocks, even the block's own opening/closing tags).
 */
export function extractStyleBlocks(sfc: string): StyleBlock[] {
  const blocks: StyleBlock[] = [];
  STYLE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STYLE_BLOCK_RE.exec(sfc)) !== null) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    // The inner text starts right after "<style" + attrs + ">".
    const innerStart = match.index + "<style".length + attrs.length + 1;
    blocks.push({
      attrs,
      lang: parseLang(attrs),
      module: hasBooleanAttr(attrs, "module"),
      scoped: hasBooleanAttr(attrs, "scoped"),
      innerStart,
      innerEnd: innerStart + inner.length,
      css: inner,
    });
  }
  return blocks;
}

export interface ApplySfcOptions {
  /** Original-source position the sourcemap resolved, when one exists. */
  position?: RulePosition | undefined;
}

export interface ApplySfcResult {
  css: string;
}

/** 1-based line number of a byte offset within `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** Does the block's inner byte range contain source line `line` (1-based, whole-file numbering)? */
function blockContainsLine(sfc: string, block: StyleBlock, line: number): boolean {
  const startLine = lineAt(sfc, block.innerStart);
  const endLine = lineAt(sfc, block.innerEnd);
  return line >= startLine && line <= endLine;
}

/** Quick "does this block's CSS contain a rule with this selector" check, for block selection only (the real match happens inside applyCssChange). */
function blockContainsSelector(css: string, selector: string): boolean {
  // Cheap textual check: the selector's normalized text appears as a rule
  // header somewhere in the block. Good enough to pick between blocks;
  // applyCssChange does the authoritative AST-level match.
  const wanted = selector.replace(/\s+/g, " ").trim();
  const pattern = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${pattern}(\\s|,|\\{)`).test(css.replace(/\s+/g, " "));
}

/**
 * Apply one captured CSS change to an SFC's `<style>` block(s). Pure: string
 * in, string out; throws SkipChangeError for "cannot apply" conditions so the
 * orchestrator can skip-with-reason (never a partial/corrupting write).
 *
 * Steps: (a) reduce the served (scoped) selector to the source selector via
 * stripScopedAttr; (b) pick the target block — by mapped source line when a
 * position hint is available, else by textual selector match; (c) delegate
 * the actual CSS edit to apply-css.ts's applyCssChange, reusing its
 * selector/position matching and structural-fidelity guards; (d) splice the
 * edited CSS back into the SFC over exactly the target block's byte range —
 * everything outside that range (template, script, other style blocks, even
 * this block's own tags) is byte-identical afterward.
 */
export function applySfcChange(
  sfc: string,
  change: CssChange,
  opts: ApplySfcOptions = {},
): ApplySfcResult {
  const blocks = extractStyleBlocks(sfc);
  if (blocks.length === 0) {
    throw new SkipChangeError("no <style> block found in SFC source");
  }

  const strippedSelector = stripScopedAttr(change.selector);

  let target: StyleBlock | undefined;
  let blockPosition: RulePosition | undefined;

  if (opts.position?.line !== undefined) {
    target = blocks.find((b) => blockContainsLine(sfc, b, opts.position!.line));
    if (target) {
      blockPosition = {
        line: opts.position!.line - lineAt(sfc, target.innerStart) + 1,
        column: opts.position!.column,
      };
    }
  }

  if (!target) {
    // No usable source position — fall back to a textual selector match. If the
    // selector textually appears in MORE than one <style> block we cannot tell
    // which one the browser-observed rule lives in; guessing risks editing the
    // wrong block (silent source corruption), so skip-with-reason instead.
    const matches = blocks.filter((b) => blockContainsSelector(b.css, strippedSelector));
    if (matches.length > 1) {
      throw new SkipChangeError(
        `selector "${strippedSelector}" (from served selector "${change.selector}") appears in ${String(matches.length)} <style> blocks of this SFC and no source position was available to disambiguate — refusing to guess which block the edit targets`,
      );
    }
    target = matches[0];
  }

  if (!target) {
    if (blocks.some((b) => b.module)) {
      throw new SkipChangeError(
        `selector "${change.selector}" not found in any <style> block — <style module> selectors are compiled to opaque hashes the server cannot reverse without a range; this change was likely targeting one`,
      );
    }
    throw new SkipChangeError(
      `selector "${strippedSelector}" (from served selector "${change.selector}") not found in any <style> block of this SFC`,
    );
  }

  if (target.module) {
    throw new SkipChangeError(
      `matched a <style module> block, but its served selector can't be reversed to the source selector without the module export map — unsupported`,
    );
  }

  const changeForBlock: CssChange = { ...change, selector: strippedSelector };
  const result = applyCssChange(target.css, changeForBlock, {
    syntax: target.lang,
    position: blockPosition,
  });

  const css = sfc.slice(0, target.innerStart) + result.css + sfc.slice(target.innerEnd);
  return { css };
}
