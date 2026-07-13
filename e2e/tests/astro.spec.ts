import { test, expect } from "../fixtures";
import fs from "node:fs";
import path from "node:path";

// Astro sfc tier: `.astro` is registered in resolve.ts's `isSfcLike` (alongside
// `.vue`/`.svelte`) and apply-sfc.ts's `stripScopedAttr` strips Astro's own
// scoping attribute (`[data-astro-cid-<hash>]`). Astro's dev server inlines
// the component's compiled `<style>` directly into the SSR'd document (no
// separate <link>), tagged with a `data-vite-dev-id` pointing at the real
// style module URL — fetching THAT URL (not the inlined block) is what
// carries the inline base64 sourcemap, whose `sources` entry is the
// absolute `Card.astro` path. That lands resolve.ts on the sourcemap
// sources loop → kind:"sfc", viaSourceMap:true → mode "sourcemap".
// apply-sfc.ts then edits only the matching `<style>` rule. The scoped
// hash (`data-astro-cid-<hash>`) is content-derived by Astro's compiler,
// so this spec discovers it at runtime instead of hardcoding it.
//
// Only meaningful on the "astro" project (baseURL -> astro-app's own dev server).
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "astro", "targets the astro-app Card.astro source");
});

const SFC_PATH = path.resolve(import.meta.dirname, "../../examples/astro-app/src/components/Card.astro");

test("a committed Styles-panel edit writes Card.astro's <style> block on disk", async ({ request }) => {
  // Normalise to pristine first so the test is idempotent even if a prior
  // crashed run left the source mid-edit.
  const before = fs.readFileSync(SFC_PATH, "utf8").replace("padding: 40px;", "padding: 20px;");
  fs.writeFileSync(SFC_PATH, before);

  try {
    // Discover the compiled style module URL + content-derived scoped hash
    // from the SSR'd root document's inlined <style data-vite-dev-id="...">.
    const rootRes = await request.get("/");
    expect(rootRes.ok()).toBeTruthy();
    const rootHtml = await rootRes.text();

    const inlineMatch = rootHtml.match(
      /<style data-vite-dev-id="[^"]*\/Card\.astro\?astro&(?:amp;)?type=style&(?:amp;)?index=0&(?:amp;)?lang\.css">\.card\[data-astro-cid-([0-9a-z]+)]/,
    );
    expect(inlineMatch, "expected an inlined scoped <style> for Card.astro in the SSR'd document").not.toBeNull();
    const scopedHash = inlineMatch![1];

    const styleUrlMatch = rootHtml.match(
      /<script type="module" src="(\/src\/components\/Card\.astro\?astro&type=style&index=0&lang\.css)">/,
    );
    expect(styleUrlMatch, "expected a style module <script> tag for Card.astro").not.toBeNull();
    const styleUrl = styleUrlMatch![1]!;

    const styleRes = await request.get(styleUrl);
    expect(styleRes.ok()).toBeTruthy();
    const styleModule = await styleRes.text();
    const cssMatch = styleModule.match(/const __vite__css = "((?:[^"\\]|\\.)*)"/);
    expect(cssMatch, "expected an inlined __vite__css string in the style module").not.toBeNull();
    const cssText = JSON.parse(`"${cssMatch![1]}"`) as string;
    expect(cssText).toContain(`.card[data-astro-cid-${scopedHash}]`);

    const sourceMapURLMatch = cssText.match(/\/\*#\s*sourceMappingURL=([^\s*]+?)\s*\*\//);
    expect(sourceMapURLMatch, "expected an inline sourceMappingURL on the style module").not.toBeNull();

    const selector = `.card[data-astro-cid-${scopedHash}]`;

    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5699/",
        applyMode: "commit",
        changes: [
          {
            op: "modify",
            styleSheet: {
              id: "e2e-astro-scoped",
              sourceURL: `http://localhost:5699${styleUrl}`,
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
    expect(result.applied[0].file).toBe("src/components/Card.astro");
    expect(result.applied[0].mode).toBe("sourcemap");

    const after = fs.readFileSync(SFC_PATH, "utf8");
    expect(after).toContain("padding: 40px;");
    expect(after).not.toContain("padding: 20px;");

    // Frontmatter + markup outside the targeted declaration are byte-identical;
    // only the `.card` rule's `padding` changed.
    const styleBlockBefore = before.slice(0, before.indexOf("<style"));
    const styleBlockAfter = after.slice(0, after.indexOf("<style"));
    expect(styleBlockAfter).toBe(styleBlockBefore);
    // Sibling declaration + sibling rule inside the same block are untouched.
    expect(after).toContain("border-radius: 8px;");
    expect(after).toContain("color: #2563eb;");
  } finally {
    fs.writeFileSync(SFC_PATH, before);
  }
});
