import { describe, expect, it } from "vitest";
import type { StyleSheetRef } from "@dev-sync/contract";
import { applyVanillaExtractChange, parseVeClass } from "../src/apply-vanilla-extract.js";
import { SkipChangeError } from "../src/errors.js";

const SHEET: StyleSheetRef = {
  id: "s1",
  sourceURL: "/src/card.css.ts.vanilla.css",
  sourceMapURL: undefined,
  origin: "regular",
};

const FLAT_MEDIA_HOVER_SOURCE = [
  'import { style } from "@vanilla-extract/css";',
  "",
  "export const card = style({",
  '  padding: "20px",',
  '  borderRadius: "8px",',
  '  color: "#111827",',
  "});",
  "",
  "export const fancy = style({",
  '  padding: "10px",',
  "  selectors: {",
  '    "&:hover": {',
  '      padding: "16px",',
  "    },",
  "  },",
  '  "@media": {',
  '    "screen and (min-width: 900px)": {',
  '      padding: "24px",',
  "    },",
  "  },",
  "});",
  "",
].join("\n");

describe("parseVeClass", () => {
  it("resolves a flat class token to its export with no pseudo", () => {
    expect(parseVeClass(".card_card__8mojj40", ["card", "fancy"])).toEqual({
      export: "card",
      pseudo: null,
    });
  });

  it("resolves a hover-suffixed class token, separating export from pseudo", () => {
    expect(parseVeClass(".card_fancy__8mojj41:hover", ["card", "fancy"])).toEqual({
      export: "fancy",
      pseudo: ":hover",
    });
  });

  it("resolves a plain class token used for an @media rule (no pseudo)", () => {
    expect(parseVeClass(".card_fancy__8mojj41", ["card", "fancy"])).toEqual({
      export: "fancy",
      pseudo: null,
    });
  });

  it("disambiguates an underscore-containing export name against a longer file-basename prefix", () => {
    // token "<file>_<export>__<hash>" where the export itself contains "_":
    // "my_file_my_export__hash" — only "my_export" is a known export.
    expect(parseVeClass(".my_file_my_export__hash", ["my_export"])).toEqual({
      export: "my_export",
      pseudo: null,
    });
  });

  it("throws SkipChangeError when no known export matches", () => {
    expect(() => parseVeClass(".card_unknown__8mojj40", ["card", "fancy"])).toThrow(SkipChangeError);
  });

  it("throws SkipChangeError when the class token has no __hash suffix", () => {
    expect(() => parseVeClass(".plainclass", ["card"])).toThrow(SkipChangeError);
  });
});

describe("applyVanillaExtractChange — flat modify", () => {
  it("changes only the targeted value, byte-identical elsewhere", () => {
    const { css } = applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
      op: "modify",
      styleSheet: SHEET,
      selector: ".card_card__8mojj40",
      property: "padding",
      oldValue: "20px",
      newValue: "40px",
    });
    expect(css).toContain('padding: "40px"');
    expect(css).not.toContain('padding: "20px"');
    // Everything else in `card` is untouched.
    expect(css).toContain('borderRadius: "8px"');
    expect(css).toContain('color: "#111827"');
    // The `fancy` export is byte-identical.
    expect(css.slice(css.indexOf("export const fancy"))).toBe(
      FLAT_MEDIA_HOVER_SOURCE.slice(FLAT_MEDIA_HOVER_SOURCE.indexOf("export const fancy")),
    );
  });
});

describe("applyVanillaExtractChange — nested :hover modify", () => {
  it("edits only the selectors['&:hover'] padding", () => {
    const { css } = applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
      op: "modify",
      styleSheet: SHEET,
      selector: ".card_fancy__8mojj41:hover",
      property: "padding",
      oldValue: "16px",
      newValue: "32px",
    });
    expect(css).toContain('padding: "32px"');
    expect(css).not.toContain('padding: "16px"');
    // Base padding and the @media padding are untouched.
    expect(css).toContain('padding: "10px"');
    expect(css).toContain('padding: "24px"');
  });
});

describe("applyVanillaExtractChange — @media modify", () => {
  it("edits only the @media[query] padding", () => {
    const { css } = applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
      op: "modify",
      styleSheet: SHEET,
      selector: ".card_fancy__8mojj41",
      mediaText: "screen and (min-width: 900px)",
      property: "padding",
      oldValue: "24px",
      newValue: "48px",
    });
    expect(css).toContain('padding: "48px"');
    expect(css).not.toContain('padding: "24px"');
    // Base + hover paddings untouched.
    expect(css).toContain('padding: "10px"');
    expect(css).toContain('padding: "16px"');
  });
});

describe("applyVanillaExtractChange — unsupported APIs skip with a named reason", () => {
  it("skips styleVariants with a reason naming the API", () => {
    const source = [
      'import { styleVariants } from "@vanilla-extract/css";',
      "export const button = styleVariants({",
      '  primary: { padding: "10px" },',
      "});",
    ].join("\n");
    let error: unknown;
    try {
      applyVanillaExtractChange(
        source,
        {
          op: "modify",
          styleSheet: SHEET,
          selector: ".card_button__hash",
          property: "padding",
          oldValue: "10px",
          newValue: "20px",
        },
        { knownExports: ["button"] },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SkipChangeError);
    expect((error as Error).message).toContain("styleVariants");
  });

  it("skips recipe with a reason naming the API", () => {
    const source = [
      'import { recipe } from "@vanilla-extract/recipes";',
      "export const button = recipe({",
      '  base: { padding: "10px" },',
      "});",
    ].join("\n");
    let error: unknown;
    try {
      applyVanillaExtractChange(
        source,
        {
          op: "modify",
          styleSheet: SHEET,
          selector: ".card_button__hash",
          property: "padding",
          oldValue: "10px",
          newValue: "20px",
        },
        { knownExports: ["button"] },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SkipChangeError);
    expect((error as Error).message).toContain("recipe");
  });

  it("skips style([...]) array composition, naming it unsupported", () => {
    const source = [
      'import { style } from "@vanilla-extract/css";',
      'const base = style({ padding: "10px" });',
      "export const button = style([base, { color: 'red' }]);",
    ].join("\n");
    expect(() =>
      applyVanillaExtractChange(
        source,
        {
          op: "modify",
          styleSheet: SHEET,
          selector: ".card_button__hash",
          property: "color",
          oldValue: "red",
          newValue: "blue",
        },
        { knownExports: ["button"] },
      ),
    ).toThrow(SkipChangeError);
  });

  it("skips style(base, {...}) multi-arg composition", () => {
    const source = [
      'import { style } from "@vanilla-extract/css";',
      'const base = style({ padding: "10px" });',
      'export const button = style(base, { color: "red" });',
    ].join("\n");
    expect(() =>
      applyVanillaExtractChange(
        source,
        {
          op: "modify",
          styleSheet: SHEET,
          selector: ".card_button__hash",
          property: "color",
          oldValue: "red",
          newValue: "blue",
        },
        { knownExports: ["button"] },
      ),
    ).toThrow(SkipChangeError);
  });
});

describe("applyVanillaExtractChange — computed key / dynamic value skip", () => {
  it("skips a dynamic (non-literal) declaration value rather than dropping the binding", () => {
    const source = [
      'import { style } from "@vanilla-extract/css";',
      "const spacing = 10;",
      "export const card = style({",
      "  padding: spacing,",
      "});",
    ].join("\n");
    expect(() =>
      applyVanillaExtractChange(source, {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card_card__hash",
        property: "padding",
        oldValue: "10",
        newValue: "20px",
      }),
    ).toThrow(SkipChangeError);
  });
});

describe("applyVanillaExtractChange — property not found", () => {
  it("skips when the declaration property does not exist on the export", () => {
    expect(() =>
      applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card_card__8mojj40",
        property: "marginTop",
        oldValue: "0",
        newValue: "4px",
      }),
    ).toThrow(SkipChangeError);
  });
});

describe("applyVanillaExtractChange — missing nested path", () => {
  it("skips when mediaText is set but the export has no @media block", () => {
    expect(() =>
      applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card_card__8mojj40",
        mediaText: "screen and (min-width: 500px)",
        property: "padding",
        oldValue: "20px",
        newValue: "30px",
      }),
    ).toThrow(SkipChangeError);
  });

  it("skips when the @media block exists but the specific query key does not", () => {
    expect(() =>
      applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card_fancy__8mojj41",
        mediaText: "screen and (min-width: 1200px)",
        property: "padding",
        oldValue: "24px",
        newValue: "30px",
      }),
    ).toThrow(SkipChangeError);
  });

  it("skips when pseudo is targeted but the export has no selectors block", () => {
    expect(() =>
      applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card_card__8mojj40:hover",
        property: "padding",
        oldValue: "20px",
        newValue: "30px",
      }),
    ).toThrow(SkipChangeError);
  });
});

describe("applyVanillaExtractChange — property-name injection (RCE guard)", () => {
  // add-decl emits `change.property` (camelCased) directly as an object KEY. A
  // crafted property that closes the style({...}) literal early and appends JS
  // would be evaluated by vanilla-extract's plugin at build time (RCE). The
  // property-name guard must reject it BEFORE it reaches the splice, even
  // though the resulting source would still be syntactically valid JS.
  const MALICIOUS_PROPS = [
    'a: 1}); console.log("pwned"); ({b',
    "padding }); throw 1; ({",
    "color: red; background: url(evil)",
    "foo(){}",
    "--x: 1 } ; ({",
  ];
  for (const property of MALICIOUS_PROPS) {
    it(`rejects add-decl with an injecting property: ${JSON.stringify(property)}`, () => {
      let error: unknown;
      let result: { css: string } | undefined;
      try {
        result = applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
          op: "add-decl",
          styleSheet: SHEET,
          selector: ".card_card__8mojj40",
          property,
          newValue: "1px",
        });
      } catch (e) {
        error = e;
      }
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(SkipChangeError);
    });
  }

  it("rejects a modify whose property name is not a valid CSS property", () => {
    expect(() =>
      applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
        op: "modify",
        styleSheet: SHEET,
        selector: ".card_card__8mojj40",
        property: "pad}ding",
        oldValue: "20px",
        newValue: "40px",
      }),
    ).toThrow(SkipChangeError);
  });
});

describe("applyVanillaExtractChange — add-decl", () => {
  it("inserts a new declaration into the flat object, byte-identical elsewhere", () => {
    const { css } = applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
      op: "add-decl",
      styleSheet: SHEET,
      selector: ".card_card__8mojj40",
      property: "margin-top",
      newValue: "4px",
    });
    expect(css).toContain('marginTop: "4px"');
    // Existing declarations preserved.
    expect(css).toContain('padding: "20px"');
    expect(css).toContain('color: "#111827"');
    // `fancy` untouched.
    expect(css.slice(css.indexOf("export const fancy"))).toBe(
      FLAT_MEDIA_HOVER_SOURCE.slice(FLAT_MEDIA_HOVER_SOURCE.indexOf("export const fancy")),
    );
    // Result is valid TS (parses) — the object stayed balanced.
    expect(css).toContain("export const card = style({");
  });

  it("inserts into a nested selectors['&:hover'] block", () => {
    const { css } = applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
      op: "add-decl",
      styleSheet: SHEET,
      selector: ".card_fancy__8mojj41:hover",
      property: "color",
      newValue: "blue",
    });
    expect(css).toContain('color: "blue"');
    // The hover block still has its original padding.
    expect(css).toContain('padding: "16px"');
  });

  it("emits a custom property as a quoted string key, not a bare identifier", () => {
    const { css } = applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
      op: "add-decl",
      styleSheet: SHEET,
      selector: ".card_card__8mojj40",
      property: "--brand",
      newValue: "#f00",
    });
    expect(css).toContain('"--brand": "#f00"');
  });
});

describe("applyVanillaExtractChange — delete-decl", () => {
  it("removes the targeted declaration and its line, leaving siblings intact", () => {
    const { css } = applyVanillaExtractChange(FLAT_MEDIA_HOVER_SOURCE, {
      op: "delete-decl",
      styleSheet: SHEET,
      selector: ".card_card__8mojj40",
      property: "border-radius",
    });
    expect(css).not.toContain("borderRadius");
    // Siblings preserved, object still balanced/valid.
    expect(css).toContain('padding: "20px"');
    expect(css).toContain('color: "#111827"');
    expect(css).toContain("export const card = style({");
  });
});

describe("applyVanillaExtractChange — literal value edge cases", () => {
  it("modifies a bare numeric-literal value", () => {
    const source = [
      'import { style } from "@vanilla-extract/css";',
      "export const card = style({",
      "  flexGrow: 1,",
      "});",
    ].join("\n");
    const { css } = applyVanillaExtractChange(source, {
      op: "modify",
      styleSheet: SHEET,
      selector: ".card_card__hash",
      property: "flex-grow",
      oldValue: "1",
      newValue: "2",
    });
    // Replaced with a quoted string value (the writer always emits quoted).
    expect(css).toContain('flexGrow: "2"');
  });

  it("prefers the declaration whose current value matches oldValue when a key repeats", () => {
    const source = [
      'import { style } from "@vanilla-extract/css";',
      "export const card = style({",
      '  padding: "1px",',
      '  padding: "2px",',
      "});",
    ].join("\n");
    const { css } = applyVanillaExtractChange(source, {
      op: "modify",
      styleSheet: SHEET,
      selector: ".card_card__hash",
      property: "padding",
      oldValue: "2px",
      newValue: "9px",
    });
    expect(css).toContain('padding: "1px"');
    expect(css).toContain('padding: "9px"');
    expect(css).not.toContain('padding: "2px"');
  });
});
