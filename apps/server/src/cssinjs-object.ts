import type { AddDeclChange, DeleteDeclChange, ModifyChange } from "@dev-sync/contract";
import { SkipChangeError } from "./errors.js";
import { lineOfOffset } from "./util.js";
import {
  assertAbsent,
  assertCssInJsValueSafe,
  assertStructuralCountUnchanged,
  assertValuePresent,
} from "./fidelity.js";
import {
  assertReparses,
  parseModule,
  rootIdentifier,
  STYLE_TAG_ROOTS,
  walk,
  type AnyNode,
} from "./cssinjs-ast.js";
import type { CssInJsEditResult, TemplateInfo } from "./cssinjs.js";

/**
 * apps/server/src/cssinjs-object.ts — the OBJECT-SYNTAX css-in-js writer.
 *
 * Emotion (`css({...})`, `styled.div({...})`) and styled-components v6
 * (`styled('button', {...})`) accept STYLE OBJECTS as an alternative to tagged
 * templates. Those object forms produce the SAME runtime <style data-emotion> /
 * <style data-styled> sheets, so a DevTools edit routes to applyCssInJsChange
 * exactly like the template form — but the template writer has no template body
 * to splice. cssinjs.ts delegates here whenever the mapped file has no matching
 * tagged template but DOES contain a style object.
 *
 * Same fail-closed contract as the template writer: every edit is a byte-offset
 * splice validated by a strict re-parse + the shared fidelity guards
 * (structural-count, value round-trip, injection pre-reject). Anything
 * ambiguous, unrecognised, or unsafe throws SkipChangeError — never a guess,
 * never a partial write.
 *
 * WRITE-PATH SIMPLIFICATION: object-syntax values are always emitted as a
 * QUOTED STRING (`fontSize: "20px"`), never a bare number. A quoted full CSS
 * value string is valid for EVERY property in every object-syntax lib, so the
 * writer never needs the emotion/React unitless-property list nor px-appending
 * (those only matter when emitting bare numbers, which this writer never does).
 */

type CssInJsChange = ModifyChange | AddDeclChange | DeleteDeclChange;

/**
 * Convert a CSS property (`background-color`, `-webkit-box-shadow`,
 * `-ms-flex-align`) to its object-syntax camelCase key. Vendor prefixes follow
 * the CSSOM/React convention: `-webkit-`/`-moz-`/`-o-` capitalize
 * (`WebkitBoxShadow`, `MozAppearance`), but `-ms-` stays lowercase
 * (`msFlexAlign`) — the one prefix that is not title-cased.
 */
export function kebabToCamel(property: string): string {
  const segments = property.trim().split("-");
  if (segments[0] === "") {
    // Leading dash => vendor-prefixed: ["", vendor, ...rest].
    const vendor = segments[1] ?? "";
    const prefix = vendor === "ms" ? "ms" : vendor.charAt(0).toUpperCase() + vendor.slice(1);
    return prefix + segments.slice(2).map(capitalize).join("");
  }
  return segments.map((s, i) => (i === 0 ? s : capitalize(s))).join("");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** True when a CSS property matches an object property key (camelCase OR the raw kebab string key). */
function keyMatchesProperty(key: string, property: string): boolean {
  const prop = property.trim();
  return key === kebabToCamel(prop) || key === prop;
}

/**
 * The literal key name of an ObjectProperty, whether an Identifier or a
 * string-literal key. Returns null for a COMPUTED key (`[expr]: v`) — its name
 * is only known at runtime, so it must never match a CSS property.
 */
function propertyKeyName(prop: AnyNode): string | null {
  if (prop["computed"] === true) return null;
  const key = prop["key"] as AnyNode | undefined;
  if (!key) return null;
  if (key.type === "Identifier") return typeof key["name"] === "string" ? (key["name"] as string) : null;
  if (key.type === "StringLiteral") return typeof key["value"] === "string" ? (key["value"] as string) : null;
  return null;
}

/**
 * Only a plain string- or number-literal value can be safely replaced with a
 * quoted string. A template literal, a member/identifier/call expression, etc.
 * is a DYNAMIC binding (`` `${x}px` ``, `theme.primary`); overwriting it with a
 * literal string would drop the interpolation/binding — the same corruption the
 * tagged-template writer's interpolation-count invariant refuses. Fail closed.
 */
function isReplaceableValue(node: AnyNode | undefined): boolean {
  return node?.type === "StringLiteral" || node?.type === "NumericLiteral";
}

/** ObjectProperties that are actual declarations (scalar value, not a nested selector/media object). */
function declarationProperties(obj: AnyNode): AnyNode[] {
  const props = (obj["properties"] as AnyNode[] | undefined) ?? [];
  return props.filter(
    (p) => p.type === "ObjectProperty" && (p["value"] as AnyNode | undefined)?.type !== "ObjectExpression",
  );
}

/** Every ObjectExpression argument of a css-in-js style-tag call — the "root" style objects in `code`. */
function findStyleObjectRoots(ast: ReturnType<typeof parseModule>): AnyNode[] {
  const roots: AnyNode[] = [];
  walk(ast.program, (n) => {
    if (n.type !== "CallExpression") return;
    if (!STYLE_TAG_ROOTS.has(rootIdentifier(n["callee"] as AnyNode) ?? "")) return;
    for (const arg of (n["arguments"] as AnyNode[] | undefined) ?? []) {
      if (arg.type === "ObjectExpression") roots.push(arg);
    }
  });
  return roots;
}

function spanContainsLine(node: AnyNode, line: number): boolean {
  return node.loc != null && node.loc.start.line <= line && line <= node.loc.end.line;
}

function spanSize(node: AnyNode): number {
  if (typeof node.start !== "number" || typeof node.end !== "number") return Number.MAX_SAFE_INTEGER;
  return node.end - node.start;
}

/**
 * Descend from a root style object to the INNERMOST ObjectExpression whose span
 * contains `line` — so an edit whose mapped line lands inside a nested
 * `&:hover` / `@media` block targets that block, not the outer one. Falls back
 * to the root object itself.
 */
function innermostObjectAtLine(root: AnyNode, line: number | null): AnyNode {
  if (line === null) return root;
  let best = root;
  walk(root, (n) => {
    if (n.type === "ObjectExpression" && spanContainsLine(n, line) && spanSize(n) < spanSize(best)) {
      best = n;
    }
  });
  return best;
}

/**
 * Enumerate every style object in `code` as a TemplateInfo, so the css-in-js
 * targeting layer (cssinjs-target.ts) can pick among object blocks the same way
 * it picks among tagged templates when a file has several and no sourcemap line.
 */
export function listStyleObjects(code: string): TemplateInfo[] {
  const ast = parseModule(code);
  const roots = findStyleObjectRoots(ast);
  return roots.map((obj, index) => {
    const startLine = obj.loc?.start.line ?? 0;
    const endLine = obj.loc?.end.line ?? startLine;
    const text =
      typeof obj.start === "number" && typeof obj.end === "number" ? code.slice(obj.start, obj.end) : "";
    return { index, startLine, endLine, text };
  });
}

/** Cheap presence check used by cssinjs.ts to decide whether to delegate here. */
export function hasStyleObject(code: string): boolean {
  return findStyleObjectRoots(parseModule(code)).length > 0;
}

/**
 * css-in-js object values are emitted as a bare double/single-quoted JS string.
 * Reject anything that cannot be embedded as one: a `"`/`\`/control char breaks
 * the emitted literal, and (via assertCssInJsValueSafe) a backtick, `${`, or an
 * unescaped `;`/`{`/`}` would either run as live JS or inject extra CSS
 * declarations once the engine parses the string as a value at runtime.
 */
function assertObjectValueSafe(value: string): void {
  assertCssInJsValueSafe(value);
  if (/["\\\x00-\x1f]/.test(value)) {
    throw new SkipChangeError(
      `refusing to write: value contains a quote, backslash, or control character that cannot be safely embedded in an object-syntax string value: "${value}"`,
    );
  }
}

/** The quote char to reuse for a replacement — the existing string value's quote, else double. */
function quoteCharOf(valueNode: AnyNode | undefined, code: string): '"' | "'" {
  if (valueNode?.type === "StringLiteral" && typeof valueNode.start === "number") {
    const first = code[valueNode.start];
    if (first === "'" || first === '"') return first;
  }
  return '"';
}

interface Located {
  rootIndex: number;
  block: AnyNode;
  blockStartLine: number;
}

/** Locate the style object block (by mapped line, or the sole root) an edit targets. */
function locateBlock(code: string, mappedLine: number | null): Located {
  const roots = findStyleObjectRoots(parseModule(code));
  if (roots.length === 0) {
    throw new SkipChangeError("no css-in-js style object found in the mapped source file");
  }
  let root: AnyNode | undefined;
  let rootIndex = -1;
  if (mappedLine !== null) {
    // Innermost (smallest-span) root whose span contains the line.
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i]!;
      if (spanContainsLine(r, mappedLine) && (!root || spanSize(r) < spanSize(root))) {
        root = r;
        rootIndex = i;
      }
    }
  }
  if (!root && roots.length === 1) {
    root = roots[0];
    rootIndex = 0;
  }
  if (!root) {
    throw new SkipChangeError(
      "could not locate the css-in-js style object for this change (ambiguous file, no line match)",
    );
  }
  const block = innermostObjectAtLine(root, mappedLine);
  return { rootIndex, block, blockStartLine: block.loc?.start.line ?? (root.loc?.start.line ?? 0) };
}

/** Re-locate the same block after an edit (stable root index + block start line) and read it back. */
function relocateBlock(code: string, rootIndex: number, blockStartLine: number): AnyNode {
  const roots = findStyleObjectRoots(parseModule(code));
  const root = roots[rootIndex];
  if (!root) {
    throw new SkipChangeError(
      "refusing to write: css-in-js style object could not be relocated after edit (possible structural corruption)",
    );
  }
  return innermostObjectAtLine(root, blockStartLine);
}

/** Every declaration value (raw source text) in `block` whose key matches `property`. */
function matchingValues(block: AnyNode, code: string, property: string): string[] {
  const out: string[] = [];
  for (const p of declarationProperties(block)) {
    const key = propertyKeyName(p);
    if (key === null || !keyMatchesProperty(key, property)) continue;
    const v = p["value"] as AnyNode | undefined;
    if (v && typeof v.start === "number" && typeof v.end === "number") out.push(code.slice(v.start, v.end));
  }
  return out;
}

/**
 * Edit a declaration inside a css-in-js STYLE OBJECT. Mirrors
 * applyCssInJsChange's template path: locate the block, splice by byte offset,
 * then validate with a strict re-parse + the shared fidelity guards.
 */
export function applyCssInJsObjectChange(
  code: string,
  mappedLine: number | null,
  change: CssInJsChange,
): CssInJsEditResult {
  const { rootIndex, block, blockStartLine } = locateBlock(code, mappedLine);
  const property = change.property.trim();
  const declCountBefore = declarationProperties(block).length;

  if (change.op === "modify" || change.op === "delete-decl") {
    const props = declarationProperties(block);
    const matches = props.filter((p) => {
      const key = propertyKeyName(p);
      return key !== null && keyMatchesProperty(key, property);
    });
    if (matches.length === 0) {
      throw new SkipChangeError(`declaration "${property}" not found in the css-in-js style object`);
    }
    // Prefer the property whose current value matches oldValue (a property may
    // legitimately appear once; ties resolve to the first).
    const preferred =
      change.op === "modify"
        ? matches.find((p) => {
            const v = p["value"] as AnyNode | undefined;
            if (!v || typeof v.start !== "number" || typeof v.end !== "number") return false;
            const raw = code.slice(v.start, v.end);
            const unquoted = raw.replace(/^['"]|['"]$/g, "");
            return unquoted.trim() === change.oldValue.trim();
          }) ?? matches[0]!
        : matches[0]!;

    if (change.op === "modify") {
      assertObjectValueSafe(change.newValue);
      const valueNode = preferred["value"] as AnyNode;
      if (typeof valueNode.start !== "number" || typeof valueNode.end !== "number") {
        throw new SkipChangeError("css-in-js style declaration has no editable value span");
      }
      if (!isReplaceableValue(valueNode)) {
        throw new SkipChangeError(
          `refusing to write: css-in-js declaration "${property}" has a dynamic value (${valueNode.type ?? "expression"}); replacing it with a literal string would drop the binding or interpolation`,
        );
      }
      const q = quoteCharOf(valueNode, code);
      const quoted = `${q}${change.newValue.trim()}${q}`;
      const newCode = code.slice(0, valueNode.start) + quoted + code.slice(valueNode.end);
      assertReparses(newCode);
      const relocated = relocateBlock(newCode, rootIndex, blockStartLine);
      assertStructuralCountUnchanged({
        label: "css-in-js style object declaration",
        before: declCountBefore,
        after: declarationProperties(relocated).length,
        expectedDelta: 0,
      });
      assertValuePresent(
        `css-in-js declaration "${property}"`,
        matchingValues(relocated, newCode, property),
        quoted,
      );
      return { code: newCode, line: lineOfOffset(code, valueNode.start) };
    }

    // delete-decl: remove the whole property node plus its trailing comma and,
    // when it sits alone on its line, the surrounding indentation + newline.
    const start = preferred.start as number;
    let end = preferred.end as number;
    // Consume a trailing comma.
    while (end < code.length && /[ \t]/.test(code[end]!)) end++;
    if (code[end] === ",") end++;
    // If the declaration occupied its own line, drop the leading indentation and
    // the trailing newline so no blank line is left behind.
    const lineStart = code.lastIndexOf("\n", start - 1) + 1;
    let removeStart = start;
    let removeEnd = end;
    if (/^[ \t]*$/.test(code.slice(lineStart, start))) {
      removeStart = lineStart;
      if (code[removeEnd] === "\n") removeEnd++;
    }
    const newCode = code.slice(0, removeStart) + code.slice(removeEnd);
    assertReparses(newCode);
    const relocated = relocateBlock(newCode, rootIndex, blockStartLine);
    assertStructuralCountUnchanged({
      label: "css-in-js style object declaration",
      before: declCountBefore,
      after: declarationProperties(relocated).length,
      expectedDelta: -1,
    });
    assertAbsent(`css-in-js declaration "${property}"`, matchingValues(relocated, newCode, property));
    return { code: newCode, line: lineOfOffset(code, removeStart) };
  }

  // add-decl: insert `key: "value",` before the block's closing brace.
  assertObjectValueSafe(change.newValue);
  if (typeof block.start !== "number" || typeof block.end !== "number") {
    throw new SkipChangeError("css-in-js style object has no editable span");
  }
  const key = kebabToCamel(property);
  const quoted = `"${change.newValue.trim()}"`;
  // Match the indentation of an existing declaration, defaulting to two spaces
  // past the block's own opening-brace indent.
  const existing = declarationProperties(block)[0];
  let indent = "  ";
  if (existing && typeof existing.start === "number") {
    const ls = code.lastIndexOf("\n", existing.start - 1) + 1;
    const lead = code.slice(ls, existing.start);
    if (/^[ \t]+$/.test(lead)) indent = lead;
  }
  // Insert just before the closing `}` of the block.
  const closeBrace = block.end - 1; // block.end is one past `}`
  const beforeClose = code.slice(0, closeBrace).replace(/\s*$/, "");
  const insertAt = beforeClose.length;
  const needsComma = !/[,{]\s*$/.test(beforeClose); // add a separating comma unless the block is empty or already comma-terminated
  const insertion = `${needsComma ? "," : ""}\n${indent}${key}: ${quoted},\n`;
  const tailIndent = code.slice(code.lastIndexOf("\n", closeBrace - 1) + 1, closeBrace).match(/^[ \t]*/)?.[0] ?? "";
  const newCode = code.slice(0, insertAt) + insertion + tailIndent + code.slice(closeBrace);
  assertReparses(newCode);
  const relocated = relocateBlock(newCode, rootIndex, blockStartLine);
  assertStructuralCountUnchanged({
    label: "css-in-js style object declaration",
    before: declCountBefore,
    after: declarationProperties(relocated).length,
    expectedDelta: 1,
  });
  assertValuePresent(
    `css-in-js declaration "${property}"`,
    matchingValues(relocated, newCode, property),
    quoted,
  );
  return { code: newCode, line: lineOfOffset(code, insertAt) + 1 };
}
