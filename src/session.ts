import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { MailAccount } from "./contracts/account.js";
import type {
  FetchUnreadQuery,
  NormalizedThreadRecord,
  ReadResultEnvelope,
  SearchQuery,
} from "./contracts/mail.js";
import { SurfaceError } from "./lib/errors.js";
import { nowIsoUtc } from "./lib/time.js";
import { makeSessionId } from "./refs.js";
import type { AccountRuntimeContext, RuntimeContext } from "./runtime.js";
import type { StoredSessionRecord } from "./state/database.js";

export const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 60 * 60;
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const SESSION_STARTUP_TIMEOUT_MS = 20_000;
const SESSION_POLL_INTERVAL_MS = 200;

export type SessionRpcMethod =
  | "ping"
  | "search"
  | "fetch-unread"
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
      command: join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
      args: [join(moduleDir, "session-daemon.ts")],
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

function isWarmSessionSupported(account: MailAccount): boolean {
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

async function waitForSessionReady(context: RuntimeContext, sessionId: string): Promise<StoredSessionRecord> {
  const deadline = Date.now() + SESSION_STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const record = context.db.getSession(sessionId);
    if (!record) {
      throw new SurfaceError("not_found", `Session '${sessionId}' was not found after startup.`, {
        account: null,
      });
    }

    if (record.status === "running") {
      return record;
    }

    if (record.status === "failed" || record.status === "closed" || record.status === "expired") {
      throw new SurfaceError(
        "transport_error",
        record.error_detail || `Session '${sessionId}' failed to start.`,
      );
    }

    await sleep(SESSION_POLL_INTERVAL_MS);
  }

  throw new SurfaceError("transport_error", `Timed out waiting for session '${sessionId}' to start.`, {
    retryable: true,
  });
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

  const sessionId = makeSessionId();
  const socketPath = sessionSocketPath(context, sessionId);
  const authToken = makeSessionToken();
  const record = context.db.createSession({
    session_id: sessionId,
    account_id: account.account_id,
    provider: account.provider,
    transport: account.transport,
    socket_path: socketPath,
    auth_token: authToken,
    idle_timeout_seconds: options.idleTimeoutSeconds,
    max_age_seconds: options.maxAgeSeconds,
  });

  const daemon = sessionDaemonPath();
  const child = spawn(
    daemon.command,
    [
      ...daemon.args,
      "--session-id",
      sessionId,
      "--account-id",
      account.account_id,
      "--config-path",
      context.configPath,
      "--socket-path",
      socketPath,
      "--auth-token",
      authToken,
      "--idle-timeout-seconds",
      String(options.idleTimeoutSeconds),
      "--max-age-seconds",
      String(options.maxAgeSeconds),
    ],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
  context.db.updateSessionProcessInfo(sessionId, child.pid ?? null);

  return waitForSessionReady(context, record.session_id);
}

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

  if (record.account_id !== account.account_id) {
    throw new SurfaceError(
      "invalid_argument",
      `Session '${sessionId}' belongs to a different account.`,
      { account: account.name },
    );
  }

  const expiry = sessionExpiry(record);
  if (expiry.expired && record.status === "running") {
    context.db.markSessionClosed(sessionId, "expired", {
      errorDetail: `Session expired due to ${expiry.reason ?? "timeout"}.`,
    });
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

async function callSession(record: StoredSessionRecord, method: SessionRpcMethod, params: Record<string, unknown>): Promise<unknown> {
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

  try {
    if (record.status === "running" && existsSync(record.socket_path)) {
      await callSession(record, "shutdown", {});
    }
  } catch {
    if (record.pid) {
      try {
        process.kill(record.pid, "SIGTERM");
      } catch {
        // Ignore missing processes.
      }
    }
  } finally {
    if (existsSync(record.socket_path)) {
      rmSync(record.socket_path, { force: true });
    }
    context.db.markSessionClosed(sessionId, "closed", { pid: null });
  }

  return context.db.getSession(sessionId)!;
}

export async function sessionSearch(
  context: AccountRuntimeContext,
  sessionId: string,
  query: SearchQuery,
): Promise<NormalizedThreadRecord[]> {
  const record = validateSessionForAccount(context, sessionId, context.account);
  const result = await callSession(record, "search", { query });
  context.db.touchSession(sessionId);
  return result as NormalizedThreadRecord[];
}

export async function sessionFetchUnread(
  context: AccountRuntimeContext,
  sessionId: string,
  query: FetchUnreadQuery,
): Promise<NormalizedThreadRecord[]> {
  const record = validateSessionForAccount(context, sessionId, context.account);
  const result = await callSession(record, "fetch-unread", { query });
  context.db.touchSession(sessionId);
  return result as NormalizedThreadRecord[];
}

export async function sessionRefreshThread(
  context: AccountRuntimeContext,
  sessionId: string,
  threadRef: string,
): Promise<void> {
  const record = validateSessionForAccount(context, sessionId, context.account);
  await callSession(record, "refresh-thread", { thread_ref: threadRef });
  context.db.touchSession(sessionId);
}

export async function sessionReadMessage(
  context: AccountRuntimeContext,
  sessionId: string,
  messageRef: string,
  refresh: boolean,
): Promise<ReadResultEnvelope> {
  const record = validateSessionForAccount(context, sessionId, context.account);
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
