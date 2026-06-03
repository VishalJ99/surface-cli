import assert from "node:assert/strict";
import test from "node:test";

import type { MailAccount } from "../../contracts/account.js";
import type { AuthLoginOptions } from "../types.js";
import { imapAuthTestHooks } from "./auth.js";

function account(): MailAccount {
  return {
    account_id: "acc_imap",
    name: "imap",
    provider: "imap",
    transport: "imap-smtp",
    email: "surface@example.com",
    created_at: "2026-06-03T12:00:00.000Z",
    updated_at: "2026-06-03T12:00:00.000Z",
  };
}

test("failing password-command errors are redacted", () => {
  const command = `${process.execPath} -e "console.error('DO_NOT_LEAK_SECRET'); process.exit(7)"`;

  let thrown: unknown;
  try {
    imapAuthTestHooks.resolvePassword({ passwordCommand: command } as AuthLoginOptions, account());
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "IMAP/SMTP password command failed.");
  assert.doesNotMatch(thrown.message, /DO_NOT_LEAK_SECRET/);
  assert.doesNotMatch(thrown.message, /process\.exit/);
  assert.doesNotMatch(thrown.message, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("direct password source returns the password flag value", () => {
  assert.equal(
    imapAuthTestHooks.resolvePassword({ password: "mailbox-secret" } as AuthLoginOptions, account()),
    "mailbox-secret",
  );
});

test("password sources are mutually exclusive", () => {
  assert.throws(
    () => imapAuthTestHooks.resolvePassword(
      { password: "mailbox-secret", passwordEnv: "SURFACE_GMX_PASSWORD" } as AuthLoginOptions,
      account(),
    ),
    /exactly one of --password, --password-env, --password-file, or --password-command/,
  );
});
