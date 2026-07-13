import { describe, expect, it } from "vitest";
import { sourceLocatorAstro } from "./stamp-astro.js";

const plugin = sourceLocatorAstro({ root: "/proj" });

/** Invoke the plugin's `transform` hook the way Vite would (id = absolute .astro path). */
function run(code: string, id = "/proj/src/components/Card.astro"): string {
  const t = plugin.transform as (code: string, id: string) => { code: string } | undefined;
  const out = t.call({} as never, code, id);
  return out?.code ?? code;
}

const COMPONENT = "/proj/src/components/Card.astro";
const PAGE = "/proj/src/pages/index.astro";

describe("sourceLocatorAstro", () => {
  it("stamps a static element with data-devloc carrying its rel file + line", () => {
    const src = "---\nconst x = 1;\n---\n<div class=\"card\">Hi</div>\n";
    const out = run(src);
    // <div> is on line 4.
    expect(out).toContain('<div data-devloc="src/components/Card.astro:4" class="card">');
  });

  it("inserts the marker immediately after the tag name, before existing attributes", () => {
    const src = "<article class=\"card\" id=\"a\">x</article>\n";
    const out = run(src);
    expect(out).toContain('<article data-devloc="src/components/Card.astro:1" class="card" id="a">');
  });

  it("stamps each element with its own distinct line number", () => {
    const src = "<div>a</div>\n<div>b</div>\n<div>c</div>\n";
    const out = run(src);
    expect(out).toContain("src/components/Card.astro:1");
    expect(out).toContain("src/components/Card.astro:2");
    expect(out).toContain("src/components/Card.astro:3");
  });

  it("does NOT stamp component elements (capitalized tags)", () => {
    const src = "---\nimport Card from '../components/Card.astro';\n---\n<Card title=\"x\" />\n<div>ok</div>\n";
    const out = run(src);
    expect(out).not.toContain("<Card data-devloc");
    expect(out).toContain("<div data-devloc=");
  });

  it("recurses INTO a component's children so slotted host elements get stamped", () => {
    const src = "<Card>\n  <p>slotted</p>\n</Card>\n";
    const out = run(src);
    expect(out).not.toContain("<Card data-devloc");
    expect(out).toContain('<p data-devloc="src/components/Card.astro:2">');
  });

  it("does NOT stamp non-visual tags (html/head/title/meta/style/script/slot)", () => {
    const src = "<html>\n<head><title>t</title><meta charset=\"utf-8\" /></head>\n<slot />\n<style>.a{}</style>\n</html>\n";
    const out = run(src);
    expect(out).not.toContain("data-devloc");
  });

  it("appends the client harvest script for page files (src/pages/**)", () => {
    const src = "<div>x</div>\n";
    const out = run(src, PAGE);
    expect(out).toContain('import { stampSrcLoc as __ds_srcloc } from "@dev-sync/babel-plugin-source-locator/runtime";');
    expect(out).toContain('document.querySelectorAll("[data-devloc]")');
    expect(out).toContain("removeAttribute");
    // The page's own element is still stamped.
    expect(out).toContain('<div data-devloc="src/pages/index.astro:1">');
  });

  it("does NOT append the harvest script for non-page component files", () => {
    const src = "<div>x</div>\n";
    const out = run(src, COMPONENT);
    expect(out).not.toContain("stampSrcLoc as __ds_srcloc");
    expect(out).not.toContain("querySelectorAll");
  });

  it("emits the harvest script for a page even when it has no stampable element of its own", () => {
    const src = "---\nimport Card from '../components/Card.astro';\n---\n<Card title=\"x\" />\n";
    const out = run(src, PAGE);
    expect(out).not.toContain("<Card data-devloc");
    expect(out).toContain("stampSrcLoc as __ds_srcloc");
  });

  it("preserves line numbers of untouched lines (only same-line insertions)", () => {
    const src = "<div>a</div>\n<div>b</div>\n";
    const out = run(src, COMPONENT);
    const lines = out.split("\n");
    expect(lines[0]).toContain('data-devloc="src/components/Card.astro:1"');
    expect(lines[1]).toContain('data-devloc="src/components/Card.astro:2"');
  });

  it("returns unchanged for a non-astro id", () => {
    expect(run("<div/>", "/proj/x.js")).toBe("<div/>");
  });

  it("ignores astro sub-block requests (?astro&type=…)", () => {
    const src = "<div>x</div>\n";
    expect(run(src, "/proj/src/components/Card.astro?astro&type=style")).toBe(src);
  });
});
