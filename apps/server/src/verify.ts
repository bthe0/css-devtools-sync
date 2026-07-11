import type { VerifyRequest, VerifyResult } from "@css-sync/contract";

/** Light normalization so cosmetic differences don't count as mismatches. */
function normalizeCssValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/,\s+/g, ",")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

/**
 * Compare expected vs actual computed values reported by the extension after
 * the apply round-trip (HMR/reload). Empty checks[] verifies trivially.
 */
export function verifyChecks(request: VerifyRequest): VerifyResult {
  const mismatches = request.checks.filter(
    (c) => normalizeCssValue(c.expected) !== normalizeCssValue(c.actual),
  );
  return { ok: mismatches.length === 0, mismatches };
}
