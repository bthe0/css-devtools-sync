// "use client" is required for the source-locator to stamp this tree: the stamp
// attaches a `ref`, which is illegal in a Server Component. The CSS-file and
// CSS-Module tiers below resolve via sourcemaps and work without stamping — but
// the Tailwind (element) tier needs __srcLoc, so this page opts into client.
"use client";

import type { ReactNode } from "react";
import card from "./Card.module.css";

/**
 * dev-sync example (Next.js App Router, webpack dev). Four tiers:
 *  - PlainCard   → plain CSS in globals.css (postcss AST apply)
 *  - ModuleCard  → CSS Modules in Card.module.css (hashed-selector demangle)
 *  - TailwindCard→ Tailwind utilities in className (classlist apply; needs __srcLoc)
 *  - Set-text    → editable STATIC JSX text; dynamic text is marked with {{ }}
 *
 * Open DevTools, edit a rule in the Styles panel, and the matching source
 * changes. Requires `next dev --webpack` (Turbopack is unsupported).
 */

// Marks DYNAMIC text — anything derived from a JS expression (a variable, prop,
// or .map()) — by wrapping it in {{ }}. dev-sync's set-text tier only writes back
// STATIC JSX text literals; there's no source string for an expression to edit,
// so the braces are the tell: plain text is editable, {{braced}} text is not.
function Dyn({ children }: { children: ReactNode }) {
  return <span className="dyn">{`{{`}{children}{`}}`}</span>;
}

export default function Home() {
  // "dynamic" values — no literal exists in the JSX for these, so set-text can't
  // sync edits to them. Rendered inside <Dyn> so the page shows that visually.
  const region = "eu-west-1";
  const replicas = 3;

  return (
    <main className="page">
      <h1 className="page__title">EEEE</h1>
      <p className="page__subtitle">CUCU</p>
      <section className="tier">
        <h2 className="tier__heading">Tier: plain CSS — globals.css</h2>
        <article className="plain-card">
          <h3 className="plain-card__title">Pipeline #128</h3>
          <p className="plain-card__body">All checks green on main</p>
          <span className="plain-card__badge">passing</span>
        </article>
      </section>
      <section className="tier">
        <h2 className="tier__heading">Tier: CSS Modules — Card.module.css</h2>
        <article className={card.card}>
          <h3 className={card.title}>Rollout status</h3>
          <p className={card.body}>3 of 4 regions synced</p>
        </article>
      </section>
      <section className="tier">
        <h2 className="tier__heading">Tier: Tailwind utilities — page.tsx className</h2>
        <article className="max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5">
          <h3 className="mb-1 text-lg font-semibold text-zinc-100">Edge metrics</h3>
          <p className="text-zinc-400">4 series streaming</p>
        </article>
      </section>
      <section className="tier">
        <h2 className="tier__heading">Tier: static text — page.tsx (set-text)</h2>
        <article className="plain-card">
          {/* STATIC literal → editable in DevTools, writes back to this line. */}
          <h3 className="plain-card__title">Deploy logs</h3>
          <p className="plain-card__body">Deployment finished successfully</p>
          {/* DYNAMIC → no source literal; marked with {{ }}, set-text can't sync it. */}
          <p className="plain-card__body">
            Region <Dyn>{region}</Dyn> · <Dyn>{replicas} replicas</Dyn> online
          </p>
        </article>
      </section>
    </main>
  );
}
