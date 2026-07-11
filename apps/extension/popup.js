// popup.js — browser-action popup: autosave toggle + on-demand sync.
// Shares the autosave pref (chrome.storage.local) with the DevTools panel;
// a storage.onChanged listener in panel.js keeps an open panel in sync.

"use strict";

const AUTOSAVE_KEY = "css-sync:autosave";
const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

const $ = (id) => document.getElementById(id);
const autosaveEl = $("autosave");
const dot = $("p-dot");
const syncBtn = $("sync-now");
const syncNote = $("sync-note");

$("shortcut").textContent = IS_MAC ? "⌘⇧S" : "Ctrl+Shift+S";

function renderAutosave(on) {
  autosaveEl.checked = on;
  dot.className = `p-dot ${on ? "on" : "off"}`;
  dot.title = on ? "autosave on" : "autosave off";
}

// Default ON when unset.
chrome.storage.local.get(AUTOSAVE_KEY, (stored) => {
  const val = stored ? stored[AUTOSAVE_KEY] : undefined;
  renderAutosave(val === undefined ? true : Boolean(val));
});

autosaveEl.addEventListener("change", () => {
  const on = autosaveEl.checked;
  chrome.storage.local.set({ [AUTOSAVE_KEY]: on });
  renderAutosave(on);
});

function note(text, ok) {
  syncNote.textContent = text;
  syncNote.className = `p-note ${ok ? "ok" : "warn"}`;
}

syncBtn.addEventListener("click", () => {
  syncBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "sync-now-request" }, (res) => {
    syncBtn.disabled = false;
    if (chrome.runtime.lastError || !res) {
      note("Could not reach the extension worker.", false);
      return;
    }
    if (res.ok) {
      note("Sync triggered — check the page toast.", true);
    } else {
      note(res.reason || "Open DevTools on this tab first (capture attaches automatically).", false);
    }
  });
});

$("shortcut-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});
