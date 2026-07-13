import { test, expect } from "../fixtures";
import fs from "node:fs";
import path from "node:path";

// Nuxt SFC tier: rides the same vue sfc tier as vue.spec.ts (Nuxt wires
// devSync() through `vite.plugins` and its internal Vite dev server serves
// the exact same scoped-style module shape vite-plugin-vue produces
// elsewhere) — vite-plugin-vue emits the FULL path in the scoped style's
// sourcemap `sources`, so resolve.ts resolves it through the sourcemap
// sources loop → kind:"sfc", viaSourceMap:true → mode "sourcemap".
// apply-sfc.ts then edits only the matching `<style scoped>` rule.
//
// Nuxt asset-prefixes every Vite-served module under `/_nuxt/` (unlike a
// bare vite-plugin-vue app, which serves at `/src/...`), so the compiled
// style module lives at
// `/_nuxt/components/ScopedCard.vue?vue&type=style&index=0&scoped=<hash>&lang.css`.
// The SSR'd root document already links that exact URL (with the
// content-derived scoped hash baked in), so this spec discovers the hash
// straight from the served HTML instead of hardcoding it or fetching the
// compiled component script separately.
//
// Only meaningful on the "nuxt" project (baseURL -> nuxt-app's own dev server).
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "nuxt", "targets the nuxt-app ScopedCard.vue source");
});

const SFC_PATH = path.resolve(import.meta.dirname, "../../examples/nuxt-app/components/ScopedCard.vue");

test("a committed Styles-panel edit writes ScopedCard.vue's <style scoped> block on disk", async ({ request }) => {
  // Normalise to pristine first so the test is idempotent even if a prior
  // crashed run left the source mid-edit.
  const before = fs.readFileSync(SFC_PATH, "utf8").replace("padding: 40px;", "padding: 20px;");
  fs.writeFileSync(SFC_PATH, before);

  try {
    // Discover the `/_nuxt/`-prefixed compiled style module URL + the
    // content-derived scoped hash straight from the SSR'd root document's
    // <link rel="stylesheet"> tag.
    const rootRes = await request.get("/");
    expect(rootRes.ok()).toBeTruthy();
    const rootHtml = await rootRes.text();
    const linkMatch = rootHtml.match(
      /href="(\/_nuxt\/components\/ScopedCard\.vue\?vue&type=style&index=0&scoped=([0-9a-f]+)&lang\.css)"/,
    );
    expect(linkMatch, "expected a scoped style <link> for ScopedCard.vue in the SSR'd document").not.toBeNull();
    const [, styleUrl, scopedHash] = linkMatch!;

    const styleRes = await request.get(styleUrl!);
    expect(styleRes.ok()).toBeTruthy();
    const styleModule = await styleRes.text();
    const cssMatch = styleModule.match(/const __vite__css = "((?:[^"\\]|\\.)*)"/);
    expect(cssMatch, "expected an inlined __vite__css string in the style module").not.toBeNull();
    const cssText = JSON.parse(`"${cssMatch![1]}"`) as string;
    expect(cssText).toContain(`.card[data-v-${scopedHash}]`);

    const sourceMapURLMatch = cssText.match(/\/\*#\s*sourceMappingURL=([^\s*]+?)\s*\*\//);
    expect(sourceMapURLMatch, "expected an inline sourceMappingURL on the scoped style").not.toBeNull();

    const selector = `.card[data-v-${scopedHash}]`;

    const applyRes = await request.post("/__dev-sync/apply", {
      data: {
        url: "http://localhost:5899/",
        applyMode: "commit",
        changes: [
          {
            op: "modify",
            styleSheet: {
              id: "e2e-nuxt-scoped",
              sourceURL: `http://localhost:5899${styleUrl}`,
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
    expect(result.applied[0].file).toBe("components/ScopedCard.vue");
    expect(result.applied[0].mode).toBe("sourcemap");

    const after = fs.readFileSync(SFC_PATH, "utf8");
    expect(after).toContain("padding: 40px;");
    expect(after).not.toContain("padding: 20px;");

    // Script + template are byte-identical; only the targeted declaration
    // inside <style scoped> changed.
    const templateBefore = before.slice(0, before.indexOf("<style"));
    const templateAfter = after.slice(0, after.indexOf("<style"));
    expect(templateAfter).toBe(templateBefore);
    // Sibling declaration inside the same block is untouched.
    expect(after).toContain("border-radius: 8px;");
  } finally {
    fs.writeFileSync(SFC_PATH, before);
  }
});
