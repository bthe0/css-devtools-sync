// harness-main.js — the MAIN-world half of the in-page capture harness.
//
// harness.js runs in the content-script ISOLATED world: it shares the page's
// DOM/CSSOM (so CSS capture works there directly) but NOT the page's JS heap,
// where the framework runtime stashes each element's `__srcLoc`. serializeElements()
// needs that expando, so it has to run in the MAIN world — this file is that
// world's agent. It's declared as a `"world": "MAIN"` content script (not an
// injected inline <script>, which a page CSP can block and which executes
// unreliably from an isolated-world insertion), so it's extension-injected,
// CSP-exempt, and always present.
//
// Protocol (window.postMessage, structured-cloned across worlds):
//   isolated -> { __dsHarness: "eval", id, expr }        (expr = capture-core's
//                                                          SERIALIZE_ELEMENTS)
//   main     -> { __dsHarness: "eval-result", id, ok, result | error }
//
// Gated on the same ?dsHarness opt-in as harness.js, so the eval listener only
// arms when the harness is explicitly requested — it never sits on a normal dev
// page. `expr` is always capture-core's own serialize string (the isolated side
// sources it from the module, page script can't inject a different one that the
// harness would act on), and the origin is pinned to same-window/same-origin.

"use strict";

(function () {
  if (!/[?&]dsHarness(=|&|$)/.test(location.search)) return;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__dsHarness !== "eval" || typeof data.expr !== "string") return;

    let reply;
    try {
      // eslint-disable-next-line no-eval -- evaluating capture-core's own
      // SERIALIZE_ELEMENTS string in the page world, exactly as devtools.js hands
      // it to inspectedWindow.eval; the value is a JSON string.
      const result = window.eval(data.expr);
      reply = { __dsHarness: "eval-result", id: data.id, ok: true, result };
    } catch (err) {
      reply = {
        __dsHarness: "eval-result",
        id: data.id,
        ok: false,
        error: String((err && err.message) || err),
      };
    }
    window.postMessage(reply, location.origin);
  });
})();
