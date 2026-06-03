import assert from "node:assert/strict";
import test from "node:test";

import type { MailAccount } from "../../contracts/account.js";
import type { AuthLoginOptions } from "../types.js";
import { imapAuthTestHooks } from "./auth.js";

function account(email = "surface@example.com"): MailAccount {
  return {
    account_id: "acc_imap",
    name: "imap",
    provider: "imap",
    transport: "imap-smtp",
    email,
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

test("GMX.com preset resolves server settings from username domain", () => {
  const settings = imapAuthTestHooks.resolveServerSettings(
    { username: "you@gmx.com" } as AuthLoginOptions,
    account("fallback@example.com"),
  );

  assert.deepEqual(settings, {
    imap: { host: "imap.gmx.com", port: 993, security: "tls" },
    smtp: { host: "mail.gmx.com", port: 587, security: "starttls" },
  });
});

test("GMX.net preset resolves server settings from account email", () => {
  const settings = imapAuthTestHooks.resolveServerSettings({} as AuthLoginOptions, account("you@gmx.net"));

  assert.deepEqual(settings, {
    imap: { host: "imap.gmx.net", port: 993, security: "tls" },
    smtp: { host: "mail.gmx.net", port: 587, security: "starttls" },
  });
});

test("explicit IMAP SMTP server settings still work for custom providers", () => {
  const settings = imapAuthTestHooks.resolveServerSettings(
    {
      imapHost: "imap.example.net",
      imapPort: 993,
      imapSecurity: "tls",
      smtpHost: "smtp.example.net",
      smtpPort: 587,
      smtpSecurity: "starttls",
    } as AuthLoginOptions,
    account("you@example.net"),
  );

  assert.deepEqual(settings, {
    imap: { host: "imap.example.net", port: 993, security: "tls" },
    smtp: { host: "smtp.example.net", port: 587, security: "starttls" },
  });
});

test("partial IMAP SMTP server settings are rejected", () => {
  assert.throws(
    () => imapAuthTestHooks.resolveServerSettings(
      { username: "you@gmx.com", imapHost: "imap.gmx.com" } as AuthLoginOptions,
      account("you@gmx.com"),
    ),
    /requires either all server flags/,
  );
});

test("unsupported IMAP SMTP preset asks for explicit server settings", () => {
  assert.throws(
    () => imapAuthTestHooks.resolveServerSettings({ username: "you@example.net" } as AuthLoginOptions, account()),
    /No IMAP\/SMTP preset for domain 'example\.net'.*--imap-host/,
  );
});
