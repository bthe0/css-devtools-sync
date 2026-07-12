import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { createTwoFilesPatch } from "diff";
import type {
  AddRuleChange,
  ApplyMode,
  ApplyOutcome,
  ApplyResult,
  CaptureChange,
  CapturePayload,
  Confidence,
  FileDiff,
  RequiredElementContext,
  SkippedChange,
  TemplateResponse,
} from "@dev-sync/contract";
import type { Config } from "./config.js";
import { SkipChangeError } from "./errors.js";
import { appendJournal } from "./journal.js";
import { applyCssChange } from "./apply-css.js";
import { applyInlinePromote } from "./apply-inline-promote.js";
import { applyJsxChange, describeJsxTemplate } from "./apply-jsx.js";
import { computeClassListChange, isTailwindTarget } from "./classlist.js";
import { applyCssInJsChange } from "./cssinjs.js";
import { chooseTemplateLine, hasStyledIdentity, resolveStyledTarget } from "./cssinjs-target.js";
import { choosePlacement, findOwningCssFile } from "./placement.js";
import { cssSyntaxForFile, isCssLike, resolveTargetForChange } from "./resolve.js";
import {
  jailResolve,
  readWorkspaceFile,
  resolveExistingFile,
  toWorkspaceRelative,
  WorkspaceError,
  writeWorkspaceFile,
} from "./workspace.js";

/** One computed file edit awaiting preview or commit. Nothing is written until commit. */
export interface PlannedWrite {
  /** Absolute jailed path of the file to write. */
  absFile: string;
  /** Workspace-relative path (for outcome + journal reporting). */
  relFile: string;
  /** Current on-disk content. */
  before: string;
  /** Computed content (equals `before` for a no-op the commit path skips). */
  after: string;
}

/**
 * Everything applyOne computes for a change WITHOUT touching disk: the outcome
 * metadata plus the concrete file writes it entails (one for most tiers, two
 * for inline-promote). applyPayload then either builds a preview diff or
 * commits + journals each write.
 */
interface PlannedChange {
  change: CaptureChange;
  file: string;
  line?: number | undefined;
  mode: ApplyMode;
  confidence: Confidence;
  confidenceReason?: string | undefined;
  note?: string | undefined;
  writes: PlannedWrite[];
}

type ApplyOneResult = PlannedChange | { needsPlacement: true };

/**
 * Orchestrator: route every captured change to the right apply module and
 * collect an ApplyResult. Per-change failures become skipped-with-reason;
 * only jail violations (WorkspaceError) abort the request (HTTP 400).
 */
export async function applyPayload(
  payload: CapturePayload,
  cfg: Config,
  log: FastifyBaseLogger,
): Promise<ApplyResult> {
  const commit = payload.applyMode === "commit";
  const applied: ApplyOutcome[] = [];
  const skipped: SkippedChange[] = [];
  const needsPlacement: CaptureChange[] = [];

  for (const change of payload.changes) {
    try {
      const result = await applyOne(change, cfg, log);
      if ("needsPlacement" in result) {
        needsPlacement.push(change);
        continue;
      }
      // Preview OR commit: the file writes are computed but not yet on disk.
      // Preview returns diffs and touches nothing; commit persists each changed
      // write and appends a reversible journal entry per file.
      const outcome = await finalizeChange(result, cfg, commit, log);
      applied.push(outcome);
    } catch (err) {
      if (err instanceof WorkspaceError) throw err; // hostile path -> 400 for the whole request
      if (err instanceof SkipChangeError) {
        skipped.push({ change, reason: err.message });
      } else {
        // Log the real error; never leak internals into the response.
        log.error({ err }, "unexpected error applying change");
        skipped.push({ change, reason: "internal error while applying this change" });
      }
    }
  }

  return { applied, skipped, needsPlacement, committed: commit };
}

/**
 * Turn a computed PlannedChange into an ApplyOutcome. In commit mode, persist
 * every write whose content actually changed and journal it (drift-recoverable,
 * one-click reversible). In preview mode, write NOTHING — just fold the writes
 * into a single unified diff so the client can confirm before committing.
 *
 * Multi-file changes (inline-promote touches JSX + overrides) still map to the
 * single-file ApplyOutcome.diff by concatenating each write's patch; before/after
 * report the primary (first) write.
 */
async function finalizeChange(
  planned: PlannedChange,
  cfg: Config,
  commit: boolean,
  log: FastifyBaseLogger,
): Promise<ApplyOutcome> {
  // Only writes that actually change bytes get persisted, journaled, or diffed.
  const changed = planned.writes.filter((w) => w.before !== w.after);
  const patches = changed.map((w) =>
    createTwoFilesPatch(w.relFile, w.relFile, w.before, w.after, "before", "after"),
  );

  if (commit && changed.length > 0) {
    // Phase 1 — write every file, all-or-nothing. A multi-file change (e.g.
    // inline-promote: JSX className + overrides sheet) must not half-apply, so
    // if any write throws we roll the already-written files back to `before`
    // and rethrow — the caller then records the whole change as skipped.
    const written: PlannedWrite[] = [];
    try {
      for (const w of changed) {
        // Guard the read-modify-write race: `w.before` was captured when this
        // edit was COMPUTED (applyOne read the file). Between then and now a
        // concurrent /apply request or an external editor may have written the
        // file. Re-read immediately before writing and, if the on-disk content
        // has drifted from what we planned against, skip rather than clobber it
        // with last-writer-wins. The common path (disk still == before, no
        // concurrent writer — including sequential same-file changes in one
        // request, which re-read disk per change) sees no drift and proceeds.
        let current: string;
        try {
          current = fs.readFileSync(w.absFile, "utf8");
        } catch (readErr) {
          if ((readErr as NodeJS.ErrnoException).code === "ENOENT") current = "";
          else throw readErr;
        }
        if (current !== w.before) {
          throw new SkipChangeError(
            "target file changed on disk since this edit was computed — skipped to avoid clobbering",
          );
        }
        writeWorkspaceFile(cfg.workspaceRoot, w.absFile, w.after);
        written.push(w);
      }
    } catch (err) {
      for (const w of written) {
        try {
          writeWorkspaceFile(cfg.workspaceRoot, w.absFile, w.before);
        } catch (rollbackErr) {
          // Rollback itself failed — the file may be left modified. Loud, not silent.
          log.error(
            { rollbackErr, file: w.relFile },
            "write failed mid-change AND rollback failed — file may be left modified",
          );
        }
      }
      throw err;
    }

    // Phase 2 — all files are on disk and consistent. Journal each. A journal
    // failure must NOT revert correct writes (that would resurrect bug #1); the
    // write stands, we log that this one write is not undoable. The undo drift
    // guard already refuses to revert against a mismatching entry, so a partial
    // journal can never clobber a good file.
    for (const w of changed) {
      try {
        await appendJournal(
          cfg,
          {
            file: w.relFile,
            mode: planned.mode,
            confidence: planned.confidence,
            before: w.before,
            after: w.after,
          },
          log,
        );
      } catch (journalErr) {
        log.error(
          { journalErr, file: w.relFile },
          "write committed but journaling failed — this write is not undoable",
        );
      }
    }
  }

  // Primary = first write that actually changed (fixes a no-op leading write
  // reporting before===after while `unified` shows real hunks). Fall back to
  // writes[0] only for a pure no-op change so an outcome still carries a file.
  const primary = changed[0] ?? planned.writes[0];
  const diff: FileDiff | undefined = primary
    ? { before: primary.before, after: primary.after, unified: patches.join("\n") }
    : undefined;

  return {
    change: planned.change,
    file: planned.file,
    line: planned.line,
    mode: planned.mode,
    confidence: planned.confidence,
    confidenceReason: planned.confidenceReason,
    note: planned.note,
    diff,
  };
}

/**
 * Read-only: describe the source template of an instrumented element so the
 * client can offer per-segment static-text editing. Converts the located file
 * to a workspace-relative path; propagates SkipChangeError (unlocatable) and
 * WorkspaceError (jail escape) for the route to map to 404 / 400.
 */
export function describeTemplate(
  element: RequiredElementContext,
  cfg: Config,
): TemplateResponse {
  const desc = describeJsxTemplate(cfg.workspaceRoot, element);
  return {
    file: toWorkspaceRelative(cfg.workspaceRoot, desc.file),
    line: desc.line,
    tag: desc.tag,
    parts: desc.parts,
    editable: desc.editable,
  };
}

async function applyOne(
  change: CaptureChange,
  cfg: Config,
  log: FastifyBaseLogger,
): Promise<ApplyOneResult> {
  // --- Tier: markup ops -> edit JSX source directly, never a stylesheet ---
  if (
    change.op === "set-attr" ||
    change.op === "remove-attr" ||
    change.op === "set-text" ||
    change.op === "set-text-segment"
  ) {
    const res = applyJsxChange(cfg.workspaceRoot, change);
    const rel = toWorkspaceRelative(cfg.workspaceRoot, res.file);
    return {
      change,
      file: rel,
      line: res.line,
      mode: "jsx",
      confidence: "deterministic",
      confidenceReason: "exact AST match on the instrumented JSX element",
      note: res.note,
      writes: [{ absFile: res.file, relFile: rel, before: res.before, after: res.after }],
    };
  }

  // --- Tier: inline-style promote -> generated class + overrides CSS rule ---
  if (change.op === "promote-inline-style") {
    const res = applyInlinePromote(change, cfg);
    return {
      change,
      file: res.file,
      line: res.line,
      mode: "promote",
      confidence: "deterministic",
      confidenceReason:
        "generated class added to the instrumented element + its rule upserted deterministically",
      note: res.note,
      writes: res.writes,
    };
  }

  // --- Tier: Tailwind / utility classes -> edit className, never the CSS ---
  if (change.op !== "add-rule" && isTailwindTarget(change)) {
    const edit = computeClassListChange(cfg.workspaceRoot, change);
    const rel = toWorkspaceRelative(cfg.workspaceRoot, edit.file);
    return {
      change,
      file: rel,
      line: edit.line,
      mode: "classlist",
      confidence: "deterministic",
      confidenceReason: "exact className edit on the instrumented element",
      note: edit.note,
      writes: [{ absFile: edit.file, relFile: rel, before: edit.original, after: edit.code }],
    };
  }

  if (change.op === "add-rule") {
    return applyAddRule(change, cfg, log);
  }

  // --- Resolve the target file (sourcemap chain first) ---
  const target = resolveTargetForChange(cfg.workspaceRoot, change.styleSheet, change.range ?? null);
  if (!target) {
    // --- Tier: styled-components (no sourcemap) ---
    // The runtime <style data-styled> sheet has no map and the rule selector is
    // an opaque hash. Resolve the source via the element's displayName class
    // (File__Var) + LLM/deterministic template targeting.
    if (hasStyledIdentity(change.element?.classList)) {
      const styled = await resolveStyledTarget(cfg, change, log);
      const res = applyCssInJsChange(styled.code, styled.line, change);
      const rel = toWorkspaceRelative(cfg.workspaceRoot, styled.absFile);
      return {
        change,
        file: rel,
        line: res.line,
        mode: "cssinjs",
        confidence: styled.confidence,
        confidenceReason: joinNotes(styled.reason, res.note),
        note: res.note,
        writes: [{ absFile: styled.absFile, relFile: rel, before: styled.code, after: res.code }],
      };
    }
    throw new SkipChangeError(
      `source file not found for stylesheet "${change.styleSheet.sourceURL || change.styleSheet.id}"`,
    );
  }

  // --- Tier: css-in-js (emotion / styled-components) ---
  if (target.kind === "cssinjs") {
    const code = readWorkspaceFile(cfg.workspaceRoot, target.file);
    // The sheet mapped us to the FILE but not always a single template line
    // (emotion emits one <style> per component but the map may only pin the
    // file). When the line is unknown, auto-target the template.
    let line: number;
    let confidence: Confidence;
    let reason: string;
    if (target.line !== null) {
      line = target.line;
      confidence = "deterministic";
      reason = "sourcemap pinned the exact template line";
    } else {
      const choice = await chooseTemplateLine(cfg, target.file, code, change, log);
      line = choice.line;
      confidence = choice.confidence;
      reason = choice.reason;
    }
    const res = applyCssInJsChange(code, line, change);
    const rel = toWorkspaceRelative(cfg.workspaceRoot, target.file);
    return {
      change,
      file: rel,
      line: res.line,
      mode: "cssinjs",
      confidence,
      confidenceReason: joinNotes(reason, res.note),
      note: res.note,
      writes: [{ absFile: target.file, relFile: rel, before: code, after: res.code }],
    };
  }

  // --- Tier: plain / compiled-mapped CSS via PostCSS ---
  const source = readWorkspaceFile(cfg.workspaceRoot, target.file);
  const res = applyCssChange(source, change, {
    syntax: cssSyntaxForFile(target.file),
    // Position fallback for CSS Modules (hashed selector) / Sass nesting
    // (flattened selector) — see apply-css.ts's pickRuleForChange.
    position: target.line !== null ? { line: target.line, column: target.column } : undefined,
  });
  const rel = toWorkspaceRelative(cfg.workspaceRoot, target.file);
  return {
    change,
    file: rel,
    line: res.line,
    mode: target.viaSourceMap ? "sourcemap" : "postcss",
    confidence: "deterministic",
    confidenceReason: target.viaSourceMap
      ? "sourcemap resolved the exact source rule"
      : "exact PostCSS AST match on the target rule",
    note: res.note,
    writes: [{ absFile: target.file, relFile: rel, before: source, after: res.css }],
  };
}

async function applyAddRule(
  change: AddRuleChange,
  cfg: Config,
  log: FastifyBaseLogger,
): Promise<ApplyOneResult> {
  // If the sheet itself maps to an editable CSS source, apply deterministically.
  const target = resolveTargetForChange(cfg.workspaceRoot, change.styleSheet, null);
  if (target && target.kind === "css" && change.styleSheet.origin === "regular") {
    const source = readWorkspaceFile(cfg.workspaceRoot, target.file);
    const res = applyCssChange(source, change, { syntax: cssSyntaxForFile(target.file) });
    const rel = toWorkspaceRelative(cfg.workspaceRoot, target.file);
    return {
      change,
      file: rel,
      line: res.line,
      mode: target.viaSourceMap ? "sourcemap" : "postcss",
      confidence: "deterministic",
      confidenceReason: target.viaSourceMap
        ? "sourcemap resolved the owning stylesheet"
        : "rule added to the sheet's own mapped source file",
      note: res.note,
      writes: [
        { absFile: jailResolve(cfg.workspaceRoot, target.file), relFile: rel, before: source, after: res.css },
      ],
    };
  }

  // Inspector-origin (typed in DevTools) or unresolvable sheet: placement engine.
  const candidates = buildPlacementCandidates(cfg, change);
  if (candidates.length === 0) return { needsPlacement: true };

  const decision = await choosePlacement(change, cfg, candidates, log);
  if (!decision) return { needsPlacement: true };

  const abs = jailResolve(cfg.workspaceRoot, decision.file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new SkipChangeError(`placement target not found: ${decision.file}`);
  }
  const source = readWorkspaceFile(cfg.workspaceRoot, abs);
  const res = applyCssChange(source, change, {
    anchorSelector: decision.anchor,
    syntax: cssSyntaxForFile(abs),
  });
  // Confidence: one candidate -> deterministic; LLM tiebreak -> assisted;
  // multiple candidates resolved by first-match heuristic -> fallback.
  let confidence: Confidence;
  let reason: string;
  if (candidates.length === 1) {
    confidence = "deterministic";
    reason = `only one candidate stylesheet (${decision.file}) — placed there`;
  } else if (decision.viaLlm) {
    confidence = "assisted";
    reason = `LLM picked ${decision.file} among ${String(candidates.length)} candidate stylesheets — eyeball the diff`;
  } else {
    confidence = "fallback";
    reason = `first-match heuristic picked ${decision.file} among ${String(candidates.length)} candidates — verify the diff`;
  }
  return {
    change,
    file: decision.file,
    line: res.line,
    mode: "placed",
    confidence,
    confidenceReason: reason,
    note: joinNotes(
      decision.viaLlm ? "placement chosen by LLM" : "deterministic placement",
      res.note,
    ),
    writes: [{ absFile: abs, relFile: decision.file, before: source, after: res.css }],
  };
}

/** Ranked candidate files (workspace-relative) for placing a new rule. */
function buildPlacementCandidates(cfg: Config, change: AddRuleChange): string[] {
  const out: string[] = [];
  const push = (abs: string | null): void => {
    if (!abs) return;
    const rel = toWorkspaceRelative(cfg.workspaceRoot, abs);
    if (!out.includes(rel)) out.push(rel);
  };

  // 1. Stylesheet co-located with the instrumented component.
  const srcFile = change.element?.dataSourceFile;
  if (srcFile) {
    try {
      const absSrc = jailResolve(cfg.workspaceRoot, srcFile);
      const dir = path.dirname(absSrc);
      const base = path.basename(absSrc).replace(/\.[^.]+$/, "");
      for (const name of [
        `${base}.module.css`,
        `${base}.css`,
        `${base}.scss`,
        "styles.css",
        "style.css",
        "index.css",
      ]) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) push(candidate);
      }
    } catch {
      // instrumented path invalid — ignore for candidate building
    }
  }

  // 2. The file already owning rules for this element's classes.
  push(findOwningCssFile(cfg.workspaceRoot, change.element?.classList ?? []));

  // 3. The sheet's own file, when it resolves to editable CSS.
  const sheetFile = resolveExistingFile(cfg.workspaceRoot, change.styleSheet.sourceURL);
  if (sheetFile && isCssLike(sheetFile)) push(sheetFile);

  return out;
}

function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const kept = notes.filter((n): n is string => Boolean(n));
  return kept.length > 0 ? kept.join("; ") : undefined;
}
