import fs from "node:fs";
import postcss from "postcss";
import type { Declaration, Root, Rule } from "postcss";
import type { InlineDeclaration, PromoteInlineStyleChange } from "@css-sync/contract";
import type { Config } from "./config.js";
import { SkipChangeError } from "./errors.js";
import { computeElementClassEdit } from "./classlist.js";
import { assertCssValueSafe, assertExactMatch, assertStructuralCountUnchanged } from "./fidelity.js";
import { jailResolve, toWorkspaceRelative } from "./workspace.js";

/**
 * apps/server/src/apply-inline-promote.ts — the "promote inline style" tier.
 *
 * An `element.style` edit in DevTools has no stylesheet or selector to map
 * back to, and the user explicitly does NOT want an inline `style={{}}` written
 * into their JSX. So instead we make the transient inline tweak persistent as a
 * real CSS rule keyed by a generated, source-location-stable class:
 *
 *   1. append the generated `csync-<hash>` class to the element's className in
 *      its JSX/HTML source (via the shared, fidelity-guarded className writer);
 *   2. upsert a matching `.csync-<hash> { <declarations> }` rule into the
 *      overrides stylesheet (Config.overridesFile), REPLACING that rule's body
 *      in place on a re-promote so repeated edits never pile up duplicate rules.
 *
 * Both edits are computed in memory first; nothing is written until both
 * succeed, so a dynamic-className skip or a malformed-overrides-file parse error
 * leaves BOTH files untouched.
 */

/** A CSS property name — standard (`max-width`) or custom (`--foo`). No spaces, no injection chars. */
const PROPERTY_RE = /^(--[a-zA-Z0-9-]+|[a-zA-Z][a-zA-Z0-9-]*)$/;

const normalizeSelector = (s: string): string => s.replace(/\s+/g, " ").trim();

/** One computed file edit awaiting preview/commit (structurally = apply.ts PlannedWrite). */
export interface PromoteWrite {
  /** Absolute jailed path of the file to write. */
  absFile: string;
  /** Workspace-relative path (for outcome/journal reporting). */
  relFile: string;
  /** Current on-disk content. */
  before: string;
  /** Computed content (equals `before` when this file is unchanged). */
  after: string;
}

export interface InlinePromoteResult {
  /** Workspace-relative path of the JSX/HTML file the class was added to. */
  file: string;
  line?: number | undefined;
  note?: string | undefined;
  /**
   * The two computed writes (JSX className edit, then overrides stylesheet
   * upsert), in commit order. Nothing is written here — the caller previews or
   * commits. A file whose `before === after` is a no-op the caller skips.
   */
  writes: PromoteWrite[];
}

/** Deterministic pretty raws for a rule whose body we just (re)built. */
function reindentRule(rule: Rule): void {
  rule.raws.between = " ";
  rule.raws.after = "\n";
  rule.raws.semicolon = true;
  rule.walkDecls((d) => {
    d.raws.before = "\n  ";
    d.raws.between = ": ";
  });
}

/** Validate each declaration is a legitimate, injection-free single CSS decl. */
function assertDeclarationsSafe(decls: InlineDeclaration[]): void {
  for (const d of decls) {
    const prop = d.property.trim();
    if (!PROPERTY_RE.test(prop)) {
      throw new SkipChangeError(`refusing to write: invalid CSS property name "${d.property}"`);
    }
    // value fidelity / injection pre-reject — same guard as modify/add-decl.
    assertCssValueSafe(d.value);
  }
}

/** The exact text `value` renders as inside a declaration, for round-trip comparison. */
function renderedDeclValue(decl: Declaration): string {
  return decl.value.trim() + (decl.important ? " !important" : "");
}

function expectedDeclText(rawValue: string): string {
  const v = rawValue.trim();
  const important = /!important\s*$/i.test(v);
  const base = important ? v.replace(/\s*!important\s*$/i, "").trim() : v;
  return base + (important ? " !important" : "");
}

/**
 * Upsert `.<className> { <decls> }` into `css`. If a rule with that exact
 * selector already exists, replace its entire body; otherwise append a new
 * rule. Pure: returns the new stylesheet text. Guards on re-parse + a
 * structural check that EXACTLY one rule carries the selector with exactly the
 * requested declarations (values byte-identical) — refuses the write otherwise.
 */
function upsertOverrideRule(
  css: string,
  className: string,
  decls: InlineDeclaration[],
): { css: string; created: boolean } {
  const selector = `.${className}`;
  let root: Root;
  try {
    root = postcss.parse(css);
  } catch (err) {
    throw new SkipChangeError(
      `overrides stylesheet failed to parse: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  const matches: Rule[] = [];
  root.walkRules((r) => {
    if (normalizeSelector(r.selector) === selector) matches.push(r);
  });
  if (matches.length > 1) {
    throw new SkipChangeError(
      `refusing to write: overrides stylesheet already has ${String(matches.length)} rules for "${selector}" — ambiguous, will not modify`,
    );
  }

  const buildDecls = (rule: Rule): void => {
    for (const d of decls) {
      const decl = postcss.decl({ prop: d.property.trim(), value: "" });
      const v = d.value.trim();
      const important = /!important\s*$/i.test(v);
      decl.value = important ? v.replace(/\s*!important\s*$/i, "").trim() : v;
      decl.important = important;
      rule.append(decl);
    }
    reindentRule(rule);
  };

  const existing = matches[0];
  const created = !existing;
  if (existing) {
    existing.removeAll();
    buildDecls(existing);
  } else {
    const rule = postcss.rule({ selector });
    buildDecls(rule);
    rule.raws.before = css.trim().length > 0 ? "\n\n" : "";
    root.append(rule);
  }

  const printed = root.toString();
  // CORE INVARIANT #1: never persist source that does not re-parse.
  let reparsed: Root;
  try {
    reparsed = postcss.parse(printed);
  } catch (err) {
    throw new SkipChangeError(
      `refusing to write: edited overrides stylesheet failed to re-parse (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }

  // CORE INVARIANT #2 + #3: exactly one rule for this selector, holding exactly
  // the requested declarations with byte-identical values.
  const relocated: Rule[] = [];
  reparsed.walkRules((r) => {
    if (normalizeSelector(r.selector) === selector) relocated.push(r);
  });
  if (relocated.length !== 1) {
    throw new SkipChangeError(
      `refusing to write: expected exactly 1 "${selector}" rule after edit, found ${String(relocated.length)} (possible structural corruption)`,
    );
  }
  const rule = relocated[0]!;
  const ownDecls: Declaration[] = [];
  rule.each((n) => {
    if (n.type === "decl") ownDecls.push(n as Declaration);
  });
  assertStructuralCountUnchanged({
    label: `declaration count in "${selector}"`,
    before: 0,
    after: ownDecls.length,
    expectedDelta: decls.length,
  });
  for (const want of decls) {
    const wantProp = want.property.trim().toLowerCase();
    const found = ownDecls.filter((d) => d.prop.trim().toLowerCase() === wantProp);
    const last = found[found.length - 1];
    assertExactMatch(
      `declaration "${want.property}" in "${selector}"`,
      last ? renderedDeclValue(last) : null,
      expectedDeclText(want.value),
    );
  }

  return { css: printed, created };
}

/**
 * Apply one promote-inline-style change: add the generated class to the JSX
 * element and upsert its rule into the overrides stylesheet. Writes both files
 * only after both edits are computed successfully.
 */
export function applyInlinePromote(
  change: PromoteInlineStyleChange,
  cfg: Config,
): InlinePromoteResult {
  assertDeclarationsSafe(change.declarations);

  // (1) compute the JSX className edit (throws on dynamic className / no element).
  const classEdit = computeElementClassEdit(
    cfg.workspaceRoot,
    change.element,
    [],
    [change.className],
  );

  // (2) compute the overrides stylesheet edit.
  const overridesAbs = jailResolve(cfg.workspaceRoot, cfg.overridesFile);
  const overridesExists = fs.existsSync(overridesAbs) && fs.statSync(overridesAbs).isFile();
  const overridesCss = overridesExists ? fs.readFileSync(overridesAbs, "utf8") : "";
  const upsert = upsertOverrideRule(overridesCss, change.className, change.declarations);

  // (3) both computed safely — emit the two planned writes in commit order
  // (JSX first: it's the source of truth for the class, then the stylesheet).
  // Writing is the caller's job (preview shows the diffs; commit persists +
  // journals each). A file whose before === after is a no-op the caller skips.
  const jsxRel = toWorkspaceRelative(cfg.workspaceRoot, classEdit.file);
  const overridesRel = toWorkspaceRelative(cfg.workspaceRoot, overridesAbs);
  const writes: PromoteWrite[] = [
    {
      absFile: classEdit.file,
      relFile: jsxRel,
      before: classEdit.original,
      after: classEdit.code,
    },
    {
      absFile: overridesAbs,
      relFile: overridesRel,
      before: overridesCss,
      after: upsert.css,
    },
  ];

  const noteParts = [
    `promoted inline style to .${change.className} in ${cfg.overridesFile}`,
    upsert.created ? "created rule" : "updated existing rule",
  ];
  if (classEdit.note) noteParts.push(classEdit.note);

  return {
    file: jsxRel,
    line: classEdit.line,
    note: noteParts.join("; "),
    writes,
  };
}
