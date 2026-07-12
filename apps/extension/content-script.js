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
// Messages arrive from the service worker (relayed from the DevTools client):
//   dev-sync:status  { state: "green" | "yellow" | "red" | "idle" }
//   dev-sync:message { text, kind: "info" | "warn" }
//   dev-sync:pending { count }
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

let hud = null; // { root, badge, feed, switchEl } once built

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
    }
    .bar {
      display:flex; align-items:center; gap:10px;
      padding:9px 11px; background:#20233340; border-bottom:1px solid #2c3145;
    }
    .badge {
      flex:0 0 auto; width:22px; height:22px; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      background:${STATUS_COLOR.idle}; transition:background .25s ease;
    }
    .badge svg { width:13px; height:13px; display:block; }
    .title { flex:1 1 auto; font-weight:600; letter-spacing:.01em; }
    .title small { display:block; font-weight:400; font-size:11px; color:#9aa1b3; }
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
    .feed { list-style:none; margin:0; padding:6px; display:flex; flex-direction:column; gap:5px; }
    .feed:empty { display:none; }
    .line {
      display:flex; align-items:flex-start; gap:7px; padding:6px 8px;
      background:#232838; border-radius:7px; border-left:3px solid #3b82f6;
      opacity:0; transform:translateY(4px); transition:opacity .18s ease, transform .18s ease;
    }
    .line.show { opacity:1; transform:none; }
    .line.warn { border-left-color:#f59e0b; }
    .line.pending { border-left-color:#f59e0b; background:#2a2438; }
    .line .ic { flex:0 0 auto; font-weight:700; color:#3b82f6; }
    .line.warn .ic, .line.pending .ic { color:#f59e0b; }
    .line .msg { word-break:break-word; }
    @media (prefers-reduced-motion: reduce) {
      .badge,.sw,.sw::after,.line { transition:none; }
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
  const titleName = document.createElement("span");
  titleName.textContent = "dev-sync";
  const titleSub = document.createElement("small");
  titleSub.textContent = STATUS_LABEL.idle;
  title.append(titleName, titleSub);

  const switchEl = document.createElement("button");
  switchEl.className = "sw";
  switchEl.setAttribute("role", "switch");
  switchEl.setAttribute("aria-checked", "true");
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

  frame.append(bar, feed);
  root.appendChild(frame);

  hud = { root, badge, feed, switchEl, titleSub };
  return hud;
}

function setStatus(state) {
  const h = buildHud();
  const s = STATUS_COLOR[state] ? state : "idle";
  h.badge.style.background = STATUS_COLOR[s];
  h.badge.setAttribute("aria-label", STATUS_LABEL[s]);
  h.badge.title = STATUS_LABEL[s];
  h.titleSub.textContent = STATUS_LABEL[s];
}

function pushMessage(text, kind) {
  const h = buildHud();
  const li = document.createElement("li");
  li.className = `line ${kind === "warn" ? "warn" : ""}`;
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

function reflectAutosave(on) {
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
  if (msg.type === "dev-sync:message" && typeof msg.text === "string") {
    pushMessage(msg.text, msg.kind);
  } else if (msg.type === "dev-sync:status") {
    setStatus(String(msg.state || "idle"));
  } else if (msg.type === "dev-sync:pending") {
    setPending(Number(msg.count) || 0);
  }
});

// Build the HUD immediately so it's always visible on a dev page.
buildHud();
