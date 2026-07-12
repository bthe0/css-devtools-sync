// background/service-worker.js — the CDP capture engine.
//
// Uses chrome.debugger (raw Chrome DevTools Protocol) because
// chrome.devtools.inspectedWindow does NOT expose CSS.*/DOM.* domain events.
//
// All diffing / CaptureChange-building logic is pure and lives in
// ./diff.js (no chrome.* calls) so it can be unit-tested without a browser.
// This file's job is just: manage the CDP session, keep just enough DOM
// state to resolve mutated nodeIds back to ElementContext, and forward the
// results to the panel.
//
// KNOWN LIMITATIONS (documented, surfaced to the panel where possible):
//  - Attaching shows Chrome's yellow "… started debugging this browser"
//    banner on the inspected tab. This is unavoidable with chrome.debugger;
//    clicking "Cancel" on the banner force-detaches us (we report it).
//  - chrome.debugger multiplexes with an open DevTools window since Chrome
//    ~M63, so attaching WHILE DevTools is open works — but if another
//    debugger extension is already attached, attach fails with
//    "Another debugger is already attached"; we surface that error verbatim.
//  - Service workers can be killed by the browser; in-memory stylesheet/DOM
//    snapshots die with it. Debugger events keep the worker alive in
//    practice, but after a SW restart the panel must re-attach.

"use strict";

import {
  diffSheet,
} from "./diff.js";
import { summarizeAutosave } from "./summary.js";

const DIFF_DEBOUNCE_MS = 300;
// NOTE: CSS.styleSheetChanged is delivered ONLY to the CDP session that made
// the edit, and CSS.getStyleSheetText returns text frozen at attach for a
// secondary session. The user edits through the DevTools frontend's session,
// so neither the event nor a re-read here can observe the user's CSS edits.
// The real capture path therefore lives in devtools.js, which polls the LIVE
// CSSOM via inspectedWindow.eval. This file keeps the styleSheetChanged
// listener only as a harmless fast-path (fires for same-session edits) and
// remains the source of stylesheet METADATA (sourceURL/sourceMapURL).

/**
 * Per-tab capture session.
 * tabId -> {
 *   port: chrome.runtime.Port,
 *   sheets: Map<styleSheetId, {ref: StyleSheetRef, text: string}>,
 *   debounce: Map<styleSheetId, timeoutId>,               // CSS
 *   lastElementContext: ElementContext | null,
 *   attached: boolean,
 * }
 */
const sessions = new Map();

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
      } else {
        resolve(result);
      }
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // Ignore "not attached" errors — detach must be idempotent.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function startSession(tabId, port) {
  const session = {
    port,
    sheets: new Map(),
    debounce: new Map(),
    lastElementContext: null,
    attached: false,
  };
  sessions.set(tabId, session);

  // NO CDP attach. Every capture tier (CSS, set-text, set-attr, Tailwind,
  // Emotion, styled-components, inline-promote, text-segment) now runs as an
  // inspectedWindow.eval poller in devtools.js reading the page's REAL live
  // DOM/CSSOM and POSTing straight to the dev server's apply engine — the CDP
  // session never sees the user's edits (the original cross-session capture bug)
  // and its DOM/attr/char-data handlers are already neutered. Attaching only cost
  // Chrome's intrusive "started inspecting this browser" banner (browser-wide, on
  // every tab) for a session nothing on the live path consumes. So we keep just
  // the session record — postToPanel relays status/toast/pending over its port —
  // and skip the attach entirely. `attached` stays false: stopSession then never
  // detaches, and the (unused) get-computed path stays inert.
  return session;
}

async function stopSession(tabId, { detach = true } = {}) {
  const session = sessions.get(tabId);
  if (!session) return;
  for (const t of session.debounce.values()) clearTimeout(t);
  sessions.delete(tabId);
  if (detach && session.attached) await debuggerDetach(tabId);
}

function postToPanel(tabId, msg) {
  const session = sessions.get(tabId);
  if (!session) return;
  try {
    session.port.postMessage(msg);
  } catch {
    // Port gone (panel closed mid-flight); onDisconnect will clean up.
  }
}

function postError(tabId, context, err) {
  postToPanel(tabId, {
    type: "cdp-error",
    context,
    message: err instanceof Error ? err.message : String(err),
  });
}

// Tell the tab's content script to remove the in-page HUD (DevTools closed).
// No-op if the page has no content script (non-localhost / not injected).
function tearDownHud(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "dev-sync:teardown" }, () => {
    void chrome.runtime.lastError;
  });
}

// A content script (re)mounted its HUD — e.g. after an HMR/page reload, which
// re-injects a fresh idle HUD while devtools.js keeps running with a stale
// status latch. The content script PULLS (it knows when it mounts; a push from
// devtools.js races the injection), so relay the request to the tab's DevTools
// session, which re-asserts status + pending. No-op if no session (DevTools not
// open for this tab) — the HUD then correctly stays idle.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "dev-sync:hud-ready" && sender.tab?.id != null) {
    postToPanel(sender.tab.id, { type: "resync" });
  }
});

/** The tab's url, or "" if hidden (no host_permissions match) / unavailable. */
function tabUrl(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      void chrome.runtime.lastError; // tab gone → resolve empty
      resolve(tab && typeof tab.url === "string" ? tab.url : "");
    });
  });
}

// Resolve the tab's url, retrying while it reads back empty. On a cold service
// worker (just after an extension reload) chrome.tabs.get can transiently
// return no url even for a localhost tab that host_permissions covers — a
// premature "" there yields a FALSE not-dev-host and the badge never leaves
// idle. Retry a few times before trusting an empty result.
async function resolveTabUrl(tabId, tries = 4, gapMs = 150) {
  for (let i = 0; i < tries; i++) {
    const url = await tabUrl(tabId);
    if (url) return url;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return "";
}

/** True only for http(s) localhost / 127.0.0.1 — where the apply engine lives. */
function isDevTabUrl(url) {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CDP events
// ---------------------------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined || !sessions.has(tabId)) return;

  switch (method) {
    case "CSS.styleSheetAdded":
      void onStyleSheetAdded(tabId, params.header);
      break;
    case "CSS.styleSheetChanged":
      onStyleSheetChanged(tabId, params.styleSheetId);
      break;
    case "CSS.styleSheetRemoved":
      sessions.get(tabId)?.sheets.delete(params.styleSheetId);
      break;
    default:
      break;
  }
});

async function onStyleSheetAdded(tabId, header) {
  const session = sessions.get(tabId);
  if (!session) return;
  const ref = {
    id: header.styleSheetId,
    sourceURL: header.sourceURL ?? "",
    ...(header.sourceMapURL ? { sourceMapURL: header.sourceMapURL } : {}),
    origin: header.origin, // "regular" | "inspector" | "injected" | "user-agent"
  };
  try {
    const { text } = await cdp(tabId, "CSS.getStyleSheetText", {
      styleSheetId: header.styleSheetId,
    });
    session.sheets.set(header.styleSheetId, { ref, text });
  } catch (err) {
    // Some UA sheets refuse to serve text — snapshot as empty, never capture.
    if (header.origin !== "user-agent") postError(tabId, "getStyleSheetText", err);
    session.sheets.set(header.styleSheetId, { ref, text: "" });
  }
}

function onStyleSheetChanged(tabId, styleSheetId) {
  const session = sessions.get(tabId);
  if (!session) return;
  // DevTools fires styleSheetChanged per keystroke while the user types a
  // value; debounce so we diff the settled text, not intermediate states.
  clearTimeout(session.debounce.get(styleSheetId));
  session.debounce.set(
    styleSheetId,
    setTimeout(() => {
      session.debounce.delete(styleSheetId);
      void diffAndEmit(tabId, styleSheetId);
    }, DIFF_DEBOUNCE_MS)
  );
}

async function diffAndEmit(tabId, styleSheetId) {
  const session = sessions.get(tabId);
  if (!session) return;
  const snapshot = session.sheets.get(styleSheetId);
  if (!snapshot) return; // sheet we never managed to snapshot
  if (snapshot.ref.origin === "user-agent") return; // never capture UA sheets

  let newText;
  try {
    ({ text: newText } = await cdp(tabId, "CSS.getStyleSheetText", { styleSheetId }));
  } catch (err) {
    postError(tabId, "getStyleSheetText", err);
    return;
  }
  if (newText === snapshot.text) return;

  let changes;
  try {
    changes = diffSheet(snapshot.ref, snapshot.text, newText);
  } catch (err) {
    postError(tabId, "diff", err);
    snapshot.text = newText;
    return;
  }
  snapshot.text = newText;

  const element = session.lastElementContext ?? undefined;
  for (const change of changes) {
    postToPanel(tabId, {
      type: "change",
      change: element ? { ...change, element } : change,
    });
  }
}

// ---------------------------------------------------------------------------
// Computed-style reads (for the Verify round-trip)
// ---------------------------------------------------------------------------

async function getComputedStyles(tabId, checks) {
  // checks: [{selector, property, expected}] -> VerifyCheck[] with `actual`.
  const { root } = await cdp(tabId, "DOM.getDocument", { depth: 0 });
  const results = [];
  for (const check of checks) {
    let actual = "";
    try {
      const { nodeId } = await cdp(tabId, "DOM.querySelector", {
        nodeId: root.nodeId,
        selector: check.selector,
      });
      if (nodeId) {
        const { computedStyle } = await cdp(tabId, "CSS.getComputedStyleForNode", {
          nodeId,
        });
        actual =
          computedStyle.find((p) => p.name === check.property.toLowerCase())?.value ??
          "";
      } else {
        actual = "<no element matches selector>";
      }
    } catch (err) {
      actual = `<error: ${err instanceof Error ? err.message : String(err)}>`;
    }
    results.push({
      selector: check.selector,
      property: check.property,
      expected: check.expected,
      actual,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Panel port protocol
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "dev-sync-panel") return;
  let tabId = null;

  port.onMessage.addListener((msg) => {
    void handlePanelMessage(msg);
  });

  async function handlePanelMessage(msg) {
    // A malformed port message (null / non-object / no string type) would throw
    // here — and since this runs via `void handlePanelMessage` (516) that becomes
    // an unhandled promise rejection. Guard like the runtime listener at 242.
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "attach": {
        tabId = msg.tabId;
        // Gate on the tab's REAL url (not an inspectedWindow.eval that races page
        // load). chrome.tabs.get only exposes the url for tabs matching
        // host_permissions (localhost/127.0.0.1), so a non-dev tab reads back
        // empty → we skip the session and reply not-dev-host, leaving the HUD
        // idle instead of spinning a pointless health poll on a non-dev origin.
        if (!isDevTabUrl(await resolveTabUrl(tabId))) {
          port.postMessage({ type: "not-dev-host" });
          break;
        }
        try {
          if (sessions.has(tabId)) await stopSession(tabId); // stale session
          await startSession(tabId, port);
          postToPanel(tabId, { type: "attached", tabId });
        } catch (err) {
          sessions.delete(tabId);
          port.postMessage({
            type: "attach-failed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "detach": {
        if (tabId !== null) {
          await stopSession(tabId);
          tearDownHud(tabId);
          port.postMessage({ type: "detached", reason: "panel request" });
        }
        break;
      }

      case "show-toast": {
        // Panel finished an autosave; render an in-page toast in the tab.
        // Messaging an injected content script needs no extra permission
        // (same path as requestElementContextFromContentScript).
        if (tabId === null) break;
        const { text, kind } = summarizeAutosave(msg.applied ?? [], msg.skipped ?? 0);
        chrome.tabs.sendMessage(tabId, { type: "dev-sync:message", text, kind }, () => {
          void chrome.runtime.lastError; // no content script on this page — ignore
        });
        break;
      }

      case "toast": {
        // A feed line (errors / partial-failure notices) for the in-page HUD
        // from the headless devtools client — same content-script relay path.
        if (tabId === null) break;
        chrome.tabs.sendMessage(
          tabId,
          { type: "dev-sync:message", text: String(msg.text ?? ""), kind: msg.kind },
          () => {
            void chrome.runtime.lastError;
          }
        );
        break;
      }

      case "status": {
        // Engine connection state for the HUD badge (green/yellow/red/idle).
        if (tabId === null) break;
        chrome.tabs.sendMessage(
          tabId,
          {
            type: "dev-sync:status",
            state: String(msg.state ?? "idle"),
            detail: typeof msg.detail === "string" ? msg.detail : "",
          },
          () => {
            void chrome.runtime.lastError;
          }
        );
        break;
      }

      case "pending-count": {
        // Singleton "N changes waiting for save" status for the tab (shown only
        // when autosave is off and the panel is closed — see devtools.js
        // notifyPending). count 0 dismisses it.
        if (tabId === null) break;
        chrome.tabs.sendMessage(
          tabId,
          { type: "dev-sync:pending", count: Number(msg.count) || 0 },
          () => {
            void chrome.runtime.lastError;
          }
        );
        break;
      }

      case "element-selected": {
        // The devtools client eval'd the context off $0.__srcLoc (main world);
        // that's now the sole source — the content-script/marker path is gone.
        if (tabId === null) break;
        const session = sessions.get(tabId);
        if (!session) break;
        session.lastElementContext = msg.context ?? null;
        postToPanel(tabId, {
          type: "element-context",
          context: session.lastElementContext,
          source: "devtools-eval",
        });
        break;
      }

      case "get-computed": {
        if (tabId === null || !sessions.get(tabId)?.attached) {
          port.postMessage({
            type: "computed-result",
            requestId: msg.requestId,
            error: "Not attached to the inspected tab",
          });
          break;
        }
        try {
          const checks = await getComputedStyles(tabId, msg.checks);
          port.postMessage({ type: "computed-result", requestId: msg.requestId, checks });
        } catch (err) {
          port.postMessage({
            type: "computed-result",
            requestId: msg.requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "pending-snapshot": {
        // devtools.js's pending-changes map changed — mirror it to any open
        // Source Sync panel for this tab (see the preview relay below).
        if (tabId === null) break;
        broadcastPending(tabId, { changes: msg.changes ?? [], skips: msg.skips ?? [] });
        break;
      }

      default:
        break;
    }
  }

  port.onDisconnect.addListener(() => {
    // Panel closed / DevTools closed — detach cleanly and remove the in-page HUD.
    if (tabId !== null) {
      void stopSession(tabId);
      tearDownHud(tabId);
    }
  });
});

// ---------------------------------------------------------------------------
// Preview-panel relay.
//
// The Source Sync panel (panel.html/panel.js) does NOT run its own
// chrome.debugger session — devtools.js already holds the live capture
// session for the tab, and a second `attach` here would steal it (sessions
// are keyed by tabId; see the "attach" case above). Instead the panel opens a
// SEPARATE port ("dev-sync-preview") that:
//   - mirrors devtools.js's pending-changes map (pushed via "pending-snapshot"
//     on devtools.js's own "dev-sync-panel" port, relayed here to the panel),
//   - tells devtools.js to pause its autosave auto-commit while a panel is
//     open (so the user gets a chance to preview before anything writes), and
//     to resume it when the panel closes,
//   - forwards "drop-keys" (an Apply-success or manual Clear in the panel)
//     back to devtools.js so its map doesn't resurrect/re-autosave changes
//     the panel already committed or discarded.
// Actual preview/commit/undo/journal calls are plain HTTP from panel.js
// straight to the sync server — this relay only carries the changes list.
// ---------------------------------------------------------------------------
const previewPorts = new Map(); // tabId -> Set<port>
const pendingSnapshots = new Map(); // tabId -> { changes, skips }

function broadcastPending(tabId, snapshot) {
  pendingSnapshots.set(tabId, snapshot);
  const set = previewPorts.get(tabId);
  if (!set) return;
  for (const p of set) {
    try {
      p.postMessage({ type: "pending-snapshot", changes: snapshot.changes, skips: snapshot.skips });
    } catch {
      // Dead port; its onDisconnect below will prune it.
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "dev-sync-preview") return;
  let tabId = null;

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return; // ignore malformed messages
    switch (msg.type) {
      case "preview-subscribe": {
        tabId = msg.tabId;
        if (!previewPorts.has(tabId)) previewPorts.set(tabId, new Set());
        previewPorts.get(tabId).add(port);
        postToPanel(tabId, { type: "panel-open" }); // pause devtools.js autosave
        const snap = pendingSnapshots.get(tabId);
        if (snap) {
          port.postMessage({ type: "pending-snapshot", changes: snap.changes, skips: snap.skips });
        }
        break;
      }
      case "drop-keys": {
        if (tabId === null) break;
        postToPanel(tabId, { type: "drop-keys", keys: msg.keys ?? [] });
        break;
      }
      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId === null) return;
    const set = previewPorts.get(tabId);
    if (!set) return;
    set.delete(port);
    if (set.size === 0) {
      previewPorts.delete(tabId);
      postToPanel(tabId, { type: "panel-closed" }); // resume devtools.js autosave
    }
  });
});

// User clicked "Cancel" on the yellow debugging banner, tab closed, or
// another debugger took over.
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId === undefined || !sessions.has(tabId)) return;
  postToPanel(tabId, { type: "detached", reason });
  void stopSession(tabId, { detach: false });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessions.has(tabId)) void stopSession(tabId, { detach: false });
});

// Ask the panel of the currently-focused tab to sync now. Shared by the
// keyboard command and the toolbar-popup "Sync now" button. Only forwards when
// a capture session (an open Source Sync panel) exists for that tab.
function forwardSyncNow(source, done) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    const ok = tabId !== undefined && sessions.has(tabId);
    if (ok) postToPanel(tabId, { type: "run-sync", source });
    if (done) done(ok);
  });
}

// Keyboard shortcut (manifest `commands`).
chrome.commands.onCommand.addListener((command) => {
  if (command === "sync-now") forwardSyncNow("shortcut");
});

// Toolbar-popup "Sync now" button (chrome.runtime.sendMessage from popup.js).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "sync-now-request") {
    forwardSyncNow("popup", (ok) =>
      sendResponse({
        ok,
        reason: ok ? undefined : "Open DevTools on this tab first (capture attaches automatically).",
      })
    );
    return true; // async sendResponse
  }
  return undefined;
});
