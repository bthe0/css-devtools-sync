import { test, expect } from "../fixtures";
import fs from "node:fs";
import path from "node:path";

// Svelte SFC tier: the extension emits the compiled style module's own id
// (`Card.svelte?svelte&type=style&lang.css`) as sourceURL, exactly as CDP
// reports it for the <style> vite-plugin-svelte injects. vite-plugin-svelte's
// sourcemap carries a BARE `"sources":["Card.svelte"]` (no directory), which
// resolveExistingFile can't locate under the workspace on its own — so
// resolution rides resolve.ts's sourceURL fallback (the `if (compiled)`
// branch after the sourcemap-sources pass misses), landing on the real
// src/lib/Card.svelte. The scoped class (`svelte-<hash>`) is content-derived,
// so this spec discovers it at runtime instead of hardcoding it.
//
// Only meaningful on the "svelte" project (baseURL -> svelte-app's own dev server).
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "svelte", "targets the svelte-app Card.svelte source");
});

const SFC_PATH = path.resolve(import.meta.dirname, "../../examples/svelte-app/src/lib/Card.svelte");

test("a committed Styles-panel edit writes Card.svelte's <style> block on disk", async ({ request }) => {
  const before = fs.readFileSync(SFC_PATH, "utf8").replace("padding: 40px;", "padding: 20px;");
  fs.writeFileSync(SFC_PATH, before);

  try {
    // Discover the compiled scoping class + confirm the style import id by
    // asking Card.svelte's own compiled module for what it renders/imports.
    const scriptRes = await request.get("/src/lib/Card.svelte");
    expect(scriptRes.ok()).toBeTruthy();
    const script = await scriptRes.text();

    const classMatch = script.match(/class="card (svelte-[0-9a-z]+)"/);
    expect(classMatch, "expected a svelte-scoped class on the rendered card markup").not.toBeNull();
    const scopedClass = classMatch![1];

    const styleImportMatch = script.match(/import\s+"(\/src\/lib\/Card\.svelte\?svelte&type=style&lang\.css)"/);
    expect(styleImportMatch, "expected a style import in the compiled SFC module").not.toBeNull();
    const styleUrl = styleImportMatch![1]!;

    const styleRes = await request.get(styleUrl);
    expect(styleRes.ok()).toBeTruthy();
    const styleModule = await styleRes.text();
    const cssMatch = styleModule.match(/const __vite__css = "((?:[^"\\]|\\.)*)"/);
    expect(cssMatch, "expected an inlined __vite__css string in the style module").not.toBeNull();
    const cssText = JSON.parse(`"${cssMatch![1]}"`) as string;
    expect(cssText).toContain(`.card.${scopedClass}`);

    const sourceMapURLMatch = cssText.match(/\/\*#\s*sourceMappingURL=([^\s*]+?)\s*\*\//);
    expect(sourceMapURLMatch, "expected an inline sourceMappingURL on the scoped style").not.toBeNull();

    const selector = `.card.${scopedClass}`;

    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5499/",
        applyMode: "commit",
        changes: [
          {
            op: "modify",
            styleSheet: {
              id: "e2e-svelte-scoped",
              sourceURL: `http://localhost:5499${styleUrl}`,
              sourceMapURL: sourceMapURLMatch![1],
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
    expect(result.applied[0].mode).toBe("postcss");

    const after = fs.readFileSync(SFC_PATH, "utf8");
    expect(after).toContain("padding: 40px;");
    expect(after).not.toContain("padding: 20px;");

    // Markup + script are byte-identical; only the targeted declaration
    // inside <style> changed.
    const markupBefore = before.slice(0, before.indexOf("<style"));
    const markupAfter = after.slice(0, after.indexOf("<style"));
    expect(markupAfter).toBe(markupBefore);
    // Sibling declaration inside the same block is untouched.
    expect(after).toContain("border-radius: 8px;");
    expect(after).toContain("color: #2563eb;");
  } finally {
    fs.writeFileSync(SFC_PATH, before);
  }
});
