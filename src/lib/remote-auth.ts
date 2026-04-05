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

function surfaceRemoteInvoker(surfaceArgs: string[], env: Record<string, string> = {}): string {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellEscape(value)}`)
    .join(" ");
  const escapedArgs = surfaceArgs.map(shellEscape).join(" ");

  return [
    'PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"',
    'if command -v surface >/dev/null 2>&1; then SURFACE_BIN="$(command -v surface)"; elif [ -x /opt/homebrew/bin/surface ]; then SURFACE_BIN=/opt/homebrew/bin/surface; elif [ -x /usr/local/bin/surface ]; then SURFACE_BIN=/usr/local/bin/surface; else echo "surface CLI not found on remote host." >&2; exit 127; fi',
    `${envPrefix ? `${envPrefix} ` : ""}"$SURFACE_BIN" ${escapedArgs}`,
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

async function runRemoteShell(remoteHost: string, command: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("ssh", ["-T", remoteHost, "sh", "-lc", command], {
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

async function runRemoteSurfaceJson<T>(
  remoteHost: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<T> {
  const result = await runRemoteShell(remoteHost, surfaceRemoteInvoker(args, env));
  try {
    return JSON.parse(extractJsonEnvelope(result.stdout)) as T;
  } catch (error) {
    throw new SurfaceError(
      "remote_command_failed",
      `Remote surface ${args.join(" ")} on '${remoteHost}' returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
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

async function resolveRemoteAuthStatus(remoteHost: string, accountName: string): Promise<AuthStatus> {
  const payload = await runRemoteSurfaceJson<RemoteAuthStatusEnvelope>(remoteHost, ["auth", "status", accountName]);
  return payload.status;
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
    const child = spawn("ssh", ["-T", remoteHost, "sh", "-lc", surfaceRemoteInvoker(args, env)], {
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
  const localClientSecret = resolveLocalGmailClientSecretSource(context, account.name);

  await ensureRemoteDirectory(remoteHost, remoteAuthDir);
  await syncPathToRemote(localClientSecret, remoteHost, `${remoteAuthDir}/client_secret.json`);

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

  const remoteStatus = await resolveRemoteAuthStatus(remoteHost, account.name);
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
): Promise<RemoteAuthLoginEnvelope> {
  const remoteAccount = await resolveRemoteAccount(remoteHost, accountName);
  const remoteStatus = await resolveRemoteAuthStatus(remoteHost, accountName);
  await promptForRemoteReplacement(remoteHost, remoteAccount, remoteStatus);

  if (remoteAccount.provider === "gmail" && remoteAccount.transport === "gmail-api") {
    return await runRemoteGmailLogin(remoteHost, remoteAccount, context);
  }

  if (remoteAccount.provider === "outlook" && remoteAccount.transport === "outlook-web-playwright") {
    return await runRemoteOutlookLogin(remoteHost, remoteAccount, context);
  }

  throw new SurfaceError(
    "not_implemented",
    `Remote auth login is not implemented for provider '${remoteAccount.provider}' and transport '${remoteAccount.transport}'.`,
    { account: accountName },
  );
}
