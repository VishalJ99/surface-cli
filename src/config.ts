import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const summarizerBackendSchema = z.enum(["openrouter", "openclaw", "none"]);
const sendModeSchema = z.enum(["draft_only", "allow_send"]);
const stringListSchema = z.union([z.string(), z.array(z.string())]);

const fileConfigSchema = z.object({
  cache_dir: z.string().optional(),
  default_result_limit: z.number().int().positive().optional(),
  provider_timeout_ms: z.number().int().positive().optional(),
  summarizer: z
    .object({
      backend: summarizerBackendSchema.optional(),
      model: z.string().min(1).optional(),
      timeout_ms: z.number().int().positive().optional(),
    })
    .optional(),
  summary_input_max_bytes: z.number().int().positive().optional(),
  summarizer_backend: summarizerBackendSchema.optional(),
  summarizer_model: z.string().min(1).optional(),
  summarizer_timeout_ms: z.number().int().positive().optional(),
  writes_enabled: z.boolean().optional(),
  send_mode: sendModeSchema.optional(),
  test_subject_prefix: z.string().min(1).optional(),
  test_recipients: stringListSchema.optional(),
  test_account_allowlist: stringListSchema.optional(),
});

export interface SurfaceConfig {
  cacheDir: string;
  defaultResultLimit: number;
  providerTimeoutMs: number;
  summarizerBackend: "openrouter" | "openclaw" | "none";
  summarizerModel: string;
  summaryInputMaxBytes: number;
  summarizerTimeoutMs: number;
  writesEnabled: boolean;
  sendMode: "draft_only" | "allow_send";
  testSubjectPrefix: string;
  testRecipients: string[];
  testAccountAllowlist: string[];
}

export interface ConfigLoadOptions {
  configPath?: string;
}

export function defaultConfigPath(): string {
  return resolve(homedir(), ".surface-cli", "config.toml");
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function parseConfigFile(rawText: string): z.infer<typeof fileConfigSchema> {
  const parsed = parseToml(rawText);
  return fileConfigSchema.parse(parsed);
}

function envInt(name: string): number | undefined {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }
  return parsed;
}

function envBoolean(name: string): boolean | undefined {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Environment variable ${name} must be a boolean.`);
}

function parseStringList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadConfig(options: ConfigLoadOptions = {}): {
  config: SurfaceConfig;
  configPath: string;
} {
  const configPath = expandHomePath(options.configPath ?? process.env.SURFACE_CONFIG_PATH ?? defaultConfigPath());

  let fileConfig: z.infer<typeof fileConfigSchema> = {};
  try {
    fileConfig = parseConfigFile(readFileSync(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const config: SurfaceConfig = {
    cacheDir: expandHomePath(
      process.env.SURFACE_CACHE_DIR ?? fileConfig.cache_dir ?? resolve(homedir(), ".surface-cli"),
    ),
    defaultResultLimit:
      envInt("SURFACE_DEFAULT_RESULT_LIMIT") ?? fileConfig.default_result_limit ?? 50,
    providerTimeoutMs:
      envInt("SURFACE_PROVIDER_TIMEOUT_MS") ?? fileConfig.provider_timeout_ms ?? 30_000,
    summarizerBackend:
      (process.env.SURFACE_SUMMARIZER_BACKEND as SurfaceConfig["summarizerBackend"] | undefined) ??
      fileConfig.summarizer?.backend ??
      fileConfig.summarizer_backend ??
      "none",
    summarizerModel:
      process.env.SURFACE_SUMMARIZER_MODEL ??
      fileConfig.summarizer?.model ??
      fileConfig.summarizer_model ??
      "openai/gpt-4o-mini",
    summaryInputMaxBytes:
      envInt("SURFACE_SUMMARY_INPUT_MAX_BYTES") ??
      fileConfig.summary_input_max_bytes ??
      16_384,
    summarizerTimeoutMs:
      envInt("SURFACE_SUMMARIZER_TIMEOUT_MS") ??
      fileConfig.summarizer?.timeout_ms ??
      fileConfig.summarizer_timeout_ms ??
      20_000,
    writesEnabled:
      envBoolean("SURFACE_WRITES_ENABLED") ??
      fileConfig.writes_enabled ??
      false,
    sendMode:
      (process.env.SURFACE_SEND_MODE as SurfaceConfig["sendMode"] | undefined) ??
      fileConfig.send_mode ??
      "draft_only",
    testSubjectPrefix:
      process.env.SURFACE_TEST_SUBJECT_PREFIX ??
      fileConfig.test_subject_prefix ??
      "[surface-test]",
    testRecipients:
      parseStringList(process.env.SURFACE_TEST_RECIPIENTS) ??
      parseStringList(fileConfig.test_recipients) ??
      [],
    testAccountAllowlist:
      parseStringList(process.env.SURFACE_TEST_ACCOUNT_ALLOWLIST) ??
      parseStringList(fileConfig.test_account_allowlist) ??
      [],
  };

  return { config, configPath };
}
