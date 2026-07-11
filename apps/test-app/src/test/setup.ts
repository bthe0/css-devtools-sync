import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// RTL's auto-cleanup only self-registers when it detects global test hooks
// (vitest `globals: true`). We run without globals, so unmount explicitly —
// otherwise each test in a file renders on top of the previous one's DOM.
afterEach(() => {
  cleanup();
});
