// content-script.js — runs in the inspected page (localhost dev apps only, see
// manifest matches). Renders the persistent dev-sync HUD in a Shadow DOM host:
// a status badge (engine connection), an autosave toggle, and a live message
// feed. This is the SINGLE in-page surface — all extension feedback flows here.
//
// Element source location is NOT read here; it lives off-DOM as a `__srcLoc`
// property on each node (attached by the source-locator runtime ref) and is
// read from the page's main world by the devtools client via
// inspectedWindow.eval / CDP.
//
// The content script is injected into every localhost tab (manifest matches
// keep it off non-dev sites) and renders a PERSISTENT HUD: it's always visible
// on the page, idle until a DevTools session for this tab connects. Only the
// CDP attach is scoped to the inspected tab (see devtools.js isDevHost) — the
// HUD itself is a passive, always-on indicator.
//
// Messages arrive from the service worker (relayed from the DevTools client):
//   dev-sync:status   { state: "green" | "yellow" | "red" | "idle" }
//   dev-sync:message  { text, kind: "success" | "info" | "warn" }
//   dev-sync:pending  { count }
//   dev-sync:teardown {}  — DevTools closed; return the HUD to idle (kept on page)
// The autosave slider is owned here and mirrored through chrome.storage.local
// (shared with the popup + DevTools panel).

"use strict";

const HOST_ID = "dev-sync-hud-host";
const AUTOSAVE_KEY = "dev-sync:autosave";
const MSG_TTL_MS = 5000; // a feed line fades out after this; the HUD frame stays
const MSG_MAX = 4; // most recent lines kept in the feed

// Connection state → circle background. green: connected, idle/healthy.
// yellow: reachable but the last edit errored/was skipped. red: engine
// unreachable. idle: no DevTools signal yet (gray).
const STATUS_COLOR = {
  green: "#22c55e",
  yellow: "#f59e0b",
  red: "#ef4444",
  idle: "#6b7280",
};
const STATUS_LABEL = {
  green: "Connected — waiting for edits",
  yellow: "Connected — last edit had issues",
  red: "Can't reach the dev server",
  idle: "Open DevTools to start syncing",
};

let hud = null; // { root, badge, feed, switchEl } once built; null until first message
let autosavePref = true; // stored pref, seeded async; seeds the switch when built

function buildHud() {
  if (hud) return hud;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "position:fixed;z-index:2147483647;right:16px;bottom:16px;pointer-events:none;";
  (document.body || document.documentElement).appendChild(host);

  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .hud {
      pointer-events:auto; width:280px;
      font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      color:#e8eaf0; background:#1b1e2b; border:1px solid #2c3145;
      border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.4); overflow:hidden;
      /* Sits at 60% so it stays unobtrusive over the page; full opacity while
         hovered, dragged, or after a click so it's readable when the user
         reaches for it (click latches until they click off it). */
      opacity:.6; transition:opacity .2s ease;
    }
    .hud:hover, .hud.dragging, .hud.active { opacity:1; }
    .bar {
      display:flex; align-items:center; gap:10px;
      padding:9px 11px; background:#20233340;
      cursor:move; user-select:none; /* drag handle */
    }
    .badge {
      flex:0 0 auto; width:22px; height:22px; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      background:${STATUS_COLOR.idle}; transition:background .25s ease;
    }
    .badge svg { width:13px; height:13px; display:block; }
    .title { flex:1 1 auto; font-weight:600; letter-spacing:.01em; }
    /* Status message row under the settings bar. Color set inline per state. */
    .status {
      padding:7px 12px 9px; font-size:11.5px; color:#9aa1b3;
      border-top:1px solid #2c3145; transition:color .25s ease;
    }
    /* Autosave switch (role=switch) */
    .sw {
      flex:0 0 auto; position:relative; width:38px; height:22px; border-radius:11px;
      background:#3a3f52; border:none; cursor:pointer; padding:0;
      transition:background .18s ease;
    }
    .sw[aria-checked="true"] { background:#3b82f6; }
    .sw::after {
      content:""; position:absolute; top:2px; left:2px; width:18px; height:18px;
      border-radius:50%; background:#fff; transition:transform .18s ease;
    }
    .sw[aria-checked="true"]::after { transform:translateX(16px); }
    .sw:focus-visible { outline:2px solid #93c5fd; outline-offset:2px; }
    /* Feed sits ABOVE the bar so activity toasts stack up over the widget. */
    .feed {
      list-style:none; margin:0; padding:6px; display:flex; flex-direction:column;
      gap:5px; border-bottom:1px solid #2c3145;
    }
    .feed:empty { display:none; }
    .line {
      display:flex; align-items:flex-start; gap:7px; padding:6px 8px;
      background:#232838; border-radius:7px; border-left:3px solid #3b82f6;
      opacity:0; transform:translateY(4px); transition:opacity .18s ease, transform .18s ease;
    }
    .line.show { opacity:1; transform:none; }
    .line.warn { border-left-color:#f59e0b; }
    .line.success { border-left-color:#22c55e; background:#1e2a26; }
    .line.pending { border-left-color:#f59e0b; background:#2a2438; }
    .line .ic { flex:0 0 auto; font-weight:700; color:#3b82f6; }
    .line.warn .ic, .line.pending .ic { color:#f59e0b; }
    .line.success .ic { color:#22c55e; }
    .line .msg { word-break:break-word; }
    @media (prefers-reduced-motion: reduce) {
      .badge,.sw,.sw::after,.line,.status,.hud { transition:none; }
      .line { opacity:1; transform:none; }
    }`;
  root.appendChild(style);

  const frame = document.createElement("div");
  frame.className = "hud";

  const bar = document.createElement("div");
  bar.className = "bar";

  const badge = document.createElement("div");
  badge.className = "badge";
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", STATUS_LABEL.idle);
  badge.title = STATUS_LABEL.idle;
  // Inline sync-arrows mark (no packaged asset → no web_accessible_resources).
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8"/><path d="M20 4v4h-4"/>' +
    '<path d="M20 12a8 8 0 0 1-13.7 5.6L4 16"/><path d="M4 20v-4h4"/></svg>';

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "dev-sync";

  const switchEl = document.createElement("button");
  switchEl.className = "sw";
  switchEl.setAttribute("role", "switch");
  switchEl.setAttribute("aria-checked", autosavePref ? "true" : "false");
  switchEl.setAttribute("aria-label", "Autosave edits to source");
  switchEl.title = "Autosave";
  switchEl.addEventListener("click", () => {
    const next = switchEl.getAttribute("aria-checked") !== "true";
    chrome.storage.local.set({ [AUTOSAVE_KEY]: next });
  });

  bar.append(badge, title, switchEl);

  const feed = document.createElement("ul");
  feed.className = "feed";
  feed.setAttribute("aria-live", "polite");
  feed.setAttribute("aria-label", "dev-sync activity");

  // Status message: its own row UNDER the settings bar, tinted to match the
  // circle (green/yellow/red), muted when idle.
  const statusEl = document.createElement("div");
  statusEl.className = "status";
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  statusEl.textContent = STATUS_LABEL.idle;

  // Bottom-right anchored: feed toasts stack up on top, then the settings bar,
  // then the persistent status message beneath it.
  frame.append(feed, bar, statusEl);
  root.appendChild(frame);

  // Drag the whole widget by its settings bar. Position is deliberately NOT
  // persisted — the content script rebuilds the HUD on every page load, so it
  // resets to the bottom-right anchor on refresh (as requested).
  makeDraggable(host, frame, bar, switchEl);

  // Click the widget to latch it to full opacity (readable while you work in it);
  // a click anywhere off it drops back to the resting 60%.
  frame.addEventListener("mousedown", () => frame.classList.add("active"));
  document.addEventListener("mousedown", (e) => {
    if (!host.contains(e.target)) frame.classList.remove("active");
  });

  hud = { root, badge, feed, switchEl, statusEl };
  return hud;
}

// Let the user click-drag the HUD anywhere by its `handle`, ignoring drags that
// start on `ignore` (the autosave switch — those are clicks, not drags). The
// host is anchored bottom-right via right/bottom; on the first drag we convert
// to left/top from its current rect so the pointer stays glued to the grab point.
function makeDraggable(host, frame, handle, ignore) {
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  const onMove = (e) => {
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;
    // Keep the box inside the viewport so it can't be lost off an edge.
    const left = Math.max(0, Math.min(window.innerWidth - w, originLeft + e.clientX - startX));
    const top = Math.max(0, Math.min(window.innerHeight - h, originTop + e.clientY - startY));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  };

  const onUp = () => {
    frame.classList.remove("dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || (ignore && ignore.contains(e.target))) return;
    e.preventDefault(); // don't start a text selection while dragging
    const rect = frame.getBoundingClientRect();
    // Switch the anchor from right/bottom to left/top at the current position.
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    originLeft = rect.left;
    originTop = rect.top;
    startX = e.clientX;
    startY = e.clientY;
    frame.classList.add("dragging");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function setStatus(state) {
  const h = buildHud();
  const s = STATUS_COLOR[state] ? state : "idle";
  h.badge.style.background = STATUS_COLOR[s];
  h.badge.setAttribute("aria-label", STATUS_LABEL[s]);
  h.badge.title = STATUS_LABEL[s];
  h.statusEl.textContent = STATUS_LABEL[s];
  h.statusEl.style.color = s === "idle" ? "#9aa1b3" : STATUS_COLOR[s];
}

function pushMessage(text, kind) {
  const h = buildHud();
  const li = document.createElement("li");
  // "success" (autosave confirmations) → green ✓; "warn" → amber !; else blue ✓.
  const cls = kind === "warn" ? "warn" : kind === "success" ? "success" : "";
  li.className = `line ${cls}`;
  const ic = document.createElement("span");
  ic.className = "ic";
  ic.textContent = kind === "warn" ? "!" : "✓";
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = text;
  li.append(ic, msg);

  // Newest on top, above the persistent pending line if present.
  const pending = h.feed.querySelector(".pending");
  h.feed.insertBefore(li, pending ?? h.feed.firstChild);
  requestAnimationFrame(() => li.classList.add("show"));

  // Trim transient lines beyond the cap (never the pending line).
  const transient = h.feed.querySelectorAll(".line:not(.pending)");
  for (let i = MSG_MAX; i < transient.length; i++) transient[i].remove();

  setTimeout(() => {
    li.classList.remove("show");
    setTimeout(() => li.remove(), 200);
  }, MSG_TTL_MS);
}

function setPending(count) {
  const h = buildHud();
  let line = h.feed.querySelector(".pending");
  if (count <= 0) {
    if (line) {
      line.classList.remove("show");
      setTimeout(() => line.remove(), 200);
    }
    return;
  }
  const text = `${count} ${count === 1 ? "change" : "changes"} waiting for save`;
  if (line) {
    line.querySelector(".msg").textContent = text;
    return;
  }
  line = document.createElement("li");
  line.className = "line pending";
  line.setAttribute("role", "status");
  const ic = document.createElement("span");
  ic.className = "ic";
  ic.textContent = "●";
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = text;
  line.append(ic, msg);
  h.feed.appendChild(line); // pending sits at the bottom of the feed
  requestAnimationFrame(() => line.classList.add("show"));
}

// DevTools closed for this tab: the HUD is PERSISTENT, so don't remove it —
// just drop back to the idle badge and clear any stale pending count.
function resetToIdle() {
  setStatus("idle");
  setPending(0);
}

// Track the stored pref and reflect it onto the switch. The HUD is always
// present (built eagerly at load), so this can update it directly.
function reflectAutosave(on) {
  autosavePref = on;
  const h = buildHud();
  h.switchEl.setAttribute("aria-checked", on ? "true" : "false");
  h.switchEl.title = on ? "Autosave on" : "Autosave off";
}

// Seed the switch from the stored pref (default ON), then track changes.
chrome.storage.local.get(AUTOSAVE_KEY, (stored) => {
  const val = stored ? stored[AUTOSAVE_KEY] : undefined;
  reflectAutosave(val === undefined ? true : Boolean(val));
});
chrome.storage.onChanged.addListener((changed, area) => {
  if (area === "local" && changed[AUTOSAVE_KEY]) {
    reflectAutosave(Boolean(changed[AUTOSAVE_KEY].newValue));
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  // Signals from the DevTools session for THIS tab. The HUD is already on the
  // page (built eagerly below); these just update it. Teardown returns it to
  // idle when DevTools closes — the widget stays put.
  if (msg.type === "dev-sync:message" && typeof msg.text === "string") {
    pushMessage(msg.text, msg.kind);
  } else if (msg.type === "dev-sync:status") {
    setStatus(String(msg.state || "idle"));
  } else if (msg.type === "dev-sync:pending") {
    setPending(Number(msg.count) || 0);
  } else if (msg.type === "dev-sync:teardown") {
    resetToIdle();
  }
});

// Build the HUD immediately so it's a persistent fixture on every localhost dev
// page (manifest matches keep it off non-dev sites). It sits idle until a
// DevTools session for this tab sends a status/message.
buildHud();

// On (re)mount — including after an HMR/page reload, where devtools.js survives
// but this content script re-injects a fresh idle HUD — PULL the current state
// from the DevTools session (relayed via the service worker). devtools.js can't
// time this remount to push, so we ask on our own mount. No-op if DevTools isn't
// open for this tab; the HUD then correctly stays idle.
chrome.runtime.sendMessage({ type: "dev-sync:hud-ready" }, () => {
  void chrome.runtime.lastError; // no SW listener / no session — stay idle
});
