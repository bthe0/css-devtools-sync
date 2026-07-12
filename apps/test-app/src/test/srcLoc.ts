// srcLoc.ts — read the off-DOM source location the source-locator plugin
// attaches. The plugin does NOT stamp `data-source-*` attributes (they'd
// pollute the Elements panel); it defines a non-enumerable `__srcLoc` property
// on the host node via a composed callback ref, exactly what the extension
// reads over CDP (`$0.__srcLoc`). Tests assert against that same contract.
import type { SrcLoc } from "@dev-sync/babel-plugin-source-locator/runtime";

/** The `__srcLoc` the plugin's runtime stashed on a host node, if instrumented. */
export function srcLoc(el: Element): SrcLoc | undefined {
  return (el as Element & { __srcLoc?: SrcLoc }).__srcLoc;
}

/** Every host element under `container` the plugin instrumented (has __srcLoc). */
export function instrumentedEls(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("*")).filter((el) => srcLoc(el) !== undefined);
}
