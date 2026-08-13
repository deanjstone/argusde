#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4870;

export function parseServeArgs(argv: string[]): { host: string; port: number } {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host") {
      host = argv[++i] ?? host;
    } else if (argv[i] === "--port") {
      const raw = argv[++i];
      // `Number(raw) || port` would silently fall back to the default for
      // "--port 0" — 0 is a legitimate request for an OS-assigned ephemeral
      // port (the same pattern this codebase's own tests rely on).
      const parsed = raw === undefined ? NaN : Number(raw);
      if (!Number.isNaN(parsed)) port = parsed;
    }
  }
  return { host, port };
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand !== "serve") {
    console.error("Usage: argusde serve [--host <host>] [--port <port>]");
    process.exitCode = 1;
    return;
  }

  const { host, port } = parseServeArgs(rest);
  const dataDir = path.join(os.homedir(), ".argusde");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "argusde.sqlite");

  // dist/server/cli.js -> dist/web (vite.config.web.ts's outDir). Falls
  // back to serving nothing (404 for HTTP GETs, WS API still works) if the
  // web UI hasn't been built.
  const webDistDir = path.join(__dirname, "../web");

  const server = await startServer({ host, port, dbPath, webDistDir });
  console.log(`ArgusDE server listening on ws://${host}:${server.port}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await server.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run when executed directly (`node dist/server/cli.js ...` or the
// `argusde` bin) — not as a side effect of another module importing
// parseServeArgs, which would otherwise try to start a real server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
