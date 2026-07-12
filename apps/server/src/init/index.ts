// index.ts — `css-sync init` orchestrator: detect → plan → preview diff.
//
// Pure and read-only. planInit decides what init should do to a target repo's
// vite config and returns a unified diff to preview; it writes NOTHING — the
// CLI owns the confirm+write step (the irreversible-edit safety gate).
//
// The core edit inserts cssSync() (from @css-sync/vite) into the config's
// plugins array — always, since that's the whole point of onboarding; a note
// tells the user to install @css-sync/vite when it's missing. Optional css-in-js
// babel plugins (emotion/styled) ARE gated on their package being installed —
// referencing an uninstalled optional plugin would break `vite dev`.
import { createTwoFilesPatch } from "diff";
import { SkipChangeError } from "../errors.js";
import { toWorkspaceRelative } from "../workspace.js";
import { detectStack, type StackReport } from "./detect.js";
import { transformViteConfig, type InitTransformPlan } from "./transform.js";

export type InitStatus = "ready" | "up-to-date" | "no-vite" | "no-config" | "manual" | "framework";

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

  // Build-owning frameworks (Next/Nuxt/Astro/SvelteKit/Remix/SolidStart) own
  // their build + config, so detect and skip rather than auto-edit a
  // framework-managed config and falsely claim the sync is wired up. Vite-plugin
  // frameworks (Vue/Svelte/Qwik) have a user-editable plugins array and fall
  // through to the normal cssSync() insertion below.
  if (report.framework !== null && report.frameworkOwnsBuild) {
    return base(report, {
      status: "framework",
      message:
        `${report.framework} detected — css-sync init won't edit a framework-managed build config. ` +
        "Skipped. Add the cssSync() plugin to your build manually if it exposes a Vite plugins array.",
    });
  }

  if (report.bundler !== "vite") {
    return base(report, {
      status: "no-vite",
      message:
        "css-sync init supports Vite projects only — no Vite build detected (a vite dep from vitest or a framework like Next/Astro doesn't count).",
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

  // cssSync() is the core onboarding edit — always inserted. It references
  // @css-sync/vite (the drop-in engine plugin); when the target repo hasn't
  // installed it yet, the config edit + this required-dep note together are the
  // actionable step ("add the plugin line, install the package").
  if (!deps.has("@css-sync/vite")) {
    requiredDevDeps.push({
      pkg: "@css-sync/vite",
      reason: "the css-sync dev-server plugin (CSS sourcemap + apply engine + JSX stamping)",
    });
  }

  const transformPlan: InitTransformPlan = {
    cssSync: true,
    emotion: injectEmotion,
    styledComponents: injectStyled,
  };

  const tailwindNote = report.tailwind
    ? "Tailwind detected — its className path is assisted-only (cssSync stamps JSX hosts; utility-class edits stay manual in v1)."
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
