import { transformAsync } from "@babel/core";
import { describe, expect, it } from "vitest";
import sourceLocatorBabelPlugin from "./index.js";

const FIXTURE = `
function Card() {
  return (
    <div className="card">
      <span>hello</span>
      <MyWidget />
    </div>
  );
}

const Footer = () => <footer id="f" />;
`;

const RUNTIME = "@dev-sync/babel-plugin-source-locator/runtime";

const transform = async (code: string, opts: Record<string, unknown> = {}) => {
  const result = await transformAsync(code, {
    filename: "/repo/src/components/Card.tsx",
    babelrc: false,
    configFile: false,
    plugins: [[sourceLocatorBabelPlugin, { root: "/repo", ...opts }]],
  });
  return result?.code ?? "";
};

/** Extract the local name the runtime helper was imported as (uid varies). */
const helperName = (out: string): string => {
  const m = out.match(
    new RegExp(`import\\s*\\{\\s*__srcLocRef as (\\w+)\\s*\\}\\s*from\\s*"${RUNTIME.replace(/\//g, "\\/")}"`),
  );
  if (!m) throw new Error(`runtime import not found in:\n${out}`);
  return m[1];
};

describe("source-locator babel plugin", () => {
  it("attaches source location via a ref helper, not DOM attributes", async () => {
    const out = await transform(FIXTURE);

    // Never pollutes the DOM with data-source-* attributes anymore.
    expect(out).not.toContain("data-source-file");

    const ref = helperName(out);
    // Runtime import present exactly once.
    expect(out.match(new RegExp(`import\\s*\\{\\s*__srcLocRef`, "g"))).toHaveLength(1);

    // <div> — line 4 of the fixture (leading newline counts as line 1)
    expect(out).toContain(`ref={${ref}("src/components/Card.tsx", 4, "Card")}`);
    // <span> — line 5
    expect(out).toContain(`${ref}("src/components/Card.tsx", 5, "Card")`);
    // arrow component name resolution — <footer> on line 11
    expect(out).toContain(`${ref}("src/components/Card.tsx", 11, "Footer")`);
  });

  it("does not touch custom components", async () => {
    const out = await transform(FIXTURE);
    expect(out).toMatch(/<MyWidget\s*\/>/);
  });

  it("composes with an existing ref, passing it as the fourth argument", async () => {
    const out = await transform(
      `function A() { const r = null; return <div ref={r} className="x" />; }`,
    );
    const ref = helperName(out);
    // Original ref expression is threaded through, not dropped.
    expect(out).toContain(`ref={${ref}("src/components/Card.tsx", 1, "A", r)}`);
    // Only one ref attribute remains on the element.
    expect(out.match(/ref=/g)).toHaveLength(1);
  });

  it("inserts the ref before a spread so a runtime-provided ref still wins", async () => {
    const out = await transform(
      `function A(props) { return <div {...props} className="y" />; }`,
    );
    const ref = helperName(out);
    // Our ref appears earlier in source order than the spread → React lets a
    // spread-provided ref override ours (documented: those elements lose loc).
    const refIdx = out.indexOf(`${ref}(`);
    const spreadIdx = out.indexOf("...props");
    expect(refIdx).toBeGreaterThan(-1);
    expect(spreadIdx).toBeGreaterThan(-1);
    expect(refIdx).toBeLessThan(spreadIdx);
  });

  it("omits the component argument as null when none can be resolved", async () => {
    // Bare JSX at module scope has no enclosing component.
    const out = await transform(`const x = <div className="z" />;`);
    const ref = helperName(out);
    expect(out).toContain(`${ref}("src/components/Card.tsx", 1, null)`);
  });

  describe("requireUseClientDirective (Next.js RSC safety)", () => {
    // Under Next's App Router the default is a Server Component, where a `ref`
    // is illegal — stamping one throws at render. With this option on, only
    // modules carrying the "use client" directive get stamped.
    it("skips a module with no 'use client' directive", async () => {
      const out = await transform(FIXTURE, { requireUseClientDirective: true });
      expect(out).not.toContain("__srcLocRef");
      expect(out).not.toContain("ref=");
    });

    it("stamps a module that opens with 'use client'", async () => {
      const out = await transform(`"use client";\n${FIXTURE}`, {
        requireUseClientDirective: true,
      });
      const ref = helperName(out);
      // <div> is now on line 5 (directive + blank + fixture's own leading blank).
      expect(out).toContain(`${ref}(`);
      expect(out).toContain(`"use client"`);
    });

    it("stamps everything by default (Vite has no directives)", async () => {
      const out = await transform(FIXTURE); // option off
      expect(out).toContain("__srcLocRef");
    });
  });

  describe("CSS Modules import registration", () => {
    it("registers a *.module.css default import's map with the root-relative css path", async () => {
      const out = await transform(
        `import styles from "./Button.module.css";\nfunction B() { return <button className={styles.btn} />; }\n`,
      );
      expect(out).toContain("registerCssModule");
      // Resolved relative to the importer (/repo/src/components/Card.tsx) -> root-relative.
      expect(out).toMatch(/registerCssModule as (\w+)/);
      expect(out).toContain('("src/components/Button.module.css", styles)');
    });

    it("handles scss/sass/less module specifiers too", async () => {
      const out = await transform(`import s from "../styles/x.module.scss";\nexport const v = s;\n`);
      expect(out).toContain('("src/styles/x.module.scss", s)');
    });

    it("ignores a plain (non-module) css import", async () => {
      const out = await transform(`import "./app.css";\nimport t from "./theme.css";\nexport const v = t;\n`);
      expect(out).not.toContain("registerCssModule");
    });

    it("ignores a side-effect-only module import (no default binding, nothing to read)", async () => {
      const out = await transform(`import "./Button.module.css";\nexport const v = 1;\n`);
      expect(out).not.toContain("registerCssModule");
    });

    it("skips a bare/aliased module specifier it can't resolve to a file (fail-closed)", async () => {
      const out = await transform(`import s from "@/Button.module.css";\nexport const v = s;\n`);
      expect(out).not.toContain("registerCssModule");
    });

    it("imports registerCssModule exactly once for multiple module imports", async () => {
      const out = await transform(
        `import a from "./a.module.css";\nimport b from "./b.module.css";\nexport const v = [a, b];\n`,
      );
      expect(out.match(/registerCssModule as \w+/g)).toHaveLength(1);
      expect(out).toContain('("src/components/a.module.css", a)');
      expect(out).toContain('("src/components/b.module.css", b)');
    });
  });

  it("is a no-op when NODE_ENV is production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const out = await transformAsync(FIXTURE, {
        filename: "/repo/src/components/Card.tsx",
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["jsx"] },
        plugins: [[sourceLocatorBabelPlugin, { root: "/repo" }]],
      });
      expect(out?.code).not.toContain("__srcLocRef");
      expect(out?.code).not.toContain("data-source-file");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
