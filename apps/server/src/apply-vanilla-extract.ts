import type { AddDeclChange, DeleteDeclChange, ModifyChange } from "@dev-sync/contract";
import { SkipChangeError } from "./errors.js";
import { assertCssInJsValueSafe, assertStructuralCountUnchanged } from "./fidelity.js";
import { assertReparses, parseModule, rootIdentifier, walk, type AnyNode } from "./cssinjs-ast.js";
import { kebabToCamel } from "./cssinjs-object.js";

/**
 * apps/server/src/apply-vanilla-extract.ts — the vanilla-extract (VE) apply
 * tier. VE is NOT on the sourcemap path: a `.css.ts` file's `style({...})`
 * call is served as a virtual `.vanilla.css` stylesheet with debug classes
 * shaped `<fileBasename>_<export>__<hash>` and no real sourcemap. resolve.ts
 * strips the served `.vanilla.css` id back to the real `.css.ts` path; this
 * module does the actual edit — a byte-offset splice of the `style({...})`
 * object literal, validated by a strict re-parse.
 *
 * v1 scope: only a plain `style({...})` single-object-literal call is
 * supported. `styleVariants`, `recipe`, array composition (`style([...])`),
 * and multi-arg composition (`style(base, {...})`) are refused with a named
 * reason rather than guessed at.
 *
 * Self-contained by design: reuses only pure/stateless helpers from
 * cssinjs-ast.js (parser/walker/reparse-guard) and cssinjs-object.js
 * (kebabToCamel) — never imports from cssinjs.ts (cycle risk) and never
 * touches STYLE_TAG_ROOTS (would regress the Emotion tier).
 */

export type CssChange = ModifyChange | AddDeclChange | DeleteDeclChange;

export interface ParsedVeClass {
  export: string;
  pseudo: string | null;
}

const CLASS_TOKEN_RE = /^\.([A-Za-z0-9_-]+)/;
const PSEUDO_SUFFIX_RE = /^(::?[A-Za-z-]+(?:\([^)]*\))?)/;

/**
 * From a served vanilla-extract selector (e.g. `.card_fancy__8mojj41:hover`),
 * isolate the primary class token and split it into the export id + hash. The
 * class shape is `<fileBasename>_<export>__<hash>` — a single `_` before the
 * export name, `__` before the hash — but the file basename itself may
 * legitimately contain `_`, so the export id is disambiguated by testing
 * candidate suffixes (splitting on each `_`, longest suffix first) against
 * `knownExports` until one matches.
 */
export function parseVeClass(selector: string, knownExports: string[]): ParsedVeClass {
  const trimmed = selector.trim();
  const classMatch = CLASS_TOKEN_RE.exec(trimmed);
  if (!classMatch) {
    throw new SkipChangeError(
      `vanilla-extract: served selector "${selector}" has no leading class token to resolve`,
    );
  }
  const token = classMatch[1]!;
  const rest = trimmed.slice(classMatch[0].length);
  const pseudoMatch = PSEUDO_SUFFIX_RE.exec(rest);
  const pseudo = pseudoMatch ? pseudoMatch[1]! : null;

  const hashIdx = token.lastIndexOf("__");
  if (hashIdx === -1) {
    throw new SkipChangeError(
      `vanilla-extract: class token "${token}" is not shaped "<file>_<export>__<hash>" (no "__" hash separator)`,
    );
  }
  const fileExportPart = token.slice(0, hashIdx);
  const parts = fileExportPart.split("_");
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join("_");
    if (knownExports.includes(candidate)) {
      return { export: candidate, pseudo };
    }
  }
  throw new SkipChangeError(
    `vanilla-extract: class token "${token}" does not match any known style() export (known: ${knownExports.join(", ") || "none"})`,
  );
}

export interface ApplyVanillaExtractOptions {
  /** Override the export list used by parseVeClass (else derived from `code`). */
  knownExports?: string[];
}

export interface ApplyVanillaExtractResult {
  css: string;
}

interface VeExportInfo {
  name: string;
  declarator: AnyNode;
  /** The declarator's init CallExpression, when it is one. */
  init: AnyNode | undefined;
  /** Root identifier of the init call's callee (e.g. "style", "styleVariants", "recipe"), or null. */
  apiName: string | null;
}

/** Every `export const <id> = <expr>` at the top level of the module. */
function collectExports(ast: ReturnType<typeof parseModule>): VeExportInfo[] {
  const out: VeExportInfo[] = [];
  walk(ast.program, (n) => {
    if (n.type !== "ExportNamedDeclaration") return;
    const decl = n["declaration"] as AnyNode | undefined;
    if (!decl || decl.type !== "VariableDeclaration") return;
    for (const d of (decl["declarations"] as AnyNode[] | undefined) ?? []) {
      if (d.type !== "VariableDeclarator") continue;
      const id = d["id"] as AnyNode | undefined;
      if (!id || id.type !== "Identifier" || typeof id["name"] !== "string") continue;
      const init = d["init"] as AnyNode | undefined;
      const apiName = init?.type === "CallExpression" ? rootIdentifier(init["callee"] as AnyNode) : null;
      out.push({ name: id["name"] as string, declarator: d, init, apiName });
    }
  });
  return out;
}

const VE_STYLE_APIS = new Set(["style", "styleVariants", "recipe"]);

/** The literal key name of an ObjectProperty (Identifier or string-literal key); null for a computed key. */
function propertyKeyName(prop: AnyNode): string | null {
  if (prop["computed"] === true) return null;
  const key = prop["key"] as AnyNode | undefined;
  if (!key) return null;
  if (key.type === "Identifier") return typeof key["name"] === "string" ? (key["name"] as string) : null;
  if (key.type === "StringLiteral") return typeof key["value"] === "string" ? (key["value"] as string) : null;
  return null;
}

function objectProperties(obj: AnyNode): AnyNode[] {
  return ((obj["properties"] as AnyNode[] | undefined) ?? []).filter((p) => p.type === "ObjectProperty");
}

/** Find a direct ObjectProperty of `obj` whose key string equals `wantedKey` exactly. */
function findProperty(obj: AnyNode, wantedKey: string): AnyNode | undefined {
  return objectProperties(obj).find((p) => propertyKeyName(p) === wantedKey);
}

/** Declaration properties: direct ObjectProperties whose value is NOT itself a nested object (selectors/@media). */
function declarationProperties(obj: AnyNode): AnyNode[] {
  return objectProperties(obj).filter((p) => (p["value"] as AnyNode | undefined)?.type !== "ObjectExpression");
}

function keyMatchesProperty(key: string, property: string): boolean {
  const prop = property.trim();
  return key === kebabToCamel(prop) || key === prop;
}

function isReplaceableValue(node: AnyNode | undefined): boolean {
  return node?.type === "StringLiteral" || node?.type === "NumericLiteral";
}

/**
 * Values are always emitted as a quoted JS string (`padding: "40px"`), so the
 * safety guard mirrors cssinjs-object.ts's assertObjectValueSafe: reject a
 * `${`/backtick or unescaped `;`/`{`/`}` (assertCssInJsValueSafe), plus a raw
 * quote/backslash/control char that cannot be safely embedded in the string.
 */
function assertVeValueSafe(value: string): void {
  assertCssInJsValueSafe(value);
  if (/["\\\x00-\x1f]/.test(value)) {
    throw new SkipChangeError(
      `refusing to write: value contains a quote, backslash, or control character that cannot be safely embedded in a vanilla-extract object value: "${value}"`,
    );
  }
}

/** A legitimate CSS property name — standard (`background-color`) or custom (`--foo`). */
const CSS_PROPERTY_RE = /^(--[A-Za-z0-9-]+|[A-Za-z][A-Za-z0-9-]*)$/;

/**
 * `change.property` is client-supplied (it arrives in the CapturePayload) and,
 * for `add-decl`, is emitted DIRECTLY as an object key. Without this guard a
 * crafted property could close the `style({...})` literal early and splice
 * arbitrary JS statements into the `.css.ts` — which vanilla-extract's plugin
 * then EVALUATES at build time (RCE on the dev machine). `assertReparses` does
 * not catch it (the injected source is still syntactically valid JS). So
 * validate the property is a bare CSS property name before it is ever used as
 * a key, exactly as the value is validated before being emitted.
 */
function assertVePropertySafe(property: string): void {
  if (!CSS_PROPERTY_RE.test(property)) {
    throw new SkipChangeError(
      `refusing to write: "${property}" is not a valid CSS property name`,
    );
  }
}

/** Emit an object key for a validated CSS property: a bare identifier when the
 * camelCased form is a legal JS identifier, else a quoted string key (custom
 * properties like `--foo` are not identifiers). */
function objectKeyFor(camelKey: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(camelKey) ? camelKey : JSON.stringify(camelKey);
}

function quoteCharOf(valueNode: AnyNode | undefined, code: string): '"' | "'" {
  if (valueNode?.type === "StringLiteral" && typeof valueNode.start === "number") {
    const first = code[valueNode.start];
    if (first === "'" || first === '"') return first;
  }
  return '"';
}

/**
 * Resolve the served change to the exact ObjectExpression its declaration lives
 * in: locate `export const <export> = style({...})`, then descend into
 * `"@media"[<query>]` and/or `selectors["&<pseudo>"]` when the change targets a
 * nested rule. Throws SkipChangeError for every unsupported/absent path. Shared
 * by the writer and the post-add structural check so both navigate identically.
 */
function resolveVeTargetObject(
  code: string,
  change: CssChange,
  opts: ApplyVanillaExtractOptions,
): { target: AnyNode; exportName: string } {
  const ast = parseModule(code);
  const exportsList = collectExports(ast);
  const veStyleExportNames = exportsList
    .filter((e) => e.apiName !== null && VE_STYLE_APIS.has(e.apiName))
    .map((e) => e.name);
  const knownExports = opts.knownExports ?? veStyleExportNames;

  const parsed = parseVeClass(change.selector, knownExports);

  const info = exportsList.find((e) => e.name === parsed.export);
  if (!info) {
    throw new SkipChangeError(
      `vanilla-extract: export "${parsed.export}" (resolved from selector "${change.selector}") not found in source`,
    );
  }
  if (info.apiName !== "style") {
    throw new SkipChangeError(
      `vanilla-extract: export "${parsed.export}" is defined via ${
        info.apiName ? `${info.apiName}(...)` : "a non-style() expression"
      }, not a plain style({...}) call — unsupported in v1 (styleVariants/recipe are out of scope)`,
    );
  }
  const initArgs = (info.init!["arguments"] as AnyNode[] | undefined) ?? [];
  if (initArgs.length !== 1 || initArgs[0]!.type !== "ObjectExpression") {
    const reason =
      initArgs.length !== 1
        ? `style() called with ${String(initArgs.length)} arguments (composition, e.g. style(base, {...}))`
        : "style()'s argument is not a plain object literal (e.g. array composition style([...]))";
    throw new SkipChangeError(
      `vanilla-extract: export "${parsed.export}" uses an unsupported style() form — ${reason} — unsupported in v1`,
    );
  }
  let target: AnyNode = initArgs[0]!;

  if (change.mediaText) {
    const mediaProp = findProperty(target, "@media");
    const mediaObj = mediaProp?.["value"] as AnyNode | undefined;
    if (!mediaProp || mediaObj?.type !== "ObjectExpression") {
      throw new SkipChangeError(
        `vanilla-extract: export "${parsed.export}" has no "@media" block, but the change targets media "${change.mediaText}"`,
      );
    }
    const queryProp = findProperty(mediaObj, change.mediaText);
    const queryObj = queryProp?.["value"] as AnyNode | undefined;
    if (!queryProp || queryObj?.type !== "ObjectExpression") {
      const available = objectProperties(mediaObj)
        .map((p) => propertyKeyName(p))
        .filter((k): k is string => k !== null);
      throw new SkipChangeError(
        `vanilla-extract: @media query "${change.mediaText}" not found in export "${parsed.export}" — available: ${
          available.join(", ") || "none"
        }`,
      );
    }
    target = queryObj;
  }

  if (parsed.pseudo) {
    const selectorsProp = findProperty(target, "selectors");
    const selectorsObj = selectorsProp?.["value"] as AnyNode | undefined;
    if (!selectorsProp || selectorsObj?.type !== "ObjectExpression") {
      throw new SkipChangeError(
        `vanilla-extract: export "${parsed.export}" has no "selectors" block, but the change targets pseudo "${parsed.pseudo}"`,
      );
    }
    const wantedKey = `&${parsed.pseudo}`;
    const pseudoProp = findProperty(selectorsObj, wantedKey);
    const pseudoObj = pseudoProp?.["value"] as AnyNode | undefined;
    if (!pseudoProp || pseudoObj?.type !== "ObjectExpression") {
      const available = objectProperties(selectorsObj)
        .map((p) => propertyKeyName(p))
        .filter((k): k is string => k !== null);
      throw new SkipChangeError(
        `vanilla-extract: selector "${wantedKey}" not found in export "${parsed.export}" — available: ${
          available.join(", ") || "none"
        }`,
      );
    }
    target = pseudoObj;
  }

  return { target, exportName: parsed.export };
}

/**
 * After an `add-decl` splice, re-navigate the edited source and assert the
 * target object gained EXACTLY one declaration. A balanced single-property
 * insert is the only acceptable outcome; any other delta means an escaped
 * key/value restructured the literal (defense-in-depth beyond the property/
 * value guards + assertReparses).
 */
function assertAddedExactlyOneDecl(
  code: string,
  change: CssChange,
  opts: ApplyVanillaExtractOptions,
  before: number,
): void {
  const { target } = resolveVeTargetObject(code, change, opts);
  assertStructuralCountUnchanged({
    label: "vanilla-extract declaration count after add-decl",
    before,
    after: declarationProperties(target).length,
    expectedDelta: 1,
  });
}

/**
 * Edit a declaration inside a vanilla-extract `style({...})` object (optionally
 * nested under `selectors["&<pseudo>"]` and/or `"@media"[<query>]`). Pure:
 * string in, string out; throws SkipChangeError for every "cannot apply"
 * condition (unsupported API, missing nesting, dynamic value, ...) rather than
 * guessing — never a partial or corrupting write.
 */
export function applyVanillaExtractChange(
  code: string,
  change: CssChange,
  opts: ApplyVanillaExtractOptions = {},
): ApplyVanillaExtractResult {
  const { target, exportName } = resolveVeTargetObject(code, change, opts);

  const property = change.property.trim();
  assertVePropertySafe(property);

  if (change.op === "modify" || change.op === "delete-decl") {
    const matches = declarationProperties(target).filter((p) => {
      const key = propertyKeyName(p);
      return key !== null && keyMatchesProperty(key, property);
    });
    if (matches.length === 0) {
      throw new SkipChangeError(
        `vanilla-extract: declaration "${property}" not found in export "${exportName}"`,
      );
    }
    const preferred =
      change.op === "modify"
        ? (matches.find((p) => {
            const v = p["value"] as AnyNode | undefined;
            if (!v || typeof v.start !== "number" || typeof v.end !== "number") return false;
            const raw = code.slice(v.start, v.end);
            const unquoted = raw.replace(/^['"]|['"]$/g, "");
            return unquoted.trim() === change.oldValue.trim();
          }) ?? matches[0]!)
        : matches[0]!;

    if (change.op === "modify") {
      assertVeValueSafe(change.newValue);
      const valueNode = preferred["value"] as AnyNode;
      if (typeof valueNode.start !== "number" || typeof valueNode.end !== "number") {
        throw new SkipChangeError("vanilla-extract: declaration has no editable value span");
      }
      if (!isReplaceableValue(valueNode)) {
        throw new SkipChangeError(
          `vanilla-extract: refusing to write: declaration "${property}" has a dynamic value (${
            valueNode.type ?? "expression"
          }); replacing it with a literal string would drop the binding/interpolation`,
        );
      }
      const q = quoteCharOf(valueNode, code);
      const quoted = `${q}${change.newValue.trim()}${q}`;
      const newCode = code.slice(0, valueNode.start) + quoted + code.slice(valueNode.end);
      assertReparses(newCode);
      return { css: newCode };
    }

    // delete-decl: remove the whole property node plus its trailing comma and,
    // when it sits alone on its line, the surrounding indentation + newline.
    const start = preferred.start as number;
    let end = preferred.end as number;
    while (end < code.length && /[ \t]/.test(code[end]!)) end++;
    if (code[end] === ",") end++;
    const lineStart = code.lastIndexOf("\n", start - 1) + 1;
    let removeStart = start;
    let removeEnd = end;
    if (/^[ \t]*$/.test(code.slice(lineStart, start))) {
      removeStart = lineStart;
      if (code[removeEnd] === "\n") removeEnd++;
    }
    const newCode = code.slice(0, removeStart) + code.slice(removeEnd);
    assertReparses(newCode);
    return { css: newCode };
  }

  // add-decl: insert `<camelKey>: "<value>",` before the target object's closing brace.
  assertVeValueSafe(change.newValue);
  if (typeof target.start !== "number" || typeof target.end !== "number") {
    throw new SkipChangeError("vanilla-extract: target object has no editable span");
  }
  // Custom properties (`--foo`) are never camelCased — kebabToCamel would
  // mangle them (vendor-prefix path). Emit them verbatim as a quoted key.
  const key = property.startsWith("--") ? JSON.stringify(property) : objectKeyFor(kebabToCamel(property));
  const quoted = `"${change.newValue.trim()}"`;
  const declsBefore = declarationProperties(target).length;
  const existing = declarationProperties(target)[0];
  let indent = "  ";
  if (existing && typeof existing.start === "number") {
    const ls = code.lastIndexOf("\n", existing.start - 1) + 1;
    const lead = code.slice(ls, existing.start);
    if (/^[ \t]+$/.test(lead)) indent = lead;
  }
  const closeBrace = target.end - 1; // target.end is one past `}`
  const beforeClose = code.slice(0, closeBrace).replace(/\s*$/, "");
  const insertAt = beforeClose.length;
  const needsComma = !/[,{]\s*$/.test(beforeClose);
  const insertion = `${needsComma ? "," : ""}\n${indent}${key}: ${quoted},\n`;
  const tailIndent = code.slice(code.lastIndexOf("\n", closeBrace - 1) + 1, closeBrace).match(/^[ \t]*/)?.[0] ?? "";
  const newCode = code.slice(0, insertAt) + insertion + tailIndent + code.slice(closeBrace);
  assertReparses(newCode);
  // Defense-in-depth: re-navigate the edited source and confirm the target
  // object gained EXACTLY one declaration (a balanced single-property insert),
  // never a structural change from an escaped key/value. Mirrors the
  // structural-count guard on cssinjs-object.ts's add-decl path.
  assertAddedExactlyOneDecl(newCode, change, opts, declsBefore);
  return { css: newCode };
}
