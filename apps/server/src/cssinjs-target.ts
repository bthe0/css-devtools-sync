import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import type { AddDeclChange, Confidence, DeleteDeclChange, ModifyChange } from "@dev-sync/contract";
import type { Config } from "./config.js";
import { SkipChangeError } from "./errors.js";
import { listTemplates, type TemplateInfo } from "./cssinjs.js";
import { kebabToCamel } from "./cssinjs-object.js";
import { escapeRegExp } from "./util.js";
import { jailResolve } from "./workspace.js";

/**
 * apps/server/src/cssinjs-target.ts — pick WHICH source file + styled/css
 * template a CSS-in-JS edit belongs to, when the browser stylesheet gives us no
 * usable sourcemap line.
 *
 * Two entry problems this solves:
 *   • Emotion: the `<style data-emotion>` sheet HAS a sourcemap → the resolver
 *     already knows the FILE, but not which of the file's several templates
 *     (Wrap / StyledButton / ClickCount) the edit targets (line=null).
 *   • styled-components (v6): the `<style data-styled>` sheet has NO sourcemap
 *     and the rule selector is an opaque hash (`.hdbeaO`). The only identity is
 *     the element's displayName class (`StyledBadge__Pill-…`, i.e. File__Var),
 *     which yields the FILE; the template is then chosen the same way.
 *
 * Targeting strategy (per the product decision "file name is enough; let an LLM
 * auto-target the location"):
 *   1. If the file has exactly one template → use it.
 *   2. Deterministic: if exactly one template contains the edited property (and,
 *      for modify, its oldValue) → use it. Free, offline, production-safe.
 *   3. Otherwise defer to the LLM (Fable, non-production only) to pick the line.
 *   4. Fallback to the first property-matching template, else the first template
 *      — applyCssInJsChange then re-validates (declaration-not-found → skip), so
 *      a wrong guess can never corrupt source.
 */

type CssInJsChange = ModifyChange | AddDeclChange | DeleteDeclChange;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".output",
]);

const JS_EXTS = [".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs"];

/**
 * A styled-components displayName class: `Block__Component` optionally followed
 * by `-<hash>` (default) or `-sc-<hash>`. `Block` is the source file basename
 * (babel `fileName: true`), `Component` the styled variable (`displayName`).
 */
const DISPLAYNAME_RE = /^([A-Za-z][A-Za-z0-9]*)__([A-Za-z][A-Za-z0-9]*)(?:-[A-Za-z0-9-]+)?$/;

export interface StyledIdentity {
  /** Source file basename without extension (from the displayName block). */
  file: string;
  /** Styled component variable name (from the displayName component). */
  component: string;
}

/** Extract {file, component} from the first displayName-shaped class, if any. */
export function styledIdentityFromClassList(classList: readonly string[]): StyledIdentity | null {
  for (const cls of classList) {
    const m = DISPLAYNAME_RE.exec(cls);
    if (m && m[1] && m[2]) return { file: m[1], component: m[2] };
  }
  return null;
}

/** True when a change's element carries a styled-components displayName class. */
export function hasStyledIdentity(classList: readonly string[] | undefined): boolean {
  return classList != null && styledIdentityFromClassList(classList) !== null;
}

/** Bounded recursive walk of the workspace collecting JS/TS source files. */
function collectSourceFiles(workspaceRoot: string, cap = 2000): string[] {
  const files: string[] = [];
  const stack = [workspaceRoot];
  while (stack.length > 0 && files.length < cap) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow symlinks out of the jail
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(full);
      } else if (entry.isFile() && JS_EXTS.includes(path.extname(entry.name).toLowerCase())) {
        files.push(full);
      }
    }
  }
  return files;
}

/**
 * Locate the source file for a styled-components edit from its displayName
 * identity: the file whose basename matches the displayName block AND which
 * declares the styled component. Falls back to any source file that declares
 * `const <component> = styled\`…\``. Returns an absolute (jailed) path or null.
 */
export function deriveStyledFile(
  workspaceRoot: string,
  classList: readonly string[],
): string | null {
  const id = styledIdentityFromClassList(classList);
  if (!id) return null;

  const files = collectSourceFiles(workspaceRoot);
  const declRe = new RegExp(`\\b${escapeRegExp(id.component)}\\b\\s*=\\s*styled`);

  // 1. Exact basename match (StyledBadge -> StyledBadge.tsx) that declares it.
  const byName = files.filter((f) => {
    const base = path.basename(f).replace(/\.[^.]+$/, "");
    return base === id.file;
  });
  for (const f of byName) {
    try {
      if (declRe.test(fs.readFileSync(f, "utf8"))) return f;
    } catch {
      continue;
    }
  }
  // 2. Basename match without the declaration check (single candidate).
  if (byName.length === 1) return byName[0]!;

  // 3. Any file that declares `const <component> = styled`.
  for (const f of files) {
    try {
      if (declRe.test(fs.readFileSync(f, "utf8"))) return f;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The property forms a declaration might use: the raw CSS name
 * (`background-color`, in a tagged template or a string-literal object key) AND
 * its object-syntax camelCase key (`backgroundColor`). Deduped.
 */
function propertyForms(property: string): string[] {
  const raw = property.trim();
  const camel = kebabToCamel(raw);
  return camel === raw ? [raw] : [raw, camel];
}

/**
 * A preceding-char class permitting either CSS-template boundaries (`;`/`{`/
 * whitespace) or object-key boundaries (`,`/`{`/quote) so both forms match.
 */
const DECL_PREFIX = `(^|[\\s;{,"'])`;

/** Does this template/object body contain a declaration for `property` (either form)? */
function templateHasProperty(text: string, property: string): boolean {
  return propertyForms(property).some((form) =>
    new RegExp(`${DECL_PREFIX}${escapeRegExp(form)}\\s*:`, "i").test(text),
  );
}

/** Does it contain `property: <value>` (loose, whitespace-normalized, either form)? */
function templateHasValue(text: string, property: string, value: string): boolean {
  return propertyForms(property).some((form) =>
    new RegExp(
      `${DECL_PREFIX}${escapeRegExp(form)}\\s*:\\s*['"]?${escapeRegExp(value.trim())}`,
      "i",
    ).test(text),
  );
}

const LineResponseSchema = z.object({ line: z.number().int().positive() });

async function llmChooseTemplate(
  cfg: Config,
  relFile: string,
  templates: TemplateInfo[],
  change: CssInJsChange,
  log: FastifyBaseLogger,
): Promise<number | null> {
  if (cfg.appEnv === "production" || !cfg.anthropicApiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const oldVal = change.op === "modify" ? change.oldValue : undefined;
    const newVal = change.op === "delete-decl" ? undefined : change.newValue;
    const prompt = [
      "A developer edited a CSS-in-JS (styled-components / emotion) declaration in Chrome DevTools.",
      `Pick which styled/css template literal in ${relFile} the edit targets.`,
      "",
      `Operation: ${change.op}`,
      `Property: ${change.property}`,
      oldVal !== undefined ? `Old value: ${oldVal}` : "Old value: (unknown)",
      newVal !== undefined ? `New value: ${newVal}` : "New value: (n/a)",
      `Rule selector in the browser: ${change.selector}`,
      change.element
        ? `Element: <${change.element.tagName}> classes=[${change.element.classList.join(", ")}]`
        : "No element context.",
      "",
      "Templates (choose exactly one by its startLine):",
      ...templates.map(
        (t) =>
          `- startLine ${t.startLine}: ${t.text.replace(/\s+/g, " ").trim().slice(0, 200)}`,
      ),
      "",
      'Respond with ONLY JSON, no prose: {"line": <startLine of the chosen template>}',
    ].join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-fable-5",
        max_tokens: 100,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "css-in-js targeting LLM failed; using deterministic pick");
      return null;
    }
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = Array.isArray(data.content)
      ? data.content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
      : "";
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) return null;
    const parsed = LineResponseSchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!parsed.success) return null;
    // Only accept a line that is actually one of the templates' start lines.
    return templates.some((t) => t.startLine === parsed.data.line) ? parsed.data.line : null;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "css-in-js targeting LLM errored; using deterministic pick",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The template line a css-in-js change targets, plus how confidently it was
 * chosen (see Phase 1c). `deterministic` = a unique structural match (single
 * template, or exactly one template holding the property/value); `assisted` =
 * an LLM tiebreak among several candidates (non-prod only); `fallback` = a
 * first-match heuristic when nothing was unique and no LLM was available.
 */
export interface TemplateChoice {
  line: number;
  confidence: Confidence;
  reason: string;
}

/**
 * Choose the 1-based line of the template a css-in-js change targets within
 * `code`, and classify HOW it was chosen. Deterministic when unambiguous;
 * LLM-assisted (non-prod) otherwise; always returns a best-guess line rather
 * than throwing on ambiguity, because applyCssInJsChange re-validates the
 * declaration and safely skips a wrong pick. Throws only when the file contains
 * no styled/css template at all.
 */
export async function chooseTemplateLine(
  cfg: Config,
  absFile: string,
  code: string,
  change: CssInJsChange,
  log: FastifyBaseLogger,
): Promise<TemplateChoice> {
  const templates = listTemplates(code);
  if (templates.length === 0) {
    throw new SkipChangeError("no css/styled template literal found in the mapped source file");
  }
  if (templates.length === 1) {
    return {
      line: templates[0]!.startLine,
      confidence: "deterministic",
      reason: "the only css/styled template in the file",
    };
  }

  const withProp = templates.filter((t) => templateHasProperty(t.text, change.property));
  const withValue =
    change.op === "modify"
      ? withProp.filter((t) => templateHasValue(t.text, change.property, change.oldValue))
      : withProp;

  // Unambiguous deterministic hit — no LLM needed.
  if (withValue.length === 1) {
    return {
      line: withValue[0]!.startLine,
      confidence: "deterministic",
      reason: `exactly one of ${String(templates.length)} templates declares ${change.property}: ${change.op === "modify" ? change.oldValue : "(this property)"}`,
    };
  }
  if (withProp.length === 1) {
    return {
      line: withProp[0]!.startLine,
      confidence: "deterministic",
      reason: `exactly one of ${String(templates.length)} templates declares ${change.property}`,
    };
  }

  // Ambiguous (or zero deterministic matches): ask the LLM to auto-target.
  const relFile = path.relative(cfg.workspaceRoot, absFile) || path.basename(absFile);
  const llmLine = await llmChooseTemplate(cfg, relFile, templates, change, log);
  if (llmLine !== null) {
    return {
      line: llmLine,
      confidence: "assisted",
      reason: `LLM chose among ${String(templates.length)} candidate templates (no unique match) — eyeball the diff`,
    };
  }

  // Deterministic fallback: first property/value match, else first template.
  const fallback = (withValue[0] ?? withProp[0] ?? templates[0])!;
  return {
    line: fallback.startLine,
    confidence: "fallback",
    reason: `first-match heuristic among ${String(templates.length)} templates (no unique match, no LLM) — verify the diff`,
  };
}

/**
 * Full styled-components resolution from a change carrying a displayName class:
 * derive the file, read it, choose the template line. Returns {absFile, code,
 * line, confidence, reason} ready for applyCssInJsChange. Throws SkipChangeError
 * when no file can be found for the identity.
 */
export async function resolveStyledTarget(
  cfg: Config,
  change: CssInJsChange,
  log: FastifyBaseLogger,
): Promise<{ absFile: string; code: string; line: number; confidence: Confidence; reason: string }> {
  const classList = change.element?.classList ?? [];
  const absFile = deriveStyledFile(cfg.workspaceRoot, classList);
  if (!absFile) {
    const id = styledIdentityFromClassList(classList);
    throw new SkipChangeError(
      id
        ? `could not find a source file declaring styled component "${id.component}" (from class "${id.file}__${id.component}")`
        : "styled-components edit has no displayName class to resolve a source file from",
    );
  }
  // Defensive: ensure the derived path is inside the jail before reading.
  const jailed = jailResolve(cfg.workspaceRoot, path.relative(cfg.workspaceRoot, absFile));
  const code = fs.readFileSync(jailed, "utf8");
  const choice = await chooseTemplateLine(cfg, jailed, code, change, log);
  return { absFile: jailed, code, line: choice.line, confidence: choice.confidence, reason: choice.reason };
}
