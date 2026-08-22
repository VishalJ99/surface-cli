import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("built stdio server completes an isolated real Surface CLI round trip", async () => {
  const isolatedDir = mkdtempSync(join(tmpdir(), "surface-mcp-stdio-"));
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const entrypoint = join(repositoryRoot, "dist", "mcp-server.js");
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: isolatedDir,
    env: {
      ...inheritedEnv,
      SURFACE_CONFIG_PATH: join(isolatedDir, "config.toml"),
      SURFACE_CACHE_DIR: join(isolatedDir, "state"),
      SURFACE_WRITES_ENABLED: "0",
      SURFACE_MCP_ATTACHMENT_ROOTS: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "surface-mcp-stdio-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 28);

    const result = await client.callTool({
      name: "surface_account_list",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      schema_version: "1",
      command: "account-list",
      accounts: [],
    });
  } finally {
    await client.close();
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});
