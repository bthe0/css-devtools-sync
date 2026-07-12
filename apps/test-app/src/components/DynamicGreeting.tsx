/**
 * Tier: dynamic markup (mixed static text + {expression} holes).
 * The <p> below interleaves literal text runs with runtime values, so the
 * whole-body `set-text` op deliberately refuses it. Instead the /describe
 * endpoint enumerates its children into editable static runs vs read-only
 * dynamic holes, and `set-text-segment` edits ONE static run by index (via a
 * surgical source-range splice, preserving every other byte) while leaving
 * every {expression} untouched — resolved via the __srcLoc source location the
 * source-locator babel plugin stamps at build time.
 */
export function DynamicGreeting({ name, count }: { name: string; count: number }) {
  return (
    <p className="greeting">Hello {name}, you have {count} messages!</p>
  );
}
