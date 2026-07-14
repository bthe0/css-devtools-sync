// apply-sfc-markup.test.ts — shared SFC markup tier (Phase 1).
//
// A static attr/text run in a .vue/.svelte/.astro template is byte-identical
// HTML, so one line-anchored byte-splice serves all three. These tests pin the
// pure string-in/string-out core (the byte-level truth) plus the apply.ts
// routing (SFC ext -> this tier; .tsx -> the JSX tier). Dynamic bindings and
// mixed/element children are refused with a clear reason, never corrupted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { CapturePayload, SetAttrChange, SetTextChange } from "@dev-sync/contract";
import type { Config } from "../src/config.js";
import { applyPayload } from "../src/apply.js";
import { applySfcMarkup } from "../src/apply-sfc-markup.js";
import { SkipChangeError } from "../src/errors.js";

// --------------------------------------------------------------------------
// Pure core — byte-level correctness
// --------------------------------------------------------------------------

function attrChange(line: number, attribute: string, value: string): SetAttrChange {
  return {
    op: "set-attr",
    element: { tagName: "article", classList: [], dataSourceFile: "src/Card.svelte", dataSourceLine: line },
    attribute,
    value,
  };
}

function textChange(line: number, newText: string, oldText?: string): SetTextChange {
  return {
    op: "set-text",
    element: { tagName: "h3", classList: [], dataSourceFile: "src/Card.svelte", dataSourceLine: line },
    newText,
    ...(oldText != null ? { oldText } : {}),
  };
}

describe("applySfcMarkup — set-attr", () => {
  it("replaces an existing quoted attribute value in place, byte-preserving the rest", () => {
    const src = '<article class="card" style="padding: 20px;">\n  <h3>Hi</h3>\n</article>\n';
    const out = applySfcMarkup(src, attrChange(1, "style", "padding: 24px;"));
    expect(out).toBe('<article class="card" style="padding: 24px;">\n  <h3>Hi</h3>\n</article>\n');
  });

  it("keeps the original quote character (single quotes stay single)", () => {
    const src = "<article style='padding: 20px;'>x</article>\n";
    const out = applySfcMarkup(src, attrChange(1, "style", "padding: 9px;"));
    expect(out).toBe("<article style='padding: 9px;'>x</article>\n");
  });

  it("inserts a new attribute right after the tag name when absent", () => {
    const src = '<article class="card">x</article>\n';
    const out = applySfcMarkup(src, attrChange(1, "style", "color: red;"));
    expect(out).toBe('<article style="color: red;" class="card">x</article>\n');
  });

  it("escapes double quotes in an inserted attribute value", () => {
    const src = "<article>x</article>\n";
    const out = applySfcMarkup(src, attrChange(1, "title", 'a "b" c'));
    expect(out).toBe('<article title="a &quot;b&quot; c">x</article>\n');
  });

  it("edits the element on the target line, not an earlier same-tag sibling", () => {
    const src = '<article style="padding: 1px;">a</article>\n<article style="padding: 2px;">b</article>\n';
    const out = applySfcMarkup(src, attrChange(2, "style", "padding: 9px;"));
    expect(out).toBe('<article style="padding: 1px;">a</article>\n<article style="padding: 9px;">b</article>\n');
  });

  it("refuses a Vue dynamic :style binding rather than corrupting it", () => {
    const src = '<article :style="dyn">x</article>\n';
    expect(() => applySfcMarkup(src, attrChange(1, "style", "padding: 9px;"))).toThrow(/dynamic binding/);
  });

  it("refuses a Svelte/Astro expression binding style={expr}", () => {
    const src = "<article style={dyn}>x</article>\n";
    expect(() => applySfcMarkup(src, attrChange(1, "style", "padding: 9px;"))).toThrow(/dynamic binding/);
  });

  it("refuses class edits (owned by the class-list tier)", () => {
    const src = '<article class="a">x</article>\n';
    expect(() => applySfcMarkup(src, attrChange(1, "class", "b"))).toThrow(/class-list tier/);
  });
});

describe("applySfcMarkup — remove-attr", () => {
  it("removes a quoted attribute with its leading whitespace", () => {
    const src = '<article class="card" style="padding: 20px;">x</article>\n';
    const out = applySfcMarkup(src, {
      op: "remove-attr",
      element: { tagName: "article", classList: [], dataSourceFile: "src/Card.svelte", dataSourceLine: 1 },
      attribute: "style",
    });
    expect(out).toBe('<article class="card">x</article>\n');
  });

  it("throws SkipChangeError when the attribute is absent", () => {
    const src = '<article class="card">x</article>\n';
    expect(() =>
      applySfcMarkup(src, {
        op: "remove-attr",
        element: { tagName: "article", classList: [], dataSourceFile: "src/Card.svelte", dataSourceLine: 1 },
        attribute: "style",
      }),
    ).toThrow(SkipChangeError);
  });
});

describe("applySfcMarkup — set-text", () => {
  it("replaces a text-only element's body, preserving surrounding whitespace", () => {
    const src = "<article>\n  <h3>Hi there</h3>\n</article>\n";
    const out = applySfcMarkup(src, textChange(2, "Bye"));
    expect(out).toBe("<article>\n  <h3>Bye</h3>\n</article>\n");
  });

  it("honors the oldText drift guard — refuses when source moved on", () => {
    const src = "<h3>Current</h3>\n";
    expect(() => applySfcMarkup(src, textChange(1, "New", "Stale"))).toThrow(/drifted/);
  });

  it("applies when oldText matches", () => {
    const src = "<h3>Same</h3>\n";
    expect(applySfcMarkup(src, textChange(1, "New", "Same"))).toBe("<h3>New</h3>\n");
  });

  it("escapes < and & in the new text", () => {
    const src = "<h3>x</h3>\n";
    expect(applySfcMarkup(src, textChange(1, "a < b & c"))).toBe("<h3>a &lt; b &amp; c</h3>\n");
  });

  it("refuses an element whose children include a nested tag", () => {
    const src = "<h3>Hi <b>bold</b></h3>\n";
    expect(() => applySfcMarkup(src, textChange(1, "X"))).toThrow(/non-text or dynamic/);
  });

  it("refuses an element whose body contains an {expression}", () => {
    const src = "<h3>{title}</h3>\n";
    expect(() => applySfcMarkup(src, textChange(1, "X"))).toThrow(/non-text or dynamic/);
  });

  it("refuses a void element", () => {
    const src = '<input value="x" />\n';
    expect(() =>
      applySfcMarkup(src, {
        op: "set-text",
        element: { tagName: "input", classList: [], dataSourceFile: "src/Card.svelte", dataSourceLine: 1 },
        newText: "y",
      }),
    ).toThrow(/no text content/);
  });
});

// --------------------------------------------------------------------------
// Line-offset safety — CRLF endings + multibyte/emoji content
//
// lineOffsets splits on "\n" only and every offset is a UTF-16 code-unit index
// (slice/indexOf), so a lone "\r" rides inside its line as inert whitespace and
// emoji/CJK never shift a splice. These pin that: a byte-offset regression or a
// CRLF-eager split would corrupt the surrounding source.
// --------------------------------------------------------------------------

describe("applySfcMarkup — CRLF + multibyte offset safety", () => {
  it("edits the target line on a CRLF file, preserving \\r\\n endings", () => {
    const src = '<article style="p: 1px;">a</article>\r\n<article style="p: 2px;">b</article>\r\n';
    const out = applySfcMarkup(src, attrChange(2, "style", "p: 9px;"));
    expect(out).toBe('<article style="p: 1px;">a</article>\r\n<article style="p: 9px;">b</article>\r\n');
  });

  it("locates the right line when earlier lines carry emoji/CJK (UTF-16 offsets, not bytes)", () => {
    const src = '<h3>café · 🎉 · 世界</h3>\n<article style="p: 1px;">x</article>\n';
    const out = applySfcMarkup(src, attrChange(2, "style", "p: 9px;"));
    expect(out).toBe('<h3>café · 🎉 · 世界</h3>\n<article style="p: 9px;">x</article>\n');
  });

  it("round-trips emoji/multibyte text through set-text without mangling code units", () => {
    const src = "<h3>old</h3>\n";
    const out = applySfcMarkup(src, textChange(1, "café 🎉 世界"));
    expect(out).toBe("<h3>café 🎉 世界</h3>\n");
  });
});

// --------------------------------------------------------------------------
// Security & fidelity — the trust boundary (Phase A1 hardening)
// --------------------------------------------------------------------------

describe("applySfcMarkup — attribute-name trust boundary", () => {
  it("refuses an attribute name carrying an injected handler rather than splicing it raw", () => {
    // Contract only bounds length; a crafted name would inject markup on insert.
    const src = "<article>x</article>\n";
    expect(() =>
      applySfcMarkup(src, attrChange(1, 'x onload="fetch(`/steal`)" y', "v")),
    ).toThrow(/attribute name/i);
  });

  it("refuses a malformed attribute name on remove-attr too", () => {
    const src = '<article style="p">x</article>\n';
    expect(() =>
      applySfcMarkup(src, {
        op: "remove-attr",
        element: { tagName: "article", classList: [], dataSourceFile: "src/Card.svelte", dataSourceLine: 1 },
        attribute: "style onmouseover=alert(1)",
      }),
    ).toThrow(/attribute name/i);
  });

  it("still accepts a legitimate namespaced/dotted attribute name", () => {
    const src = "<article>x</article>\n";
    const out = applySfcMarkup(src, attrChange(1, "data-x.y:z", "1"));
    expect(out).toBe('<article data-x.y:z="1">x</article>\n');
  });
});

describe("applySfcMarkup — interpolation injection", () => {
  it("neutralizes a Svelte/Astro {expr} injected via set-text (no live interpolation reaches source)", () => {
    const src = "<h3>x</h3>\n";
    const out = applySfcMarkup(src, textChange(1, "{constructor.constructor('x')()}"));
    expect(out).not.toContain("{constructor");
    expect(out).toContain("&lbrace;");
  });

  it("neutralizes a Vue {{ }} mustache injected via set-text", () => {
    const src = "<h3>x</h3>\n";
    const out = applySfcMarkup(src, textChange(1, "{{ evil }}"));
    expect(out).not.toContain("{{");
  });

  it("neutralizes a brace injected via an inserted attribute value", () => {
    const src = "<article>x</article>\n";
    const out = applySfcMarkup(src, attrChange(1, "title", "a{evil}b"));
    expect(out).not.toContain("{evil}");
    expect(out).toContain("&lbrace;");
  });
});

describe("applySfcMarkup — brace-aware open-tag scan", () => {
  it("does not mis-terminate the tag on a '>' inside a {arrow => expr} attribute", () => {
    // The '>' in `a > b` sits inside a Svelte expression attribute; a quote-only
    // scanner would end the tag there and splice into the expression.
    const src = "<button on:click={() => go(a > b)}>Go</button>\n";
    const out = applySfcMarkup(src, {
      op: "set-text",
      element: { tagName: "button", classList: [], dataSourceFile: "src/Card.svelte", dataSourceLine: 1 },
      newText: "Stop",
    });
    expect(out).toBe("<button on:click={() => go(a > b)}>Stop</button>\n");
  });
});

describe("applySfcMarkup — tag-name identity", () => {
  it("skips a false '<x' match earlier on the line and edits the element whose tag matches", () => {
    // `i<n` yields a spurious `<n` that a first-match locator would try to edit.
    const src = '{#if i<n}<article style="p: 1px;">x</article>{/if}\n';
    const out = applySfcMarkup(src, attrChange(1, "style", "p: 9px;"));
    expect(out).toBe('{#if i<n}<article style="p: 9px;">x</article>{/if}\n');
  });

  it("refuses when no element on the line matches the recorded tag name", () => {
    const src = "<section>x</section>\n";
    expect(() => applySfcMarkup(src, attrChange(1, "style", "p: 9px;"))).toThrow(
      /tag|drift/i,
    );
  });
});

describe("applySfcMarkup — dynamic value guards", () => {
  it("refuses to overwrite an existing attribute value that carries {interpolation}", () => {
    const src = '<article style="color: {c}">x</article>\n';
    expect(() => applySfcMarkup(src, attrChange(1, "style", "color: red;"))).toThrow(
      /dynamic|interpolat/i,
    );
  });

  it("refuses to insert an attribute already present as a shorthand {attr}", () => {
    const src = "<article {style}>x</article>\n";
    expect(() => applySfcMarkup(src, attrChange(1, "style", "color: red;"))).toThrow(
      /shorthand|dynamic/i,
    );
  });

  it("refuses to insert onto an element carrying a {...spread}", () => {
    const src = "<article {...props}>x</article>\n";
    expect(() => applySfcMarkup(src, attrChange(1, "title", "hi"))).toThrow(
      /spread|dynamic/i,
    );
  });
});

// --------------------------------------------------------------------------
// Integration — apply.ts routing across the three SFC extensions
// --------------------------------------------------------------------------

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const noopLog = {
  error() {},
  info() {},
  warn() {},
  debug() {},
  child() {
    return noopLog;
  },
} as unknown as FastifyBaseLogger;

function makeWorkspace(rel: string, content: string): { root: string; abs: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cssync-sfc-markup-")));
  tmpDirs.push(root);
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return { root, abs };
}

function makeCfg(root: string): Config {
  return {
    workspaceRoot: root,
    port: 0,
    appEnv: "test",
    anthropicApiKey: undefined,
    extensionId: undefined,
    syncToken: undefined,
    overridesFile: "src/index.css",
    journalDir: path.join(root, ".dev-sync-journal"),
  };
}

async function preview(root: string, changes: (SetAttrChange | SetTextChange)[]) {
  const payload = { url: "http://localhost:5173/", changes } as unknown as CapturePayload;
  return applyPayload(payload, makeCfg(root), noopLog);
}

describe("apply.ts SFC markup routing", () => {
  const CASES: Array<{ ext: string; rel: string; src: string; line: number }> = [
    {
      ext: ".vue",
      rel: "src/Card.vue",
      src: '<template>\n  <article class="card" style="padding: 20px;">\n    <h3 class="title">Hi</h3>\n  </article>\n</template>\n',
      line: 2,
    },
    {
      ext: ".svelte",
      rel: "src/Card.svelte",
      src: '<article class="card" style="padding: 20px;">\n  <h3 class="title">Hi</h3>\n</article>\n',
      line: 1,
    },
    {
      ext: ".astro",
      rel: "src/Card.astro",
      src: '---\nconst x = 1;\n---\n<article class="card" style="padding: 20px;">\n  <h3 class="title">Hi</h3>\n</article>\n',
      line: 4,
    },
  ];

  for (const { ext, rel, src, line } of CASES) {
    it(`applies a set-attr on a ${ext} element (preview never writes)`, async () => {
      const { root, abs } = makeWorkspace(rel, src);
      const result = await preview(root, [
        {
          op: "set-attr",
          element: { tagName: "article", classList: ["card"], dataSourceFile: rel, dataSourceLine: line },
          attribute: "style",
          value: "padding: 24px;",
        },
      ]);
      expect(result.skipped).toHaveLength(0);
      expect(result.applied).toHaveLength(1);
      // preview mode never writes to disk.
      expect(fs.readFileSync(abs, "utf8")).toBe(src);
    });
  }

  it("routes a .tsx element to the JSX tier, NOT the SFC tier", async () => {
    // A .tsx set-attr on a non-existent line skips for the JSX tier's reason
    // ("no JSX element found"), proving the SFC tier didn't intercept it.
    const { root } = makeWorkspace(
      "src/Card.tsx",
      'export const Card = () => <article className="card">Hi</article>;\n',
    );
    const result = await preview(root, [
      {
        op: "set-attr",
        element: { tagName: "article", classList: ["card"], dataSourceFile: "src/Card.tsx", dataSourceLine: 99 },
        attribute: "title",
        value: "x",
      },
    ]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/no JSX element found/i);
  });
});
