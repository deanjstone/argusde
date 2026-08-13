import { describe, it, expect } from "vitest";
import { parseServeArgs } from "./cli.js";

describe("parseServeArgs", () => {
  it("defaults to 127.0.0.1:4870 with no flags", () => {
    expect(parseServeArgs([])).toEqual({ host: "127.0.0.1", port: 4870 });
  });

  it("parses --host and --port overrides", () => {
    expect(parseServeArgs(["--host", "0.0.0.0", "--port", "9999"])).toEqual({ host: "0.0.0.0", port: 9999 });
  });

  it("accepts --port 0 (an OS-assigned ephemeral port) instead of falling back to the default", () => {
    expect(parseServeArgs(["--port", "0"])).toEqual({ host: "127.0.0.1", port: 0 });
  });

  it("ignores an unparseable --port value and keeps the default", () => {
    expect(parseServeArgs(["--port", "not-a-number"])).toEqual({ host: "127.0.0.1", port: 4870 });
  });
});
