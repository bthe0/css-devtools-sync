import { test, expect } from "../fixtures";

// The bundler plugin (@dev-sync/vite / @dev-sync/webpack) mounts the apply
// engine on the page's own origin under /__dev-sync/*. Hit it against the live
// dev server to prove the mount is wired — the handler.test.ts unit drives the
// same engine over an in-memory socket; this proves it over the real HTTP stack.
test("mounts the apply engine on the page origin", async ({ request }) => {
  const res = await request.get("/__dev-sync/journal");
  expect(res.status()).toBe(200);

  const body = await res.json();
  // Don't assert emptiness — the journal is global per origin and other tests
  // in this run may have seeded it; the contract is a JournalList shape.
  expect(Array.isArray(body.entries)).toBe(true);
});
