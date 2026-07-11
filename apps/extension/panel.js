// panel.js — the "Source Sync" DevTools panel: a preview/undo control surface.
//
// IMPORTANT: this panel does NOT run its own chrome.debugger session. The
// live capture engine is devtools.js (loaded once per DevTools window,
// independent of whether this panel is open) — a second `attach` here would
// steal its CDP session (sessions are keyed by tabId in
// background/service-worker.js), and CSS.styleSheetChanged never fires for a
// non-editing session anyway. Instead this panel:
//   - opens a SEPARATE port ("css-sync-preview") that mirrors devtools.js's
//     pending-changes map read-only (relayed by the service worker),
//   - tells devtools.js (via the service worker) to pause its autosave while
//     this panel is open, so the user gets a chance to preview before
//     anything is written, and to resume it on close,
//   - drives the two-phase preview/commit flow and the undo/journal history
//     purely over plain fetch to the local sync server (127.0.0.1:7777).
//
// The old "Verify" feature (re-reading computed styles over the CDP session)
// is intentionally dropped: it required this panel's own attach, which this
// design explicitly avoids. It was unreachable dead code before this rewrite
// (the panel was never registered), so this is a clean removal.

"use strict";

const SERVER_BASE = "http://127.0.0.1:7777";
const tabId = chrome.devtools.inspectedWindow.tabId;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Mirrors devtools.js's pending-changes map: key -> CaptureChange. Display-only. */
const changes = new Map();
/** Mirrors devtools.js's recent skip log. Capped so it can't grow unbounded. */
const MAX_SKIPS = 50;
const skips = [];

let previewBusy = false;
let applyBusy = false;
/** The exact CaptureChange[] the last preview was run against (re-sent on Apply). */
let previewChangesSnapshot = null;

let journalEntries = [];
let journalState = "loading"; // "loading" | "loaded" | "error"
let journalError = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const connectionBadge = $("connection");
const elementBadge = $("element-badge");
const banner = $("banner");
const bannerText = $("banner-text");
const bannerRetryBtn = $("banner-retry");
const emptyState = $("empty-state");
const changeList = $("change-list");
const clearBtn = $("clear-btn");
const previewBtn = $("preview-btn");
const undoBtn = $("undo-btn");
const autosaveBadge = $("autosave-badge");
const settingsBtn = $("settings-btn");
const settingsPopover = $("settings-popover");
const autosaveToggle = $("autosave-toggle");
const shortcutHint = $("shortcut-hint");
const shortcutLink = $("shortcut-link");

const previewArea = $("preview-area");
const previewBody = $("preview-body");
const previewActions = $("preview-actions");
const discardBtn = $("discard-btn");
const applyBtn = $("apply-btn");

const journalLoading = $("journal-loading");
const journalEmpty = $("journal-empty");
const journalList = $("journal-list");
const journalRefreshBtn = $("journal-refresh-btn");

// ---------------------------------------------------------------------------
// Autosave settings (persisted in chrome.storage.local; shared with devtools.js)
// ---------------------------------------------------------------------------

const AUTOSAVE_KEY = "css-sync:autosave";
let autosave = true; // default ON (overwritten by stored pref on load)

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

function renderAutosaveState() {
  autosaveBadge.textContent = autosave ? "autosave on (paused)" : "autosave off";
  autosaveBadge.className = `badge ${autosave ? "badge-on" : "badge-off"}`;
  autosaveBadge.classList.remove("hidden");
  autosaveToggle.checked = autosave;
}

function setAutosave(on) {
  autosave = on;
  renderAutosaveState();
  chrome.storage.local.set({ [AUTOSAVE_KEY]: on });
}

chrome.storage.local.get(AUTOSAVE_KEY, (stored) => {
  const val = stored ? stored[AUTOSAVE_KEY] : undefined;
  autosave = val === undefined ? true : Boolean(val);
  renderAutosaveState();
});

chrome.storage.onChanged.addListener((changed, area) => {
  if (area !== "local" || !changed[AUTOSAVE_KEY]) return;
  autosave = Boolean(changed[AUTOSAVE_KEY].newValue);
  renderAutosaveState();
});

shortcutHint.textContent = IS_MAC ? "⌘⇧S" : "Ctrl+Shift+S";

// --- popover open/close ---
function setPopover(open) {
  settingsPopover.classList.toggle("hidden", !open);
  settingsBtn.setAttribute("aria-expanded", String(open));
}
settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setPopover(settingsPopover.classList.contains("hidden"));
});
document.addEventListener("click", (e) => {
  if (!settingsPopover.contains(e.target) && e.target !== settingsBtn) setPopover(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setPopover(false);
});
autosaveToggle.addEventListener("change", () => setAutosave(autosaveToggle.checked));
shortcutLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// ---------------------------------------------------------------------------
// Preview-mirror port ("css-sync-preview") — read-only relay to devtools.js
// ---------------------------------------------------------------------------

let previewPort = null;
let previewReconnectAttempts = 0;
const MAX_PREVIEW_RECONNECT = 6;

function connectPreviewPort() {
  previewPort = chrome.runtime.connect({ name: "css-sync-preview" });

  previewPort.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "pending-snapshot":
        applySnapshot(msg.changes ?? [], msg.skips ?? []);
        break;
      default:
        break;
    }
  });

  previewPort.onDisconnect.addListener(() => {
    setConnection(false);
    if (previewReconnectAttempts >= MAX_PREVIEW_RECONNECT) {
      showBanner(
        "Lost connection to the extension service worker.",
        "error",
        () => {
          previewReconnectAttempts = 0;
          connectPreviewPort();
        }
      );
      return;
    }
    const delay = Math.min(200 * 2 ** previewReconnectAttempts, 5000); // 200ms → 5s
    previewReconnectAttempts += 1;
    setTimeout(connectPreviewPort, delay);
  });

  previewPort.postMessage({ type: "preview-subscribe", tabId });
  setConnection(true);
  previewReconnectAttempts = 0;
}

connectPreviewPort();

function setConnection(on) {
  connectionBadge.textContent = on ? "connected" : "reconnecting…";
  connectionBadge.className = `badge ${on ? "badge-on" : "badge-off"}`;
}

function applySnapshot(changesArr, skipsArr) {
  changes.clear();
  for (const c of changesArr) changes.set(changeKey(c), c);
  skips.length = 0;
  for (const s of skipsArr) skips.push(s);
  if (skips.length > MAX_SKIPS) skips.splice(0, skips.length - MAX_SKIPS);
  renderChanges();
}

// ---------------------------------------------------------------------------
// Element selection -> ElementContext (local/display only — never sent
// anywhere; this panel has no CDP session of its own to attach it to)
// ---------------------------------------------------------------------------

const SELECTION_EVAL = `(() => {
  const el = typeof $0 !== "undefined" ? $0 : null;
  if (!el || el.nodeType !== 1) return null;
  const ctx = { tagName: el.tagName.toLowerCase(), classList: [...el.classList] };
  const loc = el.__srcLoc;
  if (loc && typeof loc === "object") {
    if (loc.dataSourceFile) ctx.dataSourceFile = loc.dataSourceFile;
    if (Number.isInteger(loc.dataSourceLine) && loc.dataSourceLine > 0) {
      ctx.dataSourceLine = loc.dataSourceLine;
    }
    if (loc.dataSourceComponent) ctx.dataSourceComponent = loc.dataSourceComponent;
  }
  return ctx;
})()`;

function onSelectionChanged() {
  chrome.devtools.inspectedWindow.eval(SELECTION_EVAL, (result, exceptionInfo) => {
    if (exceptionInfo && (exceptionInfo.isError || exceptionInfo.isException)) return;
    renderElementBadge(result ?? null);
  });
}

chrome.devtools.panels.elements.onSelectionChanged.addListener(onSelectionChanged);
onSelectionChanged(); // capture whatever is selected right now

function renderElementBadge(context) {
  if (!context) {
    elementBadge.classList.add("hidden");
    return;
  }
  const cls = context.classList.length ? `.${context.classList.join(".")}` : "";
  const src = context.dataSourceFile
    ? ` — ${context.dataSourceFile}${context.dataSourceLine ? `:${context.dataSourceLine}` : ""}`
    : "";
  elementBadge.textContent = `${context.tagName}${cls}${src}`;
  elementBadge.title = context.dataSourceComponent
    ? `component: ${context.dataSourceComponent}`
    : "selected element";
  elementBadge.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Change list (mirrors devtools.js's pending changes/skips)
// ---------------------------------------------------------------------------

const DOM_OPS = new Set(["set-attr", "remove-attr", "set-text", "set-text-segment"]);
const isDomOp = (c) => DOM_OPS.has(c.op);

// Kept in sync with devtools.js's changeKey (background/diff.js exports no
// shared implementation — see its "no exports" note in the repo history).
function changeKey(c) {
  if (isDomOp(c)) {
    const loc = `${c.element.dataSourceFile}:${c.element.dataSourceLine}`;
    const sub =
      c.op === "set-text"
        ? ""
        : c.op === "set-text-segment"
          ? `seg${c.segmentIndex}`
          : c.attribute;
    return `${c.op}|${loc}|${sub}`;
  }
  if (c.op === "promote-inline-style") {
    return `${c.op}|${c.element.dataSourceFile}:${c.element.dataSourceLine}`;
  }
  const media = c.mediaText ?? "";
  const prop = c.op === "add-rule" ? c.ruleText : c.property;
  return `${c.op}|${c.styleSheet.id}|${media}|${c.selector}|${prop}`;
}

function renderChanges() {
  changeList.textContent = "";
  const has = changes.size > 0 || skips.length > 0;
  emptyState.classList.toggle("hidden", has);
  changeList.classList.toggle("hidden", !has);
  clearBtn.disabled = !has;
  previewBtn.disabled = changes.size === 0 || previewBusy;

  for (const change of changes.values()) {
    const li = document.createElement("li");
    li.className = "change-item";

    const chip = document.createElement("span");
    chip.className = `op-chip op-${change.op}`;
    chip.textContent = change.op;
    li.appendChild(chip);

    if (change.mediaText) {
      const media = document.createElement("span");
      media.className = "media-chip";
      media.textContent = `@media ${change.mediaText}`;
      li.appendChild(media);
    }

    const sel = document.createElement("span");
    sel.className = "change-selector";
    const location = isDomOp(change)
      ? `${change.element.tagName}${
          change.element.classList.length ? "." + change.element.classList.join(".") : ""
        } — ${change.element.dataSourceFile}:${change.element.dataSourceLine}`
      : change.selector;
    sel.textContent = location;
    sel.title = location;
    li.appendChild(sel);

    const detail = document.createElement("span");
    detail.className = "change-detail";
    switch (change.op) {
      case "modify": {
        detail.append(`${change.property}: `);
        const oldSpan = document.createElement("span");
        oldSpan.className = "old-value";
        oldSpan.textContent = change.oldValue;
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.textContent = " → ";
        detail.append(oldSpan, arrow, change.newValue);
        break;
      }
      case "add-decl":
        detail.append(`${change.property}: ${change.newValue}`);
        break;
      case "delete-decl":
        detail.append(change.property);
        break;
      case "add-rule":
        detail.append(change.ruleText);
        detail.title = change.ruleText;
        break;
      case "promote-inline-style":
        detail.append(change.cssText ?? "");
        break;
      case "set-attr":
        detail.append(`${change.attribute}="${change.value}"`);
        break;
      case "remove-attr":
        detail.append(`remove ${change.attribute}`);
        break;
      case "set-text":
      case "set-text-segment": {
        const text = change.newText;
        detail.append(text ?? "");
        detail.title = text ?? "";
        break;
      }
    }
    li.appendChild(detail);
    changeList.appendChild(li);
  }

  for (const skip of skips) {
    const li = document.createElement("li");
    li.className = "change-item skip-item";

    const chip = document.createElement("span");
    chip.className = "op-chip op-skip";
    chip.textContent = "skip";
    li.appendChild(chip);

    const detail = document.createElement("span");
    detail.className = "change-detail";
    detail.textContent = skip.reason;
    detail.title = skip.reason;
    li.appendChild(detail);

    changeList.appendChild(li);
  }
}

clearBtn.addEventListener("click", () => {
  const keys = [...changes.keys()];
  changes.clear();
  skips.length = 0;
  hidePreview();
  renderChanges();
  try {
    previewPort.postMessage({ type: "drop-keys", keys });
  } catch {
    /* port gone; devtools.js will re-sync its own state regardless */
  }
});

// ---------------------------------------------------------------------------
// Banner helper (loading is shown inline on the triggering button instead)
// ---------------------------------------------------------------------------

let bannerTimer;
function showBanner(text, kind /* "info" | "warn" | "error" */, retry) {
  bannerText.textContent = text;
  banner.className = `banner banner-${kind}`;
  banner.classList.remove("hidden");
  if (retry) {
    bannerRetryBtn.classList.remove("hidden");
    bannerRetryBtn.onclick = () => {
      banner.classList.add("hidden");
      retry();
    };
  } else {
    bannerRetryBtn.classList.add("hidden");
    bannerRetryBtn.onclick = null;
  }
  clearTimeout(bannerTimer);
  if (kind === "info") {
    bannerTimer = setTimeout(() => banner.classList.add("hidden"), 6000);
  }
}

function describeFetchError(err, action) {
  if (err instanceof TypeError) {
    return `${action} failed: sync server unreachable at ${SERVER_BASE}. Start it with: pnpm --filter @css-sync/server dev`;
  }
  return `${action} failed: ${err instanceof Error ? err.message : String(err)}`;
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`server returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

function getInspectedUrl() {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval("location.href", (result) => {
      resolve(typeof result === "string" && result ? result : "about:blank");
    });
  });
}

// ---------------------------------------------------------------------------
// Two-phase preview -> apply/discard
// ---------------------------------------------------------------------------

previewBtn.addEventListener("click", () => void doPreview());
discardBtn.addEventListener("click", () => doDiscard());
applyBtn.addEventListener("click", () => void doApply());

function hidePreview() {
  previewChangesSnapshot = null;
  previewArea.classList.add("hidden");
  previewBody.textContent = "";
  previewActions.classList.add("hidden");
}

function doDiscard() {
  hidePreview();
}

async function postApply(payload) {
  return fetchJSON(`${SERVER_BASE}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function doPreview() {
  if (changes.size === 0 || previewBusy) return;
  previewBusy = true;
  const orig = previewBtn.textContent;
  previewBtn.disabled = true;
  previewBtn.innerHTML = '<span class="spinner"></span>Previewing…';
  try {
    const snapshot = [...changes.values()];
    const payload = { url: await getInspectedUrl(), changes: snapshot, applyMode: "preview" };
    const result = await postApply(payload);
    if (
      !result ||
      !Array.isArray(result.applied) ||
      !Array.isArray(result.skipped) ||
      !Array.isArray(result.needsPlacement)
    ) {
      showBanner("Preview failed: server returned a malformed ApplyResult.", "error", doPreview);
      return;
    }
    previewChangesSnapshot = snapshot;
    renderPreview(result);
  } catch (err) {
    showBanner(describeFetchError(err, "Preview"), "error", () => void doPreview());
  } finally {
    previewBusy = false;
    previewBtn.textContent = orig;
    previewBtn.disabled = changes.size === 0;
  }
}

async function doApply() {
  if (!previewChangesSnapshot || applyBusy) return;
  applyBusy = true;
  const origApply = applyBtn.textContent;
  applyBtn.disabled = true;
  discardBtn.disabled = true;
  applyBtn.innerHTML = '<span class="spinner"></span>Applying…';
  try {
    const payload = {
      url: await getInspectedUrl(),
      changes: previewChangesSnapshot,
      applyMode: "commit",
    };
    const result = await postApply(payload);
    if (
      !result ||
      !Array.isArray(result.applied) ||
      !Array.isArray(result.skipped) ||
      !Array.isArray(result.needsPlacement)
    ) {
      showBanner("Apply failed: server returned a malformed ApplyResult.", "error", () => void doApply());
      return;
    }
    if (!result.committed) {
      showBanner(
        "Server did not confirm the commit (committed: false) — nothing was written. Try Preview again.",
        "warn"
      );
      return;
    }

    // Drop applied entries from our mirror and tell devtools.js to drop them
    // too, so they don't get resurrected by the next pending-snapshot.
    const appliedKeys = result.applied.map((o) => changeKey(o.change));
    for (const key of appliedKeys) changes.delete(key);
    renderChanges();
    try {
      previewPort.postMessage({ type: "drop-keys", keys: appliedKeys });
    } catch {
      /* port gone; devtools.js will re-sync regardless */
    }

    hidePreview();

    showBanner(
      `Applied ${result.applied.length} change${result.applied.length === 1 ? "" : "s"}` +
        (result.skipped.length ? `, ${result.skipped.length} skipped` : "") +
        ".",
      result.skipped.length ? "warn" : "info"
    );
    await loadJournal();
  } catch (err) {
    showBanner(describeFetchError(err, "Apply"), "error", () => void doApply());
  } finally {
    applyBusy = false;
    applyBtn.textContent = origApply;
    discardBtn.disabled = false;
    applyBtn.disabled = changes.size === 0;
  }
}

function confidenceBadge(confidence, reason) {
  const span = document.createElement("span");
  const dot = document.createElement("span");
  dot.className = "confidence-dot";
  const label =
    confidence === "deterministic"
      ? "deterministic"
      : confidence === "assisted"
        ? "assisted — check diff"
        : confidence === "fallback"
          ? "fallback — check diff"
          : confidence;
  span.className = `confidence-badge confidence-${confidence ?? "deterministic"}`;
  span.append(dot, document.createTextNode(label));
  if (reason) span.title = reason;
  return span;
}

function renderDiff(unified) {
  const pre = document.createElement("pre");
  pre.className = "diff-view";
  const lines = String(unified).split("\n");
  for (const line of lines) {
    const span = document.createElement("span");
    if (line.startsWith("+") && !line.startsWith("+++")) span.className = "diff-add";
    else if (line.startsWith("-") && !line.startsWith("---")) span.className = "diff-del";
    else if (line.startsWith("@@")) span.className = "diff-hunk";
    else span.className = "diff-ctx";
    span.textContent = line;
    pre.appendChild(span);
  }
  return pre;
}

function renderOutcome(o) {
  const div = document.createElement("div");
  div.className = "preview-outcome";
  const head = document.createElement("div");
  head.className = "preview-outcome-head";

  const fileSpan = document.createElement("span");
  fileSpan.className = "preview-file";
  const where = o.line ? `${o.file}:${o.line}` : o.file;
  fileSpan.textContent = `${where}${o.mode ? ` [${o.mode}]` : ""}`;
  fileSpan.title = where;
  head.appendChild(fileSpan);
  head.appendChild(confidenceBadge(o.confidence, o.confidenceReason));
  div.appendChild(head);

  if (o.diff && o.diff.unified) {
    div.appendChild(renderDiff(o.diff.unified));
  } else if (o.note) {
    const note = document.createElement("p");
    note.className = "result-note";
    note.textContent = o.note;
    div.appendChild(note);
  }
  return div;
}

function renderSkipped(s) {
  const div = document.createElement("div");
  div.className = "preview-outcome";
  const head = document.createElement("div");
  head.className = "preview-outcome-head";

  const fileSpan = document.createElement("span");
  fileSpan.className = "preview-file";
  fileSpan.textContent =
    s.change?.selector ?? (s.change?.element ? `${s.change.element.tagName}` : "change");
  head.appendChild(fileSpan);

  const badge = document.createElement("span");
  badge.className = "confidence-badge confidence-skipped";
  const dot = document.createElement("span");
  dot.className = "confidence-dot";
  badge.append(dot, document.createTextNode("skipped"));
  badge.title = s.reason;
  head.appendChild(badge);
  div.appendChild(head);

  const note = document.createElement("p");
  note.className = "result-note";
  note.textContent = s.reason;
  div.appendChild(note);
  return div;
}

function renderNeedsPlacement(c) {
  const div = document.createElement("div");
  div.className = "preview-outcome";
  const p = document.createElement("p");
  p.className = "result-note";
  p.textContent = c.op === "add-rule" ? c.ruleText : `${c.selector} { ${c.property ?? ""} }`;
  div.appendChild(p);
  return div;
}

function renderPreview(result) {
  previewBody.textContent = "";
  previewArea.classList.remove("hidden");

  const group = (title, cls, items, renderItem) => {
    if (items.length === 0) return;
    const div = document.createElement("div");
    div.className = "result-group";
    const h = document.createElement("h3");
    h.className = cls;
    h.textContent = `${title} (${items.length})`;
    div.appendChild(h);
    for (const item of items) div.appendChild(renderItem(item));
    previewBody.appendChild(div);
  };

  group("Would apply", "ok", result.applied, renderOutcome);
  group("Skipped", "warn", result.skipped, renderSkipped);
  group("Needs placement", "err", result.needsPlacement, renderNeedsPlacement);

  if (previewBody.children.length === 0) {
    const p = document.createElement("p");
    p.className = "result-note";
    p.textContent = "Nothing to preview — the server would apply no changes.";
    previewBody.appendChild(p);
  }

  previewActions.classList.remove("hidden");
  applyBtn.classList.toggle("hidden", result.applied.length === 0);
  applyBtn.disabled = false;
  discardBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Undo + journal (sync history)
// ---------------------------------------------------------------------------

undoBtn.addEventListener("click", () => void undoLast());
journalRefreshBtn.addEventListener("click", () => void loadJournal());

function handleUndoResult(result) {
  const revertedN = result?.reverted?.length ?? 0;
  const skipped = result?.skipped ?? [];
  if (skipped.length > 0) {
    const lines = skipped.map((s) => `${s.file}: ${s.reason}`).join("; ");
    showBanner(
      `Undo: reverted ${revertedN}, but ${skipped.length} skipped (drift detected since applying — the file changed since) — ${lines}`,
      "warn"
    );
  } else if (revertedN > 0) {
    showBanner(`Undo: reverted ${revertedN} change${revertedN === 1 ? "" : "s"}.`, "info");
  } else {
    showBanner("Nothing to undo.", "info");
  }
}

async function undoLast() {
  if (undoBtn.disabled) return;
  undoBtn.disabled = true;
  const orig = undoBtn.textContent;
  undoBtn.innerHTML = '<span class="spinner"></span>Undoing…';
  try {
    const result = await fetchJSON(`${SERVER_BASE}/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    handleUndoResult(result);
  } catch (err) {
    showBanner(describeFetchError(err, "Undo"), "error", () => void undoLast());
  } finally {
    undoBtn.disabled = false;
    undoBtn.textContent = orig;
    await loadJournal();
  }
}

async function undoEntry(id, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const result = await fetchJSON(`${SERVER_BASE}/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    handleUndoResult(result);
  } catch (err) {
    showBanner(describeFetchError(err, "Undo"), "error", () => void undoEntry(id, btn));
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
    await loadJournal();
  }
}

function formatEntryTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderJournal() {
  journalLoading.classList.toggle("hidden", journalState !== "loading");
  journalEmpty.classList.toggle("hidden", !(journalState === "loaded" && journalEntries.length === 0));
  journalList.classList.toggle("hidden", !(journalState === "loaded" && journalEntries.length > 0));

  if (journalState !== "loaded") return;
  journalList.textContent = "";
  for (const entry of journalEntries) {
    const li = document.createElement("li");
    li.className = "journal-item";

    const fileSpan = document.createElement("span");
    fileSpan.className = "journal-file";
    const where = entry.line ? `${entry.file}:${entry.line}` : entry.file;
    fileSpan.textContent = where;
    fileSpan.title = where;
    li.appendChild(fileSpan);

    li.appendChild(confidenceBadge(entry.confidence, entry.confidenceReason));

    const timeSpan = document.createElement("span");
    timeSpan.className = "journal-time";
    timeSpan.textContent = formatEntryTime(entry.at ?? entry.timestamp);
    li.appendChild(timeSpan);

    const undoEntryBtn = document.createElement("button");
    undoEntryBtn.type = "button";
    undoEntryBtn.className = "journal-undo-btn";
    undoEntryBtn.textContent = "Undo";
    undoEntryBtn.addEventListener("click", () => void undoEntry(entry.id, undoEntryBtn));
    li.appendChild(undoEntryBtn);

    journalList.appendChild(li);
  }
}

async function loadJournal() {
  journalState = "loading";
  journalError = null;
  renderJournal();
  try {
    const data = await fetchJSON(`${SERVER_BASE}/journal?limit=20`);
    journalEntries = Array.isArray(data?.entries) ? data.entries : [];
    journalState = "loaded";
    renderJournal();
  } catch (err) {
    journalState = "error";
    journalError = err;
    renderJournal();
    showBanner(describeFetchError(err, "Loading sync history"), "error", () => void loadJournal());
  }
}

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

renderChanges();
hidePreview();
void loadJournal();
