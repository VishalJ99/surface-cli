import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RuntimeContext } from "./runtime.js";
import { reconcileWarmSessions, sessionStartupTimeoutMs, sessionTestHooks } from "./session.js";
import { SurfaceDatabase } from "./state/database.js";

function createTestRuntime(): {
  runtime: RuntimeContext;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "surface-session-test-"));
  const db = new SurfaceDatabase(join(root, "state.db"));
  db.upsertAccount({
    name: "work",
    provider: "outlook",
    transport: "outlook-web-playwright",
    email: "work@example.com",
  });

  return {
    runtime: {
      db,
      config: { providerTimeoutMs: 30_000 },
      configPath: join(root, "config.toml"),
      paths: { sessionsDir: join(root, "sessions") },
    } as unknown as RuntimeContext,
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createSession(runtime: RuntimeContext, pid: number) {
  const account = runtime.db.findAccountByName("work")!;
  const record = runtime.db.createSession({
    session_id: `sess_test_${pid}`,
    account_id: account.account_id,
    provider: account.provider,
    transport: account.transport,
    socket_path: join(runtime.paths.sessionsDir, `sess_test_${pid}.sock`),
    auth_token: "test-token",
    idle_timeout_seconds: 3_600,
    max_age_seconds: 7_200,
  });
  runtime.db.updateSessionProcessInfo(record.session_id, pid);
  return runtime.db.getSession(record.session_id)!;
}

function identity(record: ReturnType<typeof createSession>) {
  return { pid: record.pid!, parentPid: 1, processGroupId: record.pid!, startedAt: "Mon Oct 12 12:00:00 2026", elapsedSeconds: 60,
    executablePath: process.execPath, commandLine: `${process.execPath} ${join(process.cwd(), "src/session-daemon.ts")} --session-id ${record.session_id} --account-id ${record.account_id} --socket-path ${record.socket_path}` };
}

test("session startup budget includes provider timeout and browser launch grace", () => {
  assert.equal(sessionStartupTimeoutMs({ config: { providerTimeoutMs: 30_000 } } as RuntimeContext), 120_000);
  assert.equal(sessionStartupTimeoutMs({ config: { providerTimeoutMs: 1_000 } } as RuntimeContext), 62_000);
});

test("shutdownSessionRecord terminates a starting daemon before clearing its pid", async () => {
  const { runtime, cleanup } = createTestRuntime();
  try {
    const record = createSession(runtime, 12_345);
    let alive = true;
    let nowMs = 0;
    const signals: NodeJS.Signals[] = [];

    const stopped = await sessionTestHooks.shutdownSessionRecord(runtime, record, {
      status: "failed",
      errorDetail: "startup timed out",
      operations: {
        isPidAlive: () => alive,
        inspectProcess: () => alive ? identity(record) : undefined,
        kill: (_pid: number, signal: NodeJS.Signals) => {
          signals.push(signal);
          alive = false;
        },
        nowMs: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      },
    });

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.pid, null);
    assert.equal(stopped.error_detail, "startup timed out");
  } finally {
    cleanup();
  }
});

test("shutdownSessionRecord escalates to SIGKILL when SIGTERM does not exit", async () => {
  const { runtime, cleanup } = createTestRuntime();
  try {
    const record = createSession(runtime, 23_456);
    let alive = true;
    let nowMs = 0;
    const signals: NodeJS.Signals[] = [];

    await sessionTestHooks.shutdownSessionRecord(runtime, record, {
      status: "closed",
      operations: {
        isPidAlive: () => alive,
        inspectProcess: () => alive ? identity(record) : undefined,
        kill: (_pid: number, signal: NodeJS.Signals) => {
          signals.push(signal);
          if (signal === "SIGKILL") {
            alive = false;
          }
        },
        nowMs: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      },
    });

    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(runtime.db.getSession(record.session_id)?.pid, null);
  } finally {
    cleanup();
  }
});

test("reconcileWarmSessions marks a running row failed when its owner pid is gone", async () => {
  const { runtime, cleanup } = createTestRuntime();
  try {
    const record = createSession(runtime, 2_147_483_647);
    runtime.db.markSessionRunning(record.session_id, 2_147_483_647);

    await reconcileWarmSessions(runtime);

    const reconciled = runtime.db.getSession(record.session_id)!;
    assert.equal(reconciled.status, "failed");
    assert.equal(reconciled.pid, null);
    assert.equal(reconciled.error_detail, "Session owner process is no longer running.");
  } finally {
    cleanup();
  }
});


test("shutdownSessionRecord never signals a live PID whose executable or binding does not match", async () => {
  const { runtime, cleanup } = createTestRuntime();
  try {
    const record = createSession(runtime, 34567);
    for (const changed of [
      { ...identity(record), executablePath: "/usr/bin/python" },
      { ...identity(record), commandLine: identity(record).commandLine.replace(record.session_id, "sess_unrelated") },
      { ...identity(record), commandLine: identity(record).commandLine.replace(record.socket_path, "/tmp/unrelated.sock") },
      { ...identity(record), commandLine: identity(record).commandLine.replace("session-daemon.ts", "other.ts") },
      { ...identity(record), commandLine: identity(record).commandLine.replace(`${process.execPath} `, `${process.execPath} /tmp/unrelated.js `) },
    ]) {
      const signals: NodeJS.Signals[] = [];
      await sessionTestHooks.shutdownSessionRecord(runtime, record, { status: "failed", operations: {
        isPidAlive: () => true, inspectProcess: () => changed, kill: (_pid, signal) => signals.push(signal),
        nowMs: () => 0, sleep: async () => {},
      }});
      assert.deepEqual(signals, []);
      assert.equal(runtime.db.getSession(record.session_id)?.pid, null);
    }
  } finally { cleanup(); }
});

test("shutdownSessionRecord revalidates identity before delayed SIGKILL", async () => {
  const { runtime, cleanup } = createTestRuntime();
  try {
    const record = createSession(runtime, 45678); let nowMs = 0; const signals: NodeJS.Signals[] = [];
    let deadlineInspections = 0;
    await sessionTestHooks.shutdownSessionRecord(runtime, record, { status: "closed", operations: {
      isPidAlive: () => true,
      inspectProcess: () => {
        if (!signals.length) return identity(record);
        // Last exit poll still sees the daemon; the pre-SIGKILL check sees a reused PID.
        if (nowMs >= 35000) deadlineInspections++;
        return deadlineInspections >= 2 ? { ...identity(record), startedAt: "Mon Oct 12 13:00:00 2026" } : identity(record);
      },
      kill: (_pid, signal) => signals.push(signal), nowMs: () => nowMs,
      sleep: async ms => { nowMs += ms; },
    }});
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(runtime.db.getSession(record.session_id)?.pid, null);
  } finally { cleanup(); }
});
