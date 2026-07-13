import { style } from "@vanilla-extract/css";

// Flat export: probes whether a top-level camelCase key in style({...})
// maps 1:1 to a served kebab-case CSS declaration.
export const card = style({
  padding: "20px",
  borderRadius: "8px",
  color: "#111827",
});

// Nested export: probes whether a pseudo-selector and an @media block
// remap deterministically back to `selectors["&:hover"]` / `"@media"[...]`.
export const fancy = style({
  padding: "10px",
  selectors: {
    "&:hover": {
      padding: "16px",
    },
  },
  "@media": {
    "screen and (min-width: 900px)": {
      padding: "24px",
    },
  },
});
