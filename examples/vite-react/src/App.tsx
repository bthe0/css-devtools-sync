import "./App.css";
import card from "./Card.module.css";

/**
 * dev-sync example (Vite + React). Two styling tiers on one page:
 *  - PlainCard  → plain CSS in App.css (postcss AST apply)
 *  - ModuleCard → CSS Modules in Card.module.css (hashed-selector demangle)
 *
 * Open DevTools, edit a rule in the Styles panel, and the matching source file
 * changes. Add more tiers/pages here to exercise the rest.
 */
function App() {
  return (
    <main className="page">
      <h1 className="page__title">dev-sync — Vite + React</h1>
      <p className="page__subtitle">
        Edit any rule below in DevTools; it writes back to source.
      </p>

      <section className="tier">
        <h2 className="tier__heading">Tier: plain CSS — App.css</h2>
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
    </main>
  );
}

export default App;
