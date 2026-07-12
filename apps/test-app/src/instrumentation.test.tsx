import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PlainCard } from "./components/PlainCard";
import { ModuleCard } from "./components/ModuleCard";
import { ScssPanel } from "./components/ScssPanel";
import { EmotionButton } from "./components/EmotionButton";
import { StyledBadge } from "./components/StyledBadge";
import { TailwindHero } from "./components/TailwindHero";
import { StaticBlock } from "./components/StaticBlock";
import { instrumentedEls, srcLoc } from "./test/srcLoc";

/**
 * Spot-checks that the source-locator vite/babel plugin (@css-sync/babel-
 * plugin-source-locator) actually records each rendered host element's source
 * location on an off-DOM `__srcLoc` property (file/line/component) in dev, for
 * every tier's component — the same property the extension reads over CDP.
 */
describe("source-locator instrumentation", () => {
  it.each([
    { Component: PlainCard, file: "src/components/PlainCard.tsx", name: "PlainCard" },
    { Component: ModuleCard, file: "src/components/ModuleCard.tsx", name: "ModuleCard" },
    { Component: ScssPanel, file: "src/components/ScssPanel.tsx", name: "ScssPanel" },
    { Component: TailwindHero, file: "src/components/TailwindHero.tsx", name: "TailwindHero" },
    { Component: StaticBlock, file: "src/components/StaticBlock.tsx", name: "StaticBlock" },
  ])("$name records its own source location on every host element's __srcLoc", ({ Component, file, name }) => {
    const { container } = render(<Component />);
    const tagged = instrumentedEls(container);

    expect(tagged.length).toBeGreaterThan(0);
    tagged.forEach((el) => {
      const loc = srcLoc(el);
      expect(loc?.dataSourceFile).toBe(file);
      expect(loc?.dataSourceComponent).toBe(name);
    });
  });

  it("EmotionButton has no raw host JSX tags, so source-locator has nothing to record (by design)", () => {
    // EmotionButton's JSX only uses capitalized @emotion/styled component
    // tags (<Wrap>, <StyledButton>, <ClickCount>) — the babel plugin only
    // instruments lowercase host elements in the JSX *source*, so this tier
    // is (correctly) resolved via emotion's own sourcemap, not source-locator.
    const { container } = render(<EmotionButton />);
    expect(instrumentedEls(container).length).toBe(0);
  });

  it("StyledBadge has no raw host JSX tags, so source-locator has nothing to record (by design)", () => {
    // Same reasoning as EmotionButton: StyledBadge's JSX only uses
    // capitalized styled-components tags (<Pill>, <Dot>) — this tier
    // resolves through babel-plugin-styled-components' own sourcemap
    // (displayName + fileName + sourceMap), not source-locator.
    const { container } = render(<StyledBadge />);
    expect(instrumentedEls(container).length).toBe(0);
  });
});
