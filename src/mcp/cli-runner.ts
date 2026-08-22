import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, parse as parsePath, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type JsonObject = Record<string, unknown>;

export interface SurfaceCliResult {
  payload: JsonObject;
  isError: boolean;
}

export interface SurfaceCliCallOptions {
  signal?: AbortSignal;
  interruptionRetryable?: boolean;
}

export type SurfaceCliExecutor = (
  argv: readonly string[],
  options?: SurfaceCliCallOptions,
) => Promise<SurfaceCliResult>;

export interface SurfaceCliExecutorOptions {
  cliPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  terminateGraceMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  attachmentRoots?: readonly string[];
  shutdownSignal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATE_GRACE_MS = 2_000;
const DEFAULT_MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 96 * 1024;
const MAX_ARGV_BYTES = process.platform === "win32" ? 24 * 1024 : 128 * 1024;
const SCRUBBED_CHILD_ENVIRONMENT_VARIABLES = [
  "CONTROL_PLANE_API_KEY",
] as const;
const FORBIDDEN_SPLIT_VALUE_OPTIONS = new Set([
  "--account",
  "--attach",
  "--bcc",
  "--body",
  "--cc",
  "--from",
  "--idle-timeout",
  "--interval",
  "--label",
  "--limit",
  "--mailbox",
  "--max-age",
  "--recipient",
  "--response",
  "--session",
  "--subject",
  "--text",
  "--thread",
  "--to",
]);
function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorEnvelope(code: string, message: string, retryable: boolean): JsonObject {
  return {
    schema_version: "1",
    error: {
      code,
      message,
      retryable,
      account: null,
      message_ref: null,
      thread_ref: null,
    },
  };
}

function errorResult(code: string, message: string, retryable = false): SurfaceCliResult {
  return {
    payload: errorEnvelope(code, message, retryable),
    isError: true,
  };
}

function interruptionResult(reason: "cancelled" | "timed out", retryable: boolean): SurfaceCliResult {
  if (retryable) {
    return errorResult(
      reason === "cancelled" ? "request_cancelled" : "surface_cli_timeout",
      reason === "cancelled"
        ? "The MCP request was cancelled."
        : "Surface CLI exceeded the MCP execution timeout.",
      true,
    );
  }
  return errorResult(
    "mcp_outcome_unknown",
    `Surface CLI ${reason} before reporting whether the action completed. Do not retry automatically; inspect state first.`,
  );
}

function parseConfiguredAttachmentRoots(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
        throw new Error("expected a JSON array of strings");
      }
      return parsed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid SURFACE_MCP_ATTACHMENT_ROOTS: ${detail}`);
    }
  }

  return trimmed.split(delimiter).filter((entry) => entry !== "");
}

function canonicalizeRoots(roots: readonly string[]): string[] {
  return roots.map((root) => {
    if (root.trim() === "" || !isAbsolute(root)) {
      throw new Error("MCP attachment roots must be non-empty absolute paths.");
    }
    const canonicalRoot = realpathSync(root);
    if (canonicalRoot === parsePath(canonicalRoot).root) {
      throw new Error("The filesystem root cannot be used as an MCP attachment root.");
    }
    if (!statSync(canonicalRoot).isDirectory()) {
      throw new Error(`MCP attachment root is not a directory: ${root}`);
    }
    return canonicalRoot;
  });
}

function isInsideRoot(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function containsUnsafeOptionForm(argv: readonly string[]): boolean {
  return argv.some((argument) => (
    argument === "--config"
    || argument.startsWith("--config=")
    || FORBIDDEN_SPLIT_VALUE_OPTIONS.has(argument)
  ));
}

function validateArgumentBounds(argv: readonly string[]): SurfaceCliResult | undefined {
  let totalBytes = 0;
  for (const argument of argv) {
    const bytes = Buffer.byteLength(argument, "utf8") + 1;
    if (bytes > MAX_ARGUMENT_BYTES) {
      return errorResult(
        "mcp_input_too_large",
        "One MCP input exceeds the safe subprocess argument size. Shorten the message or filter.",
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_ARGV_BYTES) {
    return errorResult(
      "mcp_input_too_large",
      "The combined MCP input exceeds the safe subprocess argument size. Shorten the message or recipient list.",
    );
  }
  return undefined;
}

function prepareAttachmentArguments(
  argv: readonly string[],
  roots: readonly string[],
  maxAttachmentBytes: number,
  maxTotalAttachmentBytes: number,
): string[] | SurfaceCliResult {
  const prepared = [...argv];
  let totalAttachmentBytes = 0;
  for (let index = 0; index < prepared.length; index += 1) {
    if (!prepared[index]?.startsWith("--attach=")) {
      continue;
    }

    const requestedPath = prepared[index]!.slice("--attach=".length);
    if (roots.length === 0) {
      return errorResult(
        "attachment_paths_disabled",
        "MCP attachment paths are disabled. Configure SURFACE_MCP_ATTACHMENT_ROOTS on the server.",
      );
    }

    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(resolve(requestedPath));
    } catch {
      return errorResult("invalid_attachment_path", "The requested attachment does not exist.");
    }
    if (!roots.some((root) => isInsideRoot(canonicalPath, root))) {
      return errorResult(
        "attachment_path_not_allowed",
        "The requested attachment is outside the server's configured attachment roots.",
      );
    }
    let attachmentStat;
    try {
      attachmentStat = statSync(canonicalPath);
    } catch {
      return errorResult("invalid_attachment_path", "The requested attachment is no longer available.");
    }
    if (!attachmentStat.isFile()) {
      return errorResult("invalid_attachment_path", "The requested attachment is not a regular file.");
    }
    totalAttachmentBytes += attachmentStat.size;
    if (
      attachmentStat.size > maxAttachmentBytes
      || totalAttachmentBytes > maxTotalAttachmentBytes
    ) {
      return errorResult(
        "attachment_too_large",
        "The requested attachment set exceeds the MCP server's configured size limit.",
      );
    }
    prepared[index] = `--attach=${canonicalPath}`;
  }
  return prepared;
}

function stopProcess(child: Pick<ChildProcess, "pid" | "kill">, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group already exited or was not created.
    }
  }
  child.kill(signal);
}

function runSurfaceCli(
  argv: readonly string[],
  options: Required<Pick<
    SurfaceCliExecutorOptions,
    "cliPath" | "cwd" | "env" | "timeoutMs" | "terminateGraceMs" | "maxStdoutBytes" | "maxStderrBytes"
  >>,
  signals: readonly AbortSignal[],
  interruptionRetryable: boolean,
): Promise<SurfaceCliResult> {
  if (signals.some((signal) => signal.aborted)) {
    return Promise.resolve(interruptionResult("cancelled", interruptionRetryable));
  }

  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [options.cliPath, ...argv], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError: SurfaceCliResult | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (result: SurfaceCliResult): void => {
      if (terminalError !== undefined) {
        return;
      }
      terminalError = result;
      stopProcess(child, "SIGTERM");
      killTimer = setTimeout(() => stopProcess(child, "SIGKILL"), options.terminateGraceMs);
      killTimer.unref();
    };

    const timeout = setTimeout(() => {
      terminate(interruptionResult("timed out", interruptionRetryable));
    }, options.timeoutMs);
    timeout.unref();

    const onAbort = (): void => {
      terminate(interruptionResult("cancelled", interruptionRetryable));
    };
    for (const signal of signals) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (signals.some((signal) => signal.aborted)) {
      onAbort();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) {
        terminate(errorResult("surface_cli_output_too_large", "Surface CLI stdout exceeded the MCP limit."));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxStderrBytes) {
        terminate(errorResult("surface_cli_stderr_too_large", "Surface CLI stderr exceeded the MCP limit."));
      }
    });

    child.on("error", (error) => {
      void error;
      terminalError ??= errorResult("surface_cli_spawn_failed", "Could not start Surface CLI.");
    });

    child.on("close", (code, closeSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      for (const signal of signals) {
        signal.removeEventListener("abort", onAbort);
      }

      if (terminalError !== undefined) {
        resolveResult(terminalError);
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      let payload: unknown;
      try {
        payload = JSON.parse(stdout);
      } catch {
        resolveResult(errorResult(
          "surface_cli_invalid_json",
          "Surface CLI did not return one valid JSON envelope.",
        ));
        return;
      }

      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        resolveResult(errorResult(
          "surface_cli_invalid_json",
          "Surface CLI returned JSON that was not an object envelope.",
        ));
        return;
      }

      const objectPayload = payload as JsonObject;
      const failed = code !== 0 || closeSignal !== null || Object.hasOwn(objectPayload, "error");
      resolveResult({ payload: objectPayload, isError: failed });
    });
  });
}

export function createSurfaceCliExecutor(options: SurfaceCliExecutorOptions = {}): SurfaceCliExecutor {
  const env = { ...(options.env ?? process.env) };
  for (const variable of SCRUBBED_CHILD_ENVIRONMENT_VARIABLES) {
    delete env[variable];
  }
  const configuredRoots = options.attachmentRoots
    ?? parseConfiguredAttachmentRoots(env.SURFACE_MCP_ATTACHMENT_ROOTS);
  const attachmentRoots = canonicalizeRoots(configuredRoots);
  const cliPath = options.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url));
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs
    ?? positiveInteger(env.SURFACE_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const maxStdoutBytes = options.maxStdoutBytes
    ?? positiveInteger(env.SURFACE_MCP_MAX_STDOUT_BYTES, DEFAULT_MAX_STDOUT_BYTES);
  const maxStderrBytes = options.maxStderrBytes
    ?? positiveInteger(env.SURFACE_MCP_MAX_STDERR_BYTES, DEFAULT_MAX_STDERR_BYTES);
  const maxAttachmentBytes = options.maxAttachmentBytes
    ?? positiveInteger(env.SURFACE_MCP_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES);
  const maxTotalAttachmentBytes = options.maxTotalAttachmentBytes
    ?? positiveInteger(
      env.SURFACE_MCP_MAX_TOTAL_ATTACHMENT_BYTES,
      DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
    );

  let queue: Promise<void> = Promise.resolve();

  return (argv, callOptions = {}) => {
    const invoke = async (): Promise<SurfaceCliResult> => {
      if (containsUnsafeOptionForm(argv)) {
        return errorResult(
          "mcp_argument_not_allowed",
          "MCP tool arguments must use reviewed atomic option forms and cannot select a Surface config path.",
        );
      }
      const argumentBoundsError = validateArgumentBounds(argv);
      if (argumentBoundsError !== undefined) {
        return argumentBoundsError;
      }
      const preparedArgv = prepareAttachmentArguments(
        argv,
        attachmentRoots,
        maxAttachmentBytes,
        maxTotalAttachmentBytes,
      );
      if (!Array.isArray(preparedArgv)) {
        return preparedArgv;
      }
      const signals = [callOptions.signal, options.shutdownSignal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      return runSurfaceCli(preparedArgv, {
        cliPath,
        cwd,
        env,
        timeoutMs,
        terminateGraceMs,
        maxStdoutBytes,
        maxStderrBytes,
      }, signals, callOptions.interruptionRetryable ?? false);
    };

    const result = queue.then(invoke, invoke);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
}
