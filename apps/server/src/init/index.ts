// index.ts — `css-sync init` orchestrator: detect → plan → preview diff.
//
// Pure and read-only. planInit decides what init should do to a target repo's
// vite config and returns a unified diff to preview; it writes NOTHING — the
// CLI owns the confirm+write step (the irreversible-edit safety gate).
//
// Plugin injection is GATED on the plugin package already being installed:
// wiring a config to reference a package the repo hasn't got would break
// `vite dev`, so a wanted-but-missing plugin becomes a "install this and
// re-run" required-dep note instead of a config edit.
import { createTwoFilesPatch } from "diff";
import { SkipChangeError } from "../errors.js";
import { toWorkspaceRelative } from "../workspace.js";
import { detectStack, type StackReport } from "./detect.js";
import { transformViteConfig, type InitTransformPlan } from "./transform.js";

export type InitStatus = "ready" | "up-to-date" | "no-vite" | "no-config" | "manual";

export interface RequiredDep {
  readonly pkg: string;
  readonly reason: string;
}

export interface InitPlan {
  readonly status: InitStatus;
  readonly report: StackReport;
  /** Absolute path to the vite config init would edit (null when none/N/A). */
  readonly configPath: string | null;
  /** Workspace-relative config path for display (null when none). */
  readonly relConfigPath: string | null;
  /** Unified diff of the proposed edit; "" unless status === "ready". */
  readonly diff: string;
  /** Transformed config source to write; null unless status === "ready". */
  readonly newSource: string | null;
  /** Sub-edits that couldn't be auto-applied (manual TODO for the user). */
  readonly warnings: readonly string[];
  /** Plugin packages the user must install before their config works. */
  readonly requiredDevDeps: readonly RequiredDep[];
  /** Tailwind warn-and-skip note (null when no tailwind). */
  readonly tailwindNote: string | null;
  /** One-line human summary of the outcome. */
  readonly message: string;
}

function base(report: StackReport, over: Partial<InitPlan> & { status: InitStatus; message: string }): InitPlan {
  return {
    report,
    configPath: report.configPath,
    relConfigPath: null,
    diff: "",
    newSource: null,
    warnings: [],
    requiredDevDeps: [],
    tailwindNote: null,
    ...over,
  };
}

export function planInit(workspaceRoot: string): InitPlan {
  const report = detectStack(workspaceRoot);

  if (report.bundler !== "vite") {
    return base(report, {
      status: "no-vite",
      message:
        "css-sync init v1 supports Vite projects only — no Vite build detected (a vite dep from vitest or a framework like Next/Astro doesn't count).",
    });
  }
  if (!report.configPath || report.configSource === null) {
    return base(report, {
      status: "no-config",
      message: "vite is a dependency but no vite.config.* file was found — create one, then re-run css-sync init.",
    });
  }

  const deps = new Set(report.dependencies);
  const warnings: string[] = [];
  const requiredDevDeps: RequiredDep[] = [];

  const wantEmotion = report.cssInJs.includes("emotion");
  const wantStyled = report.cssInJs.includes("styled-components");

  // css-in-js babel plugins only inject when (a) the plugin package is present
  // AND (b) react is the babel plugin (swc can't take babel plugins). Anything
  // missing becomes a required-dep note or a warning — never a broken edit.
  const emotionPluginInstalled = deps.has("@emotion/babel-plugin");
  const styledPluginInstalled = deps.has("babel-plugin-styled-components");

  if (wantEmotion && !emotionPluginInstalled) {
    requiredDevDeps.push({ pkg: "@emotion/babel-plugin", reason: "readable emotion class labels + sourcemaps" });
  }
  if (wantStyled && !styledPluginInstalled) {
    requiredDevDeps.push({ pkg: "babel-plugin-styled-components", reason: "styled-components displayName + sourcemaps" });
  }
  if ((wantEmotion || wantStyled) && !report.hasReactPlugin) {
    warnings.push(
      "css-in-js babel plugins need @vitejs/plugin-react (babel); @vitejs/plugin-react-swc can't take them — skipped.",
    );
  }

  const injectEmotion = wantEmotion && emotionPluginInstalled && report.hasReactPlugin;
  const injectStyled = wantStyled && styledPluginInstalled && report.hasReactPlugin;
  // Tier-3 JSX stamping: only when css-sync's own locator plugin is installed.
  const injectSourceLocator = deps.has("@css-sync/babel-plugin-source-locator");

  const transformPlan: InitTransformPlan = {
    devSourcemap: true,
    emotion: injectEmotion,
    styledComponents: injectStyled,
    sourceLocator: injectSourceLocator,
  };

  const tailwindNote = report.tailwind
    ? "Tailwind detected — skipped in v1 (its className path is assisted-only). For JSX host stamping, install @css-sync/babel-plugin-source-locator and re-run."
    : null;

  let result;
  try {
    result = transformViteConfig(report.configSource, transformPlan);
  } catch (err) {
    if (err instanceof SkipChangeError) {
      return base(report, {
        status: "manual",
        warnings,
        requiredDevDeps,
        tailwindNote,
        message: `Couldn't safely edit the config automatically: ${err.message}`,
      });
    }
    throw err;
  }

  const allWarnings = [...warnings, ...result.warnings];

  if (!result.changed) {
    return base(report, {
      status: "up-to-date",
      warnings: allWarnings,
      requiredDevDeps,
      tailwindNote,
      message: "vite config already has everything css-sync needs — nothing to change.",
    });
  }

  const relConfigPath = toWorkspaceRelative(workspaceRoot, report.configPath);
  const diff = createTwoFilesPatch(relConfigPath, relConfigPath, report.configSource, result.source, "before", "after");

  return base(report, {
    status: "ready",
    relConfigPath,
    diff,
    newSource: result.source,
    warnings: allWarnings,
    requiredDevDeps,
    tailwindNote,
    message: `Ready to enable css-sync in ${relConfigPath}.`,
  });
}
