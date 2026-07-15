import { beforeEach, describe, expect, it } from "vitest";
import { registerCssModule, type CssModuleRegistration } from "./runtime.js";

/** The page-global reverse index registerCssModule writes into. */
function registry(): Record<string, CssModuleRegistration> | undefined {
  return (globalThis as { __dsCssModules?: Record<string, CssModuleRegistration> })
    .__dsCssModules;
}

describe("registerCssModule", () => {
  beforeEach(() => {
    delete (globalThis as { __dsCssModules?: unknown }).__dsCssModules;
  });

  it("indexes each {local -> hash} entry as hash -> {local, file}", () => {
    registerCssModule("src/components/ModuleCard.vue", {
      card: "_card_1ah9a_2",
      title: "_title_1ah9a_9",
    });
    expect(registry()).toEqual({
      _card_1ah9a_2: { local: "card", file: "src/components/ModuleCard.vue" },
      _title_1ah9a_9: { local: "title", file: "src/components/ModuleCard.vue" },
    });
  });

  it("merges maps from multiple files into the one global index", () => {
    registerCssModule("src/A.vue", { a: "_a_1" });
    registerCssModule("src/B.module.css", { b: "_b_2" });
    expect(registry()).toEqual({
      _a_1: { local: "a", file: "src/A.vue" },
      _b_2: { local: "b", file: "src/B.module.css" },
    });
  });

  it("registers every token when a value is a space-joined composition list", () => {
    registerCssModule("src/C.vue", { title: "_title_9 _base_3" });
    expect(registry()?._title_9).toEqual({ local: "title", file: "src/C.vue" });
    expect(registry()?._base_3).toEqual({ local: "title", file: "src/C.vue" });
  });

  it("skips non-string / empty values without throwing", () => {
    registerCssModule("src/D.vue", {
      ok: "_ok_1",
      empty: "",
      // @ts-expect-error — runtime robustness: a non-string slips through
      bad: 42,
    });
    expect(registry()).toEqual({ _ok_1: { local: "ok", file: "src/D.vue" } });
  });

  it("is a no-op for null/undefined/non-object maps", () => {
    registerCssModule("src/E.vue", null);
    registerCssModule("src/E.vue", undefined);
    expect(registry()).toBeUndefined();
  });
});
