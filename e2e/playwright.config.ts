import { defineConfig } from "@playwright/test";
import path from "node:path";

// Repo root — webServer commands run pnpm workspace filters from here.
const root = path.resolve(import.meta.dirname, "..");

const VITE = "http://localhost:5299";
const NEXT = "http://localhost:4300";
const VUE = "http://localhost:5399";
const SVELTE = "http://localhost:5499";
const VE = "http://localhost:5599";

// The MV3 extension only injects on localhost origins (manifest `matches`), and
// Chromium loads unpacked extensions only under a persistent context — so the
// suite runs headed (the fixture launches `launchPersistentContext`). One
// worker, no parallelism: both example dev servers share a single browser and
// the engine's on-disk journal is global per origin, so tests must not race.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  projects: [
    { name: "vite", use: { baseURL: VITE } },
    { name: "next", use: { baseURL: NEXT } },
    { name: "vue", use: { baseURL: VUE } },
    { name: "svelte", use: { baseURL: SVELTE } },
    { name: "ve", use: { baseURL: VE } },
  ],
  webServer: [
    {
      command: "pnpm --filter vite-react dev",
      cwd: root,
      url: VITE,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
    },
    {
      // Next webpack dev is slow to first-compile — give it a generous window.
      command: "pnpm --filter next-app dev",
      cwd: root,
      url: NEXT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
    },
    {
      command: "pnpm --filter vue-app dev",
      cwd: root,
      url: VUE,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
    },
    {
      command: "pnpm --filter @dev-sync/example-svelte-app dev",
      cwd: root,
      url: SVELTE,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
    },
    {
      command: "pnpm --filter @dev-sync/example-ve-app dev",
      cwd: root,
      url: VE,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
    },
  ],
});
