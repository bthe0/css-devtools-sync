import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { sourceLocator } from "@dev-sync/babel-plugin-source-locator/vite";

// Mirrors vite.config.ts: the source-locator plugin must run in the test
// transform pipeline too, so the render test can assert __srcLoc source location
// attributes actually land on host elements the same way dev-serve does.
export default defineConfig({
  plugins: [
    sourceLocator(),
    react({
      jsxImportSource: "@emotion/react",
      babel: {
        plugins: [
          [
            "@emotion/babel-plugin",
            { sourceMap: true, autoLabel: "always", labelFormat: "[dirname]--[local]" },
          ],
          [
            "babel-plugin-styled-components",
            { displayName: true, fileName: true, ssr: false, sourceMap: true },
          ],
        ],
      },
    }),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.tsx"],
  },
});
