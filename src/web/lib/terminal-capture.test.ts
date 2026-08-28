import { describe, it, expect } from "vitest";
import { CAPTURE_LIMITS, boundCapture, formatMessageWithCapture } from "./terminal-capture.js";

describe("boundCapture", () => {
  it("keeps short output exactly as the terminal printed it", () => {
    const capture = boundCapture("$ pnpm test\r\n636 passed\r\n", "output");

    expect(capture).toEqual({
      // Carriage returns are a terminal's business, not a message's — what
      // reaches the agent should read the way it looked.
      text: "$ pnpm test\n636 passed",
      lines: 2,
      truncated: false,
      source: "output",
    });
  });

  it("keeps the tail when there are more lines than the cap allows", () => {
    const raw = Array.from({ length: CAPTURE_LIMITS.maxLines + 50 }, (_, i) => `line ${i}`).join("\n");

    const capture = boundCapture(raw, "output");

    expect(capture.lines).toBe(CAPTURE_LIMITS.maxLines);
    expect(capture.truncated).toBe(true);
    // The end of a log is the part that says what went wrong.
    expect(capture.text.endsWith(`line ${CAPTURE_LIMITS.maxLines + 49}`)).toBe(true);
    expect(capture.text).not.toContain("line 0\n");
  });

  it("cuts to the byte cap even when the line count is within bounds", () => {
    const raw = Array.from({ length: 10 }, () => "x".repeat(4000)).join("\n");

    const capture = boundCapture(raw, "output");

    // Story 27: attaching a 40 MB log has to truncate visibly rather than
    // silently or catastrophically.
    expect(capture.text.length).toBeLessThanOrEqual(CAPTURE_LIMITS.maxBytes);
    expect(capture.truncated).toBe(true);
  });

  it("drops the blank tail a terminal buffer always ends with", () => {
    const capture = boundCapture("done\n\n\n   \n", "output");

    expect(capture.text).toBe("done");
    expect(capture.lines).toBe(1);
  });

  it("reports nothing to capture as empty rather than as a blank attachment", () => {
    expect(boundCapture("   \n\n", "selection").text).toBe("");
    expect(boundCapture("", "output").lines).toBe(0);
  });
});

describe("formatMessageWithCapture", () => {
  it("returns the message untouched when nothing was captured", () => {
    expect(formatMessageWithCapture("what broke?", null)).toBe("what broke?");
  });

  it("puts the output in a fenced block under the user's own words", () => {
    const message = formatMessageWithCapture("why did this fail?", boundCapture("npm ERR! code E404", "output"));

    expect(message).toBe(["why did this fail?", "", "Terminal output:", "```", "npm ERR! code E404", "```"].join("\n"));
  });

  it("names a selection as a selection, so the agent is not told it has the whole log", () => {
    const message = formatMessageWithCapture("", boundCapture("line one\nline two", "selection"));

    expect(message).toContain("Terminal selection:");
    expect(message.startsWith("Terminal selection:")).toBe(true);
  });

  it("says in the message itself when the capture was truncated", () => {
    const raw = Array.from({ length: CAPTURE_LIMITS.maxLines + 10 }, (_, i) => `line ${i}`).join("\n");

    const message = formatMessageWithCapture("fix this", boundCapture(raw, "output"));

    // The agent has to know it is looking at a tail. Without this it will
    // reason about "the whole output" and be wrong.
    expect(message).toContain(`last ${CAPTURE_LIMITS.maxLines} lines`);
    expect(message).toContain("earlier output omitted");
  });

  it("closes a fence that the captured text opened, so the block cannot swallow the rest of the message", () => {
    const message = formatMessageWithCapture("look", boundCapture("printing ``` in a log", "output"));

    // A backtick fence inside the output would end the block early and leak
    // the rest as prose — the fence has to be longer than anything inside it.
    const fence = message.split("\n").find((line) => /^`{3,}$/.test(line));
    expect(fence).toBeTruthy();
    expect(fence!.length).toBeGreaterThan(3);
    expect(message.split(fence!).length).toBe(3);
  });
});
