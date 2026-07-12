import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";
import { buildServer, isOriginAllowed } from "../src/server.js";

const tmpDirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeCfg(overrides: Partial<Config> = {}): Config {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-server-"));
  tmpDirs.push(root);
  return {
    workspaceRoot: fs.realpathSync(root),
    port: 0,
    appEnv: "test",
    anthropicApiKey: undefined,
    extensionId: undefined,
    syncToken: undefined,
    overridesFile: "src/index.css",
    // Keep the write journal inside the temp tree so commit-mode tests never
    // pollute the real ~/.dev-sync/journal; cleaned with `root` in afterEach.
    journalDir: path.join(root, ".dev-sync-journal"),
    ...overrides,
  };
}

const EXT_ID_A = "a".repeat(32);
const EXT_ID_B = "b".repeat(32);

// ---------------------------------------------------------------------------
// isOriginAllowed — pure logic
// ---------------------------------------------------------------------------

describe("isOriginAllowed", () => {
  it("allows any chrome-extension id-shaped origin in dev when EXTENSION_ID unset", () => {
    expect(isOriginAllowed(`chrome-extension://${EXT_ID_A}`, { appEnv: "development", extensionId: undefined })).toBe(true);
  });

  it("rejects EVERY chrome-extension origin in production when EXTENSION_ID unset (fail-closed)", () => {
    expect(isOriginAllowed(`chrome-extension://${EXT_ID_A}`, { appEnv: "production", extensionId: undefined })).toBe(
      false,
    );
  });

  it("when EXTENSION_ID is set, allows ONLY that exact origin (dev or prod)", () => {
    const cfgDev = { appEnv: "development" as const, extensionId: EXT_ID_A };
    const cfgProd = { appEnv: "production" as const, extensionId: EXT_ID_A };
    expect(isOriginAllowed(`chrome-extension://${EXT_ID_A}`, cfgDev)).toBe(true);
    expect(isOriginAllowed(`chrome-extension://${EXT_ID_A}`, cfgProd)).toBe(true);
    // a different, equally id-shaped extension is rejected even though the old
    // wildcard regex would have accepted it
    expect(isOriginAllowed(`chrome-extension://${EXT_ID_B}`, cfgDev)).toBe(false);
    expect(isOriginAllowed(`chrome-extension://${EXT_ID_B}`, cfgProd)).toBe(false);
  });

  it("allows localhost only outside production", () => {
    expect(isOriginAllowed("http://localhost:5173", { appEnv: "development", extensionId: undefined })).toBe(true);
    expect(isOriginAllowed("http://localhost:5173", { appEnv: "production", extensionId: undefined })).toBe(false);
  });

  it("rejects arbitrary web origins in every environment", () => {
    expect(isOriginAllowed("https://evil.example.com", { appEnv: "development", extensionId: undefined })).toBe(
      false,
    );
    expect(isOriginAllowed("https://evil.example.com", { appEnv: "production", extensionId: EXT_ID_A })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CORS — integration
// ---------------------------------------------------------------------------

describe("CORS integration", () => {
  it("echoes back an allowed extension origin", async () => {
    const cfg = makeCfg({ extensionId: EXT_ID_A, appEnv: "development" });
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: `chrome-extension://${EXT_ID_A}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(`chrome-extension://${EXT_ID_A}`);
  });

  it("does not echo a disallowed origin and does not serve it as an ordinary 200", async () => {
    const cfg = makeCfg({ extensionId: EXT_ID_A, appEnv: "development" });
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: `chrome-extension://${EXT_ID_B}` },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.statusCode).not.toBe(200);
  });

  it("rejects any chrome-extension origin in production when EXTENSION_ID is unset", async () => {
    const cfg = makeCfg({ extensionId: undefined, appEnv: "production" });
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: `chrome-extension://${EXT_ID_A}` },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.statusCode).not.toBe(200);
  });
});

// ---------------------------------------------------------------------------
// SYNC_TOKEN — integration
// ---------------------------------------------------------------------------

describe("SYNC_TOKEN gating", () => {
  it("rejects /apply with 401 when SYNC_TOKEN is set and no header is sent", async () => {
    const cfg = makeCfg({ syncToken: "s3cr3t" });
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({ method: "POST", url: "/apply", payload: { url: "http://x", changes: [] } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects /apply with 401 when the token does not match", async () => {
    const cfg = makeCfg({ syncToken: "s3cr3t" });
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/apply",
      headers: { "x-sync-token": "wrong" },
      payload: { url: "http://x", changes: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts /apply when the token matches", async () => {
    const cfg = makeCfg({ syncToken: "s3cr3t" });
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/apply",
      headers: { "x-sync-token": "s3cr3t" },
      payload: { url: "http://x", changes: [] },
    });
    expect(res.statusCode).toBe(200);
    // default applyMode is preview → committed:false; empty changes → empty buckets.
    expect(res.json()).toEqual({ applied: [], skipped: [], needsPlacement: [], committed: false });
  });

  it("rejects /verify with 401 when the token is missing", async () => {
    const cfg = makeCfg({ syncToken: "s3cr3t" });
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({ method: "POST", url: "/verify", payload: { url: "http://x", checks: [] } });
    expect(res.statusCode).toBe(401);
  });

  it("accepts /verify when the token matches", async () => {
    const cfg = makeCfg({ syncToken: "s3cr3t" });
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/verify",
      headers: { "x-sync-token": "s3cr3t" },
      payload: { url: "http://x", checks: [] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("requires no header at all when SYNC_TOKEN is unset (default, backwards compatible)", async () => {
    const cfg = makeCfg({ syncToken: undefined });
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({ method: "POST", url: "/apply", payload: { url: "http://x", changes: [] } });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Payload edge cases
// ---------------------------------------------------------------------------

describe("/apply payload edge cases", () => {
  it("accepts an empty changes[] and returns empty result buckets", async () => {
    const cfg = makeCfg();
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({ method: "POST", url: "/apply", payload: { url: "http://x", changes: [] } });
    expect(res.statusCode).toBe(200);
    // default applyMode is preview → committed:false; empty changes → empty buckets.
    expect(res.json()).toEqual({ applied: [], skipped: [], needsPlacement: [], committed: false });
  });

  it("skips (not 500s) an add-decl change against an unknown selector", async () => {
    const cfg = makeCfg();
    fs.mkdirSync(path.join(cfg.workspaceRoot, "styles"), { recursive: true });
    fs.writeFileSync(path.join(cfg.workspaceRoot, "styles", "app.css"), ".card { color: red; }\n");
    const app = await buildServer(cfg);
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/apply",
      payload: {
        url: "http://localhost/x",
        changes: [
          {
            op: "modify",
            styleSheet: { id: "s1", sourceURL: "http://localhost:5173/styles/app.css", origin: "regular" },
            selector: ".does-not-exist",
            property: "color",
            oldValue: "red",
            newValue: "blue",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: unknown[]; skipped: { reason: string }[] };
    expect(body.applied).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]?.reason).toMatch(/selector not found/);
  });
});
