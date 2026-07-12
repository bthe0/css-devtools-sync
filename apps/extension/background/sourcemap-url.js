// Pure sourceMappingURL extraction — no DOM, no chrome APIs, so it unit-tests.
//
// Why this exists: the CSSOM (`sheet.cssRules`) STRIPS the trailing
// `/*# sourceMappingURL=… */` comment, and an external `<link>` stylesheet has
// no `ownerNode.textContent` to read it back from. So for a linked dev sheet
// (Next serves CSS as `<link rel=stylesheet>`) the DevTools poller can only
// recover the map by fetching the sheet's bytes and scanning them with this.

/**
 * Return the sourceMappingURL from a compiled CSS body, or "" when absent.
 * Scans for the LAST occurrence (webpack/MiniCssExtract append it at the very
 * end; a rule value could contain the literal text earlier, so last wins).
 * @param {string} cssText raw stylesheet bytes (as served)
 * @returns {string}
 */
export function extractSourceMappingURL(cssText) {
  if (typeof cssText !== "string" || cssText.length === 0) return "";
  const re = /\/\*#\s*sourceMappingURL=([^\s*]+?)\s*\*\//g;
  let last = "";
  let m;
  while ((m = re.exec(cssText)) !== null) last = m[1];
  return last;
}
