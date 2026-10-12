import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { MailAccount } from "./contracts/account.js";
import type {
  FetchUnreadQuery,
  NormalizedThreadRecord,
  ReadResultEnvelope,
  SearchQuery,
  SentMessageResult,
  SentQuery,
} from "./contracts/mail.js";
import { errorToEnvelope, SurfaceError } from "./lib/errors.js";
import { processCommandLineTokens, snapshotProcessIdentities, type ProcessIdentitySnapshot } from "./lib/process-identity.js";
import { nowIsoUtc } from "./lib/time.js";
import { makeSessionId } from "./refs.js";
import type { AccountRuntimeContext, RuntimeContext } from "./runtime.js";
import type { StoredSessionRecord } from "./state/database.js";

export const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 60 * 60;
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// Chrome launch/profile cloning plus navigation and mailbox readiness each need their budget.
const SESSION_BOOTSTRAP_ALLOWANCE_MS = 60_000;
const SESSION_POLL_INTERVAL_MS = 200;

const SESSION_RPC_SHUTDOWN_GRACE_MS = 5_000;
const SESSION_SIGTERM_GRACE_MS = 35_000;
const SESSION_SIGKILL_GRACE_MS = 2_000;

interface SessionProcessOperations {
  isPidAlive(pid: number): boolean;
  inspectProcess(pid: number): ProcessIdentitySnapshot | undefined;
  kill(pid: number, signal: NodeJS.Signals): void;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}
const defaultSessionProcessOperations: SessionProcessOperations = {
  isPidAlive: pid => isProcessAlive(pid),
  inspectProcess: pid => snapshotProcessIdentities().find(candidate => candidate.pid === pid),
  kill: (pid, signal) => { process.kill(pid, signal); }, nowMs: Date.now, sleep,
};

export type SessionRpcMethod =
  | "ping"
  | "search"
  | "fetch-unread"
  | "sent"
  | "refresh-thread"
  | "read-message"
  | "shutdown";

interface SessionRpcRequest {
  token: string;
  method: SessionRpcMethod;
  params: Record<string, unknown>;
}

type SessionRpcResponse =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        account: string | null;
        message_ref: string | null;
        thread_ref: string | null;
      };
    };

function sessionDaemonPath(): { command: string; args: string[] } {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = dirname(modulePath);

  if (modulePath.endsWith(".ts")) {
    return {
      command: process.execPath,
      args: ["--import", createRequire(import.meta.url).resolve("tsx"), join(moduleDir, "session-daemon.ts")],
    };
  }

  return {
    command: process.execPath,
    args: [join(moduleDir, "session-daemon.js")],
  };
}

function sessionSocketPath(context: RuntimeContext, sessionId: string): string {
  return join(context.paths.sessionsDir, `${sessionId}.sock`);
}

function makeSessionToken(): string {
  return randomBytes(24).toString("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isWarmSessionSupported(account: MailAccount): boolean {
  return account.provider === "outlook" && account.transport === "outlook-web-playwright";
}

function parseTimestamp(input: string): number {
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sessionExpiry(record: StoredSessionRecord): {
  expired: boolean;
  reason: "idle_timeout" | "max_age" | null;
  expires_at: string;
} {
  const createdAt = parseTimestamp(record.created_at);
  const lastUsedAt = parseTimestamp(record.last_used_at);
  const idleExpiry = lastUsedAt + record.idle_timeout_seconds * 1000;
  const maxAgeExpiry = createdAt + record.max_age_seconds * 1000;
  const expiry = Math.min(idleExpiry, maxAgeExpiry);
  const now = Date.now();

  if (now >= maxAgeExpiry) {
    return {
      expired: true,
      reason: "max_age",
      expires_at: new Date(expiry).toISOString(),
    };
  }

  if (now >= idleExpiry) {
    return {
      expired: true,
      reason: "idle_timeout",
      expires_at: new Date(expiry).toISOString(),
    };
  }

  return {
    expired: false,
    reason: null,
    expires_at: new Date(expiry).toISOString(),
  };
}

function assertWarmSessionSupported(account: MailAccount): void {
  if (isWarmSessionSupported(account)) {
    return;
  }

  throw new SurfaceError(
    "unsupported",
    `Warm sessions are only supported for ${"outlook-web-playwright"} accounts in v1.`,
    { account: account.name },
  );
}

export function sessionStartupTimeoutMs(context: RuntimeContext): number {
  return SESSION_BOOTSTRAP_ALLOWANCE_MS + 2 * context.config.providerTimeoutMs;
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sessionConfigFingerprint(context: RuntimeContext, env: NodeJS.ProcessEnv = process.env): string {
  // Hash effective settings and inherited summarizer credentials, never return raw secrets.
  return createHash("sha256").update(JSON.stringify({
    config: context.config,
    openRouterKey: env.OPENROUTER_API_KEY ?? null,
    openClawAgent: env.SURFACE_OPENCLAW_AGENT ?? "main",
    openClawConfig: env.OPENCLAW_CONFIG_PATH ?? null,
    openClawState: env.OPENCLAW_STATE_DIR ?? null,
    chromePath: env.SURFACE_CHROME_PATH ?? null,
  })).digest("hex");
}

export function sessionHealthResult(context: AccountRuntimeContext, sessionId: string, token: string | undefined) {
  const record = validateSessionForAccount(context, sessionId, context.account);
  if (token !== record.auth_token) throw new SurfaceError("forbidden", "Session token mismatch.");
  return { session_id: sessionId, status: "running", config_fingerprint: sessionConfigFingerprint(context) };
}

export function respondToSessionHealthCheck(context: AccountRuntimeContext, sessionId: string, socket: Socket, raw: string): boolean {
  try {
    const request = JSON.parse(raw) as { token?: string; method?: string };
    if (request.method !== "ping") return false;
    socket.end(JSON.stringify({ ok: true, result: sessionHealthResult(context, sessionId, request.token) }));
  } catch (error) {
    socket.end(JSON.stringify({ ok: false, error: errorToEnvelope(error).error }));
  }
  return true;
}

async function sessionHasCompatibleConfig(context: RuntimeContext, record: StoredSessionRecord): Promise<boolean> {
  const health = await callSession(record, "ping", {}, 5_000) as { config_fingerprint?: string };
  return health.config_fingerprint === sessionConfigFingerprint(context);
}

export function closeEmptySessionProbe(socket: Socket, raw: string): boolean {
  if (raw.trim()) return false;
  socket.end();
  return true;
}

async function checkSessionSocket(record: StoredSessionRecord, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(record.socket_path);
    const timer = setTimeout(() => {
      socket.destroy(new SurfaceError("transport_error", `Timed out checking session '${record.session_id}' readiness.`, { retryable: true }));
    }, timeoutMs);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("close", () => clearTimeout(timer));
  });
}

async function waitForSessionReady(context: RuntimeContext, sessionId: string): Promise<StoredSessionRecord> {
  const initial = context.db.getSession(sessionId);
  const deadline = initial?.status === "running"
    ? Date.now() + 5_000
    : parseTimestamp(initial?.created_at ?? nowIsoUtc()) + sessionStartupTimeoutMs(context);

  while (Date.now() < deadline) {
    const record = context.db.getSession(sessionId);
    if (!record) {
      throw new SurfaceError("not_found", `Session '${sessionId}' was not found after startup.`);
    }
    if (record.status === "failed" || record.status === "closed" || record.status === "expired") {
      throw new SurfaceError("transport_error", record.error_detail || `Session '${sessionId}' failed to start.`);
    }
    if (record.pid && !isProcessAlive(record.pid)) {
      throw new SurfaceError("transport_error", `Session '${sessionId}' exited before becoming ready.`);
    }
    if (record.status === "running" && existsSync(record.socket_path)) {
      await checkSessionSocket(record, Math.min(5_000, Math.max(1, deadline - Date.now())));
      return record;
    }
    await sleep(Math.min(SESSION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new SurfaceError("transport_error", `Timed out waiting for session '${sessionId}' to start.`, {
    retryable: true,
  });
}

function createWarmSessionRecord(
  context: RuntimeContext,
  account: MailAccount,
  options: { idleTimeoutSeconds: number; maxAgeSeconds: number },
): StoredSessionRecord {
  const sessionId = makeSessionId();
  return context.db.createSession({
    session_id: sessionId,
    account_id: account.account_id,
    provider: account.provider,
    transport: account.transport,
    socket_path: sessionSocketPath(context, sessionId),
    auth_token: makeSessionToken(),
    idle_timeout_seconds: options.idleTimeoutSeconds,
    max_age_seconds: options.maxAgeSeconds,
  });
}

function spawnWarmSession(context: RuntimeContext, record: StoredSessionRecord): void {
  const daemon = sessionDaemonPath();
  const child = spawn(daemon.command, [
    ...daemon.args,
    "--session-id", record.session_id,
    "--account-id", record.account_id,
    "--config-path", context.configPath,
    "--socket-path", record.socket_path,
    "--auth-token", record.auth_token,
    "--idle-timeout-seconds", String(record.idle_timeout_seconds),
    "--max-age-seconds", String(record.max_age_seconds),
  ], { detached: true, stdio: "ignore", env: process.env });
  child.on("error", (error) => {
    context.db.markSessionClosed(record.session_id, "failed", { errorDetail: error.message, pid: null });
  });
  child.unref();
  context.db.updateSessionProcessInfo(record.session_id, child.pid ?? null);
}

function ownedSessionProcess(record: StoredSessionRecord, operations: SessionProcessOperations): ProcessIdentitySnapshot | undefined {
  if (!record.pid || !operations.isPidAlive(record.pid)) return undefined;
  const identity = operations.inspectProcess(record.pid);
  if (!identity || identity.pid !== record.pid || !identity.executablePath.startsWith("/") ||
      resolve(identity.executablePath) !== resolve(process.execPath)) return undefined;
  const args = processCommandLineTokens(identity.commandLine);
  const entrypoint = sessionDaemonPath().args.at(-1)!;
  let entrypointIndex = 1;
  if (args[entrypointIndex] === "--import") {
    const loader = args[entrypointIndex + 1];
    try {
      const path = loader?.startsWith("file:") ? fileURLToPath(loader) : loader;
      if (!path || realpathSync(path) !== realpathSync(createRequire(import.meta.url).resolve("tsx"))) return undefined;
    } catch { return undefined; }
    entrypointIndex += 2;
  }
  // The daemon must be the actual Node entrypoint, never an argument to another script.
  if (args[entrypointIndex] !== entrypoint) return undefined;
  const exactFlag = (name: string, value: string) => {
    const indexes = args.flatMap((arg, index) => arg === name ? [index] : []);
    return indexes.length === 1 && args[indexes[0]! + 1] === value;
  };
  if (!exactFlag("--session-id", record.session_id) || !exactFlag("--socket-path", record.socket_path) ||
      !exactFlag("--account-id", record.account_id)) return undefined;
  return identity;
}

async function waitForOwnedProcessExit(record: StoredSessionRecord, owner: ProcessIdentitySnapshot, timeoutMs: number, operations: SessionProcessOperations): Promise<boolean> {
  const deadline = operations.nowMs() + timeoutMs;
  while (true) {
    const current = ownedSessionProcess(record, operations);
    if (!current || current.startedAt !== owner.startedAt) return true;
    if (operations.nowMs() >= deadline) return false;
    await operations.sleep(Math.min(SESSION_POLL_INTERVAL_MS, Math.max(1, deadline - operations.nowMs())));
  }
}

async function shutdownSessionRecord(context: RuntimeContext, record: StoredSessionRecord, options: {
  status: "closed" | "expired" | "failed"; errorDetail?: string | null; operations?: SessionProcessOperations;
}): Promise<StoredSessionRecord> {
  const operations = options.operations ?? defaultSessionProcessOperations;
  const owner = ownedSessionProcess(record, operations);
  let shutdownRequested = false;
  if (record.status === "running" && existsSync(record.socket_path)) {
    try {
      await callSession(record, "shutdown", {}, SESSION_RPC_SHUTDOWN_GRACE_MS);
      shutdownRequested = true;
    } catch { /* A verified process may still be terminated below. */ }
  }
  if (owner) {
    const signalOwned = (signal: NodeJS.Signals) => {
      // Re-read executable, entrypoint, bindings and start identity before EACH signal.
      const current = ownedSessionProcess(record, operations);
      if (!current || current.startedAt !== owner.startedAt) return;
      try { operations.kill(owner.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    if (!shutdownRequested || !await waitForOwnedProcessExit(record, owner, SESSION_RPC_SHUTDOWN_GRACE_MS, operations)) {
      signalOwned("SIGTERM");
      if (!await waitForOwnedProcessExit(record, owner, SESSION_SIGTERM_GRACE_MS, operations)) {
        signalOwned("SIGKILL");
        await waitForOwnedProcessExit(record, owner, SESSION_SIGKILL_GRACE_MS, operations);
      }
    }
  }
  const currentOwner = ownedSessionProcess(record, operations);
  const processStillAlive = Boolean(owner && currentOwner?.startedAt === owner.startedAt);
  if (existsSync(record.socket_path)) rmSync(record.socket_path, { force: true });
  context.db.markSessionClosed(record.session_id, options.status, {
    errorDetail: processStillAlive ? `${options.errorDetail ?? "Session shutdown failed."} Process ${record.pid} is still alive.` : options.errorDetail ?? null,
    pid: processStillAlive ? record.pid : null,
  });
  if (processStillAlive) throw new SurfaceError("transport_error", `Session '${record.session_id}' could not terminate its owned daemon.`, { retryable: true });
  return context.db.getSession(record.session_id)!;
}

export async function reconcileWarmSessions(context: RuntimeContext): Promise<void> {
  for (const record of context.db.listSessions()) {
    if (!["starting", "running"].includes(record.status)) continue;
    const expiry = sessionExpiry(record);
    const startingTimedOut = record.status === "starting" && Date.now() >= parseTimestamp(record.created_at) + sessionStartupTimeoutMs(context);
    if (expiry.expired) {
      await shutdownSessionRecord(context, record, { status: "expired", errorDetail: `Session expired due to ${expiry.reason}.` });
    } else if (!isProcessAlive(record.pid)) {
      await shutdownSessionRecord(context, record, { status: "failed", errorDetail: "Session owner process is no longer running." });
    } else if (startingTimedOut || (record.status === "running" && !existsSync(record.socket_path))) {
      await shutdownSessionRecord(context, record, { status: "failed", errorDetail: startingTimedOut
        ? "Session startup exceeded its bounded timeout." : "Session socket disappeared while its owner process was still running." });
    }
  }
}

async function failOwnedStartup(context: RuntimeContext, sessionId: string, error: unknown, ownedPid?: number | null, operations?: SessionProcessOperations): Promise<void> {
  const record = context.db.getSession(sessionId);
  if (!record) return;
  await shutdownSessionRecord(context, { ...record, pid: ownedPid ?? record.pid }, {
    status: "failed", errorDetail: error instanceof Error ? error.message : String(error), ...(operations ? { operations } : {}),
  });
}

async function finishOwnedStartup(context: RuntimeContext, record: StoredSessionRecord, operations?: SessionProcessOperations): Promise<StoredSessionRecord> {
  try {
    return await waitForSessionReady(context, record.session_id);
  } catch (error) {
    await failOwnedStartup(context, record.session_id, error, record.pid, operations);
    throw error;
  }
}

export async function startWarmSession(
  context: RuntimeContext,
  account: MailAccount,
  options: {
    idleTimeoutSeconds: number;
    maxAgeSeconds: number;
  },
): Promise<StoredSessionRecord> {
  assertWarmSessionSupported(account);
  await reconcileWarmSessions(context);

  const record = context.db.transaction(() => {
    const starting = createWarmSessionRecord(context, account, options);
    spawnWarmSession(context, starting);
    return context.db.getSession(starting.session_id)!;
  }, "immediate");
  return finishOwnedStartup(context, record);
}

interface DefaultSessionLifecycle {
  spawn: typeof spawnWarmSession;
  wait: typeof waitForSessionReady;
  finishOwned: typeof finishOwnedStartup;
  compatible: typeof sessionHasCompatibleConfig;
}
const defaultSessionLifecycle: DefaultSessionLifecycle = {
  spawn: spawnWarmSession, wait: waitForSessionReady, finishOwned: finishOwnedStartup, compatible: sessionHasCompatibleConfig,
};

async function getOrStartWarmSession(
  context: AccountRuntimeContext,
  lifecycle: DefaultSessionLifecycle = defaultSessionLifecycle,
  excludedIds: Set<string> = new Set(),
): Promise<StoredSessionRecord> {
  if (lifecycle === defaultSessionLifecycle) await reconcileWarmSessions(context);
  const reservation = context.db.transaction(() => {
    for (const record of context.db.listSessions()) {
      if (excludedIds.has(record.session_id) || record.account_id !== context.account.account_id || record.provider !== context.account.provider ||
          record.transport !== context.account.transport || !["running", "starting"].includes(record.status)) continue;
      const expired = sessionExpiry(record);
      const staleStartup = record.status === "starting" &&
        Date.now() >= parseTimestamp(record.created_at) + sessionStartupTimeoutMs(context);
      if (expired.expired || staleStartup || !isProcessAlive(record.pid) ||
          (record.status === "running" && !existsSync(record.socket_path))) {
        context.db.markSessionClosed(record.session_id, expired.expired ? "expired" : "failed", {
          errorDetail: expired.expired ? `Session expired due to ${expired.reason}.` : "Session daemon is unavailable or startup timed out.",
        });
        continue;
      }
      return { record, owned: false };
    }
    const record = createWarmSessionRecord(context, context.account, {
      idleTimeoutSeconds: DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS,
      maxAgeSeconds: DEFAULT_SESSION_MAX_AGE_SECONDS,
    });
    // Spawn and persist pid before releasing the short reservation transaction.
    lifecycle.spawn(context, record);
    return { record: context.db.getSession(record.session_id)!, owned: true };
  }, "immediate");

  if (reservation.owned) return lifecycle.finishOwned(context, reservation.record);
  try {
    const ready = await lifecycle.wait(context, reservation.record.session_id);
    if (await lifecycle.compatible(context, ready)) return ready;
    // Legacy/incompatible sessions stay available to their explicit owners.
    excludedIds.add(ready.session_id);
    return getOrStartWarmSession(context, lifecycle, excludedIds);
  } catch (error) {
    // Only a refused/missing health-check connection can select a replacement.
    // Startup timeouts and provider RPC errors never retry here.
    const code = (error as NodeJS.ErrnoException).code;
    if (reservation.record.status !== "running" ||
        !["ECONNREFUSED", "ENOENT"].includes(code ?? "")) throw error;
    context.db.markSessionClosed(reservation.record.session_id, "failed", { errorDetail: "Session socket is unreachable." });
    excludedIds.add(reservation.record.session_id);
    return getOrStartWarmSession(context, lifecycle, excludedIds);
  }
}

export async function resolveReadSession(
  context: AccountRuntimeContext,
  explicitSessionId?: string,
): Promise<string | undefined> {
  if (explicitSessionId !== undefined) return explicitSessionId;
  if (!isWarmSessionSupported(context.account)) return undefined;
  return (await getOrStartWarmSession(context)).session_id;
}

export const sessionTestHooks = { getOrStartWarmSession, waitForSessionReady, finishOwnedStartup, sessionHasCompatibleConfig, shutdownSessionRecord, ownedSessionProcess };

function validateSessionForAccount(
  context: RuntimeContext,
  sessionId: string,
  account: MailAccount,
): StoredSessionRecord {
  const record = context.db.getSession(sessionId);
  if (!record) {
    throw new SurfaceError("not_found", `Session '${sessionId}' was not found.`, {
      account: account.name,
    });
  }

  if (record.account_id !== account.account_id || record.provider !== account.provider || record.transport !== account.transport) {
    throw new SurfaceError(
      "invalid_argument",
      `Session '${sessionId}' belongs to a different account/provider/transport.`,
      { account: account.name },
    );
  }

  const expiry = sessionExpiry(record);
  if (expiry.expired) {
    throw new SurfaceError("session_invalid", `Session expired due to ${expiry.reason ?? "timeout"}.`, { account: account.name });
  }

  const refreshed = context.db.getSession(sessionId) ?? record;
  if (refreshed.status !== "running") {
    throw new SurfaceError(
      "session_invalid",
      refreshed.error_detail || `Session '${sessionId}' is not running.`,
      { account: account.name },
    );
  }

  return refreshed;
}

async function validateCallerSession(context: AccountRuntimeContext, sessionId: string): Promise<StoredSessionRecord> {
  const record = context.db.getSession(sessionId);
  // Never terminate a session bound to a different caller account.
  if (record?.account_id === context.account.account_id && record.provider === context.account.provider &&
      record.transport === context.account.transport && sessionExpiry(record).expired && record.status === "running") {
    await shutdownSessionRecord(context, record, { status: "expired", errorDetail: `Session expired due to ${sessionExpiry(record).reason}.` });
  }
  return validateSessionForAccount(context, sessionId, context.account);
}

async function callSession(record: StoredSessionRecord, method: SessionRpcMethod, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  if (!existsSync(record.socket_path)) {
    throw new SurfaceError("session_invalid", `Session socket is missing for '${record.session_id}'.`);
  }

  const request: SessionRpcRequest = {
    token: record.auth_token,
    method,
    params,
  };

  const response = await new Promise<SessionRpcResponse>((resolve, reject) => {
    const socket = connect(record.socket_path);
    let raw = "";

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => socket.destroy(new SurfaceError("transport_error", `Timed out checking session '${record.session_id}' compatibility.`, { retryable: true })), timeoutMs);
    }
    socket.once("close", () => { if (timer) clearTimeout(timer); });
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify(request));
      socket.end();
    });
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("error", (error) => {
      reject(error);
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(raw) as SessionRpcResponse);
      } catch (error) {
        reject(error);
      }
    });
  });

  if (!response.ok) {
    throw new SurfaceError(response.error.code, response.error.message, {
      retryable: response.error.retryable,
      account: response.error.account,
      messageRef: response.error.message_ref,
      threadRef: response.error.thread_ref,
    });
  }

  return response.result;
}

export function listWarmSessions(context: RuntimeContext): Array<StoredSessionRecord & { account_name: string | null; expires_at: string }> {
  return context.db.listSessions().map((record) => ({
    ...record,
    account_name: context.db.findAccountById(record.account_id)?.name ?? null,
    expires_at: sessionExpiry(record).expires_at,
  }));
}

export async function stopWarmSession(context: RuntimeContext, sessionId: string): Promise<StoredSessionRecord> {
  const record = context.db.getSession(sessionId);
  if (!record) {
    throw new SurfaceError("not_found", `Session '${sessionId}' was not found.`);
  }

  return shutdownSessionRecord(context, record, { status: "closed" });
}

export async function sessionSearch(
  context: AccountRuntimeContext,
  sessionId: string,
  query: SearchQuery,
): Promise<NormalizedThreadRecord[]> {
  const record = await validateCallerSession(context, sessionId);
  const result = await callSession(record, "search", { query });
  context.db.touchSession(sessionId);
  return result as NormalizedThreadRecord[];
}

export async function sessionFetchUnread(
  context: AccountRuntimeContext,
  sessionId: string,
  query: FetchUnreadQuery,
): Promise<NormalizedThreadRecord[]> {
  const record = await validateCallerSession(context, sessionId);
  const result = await callSession(record, "fetch-unread", { query });
  context.db.touchSession(sessionId);
  return result as NormalizedThreadRecord[];
}

export async function sessionSent(
  context: AccountRuntimeContext,
  sessionId: string,
  query: SentQuery,
): Promise<SentMessageResult[]> {
  const record = await validateCallerSession(context, sessionId);
  const result = await callSession(record, "sent", { query });
  context.db.touchSession(sessionId);
  return result as SentMessageResult[];
}

export async function sessionRefreshThread(
  context: AccountRuntimeContext,
  sessionId: string,
  threadRef: string,
): Promise<void> {
  const record = await validateCallerSession(context, sessionId);
  await callSession(record, "refresh-thread", { thread_ref: threadRef });
  context.db.touchSession(sessionId);
}

export async function sessionReadMessage(
  context: AccountRuntimeContext,
  sessionId: string,
  messageRef: string,
  refresh: boolean,
): Promise<ReadResultEnvelope> {
  const record = await validateCallerSession(context, sessionId);
  const result = await callSession(record, "read-message", {
    message_ref: messageRef,
    refresh,
  });
  context.db.touchSession(sessionId);
  return result as ReadResultEnvelope;
}

export function sessionStartEnvelope(record: StoredSessionRecord, account: MailAccount) {
  return {
    schema_version: "1" as const,
    command: "session-start",
    generated_at: nowIsoUtc(),
    session: {
      session_id: record.session_id,
      account: account.name,
      provider: record.provider,
      transport: record.transport,
      status: record.status,
      created_at: record.created_at,
      last_used_at: record.last_used_at,
      idle_timeout_seconds: record.idle_timeout_seconds,
      max_age_seconds: record.max_age_seconds,
      expires_at: sessionExpiry(record).expires_at,
    },
  };
}
