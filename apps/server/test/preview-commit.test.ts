// preview-commit.test.ts — Phase 1 (Trust core) exit criteria, end to end.
//
// Proves the two-phase apply contract that the extension relies on:
//   1. preview (default applyMode) writes NOTHING and returns a per-file diff
//      (before/after/unified) plus committed:false — a safe dry-run.
//   2. commit writes the file AND journals it (append-only, outside the jail).
//   3. every outcome carries a confidence signal (deterministic here).
//   4. an ambiguous/stale change is SKIPPED with a human reason — never a
//      silent no-op, and never a disk mutation.
//   5. commit recomputes against the CURRENT file, never replays a stale plan.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CapturePayloadInput, ModifyChange } from "@dev-sync/contract";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { readJournal } from "../src/journal.js";

const tmpDirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Fresh workspace with styles/app.css holding a single .card rule. */
function makeWorkspace(css = ".card { color: red; }\n"): { root: string; cssAbs: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cssync-pc-")));
  tmpDirs.push(root);
  const cssAbs = path.join(root, "styles", "app.css");
  fs.mkdirSync(path.dirname(cssAbs), { recursive: true });
  fs.writeFileSync(cssAbs, css, "utf8");
  return { root, cssAbs };
}

function makeCfg(root: string): Config {
  return {
    workspaceRoot: root,
    port: 0,
    appEnv: "test",
    anthropicApiKey: undefined, // LLM targeting disabled
    extensionId: undefined,
    syncToken: undefined,
    overridesFile: "src/index.css",
    journalDir: path.join(root, ".dev-sync-journal"), // contained, cleaned in afterEach
  };
}

/** A deterministic plain-CSS modify: .card color red -> blue, mapped to styles/app.css. */
function cardColorChange(over: Partial<ModifyChange> = {}): ModifyChange {
  return {
    op: "modify",
    styleSheet: { id: "s1", sourceURL: "http://localhost:5173/styles/app.css", origin: "regular" },
    selector: ".card",
    property: "color",
    oldValue: "red",
    newValue: "blue",
    ...over,
  };
}

function apply(app: FastifyInstance, changes: ModifyChange[], applyMode?: "preview" | "commit") {
  const payload: CapturePayloadInput = { url: "http://localhost:5173/", changes };
  if (applyMode) payload.applyMode = applyMode;
  return app.inject({ method: "POST", url: "/apply", payload });
}

type Outcome = {
  file: string;
  mode: string;
  confidence: string;
  confidenceReason?: string;
  diff?: { before: string; after: string; unified: string };
};
type Result = {
  applied: Outcome[];
  skipped: { reason: string }[];
  needsPlacement: unknown[];
  committed: boolean;
};

describe("preview (default applyMode): dry-run, no write, returns a diff", () => {
  it("writes nothing, returns before/after/unified, and reports committed:false", async () => {
    const { root, cssAbs } = makeWorkspace();
    const before = fs.readFileSync(cssAbs, "utf8");
    const app = await buildServer(makeCfg(root));
    apps.push(app);

    const res = await apply(app, [cardColorChange()]); // no applyMode -> preview
    expect(res.statusCode).toBe(200);
    const body = res.json() as Result;

    expect(body.committed).toBe(false);
    expect(body.skipped).toHaveLength(0);
    expect(body.applied).toHaveLength(1);

    const out = body.applied[0]!;
    expect(out.file).toBe("styles/app.css");
    expect(out.mode).toBe("postcss");
    expect(out.diff).toBeDefined();
    expect(out.diff!.before).toBe(before); // proposed change is against the real file
    expect(out.diff!.after).toContain("color: blue");
    expect(out.diff!.after).not.toContain("color: red");
    // Unified patch names the file and shows both sides of the hunk.
    expect(out.diff!.unified).toContain("styles/app.css");
    expect(out.diff!.unified).toContain("-.card { color: red; }");
    expect(out.diff!.unified).toContain("+.card { color: blue; }");

    // The whole point: disk is byte-identical after a preview.
    expect(fs.readFileSync(cssAbs, "utf8")).toBe(before);
  });

  it("preview journals nothing", async () => {
    const { root } = makeWorkspace();
    const cfg = makeCfg(root);
    const app = await buildServer(cfg);
    apps.push(app);
    await apply(app, [cardColorChange()]);
    expect(await readJournal(cfg)).toHaveLength(0);
  });
});

describe("commit: writes the file and journals the write", () => {
  it("mutates disk, reports committed:true, and appends one journal entry", async () => {
    const { root, cssAbs } = makeWorkspace();
    const cfg = makeCfg(root);
    const app = await buildServer(cfg);
    apps.push(app);

    const res = await apply(app, [cardColorChange()], "commit");
    expect(res.statusCode).toBe(200);
    const body = res.json() as Result;

    expect(body.committed).toBe(true);
    expect(body.applied).toHaveLength(1);
    expect(fs.readFileSync(cssAbs, "utf8")).toContain("color: blue");

    const journal = await readJournal(cfg);
    expect(journal).toHaveLength(1);
    const entry = journal[0]!;
    expect(entry.file).toBe("styles/app.css");
    expect(entry.mode).toBe("postcss");
    expect(entry.confidence).toBe("deterministic");
    expect(entry.before).toContain("color: red");
    expect(entry.after).toContain("color: blue");
  });
});

describe("confidence signal: every outcome is labelled", () => {
  it("a plain-CSS sourcemap-mapped modify is deterministic", async () => {
    const { root } = makeWorkspace();
    const app = await buildServer(makeCfg(root));
    apps.push(app);
    const body = (await apply(app, [cardColorChange()])).json() as Result;
    expect(body.applied[0]!.confidence).toBe("deterministic");
  });
});

describe("ambiguous/stale change: skipped with a reason, never silent, never a write", () => {
  it("an unknown selector is skipped with a human reason and leaves disk untouched", async () => {
    const { root, cssAbs } = makeWorkspace();
    const before = fs.readFileSync(cssAbs, "utf8");
    const app = await buildServer(makeCfg(root));
    apps.push(app);

    // commit mode: prove that even when writes are enabled, an unresolved
    // target produces an explicit skip, not a silent no-op or a corruption.
    const body = (await apply(app, [cardColorChange({ selector: ".ghost" })], "commit")).json() as Result;

    expect(body.applied).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]!.reason).toMatch(/selector not found/i);
    expect(fs.readFileSync(cssAbs, "utf8")).toBe(before); // byte-identical
  });
});

describe("commit recomputes against the current file (no stale-plan replay)", () => {
  it("a preview, then an external edit, then commit — commit reflects the CURRENT file", async () => {
    const { root, cssAbs } = makeWorkspace();
    const cfg = makeCfg(root);
    const app = await buildServer(cfg);
    apps.push(app);

    // 1. Preview the red->blue change while the file is still red.
    const preview = (await apply(app, [cardColorChange()])).json() as Result;
    expect(preview.applied[0]!.diff!.before).toContain("color: red");

    // 2. Someone edits the file out-of-band: red -> green, plus an unrelated rule.
    fs.writeFileSync(cssAbs, ".card { color: green; }\n.other { margin: 0; }\n", "utf8");

    // 3. Commit the SAME change object. It must re-read disk, not replay the
    //    stale preview: before == the green file, and the write preserves .other.
    const commit = (await apply(app, [cardColorChange()], "commit")).json() as Result;
    expect(commit.committed).toBe(true);
    expect(commit.applied).toHaveLength(1);
    const entry = commit.applied[0]!;
    expect(entry.diff!.before).toContain("color: green"); // current, not the stale red
    expect(entry.diff!.before).not.toContain("color: red");

    const onDisk = fs.readFileSync(cssAbs, "utf8");
    expect(onDisk).toContain("color: blue");
    expect(onDisk).toContain(".other { margin: 0; }"); // untouched sibling survives
  });
});

describe("commit guards the read-modify-write race (fix #1)", () => {
  it("skips a change whose target file drifted on disk between compute and commit", async () => {
    const { root, cssAbs } = makeWorkspace(); // .card { color: red; }
    const cfg = makeCfg(root);
    const app = await buildServer(cfg);
    apps.push(app);

    // Simulate a concurrent writer: right after applyOne reads the file to
    // capture `before` (red), land an external edit (green) on disk. The commit
    // path re-reads before writing and must see the drift, skip, and NOT clobber
    // the green with its stale blue. Hook the FIRST read of the target file.
    const realRead = fs.readFileSync.bind(fs);
    let injected = false;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown, opts: unknown) => {
      const content = realRead(p as fs.PathOrFileDescriptor, opts as never);
      if (!injected && typeof p === "string" && p.endsWith("app.css")) {
        injected = true; // external edit lands in the compute→commit window
        fs.writeFileSync(cssAbs, ".card { color: green; }\n", "utf8");
      }
      return content;
    }) as typeof fs.readFileSync);

    try {
      const body = (await apply(app, [cardColorChange()], "commit")).json() as Result;
      expect(body.applied).toHaveLength(0);
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0]!.reason).toMatch(/changed on disk/i);
      // The concurrent writer's content survives; it is NOT clobbered with blue.
      expect(fs.readFileSync(cssAbs, "utf8")).toBe(".card { color: green; }\n");
    } finally {
      spy.mockRestore();
    }

    // And nothing was journaled for the skipped change.
    expect(await readJournal(cfg)).toHaveLength(0);
  });

  it("a normal single write with no drift still commits (control)", async () => {
    const { root, cssAbs } = makeWorkspace();
    const app = await buildServer(makeCfg(root));
    apps.push(app);
    const body = (await apply(app, [cardColorChange()], "commit")).json() as Result;
    expect(body.skipped).toHaveLength(0);
    expect(body.applied).toHaveLength(1);
    expect(fs.readFileSync(cssAbs, "utf8")).toContain("color: blue");
  });
});
