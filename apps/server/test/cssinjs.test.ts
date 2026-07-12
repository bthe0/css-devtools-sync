import { describe, expect, it } from "vitest";
import type { AddDeclChange, DeleteDeclChange, ModifyChange, StyleSheetRef } from "@dev-sync/contract";
import { applyCssInJsChange } from "../src/cssinjs.js";
import { SkipChangeError } from "../src/errors.js";

/**
 * Direct unit coverage for the css-in-js WRITER (applyCssInJsChange).
 *
 * The integration suite (integration-tiers.test.ts) exercises this writer only
 * through the `modify` op on `styled.x` templates (emotion + styled-components).
 * But cssinjs.ts advertises a wider surface — every tag root in
 * STYLE_TAG_ROOTS (styled / css / keyframes / createGlobalStyle / injectGlobal),
 * `styled(Component)` extension and `styled.x.attrs()` chains, plus the
 * add-decl / delete-decl paths and the injection pre-reject guard. None of
 * those had a test. This suite pins each: a tag root that silently fails to be
 * recognised, or an add/delete path that corrupts the template, is a real bug
 * this file will catch — not a hypothetical.
 *
 * The writer only reads change.op / property / oldValue / newValue; styleSheet
 * and selector are required by the contract type but ignored here, so a single
 * placeholder sheet is reused throughout.
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
// Tag-root coverage: every STYLE_TAG_ROOTS entry the writer claims to accept.
// mappedLine is null throughout — each fixture holds a SINGLE template, so the
// writer's "one template => use it" fallback resolves the target.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — tag-root coverage", () => {
  it("edits a bare emotion `css` tagged template (the css-prop pattern)", () => {
    const src = `import { css } from "@emotion/react";

const box = css\`
  display: grid;
  gap: 8px;
\`;
`;
    const res = applyCssInJsChange(src, null, modify("gap", "8px", "12px"));
    expect(res.code).toContain("gap: 12px;");
    expect(res.code).not.toContain("gap: 8px;");
    expect(res.code).toContain("display: grid;"); // sibling untouched
  });

  it("edits a `styled(Component)` extension template (callee-recursion to the `styled` root)", () => {
    const src = `import styled from "styled-components";
import { BaseButton } from "./BaseButton";

const Primary = styled(BaseButton)\`
  padding: 8px;
  color: white;
\`;
`;
    const res = applyCssInJsChange(src, null, modify("padding", "8px", "12px"));
    expect(res.code).toContain("padding: 12px;");
    expect(res.code).toContain("styled(BaseButton)"); // the extension call survives verbatim
    expect(res.code).toContain("color: white;");
  });

  it("edits a `styled.input.attrs({...})` chained template (member→call→member to the `styled` root)", () => {
    const src = `import styled from "styled-components";

const Field = styled.input.attrs({ type: "text" })\`
  border: 1px solid #ccc;
  padding: 6px;
\`;
`;
    const res = applyCssInJsChange(src, null, modify("padding", "6px", "10px"));
    expect(res.code).toContain("padding: 10px;");
    expect(res.code).toContain('styled.input.attrs({ type: "text" })'); // .attrs() config untouched
    expect(res.code).toContain("border: 1px solid #ccc;");
  });

  it("edits a declaration inside a `keyframes` template's step, leaving the other step intact", () => {
    const src = `import { keyframes } from "styled-components";

const fade = keyframes\`
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
\`;
`;
    // Two "opacity" decls exist; oldValue "0" disambiguates to the `from` step.
    const res = applyCssInJsChange(src, null, modify("opacity", "0", "0.4"));
    expect(res.code).toContain("opacity: 0.4;");
    expect(res.code).toContain("opacity: 1;"); // the `to` step's own opacity survives
  });

  it("edits a declaration inside a `createGlobalStyle` template", () => {
    const src = `import { createGlobalStyle } from "styled-components";

const Global = createGlobalStyle\`
  body {
    margin: 0;
    background: #111;
  }
\`;
`;
    const res = applyCssInJsChange(src, null, modify("margin", "0", "8px"));
    expect(res.code).toContain("margin: 8px;");
    expect(res.code).toContain("background: #111;");
  });

  it("ignores non-style tagged templates (e.g. gql``) — reports nothing to edit", () => {
    const src = `import { gql } from "@apollo/client";

const Query = gql\`
  query { me { id } }
\`;
`;
    expect(() => applyCssInJsChange(src, null, modify("id", "1", "2"))).toThrow(SkipChangeError);
    expect(() => applyCssInJsChange(src, null, modify("id", "1", "2"))).toThrow(
      /no css\/styled template literal found/,
    );
  });
});

// ---------------------------------------------------------------------------
// add-decl / delete-decl: only `modify` was integration-tested. These paths
// have their own splice logic (append-before-closing-backtick, whole-line
// removal) and their own fidelity guards.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — add-decl / delete-decl", () => {
  const src = `import styled from "@emotion/styled";

const Card = styled.div\`
  display: flex;
  padding: 16px;
\`;
`;

  it("appends a new declaration before the closing backtick, matching the template's indentation", () => {
    const res = applyCssInJsChange(src, null, addDecl("gap", "12px"));
    expect(res.code).toContain("gap: 12px;");
    // appended INSIDE the template, after the last existing decl, two-space indent
    expect(res.code).toMatch(/padding: 16px;\n {2}gap: 12px;\n`/);
    expect(res.code).toContain("display: flex;");
  });

  it("removes an entire declaration line, leaving siblings byte-identical", () => {
    const res = applyCssInJsChange(src, null, delDecl("padding"));
    expect(res.code).not.toContain("padding: 16px;");
    expect(res.code).not.toMatch(/\n\s*\n`/); // no dangling blank line where padding was
    expect(res.code).toContain("display: flex;");
  });

  it("delete-decl a second time is an idempotent SKIP (nothing left to remove)", () => {
    const once = applyCssInJsChange(src, null, delDecl("padding"));
    expect(() => applyCssInJsChange(once.code, null, delDecl("padding"))).toThrow(
      /declaration "padding" not found in the css-in-js template/,
    );
  });

  it("add-decl then modify the just-added declaration round-trips to the requested value", () => {
    const added = applyCssInJsChange(src, null, addDecl("gap", "12px"));
    const changed = applyCssInJsChange(added.code, null, modify("gap", "12px", "20px"));
    expect(changed.code).toContain("gap: 20px;");
    expect(changed.code).not.toContain("gap: 12px;");
  });
});

// ---------------------------------------------------------------------------
// Injection pre-reject (fidelity.assertCssInJsValueSafe): a value that could
// terminate the template, open a live JS interpolation, or break the CSS rule
// structure the runtime re-parses must SkipChangeError and never write.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — injection pre-reject", () => {
  const src = `import styled from "@emotion/styled";

const Card = styled.div\`
  color: #111;
\`;
`;

  it("refuses a value containing an unescaped `}` that would break the CSS rule structure", () => {
    expect(() => applyCssInJsChange(src, null, modify("color", "#111", "red } .evil { color: blue"))).toThrow(
      /break the enclosing CSS rule structure/,
    );
  });

  it("refuses a value containing a backtick that would terminate the template literal", () => {
    expect(() => applyCssInJsChange(src, null, modify("color", "#111", "red`"))).toThrow(
      /terminate the enclosing template literal/,
    );
  });

  it("refuses a value containing ${ that would open a live JS interpolation", () => {
    expect(() =>
      applyCssInJsChange(src, null, modify("color", "#111", "${globalThis.pwn=1}")),
    ).toThrow(/open a live JS interpolation/);
  });

  it("leaves the source unwritten on refusal (the caller receives no code)", () => {
    // applyCssInJsChange throws before producing any code; the write site in
    // apply.ts only persists res.code, so a throw == no file mutation.
    let threw = false;
    try {
      applyCssInJsChange(src, null, modify("color", "#111", "red;}"));
    } catch (err) {
      threw = err instanceof SkipChangeError;
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Interpolation fidelity: a `${...}` in a SIBLING declaration must survive an
// edit to a static declaration, and the structural interpolation-count guard
// must pass (an edit may change only the intended value, never move a hole).
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — interpolation fidelity", () => {
  it("editing a static declaration preserves a sibling declaration's ${...} interpolation verbatim", () => {
    const src = `import styled from "@emotion/styled";

const Button = styled.button<{ variant: string }>\`
  font-size: 14px;
  background-color: \${({ variant }) => (variant === "primary" ? "#e11d48" : "transparent")};
\`;
`;
    const res = applyCssInJsChange(src, null, modify("font-size", "14px", "16px"));
    expect(res.code).toContain("font-size: 16px;");
    // the dynamic value expression is untouched, byte-for-byte
    expect(res.code).toContain(
      'background-color: ${({ variant }) => (variant === "primary" ? "#e11d48" : "transparent")};',
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary: what the writer must REFUSE, not corrupt. The writer is
// tagged-template-only — it splices inside a `css`/`styled`/… template body.
// Everything else (HTML-from-JS, object-syntax CSS-in-JS) has no template to
// splice; the contract is fail-CLOSED — throw SkipChangeError, never write a
// half-parsed guess into markup or an object literal. These pin that boundary
// so a future change can't quietly start mutating the wrong construct.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — unsupported constructs fail closed (never corrupt)", () => {
  it("ignores lit-html `html``` markup — DOM built from a string is not an editable style template", () => {
    const src = `import { html } from "lit";\nconst tpl = html\`<div class="x">hi</div>\`;\n`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "blue"))).toThrow(
      /no css\/styled template literal found/,
    );
  });

  it("ignores an `innerHTML =` string assignment (no tagged template exists at all)", () => {
    const src = `el.innerHTML = '<div style="color:red">x</div>';\n`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "blue"))).toThrow(
      SkipChangeError,
    );
  });

  it("ignores an untagged template string that happens to hold HTML", () => {
    const src = "const t = `<span style=\"color: red\">x</span>`;\n";
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "blue"))).toThrow(
      SkipChangeError,
    );
  });

  it("refuses object-syntax CSS-in-JS (vanilla-extract `style({...})`) — no template body to splice", () => {
    const src = `import { style } from "@vanilla-extract/css";\nconst c = style({ color: "red" });\n`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "blue"))).toThrow(
      SkipChangeError,
    );
  });

  it("edits object-syntax `styled(el, {...})` — delegates to the object-syntax writer", () => {
    // `styled(...)` is a style-tag root, so the object 2nd arg IS editable now
    // (emotion / styled-components v6 object form). Fail-closed is about
    // ambiguity/corruption, not refusing a supported construct — see
    // test/cssinjs-object.test.ts for the full object-path coverage.
    const src = `const Button = styled("button", { color: "red" });\n`;
    const res = applyCssInJsChange(src, null, modify("color", "red", "blue"));
    expect(res.code).toContain(`color: "blue"`);
  });

  it("skips (does not guess) when two `css``` templates are ambiguous and no line pins the target", () => {
    const src = `const a = css\`\n  color: red;\n\`;\nconst b = css\`\n  color: green;\n\`;\n`;
    expect(() => applyCssInJsChange(src, null, modify("color", "red", "blue"))).toThrow(
      /ambiguous file, no line match/,
    );
  });
});

// ---------------------------------------------------------------------------
// Beyond styled-components/emotion: the `css` tag root is framework-agnostic.
// lit's static `css``` and a `css``` nested inside a lit `html``` both resolve.
// ---------------------------------------------------------------------------

describe("applyCssInJsChange — css tag root works across libraries (lit)", () => {
  it("edits lit's static `css``` styles the same as emotion's", () => {
    const src = `import { css } from "lit";\nconst s = css\`\n  color: red;\n\`;\n`;
    const res = applyCssInJsChange(src, null, modify("color", "red", "blue"));
    expect(res.code).toContain("color: blue;");
    expect(res.code).not.toContain("color: red;");
  });

  it("edits a `css``` template nested inside a lit `html``` <style> hole", () => {
    const src = "const t = html`<style>${css`color: red;`}</style>`;\n";
    const res = applyCssInJsChange(src, null, modify("color", "red", "blue"));
    expect(res.code).toContain("color: blue;");
    expect(res.code).toContain("html`<style>${css`"); // outer html shell + interpolation intact
  });
});
