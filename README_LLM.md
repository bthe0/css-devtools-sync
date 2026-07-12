# README_LLM — agent setup runbook for dev-sync

You are an AI coding agent setting up **dev-sync** for a user. Follow this in
order. It is written for you, not the human — do the mechanical steps yourself,
and STOP at the two decision points to ask the human before continuing.

Human-facing docs live in `README.md`. Architecture + invariants live in
`CLAUDE.md`. This file is only the setup procedure.

## 0. Preconditions (verify, don't assume)

```sh
node -v      # must be >= 20
corepack enable && pnpm -v   # expect pnpm 10.x (pinned via packageManager)
```

If Node < 20 or pnpm is missing, tell the human and stop — do not silently
install a different toolchain.

**No AI API key is required.** dev-sync's five apply tiers are fully
deterministic. `ANTHROPIC_API_KEY` is optional — it only lets Claude break ties
when a brand-new rule could land in several files, and it is disabled when
`APP_ENV=production`. Never tell the human they must set it to run the tool.

## 1. Install + build + verify (run all four; each must pass)

```sh
pnpm install
pnpm build       # topological: contract + babel + vite dists first
pnpm typecheck   # tsc --noEmit across every package
pnpm test        # vitest — expect the full suite green (0 failures)
```

If any step fails, paste the real error and stop. Do NOT start the servers on a
red build. "Vibecoded" is not a license to skip the gate.

## 2. DECISION POINT A — where does the apply engine write?

The engine is a **filesystem jail**: every CSS write is confined under
`DEV_SYNC_WORKSPACE_ROOT` (realpath-resolved; it refuses to start without it).
Nothing outside that directory can ever be written.

**Ask the human:**

> "Which project should dev-sync edit? Give me the absolute path to its repo
> root. I'll jail all writes under it. (For a quick demo, I can use the bundled
> `apps/test-app` instead.)"

- If they name their own project → that path becomes `DEV_SYNC_WORKSPACE_ROOT`.
  Their app must be a **Vite** project; add the plugin to its `vite.config`:
  ```ts
  import { devSync } from "@dev-sync/vite";
  export default defineConfig({ plugins: [react(), devSync()] });
  ```
  (Next.js / Nuxt / Astro / SvelteKit own their build — not supported yet. Say
  so and stop if that's their stack.)
- If they want the demo → use `$PWD/apps/test-app` and run the bundled fixture.

Never guess the path. Never pick a root that isn't the project they named.

## 3. Start the servers

Demo (bundled fixture — two processes):

```sh
# apply engine, jailed to the test app (port 7777)
DEV_SYNC_WORKSPACE_ROOT="$PWD/apps/test-app" pnpm --filter @dev-sync/server dev

# the fixture app (its own Vite dev server, port 5199)
pnpm --filter @dev-sync/test-app dev
```

Their own project: start their app's dev server with the `devSync()` plugin
added (step 2). The engine mounts on the app's own origin at `/__dev-sync/*` —
no separate port.

Confirm liveness before handing off (do not curl blindly — a shell hook may
redirect curl; use a tiny node http request if so):

- `GET  http://127.0.0.1:7777/healthz` → `{"ok":true}`
- `POST http://127.0.0.1:7777/apply` with `{}` → `400` + `invalid CapturePayload`
  (proves the route + Zod contract are wired; writes nothing)
- app origin returns `200`

## 4. DECISION POINT B — load the Chrome extension

The extension is MV3, loaded **unpacked**. It is NOT auto-installed.

**Ask the human — do not touch their browser without a yes:**

> "Want me to auto-load the dev-sync extension into your Chrome, or will you
> load it yourself? Auto-loading launches a Chrome instance pointed at the
> unpacked extension at `apps/extension/`. I will not modify your existing
> Chrome profile or install anything into it without your go-ahead."

- **They say load it yourself** (default, safest): give them the absolute path
  and steps — `chrome://extensions` → Developer mode ON → **Load unpacked** →
  select `<repo>/apps/extension/`.
- **They say auto-load**: launch a SEPARATE Chrome instance with an isolated
  profile so you never mutate their daily profile:
  ```sh
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --user-data-dir="$(mktemp -d)" \
    --load-extension="$PWD/apps/extension" \
    "http://localhost:5199/"
  ```
  Confirm the target app URL with them first. Never load an unpacked extension
  into their primary profile, and never disable Chrome security flags.

## 5. Hand off

Tell the human: open the app's DevTools → **Source Sync** panel → edit a rule in
the **Styles** panel → it writes back into the mapped source file under the
workspace root. Undo is journaled (append-only JSONL, outside the jail).

Report exactly what you ran, which ports are live, and the workspace root you
jailed writes to.
