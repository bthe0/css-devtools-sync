/// <reference lib="dom" />
// runtime.ts — injected into transformed app modules by the source-locator
// Babel plugin. Runs in the BROWSER (dev only). Instead of stamping DOM
// attributes, we attach the source location as a NON-attribute JS property
// (`__srcLoc`) on the host DOM node via a callback ref. The property is
// invisible in the Elements panel but readable from the page's main world by
// `inspectedWindow.eval` ($0.__srcLoc) and over CDP (Runtime.callFunctionOn).
//
// The ref is composed with any ref the element already had, so instrumentation
// never clobbers application behavior.

/** Shape stashed on the node — matches ElementContext's source fields. */
export interface SrcLoc {
  dataSourceFile: string;
  dataSourceLine: number;
  dataSourceComponent?: string;
}

type UserRef =
  | ((node: Element | null) => void | (() => void))
  | { current: Element | null }
  | null
  | undefined;

/**
 * Build a callback ref that records `{file, line, component}` on the mounted
 * node and forwards to `userRef` (callback or object ref). React 19 cleanup
 * semantics are preserved: if the user's callback returns a cleanup function we
 * return it (React then drives cleanup and won't call us with null); otherwise
 * we fall back to legacy null-on-unmount behavior.
 */
export function __srcLocRef(
  file: string,
  line: number,
  component: string | null,
  userRef?: UserRef,
): (node: Element | null) => void | (() => void) {
  return (node: Element | null) => {
    if (node) {
      const loc: SrcLoc = { dataSourceFile: file, dataSourceLine: line };
      if (component) loc.dataSourceComponent = component;
      try {
        // Non-enumerable so it never shows up in for..in / spreads / devtools
        // property lists that enumerate own keys.
        Object.defineProperty(node, "__srcLoc", {
          value: loc,
          configurable: true,
          enumerable: false,
          writable: true,
        });
      } catch {
        // Frozen/exotic node — best effort, skip.
      }
    }

    if (typeof userRef === "function") {
      const cleanup = userRef(node);
      return typeof cleanup === "function" ? cleanup : undefined;
    }
    if (userRef && typeof userRef === "object") {
      userRef.current = node;
    }
    return undefined;
  };
}
