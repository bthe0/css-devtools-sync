import { Readable } from "node:stream";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configFromRoot } from "../src/config.js";
import { createApplyMiddleware } from "../src/middleware.js";

/** Minimal ServerResponse stand-in capturing what the middleware writes. */
interface CapturedRes {
  statusCode: number;
  headers: Record<string, string>;
  headersSent: boolean;
  body: string | undefined;
  setHeader(name: string, value: string): void;
  end(data?: string): void;
}
function makeRes(): CapturedRes {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(data) {
      this.body = data;
      this.headersSent = true;
    },
  };
}

/** Drive the middleware with a request; resolves once the response is written. */
function invoke(
  cfg: ReturnType<typeof configFromRoot>,
  opts: { method?: string; url: string; body?: unknown; headers?: Record<string, string> },
  mwOpts?: { prefix?: string },
): Promise<{ res: CapturedRes; nextCalled: boolean; json: unknown }> {
  const mw = createApplyMiddleware(cfg, mwOpts);
  const raw = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as Parameters<typeof mw>[0];
  Object.assign(req, {
    method: opts.method ?? "POST",
    url: opts.url,
    headers: opts.headers ?? {},
  });
  const res = makeRes();
  return new Promise((resolve) => {
    let nextCalled = false;
    mw(req, res as unknown as Parameters<typeof mw>[1], () => {
      nextCalled = true;
      resolve({ res, nextCalled, json: undefined });
    });
    // Poll for the async handler to finish writing the response.
    const started = Date.now();
    const tick = (): void => {
      if (res.headersSent) {
        resolve({ res, nextCalled, json: res.body ? JSON.parse(res.body) : undefined });
      } else if (Date.now() - started > 2000) {
        resolve({ res, nextCalled, json: undefined });
      } else {
        setImmediate(tick);
      }
    };
    setImmediate(tick);
  });
}

const cfg = configFromRoot(os.tmpdir());

describe("createApplyMiddleware", () => {
  it("passes unowned paths through to next()", async () => {
    const { nextCalled, res } = await invoke(cfg, { url: "/index.html" });
    expect(nextCalled).toBe(true);
    expect(res.headersSent).toBe(false);
  });

  it("rejects non-POST with 405", async () => {
    const { res } = await invoke(cfg, { method: "GET", url: "/verify" });
    expect(res.statusCode).toBe(405);
  });

  it("verifies matching computed styles (ok:true)", async () => {
    const { res, json } = await invoke(cfg, {
      url: "/verify",
      body: {
        url: "http://localhost:5173/",
        checks: [{ selector: ".a", property: "color", expected: "red", actual: "red" }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(json).toEqual({ ok: true, mismatches: [] });
  });

  it("reports verify mismatches", async () => {
    const { json } = await invoke(cfg, {
      url: "/verify",
      body: {
        url: "http://localhost:5173/",
        checks: [{ selector: ".a", property: "color", expected: "red", actual: "blue" }],
      },
    });
    expect(json).toMatchObject({ ok: false });
  });

  it("rejects an invalid CapturePayload with 400", async () => {
    const { res, json } = await invoke(cfg, { url: "/apply", body: { not: "a payload" } });
    expect(res.statusCode).toBe(400);
    expect(json).toMatchObject({ error: "invalid CapturePayload" });
  });

  it("applies an empty change set as a no-op preview", async () => {
    const { res, json } = await invoke(cfg, {
      url: "/apply",
      body: { url: "http://localhost:5173/", changes: [], applyMode: "preview" },
    });
    expect(res.statusCode).toBe(200);
    expect(json).toEqual({ applied: [], skipped: [], needsPlacement: [], committed: false });
  });

  it("rejects malformed JSON with 400", async () => {
    const mw = createApplyMiddleware(cfg);
    const req = Readable.from([Buffer.from("{ not json")]) as unknown as Parameters<typeof mw>[0];
    Object.assign(req, { method: "POST", url: "/verify", headers: {} });
    const res = makeRes();
    await new Promise<void>((resolve) => {
      mw(req, res as unknown as Parameters<typeof mw>[1], () => resolve());
      const tick = (): void => (res.headersSent ? resolve() : void setImmediate(tick));
      setImmediate(tick);
    });
    expect(res.statusCode).toBe(400);
  });

  it("enforces a sync token when configured", async () => {
    const tokenCfg = configFromRoot(os.tmpdir(), { syncToken: "secret" });
    const { res } = await invoke(tokenCfg, {
      url: "/verify",
      body: { url: "http://x/", checks: [] },
      headers: { "x-sync-token": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a matching sync token", async () => {
    const tokenCfg = configFromRoot(os.tmpdir(), { syncToken: "secret" });
    const { res } = await invoke(tokenCfg, {
      url: "/verify",
      body: { url: "http://x/", checks: [] },
      headers: { "x-sync-token": "secret" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("serves an empty write journal on GET /journal", async () => {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-sync-journal-"));
    const jcfg = configFromRoot(os.tmpdir(), { journalDir });
    const { res, json } = await invoke(jcfg, { method: "GET", url: "/journal?limit=10" });
    expect(res.statusCode).toBe(200);
    expect(json).toEqual({ entries: [] });
  });

  it("rejects POST /journal (wrong method) with 405", async () => {
    const { res } = await invoke(cfg, { method: "POST", url: "/journal", body: {} });
    expect(res.statusCode).toBe(405);
  });

  it("undoes against an empty journal without error", async () => {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-sync-journal-"));
    const jcfg = configFromRoot(os.tmpdir(), { journalDir });
    const { res, json } = await invoke(jcfg, { url: "/undo", body: {} });
    expect(res.statusCode).toBe(200);
    expect(json).toMatchObject({ reverted: [], skipped: [] });
  });

  it("redoes against an empty journal without error", async () => {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-sync-journal-"));
    const jcfg = configFromRoot(os.tmpdir(), { journalDir });
    const { res, json } = await invoke(jcfg, { url: "/redo", body: {} });
    expect(res.statusCode).toBe(200);
    expect(json).toMatchObject({ redone: [], skipped: [] });
  });

  it("rejects GET /redo (wrong method) with 405", async () => {
    const { res } = await invoke(cfg, { method: "GET", url: "/redo" });
    expect(res.statusCode).toBe(405);
  });
});

describe("createApplyMiddleware with a mount prefix", () => {
  const opts = { prefix: "/__dev-sync" };

  it("routes a prefixed path (POST /__dev-sync/apply)", async () => {
    const { res, json } = await invoke(
      cfg,
      { url: "/__dev-sync/apply", body: { url: "http://localhost:5173/", changes: [], applyMode: "preview" } },
      opts,
    );
    expect(res.statusCode).toBe(200);
    expect(json).toEqual({ applied: [], skipped: [], needsPlacement: [], committed: false });
  });

  it("preserves the query string across prefix stripping (GET /__dev-sync/journal?limit=10)", async () => {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-sync-journal-"));
    const jcfg = configFromRoot(os.tmpdir(), { journalDir });
    const { res, json } = await invoke(jcfg, { method: "GET", url: "/__dev-sync/journal?limit=10" }, opts);
    expect(res.statusCode).toBe(200);
    expect(json).toEqual({ entries: [] });
  });

  it("passes a bare prefixed path through to next() (no route)", async () => {
    const { nextCalled, res } = await invoke(cfg, { url: "/__dev-sync/nope" }, opts);
    expect(nextCalled).toBe(true);
    expect(res.headersSent).toBe(false);
  });

  it("does NOT treat a same-stem sibling path as under the prefix (/__dev-syncx)", async () => {
    // Boundary: startsWith("/__dev-sync") would falsely claim "/__dev-syncx/apply".
    const { nextCalled, res } = await invoke(cfg, { url: "/__dev-syncx/apply" }, opts);
    expect(nextCalled).toBe(true);
    expect(res.headersSent).toBe(false);
  });

  it("passes non-prefixed paths through to next() (SSR fall-through)", async () => {
    const { nextCalled } = await invoke(cfg, { url: "/some/page" }, opts);
    expect(nextCalled).toBe(true);
  });
});
