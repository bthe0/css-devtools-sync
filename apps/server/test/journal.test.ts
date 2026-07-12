import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJournal, readJournal, redo, undo, withJournalLock, type JournalConfig } from "../src/journal.js";
import { readWorkspaceFile, writeWorkspaceFile } from "../src/workspace.js";

let workspaceRoot: string;
let journalDir: string;
let cfg: JournalConfig;

beforeEach(() => {
  workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cssync-ws-")));
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "cssync-journal-"));
  cfg = { workspaceRoot, journalDir };
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(journalDir, { recursive: true, force: true });
});

function baseEntry(overrides: Partial<Parameters<typeof appendJournal>[1]> = {}) {
  return {
    file: "src/app.css",
    mode: "postcss" as const,
    confidence: "deterministic" as const,
    before: ".card { color: red; }\n",
    after: ".card { color: blue; }\n",
    ...overrides,
  };
}

describe("appendJournal / readJournal", () => {
  it("round-trips an entry (id + ts populated)", async () => {
    const entry = await appendJournal(cfg, baseEntry());
    expect(entry.id).toBeTruthy();
    expect(entry.ts).toBeGreaterThan(0);

    const entries = await readJournal(cfg);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it("returns [] when the journal file is missing", async () => {
    const entries = await readJournal(cfg);
    expect(entries).toEqual([]);
  });

  it("returns entries newest-first", async () => {
    const a = await appendJournal(cfg, baseEntry({ file: "a.css" }));
    const b = await appendJournal(cfg, baseEntry({ file: "b.css" }));
    const entries = await readJournal(cfg);
    expect(entries.map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it("skips malformed lines but still returns valid ones", async () => {
    const entry = await appendJournal(cfg, baseEntry());
    const filePath = path.join(
      journalDir,
      fs.readdirSync(journalDir).find((f) => f.endsWith(".jsonl"))!,
    );
    fs.appendFileSync(filePath, "not-json-at-all\n");
    fs.appendFileSync(filePath, `${JSON.stringify({ missing: "fields" })}\n`);

    const entries = await readJournal(cfg);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(entry.id);
  });

  it("rotates and caps entry count", async () => {
    for (let i = 0; i < 520; i++) {
      await appendJournal(cfg, baseEntry({ file: `f${i}.css` }));
    }
    const entries = await readJournal(cfg, 1000);
    expect(entries.length).toBeLessThanOrEqual(500);
    // newest survives
    expect(entries[0]?.file).toBe("f519.css");
  });

  it("withJournalLock runs critical sections strictly one-at-a-time per file", async () => {
    // The append+rotate corruption vector (a rotate's read->rename clobbering a
    // racing append) is real but only loses data on a specific, non-deterministic
    // interleave — untestable head-on without flaking. Instead assert the actual
    // guarantee the fix provides: withJournalLock never lets two critical sections
    // for the SAME file overlap. A shared counter that spans an await gap would
    // exceed 1 the instant two run concurrently.
    let active = 0;
    let maxActive = 0;
    const gap = () => new Promise((r) => setTimeout(r, 5));
    const critical = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gap(); // yield: overlapping runs would be caught here
      active--;
    };

    const p = path.join(journalDir, "same-file.jsonl");
    await Promise.all(Array.from({ length: 20 }, () => withJournalLock(p, critical)));
    expect(maxActive).toBe(1); // serialized: never two at once

    // A rejecting section must not poison the chain — the next waiter still runs.
    let ranAfterReject = false;
    await Promise.allSettled([
      withJournalLock(p, async () => {
        throw new Error("boom");
      }),
      withJournalLock(p, async () => {
        ranAfterReject = true;
      }),
    ]);
    expect(ranAfterReject).toBe(true);

    // A different file is an independent lane — those CAN overlap.
    let active2 = 0;
    let maxOverlap = 0;
    const other = () => new Promise((r) => setTimeout(r, 5));
    const track = async () => {
      active2++;
      maxOverlap = Math.max(maxOverlap, active2);
      await other();
      active2--;
    };
    await Promise.all([
      withJournalLock(path.join(journalDir, "a.jsonl"), track),
      withJournalLock(path.join(journalDir, "b.jsonl"), track),
    ]);
    expect(maxOverlap).toBe(2); // distinct files don't block each other
  });
});

describe("undo", () => {
  it("reverts the file when content matches `after` (happy path)", async () => {
    fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
    writeWorkspaceFile(workspaceRoot, "src/app.css", ".card { color: blue; }\n");
    await appendJournal(cfg, baseEntry());

    const result = await undo(cfg, {});
    expect(result.skipped).toEqual([]);
    expect(result.reverted).toHaveLength(1);
    expect(readWorkspaceFile(workspaceRoot, "src/app.css")).toBe(".card { color: red; }\n");

    // the revert itself was journaled
    const entries = await readJournal(cfg);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.before).toBe(".card { color: blue; }\n");
    expect(entries[0]?.after).toBe(".card { color: red; }\n");
  });

  it("drift guard: refuses when the file changed since the write", async () => {
    fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
    writeWorkspaceFile(workspaceRoot, "src/app.css", ".card { color: GREEN; }\n"); // hand-edited
    await appendJournal(cfg, baseEntry());

    const result = await undo(cfg, {});
    expect(result.reverted).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/hand-edit/);
    expect(readWorkspaceFile(workspaceRoot, "src/app.css")).toBe(".card { color: GREEN; }\n");
  });

  it("undoes by explicit id vs most-recent", async () => {
    writeWorkspaceFile(workspaceRoot, "a.css", "A2\n");
    writeWorkspaceFile(workspaceRoot, "b.css", "B2\n");
    const first = await appendJournal(cfg, baseEntry({ file: "a.css", before: "A1\n", after: "A2\n" }));
    await appendJournal(cfg, baseEntry({ file: "b.css", before: "B1\n", after: "B2\n" }));

    // undo by explicit (older) id reverts a.css, leaves b.css untouched
    const result = await undo(cfg, { id: first.id });
    expect(result.reverted).toHaveLength(1);
    expect(result.reverted[0]?.file).toBe("a.css");
    expect(readWorkspaceFile(workspaceRoot, "a.css")).toBe("A1\n");
    expect(readWorkspaceFile(workspaceRoot, "b.css")).toBe("B2\n");
  });

  it("most-recent undo (no id) targets the last entry", async () => {
    writeWorkspaceFile(workspaceRoot, "a.css", "A2\n");
    writeWorkspaceFile(workspaceRoot, "b.css", "B2\n");
    await appendJournal(cfg, baseEntry({ file: "a.css", before: "A1\n", after: "A2\n" }));
    await appendJournal(cfg, baseEntry({ file: "b.css", before: "B1\n", after: "B2\n" }));

    const result = await undo(cfg, {});
    expect(result.reverted).toHaveLength(1);
    expect(result.reverted[0]?.file).toBe("b.css");
    expect(readWorkspaceFile(workspaceRoot, "b.css")).toBe("B1\n");
  });

  it("empty journal -> empty result, no throw", async () => {
    const result = await undo(cfg, {});
    expect(result).toEqual({ reverted: [], skipped: [] });
  });

  it("unknown explicit id -> skipped, no throw", async () => {
    await appendJournal(cfg, baseEntry());
    const result = await undo(cfg, { id: "does-not-exist" });
    expect(result.reverted).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "does-not-exist", file: "", reason: "no journal entry with that id" },
    ]);
  });
});

describe("redo", () => {
  // Seed a committed edit on disk + in the journal, then undo it — the shared
  // starting point for the redo cases (file at `before`, newest entry kind=undo).
  async function seedThenUndo() {
    const e = baseEntry({ file: "a.css" });
    writeWorkspaceFile(workspaceRoot, "a.css", e.after);
    await appendJournal(cfg, e);
    await undo(cfg, {});
    expect(readWorkspaceFile(workspaceRoot, "a.css")).toBe(e.before);
    return e;
  }

  it("re-applies the change the most-recent undo reverted", async () => {
    const e = await seedThenUndo();
    const result = await redo(cfg);
    expect(result.redone).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(readWorkspaceFile(workspaceRoot, "a.css")).toBe(e.after);
    // The redo is itself journaled as kind:"redo".
    expect((await readJournal(cfg, 1))[0]?.kind).toBe("redo");
  });

  it("is a no-op on an empty journal", async () => {
    const result = await redo(cfg);
    expect(result).toEqual({ redone: [], skipped: [] });
  });

  it("does nothing when the newest entry isn't an undo (a fresh edit shadows redo)", async () => {
    await seedThenUndo();
    // A brand-new sync write lands AFTER the undo — now there is nothing to redo.
    writeWorkspaceFile(workspaceRoot, "a.css", ".card { color: green; }\n");
    await appendJournal(
      cfg,
      baseEntry({ file: "a.css", before: ".card { color: red; }\n", after: ".card { color: green; }\n" }),
    );
    const result = await redo(cfg);
    expect(result.redone).toEqual([]);
    // File left untouched — the new edit stands.
    expect(readWorkspaceFile(workspaceRoot, "a.css")).toBe(".card { color: green; }\n");
  });

  it("round-trips undo -> redo -> undo, toggling the file", async () => {
    const e = await seedThenUndo(); // file == before
    await redo(cfg);
    expect(readWorkspaceFile(workspaceRoot, "a.css")).toBe(e.after);
    await undo(cfg, {}); // undo the redo
    expect(readWorkspaceFile(workspaceRoot, "a.css")).toBe(e.before);
  });

  it("refuses to redo over a hand-edit (drift guard)", async () => {
    await seedThenUndo();
    writeWorkspaceFile(workspaceRoot, "a.css", "/* touched by hand */\n");
    const result = await redo(cfg);
    expect(result.redone).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/hand-edit/);
    expect(readWorkspaceFile(workspaceRoot, "a.css")).toBe("/* touched by hand */\n");
  });
});
