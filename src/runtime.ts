import { loadConfig } from "./config.js";
import { buildAccountPaths, buildSurfacePaths, ensureSurfacePaths } from "./paths.js";
import { SurfaceDatabase } from "./state/database.js";
import type { MailAccount } from "./contracts/account.js";

export interface RuntimeContext {
  config: ReturnType<typeof loadConfig>["config"];
  configPath: string;
  paths: ReturnType<typeof buildSurfacePaths>;
  db: SurfaceDatabase;
}

export interface AccountRuntimeContext extends RuntimeContext {
  account: MailAccount;
  accountPaths: ReturnType<typeof buildAccountPaths>;
}

export function createRuntimeContext(options: { configPath?: string } = {}): RuntimeContext {
  const { config, configPath } = loadConfig(options);
  const paths = buildSurfacePaths(config, configPath);
  ensureSurfacePaths(paths);
  const db = new SurfaceDatabase(paths.stateDbPath);

  return {
    config,
    configPath,
    paths,
    db,
  };
}

export function createAccountRuntimeContext(
  context: RuntimeContext,
  account: MailAccount,
): AccountRuntimeContext {
  return {
    ...context,
    account,
    accountPaths: buildAccountPaths(context.paths, account),
  };
}
