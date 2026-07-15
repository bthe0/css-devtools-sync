import { describe, expect, it } from "vitest";
import type { CssModuleMap } from "@dev-sync/contract";
import { reverseCssModuleSelector } from "../src/css-module-map.js";

const MAP: CssModuleMap = {
  _card_1ah9a_2: { local: "card", file: "src/components/ModuleCard.vue" },
  _title_1ah9a_9: { local: "title", file: "src/components/ModuleCard.vue" },
  // A second component's module, different source file.
  _btn_z9x8_1: { local: "btn", file: "src/Button.module.css" },
};

describe("reverseCssModuleSelector", () => {
  it("reverses a single hashed class to its source-local selector + file", () => {
    expect(reverseCssModuleSelector("._title_1ah9a_9", MAP)).toEqual({
      file: "src/components/ModuleCard.vue",
      selector: ".title",
    });
  });

  it("reverses every hashed token in a compound selector, preserving combinators", () => {
    expect(reverseCssModuleSelector("._card_1ah9a_2 ._title_1ah9a_9", MAP)).toEqual({
      file: "src/components/ModuleCard.vue",
      selector: ".card .title",
    });
  });

  it("preserves non-module tokens (e.g. a global class combined with a module class)", () => {
    expect(reverseCssModuleSelector("._card_1ah9a_2.is-active", MAP)).toEqual({
      file: "src/components/ModuleCard.vue",
      selector: ".card.is-active",
    });
  });

  it("preserves pseudo-classes and attribute parts around the reversed token", () => {
    expect(reverseCssModuleSelector("._title_1ah9a_9:hover", MAP)).toEqual({
      file: "src/components/ModuleCard.vue",
      selector: ".title:hover",
    });
  });

  it("returns null when no token is in the map (a plain, non-module selector)", () => {
    expect(reverseCssModuleSelector(".badge", MAP)).toBeNull();
    expect(reverseCssModuleSelector(".badge:hover .icon", MAP)).toBeNull();
  });

  it("refuses (null) when hashed tokens span more than one source file — can't pick one target", () => {
    expect(reverseCssModuleSelector("._card_1ah9a_2 ._btn_z9x8_1", MAP)).toBeNull();
  });

  it("returns null for an undefined/empty map", () => {
    expect(reverseCssModuleSelector("._title_1ah9a_9", undefined)).toBeNull();
    expect(reverseCssModuleSelector("._title_1ah9a_9", {})).toBeNull();
  });
});
