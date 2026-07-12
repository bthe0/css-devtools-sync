import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Plugin, ViteDevServer } from "vite";
import { devSync, MOUNT_PREFIX } from "./index.js";

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

describe("devSync", () => {
  it("returns an array of plugins", () => {
    const plugins = devSync();
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBeGreaterThanOrEqual(2);
  });

  it("enables the CSS dev sourcemap via a serve-only config hook", () => {
    const plugins = devSync();
    const configPlugin = plugins.find((p) => p.name === "dev-sync:config");
    expect(configPlugin).toBeDefined();
    expect(configPlugin?.apply).toBe("serve");
    expect(callConfigHook(configPlugin!)).toEqual({ css: { devSourcemap: true } });
  });

  it("composes the JSX source-locator plugin for host-element stamping", () => {
    const plugins = devSync();
    expect(plugins.some((p) => p.name === "dev-sync:source-locator")).toBe(true);
  });

  it("threads an explicit root through to the source-locator", () => {
    // Smoke: passing a root must not throw and must still yield both plugins.
    const plugins = devSync({ root: os.tmpdir() });
    expect(plugins.some((p) => p.name === "dev-sync:config")).toBe(true);
    expect(plugins.some((p) => p.name === "dev-sync:source-locator")).toBe(true);
  });

  it("mounts the apply engine on the dev server under the prefix", async () => {
    const plugins = devSync({ root: os.tmpdir() });
    const enginePlugin = plugins.find((p) => p.name === "dev-sync:engine");
    expect(enginePlugin).toBeDefined();
    expect(enginePlugin?.apply).toBe("serve");

    const use = vi.fn();
    const server = {
      config: { root: os.tmpdir() },
      middlewares: { use },
    } as unknown as ViteDevServer;

    const hook = enginePlugin!.configureServer;
    const fn = typeof hook === "function" ? hook : hook?.handler;
    await fn?.call(enginePlugin as never, server);

    expect(use).toHaveBeenCalledTimes(1);
    expect(use.mock.calls[0]?.[0]).toBe(MOUNT_PREFIX);
    expect(typeof use.mock.calls[0]?.[1]).toBe("function");
  });

  it("omits the engine plugin when engine:false", () => {
    const plugins = devSync({ engine: false });
    expect(plugins.some((p) => p.name === "dev-sync:engine")).toBe(false);
    expect(plugins.some((p) => p.name === "dev-sync:config")).toBe(true);
    expect(plugins.some((p) => p.name === "dev-sync:source-locator")).toBe(true);
  });
});
