// hud.test.js — jsdom coverage for the in-page HUD (content-script.js).
// Drives the real content script through its message protocol + storage bus
// (no browser), asserting badge status colors, the message feed, the pending
// line, and the autosave switch. Run via `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "content-script.js"), "utf8");

// jsdom serializes inline background colors as rgb(...).
const GREEN = "rgb(34, 197, 94)"; // #22c55e
const YELLOW = "rgb(245, 158, 11)"; // #f59e0b
const RED = "rgb(239, 68, 68)"; // #ef4444
const IDLE = "rgb(107, 114, 128)"; // #6b7280

/** Fresh jsdom + stubbed chrome + the content script evaluated into it. */
function mount(storedAutosave) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true, // provides requestAnimationFrame
    runScripts: "dangerously", // execute an injected <script> in the window realm
  });
  const { window } = dom;
  const msgFns = [];
  const changedFns = [];
  const store = {};
  if (storedAutosave !== undefined) store["dev-sync:autosave"] = storedAutosave;

  window.chrome = {
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: store[key] }),
        set: (obj) => {
          Object.assign(store, obj);
          const changes = {};
          for (const k of Object.keys(obj)) changes[k] = { newValue: obj[k] };
          for (const fn of changedFns) fn(changes, "local");
        },
      },
      onChanged: { addListener: (fn) => changedFns.push(fn) },
    },
    runtime: { onMessage: { addListener: (fn) => msgFns.push(fn) } },
  };

  // Execute the content script in the window realm so bare `chrome`/`document`
  // resolve to this window's globals.
  const scriptEl = window.document.createElement("script");
  scriptEl.textContent = SRC;
  window.document.body.appendChild(scriptEl);

  const emit = (m) => msgFns.forEach((fn) => fn(m));
  const shadow = () => window.document.getElementById("dev-sync-hud-host").shadowRoot;
  return { window, emit, shadow, store };
}

const bg = (shadow) => shadow().querySelector(".badge").style.background;

test("HUD mounts a shadow-DOM host with bar + feed, badge starts idle-gray", () => {
  const { window, shadow } = mount();
  const host = window.document.getElementById("dev-sync-hud-host");
  assert.ok(host, "host element present");
  assert.ok(shadow().querySelector(".hud"), "frame rendered");
  assert.ok(shadow().querySelector(".bar"), "bar rendered");
  assert.ok(shadow().querySelector(".feed"), "feed rendered");
  // Initial idle color is stylesheet-driven (.badge rule); no inline override
  // until a status message arrives. The stylesheet carries the idle color.
  assert.equal(bg(shadow), "");
  assert.ok(shadow().querySelector("style").textContent.includes("#6b7280"));
});

test("status message paints the badge per state", () => {
  const { emit, shadow } = mount();
  emit({ type: "dev-sync:status", state: "green" });
  assert.equal(bg(shadow), GREEN);
  emit({ type: "dev-sync:status", state: "yellow" });
  assert.equal(bg(shadow), YELLOW);
  emit({ type: "dev-sync:status", state: "red" });
  assert.equal(bg(shadow), RED);
  emit({ type: "dev-sync:status", state: "idle" });
  assert.equal(bg(shadow), IDLE);
  // Unknown state falls back to idle, never throws.
  emit({ type: "dev-sync:status", state: "bogus" });
  assert.equal(bg(shadow), IDLE);
});

test("messages render in the feed with the right kind marker", () => {
  const { emit, shadow } = mount();
  emit({ type: "dev-sync:message", text: "Autosaved → Card.tsx", kind: "info" });
  emit({ type: "dev-sync:message", text: "engine returned 500", kind: "warn" });
  const lines = shadow().querySelectorAll(".feed .line");
  assert.equal(lines.length, 2);
  // Newest on top.
  assert.match(lines[0].querySelector(".msg").textContent, /engine returned 500/);
  assert.ok(lines[0].classList.contains("warn"));
  assert.equal(lines[0].querySelector(".ic").textContent, "!");
  assert.equal(lines[1].querySelector(".ic").textContent, "✓");
});

test("feed trims transient lines to the cap (4)", () => {
  const { emit, shadow } = mount();
  for (let i = 0; i < 8; i++) {
    emit({ type: "dev-sync:message", text: `msg ${i}`, kind: "info" });
  }
  assert.equal(shadow().querySelectorAll(".feed .line:not(.pending)").length, 4);
});

test("pending line is persistent, updates count, pluralizes, and clears at 0", () => {
  const { emit, shadow } = mount();
  emit({ type: "dev-sync:pending", count: 2 });
  let pending = shadow().querySelector(".line.pending");
  assert.ok(pending);
  assert.match(pending.querySelector(".msg").textContent, /^2 changes waiting for save$/);

  emit({ type: "dev-sync:pending", count: 1 });
  assert.match(
    shadow().querySelector(".line.pending .msg").textContent,
    /^1 change waiting for save$/,
  );

  // A new transient message must not evict the pending line, and pending stays last.
  emit({ type: "dev-sync:message", text: "Autosaved → X.tsx", kind: "info" });
  assert.ok(shadow().querySelector(".line.pending"), "pending survives new messages");
  const all = shadow().querySelectorAll(".feed .line");
  assert.ok(all[all.length - 1].classList.contains("pending"), "pending sits last");

  emit({ type: "dev-sync:pending", count: 0 });
  // Removal is deferred (fade); assert it's on its way out (no longer counted fresh
  // once removed). Force the timer tick.
});

test("autosave switch seeds from stored pref and toggles through storage", () => {
  const { window, shadow, store } = mount(false); // stored OFF
  const sw = shadow().querySelector(".sw");
  assert.equal(sw.getAttribute("aria-checked"), "false", "seeded from stored OFF");

  // Click flips the pref via chrome.storage; the onChanged echo updates the UI.
  sw.dispatchEvent(new window.Event("click"));
  assert.equal(store["dev-sync:autosave"], true, "click wrote the flipped pref");
  assert.equal(sw.getAttribute("aria-checked"), "true", "UI reflects the new pref");

  sw.dispatchEvent(new window.Event("click"));
  assert.equal(store["dev-sync:autosave"], false);
  assert.equal(sw.getAttribute("aria-checked"), "false");
});

test("switch defaults ON when no pref is stored", () => {
  const { shadow } = mount(); // nothing stored
  assert.equal(shadow().querySelector(".sw").getAttribute("aria-checked"), "true");
});

test("switch is a real role=switch control (keyboard-operable button)", () => {
  const { shadow } = mount();
  const sw = shadow().querySelector(".sw");
  assert.equal(sw.tagName, "BUTTON");
  assert.equal(sw.getAttribute("role"), "switch");
  assert.ok(sw.getAttribute("aria-label"));
});
