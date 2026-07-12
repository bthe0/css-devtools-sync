// transform.ts — `dev-sync init` AST edits on a vite config (recast-preserving).
//
// Two idempotent, fail-closed edits over the default-exported config object:
//   1. prepend a devSync() plugin + its import (@dev-sync/vite) — the drop-in
//      that boots the CSS sourcemap, mounts the apply engine on the dev server,
//      and stamps JSX host elements. Creates a plugins array if none exists.
//   2. inject emotion / styled-components babel plugins into react()'s babel
//      (React-only css-in-js labels; devSync doesn't touch those).
//
// Contract:
//   - Never emit source that fails to re-parse (corruption guard throws Skip).
//   - Idempotent: when nothing needs adding, returns the input string verbatim.
//   - A sub-edit that can't be applied safely (e.g. no react() call) is a
//     WARNING, not a throw — except when the top-level config object itself
//     can't be located or a targeted value has an unexpected shape, which is a
//     hard SkipChangeError (we refuse to guess and corrupt user config).
//
// Mirrors the recast + @babel/parser round-trip idiom in apply-jsx.ts, and the
// duck-typed AnyNode shapes used across classlist.ts / cssinjs-ast.ts (keeps
// @babel/types out of the direct dependency set).
import * as recast from "recast";
import { parse as babelParse } from "@babel/parser";
import { SkipChangeError } from "../errors.js";

const b = recast.types.builders;

const recastBabelParser = {
  parse: (source: string) =>
    babelParse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      tokens: true,
    }),
};

export interface InitTransformPlan {
  /** Prepend devSync() (+ its @dev-sync/vite import) — the drop-in engine plugin. */
  readonly devSync: boolean;
  /** Inject @emotion/babel-plugin into react()'s babel.plugins. */
  readonly emotion: boolean;
  /** Inject babel-plugin-styled-components into react()'s babel.plugins. */
  readonly styledComponents: boolean;
}

export interface TransformResult {
  /** New config source, or the input verbatim when nothing changed. */
  readonly source: string;
  /** True iff at least one edit was applied. */
  readonly changed: boolean;
  /** Human notes for sub-edits that couldn't be auto-applied (manual TODO). */
  readonly warnings: string[];
}

// Duck-typed AST node — same minimal shape used elsewhere in the codebase.
interface AnyNode {
  type?: string;
  [key: string]: unknown;
}

const DEV_SYNC_MODULE = "@dev-sync/vite";

// --- small AST helpers -----------------------------------------------------

/** Name of an object-property key, whether it's an Identifier or StringLiteral. */
function keyName(prop: AnyNode): string | undefined {
  const k = prop.key as AnyNode | undefined;
  if (!k) return undefined;
  if (k.type === "Identifier") return k.name as string;
  if (k.type === "StringLiteral") return k.value as string;
  return undefined;
}

/** First own ObjectProperty of `obj` whose key is `name`. */
function findProp(obj: AnyNode, name: string): AnyNode | undefined {
  const props = (obj.properties as AnyNode[] | undefined) ?? [];
  return props.find((p) => p.type === "ObjectProperty" && keyName(p) === name);
}

function objProp(key: string, value: unknown): AnyNode {
  return b.objectProperty(b.identifier(key), value as never) as unknown as AnyNode;
}

/** Does the plugins/babel-plugins array already contain an entry for `name`? */
function hasPluginNamed(elements: AnyNode[], name: string): boolean {
  return elements.some((el) => {
    if (!el) return false;
    if (el.type === "StringLiteral") return el.value === name;
    if (el.type === "ArrayExpression") {
      const first = (el.elements as AnyNode[] | undefined)?.[0];
      return first?.type === "StringLiteral" && first.value === name;
    }
    return false;
  });
}

/** `["<name>", { ...opts }]` tuple entry for a babel plugin. */
function babelPluginEntry(name: string, opts: Record<string, string | boolean>): AnyNode {
  const props = Object.entries(opts).map(([k, v]) =>
    objProp(k, typeof v === "boolean" ? b.booleanLiteral(v) : b.stringLiteral(v)),
  );
  return b.arrayExpression([
    b.stringLiteral(name),
    b.objectExpression(props as never),
  ]) as unknown as AnyNode;
}

// --- config-object discovery (hard fail-closed) ----------------------------

/**
 * The ObjectExpression init edits: `export default { ... }` or
 * `export default defineConfig({ ... })`. Anything else (function arg, spread,
 * a call whose first arg isn't an object literal, no default export) is a hard
 * SkipChangeError — we refuse to guess.
 */
function findConfigObject(program: AnyNode): AnyNode {
  const body = (program.body as AnyNode[] | undefined) ?? [];
  const exp = body.find((n) => n.type === "ExportDefaultDeclaration");
  if (!exp) {
    throw new SkipChangeError("no `export default` in the vite config — add the settings manually");
  }
  const decl = exp.declaration as AnyNode;
  let obj: AnyNode | undefined;
  if (decl.type === "ObjectExpression") {
    obj = decl;
  } else if (decl.type === "CallExpression") {
    const arg0 = (decl.arguments as AnyNode[] | undefined)?.[0];
    if (arg0?.type === "ObjectExpression") obj = arg0;
  }
  if (!obj) {
    throw new SkipChangeError(
      "the default export isn't a plain config object — add css.devSourcemap / babel plugins manually",
    );
  }
  return obj;
}

// --- individual edits (each returns whether it mutated the AST) -------------

/**
 * Prepend `devSync()` to the config's plugins array (creating the array if the
 * config has none) and add `import { devSync } from "@dev-sync/vite"`. devSync()
 * is the drop-in: it enables the CSS dev sourcemap, mounts the apply engine on
 * the dev server, and stamps JSX — so init no longer writes those individually.
 */
function ensureDevSyncPlugin(program: AnyNode, obj: AnyNode, warnings: string[]): boolean {
  let mutated = false;

  let pluginsArr: AnyNode;
  const pluginsProp = findProp(obj, "plugins");
  if (!pluginsProp) {
    pluginsArr = b.arrayExpression([]) as unknown as AnyNode;
    (obj.properties as AnyNode[]).push(objProp("plugins", pluginsArr));
    mutated = true;
  } else {
    const pv = pluginsProp.value as AnyNode;
    if (pv.type !== "ArrayExpression") {
      warnings.push("`plugins` isn't an array literal — add devSync() to it manually");
      return mutated;
    }
    pluginsArr = pv;
  }

  const elements = pluginsArr.elements as AnyNode[];
  const alreadyPlugin = elements.some(
    (el) =>
      el?.type === "CallExpression" &&
      (el.callee as AnyNode | undefined)?.type === "Identifier" &&
      (el.callee as AnyNode).name === "devSync",
  );
  if (!alreadyPlugin) {
    elements.unshift(b.callExpression(b.identifier("devSync"), []) as unknown as AnyNode);
    mutated = true;
  }

  const body = program.body as AnyNode[];
  const hasImport = body.some(
    (n) => n.type === "ImportDeclaration" && (n.source as AnyNode | undefined)?.value === DEV_SYNC_MODULE,
  );
  if (!hasImport) {
    const decl = b.importDeclaration(
      [b.importSpecifier(b.identifier("devSync"))],
      b.stringLiteral(DEV_SYNC_MODULE),
    ) as unknown as AnyNode;
    let lastImport = -1;
    body.forEach((n, i) => {
      if (n.type === "ImportDeclaration") lastImport = i;
    });
    body.splice(lastImport + 1, 0, decl);
    mutated = true;
  }
  return mutated;
}

function ensureBabelPlugins(obj: AnyNode, entries: { name: string; node: AnyNode }[], warnings: string[]): boolean {
  const pluginsProp = findProp(obj, "plugins");
  const pluginsVal = pluginsProp?.value as AnyNode | undefined;
  if (!pluginsVal || pluginsVal.type !== "ArrayExpression") {
    warnings.push("no plugins array found — add the react() babel plugins manually");
    return false;
  }
  const reactCall = (pluginsVal.elements as AnyNode[]).find(
    (el) =>
      el?.type === "CallExpression" &&
      (el.callee as AnyNode | undefined)?.type === "Identifier" &&
      (el.callee as AnyNode).name === "react",
  );
  if (!reactCall) {
    warnings.push("no react() call in plugins — add the babel plugins to @vitejs/plugin-react manually");
    return false;
  }

  const args = reactCall.arguments as AnyNode[];
  let mutated = false;
  let argObj = args[0];
  if (!argObj) {
    argObj = b.objectExpression([]) as unknown as AnyNode;
    args.push(argObj);
    mutated = true;
  }
  if (argObj.type !== "ObjectExpression") {
    warnings.push("react() argument isn't an object literal — add the babel plugins manually");
    return mutated;
  }

  let babelObj: AnyNode;
  const babelProp = findProp(argObj, "babel");
  if (!babelProp) {
    babelObj = b.objectExpression([]) as unknown as AnyNode;
    (argObj.properties as AnyNode[]).push(objProp("babel", babelObj));
  } else {
    const bv = babelProp.value as AnyNode;
    if (bv.type !== "ObjectExpression") {
      warnings.push("react() babel option isn't an object literal — add the plugins manually");
      return mutated;
    }
    babelObj = bv;
  }

  let bpArr: AnyNode;
  const bpProp = findProp(babelObj, "plugins");
  if (!bpProp) {
    bpArr = b.arrayExpression([]) as unknown as AnyNode;
    (babelObj.properties as AnyNode[]).push(objProp("plugins", bpArr));
  } else {
    const av = bpProp.value as AnyNode;
    if (av.type !== "ArrayExpression") {
      warnings.push("react() babel.plugins isn't an array literal — add the plugins manually");
      return mutated;
    }
    bpArr = av;
  }

  const elements = bpArr.elements as AnyNode[];
  for (const entry of entries) {
    if (!hasPluginNamed(elements, entry.name)) {
      elements.push(entry.node);
      mutated = true;
    }
  }
  return mutated;
}

// --- public entry ----------------------------------------------------------

export function transformViteConfig(source: string, plan: InitTransformPlan): TransformResult {
  const ast = recast.parse(source, { parser: recastBabelParser });
  const program = ast.program as AnyNode;
  const obj = findConfigObject(program); // hard fail-closed on unrecognized shape

  const warnings: string[] = [];
  let changed = false;

  if (plan.devSync) changed = ensureDevSyncPlugin(program, obj, warnings) || changed;

  const entries: { name: string; node: AnyNode }[] = [];
  if (plan.emotion) {
    entries.push({
      name: "@emotion/babel-plugin",
      node: babelPluginEntry("@emotion/babel-plugin", {
        sourceMap: true,
        autoLabel: "always",
        labelFormat: "[dirname]--[local]",
      }),
    });
  }
  if (plan.styledComponents) {
    entries.push({
      name: "babel-plugin-styled-components",
      node: babelPluginEntry("babel-plugin-styled-components", {
        displayName: true,
        fileName: true,
        ssr: false,
        sourceMap: true,
      }),
    });
  }
  if (entries.length > 0) changed = ensureBabelPlugins(obj, entries, warnings) || changed;

  if (!changed) return { source, changed: false, warnings };

  const printed = recast.print(ast).code;
  try {
    recastBabelParser.parse(printed); // corruption guard — never write unparseable config
  } catch (err) {
    throw new SkipChangeError(
      `init produced unparseable config (${(err as Error).message}) — no changes written`,
    );
  }
  return { source: printed, changed: true, warnings };
}
