import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StaticBlock } from "./StaticBlock";

/**
 * Tier 5 (DOM/HTML template) has no stylesheet or CSS-in-JS template to fall
 * back on, so the whole markup-sync path lives or dies on the source-locator
 * babel plugin actually stamping data-source-* onto the rendered host
 * elements, and on those elements carrying literal (non-expression) text and
 * attribute values for set-text/set-attr to target.
 */
describe("StaticBlock", () => {
  it("stamps host elements with data-source-file/line/component", () => {
    const { container } = render(<StaticBlock />);

    const nav = screen.getByRole("navigation", { name: "Footer navigation" });
    expect(nav).toHaveAttribute("data-source-file", "src/components/StaticBlock.tsx");
    expect(nav).toHaveAttribute("data-source-component", "StaticBlock");
    expect(nav.getAttribute("data-source-line")).toMatch(/^\d+$/);

    const heading = screen.getByText("css-devtools-sync");
    expect(heading).toHaveAttribute("data-source-file", "src/components/StaticBlock.tsx");
    expect(heading).toHaveAttribute("data-source-component", "StaticBlock");
    expect(heading.getAttribute("data-source-line")).toMatch(/^\d+$/);

    // Every host element StaticBlock renders should be instrumented, not
    // just a spot check. Query within `container` (RTL's own wrapper <div>
    // is not part of StaticBlock's JSX, so querySelectorAll on it correctly
    // excludes itself and only walks StaticBlock's actual host elements).
    const allHostEls = container.querySelectorAll("footer, div, strong, p, nav, a");
    expect(allHostEls.length).toBeGreaterThan(0);
    allHostEls.forEach((el) => {
      expect(el).toHaveAttribute("data-source-file", "src/components/StaticBlock.tsx");
      expect(el).toHaveAttribute("data-source-component", "StaticBlock");
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
