# dev-sync example — Vite + React

Runnable demo of [`@dev-sync/vite`](../../packages/vite).

```sh
pnpm install          # from the repo root (workspace-links @dev-sync/*)
pnpm --filter vite-react dev
```

Opens `http://localhost:5299`. Wiring is one line in `vite.config.ts`:

```ts
plugins: [react(), devSync()]
```

`devSync()` turns on the CSS dev sourcemap, mounts the apply engine on this server's own origin (`/__dev-sync/*`), and stamps JSX with source locations. Two tiers on the page: plain CSS (`App.css`) and CSS Modules (`Card.module.css`).

**Undo:** Cmd/Ctrl+Z on the page reverts the last applied change (focus the page first).

Load the extension (**Load unpacked** `apps/extension/`), open DevTools, edit a rule → the matching source changes.
