import { test, expect, HUD_HOST } from "../fixtures";

// Only a real browser can prove the MV3 extension packages, loads, and injects
// its content script — jsdom mounts the HUD directly, bypassing manifest matches
// and CSP. This is the packaging/injection smoke test, run against each example.
test("injects the dev-sync HUD on the dev app", async ({ page }) => {
  await page.goto("/");

  const host = page.locator(HUD_HOST);
  await expect(host).toBeAttached({ timeout: 15_000 });

  // Playwright's CSS engine pierces the open shadow root the content script
  // mounts the widget under, so the descendant reaches into the shadow DOM.
  await expect(page.locator(`${HUD_HOST} .hud`)).toBeVisible();
});
