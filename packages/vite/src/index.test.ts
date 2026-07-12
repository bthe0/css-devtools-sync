import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import { cssSync } from "./index.js";

/** A plugin's `config` hook can be a fn or an `{ handler }` object — normalise. */
function callConfigHook(plugin: Plugin): unknown {
  const hook = plugin.config;
  if (typeof hook === "function") {
    return hook.call(plugin as never, {}, { command: "serve", mode: "development" });
  }
  if (hook && typeof hook === "object" && typeof hook.handler === "function") {
    return hook.handler.call(plugin as never, {}, { command: "serve", mode: "development" });
  }
  return undefined;
}

describe("cssSync", () => {
  it("returns an array of plugins", () => {
    const plugins = cssSync();
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBeGreaterThanOrEqual(2);
  });

  it("enables the CSS dev sourcemap via a serve-only config hook", () => {
    const plugins = cssSync();
    const configPlugin = plugins.find((p) => p.name === "css-sync:config");
    expect(configPlugin).toBeDefined();
    expect(configPlugin?.apply).toBe("serve");
    expect(callConfigHook(configPlugin!)).toEqual({ css: { devSourcemap: true } });
  });

  it("composes the JSX source-locator plugin for host-element stamping", () => {
    const plugins = cssSync();
    expect(plugins.some((p) => p.name === "css-sync:source-locator")).toBe(true);
  });

  it("threads an explicit root through to the source-locator", () => {
    // Smoke: passing a root must not throw and must still yield both plugins.
    const plugins = cssSync({ root: "/tmp/project" });
    expect(plugins.some((p) => p.name === "css-sync:config")).toBe(true);
    expect(plugins.some((p) => p.name === "css-sync:source-locator")).toBe(true);
  });
});
