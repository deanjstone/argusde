import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Not using vitest's `globals: true` mode (test files import describe/it/
// expect explicitly), so @testing-library/react's own auto-cleanup
// detection (which looks for a global afterEach) never fires — register it
// explicitly instead, or DOM from one component test leaks into the next.
afterEach(() => {
  cleanup();
});
