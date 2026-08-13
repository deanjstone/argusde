import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getServerUrl, setServerUrl, DEFAULT_SERVER_URL } from "./server-config.js";

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-server-config-"));
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("server-config", () => {
  it("returns the default server URL when no config file exists yet", () => {
    expect(getServerUrl(configDir)).toBe(DEFAULT_SERVER_URL);
  });

  it("round-trips a set server URL", () => {
    setServerUrl(configDir, "http://100.125.93.42:4870/");
    expect(getServerUrl(configDir)).toBe("http://100.125.93.42:4870/");
  });

  it("creates the config directory if it doesn't exist yet", () => {
    const nestedDir = path.join(configDir, "nested", "argusde");
    setServerUrl(nestedDir, "http://127.0.0.1:9999/");
    expect(getServerUrl(nestedDir)).toBe("http://127.0.0.1:9999/");
  });

  it("falls back to the default instead of throwing when the config file is corrupt", () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "{ not valid json");
    expect(getServerUrl(configDir)).toBe(DEFAULT_SERVER_URL);
  });

  it("falls back to the default when the config file has an unexpected shape", () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ somethingElse: true }));
    expect(getServerUrl(configDir)).toBe(DEFAULT_SERVER_URL);
  });
});
