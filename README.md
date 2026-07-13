<div align="center">

<img src="./brand/logo.png" alt="dev-sync" width="360" />

<h1>dev-sync</h1>

**Edit CSS in Chrome DevTools → it writes back to your source files.**

Plain CSS · Sass modules · Emotion/styled css-in-js · Tailwind class lists — synced from the Styles panel to disk through a local apply engine and a DevTools extension.

<img src="./docs/screenshots/demo.gif" alt="Editing CSS in Chrome DevTools and watching it write back to source across every styling tier" width="720" />

<!-- badges -->
[![CI](https://github.com/bthe0/css-devtools-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/bthe0/css-devtools-sync/actions/workflows/ci.yml)
[![CodeQL](https://github.com/bthe0/css-devtools-sync/actions/workflows/codeql.yml/badge.svg)](https://github.com/bthe0/css-devtools-sync/actions/workflows/codeql.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-10.12-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.base.json)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vite.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/bthe0)

</div>

---

> **🤖 Setting this up with an AI agent?** Point it at **[`README_LLM.md`](./README_LLM.md)** — a step-by-step setup runbook written for LLMs (verify toolchain → install/build/test → pick the write-jail root → load the extension). It stops to ask you where to run and before touching your browser.

## Requirements

- **Node ≥ 20** and **pnpm 10** (pinned via `packageManager`).
- A **Vite** app (Vue, Svelte, Qwik, or React + Vite) via `@dev-sync/vite`, **or Next.js (App Router)** via `@dev-sync/webpack` — see [Next.js](#nextjs-app-router) below. Next runs on the **webpack** dev server (`next dev --webpack`); Turbopack has no stable plugin API and is unsupported. Nuxt/Astro/SvelteKit aren't supported yet.
- **Chrome** (the DevTools extension is Chromium MV3).

**AI-assisted rule placement is optional.** All five apply tiers are fully deterministic and run with no API key. Setting `ANTHROPIC_API_KEY` only lets Claude break ties when a *brand-new* rule could plausibly land in several source files; without it, dev-sync falls back to a deterministic pick. LLM placement is disabled entirely when `APP_ENV=production`. **Claude is not required to run dev-sync.**

## What it does

You tweak `border-radius` on a rule in the DevTools **Styles** panel. `dev-sync` figures out which source construct produced that rule — a `.css` file, a compiled `.module.scss`, an Emotion template literal, or a Tailwind utility in a `className` — and writes the edit **back into that source**. Vite HMR reloads, and the change now comes from your code, not a runtime override.

It resolves DevTools → source through two channels:

- **CSS → source**: CSS sourcemaps (enabled automatically by the `devSync()` bundler plugin) plus per-tier apply strategies (`postcss`, `sourcemap`, `cssinjs`, `classlist`).
- **DOM element → source**: a Babel plugin stamps every JSX host element at dev time with a **non-enumerable `__srcLoc` JS property** (`{ dataSourceFile, dataSourceLine, dataSourceComponent }`) — read off `$0.__srcLoc` over CDP. It is *not* a `data-source-*` DOM attribute (those would pollute the Elements panel).

## The test app

The fixture app exercises every styling tier in one page — each block maps to a distinct apply strategy (plain CSS, CSS Modules, Sass sourcemap, css-in-js, Tailwind class lists, static markup, image attrs). The demo above runs against it.

## Quick start (drop-in)

One plugin self-configures the CSS sourcemap, boots the apply engine on your dev server's own origin, and stamps JSX:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devSync } from "@dev-sync/vite";

export default defineConfig({
  plugins: [react(), devSync()],
});
```

Or let the CLI detect your stack and edit the config for you (previews a diff, writes only on confirm):

```sh
pnpm dlx @dev-sync/server init
```

Then **Load unpacked** `apps/extension/` at `chrome://extensions` (Developer mode on), open your app's DevTools, and use the **Source Sync** panel.

### Next.js (App Router)

Next runs on the **webpack** dev server (`next dev --webpack` — Turbopack is unsupported). Three small pieces:

```ts
// next.config.ts
import { withDevSync } from "@dev-sync/webpack";
export default withDevSync({ /* your config */ });
```

```ts
// pages/api/__dev-sync/[...path].ts — mounts the apply engine on your origin
import { createDevSyncHandler, engineApiConfig } from "@dev-sync/webpack/handler";
export const config = engineApiConfig;
export default createDevSyncHandler();
```

```json
// .babelrc — stamps JSX host elements (switches Next to Babel in dev)
{ "presets": ["next/babel"], "plugins": [["@dev-sync/babel-plugin-source-locator", { "root": ".", "requireUseClientDirective": true }]] }
```

`withDevSync` rewrites the page-origin `/__dev-sync/*` onto the API route and forces CSS dev sourcemaps; the `.babelrc` is what enables the element / set-text / Tailwind tiers (CSS-file/module/scss/emotion tiers work without it). Then run `next dev --webpack` and **Load unpacked** the extension as above.

> **App Router (RSC):** the stamp attaches a `ref`, which is illegal in a React Server Component — so `requireUseClientDirective: true` gates stamping to modules that open with `"use client"`. Put it on the pages/components whose **element / Tailwind** edits you want synced; the **CSS-file / CSS-Module / Sass / Emotion** tiers resolve via sourcemaps and need no `"use client"`. Without the flag, `next/babel` stamps `<html>`/`<body>` in your root layout and every route 500s. (Also: drop `next/font` — it requires SWC and conflicts with the Babel config; use a plain CSS font stack.)

### Undo / Redo

**Cmd/Ctrl+Z** on the page reverts the last applied rule change (via the engine's `/undo`); **Cmd/Ctrl+Shift+Z** re-applies it (`/redo`). Focus the page (e.g. click the HUD) first — a Cmd+Z inside the DevTools Styles panel never reaches the page. Redo only fires when the last action was an undo; a fresh edit after an undo clears it (the journal's newest entry is no longer an undo).

### Examples

Runnable in [`examples/`](./examples): [`next-app`](./examples/next-app) (Next.js App Router, `next dev --webpack`, port 4300), [`vite-react`](./examples/vite-react) (Vite + React, port 5299), [`vue-app`](./examples/vue-app) (Vue 3 SFC, port 5399), [`svelte-app`](./examples/svelte-app) (Svelte 5, port 5499), and [`ve-app`](./examples/ve-app) (vanilla-extract `.css.ts`, port 5599) — each demoing multiple styling tiers on one page.

## Monorepo layout

```
packages/
  contract/                      @dev-sync/contract — wire protocol (Zod v4 schemas + TS types)
  babel-plugin-source-locator/   @dev-sync/babel-plugin-source-locator — stamps JSX host elements
                                 with the off-DOM __srcLoc property (dev only) + Vite wrapper
  vite/                          @dev-sync/vite — drop-in devSync() plugin: CSS devSourcemap +
                                 apply engine on the dev-server origin + source-locator
  webpack/                       @dev-sync/webpack — Next.js (webpack dev): withDevSync() config
                                 wrapper + createDevSyncHandler (pages/api engine mount)
apps/
  server/                        @dev-sync/server — apply engine + `dev-sync init` CLI; writes are
                                 jailed to DEV_SYNC_WORKSPACE_ROOT (fail-closed)
  test-app/                      @dev-sync/test-app — fixture app exercising every styling tier
  extension/                     Chrome MV3 DevTools extension (plain JS, loaded unpacked)
examples/
  next-app/                      Next.js App Router demo (next dev --webpack, port 4300)
  vite-react/                    Vite + React demo (port 5299)
  vue-app/                       Vue 3 SFC demo — <style scoped> + <style module> (port 5399)
  svelte-app/                    Svelte 5 demo — component-scoped <style> (port 5499)
  ve-app/                        vanilla-extract demo — style({...}) in .css.ts (port 5599)
e2e/                             @dev-sync/e2e — Playwright suite: loads the unpacked
                                 extension, drives the live examples end-to-end
```

`@dev-sync/contract` is the single source of truth for the extension ⇄ server protocol.

## Framework support

Frameworks split three ways:

| Bucket | Frameworks | Integration |
|---|---|---|
| **Vite-plugin** (editable `plugins` array) | Vue, Svelte, Qwik, plain React+Vite | `@dev-sync/vite` — `devSync()` in your config |
| **Next.js (webpack dev)** | Next.js App Router | `@dev-sync/webpack` — `withDevSync()` + engine handler + `.babelrc` (see [above](#nextjs-app-router)) |
| **Not yet supported** | Nuxt, Astro, SvelteKit, Remix, SolidStart | detected & skipped by `init` with a note |

> **Turbopack:** Next's `next dev` defaults to Turbopack, which has no stable plugin API — run `next dev --webpack`. The webpack path is where `withDevSync` attaches.

## What edits map where (per tier)

| Component (test-app) | Styling tier | Edit in DevTools | Source that changes | Apply mode |
|---|---|---|---|---|
| `PlainCard` | Plain CSS file | `.plain-card*` rules | `PlainCard.css` | `postcss` |
| `ScssPanel` | Sass module (sourcemapped) | `.panel*` (hashed classes) | `ScssPanel.module.scss` | `sourcemap` |
| `EmotionButton` | Emotion `styled` | `css-*--EmotionButton*` classes | template literal in `EmotionButton.tsx` | `cssinjs` |
| `TailwindHero` | Tailwind utilities | a utility class (e.g. `.p-8`) | `className` in `TailwindHero.tsx` (`p-8` → `p-[40px]`) | `classlist` |
| `StaticBlock` | Static JSX text/attrs | literal text / `aria-label` / `title` | `StaticBlock.tsx` | markup set-text/set-attr |
| `ScopedCard.vue` | Vue SFC `<style scoped>` | `.card[data-v-*]` scoped rules | the `<style>` block in `ScopedCard.vue` | `sourcemap` |
| `Card.svelte` | Svelte component `<style>` | `.card.svelte-*` scoped rules | the `<style>` block in `Card.svelte` | `postcss` |
| `card.css.ts` | vanilla-extract `style({...})` | `<file>_<export>__<hash>` classes (incl. `:hover` / `@media`) | the `style({...})` object in `card.css.ts` | `vanilla-extract` |

The last three are the **SFC tier** (Vue/Svelte `.vue`/`.svelte` `<style>` blocks — edited in place, template/script byte-identical) and the **vanilla-extract tier** (`.css.ts` `style({...})` object literals — attribution by parsing the served debug class name, since VE emits no usable sourcemap). vanilla-extract v1 edits plain `style({...})` objects (flat + `selectors`/`@media` nesting); `styleVariants`, `recipe`, and array/multi-arg composition skip with a clear reason rather than guess.

## Local development

```sh
pnpm install
pnpm build          # topological: builds contract + babel plugin + vite dists first
pnpm typecheck      # builds packages, then tsc --noEmit everywhere
pnpm test           # vitest across every workspace (470 tests)
pnpm test:e2e       # Playwright: loads the extension, drives the live examples
```

### End-to-end tests

`e2e/` is a Playwright suite that boots the two example dev servers and loads the
**real unpacked extension** in a persistent Chromium context (MV3 → headed). It
proves what the unit suites can't reach: the extension packages and injects its
HUD, the apply engine is mounted on the page origin, and **Cmd/Ctrl+Z** on the
page reaches the live engine and reverts a committed edit on disk. One boundary
holds for any tool: no automation API can drive the Chrome **DevTools Styles
panel**, so the literal "edit a rule in DevTools" gesture is exercised by POSTing
the exact `CapturePayload` the extension would emit — everything below the panel
is covered.

```sh
pnpm --filter @dev-sync/e2e exec playwright install chromium  # one-time
pnpm test:e2e
```

Run the fixture app + engine against the test app:

```sh
# apply engine, jailed to the test app; refuses to start without the root
DEV_SYNC_WORKSPACE_ROOT="$PWD/apps/test-app" pnpm --filter @dev-sync/server dev

# the fixture app (source-locator + apply engine mounted on its own origin)
pnpm --filter @dev-sync/test-app dev
```

Optionally `export ANTHROPIC_API_KEY=...` to enable LLM-assisted *placement* of brand-new rules when several candidate files tie (deterministic otherwise; disabled when `APP_ENV=production`).

## Support

I build small, sharp developer tools and ship them open source — no paywalls, no upsells. If dev-sync saved you a debugging session, a coffee keeps the next tool coming.

<a href="https://buymeacoffee.com/bthe0"><img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-bthe0-FFDD00?logo=buymeacoffee&logoColor=black&style=for-the-badge" alt="Buy Me A Coffee" /></a>

## License

MIT © [bthe0](https://github.com/bthe0)
