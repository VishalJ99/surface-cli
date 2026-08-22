import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { MailAccount } from "../contracts/account.js";
import type { AuthStatus } from "../providers/types.js";

export interface StoredAuthCheckRecord {
  account: string;
  account_id: string;
  checked_at: string;
  next_check_at: string;
  status: AuthStatus["status"];
  detail: string | null;
  stale: boolean;
  reauth_required: boolean;
}

export interface StoredAuthCheckState {
  version: 1;
  accounts: Record<string, StoredAuthCheckRecord>;
}

export function authCheckStatePath(rootDir: string): string {
  return join(rootDir, "auth-checks.json");
}

function emptyAuthCheckState(): StoredAuthCheckState {
  return { version: 1, accounts: {} };
}

export function readAuthCheckState(rootDir: string): StoredAuthCheckState {
  const path = authCheckStatePath(rootDir);
  if (!existsSync(path)) {
    return emptyAuthCheckState();
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAuthCheckState>;
    if (parsed.version !== 1 || !parsed.accounts || typeof parsed.accounts !== "object") {
      return emptyAuthCheckState();
    }
    return parsed as StoredAuthCheckState;
  } catch {
    return emptyAuthCheckState();
  }
}

export function writeAuthCheckState(rootDir: string, state: StoredAuthCheckState): void {
  const path = authCheckStatePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function addSecondsToIso(timestamp: string, seconds: number): string {
  const parsed = Date.parse(timestamp);
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(base + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function authStatusNeedsLogin(status: AuthStatus): boolean {
  return status.status !== "authenticated";
}

export function isAuthCheckDue(
  record: StoredAuthCheckRecord | undefined,
  checkedAt: string,
): boolean {
  if (!record?.next_check_at) {
    return true;
  }
  const dueAt = Date.parse(record.next_check_at);
  const now = Date.parse(checkedAt);
  if (!Number.isFinite(dueAt) || !Number.isFinite(now)) {
    return true;
  }
  return dueAt <= now;
}

export function buildAuthCheckRecord(
  account: MailAccount,
  status: AuthStatus,
  checkedAt: string,
  intervalSeconds: number,
): StoredAuthCheckRecord {
  const stale = authStatusNeedsLogin(status);
  return {
    account: account.name,
    account_id: account.account_id,
    checked_at: checkedAt,
    next_check_at: addSecondsToIso(checkedAt, intervalSeconds),
    status: status.status,
    detail: status.detail ?? null,
    stale,
    reauth_required: stale,
  };
}
