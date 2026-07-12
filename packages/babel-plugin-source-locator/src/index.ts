import path from "node:path";
import type { NodePath, PluginObj, PluginPass } from "@babel/core";
import { addNamed } from "@babel/helper-module-imports";
import type * as t from "@babel/types";
// @ts-expect-error -- no bundled types for the syntax plugin
import syntaxJsxImport from "@babel/plugin-syntax-jsx";

// `@babel/plugin-syntax-jsx` is CJS (`exports.default = declare(...)`). Under
// native Node ESM (how Vite loads this package's compiled dist/*.js), a
// default import binds the whole `module.exports` object — not its
// `.default` property — so `syntaxJsxImport` here is `{ default: fn }`, not
// `fn`. Unwrap explicitly; this also stays correct under bundlers/ts-node
// that already give the function directly.
const syntaxJsx: unknown =
  typeof syntaxJsxImport === "function"
    ? syntaxJsxImport
    : (syntaxJsxImport as { default?: unknown }).default;

/** Bare specifier of the browser runtime whose `__srcLocRef` we inject. */
const RUNTIME_SOURCE = "@dev-sync/babel-plugin-source-locator/runtime";

export interface SourceLocatorOptions {
  /** Project root; emitted file paths are relative to this. Defaults to process.cwd(). */
  root?: string;
}

type BabelApi = {
  types: typeof t;
  assertVersion: (v: number) => void;
};

/** True for host (lowercase intrinsic) elements like <div>, not <MyComponent> or <foo.bar>. */
const isHostElement = (name: t.JSXOpeningElement["name"]): name is t.JSXIdentifier =>
  name.type === "JSXIdentifier" && /^[a-z]/.test(name.name);

/** Nearest enclosing component/function name, walking out of anonymous wrappers. */
const enclosingComponentName = (openingPath: NodePath<t.JSXOpeningElement>): string | null => {
  let fn = openingPath.getFunctionParent();
  while (fn) {
    const node = fn.node;
    if (node.type === "FunctionDeclaration" && node.id) return node.id.name;
    if (
      (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
      fn.parentPath?.node.type === "VariableDeclarator" &&
      fn.parentPath.node.id.type === "Identifier"
    ) {
      return fn.parentPath.node.id.name;
    }
    if (node.type === "ClassMethod" && node.key.type === "Identifier") return node.key.name;
    if (node.type === "ObjectMethod" && node.key.type === "Identifier") return node.key.name;
    fn = fn.getFunctionParent();
  }
  return null;
};

/** The `ref` JSXAttribute on this element, if it has a static one. */
const findRefAttribute = (node: t.JSXOpeningElement): t.JSXAttribute | undefined =>
  node.attributes.find(
    (attr): attr is t.JSXAttribute =>
      attr.type === "JSXAttribute" &&
      attr.name.type === "JSXIdentifier" &&
      attr.name.name === "ref",
  );

export default function sourceLocatorBabelPlugin(api: BabelApi): PluginObj<
  PluginPass & { opts: SourceLocatorOptions }
> {
  api.assertVersion(7);
  const t_ = api.types;

  // DEV ONLY: no-op in production builds.
  if (process.env.NODE_ENV === "production") {
    return { name: "source-locator", visitor: {} };
  }

  return {
    name: "source-locator",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unwrapped CJS default, see comment above
    inherits: syntaxJsx as any,
    visitor: {
      JSXOpeningElement(openingPath, state) {
        const node = openingPath.node;
        if (!isHostElement(node.name)) return;
        if (!node.loc) return;

        const filename = state.filename;
        if (!filename) return;

        const root = state.opts.root ?? state.cwd ?? process.cwd();
        const relFile = path.relative(root, filename).split(path.sep).join("/");
        const component = enclosingComponentName(openingPath);

        // Import the runtime helper ONCE per module (addNamed itself does not
        // dedupe — cache the local name in plugin state and reuse it).
        let helperName = state.get("srcLocHelperName") as string | undefined;
        if (!helperName) {
          helperName = addNamed(openingPath, "__srcLocRef", RUNTIME_SOURCE).name;
          state.set("srcLocHelperName", helperName);
        }
        const helper = t_.identifier(helperName);

        const args: t.Expression[] = [
          t_.stringLiteral(relFile),
          t_.numericLiteral(node.loc.start.line),
          component ? t_.stringLiteral(component) : t_.nullLiteral(),
        ];

        // Compose with an existing ref (thread it through as the 4th arg) and
        // drop the original so the element ends up with exactly one ref.
        const existingRef = findRefAttribute(node);
        if (existingRef?.value?.type === "JSXExpressionContainer") {
          if (existingRef.value.expression.type !== "JSXEmptyExpression") {
            args.push(existingRef.value.expression);
          }
          node.attributes = node.attributes.filter((a) => a !== existingRef);
        } else if (existingRef) {
          // A non-expression ref (e.g. a string) is invalid/unusual; leave the
          // element untouched rather than risk mangling it.
          return;
        }

        const refAttr = t_.jsxAttribute(
          t_.jsxIdentifier("ref"),
          t_.jsxExpressionContainer(t_.callExpression(helper, args)),
        );

        // Place our ref BEFORE the first spread so a runtime spread-provided ref
        // wins (React uses the last-specified ref). Elements whose ref arrives
        // only via such a spread will not receive __srcLoc — a documented,
        // dev-only limitation.
        const firstSpread = node.attributes.findIndex(
          (a) => a.type === "JSXSpreadAttribute",
        );
        if (firstSpread === -1) {
          node.attributes.push(refAttr);
        } else {
          node.attributes.splice(firstSpread, 0, refAttr);
        }
      },
    },
  };
}
