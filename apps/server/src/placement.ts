import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import type { AddRuleChange } from "@css-sync/contract";
import type { Config } from "./config.js";
import { isUtilityClassSelector } from "./classlist.js";
import { isCssLike } from "./resolve.js";
import { escapeRegExp } from "./util.js";

/**
 * THE ONLY LLM USE IN THE SERVER.
 * Fable is called exclusively to choose {file, anchor} for a new rule whose
 * deterministic placement is ambiguous — never to perform exact edits.
 *
 * GATE: engages only when APP_ENV !== "production" AND ANTHROPIC_API_KEY is
 * set AND there is more than one candidate file. Every other path — including
 * ALL production traffic — uses the deterministic fallback (first candidate =
 * the owning selector file; apply-css.ts then find-or-creates the matching
 * @media block or appends at end).
 */

const PlacementResponseSchema = z.object({
  file: z.string().min(1),
  anchor: z.string().min(1).optional(),
});

export interface PlacementDecision {
  /** Workspace-relative path of the file to place the rule in. */
  file: string;
  /** Optional selector in that file to anchor the new rule after. */
  anchor?: string | undefined;
  viaLlm: boolean;
}

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

/**
 * Scan the workspace (bounded) for the stylesheet that already owns rules for
 * the element's (non-utility) classes — the natural home for a new rule.
 */
export function findOwningCssFile(workspaceRoot: string, classList: string[]): string | null {
  const classes = classList.filter((c) => c && !isUtilityClassSelector(`.${c}`));
  if (classes.length === 0) return null;

  const files: string[] = [];
  const stack = [workspaceRoot];
  while (stack.length > 0 && files.length < 400) {
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
      } else if (entry.isFile() && isCssLike(entry.name)) {
        files.push(full);
      }
    }
  }

  let best: string | null = null;
  let bestScore = 0;
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let score = 0;
    for (const cls of classes) {
      if (new RegExp(`\\.${escapeRegExp(cls)}(?![\\w-])`).test(content)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = file;
    }
  }
  return best;
}

async function llmChoosePlacement(
  change: AddRuleChange,
  apiKey: string,
  candidates: string[],
  log: FastifyBaseLogger,
): Promise<{ file: string; anchor?: string | undefined } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const prompt = [
      "A developer added a new CSS rule in Chrome DevTools. Choose which source file it belongs in.",
      "",
      `Rule text: ${change.ruleText}`,
      `Selector: ${change.selector}`,
      change.mediaText ? `Media query: @media ${change.mediaText}` : "No media query.",
      change.element
        ? `Target element: <${change.element.tagName}> classes=[${change.element.classList.join(", ")}]${change.element.dataSourceComponent ? ` component=${change.element.dataSourceComponent}` : ""}`
        : "No element context.",
      "",
      "Candidate files (choose exactly one):",
      ...candidates.map((c) => `- ${c}`),
      "",
      'Respond with ONLY a JSON object, no prose: {"file": "<one of the candidates verbatim>", "anchor": "<optional existing selector in that file to place the new rule after>"}',
    ].join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-fable-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "placement LLM call failed; using deterministic fallback");
      return null;
    }
    const data = (await res.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const text = Array.isArray(data.content)
      ? data.content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
      : "";
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) return null;
    const parsed = PlacementResponseSchema.safeParse(JSON.parse(jsonMatch[0]));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "placement LLM call errored; using deterministic fallback",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Choose the placement for an add-rule change among candidate files
 * (workspace-relative). Returns null when there is nothing to choose from
 * (the change then goes to ApplyResult.needsPlacement).
 */
export async function choosePlacement(
  change: AddRuleChange,
  cfg: Config,
  candidates: string[],
  log: FastifyBaseLogger,
): Promise<PlacementDecision | null> {
  if (candidates.length === 0) return null;

  // LLM only when placement is genuinely ambiguous, and never in production.
  if (cfg.appEnv !== "production" && cfg.anthropicApiKey && candidates.length > 1) {
    const llm = await llmChoosePlacement(change, cfg.anthropicApiKey, candidates, log);
    if (llm && candidates.includes(llm.file)) {
      return { file: llm.file, anchor: llm.anchor, viaLlm: true };
    }
  }

  const fallback = candidates[0];
  return fallback ? { file: fallback, viaLlm: false } : null;
}
