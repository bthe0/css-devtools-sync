import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { CapturePayloadInput, ModifyChange } from "@dev-sync/contract";
import type { Config } from "../src/config.js";
import { SkipChangeError } from "../src/errors.js";
import {
  chooseTemplateLine,
  deriveStyledFile,
  hasStyledIdentity,
  resolveStyledTarget,
  styledIdentityFromClassList,
} from "../src/cssinjs-target.js";
import { buildServer } from "../src/server.js";
import type { FastifyInstance } from "fastify";

/**
 * css-in-js targeting: resolve the source file + template line for a
 * styled-components / emotion edit when the browser sheet gives no sourcemap
 * line. Deterministic path only (anthropicApiKey undefined → LLM disabled).
 */

const tmpDirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const nullLog = {
  warn() {},
  error() {},
  info() {},
  debug() {},
  fatal() {},
  trace() {},
} as unknown as FastifyBaseLogger;

const STYLED_SRC = `import styled from "styled-components";

const Pill = styled.span\`
  gap: 6px;
  font-size: 12px;
\`;

const Dot = styled.span\`
  width: 6px;
  height: 6px;
\`;

export function StyledBadge() {
  return (
    <Pill>
      <Dot />
    </Pill>
  );
}
`;

const EMOTION_SRC = `import styled from "@emotion/styled";

const Wrap = styled.div\`
  display: flex;
\`;

const StyledButton = styled.button\`
  font-size: 14px;
  padding: 10px 22px;
\`;

const ClickCount = styled.span\`
  font-size: 13px;
\`;

export function EmotionButton() {
  return <Wrap><StyledButton>go</StyledButton><ClickCount>0</ClickCount></Wrap>;
}
`;

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cssync-target-")));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

function makeCfg(workspaceRoot: string): Config {
  return {
    workspaceRoot,
    port: 0,
    appEnv: "test",
    anthropicApiKey: undefined,
    extensionId: undefined,
    syncToken: undefined,
    overridesFile: "src/index.css",
    // Journal inside the temp workspace tree — cleaned in afterEach, never the real home.
    journalDir: path.join(workspaceRoot, ".dev-sync-journal"),
  };
}

function styledModify(over: Partial<ModifyChange> = {}): ModifyChange {
  return {
    op: "modify",
    styleSheet: { id: "eval:styled", sourceURL: "", origin: "regular" },
    selector: ".hdbeaO",
    property: "gap",
    oldValue: "6px",
    newValue: "9px",
    element: { tagName: "span", classList: ["StyledBadge__Pill-iRebCQ", "hdbeaO"] },
    ...over,
  };
}

describe("styledIdentityFromClassList", () => {
  it("extracts File__Var from a displayName class, ignoring the hash class", () => {
    expect(styledIdentityFromClassList(["StyledBadge__Pill-iRebCQ", "hdbeaO"])).toEqual({
      file: "StyledBadge",
      component: "Pill",
    });
  });

  it("handles the -sc- infix and returns null for plain classes", () => {
    expect(styledIdentityFromClassList(["Card__Header-sc-ab12cd"])).toEqual({
      file: "Card",
      component: "Header",
    });
    expect(styledIdentityFromClassList(["plain-card", "hdbeaO", "px-4"])).toBeNull();
  });

  it("hasStyledIdentity mirrors it and tolerates undefined", () => {
    expect(hasStyledIdentity(["A__B-xy"])).toBe(true);
    expect(hasStyledIdentity(["nope"])).toBe(false);
    expect(hasStyledIdentity(undefined)).toBe(false);
  });
});

describe("deriveStyledFile", () => {
  it("finds the file by displayName basename that declares the component", () => {
    const root = makeWorkspace({ "src/components/StyledBadge.tsx": STYLED_SRC });
    const file = deriveStyledFile(root, ["StyledBadge__Pill-iRebCQ", "hdbeaO"]);
    expect(file).toBe(path.join(root, "src/components/StyledBadge.tsx"));
  });

  it("falls back to any file declaring the component when basename differs", () => {
    const root = makeWorkspace({ "src/ui/badges.tsx": STYLED_SRC });
    // block "StyledBadge" has no matching filename, but Pill is declared here.
    const file = deriveStyledFile(root, ["StyledBadge__Pill-iRebCQ", "hdbeaO"]);
    expect(file).toBe(path.join(root, "src/ui/badges.tsx"));
  });

  it("returns null when no source declares the component", () => {
    const root = makeWorkspace({ "src/other.tsx": "export const x = 1;\n" });
    expect(deriveStyledFile(root, ["StyledBadge__Pill-iRebCQ"])).toBeNull();
  });
});

describe("chooseTemplateLine (deterministic)", () => {
  it("picks the only template holding the edited property", async () => {
    const cfg = makeCfg("/");
    // Pill has gap; Dot does not — gap edit must target Pill.
    const res = await chooseTemplateLine(cfg, "StyledBadge.tsx", STYLED_SRC, styledModify(), nullLog);
    // `const Pill = styled.span\`` is on line 3 (1-based).
    expect(res.line).toBe(3);
    expect(res.confidence).toBe("deterministic");
  });

  it("disambiguates by oldValue when multiple templates share the property", async () => {
    const cfg = makeCfg("/");
    // Wrap(no font-size), StyledButton(14px), ClickCount(13px) — 14px => StyledButton.
    const change = styledModify({
      property: "font-size",
      oldValue: "14px",
      newValue: "16px",
      element: { tagName: "button", classList: ["EmotionButton__x-1"] },
    });
    const res = await chooseTemplateLine(cfg, "EmotionButton.tsx", EMOTION_SRC, change, nullLog);
    expect(res.line).toBe(7); // `const StyledButton = styled.button\``
  });

  it("throws when the file has no styled/css template at all", async () => {
    const cfg = makeCfg("/");
    await expect(
      chooseTemplateLine(cfg, "x.tsx", "export const x = 1;\n", styledModify(), nullLog),
    ).rejects.toBeInstanceOf(SkipChangeError);
  });
});

describe("resolveStyledTarget", () => {
  it("derives file + template line end to end", async () => {
    const root = makeWorkspace({ "src/components/StyledBadge.tsx": STYLED_SRC });
    const cfg = makeCfg(root);
    const res = await resolveStyledTarget(cfg, styledModify(), nullLog);
    expect(res.absFile).toBe(path.join(root, "src/components/StyledBadge.tsx"));
    expect(res.line).toBe(3);
    expect(res.code).toContain("gap: 6px");
  });

  it("skips when no file declares the component", async () => {
    const root = makeWorkspace({ "src/other.tsx": "export const y = 2;\n" });
    const cfg = makeCfg(root);
    await expect(resolveStyledTarget(cfg, styledModify(), nullLog)).rejects.toBeInstanceOf(
      SkipChangeError,
    );
  });
});

describe("E2E through /apply — styled-components edit writes the template", () => {
  it("modify .hdbeaO gap => rewrites StyledBadge.tsx Pill template", async () => {
    const root = makeWorkspace({ "src/components/StyledBadge.tsx": STYLED_SRC });
    const app = await buildServer(makeCfg(root));
    apps.push(app);

    const payload: CapturePayloadInput = {
      url: "http://localhost:5199/",
      changes: [styledModify()],
      applyMode: "commit", // exercise the write path (default is preview/no-write)
    };
    const res = await app.inject({ method: "POST", url: "/apply", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: unknown[]; skipped: { reason: string }[] };
    expect(body.skipped).toEqual([]);
    expect(body.applied).toHaveLength(1);

    const written = fs.readFileSync(path.join(root, "src/components/StyledBadge.tsx"), "utf8");
    expect(written).toContain("gap: 9px");
    expect(written).not.toContain("gap: 6px");
    // Dot template untouched.
    expect(written).toContain("width: 6px");
  });
});
