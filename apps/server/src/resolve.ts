import fs from "node:fs";
import path from "node:path";
import { SourceMapConsumer, type RawSourceMap } from "source-map-js";
import type { SourceRange, StyleSheetRef } from "@css-sync/contract";
import { jailResolve, resolveExistingFile } from "./workspace.js";

export const isJsLike = (file: string): boolean => /\.(?:[cm]?[jt]sx?)$/i.test(file);
export const isCssLike = (file: string): boolean => /\.(?:css|scss|sass|less|styl)$/i.test(file);

/**
 * Which PostCSS syntax to parse/print a target file with. `.scss`/`.sass`
 * files use SCSS-specific constructs (`//` line comments, `$var`, nesting)
 * that vanilla `postcss.parse` chokes on — real .scss files in the wild use
 * `//` comments constantly, so this is not an edge case.
 */
export const cssSyntaxForFile = (file: string): "scss" | "css" =>
  /\.(?:scss|sass)$/i.test(file) ? "scss" : "css";

export interface ResolvedTarget {
  /** Absolute (jailed) path of the file to edit. */
  file: string;
  /** css -> PostCSS apply; cssinjs -> babel/recast template-literal apply. */
  kind: "css" | "cssinjs";
  /** 1-based line in the ORIGINAL source, when the sourcemap gave us one. */
  line: number | null;
  /**
   * 0-based column in the ORIGINAL source on that line, when the sourcemap
   * gave us one (source-map-js reports columns 0-based). Only ever set
   * alongside `line`. Used by apply-css.ts as a position-based fallback for
   * CSS Modules (hashed selectors never match the source's plain class
   * names) and Sass nesting (the compiled selector is flattened, e.g.
   * ".panel .header", and never matches the source's own nested ".header").
   */
  column: number | null;
  viaSourceMap: boolean;
}

function parseMapJson(json: string): RawSourceMap | null {
  try {
    const map: unknown = JSON.parse(json);
    if (map !== null && typeof map === "object" && "mappings" in map) return map as RawSourceMap;
    return null;
  } catch {
    return null;
  }
}

/**
 * Load the sourcemap for a sheet: data-URI sourceMapURL, file sourceMapURL
 * (resolved relative to the compiled file, jailed), or a sibling `.map`.
 */
export function loadSourceMap(
  workspaceRoot: string,
  sheet: StyleSheetRef,
  compiledPath: string | null,
): RawSourceMap | null {
  const url = sheet.sourceMapURL;

  if (url && url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) return null;
    const meta = url.slice(0, comma);
    const payload = url.slice(comma + 1);
    try {
      const json = /;base64/i.test(meta)
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
      return parseMapJson(json);
    } catch {
      return null;
    }
  }

  if (url) {
    // Relative to the compiled file's directory first, then workspace-wide.
    if (compiledPath && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("/")) {
      try {
        const abs = jailResolve(workspaceRoot, path.join(path.dirname(compiledPath), url));
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          return parseMapJson(fs.readFileSync(abs, "utf8"));
        }
      } catch {
        // fall through to workspace-wide resolution
      }
    }
    const resolved = resolveExistingFile(workspaceRoot, url);
    if (resolved) return parseMapJson(fs.readFileSync(resolved, "utf8"));
    return null;
  }

  if (compiledPath) {
    try {
      const sibling = jailResolve(workspaceRoot, `${compiledPath}.map`);
      if (fs.existsSync(sibling) && fs.statSync(sibling).isFile()) {
        return parseMapJson(fs.readFileSync(sibling, "utf8"));
      }
    } catch {
      return null;
    }
  }
  return null;
}

export interface OriginalLocation {
  file: string;
  line: number;
  column: number;
}

/** Map a compiled CDP range back to the original source via the sourcemap. */
export function mapRangeToOriginal(
  workspaceRoot: string,
  map: RawSourceMap,
  range: SourceRange,
): OriginalLocation | null {
  let consumer: SourceMapConsumer;
  try {
    consumer = new SourceMapConsumer(map);
  } catch {
    return null;
  }
  // CDP ranges are 0-based; source-map consumers take 1-based lines.
  const pos = consumer.originalPositionFor({
    line: range.startLine + 1,
    column: range.startColumn,
  });
  if (!pos.source || pos.line == null) return null;
  const file = resolveExistingFile(workspaceRoot, pos.source);
  if (!file) return null;
  return { file, line: pos.line, column: pos.column ?? 0 };
}

/**
 * Decide which local file a change should edit.
 * Build-pipeline detection: when the browser sheet is compiled output and a
 * mappable ORIGINAL source exists (.scss/.less/.module.css/JS), target the
 * source — never the compiled .css.
 */
export function resolveTargetForChange(
  workspaceRoot: string,
  sheet: StyleSheetRef,
  range: SourceRange | null,
): ResolvedTarget | null {
  const compiled = resolveExistingFile(workspaceRoot, sheet.sourceURL);
  const map = loadSourceMap(workspaceRoot, sheet, compiled);

  if (map) {
    if (range) {
      const orig = mapRangeToOriginal(workspaceRoot, map, range);
      if (orig) {
        return {
          file: orig.file,
          line: orig.line,
          column: orig.column,
          kind: isJsLike(orig.file) ? "cssinjs" : "css",
          viaSourceMap: true,
        };
      }
    }
    // No usable range: still prefer any resolvable original source over the
    // compiled output. CSS-like sources first, then css-in-js sources.
    const sources: string[] = Array.isArray(map.sources) ? map.sources : [];
    for (const wantJs of [false, true]) {
      for (const src of sources) {
        let f: string | null = null;
        try {
          f = resolveExistingFile(workspaceRoot, src);
        } catch {
          continue;
        }
        if (!f) continue;
        if (!wantJs && isCssLike(f)) {
          return { file: f, line: null, column: null, kind: "css", viaSourceMap: true };
        }
        if (wantJs && isJsLike(f)) {
          return { file: f, line: null, column: null, kind: "cssinjs", viaSourceMap: true };
        }
      }
    }
  }

  if (compiled) {
    return {
      file: compiled,
      line: null,
      column: null,
      kind: isJsLike(compiled) ? "cssinjs" : "css",
      viaSourceMap: false,
    };
  }
  return null;
}
