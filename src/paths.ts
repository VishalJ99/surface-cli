import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { MailAccount } from "./contracts/account.js";
import type { SurfaceConfig } from "./config.js";

export interface SurfacePaths {
  rootDir: string;
  configPath: string;
  stateDbPath: string;
  authDir: string;
  cacheDir: string;
  downloadsDir: string;
  sessionsDir: string;
}

export interface AccountPaths {
  authDir: string;
  cacheDir: string;
  messagesDir: string;
  downloadsDir: string;
}

export function buildSurfacePaths(config: SurfaceConfig, configPath: string): SurfacePaths {
  return {
    rootDir: config.cacheDir,
    configPath,
    stateDbPath: join(config.cacheDir, "state.db"),
    authDir: join(config.cacheDir, "auth"),
    cacheDir: join(config.cacheDir, "cache"),
    downloadsDir: join(config.cacheDir, "downloads"),
    sessionsDir: join(config.cacheDir, "sessions"),
  };
}

export function ensureSurfacePaths(paths: SurfacePaths): void {
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.authDir, { recursive: true });
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.downloadsDir, { recursive: true });
  mkdirSync(paths.sessionsDir, { recursive: true });
}

export function buildAccountPaths(paths: SurfacePaths, account: MailAccount): AccountPaths {
  const authDir = join(paths.authDir, account.account_id);
  const cacheDir = join(paths.cacheDir, account.account_id);
  return {
    authDir,
    cacheDir,
    messagesDir: join(cacheDir, "messages"),
    downloadsDir: join(paths.downloadsDir, account.account_id),
  };
}
