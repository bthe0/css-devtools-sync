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
