import type {
  AddDeclChange,
  DeleteDeclChange,
  ModifyChange,
} from "@dev-sync/contract";
import { SkipChangeError } from "./errors.js";
import { escapeRegExp, lineOfOffset } from "./util.js";
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
import {
  applyCssInJsObjectChange,
  hasStyleObject,
  listStyleObjects,
} from "./cssinjs-object.js";

type CssInJsChange = ModifyChange | AddDeclChange | DeleteDeclChange;

interface TemplateTarget {
  node: AnyNode;
  quasis: AnyNode[];
  /** The template literal's `${...}` interpolation expressions — used to detect an injected interpolation post-edit. */
  expressions: AnyNode[];
}

function isStyleTag(tag: AnyNode): boolean {
  const root = rootIdentifier(tag);
  return root !== null && STYLE_TAG_ROOTS.has(root);
}

function findTemplates(code: string): TemplateTarget[] {
  const ast = parseModule(code);
  const templates: TemplateTarget[] = [];
  walk(ast.program, (n) => {
    if (n.type !== "TaggedTemplateExpression") return;
    if (!isStyleTag(n["tag"] as AnyNode)) return;
    const quasi = n["quasi"] as AnyNode | undefined;
    const quasis = (quasi?.["quasis"] as AnyNode[] | undefined) ?? [];
    const expressions = (quasi?.["expressions"] as AnyNode[] | undefined) ?? [];
    if (quasis.length > 0) templates.push({ node: n, quasis, expressions });
  });
  return templates;
}

/**
 * Re-parse `code`, re-locate the template at the same index it held in the
 * ORIGINAL `templates` array (edits here only ever change text WITHIN one
 * template, never add/remove/reorder sibling templates, so positional index
 * is a stable identity), and re-extract EVERY value the property has
 * anywhere in the template (a global scan, not just the first match — a
 * property can legitimately appear more than once, e.g. a base value plus a
 * later override that wins the cascade). Used post-splice to verify (2) no
 * structural injection (interpolation count) and (1) value fidelity (the
 * edited declaration's value is actually present, or — for delete-decl —
 * the property is no longer present at all).
 */
function relocateTemplate(
  code: string,
  templateIndex: number,
  property: string,
): { template: TemplateTarget; values: string[] } {
  const templates = findTemplates(code);
  const template = templates[templateIndex];
  if (!template) {
    throw new SkipChangeError(
      "refusing to write: css-in-js template could not be relocated after edit (possible structural corruption)",
    );
  }
  const propReSource = `(^|[\\s;{])(${escapeRegExp(property)})(\\s*:\\s*)([^;\\n}]+)`;
  const values: string[] = [];
  for (const quasi of template.quasis) {
    if (typeof quasi.start !== "number" || typeof quasi.end !== "number") continue;
    const text = code.slice(quasi.start, quasi.end);
    const re = new RegExp(propReSource, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      values.push((m[4] ?? "").trim());
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width matches looping forever
    }
  }
  return { template, values };
}

export interface CssInJsEditResult {
  code: string;
  line?: number | undefined;
  note?: string | undefined;
}

/** One styled/css tagged-template in a source file, for external targeting. */
export interface TemplateInfo {
  /** Positional index (stable identity used by applyCssInJsChange's relocate). */
  index: number;
  /** 1-based line where the tagged template expression begins. */
  startLine: number;
  /** 1-based line where it ends. */
  endLine: number;
  /** Raw source text of the template body (all quasis, interpolations elided). */
  text: string;
}

/**
 * Enumerate every emotion/styled-components tagged template in `code`, with its
 * line range and body text. Used by the css-in-js targeting layer to pick WHICH
 * template a sheet-level edit belongs to when the sheet has no usable sourcemap
 * line (multiple templates per file) — see apps/server/src/cssinjs-target.ts.
 */
export function listTemplates(code: string): TemplateInfo[] {
  const templates = findTemplates(code).map((t, index) => {
    const startLine = t.node.loc?.start.line ?? 0;
    const endLine = t.node.loc?.end.line ?? startLine;
    const first = t.quasis[0];
    const last = t.quasis[t.quasis.length - 1];
    const text =
      typeof first?.start === "number" && typeof last?.end === "number"
        ? code.slice(first.start, last.end)
        : "";
    return { index, startLine, endLine, text };
  });
  // Union object-syntax style blocks (`css({...})`, `styled.div({...})`) so the
  // targeting layer can pick among them exactly like tagged templates. Indices
  // continue past the templates' — external callers use startLine/text, not the
  // index (relocation re-derives its own index list per writer).
  const objects = listStyleObjects(code).map((o, i) => ({
    ...o,
    index: templates.length + i,
  }));
  return [...templates, ...objects];
}

/**
 * Edit a declaration inside an emotion/styled-components template literal.
 * The template is LOCATED via the sourcemap-mapped line; edits are applied by
 * byte-offset splicing inside individual quasis, so every character outside
 * the edited declaration is preserved exactly (interpolations untouched).
 *
 * CORE INVARIANT #1 (re-parses): assertReparses is the universal safety net
 * behind every return path below.
 *
 * CORE INVARIANT #3 (injection pre-reject): modify/add-decl pre-reject a
 * newValue containing a backtick, `${`, or an unescaped `;`/`}` — see
 * assertCssInJsValueSafe's doc comment for why a JS-level reparse alone
 * cannot catch either hazard (backtick/`${` are template-literal syntax
 * that would run as live JS; a bare `}`/`;` is inert to the JS parser but
 * breaks the CSS structure emotion/styled-components parses this text as
 * at runtime).
 *
 * CORE INVARIANT #2 (no structural injection) + #1 (value fidelity, cont'd):
 * every op relocates the template post-splice (by its stable positional
 * index — edits here only ever change text WITHIN one template, never
 * add/remove/reorder sibling templates) and asserts its interpolation count
 * is unchanged, and (for modify/add-decl) that the edited declaration reads
 * back byte-for-byte the value that was requested — the same "produce,
 * re-extract with the SAME reader, compare" mechanism used by every other
 * writer in this package (see ./fidelity.js).
 */
export function applyCssInJsChange(
  code: string,
  mappedLine: number | null,
  change: CssInJsChange,
): CssInJsEditResult {
  const templates = findTemplates(code);

  let target: TemplateTarget | undefined;
  if (mappedLine !== null) {
    target = templates.find(
      (t) =>
        t.node.loc != null &&
        t.node.loc.start.line <= mappedLine &&
        mappedLine <= t.node.loc.end.line,
    );
  }
  if (!target && templates.length === 1) target = templates[0];
  if (!target) {
    // No tagged-template target. Emotion/styled-components also accept OBJECT
    // styles (`css({...})`, `styled.div({...})`), which emit the same runtime
    // sheets and route here identically — delegate to the object-syntax writer
    // when the file actually has a style object. Otherwise preserve the
    // template-path diagnostics verbatim (callers/tests key off these strings).
    if (hasStyleObject(code)) {
      return applyCssInJsObjectChange(code, mappedLine, change);
    }
    if (templates.length === 0) {
      throw new SkipChangeError("no css/styled template literal found in the mapped source file");
    }
    throw new SkipChangeError(
      "could not locate the css-in-js template for this change (ambiguous file, no line match)",
    );
  }
  const targetIndex = templates.indexOf(target);
  const interpolationCountBefore = target.expressions.length;

  const property = change.property.trim();
  const propRe = new RegExp(
    `(^|[\\s;{])(${escapeRegExp(property)})(\\s*:\\s*)([^;\\n}]+)`,
    "i",
  );

  if (change.op === "modify" || change.op === "delete-decl") {
    interface Match {
      quasi: AnyNode;
      m: RegExpExecArray;
      text: string;
    }
    const matches: Match[] = [];
    for (const quasi of target.quasis) {
      if (typeof quasi.start !== "number" || typeof quasi.end !== "number") continue;
      const text = code.slice(quasi.start, quasi.end);
      const m = propRe.exec(text);
      if (m) matches.push({ quasi, m, text });
    }
    if (matches.length === 0) {
      throw new SkipChangeError(
        `declaration "${property}" not found in the css-in-js template`,
      );
    }
    const preferred =
      change.op === "modify"
        ? matches.find((x) => (x.m[4] ?? "").trim() === change.oldValue.trim()) ?? matches[0]!
        : matches[0]!;

    const { quasi, m, text } = preferred;
    const qStart = quasi.start as number;
    const valueStart = m.index + (m[1]?.length ?? 0) + (m[2]?.length ?? 0) + (m[3]?.length ?? 0);
    const valueEnd = valueStart + (m[4]?.length ?? 0);

    if (change.op === "modify") {
      assertCssInJsValueSafe(change.newValue);
      const expectedValue = change.newValue.trim();
      const absStart = qStart + valueStart;
      const absEnd = qStart + valueEnd;
      const newCode = code.slice(0, absStart) + expectedValue + code.slice(absEnd);
      assertReparses(newCode);
      const relocated = relocateTemplate(newCode, targetIndex, property);
      assertStructuralCountUnchanged({
        label: "css-in-js template interpolation",
        before: interpolationCountBefore,
        after: relocated.template.expressions.length,
        expectedDelta: 0,
      });
      assertValuePresent(`css-in-js declaration "${property}"`, relocated.values, expectedValue);
      return { code: newCode, line: lineOfOffset(code, absStart) };
    }

    // delete-decl: remove the whole declaration (widen to the full line when
    // the declaration is alone on it).
    const declStart = m.index + (m[1]?.length ?? 0);
    let localEnd = valueEnd;
    if (text[localEnd] === ";") localEnd++;
    const lineStart = text.lastIndexOf("\n", declStart - 1) + 1;
    const beforeDecl = text.slice(lineStart, declStart);
    let removeStart = declStart;
    let removeEnd = localEnd;
    if (/^\s*$/.test(beforeDecl)) {
      removeStart = lineStart;
      if (text[removeEnd] === "\n") removeEnd++;
    }
    const newCode = code.slice(0, qStart + removeStart) + code.slice(qStart + removeEnd);
    assertReparses(newCode);
    const relocated = relocateTemplate(newCode, targetIndex, property);
    assertStructuralCountUnchanged({
      label: "css-in-js template interpolation",
      before: interpolationCountBefore,
      after: relocated.template.expressions.length,
      expectedDelta: 0,
    });
    assertAbsent(`css-in-js declaration "${property}"`, relocated.values);
    return { code: newCode, line: lineOfOffset(code, qStart + removeStart) };
  }

  // add-decl: append before the closing backtick of the template.
  assertCssInJsValueSafe(change.newValue);
  const expectedValue = change.newValue.trim();
  const lastQuasi = target.quasis[target.quasis.length - 1];
  if (!lastQuasi || typeof lastQuasi.start !== "number" || typeof lastQuasi.end !== "number") {
    throw new SkipChangeError("css-in-js template has no editable tail segment");
  }
  const qStart = lastQuasi.start;
  const text = code.slice(qStart, lastQuasi.end);

  // Match the template's existing indentation, defaulting to two spaces.
  let indent = "  ";
  for (const quasi of target.quasis) {
    if (typeof quasi.start !== "number" || typeof quasi.end !== "number") continue;
    const im = /\n([ \t]+)\S/.exec(code.slice(quasi.start, quasi.end));
    if (im?.[1]) {
      indent = im[1];
      break;
    }
  }

  const insertLocal = text.replace(/\s*$/, "").length;
  const trailing = text.slice(insertLocal);
  const insertion = `\n${indent}${property}: ${expectedValue};${trailing.includes("\n") ? "" : "\n"}`;
  const absInsert = qStart + insertLocal;
  const newCode = code.slice(0, absInsert) + insertion + code.slice(absInsert);
  assertReparses(newCode);
  const relocated = relocateTemplate(newCode, targetIndex, property);
  assertStructuralCountUnchanged({
    label: "css-in-js template interpolation",
    before: interpolationCountBefore,
    after: relocated.template.expressions.length,
    expectedDelta: 0,
  });
  assertValuePresent(`css-in-js declaration "${property}"`, relocated.values, expectedValue);
  return { code: newCode, line: lineOfOffset(code, absInsert) + 1 };
}
