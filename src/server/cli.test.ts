import { describe, it, expect } from "vitest";
import { parseServeArgs, shouldEnableTailscale } from "./cli.js";

describe("parseServeArgs", () => {
  it("defaults to 127.0.0.1:4870 with no flags, tailscale wiring on by default", () => {
    expect(parseServeArgs([])).toEqual({ host: "127.0.0.1", port: 4870, tailscale: true });
  });

  it("parses --host and --port overrides", () => {
    expect(parseServeArgs(["--host", "0.0.0.0", "--port", "9999"])).toEqual({
      host: "0.0.0.0",
      port: 9999,
      tailscale: true,
    });
  });

  it("accepts --port 0 (an OS-assigned ephemeral port) instead of falling back to the default", () => {
    expect(parseServeArgs(["--port", "0"])).toEqual({ host: "127.0.0.1", port: 0, tailscale: true });
  });

  it("ignores an unparseable --port value and keeps the default", () => {
    expect(parseServeArgs(["--port", "not-a-number"])).toEqual({ host: "127.0.0.1", port: 4870, tailscale: true });
  });

  it("parses --no-tailscale as an explicit opt-out", () => {
    expect(parseServeArgs(["--no-tailscale"])).toEqual({ host: "127.0.0.1", port: 4870, tailscale: false });
  });
});

describe("shouldEnableTailscale", () => {
  it("is true for the default host with tailscale wiring on", () => {
    expect(shouldEnableTailscale({ tailscale: true, host: "127.0.0.1" })).toBe(true);
  });

  it("is true for 'localhost' too", () => {
    expect(shouldEnableTailscale({ tailscale: true, host: "localhost" })).toBe(true);
  });

  it("is false when --no-tailscale was passed, regardless of host", () => {
    expect(shouldEnableTailscale({ tailscale: false, host: "127.0.0.1" })).toBe(false);
  });

  it("is false for a non-default host, even with tailscale wiring on — binding 0.0.0.0 on the same port defeats tailscaled's own listener", () => {
    expect(shouldEnableTailscale({ tailscale: true, host: "0.0.0.0" })).toBe(false);
  });
});
