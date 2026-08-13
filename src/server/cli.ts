#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import qrcodeTerminal from "qrcode-terminal";
import { WS_PATH } from "../shared/ws-protocol.js";
import { startServer } from "./index.js";
import { checkTailscaleStatus, enableServe, disableServe } from "./remote/tailscale.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4870;

export function parseServeArgs(argv: string[]): { host: string; port: number; tailscale: boolean } {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let tailscale = true;
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
    } else if (argv[i] === "--no-tailscale") {
      tailscale = false;
    }
  }
  return { host, port, tailscale };
}

/**
 * A non-default `--host` means the server (and thus tailscaled's own
 * proxy target) isn't bound to 127.0.0.1 — binding 0.0.0.0 on the same
 * port tailscale serve wants to claim makes tailscaled silently fail to
 * grab the tailnet listener (TLS resets, no clear error), so Tailscale
 * wiring is skipped rather than attempted and failing confusingly.
 */
export function shouldEnableTailscale(options: { tailscale: boolean; host: string }): boolean {
  return options.tailscale && (options.host === "127.0.0.1" || options.host === "localhost");
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand !== "serve") {
    console.error("Usage: argusde serve [--host <host>] [--port <port>] [--no-tailscale]");
    process.exitCode = 1;
    return;
  }

  const { host, port, tailscale } = parseServeArgs(rest);
  const dataDir = path.join(os.homedir(), ".argusde");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "argusde.sqlite");

  // dist/server/cli.js -> dist/web (vite.config.web.ts's outDir). Falls
  // back to serving nothing (404 for HTTP GETs, WS API still works) if the
  // web UI hasn't been built.
  const webDistDir = path.join(__dirname, "../web");

  const server = await startServer({ host, port, dbPath, webDistDir });
  console.log(`ArgusDE server listening at http://${host}:${server.port}/ (WebSocket API at ws://${host}:${server.port}${WS_PATH})`);

  let tailscaleEnabled = false;
  if (shouldEnableTailscale({ tailscale, host })) {
    const status = await checkTailscaleStatus();
    if (status.available) {
      try {
        await enableServe(server.port);
        tailscaleEnabled = true;
        const url = `https://${status.dnsName}:${server.port}/`;
        console.log(`Remote access via Tailscale: ${url}`);
        qrcodeTerminal.generate(url, { small: true });
      } catch (err) {
        // Tailscale wiring is a bonus, not a requirement — local/LAN access
        // via the status line above already works regardless.
        console.warn(`Tailscale serve setup failed, continuing with local access only: ${(err as Error).message}`);
      }
    } else {
      console.log('Tailscale not detected — remote access unavailable. Run "tailscale up" to enable it.');
    }
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      if (tailscaleEnabled) {
        await disableServe(server.port).catch((err: Error) => {
          console.warn(`Failed to clean up tailscale serve mapping: ${err.message}`);
        });
      }
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
