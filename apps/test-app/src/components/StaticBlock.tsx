/**
 * Tier: static JSX markup (DOM/HTML -> template sync).
 * Mostly-static markup with inline `style` props, literal text children, and
 * a literal `aria-label` attribute. Editing element.style, the aria-label
 * attribute, or the heading/body text in the Elements panel should sync back
 * into this JSX — resolved via the __srcLoc source location stamped by the
 * source-locator babel plugin (Tier 3 instrumentation), since there is no
 * stylesheet or CSS-in-JS template to fall back on for this tier.
 */
export function StaticBlock() {
  return (
    <footer
      style={{
        backgroundColor: "#12141f",
        border: "1px solid #232636",
        borderRadius: "10px",
        padding: "20px 24px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        {/* set-text target: literal text child, no expressions/JSXExpressionContainer */}
        <strong style={{ color: "#f3f4f8", fontSize: "14px" }}>css-devtools-sync</strong>
        <p style={{ margin: "4px 0 0", color: "#6b7080", fontSize: "12px" }}>
          v0.0.1 — local fixture build
        </p>
      </div>
      {/* set-attr target: literal aria-label string attribute */}
      <nav
        aria-label="Footer navigation"
        style={{ display: "flex", gap: "18px" }}
      >
        <a
          href="#plain"
          title="Jump to the plain CSS tier"
          style={{ color: "#8b90a0", fontSize: "12px" }}
        >
          Plain CSS
        </a>
        <a href="#scss" style={{ color: "#8b90a0", fontSize: "12px" }}>
          Sass
        </a>
        <a href="#emotion" style={{ color: "#8b90a0", fontSize: "12px" }}>
          Emotion
        </a>
        <a href="#tailwind" style={{ color: "#8b90a0", fontSize: "12px" }}>
          Tailwind
        </a>
      </nav>
    </footer>
  );
}
