// panel.js — "Source Sync" DevTools panel UI.
// Talks to background/service-worker.js over a long-lived port (CDP capture)
// and to the local sync server over fetch (127.0.0.1:7777 only).

"use strict";

const SERVER_BASE = "http://127.0.0.1:7777";
const tabId = chrome.devtools.inspectedWindow.tabId;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Deduped captured changes: key -> CaptureChange (latest wins, oldValue kept). */
const changes = new Map();
/** Visible skip log for DOM mutations we could not locate in source
 * (no data-source-file/line) — surfaced, never a silent drop. Capped so a
 * chatty page can't grow the panel unbounded. */
const MAX_SKIPS = 50;
const skips = [];
let attached = false;
let syncing = false;
let lastApplied = []; // ApplyOutcome[] from the last successful sync (for Verify)
let computedRequestSeq = 0;
const pendingComputed = new Map(); // requestId -> {resolve, reject}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const connectionBadge = $("connection");
const elementBadge = $("element-badge");
const banner = $("banner");
const emptyState = $("empty-state");
const changeList = $("change-list");
const clearBtn = $("clear-btn");
const syncBtn = $("sync-btn");
const verifyBtn = $("verify-btn");
const resultArea = $("result-area");
const resultBody = $("result-body");
const autosaveBadge = $("autosave-badge");
const settingsBtn = $("settings-btn");
const settingsPopover = $("settings-popover");
const autosaveToggle = $("autosave-toggle");
const shortcutHint = $("shortcut-hint");
const shortcutLink = $("shortcut-link");

// ---------------------------------------------------------------------------
// Autosave settings (persisted in chrome.storage.local)
// ---------------------------------------------------------------------------

const AUTOSAVE_KEY = "css-sync:autosave";
const AUTOSAVE_DEBOUNCE_MS = 700;
let autosave = true; // default ON (overwritten by stored pref on load)
let autosaveTimer = null;

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

function renderAutosaveState() {
  autosaveBadge.textContent = autosave ? "autosave on" : "autosave off";
  autosaveBadge.className = `badge ${autosave ? "badge-on" : "badge-off"}`;
  autosaveBadge.classList.remove("hidden");
  autosaveToggle.checked = autosave;
}

function setAutosave(on) {
  autosave = on;
  renderAutosaveState();
  chrome.storage.local.set({ [AUTOSAVE_KEY]: on });
  if (!on && autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

function scheduleAutosave() {
  if (!autosave) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void syncToSource({ auto: true, toast: true });
  }, AUTOSAVE_DEBOUNCE_MS);
}

// Load the stored preference (default ON) before wiring the toggle.
chrome.storage.local.get(AUTOSAVE_KEY, (stored) => {
  const val = stored ? stored[AUTOSAVE_KEY] : undefined;
  autosave = val === undefined ? true : Boolean(val);
  renderAutosaveState();
});

// Keep in sync when the toolbar popup (or another panel) flips the pref.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[AUTOSAVE_KEY]) return;
  autosave = Boolean(changes[AUTOSAVE_KEY].newValue);
  renderAutosaveState();
  if (!autosave && autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
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
  // Opens Chrome's shortcut editor so the user can rebind `sync-now`.
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// ---------------------------------------------------------------------------
// Service-worker port
// ---------------------------------------------------------------------------

const port = chrome.runtime.connect({ name: "css-sync-panel" });

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "attached":
      attached = true;
      setConnection(true);
      showBanner(
        "Capturing. Chrome shows a yellow debugging banner on the tab while attached — that's expected.",
        "info"
      );
      break;

    case "attach-failed":
      attached = false;
      setConnection(false);
      // Most common cause: another chrome.debugger extension already attached.
      showBanner(`Could not attach debugger: ${msg.message}`, "error");
      break;

    case "detached":
      attached = false;
      setConnection(false);
      showBanner(
        `Debugger detached (${msg.reason}). Reopen the panel or reload to re-attach.`,
        "warn"
      );
      break;

    case "change":
      addChange(msg.change);
      break;

    case "run-sync":
      // Keyboard shortcut relayed by the service worker.
      void syncToSource({ toast: true, source: msg.source });
      break;

    case "skip":
      addSkip(msg.reason);
      break;

    case "element-context":
      renderElementBadge(msg.context);
      break;

    case "cdp-error":
      showBanner(`CDP error (${msg.context}): ${msg.message}`, "error");
      break;

    case "computed-result": {
      const pending = pendingComputed.get(msg.requestId);
      if (!pending) break;
      pendingComputed.delete(msg.requestId);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.checks);
      break;
    }

    default:
      break;
  }
});

port.onDisconnect.addListener(() => {
  attached = false;
  setConnection(false);
  showBanner("Lost connection to the extension service worker.", "error");
});

port.postMessage({ type: "attach", tabId });

// ---------------------------------------------------------------------------
// Element selection -> ElementContext
// ---------------------------------------------------------------------------

// Marks $0 for the content script AND extracts a fallback context in one eval.
const SELECTION_EVAL = `(() => {
  for (const el of document.querySelectorAll("[data-css-sync-inspected]")) {
    el.removeAttribute("data-css-sync-inspected");
  }
  const el = typeof $0 !== "undefined" ? $0 : null;
  if (!el || el.nodeType !== 1) return null;
  el.setAttribute("data-css-sync-inspected", "");
  const line = parseInt(el.getAttribute("data-source-line") || "", 10);
  const ctx = { tagName: el.tagName.toLowerCase(), classList: [...el.classList] };
  const file = el.getAttribute("data-source-file");
  if (file) ctx.dataSourceFile = file;
  if (Number.isInteger(line) && line > 0) ctx.dataSourceLine = line;
  const comp = el.getAttribute("data-source-component");
  if (comp) ctx.dataSourceComponent = comp;
  return ctx;
})()`;

function onSelectionChanged() {
  chrome.devtools.inspectedWindow.eval(SELECTION_EVAL, (result, exceptionInfo) => {
    if (exceptionInfo && (exceptionInfo.isError || exceptionInfo.isException)) {
      showBanner(
        `Could not read selected element: ${exceptionInfo.value ?? exceptionInfo.description ?? "eval failed"}`,
        "warn"
      );
      return;
    }
    // SW prefers the content script's read; `result` is the fallback context.
    port.postMessage({ type: "element-selected", context: result ?? null });
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
// Change list
// ---------------------------------------------------------------------------

const DOM_OPS = new Set(["set-attr", "remove-attr", "set-text"]);
const isDomOp = (c) => DOM_OPS.has(c.op);

function changeKey(c) {
  if (isDomOp(c)) {
    // DOM ops have no stylesheet/selector — key off the source location +
    // (for attrs) the attribute name, so successive edits of the same
    // attribute/text node collapse to one pending change.
    const loc = `${c.element.dataSourceFile}:${c.element.dataSourceLine}`;
    const sub = c.op === "set-text" ? "" : c.attribute;
    return `${c.op}|${loc}|${sub}`;
  }
  const media = c.mediaText ?? "";
  const prop = c.op === "add-rule" ? c.ruleText : c.property;
  return `${c.op}|${c.styleSheet.id}|${media}|${c.selector}|${prop}`;
}

function addSkip(reason) {
  skips.push({ reason, at: Date.now() });
  if (skips.length > MAX_SKIPS) skips.shift();
  renderChanges();
}

function addChange(change) {
  const key = changeKey(change);

  if (change.op === "modify") {
    // Collapse successive edits of the same declaration: keep the FIRST
    // oldValue (true original) and the LATEST newValue.
    const prior = changes.get(key);
    if (prior && prior.op === "modify") change = { ...change, oldValue: prior.oldValue };
    if (change.oldValue === change.newValue) {
      changes.delete(key); // edited back to the original — nothing to sync
      renderChanges();
      return;
    }
  }

  changes.set(key, change);
  renderChanges();
  scheduleAutosave();
}

function renderChanges() {
  changeList.textContent = "";
  const has = changes.size > 0 || skips.length > 0;
  emptyState.classList.toggle("hidden", has);
  changeList.classList.toggle("hidden", !has);
  clearBtn.disabled = !has;
  syncBtn.disabled = changes.size === 0 || syncing;
  verifyBtn.disabled = lastApplied.length === 0;

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
      case "set-attr":
        detail.append(`${change.attribute}="${change.value}"`);
        break;
      case "remove-attr":
        detail.append(`remove ${change.attribute}`);
        break;
      case "set-text": {
        const text = change.newText;
        detail.append(text);
        detail.title = text;
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
  changes.clear();
  skips.length = 0;
  lastApplied = [];
  resultArea.classList.add("hidden");
  renderChanges();
});

// ---------------------------------------------------------------------------
// Banner helper
// ---------------------------------------------------------------------------

let bannerTimer;
function showBanner(text, kind /* "info" | "warn" | "error" */) {
  banner.textContent = text;
  banner.className = `banner banner-${kind}`;
  clearTimeout(bannerTimer);
  if (kind === "info") {
    bannerTimer = setTimeout(() => banner.classList.add("hidden"), 6000);
  }
}

function setConnection(on) {
  connectionBadge.textContent = on ? "capturing" : "detached";
  connectionBadge.className = `badge ${on ? "badge-on" : "badge-off"}`;
}

// ---------------------------------------------------------------------------
// Sync -> POST CapturePayload to /apply, render ApplyResult
// ---------------------------------------------------------------------------

function getInspectedUrl() {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval("location.href", (result) => {
      resolve(typeof result === "string" && result ? result : "about:blank");
    });
  });
}

syncBtn.addEventListener("click", () => void syncToSource());

async function syncToSource(opts = {}) {
  const { auto = false, toast = false } = opts;
  if (syncing || changes.size === 0) return;
  syncing = true;
  const originalLabel = syncBtn.textContent;
  syncBtn.disabled = true;
  syncBtn.innerHTML = '<span class="spinner"></span>Syncing…';

  try {
    /** @type {import("@css-sync/contract").CapturePayload} */
    const payload = {
      url: await getInspectedUrl(),
      changes: [...changes.values()],
    };

    let res;
    try {
      res = await fetch(`${SERVER_BASE}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      showBanner(
        `Sync server unreachable at ${SERVER_BASE}. Start it with: pnpm --filter @css-sync/server dev`,
        "error"
      );
      return;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      showBanner(`Server error ${res.status}: ${body.slice(0, 300)}`, "error");
      return;
    }

    /** @type {import("@css-sync/contract").ApplyResult} */
    const result = await res.json();
    if (
      !result ||
      !Array.isArray(result.applied) ||
      !Array.isArray(result.skipped) ||
      !Array.isArray(result.needsPlacement)
    ) {
      showBanner("Server returned a malformed ApplyResult.", "error");
      return;
    }

    lastApplied = result.applied;
    renderApplyResult(result);

    // Applied changes are now in source; drop them from the pending list.
    const appliedKeys = new Set(result.applied.map((o) => changeKey(o.change)));
    for (const key of [...changes.keys()]) {
      if (appliedKeys.has(key)) changes.delete(key);
    }
    renderChanges();

    // In-page toast for autosave / shortcut (panel banner would be off-screen).
    if (toast) {
      port.postMessage({
        type: "show-toast",
        applied: result.applied.map((o) => ({ file: o.file })),
        skipped: result.skipped.length,
      });
    }
    // The toast already reports auto/shortcut runs; only banner manual syncs
    // (and always banner when something needs attention).
    if (!auto || result.skipped.length > 0 || result.needsPlacement.length > 0) {
      showBanner(
        `Sync complete: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.needsPlacement.length} need placement.`,
        result.skipped.length > 0 || result.needsPlacement.length > 0 ? "warn" : "info"
      );
    }
  } finally {
    syncing = false;
    syncBtn.textContent = originalLabel;
    syncBtn.disabled = changes.size === 0;
  }
}

function renderApplyResult(result) {
  resultBody.textContent = "";

  const group = (title, cls, items, renderItem) => {
    if (items.length === 0) return;
    const div = document.createElement("div");
    div.className = "result-group";
    const h = document.createElement("h3");
    h.className = cls;
    h.textContent = `${title} (${items.length})`;
    div.appendChild(h);
    const ul = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      renderItem(li, item);
      ul.appendChild(li);
    }
    div.appendChild(ul);
    resultBody.appendChild(div);
  };

  group("Applied", "ok", result.applied, (li, o) => {
    const where = o.line ? `${o.file}:${o.line}` : o.file;
    li.textContent = `${o.change.selector} — ${where} [${o.mode}]`;
    if (o.note) {
      const note = document.createElement("span");
      note.className = "result-note";
      note.textContent = ` (${o.note})`;
      li.appendChild(note);
    }
  });

  group("Skipped", "warn", result.skipped, (li, s) => {
    li.textContent = `${s.change.selector} — ${s.reason}`;
  });

  group("Needs placement", "err", result.needsPlacement, (li, c) => {
    li.textContent =
      c.op === "add-rule" ? c.ruleText : `${c.selector} { ${c.property ?? ""} }`;
  });

  if (resultBody.children.length === 0) {
    const p = document.createElement("p");
    p.className = "result-note";
    p.textContent = "Server applied nothing (empty result).";
    resultBody.appendChild(p);
  }
  resultArea.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Verify -> re-read computed styles via CDP, POST VerifyRequest to /verify
// ---------------------------------------------------------------------------

verifyBtn.addEventListener("click", () => void verifyApplied());

function requestComputed(checks) {
  return new Promise((resolve, reject) => {
    const requestId = ++computedRequestSeq;
    pendingComputed.set(requestId, { resolve, reject });
    port.postMessage({ type: "get-computed", requestId, checks });
    setTimeout(() => {
      if (pendingComputed.delete(requestId)) {
        reject(new Error("Timed out reading computed styles"));
      }
    }, 10_000);
  });
}

async function verifyApplied() {
  if (lastApplied.length === 0) return;
  if (!attached) {
    showBanner("Cannot verify: debugger is detached.", "error");
    return;
  }

  // Build expected checks from what the server said it applied.
  const wanted = lastApplied
    .map((o) => o.change)
    .filter((c) => c.op === "modify" || c.op === "add-decl")
    .map((c) => ({ selector: c.selector, property: c.property, expected: c.newValue }));
  if (wanted.length === 0) {
    showBanner("Nothing verifiable in the last sync (only deletes/new rules).", "warn");
    return;
  }

  verifyBtn.disabled = true;
  verifyBtn.innerHTML = '<span class="spinner"></span>Verifying…';
  try {
    const checks = await requestComputed(wanted); // VerifyCheck[] with `actual`

    /** @type {import("@css-sync/contract").VerifyRequest} */
    const verifyRequest = { url: await getInspectedUrl(), checks };
    let res;
    try {
      res = await fetch(`${SERVER_BASE}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(verifyRequest),
      });
    } catch {
      showBanner(`Sync server unreachable at ${SERVER_BASE} for /verify.`, "error");
      return;
    }
    if (!res.ok) {
      showBanner(`Verify failed: server returned ${res.status}.`, "error");
      return;
    }

    /** @type {import("@css-sync/contract").VerifyResult} */
    const verdict = await res.json();
    if (verdict.ok) {
      showBanner(`Verify OK: all ${checks.length} checks match computed styles.`, "info");
    } else {
      const lines = (verdict.mismatches ?? [])
        .map((m) => `${m.selector} ${m.property}: expected "${m.expected}", got "${m.actual}"`)
        .join("; ");
      showBanner(`Verify found ${verdict.mismatches.length} mismatch(es): ${lines}`, "warn");
    }
  } catch (err) {
    showBanner(`Verify error: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    verifyBtn.textContent = "Verify";
    verifyBtn.disabled = lastApplied.length === 0;
  }
}

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

renderChanges();
