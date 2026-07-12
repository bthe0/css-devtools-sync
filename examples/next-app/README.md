# dev-sync example — Next.js (App Router)

Runnable demo of [`@dev-sync/webpack`](../../packages/webpack) on the Next.js **webpack** dev server.

```sh
pnpm install          # from the repo root (workspace-links @dev-sync/*)
pnpm --filter next-app dev
```

Opens `http://localhost:4300`. Wiring:

- `next.config.ts` — `withDevSync()` (rewrites `/__dev-sync/*` → the engine, forces CSS dev sourcemaps)
- `pages/api/__dev-sync/[...path].ts` — `createDevSyncHandler()` mounts the apply engine on this origin
- `.babelrc` — stamps JSX host elements with `__srcLoc` (enables the element / Tailwind tiers; switches Next to Babel in dev). Uses `requireUseClientDirective: true`.

Four tiers on the page: plain CSS (`globals.css`), CSS Modules (`Card.module.css`), Tailwind utilities, and **static text** (set-text — edit the text of a JSX element in DevTools and it rewrites the literal in `page.tsx`).

> **Static vs dynamic text:** set-text can only write back a **static** JSX text literal. Text derived from a JS expression (a variable, prop, `.map()`) has no literal to edit, so the page marks it with `{{ }}` (e.g. `{{eu-west-1}}`) — braced text is *not* editable via set-text.

> **RSC note:** the stamp is a `ref`, illegal in a Server Component — so `app/page.tsx` opens with `"use client"` (that's what enables its Tailwind/element tier). The CSS-file and CSS-Module tiers need no `"use client"`. The root `app/layout.tsx` stays a Server Component and is left unstamped. `next/font` was removed (it requires SWC, which the Babel config disables).

> Requires `next dev --webpack` (the `dev` script, pinned to port 4300). Turbopack is unsupported — no stable plugin API.

**Undo:** Cmd/Ctrl+Z on the page reverts the last applied change (focus the page first).

Load the extension (**Load unpacked** `apps/extension/`), open DevTools, edit a rule → the matching source changes.
