import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MailAccount } from "../contracts/account.js";
import {
  addSecondsToIso,
  authStatusNeedsLogin,
  buildAuthCheckRecord,
  isAuthCheckDue,
  readAuthCheckState,
  writeAuthCheckState,
} from "./auth-check.js";

function account(): MailAccount {
  return {
    account_id: "acc_test",
    name: "personal",
    provider: "gmail",
    transport: "gmail-api",
    email: "you@example.com",
    created_at: "2026-06-15T12:00:00Z",
    updated_at: "2026-06-15T12:00:00Z",
  };
}

test("authStatusNeedsLogin treats non-authenticated states as stale", () => {
  assert.equal(authStatusNeedsLogin({ status: "authenticated" }), false);
  assert.equal(authStatusNeedsLogin({ status: "unauthenticated" }), true);
  assert.equal(authStatusNeedsLogin({ status: "unknown" }), true);
});

test("auth check due calculation uses next_check_at", () => {
  const record = buildAuthCheckRecord(
    account(),
    { status: "authenticated", detail: "ok" },
    "2026-06-15T12:00:00Z",
    3600,
  );

  assert.equal(record.next_check_at, "2026-06-15T13:00:00Z");
  assert.equal(isAuthCheckDue(record, "2026-06-15T12:30:00Z"), false);
  assert.equal(isAuthCheckDue(record, "2026-06-15T13:00:00Z"), true);
});

test("auth check state round trips as JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-auth-check-"));
  try {
    const record = buildAuthCheckRecord(
      account(),
      { status: "unauthenticated", detail: "refresh token rejected" },
      "2026-06-15T12:00:00Z",
      60,
    );
    writeAuthCheckState(dir, { version: 1, accounts: { [record.account_id]: record } });

    const state = readAuthCheckState(dir);
    assert.deepEqual(state.accounts.acc_test, {
      account: "personal",
      account_id: "acc_test",
      checked_at: "2026-06-15T12:00:00Z",
      next_check_at: "2026-06-15T12:01:00Z",
      status: "unauthenticated",
      detail: "refresh token rejected",
      stale: true,
      reauth_required: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSecondsToIso falls back to current time for invalid timestamps", () => {
  assert.match(addSecondsToIso("not-a-date", 1), /^\d{4}-\d{2}-\d{2}T/);
});
