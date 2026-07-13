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
    expect(after).toContain("color: rgb(37, 99, 235);");
  } finally {
    fs.writeFileSync(SFC_PATH, before);
  }
});

// --------------------------------------------------------------------------
// Markup tier — the same shared line-anchored SFC byte-splice that serves
// Svelte/Vue. sourceLocatorAstro() stamps each static element with a transient
// `data-devloc` on the raw `.astro` source; a page-level harvest script lifts
// it into a valid `__srcLoc` before first paint, so the extension emits
// set-attr/set-text changes carrying the element's `dataSourceFile` +
// `dataSourceLine`. These specs POST those change shapes directly and assert
// the server writes the `.astro` SOURCE, static edits apply (mode "jsx"), and
// the dynamic `<h2>{title}</h2>` body is refused rather than corrupted. The
// set-attr/set-text targets live in Card.astro; the set-text-on-page target
// lives in index.astro (a slotted `<p>` reached by recursing into `<Card>`).
// --------------------------------------------------------------------------

const CARD_REL = "src/components/Card.astro";
const INDEX_PATH = path.resolve(import.meta.dirname, "../../examples/astro-app/src/pages/index.astro");
const INDEX_REL = "src/pages/index.astro";

/** Read pristine source at `file`, run `body`, always restore the file afterwards. */
async function withPristine(file: string, body: (pristine: string) => Promise<void>): Promise<void> {
  const pristine = fs.readFileSync(file, "utf8");
  try {
    await body(pristine);
  } finally {
    fs.writeFileSync(file, pristine);
  }
}

test("a committed set-attr on the static <div> inserts style= into Card.astro source", async ({ request }) => {
  await withPristine(SFC_PATH, async () => {
    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5699/",
        applyMode: "commit",
        changes: [
          {
            op: "set-attr",
            element: { tagName: "div", classList: ["card"], dataSourceFile: CARD_REL, dataSourceLine: 8 },
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
    expect(after).toContain('<div style="padding: 24px;" class="card">');
    expect(after).toContain("padding: 20px;"); // the .card rule inside <style> is a different tier
  });
});

test("a committed set-text on the slotted <p> rewrites its body in index.astro source", async ({ request }) => {
  await withPristine(INDEX_PATH, async () => {
    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5699/",
        applyMode: "commit",
        changes: [
          {
            op: "set-text",
            element: { tagName: "p", classList: [], dataSourceFile: INDEX_REL, dataSourceLine: 12 },
            newText: "Edited via DevTools",
            oldText: "Scoped style probe target.",
          },
        ],
      },
    });
    expect(applyRes.status(), await applyRes.text()).toBe(200);
    const result = await applyRes.json();
    expect(result.applied, JSON.stringify(result)).toHaveLength(1);
    expect(result.applied[0].mode).toBe("jsx");

    const after = fs.readFileSync(INDEX_PATH, "utf8");
    expect(after).toContain("<p>Edited via DevTools</p>");
    expect(after).not.toContain("Scoped style probe target.");
    // The hosting <Card> component tag is byte-identical.
    expect(after).toContain('<Card title="Hello from Astro">');
  });
});

test("a set-text on the dynamic <h2>{title}</h2> is refused, not corrupted", async ({ request }) => {
  await withPristine(SFC_PATH, async (pristine) => {
    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5699/",
        applyMode: "commit",
        changes: [
          {
            op: "set-text",
            element: { tagName: "h2", classList: ["card-title"], dataSourceFile: CARD_REL, dataSourceLine: 9 },
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
