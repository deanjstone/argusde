import { describe, it, expect, vi } from "vitest";
import { checkTailscaleStatus, enableServe, disableServe, hasExistingMapping, createExec } from "./tailscale.js";

const RUNNING_STATUS_JSON = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "lnv-lgn5-wsl.tail00500e.ts.net." },
});

describe("createExec", () => {
  it("rejects a command that outlives the given timeout, instead of hanging forever", async () => {
    // A real subprocess (matches this repo's "real over mocked" testing
    // convention) — `sleep 5` deliberately outlives a much shorter timeout.
    const exec = createExec("sleep", 100);
    await expect(exec(["5"])).rejects.toThrow();
  });

  it("resolves normally for a command that finishes within the timeout", async () => {
    const exec = createExec("echo", 5000);
    await expect(exec(["hello"])).resolves.toMatchObject({ stdout: "hello\n" });
  });
});

describe("checkTailscaleStatus", () => {
  it("reports unavailable when the tailscale binary isn't found", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("ENOENT: spawn tailscale"));
    await expect(checkTailscaleStatus(exec)).resolves.toEqual({ available: false });
    expect(exec).toHaveBeenCalledWith(["status", "--json"]);
  });

  it("logs the underlying reason rather than swallowing it silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const exec = vi.fn().mockRejectedValue(new Error("ENOENT: spawn tailscale"));
    await checkTailscaleStatus(exec);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENOENT: spawn tailscale"));
    warn.mockRestore();
  });

  it("reports unavailable when tailscaled is installed but not running", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ BackendState: "Stopped" }) });
    await expect(checkTailscaleStatus(exec)).resolves.toEqual({ available: false });
  });

  it("reports available with the DNS name (trailing dot stripped) when running", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: RUNNING_STATUS_JSON });
    await expect(checkTailscaleStatus(exec)).resolves.toEqual({
      available: true,
      dnsName: "lnv-lgn5-wsl.tail00500e.ts.net",
    });
  });

  it("reports unavailable on malformed JSON rather than throwing", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "not json" });
    await expect(checkTailscaleStatus(exec)).resolves.toEqual({ available: false });
  });
});

describe("hasExistingMapping", () => {
  it("is true when the port already has a serve mapping", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ TCP: { "8787": { HTTPS: true } } }) });
    await expect(hasExistingMapping(8787, exec)).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith(["serve", "status", "--json"]);
  });

  it("is false when the port has no mapping", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ TCP: { "8787": { HTTPS: true } } }) });
    await expect(hasExistingMapping(4870, exec)).resolves.toBe(false);
  });

  it("is false when there is no serve config at all", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify({}) });
    await expect(hasExistingMapping(4870, exec)).resolves.toBe(false);
  });

  it("fails safe (true) when the status query itself fails — can't verify, so don't risk clobbering", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("tailscaled unreachable"));
    await expect(hasExistingMapping(4870, exec)).resolves.toBe(true);
  });

  it("fails safe (true) on malformed JSON", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "not json" });
    await expect(hasExistingMapping(4870, exec)).resolves.toBe(true);
  });
});

describe("enableServe", () => {
  it("publishes the given port via tailscale serve in the background", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    await enableServe(4870, "127.0.0.1", exec);
    expect(exec).toHaveBeenCalledWith(["serve", "--bg", "--https=4870", "4870"]);
  });

  it("accepts 'localhost' as an equivalent loopback host", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    await enableServe(4870, "localhost", exec);
    expect(exec).toHaveBeenCalledWith(["serve", "--bg", "--https=4870", "4870"]);
  });

  it("refuses a non-loopback host without ever calling exec — the safety invariant travels with the function, not just the caller", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    await expect(enableServe(4870, "0.0.0.0", exec)).rejects.toThrow(/loopback/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("propagates a failure so the caller can decide how to handle it", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("tailscaled unreachable"));
    await expect(enableServe(4870, "127.0.0.1", exec)).rejects.toThrow("tailscaled unreachable");
  });
});

describe("disableServe", () => {
  it("turns off only the mapping for the given port", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    await disableServe(4870, exec);
    expect(exec).toHaveBeenCalledWith(["serve", "--https=4870", "off"]);
  });

  it("propagates a failure so the caller can decide how to handle it", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("tailscaled unreachable"));
    await expect(disableServe(4870, exec)).rejects.toThrow("tailscaled unreachable");
  });
});
