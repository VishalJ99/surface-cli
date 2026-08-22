#!/usr/bin/env node

import { join } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { loadProjectDotenv } from "./lib/dotenv.js";
import { createSurfaceCliExecutor } from "./mcp/cli-runner.js";
import { createSurfaceMcpServer } from "./mcp/server.js";

delete process.env.CONTROL_PLANE_API_KEY;
loadProjectDotenv();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const shutdownController = new AbortController();
const execute = createSurfaceCliExecutor({ shutdownSignal: shutdownController.signal });
const { config } = loadConfig();
const serverOptions = {
  downloadRoots: [join(config.cacheDir, "downloads")],
  maxEmbeddedAttachmentBytes: positiveInteger(
    process.env.SURFACE_MCP_MAX_EMBEDDED_ATTACHMENT_BYTES,
    5 * 1024 * 1024,
  ),
};

const handle = serveStdio(
  () => createSurfaceMcpServer(execute, serverOptions),
  {
    onerror: (error) => {
      process.stderr.write(`[surface-mcp] ${error.name}: ${error.message}\n`);
    },
  },
);

let closing = false;

async function close(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  shutdownController.abort();
  try {
    await handle.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[surface-mcp] shutdown failed: ${message}\n`);
  }
  process.exitCode = signal === "SIGINT" ? 130 : 143;
}

process.once("SIGINT", () => {
  void close("SIGINT");
});
process.once("SIGTERM", () => {
  void close("SIGTERM");
});
