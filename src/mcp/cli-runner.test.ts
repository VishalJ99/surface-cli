import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";
import test from "node:test";

import { createSurfaceCliExecutor } from "./cli-runner.js";

function fixture(source: string): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), "surface-mcp-runner-"));
  const script = join(dir, "fixture.mjs");
  writeFileSync(script, source, "utf8");
  return { dir, script };
}

test("runner preserves argv values and parses the Surface envelope", async () => {
  const { dir, script } = fixture(`
    process.stdout.write(JSON.stringify({schema_version:"1", argv:process.argv.slice(2)}));
  `);
  try {
    const execute = createSurfaceCliExecutor({ cliPath: script, cwd: dir });
    const result = await execute(["mail", "search", "personal", "--text=$(touch nope); *"]);
    assert.equal(result.isError, false);
    assert.deepEqual(result.payload.argv, ["mail", "search", "personal", "--text=$(touch nope); *"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner preserves a Surface JSON error envelope", async () => {
  const { dir, script } = fixture(`
    process.stdout.write(JSON.stringify({schema_version:"1",error:{code:"write_disabled",message:"no",retryable:false,account:null,message_ref:null,thread_ref:null}}));
    process.exitCode = 1;
  `);
  try {
    const execute = createSurfaceCliExecutor({ cliPath: script, cwd: dir });
    const result = await execute(["mail", "send"]);
    assert.equal(result.isError, true);
    assert.equal((result.payload.error as { code: string }).code, "write_disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner bounds malformed output, timeouts, and oversized stdout", async (t) => {
  await t.test("malformed JSON", async () => {
    const { dir, script } = fixture(`process.stdout.write("not json");`);
    try {
      const result = await createSurfaceCliExecutor({ cliPath: script, cwd: dir })([]);
      assert.equal((result.payload.error as { code: string }).code, "surface_cli_invalid_json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("timeout", async () => {
    const { dir, script } = fixture(`setTimeout(() => {}, 10_000);`);
    try {
      const result = await createSurfaceCliExecutor({
        cliPath: script,
        cwd: dir,
        timeoutMs: 30,
        terminateGraceMs: 10,
      })([]);
      assert.equal((result.payload.error as { code: string }).code, "mcp_outcome_unknown");
      assert.equal((result.payload.error as { retryable: boolean }).retryable, false);

      const retryable = await createSurfaceCliExecutor({
        cliPath: script,
        cwd: dir,
        timeoutMs: 30,
        terminateGraceMs: 10,
      })([], { interruptionRetryable: true });
      assert.equal((retryable.payload.error as { code: string }).code, "surface_cli_timeout");
      assert.equal((retryable.payload.error as { retryable: boolean }).retryable, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("output cap", async () => {
    const { dir, script } = fixture(`process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 10_000);`);
    try {
      const result = await createSurfaceCliExecutor({
        cliPath: script,
        cwd: dir,
        maxStdoutBytes: 128,
        terminateGraceMs: 10,
      })([]);
      assert.equal((result.payload.error as { code: string }).code, "surface_cli_output_too_large");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("runner terminates an active call when the MCP server shuts down", async () => {
  const { dir, script } = fixture(`setTimeout(() => {}, 10_000);`);
  const shutdownController = new AbortController();
  try {
    const execute = createSurfaceCliExecutor({
      cliPath: script,
      cwd: dir,
      shutdownSignal: shutdownController.signal,
      terminateGraceMs: 10,
    });
    const pending = execute([]);
    setTimeout(() => shutdownController.abort(), 30);
    const result = await pending;
    assert.equal((result.payload.error as { code: string }).code, "mcp_outcome_unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner serializes concurrent calls through one FIFO", async () => {
  const { dir, script } = fixture(`
    const { appendFileSync } = await import("node:fs");
    const [log, label] = process.argv.slice(2);
    appendFileSync(log, "start:" + label + "\\n");
    await new Promise(resolve => setTimeout(resolve, 40));
    appendFileSync(log, "end:" + label + "\\n");
    process.stdout.write(JSON.stringify({schema_version:"1", label}));
  `);
  const log = join(dir, "calls.log");
  try {
    const execute = createSurfaceCliExecutor({ cliPath: script, cwd: dir });
    await Promise.all([execute([log, "one"]), execute([log, "two"])]);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "start:one",
      "end:one",
      "start:two",
      "end:two",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner restricts compose attachments to configured canonical roots", async () => {
  const { dir, script } = fixture(`process.stdout.write(JSON.stringify({schema_version:"1"}));`);
  const allowed = join(dir, "allowed");
  const outside = join(dir, "outside.txt");
  mkdirSync(allowed);
  writeFileSync(join(allowed, "inside.txt"), "inside", "utf8");
  writeFileSync(outside, "outside", "utf8");
  try {
    const disabled = createSurfaceCliExecutor({ cliPath: script, cwd: dir });
    const disabledResult = await disabled(["mail", "send", `--attach=${join(allowed, "inside.txt")}`]);
    assert.equal((disabledResult.payload.error as { code: string }).code, "attachment_paths_disabled");

    const execute = createSurfaceCliExecutor({ cliPath: script, cwd: dir, attachmentRoots: [allowed] });
    const allowedResult = await execute(["mail", "send", `--attach=${join(allowed, "inside.txt")}`]);
    assert.equal(allowedResult.isError, false);
    const rejected = await execute(["mail", "send", `--attach=${outside}`]);
    assert.equal((rejected.payload.error as { code: string }).code, "attachment_path_not_allowed");

    const directory = await execute(["mail", "send", `--attach=${allowed}`]);
    assert.equal((directory.payload.error as { code: string }).code, "invalid_attachment_path");

    const sizeLimited = createSurfaceCliExecutor({
      cliPath: script,
      cwd: dir,
      attachmentRoots: [allowed],
      maxAttachmentBytes: 3,
    });
    const oversized = await sizeLimited(["mail", "send", `--attach=${join(allowed, "inside.txt")}`]);
    assert.equal((oversized.payload.error as { code: string }).code, "attachment_too_large");

    writeFileSync(join(allowed, "second.txt"), "12345", "utf8");
    const aggregateLimited = createSurfaceCliExecutor({
      cliPath: script,
      cwd: dir,
      attachmentRoots: [allowed],
      maxAttachmentBytes: 10,
      maxTotalAttachmentBytes: 8,
    });
    const aggregate = await aggregateLimited([
      "mail",
      "send",
      `--attach=${join(allowed, "inside.txt")}`,
      `--attach=${join(allowed, "second.txt")}`,
    ]);
    assert.equal((aggregate.payload.error as { code: string }).code, "attachment_too_large");

    assert.throws(
      () => createSurfaceCliExecutor({ cliPath: script, cwd: dir, attachmentRoots: ["."] }),
      /absolute paths/,
    );
    assert.throws(
      () => createSurfaceCliExecutor({ cliPath: script, cwd: dir, attachmentRoots: [""] }),
      /absolute paths/,
    );
    assert.throws(
      () => createSurfaceCliExecutor({
        cliPath: script,
        cwd: dir,
        attachmentRoots: [parsePath(dir).root],
      }),
      /filesystem root/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner rejects caller-selected Surface config flags", async () => {
  const { dir, script } = fixture(`process.stdout.write(JSON.stringify({schema_version:"1"}));`);
  try {
    const execute = createSurfaceCliExecutor({ cliPath: script, cwd: dir });
    for (const configArgument of ["--config", "--config=/tmp/other.toml"]) {
      const result = await execute(["account", "list", configArgument]);
      assert.equal((result.payload.error as { code: string }).code, "mcp_argument_not_allowed");
    }
    const ambiguousPair = await execute(["mail", "send", "--body", "--config=/tmp/literal-text"]);
    assert.equal((ambiguousPair.payload.error as { code: string }).code, "mcp_argument_not_allowed");
    const optionValue = await execute(["mail", "send", "--body=--config=/tmp/literal-text"]);
    assert.equal(optionValue.isError, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner bounds subprocess arguments and scrubs tunnel credentials", async () => {
  const { dir, script } = fixture(`
    process.stdout.write(JSON.stringify({
      schema_version:"1",
      control_plane_key: process.env.CONTROL_PLANE_API_KEY ?? null
    }));
  `);
  try {
    const execute = createSurfaceCliExecutor({
      cliPath: script,
      cwd: dir,
      env: { ...process.env, CONTROL_PLANE_API_KEY: "must-not-reach-surface" },
    });
    const normal = await execute(["account", "list"]);
    assert.equal(normal.payload.control_plane_key, null);

    const oversized = await execute(["mail", "send", `--body=${"x".repeat(96 * 1024)}`]);
    assert.equal((oversized.payload.error as { code: string }).code, "mcp_input_too_large");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
