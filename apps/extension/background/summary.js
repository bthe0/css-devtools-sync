// background/summary.js — pure helpers for the in-page autosave toast.
// No chrome.* / no DOM, so it unit-tests headless like diff.js.

"use strict";

/** Last path segment of a workspace-relative file (posix or win separators). */
export function baseName(file) {
  if (typeof file !== "string" || file.length === 0) return "";
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] || file;
}

/**
 * Human summary for the toast the content script renders after an autosave.
 * @param {{file: string}[]} applied  ApplyOutcome[]-shaped (only `file` read)
 * @param {number} skipped            count of skipped changes
 * @param {number} [maxFiles=3]       cap before "+N more"
 * @returns {{ text: string, kind: "success" | "warn" }}
 */
export function summarizeAutosave(applied, skipped = 0, maxFiles = 3) {
  const appliedList = Array.isArray(applied) ? applied : [];
  const skippedCount = Number.isInteger(skipped) && skipped > 0 ? skipped : 0;

  // Unique file basenames, first-seen order preserved.
  const seen = new Set();
  const files = [];
  for (const o of appliedList) {
    const name = baseName(o && o.file);
    if (name && !seen.has(name)) {
      seen.add(name);
      files.push(name);
    }
  }

  const n = appliedList.length;

  if (n === 0) {
    // Nothing written — only meaningful if something was actually skipped.
    if (skippedCount > 0) {
      return {
        text: `Nothing autosaved — ${skippedCount} change${skippedCount === 1 ? "" : "s"} skipped`,
        kind: "warn",
      };
    }
    return { text: "Nothing to autosave", kind: "warn" };
  }

  const shown = files.slice(0, maxFiles);
  const extra = files.length - shown.length;
  let fileList = shown.join(", ");
  if (extra > 0) fileList += `, +${extra} more`;

  let text = `Autosaved ${n} change${n === 1 ? "" : "s"} → ${fileList}`;
  if (skippedCount > 0) text += ` (${skippedCount} skipped)`;
  return { text, kind: skippedCount > 0 ? "warn" : "success" };
}

/** Markup ops whose skip is a dynamic-source rejection, not a real failure. */
const DYNAMIC_MARKUP_OPS = new Set(["set-text", "set-text-segment", "set-attr", "remove-attr"]);

/**
 * True when a skipped change is an EXPECTED dynamic-markup rejection rather than
 * an actionable failure. The text/attr pollers auto-emit a set-text/set-attr for
 * every instrumented element on the page each tick; when a child is dynamic or
 * mixed ({expr} or nested tags — e.g. a demo line like `Region {{eu-west-1}}
 * online`) the engine correctly refuses to rewrite the expression as a literal,
 * and devtools.js suppresses that source location so it never re-emits.
 *
 * Counting these as user-facing skips is wrong: it latches the HUD amber and
 * inflates the autosave toast ("1 skipped") for edits the user never made,
 * masking that their real edit succeeded. Only skips that are NOT expected here
 * — a CSS rule that wouldn't resolve, drift on a committed file, an internal
 * error — should surface. The instrumented-element guard (dataSourceFile) keeps
 * a CSS `modify`/`add-rule` skip actionable even if it carries element context.
 *
 * @param {{ change?: { op?: string, element?: { dataSourceFile?: string } } }} item  one SkippedChange
 * @returns {boolean}
 */
export function isDynamicMarkupSkip(item) {
  const change = item && item.change;
  if (!change || typeof change.op !== "string" || !DYNAMIC_MARKUP_OPS.has(change.op)) return false;
  const src = change.element && change.element.dataSourceFile;
  return typeof src === "string" && src.length > 0;
}

/**
 * Split an ApplyResult.skipped array into expected dynamic-markup rejections
 * (silent — must not latch amber or count in the toast) and actionable skips
 * (surface them). Pure: the caller still applies the churn-guard side effects
 * (suppress sets, dropping the stuck change) as it walks `skipped`.
 * @param {{ change?: object }[]} skipped
 * @returns {{ dynamic: object[], actionable: object[] }}
 */
export function partitionSkips(skipped) {
  const list = Array.isArray(skipped) ? skipped : [];
  const dynamic = [];
  const actionable = [];
  for (const item of list) {
    (isDynamicMarkupSkip(item) ? dynamic : actionable).push(item);
  }
  return { dynamic, actionable };
}
