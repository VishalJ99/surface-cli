import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { promisify } from "node:util";

import { parse as parseToml } from "smol-toml";

import type { MailAccount } from "../contracts/account.js";
import type { AuthStatus } from "../providers/types.js";
import type { RuntimeContext } from "../runtime.js";
import { buildAccountPaths } from "../paths.js";
import { SurfaceError } from "./errors.js";
import { gmailClientSecretPath } from "../providers/gmail/oauth.js";
import {
  launchOutlookSession,
  probeOutlookAuth,
  promptForOutlookLogin,
} from "../providers/outlook/session.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GMAIL_CALLBACK_PORT = 8765;
const SSH_TIMEOUT_MS = 30_000;
const SSH_MAX_BUFFER = 1024 * 1024;
const REMOTE_AUTH_PREFLIGHT_TIMEOUT_MS = 8_000;
const REMOTE_AUTH_VALIDATE_TIMEOUT_MS = 20_000;

interface RemoteAccountListEnvelope {
  accounts: MailAccount[];
}

interface RemoteAuthStatusEnvelope {
  account?: string;
  provider?: string;
  transport?: string;
  status: AuthStatus;
}

export interface RemoteAuthLoginEnvelope {
  schema_version: "1";
  command: "auth-login";
  account: string;
  provider: string;
  transport: string;
  remote_host: string;
  status: AuthStatus;
  remembered_auth?: {
    env_path: string;
    accounts: string[];
    auth_check_interval_seconds: number;
    secret_storage: string;
    check_command: string;
    reauth_command: string;
  };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function shellPath(value: string): string {
  if (value === "~") {
    return "$HOME";
  }
  if (value.startsWith("~/")) {
    return `$HOME/${value.slice(2)}`;
  }
  return shellEscape(value);
}

function remoteLoginShellWrapper(command: string): string {
  const escapedCommand = shellEscape(command);
  return [
    `if [ -x /bin/zsh ]; then exec /bin/zsh -lc ${escapedCommand}; fi`,
    `if [ -x /bin/bash ]; then exec /bin/bash -lc ${escapedCommand}; fi`,
    `exec /bin/sh -lc ${escapedCommand}`,
  ].join("; ");
}

function extractJsonEnvelope(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function remoteSurfaceExecArgs(
  remoteHost: string,
  args: string[],
  env: Record<string, string> = {},
): string[] {
  const execEnv = [
    "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
  ];

  return ["-T", remoteHost, "/usr/bin/env", ...execEnv, "surface", ...args];
}

async function runRemoteShell(remoteHost: string, command: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("ssh", ["-T", remoteHost, remoteLoginShellWrapper(command)], {
      timeout: SSH_TIMEOUT_MS,
      maxBuffer: SSH_MAX_BUFFER,
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string };
    throw new SurfaceError(
      "remote_command_failed",
      `Remote command on '${remoteHost}' failed: ${failure.stderr?.trim() || failure.message}`,
    );
  }
}

async function assertRemoteProjectDirectory(remoteHost: string, directory: string): Promise<void> {
  try {
    await runRemoteShell(remoteHost, `test -d ${shellPath(directory)}`);
  } catch (error) {
    throw new SurfaceError(
      "invalid_configuration",
      error instanceof Error
        ? `Remote project directory '${directory}' is not available on '${remoteHost}': ${error.message}`
        : `Remote project directory '${directory}' is not available on '${remoteHost}'.`,
    );
  }
}

async function rememberRemoteAuthAccount(
  remoteHost: string,
  accountName: string,
  options: { remoteProjectDir: string; authCheckIntervalSeconds: number },
): Promise<NonNullable<RemoteAuthLoginEnvelope["remembered_auth"]>> {
  const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");

const projectDir = process.env.SURFACE_REMOTE_PROJECT_DIR;
const accountName = process.env.SURFACE_REMEMBER_ACCOUNT;
const fallbackInterval = Number.parseInt(process.env.SURFACE_AUTH_CHECK_INTERVAL_SECONDS || "86400", 10);

if (!projectDir || !accountName) {
  throw new Error("missing remote remembered-auth environment");
}
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  throw new Error("remote project directory does not exist: " + projectDir);
}

const envPath = path.join(projectDir, ".env");
let text = "";
try {
  text = fs.readFileSync(envPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

function parseDotenv(rawText) {
  const values = {};
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = normalizedLine.slice(0, separatorIndex).trim();
    let value = normalizedLine.slice(separatorIndex + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value);
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function rememberedAccounts(value) {
  if (!value) return [];
  const trimmed = value.trim();
  const rawValues = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split(",");
  if (!Array.isArray(rawValues) || !rawValues.every((entry) => typeof entry === "string")) {
    throw new Error("SURFACE_REMEMBERED_AUTH_ACCOUNTS must be a JSON array of account names");
  }
  const seen = new Set();
  const accounts = [];
  for (const rawAccount of rawValues) {
    const account = rawAccount.trim();
    if (!account || seen.has(account)) continue;
    seen.add(account);
    accounts.push(account);
  }
  return accounts;
}

function formatDotenvValue(value) {
  return /^[A-Za-z0-9_./:@,+-]+$/.test(value) ? value : JSON.stringify(value);
}

function upsertDotenv(rawText, values) {
  const lines = rawText ? rawText.split(/\r?\n/) : [];
  const consumed = new Set();
  const updated = lines.map((line) => {
    const normalizedLine = line.trimStart().startsWith("export ")
      ? line.trimStart().slice("export ".length).trimStart()
      : line.trimStart();
    const separatorIndex = normalizedLine.indexOf("=");
    const key = separatorIndex > 0 ? normalizedLine.slice(0, separatorIndex).trim() : "";
    if (!Object.prototype.hasOwnProperty.call(values, key)) return line;
    consumed.add(key);
    return key + "=" + formatDotenvValue(values[key]);
  });
  const keysToAppend = Object.keys(values).filter((key) => !consumed.has(key));
  if (keysToAppend.length > 0) {
    if (updated.some((line) => line.trim().length > 0) && updated[updated.length - 1]?.trim() !== "") {
      updated.push("");
    }
    updated.push("# Surface remembered auth settings");
    for (const key of keysToAppend) {
      updated.push(key + "=" + formatDotenvValue(values[key]));
    }
  }
  return updated.join("\n").replace(/\n+$/g, "") + "\n";
}

const parsed = parseDotenv(text);
const accounts = rememberedAccounts(parsed.SURFACE_REMEMBERED_AUTH_ACCOUNTS);
if (!accounts.includes(accountName)) {
  accounts.push(accountName);
}
const parsedInterval = Number.parseInt(parsed.SURFACE_AUTH_CHECK_INTERVAL_SECONDS || "", 10);
const interval = Number.isSafeInteger(parsedInterval) && parsedInterval > 0
  ? parsedInterval
  : fallbackInterval;

fs.writeFileSync(envPath, upsertDotenv(text, {
  SURFACE_REMEMBERED_AUTH_ACCOUNTS: JSON.stringify(accounts),
  SURFACE_AUTH_CHECK_INTERVAL_SECONDS: String(interval),
}), { encoding: "utf8", mode: 0o600 });
fs.chmodSync(envPath, 0o600);

process.stdout.write(JSON.stringify({
  env_path: envPath,
  accounts,
  auth_check_interval_seconds: interval,
}) + "\n");
`;

  const result = await runRemoteShell(
    remoteHost,
    [
      `SURFACE_REMOTE_PROJECT_DIR=${shellEscape(options.remoteProjectDir)}`,
      `SURFACE_REMEMBER_ACCOUNT=${shellEscape(accountName)}`,
      `SURFACE_AUTH_CHECK_INTERVAL_SECONDS=${shellEscape(String(options.authCheckIntervalSeconds))}`,
      `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH node -e ${shellEscape(script)}`,
    ].join(" "),
  );

  const parsed = JSON.parse(extractJsonEnvelope(result.stdout)) as {
    env_path: string;
    accounts: string[];
    auth_check_interval_seconds: number;
  };
  return {
    ...parsed,
    secret_storage: "Remote Surface auth storage; the remote project .env stores account/check settings only.",
    check_command: `ssh ${shellEscape(remoteHost)} ${shellEscape(
      `cd ${shellEscape(options.remoteProjectDir)} && surface auth check --remembered-only --due-only`,
    )}`,
    reauth_command: `surface auth login ${shellEscape(accountName)} --remote-host ${shellEscape(remoteHost)} --remember-me --remote-project-dir ${shellEscape(options.remoteProjectDir)}`,
  };
}

async function preflightRemoteRememberMe(
  remoteHost: string,
  accountName: string,
  options: { remoteProjectDir: string },
): Promise<void> {
  await assertRemoteProjectDirectory(remoteHost, options.remoteProjectDir);
  await runRemoteShell(
    remoteHost,
    [
      `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH`,
      `node -e ${shellEscape("process.exit(0)")}`,
    ].join(" "),
  ).catch((error) => {
    throw new SurfaceError(
      "invalid_configuration",
      error instanceof Error
        ? `Remote host '${remoteHost}' cannot run node for remembered-auth setup: ${error.message}`
        : `Remote host '${remoteHost}' cannot run node for remembered-auth setup.`,
      { account: accountName },
    );
  });
}

async function runRemoteSurfaceProcess(
  remoteHost: string,
  args: string[],
  env: Record<string, string> = {},
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("ssh", remoteSurfaceExecArgs(remoteHost, args, env), {
      timeout: options.timeoutMs ?? SSH_TIMEOUT_MS,
      maxBuffer: SSH_MAX_BUFFER,
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string };
    throw new SurfaceError(
      "remote_command_failed",
      `Remote surface ${args.join(" ")} on '${remoteHost}' failed: ${failure.stderr?.trim() || failure.message}`,
    );
  }
}

async function runRemoteSurfaceJson<T>(
  remoteHost: string,
  args: string[],
  env: Record<string, string> = {},
  options: { timeoutMs?: number } = {},
): Promise<T> {
  try {
    const result = await runRemoteSurfaceProcess(remoteHost, args, env, options);
    return JSON.parse(extractJsonEnvelope(result.stdout)) as T;
  } catch (error) {
    const failure = error as Error & { stdout?: string };
    if (typeof failure.stdout === "string" && failure.stdout.trim()) {
      try {
        return JSON.parse(extractJsonEnvelope(failure.stdout)) as T;
      } catch {
        // fall through to the normalized error below
      }
    }

    throw new SurfaceError(
      "remote_command_failed",
      error instanceof Error
        ? error.message
        : `Remote surface ${args.join(" ")} on '${remoteHost}' returned invalid JSON.`,
    );
  }
}

async function resolveRemoteAccount(remoteHost: string, accountName: string): Promise<MailAccount> {
  const payload = await runRemoteSurfaceJson<RemoteAccountListEnvelope>(remoteHost, ["account", "list"]);
  const account = payload.accounts.find((candidate) => candidate.name === accountName);
  if (!account) {
    throw new SurfaceError(
      "not_found",
      `Account '${accountName}' was not found on remote host '${remoteHost}'.`,
      { account: accountName },
    );
  }
  return account;
}

async function resolveRemoteAuthStatus(
  remoteHost: string,
  accountName: string,
  options: { timeoutMs?: number; bestEffort?: boolean } = {},
): Promise<AuthStatus> {
  try {
    const payload = await runRemoteSurfaceJson<RemoteAuthStatusEnvelope>(
      remoteHost,
      ["auth", "status", accountName],
      {},
      options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    );
    return payload.status;
  } catch (error) {
    if (options.bestEffort) {
      return {
        status: "unknown",
        detail:
          error instanceof Error
            ? `Remote auth status probe failed: ${error.message}`
            : "Remote auth status probe failed.",
      };
    }
    throw error;
  }
}

async function promptForRemoteReplacement(
  remoteHost: string,
  account: MailAccount,
  status: AuthStatus,
): Promise<void> {
  if (status.status !== "authenticated") {
    return;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new SurfaceError(
      "interactive_required",
      `Remote account '${account.name}' on '${remoteHost}' already appears authenticated. Re-run this command from an interactive terminal to confirm replacement.`,
      { account: account.name },
    );
  }

  const replacementLabel =
    account.provider === "outlook"
      ? "Replacing it will overwrite the current Outlook browser profile on the remote host."
      : "Replacing it will overwrite the current Gmail token state on the remote host.";

  const prompt = [
    `Remote account '${account.name}' on '${remoteHost}' already appears authenticated.`,
    replacementLabel,
    "Continue? [y/N] ",
  ].join("\n");

  const interfaceHandle = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await interfaceHandle.question(prompt)).trim().toLowerCase();
    if (!["y", "yes"].includes(answer)) {
      throw new SurfaceError("user_aborted", "Remote auth login cancelled by user.", {
        account: account.name,
      });
    }
  } finally {
    interfaceHandle.close();
  }
}

function gmailCallbackPort(): number {
  const rawValue = process.env.SURFACE_GMAIL_CALLBACK_PORT;
  if (!rawValue) {
    return DEFAULT_GMAIL_CALLBACK_PORT;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new SurfaceError(
      "invalid_configuration",
      "SURFACE_GMAIL_CALLBACK_PORT must be a valid TCP port between 1 and 65535.",
    );
  }

  return parsed;
}

function resolveLocalGmailClientSecretSource(context: RuntimeContext, accountName: string): string {
  const localAccount = context.db.findAccountByName(accountName);
  if (localAccount) {
    const candidate = gmailClientSecretPath({
      config: context.config,
      paths: context.paths,
      db: context.db,
      accountPaths: buildAccountPaths(context.paths, localAccount),
    });
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const envPath = process.env.SURFACE_GMAIL_CLIENT_SECRET_FILE;
  if (envPath) {
    const resolvedPath = resolve(envPath);
    if (!existsSync(resolvedPath)) {
      throw new SurfaceError(
        "not_found",
        `SURFACE_GMAIL_CLIENT_SECRET_FILE points to a missing file: ${resolvedPath}`,
      );
    }
    return resolvedPath;
  }

  const cwdPath = resolve(process.cwd(), "client_secret.json");
  if (existsSync(cwdPath)) {
    return cwdPath;
  }

  throw new SurfaceError(
    "not_found",
    "Missing Gmail OAuth desktop client credentials. Set SURFACE_GMAIL_CLIENT_SECRET_FILE or place client_secret.json in the current working directory before running remote Gmail auth login.",
    { account: accountName },
  );
}

async function remoteFileExists(remoteHost: string, filePath: string): Promise<boolean> {
  try {
    await runRemoteShell(remoteHost, `test -f ${shellPath(filePath)}`);
    return true;
  } catch (error) {
    if (error instanceof SurfaceError && error.code === "remote_command_failed") {
      return false;
    }
    throw error;
  }
}

async function resolveRemoteSurfaceRoot(remoteHost: string): Promise<string> {
  const defaultRoot = "~/.surface-cli";
  const command = "if [ -f ~/.surface-cli/config.toml ]; then cat ~/.surface-cli/config.toml; fi";
  const result = await runRemoteShell(remoteHost, command);
  if (!result.stdout.trim()) {
    return defaultRoot;
  }

  try {
    const parsed = parseToml(result.stdout) as { cache_dir?: unknown };
    return typeof parsed.cache_dir === "string" && parsed.cache_dir.trim().length > 0
      ? parsed.cache_dir.trim()
      : defaultRoot;
  } catch {
    return defaultRoot;
  }
}

async function ensureRemoteDirectory(remoteHost: string, directory: string): Promise<void> {
  await runRemoteShell(remoteHost, `mkdir -p ${shellPath(directory)}`);
}

async function syncPathToRemote(
  localPath: string,
  remoteHost: string,
  remotePath: string,
  options: { delete?: boolean } = {},
): Promise<void> {
  const args = ["-a"];
  if (options.delete) {
    args.push("--delete");
  }
  args.push(localPath, `${remoteHost}:${remotePath}`);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("rsync", args, {
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      stderr.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.write(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new SurfaceError(
          "remote_command_failed",
          `rsync to '${remoteHost}:${remotePath}' failed with exit code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

async function waitForTunnelReady(
  tunnel: ChildProcess,
  remoteHost: string,
  port: number,
): Promise<void> {
  let tunnelExited = false;
  let tunnelErrorMessage: string | null = null;

  tunnel.once("error", (error) => {
    tunnelErrorMessage = error.message;
  });
  tunnel.once("close", () => {
    tunnelExited = true;
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (tunnelErrorMessage) {
      throw new SurfaceError(
        "remote_command_failed",
        `Could not start SSH tunnel to '${remoteHost}': ${tunnelErrorMessage}`,
      );
    }

    if (tunnelExited) {
      throw new SurfaceError(
        "remote_command_failed",
        `SSH tunnel to '${remoteHost}' exited before Gmail auth completed.`,
      );
    }

    const isListening = await new Promise<boolean>((resolvePromise) => {
      const socket = new Socket();
      const finish = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolvePromise(result);
      };

      socket.setTimeout(250);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(port, "127.0.0.1");
    });

    if (isListening) {
      return;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }

  throw new SurfaceError(
    "remote_command_failed",
    `SSH tunnel to '${remoteHost}' did not start listening on localhost:${port} in time.`,
  );
}

async function stopTunnel(tunnel: ChildProcess | null): Promise<void> {
  if (!tunnel || tunnel.exitCode !== null) {
    return;
  }

  tunnel.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      if (tunnel.exitCode === null) {
        tunnel.kill("SIGKILL");
      }
      resolvePromise();
    }, 2_000);

    tunnel.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function runRemoteSurfaceStreaming(
  remoteHost: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn("ssh", remoteSurfaceExecArgs(remoteHost, args, env), {
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuffer += text;
      stderr.write(text);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdoutBuffer);
        return;
      }
      rejectPromise(
        new SurfaceError(
          "remote_command_failed",
          `Remote surface ${args.join(" ")} on '${remoteHost}' failed with exit code ${code ?? "unknown"}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : "."}`,
        ),
      );
    });
  });
}

async function runRemoteGmailLogin(
  remoteHost: string,
  account: MailAccount,
  context: RuntimeContext,
): Promise<RemoteAuthLoginEnvelope> {
  const callbackPort = gmailCallbackPort();
  const surfaceRoot = await resolveRemoteSurfaceRoot(remoteHost);
  const remoteAuthDir = `${surfaceRoot}/auth/${account.account_id}`;
  const remoteClientSecret = `${remoteAuthDir}/client_secret.json`;

  await ensureRemoteDirectory(remoteHost, remoteAuthDir);
  const remoteHasClientSecret = await remoteFileExists(remoteHost, remoteClientSecret);
  if (!remoteHasClientSecret) {
    const localClientSecret = resolveLocalGmailClientSecretSource(context, account.name);
    await syncPathToRemote(localClientSecret, remoteHost, remoteClientSecret);
  }

  const tunnel = spawn("ssh", ["-N", "-L", `${callbackPort}:127.0.0.1:${callbackPort}`, remoteHost], {
    stdio: ["inherit", "ignore", "pipe"],
  });
  tunnel.stderr.on("data", (chunk) => {
    stderr.write(chunk.toString("utf8"));
  });

  try {
    await waitForTunnelReady(tunnel, remoteHost, callbackPort);
    stderr.write(
      `Remote Gmail auth: forwarding localhost:${callbackPort} to '${remoteHost}' before OAuth approval.\n`,
    );
    const rawOutput = await runRemoteSurfaceStreaming(
      remoteHost,
      ["auth", "login", account.name],
      { SURFACE_GMAIL_CALLBACK_PORT: String(callbackPort) },
    );
    const parsed = JSON.parse(extractJsonEnvelope(rawOutput)) as Omit<RemoteAuthLoginEnvelope, "remote_host">;
    return {
      ...parsed,
      remote_host: remoteHost,
    };
  } catch (error) {
    if (error instanceof SurfaceError) {
      throw error;
    }
    throw new SurfaceError(
      "remote_command_failed",
      `Remote Gmail auth login for '${account.name}' on '${remoteHost}' failed: ${error instanceof Error ? error.message : String(error)}`,
      { account: account.name },
    );
  } finally {
    await stopTunnel(tunnel);
  }
}

function localRemoteOutlookProfileDir(accountName: string): string {
  const safeName = accountName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "SurfaceChrome",
      safeName,
    );
  }

  return join(homedir(), ".surface-cli", "local-profiles", "outlook", safeName);
}

async function runRemoteOutlookLogin(
  remoteHost: string,
  account: MailAccount,
  context: RuntimeContext,
): Promise<RemoteAuthLoginEnvelope> {
  const localProfileDir = localRemoteOutlookProfileDir(account.name);
  const session = await launchOutlookSession(localProfileDir, { headless: false });

  try {
    await session.page.goto("https://outlook.office.com/mail/", { waitUntil: "domcontentloaded" });
    await promptForOutlookLogin(localProfileDir);
    const localStatus = await probeOutlookAuth(session.page, {
      timeoutMs: context.config.providerTimeoutMs,
    });
    if (localStatus.status !== "authenticated") {
      throw new SurfaceError(
        "auth_failed",
        localStatus.detail ?? "Outlook login did not reach an authenticated mailbox state locally.",
        { account: account.name },
      );
    }
  } finally {
    await session.context.close();
    session.cleanup?.();
  }

  const surfaceRoot = await resolveRemoteSurfaceRoot(remoteHost);
  const remoteProfileDir = `${surfaceRoot}/auth/${account.account_id}/profile`;
  await ensureRemoteDirectory(remoteHost, remoteProfileDir);
  await syncPathToRemote(`${localProfileDir}/`, remoteHost, `${remoteProfileDir}/`, { delete: true });

  const remoteStatus = await resolveRemoteAuthStatus(remoteHost, account.name, {
    timeoutMs: REMOTE_AUTH_VALIDATE_TIMEOUT_MS,
    bestEffort: true,
  });
  return {
    schema_version: "1",
    command: "auth-login",
    account: account.name,
    provider: account.provider,
    transport: account.transport,
    remote_host: remoteHost,
    status: remoteStatus,
  };
}

export async function runRemoteAuthLogin(
  context: RuntimeContext,
  accountName: string,
  remoteHost: string,
  options: { rememberMe?: boolean; remoteProjectDir?: string } = {},
): Promise<RemoteAuthLoginEnvelope> {
  const remoteAccount = await resolveRemoteAccount(remoteHost, accountName);
  const remoteStatus = await resolveRemoteAuthStatus(remoteHost, accountName, {
    timeoutMs: REMOTE_AUTH_PREFLIGHT_TIMEOUT_MS,
    bestEffort: true,
  });
  await promptForRemoteReplacement(remoteHost, remoteAccount, remoteStatus);
  const remoteProjectDir = options.remoteProjectDir ?? process.cwd();
  if (options.rememberMe) {
    await preflightRemoteRememberMe(remoteHost, accountName, { remoteProjectDir });
  }

  let envelope: RemoteAuthLoginEnvelope;
  if (remoteAccount.provider === "gmail" && remoteAccount.transport === "gmail-api") {
    envelope = await runRemoteGmailLogin(remoteHost, remoteAccount, context);
  } else if (remoteAccount.provider === "outlook" && remoteAccount.transport === "outlook-web-playwright") {
    envelope = await runRemoteOutlookLogin(remoteHost, remoteAccount, context);
  } else {
    throw new SurfaceError(
      "not_implemented",
      `Remote auth login is not implemented for provider '${remoteAccount.provider}' and transport '${remoteAccount.transport}'.`,
      { account: accountName },
    );
  }

  if (options.rememberMe) {
    envelope.remembered_auth = await rememberRemoteAuthAccount(remoteHost, accountName, {
      remoteProjectDir,
      authCheckIntervalSeconds: context.config.authCheckIntervalSeconds,
    });
  }

  return envelope;
}
