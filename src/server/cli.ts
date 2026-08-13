#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./index.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4870;

function parseServeArgs(argv: string[]): { host: string; port: number } {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host") host = argv[++i] ?? host;
    else if (argv[i] === "--port") port = Number(argv[++i]) || port;
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

  const server = await startServer({ host, port, dbPath });
  console.log(`ArgusDE server listening on ws://${host}:${server.port}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
