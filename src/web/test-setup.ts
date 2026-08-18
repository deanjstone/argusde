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

// jsdom implements neither of these, and Radix's overlay primitives need both
// — Popover measures its trigger to position itself, and its dismiss handling
// captures the pointer. Without them a component test of anything built on a
// popover dies with "ResizeObserver is not defined" long before it asserts
// anything. Minimal stand-ins rather than a polyfill dependency: the tests
// assert on content and interaction, never on geometry.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Guarded on `Element` existing at all: this setup file runs for the
// node-environment tests too (the server and utility suites), where touching
// a DOM global is a ReferenceError that takes the whole file down before a
// single test runs.
if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
