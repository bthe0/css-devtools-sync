import postcss from "postcss";
import scssSyntax from "postcss-scss";
import type { AtRule, Declaration, Root, Rule } from "postcss";
import type {
  AddDeclChange,
  AddRuleChange,
  DeleteDeclChange,
  ModifyChange,
} from "@dev-sync/contract";
import { SkipChangeError } from "./errors.js";
import { assertCssValueSafe, assertStructuralCountUnchanged, assertExactMatch } from "./fidelity.js";

export type CssChange = ModifyChange | AddDeclChange | DeleteDeclChange | AddRuleChange;

export interface CssEditResult {
  css: string;
  /** 1-based line of the edited declaration/rule, when known. */
  line?: number | undefined;
  note?: string | undefined;
}

const normalizeSelector = (s: string): string => s.replace(/\s+/g, " ").trim();
const normalizeMedia = (s: string): string =>
  s
    .replace(/^@media\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim()
    .toLowerCase();

function isMediaAtRule(node: unknown): node is AtRule {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as { type?: string }).type === "atrule" &&
    (node as AtRule).name.toLowerCase() === "media"
  );
}

/** @media params of the (possibly nested) at-rule chain containing `rule`, or null. */
function mediaParamsOf(rule: Rule): string | null {
  let parent = rule.parent;
  while (parent && parent.type === "atrule") {
    const at = parent as AtRule;
    if (at.name.toLowerCase() === "media") return normalizeMedia(at.params);
    parent = at.parent;
  }
  return null;
}

interface PickedRule {
  rule: Rule;
  note?: string | undefined;
}

/**
 * Does `rule`'s own source span (selector through closing brace) contain
 * (line, column)? Multi-line rules are unambiguous from the line alone (the
 * mapped position of a declaration always falls strictly between its rule's
 * opening and closing lines); single-line rules need the column too, when
 * one is available, since two single-line rules can share a line.
 */
function ruleContainsPosition(rule: Rule, line: number, column: number | undefined): boolean {
  const start = rule.source?.start;
  const end = rule.source?.end;
  if (!start || !end) return false;
  if (line < start.line || line > end.line) return false;
  if (start.line === end.line && line === start.line && column !== undefined) {
    return column >= start.column && column <= end.column;
  }
  return true;
}

/** Line/column span of a rule's own source range, as a single comparable number (larger = wider span). Only meaningful once ruleContainsPosition has confirmed rule.source.start/end are both present. */
function ruleSpan(rule: Rule): number {
  const start = rule.source?.start;
  const end = rule.source?.end;
  if (!start || !end) return Number.POSITIVE_INFINITY;
  return (end.line - start.line) * 100000 + (end.column - start.column);
}

/**
 * Position-based rule lookup: the INNERMOST rule (smallest source span)
 * whose own span contains (line, column). This is the fallback used when
 * selector-NAME matching fails (see pickRuleForChange below) — it is the
 * mechanism behind the CSS-Modules and Sass-nesting tiers, where the
 * compiled selector DevTools reports never matches the source's own
 * selector text (a hash suffix, or a flattened ".parent .child" versus the
 * source's nested ".child"), but the sourcemap-mapped ORIGINAL position
 * always lands inside the correct rule's own body.
 */
function pickRuleAtPosition(root: Root, line: number, column: number | undefined): PickedRule | null {
  let best: Rule | null = null;
  root.walkRules((r) => {
    if (!ruleContainsPosition(r, line, column)) return;
    if (!best || ruleSpan(r) < ruleSpan(best)) best = r;
  });
  if (!best) return null;
  return {
    rule: best,
    note: `selector not found by name — likely a CSS Modules hash or a flattened Sass-nesting selector; located instead by the original source position from the sourcemap (line ${String(line)})`,
  };
}

/** Position hint carried alongside a change, when the sourcemap resolved one. */
export interface RulePosition {
  line: number;
  column: number | null;
}

/**
 * Selector-name lookup first (the common case: compiled and source selector
 * text agree); falls back to position-based lookup ONLY when the name match
 * fails AND a mapped source position is available. Never the other way
 * around — an exact selector-name match is always preferred and cheaper to
 * reason about, so position is strictly a fallback for the cases name
 * matching structurally cannot handle.
 */
function pickRuleForChange(
  root: Root,
  selector: string,
  mediaText: string | undefined,
  position: RulePosition | undefined,
): PickedRule | null {
  const byName = pickRule(root, selector, mediaText);
  if (byName) return byName;
  if (!position) return null;
  return pickRuleAtPosition(root, position.line, position.column ?? undefined);
}

function pickRule(root: Root, selector: string, mediaText: string | undefined): PickedRule | null {
  const wanted = normalizeSelector(selector);
  const matches: Rule[] = [];
  root.walkRules((r) => {
    if (normalizeSelector(r.selector) === wanted) matches.push(r);
  });
  if (matches.length === 0) return null;

  const wantedMedia = mediaText !== undefined ? normalizeMedia(mediaText) : null;
  const strict = matches.filter((r) => mediaParamsOf(r) === wantedMedia);

  if (strict.length > 0) {
    const rule = strict[0]!;
    const note =
      strict.length > 1 ? `matched 1st of ${strict.length} duplicate selectors` : undefined;
    return { rule, note };
  }
  // Lenient fallback: same selector in a different media context.
  const rule = matches[0]!;
  return {
    rule,
    note: wantedMedia
      ? `no rule in @media ${mediaText ?? ""}; edited nearest match`
      : "selector only found inside an @media block; edited nearest match",
  };
}

function declsOf(rule: Rule, property: string): Declaration[] {
  const wanted = property.trim().toLowerCase();
  const out: Declaration[] = [];
  rule.each((node) => {
    if (node.type === "decl" && node.prop.trim().toLowerCase() === wanted) {
      out.push(node);
    }
  });
  return out;
}

function normalizeDeclValue(rawValue: string): { value: string; important: boolean } {
  let value = rawValue.trim();
  const important = /!important\s*$/i.test(value);
  if (important) value = value.replace(/\s*!important\s*$/i, "").trim();
  return { value, important };
}

function setDeclValue(decl: Declaration, rawValue: string): void {
  const { value, important } = normalizeDeclValue(rawValue);
  decl.value = value;
  decl.important = important;
}

/** The exact text a declaration's value+importance renders as, for value-fidelity comparison. */
function expectedDeclText(rawValue: string): string {
  const { value, important } = normalizeDeclValue(rawValue);
  return value + (important ? " !important" : "");
}

/** Count of direct (non-nested) `decl` children of a rule — used for the "no extra declaration got injected" structural check. */
function countDirectDecls(rule: Rule): number {
  let n = 0;
  rule.each((node) => {
    if (node.type === "decl") n++;
  });
  return n;
}

/** Count of every rule in the document (root-level and nested inside @media/@supports/...) — used for the "no extra rule got injected" structural check. */
function countAllRules(root: Root): number {
  let n = 0;
  root.walkRules(() => {
    n++;
  });
  return n;
}

/** px-normalized width mentioned in a media query, for ordering. */
function extractWidthPx(params: string): number | null {
  const m = /\b(?:min|max)-width\s*:\s*([\d.]+)\s*(px|em|rem)?/i.exec(params);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  const unit = (m[2] ?? "px").toLowerCase();
  return unit === "px" ? n : n * 16;
}

type MediaStrategy = "mobile-first" | "desktop-first" | "unknown";

/** Inspect the file's existing @media blocks to infer its breakpoint ordering. */
function detectMediaStrategy(medias: AtRule[]): MediaStrategy {
  let minCount = 0;
  let maxCount = 0;
  for (const m of medias) {
    if (/\bmin-width\b/i.test(m.params)) minCount++;
    if (/\bmax-width\b/i.test(m.params)) maxCount++;
  }
  if (minCount === 0 && maxCount === 0) return "unknown";
  return minCount >= maxCount ? "mobile-first" : "desktop-first";
}

/**
 * Find the top-level @media block matching `mediaText`, or create one at the
 * position that respects the file's mobile-first / desktop-first ordering.
 */
function findOrCreateMedia(root: Root, mediaText: string): AtRule {
  const wanted = normalizeMedia(mediaText);
  let found: AtRule | null = null;
  root.each((node) => {
    if (isMediaAtRule(node) && normalizeMedia(node.params) === wanted) {
      found = node;
      return false;
    }
    return undefined;
  });
  if (found) return found;

  const created = postcss.atRule({ name: "media", params: mediaText.trim() });
  created.raws.before = "\n\n";
  created.raws.between = " ";
  created.raws.after = "\n";

  const medias = root.nodes.filter(isMediaAtRule);
  const strategy = detectMediaStrategy(medias);
  const width = extractWidthPx(mediaText);

  if (width !== null && strategy !== "unknown") {
    for (const existing of medias) {
      const existingWidth = extractWidthPx(existing.params);
      if (existingWidth === null) continue;
      const insertHere =
        strategy === "mobile-first" ? existingWidth > width : existingWidth < width;
      if (insertHere) {
        root.insertBefore(existing, created);
        if (root.first === created) created.raws.before = "";
        return created;
      }
    }
  }
  root.append(created);
  if (root.first === created) created.raws.before = "";
  return created;
}

/** Direct rule children of a container (root-level or inside one @media block). */
function directRules(container: Root | AtRule): Rule[] {
  return (container.nodes ?? []).filter((n): n is Rule => n.type === "rule");
}

/** Order-insensitive signature of a rule's own declarations, for duplicate detection. */
function ruleDeclSignature(rule: Rule): string {
  const decls: string[] = [];
  rule.each((node) => {
    if (node.type === "decl") {
      decls.push(
        `${node.prop.trim().toLowerCase()}:${node.value.trim()}${node.important ? " !important" : ""}`,
      );
    }
  });
  return decls.sort().join(";");
}

/** Deterministic pretty raws for a freshly inserted rule. */
function reindentRule(rule: Rule, indent: string): void {
  rule.raws.between = " ";
  rule.raws.after = `\n${indent}`;
  rule.raws.semicolon = true;
  rule.walkDecls((d) => {
    d.raws.before = `\n${indent}  `;
    d.raws.between = ": ";
  });
}

export interface ApplyCssOptions {
  /** Selector to place a new rule directly after (LLM placement anchor). */
  anchorSelector?: string | undefined;
  /**
   * "scss" selects the postcss-scss syntax (handles `//` line comments and
   * other SCSS constructs a real .scss/.sass file uses); default is plain
   * CSS. Derive this from the target file's extension via cssSyntaxForFile.
   */
  syntax?: "css" | "scss" | undefined;
  /**
   * Original-source position the sourcemap resolved for this change, when
   * one exists (see ResolvedTarget in resolve.ts). Used ONLY as a fallback
   * for modify/add-decl/delete-decl when the reported selector's NAME isn't
   * found in this file — the CSS-Modules and Sass-nesting tiers, where the
   * compiled selector text never matches the source's own selector.
   */
  position?: RulePosition | undefined;
}

/**
 * Apply one captured change to CSS source text. Pure: returns the new text.
 * Throws SkipChangeError for "cannot apply" conditions (unknown selector,
 * missing declaration, empty ruleText) so the orchestrator can skip-with-reason.
 *
 * CORE INVARIANT #1 (re-parses): every return path below routes its printed
 * text through `finish`, which reparses with the SAME syntax and throws
 * SkipChangeError (leaving the file untouched) if that fails.
 *
 * CORE INVARIANT #2 (no structural injection) + #3 (value fidelity): `finish`
 * additionally — via the shared guard in ./fidelity.js — asserts the file's
 * total rule count and (for modify/add-decl/delete-decl) the target rule's
 * own declaration count changed by EXACTLY the delta the caller intended,
 * and that the edited declaration's value reads back byte-for-byte the same
 * as what was requested. Any mismatch means something besides the intended
 * edit landed in the file (an injected declaration, an injected rule, a
 * value that silently changed) -> SkipChangeError, never a partial write.
 * modify/add-decl additionally pre-reject values that can never be a
 * legitimate single CSS value (see assertCssValueSafe) before ever touching
 * the AST, independent of whatever the structural check would catch.
 */
export function applyCssChange(
  source: string,
  change: CssChange,
  options: ApplyCssOptions = {},
): CssEditResult {
  const syntax = options.syntax === "scss" ? scssSyntax : undefined;

  let root: Root;
  try {
    root = syntax ? (syntax.parse(source) as Root) : postcss.parse(source);
  } catch (err) {
    throw new SkipChangeError(
      `target stylesheet failed to parse: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  interface StructuralCheck {
    ruleCountBefore: number;
    ruleCountDelta: number;
    /** Present for modify/add-decl/delete-decl: the single rule whose own declaration count and (for modify/add-decl) value must be verified. */
    target?: {
      selector: string;
      mediaText: string | undefined;
      declCountBefore: number;
      declCountDelta: number;
      /** Present for modify/add-decl: assert this property's value reads back exactly this text. */
      valueCheck?: { property: string; expectedValue: string };
    };
    /** Present for add-rule: each newly-inserted rule must be relocatable with its own exact declarations, unchanged. */
    insertedRules?: { selector: string; mediaText: string | undefined; sig: string }[];
  }

  const finish = (r: Root, check?: StructuralCheck): string => {
    const printed = syntax ? r.toString(syntax) : r.toString();
    let reparsed: Root;
    try {
      reparsed = syntax ? (syntax.parse(printed) as Root) : postcss.parse(printed);
    } catch (err) {
      throw new SkipChangeError(
        `refusing to write: edited stylesheet failed to re-parse (${err instanceof Error ? err.message : "unknown error"})`,
      );
    }
    if (!check) return printed;

    assertStructuralCountUnchanged({
      label: "rule",
      before: check.ruleCountBefore,
      after: countAllRules(reparsed),
      expectedDelta: check.ruleCountDelta,
    });

    if (check.target) {
      const picked = pickRule(reparsed, check.target.selector, check.target.mediaText);
      if (!picked) {
        throw new SkipChangeError(
          `refusing to write: edited rule "${check.target.selector}" could not be relocated after re-parse (possible structural corruption)`,
        );
      }
      assertStructuralCountUnchanged({
        label: `declaration count in "${check.target.selector}"`,
        before: check.target.declCountBefore,
        after: countDirectDecls(picked.rule),
        expectedDelta: check.target.declCountDelta,
      });
      if (check.target.valueCheck) {
        const decls = declsOf(picked.rule, check.target.valueCheck.property);
        const decl = decls[decls.length - 1];
        const actual = decl ? decl.value.trim() + (decl.important ? " !important" : "") : null;
        assertExactMatch(
          `declaration "${check.target.valueCheck.property}" in "${check.target.selector}"`,
          actual,
          check.target.valueCheck.expectedValue,
        );
      }
    }

    if (check.insertedRules) {
      for (const ins of check.insertedRules) {
        const wantedMedia = ins.mediaText !== undefined ? normalizeMedia(ins.mediaText) : null;
        let found = false;
        reparsed.walkRules((r) => {
          if (
            normalizeSelector(r.selector) === normalizeSelector(ins.selector) &&
            mediaParamsOf(r) === wantedMedia &&
            ruleDeclSignature(r) === ins.sig
          ) {
            found = true;
          }
        });
        if (!found) {
          throw new SkipChangeError(
            `refusing to write: inserted rule "${ins.selector}" could not be relocated with its exact declarations after re-parse (possible structural corruption)`,
          );
        }
      }
    }

    return printed;
  };

  switch (change.op) {
    case "modify": {
      const picked = pickRuleForChange(root, change.selector, change.mediaText, options.position);
      if (!picked) {
        throw new SkipChangeError(`selector not found in target file: "${change.selector}"`);
      }
      // Relocate by the rule's OWN selector/media, not the (possibly hashed
      // or flattened) reported one — see pickRuleForChange's doc comment.
      const targetSelector = picked.rule.selector;
      const targetMediaText = mediaParamsOf(picked.rule) ?? undefined;
      const decls = declsOf(picked.rule, change.property);
      const decl = decls[decls.length - 1]; // last wins in the cascade
      if (!decl) {
        throw new SkipChangeError(
          `declaration "${change.property}" not found in "${change.selector}"`,
        );
      }
      assertCssValueSafe(change.newValue);
      const ruleCountBefore = countAllRules(root);
      const declCountBefore = countDirectDecls(picked.rule);
      setDeclValue(decl, change.newValue);
      const css = finish(root, {
        ruleCountBefore,
        ruleCountDelta: 0,
        target: {
          selector: targetSelector,
          mediaText: targetMediaText,
          declCountBefore,
          declCountDelta: 0,
          valueCheck: { property: change.property, expectedValue: expectedDeclText(change.newValue) },
        },
      });
      return { css, line: decl.source?.start?.line, note: picked.note };
    }

    case "add-decl": {
      const picked = pickRuleForChange(root, change.selector, change.mediaText, options.position);
      if (!picked) {
        throw new SkipChangeError(`selector not found in target file: "${change.selector}"`);
      }
      const targetSelector = picked.rule.selector;
      const targetMediaText = mediaParamsOf(picked.rule) ?? undefined;
      assertCssValueSafe(change.newValue);
      const ruleCountBefore = countAllRules(root);
      const declCountBefore = countDirectDecls(picked.rule);
      const existing = declsOf(picked.rule, change.property);
      const last = existing[existing.length - 1];
      const valueCheck = { property: change.property, expectedValue: expectedDeclText(change.newValue) };
      if (last) {
        setDeclValue(last, change.newValue);
        const css = finish(root, {
          ruleCountBefore,
          ruleCountDelta: 0,
          target: { selector: targetSelector, mediaText: targetMediaText, declCountBefore, declCountDelta: 0, valueCheck },
        });
        return {
          css,
          line: last.source?.start?.line,
          note: joinNotes(picked.note, "declaration already existed; updated its value"),
        };
      }
      const decl = postcss.decl({ prop: change.property, value: "" });
      setDeclValue(decl, change.newValue);
      picked.rule.append(decl);
      const css = finish(root, {
        ruleCountBefore,
        ruleCountDelta: 0,
        target: { selector: targetSelector, mediaText: targetMediaText, declCountBefore, declCountDelta: 1, valueCheck },
      });
      return { css, note: picked.note };
    }

    case "delete-decl": {
      const picked = pickRuleForChange(root, change.selector, change.mediaText, options.position);
      if (!picked) {
        throw new SkipChangeError(`selector not found in target file: "${change.selector}"`);
      }
      const targetSelector = picked.rule.selector;
      const targetMediaText = mediaParamsOf(picked.rule) ?? undefined;
      const decls = declsOf(picked.rule, change.property);
      if (decls.length === 0) {
        throw new SkipChangeError(
          `declaration "${change.property}" not found in "${change.selector}"`,
        );
      }
      const ruleCountBefore = countAllRules(root);
      const declCountBefore = countDirectDecls(picked.rule);
      const removedCount = decls.length;
      for (const d of decls) d.remove();
      const css = finish(root, {
        ruleCountBefore,
        ruleCountDelta: 0,
        target: {
          selector: targetSelector,
          mediaText: targetMediaText,
          declCountBefore,
          declCountDelta: -removedCount,
        },
      });
      return { css, note: picked.note };
    }

    case "add-rule": {
      const ruleCountBefore = countAllRules(root);

      let parsed: Root;
      try {
        parsed = postcss.parse(change.ruleText);
      } catch (err) {
        throw new SkipChangeError(
          `ruleText failed to parse: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }
      const newRules = parsed.nodes.filter((n): n is Rule => n.type === "rule");
      if (newRules.length === 0) {
        throw new SkipChangeError("ruleText contains no CSS rule");
      }

      const container: Root | AtRule = change.mediaText
        ? findOrCreateMedia(root, change.mediaText)
        : root;
      const indent = change.mediaText ? "  " : "";

      // Optional anchor: insert straight after a named existing rule.
      const anchorPicked = options.anchorSelector
        ? pickRule(root, options.anchorSelector, change.mediaText)
        : undefined;
      const anchor = anchorPicked?.rule;

      // Observability (prior LOW finding): the LLM-chosen anchor may resolve
      // to a rule that lives in a DIFFERENT container than the one the new
      // rule is being placed into (e.g. anchor is top-level but the new rule
      // is going inside an @media block). insertAfter can only operate within
      // the same parent, so that case silently fell back to "append at end"
      // — surface it in the note instead of dropping it on the floor.
      let anchorNote: string | undefined;
      if (options.anchorSelector && !anchor) {
        anchorNote = `LLM placement anchor "${options.anchorSelector}" not found; appended at end instead`;
      } else if (anchor && anchor.parent !== container) {
        anchorNote = `LLM placement anchor "${options.anchorSelector}" is in a different container; anchor disregarded, appended at end instead`;
      }

      // IDEMPOTENCY (platform rule: external-facing apply must be safe to
      // retry): without this check, re-POSTing the identical add-rule change
      // — which the extension does on every retry/re-sync — would append a
      // second, third, ... copy of the same rule forever. Skip a new rule
      // when the target container already holds a rule with the same
      // selector AND the exact same declarations; only genuinely new rules
      // get inserted.
      const dupNotes: string[] = [];
      const insertedRules: { selector: string; mediaText: string | undefined; sig: string }[] = [];
      for (const nr of newRules) {
        const nrSelector = normalizeSelector(nr.selector);
        const nrSig = ruleDeclSignature(nr);
        const existingDup = directRules(container).find(
          (r) => normalizeSelector(r.selector) === nrSelector && ruleDeclSignature(r) === nrSig,
        );
        if (existingDup) {
          dupNotes.push(`rule "${nr.selector}" already present with identical declarations; skipped duplicate insert`);
          continue;
        }
        nr.raws.before = container === root ? "\n\n" : `\n${indent}`;
        reindentRule(nr, indent);
        if (anchor && anchor.parent === container) {
          container.insertAfter(anchor, nr);
        } else {
          container.append(nr);
        }
        if (container === root && root.first === nr) nr.raws.before = "";
        insertedRules.push({ selector: nr.selector, mediaText: change.mediaText, sig: nrSig });
      }
      const css = finish(root, {
        ruleCountBefore,
        ruleCountDelta: insertedRules.length,
        insertedRules,
      });
      return {
        css,
        note: joinNotes(
          change.mediaText ? `placed in @media ${change.mediaText.trim()}` : undefined,
          anchorNote,
          dupNotes.length > 0 ? dupNotes.join("; ") : undefined,
        ),
      };
    }
  }
}

function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const kept = notes.filter((n): n is string => Boolean(n));
  return kept.length > 0 ? kept.join("; ") : undefined;
}
