import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PlainCard } from "./components/PlainCard";
import { ModuleCard } from "./components/ModuleCard";
import { ScssPanel } from "./components/ScssPanel";
import { EmotionButton } from "./components/EmotionButton";
import { StyledBadge } from "./components/StyledBadge";
import { TailwindHero } from "./components/TailwindHero";
import { StaticBlock } from "./components/StaticBlock";

/**
 * Spot-checks that the source-locator vite/babel plugin (@css-sync/babel-
 * plugin-source-locator) actually injects data-source-file/line/component
 * onto rendered host elements in dev, for every tier's component.
 */
describe("source-locator instrumentation", () => {
  it.each([
    { Component: PlainCard, file: "src/components/PlainCard.tsx", name: "PlainCard" },
    { Component: ModuleCard, file: "src/components/ModuleCard.tsx", name: "ModuleCard" },
    { Component: ScssPanel, file: "src/components/ScssPanel.tsx", name: "ScssPanel" },
    { Component: TailwindHero, file: "src/components/TailwindHero.tsx", name: "TailwindHero" },
    { Component: StaticBlock, file: "src/components/StaticBlock.tsx", name: "StaticBlock" },
  ])("$name renders host elements tagged with its own data-source-file", ({ Component, file, name }) => {
    const { container } = render(<Component />);
    const tagged = container.querySelectorAll("[data-source-file]");

    expect(tagged.length).toBeGreaterThan(0);
    tagged.forEach((el) => {
      expect(el).toHaveAttribute("data-source-file", file);
      expect(el).toHaveAttribute("data-source-component", name);
    });
  });

  it("EmotionButton has no raw host JSX tags, so source-locator has nothing to stamp (by design)", () => {
    // EmotionButton's JSX only uses capitalized @emotion/styled component
    // tags (<Wrap>, <StyledButton>, <ClickCount>) — the babel plugin only
    // instruments lowercase host elements in the JSX *source*, so this tier
    // is (correctly) resolved via emotion's own sourcemap, not source-locator.
    const { container } = render(<EmotionButton />);
    expect(container.querySelectorAll("[data-source-file]").length).toBe(0);
  });

  it("StyledBadge has no raw host JSX tags, so source-locator has nothing to stamp (by design)", () => {
    // Same reasoning as EmotionButton: StyledBadge's JSX only uses
    // capitalized styled-components tags (<Pill>, <Dot>) — this tier
    // resolves through babel-plugin-styled-components' own sourcemap
    // (displayName + fileName + sourceMap), not source-locator.
    const { container } = render(<StyledBadge />);
    expect(container.querySelectorAll("[data-source-file]").length).toBe(0);
  });
});
