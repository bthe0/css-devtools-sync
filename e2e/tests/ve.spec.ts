import { test, expect } from "../fixtures";
import fs from "node:fs";
import path from "node:path";

// vanilla-extract tier: the served stylesheet is the per-file virtual
// `*.css.ts.vanilla.css` module (no inline <style>, no real on-disk file) —
// resolve.ts strips the `.vanilla.css` suffix from sourceURL to recover the
// real `card.css.ts` path (see resolve.ts's VANILLA_CSS_SUFFIX branch), then
// apply-vanilla-extract.ts edits the `style({...})` object literal in place.
// The debug class (`<file>_<export>__<hash>`) is content-derived by
// vanilla-extract, so this spec discovers it at runtime instead of
// hardcoding it.
//
// Only meaningful on the "ve" project (baseURL -> ve-app's own dev server).
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "ve", "targets the ve-app card.css.ts source");
});

const SOURCE_PATH = path.resolve(import.meta.dirname, "../../examples/ve-app/src/card.css.ts");
const VANILLA_CSS_URL = "/src/card.css.ts.vanilla.css";

test("a committed Styles-panel edit writes card.css.ts's `card` style object on disk", async ({ request }) => {
  const before = fs.readFileSync(SOURCE_PATH, "utf8").replace('padding: "40px"', 'padding: "20px"');
  fs.writeFileSync(SOURCE_PATH, before);

  try {
    // Discover the debug class vanilla-extract minted for the `card` export
    // from the compiled JS module (`export var card = 'card_card__<hash>';`).
    const moduleRes = await request.get("/src/card.css.ts");
    expect(moduleRes.ok()).toBeTruthy();
    const moduleText = await moduleRes.text();
    const classMatch = moduleText.match(/export var card = '(card_card__[0-9a-z]+)';/);
    expect(classMatch, "expected a debug class export for `card`").not.toBeNull();
    const debugClass = classMatch![1];

    const cssRes = await request.get(VANILLA_CSS_URL);
    expect(cssRes.ok()).toBeTruthy();
    const styleModule = await cssRes.text();
    const cssMatch = styleModule.match(/const __vite__css = "((?:[^"\\]|\\.)*)"/);
    expect(cssMatch, "expected an inlined __vite__css string in the vanilla-extract style module").not.toBeNull();
    const cssText = JSON.parse(`"${cssMatch![1]}"`) as string;
    expect(cssText).toContain(`.${debugClass} {`);

    const selector = `.${debugClass}`;

    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5599/",
        applyMode: "commit",
        changes: [
          {
            op: "modify",
            styleSheet: {
              id: "e2e-ve-card",
              sourceURL: `http://localhost:5599${VANILLA_CSS_URL}`,
              origin: "regular",
            },
            selector,
            property: "padding",
            oldValue: "20px",
            newValue: "40px",
          },
        ],
      },
    });
    expect(applyRes.status(), await applyRes.text()).toBe(200);
    const result = await applyRes.json();
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].mode).toBe("vanilla-extract");

    const after = fs.readFileSync(SOURCE_PATH, "utf8");
    expect(after).toContain('padding: "40px"');
    expect(after).not.toContain('padding: "20px"');
    // Rest of `card` untouched.
    expect(after).toContain('borderRadius: "8px"');
    expect(after).toContain('color: "#111827"');
    // `fancy` export is byte-identical.
    expect(after.slice(after.indexOf("export const fancy"))).toBe(
      before.slice(before.indexOf("export const fancy")),
    );
  } finally {
    fs.writeFileSync(SOURCE_PATH, before);
  }
});
