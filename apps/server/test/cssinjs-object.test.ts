import { describe, expect, it } from "vitest";
import type { AddDeclChange, DeleteDeclChange, ModifyChange, StyleSheetRef } from "@css-sync/contract";
import { applyCssInJsChange } from "../src/cssinjs.js";
import { SkipChangeError } from "../src/errors.js";

/**
 * Unit coverage for the OBJECT-SYNTAX css-in-js writer path.
 *
 * cssinjs.ts historically only edited TAGGED-TEMPLATE literals
 * (styled`...`, css`...`). But emotion and styled-components v6 also accept
 * OBJECT styles — `css({ fontSize: 16 })`, `styled('button', { color: 'red' })`,
 * `styled.div({ ... })` — and those produce the SAME runtime <style data-emotion>
 * / <style data-styled> sheets that already route a change to applyCssInJsChange.
 * With only the template writer, every object-form edit threw
 * "no css/styled template literal found" and was silently dropped (fail-closed,
 * but a real capability gap). This suite pins the object path applyCssInJsChange
 * now delegates to.
 *
 * Out of scope by design (no routing path reaches this writer, so a writer would
 * be dead code): vanilla-extract (compiles to plain .css at build), JSS
 * `createUseStyles`, Fela `renderRule`, standalone stitches — each needs its own
 * source-resolution layer, not just an object-property writer.
 *
 * The writer only reads change.op / property / oldValue / newValue; styleSheet
 * and selector are required by the contract type but ignored, so one placeholder
 * sheet is reused throughout.
 */

const sheet: StyleSheetRef = { id: "s", sourceURL: "", origin: "injected" };

function modify(property: string, oldValue: string, newValue: string): ModifyChange {
  return { op: "modify", styleSheet: sheet, selector: ".x", property, oldValue, newValue };
}
function addDecl(property: string, newValue: string): AddDeclChange {
  return { op: "add-decl", styleSheet: sheet, selector: ".x", property, newValue };
}
function delDecl(property: string): DeleteDeclChange {
  return { op: "delete-decl", styleSheet: sheet, selector: ".x", property };
}

// ---------------------------------------------------------------------------
// modify — the four object-form call shapes emotion/styled-components emit.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — object-syntax modify", () => {
  it("edits a flat emotion `css({})` object, converting the CSS property to camelCase", () => {
    const src = `import { css } from "@emotion/react";

const box = css({
  fontSize: "16px",
  display: "grid",
});
`;
    const res = applyCssInJsChange(src, null, modify("font-size", "16px", "20px"));
    expect(res.code).toContain(`fontSize: "20px"`);
    expect(res.code).not.toContain(`"16px"`);
    expect(res.code).toContain(`display: "grid"`); // sibling untouched
  });

  it("edits a bare-number value, writing the new CSS value as a quoted string", () => {
    const src = `const box = css({ fontSize: 16, lineHeight: 1.5 });
`;
    const res = applyCssInJsChange(src, null, modify("font-size", "16", "20px"));
    expect(res.code).toContain(`fontSize: "20px"`);
    expect(res.code).toContain(`lineHeight: 1.5`); // sibling untouched
  });

  it("preserves the existing single-quote style when replacing a value", () => {
    const src = `const box = css({ color: 'red' });
`;
    const res = applyCssInJsChange(src, null, modify("color", "red", "blue"));
    expect(res.code).toContain(`color: 'blue'`);
    expect(res.code).not.toContain(`'red'`);
  });

  it("edits the object 2nd argument of `styled('button', {})`", () => {
    const src = `import styled from "styled-components";

const Btn = styled("button", {
  padding: "8px",
});
`;
    const res = applyCssInJsChange(src, null, modify("padding", "8px", "12px"));
    expect(res.code).toContain(`padding: "12px"`);
  });

  it("edits the object argument of a `styled.div({})` member-callee form", () => {
    const src = `import styled from "styled-components";

const Card = styled.div({
  borderRadius: "4px",
});
`;
    const res = applyCssInJsChange(src, null, modify("border-radius", "4px", "8px"));
    expect(res.code).toContain(`borderRadius: "8px"`);
  });

  it("matches a string-literal key (`'font-size'`) against the kebab CSS property", () => {
    const src = `const box = css({ "font-size": "16px" });
`;
    const res = applyCssInJsChange(src, null, modify("font-size", "16px", "18px"));
    expect(res.code).toContain(`"font-size": "18px"`);
  });
});

// ---------------------------------------------------------------------------
// Vendor-prefix key conversion: -webkit-/-moz- capitalize, -ms- lowercases.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — object-syntax vendor prefixes", () => {
  it("matches a `-webkit-` prefixed CSS property against its `Webkit`-capitalized key", () => {
    const src = `const box = css({ WebkitBoxShadow: "0 0 1px red" });
`;
    const res = applyCssInJsChange(src, null, modify("-webkit-box-shadow", "0 0 1px red", "0 0 2px blue"));
    expect(res.code).toContain(`WebkitBoxShadow: "0 0 2px blue"`);
  });

  it("matches a `-ms-` prefixed CSS property against its lowercase `ms` key", () => {
    const src = `const box = css({ msFlexAlign: "center" });
`;
    const res = applyCssInJsChange(src, null, modify("-ms-flex-align", "center", "start"));
    expect(res.code).toContain(`msFlexAlign: "start"`);
  });
});

// ---------------------------------------------------------------------------
// add-decl / delete-decl on object blocks.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — object-syntax add/delete", () => {
  it("adds a declaration with a camelCase key before the closing brace", () => {
    const src = `const box = css({
  color: "red",
});
`;
    const res = applyCssInJsChange(src, null, addDecl("background-color", "blue"));
    expect(res.code).toContain(`backgroundColor: "blue"`);
    expect(res.code).toContain(`color: "red"`);
  });

  it("deletes a declaration and leaves siblings intact", () => {
    const src = `const box = css({
  color: "red",
  fontSize: "16px",
});
`;
    const res = applyCssInJsChange(src, null, delDecl("font-size"));
    expect(res.code).not.toContain(`fontSize`);
    expect(res.code).toContain(`color: "red"`);
  });
});

// ---------------------------------------------------------------------------
// Nesting: an edit whose mapped line lands inside a nested `:hover` block edits
// the nested declaration, never the outer one of the same name.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — object-syntax nested selectors", () => {
  it("edits a declaration inside a nested `&:hover` object when the line points there", () => {
    const src = `const box = css({
  color: "black",
  "&:hover": {
    color: "red",
  },
});
`;
    const hoverLine = src.split("\n").findIndex((l) => l.includes(`color: "red"`)) + 1;
    const res = applyCssInJsChange(src, hoverLine, modify("color", "red", "green"));
    expect(res.code).toContain(`color: "green"`);
    expect(res.code).toContain(`color: "black"`); // outer untouched
  });
});

// ---------------------------------------------------------------------------
// Fail-closed guards: injection, ambiguity, missing property.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — object-syntax fail-closed", () => {
  it("refuses a value containing an unescaped `;` (CSS-structure injection)", () => {
    const src = `const box = css({ color: "red" });
`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "red; background: url(x)")))
      .toThrow(SkipChangeError);
  });

  it("refuses a value containing a double quote (would break the emitted JS string)", () => {
    const src = `const box = css({ color: "red" });
`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", `re"d`))).toThrow(SkipChangeError);
  });

  it("refuses a value containing a `${` interpolation opener", () => {
    const src = `const box = css({ color: "red" });
`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "red${x}"))).toThrow(
      SkipChangeError,
    );
  });

  it("refuses (skips) when two object blocks match and no line disambiguates", () => {
    const src = `const a = css({ color: "red" });
const b = css({ color: "red" });
`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "blue"))).toThrow(
      SkipChangeError,
    );
  });

  it("uses the mapped line to pick the right block among several", () => {
    const src = `const a = css({ color: "red" });
const b = css({ color: "red" });
`;
    const res = applyCssInJsChange(src, 2, modify("color", "red", "blue"));
    expect(res.code).toContain(`const a = css({ color: "red" });`); // block a untouched
    expect(res.code).toContain(`const b = css({ color: "blue" });`);
  });

  it("skips when the property is absent from the located block", () => {
    const src = `const box = css({ color: "red" });
`;
    expect(() => applyCssInJsChange(src, null, modify("font-size", "16px", "20px"))).toThrow(
      SkipChangeError,
    );
  });

  it("skips a non-style-tag object (a plain config object is never edited)", () => {
    const src = `const config = makeConfig({ color: "red" });
`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "blue"))).toThrow(
      SkipChangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Non-literal / dynamic value nodes: a declaration whose value is a template
// literal, a member/identifier expression, or a spread/computed property must
// never be silently overwritten with a string — that would drop the dynamic
// binding (and, for a template literal, an interpolation, exactly the hazard
// the tagged-template writer's interpolation-count invariant guards against).
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — object-syntax non-literal values fail closed", () => {
  it("refuses to modify a value that is a template literal (would drop the ${} interpolation)", () => {
    const src = "const box = css({ width: `${x}px` });\n";
    expect(() => applyCssInJsChange(src, null, modify("width", "", "20px"))).toThrow(
      SkipChangeError,
    );
  });

  it("refuses to modify a value that is a member/identifier expression (dynamic binding)", () => {
    const src = `const box = css({ color: theme.primary });
`;
    expect(() => applyCssInJsChange(src, null, modify("color", "theme.primary", "blue"))).toThrow(
      SkipChangeError,
    );
  });

  it("does not match a computed key `[prop]: v` against a CSS property", () => {
    const src = `const box = css({ [prop]: "red" });
`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "blue"))).toThrow(
      SkipChangeError,
    );
  });

  it("ignores a spread element when locating and counting declarations", () => {
    const src = `const box = css({ ...base, color: "red" });
`;
    const res = applyCssInJsChange(src, null, modify("color", "red", "blue"));
    expect(res.code).toContain(`color: "blue"`);
    expect(res.code).toContain(`...base`); // spread preserved untouched
  });
});

// ---------------------------------------------------------------------------
// Documentation pins: behaviors relied on elsewhere, made explicit so a future
// change can't silently alter them.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — object-syntax documented behaviors", () => {
  it("modify targets the declaration whose current value matches oldValue when a key repeats", () => {
    const src = `const box = css({
  color: "red",
  color: "green",
});
`;
    const res = applyCssInJsChange(src, null, modify("color", "green", "blue"));
    expect(res.code).toContain(`color: "red"`); // first (non-matching) left alone
    expect(res.code).toContain(`color: "blue"`); // the oldValue="green" one edited
    expect(res.code).not.toContain(`"green"`);
  });

  it("refuses a value containing a newline (control char) — cannot embed in a string literal", () => {
    const src = `const box = css({ color: "red" });
`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "re\nd"))).toThrow(
      SkipChangeError,
    );
  });

  it("add-decl appends a second declaration even when the property already exists", () => {
    // Matches the tagged-template writer: add-decl never dedupes; the cascade
    // (last wins) is the caller's concern.
    const src = `const box = css({
  color: "red",
});
`;
    const res = applyCssInJsChange(src, null, addDecl("color", "blue"));
    expect(res.code).toContain(`color: "red"`);
    expect(res.code).toContain(`color: "blue"`);
  });

  it("add-decl into a block with a trailing comment still produces valid source", () => {
    const src = `const box = css({ color: "red" /* keep */ });
`;
    const res = applyCssInJsChange(src, null, addDecl("background-color", "blue"));
    expect(res.code).toContain(`backgroundColor: "blue"`);
    expect(res.code).toContain(`/* keep */`); // comment preserved
  });
});
