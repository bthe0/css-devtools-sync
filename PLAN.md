# PLAN — @dev-sync/webpack (Next.js support) + examples

Goal: dev-sync works on a Next.js app (App Router, webpack dev — NOT Turbopack),
consumed via explicit package.json deps. Plus a Vite+React example. User then
makes a few pages and tests each styling tier live.

## Blockers / unknowns (gate before building the package)
- **CSS dev sourcemaps on Next** (HIGH): the whole CSS→source path needs the served
  CSS to carry a usable sourceMappingURL. Next owns its css-loader; no `css.devSourcemap`
  equivalent. Phase 0 go/no-go.
- **JSX `__srcLoc` stamping** (MED): the babel source-locator plugin. A babel config
  disables Next SWC (slower dev, breaks next/font). Acceptable for a dev-only sync tool.
- **Turbopack** (KNOWN GAP): no stable plugin API → webpack dev only (`next dev`, no --turbopack).

## Phases
- [x] P0 SPIKE — examples/next-app scaffolded (Next 16.2.10, app router, TS, tailwind).
      Engine mount PROVEN headless: `next dev --webpack` boots, GET /__dev-sync/journal
      -> 200 {"entries":[]} through rewrite -> pages/api/__dev-sync/[...path] -> connect
      middleware. page -> 200. Stall warning fixed (handler awaits res close).
- [x] P1 packages/webpack — withDevSync(nextConfig) (rewrites in beforeFiles + webpack
      CSS-sourcemap loader patch), createDevSyncHandler (pages/api), devSyncBabelConfig.
      Build clean, 6/6 tests. Added `default` export condition to @dev-sync/server +
      @dev-sync/webpack (Next config loader resolves under non-import condition).
- [x] P2 examples/vite-react — devSync() wired (port 5299). Boot verified: page 200,
      engine /__dev-sync/journal 200. Plain-CSS + CSS-Module tiers demoed.
- [x] P3 both examples: demo pages exercising tiers (next-app: plain/module/tailwind;
      vite-react: plain/module). Both boot 200 with tiers in the HTML + engine 200.
- [x] P4 undo keybind — Cmd/Ctrl+Z in content-script POSTs same-origin /__dev-sync/undo,
      toasts reverted/skipped; ignored while typing in a field. +2 tests (67/67).

## BABEL-ESM BLOCKER RESOLVED (2026-07-12)
Dual ESM+CJS build for @dev-sync/babel-plugin-source-locator (tsconfig.cjs.json →
dist/cjs + {"type":"commonjs"} marker; exports `.` gains `require`+`default`).
.babelrc re-enabled; Next app router COMPILES under next/babel + the plugin
(page 200, no errors) → JSX __srcLoc stamping active. SWC-disable cost accepted (dev-only).

## STILL user-live-test only
- CSS-sourcemap-in-browser: unchanged — needs the live extension (Next injects CSS via
  JS, nothing to curl). Everything else is proven headless.
## Pre-existing (NOT introduced here)
- apps/test-app/vite.config.ts TS2769 overload error — latent in HEAD (git diff empty).

## OPEN / user-live-test items
- **CSS sourcemap in the browser (HIGH, unverified)**: headless can't see it — Next dev
  injects CSS via JS (next-style-loader), so the served HTML has no <style> to curl.
  Needs the extension live: edit a rule in DevTools, confirm it writes source. This is
  the real go/no-go the user runs.
- **JSX __srcLoc stamping BLOCKED (babel ESM)**: .babelrc disabled for now (renamed
  .babelrc.disabled) so Next boots on SWC. Blocker: @dev-sync/babel-plugin-source-locator
  dist is ESM (export default), and babel loads plugins via sync require() -> can't load
  an ESM plugin from a static .babelrc. Options: (a) ship a CJS build of the babel plugin,
  (b) babel.config.js async + dynamic import. Until fixed, CSS-file/module/scss/emotion
  tiers work (sourcemap-based); element/set-text/Tailwind tiers (need __srcLoc) do NOT.

## Decisions (ADR-lite)
- App Router (house rule Next 15-16 App Router; hardest SWC case — if it works, pages router trivial).
- examples/* added to pnpm workspace; examples depend on @dev-sync/* via workspace:*.
- Next dev pinned to webpack (Turbopack unsupported — no plugin API).

## Queued (mid-build request, 2026-07-12)
- [ ] P4 Undo keybind — Cmd+Z / Ctrl+Z in the extension reverts the last applied
      rule change via the existing engine `/undo` route (ROUTES already has it).
      Wire keydown in devtools.js (or HUD), POST /undo, toast the result. Separate
      subsystem from the Next work — do at the P1 checkpoint.

## P5 — Playwright E2E suite (DONE)
New `e2e/` workspace (@dev-sync/e2e, @playwright/test 1.61.1). Persistent-context
Chromium loads the real unpacked extension (MV3 → headed). Two projects (vite 5299,
next 4300), one worker, no parallelism (shared servers + global engine journal).
- extension-hud: #dev-sync-hud-host + shadow .hud injected on both examples.
- engine-mount: GET /__dev-sync/journal 200 {entries:[]} on both origins.
- undo-keybind A: Cmd/Ctrl+Z → real POST /__dev-sync/undo → toast (both).
- undo-keybind B (vite only): real /apply commit writes App.css → Cmd/Ctrl+Z reverts
  it on disk. Self-normalises the badge value so a crashed run can't poison it;
  finally-restores the source. Asserts disk (poll), NOT the undo response body — the
  write-back HMR reload discards the network resource.
Result: 7 passed, 1 skipped (B on next: seed targets vite's App.css). `pnpm test:e2e`.

### Real defects the E2E uncovered (the value)
1. next-app `dev` script had NO port → booted on 3000, not 4300. Pinned `-p 4300`.
   (Earlier "passing" Next runs reused a stale 4300 server from a prior session.)
2. next-app 500'd on EVERY route: `next/font` (Geist) in layout.tsx requires SWC,
   which the dev-sync `.babelrc` disables → babel-font-loader-conflict. Removed
   next/font, moved the font stack into globals.css.
3. next-app STILL 500'd: the source-locator stamp is a `ref`, illegal in a React
   Server Component (App Router default) — including <html>/<body> in the root
   layout. FIX (real feature): babel plugin gains `requireUseClientDirective`; when
   set it stamps only modules opening with "use client". webpack babel config +
   example .babelrc set it true; page.tsx opts in with "use client". Vite unaffected
   (default off; no directives there). +3 plugin tests. The Next integration never
   actually rendered before this — the E2E is what surfaced it.

## Boundary (any tool)
No automation API drives the Chrome DevTools Styles panel, so the literal
"edit a rule in DevTools" gesture is exercised by POSTing the exact CapturePayload
the extension emits. Everything below the panel is covered headless.

## P6 — Redo (Cmd/Ctrl+Shift+Z) + set-text demo tier (DONE)
Redo built on the append-only "revert newest write" journal. Undo already appended
a swapped before/after entry (so undo is undoable) — now those appends are TAGGED
`kind` ("apply"|"undo"|"redo", optional/back-compat). Model:
- undo: revert newest entry, append kind:"undo".
- redo: ONLY if newest entry.kind==="undo" (last action was an undo) → revert IT
  (re-applies the original), append kind:"redo". Else nothing to redo.
- A fresh sync-write after an undo naturally SHADOWS redo (newest is now an "apply",
  not "undo") — no explicit redo-stack truncation needed.
Wired: contract (kind field + RedoResultSchema {redone,skipped}), journal.ts
(redo() + extracted revertEntry() shared with undo, drift-guarded), both engine
mounts (middleware.ts ROUTES + branch; routes-journal.ts Fastify POST /redo),
content-script.js (Shift branch → /redo; verb/nothing text). Tests: journal +5,
middleware +2, hud +2 (redo + nothing-to-redo). Live-verified apply→undo→redo→
redo-noop→cleanup against the running vite engine. E2E +2 (redo-reaches both
projects; full undo→redo disk round trip on vite) → 9 passed / 1 skipped.

### Latent bug fixed (same code path)
content-script's undo toast read `Number(res.reverted)` but the engine returns an
ARRAY — Number([...]) is NaN → 0 → EVERY successful undo toasted "Nothing to undo".
The old hud.test mock encoded the bug (returned `reverted: 2` as a number). Fixed
to `list.length` + updated the mock to the real array shape. E2E hid it (matched
the empty-journal branch).

### Next example: set-text tier + {{ }} dynamic marker
Added a 4th tier to examples/next-app (static JSX text → set-text). Convention: text
from a JS expression (no source literal to edit) is wrapped in {{ }} via a <Dyn>
helper so it reads as non-editable. Documented in the example README.
