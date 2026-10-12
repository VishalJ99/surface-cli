import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { processCommandLineTokens, snapshotProcessIdentities, type ProcessIdentitySnapshot } from "../../lib/process-identity.js";

import {
  OUTLOOK_TEMP_PROFILE_MARKER_FILENAME,
  OUTLOOK_TEMP_PROFILE_PREFIX,
} from "./temp-profiles.js";

export const DEFAULT_OUTLOOK_ORPHAN_CHROMIUM_GRACE_SECONDS = 600;
export const DEFAULT_OUTLOOK_ORPHAN_CHROMIUM_TERM_WAIT_MS = 2_000;
export const DEFAULT_OUTLOOK_ORPHAN_CHROMIUM_KILL_WAIT_MS = 1_000;

interface OutlookTempProfileMarker {
  version: 1;
  created_at: string;
  owner_pid: number;
  created_by: "surface-cli";
  provider: "outlook";
}

export interface OutlookTempProfileSnapshot {
  profileDir: string;
  marker: unknown;
}

export type OutlookProcessSnapshot = ProcessIdentitySnapshot;

export interface OutlookOrphanChromiumCandidate {
  profileDir: string;
  ownerPid: number;
  browserPid: number;
  processGroupId: number;
  startedAt: string;
}

export interface PlanOutlookOrphanChromiumOptions {
  tmpRoot: string;
  now: Date;
  graceSeconds?: number;
  profiles: readonly OutlookTempProfileSnapshot[];
  processes: readonly OutlookProcessSnapshot[];
  ownerPidLiveness: ReadonlyMap<number, boolean>;
}

export interface ReapOutlookOrphanChromiumDependencies {
  snapshotProfiles?: (tmpRoot: string) => OutlookTempProfileSnapshot[];
  snapshotProcesses?: () => OutlookProcessSnapshot[];
  isPidAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  waitForProcessGroupExit?: (processGroupId: number, timeoutMs: number) => Promise<boolean>;
}

export interface ReapOutlookOrphanChromiumOptions {
  tmpRoot?: string;
  now?: Date;
  graceSeconds?: number;
  termWaitMs?: number;
  killWaitMs?: number;
  dryRun?: boolean;
  dependencies?: ReapOutlookOrphanChromiumDependencies;
}

export interface ReapOutlookOrphanChromiumResult {
  dry_run: boolean;
  planned: number;
  terminated: number;
  force_killed: number;
  exited: number;
  skipped_changed: number;
  errors: Array<{
    browser_pid: number;
    profile_dir: string;
    message: string;
  }>;
}

function parseMarker(value: unknown): OutlookTempProfileMarker | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const marker = value as Partial<OutlookTempProfileMarker>;
  if (
    marker.version !== 1
    || typeof marker.created_at !== "string"
    || !Number.isSafeInteger(marker.owner_pid)
    || (marker.owner_pid ?? 0) <= 1
    || marker.created_by !== "surface-cli"
    || marker.provider !== "outlook"
  ) {
    return null;
  }

  return marker as OutlookTempProfileMarker;
}

function isExactSurfaceProfileChild(tmpRoot: string, profileDir: string): boolean {
  const resolvedRoot = resolve(tmpRoot);
  const resolvedProfile = resolve(profileDir);
  const profileName = basename(resolvedProfile);
  return dirname(resolvedProfile) === resolvedRoot
    && profileName.startsWith(OUTLOOK_TEMP_PROFILE_PREFIX)
    && profileName.length > OUTLOOK_TEMP_PROFILE_PREFIX.length;
}

function commandLineUserDataDirs(commandLine: string): string[] {
  const tokens = processCommandLineTokens(commandLine);
  const profileDirs: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--user-data-dir") {
      const value = tokens[index + 1];
      if (value) {
        profileDirs.push(value);
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--user-data-dir=")) {
      profileDirs.push(token.slice("--user-data-dir=".length));
    }
  }

  return profileDirs;
}

function referencesExactProfile(commandLine: string, profileDir: string): boolean {
  const values = commandLineUserDataDirs(commandLine);
  if (values.length !== 1 || !isAbsolute(values[0] ?? "")) {
    return false;
  }
  return normalize(values[0] ?? "") === normalize(profileDir);
}

function isPlaywrightChromiumBrowserRoot(process: OutlookProcessSnapshot): boolean {
  if (
    !Number.isSafeInteger(process.pid)
    || process.pid <= 1
    || !Number.isSafeInteger(process.processGroupId)
    || process.processGroupId !== process.pid
    || !Number.isFinite(process.elapsedSeconds)
    || process.elapsedSeconds < 0
  ) {
    return false;
  }

  const tokens = processCommandLineTokens(process.commandLine);
  if (tokens.some((token) => token === "--type" || token.startsWith("--type="))) {
    return false;
  }
  if (!tokens.includes("--enable-automation") || !tokens.includes("--remote-debugging-pipe")) {
    return false;
  }

  // Keep this allowlist deliberately narrow. A custom browser binary that does not
  // retain a recognizable Chromium/Chrome basename is skipped instead of guessed.
  return /^(?:Google Chrome(?: Canary)?|Chromium|google-chrome(?:-stable)?|chromium(?:-browser)?|chrome-headless-shell)$/iu
    .test(basename(process.executablePath));
}

function isDescendantOf(
  process: OutlookProcessSnapshot,
  rootPid: number,
  byPid: ReadonlyMap<number, OutlookProcessSnapshot>,
): boolean {
  const visited = new Set<number>([process.pid]);
  let parentPid = process.parentPid;

  while (parentPid > 1 && !visited.has(parentPid)) {
    if (parentPid === rootPid) {
      return true;
    }
    visited.add(parentPid);
    const parent = byPid.get(parentPid);
    if (!parent) {
      return false;
    }
    parentPid = parent.parentPid;
  }
  return false;
}

function ownsEntireProcessGroup(
  root: OutlookProcessSnapshot,
  processes: readonly OutlookProcessSnapshot[],
  byPid: ReadonlyMap<number, OutlookProcessSnapshot>,
): boolean {
  const groupMembers = processes.filter((process) => process.processGroupId === root.processGroupId);
  return groupMembers.length > 0
    && groupMembers.every((process) => process.pid === root.pid || isDescendantOf(process, root.pid, byPid));
}

/**
 * Purely identifies safe kill candidates. It never reads the filesystem, takes a
 * process snapshot, or sends a signal.
 */
export function planOutlookOrphanChromiumReap(
  options: PlanOutlookOrphanChromiumOptions,
): OutlookOrphanChromiumCandidate[] {
  const graceSeconds = options.graceSeconds ?? DEFAULT_OUTLOOK_ORPHAN_CHROMIUM_GRACE_SECONDS;
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
    throw new Error("Outlook orphan Chromium graceSeconds must be a non-negative number.");
  }

  const nowMs = options.now.getTime();
  const graceMs = graceSeconds * 1_000;
  const byPid = new Map(options.processes.map((process) => [process.pid, process]));
  const candidates: OutlookOrphanChromiumCandidate[] = [];
  const seenGroups = new Set<number>();

  for (const profile of options.profiles) {
    if (!isExactSurfaceProfileChild(options.tmpRoot, profile.profileDir)) {
      continue;
    }
    const marker = parseMarker(profile.marker);
    if (!marker || options.ownerPidLiveness.get(marker.owner_pid) !== false) {
      continue;
    }

    const createdAtMs = Date.parse(marker.created_at);
    if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs || nowMs - createdAtMs < graceMs) {
      continue;
    }

    for (const process of options.processes) {
      if (
        process.elapsedSeconds * 1_000 < graceMs
        || !isPlaywrightChromiumBrowserRoot(process)
        || !referencesExactProfile(process.commandLine, profile.profileDir)
        || !ownsEntireProcessGroup(process, options.processes, byPid)
        || seenGroups.has(process.processGroupId)
      ) {
        continue;
      }

      candidates.push({
        profileDir: profile.profileDir,
        ownerPid: marker.owner_pid,
        browserPid: process.pid,
        processGroupId: process.processGroupId,
        startedAt: process.startedAt,
      });
      seenGroups.add(process.processGroupId);
    }
  }

  return candidates;
}

function snapshotOutlookTempProfiles(tmpRoot: string): OutlookTempProfileSnapshot[] {
  let entries;
  try {
    entries = readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const profiles: OutlookTempProfileSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(OUTLOOK_TEMP_PROFILE_PREFIX)) {
      continue;
    }
    const profileDir = join(tmpRoot, entry.name);
    let marker: unknown = null;
    try {
      marker = JSON.parse(
        readFileSync(join(profileDir, OUTLOOK_TEMP_PROFILE_MARKER_FILENAME), "utf8"),
      ) as unknown;
    } catch {
      // Unreadable and invalid markers are returned as null so the planner skips them.
    }
    profiles.push({ profileDir, marker });
  }
  return profiles;
}

const snapshotProcesses = snapshotProcessIdentities;

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isProcessGroupAlive(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) {
      return true;
    }
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  return !isProcessGroupAlive(processGroupId);
}

function ownerLiveness(
  profiles: readonly OutlookTempProfileSnapshot[],
  checkPid: (pid: number) => boolean,
): Map<number, boolean> {
  const result = new Map<number, boolean>();
  for (const profile of profiles) {
    const marker = parseMarker(profile.marker);
    if (!marker || result.has(marker.owner_pid)) {
      continue;
    }
    try {
      result.set(marker.owner_pid, checkPid(marker.owner_pid));
    } catch {
      // Unknown liveness must preserve the browser.
      result.set(marker.owner_pid, true);
    }
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Platform wrapper around the pure planner. It re-snapshots immediately before
 * signalling and only ever addresses a process group as a negative PID after the
 * planner proves that Chrome is the group leader and owns every visible member.
 */
export async function reapOutlookOrphanChromium(
  options: ReapOutlookOrphanChromiumOptions = {},
): Promise<ReapOutlookOrphanChromiumResult> {
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const now = options.now ?? new Date();
  const graceSeconds = options.graceSeconds ?? DEFAULT_OUTLOOK_ORPHAN_CHROMIUM_GRACE_SECONDS;
  const termWaitMs = options.termWaitMs ?? DEFAULT_OUTLOOK_ORPHAN_CHROMIUM_TERM_WAIT_MS;
  const killWaitMs = options.killWaitMs ?? DEFAULT_OUTLOOK_ORPHAN_CHROMIUM_KILL_WAIT_MS;
  const dependencies = options.dependencies ?? {};
  const dryRun = options.dryRun ?? false;
  const takeProfiles = dependencies.snapshotProfiles ?? snapshotOutlookTempProfiles;
  const takeProcesses = dependencies.snapshotProcesses ?? snapshotProcesses;
  const checkPid = dependencies.isPidAlive ?? isPidAlive;
  const sendSignal = dependencies.kill ?? process.kill.bind(process);
  const waitForExit = dependencies.waitForProcessGroupExit ?? waitForProcessGroupExit;

  const profiles = takeProfiles(tmpRoot);
  const processes = takeProcesses();
  const initialPlan = planOutlookOrphanChromiumReap({
    tmpRoot,
    now,
    graceSeconds,
    profiles,
    processes,
    ownerPidLiveness: ownerLiveness(profiles, checkPid),
  });
  const result: ReapOutlookOrphanChromiumResult = {
    dry_run: dryRun,
    planned: initialPlan.length,
    terminated: 0,
    force_killed: 0,
    exited: 0,
    skipped_changed: 0,
    errors: [],
  };

  if (dryRun) {
    return result;
  }

  for (const candidate of initialPlan) {
    const stillSafe = () => {
      const freshProfiles = takeProfiles(tmpRoot);
      const freshProcesses = takeProcesses();
      return planOutlookOrphanChromiumReap({
      tmpRoot,
      now,
      graceSeconds,
      profiles: freshProfiles,
      processes: freshProcesses,
      ownerPidLiveness: ownerLiveness(freshProfiles, checkPid),
    }).some((fresh) =>
      fresh.browserPid === candidate.browserPid
      && fresh.processGroupId === candidate.processGroupId
      && fresh.ownerPid === candidate.ownerPid
      && fresh.profileDir === candidate.profileDir
      && fresh.startedAt === candidate.startedAt
    );

    };

    if (!stillSafe() || !checkPid(candidate.browserPid)) {
      result.skipped_changed += 1;
      continue;
    }

    try {
      sendSignal(-candidate.processGroupId, "SIGTERM");
      result.terminated += 1;
      if (await waitForExit(candidate.processGroupId, termWaitMs)) {
        result.exited += 1;
        continue;
      }

      if (!stillSafe() || !checkPid(candidate.browserPid)) {
        result.skipped_changed += 1;
        continue;
      }
      sendSignal(-candidate.processGroupId, "SIGKILL");
      result.force_killed += 1;
      if (await waitForExit(candidate.processGroupId, killWaitMs)) {
        result.exited += 1;
      } else {
        result.errors.push({
          browser_pid: candidate.browserPid,
          profile_dir: candidate.profileDir,
          message: "Chromium process group remained alive after SIGKILL.",
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        result.exited += 1;
        continue;
      }
      result.errors.push({
        browser_pid: candidate.browserPid,
        profile_dir: candidate.profileDir,
        message: errorMessage(error),
      });
    }
  }

  return result;
}
