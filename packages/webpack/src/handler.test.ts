import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevSyncHandler, engineApiConfig } from "./handler.js";

// Integration: drive the real handler (real apply engine, temp workspace) through
// the exact path Next rewrites to (/api/__dev-sync/*) — proving prefix-strip +
// connect middleware + the resolve-on-close promise wire end-to-end. No browser.

interface CapturedRes extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  body: string | undefined;
  setHeader(name: string, value: string): void;
  end(data?: string): void;
}

function makeRes(): CapturedRes {
  const res = new EventEmitter() as CapturedRes;
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.end = (data) => {
    res.body = data;
    res.emit("close"); // the handler resolves its promise on close
  };
  return res;
}

function makeReq(method: string, url: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

async function drive(handler: ReturnType<typeof createDevSyncHandler>, method: string, url: string) {
  const res = makeRes();
  await handler(makeReq(method, url), res as unknown as ServerResponse);
  return res;
}

describe("createDevSyncHandler (integration, real engine)", () => {
  let root: string;
  let handler: ReturnType<typeof createDevSyncHandler>;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-sync-handler-"));
    handler = createDevSyncHandler({ root });
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves GET /journal through the rewritten /api/__dev-sync prefix", async () => {
    const res = await drive(handler, "GET", "/api/__dev-sync/journal");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ entries: [] });
  });

  it("also strips the raw page-origin /__dev-sync prefix", async () => {
    const res = await drive(handler, "GET", "/__dev-sync/journal");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ entries: [] });
  });

  it("404s an unknown route (middleware falls through to next)", async () => {
    const res = await drive(handler, "GET", "/api/__dev-sync/nope");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body!)).toEqual({ error: "not found" });
  });

  it("405s a wrong method on a known route", async () => {
    const res = await drive(handler, "GET", "/api/__dev-sync/apply"); // /apply is POST
    expect(res.statusCode).toBe(405);
  });

  it("engineApiConfig disables Next's body parser (engine reads the raw stream)", () => {
    expect(engineApiConfig.api.bodyParser).toBe(false);
  });
});
