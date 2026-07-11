import { parse as babelParse } from "@babel/parser";
import * as recast from "recast";
import { SkipChangeError } from "./errors.js";

/**
 * apps/server/src/fidelity.ts — THE shared guard every writer routes through.
 *
 * Three prior audits each found the same bug family in a DIFFERENT writer: a
 * writer persists source that RE-PARSES but holds a value other than what
 * was requested, or injects an extra declaration/rule/interpolation, or
 * (cssinjs) turns a plain value into executing code — and reports success.
 * Each fix landed locally on the one writer the audit happened to look at,
 * so the next audit always found another unguarded write site.
 *
 * This module is the structural fix: ONE place that defines what "safe to
 * persist" means. No write site in this package may bypass it.
 *
 *   (1) VALUE FIDELITY — assertExactMatch / assertValueRoundTrips: after
 *       producing the candidate text, locate the exact target the SAME way
 *       it will be read back, and require byte-for-byte equality with what
 *       was requested. Mismatch -> SkipChangeError, never a partial write.
 *   (2) NO STRUCTURAL INJECTION — assertStructuralCountUnchanged: an edit
 *       may change ONLY the intended node. Any unexpected delta in a
 *       declaration count / rule count / interpolation count means
 *       something besides the intended value moved -> SkipChangeError.
 *   (3) INJECTION PRE-REJECT — assertCssValueSafe / assertCssInJsValueSafe /
 *       assertClassTokensSafe / the JSX*_UNSAFE_RE family: values that can
 *       never be a legitimate single value (a bare `;`/`{`/`}` in a CSS
 *       declaration value, a backtick or `${` in a css-in-js template) are
 *       rejected BEFORE any parser/printer sees them — independent of
 *       whether a given writer's reparse-only check would happen to catch
 *       the resulting damage.
 *
 * apply-css.ts, cssinjs.ts, apply-jsx.ts, and classlist.ts all import from
 * here rather than keeping a local copy of any of this.
 */

// ---------------------------------------------------------------------------
// (1) + (2): generic assertion primitives
// ---------------------------------------------------------------------------

/**
 * Throws SkipChangeError with the module's uniform "value fidelity" message
 * when `actual !== expected`. The single place that decides what "the write
 * would silently change the value" looks like, message-wise, across every
 * writer.
 */
export function assertExactMatch(label: string, actual: string | null | undefined, expected: string): void {
  if (actual !== expected) {
    throw new SkipChangeError(
      `refusing to write: ${label} would round-trip to a different value than requested (value-fidelity check failed)`,
    );
  }
}

/**
 * Like assertExactMatch, but for readers that can legitimately return more
 * than one candidate value for the same target (e.g. a css-in-js template
 * where the same property may appear more than once — a base value plus a
 * later override that wins the cascade — and a regex-based re-extraction
 * has no cascade semantics to pick "the" one). Passes when `expected` is
 * present anywhere in `candidates`.
 */
export function assertValuePresent(label: string, candidates: string[], expected: string): void {
  if (!candidates.includes(expected)) {
    throw new SkipChangeError(
      `refusing to write: ${label} would round-trip to a different value than requested (value-fidelity check failed)`,
    );
  }
}

/** The mirror of assertValuePresent for a delete: refuses the write when the target is unexpectedly STILL present after removal. */
export function assertAbsent(label: string, candidates: string[]): void {
  if (candidates.length > 0) {
    throw new SkipChangeError(
      `refusing to write: ${label} is still present after delete (value-fidelity check failed)`,
    );
  }
}

/**
 * Generic "produce a candidate -> re-extract it using the SAME reader the
 * eventual consumer will use -> compare" primitive. This is the one
 * mechanism behind value fidelity across every writer in this package: CSS
 * declaration values (postcss re-parse + relocate), JSX attribute/text/
 * className values (isolated-node reparse), css-in-js declaration values
 * (regex re-extraction), and HTML class attributes (regex re-extraction)
 * all reduce to this same shape. A throw from either callback (the
 * candidate itself cannot be printed/parsed) is treated the same as a
 * mismatch: refuse the write rather than let an internal error escape
 * uncaught.
 */
export function assertValueRoundTrips<T>(params: {
  label: string;
  produce: () => T;
  extract: (produced: T) => string | null | undefined;
  expected: string;
}): T {
  let produced: T;
  try {
    produced = params.produce();
  } catch (err) {
    throw new SkipChangeError(
      `refusing to write: ${params.label} value cannot be verified to round-trip (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }
  let actual: string | null | undefined;
  try {
    actual = params.extract(produced);
  } catch (err) {
    throw new SkipChangeError(
      `refusing to write: ${params.label} value cannot be verified to round-trip (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }
  assertExactMatch(params.label, actual, params.expected);
  return produced;
}

/**
 * Throws SkipChangeError when a structural count (declaration count in a
 * rule, rule count in a file, interpolation count in a css-in-js template,
 * ...) changed by anything other than the one delta the caller intended.
 * The generic mechanism behind "no structural injection" across every
 * writer — each writer supplies its own domain-specific counting logic
 * (what "a declaration" or "a rule" even means differs completely between a
 * postcss AST and a template literal), but the decision of what counts as
 * an unexpected delta, and the resulting SkipChangeError, live in one place.
 */
export function assertStructuralCountUnchanged(params: {
  label: string;
  before: number;
  after: number;
  expectedDelta: number;
}): void {
  const actualDelta = params.after - params.before;
  if (actualDelta !== params.expectedDelta) {
    throw new SkipChangeError(
      `refusing to write: ${params.label} count changed by ${actualDelta} (expected ${params.expectedDelta}) — possible structural injection`,
    );
  }
}

// ---------------------------------------------------------------------------
// (3) Injection pre-reject: plain CSS declaration values
// ---------------------------------------------------------------------------

/** Strip quoted-string and url(...) contents so e.g. `content: ";"` doesn't false-positive the raw-char scan below. */
function stripCssQuotedAndUrl(value: string): string {
  return value
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/url\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\s*\)/gi, "url()");
}

const CSS_VALUE_UNSAFE_RE = /[;{}]/;

/**
 * A raw, unquoted `;`, `{`, or `}` in a CSS declaration value can never be a
 * legitimate single value — CSS has no way to "escape" these outside a
 * quoted string or url(...). A writer that stores such a value verbatim
 * (postcss's Declaration#value setter does no validation at all) and prints
 * it produces text that RE-PARSES fine yet contains an injected extra
 * declaration or rule (`"red; background: evil"`, `"red } .evil { color:
 * blue }"`). Reject before any parser/printer ever sees it — this is the
 * cheap, syntax-independent first line of defense; assertStructuralCount-
 * Unchanged is the second, for anything that slips past a regex.
 */
export function assertCssValueSafe(value: string): void {
  if (CSS_VALUE_UNSAFE_RE.test(stripCssQuotedAndUrl(value))) {
    throw new SkipChangeError(
      `refusing to write: value contains an unescaped ";", "{", or "}" outside a quoted string/url(...) — cannot be a legitimate single CSS value: "${value}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// (3) Injection pre-reject: css-in-js template-literal values
// ---------------------------------------------------------------------------

/**
 * css-in-js declaration values are spliced as raw text directly into a JS
 * template literal (see cssinjs.ts). Two distinct hazards, NEITHER caught by
 * a JS-level reparse:
 *  - a backtick or `${` is JS TEMPLATE-LITERAL SYNTAX, not CSS — it
 *    terminates the template or opens a LIVE JS expression regardless of
 *    any CSS-level quoting (`"a${globalThis.pwn=1}c"` executes attacker
 *    code the next time the component renders).
 *  - a raw, unquoted `;` or `}` breaks the CSS structure that the css-in-js
 *    engine (emotion/styled-components) parses THIS text as at runtime,
 *    even though it is completely inert to the JS parser itself
 *    (`"red } .evil { color: blue"` is perfectly valid JS template text,
 *    but injects a whole new rule once emotion parses it as CSS).
 */
export function assertCssInJsValueSafe(value: string): void {
  if (value.includes("`")) {
    throw new SkipChangeError(
      `refusing to write: value contains a backtick, which would terminate the enclosing template literal: "${value}"`,
    );
  }
  if (value.includes("${")) {
    throw new SkipChangeError(
      `refusing to write: value contains "\${", which would open a live JS interpolation in the template literal: "${value}"`,
    );
  }
  if (/[;{}]/.test(stripCssQuotedAndUrl(value))) {
    throw new SkipChangeError(
      `refusing to write: value contains an unescaped ";", "{", or "}" outside a quoted string/url(...) — would break the enclosing CSS rule structure: "${value}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// (3) Injection pre-reject + safe-node building: JSX attribute / text / class
// ---------------------------------------------------------------------------

const b = recast.types.builders;

interface JsxValueHolder {
  type?: string;
  value?: unknown;
  expression?: { type?: string; value?: unknown };
  [key: string]: unknown;
}

interface JsxTextChild {
  type?: string;
  value?: unknown;
  expression?: { type?: string; value?: unknown };
  [key: string]: unknown;
}

/**
 * JSX attribute string literals ("...") are lexed like raw JSXText, NOT a JS
 * string — there is no backslash-escape mechanism. A `"` cannot be
 * represented inside a bare `attr="..."` form at all. A backslash or any C0
 * control character (newline, tab, CR, ...) DOES still parse when printed
 * bare — but the printer's string serializer emits a JS-style escape for it
 * regardless of context, and JSX attribute strings do not interpret
 * backslash escapes at all. The result RE-PARSES cleanly yet holds a
 * DIFFERENT value than requested (a real tab becomes the two literal
 * characters `\` and `t`) — reparse-only validation cannot catch this, only
 * exact-value comparison can. Route every such value through the
 * JSXExpressionContainer string-literal form instead, where JS string
 * escaping is well-defined and round-trips exactly.
 */
export const JSX_ATTR_STRING_UNSAFE_RE = /["\\\x00-\x1f]/;

/**
 * `<`, `{`, `}` terminate/reopen JSX markup mid-text and would be misread as
 * the start of a tag/expression. C0 control chars parse fine as raw JSXText
 * but recast's printer reformats multi-line text to match the surrounding
 * document's indentation (silently inserting whitespace into a value
 * containing a real newline) or can throw outright on a raw tab. A `{...}`
 * expression container avoids both.
 */
export const JSX_TEXT_UNSAFE_RE = /[<{}\x00-\x1f]/;

/**
 * Characters that cannot appear inside a class token embedded in
 * `class="..."` (HTML — no escape mechanism at all) or `className="..."`
 * (JSX attribute string — same limitation as JSX_ATTR_STRING_UNSAFE_RE)
 * without either corrupting the surrounding markup or silently changing the
 * token read back. Tailwind's own arbitrary-value syntax has no way to
 * express any of these anyway, so refusing to write loses nothing.
 */
export const UNSAFE_CLASS_TOKEN_RE = /["'<>=`\s]/;

/** SkipChangeError when any token about to be spliced into a class attribute is unsafe to embed. */
export function assertClassTokensSafe(tokens: string[]): void {
  for (const t of tokens) {
    if (UNSAFE_CLASS_TOKEN_RE.test(t)) {
      throw new SkipChangeError(
        `generated utility class token "${t}" contains a character that cannot be safely embedded in a class attribute; refusing to write (Tailwind arbitrary-value syntax cannot express raw quotes/whitespace/angle-brackets)`,
      );
    }
  }
}

function readJsxAttrStringValue(val: JsxValueHolder | null | undefined): string | null {
  if (!val) return null;
  if (val.type === "StringLiteral") return String(val.value ?? "");
  if (val.type === "JSXExpressionContainer" && val.expression?.type === "StringLiteral") {
    return String(val.expression.value ?? "");
  }
  return null;
}

function readJsxTextChildValue(node: JsxTextChild | undefined): string | null {
  if (!node) return null;
  if (node.type === "JSXText") return String(node.value ?? "");
  if (node.type === "JSXExpressionContainer" && node.expression?.type === "StringLiteral") {
    return String(node.expression.value ?? "");
  }
  return null;
}

/**
 * Build the value node for a JSX attribute — including `className`, which
 * is just another string-valued JSX attribute: a plain string literal when
 * the value is safe to embed bare, otherwise a `{...}` expression container
 * wrapping a real JS string literal (JS string escaping IS well-defined, so
 * any character round-trips correctly there).
 *
 * Applies the value-fidelity round-trip assertion (print the node standalone,
 * embed it in a throwaway `<x attribute=PRINTED />` fragment, parse that
 * fragment, confirm the attribute reads back to EXACTLY the requested value)
 * before returning, so every caller — set-attr, the style-attribute string
 * form, and className rewriting — gets the safety net automatically, from
 * ONE implementation.
 *
 * Deliberately scoped to the built node, NOT a full-document reparse +
 * relocate-by-line: recast can reflow/collapse unrelated surrounding source
 * on any edit (verified empirically — a single-line self-closing element's
 * containing `return (...)` collapsing onto one line after only one
 * attribute value was replaced), which shifts the very line number a
 * location-based re-check would depend on and produces a false-positive
 * skip on an otherwise-correct edit. Isolating the node sidesteps that.
 */
export function buildAttrValueNode(attribute: string, value: string): unknown {
  const node = JSX_ATTR_STRING_UNSAFE_RE.test(value)
    ? b.jsxExpressionContainer(b.stringLiteral(value))
    : b.stringLiteral(value);
  assertValueRoundTrips({
    label: `attribute "${attribute}"`,
    produce: () => recast.print(node as recast.types.ASTNode).code,
    extract: (printed) => {
      const fragment = babelParse(`const _x = <x ${attribute}=${printed} />;`, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
      });
      let actual: string | null = null;
      recast.types.visit(fragment, {
        visitJSXAttribute(p) {
          const attrNode = p.node as unknown as { value: JsxValueHolder | null };
          actual = readJsxAttrStringValue(attrNode.value);
          return false;
        },
      });
      return actual;
    },
    expected: value,
  });
  return node;
}

/**
 * Build the child node for new JSX text content: raw JSXText when safe,
 * otherwise a `{...}` expression container wrapping a JS string literal.
 * Same value-fidelity round-trip assertion pattern as buildAttrValueNode,
 * scoped to a throwaway `<x>PRINTED</x>` fragment.
 */
export function buildTextChildNode(text: string): unknown {
  const node = JSX_TEXT_UNSAFE_RE.test(text)
    ? b.jsxExpressionContainer(b.stringLiteral(text))
    : b.jsxText(text);
  assertValueRoundTrips({
    label: "text content",
    produce: () => recast.print(node as recast.types.ASTNode).code,
    extract: (printed) => {
      const fragment = babelParse(`const _x = <x>${printed}</x>;`, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
      });
      let actual: string | null = null;
      recast.types.visit(fragment, {
        visitJSXElement(p) {
          const children = (p.node.children ?? []) as JsxTextChild[];
          actual = children.length === 1 ? readJsxTextChildValue(children[0]) : null;
          return false;
        },
      });
      return actual;
    },
    expected: text,
  });
  return node;
}
