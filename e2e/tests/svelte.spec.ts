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

// --------------------------------------------------------------------------
// Markup tier — the shared line-anchored SFC byte-splice. The stamp
// preprocessor puts a valid `__srcLoc` on each static element at runtime, so
// the extension emits set-attr/set-text changes carrying the element's
// `dataSourceFile` + `dataSourceLine`. These specs POST those change shapes
// directly (the extension can't be Playwright-driven inside DevTools) and
// assert the server writes the .svelte SOURCE, static edits apply, and a
// dynamic `{expr}` body is refused rather than corrupted.
// --------------------------------------------------------------------------

const REL = "src/lib/Card.svelte";

/** Read pristine source, run `body`, always restore the file afterwards. */
async function withPristine(body: (pristine: string) => Promise<void>): Promise<void> {
  const pristine = fs.readFileSync(SFC_PATH, "utf8");
  try {
    await body(pristine);
  } finally {
    fs.writeFileSync(SFC_PATH, pristine);
  }
}

test("a committed set-attr on the static <article> inserts style= into Card.svelte source", async ({
  request,
}) => {
  await withPristine(async () => {
    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5499/",
        applyMode: "commit",
        changes: [
          {
            op: "set-attr",
            element: { tagName: "article", classList: ["card"], dataSourceFile: REL, dataSourceLine: 5 },
            attribute: "style",
            value: "padding: 24px;",
          },
        ],
      },
    });
    expect(applyRes.status(), await applyRes.text()).toBe(200);
    const result = await applyRes.json();
    expect(result.applied, JSON.stringify(result)).toHaveLength(1);
    expect(result.applied[0].mode).toBe("jsx");

    const after = fs.readFileSync(SFC_PATH, "utf8");
    // Inserted right after the tag name, class preserved; <style> block untouched.
    expect(after).toContain('<article style="padding: 24px;" class="card">');
    expect(after).toContain("padding: 20px;"); // the .card rule inside <style> is a different tier
  });
});

test("a committed set-text on the static <p> rewrites its body in Card.svelte source", async ({
  request,
}) => {
  await withPristine(async () => {
    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5499/",
        applyMode: "commit",
        changes: [
          {
            op: "set-text",
            element: { tagName: "p", classList: [], dataSourceFile: REL, dataSourceLine: 7 },
            newText: "Edited via DevTools",
            oldText: "Scoped style tier",
          },
        ],
      },
    });
    expect(applyRes.status(), await applyRes.text()).toBe(200);
    const result = await applyRes.json();
    expect(result.applied, JSON.stringify(result)).toHaveLength(1);
    expect(result.applied[0].mode).toBe("jsx");

    const after = fs.readFileSync(SFC_PATH, "utf8");
    expect(after).toContain("<p>Edited via DevTools</p>");
    expect(after).not.toContain("Scoped style tier");
    // The dynamic sibling <h3>{title}</h3> is byte-identical.
    expect(after).toContain('<h3 class="card-title">{title}</h3>');
  });
});

test("a set-text on the dynamic <h3>{title}</h3> is refused, not corrupted", async ({ request }) => {
  await withPristine(async (pristine) => {
    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5499/",
        applyMode: "commit",
        changes: [
          {
            op: "set-text",
            element: { tagName: "h3", classList: ["card-title"], dataSourceFile: REL, dataSourceLine: 6 },
            newText: "Hardcoded",
          },
        ],
      },
    });
    expect(applyRes.status(), await applyRes.text()).toBe(200);
    const result = await applyRes.json();
    expect(result.applied).toHaveLength(0);
    expect(result.skipped, JSON.stringify(result)).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/non-text or dynamic/i);
    // Source is byte-identical — a refused edit never touches disk.
    expect(fs.readFileSync(SFC_PATH, "utf8")).toBe(pristine);
  });
});
