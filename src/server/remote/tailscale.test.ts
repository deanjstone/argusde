import { describe, it, expect, vi } from "vitest";
import { checkTailscaleStatus, enableServe, disableServe } from "./tailscale.js";

const RUNNING_STATUS_JSON = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "lnv-lgn5-wsl.tail00500e.ts.net." },
});

describe("checkTailscaleStatus", () => {
  it("reports unavailable when the tailscale binary isn't found", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("ENOENT: spawn tailscale"));
    await expect(checkTailscaleStatus(exec)).resolves.toEqual({ available: false });
    expect(exec).toHaveBeenCalledWith(["status", "--json"]);
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

describe("enableServe", () => {
  it("publishes the given port via tailscale serve in the background", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "" });
    await enableServe(4870, exec);
    expect(exec).toHaveBeenCalledWith(["serve", "--bg", "--https=4870", "4870"]);
  });

  it("propagates a failure so the caller can decide how to handle it", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("tailscaled unreachable"));
    await expect(enableServe(4870, exec)).rejects.toThrow("tailscaled unreachable");
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
