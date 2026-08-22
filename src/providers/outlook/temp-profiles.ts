import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const OUTLOOK_TEMP_PROFILE_PREFIX = "surface-outlook-";
export const OUTLOOK_TEMP_PROFILE_MARKER_FILENAME = ".surface-temp-profile.json";
export const DEFAULT_OUTLOOK_TEMP_PROFILE_MAX_AGE_SECONDS = 21_600;

interface OutlookTempProfileMarker {
  version: 1;
  created_at: string;
  owner_pid: number;
  created_by: "surface-cli";
  provider: "outlook";
}

export interface OutlookTempProfilePruneOptions {
  tmpRoot?: string;
  now?: Date;
  maxAgeSeconds?: number;
  dryRun?: boolean;
  processArgs?: readonly string[];
  isPidAlive?: (pid: number) => boolean;
}

export interface OutlookTempProfilePruneResult {
  scanned: number;
  removed: number;
  skipped_active: number;
  skipped_young: number;
  skipped_error: number;
  removed_bytes: number;
  dry_run: boolean;
}

export interface OutlookTempProfileCloneOptions {
  tmpRoot?: string;
  now?: Date;
}

function directorySizeBytes(rootPath: string): number {
  if (!existsSync(rootPath)) {
    return 0;
  }

  const stats = statSync(rootPath);
  if (stats.isFile()) {
    return stats.size;
  }

  let total = 0;
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    total += directorySizeBytes(join(rootPath, entry.name));
  }
  return total;
}

function defaultProcessArgs(): string[] {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return [];
  }

  try {
    return execFileSync("ps", ["-axo", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readMarker(profileDir: string): OutlookTempProfileMarker | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(profileDir, OUTLOOK_TEMP_PROFILE_MARKER_FILENAME), "utf8"),
    ) as Partial<OutlookTempProfileMarker>;
    if (
      parsed.version === 1
      && typeof parsed.created_at === "string"
      && typeof parsed.owner_pid === "number"
      && parsed.created_by === "surface-cli"
      && parsed.provider === "outlook"
    ) {
      return parsed as OutlookTempProfileMarker;
    }
  } catch {
    return null;
  }

  return null;
}

function writeMarker(profileDir: string, now: Date): void {
  const marker: OutlookTempProfileMarker = {
    version: 1,
    created_at: now.toISOString(),
    owner_pid: process.pid,
    created_by: "surface-cli",
    provider: "outlook",
  };

  try {
    writeFileSync(
      join(profileDir, OUTLOOK_TEMP_PROFILE_MARKER_FILENAME),
      `${JSON.stringify(marker, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // The marker improves future pruning, but normal session cleanup still owns this temp dir.
  }
}

function markerCreatedAtMs(marker: OutlookTempProfileMarker | null): number | null {
  if (!marker) {
    return null;
  }

  const createdAtMs = Date.parse(marker.created_at);
  return Number.isFinite(createdAtMs) ? createdAtMs : null;
}

function processArgsContainProfile(processArgs: readonly string[], profileDir: string): boolean {
  const candidatePaths = new Set([profileDir]);
  try {
    candidatePaths.add(resolve(profileDir));
    candidatePaths.add(statSync(profileDir).isDirectory() ? resolve(profileDir) : profileDir);
  } catch {
    // Ignore; a path that vanished during scanning will be counted as a per-profile error elsewhere.
  }

  for (const candidatePath of [...candidatePaths]) {
    try {
      candidatePaths.add(realpathSync(candidatePath));
    } catch {
      // Symlink-normalized paths are best-effort only.
    }
  }

  return processArgs.some((args) => [...candidatePaths].some((candidatePath) => args.includes(candidatePath)));
}

function isSurfaceOutlookTempProfileChild(tmpRoot: string, entryName: string): boolean {
  if (!entryName.startsWith(OUTLOOK_TEMP_PROFILE_PREFIX)) {
    return false;
  }

  const parent = resolve(tmpRoot);
  const candidate = resolve(tmpRoot, entryName);
  return dirname(candidate) === parent && basename(candidate) === entryName;
}

export function createOutlookTempProfileClone(
  profileDir: string,
  options: OutlookTempProfileCloneOptions = {},
): string {
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const now = options.now ?? new Date();
  mkdirSync(tmpRoot, { recursive: true });

  const tempProfileDir = join(
    tmpRoot,
    `${OUTLOOK_TEMP_PROFILE_PREFIX}${now.getTime()}-${Math.random().toString(36).slice(2)}`,
  );
  cpSync(profileDir, tempProfileDir, { recursive: true });
  writeMarker(tempProfileDir, now);
  return tempProfileDir;
}

export function pruneOutlookTempProfiles(
  options: OutlookTempProfilePruneOptions = {},
): OutlookTempProfilePruneResult {
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const now = options.now ?? new Date();
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_OUTLOOK_TEMP_PROFILE_MAX_AGE_SECONDS;
  const maxAgeMs = maxAgeSeconds * 1000;
  const dryRun = options.dryRun ?? false;
  const processArgs = options.processArgs ?? defaultProcessArgs();
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const result: OutlookTempProfilePruneResult = {
    scanned: 0,
    removed: 0,
    skipped_active: 0,
    skipped_young: 0,
    skipped_error: 0,
    removed_bytes: 0,
    dry_run: dryRun,
  };

  let entries;
  try {
    entries = readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    result.skipped_error += 1;
    return result;
  }

  for (const entry of entries) {
    if (!isSurfaceOutlookTempProfileChild(tmpRoot, entry.name)) {
      continue;
    }

    result.scanned += 1;
    const profileDir = join(tmpRoot, entry.name);

    try {
      if (!entry.isDirectory()) {
        result.skipped_error += 1;
        continue;
      }

      const stats = statSync(profileDir);
      const marker = readMarker(profileDir);
      if (marker && isPidAlive(marker.owner_pid)) {
        result.skipped_active += 1;
        continue;
      }

      if (processArgsContainProfile(processArgs, profileDir)) {
        result.skipped_active += 1;
        continue;
      }

      const createdAtMs = markerCreatedAtMs(marker) ?? stats.mtimeMs;
      if (maxAgeMs > 0 && now.getTime() - createdAtMs < maxAgeMs) {
        result.skipped_young += 1;
        continue;
      }

      const bytes = directorySizeBytes(profileDir);
      result.removed += 1;
      result.removed_bytes += bytes;
      if (!dryRun) {
        rmSync(profileDir, { recursive: true, force: true });
      }
    } catch {
      result.skipped_error += 1;
    }
  }

  return result;
}
