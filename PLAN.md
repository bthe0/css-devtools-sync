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

## Phase 1 — Vue example  (LOW risk if it rides the existing path)
- [ ] 1a scaffold `examples/vue-app`: Vite 8 + `@vitejs/plugin-vue` + `devSync()`, port 5399,
      strictPort. Tiers to cover: plain global CSS, a `<style scoped>` SFC block, a CSS module.
- [ ] 1b **EMPIRICAL probe (decides the rest):** boot it, inspect the served style — does the
      DOM `<style>` / served CSS carry `data-vite-dev-id` AND a sourcemap that maps back into the
      `.vue` file (vs. a virtual `Foo.vue?vue&type=style` id with no useful mapping)?
- [ ] 1c IF rides existing `css`/sourcemap tier → example only, done. ELSE add resolver handling
      for the virtual `?vue&type=style` id → SFC + an SFC-`<style>`-region-aware apply in server.
- [ ] 1d checkpoint commit.

## Phase 2 — Svelte example  (same shape as Phase 1)
- [ ] 2a scaffold `examples/svelte-app`: `@sveltejs/vite-plugin-svelte` + svelte 5 + `devSync()`,
      port 5499. Svelte scopes CSS via a generated `.svelte-<hash>` class → verify the served
      `<style>` maps back to the `.svelte` file.
- [ ] 2b probe (as 1b). 2c resolver/apply work if the virtual `?svelte&type=style` id needs it.
- [ ] 2d checkpoint commit.

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
