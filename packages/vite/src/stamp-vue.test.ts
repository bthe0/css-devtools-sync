import { describe, expect, it } from "vitest";
import { sourceLocatorVue } from "./stamp-vue.js";

const plugin = sourceLocatorVue({ root: "/proj" });

/** Invoke the plugin's `transform` hook the way Vite would (id = absolute .vue path). */
function run(code: string, id = "/proj/src/Card.vue"): string {
  const t = plugin.transform as (code: string, id: string) => { code: string } | undefined;
  const out = t.call({} as never, code, id);
  return out?.code ?? code;
}

describe("sourceLocatorVue", () => {
  it("stamps a static element with an :onVnodeMounted binding carrying its rel file + line", () => {
    const src = "<script setup>\nconst x = 1;\n</script>\n\n<template>\n  <article class=\"card\">Hi</article>\n</template>\n";
    const out = run(src);
    // <article> is on line 6.
    expect(out).toContain(
      `:onVnodeMounted='(__v)=>__ds_srcloc(__v.el,{dataSourceFile:"src/Card.vue",dataSourceLine:6,dataSourceComponent:"Card"})'`,
    );
    // Inserted right after the tag name, before existing attributes.
    expect(out).toContain('<article :onVnodeMounted=');
    expect(out).toContain('class="card"');
  });

  it("imports stampSrcLoc (aliased) into the existing <script setup>", () => {
    const src = "<script setup>\nconst x = 1;\n</script>\n<template><div>Hi</div></template>\n";
    const out = run(src);
    expect(out).toContain(
      'import { stampSrcLoc as __ds_srcloc } from "@dev-sync/babel-plugin-source-locator/runtime";',
    );
    // Import lands inside <script setup>, before user code.
    const scriptBody = out.slice(out.indexOf("<script setup>") + "<script setup>".length, out.indexOf("</script>"));
    expect(scriptBody).toContain("stampSrcLoc as __ds_srcloc");
    expect(scriptBody).toContain("const x = 1;");
  });

  it("creates a <script setup> when the component has none", () => {
    const src = "<template><p>plain</p></template>\n";
    const out = run(src);
    expect(out).toMatch(/^<script setup>/);
    expect(out).toContain("stampSrcLoc as __ds_srcloc");
    expect(out).toContain(":onVnodeMounted=");
  });

  it("stamps each element with its own distinct line number", () => {
    const src = "<template>\n  <div>a</div>\n  <div>b</div>\n  <div>c</div>\n</template>\n";
    const out = run(src);
    expect(out).toContain("dataSourceLine:2");
    expect(out).toContain("dataSourceLine:3");
    expect(out).toContain("dataSourceLine:4");
  });

  it("stamps elements nested inside v-if / v-for", () => {
    const src = '<template>\n  <ul>\n    <li v-for="i in list">{{ i }}</li>\n  </ul>\n</template>\n';
    const out = run(src);
    expect(out).toContain("<li :onVnodeMounted=");
    expect(out).toContain("<ul :onVnodeMounted=");
  });

  it("does NOT stamp component elements (only plain elements get a vnode hook here)", () => {
    const src =
      "<script setup>\nimport Child from './Child.vue';\n</script>\n<template>\n  <Child />\n  <div>ok</div>\n</template>\n";
    const out = run(src);
    expect(out).not.toContain("<Child :onVnodeMounted");
    expect(out).toContain("<div :onVnodeMounted=");
  });

  it("preserves line numbers of untouched lines (only same-line insertions)", () => {
    const src = "<template>\n  <div>a</div>\n  <div>b</div>\n</template>\n";
    const out = run(src);
    const lines = out.split("\n");
    expect(lines.some((l) => l.includes("<div :onVnodeMounted=") && l.includes("dataSourceLine:2"))).toBe(true);
    expect(lines.some((l) => l.includes("<div :onVnodeMounted=") && l.includes("dataSourceLine:3"))).toBe(true);
  });

  it("returns undefined-equivalent (unchanged) for a non-vue id", () => {
    expect(run("<div/>", "/proj/x.js")).toBe("<div/>");
  });

  it("ignores plugin-vue sub-block requests (?vue&type=…)", () => {
    const src = "<template><div>x</div></template>\n";
    expect(run(src, "/proj/src/Card.vue?vue&type=template")).toBe(src);
  });
});
