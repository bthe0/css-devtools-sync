# css-devtools-sync — Product Roadmap

Prototype → product. `PLAN.md` is the historical build log for the five tiers (what
exists). This is the forward plan: what closes the gap between "works on my machine"
and "others trust it on their source."

Sequenced by dependency and leverage, not by ease. Each phase has a hard exit
criterion — don't advance until it's met.

---

## Phase 0 — Positioning (do first; it reframes everything below)

**Problem.** Chrome **Local Overrides + Workspaces** already maps DevTools edits → disk
for plain CSS/JS, natively, zero install. Pitching "sync plain CSS" competes with a
browser built-in and loses. The defensible wedge is the tiers Local Overrides *cannot*
touch: **css-in-js reverse-mapping, Sass-module class resolution, Tailwind classlist
edits.** Plain CSS stays supported but is table-stakes, never the headline.

**Tasks**
- Rewrite `README.md` lede around the three hard tiers; demote plain CSS to a "also
  handles" line. One GIF per hard tier (emotion edit → source diff; Tailwind utility →
  className rewrite; Sass module → source `.scss`).
- Add a one-line comparison vs Local Overrides ("Overrides can't reach compiled CSS,
  css-in-js templates, or utility classes — this does").
- ADR: `docs/adr/0001-positioning.md` — why we don't chase plain-CSS parity.

**Exit:** README leads with the wedge; a new reader understands in 10s why the browser
built-in isn't enough. No code.

**Effort:** S. **Blocks:** nothing. **Unblocks:** framing for Phases 4 & 5.

---

## Phase 1 — Trust core (the make-or-break)

A tool that writes source dies on one bad silent write. Everything here exists to make
mistakes **visible and reversible** so the heuristic targeting becomes acceptable.

### 1a. Preview-before-write (two-phase apply)
Every edit returns a diff; source only changes on explicit confirm.

- **Contract** (`packages/contract/src/index.ts`): add `mode: "preview" | "commit"` to
  the apply request (default `preview`); extend `ApplyOutcome` with
  `{ file, before, after, unifiedDiff }` for the changed region.
- **Server** (`apps/server/src/apply.ts`): thread `mode` through the pipeline. The
  writers already return full new source (`code`) — in `preview` mode run the whole
  chain, capture results, **skip the fsync**. `commit` re-runs (or replays a
  short-lived cached plan keyed by a change hash) and writes.
- **Extension** (`apps/extension` devtools panel): render the unified diff per file;
  Apply / Discard buttons. Queue edits; batch-confirm.
- Edge cases: preview then source changed on disk before commit → stale-plan detection
  (hash the target file at preview, re-check at commit; mismatch → re-preview, never
  blind-write).

### 1b. Undo / write journal
- **Server**: append-only JSONL journal in a state dir *outside* the workspace jail
  (`~/.dev-sync/journal/<workspace-hash>.jsonl`): `{id, ts, file, beforeSha, before,
  after}`. Cap entries + total bytes (rotate).
- New routes: `POST /undo` (last, or `{id}`), `GET /journal` (recent N).
- **Extension**: "Undo last sync" + a session history list.
- Guard: undo re-checks current file matches the recorded `after` before reverting
  (don't clobber a hand-edit made since); mismatch → refuse + surface.

### 1c. Confidence signal
Targeting is already tiered internally — surface it.

- `apps/server/src/cssinjs-target.ts` (`chooseTemplateLine`) and
  `apps/server/src/placement.ts` already distinguish single-match (deterministic) vs
  LLM-picked vs first-match fallback. Emit `confidence: "deterministic" | "assisted" |
  "fallback"` + a human `reason` on each `ApplyOutcome`.
- Also surface the **fail-closed skips** you already produce (SkipChangeError reason)
  as an explicit outcome — "skipped: couldn't locate target (ambiguous file)" — instead
  of a silent no-op.
- **Extension**: green = deterministic, amber = assisted/fallback (eyeball the diff),
  grey = skipped-with-reason.

**Exit:** no edit ever mutates source without a shown diff + confirm; every committed
write is in the journal and one-click reversible; every outcome carries a
confidence/skip reason. A deliberately-ambiguous edit shows "skipped: reason", never
nothing.

**Effort:** L (contract + server + panel). **Blocks:** Phase 2 (reuses confidence +
skip reasons). **Highest leverage in the doc — do this before anything cosmetic.**

---

## Phase 2 — Honesty surface (coverage matrix badge)

Reuses Phase 1c's classification. Before an edit, tell the user whether a rule is
editable and why not.

- **Server**: `POST /classify` — given a sheet/rule/element context, run the resolver +
  writer *dry* (no plan, no write) and return `{ editable, tier, reason }`.
- **Extension**: per-rule badge in the Styles panel mirror ("editable · css-in-js" /
  "not editable · compiled CSS with no sourcemap"). Kills silent failure — the #1 trust
  killer after bad writes.

**Exit:** every rule the panel shows carries an editable/not-editable badge with a
reason. **Effort:** M. **Depends:** 1c.

---

## Phase 3 — Zero-config DX (kill the separate daemon)

A hand-started server on :7777 is adoption friction.

- New package `@dev-sync/vite-plugin`: boots the Fastify app as Vite dev-server
  middleware (in-process, dev-only), auto-sets `DEV_SYNC_WORKSPACE_ROOT` to the Vite
  root, tears down on exit. No extra terminal, no port to remember.
- Next.js: a plugin/`instrumentation` hook that does the same under `next dev`.
- Keep the standalone server for non-Vite setups (webpack, Astro) — the plugin is the
  happy path, not the only path.
- Hard rule (matches existing posture): dev-only. The embedded server must refuse to
  start when `NODE_ENV=production`.

**Exit:** `pnpm dev` in a Vite app starts the sync server with zero extra steps; removing
the plugin removes the server cleanly. **Effort:** M. **Depends:** stable apply API
(Phase 1 contract).

---

## Phase 4 — Framework proof (the compatibility table is the marketing)

You test emotion/styled-components. Users run Next App Router, CSS Modules + Tailwind
together, Panda, etc. Prove coverage publicly.

- Matrix of fixture apps (or fixture routes in `apps/test-app`): Next App Router,
  CRA/Vite + CSS Modules, Tailwind + CSS Modules combo, styled-components v6 object +
  template, emotion object + template.
- CI job runs each fixture's sync round-trip; generates `COMPATIBILITY.md` (tested /
  known-broken / unsupported-by-design) from the results — so the table can't lie.
- Link `COMPATIBILITY.md` from the README (Phase 0).

**Exit:** a CI-generated compat table covers the top 5 real-world stacks; README links
it. **Effort:** L. **Depends:** Phase 0 framing, Phase 1 (round-trip must be trustworthy
to benchmark).

---

## Phase 5 — Distribution

- **Chrome Web Store**: MV3 manifest audit, permissions minimization + justification,
  listing assets (the Phase 0 GIFs), privacy note (localhost-only, no data leaves the
  machine — a genuine selling point).
- **Firefox**: MV3 build; `webextension-polyfill` for the `chrome.*` surface; a second
  listing.
- **`create-dev-sync`**: scaffolder that installs the framework plugin (Phase 3) + prints
  the extension install link. The npm package + plugin is the real install story; the
  extension is just the UI.

**Exit:** installable by a stranger in two steps (add extension, add plugin) with no
README archaeology. **Effort:** L. **Depends:** Phases 1–4.

---

## Explicitly NOT building
- **vanilla-extract / JSS / Fela writers** — they compile to static CSS at build; there's
  no runtime→source path to reverse-map, so a writer is dead code. Correctly scoped out;
  keep it that way. (`.zero-runtime` libs → classify as "not editable · compiled at
  build" in Phase 2, which is the honest answer.)
- **Auth / multi-user / cloud / accounts** — it's a localhost dev tool; its whole value is
  touching *your local files*. No backend. Resist SaaS-ifying it.

---

## One-line sequencing
Phase 0 (frame) → **Phase 1 (trust — do this or nothing else matters)** → Phase 2
(honesty) → Phase 3 (DX) → Phase 4 (proof) → Phase 5 (ship).
