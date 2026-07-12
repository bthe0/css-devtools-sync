// detect.ts — `dev-sync init` stack detection (pure, read-only).
//
// Reads a target repo's package.json + vite.config.* and reports what init can
// wire up. init is Vite-based: bundler is "vite" when a vite config file exists,
// or vite is a dep NOT explained by a test runner (vitest) or a build-owning
// meta-framework that pulls vite transitively; else "unknown".
//
// Frameworks split into two buckets (see FRAMEWORK_MARKERS):
//   - BUILD-OWNING (Next/Nuxt/Astro/SvelteKit/Remix/SolidStart): own their build
//     + config, dev-sync can't drive them — reported via `framework` with
//     `frameworkOwnsBuild=true` and skipped by init.
//   - VITE-PLUGIN (Vue/Svelte/Qwik): plain Vite apps with a user-editable
//     vite.config plugins array — reported via `framework` with
//     `frameworkOwnsBuild=false`; init inserts devSync() like it does for React.
//
// Everything here tolerates missing/malformed inputs — detection never throws;
// a repo we can't read cleanly just reports less, and init decides what to do.
import fs from "node:fs";
import path from "node:path";

/** css-in-js families init knows how to configure (babel plugin injection). */
export type CssInJs = "styled-components" | "emotion";

/** Frameworks init recognizes. Some own their build (skip), some are plain Vite. */
export type KnownFramework =
  | "Next.js"
  | "Nuxt"
  | "Astro"
  | "SvelteKit"
  | "Remix"
  | "SolidStart"
  | "Vue"
  | "Svelte"
  | "Qwik";

/**
 * Marker dep -> [framework, ownsBuild], in priority order. A `vite` dep alone
 * never proves a plain Vite app: build-owning frameworks pull vite in
 * transitively and/or ship their own config, so their marker disqualifies the
 * dep-only inference and short-circuits onboarding. Vite-plugin frameworks
 * (ownsBuild=false) are real Vite apps — init onboards them. Ordered so a
 * more-specific marker (e.g. @sveltejs/kit) wins over a broad one (svelte).
 */
const FRAMEWORK_MARKERS: readonly (readonly [string, KnownFramework, boolean])[] = [
  ["next", "Next.js", true],
  ["nuxt", "Nuxt", true],
  ["astro", "Astro", true],
  ["@sveltejs/kit", "SvelteKit", true],
  ["svelte", "Svelte", false],
  ["@remix-run/dev", "Remix", true],
  ["@remix-run/react", "Remix", true],
  ["@builder.io/qwik", "Qwik", false],
  ["@solidjs/start", "SolidStart", true],
  ["solid-start", "SolidStart", true],
  ["vue", "Vue", false],
] as const;

export interface StackReport {
  /** v1 supports "vite" only; "unknown" makes init exit with a "Vite-only" message. */
  readonly bundler: "vite" | "unknown";
  /** Absolute path to the discovered vite config, or null if none on disk. */
  readonly configPath: string | null;
  /** Raw source of the vite config (for the transform step), or null. */
  readonly configSource: string | null;
  /** Detected css-in-js families, de-duped, stable order (styled-components, emotion). */
  readonly cssInJs: CssInJs[];
  /** tailwindcss present — v1 warns and skips (JSX path is assisted-only). */
  readonly tailwind: boolean;
  /**
   * True only for @vitejs/plugin-react (babel). The swc variant can't take the
   * babel plugins init injects, so it reports false — init warns rather than
   * editing a react() block it can't safely extend.
   */
  readonly hasReactPlugin: boolean;
  /**
   * All dependency + devDependency names, sorted. The orchestrator gates plugin
   * injection on presence here — never wire a config to reference a package the
   * target repo hasn't installed (that breaks their dev server).
   */
  readonly dependencies: readonly string[];
  /**
   * Detected framework, or null for a plain Vite (React) app. Build-owning ones
   * (see `frameworkOwnsBuild`) make init skip; Vite-plugin ones (Vue/Svelte/Qwik)
   * are onboarded like React.
   */
  readonly framework: KnownFramework | null;
  /**
   * True when the detected framework owns its own build + config (Next/Nuxt/
   * Astro/SvelteKit/Remix/SolidStart) — init can't drive it, so it skips. False
   * for plain-Vite frameworks (Vue/Svelte/Qwik) and when no framework detected.
   */
  readonly frameworkOwnsBuild: boolean;
}

/** First matching framework marker dep with its ownsBuild flag, or null (priority order). */
function detectFramework(deps: Set<string>): { name: KnownFramework; ownsBuild: boolean } | null {
  for (const [marker, name, ownsBuild] of FRAMEWORK_MARKERS) {
    if (deps.has(marker)) return { name, ownsBuild };
  }
  return null;
}

/** vite config filenames, in the order Vite itself resolves them. */
const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
] as const;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Read + JSON-parse package.json; missing or malformed -> empty (never throws). */
function readPackageJson(workspaceRoot: string): PackageJson {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8");
  } catch {
    return {}; // no package.json — bundler can still be inferred from a config file
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed as PackageJson;
    return {};
  } catch {
    return {}; // malformed JSON — tolerate, report nothing from deps
  }
}

/** All dependency names across dependencies + devDependencies. */
function allDepNames(pkg: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

/** First vite config file present on disk, or null. */
function findViteConfig(workspaceRoot: string): { path: string; source: string } | null {
  for (const name of VITE_CONFIG_NAMES) {
    const abs = path.join(workspaceRoot, name);
    let source: string;
    try {
      source = fs.readFileSync(abs, "utf8");
    } catch {
      continue; // not this extension — keep looking
    }
    return { path: abs, source };
  }
  return null;
}

export function detectStack(workspaceRoot: string): StackReport {
  const pkg = readPackageJson(workspaceRoot);
  const deps = allDepNames(pkg);
  const config = findViteConfig(workspaceRoot);
  const framework = detectFramework(deps);

  // A `vite` dep alone is NOT proof of an onboardable Vite app: Vitest and
  // build-owning frameworks pull vite in transitively. An on-disk vite.config is
  // definitive for "a vite build exists"; otherwise the dep-only fallback is
  // disqualified when a test runner (vitest) or a build-owning framework explains
  // the dep — better to under-claim than misguide. Vite-plugin frameworks
  // (Vue/Svelte/Qwik) do NOT disqualify: they are real Vite apps init onboards.
  const viteDepIsBundler =
    deps.has("vite") && !deps.has("vitest") && !(framework?.ownsBuild ?? false);
  const bundler: StackReport["bundler"] =
    config !== null || viteDepIsBundler ? "vite" : "unknown";

  const cssInJs: CssInJs[] = [];
  if (deps.has("styled-components")) cssInJs.push("styled-components");
  if (deps.has("@emotion/react") || deps.has("@emotion/styled")) cssInJs.push("emotion");

  return {
    bundler,
    configPath: config?.path ?? null,
    configSource: config?.source ?? null,
    cssInJs,
    tailwind: deps.has("tailwindcss"),
    hasReactPlugin: deps.has("@vitejs/plugin-react"),
    dependencies: [...deps].sort(),
    framework: framework?.name ?? null,
    frameworkOwnsBuild: framework?.ownsBuild ?? false,
  };
}
