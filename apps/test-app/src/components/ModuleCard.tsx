import { useState } from "react";
import styles from "./ModuleCard.module.css";

/**
 * Tier: CSS Modules (plain .module.css, NOT Sass).
 * Styles live in ModuleCard.module.css — class names are hashed at runtime
 * (e.g. `_card_1a2b3c`) the same way ScssPanel's are, but with no
 * intermediate compiler (no Sass variables/nesting to expand), so this tier
 * exercises the plain-CSS-module hashed-selector -> source demangle path
 * distinct from ScssPanel's sourcemap-driven one.
 */
export function ModuleCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.card}>
      <h3 className={styles.title}>Rollout status</h3>
      <p className={styles.body}>
        3 of 4 regions synced. Class names below are hashed CSS Modules
        identifiers — edit them in DevTools to test the demangle path.
      </p>
      <button
        type="button"
        className={styles.action}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? "Hide regions" : "Show regions"}
      </button>
    </div>
  );
}
