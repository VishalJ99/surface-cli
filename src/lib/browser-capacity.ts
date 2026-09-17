import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { SurfaceError } from "./errors.js";

const LEASE_VERSION = 1;
const MARKER_PREFIX = "--browser-automation-lease=";

export const DEFAULT_BROWSER_MAX_ACTIVE = 1;
export const DEFAULT_BROWSER_ACQUIRE_TIMEOUT_MS = 750;
export const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 45_000;
export const DEFAULT_BROWSER_AUTH_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

export interface BrowserAutomationRuntimeConfig {
  leaseDir: string;
  maxActive: number;
  acquireTimeoutMs: number;
  commandTimeoutMs: number;
  authIdleTimeoutMs: number;
}

interface BrowserLeaseRecord {
  lease_id: string;
  owner: string;
  kind: string;
  pid: number;
  created_at: string;
  marker: string;
  owned_processes: string;
  capture_complete: number;
}

export interface BrowserProcessIdentity {
  pid: number;
  startedAt: string;
}

interface BrowserCapacityDependencies {
  isPidAlive(pid: number): boolean;
  findMarkedBrowserPids(marker: string): number[] | null;
  lookupProcessStartTimes(pids: number[]): Map<number, string> | null;
  terminateCapturedBrowserProcesses(processes: BrowserProcessIdentity[]): Promise<boolean>;
}

export interface BrowserLeaseManagerOptions {
  leaseDir?: string;
  maxActive?: number;
  acquireTimeoutMs?: number;
  owner?: string;
  kind?: string;
  processId?: number;
  dependencies?: Partial<BrowserCapacityDependencies>;
}

export interface BrowserLease {
  readonly id: string;
  readonly marker: string;
  // If Playwright created a context, use this rather than a direct release. It verifies that the
  // marker-tagged, start-fingerprinted Chromium tree is gone (and reaps only that tree if needed).
  releaseAfterBrowserClose(): Promise<void>;
  release(): Promise<void>;
  releaseAfterFailedLaunch(): Promise<void>;
  captureOwnedProcessTree(): Promise<void>;
}

function boundedPositiveInteger(value: string | undefined, name: string, fallback: number, max: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (!/^[1-9]\d*$/u.test(value.trim())) {
    throw new SurfaceError("invalid_configuration", `${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new SurfaceError("invalid_configuration", `${name} must be at most ${max}.`);
  }
  return parsed;
}

function configuredEnvironmentValue(environment: NodeJS.ProcessEnv, generic: string, surface: string): string | undefined {
  return environment[generic] ?? environment[surface];
}

function resolveConfiguredPath(value: string | undefined, environment: NodeJS.ProcessEnv): string {
  if (!value || value.trim() === "") {
    const stateHome = environment.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
    return resolve(stateHome, "browser-automation", "leases");
  }
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

export function browserAutomationRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BrowserAutomationRuntimeConfig {
  return {
    leaseDir: resolveConfiguredPath(
      configuredEnvironmentValue(environment, "BROWSER_AUTOMATION_LEASE_DIR", "SURFACE_BROWSER_LEASE_DIR"),
      environment,
    ),
    maxActive: boundedPositiveInteger(
      configuredEnvironmentValue(environment, "BROWSER_AUTOMATION_MAX_ACTIVE", "SURFACE_BROWSER_MAX_ACTIVE"),
      "BROWSER_AUTOMATION_MAX_ACTIVE",
      DEFAULT_BROWSER_MAX_ACTIVE,
      32,
    ),
    acquireTimeoutMs: boundedPositiveInteger(
      configuredEnvironmentValue(
        environment,
        "BROWSER_AUTOMATION_ACQUIRE_TIMEOUT_MS",
        "SURFACE_BROWSER_ACQUIRE_TIMEOUT_MS",
      ),
      "BROWSER_AUTOMATION_ACQUIRE_TIMEOUT_MS",
      DEFAULT_BROWSER_ACQUIRE_TIMEOUT_MS,
      60_000,
    ),
    commandTimeoutMs: boundedPositiveInteger(
      configuredEnvironmentValue(
        environment,
        "BROWSER_AUTOMATION_COMMAND_TIMEOUT_MS",
        "SURFACE_BROWSER_COMMAND_TIMEOUT_MS",
      ),
      "BROWSER_AUTOMATION_COMMAND_TIMEOUT_MS",
      DEFAULT_BROWSER_COMMAND_TIMEOUT_MS,
      10 * 60 * 1_000,
    ),
    authIdleTimeoutMs: boundedPositiveInteger(
      configuredEnvironmentValue(
        environment,
        "BROWSER_AUTOMATION_AUTH_IDLE_TIMEOUT_MS",
        "SURFACE_BROWSER_AUTH_IDLE_TIMEOUT_MS",
      ),
      "BROWSER_AUTOMATION_AUTH_IDLE_TIMEOUT_MS",
      DEFAULT_BROWSER_AUTH_IDLE_TIMEOUT_MS,
      60 * 60 * 1_000,
    ),
  };
}

function isPidAlive(pid: number): boolean {
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

interface ProcessEntry {
  uid: number;
  pid: number;
  parentPid: number;
  command: string;
  startedAt: string;
}

function markedBrowserPids(marker: string): number[] | null {
  if (process.platform === "win32" || !process.getuid) {
    return null;
  }
  try {
    const currentUid = process.getuid();
    const output = execFileSync("ps", ["-axo", "uid=,pid=,ppid=,lstart=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const processes: ProcessEntry[] = output.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/u.exec(line);
      if (!match) {
        return [];
      }
      const uid = Number(match[1]);
      const pid = Number(match[2]);
      const parentPid = Number(match[3]);
      if (
        !Number.isSafeInteger(uid)
        || !Number.isSafeInteger(pid)
        || pid <= 0
        || !Number.isSafeInteger(parentPid)
        || parentPid < 0
      ) {
        return [];
      }
      return [{ uid, pid, parentPid, startedAt: match[4]!.trim(), command: match[5]! }];
    });
    const ownProcesses = processes.filter((entry) => entry.uid === currentUid);
    const childrenByParent = new Map<number, number[]>();
    for (const processEntry of ownProcesses) {
      const children = childrenByParent.get(processEntry.parentPid) ?? [];
      children.push(processEntry.pid);
      childrenByParent.set(processEntry.parentPid, children);
    }
    // Only the root browser receives the marker. Its complete descendant tree is the owned
    // Chromium process set; this prevents a stale lease being freed while a renderer or zygote
    // still consumes memory after the root has exited.
    const owned = new Set(ownProcesses.filter((entry) => entry.command.includes(marker)).map((entry) => entry.pid));
    const pending = [...owned];
    while (pending.length > 0) {
      const parent = pending.pop()!;
      for (const child of childrenByParent.get(parent) ?? []) {
        if (!owned.has(child)) {
          owned.add(child);
          pending.push(child);
        }
      }
    }
    return [...owned];
  } catch {
    // Process inspection is required before reclaiming a dead parent's slot. Callers fail closed.
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function processStartTimes(pids: number[]): Map<number, string> | null {
  if (process.platform === "win32" || !process.getuid) {
    return null;
  }
  const wanted = new Set(pids);
  try {
    const currentUid = process.getuid();
    const output = execFileSync("ps", ["-axo", "uid=,pid=,lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const result = new Map<number, string>();
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s*$/u.exec(line);
      if (!match) {
        continue;
      }
      const uid = Number(match[1]);
      const pid = Number(match[2]);
      if (uid === currentUid && wanted.has(pid)) {
        result.set(pid, match[3]!.trim());
      }
    }
    return result;
  } catch {
    return null;
  }
}

function currentCapturedProcesses(processes: BrowserProcessIdentity[]): BrowserProcessIdentity[] | null {
  const starts = processStartTimes(processes.map((processEntry) => processEntry.pid));
  if (starts === null) {
    return null;
  }
  const current: BrowserProcessIdentity[] = [];
  for (const processEntry of processes) {
    const startedAt = starts.get(processEntry.pid);
    if (startedAt === undefined) {
      continue;
    }
    if (startedAt !== processEntry.startedAt) {
      return null;
    }
    current.push(processEntry);
  }
  return current;
}

async function terminateCapturedBrowserProcesses(processes: BrowserProcessIdentity[]): Promise<boolean> {
  const first = currentCapturedProcesses(processes);
  if (first === null) {
    return false;
  }
  for (const processEntry of first) {
    try {
      process.kill(processEntry.pid, "SIGTERM");
    } catch {
      // A vanished owned child is safe; the verification scan below decides whether to release.
    }
  }
  await sleep(750);
  const remaining = currentCapturedProcesses(processes);
  if (remaining === null) {
    return false;
  }
  for (const processEntry of remaining) {
    try {
      process.kill(processEntry.pid, "SIGKILL");
    } catch {
      // A vanished owned child is safe; the verification scan below decides whether to release.
    }
  }
  await sleep(250);
  const finalProcesses = currentCapturedProcesses(processes);
  return finalProcesses !== null && finalProcesses.length === 0;
}

function isSafeOwnerOrKind(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/u.test(value);
}

function sqliteBusy(error: unknown): boolean {
  return (error as { code?: unknown }).code === "SQLITE_BUSY";
}

function parseOwnedProcesses(value: string): BrowserProcessIdentity[] | null {
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed)
      || parsed.length > 256
      || parsed.some((entry) => !entry || typeof entry !== "object" || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || typeof entry.startedAt !== "string" || entry.startedAt.length === 0)
    ) {
      return null;
    }
    return parsed as BrowserProcessIdentity[];
  } catch {
    return null;
  }
}

export class BrowserLeaseManager {
  private readonly leaseDir: string;
  private readonly requestedMaxActive: number;
  private readonly acquireTimeoutMs: number;
  private readonly owner: string;
  private readonly kind: string;
  private readonly processId: number;
  private readonly dependencies: BrowserCapacityDependencies;

  constructor(options: BrowserLeaseManagerOptions = {}) {
    const runtime = browserAutomationRuntimeConfig();
    this.leaseDir = resolve(options.leaseDir ?? runtime.leaseDir);
    this.requestedMaxActive = options.maxActive ?? runtime.maxActive;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? runtime.acquireTimeoutMs;
    this.owner = options.owner ?? "surface";
    this.kind = options.kind ?? "command";
    this.processId = options.processId ?? process.pid;
    if (!Number.isSafeInteger(this.requestedMaxActive) || this.requestedMaxActive <= 0 || this.requestedMaxActive > 32) {
      throw new SurfaceError("invalid_configuration", "Browser capacity must be between 1 and 32.");
    }
    if (!Number.isSafeInteger(this.acquireTimeoutMs) || this.acquireTimeoutMs <= 0 || this.acquireTimeoutMs > 60_000) {
      throw new SurfaceError("invalid_configuration", "Browser acquire timeout must be between 1 and 60000 milliseconds.");
    }
    if (!Number.isSafeInteger(this.processId) || this.processId <= 0) {
      throw new SurfaceError("invalid_configuration", "Browser lease process id is invalid.");
    }
    if (!isSafeOwnerOrKind(this.owner) || !isSafeOwnerOrKind(this.kind)) {
      throw new SurfaceError("invalid_configuration", "Browser lease owner and kind must use safe lowercase identifiers.");
    }
    this.dependencies = {
      isPidAlive: options.dependencies?.isPidAlive ?? isPidAlive,
      findMarkedBrowserPids: options.dependencies?.findMarkedBrowserPids ?? markedBrowserPids,
      lookupProcessStartTimes: options.dependencies?.lookupProcessStartTimes ?? processStartTimes,
      terminateCapturedBrowserProcesses:
        options.dependencies?.terminateCapturedBrowserProcesses ?? terminateCapturedBrowserProcesses,
    };
  }

  private ensureLeaseDirectory(): void {
    mkdirSync(this.leaseDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.leaseDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SurfaceError("invalid_configuration", "Browser lease directory must be a private directory.");
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new SurfaceError("invalid_configuration", "Browser lease directory must be owned by the current user.");
    }
    if (process.platform !== "win32") {
      chmodSync(this.leaseDir, 0o700);
    }
  }

  private openDatabase(): InstanceType<typeof Database> {
    const database = new Database(join(this.leaseDir, "browser-capacity.sqlite"));
    database.pragma(`busy_timeout = ${this.acquireTimeoutMs}`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS browser_automation_budget (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL,
        max_active INTEGER NOT NULL CHECK (max_active BETWEEN 1 AND 32)
      );
      CREATE TABLE IF NOT EXISTS browser_automation_leases (
        lease_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL,
        pid INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        marker TEXT NOT NULL UNIQUE,
        owned_processes TEXT NOT NULL DEFAULT '[]',
        capture_complete INTEGER NOT NULL DEFAULT 0 CHECK (capture_complete IN (0, 1))
      );
    `);
    if (process.platform !== "win32") {
      chmodSync(join(this.leaseDir, "browser-capacity.sqlite"), 0o600);
    }
    return database;
  }

  private readOrCreateBudget(database: InstanceType<typeof Database>): number {
    const existing = database
      .prepare("SELECT version, max_active FROM browser_automation_budget WHERE singleton = 1")
      .get() as { version: number; max_active: number } | undefined;
    if (!existing) {
      database
        .prepare("INSERT INTO browser_automation_budget (singleton, version, max_active) VALUES (1, ?, ?)")
        .run(LEASE_VERSION, this.requestedMaxActive);
      return this.requestedMaxActive;
    }
    if (existing.version !== LEASE_VERSION || existing.max_active !== this.requestedMaxActive) {
      throw new SurfaceError(
        "invalid_configuration",
        "Browser capacity differs from the shared lease budget; use the configured shared limit.",
      );
    }
    return existing.max_active;
  }

  private reserveLease(): { record?: BrowserLeaseRecord; staleProcesses?: BrowserProcessIdentity[] } {
    this.ensureLeaseDirectory();
    let database: InstanceType<typeof Database> | undefined;
    try {
      database = this.openDatabase();
      database.exec("BEGIN IMMEDIATE");
      const capacity = this.readOrCreateBudget(database);
      const leases = database
        .prepare("SELECT lease_id, owner, kind, pid, created_at, marker, owned_processes, capture_complete FROM browser_automation_leases")
        .all() as BrowserLeaseRecord[];
      let active = 0;
      for (const lease of leases) {
        if (this.dependencies.isPidAlive(lease.pid)) {
          active += 1;
          continue;
        }
        if (lease.capture_complete !== 1) {
          // A successful browser launch must record its marker tree. An incomplete record from a
          // crashed launcher cannot establish that an orphan is absent, so it remains fail-closed.
          active += 1;
          continue;
        }
        const markedPids = this.dependencies.findMarkedBrowserPids(lease.marker);
        const recordedProcesses = parseOwnedProcesses(lease.owned_processes);
        if (!recordedProcesses) {
          active += 1;
          continue;
        }
        if (markedPids === null) {
          active += 1;
          continue;
        }
        const currentStarts = this.dependencies.lookupProcessStartTimes([
          ...recordedProcesses.map((processEntry) => processEntry.pid),
          ...markedPids,
        ]);
        if (currentStarts === null) {
          active += 1;
          continue;
        }
        const reusedRecordedPid = recordedProcesses.some((processEntry) => {
          const currentStart = currentStarts.get(processEntry.pid);
          return currentStart !== undefined && currentStart !== processEntry.startedAt;
        });
        if (reusedRecordedPid) {
          active += 1;
          continue;
        }
        const liveRecordedProcesses = recordedProcesses.filter((processEntry) => currentStarts.has(processEntry.pid));
        // A root killed before recovery can leave recorded descendants without the marker in their
        // command lines. Their captured start fingerprint makes an exact same-UID reap safe; a
        // mismatch was handled above as a possible PID reuse and remains fail-closed.
        if (markedPids.length > 0 || liveRecordedProcesses.length > 0) {
          const markedProcesses = markedPids.flatMap((pid) => {
            const startedAt = currentStarts.get(pid);
            return startedAt ? [{ pid, startedAt }] : [];
          });
          database.exec("COMMIT");
          return { staleProcesses: [...markedProcesses, ...liveRecordedProcesses] };
        }
        database.prepare("DELETE FROM browser_automation_leases WHERE lease_id = ?").run(lease.lease_id);
      }
      if (active >= capacity) {
        throw new SurfaceError("browser_busy", "Browser capacity is busy; retry shortly.", { retryable: true });
      }
      const id = randomUUID();
      const record: BrowserLeaseRecord = {
        lease_id: id,
        owner: this.owner,
        kind: this.kind,
        pid: this.processId,
        created_at: new Date().toISOString(),
        marker: `${MARKER_PREFIX}${id}`,
        owned_processes: "[]",
        capture_complete: 0,
      };
      database
        .prepare(`
          INSERT INTO browser_automation_leases (lease_id, version, owner, kind, pid, created_at, marker, owned_processes, capture_complete)
          VALUES (@lease_id, @version, @owner, @kind, @pid, @created_at, @marker, @owned_processes, @capture_complete)
        `)
        .run({ ...record, version: LEASE_VERSION });
      database.exec("COMMIT");
      return { record };
    } catch (error) {
      try {
        database?.exec("ROLLBACK");
      } catch {
        // The transaction either committed or SQLite already rolled it back.
      }
      if (sqliteBusy(error)) {
        throw new SurfaceError("browser_busy", "Browser capacity is busy; retry shortly.", { retryable: true });
      }
      throw error;
    } finally {
      database?.close();
    }
  }

  async acquire(): Promise<BrowserLease> {
    while (true) {
      const result = this.reserveLease();
      if (!result.staleProcesses) {
        const record = result.record!;
        let released = false;
        let capturedProcesses: BrowserProcessIdentity[] | undefined;
        let verifiedReleasePromise: Promise<void> | undefined;
        const releaseRow = async (): Promise<void> => {
          if (released) {
            return;
          }
          let database: InstanceType<typeof Database> | undefined;
          try {
            database = this.openDatabase();
            const deleted = database
              .prepare("DELETE FROM browser_automation_leases WHERE lease_id = ? AND pid = ?")
              .run(record.lease_id, this.processId);
            if (deleted.changes !== 1) {
              throw new SurfaceError("invalid_configuration", "Browser lease ownership changed unexpectedly.");
            }
            released = true;
          } catch (error) {
            if (sqliteBusy(error)) {
              throw new SurfaceError("browser_busy", "Browser capacity is busy; retry shortly.", { retryable: true });
            }
            throw error;
          } finally {
            database?.close();
          }
        };
        const releaseAfterBrowserClose = (): Promise<void> => {
          if (released) {
            return Promise.resolve();
          }
          if (verifiedReleasePromise) {
            return verifiedReleasePromise;
          }
          const pending = (async () => {
            if (!capturedProcesses || capturedProcesses.length === 0) {
              throw new SurfaceError(
                "browser_busy",
                "Browser close could not be verified; retry shortly.",
                { retryable: true },
              );
            }
            const markedPids = this.dependencies.findMarkedBrowserPids(record.marker);
            if (markedPids === null) {
              throw new SurfaceError(
                "browser_busy",
                "Browser close could not be verified; retry shortly.",
                { retryable: true },
              );
            }
            const starts = this.dependencies.lookupProcessStartTimes([
              ...capturedProcesses.map((processEntry) => processEntry.pid),
              ...markedPids,
            ]);
            if (starts === null) {
              throw new SurfaceError(
                "browser_busy",
                "Browser close could not be verified; retry shortly.",
                { retryable: true },
              );
            }
            for (const processEntry of capturedProcesses) {
              const currentStart = starts.get(processEntry.pid);
              if (currentStart !== undefined && currentStart !== processEntry.startedAt) {
                // A PID might have been reused by an unrelated program. Preserve the lease rather
                // than risking a signal to it.
                throw new SurfaceError(
                  "browser_busy",
                  "Browser close could not be verified; retry shortly.",
                  { retryable: true },
                );
              }
            }
            const ownedByPid = new Map<number, BrowserProcessIdentity>();
            for (const processEntry of capturedProcesses) {
              if (starts.has(processEntry.pid)) {
                ownedByPid.set(processEntry.pid, processEntry);
              }
            }
            for (const pid of markedPids) {
              const startedAt = starts.get(pid);
              if (startedAt) {
                ownedByPid.set(pid, { pid, startedAt });
              }
            }
            if (ownedByPid.size > 0 && !(await this.dependencies.terminateCapturedBrowserProcesses([...ownedByPid.values()]))) {
              throw new SurfaceError(
                "browser_busy",
                "Browser close could not be verified; retry shortly.",
                { retryable: true },
              );
            }
            // Re-inspect every captured identity and the marker root/tree after reaping. A
            // release is safe only if neither scan can still identify an owned Chromium process.
            const remainingMarked = this.dependencies.findMarkedBrowserPids(record.marker);
            if (remainingMarked === null) {
              throw new SurfaceError(
                "browser_busy",
                "Browser close could not be verified; retry shortly.",
                { retryable: true },
              );
            }
            const remainingStarts = this.dependencies.lookupProcessStartTimes([
              ...capturedProcesses.map((processEntry) => processEntry.pid),
              ...remainingMarked,
            ]);
            if (remainingStarts === null) {
              throw new SurfaceError(
                "browser_busy",
                "Browser close could not be verified; retry shortly.",
                { retryable: true },
              );
            }
            if (remainingMarked.length > 0 || capturedProcesses.some((processEntry) => remainingStarts.has(processEntry.pid))) {
              throw new SurfaceError(
                "browser_busy",
                "Browser close could not be verified; retry shortly.",
                { retryable: true },
              );
            }
            await releaseRow();
          })();
          verifiedReleasePromise = pending;
          void pending.catch(() => {
            // Let an explicit close path retry a transient inspection or SQLite failure. The lease
            // remains present and fail-closed until one verified attempt deletes it.
            if (!released && verifiedReleasePromise === pending) {
              verifiedReleasePromise = undefined;
            }
          });
          return pending;
        };
        const release = (): Promise<void> => capturedProcesses ? releaseAfterBrowserClose() : releaseRow();
        return {
          id: record.lease_id,
          marker: record.marker,
          releaseAfterBrowserClose,
          release,
          releaseAfterFailedLaunch: async () => {
            const markedPids = this.dependencies.findMarkedBrowserPids(record.marker);
            if (markedPids === null) {
              throw new SurfaceError(
                "browser_busy",
                "Browser launch could not be verified as stopped; retry shortly.",
                { retryable: true },
              );
            }
            const starts = this.dependencies.lookupProcessStartTimes(markedPids);
            if (starts === null) {
              throw new SurfaceError(
                "browser_busy",
                "Browser launch could not be verified as stopped; retry shortly.",
                { retryable: true },
              );
            }
            const processes = markedPids.flatMap((pid) => {
              const startedAt = starts.get(pid);
              return startedAt ? [{ pid, startedAt }] : [];
            });
            if (processes.length > 0 && !(await this.dependencies.terminateCapturedBrowserProcesses(processes))) {
              throw new SurfaceError(
                "browser_busy",
                "Browser launch could not be verified as stopped; retry shortly.",
                { retryable: true },
              );
            }
            await releaseRow();
          },
          captureOwnedProcessTree: async () => {
            const pids = this.dependencies.findMarkedBrowserPids(record.marker);
            if (pids === null || pids.length === 0) {
              throw new SurfaceError("browser_busy", "Browser process ownership could not be captured; retry shortly.", { retryable: true });
            }
            const starts = this.dependencies.lookupProcessStartTimes(pids);
            if (starts === null) {
              throw new SurfaceError("browser_busy", "Browser process ownership could not be captured; retry shortly.", { retryable: true });
            }
            const processes = pids.flatMap((pid) => {
              const startedAt = starts.get(pid);
              return startedAt ? [{ pid, startedAt }] : [];
            });
            if (processes.length !== pids.length) {
              throw new SurfaceError("browser_busy", "Browser process ownership could not be captured; retry shortly.", { retryable: true });
            }
            let database: InstanceType<typeof Database> | undefined;
            try {
              database = this.openDatabase();
              const updated = database
                .prepare("UPDATE browser_automation_leases SET owned_processes = ?, capture_complete = 1 WHERE lease_id = ? AND pid = ?")
                .run(JSON.stringify(processes), record.lease_id, this.processId);
              if (updated.changes !== 1) {
                throw new SurfaceError("invalid_configuration", "Browser lease ownership changed unexpectedly.");
              }
              capturedProcesses = processes;
            } catch (error) {
              if (sqliteBusy(error)) {
                throw new SurfaceError("browser_busy", "Browser capacity is busy; retry shortly.", { retryable: true });
              }
              throw error;
            } finally {
              database?.close();
            }
          },
        };
      }
      if (!(await this.dependencies.terminateCapturedBrowserProcesses(result.staleProcesses))) {
        throw new SurfaceError("browser_busy", "Browser capacity is busy; retry shortly.", { retryable: true });
      }
      // Re-enter the transaction after the verified child-tree reap. A concurrent launcher may
      // reserve the newly freed slot first, which is safe and produces the same retryable result.
    }
  }
}

export async function acquireSurfaceBrowserLease(kind: "auth" | "command" | "warm"): Promise<BrowserLease> {
  const runtime = browserAutomationRuntimeConfig();
  return new BrowserLeaseManager({
    leaseDir: runtime.leaseDir,
    maxActive: runtime.maxActive,
    acquireTimeoutMs: runtime.acquireTimeoutMs,
    owner: "surface",
    kind,
  }).acquire();
}
