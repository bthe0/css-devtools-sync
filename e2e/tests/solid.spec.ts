import { test, expect } from "../fixtures";
import fs from "node:fs";
import path from "node:path";

// Solid CSS Modules tier: rides the existing css/sourcemap tier. Vite serves
// `Card.module.css` as a JS module that inlines the compiled, hashed CSS
// (`._card_<hash>_<n> { ... }`) plus an inline sourcemap whose `sources`
// entry is the absolute `Card.module.css` path — but the hashed class never
// appears in the original source (which only has `.card`), so a
// selector-by-name lookup can't find it. CDP always reports a `range`
// (the edited declaration's compiled-text position) alongside the selector;
// resolve.ts's position-based fallback maps that range through the
// sourcemap to the real (line, column) in `Card.module.css` when the
// by-name lookup misses — landing on kind:"css", viaSourceMap:true ->
// mode "sourcemap". The hashed class is content-derived (from the file's
// on-disk content hash), so this spec discovers it at runtime instead of
// hardcoding it, and derives `range` from the served compiled CSS text
// itself so the position fallback has something real to resolve.
//
// Only meaningful on the "solid" project (baseURL -> solid-app's own dev server).
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "solid", "targets the solid-app Card.module.css source");
});

const SOURCE_PATH = path.resolve(import.meta.dirname, "../../examples/solid-app/src/Card.module.css");
const MODULE_URL = "/src/Card.module.css";

test("a committed Styles-panel edit writes Card.module.css's `.card` rule on disk", async ({ request }) => {
  // Normalise to pristine first so the test is idempotent even if a prior
  // crashed run left the source mid-edit.
  const before = fs.readFileSync(SOURCE_PATH, "utf8").replace("padding: 40px;", "padding: 20px;");
  fs.writeFileSync(SOURCE_PATH, before);

  try {
    // Discover the content-derived hashed class Vite/Solid minted for `.card`
    // from the compiled CSS module's inlined __vite__css string.
    const moduleRes = await request.get(MODULE_URL);
    expect(moduleRes.ok()).toBeTruthy();
    const moduleText = await moduleRes.text();
    const cssMatch = moduleText.match(/const __vite__css = "((?:[^"\\]|\\.)*)"/);
    expect(cssMatch, "expected an inlined __vite__css string in the CSS module").not.toBeNull();
    const cssText = JSON.parse(`"${cssMatch![1]}"`) as string;

    const classMatch = cssText.match(/^(\._card_[0-9a-z]+_\d+)\s*\{/m);
    expect(classMatch, "expected a hashed .card class in the compiled CSS").not.toBeNull();
    const hashedClass = classMatch![1]!;
    const selector = hashedClass!;

    const sourceMapURLMatch = cssText.match(/\/\*#\s*sourceMappingURL=([^\s*]+?)\s*\*\//);
    expect(sourceMapURLMatch, "expected an inline sourceMappingURL on the CSS module").not.toBeNull();

    // The rule opens at the very start of the compiled CSS text — derive the
    // CDP-style range (0-based line/column) covering the selector itself,
    // exactly as the real extension would report from the CSSRule it edited.
    const ruleStart = cssText.indexOf(hashedClass);
    expect(ruleStart).toBeGreaterThanOrEqual(0);
    const textBeforeRule = cssText.slice(0, ruleStart);
    const startLine = (textBeforeRule.match(/\n/g) ?? []).length;
    const startColumn = ruleStart - (textBeforeRule.lastIndexOf("\n") + 1);
    const range = {
      startLine,
      startColumn,
      endLine: startLine,
      endColumn: startColumn + hashedClass.length,
    };

    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5799/",
        applyMode: "commit",
        changes: [
          {
            op: "modify",
            styleSheet: {
              id: "e2e-solid-card",
              sourceURL: `http://localhost:5799${MODULE_URL}`,
              sourceMapURL: sourceMapURLMatch![1],
              origin: "regular",
            },
            selector,
            range,
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
    expect(result.applied[0].file).toBe("src/Card.module.css");
    expect(result.applied[0].mode).toBe("sourcemap");

    const after = fs.readFileSync(SOURCE_PATH, "utf8");
    expect(after).toContain("padding: 40px;");
    expect(after).not.toContain("padding: 20px;");
    // Sibling declaration + sibling rule are untouched.
    expect(after).toContain("border-radius: 8px;");
    expect(after).toContain("border: 1px solid #e5e4e7;");
    expect(after).toContain('color: #2563eb;');
  } finally {
    fs.writeFileSync(SOURCE_PATH, before);
  }
});
