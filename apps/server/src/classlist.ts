import fs from "node:fs";
import path from "node:path";
import * as recast from "recast";
import { parse as babelParse } from "@babel/parser";
import type {
  AddDeclChange,
  AddRuleChange,
  DeleteDeclChange,
  ElementContext,
  ModifyChange,
} from "@dev-sync/contract";
import { SkipChangeError } from "./errors.js";
import { jailResolve } from "./workspace.js";
import { assertClassTokensSafe, assertExactMatch, buildAttrValueNode } from "./fidelity.js";

/** CSS-shaped ops only (excludes set-attr/remove-attr/set-text, which have no styleSheet/selector). */
type CssShapedChange = ModifyChange | AddDeclChange | DeleteDeclChange | AddRuleChange;

const b = recast.types.builders;

const recastBabelParser = {
  parse: (source: string) =>
    babelParse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      tokens: true,
    }),
};

// ---------------------------------------------------------------------------
// Utility-class detection
// ---------------------------------------------------------------------------

const TAILWIND_PREFIXES = new Set([
  "m", "mx", "my", "mt", "mb", "ml", "mr",
  "p", "px", "py", "pt", "pb", "pl", "pr",
  "w", "h", "size", "min-w", "max-w", "min-h", "max-h",
  "gap", "gap-x", "gap-y", "space-x", "space-y",
  "text", "bg", "font", "leading", "tracking", "decoration", "underline",
  "uppercase", "lowercase", "capitalize", "truncate", "whitespace", "break",
  "flex", "grid", "block", "inline", "inline-block", "inline-flex", "inline-grid",
  "hidden", "contents", "items", "justify", "content", "self", "place",
  "grow", "shrink", "basis", "order", "col", "row",
  "rounded", "border", "divide-x", "divide-y", "ring", "outline",
  "shadow", "opacity", "z", "top", "bottom", "left", "right", "inset",
  "absolute", "relative", "fixed", "sticky", "static",
  "overflow", "object", "aspect", "cursor", "select", "pointer-events",
  "transition", "duration", "ease", "delay", "animate",
  "scale", "rotate", "translate-x", "translate-y", "skew", "origin",
  "fill", "stroke", "align", "list", "sr-only",
]);

/** ".md\\:mt-4" -> "md:mt-4" (CSS selector escaping removed). */
export function unescapeCssClass(selector: string): string {
  return selector.replace(/^\./, "").replace(/\\(.)/g, "$1");
}

/** True when the selector is a single simple class that looks like a Tailwind utility. */
export function isUtilityClassSelector(selector: string): boolean {
  const s = selector.trim();
  if (!s.startsWith(".")) return false;
  // Reject combinators/pseudo/attribute selectors — but tolerate escaped chars
  // (`.w-1\/2`, `.mt-\[20px\]`, `.md\:mt-4` are all single classes).
  const withoutEscapes = s.replace(/\\./g, "x");
  if (/[\s>+~,():[\]#*]/.test(withoutEscapes.slice(1))) return false;

  const cls = unescapeCssClass(s);
  const base = cls.split(":").pop() ?? cls;
  const stem = (base.startsWith("-") ? base.slice(1) : base).split("[")[0] ?? "";
  const parts = stem.replace(/-$/, "").split("-").filter(Boolean);
  for (let i = parts.length; i >= 1; i--) {
    if (TAILWIND_PREFIXES.has(parts.slice(0, i).join("-"))) return true;
  }
  return false;
}

/** Should this change be applied as a className edit instead of a CSS file edit? */
export function isTailwindTarget(change: CssShapedChange): boolean {
  if (/tailwind/i.test(change.styleSheet.sourceURL)) return true;
  return isUtilityClassSelector(change.selector);
}

// ---------------------------------------------------------------------------
// property/value -> utility class
// ---------------------------------------------------------------------------

const DISPLAY_UTILITIES: Record<string, string> = {
  block: "block",
  "inline-block": "inline-block",
  inline: "inline",
  flex: "flex",
  "inline-flex": "inline-flex",
  grid: "grid",
  "inline-grid": "inline-grid",
  contents: "contents",
  none: "hidden",
};

const PROP_TO_PREFIX: Record<string, string> = {
  margin: "m",
  "margin-top": "mt",
  "margin-bottom": "mb",
  "margin-left": "ml",
  "margin-right": "mr",
  padding: "p",
  "padding-top": "pt",
  "padding-bottom": "pb",
  "padding-left": "pl",
  "padding-right": "pr",
  width: "w",
  height: "h",
  "min-width": "min-w",
  "max-width": "max-w",
  "min-height": "min-h",
  "max-height": "max-h",
  gap: "gap",
  "column-gap": "gap-x",
  "row-gap": "gap-y",
  color: "text",
  "background-color": "bg",
  "font-size": "text",
  "font-weight": "font",
  "line-height": "leading",
  "letter-spacing": "tracking",
  "border-radius": "rounded",
  "border-width": "border",
  "border-color": "border",
  opacity: "opacity",
  "z-index": "z",
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
  "flex-basis": "basis",
  "box-shadow": "shadow",
  "transition-duration": "duration",
};

/**
 * Deterministic mapping of a declaration to a Tailwind class. Uses
 * arbitrary-value (`mt-[20px]`) or arbitrary-property (`[margin-top:20px]`)
 * syntax so the result is always valid without a theme lookup.
 */
export function utilityForDeclaration(property: string, value: string): string {
  const prop = property.trim().toLowerCase();
  const raw = value.trim().replace(/\s*!important\s*$/i, "");
  if (prop === "display") {
    const direct = DISPLAY_UTILITIES[raw];
    if (direct) return direct;
  }
  const v = raw.replace(/\s+/g, "_");
  const prefix = PROP_TO_PREFIX[prop];
  return prefix ? `${prefix}-[${v}]` : `[${prop}:${v}]`;
}

// ---------------------------------------------------------------------------
// className / class attribute editing
// ---------------------------------------------------------------------------

// assertClassTokensSafe is the SHARED guard (./fidelity.js): a generated
// utility-class token containing a quote/angle-bracket/backtick/whitespace
// cannot be safely embedded in class="..."/className="..." (neither HTML
// nor JSX attribute strings have an escape mechanism for these), and
// Tailwind's arbitrary-value syntax has no way to express any of them
// anyway — refusing to write loses nothing.

function applyTokens(existing: string, remove: string[], add: string[]): string {
  assertClassTokensSafe(add);
  const removeSet = new Set(remove);
  let tokens = existing.split(/\s+/).filter(Boolean);
  tokens = tokens.filter((t) => !removeSet.has(t));
  for (const a of add) {
    if (!tokens.includes(a)) tokens.push(a);
  }
  return tokens.join(" ");
}

type ClasslistChange = ModifyChange | AddDeclChange | DeleteDeclChange;

function tokenEdits(change: ClasslistChange): { remove: string[]; add: string[] } {
  switch (change.op) {
    case "modify": {
      const remove = isUtilityClassSelector(change.selector)
        ? [unescapeCssClass(change.selector)]
        : [];
      return { remove, add: [utilityForDeclaration(change.property, change.newValue)] };
    }
    case "add-decl":
      return { remove: [], add: [utilityForDeclaration(change.property, change.newValue)] };
    case "delete-decl": {
      if (!isUtilityClassSelector(change.selector)) {
        throw new SkipChangeError(
          `cannot map delete-decl on "${change.selector}" to a utility-class removal`,
        );
      }
      return { remove: [unescapeCssClass(change.selector)], add: [] };
    }
  }
}

interface JsxNode {
  type?: string;
  loc?: { start?: { line?: number } } | null;
  attributes?: JsxAttrNode[];
  [key: string]: unknown;
}
interface JsxAttrNode {
  type?: string;
  name?: { name?: string };
  value?: {
    type?: string;
    value?: unknown;
    expression?: { type?: string; value?: unknown };
  } | null;
  [key: string]: unknown;
}

// buildAttrValueNode (imported above from ./fidelity.js) is the SAME shared
// builder every JSX attribute write in this package routes through
// (apply-jsx.ts's set-attr, the style attribute, and here for className —
// className is just another string-valued JSX attribute): it picks a safe
// node representation AND applies the value-fidelity round-trip assertion
// (print standalone, embed in a throwaway `<x className=PRINTED />`
// fragment, parse, confirm the exact value reads back) before returning.

function editJsxClass(
  code: string,
  element: ElementContext,
  remove: string[],
  add: string[],
): { code: string; note?: string | undefined } {
  const targetLine = element.dataSourceLine;
  const ast = recast.parse(code, { parser: recastBabelParser });
  let edited = false;
  let note: string | undefined;
  let skip: SkipChangeError | null = null;

  recast.types.visit(ast, {
    visitJSXOpeningElement(p) {
      if (edited || skip) return false;
      const node = p.node as unknown as JsxNode;
      const attrs = (node.attributes ?? []) as JsxAttrNode[];

      const locLine = node.loc?.start?.line;
      const matchesLoc = targetLine !== undefined && locLine === targetLine;
      const matchesAttr =
        targetLine !== undefined &&
        attrs.some(
          (a) =>
            a.type === "JSXAttribute" &&
            a.name?.name === "data-source-line" &&
            a.value?.type === "StringLiteral" &&
            Number(a.value.value) === targetLine,
        );
      if (!matchesLoc && !matchesAttr) {
        this.traverse(p);
        return undefined;
      }

      const attr = attrs.find(
        (a) => a.type === "JSXAttribute" && (a.name?.name === "className" || a.name?.name === "class"),
      );
      if (attr) {
        if (attr.value?.type === "StringLiteral") {
          const next = applyTokens(String(attr.value.value ?? ""), remove, add);
          (attr as { value: unknown }).value = buildAttrValueNode("className", next);
        } else if (
          attr.value?.type === "JSXExpressionContainer" &&
          attr.value.expression?.type === "StringLiteral"
        ) {
          const next = applyTokens(String(attr.value.expression.value ?? ""), remove, add);
          (attr.value as { expression: unknown }).expression = buildAttrValueNode("className", next);
        } else {
          skip = new SkipChangeError(
            "className is a dynamic expression; cannot edit deterministically",
          );
          return false;
        }
      } else if (add.length > 0) {
        const next = applyTokens("", remove, add);
        const valueNode = buildAttrValueNode("className", next) as Parameters<typeof b.jsxAttribute>[1];
        (node.attributes as unknown[]).push(b.jsxAttribute(b.jsxIdentifier("className"), valueNode));
      } else {
        note = "element has no className attribute; nothing to remove";
      }
      edited = true;
      return false;
    },
  });

  if (skip) throw skip;
  if (!edited) {
    throw new SkipChangeError(
      `no JSX element found at ${element.dataSourceFile ?? "?"}:${String(targetLine)}`,
    );
  }
  const printed = recast.print(ast).code;
  // CORE INVARIANT #1: never persist source that does not re-parse — same
  // guard as apply-jsx.ts, applied consistently across every writer.
  //
  // CORE INVARIANT #2 (value fidelity) was already enforced above, at the
  // point each replacement className node was built — buildAttrValueNode
  // (./fidelity.js) asserts its own node round-trips to the exact requested
  // value; see its doc comment for why that is deliberately NOT done here
  // via a full-document reparse + relocate.
  try {
    recastBabelParser.parse(printed);
  } catch (err) {
    throw new SkipChangeError(
      `refusing to write: edited JSX failed to re-parse (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }
  return { code: printed, note };
}

function editHtmlClass(
  code: string,
  element: ElementContext,
  remove: string[],
  add: string[],
): { code: string; note?: string | undefined } {
  const lines = code.split("\n");
  const targetLine = element.dataSourceLine;
  let idx = targetLine !== undefined ? targetLine - 1 : -1;
  if (idx < 0 || idx >= lines.length || !/<[a-zA-Z]/.test(lines[idx] ?? "")) {
    // fall back to the data-source-line attribute stamped by the instrumenter
    idx = lines.findIndex((l) => l.includes(`data-source-line="${String(targetLine)}"`));
  }
  if (idx < 0) {
    throw new SkipChangeError(
      `no HTML element found at ${element.dataSourceFile ?? "?"}:${String(targetLine)}`,
    );
  }
  const line = lines[idx] ?? "";
  const classRe = /(class\s*=\s*)(["'])([^"']*)\2/;
  const m = classRe.exec(line);
  let newLine: string;
  let expected: string;
  if (m) {
    const next = applyTokens(m[3] ?? "", remove, add);
    expected = next;
    newLine = line.replace(classRe, `$1$2${next}$2`);
  } else if (add.length > 0) {
    const next = applyTokens("", remove, add);
    expected = next;
    newLine = line.replace(/<([a-zA-Z][\w-]*)/, `<$1 class="${next}"`);
  } else {
    return { code, note: "element has no class attribute; nothing to remove" };
  }

  // CORE INVARIANT (value fidelity, via the shared guard in ./fidelity.js):
  // HTML class attributes have no escape mechanism at all, and this writer
  // only ever does raw string splicing — there is no parser here to
  // "re-parse" the way apply-jsx.ts does, so we re-run the SAME extraction
  // regex used to read the attribute against the line we just wrote and
  // confirm it reads back to exactly the token string we intended.
  // assertClassTokensSafe() (inside applyTokens, above) already rejects the
  // unsafe characters that would cause drift here; this is the generalized
  // safety net for anything else that slips through.
  assertExactMatch("class attribute", classRe.exec(newLine)?.[3], expected);
  lines[idx] = newLine;
  return { code: lines.join("\n") };
}

export interface ClasslistApplyResult {
  /** Absolute jailed path of the edited file. */
  file: string;
  line?: number | undefined;
  note?: string | undefined;
}

/** Result of computing (but NOT yet writing) a className token edit. */
export interface ElementClassEdit {
  /** Absolute jailed path of the element's source file. */
  file: string;
  /** Original file contents. */
  original: string;
  /** File contents after the token edit (equals `original` for a no-op). */
  code: string;
  line?: number | undefined;
  note?: string | undefined;
}

/**
 * PURE (no write): locate the instrumented element in its JSX/HTML source and
 * return the source with `add` tokens added / `remove` tokens removed from its
 * class attribute. Shared by the classlist tier (Tailwind edits) and the
 * inline-style promote tier (append one generated class) so both go through
 * the identical, fidelity-guarded className writer. Throws SkipChangeError for
 * every "cannot locate / cannot edit" condition (missing instrumentation,
 * absent file, unsupported extension, dynamic className expression).
 */
export function computeElementClassEdit(
  workspaceRoot: string,
  element: ElementContext,
  remove: string[],
  add: string[],
): ElementClassEdit {
  if (!element?.dataSourceFile || element.dataSourceLine === undefined) {
    throw new SkipChangeError(
      "classlist change requires an instrumented element (data-source-file + data-source-line)",
    );
  }

  const abs = jailResolve(workspaceRoot, element.dataSourceFile);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new SkipChangeError(`instrumented source file not found: ${element.dataSourceFile}`);
  }

  const original = fs.readFileSync(abs, "utf8");
  const ext = path.extname(abs).toLowerCase();

  let result: { code: string; note?: string | undefined };
  if (ext === ".html" || ext === ".htm") {
    result = editHtmlClass(original, element, remove, add);
  } else if ([".jsx", ".tsx", ".js", ".ts", ".mjs", ".cjs"].includes(ext)) {
    result = editJsxClass(original, element, remove, add);
  } else {
    throw new SkipChangeError(`unsupported instrumented source type: ${ext || "(none)"}`);
  }

  return { file: abs, original, code: result.code, line: element.dataSourceLine, note: result.note };
}

/**
 * PURE (no write): map a Tailwind-target change to its className token edit and
 * compute the resulting source. The two-phase apply spine calls this to capture
 * a preview diff or to commit + journal the write itself. Throws SkipChangeError
 * on any unmappable / unlocatable condition, exactly like applyClassListChange.
 */
export function computeClassListChange(
  workspaceRoot: string,
  change: ClasslistChange,
): ElementClassEdit {
  const { remove, add } = tokenEdits(change);
  return computeElementClassEdit(workspaceRoot, change.element as ElementContext, remove, add);
}

/**
 * Tailwind mode: never edit generated CSS — edit the element's className in
 * its JSX/HTML source, located via data-source-file / data-source-line.
 */
export function applyClassListChange(
  workspaceRoot: string,
  change: ClasslistChange,
): ClasslistApplyResult {
  const edit = computeClassListChange(workspaceRoot, change);
  if (edit.code !== edit.original) fs.writeFileSync(edit.file, edit.code, "utf8");
  return { file: edit.file, line: edit.line, note: edit.note };
}
