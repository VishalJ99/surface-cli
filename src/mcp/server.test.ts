import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import type { SurfaceCliExecutor } from "./cli-runner.js";
import { createSurfaceMcpServer } from "./server.js";
import { surfaceToolDefinitions } from "./tool-definitions.js";

test("MCP server lists the reviewed tools and dispatches exact Surface argv", async () => {
  const calls: string[][] = [];
  const retryableFlags: Array<boolean | undefined> = [];
  const execute: SurfaceCliExecutor = async (argv, options) => {
    calls.push([...argv]);
    retryableFlags.push(options?.interruptionRetryable);
    return {
      payload: {
        schema_version: "1",
        command: argv.slice(0, 2).join("-"),
      },
      isError: false,
    };
  };
  const server = createSurfaceMcpServer(execute);
  const client = new Client({ name: "surface-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      surfaceToolDefinitions.map((definition) => definition.name),
    );
    assert.equal(listed.tools.length, 28);
    assert.ok(listed.tools.every((tool) => tool.outputSchema !== undefined));

    const result = await client.callTool({
      name: "surface_mail_search",
      arguments: { account: "personal", text: "receipt", limit: 3 },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      schema_version: "1",
      command: "mail-search",
    });
    assert.deepEqual(calls, [[
      "mail",
      "search",
      "--account=personal",
      "--text=receipt",
      "--limit=3",
    ]]);
    assert.deepEqual(retryableFlags, [true]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP server suppresses automatic retries for ambiguous write failures", async (t) => {
  for (const retryable of [true, false]) {
    await t.test(`Surface retryable=${retryable}`, async () => {
      const execute: SurfaceCliExecutor = async () => ({
        payload: {
          schema_version: "1",
          error: {
            code: "transport_error",
            message: "Provider refresh failed.",
            retryable,
            account: "personal",
            message_ref: null,
            thread_ref: null,
          },
        },
        isError: true,
      });
      const server = createSurfaceMcpServer(execute);
      const client = new Client({ name: "surface-mcp-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
          name: "surface_mail_send",
          arguments: {
            account: "personal",
            to: ["person@example.com"],
            subject: "Hello",
            body: "Hi",
            confirm: true,
          },
        });
        assert.equal(result.isError, true);
        const error = (result.structuredContent as {
          error: { code: string; retryable: boolean; message: string };
        }).error;
        assert.equal(error.code, "mcp_outcome_unknown");
        assert.equal(error.retryable, false);
        assert.match(error.message, /may have completed/i);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  await t.test("missing Surface error envelope", async () => {
    const execute: SurfaceCliExecutor = async () => ({
      payload: {
        schema_version: "1",
        command: "send",
        account: "personal",
      },
      isError: true,
    });
    const server = createSurfaceMcpServer(execute);
    const client = new Client({ name: "surface-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "surface_mail_send",
        arguments: {
          account: "personal",
          to: ["person@example.com"],
          subject: "Hello",
          body: "Hi",
          confirm: true,
        },
      });
      assert.equal(result.isError, true);
      const error = (result.structuredContent as {
        error: { code: string; retryable: boolean; message: string };
      }).error;
      assert.equal(error.code, "mcp_outcome_unknown");
      assert.equal(error.retryable, false);
      assert.match(error.message, /may have completed/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("MCP server avoids duplicating large structured results in text content", async () => {
  const marker = "large-body-marker";
  const execute: SurfaceCliExecutor = async () => ({
    payload: {
      schema_version: "1",
      command: "read",
      body: `${marker}${"x".repeat(20 * 1024)}`,
    },
    isError: false,
  });
  const server = createSurfaceMcpServer(execute);
  const client = new Client({ name: "surface-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "surface_account_list",
      arguments: {},
    });
    assert.equal((result.structuredContent as { body: string }).body.startsWith(marker), true);
    const text = result.content.find((entry) => entry.type === "text");
    assert.ok(text && text.type === "text");
    assert.doesNotMatch(text.text, new RegExp(marker));
    assert.match(text.text, /structuredContent/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP server rejects missing confirmation before invoking Surface", async () => {
  let invoked = false;
  const execute: SurfaceCliExecutor = async () => {
    invoked = true;
    return { payload: { schema_version: "1" }, isError: false };
  };
  const server = createSurfaceMcpServer(execute);
  const client = new Client({ name: "surface-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "surface_mail_send",
      arguments: {
        account: "personal",
        to: ["person@example.com"],
        subject: "Hello",
        body: "Hi",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(invoked, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP server preserves Surface error envelopes as tool errors", async () => {
  const execute: SurfaceCliExecutor = async () => ({
    payload: {
      schema_version: "1",
      error: {
        code: "writes_disabled",
        message: "Writes are disabled.",
        retryable: false,
        account: "personal",
        message_ref: null,
        thread_ref: null,
      },
    },
    isError: true,
  });
  const server = createSurfaceMcpServer(execute);
  const client = new Client({ name: "surface-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "surface_mail_send",
      arguments: {
        account: "personal",
        to: ["person@example.com"],
        subject: "Hello",
        body: "Hi",
        confirm: true,
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      schema_version: "1",
      error: {
        code: "writes_disabled",
        message: "Writes are disabled.",
        retryable: false,
        account: "personal",
        message_ref: null,
        thread_ref: null,
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP attachment download embeds only bounded files from Surface download roots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "surface-mcp-download-"));
  const downloads = join(root, "downloads");
  const outside = join(root, "outside");
  mkdirSync(downloads);
  mkdirSync(outside);
  const allowedPath = join(downloads, "att_1__report.txt");
  const outsidePath = join(outside, "att_1__report.txt");
  writeFileSync(allowedPath, "hello attachment", "utf8");
  writeFileSync(outsidePath, "outside", "utf8");

  const callDownload = async (savedTo: string, maxBytes: number, filename = "report.txt") => {
    const execute: SurfaceCliExecutor = async () => ({
      payload: {
        schema_version: "1",
        command: "attachment-download",
        account: "personal",
        message_ref: "msg_1",
        attachment: {
          attachment_id: "att_1",
          filename,
          mime_type: "text/plain",
          size_bytes: 16,
          inline: false,
          saved_to: savedTo,
        },
      },
      isError: false,
    });
    const server = createSurfaceMcpServer(execute, {
      downloadRoots: [downloads],
      maxEmbeddedAttachmentBytes: maxBytes,
    });
    const client = new Client({ name: "surface-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await client.callTool({
        name: "surface_attachment_download",
        arguments: { message_ref: "msg_1", attachment_id: "att_1", confirm: true },
      });
    } finally {
      await client.close();
      await server.close();
    }
  };

  try {
    await t.test("embeds a resource without exposing its local path in the URI", async () => {
      const result = await callDownload(allowedPath, 1024);
      assert.equal(result.isError, undefined);
      const resource = result.content.find((entry) => entry.type === "resource");
      assert.ok(resource && resource.type === "resource");
      assert.equal(resource.resource.mimeType, "text/plain");
      assert.ok("blob" in resource.resource);
      assert.equal(Buffer.from(resource.resource.blob, "base64").toString("utf8"), "hello attachment");
      assert.doesNotMatch(resource.resource.uri, new RegExp(root));
      const text = result.content.find((entry) => entry.type === "text");
      assert.ok(text && text.type === "text");
      assert.doesNotMatch(text.text, new RegExp(root));
      assert.deepEqual(
        (result.structuredContent as { mcp_attachment_delivery: unknown }).mcp_attachment_delivery,
        {
          status: "embedded",
          embedded: true,
          size_bytes: 16,
          mime_type: "text/plain",
          host_local_path_reported: true,
        },
      );
      assert.equal(
        Object.hasOwn(
          (result.structuredContent as { attachment: Record<string, unknown> }).attachment,
          "saved_to",
        ),
        false,
      );
    });

    await t.test("encodes malformed provider filenames without throwing", async () => {
      const result = await callDownload(allowedPath, 1024, "\ud800");
      assert.equal(result.isError, undefined);
      const resource = result.content.find((entry) => entry.type === "resource");
      assert.ok(resource && resource.type === "resource");
      assert.match(resource.resource.uri, /^surface-attachment:\/\/download\//u);
    });

    await t.test("leaves an oversized attachment host-local", async () => {
      const result = await callDownload(allowedPath, 3);
      assert.equal(result.isError, undefined);
      assert.equal(result.content.some((entry) => entry.type === "resource"), false);
      assert.equal(
        (result.structuredContent as {
          mcp_attachment_delivery: { reason: string };
        }).mcp_attachment_delivery.reason,
        "attachment_too_large",
      );
    });

    await t.test("refuses to read a path outside the Surface download root", async () => {
      const result = await callDownload(outsidePath, 1024);
      assert.equal(result.isError, undefined);
      assert.equal(
        (result.structuredContent as {
          mcp_attachment_delivery: { reason: string };
        }).mcp_attachment_delivery.reason,
        "download_path_not_allowed",
      );
      assert.equal(result.content.some((entry) => entry.type === "resource"), false);
      assert.equal(
        Object.hasOwn(
          (result.structuredContent as { attachment: Record<string, unknown> }).attachment,
          "saved_to",
        ),
        false,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
