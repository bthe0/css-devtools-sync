# @dev-sync/test-app

Fixture app for end-to-end testing of every css-devtools-sync tier. Each
component uses a different styling mechanism so the DevTools → source
round-trip can be exercised per tier in isolation.

## Run

```sh
pnpm --filter @dev-sync/test-app dev
# → http://localhost:5199  (fixed port, strictPort)
```

Prereqs for a full round-trip: the extension (`apps/extension`) loaded in
Chrome and the sync server (`@dev-sync/server`) running on :7777. The app
itself runs standalone without either.

## Component → tier → source file

| Component     | Tier (server ApplyMode)                        | File that should change                | Markup sync (`data-source-*`)                                          |
| ------------- | ------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| PlainCard     | plain CSS → `postcss`                            | `src/components/PlainCard.css`           | —                                                                            |
| ModuleCard    | CSS Modules (plain) → hashed-selector demangle    | `src/components/ModuleCard.module.css`   | —                                                                            |
| ScssPanel     | Sass module → `sourcemap`                        | `src/components/ScssPanel.module.scss`   | —                                                                            |
| EmotionButton | CSS-in-JS (Emotion) → `cssinjs`                  | `src/components/EmotionButton.tsx`       | —                                                                            |
| StyledBadge   | CSS-in-JS (styled-components) → `cssinjs`        | `src/components/StyledBadge.tsx`         | —                                                                            |
| TailwindHero  | class list → `classlist`                         | `src/components/TailwindHero.tsx`        | —                                                                            |
| StaticBlock   | DOM/HTML template → `style` / `set-text` / `set-attr` | `src/components/StaticBlock.tsx`   | Edit heading text, `aria-label`, or `title` in Elements → Sync → `StaticBlock.tsx` |

## Per-tier test recipes

All recipes start the same way: `pnpm --filter @dev-sync/test-app dev`, open
http://localhost:5199, open DevTools, make the edit, then click **Sync** in the
extension panel and check the named file.

### 1. Plain CSS — PlainCard (postcss tier)

1. Inspect the "Deploy pipeline" card (`.plain-card`).
2. **Modify:** in Styles, change `background-color: #1a1d2a` to `#223`.
   Sync → `PlainCard.css` line for `.plain-card { background-color: … }` updates.
3. **Add declaration:** add `outline: 2px solid red;` to the `.plain-card` rule.
   Sync → new declaration appended inside the existing `.plain-card` block.
4. **Modify inside existing @media:** narrow the viewport below 600px (or use
   device toolbar), then edit `padding: 16px` in the `@media (max-width: 600px)`
   `.plain-card` rule. Sync → the declaration INSIDE the `@media` block changes,
   not the top-level rule.
5. **Add a new @media:** in Styles, create a new rule under a fresh media query,
   e.g. `@media (max-width: 400px) { .plain-card__badge { display: none; } }`.
   Sync → a brand-new `@media` block is appended to `PlainCard.css` (this is an
   `add-rule` capture; may route through `needsPlacement`).

### 2. CSS Modules (plain) — ModuleCard (hashed-selector demangle)

1. Inspect the "Rollout status" card. Class names are hashed the same way as
   ScssPanel's (`_card_xxxxx`), but there is no Sass compiler in between —
   this exercises resolving a hashed CSS Modules class straight back to a
   plain `.module.css` file (no sourcemap involved, unlike ScssPanel).
2. In Styles, change `background-color: #7c5cf0` on `.action` to `#22c55e`.
3. Sync → `ModuleCard.module.css` updates the `.action` rule's
   `background-color` declaration directly (literal replacement — there are
   no variables/nesting to expand, unlike the Sass tier).

### 3. Sass module — ScssPanel (sourcemap tier)

1. Inspect the "Edge metrics" panel. Class names are hashed
   (`_panel_xxxxx`), so the only path back to source is the sourcemap
   (`css.devSourcemap: true` in vite.config.ts).
2. In Styles, change `border-bottom: 2px solid #f59e0b` on the header to
   `4px solid #22d3ee`.
3. Sync → `ScssPanel.module.scss` updates. Note the source uses `$accent`; the
   server edits the declaration at the sourcemap-resolved line (variable
   inlining vs. literal replacement is a server-side policy decision — the
   FILE that changes must be the `.module.scss`, never a compiled artifact).

### 4. Emotion — EmotionButton (cssinjs tier)

1. Inspect "Trigger deploy". Thanks to `@emotion/babel-plugin`
   (`autoLabel: always`, `sourceMap: true`) the class looks like
   `css-xxxx--StyledButton` and the injected `<style>` has a sourcemap
   pointing into `EmotionButton.tsx`.
2. Change `border-radius: 8px` to `999px` in the matched `css-…` rule.
3. Sync → the template literal inside `EmotionButton.tsx` (`StyledButton`)
   updates.

### 5. styled-components — StyledBadge (cssinjs tier)

1. Inspect the pill in the "Tier: CSS-in-JS (styled-components)" section.
   Thanks to `babel-plugin-styled-components` (`displayName: true`,
   `fileName: true`, `sourceMap: true`) the class looks like
   `StyledBadge__Pill-sc-xxxxx` and the injected `<style>` has a sourcemap
   pointing into `StyledBadge.tsx` — a distinct CSS-in-JS library from
   EmotionButton's, exercising the same `cssinjs` tier against a different
   runtime/babel toolchain.
2. Change `border-radius: 999px` to `4px` in the matched
   `StyledBadge__Pill-…` rule.
3. Sync → the template literal inside `StyledBadge.tsx` (`Pill`) updates.

### 6. Tailwind — TailwindHero (class-list tier)

1. Inspect the hero. There is no component stylesheet — every style is a
   utility class.
2. Two capture shapes to test:
   - **Class-list edit:** in Elements, double-click the root `div`'s `class`
     attribute and change `p-8` → `p-12` (or add `ring-2 ring-white`).
   - **Styles-panel edit:** override `background-image` on the gradient; the
     server should translate it to the nearest utility (or report
     `needsPlacement` if untranslatable).
3. Sync → the `className` string in `TailwindHero.tsx` changes. No CSS file
   should be touched.

### 7. Static markup — StaticBlock (DOM/HTML → template tier)

1. Inspect the footer. Styles are inline `style` props; structure is static
   JSX. With the source-locator plugin active, every host element (the
   `<footer>`, its `<div>`, `<strong>`, `<p>`, the `<nav>`, and each `<a>`)
   carries `data-source-file` / `data-source-line` / `data-source-component`
   — that's the only way DOM edits map back onto this tier, since there is no
   stylesheet or CSS-in-JS template to resolve through.
2. Edits to test:
   - **element.style:** change `border-radius: 10px` → `0` in the
     `element.style` section.
   - **Text (set-text):** double-click "css-devtools-sync" (the `<strong>`
     heading) or "v0.0.1 — local fixture build" and edit the text — both are
     literal JSX text children, not expressions, so the edit maps 1:1 back to
     source.
   - **Attribute (set-attr):** in the Elements panel, edit the `<nav>`'s
     `aria-label="Footer navigation"` attribute, or the first `<a>`'s
     `title="Jump to the plain CSS tier"` attribute — both are literal string
     attributes on host elements, resolvable via the same `data-source-*`
     stamps.
3. Sync → the `style` object, the text literal, or the attribute value inside
   `StaticBlock.tsx` updates, located via the `data-source-*` attributes (no
   stylesheet involved).

## Notes

- Dev server port is fixed at **5199** (`strictPort: true`) so the extension
  and server can hardcode the origin.
- `@dev-sync/babel-plugin-source-locator` stamps `data-source-file` /
  `data-source-line` / `data-source-component` onto every host JSX element in
  dev (dev-only — it's a no-op when `NODE_ENV=production`, so a production
  `vite build` will not have these attributes). `src/instrumentation.test.tsx`
  and `src/components/StaticBlock.test.tsx` render each tier's component
  through the same Vite/babel pipeline and assert the attributes land — run
  `pnpm --filter @dev-sync/test-app test`. Note EmotionButton's JSX only uses
  capitalized `@emotion/styled` component tags (`<Wrap>`, `<StyledButton>`,
  `<ClickCount>`), so the plugin — which only instruments lowercase host tags
  in the *source* — has nothing to stamp there; that tier resolves through
  Emotion's own sourcemap instead, by design. StyledBadge is the same story
  with `styled-components` tags (`<Pill>`, `<Dot>`) — it resolves through
  `babel-plugin-styled-components`' own sourcemap instead.
- `babel-plugin-styled-components` is enabled in both `vite.config.ts` (dev
  serve) and `vitest.config.ts` (tests) with `displayName: true`,
  `fileName: true`, and `sourceMap: true`, mirroring how `@emotion/babel-
  plugin` is wired for EmotionButton — so the sync server can locate
  StyledBadge's tagged template literal the same way it locates Emotion's.
- Tailwind is v3 (`tailwind.config.js` + `@tailwind` directives in
  `src/index.css`) with PostCSS + autoprefixer.
