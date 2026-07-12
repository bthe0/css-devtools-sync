import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StaticBlock } from "./StaticBlock";
import { srcLoc } from "../test/srcLoc";

/**
 * Tier 5 (DOM/HTML template) has no stylesheet or CSS-in-JS template to fall
 * back on, so the whole markup-sync path lives or dies on the source-locator
 * babel plugin actually recording each rendered host element's source location
 * on its off-DOM `__srcLoc` property, and on those elements carrying literal
 * (non-expression) text and attribute values for set-text/set-attr to target.
 */
describe("StaticBlock", () => {
  it("records source-file/line/component on every host element's __srcLoc", () => {
    const { container } = render(<StaticBlock />);

    const nav = screen.getByRole("navigation", { name: "Footer navigation" });
    expect(srcLoc(nav)?.dataSourceFile).toBe("src/components/StaticBlock.tsx");
    expect(srcLoc(nav)?.dataSourceComponent).toBe("StaticBlock");
    expect(srcLoc(nav)?.dataSourceLine).toBeGreaterThan(0);

    const heading = screen.getByText("css-devtools-sync");
    expect(srcLoc(heading)?.dataSourceFile).toBe("src/components/StaticBlock.tsx");
    expect(srcLoc(heading)?.dataSourceComponent).toBe("StaticBlock");
    expect(srcLoc(heading)?.dataSourceLine).toBeGreaterThan(0);

    // Every host element StaticBlock renders should be instrumented, not
    // just a spot check. Query within `container` (RTL's own wrapper <div>
    // is not part of StaticBlock's JSX, so querySelectorAll on it correctly
    // excludes itself and only walks StaticBlock's actual host elements).
    const allHostEls = container.querySelectorAll("footer, div, strong, p, nav, a");
    expect(allHostEls.length).toBeGreaterThan(0);
    allHostEls.forEach((el) => {
      expect(srcLoc(el)?.dataSourceFile).toBe("src/components/StaticBlock.tsx");
      expect(srcLoc(el)?.dataSourceComponent).toBe("StaticBlock");
    });
  });

  it("exposes a literal editable heading text (set-text target)", () => {
    render(<StaticBlock />);

    const heading = screen.getByText("css-devtools-sync");
    // A literal JSXText child, not an expression container — must equal the
    // element's full textContent so a DOM text edit maps 1:1 onto the JSX.
    expect(heading.textContent).toBe("css-devtools-sync");
    expect(heading.childNodes).toHaveLength(1);
    expect(heading.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
  });

  it("exposes a literal editable aria-label attribute (set-attr target)", () => {
    render(<StaticBlock />);

    const nav = screen.getByRole("navigation", { name: "Footer navigation" });
    expect(nav).toHaveAttribute("aria-label", "Footer navigation");
  });

  it("exposes a literal editable title attribute (set-attr target)", () => {
    render(<StaticBlock />);

    const link = screen.getByRole("link", { name: "Plain CSS" });
    expect(link).toHaveAttribute("title", "Jump to the plain CSS tier");
  });
});
