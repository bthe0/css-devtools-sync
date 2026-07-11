import styles from "./ScssPanel.module.scss";

/**
 * Tier: Sass CSS module (sourcemap lookup).
 * Styles live in ScssPanel.module.scss — class names are hashed at runtime,
 * so the sync server must resolve edits through the dev sourcemap.
 */
const METRICS = [
  { label: "Requests / min", value: "1,284" },
  { label: "p95 latency", value: "212 ms" },
  { label: "Error rate", value: "0.4%" },
  { label: "Cache hit ratio", value: "93.1%" },
] as const;

export function ScssPanel() {
  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <h3>Edge metrics</h3>
        <span className={styles.count}>{METRICS.length} series</span>
      </div>
      {METRICS.map((m) => (
        <div key={m.label} className={styles.row}>
          <span>{m.label}</span>
          <span className={styles.value}>{m.value}</span>
        </div>
      ))}
    </section>
  );
}
