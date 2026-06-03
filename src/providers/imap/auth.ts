import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { MailAccount } from "../../contracts/account.js";
import { SurfaceError } from "../../lib/errors.js";
import { nowIsoUtc } from "../../lib/time.js";
import type { AuthLoginOptions, ImapSmtpSecurityMode, ProviderContext } from "../types.js";

export interface ImapSmtpAuthState {
  version: 1;
  imap: {
    host: string;
    port: number;
    security: ImapSmtpSecurityMode;
  };
  smtp: {
    host: string;
    port: number;
    security: ImapSmtpSecurityMode;
  };
  username: string;
  password: string;
  updated_at: string;
}

export function imapSmtpAuthPath(context: ProviderContext): string {
  return resolve(context.accountPaths.authDir, "imap-smtp.json");
}

function requireString(
  options: AuthLoginOptions,
  field: keyof AuthLoginOptions,
  flag: string,
  account: MailAccount,
): string {
  const value = options[field];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new SurfaceError("invalid_argument", `IMAP/SMTP auth login requires ${flag}.`, {
    account: account.name,
  });
}

function requirePort(
  options: AuthLoginOptions,
  field: "imapPort" | "smtpPort",
  flag: string,
  account: MailAccount,
): number {
  const value = options[field];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65535) {
    return value;
  }
  throw new SurfaceError("invalid_argument", `IMAP/SMTP auth login requires ${flag} as a TCP port from 1 to 65535.`, {
    account: account.name,
  });
}

function requireSecurity(
  options: AuthLoginOptions,
  field: "imapSecurity" | "smtpSecurity",
  flag: string,
  account: MailAccount,
): ImapSmtpSecurityMode {
  const value = options[field];
  if (value === "tls" || value === "starttls" || value === "none") {
    return value;
  }
  throw new SurfaceError("invalid_argument", `IMAP/SMTP auth login requires ${flag} as one of: tls, starttls, none.`, {
    account: account.name,
  });
}

function readPasswordFromEnv(envName: string, account: MailAccount): string {
  const value = process.env[envName];
  if (value === undefined) {
    throw new SurfaceError("invalid_argument", `Environment variable '${envName}' is not set.`, {
      account: account.name,
    });
  }
  return value.replace(/[\r\n]+$/g, "");
}

function readPasswordFromFile(path: string, account: MailAccount): string {
  try {
    return readFileSync(resolve(path), "utf8").replace(/[\r\n]+$/g, "");
  } catch (error) {
    throw new SurfaceError(
      "invalid_argument",
      `Could not read IMAP/SMTP password file '${path}': ${error instanceof Error ? error.message : String(error)}`,
      { account: account.name },
    );
  }
}

function readPasswordFromCommand(command: string, account: MailAccount): string {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).replace(/[\r\n]+$/g, "");
  } catch {
    throw new SurfaceError(
      "invalid_argument",
      "IMAP/SMTP password command failed.",
      { account: account.name },
    );
  }
}

function resolvePassword(options: AuthLoginOptions, account: MailAccount): string {
  const sources = [
    options.passwordEnv ? "env" : null,
    options.passwordFile ? "file" : null,
    options.passwordCommand ? "command" : null,
  ].filter(Boolean);

  if (sources.length !== 1) {
    throw new SurfaceError(
      "invalid_argument",
      "IMAP/SMTP auth login requires exactly one of --password-env, --password-file, or --password-command.",
      { account: account.name },
    );
  }

  if (options.passwordEnv) {
    return readPasswordFromEnv(options.passwordEnv, account);
  }
  if (options.passwordFile) {
    return readPasswordFromFile(options.passwordFile, account);
  }
  if (options.passwordCommand) {
    return readPasswordFromCommand(options.passwordCommand, account);
  }
  throw new SurfaceError("invalid_argument", "Missing IMAP/SMTP password source.", {
    account: account.name,
  });
}

function validateAuthState(value: unknown, path: string, account: MailAccount): ImapSmtpAuthState {
  const state = value as Partial<ImapSmtpAuthState>;
  if (
    state.version !== 1
    || !state.imap?.host
    || !state.imap?.port
    || !state.imap?.security
    || !state.smtp?.host
    || !state.smtp?.port
    || !state.smtp?.security
    || !state.username
    || typeof state.password !== "string"
  ) {
    throw new SurfaceError("invalid_configuration", `IMAP/SMTP auth state at ${path} is incomplete.`, {
      account: account.name,
    });
  }
  return state as ImapSmtpAuthState;
}

export function readImapSmtpAuthState(account: MailAccount, context: ProviderContext): ImapSmtpAuthState {
  const path = imapSmtpAuthPath(context);
  if (!existsSync(path)) {
    throw new SurfaceError("reauth_required", `No IMAP/SMTP auth state found for account '${account.name}'.`, {
      account: account.name,
    });
  }

  try {
    return validateAuthState(JSON.parse(readFileSync(path, "utf8")) as unknown, path, account);
  } catch (error) {
    if (error instanceof SurfaceError) {
      throw error;
    }
    throw new SurfaceError(
      "invalid_configuration",
      `Could not read IMAP/SMTP auth state from ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { account: account.name },
    );
  }
}

export function writeImapSmtpAuthState(
  account: MailAccount,
  context: ProviderContext,
  options: AuthLoginOptions,
): ImapSmtpAuthState {
  const state: ImapSmtpAuthState = {
    version: 1,
    imap: {
      host: requireString(options, "imapHost", "--imap-host", account),
      port: requirePort(options, "imapPort", "--imap-port", account),
      security: requireSecurity(options, "imapSecurity", "--imap-security", account),
    },
    smtp: {
      host: requireString(options, "smtpHost", "--smtp-host", account),
      port: requirePort(options, "smtpPort", "--smtp-port", account),
      security: requireSecurity(options, "smtpSecurity", "--smtp-security", account),
    },
    username: options.username?.trim() || account.email,
    password: resolvePassword(options, account),
    updated_at: nowIsoUtc(),
  };

  if (!state.password) {
    throw new SurfaceError("invalid_argument", "IMAP/SMTP password source returned an empty password.", {
      account: account.name,
    });
  }

  mkdirSync(context.accountPaths.authDir, { recursive: true });
  const path = imapSmtpAuthPath(context);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return state;
}

export function clearImapSmtpAuthState(context: ProviderContext): void {
  rmSync(imapSmtpAuthPath(context), { force: true });
}

export const imapAuthTestHooks = {
  resolvePassword,
};
