import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sourceLocator } from "@dev-sync/babel-plugin-source-locator/vite";

export default defineConfig({
  plugins: [
    // Source-locator (Tier 3): stamps JSX host elements with
    // data-source-file / data-source-line / data-source-component so the
    // extension can map DOM edits back to source without a sourcemap.
    // Runs `enforce: "pre"`, dev-serve only; composes with plugin-react below.
    sourceLocator(),
    react({
      jsxImportSource: "@emotion/react",
      babel: {
        plugins: [
          [
            "@emotion/babel-plugin",
            {
              // Source maps + readable labels so DevTools shows
              // "css-<label>" class names pointing at EmotionButton.tsx.
              sourceMap: true,
              autoLabel: "always",
              labelFormat: "[dirname]--[local]",
            },
          ],
          [
            "babel-plugin-styled-components",
            {
              // Source maps + displayName so DevTools shows
              // "StyledBadge__Pill-sc-<hash>" class names whose injected
              // <style> carries a sourcemap comment pointing at
              // StyledBadge.tsx, letting the sync server locate the
              // tagged template literal.
              displayName: true,
              fileName: true,
              ssr: false,
              sourceMap: true,
            },
          ],
        ],
      },
    }),
  ],
  css: {
    // Dev sourcemaps for Sass modules — the sync server's sourcemap tier
    // needs these to map compiled CSS back to ScssPanel.module.scss.
    devSourcemap: true,
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
