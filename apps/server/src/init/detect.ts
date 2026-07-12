// detect.ts — `css-sync init` stack detection (pure, read-only).
//
// Reads a target repo's package.json + vite.config.* and reports what init can
// wire up. v1 is Vite-only: bundler is "vite" when a vite config file exists OR
// vite is a (dev)dependency, else "unknown" (init exits early on unknown).
//
// Everything here tolerates missing/malformed inputs — detection never throws;
// a repo we can't read cleanly just reports less, and init decides what to do.
import fs from "node:fs";
import path from "node:path";

/** css-in-js families init knows how to configure (babel plugin injection). */
export type CssInJs = "styled-components" | "emotion";

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

  const bundler: StackReport["bundler"] =
    config !== null || deps.has("vite") ? "vite" : "unknown";

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
  };
}
