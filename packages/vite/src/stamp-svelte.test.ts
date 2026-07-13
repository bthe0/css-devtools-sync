import { describe, expect, it } from "vitest";
import { sourceLocatorSveltePreprocess } from "./stamp-svelte.js";

const pre = sourceLocatorSveltePreprocess({ root: "/proj" });

function run(content: string, filename = "/proj/src/Card.svelte"): string {
  const out = pre.markup({ content, filename });
  return out?.code ?? content;
}

describe("sourceLocatorSveltePreprocess", () => {
  it("stamps a static element with a use: action carrying its relative file + source line", () => {
    const src = '<script>\n  let x = 1;\n</script>\n\n<article class="card">Hi</article>\n';
    const out = run(src);
    // Element is on line 5.
    expect(out).toContain(
      'use:__ds_srcloc={{dataSourceFile:"src/Card.svelte",dataSourceLine:5,dataSourceComponent:"Card"}}',
    );
    // action inserted right after the tag name, before existing attributes
    expect(out).toContain('<article use:__ds_srcloc=');
    expect(out).toContain('class="card"');
  });

  it("imports stampSrcLoc (aliased) into the existing instance script", () => {
    const src = "<script>\n  let x = 1;\n</script>\n<div>Hi</div>\n";
    const out = run(src);
    expect(out).toContain(
      'import { stampSrcLoc as __ds_srcloc } from "@dev-sync/babel-plugin-source-locator/runtime";',
    );
    // import lands inside the instance <script>, not the module script.
    const scriptBody = out.slice(out.indexOf("<script>") + "<script>".length, out.indexOf("</script>"));
    expect(scriptBody).toContain("stampSrcLoc as __ds_srcloc");
  });

  it("creates an instance <script> when the component has none", () => {
    const src = "<p>plain</p>\n";
    const out = run(src);
    expect(out).toMatch(/^<script>/);
    expect(out).toContain("stampSrcLoc as __ds_srcloc");
    expect(out).toContain("use:__ds_srcloc=");
  });

  it("stamps each element with its own distinct line number", () => {
    const src = "<script></script>\n<div>a</div>\n<div>b</div>\n<div>c</div>\n";
    const out = run(src);
    expect(out).toContain("dataSourceLine:2");
    expect(out).toContain("dataSourceLine:3");
    expect(out).toContain("dataSourceLine:4");
  });

  it("stamps elements nested inside {#if} / {#each} blocks", () => {
    const src = "<script></script>\n{#if show}\n  <span>x</span>\n{/if}\n";
    const out = run(src);
    expect(out).toContain("<span use:__ds_srcloc=");
    expect(out).toContain("dataSourceLine:3");
  });

  it("does NOT stamp component elements (use: is illegal on components)", () => {
    const src = "<script>\n  import Child from './Child.svelte';\n</script>\n<Child />\n<div>ok</div>\n";
    const out = run(src);
    // The component tag is untouched…
    expect(out).not.toContain("<Child use:");
    // …but the sibling static element is stamped.
    expect(out).toContain("<div use:__ds_srcloc=");
  });

  it("preserves line numbers of untouched lines (only same-line insertions)", () => {
    const src = "<script></script>\n<div>a</div>\n<div>b</div>\n";
    const out = run(src);
    // No newlines added to the template body → the two element lines stay 2 and 3.
    const outLines = out.split("\n");
    expect(outLines.some((l) => l.includes("<div use:") && l.includes("dataSourceLine:2"))).toBe(true);
    expect(outLines.some((l) => l.includes("<div use:") && l.includes("dataSourceLine:3"))).toBe(true);
  });

  it("returns undefined for a non-svelte filename", () => {
    expect(pre.markup({ content: "<div/>", filename: "/proj/x.js" })).toBeUndefined();
  });
});
