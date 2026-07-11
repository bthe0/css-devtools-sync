// content-script.js — runs in the inspected page (localhost dev apps only,
// see manifest matches). Its sole job now is rendering the in-page autosave
// toast in a Shadow DOM host.
//
// Element source location is NO LONGER read here: it lives off-DOM as a
// `__srcLoc` JS property on each node (attached by the source-locator runtime
// ref) and is read directly from the page's main world by the devtools client
// via inspectedWindow.eval / CDP — the old `data-css-sync-inspected` marker +
// get-context round-trip are gone.

"use strict";

// ---------------------------------------------------------------------------
// In-page autosave toast ("✓ Autosaved → file.tsx")
// Rendered in a Shadow DOM host so the page's own CSS can never restyle or
// hide it. Stacks up to 3, auto-dismisses, honors prefers-reduced-motion.
// ---------------------------------------------------------------------------

const TOAST_HOST_ID = "css-sync-toast-host";
const TOAST_TTL_MS = 3200;
const TOAST_MAX = 3;

function toastRoot() {
  let host = document.getElementById(TOAST_HOST_ID);
  if (host && host.shadowRoot) return host.shadowRoot;

  host = document.createElement("div");
  host.id = TOAST_HOST_ID;
  // Inline the container positioning on the host itself so even a missing
  // <body> or an aggressive reset can't collapse it.
  host.style.cssText =
    "position:fixed;z-index:2147483647;right:16px;bottom:16px;" +
    "display:flex;flex-direction:column;gap:8px;pointer-events:none;";
  (document.body || document.documentElement).appendChild(host);

  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .t {
      pointer-events:auto; max-width:340px;
      font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      color:#e8eaf0; background:#1b1e2b; border:1px solid #2c3145;
      border-left:3px solid #3b82f6; border-radius:8px;
      padding:10px 12px; box-shadow:0 6px 20px rgba(0,0,0,.35);
      display:flex; align-items:flex-start; gap:8px;
      opacity:0; transform:translateY(8px); transition:opacity .18s ease, transform .18s ease;
    }
    .t.show { opacity:1; transform:none; }
    .t.warn { border-left-color:#eab308; }
    .t .ic { flex:0 0 auto; font-weight:700; color:#3b82f6; }
    .t.warn .ic { color:#eab308; }
    .t .msg { word-break:break-word; }
    @media (prefers-reduced-motion: reduce) {
      .t { transition:none; opacity:1; transform:none; }
    }`;
  root.appendChild(style);
  return root;
}

function showToast(text, kind) {
  const root = toastRoot();
  // Trim overflow: drop oldest beyond the cap-1 we're about to add.
  const existing = root.querySelectorAll(".t");
  for (let i = 0; i <= existing.length - TOAST_MAX; i++) existing[i].remove();

  const el = document.createElement("div");
  el.className = `t ${kind === "warn" ? "warn" : ""}`;
  el.setAttribute("role", "status");
  const ic = document.createElement("span");
  ic.className = "ic";
  ic.textContent = kind === "warn" ? "!" : "✓";
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = text;
  el.append(ic, msg);
  root.appendChild(el);

  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 220);
  }, TOAST_TTL_MS);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "css-sync:toast" && typeof msg.text === "string") {
    showToast(msg.text, msg.kind);
  }
});
