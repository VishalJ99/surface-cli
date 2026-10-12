import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createAccountRuntimeContext, createRuntimeContext, type AccountRuntimeContext, type RuntimeContext } from "./runtime.js";
import { closeEmptySessionProbe, respondToSessionHealthCheck, resolveReadSession, sessionConfigFingerprint, sessionHealthResult, sessionFetchUnread, sessionStartupTimeoutMs, sessionTestHooks } from "./session.js";
import type { StoredSessionRecord } from "./state/database.js";

const execFileAsync = promisify(execFile);
function store() {
  const root = mkdtempSync("/tmp/surf-569-");
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, `cache_dir = "${root}"\nsummarizer_backend = "none"\n`);
  const runtime = createRuntimeContext({ configPath });
  const account = runtime.db.upsertAccount({ name: "work", provider: "outlook", transport: "outlook-web-playwright", email: "work@example.com" });
  return { context: createAccountRuntimeContext(runtime, account), root,
    cleanup() { runtime.db.close(); rmSync(root, { recursive: true, force: true }); } };
}
function record(context: AccountRuntimeContext, id: string, accountId = context.account.account_id) {
  const result = context.db.createSession({ session_id: id, account_id: accountId, provider: "outlook", transport: "outlook-web-playwright",
    socket_path: join(context.paths.sessionsDir, `${id}.sock`), auth_token: "test-token", idle_timeout_seconds: 3600, max_age_seconds: 604800 });
  context.db.updateSessionProcessInfo(id, process.pid);
  return result;
}
async function rpcServer(context: AccountRuntimeContext, record: StoredSessionRecord, requests: string[], failure = false): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let raw = "";
    socket.on("data", (data) => { raw += data.toString(); });
    socket.on("end", () => {
      // Same empty-connection readiness behavior as the production daemon.
      if (closeEmptySessionProbe(socket, raw)) return;
      const request = JSON.parse(raw) as { token?: string; method: string };
      if (respondToSessionHealthCheck(context, record.session_id, socket, raw)) return;
      requests.push(request.method);
      socket.end(JSON.stringify(failure
        ? { ok: false, error: { code: "reauth_required", message: "test auth failure", retryable: false, account: "work", message_ref: null, thread_ref: null } }
        : { ok: true, result: request.method === "read-message" ? { schema_version: "1", command: "read", cache: { status: "refreshed" } } : [] }));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(record.socket_path, resolve));
  return server;
}
async function close(server: Server) { await new Promise<void>((resolve) => server.close(() => resolve())); }
async function cli(context: AccountRuntimeContext, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SURFACE_")));
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "--config", context.configPath, "mail", ...args], { cwd: process.cwd(), env });
}
function cachedMessage(context: AccountRuntimeContext, root: string) {
  const path = join(root, "body.txt");
  writeFileSync(path, "cached body");
  context.db.upsertThread({ thread_ref: "thr_test", account_id: context.account.account_id, subject: "test", participants: [], mailbox: "inbox", labels: [], received_at: "2026-10-12T12:00:00Z", message_count: 1, unread_count: 0, has_attachments: false });
  context.db.upsertMessage({ message_ref: "msg_test", account_id: context.account.account_id, thread_ref: "thr_test", subject: "test", from_name: null, from_email: null, to_json: "[]", cc_json: "[]", sent_at: null, received_at: "2026-10-12T12:00:00Z", unread: false, snippet: "", body_cache_path: path, body_cached: true, body_truncated: true, body_cached_bytes: 11, invite_json: null });
  context.db.replaceThreadMessages("thr_test", ["msg_test"]);
}

test("concurrent default readers reserve once and join the starting session", async () => {
  const { context, cleanup } = store();
  let spawns = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const lifecycle = {
    spawn(ctx: RuntimeContext, row: StoredSessionRecord) { spawns++; ctx.db.updateSessionProcessInfo(row.session_id, process.pid); },
    async compatible() { return true; },
    async wait(ctx: RuntimeContext, id: string) { await ready; return ctx.db.getSession(id)!; },
    async finishOwned(ctx: RuntimeContext, row: StoredSessionRecord) { await ready; return ctx.db.getSession(row.session_id)!; },
  };
  try {
    const first = sessionTestHooks.getOrStartWarmSession(context, lifecycle);
    const second = sessionTestHooks.getOrStartWarmSession(context, lifecycle);
    release();
    const rows = await Promise.all([first, second]);
    assert.equal(spawns, 1);
    assert.equal(rows[0].session_id, rows[1].session_id);
    assert.equal(context.db.listSessions().length, 1);
  } finally { cleanup(); }
});

test("separate CLI processes share the same account startup reservation", async () => {
  const { context, cleanup } = store();
  const script = `
    import { createRuntimeContext, createAccountRuntimeContext } from './src/runtime.ts';
    import { sessionTestHooks } from './src/session.ts';
    const runtime = createRuntimeContext({configPath: process.argv[1]});
    const context = createAccountRuntimeContext(runtime, runtime.db.findAccountByName('work'));
    let spawned = false;
    const delay = () => new Promise(resolve => setTimeout(resolve, 1500));
    const record = await sessionTestHooks.getOrStartWarmSession(context, {
      spawn(ctx, row) { spawned = true; ctx.db.updateSessionProcessInfo(row.session_id, process.pid); },
      async compatible() { return true; },
      async wait(ctx, id) { await delay(); return ctx.db.getSession(id); },
      async finishOwned(ctx, row) { await delay(); return ctx.db.getSession(row.session_id); },
    });
    console.log(JSON.stringify({id: record.session_id, spawned}));
    runtime.db.close();
  `;
  try {
    const results = await Promise.all([1, 2].map(() => execFileAsync(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, context.configPath])));
    const rows = results.map(result => JSON.parse(result.stdout));
    assert.equal(rows[0].id, rows[1].id);
    assert.equal(rows.filter(row => row.spawned).length, 1);
    assert.equal(context.db.listSessions().length, 1);
  } finally { cleanup(); }
});

test("default selection skips expired, dead, missing-socket and other-account sessions", async () => {
  const { context, cleanup } = store();
  const other = context.db.upsertAccount({ name: "other", provider: "outlook", transport: "outlook-web-playwright", email: "other@example.com" });
  record(context, "sess_other", other.account_id);
  record(context, "sess_expired");
  context.db.markSessionRunning("sess_expired", process.pid);
  context.db.connection.prepare("UPDATE sessions SET last_used_at = '2000-01-01T00:00:00Z' WHERE session_id = ?").run("sess_expired");
  record(context, "sess_dead"); context.db.updateSessionProcessInfo("sess_dead", 2147483647);
  record(context, "sess_missing"); context.db.markSessionRunning("sess_missing", process.pid);
  try {
    let spawns = 0;
    const row = await sessionTestHooks.getOrStartWarmSession(context, {
      spawn(ctx, row) { spawns++; ctx.db.updateSessionProcessInfo(row.session_id, process.pid); },
      async compatible() { return true; },
      async wait() { assert.fail("no usable existing session"); },
      async finishOwned(ctx, row) { return ctx.db.getSession(row.session_id)!; },
    });
    assert.equal(spawns, 1); assert.equal(row.account_id, context.account.account_id);
    assert.equal(context.db.getSession("sess_expired")?.status, "expired");
    assert.equal(context.db.getSession("sess_dead")?.status, "failed");
    assert.equal(context.db.getSession("sess_missing")?.status, "failed");
    assert.equal(context.db.getSession("sess_other")?.status, "starting");
  } finally { cleanup(); }
});

test("readiness accepts a startup older than 20 seconds and checks the actual socket", async () => {
  const { context, cleanup } = store(); const requests: string[] = [];
  const row = record(context, "sess_delayed");
  context.db.connection.prepare("UPDATE sessions SET created_at = ? WHERE session_id = ?").run(new Date(Date.now() - 25_000).toISOString(), row.session_id);
  const server = await rpcServer(context, row, requests);
  try {
    assert.equal(sessionStartupTimeoutMs(context), 120_000);
    const promise = sessionTestHooks.waitForSessionReady(context, row.session_id);
    setTimeout(() => context.db.markSessionRunning(row.session_id, process.pid), 20);
    assert.equal((await promise).session_id, row.session_id);
    assert.deepEqual(requests, []);
    assert.equal(await resolveReadSession(context), row.session_id);
    assert.deepEqual(await sessionFetchUnread(context, row.session_id, { limit: 1, unread_only: true }), []);
    assert.deepEqual(requests, ["fetch-unread"]);
  } finally { await close(server); cleanup(); }
});

test("explicit IDs and non-Outlook dispatch do not create replacements", async () => {
  const { context, cleanup } = store();
  try {
    assert.equal(await resolveReadSession(context, "sess_missing"), "sess_missing");
    await assert.rejects(sessionFetchUnread(context, "sess_missing", { limit: 1, unread_only: true }), { code: "not_found" });
    const other = context.db.upsertAccount({ name: "other", provider: "outlook", transport: "outlook-web-playwright", email: "other@example.com" });
    record(context, "sess_other", other.account_id);
    await assert.rejects(sessionFetchUnread(context, "sess_other", { limit: 1, unread_only: true }), { code: "invalid_argument" });
    const gmail = context.db.upsertAccount({ name: "gmail", provider: "gmail", transport: "gmail-api", email: "gmail@example.com" });
    assert.equal(await resolveReadSession(createAccountRuntimeContext(context, gmail)), undefined);
    assert.equal(context.db.listSessions().length, 1);
  } finally { cleanup(); }
});

test("owned startup failure terminates its detached process and records failure", async () => {
  const { context, cleanup } = store();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.unref(); record(context, "sess_failed"); context.db.updateSessionProcessInfo("sess_failed", child.pid!);
  try {
    context.db.connection.prepare("UPDATE sessions SET created_at = ? WHERE session_id = ?").run(new Date(Date.now() - 130_000).toISOString(), "sess_failed");
    await assert.rejects(sessionTestHooks.finishOwnedStartup(context, context.db.getSession("sess_failed")!), { code: "transport_error" });
    await exited;
    assert.equal(context.db.getSession("sess_failed")?.status, "failed");
    assert.equal(context.db.getSession("sess_failed")?.pid, null);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); cleanup(); }
});

test("CLI defaults dispatch all live reads to the same daemon and preserve cached/mark-read paths", async () => {
  const { context, root, cleanup } = store(); cachedMessage(context, root);
  try {
    assert.equal(JSON.parse((await cli(context, ["read", "msg_test"])).stdout).cache.status, "hit");
    assert.equal(JSON.parse((await cli(context, ["thread", "get", "thr_test", "--session", "sess_invalid"])).stdout).cache.status, "hit");
    assert.equal(context.db.listSessions().length, 0);
    await assert.rejects(cli(context, ["read", "msg_test", "--session", "sess_invalid"]), (error: unknown) => String((error as { stdout: string }).stdout).includes("not_found"));
    await assert.rejects(cli(context, ["read", "msg_test", "--session", "sess_invalid", "--mark-read"]), (error: unknown) => String((error as { stdout: string }).stdout).includes("invalid_argument"));
    await assert.rejects(cli(context, ["read", "msg_test", "--mark-read"]));
    assert.equal(context.db.listSessions().length, 0);
    const row = record(context, "sess_reuse"); context.db.markSessionRunning(row.session_id, process.pid);
    const requests: string[] = []; const server = await rpcServer(context, row, requests);
    try {
      for (const args of [ ["search", "--account", "work", "--text", "test"], ["fetch-unread", "--account", "work"], ["sent", "--account", "work"], ["sync-unread-state", "--account", "work"], ["thread", "get", "thr_test", "--refresh"], ["read", "msg_test", "--refresh"] ]) {
        assert.equal(JSON.parse((await cli(context, args)).stdout).schema_version, "1");
      }
      assert.deepEqual(requests, ["search", "fetch-unread", "sent", "fetch-unread", "refresh-thread", "read-message"]);
      assert.equal(context.db.listSessions().length, 1);
    } finally { await close(server); }
  } finally { cleanup(); }
});

test("provider RPC failures propagate once without a replacement", async () => {
  const { context, cleanup } = store(); const requests: string[] = [];
  const row = record(context, "sess_rpc_failure"); context.db.markSessionRunning(row.session_id, process.pid);
  const server = await rpcServer(context, row, requests, true);
  try {
    await assert.rejects(cli(context, ["fetch-unread", "--account", "work"]), (error: unknown) => String((error as { stdout: string }).stdout).includes("reauth_required"));
    assert.deepEqual(requests, ["fetch-unread"]);
    assert.equal(context.db.listSessions().length, 1);
  } finally { await close(server); cleanup(); }
});


test("configuration fingerprint tracks effective settings and inherited summarizer credentials", () => {
  const { context, cleanup } = store();
  try {
    const env = { OPENROUTER_API_KEY: "test-secret-a", SURFACE_OPENCLAW_AGENT: "main" };
    const fingerprint = sessionConfigFingerprint(context, env);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(fingerprint, sessionConfigFingerprint(context, { ...env, OPENROUTER_API_KEY: "test-secret-b" }));
    assert.notEqual(fingerprint, sessionConfigFingerprint(context, { ...env, SURFACE_OPENCLAW_AGENT: "other" }));
    assert.notEqual(fingerprint, sessionConfigFingerprint({ ...context, config: { ...context.config, summarizerBackend: "openrouter" } }, env));
    assert.notEqual(fingerprint, sessionConfigFingerprint({ ...context, config: { ...context.config, summarizerModel: "other-model" } }, env));
  } finally { cleanup(); }
});

test("legacy and incompatible sessions are skipped without renewing or closing them", async () => {
  const { context, cleanup } = store();
  const legacy = record(context, "sess_legacy"); context.db.markSessionRunning(legacy.session_id, process.pid);
  const incompatible = record(context, "sess_incompatible"); context.db.markSessionRunning(incompatible.session_id, process.pid);
  const servers = [legacy, incompatible].map(row => createServer({ allowHalfOpen: true }, socket => {
    socket.on("error", () => socket.destroy());
    let raw = "";
    socket.on("data", chunk => { raw += chunk.toString(); });
    socket.on("end", () => {
      if (closeEmptySessionProbe(socket, raw)) return;
      socket.end(JSON.stringify({ ok: true, result: row === legacy ? { status: "running" } : { config_fingerprint: "different" } }));
    });
  }));
  await Promise.all(servers.map((server, index) => new Promise<void>(resolve => server.listen([legacy, incompatible][index]!.socket_path, resolve))));
  const before = context.db.listSessions();
  try {
    let spawns = 0;
    const selected = await sessionTestHooks.getOrStartWarmSession(context, {
      spawn(ctx, row) { spawns++; ctx.db.updateSessionProcessInfo(row.session_id, process.pid); },
      wait: sessionTestHooks.waitForSessionReady,
      compatible: sessionTestHooks.sessionHasCompatibleConfig,
      async finishOwned(ctx, row) { return ctx.db.getSession(row.session_id)!; },
    });
    assert.equal(spawns, 1);
    assert.notEqual(selected.session_id, legacy.session_id);
    for (const old of before) {
      assert.equal(context.db.getSession(old.session_id)?.status, old.status);
      assert.equal(context.db.getSession(old.session_id)?.last_used_at, old.last_used_at);
    }
    const health = sessionHealthResult(context, legacy.session_id, legacy.auth_token);
    assert.equal(health.config_fingerprint, sessionConfigFingerprint(context));
    assert.equal(context.db.getSession(legacy.session_id)?.last_used_at, legacy.last_used_at);
  } finally { await Promise.all(servers.map(close)); cleanup(); }
});


test("health handshake responds while a provider request remains in flight and never renews TTL", async () => {
  const { context, cleanup } = store();
  const row = record(context, "sess_busy"); context.db.markSessionRunning(row.session_id, process.pid);
  let release!: () => void; let requested!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  const server = createServer({ allowHalfOpen: true }, socket => {
    let raw = ""; socket.on("error", () => socket.destroy());
    socket.on("data", chunk => { raw += chunk.toString(); });
    socket.on("end", () => {
      if (closeEmptySessionProbe(socket, raw)) return;
      if (respondToSessionHealthCheck(context, row.session_id, socket, raw)) return;
      requested();
      void pending.then(() => socket.end(JSON.stringify({ ok: true, result: [] })));
    });
  });
  await new Promise<void>(resolve => server.listen(row.socket_path, resolve));
  try {
    const operation = sessionFetchUnread(context, row.session_id, { limit: 1, unread_only: true });
    await started;
    assert.equal(await resolveReadSession(context), row.session_id);
    assert.equal(context.db.getSession(row.session_id)?.last_used_at, row.last_used_at);
    assert.throws(() => sessionHealthResult(context, row.session_id, "wrong-token"), { code: "forbidden" });
    release(); await operation;
  } finally { release(); await close(server); cleanup(); }
});

test("explicit expired sessions fail closed", async () => {
  const { context, cleanup } = store();
  const row = record(context, "sess_expired_explicit"); context.db.markSessionRunning(row.session_id, process.pid);
  context.db.connection.prepare("UPDATE sessions SET last_used_at = '2000-01-01T00:00:00Z' WHERE session_id = ?").run(row.session_id);
  try {
    assert.equal(await resolveReadSession(context, row.session_id), row.session_id);
    await assert.rejects(sessionFetchUnread(context, row.session_id, { limit: 1, unread_only: true }), { code: "session_invalid" });
    assert.equal(context.db.listSessions().length, 1);
    assert.equal(context.db.getSession(row.session_id)?.status, "expired");
  } finally { cleanup(); }
});
