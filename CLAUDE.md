# dev-sync — agent guide

DevTools → source CSS sync. Edit a rule in the Chrome DevTools **Styles** panel;
the apply engine resolves which source construct produced it (plain CSS, CSS
Module, Sass sourcemap, Emotion css-in-js, Tailwind class list, static JSX) and
writes the edit **back into that source**. Vite HMR reloads it as real code.

## Stack

- **pnpm@10.12.1** workspace monorepo, **Node ≥20**, ESM everywhere, **TypeScript strict**.
- **Vitest** tests, **Zod v4** contracts, **Fastify** standalone server, **Vite 6** plugin.

## Layout

```
packages/
  contract/                      @dev-sync/contract — wire protocol, Zod v4 schemas + TS types
  babel-plugin-source-locator/   @dev-sync/babel-plugin-source-locator — stamps JSX host elements
  vite/                          @dev-sync/vite — drop-in devSync() plugin (sourcemap + engine + locator)
apps/
  server/                        @dev-sync/server — apply engine + `dev-sync init` CLI (Fastify)
  test-app/                      @dev-sync/test-app — fixture exercising every styling tier
  extension/                     Chrome MV3 DevTools extension (plain JS, loaded unpacked)
```

## Commands

```sh
pnpm install
pnpm build       # topological: contract + babel + vite dists build first
pnpm typecheck   # builds packages, then tsc --noEmit everywhere
pnpm test        # vitest across every workspace
pnpm dev         # runs @dev-sync/server (needs DEV_SYNC_WORKSPACE_ROOT set)
```

Run the fixture + engine against the test app:

```sh
DEV_SYNC_WORKSPACE_ROOT="$PWD/apps/test-app" pnpm --filter @dev-sync/server dev
pnpm --filter @dev-sync/test-app dev
```

## Hard invariants — do not break

- **Filesystem jail.** Every write goes through `jailResolve()` / `writeWorkspaceFile`
  in `apps/server/src/workspace.ts`; nothing escapes `DEV_SYNC_WORKSPACE_ROOT`
  (realpath-resolved, symlink-escape rejected). Never add a raw `fs.write*` in a
  handler — route it through the jail.
- **Fail-closed prod env.** `apps/server/src/config.ts` parses `process.env` at
  startup and throws on any invalid value. When `APP_ENV=production`, `SYNC_TOKEN`
  **and** `EXTENSION_ID` are required (unset `SYNC_TOKEN` would leave writer routes
  ungated = remote file write). See `.env.example` for the full var set.
- **`@dev-sync/contract` is the single source of truth** for the extension ⇄ server
  protocol. Change the wire shape there (Zod v4), never hand-edit a shape on one end.
- **`__srcLoc` is an off-DOM, non-enumerable JS property** on JSX host elements
  (read via `$0.__srcLoc` over CDP) — **not** a `data-source-*` DOM attribute
  (those would pollute the Elements panel). Dev-only; stripped in production.
- **Mount prefix is `/__dev-sync`** (`MOUNT_PREFIX` in `packages/vite/src/index.ts`).
  The engine rides the dev server's own origin — no separate port in plugin mode.
- **Token compare is constant-time** (`timingSafeEqualString`); the server error
  handler sanitizes — never leak internal errors/paths to the client.

## Working here

- Match surrounding style; edit existing files over adding new ones.
- Tests are the contract — add a failing test before fixing a bug, keep the suite green.
- Before a new lib: check it's already a workspace dep and pinned; ESM only.
- `PLAN.md` tracks honest per-tier status + remaining work (Next.js/Turbopack gap is P3).
