import { useState } from "react";
import "./PlainCard.css";

/**
 * Tier: plain CSS (postcss AST match).
 * Styles live in PlainCard.css — edits in DevTools should sync there.
 */
export function PlainCard() {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <article className="plain-card">
      <h3 className="plain-card__title">Pipeline #128</h3>
      <p className="plain-card__body">All checks green on main</p>
      <span className="plain-card__badge">passing</span>
      <button
        type="button"
        className="plain-card__toggle"
        onClick={() => setShowDetails((v) => !v)}
      >
        {showDetails ? "Hide details" : "Show details"}
      </button>
      {showDetails && (
        <div className="plain-card__details">
          build 2m 01s → test 1m 12s → package 18s → deploy 11s
        </div>
      )}
    </article>
  );
}
