# PLAN — framework examples + vanilla-extract tier

Branch: `feat/framework-examples` (checkpoint commit per phase; not `main`).
Goal: add Vue + Svelte example apps, a vanilla-extract mapping tier, E2E per framework.
Grounded by the arch map (2026-07-13). One tier touches: `apps/extension/devtools.js`
(mappable gate/marker) → `packages/contract` (schema, only if new fields) → `apps/server`
(resolver + apply module + `applyOne` routing) → new `examples/*` app → `e2e` (project + spec).
**Rebuild the edited package (`pnpm --filter <pkg> build`) before an example/e2e picks it up**
(examples consume `dist`, not `src`).

## Ports
vite-react 5299 · next 4300 · test-app 5199 · **vue 5399 · svelte 5499 · vanilla-extract 5599**

## Phase 1 — Vue example  ✅ DONE (commit 4fdf1e8)
- [x] 1a scaffold `examples/vue-app`: Vite 8 + `@vitejs/plugin-vue` + `devSync()`, port 5399.
- [x] 1b probe: `.vue` sourcemap source is classified neither-css-nor-js → dropped. Needed a tier.
- [x] 1c NEW `kind:"sfc"` tier (resolve.ts + apply-sfc.ts + apply.ts). Scoped `.card` applies to
      ScopedCard.vue byte-identical outside the block; `<style module>` skips-with-reason.
      Fail-loud on ambiguous selector across >1 `<style>` block. 444 tests + reviewer (0🔴).
- [x] 1d checkpoint commit 4fdf1e8.

## Phase 2 — Svelte example  ✅ DONE
- [x] 2a scaffold `examples/svelte-app`: svelte@5.56 + @sveltejs/vite-plugin-svelte@7.2
      (peer `^8.0.0` — Vite-8 OK) + `devSync()`, port 5499. Card.svelte default-scoped `<style>`.
- [x] 2b probe: served selector `.card.svelte-<hash>` strips clean, BUT vite-plugin-svelte emits
      `"sources":["Card.svelte"]` (bare, no dir) → sourcemap sfc pass misses → hits resolve.ts's
      `if (compiled)` sourceURL fallback, which lacked the isSfcLike check → `.svelte` mis-typed
      `kind:"css"` → PostCSS choked on `<script>`.
- [x] 2c FIX: resolve.ts compiled-fallback now `isSfcLike(compiled) ? "sfc" : …`. Rejected the
      broad fuzzy-basename-match option (ambiguity risk; deterministic sourceURL already resolves).
      Re-probe PASS: `applied:[{file:"src/lib/Card.svelte", mode:"postcss", deterministic}]`,
      diff = only `.card` padding, no disk write. 445 tests.
- [x] 2d checkpoint commit.

## Phase 3 — vanilla-extract tier  (SPIKE — brittle; may hit a product fork)
Confirmed NOT on the existing sourcemap path. VE compiles `.css.ts` `style({...})` objects to
CSS with debug class names `File_export__hash`; no line correspondence.
- [ ] 3a force default mode (per-file virtual `X.css.ts.vanilla.css` id; NOT `inlineCssInDev`).
- [ ] 3b `devtools.js` mappable gate: recognise the `.vanilla.css` `data-vite-dev-id`.
- [ ] 3c `contract`: new marker field only if needed.
- [ ] 3d `apps/server`: resolver strips `.vanilla.css` → `.css.ts`; new `apply-vanilla-extract.ts`
      editing the `style({...})` object property (NOT a template literal); class `File_export__hash`
      → exported `style` const. `applyOne` routing.
- [ ] 3e `examples/ve-app`.
- [ ] **FORK to surface if blocked:** mapping ONE DevTools property edit into the correct object
      property/selector inside `style({...})` (pseudo/media nesting) may not resolve cleanly →
      stop and get a product call rather than ship a guesser.
- [ ] 3f checkpoint commit.

## Phase 4 — E2E per framework
- [ ] playwright `projects[]` + `webServer[]` entries for vue/svelte/ve; specs seeded with a
      hand-built CapturePayload matching what each framework actually serves; assert disk write.
- [ ] checkpoint commit.

## Phase 5 — docs + "more frameworks"
- [ ] README table of supported frameworks. Propose (do NOT build unprompted) candidates:
      Astro, SolidStart, Qwik, Lit, Nuxt (Vue/Vite), SvelteKit. Get a pick before grinding more.

## Open decisions (defaulted; flip if user weighs in)
1. WIP on `feat/framework-examples`, not `main` (checkpoint discipline). Merge when done.
2. vanilla-extract forced to default (per-file) mode, not `inlineCssInDev` (needs source attribution).
3. "more frameworks" scoped to Vue+Svelte+VE for now; rest is a Phase 5 proposal.
