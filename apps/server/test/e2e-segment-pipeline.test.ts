// e2e-segment-pipeline.test.ts — cross-layer E2E for the set-text-segment tier.
//
// Every other suite tests one layer: server apply logic (vitest) OR the client
// diff/resolve logic (node:test, apps/extension). This suite wires them end to
// end: it feeds a REAL server /describe response into the REAL client resolver
// (apps/extension/background/diff.js — imported unmodified, it is browser-free),
// then POSTs the resolver's set-text-segment change to a REAL server /apply over
// a real temp source file. It is the only place that proves the fragile
// DOM-childNodes <-> source-children alignment produces a change the server
// actually accepts and writes correctly — the gap unit fixtures cannot cover.
//
// The one layer NOT exercised here is the browser DOM serialization in
// devtools.js (el.childNodes -> `kids`), which is pure and can only run inside a
// DevTools panel. We stand in its place by constructing the `kids` React would
// produce for each fixture (each {expr} and each static run is its own text
// node; JSX strips whitespace-only children that contain a newline).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";
import {
  resolveTextSegmentEdit,
  buildSetTextSegmentChange,
  renderProducingParts,
} from "../../extension/background/diff.js";

const tmpDirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeCfg(overrides: Partial<Config> = {}): Config {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-e2e-seg-"));
  tmpDirs.push(root);
  return {
    workspaceRoot: fs.realpathSync(root),
    port: 0,
    appEnv: "test",
    anthropicApiKey: undefined,
    extensionId: undefined,
    syncToken: undefined,
    overridesFile: "src/index.css",
    ...overrides,
  };
}

/** Write `src/<name>` under the workspace and return {file (workspace-rel), line of `needle`}. */
function writeSource(cfg: Config, name: string, code: string, needle: string) {
  const rel = `src/${name}`;
  const abs = path.join(cfg.workspaceRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, code, "utf8");
  const line = code.slice(0, code.indexOf(needle)).split("\n").length;
  return { rel, abs, line };
}

/** A text childNode as devtools.js would serialize it. */
const text = (v: string) => ({ t: 0, v });
/** An element childNode (t:1) — value irrelevant to the resolver. */
const el = () => ({ t: 1 });

async function describe_(app: FastifyInstance, element: unknown) {
  const res = await app.inject({ method: "POST", url: "/describe", payload: { element } });
  return res;
}

async function apply_(app: FastifyInstance, change: unknown) {
  const res = await app.inject({
    method: "POST",
    url: "/apply",
    payload: { url: "http://localhost/x", changes: [change] },
  });
  return res;
}

describe("E2E: set-text-segment pipeline (client resolver <-> server describe/apply)", () => {
  it("edits one static run in a single-line mixed element, leaving every {expr} hole intact", async () => {
    const cfg = makeCfg();
    const code = `export function Greeting({ name, count }) {\n  return <p className="greet">Hello {name}, {count} items</p>;\n}\n`;
    const { rel, abs, line } = writeSource(cfg, "Greeting.tsx", code, "<p");
    const app = await buildServer(cfg);
    apps.push(app);

    const element = { tagName: "P", classList: ["greet"], dataSourceFile: rel, dataSourceLine: line };

    // 1. Real /describe.
    const desc = await describe_(app, element);
    expect(desc.statusCode).toBe(200);
    const tpl = desc.json() as { parts: unknown[]; editable: boolean };
    expect(tpl.editable).toBe(true);
    const parts = tpl.parts as { kind: string; index: number; text?: string; expr?: string }[];
    // static "Hello ", dynamic name, static ", ", dynamic count, static " items"
    expect(parts.map((p) => p.kind)).toEqual(["static", "dynamic", "static", "dynamic", "static"]);

    // 2. Rendered DOM React produces for name="World", count=3 — 5 text nodes.
    const kids = [text("Hello "), text("World"), text(", "), text("3"), text(" items")];
    // Sanity: no whitespace-only-newline parts here, so render-producing == kids.
    expect(renderProducingParts(parts).length).toBe(kids.length);

    // 3. Real client resolver: user edited the first static run "Hello " -> "Hi ".
    const resolved = resolveTextSegmentEdit(parts, kids, 0, "Hi ") as {
      ok: boolean;
      segmentIndex: number;
      oldText: string;
      newText: string;
    };
    expect(resolved.ok).toBe(true);
    expect(resolved.oldText).toBe("Hello ");
    expect(resolved.newText).toBe("Hi ");

    // 4. Real client change-builder + real server /apply.
    const built = buildSetTextSegmentChange(
      element,
      resolved.segmentIndex,
      resolved.oldText,
      resolved.newText,
    ) as { ok: boolean; change: unknown };
    expect(built.ok).toBe(true);
    const res = await apply_(app, built.change);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: { mode: string }[]; skipped: unknown[] };
    expect(body.skipped).toHaveLength(0);
    expect(body.applied).toHaveLength(1);
    expect(body.applied[0]?.mode).toBe("jsx");

    // 5. Source: static text changed, both holes and the second static run intact.
    const after = fs.readFileSync(abs, "utf8");
    expect(after).toContain("<p className=\"greet\">Hi {name}, {count} items</p>");
    expect(after).toContain("{name}");
    expect(after).toContain("{count}");
  });

  it("preserves source indentation editing a static run in a MULTILINE mixed element", async () => {
    const cfg = makeCfg();
    // The static child's raw JSXText is "\n      Hello " but React renders "Hello ".
    const code =
      `export function Hi({ name }) {\n  return (\n    <p>\n      Hello {name}\n    </p>\n  );\n}\n`;
    const { rel, abs, line } = writeSource(cfg, "Hi.tsx", code, "<p>");
    const app = await buildServer(cfg);
    apps.push(app);

    const element = { tagName: "P", classList: [], dataSourceFile: rel, dataSourceLine: line };
    const desc = await describe_(app, element);
    expect(desc.statusCode).toBe(200);
    const parts = (desc.json() as { parts: unknown[] }).parts as {
      kind: string;
      index: number;
      text?: string;
      whitespaceOnly?: boolean;
    }[];
    // static "\n      Hello ", dynamic name, static "\n    " (whitespace-only)
    expect(parts.map((p) => p.kind)).toEqual(["static", "dynamic", "static"]);
    expect(parts[2]?.whitespaceOnly).toBe(true);

    // React drops the trailing whitespace-only-newline child -> 2 rendered nodes.
    const kids = [text("Hello "), text("World")];
    const rendered = renderProducingParts(parts);
    expect(rendered.length).toBe(kids.length);

    const resolved = resolveTextSegmentEdit(parts, kids, 0, "Hi ") as {
      ok: boolean;
      segmentIndex: number;
      oldText: string;
      newText: string;
    };
    expect(resolved.ok).toBe(true);
    expect(resolved.segmentIndex).toBe(0);
    expect(resolved.oldText).toBe("\n      Hello ");
    // Leading newline+indent peeled off, re-applied around the new rendered text.
    expect(resolved.newText).toBe("\n      Hi ");

    const built = buildSetTextSegmentChange(element, resolved.segmentIndex, resolved.oldText, resolved.newText) as {
      ok: boolean;
      change: unknown;
    };
    const res = await apply_(app, built.change);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { applied: unknown[] }).applied).toHaveLength(1);

    const after = fs.readFileSync(abs, "utf8");
    expect(after).toContain("\n      Hi {name}\n"); // indentation + hole preserved
  });

  it("REFUSES client-side when the edited node maps to a dynamic {expr} hole (never rewrites it)", async () => {
    const cfg = makeCfg();
    const code = `export function G({ name }) {\n  return <p>Hello {name}!</p>;\n}\n`;
    const { rel } = writeSource(cfg, "G.tsx", code, "<p>");
    const app = await buildServer(cfg);
    apps.push(app);
    const element = { tagName: "P", classList: [], dataSourceFile: rel, dataSourceLine: 2 };

    const parts = (
      (await describe_(app, element)).json() as { parts: unknown[] }
    ).parts as { kind: string }[];
    expect(parts.map((p) => p.kind)).toEqual(["static", "dynamic", "static"]);

    // kids: "Hello ", "World"(={name}), "!" — user edited index 1, the hole.
    const kids = [text("Hello "), text("World"), text("!")];
    const resolved = resolveTextSegmentEdit(parts, kids, 1, "Universe") as {
      ok: boolean;
      dynamic?: boolean;
    };
    expect(resolved.ok).toBe(false);
    expect(resolved.dynamic).toBe(true); // devtools.js suppresses; nothing is POSTed
  });

  it("REFUSES on DOM/source count mismatch (e.g. a list-map rendering N nodes over 1 dynamic part)", async () => {
    const cfg = makeCfg();
    const code = `export function List({ items }) {\n  return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;\n}\n`;
    const { rel } = writeSource(cfg, "List.tsx", code, "<ul>");
    const app = await buildServer(cfg);
    apps.push(app);
    const element = { tagName: "UL", classList: [], dataSourceFile: rel, dataSourceLine: 2 };

    const parts = ((await describe_(app, element)).json() as { parts: unknown[] }).parts as {
      kind: string;
    }[];
    // The whole body is one dynamic {items.map(...)} hole.
    expect(parts.map((p) => p.kind)).toEqual(["dynamic"]);

    // It rendered three <li> elements — 3 nodes over 1 render-producing part.
    const kids = [el(), el(), el()];
    const resolved = resolveTextSegmentEdit(parts, kids, 0, "x") as { ok: boolean; reason?: string };
    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toBe("count-mismatch");
  });

  it("server drift guard: a stale oldText is SKIPPED, not applied (source untouched)", async () => {
    const cfg = makeCfg();
    const code = `export function G2({ name }) {\n  return <p>Hello {name}, {count} items</p>;\n}\n`;
    const { rel, abs, line } = writeSource(cfg, "G2.tsx", code, "<p>");
    const app = await buildServer(cfg);
    apps.push(app);
    const element = { tagName: "P", classList: [], dataSourceFile: rel, dataSourceLine: line };
    const before = fs.readFileSync(abs, "utf8");

    // segmentIndex 0 is "Hello " but we lie that its current value is "Howdy ".
    const stale = { op: "set-text-segment", element, segmentIndex: 0, oldText: "Howdy ", newText: "Hi " };
    const res = await apply_(app, stale);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: unknown[]; skipped: { reason: string }[] };
    expect(body.applied).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(fs.readFileSync(abs, "utf8")).toBe(before); // byte-identical, no corruption
  });
});
