import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type {
  AddRuleChange,
  ApplyOutcome,
  ApplyResult,
  CaptureChange,
  CapturePayload,
  RequiredElementContext,
  SkippedChange,
  TemplateResponse,
} from "@css-sync/contract";
import type { Config } from "./config.js";
import { SkipChangeError } from "./errors.js";
import { applyCssChange } from "./apply-css.js";
import { applyInlinePromote } from "./apply-inline-promote.js";
import { applyJsxChange, describeJsxTemplate } from "./apply-jsx.js";
import { applyClassListChange, isTailwindTarget } from "./classlist.js";
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

type ApplyOneResult = ApplyOutcome | { needsPlacement: true };

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
  const applied: ApplyOutcome[] = [];
  const skipped: SkippedChange[] = [];
  const needsPlacement: CaptureChange[] = [];

  for (const change of payload.changes) {
    try {
      const result = await applyOne(change, cfg, log);
      if ("needsPlacement" in result) {
        needsPlacement.push(change);
      } else {
        applied.push(result);
      }
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

  return { applied, skipped, needsPlacement };
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
    return {
      change,
      file: toWorkspaceRelative(cfg.workspaceRoot, res.file),
      line: res.line,
      mode: "jsx",
      note: res.note,
    };
  }

  // --- Tier: inline-style promote -> generated class + overrides CSS rule ---
  if (change.op === "promote-inline-style") {
    const res = applyInlinePromote(change, cfg);
    return { change, file: res.file, line: res.line, mode: "promote", note: res.note };
  }

  // --- Tier: Tailwind / utility classes -> edit className, never the CSS ---
  if (change.op !== "add-rule" && isTailwindTarget(change)) {
    const res = applyClassListChange(cfg.workspaceRoot, change);
    return {
      change,
      file: toWorkspaceRelative(cfg.workspaceRoot, res.file),
      line: res.line,
      mode: "classlist",
      note: res.note,
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
      writeWorkspaceFile(cfg.workspaceRoot, styled.absFile, res.code);
      return {
        change,
        file: toWorkspaceRelative(cfg.workspaceRoot, styled.absFile),
        line: res.line,
        mode: "cssinjs",
        note: res.note,
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
    const line =
      target.line ?? (await chooseTemplateLine(cfg, target.file, code, change, log));
    const res = applyCssInJsChange(code, line, change);
    writeWorkspaceFile(cfg.workspaceRoot, target.file, res.code);
    return {
      change,
      file: toWorkspaceRelative(cfg.workspaceRoot, target.file),
      line: res.line,
      mode: "cssinjs",
      note: res.note,
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
  writeWorkspaceFile(cfg.workspaceRoot, target.file, res.css);
  return {
    change,
    file: toWorkspaceRelative(cfg.workspaceRoot, target.file),
    line: res.line,
    mode: target.viaSourceMap ? "sourcemap" : "postcss",
    note: res.note,
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
    writeWorkspaceFile(cfg.workspaceRoot, target.file, res.css);
    return {
      change,
      file: toWorkspaceRelative(cfg.workspaceRoot, target.file),
      line: res.line,
      mode: target.viaSourceMap ? "sourcemap" : "postcss",
      note: res.note,
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
  writeWorkspaceFile(cfg.workspaceRoot, abs, res.css);
  return {
    change,
    file: decision.file,
    line: res.line,
    mode: "placed",
    note: joinNotes(
      decision.viaLlm ? "placement chosen by LLM" : "deterministic placement",
      res.note,
    ),
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
