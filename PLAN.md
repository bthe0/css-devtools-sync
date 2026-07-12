# css-devtools-sync — Plan

Five tiers, built as phases. Status below reflects what is actually implemented and passing (integration pass 2026-07-10: workspace install/build/typecheck green, 32 tests passing).

---

## Follow-up (2026-07-11) — fix set-attr, Tailwind, Emotion, styled-components sync

These four rode the dead SW chrome.debugger DOM-capture path or a missing map. Fix each in
the working eval-poller (devtools.js) / server tiers. CSS change schemas ALREADY carry
`element: ElementContextSchema.optional()` — no contract change for Tailwind/styled.

- **C1 set-attr/remove-attr (devtools.js only):** SERIALIZE_ELEMENTS adds `attrs` map
  (exclude class/style/instrumentation); pollElements diffs keyed `file:line|attr` →
  buildSetAttrChange/buildRemoveAttrChange; `suppressedSetAttr` guard (mirror set-text).
- **C2 Tailwind (devtools.js only):** track `selectedElement` (onSelectionChanged); pollCss
  attaches `change.element = selectedElement`. classlist tier then edits className.
- **C3 Emotion (devtools.js only):** Emotion `<style data-emotion>` sheets carry a per-sheet
  sourcemap → EmotionButton.tsx, but poller strips `range` → cssinjs line=null → "ambiguous"
  skip. Mark sheets whose sourceMapURL decodes to JS-like sources as `cssinjs`; send
  range {0,0,0,0} instead of deleting → server maps position→template line.
- **C4 styled-components (server + devtools.js):** data-styled sheet, no map, rule = hash
  `.hdbeaO`, element `__srcLoc` NULL. Only identity = displayName class `StyledBadge__Pill`
  (File__Var). Attach selectedElement (has classList); new server apply-styled.ts resolves
  File+Var → `const Var = styled\`\`` template line → applyCssInJsChange. Fragile by design.

Verify each live (CfT 9334): edit → source changes; idle 16s = 0 POSTs; suites green.
Backups: /tmp/EmotionButton.tsx.bak /tmp/StyledBadge.tsx.bak (main.tsx already reverted).

## Phase 1 — Contract (Tier 1) ✅ DONE
- [x] `@dev-sync/contract`: Zod v4 schemas + derived TS types for the extension<->server wire protocol
  (StyleSheetRef, SourceRange, ElementContext, ModifyChange/AddDeclChange/DeleteDeclChange/AddRuleChange, CapturePayload, ApplyOutcome, ApplyResult, VerifyRequest, VerifyResult)
- [x] Instrumentation attribute-name constants (data-source-file / data-source-line / data-source-component)

## Phase 2 — Capture (Tier 2) ⚠️ PARTIAL (CSS capture done; DOM markup capture missing)
- [x] `apps/extension`: MV3 DevTools extension. `chrome.debugger` (CDP 1.3) session per tab; snapshots every stylesheet on `CSS.styleSheetAdded`, diffs on `CSS.styleSheetChanged` (300 ms debounce), builds `CapturePayload`, POSTs to `127.0.0.1:7777/apply` from the Source Sync panel.
- [x] Element context capture: reads `data-source-*` attrs + classList from the inspected element (Elements selection tracking).
- [x] Verify round-trip: re-reads computed styles via `CSS.getComputedStyleForNode`, POSTs `VerifyRequest` to `/verify`, renders mismatches.
- [ ] **MISSING**: Elements-panel DOM edits are NOT captured — no `DOM.attributeModified` / `DOM.characterDataModified` / `DOM.childNodeRemoved` listeners. Editing an element's class attribute, text, or markup in Elements produces no CaptureChange. The contract has no ops for markup edits either (CSS ops only). Tailwind syncing works via Styles-panel edits to utility-class rules, not via class-attribute edits.

## Phase 3 — Instrumentation (Tier 3) ✅ DONE
- [x] `@dev-sync/babel-plugin-source-locator`: stamps JSX host elements with `data-source-file` / `data-source-line` / `data-source-component` (4 tests green).
- [x] `./vite` export: dev-serve-only Vite wrapper (`enforce: "pre"`, parse-only TS/JSX, composes with @vitejs/plugin-react).
- [x] Wired into the test app for real (integration pass replaced the dynamic-import placeholder in `apps/test-app/vite.config.ts` with a static import of `sourceLocator` from `@dev-sync/babel-plugin-source-locator/vite`, and added the workspace dep).

## Phase 4 — Apply (Tier 4) ✅ DONE (for CSS-shaped changes)
- [x] `@dev-sync/server`: Fastify on 127.0.0.1:7777 (`/healthz`, `/apply`, `/verify`), Zod-validated bodies, all writes realpath-jailed under `DEV_SYNC_WORKSPACE_ROOT` (15 workspace-jail tests).
- [x] Resolution chain: sourcemap (data-URI / file / sibling .map) → direct file match; routes to postcss / cssinjs / classlist appliers (13 apply tests).
- [x] Tiers: plain CSS (PostCSS AST edit), compiled+sourcemapped (Sass), css-in-js (babel-parsed `styled`/`css` template literals), Tailwind (declaration → utility mapping, recast className rewrite).
- [x] Placement engine for new rules: deterministic candidates (co-located stylesheet, owning-selector file, sheet's own file); LLM (Anthropic) used ONLY as multi-candidate tiebreak, gated on `APP_ENV !== production` && `ANTHROPIC_API_KEY`; unresolvable → `needsPlacement` in the response.
- [ ] **NOT COVERED**: no JSX writer for inline `style` props / attributes / text (see Tier 5 StaticBlock).

## Phase 5 — Verify + test app (Tier 5) ⚠️ PARTIAL (4 of 5 fixture tiers syncable; verify loop done)
- [x] `@dev-sync/test-app`: fixture app on :5199 with all five styling tiers (PlainCard/plain CSS, ScssPanel/Sass module, EmotionButton/css-in-js, TailwindHero/utilities, StaticBlock/static JSX) + source-locator instrumentation.
- [x] Verify loop end-to-end: panel Verify button → CDP computed styles → server `/verify` normalize-and-compare → mismatches surfaced in the panel.
- [ ] **MISSING**: StaticBlock (static JSX / inline-style / markup) tier is a fixture only — it cannot sync. Requires both the Phase 2 DOM-edit capture ops and a server-side JSX inline-style/attribute writer, neither of which exists. It still demonstrates Tier 3 instrumentation (data-source-* visible in the panel).

## Integration pass (2026-07-10)
- test-app now depends on `@dev-sync/babel-plugin-source-locator` + `@dev-sync/contract` (workspace:*); vite.config uses the real plugin statically.
- Fixed `apps/extension/background/service-worker.js`: two literal NUL bytes (used as map-key separators in template strings) made the file read as binary; replaced with `\u0000` escapes, `node --check` green on all extension JS.
- Root `typecheck` script builds `packages/*` first (test-app's vite.config resolves the plugin's dist types).
- `pnpm install` / `pnpm build` / `pnpm typecheck` / `pnpm test` all green (server 28 tests, plugin 4 tests).

---

## Pivot (2026-07-12) — bundler-plugin integration (replaces the static `dev-sync init` surgery)

User: *"can't you just have an index file import of library that does all that? start the http
server etc.?"* … *"webpack and vite should catch all then. add svelte vue qwik too."*

Ship a **bundler plugin** the user drops into their config once, instead of statically diffing +
mutating `vite.config` (`apps/server/src/init/*`, `transform.ts`). The plugin self-configures the
CSS sourcemap, boots the apply engine on the dev server's own origin, and stamps JSX. Covers every
Vite-based framework for free (all take `plugins: [devSync()]`) + a webpack path for Next.

### Decisions (locked)
1. Apply engine **embeds** on the dev-server middleware (Vite `configureServer` →
   `server.middlewares.use('/__dev-sync', h)`; webpack `setupMiddlewares`). Kills the separate
   :7777 port + CORS allowlist — extension POSTs the page origin it already inspects.
2. `apps/server` **stays the engine lib**: `applyPayload`/`describeTemplate`/`verifyChecks` are
   Fastify-decoupled (take a `Config`). New packages import them via a new `./engine` barrel; the
   standalone Fastify server stays as the non-Vite fallback. (`registerJournalRoutes` is
   Fastify-shaped — journal/undo mount is a later slice, not P1.)
3. Phasing: **P1** `@dev-sync/vite` (plain React) → **P2** Svelte/Vue/Qwik CSS-sync (same plugin,
   drop the framework-skip for Vite-based ones) → **P3** webpack (Next).
4. `init` survives, repurposed: insert one `devSync()` line into the existing `plugins` array /
   `nuxt.config` `vite.plugins` / next config. No more `css.devSourcemap` surgery.

### Honest caveats (don't paper over)
- Vite plugin only runs where Vite runs. **Next 15+ dev defaults to Turbopack** — a webpack plugin
  will NOT load under Turbopack. P3 covers `next.config` webpack; Turbopack needs `next dev
  --webpack` or its own path. Say so in onboarding.
- Deep JSX→source stamping is **React-only** (reuses `@dev-sync/babel-plugin-source-locator`).
  Svelte/Vue/Qwik get the CSS-sourcemap layer, not JSX host stamping.
- emotion/styled label babel plugins live in the framework's own `react()` babel block — our plugin
  can't retrofit them. Stays an install-hint.

### P1 slices — `@dev-sync/vite` (new `packages/vite`, default export `devSync(opts?)`)
Vite in this repo is `^6`. `devSync()` returns an array of plugins.
- **P1.1 (IN PROGRESS):** `config()` → `{ css: { devSourcemap: true } }`; compose the existing
  `sourceLocator()` (JSX stamping). No engine needed. TDD as pure hook objects.
- **P1.2:** add `./engine` barrel to `@dev-sync/server`; `createApplyMiddleware(cfg)` (thin connect
  handler over the engine fns); `configureServer` mounts it at `/__dev-sync/apply|describe|verify`.
- **P1.3:** extension POSTs page origin `/__dev-sync/*` instead of `:7777`.

### P2 / P3
- P2: drop the `framework` short-circuit in `init` for Vite-based frameworks (insert `devSync()` into
  their existing plugins array instead); revise `init-plan.test.ts` "meta-framework skip" +
  `init-cli.test.ts` "framework → no write".
- P3: `@dev-sync/webpack` — css-loader `sourceMap` + `devtool` + `setupMiddlewares` mount; Next via
  `next.config` webpack fn; flag the Turbopack gap.

### Status log
- 2026-07-12: plan written; grounded on server.ts/config.ts/apply.ts/init/*, existing
  `sourceLocator()` vite wrapper. Engine surface confirmed reusable. Starting P1.1.
