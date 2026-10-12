import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SurfaceError } from "./errors.js";

export interface RememberedAuthState {
  version: 1;
  accounts: string[];
  auth_check_interval_seconds: number;
}

export interface RememberedAuthResult {
  statePath: string;
  rememberedAccounts: string[];
  authCheckIntervalSeconds: number;
}

export function rememberedAuthStatePath(rootDir: string): string {
  return join(rootDir, "remembered-auth.json");
}

function dedupeAccounts(values: string[]): string[] {
  const seen = new Set<string>();
  const accounts: string[] = [];
  for (const rawAccount of values) {
    const account = rawAccount.trim();
    if (!account || seen.has(account)) {
      continue;
    }
    seen.add(account);
    accounts.push(account);
  }
  return accounts;
}

function validateRememberedAuthState(value: unknown, path: string): RememberedAuthState {
  if (!value || typeof value !== "object") {
    throw new SurfaceError("invalid_configuration", `Remembered auth state at ${path} must be a JSON object.`);
  }

  const parsed = value as Partial<RememberedAuthState>;
  if (parsed.version !== 1) {
    throw new SurfaceError("invalid_configuration", `Remembered auth state at ${path} has an unsupported version.`);
  }
  if (!Array.isArray(parsed.accounts) || !parsed.accounts.every((entry) => typeof entry === "string")) {
    throw new SurfaceError(
      "invalid_configuration",
      `Remembered auth state at ${path} must contain an accounts array of strings.`,
    );
  }
  const authCheckIntervalSeconds = parsed.auth_check_interval_seconds;
  if (
    authCheckIntervalSeconds === undefined
    || !Number.isSafeInteger(authCheckIntervalSeconds)
    || authCheckIntervalSeconds <= 0
  ) {
    throw new SurfaceError(
      "invalid_configuration",
      `Remembered auth state at ${path} must contain a positive auth_check_interval_seconds value.`,
    );
  }

  return {
    version: 1,
    accounts: dedupeAccounts(parsed.accounts),
    auth_check_interval_seconds: authCheckIntervalSeconds,
  };
}

export function readRememberedAuthState(
  rootDir: string,
  fallbackIntervalSeconds = 86_400,
): RememberedAuthState {
  const path = rememberedAuthStatePath(rootDir);
  if (!existsSync(path)) {
    return {
      version: 1,
      accounts: [],
      auth_check_interval_seconds: fallbackIntervalSeconds,
    };
  }

  try {
    return validateRememberedAuthState(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  } catch (error) {
    if (error instanceof SurfaceError) {
      throw error;
    }
    throw new SurfaceError(
      "invalid_configuration",
      `Could not read remembered auth state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function writeRememberedAuthState(rootDir: string, state: RememberedAuthState): string {
  const path = rememberedAuthStatePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function rememberAuthAccountInState(
  rootDir: string,
  accountName: string,
  options: { authCheckIntervalSeconds: number },
): RememberedAuthResult {
  const state = readRememberedAuthState(rootDir, options.authCheckIntervalSeconds);
  if (!state.accounts.includes(accountName)) {
    state.accounts.push(accountName);
  }
  const statePath = writeRememberedAuthState(rootDir, state);

  return {
    statePath,
    rememberedAccounts: state.accounts,
    authCheckIntervalSeconds: state.auth_check_interval_seconds,
  };
}
