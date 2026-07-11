import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import postcssScss from "postcss-scss";
import { describe, expect, it } from "vitest";
import type { StyleSheetRef } from "@css-sync/contract";
import { applyCssChange } from "../src/apply-css.js";
import { SkipChangeError } from "../src/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sheet: StyleSheetRef = {
  id: "sheet-1",
  sourceURL: "http://localhost:5173/styles/app.css",
  origin: "regular",
};

const FIXTURE = `.card {
  color: red;
  margin-top: 8px;
}

.btn {
  padding: 4px;
}

@media (min-width: 640px) {
  .card {
    margin-top: 12px;
  }
}

@media (min-width: 1024px) {
  .card {
    margin-top: 16px;
  }
}
`;

describe("applyCssChange — real .scss file with // line comments (postcss-scss syntax)", () => {
  const scssSource = fs.readFileSync(
    path.join(__dirname, "fixtures", "sample.scss"),
    "utf8",
  );

  it("vanilla postcss.parse (the pre-fix behavior) actually fails to parse this fixture", () => {
    // Sanity check that this fixture reproduces the real bug: a `//` line
    // comment outside url() is invalid CSS to the plain postcss parser.
    expect(() => postcss.parse(scssSource)).toThrow();
  });

  it("applies a modify change and produces correct, reparseable SCSS (// comments preserved)", () => {
    const res = applyCssChange(
      scssSource,
      {
        op: "modify",
        styleSheet: sheet,
        selector: ".card",
        property: "color",
        oldValue: "red",
        newValue: "blue",
      },
      { syntax: "scss" },
    );
    expect(res.css).toContain("color: blue;");
    expect(res.css).not.toContain("color: red;");
    // // comments must survive untouched, not be mangled into /* */ or dropped
    expect(res.css).toContain("// inline comment right after a declaration");
    expect(res.css).toContain("// comment sitting alone between declarations");
    expect(res.css).toContain("// comment between top-level rules");
    // CORE INVARIANT: the written text must re-parse with the same syntax
    expect(() => postcssScss.parse(res.css)).not.toThrow();
  });

  it("applies an add-decl change to the .scss fixture and re-parses cleanly", () => {
    const res = applyCssChange(
      scssSource,
      {
        op: "add-decl",
        styleSheet: sheet,
        selector: ".btn",
        property: "cursor",
        newValue: "pointer",
      },
      { syntax: "scss" },
    );
    expect(res.css).toMatch(/\.btn \{[^}]*cursor: pointer/);
    expect(() => postcssScss.parse(res.css)).not.toThrow();
  });

  it("throws SkipChangeError instead of writing when the .scss source itself fails to parse", () => {
    const brokenScss = ".card { color: red;"; // unterminated block
    expect(() =>
      applyCssChange(
        brokenScss,
        {
          op: "modify",
          styleSheet: sheet,
          selector: ".card",
          property: "color",
          oldValue: "red",
          newValue: "blue",
        },
        { syntax: "scss" },
      ),
    ).toThrow(SkipChangeError);
  });
});

describe("applyCssChange — modify", () => {
  it("sets the declaration value at the resolved rule", () => {
    const res = applyCssChange(FIXTURE, {
      op: "modify",
      styleSheet: sheet,
      selector: ".card",
      property: "color",
      oldValue: "red",
      newValue: "blue",
    });
    expect(res.css).toContain("color: blue;");
    expect(res.css).not.toContain("color: red;");
    expect(res.line).toBe(2);
  });

  it("targets the rule inside the matching @media block", () => {
    const res = applyCssChange(FIXTURE, {
      op: "modify",
      styleSheet: sheet,
      selector: ".card",
      mediaText: "(min-width: 640px)",
      property: "margin-top",
      oldValue: "12px",
      newValue: "20px",
    });
    // base rule untouched, 640px block changed, 1024px block untouched
    expect(res.css).toContain("margin-top: 8px;");
    expect(res.css).toContain("margin-top: 20px;");
    expect(res.css).toContain("margin-top: 16px;");
    expect(res.css).not.toContain("margin-top: 12px;");
  });

  it("handles !important in the new value", () => {
    const res = applyCssChange(FIXTURE, {
      op: "modify",
      styleSheet: sheet,
      selector: ".card",
      property: "color",
      oldValue: "red",
      newValue: "blue !important",
    });
    expect(res.css).toContain("color: blue !important;");
  });

  it("throws SkipChangeError for an unknown selector (skip, not 500)", () => {
    expect(() =>
      applyCssChange(FIXTURE, {
        op: "modify",
        styleSheet: sheet,
        selector: ".does-not-exist",
        property: "color",
        oldValue: "red",
        newValue: "blue",
      }),
    ).toThrow(SkipChangeError);
  });

  it("throws SkipChangeError for a missing declaration", () => {
    expect(() =>
      applyCssChange(FIXTURE, {
        op: "modify",
        styleSheet: sheet,
        selector: ".btn",
        property: "z-index",
        oldValue: "1",
        newValue: "2",
      }),
    ).toThrow(SkipChangeError);
  });
});

describe("applyCssChange — add-decl / delete-decl", () => {
  it("appends a new declaration to an existing rule", () => {
    const res = applyCssChange(FIXTURE, {
      op: "add-decl",
      styleSheet: sheet,
      selector: ".btn",
      property: "cursor",
      newValue: "pointer",
    });
    expect(res.css).toMatch(/\.btn \{[^}]*cursor: pointer/);
  });

  it("removes a declaration from the base rule only", () => {
    const res = applyCssChange(FIXTURE, {
      op: "delete-decl",
      styleSheet: sheet,
      selector: ".card",
      property: "margin-top",
    });
    const baseBlock = res.css.slice(0, res.css.indexOf("@media"));
    expect(baseBlock).not.toContain("margin-top");
    // the @media copies survive
    expect(res.css).toContain("margin-top: 12px;");
    expect(res.css).toContain("margin-top: 16px;");
  });

  it("removes a declaration from the matching @media copy only (mediaText disambiguates)", () => {
    const res = applyCssChange(FIXTURE, {
      op: "delete-decl",
      styleSheet: sheet,
      selector: ".card",
      mediaText: "(min-width: 640px)",
      property: "margin-top",
    });
    // base + the OTHER @media copy survive; only the 640px copy is gone
    const baseBlock = res.css.slice(0, res.css.indexOf("@media"));
    expect(baseBlock).toContain("margin-top: 8px;");
    expect(res.css).not.toContain("margin-top: 12px;");
    expect(res.css).toContain("margin-top: 16px;");
  });

  // -------------------------------------------------------------------------
  // Edge case: delete-decl removes the LAST remaining declaration in a rule.
  // Decision: leave a valid, EMPTY rule behind rather than removing the rule
  // itself — consistent with delete-decl's structural invariant everywhere
  // else (ruleCountDelta is always 0; only declCountDelta ever changes).
  // Removing the rule too would require delete-decl to also thread a
  // conditional ruleCountDelta through the shared fidelity re-verification,
  // for a purely cosmetic gain (an empty rule is harmless, valid CSS).
  // -------------------------------------------------------------------------
  it("removing the ONLY declaration in a rule leaves a valid EMPTY rule behind, not a removed rule", () => {
    const singleDeclFixture = `.only {\n  color: red;\n}\n\n.sibling {\n  color: blue;\n}\n`;
    const res = applyCssChange(singleDeclFixture, {
      op: "delete-decl",
      styleSheet: sheet,
      selector: ".only",
      property: "color",
    });
    // the rule survives, now empty
    expect(res.css).toMatch(/\.only \{\s*\}/);
    // the sibling rule is completely untouched
    expect(res.css).toContain(".sibling {\n  color: blue;\n}");
    // total rule count is unchanged (2 rules before, 2 after)
    const root = postcss.parse(res.css);
    let ruleCount = 0;
    root.walkRules(() => {
      ruleCount++;
    });
    expect(ruleCount).toBe(2);
    // and it re-parses cleanly, re-applying delete-decl to the now-empty
    // rule (idempotency / "nothing left to delete") skips cleanly
    expect(() =>
      applyCssChange(res.css, {
        op: "delete-decl",
        styleSheet: sheet,
        selector: ".only",
        property: "color",
      }),
    ).toThrow(SkipChangeError);
  });
});

// ---------------------------------------------------------------------------
// Nitpick: whitespace-only CSS values normalize to empty DELIBERATELY.
// normalizeDeclValue trims the raw value before storing it, so an all-
// whitespace newValue is not rejected — it's treated the same as an
// explicit empty value. Documented here so the behavior is a decision, not
// an accident.
// ---------------------------------------------------------------------------
describe("applyCssChange — normalizeDeclValue: whitespace-only values normalize to empty (documented, deliberate)", () => {
  it("a modify with an all-whitespace newValue is normalized to an EMPTY declaration value, not rejected", () => {
    const res = applyCssChange(FIXTURE, {
      op: "modify",
      styleSheet: sheet,
      selector: ".card",
      property: "color",
      oldValue: "red",
      newValue: "   ",
    });
    expect(res.css).not.toContain("color: red;");
    // the declaration survives with an EMPTY value — trimmed, not rejected
    const root = postcss.parse(res.css);
    let value: string | undefined;
    root.walkRules(".card", (rule) => {
      rule.walkDecls("color", (decl) => {
        value = decl.value;
      });
    });
    expect(value).toBe("");
  });

  it("add-decl with an all-whitespace newValue also normalizes to empty, not rejected or skipped", () => {
    const res = applyCssChange(FIXTURE, {
      op: "add-decl",
      styleSheet: sheet,
      selector: ".btn",
      property: "content",
      newValue: "\t \t",
    });
    const root = postcss.parse(res.css);
    let value: string | undefined;
    root.walkRules(".btn", (rule) => {
      rule.walkDecls("content", (decl) => {
        value = decl.value;
      });
    });
    expect(value).toBe("");
  });
});

describe("applyCssChange — add-rule with @media placement", () => {
  it("appends into an EXISTING matching @media block (no duplicate block)", () => {
    const res = applyCssChange(FIXTURE, {
      op: "add-rule",
      styleSheet: sheet,
      selector: ".btn",
      mediaText: "(min-width: 640px)",
      ruleText: ".btn { padding: 8px; }",
    });
    expect(res.css.match(/min-width: 640px/g)?.length).toBe(1);
    const start640 = res.css.indexOf("(min-width: 640px)");
    const start1024 = res.css.indexOf("(min-width: 1024px)");
    const btnInMedia = res.css.indexOf(".btn", start640);
    expect(btnInMedia).toBeGreaterThan(start640);
    expect(btnInMedia).toBeLessThan(start1024);
    expect(res.css).toContain("padding: 8px");
  });

  it("creates the FIRST @media block ever in a file that has none (no existing breakpoints to order against)", () => {
    const noMediaFixture = `.card {\n  color: red;\n}\n\n.btn {\n  padding: 4px;\n}\n`;
    const res = applyCssChange(noMediaFixture, {
      op: "add-rule",
      styleSheet: sheet,
      selector: ".card",
      mediaText: "(min-width: 768px)",
      ruleText: ".card { padding: 32px; }",
    });
    expect(res.css.match(/@media/g)?.length).toBe(1);
    expect(res.css).toMatch(/@media \(min-width: 768px\)\s*\{\s*\.card\s*\{\s*padding: 32px;/);
    // the original rules are untouched, and the new block is appended after them
    expect(res.css.indexOf(".card {")).toBeLessThan(res.css.indexOf("@media"));
    expect(res.css).toContain("color: red;");
    expect(res.css).toContain("padding: 4px;");
  });

  it("creates a NEW @media block in mobile-first breakpoint order (between 640 and 1024)", () => {
    const res = applyCssChange(FIXTURE, {
      op: "add-rule",
      styleSheet: sheet,
      selector: ".card",
      mediaText: "(min-width: 768px)",
      ruleText: ".card { margin-top: 14px; }",
    });
    const i640 = res.css.indexOf("(min-width: 640px)");
    const i768 = res.css.indexOf("(min-width: 768px)");
    const i1024 = res.css.indexOf("(min-width: 1024px)");
    expect(i768).toBeGreaterThan(i640);
    expect(i768).toBeLessThan(i1024);
    expect(res.css).toContain("margin-top: 14px;");
  });

  it("respects desktop-first ordering in max-width files", () => {
    const desktopFirst = `.a { color: red; }

@media (max-width: 1024px) {
  .a { color: green; }
}

@media (max-width: 640px) {
  .a { color: blue; }
}
`;
    const res = applyCssChange(desktopFirst, {
      op: "add-rule",
      styleSheet: sheet,
      selector: ".a",
      mediaText: "(max-width: 768px)",
      ruleText: ".a { color: purple; }",
    });
    const i1024 = res.css.indexOf("(max-width: 1024px)");
    const i768 = res.css.indexOf("(max-width: 768px)");
    const i640 = res.css.indexOf("(max-width: 640px)");
    expect(i768).toBeGreaterThan(i1024);
    expect(i768).toBeLessThan(i640);
  });

  it("appends a plain rule at the end when no mediaText is given", () => {
    const res = applyCssChange(FIXTURE, {
      op: "add-rule",
      styleSheet: sheet,
      selector: ".card:hover",
      ruleText: ".card:hover { transform: scale(1.02); }",
    });
    expect(res.css.trimEnd().endsWith("}")).toBe(true);
    const hoverIdx = res.css.indexOf(".card:hover");
    expect(hoverIdx).toBeGreaterThan(res.css.indexOf("(min-width: 1024px)"));
    expect(res.css).toContain("transform: scale(1.02)");
  });

  it("throws SkipChangeError when ruleText has no rule", () => {
    expect(() =>
      applyCssChange(FIXTURE, {
        op: "add-rule",
        styleSheet: sheet,
        selector: ".x",
        ruleText: "/* just a comment */",
      }),
    ).toThrow(SkipChangeError);
  });

  it("notes when the LLM placement anchor lives in a different container (disregarded, not silently dropped)", () => {
    // anchorSelector ".btn" only exists at the top level; the new rule is
    // being placed inside @media (min-width: 640px) — insertAfter can't
    // cross containers, so the anchor is disregarded. That must show up in
    // the note instead of vanishing.
    const res = applyCssChange(
      FIXTURE,
      {
        op: "add-rule",
        styleSheet: sheet,
        selector: ".card:focus",
        mediaText: "(min-width: 640px)",
        ruleText: ".card:focus { outline: 2px solid blue; }",
      },
      { anchorSelector: ".btn" },
    );
    expect(res.note).toMatch(/anchor .* different container/i);
    expect(res.note).toMatch(/disregarded/i);
    expect(res.css).toContain("outline: 2px solid blue");
  });

  it("notes when the LLM placement anchor selector does not exist at all", () => {
    const res = applyCssChange(FIXTURE, {
      op: "add-rule",
      styleSheet: sheet,
      selector: ".new-thing",
      ruleText: ".new-thing { color: teal; }",
    }, { anchorSelector: ".totally-unknown" });
    expect(res.note).toMatch(/anchor .* not found/i);
  });

  it("is idempotent: re-applying the identical add-rule change does not duplicate it", () => {
    const change = {
      op: "add-rule" as const,
      styleSheet: sheet,
      selector: ".new-thing",
      ruleText: ".new-thing { color: teal; }",
    };
    const first = applyCssChange(FIXTURE, change);
    expect(first.css.match(/\.new-thing/g)?.length).toBe(1);

    const second = applyCssChange(first.css, change);
    expect(second.css.match(/\.new-thing/g)?.length).toBe(1);
    expect(second.css).toBe(first.css);
    expect(second.note).toMatch(/already present.*skipped duplicate insert/i);
  });

  it("is idempotent inside an @media block across re-applies", () => {
    const change = {
      op: "add-rule" as const,
      styleSheet: sheet,
      selector: ".btn",
      mediaText: "(min-width: 640px)",
      ruleText: ".btn { padding: 8px; }",
    };
    const first = applyCssChange(FIXTURE, change);
    const second = applyCssChange(first.css, change);
    expect(second.css).toBe(first.css);
    expect(second.css.match(/padding: 8px/g)?.length).toBe(1);
  });

  it("still inserts a genuinely different rule alongside an existing duplicate-selector rule", () => {
    const change1 = {
      op: "add-rule" as const,
      styleSheet: sheet,
      selector: ".new-thing",
      ruleText: ".new-thing { color: teal; }",
    };
    const change2 = {
      op: "add-rule" as const,
      styleSheet: sheet,
      selector: ".new-thing",
      ruleText: ".new-thing { color: purple; }", // same selector, DIFFERENT decls
    };
    const first = applyCssChange(FIXTURE, change1);
    const second = applyCssChange(first.css, change2);
    expect(second.css).toContain("color: teal");
    expect(second.css).toContain("color: purple");
  });

  it("preserves untouched formatting exactly", () => {
    const res = applyCssChange(FIXTURE, {
      op: "modify",
      styleSheet: sheet,
      selector: ".card",
      property: "color",
      oldValue: "red",
      newValue: "blue",
    });
    // everything except the single edited value is byte-identical
    expect(res.css.replace("color: blue;", "color: red;")).toBe(FIXTURE);
  });
});
