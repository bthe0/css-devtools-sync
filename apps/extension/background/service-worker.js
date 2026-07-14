// background/service-worker.js — the panel <-> content-script message relay.
//
// This worker holds NO capture session. Every capture tier (CSS, set-text,
// set-attr, Tailwind, Emotion, styled-components, inline-promote, text-segment)
// runs as an inspectedWindow.eval poller in devtools.js, reading the page's
// REAL live DOM/CSSOM and POSTing straight to the dev server's apply engine.
//
// A raw-CDP session used to live here but was removed: it could never observe
// the user's Elements-panel edits (those go through the DevTools frontend's
// own protocol session — the original cross-session capture bug), and
// attaching cost Chrome's intrusive "started inspecting this browser" banner
// + an install-time warning for nothing.
//
// The worker's sole job now: track a per-tab panel port + last selected
// element, and relay status/toast/pending messages between the panel and the
// in-page HUD content script. It keeps no snapshot state, so a service-worker
// restart is harmless — the panel just re-opens its port.

"use strict";

import { summarizeAutosave } from "./summary.js";

/**
 * Per-tab session record — just the panel port + last selected element.
 * tabId -> { port: chrome.runtime.Port, lastElementContext: ElementContext | null }
 */
const sessions = new Map();

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function startSession(tabId, port) {
  const session = { port, lastElementContext: null };
  sessions.set(tabId, session);
  return session;
}

async function stopSession(tabId) {
  sessions.delete(tabId);
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
// devtools.js already holds the live capture poller for the tab (keyed by
// tabId; see the "attach" case above), so the Source Sync panel
// (panel.html/panel.js) does NOT capture on its own. It opens a SEPARATE port
// ("dev-sync-preview") that:
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessions.has(tabId)) void stopSession(tabId);
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
