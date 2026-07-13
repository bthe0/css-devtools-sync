import { test, expect } from "../fixtures";
import fs from "node:fs";
import path from "node:path";

// Vue SFC tier: the extension emits the scoped style's OWN compiled module id
// as sourceURL (`ScopedCard.vue?vue&type=style&index=0&scoped=<hash>&lang.css`),
// exactly as CDP reports it for the <style> Vite injects — never the bare
// `.vue` source. Unlike Svelte (whose per-component sourcemap has a bare
// `"sources":["Card.svelte"]` and so rides resolve.ts's `if (compiled)`
// sourceURL fallback → mode "postcss"), vite-plugin-vue emits the FULL path in
// the scoped style's sourcemap `sources`, so resolve.ts resolves it through the
// sourcemap sources loop → kind:"sfc", viaSourceMap:true → mode "sourcemap".
// apply-sfc.ts then edits only the matching `<style scoped>` rule. The scoped
// hash (`data-v-<hash>`) is content-derived by Vue's compiler, so this spec
// discovers it at runtime instead of hardcoding it.
//
// Only meaningful on the "vue" project (baseURL -> vue-app's own dev server).
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "vue", "targets the vue-app ScopedCard.vue source");
});

const SFC_PATH = path.resolve(import.meta.dirname, "../../examples/vue-app/src/components/ScopedCard.vue");

test("a committed Styles-panel edit writes ScopedCard.vue's <style scoped> block on disk", async ({ request }) => {
  // Normalise to pristine first so the test is idempotent even if a prior
  // crashed run left the source mid-edit.
  const before = fs.readFileSync(SFC_PATH, "utf8").replace("padding: 40px;", "padding: 20px;");
  fs.writeFileSync(SFC_PATH, before);

  try {
    // Discover the compiled style module's URL + content-derived scoped hash
    // by asking ScopedCard.vue's own compiled script for the style import it
    // emits — this is the exact id Vite serves the <style> under, and the
    // exact id CDP reports as the sheet's sourceURL.
    const scriptRes = await request.get("/src/components/ScopedCard.vue");
    expect(scriptRes.ok()).toBeTruthy();
    const script = await scriptRes.text();
    const styleImportMatch = script.match(
      /import\s+"(\/src\/components\/ScopedCard\.vue\?vue&type=style&index=0&scoped=([0-9a-f]+)&lang\.css)"/,
    );
    expect(styleImportMatch, "expected a scoped style import in the compiled SFC module").not.toBeNull();
    const [, styleUrl, scopedHash] = styleImportMatch!;

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
        url: "http://localhost:5399/",
        applyMode: "commit",
        changes: [
          {
            op: "modify",
            styleSheet: {
              id: "e2e-vue-scoped",
              sourceURL: `http://localhost:5399${styleUrl}`,
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
    expect(result.applied[0].mode).toBe("sourcemap");

    const after = fs.readFileSync(SFC_PATH, "utf8");
    expect(after).toContain("padding: 40px;");
    expect(after).not.toContain("padding: 20px;");

    // Template + script are byte-identical; only the targeted declaration
    // inside <style scoped> changed.
    const templateBefore = before.slice(0, before.indexOf("<style"));
    const templateAfter = after.slice(0, after.indexOf("<style"));
    expect(templateAfter).toBe(templateBefore);
    // Sibling declaration inside the same block is untouched.
    expect(after).toContain("border-radius: 8px;");
    expect(after).toContain("color: #2563eb;");
  } finally {
    fs.writeFileSync(SFC_PATH, before);
  }
});
