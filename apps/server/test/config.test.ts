import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/** A real directory so the workspace-root existence check passes. */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dev-sync-cfg-"));
const VALID_ID = "a".repeat(32); // 32 lowercase a-p chars

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** loadConfig reads only the passed env — never the ambient process.env. */
const load = (env: Record<string, string | undefined>) => loadConfig(env as NodeJS.ProcessEnv);

describe("loadConfig — workspace root", () => {
  it("throws when DEV_SYNC_WORKSPACE_ROOT is unset", () => {
    expect(() => load({})).toThrow(/DEV_SYNC_WORKSPACE_ROOT/);
  });

  it("treats empty string as unset (so it still throws)", () => {
    expect(() => load({ DEV_SYNC_WORKSPACE_ROOT: "" })).toThrow(/DEV_SYNC_WORKSPACE_ROOT/);
  });

  it("throws when the root does not exist", () => {
    expect(() => load({ DEV_SYNC_WORKSPACE_ROOT: path.join(ROOT, "nope") })).toThrow(
      /does not exist/,
    );
  });

  it("throws when the root is a file, not a directory", () => {
    const file = path.join(ROOT, "afile.txt");
    fs.writeFileSync(file, "x");
    expect(() => load({ DEV_SYNC_WORKSPACE_ROOT: file })).toThrow(/not a directory/);
  });
});

describe("loadConfig — development defaults", () => {
  it("accepts just the root; guards default to undefined and appEnv=development", () => {
    const cfg = load({ DEV_SYNC_WORKSPACE_ROOT: ROOT });
    expect(cfg.appEnv).toBe("development");
    expect(cfg.syncToken).toBeUndefined();
    expect(cfg.extensionId).toBeUndefined();
    expect(cfg.port).toBe(7777);
    expect(cfg.overridesFile).toBe("src/index.css");
    expect(cfg.workspaceRoot).toBe(fs.realpathSync(ROOT));
  });

  it("rejects a malformed EXTENSION_ID even in development", () => {
    expect(() => load({ DEV_SYNC_WORKSPACE_ROOT: ROOT, EXTENSION_ID: "TOO-SHORT" })).toThrow(
      /EXTENSION_ID/,
    );
  });
});

describe("loadConfig — production is fail-closed", () => {
  const prod = { DEV_SYNC_WORKSPACE_ROOT: ROOT, APP_ENV: "production" };

  it("throws when SYNC_TOKEN is unset in production", () => {
    expect(() => load({ ...prod, EXTENSION_ID: VALID_ID })).toThrow(/SYNC_TOKEN is required/);
  });

  it("throws when EXTENSION_ID is unset in production", () => {
    expect(() => load({ ...prod, SYNC_TOKEN: "s3cret" })).toThrow(/EXTENSION_ID is required/);
  });

  it("reports BOTH missing guards in one error", () => {
    expect(() => load(prod)).toThrow(/SYNC_TOKEN is required.*EXTENSION_ID is required/s);
  });

  it("accepts production when both guards are set", () => {
    const cfg = load({ ...prod, SYNC_TOKEN: "s3cret", EXTENSION_ID: VALID_ID });
    expect(cfg.appEnv).toBe("production");
    expect(cfg.syncToken).toBe("s3cret");
    expect(cfg.extensionId).toBe(VALID_ID);
  });

  it("does NOT require the guards outside production", () => {
    expect(() => load({ DEV_SYNC_WORKSPACE_ROOT: ROOT, APP_ENV: "test" })).not.toThrow();
  });
});
