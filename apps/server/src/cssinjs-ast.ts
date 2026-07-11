import { parse as babelParse } from "@babel/parser";
import { SkipChangeError } from "./errors.js";

/**
 * apps/server/src/cssinjs-ast.ts — the babel primitives shared by BOTH
 * css-in-js writers: the tagged-template writer (cssinjs.ts) and the
 * object-syntax writer (cssinjs-object.ts). It lives in its own module so the
 * two writers can share a parser, node walker, and style-tag recognition
 * WITHOUT a require cycle (cssinjs.ts delegates to cssinjs-object.ts, so
 * cssinjs-object.ts must not import back from cssinjs.ts).
 */

/** The identifiers that name a css-in-js style block (tag OR call callee). */
export const STYLE_TAG_ROOTS = new Set([
  "styled",
  "css",
  "keyframes",
  "createGlobalStyle",
  "injectGlobal",
]);

export interface AnyNode {
  type?: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number }; end: { line: number } } | null;
  [key: string]: unknown;
}

/**
 * Walk from an identifier/member/call node down to the root identifier that
 * names it: `styled` in `styled.div`, `styled(Base)`, `styled.div.attrs(...)`,
 * `css` in `css`. Returns null for anything that doesn't bottom out at a bare
 * identifier.
 */
export function rootIdentifier(node: AnyNode | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    case "Identifier":
      return typeof node["name"] === "string" ? (node["name"] as string) : null;
    case "MemberExpression":
      return rootIdentifier(node["object"] as AnyNode);
    case "CallExpression":
      return rootIdentifier(node["callee"] as AnyNode);
    default:
      return null;
  }
}

/** Minimal, dependency-safe AST walker (babel node shapes). */
export function walk(node: unknown, cb: (n: AnyNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, cb);
    return;
  }
  const n = node as AnyNode;
  if (typeof n.type === "string") cb(n);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    walk(n[key], cb);
  }
}

/** Parse a module with the css-in-js parser config; SkipChangeError on failure. */
export function parseModule(code: string): ReturnType<typeof babelParse> {
  try {
    return babelParse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      errorRecovery: true,
    });
  } catch (err) {
    throw new SkipChangeError(
      `css-in-js source failed to parse: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}

/**
 * CORE INVARIANT: never persist source that does not re-parse. Every writer's
 * edits are byte-offset string splices, so in principle they can never touch
 * anything outside the target literal/object — but a pathological newValue
 * could still land in a JS expression position and break the file. Defensive
 * net: reparse (strict, no error recovery) before returning; throw
 * SkipChangeError (never write) on failure.
 */
export function assertReparses(code: string): void {
  try {
    babelParse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch (err) {
    throw new SkipChangeError(
      `refusing to write: edited source failed to re-parse (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }
}
