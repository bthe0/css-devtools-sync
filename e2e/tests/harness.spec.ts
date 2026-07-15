import { test, expect } from "../fixtures";
import fs from "node:fs";
import path from "node:path";

// In-page harness tier. Every other spec hand-POSTs a CapturePayload straight to
// /apply — it proves the SERVER, but bypasses capture entirely. This spec instead
// drives the extension's real in-page harness dialog (harness.js, gated behind
// ?dsHarness), so the SAME capture-core primitives the DevTools poller uses run
// live in the page: serializeSheets()/serializeElements() → diffSheet/builders →
// buildPayload → postApply. It's the only spec that exercises capture, not just
// apply — the layer where the <style module> gap actually lives.
//
// The dialog mounts a Shadow-DOM host on the page; Playwright's CSS locators
// pierce open shadow roots, so #ds-h-* address the controls directly. The
// #ds-h-result <pre> carries the engine's verdict as data-* attributes
// (status / applied-count / skipped-count / mode / skip-reason) so asserts read
// structured state instead of parsing JSON text.
//
// One matrix, all eight examples: each project proves the two universal capture
// paths — a CSS modify (mode varies by sheet tier: sourcemap / postcss /
// vanilla-extract) and a set-attr element edit (mode jsx, which also proves the
// harness-main.js MAIN-world __srcLoc bridge fires under that framework's
// runtime). vue additionally drives the <style module> name-map channel (hash
// reversed to source via useCssModule()) and the promote-inline-on-an-SFC path.
// astro (static HTML, no client
// runtime) and ve (innerHTML DOM) tag no node with __srcLoc, so their element
// path is expected to capture nothing.

const EXAMPLES = path.resolve(import.meta.dirname, "../../examples");
const abs = (rel: string) => path.join(EXAMPLES, rel);

const ATTR_VALUE = "captured in-page";

/** How to resolve the live (often content-hashed) selector for a project's card. */
type SelectorKind = "plain" | "scoped-v" | "astro-cid" | "svelte" | "module" | "ve";

interface CssTier {
  kind: SelectorKind;
  prop: string;
  value: string;
  expectMode: string;
  /** Source file the apply lands in, relative to examples/. */
  file: string;
  /** Substring that must appear on disk after a successful write. */
  diskContains: string;
}

type ElementTier =
  | {
      /** A stable CSS selector for the instrumented card element. */
      selector: string;
      attr: string;
      value: string;
      expectMode: string;
      file: string;
      diskContains: string;
    }
  | {
      /** Why the element capture path can't work here (surfaced, not hidden). */
      unsupported: string;
      /** A concrete element to probe so the "captures nothing" claim is real. */
      probe: string;
    };

interface ProjectCfg {
  name: string;
  css: CssTier;
  element: ElementTier;
}

const PROJECTS: ProjectCfg[] = [
  {
    name: "vite",
    css: { kind: "plain", prop: "padding", value: "40px", expectMode: "sourcemap", file: "vite-react/src/App.css", diskContains: "40px" },
    element: { selector: "article.plain-card", attr: "title", value: ATTR_VALUE, expectMode: "jsx", file: "vite-react/src/App.tsx", diskContains: `title="${ATTR_VALUE}"` },
  },
  {
    name: "next",
    css: { kind: "plain", prop: "padding", value: "40px", expectMode: "sourcemap", file: "next-app/app/globals.css", diskContains: "40px" },
    element: { selector: "article.plain-card", attr: "title", value: ATTR_VALUE, expectMode: "jsx", file: "next-app/app/page.tsx", diskContains: `title="${ATTR_VALUE}"` },
  },
  {
    name: "vue",
    css: { kind: "scoped-v", prop: "padding", value: "40px", expectMode: "sourcemap", file: "vue-app/src/components/ScopedCard.vue", diskContains: "padding: 40px" },
    element: { selector: "article.card", attr: "title", value: ATTR_VALUE, expectMode: "jsx", file: "vue-app/src/components/ScopedCard.vue", diskContains: `title="${ATTR_VALUE}"` },
  },
  {
    name: "svelte",
    css: { kind: "svelte", prop: "padding", value: "40px", expectMode: "postcss", file: "svelte-app/src/lib/Card.svelte", diskContains: "40px" },
    element: { selector: "article.card", attr: "title", value: ATTR_VALUE, expectMode: "jsx", file: "svelte-app/src/lib/Card.svelte", diskContains: `title="${ATTR_VALUE}"` },
  },
  {
    name: "nuxt",
    css: { kind: "scoped-v", prop: "padding", value: "40px", expectMode: "sourcemap", file: "nuxt-app/components/ScopedCard.vue", diskContains: "padding: 40px" },
    // Nuxt SSR-renders then hydrates; sourceLocatorVue() (wired in nuxt.config.ts)
    // stamps __srcLoc on the .vue template elements during hydration, so the
    // element-capture path maps a change back the same as the standalone vue-app.
    element: { selector: "div.card", attr: "title", value: ATTR_VALUE, expectMode: "jsx", file: "nuxt-app/components/ScopedCard.vue", diskContains: `title="${ATTR_VALUE}"` },
  },
  {
    name: "astro",
    css: { kind: "astro-cid", prop: "padding", value: "40px", expectMode: "sourcemap", file: "astro-app/src/components/Card.astro", diskContains: "padding: 40px" },
    // Astro ships static HTML with no client runtime, so no per-node __srcLoc —
    // same element-capture gap as nuxt/ve.
    element: { unsupported: "static HTML, no client runtime __srcLoc", probe: "div.card" },
  },
  {
    name: "solid",
    // A `*.module.css` default import registers its `{local -> hash}` map (babel
    // ImportDeclaration visitor), so the modify reverses the served hash back to
    // `.card` + Card.module.css via the name-map channel → postcss apply, rather
    // than the served-sheet sourcemap tier.
    css: { kind: "module", prop: "padding", value: "40px", expectMode: "postcss", file: "solid-app/src/Card.module.css", diskContains: "padding: 40px" },
    element: { selector: "article", attr: "title", value: ATTR_VALUE, expectMode: "jsx", file: "solid-app/src/Card.tsx", diskContains: `title="${ATTR_VALUE}"` },
  },
  {
    name: "ve",
    css: { kind: "ve", prop: "padding", value: "40px", expectMode: "vanilla-extract", file: "ve-app/src/card.css.ts", diskContains: "40px" },
    // vanilla-extract builds the DOM via innerHTML — no framework runtime tags
    // each node with __srcLoc, so the element path has nothing to map back.
    element: { unsupported: "innerHTML DOM, no per-node __srcLoc", probe: "#app div" },
  },
];

/** Read pristine source, run `body`, always restore afterwards (commit writes disk). */
async function withPristine(file: string, body: () => Promise<void>): Promise<void> {
  const pristine = fs.readFileSync(file, "utf8");
  try {
    await body();
  } finally {
    fs.writeFileSync(file, pristine);
  }
}

/** Resolve the live selector for a card, deriving any content-hashed part off the DOM. */
function liveSelector(page: import("@playwright/test").Page, kind: SelectorKind): Promise<string> {
  return page.evaluate((k: SelectorKind) => {
    const card = () => document.querySelector(".card") as HTMLElement | null;
    if (k === "plain") return ".plain-card";
    if (k === "scoped-v") {
      const el = card();
      if (!el) throw new Error("no .card element");
      const attr = [...el.attributes].map((a) => a.name).find((n) => n.startsWith("data-v-"));
      if (!attr) throw new Error("no data-v-* scope attribute on .card");
      return `.card[${attr}]`;
    }
    if (k === "astro-cid") {
      const el = card();
      if (!el) throw new Error("no .card element");
      const attr = [...el.attributes].map((a) => a.name).find((n) => n.startsWith("data-astro-cid-"));
      if (!attr) throw new Error("no data-astro-cid-* attribute on .card");
      return `.card[${attr}]`;
    }
    if (k === "svelte") {
      const el = card();
      if (!el) throw new Error("no .card element");
      const cls = [...el.classList].find((c) => c.startsWith("svelte-"));
      if (!cls) throw new Error("no svelte-* scope class on .card");
      return `.card.${cls}`;
    }
    if (k === "module") {
      const el = document.querySelector("article") as HTMLElement | null;
      if (!el || !el.classList[0]) throw new Error("no hashed module class on article");
      return "." + el.classList[0];
    }
    // ve: pick the styled div whose debug class references the card (not the fancy variant).
    const el = [...document.querySelectorAll("[class]")].find(
      (e) => /card/i.test((e as HTMLElement).className) && !/fancy/i.test((e as HTMLElement).className),
    ) as HTMLElement | undefined;
    if (!el) throw new Error("no vanilla-extract card element");
    return "." + el.className.split(/\s+/)[0];
  }, kind);
}

/** Fill the dialog, click Run, and return the settled #ds-h-result locator. */
async function runHarness(
  page: import("@playwright/test").Page,
  args: { selector: string; op: string; prop?: string; value?: string },
) {
  // Let the dev-server client settle first — a late Vite reload (seen on ve)
  // remounts the dialog and blanks a field filled too early, so the click reads
  // an empty selector. Waiting for network idle serializes past that.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator("#ds-h-selector").fill(args.selector);
  await page.locator("#ds-h-op").selectOption(args.op);
  await page.locator("#ds-h-prop").fill(args.prop ?? "");
  await page.locator("#ds-h-value").fill(args.value ?? "");
  const result = page.locator("#ds-h-result");
  await page.locator("#ds-h-run").click();
  // The status attribute flips off "running" once the apply POST settles.
  await expect(result).not.toHaveAttribute("data-status", "running");
  return result;
}

for (const cfg of PROJECTS) {
  test.describe(cfg.name, () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== cfg.name, `drives the ${cfg.name} example harness dialog`);
    });

    test("the harness dialog mounts (capture-core dynamic-import resolves)", async ({ page }) => {
      await page.goto("/?dsHarness=1");
      // The Run button only exists once harness.js has import()ed capture-core and
      // built the Shadow-DOM dialog — its presence is the smoke test that the
      // web_accessible_resources wiring + module load path work in a real page.
      await expect(page.locator("#ds-h-run")).toBeVisible();
      await expect(page.locator("#ds-h-result")).toHaveAttribute("data-status", "idle");
    });

    test(`a CSS modify captured in-page writes source (mode ${cfg.css.expectMode})`, async ({ page }) => {
      await withPristine(abs(cfg.css.file), async () => {
        await page.goto("/?dsHarness=1");
        await expect(page.locator("#ds-h-run")).toBeVisible();

        const selector = await liveSelector(page, cfg.css.kind);
        const result = await runHarness(page, { selector, op: "modify", prop: cfg.css.prop, value: cfg.css.value });
        await expect(result).toHaveAttribute("data-status", "ok");
        await expect(result).toHaveAttribute("data-applied-count", "1");
        await expect(result).toHaveAttribute("data-mode", cfg.css.expectMode);

        expect(fs.readFileSync(abs(cfg.css.file), "utf8")).toContain(cfg.css.diskContains);
      });
    });

    const el = cfg.element;
    if ("unsupported" in el) {
      test("a set-attr on an uninstrumented element captures nothing (documented)", async ({ page }) => {
        // No __srcLoc means diffElementSnapshots has no source key to attribute the
        // change to, so runOnce reports "empty" rather than fabricating a change.
        await page.goto("/?dsHarness=1");
        await expect(page.locator("#ds-h-run")).toBeVisible();

        const result = await runHarness(page, { selector: el.probe, op: "set-attr", prop: "title", value: ATTR_VALUE });
        await expect(result).toHaveAttribute("data-status", "empty");
      });
    } else {
      test(`a set-attr captured in-page splices the attribute into source (mode ${el.expectMode})`, async ({ page }) => {
        // Exercises the ELEMENT path, which reads each node's MAIN-world __srcLoc via
        // harness-main.js (the isolated content-script world can't see that expando) —
        // so a green here also proves the cross-world postMessage bridge under this
        // framework's runtime. (style/class are excluded from the captured attr set,
        // so this drives a plain attribute.)
        await withPristine(abs(el.file), async () => {
          await page.goto("/?dsHarness=1");
          await expect(page.locator("#ds-h-run")).toBeVisible();

          const result = await runHarness(page, { selector: el.selector, op: "set-attr", prop: el.attr, value: el.value });
          await expect(result).toHaveAttribute("data-status", "ok");
          await expect(result).toHaveAttribute("data-applied-count", "1");
          await expect(result).toHaveAttribute("data-mode", el.expectMode);

          expect(fs.readFileSync(abs(el.file), "utf8")).toContain(el.diskContains);
        });
      });
    }
  });
}

// vue-only gaps: both are capture-side truths the harness is the only spec able to
// surface, since they live BEFORE the apply POST that other specs start from.
test.describe("vue gaps", () => {
  const MODULE_SFC = abs("vue-app/src/components/ModuleCard.vue");
  const SCOPED_SFC = abs("vue-app/src/components/ScopedCard.vue");

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "vue", "drives the vue-app harness dialog");
  });

  test("a <style module> CSS modify is reversed via the name-map channel and written to source", async ({ page }) => {
    // <style module> compiles `.title` to an opaque `._title_<hash>`. The Vue
    // stamper registers the block's live `{local -> hash}` map (useCssModule())
    // into `window.__dsCssModules`; the harness ships that map with the payload
    // and the server reverses the hash back to `.title` + ModuleCard.vue, then
    // splices the edit into the SFC's `<style module>` block. This drives the
    // full name-map channel end-to-end — capture, transport, reverse, apply.
    await withPristine(MODULE_SFC, async () => {
      await page.goto("/?dsHarness=1");
      await expect(page.locator("#ds-h-run")).toBeVisible();

      const selector = await page.evaluate(() => {
        const h3 = document.querySelector('h3[class*="_title_"]');
        if (!h3) throw new Error("module card h3 (._title_*) not found");
        const cls = [...h3.classList].find((c) => c.startsWith("_title_"));
        if (!cls) throw new Error("no _title_* class on the module card h3");
        return "." + cls;
      });

      const result = await runHarness(page, { selector, op: "modify", prop: "color", value: "rgb(1, 2, 3)" });
      await expect(result).toHaveAttribute("data-status", "ok");
      await expect(result).toHaveAttribute("data-applied-count", "1");
      await expect(result).toHaveAttribute("data-mode", "postcss");

      expect(fs.readFileSync(MODULE_SFC, "utf8")).toContain("rgb(1, 2, 3)");
    });
  });

  test("a promote-inline on a Vue SFC element splices an inline style attr into source", async ({ page }) => {
    // The harness first caught this as a gap: the poller emits op
    // "promote-inline-style" for an inline-style edit, but a Vue SFC has no
    // class-injection path (the class tier refuses .vue, the SFC markup tier
    // refuses `class`), so the JSX-only promote-to-class tier used to reject it.
    // The fix routes SFC elements through the SFC markup splice as a set-attr
    // "style" (apply.ts) — the same static, deterministic attribute write the
    // set-attr path proves — so the edit now lands as an inline style on the tag.
    await withPristine(SCOPED_SFC, async () => {
      await page.goto("/?dsHarness=1");
      await expect(page.locator("#ds-h-run")).toBeVisible();

      const result = await runHarness(page, { selector: "article.card", op: "promote-inline", value: "padding: 24px;" });
      await expect(result).toHaveAttribute("data-status", "ok");
      await expect(result).toHaveAttribute("data-applied-count", "1");
      await expect(result).toHaveAttribute("data-mode", "promote");

      expect(fs.readFileSync(SCOPED_SFC, "utf8")).toMatch(/<article style="padding: 24px" class="card">/);
    });
  });
});
