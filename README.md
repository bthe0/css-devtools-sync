# css-devtools-sync

Dev tool that syncs CSS edits made in Chrome DevTools (Styles panel) back to your local source files — plain CSS, Sass modules, Emotion css-in-js, and Tailwind class lists — via a local apply server and a DevTools extension.

## Monorepo layout

```
packages/
  contract/                      @css-sync/contract — wire protocol (Zod v4 schemas + TS types)
  babel-plugin-source-locator/   @css-sync/babel-plugin-source-locator — stamps JSX with data-source-* attrs (dev only) + Vite wrapper
apps/
  server/                        @css-sync/server — local apply engine on 127.0.0.1:7777, writes are jailed to CSS_SYNC_WORKSPACE_ROOT
  test-app/                      @css-sync/test-app — fixture app on :5199 exercising every tier
  extension/                     Chrome MV3 DevTools extension (plain JS, loaded unpacked — not a workspace package)
```

`@css-sync/contract` is the single source of truth for the extension <-> server protocol. See [PLAN.md](./PLAN.md) for honest per-tier status.

## Full run-through

### 1. Install + build

```sh
pnpm install
pnpm build          # builds contract + babel plugin dists (test-app's vite.config imports the plugin's dist)
```

### 2. Start the sync server (port 7777)

The server refuses to start without `CSS_SYNC_WORKSPACE_ROOT` and will only ever write inside it. Point it at the test app:

```sh
CSS_SYNC_WORKSPACE_ROOT="$PWD/apps/test-app" pnpm --filter @css-sync/server dev
```

(Optionally `export ANTHROPIC_API_KEY=...` first — enables LLM-assisted *placement* of brand-new rules when several candidate files exist. Everything else is deterministic; see `.env.example`. The server reads plain env vars, it does not auto-load `.env`.)

### 3. Start the test app (port 5199)

```sh
pnpm --filter @css-sync/test-app dev
```

Open http://localhost:5199 — Vite dev serve runs the source-locator plugin, so every JSX host element carries `data-source-file` / `data-source-line` / `data-source-component`.

### 4. Load the extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `apps/extension/`.

### 5. Sync an edit

1. Open http://localhost:5199, open DevTools, switch to the **Source Sync** panel and attach (uses `chrome.debugger` — expect Chrome's yellow "started debugging" banner; don't dismiss it).
2. In **Elements → Styles**, select e.g. the PlainCard and change `border-radius` on `.plain-card`.
3. The change appears in the Source Sync panel diff list. Click **Sync**.
4. Watch `apps/test-app/src/components/PlainCard.css` change on disk; Vite HMR reloads the page with the edit now coming from source.
5. Click **Verify** — the extension re-reads computed styles via CDP and POSTs them to `/verify`; mismatches are listed, green banner otherwise.

New rules typed in DevTools (e.g. `.plain-card:hover { ... }`) land in the inspector sheet and go through the placement engine (deterministic candidates first, LLM tiebreak only with `ANTHROPIC_API_KEY` set and `APP_ENV != production`).

## What edits map where (per tier)

| Component (test-app) | Styling tier | Edit this in DevTools | Source file that changes | Apply mode |
|---|---|---|---|---|
| `PlainCard` | Plain CSS file | `.plain-card*` rules in Styles | `apps/test-app/src/components/PlainCard.css` | `postcss` |
| `ScssPanel` | Sass module (compiled, sourcemapped) | `.panel*` (hashed module classes) in Styles | `apps/test-app/src/components/ScssPanel.module.scss` | `sourcemap` |
| `EmotionButton` | Emotion `styled` css-in-js | `css-*--EmotionButton*` classes in Styles | template literal in `apps/test-app/src/components/EmotionButton.tsx` | `cssinjs` |
| `TailwindHero` | Tailwind utilities | a utility class declaration (e.g. `.p-8`) in Styles | `className` string in `apps/test-app/src/components/TailwindHero.tsx` (utility swap, e.g. `p-8` → `p-[40px]`) | `classlist` |
| `StaticBlock` | Static JSX with inline `style` | — **not syncable yet** | would be `apps/test-app/src/components/StaticBlock.tsx` | n/a (see PLAN.md Tier 5) |

## Dev commands

```sh
pnpm build        # build all packages/apps (topological)
pnpm typecheck    # builds packages, then tsc --noEmit everywhere
pnpm test         # vitest: server (28 tests) + babel plugin (4 tests)
```
