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

## Phase 3 — vanilla-extract tier  (SPIKE — PROBE DONE, fork RESOLVED: buildable)
Probe verdict: deterministic, NOT a guesser. Served class `<fileBasename>_<export>__<hash>`
(single `_` before export, `__` before hash; disambiguate `_`-in-identifier by matching the
file's real export list). Served CSS = virtual module `<basename>.css.ts.vanilla.css`
(imported → CSSStyleSheet.href carries it → already mappable, NO devtools.js change). Self-
referential no-op sourcemap (no line path). Flat props: camelCase↔kebab 1:1. Nested is LITERAL:
`.<cls>:hover` → `selectors["&:hover"]`; `@media <q>` → `"@media"["<q>"]` — string match, not fuzzy.
- [x] 3a probe: force DEFAULT mode (per-file virtual id), NOT `inlineCssInDev`. Confirmed.
- [x] 3b devtools.js gate: NO change — served CSS mappable via `sheet.href` (vanilla.css URL).
- [x] 3c contract: NO change — `mediaText` already on ModifyChange (index.ts:107); pseudo from
      the served selector; class carries file+export.
- [x] 3d BUILT (TDD): resolve.ts `.vanilla.css`→`.css.ts` strip + `kind:"vanilla-extract"`;
      apply-vanilla-extract.ts (parseVeClass + resolveVeTargetObject + applyVanillaExtractChange);
      apply.ts branch; contract ApplyModeSchema += "vanilla-extract". Self-contained, no
      STYLE_TAG_ROOTS change. Reviewer found + I FIXED a 🔴 RCE: add-decl emitted `change.property`
      as an object key with no validation → crafted property could splice arbitrary JS into the
      `.css.ts` (VE plugin EVALUATES it → dev-machine RCE). Fix: CSS_PROPERTY_RE guard at the trust
      boundary + structural-count defense-in-depth + custom-prop verbatim-quoted key. 479 tests.
- [x] 3e `examples/ve-app` scaffolded (card flat + fancy :hover/@media); 3 preview-probes PASS.
- [x] v1 SCOPE-OUT enforced (skip-with-reason, tested): styleVariants/recipe/style([array])/
      style(base,{...}) composition, computed keys, dynamic values, missing @media/selectors path.
- [ ] 3f checkpoint commit.

## Phase 4 — E2E per framework  ✅ DONE
- [x] playwright `projects[]` + `webServer[]` for vue(5399)/svelte(5499)/ve(5599) (config +30 -0,
      shared settings + vite/next untouched). Specs discover the content-derived hash at RUNTIME
      (fetch served CSS/module, regex it) — never hardcoded — then POST a `commit`-mode
      CapturePayload and assert the DISK write + template/script byte-identical; restore in finally.
      vue asserts mode:"sourcemap" (full-path sources loop), svelte mode:"postcss" (bare-sources
      → compiled fallback), ve mode:"vanilla-extract". 15/15 green for the 3 projects, examples
      clean after (restores verified).
- [x] checkpoint commit.
- ⚠️ PRE-EXISTING (NOT this program): `undo-keybind.spec.ts:57 [vite]` (React App.css disk-revert
      via Cmd/Ctrl+Z→redo keypress) fails consistently — extension redo-keybind UI, zero overlap
      with the server routing changes here. Same area as this session's earlier C-flight/redo work.
      Flag for separate investigation; do not block the framework program on it.

## Phase 5 — docs + "more frameworks"
- [ ] README table of supported frameworks. Propose (do NOT build unprompted) candidates:
      Astro, SolidStart, Qwik, Lit, Nuxt (Vue/Vite), SvelteKit. Get a pick before grinding more.

## Open decisions (defaulted; flip if user weighs in)
1. WIP on `feat/framework-examples`, not `main` (checkpoint discipline). Merge when done.
2. vanilla-extract forced to default (per-file) mode, not `inlineCssInDev` (needs source attribution).
3. "more frameworks" scoped to Vue+Svelte+VE for now; rest is a Phase 5 proposal.
