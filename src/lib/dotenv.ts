import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SurfaceError } from "./errors.js";

const DOTENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REMEMBERED_AUTH_ACCOUNTS_ENV = "SURFACE_REMEMBERED_AUTH_ACCOUNTS";
const AUTH_CHECK_INTERVAL_ENV = "SURFACE_AUTH_CHECK_INTERVAL_SECONDS";
const LOADABLE_DOTENV_KEYS = new Set([
  "SURFACE_CACHE_DIR",
  REMEMBERED_AUTH_ACCOUNTS_ENV,
  AUTH_CHECK_INTERVAL_ENV,
]);

export interface DotenvLoadResult {
  path: string;
  loaded: string[];
}

export interface DotenvUpsertResult {
  path: string;
  keys: string[];
  created: boolean;
}

export interface RememberAuthResult {
  envPath: string;
  rememberedAccounts: string[];
  authCheckIntervalSeconds: number;
}

export function projectDotenvPath(cwd = process.cwd()): string {
  return resolve(cwd, ".env");
}

function shouldLoadKey(key: string): boolean {
  return LOADABLE_DOTENV_KEYS.has(key);
}

function stripInlineComment(value: string): string {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === "#" && quote === null && /\s/.test(value[index - 1] ?? " ")) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseDotenvValue(rawValue: string): string {
  const value = stripInlineComment(rawValue.trim());
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseDotenv(rawText: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    if (!DOTENV_KEY_PATTERN.test(key)) {
      continue;
    }
    values[key] = parseDotenvValue(normalizedLine.slice(separatorIndex + 1));
  }
  return values;
}

export function loadProjectDotenv(path = projectDotenvPath()): DotenvLoadResult {
  if (!existsSync(path)) {
    return { path, loaded: [] };
  }

  let parsed: Record<string, string>;
  try {
    parsed = parseDotenv(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SurfaceError(
      "invalid_configuration",
      `Could not read project .env at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!shouldLoadKey(key) || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
    loaded.push(key);
  }
  return { path, loaded };
}

function formatDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function parseRememberedAuthAccounts(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const trimmedValue = value.trim();
  if (trimmedValue.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedValue) as unknown;
      if (Array.isArray(parsed)) {
        if (!parsed.every((entry) => typeof entry === "string")) {
          throw new Error("array entries must be strings");
        }
        return dedupeRememberedAuthAccounts(
          parsed,
        );
      }
    } catch (error) {
      throw new SurfaceError(
        "invalid_configuration",
        `SURFACE_REMEMBERED_AUTH_ACCOUNTS must be a JSON array of account names: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new SurfaceError(
      "invalid_configuration",
      "SURFACE_REMEMBERED_AUTH_ACCOUNTS must be a JSON array of account names.",
    );
  }

  return dedupeRememberedAuthAccounts(value.split(","));
}

function dedupeRememberedAuthAccounts(values: string[]): string[] {
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

export function upsertProjectDotenv(
  path: string,
  values: Record<string, string>,
): DotenvUpsertResult {
  const created = !existsSync(path);
  const lines = created ? [] : readFileSync(path, "utf8").split(/\r?\n/);
  const consumed = new Set<string>();
  const updatedLines = lines.map((line) => {
    const normalizedLine = line.trimStart().startsWith("export ")
      ? line.trimStart().slice("export ".length).trimStart()
      : line.trimStart();
    const separatorIndex = normalizedLine.indexOf("=");
    const key = separatorIndex > 0 ? normalizedLine.slice(0, separatorIndex).trim() : "";
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      return line;
    }
    consumed.add(key);
    return `${key}=${formatDotenvValue(values[key] ?? "")}`;
  });

  const keysToAppend = Object.keys(values).filter((key) => !consumed.has(key));
  if (keysToAppend.length > 0) {
    const hasContent = updatedLines.some((line) => line.trim().length > 0);
    if (hasContent && updatedLines[updatedLines.length - 1]?.trim() !== "") {
      updatedLines.push("");
    }
    updatedLines.push("# Surface remembered auth settings");
    for (const key of keysToAppend) {
      updatedLines.push(`${key}=${formatDotenvValue(values[key] ?? "")}`);
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${updatedLines.join("\n").replace(/\n+$/g, "")}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);

  return {
    path,
    keys: Object.keys(values),
    created,
  };
}

export function rememberAuthAccountInProjectEnv(
  accountName: string,
  options: { envPath?: string; authCheckIntervalSeconds: number } = { authCheckIntervalSeconds: 86_400 },
): RememberAuthResult {
  const envPath = options.envPath ?? projectDotenvPath();
  const existing = existsSync(envPath) ? parseDotenv(readFileSync(envPath, "utf8")) : {};
  const rememberedAccounts = parseRememberedAuthAccounts(
    existing[REMEMBERED_AUTH_ACCOUNTS_ENV] ?? process.env[REMEMBERED_AUTH_ACCOUNTS_ENV],
  );
  if (!rememberedAccounts.includes(accountName)) {
    rememberedAccounts.push(accountName);
  }

  const intervalValue = existing[AUTH_CHECK_INTERVAL_ENV]
    ?? process.env[AUTH_CHECK_INTERVAL_ENV]
    ?? String(options.authCheckIntervalSeconds);
  const intervalSeconds = Number.parseInt(intervalValue, 10);
  const authCheckIntervalSeconds = Number.isSafeInteger(intervalSeconds) && intervalSeconds > 0
    ? intervalSeconds
    : options.authCheckIntervalSeconds;

  upsertProjectDotenv(envPath, {
    [REMEMBERED_AUTH_ACCOUNTS_ENV]: JSON.stringify(rememberedAccounts),
    [AUTH_CHECK_INTERVAL_ENV]: String(authCheckIntervalSeconds),
  });

  process.env[REMEMBERED_AUTH_ACCOUNTS_ENV] = JSON.stringify(rememberedAccounts);
  process.env[AUTH_CHECK_INTERVAL_ENV] = String(authCheckIntervalSeconds);

  return {
    envPath,
    rememberedAccounts,
    authCheckIntervalSeconds,
  };
}
