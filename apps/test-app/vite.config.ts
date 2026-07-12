import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devSync } from "@dev-sync/vite";

export default defineConfig({
  plugins: [
    // Drop-in integration (the same public API the README tells users to add):
    // turns on the CSS dev sourcemap, mounts the apply engine on this dev
    // server's own origin at `/__dev-sync/*`, and stamps JSX host elements with
    // their off-DOM `__srcLoc` source location. All dev-serve only.
    devSync(),
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
  server: {
    port: 5199,
    strictPort: true,
  },
});
