#!/usr/bin/env node

import { createServer } from "node:net";
import { existsSync, rmSync } from "node:fs";

import type { FetchUnreadQuery, SearchQuery } from "./contracts/mail.js";
import { errorToEnvelope, SurfaceError } from "./lib/errors.js";
import {
  fetchUnreadOutlookWithSession,
  readOutlookMessageWithSession,
  refreshOutlookThreadWithSession,
  searchOutlookWithSession,
} from "./providers/outlook/adapter.js";
import { launchOutlookSession, probeOutlookAuth } from "./providers/outlook/session.js";
import { createAccountRuntimeContext, createRuntimeContext } from "./runtime.js";
import { sessionExpiry } from "./session.js";

interface DaemonArgs {
  sessionId: string;
  accountId: string;
  configPath: string;
  socketPath: string;
  authToken: string;
  idleTimeoutSeconds: number;
  maxAgeSeconds: number;
}

function parseArgs(argv: string[]): DaemonArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid daemon argument near '${key ?? ""}'.`);
    }
    values.set(key.slice(2), value);
  }

  const sessionId = values.get("session-id");
  const accountId = values.get("account-id");
  const configPath = values.get("config-path");
  const socketPath = values.get("socket-path");
  const authToken = values.get("auth-token");
  const idleTimeoutSeconds = Number.parseInt(values.get("idle-timeout-seconds") ?? "", 10);
  const maxAgeSeconds = Number.parseInt(values.get("max-age-seconds") ?? "", 10);

  if (!sessionId || !accountId || !configPath || !socketPath || !authToken) {
    throw new Error("Missing required daemon arguments.");
  }
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds <= 0) {
    throw new Error("idle-timeout-seconds must be a positive integer.");
  }
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error("max-age-seconds must be a positive integer.");
  }

  return {
    sessionId,
    accountId,
    configPath,
    socketPath,
    authToken,
    idleTimeoutSeconds,
    maxAgeSeconds,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtime = createRuntimeContext({ configPath: args.configPath });
  let closed = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let maxAgeTimer: NodeJS.Timeout | undefined;
  let inflight = Promise.resolve();
  let session: Awaited<ReturnType<typeof launchOutlookSession>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  const record = runtime.db.getSession(args.sessionId);
  if (!record) {
    throw new Error(`Session '${args.sessionId}' was not found.`);
  }

  const account = runtime.db.findAccountById(args.accountId);
  if (!account) {
    throw new Error(`Account '${args.accountId}' was not found.`);
  }
  if (!(account.provider === "outlook" && account.transport === "outlook-web-playwright")) {
    throw new SurfaceError("unsupported", "Warm sessions only support outlook-web-playwright in v1.", {
      account: account.name,
    });
  }

  const context = createAccountRuntimeContext(runtime, account);

  const shutdown = async (
    status: "closed" | "expired" | "failed",
    errorDetail?: string,
    exitCode = 0,
  ): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    if (maxAgeTimer) {
      clearTimeout(maxAgeTimer);
    }
    runtime.db.markSessionClosed(args.sessionId, status, {
      errorDetail: errorDetail ?? null,
      pid: null,
    });

    try {
      await new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    } catch {
      // Ignore close failures during shutdown.
    }

    if (session) {
      try {
        await session.context.close();
      } catch {
        // Ignore close failures during shutdown.
      }
      session.cleanup?.();
    }

    if (existsSync(args.socketPath)) {
      rmSync(args.socketPath, { force: true });
    }

    runtime.db.close();
    process.exit(exitCode);
  };

  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      void shutdown("expired", "Session expired due to idle timeout.");
    }, args.idleTimeoutSeconds * 1000);
  };

  process.on("SIGTERM", () => {
    void shutdown("closed", undefined, 0);
  });
  process.on("SIGINT", () => {
    void shutdown("closed", undefined, 0);
  });

  try {
    if (existsSync(args.socketPath)) {
      rmSync(args.socketPath, { force: true });
    }

    session = await launchOutlookSession(context.accountPaths.authDir + "/profile", { headless: true });
    const auth = await probeOutlookAuth(session.page, { timeoutMs: context.config.providerTimeoutMs });
    if (auth.status !== "authenticated") {
      throw new SurfaceError("reauth_required", auth.detail ?? "Outlook session is not authenticated.", {
        account: account.name,
      });
    }

    server = createServer({ allowHalfOpen: true }, (socket) => {
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        raw += chunk;
      });
      socket.on("end", () => {
        inflight = inflight.then(async () => {
          try {
            const request = JSON.parse(raw) as {
              token?: string;
              method?: string;
              params?: Record<string, unknown>;
            };
            if (request.token !== args.authToken) {
              throw new SurfaceError("forbidden", "Session token mismatch.");
            }

            const current = runtime.db.getSession(args.sessionId);
            if (!current || current.status !== "running") {
              throw new SurfaceError("session_invalid", `Session '${args.sessionId}' is not running.`, {
                account: account.name,
              });
            }

            const expiry = sessionExpiry(current);
            if (expiry.expired) {
              void shutdown("expired", `Session expired due to ${expiry.reason ?? "timeout"}.`);
              throw new SurfaceError("session_invalid", `Session '${args.sessionId}' has expired.`, {
                account: account.name,
              });
            }

            runtime.db.touchSession(args.sessionId);
            resetIdleTimer();

            let result: unknown;
            switch (request.method) {
              case "ping":
                result = { session_id: args.sessionId, status: "running" };
                break;
              case "search":
                result = await searchOutlookWithSession(
                  account,
                  request.params?.query as SearchQuery,
                  context,
                  session,
                );
                break;
              case "fetch-unread":
                result = await fetchUnreadOutlookWithSession(
                  account,
                  request.params?.query as FetchUnreadQuery,
                  context,
                  session,
                );
                break;
              case "refresh-thread":
                await refreshOutlookThreadWithSession(
                  account,
                  String(request.params?.thread_ref ?? ""),
                  context,
                  session,
                );
                result = { ok: true };
                break;
              case "read-message":
                result = await readOutlookMessageWithSession(
                  account,
                  String(request.params?.message_ref ?? ""),
                  Boolean(request.params?.refresh),
                  context,
                  session,
                );
                break;
              case "shutdown":
                result = { ok: true };
                setTimeout(() => {
                  void shutdown("closed", undefined, 0);
                }, 0);
                break;
              default:
                throw new SurfaceError("invalid_argument", `Unsupported session method '${request.method ?? ""}'.`, {
                  account: account.name,
                });
            }

            socket.end(JSON.stringify({ ok: true, result }));
          } catch (error) {
            socket.end(JSON.stringify({ ok: false, error: errorToEnvelope(error).error }));
          }
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(args.socketPath, () => resolve());
    });

    runtime.db.markSessionRunning(args.sessionId, process.pid);
    resetIdleTimer();
    maxAgeTimer = setTimeout(() => {
      void shutdown("expired", "Session expired due to max age.");
    }, args.maxAgeSeconds * 1000);
  } catch (error) {
    await shutdown(
      "failed",
      error instanceof Error ? error.message : String(error),
      1,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
