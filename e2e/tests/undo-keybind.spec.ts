import { test, expect, HUD_HOST } from "../fixtures";
import fs from "node:fs";
import path from "node:path";

// Cmd/Ctrl+Z on the page is handled by the content script: it POSTs the engine's
// /__dev-sync/undo and toasts the result. jsdom already covers the keybind logic
// with a mocked fetch — these tests prove the *real* wiring in a browser: the
// keydown reaches a live extension content script, which reaches a live engine.

const UNDO = process.platform === "darwin" ? "Meta+z" : "Control+z";
const REDO = process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z";

// Bring the page to front and ensure focus sits on <body> (not an input/DevTools)
// so the content script's document keydown listener actually fires — the guard
// skips Cmd+Z when the target is INPUT/TEXTAREA/SELECT/contentEditable.
async function focusPage(page: import("@playwright/test").Page) {
  await page.bringToFront();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test("Cmd/Ctrl+Z reaches the apply engine and renders a toast", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(HUD_HOST)).toBeAttached({ timeout: 15_000 });
  await focusPage(page);

  const undoReq = page.waitForRequest(
    (r) => r.url().includes("/__dev-sync/undo") && r.method() === "POST",
  );
  await page.keyboard.press(UNDO);

  const resp = await (await undoReq).response();
  expect(resp?.ok()).toBeTruthy();

  // The toast (feed <li> or the status row) reports the outcome — either an undo
  // count or the empty-journal message. getByText pierces the HUD shadow DOM.
  await expect(page.getByText(/Undid \d+ change|Nothing to undo/)).toBeVisible({ timeout: 5_000 });
});

test("Cmd/Ctrl+Shift+Z reaches the redo route and renders a toast", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(HUD_HOST)).toBeAttached({ timeout: 15_000 });
  await focusPage(page);

  const redoReq = page.waitForRequest(
    (r) => r.url().includes("/__dev-sync/redo") && r.method() === "POST",
  );
  await page.keyboard.press(REDO);

  const resp = await (await redoReq).response();
  expect(resp?.ok()).toBeTruthy();
  await expect(page.getByText(/Redid \d+ change|Nothing to redo/)).toBeVisible({ timeout: 5_000 });
});

// The full round trip: a real /apply commit writes source, then Cmd/Ctrl+Z on
// the page reverts that exact file on disk. Only meaningful on the Vite example
// (whose engine is jailed to a project root with a plain-CSS source we can edit).
test("a committed change is reverted on the disk by Cmd/Ctrl+Z", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "vite", "seed targets the vite-react App.css source");

  const cssPath = path.resolve(import.meta.dirname, "../../examples/vite-react/src/App.css");

  // Normalise the target declaration to the pristine value first, so the test is
  // idempotent even if a prior crashed run left the source mid-edit. This
  // normalised content is the baseline we assert the undo restores to.
  const before = fs.readFileSync(cssPath, "utf8").replace("background: #16a34a;", "background: #6366f1;");
  fs.writeFileSync(cssPath, before);

  try {
    // Exactly what the extension emits for a plain-CSS (postcss) Styles-panel edit.
    const sheet = {
      id: "e2e-plain",
      sourceURL: "http://localhost:5299/src/App.css",
      origin: "regular" as const,
    };
    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5299/",
        applyMode: "commit",
        changes: [
          {
            op: "modify",
            styleSheet: sheet,
            selector: ".plain-card__badge",
            property: "background",
            oldValue: "#6366f1",
            newValue: "#16a34a",
          },
        ],
      },
    });
    expect(applyRes.status(), await applyRes.text()).toBe(200);
    const result = await applyRes.json();
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].mode).toBe("postcss");

    // Source really changed on disk.
    const afterApply = fs.readFileSync(cssPath, "utf8");
    expect(afterApply).not.toBe(before);
    expect(afterApply).toContain("#16a34a");

    // Now undo from the page — the browser keybind, not another HTTP call. The
    // toast is asserted in the test above; here the write-back reload races the
    // toast, so we assert the outcome that matters: the engine reverted (1) and
    // the source file is byte-restored on disk.
    await page.goto("/");
    await expect(page.locator(HUD_HOST)).toBeAttached({ timeout: 15_000 });
    await focusPage(page);

    const undoReq = page.waitForRequest(
      (r) => r.url().includes("/__dev-sync/undo") && r.method() === "POST",
    );
    await page.keyboard.press(UNDO);
    await undoReq;

    // The revert restored the file byte-for-byte. Poll the disk rather than read
    // the undo response body — the write-back triggers a Vite HMR reload that can
    // discard the network resource before we could read it; the file is truth.
    await expect
      .poll(() => fs.readFileSync(cssPath, "utf8"), {
        timeout: 5_000,
        message: "Cmd/Ctrl+Z should revert App.css on disk",
      })
      .toBe(before);

    // Redo it: Cmd/Ctrl+Shift+Z re-applies the change the undo just reverted.
    const redoReq = page.waitForRequest(
      (r) => r.url().includes("/__dev-sync/redo") && r.method() === "POST",
    );
    await page.keyboard.press(REDO);
    await redoReq;
    await expect
      .poll(() => fs.readFileSync(cssPath, "utf8"), {
        timeout: 5_000,
        message: "Cmd/Ctrl+Shift+Z should re-apply the change on disk",
      })
      .toBe(afterApply);
  } finally {
    // Never leave the example source dirty, whatever failed above.
    fs.writeFileSync(cssPath, before);
  }
});
