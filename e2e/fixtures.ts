import { test as base, chromium, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Unpacked MV3 extension under test.
const EXTENSION_PATH = path.resolve(import.meta.dirname, "../apps/extension");

// Playwright can only load a Chrome extension through a *persistent* context,
// and MV3 unpacked extensions require a headed Chromium. This fixture swaps the
// default `browser`/`context`/`page` for a persistent context that has the
// dev-sync extension loaded, so its content script injects the HUD on the
// localhost example pages exactly as it would for a real user.
export const test = base.extend<{ context: BrowserContext }>({
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-sync-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    // Wait for the MV3 service worker to boot so the extension is fully live
    // before the first navigation (best-effort — the content script renders the
    // HUD regardless, but this removes a startup race on the very first test).
    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 10_000 }).catch(() => {});
    }

    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },
  // Reuse the persistent context's initial page instead of the default
  // browser-scoped one (which doesn't exist here).
  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

export const expect = test.expect;

/** Shadow-DOM host id the content script mounts the HUD under (manifest-injected). */
export const HUD_HOST = "#dev-sync-hud-host";
