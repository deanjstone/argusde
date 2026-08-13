import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:4870/";

interface ServerConfig {
  serverUrl: string;
}

function configFilePath(configDir: string): string {
  return path.join(configDir, "config.json");
}

/**
 * The persisted server-URL setting (spec #33 decision #5: a settings field
 * defaulting to localhost, not auto-discovered). `configDir` is a parameter
 * rather than hardcoded to `app.getPath("userData")` so this is testable
 * against a real temp directory without a running Electron instance.
 */
export function getServerUrl(configDir: string): string {
  try {
    const raw = fs.readFileSync(configFilePath(configDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    return typeof parsed.serverUrl === "string" ? parsed.serverUrl : DEFAULT_SERVER_URL;
  } catch {
    // No config file yet, or it's corrupt/unexpected shape — the default is
    // always a safe fallback, never a reason to crash startup.
    return DEFAULT_SERVER_URL;
  }
}

export function setServerUrl(configDir: string, serverUrl: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  const config: ServerConfig = { serverUrl };
  fs.writeFileSync(configFilePath(configDir), JSON.stringify(config, null, 2));
}
