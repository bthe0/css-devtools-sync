import fs from "node:fs";
import * as recast from "recast";
import { parse as babelParse } from "@babel/parser";
import type {
  RemoveAttrChange,
  RequiredElementContext,
  SetAttrChange,
  SetTextChange,
  SetTextSegmentChange,
  TemplatePart,
} from "@dev-sync/contract";
import { SkipChangeError } from "./errors.js";
import { jailResolve } from "./workspace.js";
import { buildAttrValueNode, buildTextChildNode } from "./fidelity.js";

export type JsxChange = SetAttrChange | RemoveAttrChange | SetTextChange | SetTextSegmentChange;

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
// Minimal duck-typed AST shapes (mirrors the pattern already used in
// classlist.ts / cssinjs.ts — avoids pulling in @babel/types as a direct dep).
// ---------------------------------------------------------------------------

interface AnyNode {
  type?: string;
  loc?: { start: { line: number }; end: { line: number } } | null;
  [key: string]: unknown;
}

interface JsxAttrValueNode {
  type?: string;
  value?: unknown;
  expression?: AnyNode;
  [key: string]: unknown;
}

interface JsxAttrNode {
  type?: string;
  name?: { type?: string; name?: string };
  value?: JsxAttrValueNode | null;
  [key: string]: unknown;
}

interface JsxOpeningNode extends AnyNode {
  attributes?: JsxAttrNode[];
  selfClosing?: boolean;
}

interface JsxElementNode extends AnyNode {
  openingElement?: JsxOpeningNode;
  children?: AnyNode[];
}

interface FoundElement {
  node: JsxElementNode;
  opening: JsxOpeningNode;
}

// ---------------------------------------------------------------------------
// Locating the element by `__srcLoc` source line
// ---------------------------------------------------------------------------

function collectJsxElements(ast: recast.types.ASTNode): FoundElement[] {
  const out: FoundElement[] = [];
  recast.types.visit(ast, {
    visitJSXElement(path) {
      const node = path.node as unknown as JsxElementNode;
      const opening = node.openingElement;
      if (opening) out.push({ node, opening });
      this.traverse(path);
    },
  });
  return out;
}

/**
 * Locate the element instrumented at `targetLine`. Two passes:
 *  1. Exact match: the opening tag starts on targetLine, OR the element
 *     carries a literal `__srcLoc` source line="targetLine" attribute (belt and
 *     braces — mirrors classlist.ts's editJsxClass matching).
 *  2. Nearest enclosing: the smallest element whose full range contains
 *     targetLine (covers reformatted/multi-line opening tags).
 * Returns null when neither pass finds anything — caller skips with a reason.
 */
function locateElement(elements: FoundElement[], targetLine: number): FoundElement | null {
  const exact = elements.find((e) => {
    if (e.opening.loc?.start?.line === targetLine) return true;
    const attrs = e.opening.attributes ?? [];
    return attrs.some(
      (a) =>
        a.type === "JSXAttribute" &&
        a.name?.name === "`__srcLoc` source line" &&
        a.value?.type === "StringLiteral" &&
        Number(a.value.value) === targetLine,
    );
  });
  if (exact) return exact;

  let best: FoundElement | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const e of elements) {
    const startLine = e.node.loc?.start?.line;
    const endLine = e.node.loc?.end?.line;
    if (startLine == null || endLine == null) continue;
    if (startLine <= targetLine && targetLine <= endLine) {
      const span = endLine - startLine;
      if (span < bestSpan) {
        bestSpan = span;
        best = e;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// style="" <-> style={{...}} handling
// ---------------------------------------------------------------------------

interface CssDecl {
  prop: string;
  value: string;
}

/** Parse "prop: value; prop2: value2" into declarations, or null when malformed. */
function parseInlineCssDecls(css: string): CssDecl[] | null {
  const text = css.trim();
  if (text.length === 0) return [];
  const decls: CssDecl[] = [];
  for (const raw of text.split(";")) {
    const part = raw.trim();
    if (part.length === 0) continue;
    const idx = part.indexOf(":");
    if (idx <= 0) return null;
    const prop = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!prop || !value) return null;
    if (!/^-{0,2}[a-zA-Z][a-zA-Z-]*$/.test(prop)) return null;
    decls.push({ prop, value });
  }
  return decls;
}

function cssPropToCamel(prop: string): string {
  if (prop.startsWith("--")) return prop; // custom property: keep verbatim
  return prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** True when every property of a style ObjectExpression is a plain, rewritable literal entry. */
function isSimpleStyleObject(expr: AnyNode): boolean {
  const props = (expr["properties"] as AnyNode[] | undefined) ?? [];
  return props.every((p) => p.type === "ObjectProperty" && p["computed"] !== true);
}

function buildStyleObjectExpression(decls: CssDecl[]): AnyNode {
  const properties = decls.map((d) => {
    const camel = cssPropToCamel(d.prop);
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(camel) ? b.identifier(camel) : b.stringLiteral(d.prop);
    return b.objectProperty(key, b.stringLiteral(d.value));
  });
  return b.objectExpression(properties) as unknown as AnyNode;
}

function applyStyleAttr(attrs: JsxAttrNode[], change: SetAttrChange): void {
  const existing = attrs.find((a) => a.type === "JSXAttribute" && a.name?.name === "style");
  if (!existing || !existing.value) {
    throw new SkipChangeError(
      'style attribute is ambiguous: no existing "style" attribute on this element to infer ' +
        "string-vs-object form from — add one in source first, then retry",
    );
  }

  const val = existing.value;
  if (val.type === "StringLiteral") {
    // Route through the SAME checked builder as every other attribute — this
    // used to assign b.stringLiteral(...) directly, bypassing the
    // value-fidelity round-trip check every other attribute write gets.
    (existing as { value: unknown }).value = buildAttrValueNode("style", change.value.trim());
    return;
  }

  if (val.type === "JSXExpressionContainer" && val.expression?.type === "ObjectExpression") {
    if (!isSimpleStyleObject(val.expression)) {
      throw new SkipChangeError(
        "style object contains a spread or computed key; cannot safely rewrite deterministically",
      );
    }
    const decls = parseInlineCssDecls(change.value);
    if (!decls) {
      throw new SkipChangeError(
        `style value could not be parsed as inline CSS declarations to rewrite the object form: "${change.value}"`,
      );
    }
    (val as { expression: unknown }).expression = buildStyleObjectExpression(decls);
    return;
  }

  throw new SkipChangeError(
    "style attribute is a dynamic expression; cannot edit deterministically without risking clobbering code",
  );
}

// ---------------------------------------------------------------------------
// set-attr / remove-attr / set-text
// ---------------------------------------------------------------------------

/** Valid JSX/JS attribute identifier: letters/underscore start, then word chars plus `.:-` (covers namespaced/data-* attrs). */
const ATTR_NAME_RE = /^[A-Za-z_][\w.:-]*$/;

// buildAttrValueNode / buildTextChildNode (imported above from ./fidelity.js)
// are the SHARED guard: they pick a safe representation for the value AND
// apply the value-fidelity round-trip assertion before returning, so every
// caller here — both the add-new-attribute and update-existing-attribute
// paths in applySetAttr, the string-form style attribute below, and
// applySetText — gets the safety net from ONE implementation. See
// ./fidelity.js's doc comments for why a reparse-only check cannot catch a
// lossy bare-JSX-attribute-string write.

function applySetAttr(found: FoundElement, change: SetAttrChange): void {
  if (!ATTR_NAME_RE.test(change.attribute)) {
    throw new SkipChangeError(
      `invalid attribute name "${change.attribute}"; refusing to write unsafe JSX`,
    );
  }
  // class/className edits are the class-list tier's domain. Writing a raw
  // `class="…"` attribute into JSX (which uses `className`) would leave the
  // element with BOTH attributes, and even `className` should be edited as a
  // token diff, not a whole-value overwrite. Refuse — never corrupt the element.
  if (change.attribute === "class" || change.attribute === "className") {
    throw new SkipChangeError(
      `refusing to set "${change.attribute}" directly; class edits are handled by the class-list tier`,
    );
  }

  const attrs = (found.opening.attributes ?? []) as JsxAttrNode[];

  if (change.attribute === "style") {
    applyStyleAttr(attrs, change);
    return;
  }

  const existing = attrs.find((a) => a.type === "JSXAttribute" && a.name?.name === change.attribute);
  if (!existing) {
    // babel always populates `attributes` as an array (empty, never undefined),
    // so pushing onto the array we read from `found.opening` mutates the AST in place.
    attrs.push(
      b.jsxAttribute(
        b.jsxIdentifier(change.attribute),
        buildAttrValueNode(change.attribute, change.value) as Parameters<typeof b.jsxAttribute>[1],
      ) as unknown as JsxAttrNode,
    );
    return;
  }

  const val = existing.value;
  if (val && val.type === "JSXExpressionContainer") {
    throw new SkipChangeError(
      `attribute "${change.attribute}" is a JSX expression; cannot edit deterministically without risking clobbering code`,
    );
  }
  if (val && val.type !== "StringLiteral") {
    throw new SkipChangeError(
      `attribute "${change.attribute}" has an unsupported value type "${val.type ?? "unknown"}"; skipping to avoid clobbering code`,
    );
  }
  (existing as { value: unknown }).value = buildAttrValueNode(change.attribute, change.value);
}

function applyRemoveAttr(found: FoundElement, change: RemoveAttrChange): void {
  if (change.attribute === "class" || change.attribute === "className") {
    throw new SkipChangeError(
      `refusing to remove "${change.attribute}" directly; class edits are handled by the class-list tier`,
    );
  }
  const attrs = (found.opening.attributes ?? []) as JsxAttrNode[];
  const idx = attrs.findIndex((a) => a.type === "JSXAttribute" && a.name?.name === change.attribute);
  if (idx === -1) {
    throw new SkipChangeError(`attribute "${change.attribute}" not present on the element; nothing to remove`);
  }
  attrs.splice(idx, 1);
}

function applySetText(found: FoundElement, change: SetTextChange): void {
  if (found.opening.selfClosing) {
    throw new SkipChangeError("element is self-closing and cannot contain text children");
  }
  const children = (found.node.children ?? []) as AnyNode[];

  if (children.length === 1 && children[0]?.type === "JSXText") {
    children[0] = buildTextChildNode(change.newText) as AnyNode;
    return;
  }
  if (children.length === 0) {
    (found.node as { children: unknown[] }).children = [buildTextChildNode(change.newText)];
    return;
  }
  throw new SkipChangeError(
    "element children contain expressions or nested elements; cannot safely replace text " +
      "without destroying dynamic content — use set-text-segment to edit one static run instead",
  );
}

/** Text value a printed child carries: JSXText -> its value; {"..."} container -> the string. */
function extractChildText(child: AnyNode): string | null {
  if (child.type === "JSXText") {
    return typeof child.value === "string" ? child.value : null;
  }
  if (child.type === "JSXExpressionContainer") {
    const expr = (child as { expression?: AnyNode }).expression;
    if (expr && expr.type === "StringLiteral" && typeof expr.value === "string") {
      return expr.value;
    }
  }
  return null;
}

/**
 * Edit ONE static text run inside an element that also holds dynamic children,
 * by SPLICING the target JSXText node's exact source byte-range — never a
 * recast whole-element reprint. Reprinting a JSXElement whose child changed
 * both reflows the surrounding wrapper AND drops a leading space on a JSXText
 * that follows a {expression} (recast's JSX printer), silently corrupting the
 * value. A range splice preserves every other byte and keeps the replacement
 * text exactly as `buildTextChildNode` prints it in isolation.
 *
 * Returns the new source (unchanged reference if a no-op); the caller writes.
 * `oldText` is a hard drift guard; a post-splice re-parse asserts the segment
 * now holds exactly `newText` before anything is returned for writing.
 */
function applySetTextSegment(
  code: string,
  found: FoundElement,
  change: SetTextSegmentChange,
  element: SetTextSegmentChange["element"],
): string {
  if (found.opening.selfClosing) {
    throw new SkipChangeError("element is self-closing and has no text children to edit");
  }
  const children = (found.node.children ?? []) as AnyNode[];
  const idx = change.segmentIndex;
  const child = children[idx];
  if (!child) {
    throw new SkipChangeError(
      `no child at index ${String(idx)} on the element (it has ${String(children.length)}); ` +
        "source changed since the template was described — re-describe and retry",
    );
  }
  if (child.type !== "JSXText") {
    throw new SkipChangeError(
      `child at index ${String(idx)} is a ${child.type ?? "unknown node"}, not editable static text; ` +
        "refusing to touch dynamic content",
    );
  }
  const rawValue = (child as { value?: unknown }).value;
  if (typeof rawValue !== "string" || rawValue !== change.oldText) {
    throw new SkipChangeError(
      `static segment at index ${String(idx)} no longer matches the expected text; ` +
        "refusing to write (source drift)",
    );
  }
  const start = (child as { start?: unknown }).start;
  const end = (child as { end?: unknown }).end;
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end < start) {
    throw new SkipChangeError("source position of the target segment is unavailable; refusing to splice");
  }

  // The target child is raw JSXText (asserted above). Choose the replacement
  // representation by what the new text needs:
  //   * contains <, {, or } — cannot live as raw JSX text (they open a tag or
  //     an expression); must become a {"..."} string-literal container via
  //     buildTextChildNode, the only faithful representation. Its isolated
  //     print is the exact string to splice (a leading space survives an
  //     isolated print — only a whole-element reprint drops it).
  //   * otherwise — splice RAW. A raw JSXText run is whitespace-trimmed by JSX
  //     at render ("\n      Hi " -> "Hi "); wrapping it in {"\n      Hi "} would
  //     render the indentation LITERALLY *and* demote the static run to a
  //     dynamic hole (classifyChild reads a container as dynamic), so an
  //     indented multi-line run would become uneditable and round-trip a
  //     different value on the next capture. Raw is safe here because a range
  //     splice reprints nothing — the recast-reindent hazard that forces
  //     buildTextChildNode to escape newlines/tabs only applies to the
  //     whole-element set-text REPRINT path, never this byte splice.
  const needsContainer = /[<{}]/.test(change.newText);
  const replacement = needsContainer
    ? recast.print(buildTextChildNode(change.newText) as recast.types.ASTNode).code
    : change.newText;

  const newSource = code.slice(0, start) + replacement + code.slice(end);
  if (newSource === code) return code; // exact no-op (newText identical to old raw)

  // Post-splice verification: re-parse, re-locate the element, and assert the
  // target child now holds EXACTLY newText — a splice must never corrupt the
  // value or the structure. Any failure => refuse (caller leaves file untouched).
  let verifyAst: ReturnType<typeof recast.parse>;
  try {
    verifyAst = recast.parse(newSource, { parser: recastBabelParser });
  } catch (err) {
    throw new SkipChangeError(
      `refusing to write: edited JSX failed to re-parse (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }
  const reFound = locateElement(collectJsxElements(verifyAst), element.dataSourceLine);
  const reChild = (reFound?.node.children ?? [])[idx] as AnyNode | undefined;
  if (!reChild || extractChildText(reChild) !== change.newText) {
    throw new SkipChangeError(
      "refusing to write: post-edit verification did not find the expected text at the target segment",
    );
  }
  return newSource;
}

// ---------------------------------------------------------------------------
// Describe: enumerate an element's source children (read-only)
// ---------------------------------------------------------------------------

/** JSX tag name as source text (identifier, member, or namespaced). */
function jsxTagName(node: AnyNode): string {
  const name = (node as { openingElement?: { name?: AnyNode } }).openingElement?.name;
  if (!name) return "element";
  try {
    return recast.print(name as recast.types.ASTNode).code;
  } catch {
    return "element";
  }
}

function classifyChild(child: AnyNode, index: number): TemplatePart {
  const type = child.type;
  if (type === "JSXText") {
    const value = typeof child.value === "string" ? child.value : "";
    return { kind: "static", index, text: value, whitespaceOnly: value.trim().length === 0 };
  }
  if (type === "JSXElement") {
    return { kind: "element", index, tag: jsxTagName(child) };
  }
  if (type === "JSXFragment") {
    return { kind: "element", index, tag: "React.Fragment" };
  }
  // JSXExpressionContainer / JSXSpreadChild / anything else -> dynamic hole.
  const expr = (child as { expression?: AnyNode }).expression;
  let text = "";
  if (expr && expr.type !== "JSXEmptyExpression") {
    try {
      text = recast.print(expr as recast.types.ASTNode).code.trim();
    } catch {
      text = "";
    }
  }
  return { kind: "dynamic", index, expr: text };
}

export interface JsxTemplateDescription {
  /** Absolute jailed path of the located source file. */
  file: string;
  line: number;
  tag: string;
  parts: TemplatePart[];
  editable: boolean;
}

/**
 * Parse the instrumented source file, locate the element at its `__srcLoc`
 * source line, and enumerate its children into ordered static/dynamic/element parts.
 * Read-only — never writes. Throws SkipChangeError (unlocatable/unparseable) or
 * WorkspaceError (path escapes the jail).
 */
export function describeJsxTemplate(
  workspaceRoot: string,
  element: RequiredElementContext,
): JsxTemplateDescription {
  const abs = jailResolve(workspaceRoot, element.dataSourceFile);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new SkipChangeError(`instrumented source file not found: ${element.dataSourceFile}`);
  }
  const code = fs.readFileSync(abs, "utf8");
  let ast: ReturnType<typeof recast.parse>;
  try {
    ast = recast.parse(code, { parser: recastBabelParser });
  } catch (err) {
    throw new SkipChangeError(
      `JSX source failed to parse: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
  const found = locateElement(collectJsxElements(ast), element.dataSourceLine);
  if (!found) {
    throw new SkipChangeError(
      `no JSX element found at ${element.dataSourceFile}:${String(element.dataSourceLine)}`,
    );
  }
  const children = (found.node.children ?? []) as AnyNode[];
  const parts = children.map((c, i) => classifyChild(c, i));
  return {
    file: abs,
    line: element.dataSourceLine,
    tag: jsxTagName(found.node),
    parts,
    editable: parts.some((p) => p.kind === "static" && !p.whitespaceOnly),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface JsxApplyResult {
  /** Absolute jailed path of the edited file. */
  file: string;
  /** Current on-disk source (before the edit). */
  before: string;
  /** Computed new source (equals `before` when the change is a no-op). */
  after: string;
  line?: number | undefined;
  note?: string | undefined;
}

/**
 * Compute a set-attr / remove-attr / set-text change against JSX source WITHOUT
 * writing. Located via element.dataSourceFile (jailed) + element.dataSourceLine.
 * Parses with @babel/parser via recast so untouched formatting is preserved
 * byte-for-byte; only the located node is replaced/mutated. Returns the located
 * file's current (`before`) and computed (`after`) source so the caller decides
 * whether to preview the diff or commit the write — nothing is persisted here.
 */
export function applyJsxChange(workspaceRoot: string, change: JsxChange): JsxApplyResult {
  const element = change.element;
  const abs = jailResolve(workspaceRoot, element.dataSourceFile);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new SkipChangeError(`instrumented source file not found: ${element.dataSourceFile}`);
  }

  const code = fs.readFileSync(abs, "utf8");
  let ast: ReturnType<typeof recast.parse>;
  try {
    ast = recast.parse(code, { parser: recastBabelParser });
  } catch (err) {
    throw new SkipChangeError(
      `JSX source failed to parse: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  const elements = collectJsxElements(ast);
  const found = locateElement(elements, element.dataSourceLine);
  if (!found) {
    throw new SkipChangeError(`no JSX element found at ${element.dataSourceFile}:${String(element.dataSourceLine)}`);
  }

  // set-text-segment edits via a surgical source-range splice (NOT a recast
  // reprint) to preserve every other byte and the exact replacement value.
  if (change.op === "set-text-segment") {
    const newSource = applySetTextSegment(code, found, change, element);
    return { file: abs, before: code, after: newSource, line: element.dataSourceLine };
  }

  switch (change.op) {
    case "set-attr":
      applySetAttr(found, change);
      break;
    case "remove-attr":
      applyRemoveAttr(found, change);
      break;
    case "set-text":
      applySetText(found, change);
      break;
  }

  const printed = recast.print(ast).code;
  if (printed === code) {
    return { file: abs, before: code, after: code, line: element.dataSourceLine };
  }
  // CORE INVARIANT #1: never persist source that does not re-parse. This is
  // the universal safety net behind the targeted fixes above (unsafe
  // attribute values/text, invalid attribute names) — if anything still
  // slips through, refuse the write instead of corrupting the file. Enforced
  // here (before returning `after`) so a preview never shows, nor a commit
  // ever writes, source that would not parse.
  //
  // CORE INVARIANT #2 (value fidelity) is enforced earlier and more
  // precisely, at the point each replacement node is built —
  // buildAttrValueNode/buildTextChildNode each assert their own node
  // round-trips to the exact requested value (see their doc comments) —
  // rather than here, because relocating the edited node by line number in
  // this fully-reprinted document is not reliable: recast can reflow
  // unrelated surrounding source on any edit, shifting line numbers out
  // from under a location-based re-check.
  try {
    recastBabelParser.parse(printed);
  } catch (err) {
    throw new SkipChangeError(
      `refusing to write: edited JSX failed to re-parse (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }
  return { file: abs, before: code, after: printed, line: element.dataSourceLine };
}
