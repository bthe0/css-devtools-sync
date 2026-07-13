import { describe, expect, it } from "vitest";
import type { StyleSheetRef } from "@dev-sync/contract";
import {
  applySfcChange,
  extractStyleBlocks,
  stripScopedAttr,
} from "../src/apply-sfc.js";
import { SkipChangeError } from "../src/errors.js";

const SHEET: StyleSheetRef = {
  id: "s1",
  sourceURL: "",
  sourceMapURL: "data:application/json;charset=utf-8;base64,e30=",
  origin: "regular",
};

describe("stripScopedAttr", () => {
  it("strips a trailing Vue data-v scoped attribute", () => {
    expect(stripScopedAttr(".card[data-v-c7059591]")).toBe(".card");
  });

  it("strips a data-v attribute embedded before other selector text", () => {
    expect(stripScopedAttr(".card[data-v-abc123] > .title")).toBe(".card > .title");
  });

  it("strips a svelte scoping class suffix", () => {
    expect(stripScopedAttr(".card.svelte-1a2b3c")).toBe(".card");
  });

  it("passes plain selectors through unchanged", () => {
    expect(stripScopedAttr(".card")).toBe(".card");
    expect(stripScopedAttr(".card .title")).toBe(".card .title");
  });
});

describe("extractStyleBlocks", () => {
  it("extracts a single plain <style> block with exact byte range", () => {
    const sfc = "<template>\n  <div/>\n</template>\n\n<style>\n.card {\n  padding: 1px;\n}\n</style>\n";
    const blocks = extractStyleBlocks(sfc);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.lang).toBe("css");
    expect(b.module).toBe(false);
    expect(b.scoped).toBe(false);
    expect(sfc.slice(b.innerStart, b.innerEnd)).toBe(b.css);
    expect(b.css).toContain(".card {");
  });

  it("extracts multiple <style> blocks", () => {
    const sfc = [
      "<template><div/></template>",
      "<style>",
      ".a { color: red; }",
      "</style>",
      "<style scoped>",
      ".b { color: blue; }",
      "</style>",
    ].join("\n");
    const blocks = extractStyleBlocks(sfc);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.scoped).toBe(false);
    expect(blocks[0]!.css).toContain(".a");
    expect(blocks[1]!.scoped).toBe(true);
    expect(blocks[1]!.css).toContain(".b");
  });

  it("parses lang=\"scss\" and lang='sass' attrs into lang:'scss'", () => {
    const sfc1 = '<style lang="scss">.a { color: red; }</style>';
    const sfc2 = "<style lang='sass'>.a\n  color: red</style>";
    expect(extractStyleBlocks(sfc1)[0]!.lang).toBe("scss");
    expect(extractStyleBlocks(sfc2)[0]!.lang).toBe("scss");
  });

  it("detects module attr", () => {
    const sfc = "<style module>.card { color: red; }</style>";
    const blocks = extractStyleBlocks(sfc);
    expect(blocks[0]!.module).toBe(true);
  });

  it("returns [] when there is no <style> block", () => {
    expect(extractStyleBlocks("<template><div/></template>")).toEqual([]);
  });
});

describe("applySfcChange", () => {
  const scopedSfc = [
    '<script setup lang="ts">',
    "defineProps<{ title: string }>();",
    "</script>",
    "",
    "<template>",
    '  <article class="card">',
    '    <h3 class="card-title">{{ title }}</h3>',
    "  </article>",
    "</template>",
    "",
    "<style scoped>",
    ".card {",
    "  padding: 20px;",
    "  border-radius: 8px;",
    "}",
    "",
    ".card-title {",
    "  color: #2563eb;",
    "}",
    "</style>",
    "",
  ].join("\n");

  it("modifies only the target rule inside the <style scoped> block; template/script are byte-identical", () => {
    const { css } = applySfcChange(
      scopedSfc,
      {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card[data-v-c7059591]",
        property: "padding",
        oldValue: "20px",
        newValue: "24px",
      },
      {},
    );

    expect(css).toContain("padding: 24px;");
    expect(css).not.toContain("padding: 20px;");
    // sibling rule untouched
    expect(css).toContain("color: #2563eb;");

    // template + script sections are byte-identical
    const scriptBefore = scopedSfc.slice(0, scopedSfc.indexOf("<style"));
    const scriptAfter = css.slice(0, css.indexOf("<style"));
    expect(scriptAfter).toBe(scriptBefore);
    const afterStyleBefore = scopedSfc.slice(scopedSfc.indexOf("</style>"));
    const afterStyleAfter = css.slice(css.indexOf("</style>"));
    expect(afterStyleAfter).toBe(afterStyleBefore);
  });

  it("picks the correct block among multiple <style> blocks by matching selector", () => {
    const multi = [
      "<template><div/></template>",
      "<style>",
      ".a { color: red; }",
      "</style>",
      "<style scoped>",
      ".card[data-v-xyz] { padding: 1px; }",
      "</style>",
    ].join("\n");

    const { css } = applySfcChange(
      multi,
      {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card[data-v-xyz]",
        property: "padding",
        oldValue: "1px",
        newValue: "2px",
      },
      {},
    );
    expect(css).toContain("padding: 2px;");
    expect(css).toContain(".a { color: red; }"); // untouched first block
  });

  it("handles a lang=\"scss\" style block", () => {
    const sfc = [
      "<template><div/></template>",
      '<style lang="scss" scoped>',
      ".card[data-v-x] {",
      "  padding: 1px;",
      "  &:hover { padding: 2px; }",
      "}",
      "</style>",
    ].join("\n");

    const { css } = applySfcChange(
      sfc,
      {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card[data-v-x]",
        property: "padding",
        oldValue: "1px",
        newValue: "9px",
      },
      {},
    );
    expect(css).toContain("padding: 9px;");
  });

  it("uses opts.position (block-relative line) when the selector name isn't found in any block", () => {
    const sfc = [
      "<template><div/></template>", // line 1
      "<style scoped>", // line 2
      ".card_hashed {", // line 3
      "  padding: 1px;", // line 4
      "}", // line 5
      "</style>", // line 6
    ].join("\n");

    const { css } = applySfcChange(
      sfc,
      {
        op: "modify",
        styleSheet: SHEET,
        selector: ".totally-unrelated-hash",
        property: "padding",
        oldValue: "1px",
        newValue: "5px",
      },
      { position: { line: 4, column: 2 } },
    );
    expect(css).toContain("padding: 5px;");
  });

  it("throws SkipChangeError when no block matches the selector and no position hint resolves one", () => {
    const sfc = [
      "<template><div/></template>",
      "<style scoped>",
      ".card { padding: 1px; }",
      "</style>",
    ].join("\n");

    expect(() =>
      applySfcChange(
        sfc,
        {
          op: "modify",
          styleSheet: SHEET,
          selector: ".does-not-exist",
          property: "padding",
          oldValue: "1px",
          newValue: "2px",
        },
        {},
      ),
    ).toThrow(SkipChangeError);
  });

  it("throws SkipChangeError (ambiguous) when the selector matches >1 block and no position disambiguates", () => {
    const multi = [
      "<template><div/></template>",
      "<style>",
      ".card { padding: 1px; }",
      "</style>",
      "<style scoped>",
      ".card { padding: 2px; }",
      "</style>",
    ].join("\n");

    expect(() =>
      applySfcChange(
        multi,
        {
          op: "modify",
          styleSheet: SHEET,
          selector: ".card",
          property: "padding",
          oldValue: "1px",
          newValue: "9px",
        },
        {},
      ),
    ).toThrow(/appears in 2 <style> blocks/);
  });

  it("still resolves an ambiguous selector when a position hint points at one block", () => {
    const multi = [
      "<template><div/></template>", // line 1
      "<style>", // line 2
      ".card { padding: 1px; }", // line 3
      "</style>", // line 4
      "<style scoped>", // line 5
      ".card { padding: 2px; }", // line 6
      "</style>", // line 7
    ].join("\n");

    const { css } = applySfcChange(
      multi,
      {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card",
        property: "padding",
        oldValue: "2px",
        newValue: "9px",
      },
      { position: { line: 6, column: 0 } },
    );
    expect(css).toContain("padding: 9px;");
    expect(css).toContain(".card { padding: 1px; }"); // first block untouched
  });

  it("throws SkipChangeError when the sfc has no <style> block at all", () => {
    expect(() =>
      applySfcChange(
        "<template><div/></template>",
        {
          op: "modify",
          styleSheet: SHEET,
          selector: ".card",
          property: "padding",
          oldValue: "1px",
          newValue: "2px",
        },
        {},
      ),
    ).toThrow(SkipChangeError);
  });
});
