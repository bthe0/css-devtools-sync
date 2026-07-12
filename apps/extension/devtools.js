// devtools.js — headless capture client, loaded as the `devtools_page`.
//
// Runs once per DevTools window, for the whole time DevTools is open on the
// inspected tab — with NO panel and no user interaction. It:
//   1. attaches the CDP capture engine (service worker) the moment DevTools opens,
//   2. tracks the element selected in the Elements panel,
//   3. debounces captured CSS/DOM edits and autosaves them to source, and
//   4. shows an in-page toast (via the content script) on each save.
//
// The "Source Sync" panel (panel.html/panel.js) is registered below and reads
// this context's pending-changes map over a SEPARATE port
// ("dev-sync-preview") — it never re-attaches its own chrome.debugger session
// (that would steal this one; sessions are keyed by tabId). While the panel is
// open, autosave here pauses (captured edits still accumulate) so the user can
// preview/apply/discard instead of edits silently auto-committing underneath
// them; closing the panel resumes autosave and flushes anything pending.

"use strict";

import {
  diffSheet,
  buildPromoteInlineStyleChange,
  buildSetTextChange,
  buildSetTextSegmentChange,
  buildSetAttrChange,
  buildRemoveAttrChange,
  resolveTextSegmentEdit,
} from "./background/diff.js";

// The apply engine is mounted on the inspected page's OWN dev server under this
// prefix (Vite `server.middlewares.use("/__dev-sync", …)`), so requests are
// same-origin — no separate port, no CORS. Resolve the origin per-call so it
// stays correct across in-page navigations.
const MOUNT_PREFIX = "/__dev-sync";
const tabId = chrome.devtools.inspectedWindow.tabId;

/** Resolve the inspected page's origin via the DevTools eval bridge. */
function inspectedOrigin() {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval("location.origin", (result, exc) => {
      if (exc || typeof result !== "string" || !result) {
        reject(new Error("could not resolve inspected page origin"));
        return;
      }
      resolve(result);
    });
  });
}

/** Base URL of the embedded apply engine on the inspected page's origin. */
async function syncBase() {
  return `${await inspectedOrigin()}${MOUNT_PREFIX}`;
}

// Only localhost dev servers carry the apply engine. The CDP-attach permission
// is browser-wide (not gated by host_permissions), so without this check every
// tab that opens DevTools would get attached — plus Chrome's yellow "started
// inspecting this browser" banner — even on google.com. Mirror the manifest
// content_scripts matches: http(s) on localhost / 127.0.0.1.
function isDevHost(origin) {
  try {
    const u = new URL(origin);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Deduped captured changes: key -> CaptureChange (latest wins, oldValue kept). */
const changes = new Map();
/**
 * Element source locations (`file:line`) whose text the server refused to sync
 * as set-text — because the JSX child is dynamic/mixed ({expr} or nested tags),
 * NOT a single static run. Such elements re-render their textContent on their
 * own (counters, clocks, interpolated values), which the text poller would
 * otherwise re-emit as a set-text every tick → a permanent "N skipped" toast
 * loop. Once the server rejects one, we stop polling its text for the session.
 */
const suppressedSetText = new Set();
/**
 * Element attribute locations (`file:line|attr`) whose set-attr/remove-attr the
 * server refused (dynamic JSX expression value) — same churn guard as
 * suppressedSetText, one entry per attribute. Once rejected, the attribute
 * poller stops re-emitting it.
 */
const suppressedSetAttr = new Set();
/**
 * Element static-run locations (`file:line#renderIndex`) whose text node the
 * local aligner resolved to a DYNAMIC {expr} hole — editing the rendered value
 * there must never rewrite the expression. A dynamic node re-renders every tick
 * (counter/clock), so without this guard the poller would re-`/describe` it
 * forever. Once classified dynamic, its render position stops driving segment
 * resolution for the session.
 */
const suppressedTextSegment = new Set();
/**
 * Element locations (`file:line`) with an in-flight `/describe` round-trip, so
 * the interval poller never fires a second describe for the same element while
 * the first is still resolving.
 */
const describeInflight = new Set();
/**
 * The element currently selected in the Elements panel, as an ElementContext
 * (tagName + classList + off-DOM __srcLoc when instrumented). Attached to CSS
 * changes so the server can resolve className edits (Tailwind) and
 * styled-components templates (via the element's displayName class) — those
 * tiers key off the element, not the stylesheet. Updated on every selection
 * change; null before the first selection is read.
 */
let selectedElement = null;
let attached = false;
let syncing = false;

/**
 * Recent skipped/rejected capture attempts, newest last — mirrored to the
 * Source Sync panel (display-only there) via postPendingSnapshot(). Capped so
 * a churny dynamic element can't grow this without bound.
 */
const skips = [];
const MAX_SKIPS = 50;

/** True while the Source Sync panel is open for this tab — pauses autosave. */
let pausedForPanel = false;

// ---------------------------------------------------------------------------
// Autosave preference (shared with the toolbar popup via chrome.storage.local)
// ---------------------------------------------------------------------------

const AUTOSAVE_KEY = "dev-sync:autosave";
const AUTOSAVE_DEBOUNCE_MS = 700;
let autosave = true; // default ON (overwritten by the stored pref on load)
let autosaveTimer = null;

chrome.storage.local.get(AUTOSAVE_KEY, (stored) => {
  const val = stored ? stored[AUTOSAVE_KEY] : undefined;
  autosave = val === undefined ? true : Boolean(val);
});

chrome.storage.onChanged.addListener((changed, area) => {
  if (area !== "local" || !changed[AUTOSAVE_KEY]) return;
  autosave = Boolean(changed[AUTOSAVE_KEY].newValue);
  if (!autosave && autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  // Autosave ON dismisses the pending status (the timer will flush); OFF with
  // edits already captured surfaces the waiting-count immediately.
  notifyPending();
});

function scheduleAutosave() {
  if (!autosave || pausedForPanel) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void syncToSource({ auto: true, toast: true });
  }, AUTOSAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// In-page feedback (relayed through the service worker to the content script)
// ---------------------------------------------------------------------------

/** Autosave summary toast ("✓ Autosaved 2 changes → file.tsx"). */
function toastSummary(applied, skipped) {
  try {
    port.postMessage({
      type: "show-toast",
      applied: applied.map((o) => ({ file: o.file })),
      skipped,
    });
  } catch {
    // Port gone; nothing to toast to.
  }
}

/** Raw message toast — used for errors the user should see in the page. */
function toastRaw(text, kind /* "info" | "warn" */) {
  try {
    port.postMessage({ type: "toast", text, kind });
  } catch {
    /* port gone */
  }
}

// A broken/absent engine would fire the SAME warning on every autosave tick
// (and every poll-driven retry) — flooding the page. Show a given error at
// most once per cooldown window; a successful sync forgets it, so a fresh
// failure notifies again.
const ERROR_TOAST_COOLDOWN_MS = 15000;
let lastErrorKey = null;
let lastErrorAt = 0;

/** Deduped, human error toast. `key` collapses repeats; `text` is user-facing. */
function toastError(key, text) {
  const now = Date.now();
  if (key === lastErrorKey && now - lastErrorAt < ERROR_TOAST_COOLDOWN_MS) return;
  lastErrorKey = key;
  lastErrorAt = now;
  toastRaw(text, "warn");
}

/** Forget the last error so the next failure of any kind re-notifies. */
function clearErrorToast() {
  lastErrorKey = null;
  lastErrorAt = 0;
}

/** Map an /apply HTTP status to a human, actionable message (never a raw code). */
function engineErrorMessage(status) {
  if (status === 404)
    return "dev-sync: engine isn't mounted on this page — add devSync() to your Vite config.";
  if (status === 400 || status === 422)
    return "dev-sync: couldn't apply this edit — it's not a change the engine can map to source.";
  if (status === 401 || status === 403)
    return "dev-sync: the engine refused this request — check its token/EXTENSION_ID.";
  if (status === 413) return "dev-sync: that change is too large for the engine to apply.";
  if (status >= 500) return "dev-sync: the engine hit an error — check the dev-server terminal.";
  return `dev-sync: the engine returned ${status}.`;
}

// ---------------------------------------------------------------------------
// HUD connection status — drives the in-page badge color.
//   green: engine reachable, idle/healthy   yellow: reachable but last edit
//   errored/skipped   red: engine unreachable / not mounted
// Yellow is latched by a real edit failure and only cleared by a clean apply,
// so a health ping never paints over a problem the user should see.
// ---------------------------------------------------------------------------

let hudStatus = "idle";
function setStatus(state) {
  if (state === hudStatus) return;
  hudStatus = state;
  try {
    port.postMessage({ type: "status", state });
  } catch {
    /* port gone */
  }
}

const HEALTH_POLL_MS = 5000;
async function checkHealth() {
  let base;
  try {
    base = await syncBase();
  } catch {
    setStatus("red");
    return;
  }
  try {
    // /journal is a side-effect-free GET on the same mount as /apply — a clean
    // liveness probe (404 = engine not mounted on this origin).
    const res = await fetch(`${base}/journal?limit=1`, { method: "GET" });
    if (!res.ok) {
      setStatus(res.status === 404 ? "red" : "yellow");
      return;
    }
    // Reachable + healthy. Don't stomp a yellow the user still needs to see —
    // only a successful apply clears that.
    if (hudStatus === "red" || hudStatus === "idle") setStatus("green");
  } catch {
    setStatus("red");
  }
}
setInterval(() => void checkHealth(), HEALTH_POLL_MS);
void checkHealth();

/**
 * Persistent "N changes waiting for save" status, shown in the page ONLY when
 * autosave is off and the Source Sync panel isn't open (the panel already
 * shows the count itself — a toast would be redundant). Relayed as a singleton
 * status the content script updates in place, so it never stacks per change.
 * Posting count 0 dismisses it.
 */
function notifyPending() {
  if (autosave || pausedForPanel) {
    pushPendingCount(0);
    return;
  }
  pushPendingCount(changes.size);
}

function pushPendingCount(count) {
  try {
    port.postMessage({ type: "pending-count", count });
  } catch {
    /* port gone */
  }
}

/**
 * Mirrors the current pending-changes map (+ recent skips) to the service
 * worker, which relays it to any open Source Sync panel for this tab (see
 * "dev-sync-preview" in background/service-worker.js). Called after every
 * mutation to `changes`/`skips` so the panel's read-only view stays live.
 */
function postPendingSnapshot() {
  try {
    port.postMessage({
      type: "pending-snapshot",
      changes: [...changes.values()],
      skips: [...skips],
    });
  } catch {
    /* port gone; the panel will re-sync on reconnect via preview-subscribe */
  }
}

/** Records a rejected/skipped capture attempt for the panel's history view. */
function addSkip(reason, detail) {
  skips.push({ reason, detail: detail ?? null, at: Date.now() });
  if (skips.length > MAX_SKIPS) skips.splice(0, skips.length - MAX_SKIPS);
  postPendingSnapshot();
}

// ---------------------------------------------------------------------------
// Service-worker port (CDP capture engine)
// ---------------------------------------------------------------------------

// A MV3 service worker can be killed while idle; the port drops with it. In
// headless mode there is no panel to reopen, so we transparently reconnect and
// re-attach — otherwise a SW restart would silently stop capture forever.
let port = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 6;

function connectPort() {
  port = chrome.runtime.connect({ name: "dev-sync-panel" });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "attached":
        attached = true;
        reconnectAttempts = 0; // healthy again — reset backoff
        break;

      case "attach-failed":
        attached = false;
        // Most common cause: another chrome.debugger extension already attached.
        console.warn(`[dev-sync] could not attach debugger: ${msg.message}`);
        toastRaw(`CSS Sync: could not attach — ${msg.message}`, "warn");
        break;

      case "detached":
        attached = false;
        console.warn(`[dev-sync] debugger detached (${msg.reason})`);
        break;

      case "change":
        addChange(msg.change);
        break;

      case "run-sync":
        // Keyboard shortcut / toolbar "Sync now" relayed by the service worker.
        void syncToSource({ toast: true });
        break;

      case "cdp-error":
        console.warn(`[dev-sync] CDP error (${msg.context}): ${msg.message}`);
        break;

      case "skip":
        addSkip(msg.reason ?? "unknown", msg.detail);
        break;

      case "panel-open":
        // Source Sync panel opened — pause autosave so captured edits wait for
        // an explicit Preview/Apply instead of auto-committing underneath the
        // user while they're looking at the panel.
        pausedForPanel = true;
        if (autosaveTimer) {
          clearTimeout(autosaveTimer);
          autosaveTimer = null;
        }
        postPendingSnapshot(); // panel just subscribed — send it the current state
        notifyPending(); // panel now owns the count display — hide the in-page one
        break;

      case "panel-closed":
        // Panel closed — resume autosave and flush anything the user left
        // pending (e.g. closed the panel without Discard/Apply).
        pausedForPanel = false;
        scheduleAutosave();
        notifyPending(); // if autosave is off, re-surface any waiting count
        break;

      case "drop-keys":
        // Panel applied or discarded these changes itself (or hit Clear) —
        // drop them here too so they aren't resurrected/re-autosaved.
        for (const key of msg.keys ?? []) changes.delete(key);
        postPendingSnapshot();
        break;

      // "element-context" is informational only in headless mode.
      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    attached = false;
    // If DevTools is closing, this whole context is torn down and the timer
    // below never fires — so reconnect only actually runs on a SW restart.
    if (reconnectAttempts >= MAX_RECONNECT) {
      console.warn("[dev-sync] service worker unreachable; giving up reconnecting.");
      toastRaw("CSS Sync: capture stopped — reload the page's DevTools to resume.", "warn");
      return;
    }
    const delay = Math.min(200 * 2 ** reconnectAttempts, 5000); // 200ms → 5s
    reconnectAttempts += 1;
    setTimeout(connectPort, delay);
  });

  // Attach immediately — DevTools is open, so capture should be live now.
  port.postMessage({ type: "attach", tabId });
}

// Gate startup on the inspected page being a localhost dev server. On any other
// page (google.com, prod sites) we never connect, never attach, and never show
// the "started inspecting this browser" banner — DevTools opens clean there.
(async () => {
  let origin;
  try {
    origin = await inspectedOrigin();
  } catch {
    return; // origin unresolvable — safest not to attach
  }
  if (isDevHost(origin)) connectPort();
})();

// ---------------------------------------------------------------------------
// Element selection -> ElementContext (tracks the Elements-panel selection)
// ---------------------------------------------------------------------------

// Reads the selected element's context off its off-DOM `__srcLoc` property
// (attached by the source-locator runtime ref). Runs in the page's MAIN world,
// so it can see the JS property — no DOM marker attribute needed.
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
    if (exceptionInfo && (exceptionInfo.isError || exceptionInfo.isException)) {
      console.warn("[dev-sync] could not read selected element:", exceptionInfo);
      return;
    }
    // Remember the selection so CSS-poller changes can carry it (Tailwind
    // className edits + styled-components template resolution both key off the
    // element, not the stylesheet).
    selectedElement = result && typeof result === "object" ? result : null;
    // SW prefers the content script's read; `result` is the fallback context.
    try {
      port.postMessage({ type: "element-selected", context: result ?? null });
    } catch {
      /* port gone */
    }
  });
}

chrome.devtools.panels.elements.onSelectionChanged.addListener(onSelectionChanged);
onSelectionChanged(); // capture whatever is selected right now

// ---------------------------------------------------------------------------
// Change accumulation (dedup) — mirrors the old panel logic, minus the UI.
// ---------------------------------------------------------------------------

const DOM_OPS = new Set(["set-attr", "remove-attr", "set-text", "set-text-segment"]);
const isDomOp = (c) => DOM_OPS.has(c.op);

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
    // One promote per element (its source location); latest inline cssText wins.
    return `${c.op}|${c.element.dataSourceFile}:${c.element.dataSourceLine}`;
  }
  const media = c.mediaText ?? "";
  const prop = c.op === "add-rule" ? c.ruleText : c.property;
  return `${c.op}|${c.styleSheet.id}|${media}|${c.selector}|${prop}`;
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
      postPendingSnapshot();
      notifyPending();
      return;
    }
  }

  changes.set(key, change);
  scheduleAutosave();
  postPendingSnapshot();
  notifyPending();
}

// ---------------------------------------------------------------------------
// CSS capture — poll the LIVE CSSOM via inspectedWindow.eval.
//
// chrome.debugger (the service worker) CANNOT observe the user's DevTools CSS
// edits: CSS.styleSheetChanged fires only on the session that made the edit,
// and CSS.getStyleSheetText returns text frozen at attach for a secondary
// session. inspectedWindow.eval runs IN the page, so reading document.styleSheets
// sees the real, current CSSOM — the only vantage point that reflects a
// Styles-pane edit (including an unchecked / disabled property). We diff each
// sheet's serialized rules against the previous poll and feed deltas into the
// same addChange path the debugger fast-path uses.
// ---------------------------------------------------------------------------

const CSS_POLL_MS = 500;

// Serialize every readable stylesheet: current rule text (post-edit CSSOM state)
// plus the sourceMappingURL comment the bundler injected — the server needs the
// map to trace an inline <style> back to its source file. Cross-origin sheets
// throw on .cssRules and are skipped.
const SERIALIZE_SHEETS = `(() => {
  const out = [];
  const sheets = document.styleSheets;
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    let rulesText = "";
    try {
      const rules = sheet.cssRules;
      for (let j = 0; j < rules.length; j++) rulesText += rules[j].cssText + "\\n";
    } catch (e) {
      continue; // cross-origin stylesheet — not readable, not ours to sync
    }
    const owner = sheet.ownerNode;
    const ownerText = owner && owner.tagName === "STYLE" ? (owner.textContent || "") : "";
    const mapMatch = (ownerText || rulesText).match(/\\/\\*#\\s*sourceMappingURL=([^*]+?)\\s*\\*\\//);
    // Stable identity across HMR/reorder: Vite tags each dev <style> with its
    // source path; prefer that, then the sheet href, then the array index (last
    // resort — index can shift if sheets are inserted/removed).
    const viteId = owner && owner.getAttribute ? owner.getAttribute("data-vite-dev-id") : null;
    const sourceMapURL = mapMatch ? mapMatch[1].trim() : "";
    // styled-components v6 injects an unmapped <style data-styled> whose rules
    // are opaque hashes (.hdbeaO). It carries NO sourcemap, so it's only
    // syncable via the selected element's displayName class (see the styled
    // gating in pollCss) — mark it so the poller lets its edits through but
    // treats them specially.
    const styled = owner && owner.getAttribute ? owner.getAttribute("data-styled") !== null : false;
    // A sheet is syncable ONLY if the server can trace it back to a source file:
    // a Vite dev id (real .css/.scss/.module), an href (external stylesheet), an
    // embedded sourceMappingURL (Emotion <style data-emotion>), or a
    // styled-components marker (resolved by element, above). Other runtime
    // CSS-in-JS / injected <style> tags map to no file — the server always skips
    // them, and the libraries re-inject/reorder rules on re-render, so diffing
    // them would POST a stream of doomed changes → an endless "N skipped" toast
    // with no user action. Skip those.
    const mappable = Boolean(viteId || sheet.href || sourceMapURL || styled);
    out.push({
      key: viteId || sheet.href || ("inline:" + i),
      sourceURL: sheet.href || "",
      sourceMapURL: sourceMapURL,
      mappable: mappable,
      styled: styled,
      rulesText: rulesText,
    });
  }
  return JSON.stringify(out);
})()`;

/** Previous poll's serialized rule text, keyed by sheet key. */
const cssSnapshots = new Map();
/**
 * Guards against an edit→HMR revert re-applying itself. When a rule's value
 * lives in GENERATED CSS the sync doesn't rewrite (a Tailwind utility like
 * `.p-8`, whose edit becomes a className swap), applying the change triggers
 * HMR, which replaces the <style> and drops the DevTools override — so the
 * value bounces back to its pre-edit state. The poller would see that bounce as
 * a fresh edit and re-apply it (a phantom `p-[2rem]`). Keyed
 * `${sheetKey}|${selector}|${property}` -> the oldValue we last emitted; a later
 * diff whose newValue equals it is that revert, and is skipped once.
 */
const cssRevertGuard = new Map();
let cssPollTimer = null;
let cssPolling = false;

function pollCss() {
  return new Promise((resolve) => {
    if (cssPolling) {
      resolve();
      return;
    }
    cssPolling = true;
    chrome.devtools.inspectedWindow.eval(SERIALIZE_SHEETS, (result, exceptionInfo) => {
      try {
        if (exceptionInfo && (exceptionInfo.isError || exceptionInfo.isException)) return;
        let sheets;
        try {
          sheets = JSON.parse(result);
        } catch {
          return; // eval returned non-JSON (page navigating / not ready)
        }
        if (!Array.isArray(sheets)) return;

        const seen = new Set();
        for (const sheet of sheets) {
          // Unsyncable runtime CSS-in-JS sheet (no source mapping) — never diff
          // it; doing so only manufactures guaranteed-skip churn (see eval note).
          if (!sheet.mappable) continue;
          seen.add(sheet.key);
          const prev = cssSnapshots.get(sheet.key);
          cssSnapshots.set(sheet.key, sheet.rulesText);
          // First sighting = baseline only (no emit); unchanged = nothing to do.
          if (prev === undefined || prev === sheet.rulesText) continue;

          const ref = {
            id: "eval:" + sheet.key,
            sourceURL: sheet.sourceURL,
            origin: "regular",
            ...(sheet.sourceMapURL ? { sourceMapURL: sheet.sourceMapURL } : {}),
          };
          let sheetChanges;
          try {
            sheetChanges = diffSheet(ref, prev, sheet.rulesText);
          } catch (e) {
            console.warn("[dev-sync] diff failed for", sheet.key, e);
            continue;
          }
          for (const change of sheetChanges) {
            // Suppress our OWN promoted rules: when an inline-style promote lands
            // its `.csync-* { ... }` rule in the overrides sheet, HMR re-serves
            // that sheet and this poller would otherwise diff the new rule as a
            // user add-rule and POST it straight back — a redundant (idempotent
            // but noisy) feedback loop. Those rules are server-owned, never user
            // edits, so skip any change whose selector is a generated class.
            if (typeof change.selector === "string" && /(^|\s|,)\.csync-[0-9a-z]+\b/.test(change.selector)) {
              continue;
            }
            // Suppress a JIT-generated Tailwind utility rule appearing as a user
            // add-rule: swapping a utility (e.g. p-8 -> p-[3rem]) makes Tailwind
            // regenerate its sheet with the new arbitrary-value class, which the
            // poller would otherwise diff as a hand-typed new rule and POST back.
            // A user never types `.p-\[3rem\] { … }` in DevTools — that dash +
            // bracket shape is only ever JIT output.
            if (
              change.op === "add-rule" &&
              typeof change.selector === "string" &&
              /-\\?\[/.test(change.selector)
            ) {
              continue;
            }
            if (sheet.styled) {
              // styled-components sheet: sync ONLY a declaration edit that maps
              // to the currently-selected styled element. The library re-injects
              // and reorders its own rules on re-render; without this gate that
              // churn would POST as phantom edits. An add-rule (a whole new hash
              // rule) is always library noise here, never a user edit.
              if (change.op === "add-rule") continue;
              const m =
                typeof change.selector === "string" ? change.selector.match(/\.([\w-]+)/) : null;
              const base = m ? m[1] : null;
              const cls =
                selectedElement && Array.isArray(selectedElement.classList)
                  ? selectedElement.classList
                  : null;
              if (!base || !cls || cls.indexOf(base) === -1) continue;
            }
            // Skip an edit→HMR revert (see cssRevertGuard): if this modify's
            // newValue is exactly the oldValue we last emitted for this rule, the
            // sheet just bounced back to its pre-edit state — not a user edit.
            if (change.op === "modify" && typeof change.selector === "string") {
              const gkey = `${sheet.key}|${change.selector}|${change.property}`;
              if (cssRevertGuard.get(gkey) === change.newValue) {
                cssRevertGuard.delete(gkey);
                continue;
              }
              cssRevertGuard.set(gkey, change.oldValue);
            }
            // cssText coordinates come from the browser-serialized CSSOM, not the
            // served compiled sheet — a range here would mis-resolve. The server
            // locates the rule by selector name + the sourcemap file list (and,
            // for css-in-js, auto-targets the template), so it applies these fine
            // with no range (verified: applied:1).
            delete change.range;
            // Attach the selected element so element-keyed tiers can resolve
            // their target: Tailwind (edit className on this element) and
            // styled-components (map its displayName class to the source template).
            if (selectedElement) change.element = selectedElement;
            addChange(change);
          }
        }
        // Drop sheets that disappeared (e.g. an HMR <style> swap) so that if the
        // same key reappears it re-baselines instead of diffing against stale text.
        for (const key of [...cssSnapshots.keys()]) {
          if (!seen.has(key)) cssSnapshots.delete(key);
        }
      } finally {
        cssPolling = false;
        resolve();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Element capture — poll each instrumented element's inline `style.cssText`
// AND its editable text, both via inspectedWindow.eval.
//
// Two live-DOM edit kinds the chrome.debugger/service-worker path can't observe
// reliably (CSS.styleSheetChanged fan-out gap for styles; the SW DOM-capture
// pipeline doesn't fire E2E for text) — so we read them straight from the page:
//   • inline style edit  -> `promote-inline-style` (generated csync class + rule)
//   • text-content edit   -> `set-text` (rewrite the element's JSX text body)
// Both diff against the previous poll keyed by source location (`file:line`).
//
// Reload-safety: an element whose inline style goes empty, whose text reverts,
// or that unmounts simply reverts/drops out of the serialized list, so we clear
// its snapshot with NO emit — a reload never manufactures a spurious change.
// ---------------------------------------------------------------------------

// Serialize EVERY instrumented element (has __srcLoc). We include empty inline
// styles on purpose: an element styled only by a class has cssText="" at load,
// and the whole point is to catch the user ADDING an inline style in DevTools —
// excluding empties would let it first appear already carrying the edit and get
// baselined away. `leaf` marks elements whose sole content is text (no child
// ELEMENTS): only those are `set-text` candidates (the server refuses to edit
// text on elements with mixed/nested children), so `text` is captured for them.
const SERIALIZE_ELEMENTS = `(() => {
  const out = [];
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const loc = el.__srcLoc;
    if (!loc || typeof loc !== "object" || !loc.dataSourceFile) continue;
    if (!Number.isInteger(loc.dataSourceLine) || loc.dataSourceLine <= 0) continue;
    const leaf = el.childElementCount === 0;
    // Every attribute except class + style (class is the classlist/Tailwind
    // tier, style is the inline-promote tier — both handled separately). The
    // source-locator attributes are off-DOM now, so nothing else to exclude.
    var attrs = {};
    var at = el.attributes;
    for (var k = 0; k < at.length; k++) {
      var nm = at[k].name;
      if (nm === "class" || nm === "style") continue;
      attrs[nm] = at[k].value;
    }
    // Serialize the element's DIRECT child nodes as {t, v} — t: 0=text (v=value),
    // 1=element, 2=other (comment/etc). This is the input to the text-SEGMENT
    // tier: a MIXED element (static runs interleaved with {expr}/nested tags)
    // has >1 kid, and diffing per-text-node lets us pinpoint which single static
    // run the user edited and map it to its source JSXText via /describe.
    var kids = [];
    var cn = el.childNodes;
    for (var m = 0; m < cn.length; m++) {
      var node = cn[m];
      if (node.nodeType === 3) kids.push({ t: 0, v: node.nodeValue });
      else if (node.nodeType === 1) kids.push({ t: 1 });
      else kids.push({ t: 2 });
    }
    out.push({
      file: loc.dataSourceFile,
      line: loc.dataSourceLine,
      component: typeof loc.dataSourceComponent === "string" ? loc.dataSourceComponent : "",
      tag: el.tagName.toLowerCase(),
      classList: Array.prototype.slice.call(el.classList),
      cssText: el.style && el.style.cssText ? el.style.cssText : "",
      attrs: attrs,
      leaf: leaf,
      text: leaf ? el.textContent : null,
      kids: kids,
    });
  }
  return JSON.stringify(out);
})()`;

/** Previous poll's inline cssText, keyed by `${file}:${line}`. */
const inlineSnapshots = new Map();
/** Previous poll's leaf text content, keyed by `${file}:${line}`. */
const textSnapshots = new Map();
/** Previous poll's serialized child-node array (JSON), keyed by `${file}:${line}`.
 *  Only tracked for MIXED elements (the text-segment tier); pure single-run
 *  leaves ride the whole-body `set-text` path via textSnapshots instead. */
const kidsSnapshots = new Map();
/** Previous poll's attribute values, keyed by `${file}:${line}|${attr}`. */
const attrSnapshots = new Map();
let inlinePolling = false;

/**
 * A mixed element's child nodes changed between polls. If exactly ONE text node
 * changed value AND the overall shape (length + per-slot text/element kind) is
 * unchanged, that's a single-run text edit — resolve it to a set-text-segment.
 * Any structural change (node added/removed, text<->element flip) or multiple
 * text nodes changing at once is an app re-render, not a DevTools edit: ignore.
 */
function maybeEmitTextSegment(context, key, prevKidsStr, curKids) {
  let prevKids;
  try {
    prevKids = JSON.parse(prevKidsStr);
  } catch {
    return;
  }
  if (!Array.isArray(prevKids) || prevKids.length !== curKids.length) return;
  let changed = -1;
  let count = 0;
  for (let i = 0; i < curKids.length; i++) {
    if (prevKids[i].t !== curKids[i].t) return; // shape flip -> not a text edit
    if (curKids[i].t === 0 && prevKids[i].v !== curKids[i].v) {
      changed = i;
      count++;
    }
  }
  if (count !== 1) return; // 0 = no text delta; >1 = multi-node re-render
  const segKey = `${key}#${changed}`;
  if (suppressedTextSegment.has(segKey)) return; // known-dynamic position
  void resolveAndEmitTextSegment(context, key, curKids, changed, curKids[changed].v, segKey);
}

/**
 * Ask the server to /describe the element's source template, then align the
 * live DOM child nodes to the source parts (pure resolveTextSegmentEdit) to map
 * the edited text node to its JSXText segmentIndex. Emits a set-text-segment on
 * success; suppresses the position when it resolves to a dynamic {expr} hole so
 * a re-rendering node stops re-describing. Fire-and-forget; guarded per element.
 */
async function resolveAndEmitTextSegment(context, key, kids, changedIndex, newVal, segKey) {
  if (describeInflight.has(key)) return;
  describeInflight.add(key);
  try {
    let res;
    try {
      res = await fetch(`${await syncBase()}/describe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ element: context }),
      });
    } catch {
      return; // server unreachable — the whole-sheet path already toasts that
    }
    if (!res.ok) return; // 404 unlocatable / 400 bad element — nothing to do
    let tmpl;
    try {
      tmpl = await res.json();
    } catch {
      return;
    }
    if (!tmpl || !Array.isArray(tmpl.parts)) return;
    const resolved = resolveTextSegmentEdit(tmpl.parts, kids, changedIndex, newVal);
    if (!resolved.ok) {
      if (resolved.dynamic) suppressedTextSegment.add(segKey);
      return;
    }
    const built = buildSetTextSegmentChange(
      context,
      resolved.segmentIndex,
      resolved.oldText,
      resolved.newText,
    );
    if (built.ok) addChange(built.change);
  } finally {
    describeInflight.delete(key);
  }
}

function pollElements() {
  return new Promise((resolve) => {
    if (inlinePolling) {
      resolve();
      return;
    }
    inlinePolling = true;
    chrome.devtools.inspectedWindow.eval(SERIALIZE_ELEMENTS, (result, exceptionInfo) => {
      try {
        if (exceptionInfo && (exceptionInfo.isError || exceptionInfo.isException)) return;
        let els;
        try {
          els = JSON.parse(result);
        } catch {
          return; // eval returned non-JSON (page navigating / not ready)
        }
        if (!Array.isArray(els)) return;

        const seen = new Set();
        const seenText = new Set();
        const seenKids = new Set();
        const seenAttrKeys = new Set();
        const contextByKey = new Map();
        for (const el of els) {
          const key = `${el.file}:${el.line}`;
          seen.add(key);

          const context = {
            tagName: el.tag,
            classList: Array.isArray(el.classList) ? el.classList : [],
            dataSourceFile: el.file,
            dataSourceLine: el.line,
            ...(el.component ? { dataSourceComponent: el.component } : {}),
          };
          contextByKey.set(key, context);

          // --- inline style -> promote-inline-style ---
          const prevCss = inlineSnapshots.get(key);
          inlineSnapshots.set(key, el.cssText);
          // First sighting = baseline only (INCLUDING "") so we only promote a
          // genuine edit, never the initial state; unchanged = no-op; changed
          // but now empty = user cleared it, nothing to promote.
          if (prevCss !== undefined && prevCss !== el.cssText && el.cssText) {
            const r = buildPromoteInlineStyleChange(context, el.cssText);
            if (r.ok) addChange(r.change);
          }

          // --- text -> set-text (whole body) OR set-text-segment (one run) ---
          // A PURE static leaf (no child elements, at most one child node) is a
          // whole-body set-text candidate. A MIXED element (>1 child node:
          // static runs interleaved with {expr} holes / nested tags) can't be
          // flattened — the server refuses that — so a single edited text node
          // routes through the SEGMENT path, which /describes the source and
          // rewrites just that one JSXText run.
          const kids = Array.isArray(el.kids) ? el.kids : [];
          if (el.leaf && kids.length <= 1) {
            seenText.add(key);
            const prevText = textSnapshots.get(key);
            const text = typeof el.text === "string" ? el.text : "";
            textSnapshots.set(key, text);
            // Never re-emit text the server already rejected as dynamic — that
            // element churns forever otherwise (see suppressedSetText). Still
            // update the snapshot above so we track its current value silently.
            if (prevText !== undefined && prevText !== text && !suppressedSetText.has(key)) {
              const r = buildSetTextChange(context, text, prevText);
              if (r.ok) addChange(r.change);
            }
          } else if (kids.length >= 2) {
            seenKids.add(key);
            const prevKidsStr = kidsSnapshots.get(key);
            const curStr = JSON.stringify(kids);
            kidsSnapshots.set(key, curStr);
            if (prevKidsStr !== undefined && prevKidsStr !== curStr) {
              maybeEmitTextSegment(context, key, prevKidsStr, kids);
            }
          }

          // --- attributes -> set-attr ---
          // Diff each attribute (class/style already excluded server-serialize).
          // First sight = baseline; React re-renders re-set the same values so a
          // stable attr never churns; a dynamic-bound attr the server rejects is
          // suppressed (suppressedSetAttr), exactly like set-text.
          const curAttrs = el.attrs && typeof el.attrs === "object" ? el.attrs : {};
          for (const name of Object.keys(curAttrs)) {
            const akey = `${key}|${name}`;
            seenAttrKeys.add(akey);
            const prevVal = attrSnapshots.get(akey);
            const val = curAttrs[name];
            attrSnapshots.set(akey, val);
            if (prevVal !== undefined && prevVal !== val && !suppressedSetAttr.has(akey)) {
              const r = buildSetAttrChange(context, name, val);
              if (r.ok) addChange(r.change);
            }
          }
        }
        // Drop snapshots for elements that unmounted (inline) or are no longer
        // leaf/unmounted (text) — silently, so a reload re-baselines instead of
        // diffing against stale content.
        for (const key of [...inlineSnapshots.keys()]) {
          if (!seen.has(key)) inlineSnapshots.delete(key);
        }
        for (const key of [...textSnapshots.keys()]) {
          if (!seenText.has(key)) textSnapshots.delete(key);
        }
        // Drop child-node snapshots for elements no longer mixed/unmounted, so a
        // reload or a shape change re-baselines instead of diffing against stale.
        for (const key of [...kidsSnapshots.keys()]) {
          if (!seenKids.has(key)) kidsSnapshots.delete(key);
        }
        // Attribute snapshots: an attr key gone from a STILL-PRESENT element is a
        // real removal -> remove-attr; an attr on an UNMOUNTED element is dropped
        // silently (reload re-baselines). Never emit for suppressed keys.
        for (const akey of [...attrSnapshots.keys()]) {
          if (seenAttrKeys.has(akey)) continue;
          const sep = akey.indexOf("|");
          const elemKey = akey.slice(0, sep);
          const name = akey.slice(sep + 1);
          const prevVal = attrSnapshots.get(akey);
          attrSnapshots.delete(akey);
          const context = contextByKey.get(elemKey);
          if (context && prevVal !== undefined && !suppressedSetAttr.has(akey)) {
            const r = buildRemoveAttrChange(context, name);
            if (r.ok) addChange(r.change);
          }
        }
      } finally {
        inlinePolling = false;
        resolve();
      }
    });
  });
}

function startCssPolling() {
  if (cssPollTimer) return;
  cssPollTimer = setInterval(() => {
    void pollCss();
    void pollElements();
  }, CSS_POLL_MS);
  void pollCss(); // seed the baselines immediately
  void pollElements();
}

startCssPolling();

// ---------------------------------------------------------------------------
// Sync to source (POST /apply)
// ---------------------------------------------------------------------------

function getInspectedUrl() {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval("location.href", (result) => {
      resolve(typeof result === "string" && result ? result : "about:blank");
    });
  });
}

async function syncToSource(opts = {}) {
  const { toast = false } = opts;
  if (syncing || changes.size === 0) return;
  syncing = true;

  try {
    /** @type {import("@dev-sync/contract").CapturePayload} */
    const payload = {
      url: await getInspectedUrl(),
      changes: [...changes.values()],
      // Headless autosave has no preview UI, so it must always request an
      // immediate commit. The contract's applyMode defaults to "preview" —
      // without this, autosave would silently stop writing anything the
      // moment the server starts honoring that default.
      applyMode: "commit",
    };

    let base;
    try {
      base = await syncBase();
    } catch {
      console.warn("[dev-sync] could not resolve inspected page origin");
      toastError("origin", "dev-sync: couldn't tell what page this is — open a localhost dev server tab.");
      setStatus("red");
      return;
    }
    let res;
    try {
      res = await fetch(`${base}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      console.warn(`[dev-sync] sync engine unreachable at ${base}`);
      toastError(
        "unreachable",
        "dev-sync: can't reach the dev server — is it running with devSync() added?"
      );
      setStatus("red");
      return;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[dev-sync] server error ${res.status}: ${body.slice(0, 300)}`);
      toastError(`http-${res.status}`, engineErrorMessage(res.status));
      setStatus(res.status === 404 ? "red" : "yellow");
      return;
    }

    /** @type {import("@dev-sync/contract").ApplyResult} */
    const result = await res.json();
    if (
      !result ||
      !Array.isArray(result.applied) ||
      !Array.isArray(result.skipped) ||
      !Array.isArray(result.needsPlacement)
    ) {
      console.warn("[dev-sync] server returned a malformed ApplyResult");
      toastError("malformed", "dev-sync: got an unexpected reply from the engine — check its version.");
      setStatus("yellow");
      return;
    }

    // Got a well-formed reply — the engine is healthy again; let the next
    // failure of any kind notify afresh.
    clearErrorToast();

    // Applied changes are now in source; drop them from the pending list.
    const appliedKeys = new Set(result.applied.map((o) => changeKey(o.change)));
    for (const key of [...changes.keys()]) {
      if (appliedKeys.has(key)) changes.delete(key);
    }

    // A skipped `set-text` means the server refused to rewrite that element's
    // text — its JSX child is dynamic/mixed ({expr} or nested tags), not a
    // single static run. Such an element re-renders its own textContent (the
    // test-app's `dynamic-text` tier is exactly this), so the text poller would
    // re-emit the same doomed set-text every tick, producing an endless
    // "N skipped" toast with no user action. Remember the source location and
    // stop polling its text: the source is dynamic, no future set-text can ever
    // apply. Also drop the stuck change so it isn't re-POSTed on the next
    // autosave (skipped changes are otherwise never removed from `changes`).
    for (const item of result.skipped) {
      const c = item && item.change;
      if (!c || !c.element || !c.element.dataSourceFile) continue;
      const loc = `${c.element.dataSourceFile}:${c.element.dataSourceLine}`;
      if (c.op === "set-text") {
        suppressedSetText.add(loc);
        changes.delete(changeKey(c));
      } else if (c.op === "set-text-segment") {
        // The local aligner already refuses dynamic runs, so a server skip here
        // means drift/multiline — drop it (the snapshot has advanced, so it
        // won't re-emit unless the run changes again).
        changes.delete(changeKey(c));
      } else if (c.op === "set-attr" || c.op === "remove-attr") {
        // Same dynamic-binding churn guard as set-text, per attribute.
        suppressedSetAttr.add(`${loc}|${c.attribute}`);
        changes.delete(changeKey(c));
      }
    }

    postPendingSnapshot();
    notifyPending();

    if (toast && result.applied.length > 0) {
      toastSummary(result.applied, result.skipped.length);
    }
    // A new rule that could land in several files needs the user to choose —
    // point them at the panel. Deduped so an unresolved placement doesn't
    // re-warn on every autosave tick.
    if (result.needsPlacement.length > 0) {
      toastError(
        `placement-${result.needsPlacement.length}`,
        `dev-sync: ${result.needsPlacement.length} new ` +
          `${result.needsPlacement.length === 1 ? "rule needs" : "rules need"} ` +
          `a target file — open the Source Sync panel to place ${result.needsPlacement.length === 1 ? "it" : "them"}.`
      );
    }

    // Clean apply clears any latched yellow; a partial one keeps the badge
    // amber so the unresolved skip/placement stays visible.
    setStatus(
      result.skipped.length > 0 || result.needsPlacement.length > 0 ? "yellow" : "green"
    );
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------------------
// Source Sync panel registration
//
// The panel is a read-only mirror + preview/undo control surface (see the
// header comment above) — it does not affect capture, which keeps running
// here regardless of whether the panel is open.
// ---------------------------------------------------------------------------

chrome.devtools.panels.create("Source Sync", "", "panel.html", () => {});
