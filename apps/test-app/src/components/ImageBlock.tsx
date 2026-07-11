/**
 * Tier: image rescale (DOM/HTML template -> width/height sync).
 * A rescale is just a width/height change, so it flows through the ops that
 * already exist: editing the width/height ATTRIBUTES in the Elements panel maps
 * to `set-attr` on this <img>; editing the inline `style` width/height maps to
 * `set-attr` on the style prop; editing a CSS width rule flows through the CSS
 * tiers. Both images below are located via the data-source-* attributes the
 * source-locator babel plugin stamps at build time.
 */
const SWATCH =
  "data:image/svg+xml;utf8," +
  "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='240'>" +
  "<rect width='100%' height='100%' fill='%233b82f6'/>" +
  "<text x='50%' y='50%' fill='white' text-anchor='middle' dy='.35em' " +
  "font-family='sans-serif' font-size='20'>resize me</text></svg>";

export function ImageBlock() {
  return (
    <div style={{ display: "flex", gap: "24px", alignItems: "flex-start" }}>
      {/* sized by ATTRIBUTES — edit width/height in the Elements panel */}
      <img src={SWATCH} alt="sized by width/height attributes" width={320} height={240} />
      {/* sized by inline STYLE — edit style width/height in the Styles panel */}
      <img
        src={SWATCH}
        alt="sized by inline style"
        style={{ width: "160px", height: "120px", objectFit: "cover" }}
      />
    </div>
  );
}
