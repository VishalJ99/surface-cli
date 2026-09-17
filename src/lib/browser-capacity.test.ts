import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrowserLeaseManager,
  browserAutomationRuntimeConfig,
  type BrowserLease,
  type BrowserProcessIdentity,
} from "./browser-capacity.js";

function manager(root: string, overrides: ConstructorParameters<typeof BrowserLeaseManager>[0] = {}) {
  const { dependencies: dependencyOverrides, ...optionOverrides } = overrides;
  return new BrowserLeaseManager({
    leaseDir: root,
    maxActive: 1,
    acquireTimeoutMs: 10,
    processId: 100,
    dependencies: {
      isPidAlive: (pid) => pid === 100,
      findMarkedBrowserPids: () => [],
      lookupProcessStartTimes: (pids) => new Map(pids.map((pid) => [pid, "test-start"])),
      ...dependencyOverrides,
    },
    ...optionOverrides,
  });
}

test("browser leases bound separate managers sharing one global root", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-browser-capacity-"));
  try {
    const first = await manager(root).acquire();
    await assert.rejects(
      manager(root).acquire(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "browser_busy",
    );
    await first.release();
    const second = await manager(root).acquire();
    await second.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser leases atomically recover one stale reservation under competing launchers", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-browser-capacity-race-"));
  try {
    let childAlive = true;
    const stale = await manager(root, {
      processId: 99,
      dependencies: {
        isPidAlive: (pid) => pid === 99,
        findMarkedBrowserPids: () => [333],
        lookupProcessStartTimes: (pids) => new Map(pids.filter((pid) => pid !== 333 || childAlive).map((pid) => [pid, "test-start"])),
      },
    }).acquire();
    await stale.captureOwnedProcessTree();
    assert.ok(stale.id);
    childAlive = false;

    const sharedLiveness = (pid: number) => pid === 100 || pid === 101;
    const [first, second] = await Promise.allSettled([
      manager(root, { processId: 100, dependencies: { isPidAlive: sharedLiveness, findMarkedBrowserPids: () => [], lookupProcessStartTimes: (pids) => new Map(pids.filter((pid) => pid !== 333 || childAlive).map((pid) => [pid, "test-start"])) } }).acquire(),
      manager(root, { processId: 101, dependencies: { isPidAlive: sharedLiveness, findMarkedBrowserPids: () => [], lookupProcessStartTimes: (pids) => new Map(pids.filter((pid) => pid !== 333 || childAlive).map((pid) => [pid, "test-start"])) } }).acquire(),
    ]);
    const fulfilled: BrowserLease[] = [];
    const rejected: unknown[] = [];
    for (const result of [first, second]) {
      if (result.status === "fulfilled") {
        fulfilled.push(result.value);
      } else {
        rejected.push(result.reason);
      }
    }
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0]! as { code?: string }).code, "browser_busy");
    await fulfilled[0]!.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser leases retain a dead owner's slot when marked browser cleanup cannot complete", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-browser-capacity-orphan-"));
  try {
    const stale = await manager(root, {
      processId: 99,
      dependencies: { isPidAlive: (pid) => pid === 99, findMarkedBrowserPids: () => [444] },
    }).acquire();
    await stale.captureOwnedProcessTree();
    let terminated = false;
    await assert.rejects(
      manager(root, {
        dependencies: {
          isPidAlive: (pid) => pid === 100,
          findMarkedBrowserPids: () => [444],
          terminateCapturedBrowserProcesses: async () => {
            terminated = true;
            return false;
          },
        },
      }).acquire(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "browser_busy",
    );
    assert.equal(terminated, true);
    assert.ok(stale.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser leases preserve an uncaptured stale launch instead of freeing an unknown orphan", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-browser-capacity-uncaptured-"));
  try {
    await manager(root, {
      processId: 99,
      dependencies: { isPidAlive: (pid) => pid === 99, findMarkedBrowserPids: () => [] },
    }).acquire();
    await assert.rejects(
      manager(root).acquire(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "browser_busy",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser-close release reaps a captured descendant after the marker root has crashed", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-browser-capacity-close-orphan-"));
  try {
    let markerVisible = true;
    let childAlive = true;
    let terminated: BrowserProcessIdentity[] | undefined;
    const lease = await manager(root, {
      dependencies: {
        findMarkedBrowserPids: () => (markerVisible && childAlive ? [444] : []),
        lookupProcessStartTimes: (pids) => new Map(
          pids.filter((pid) => pid !== 444 || childAlive).map((pid) => [pid, "test-start"]),
        ),
        terminateCapturedBrowserProcesses: async (processes) => {
          terminated = processes;
          childAlive = false;
          return true;
        },
      },
    }).acquire();
    await lease.captureOwnedProcessTree();
    // The marker-owning browser root is gone, but its captured renderer survives. This mirrors a
    // context close/crash event that must not delete the ledger row before child cleanup.
    markerVisible = false;
    await lease.releaseAfterBrowserClose();
    assert.deepEqual(terminated, [{ pid: 444, startedAt: "test-start" }]);
    const replacement = await manager(root).acquire();
    await replacement.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser leases reap a matching recorded descendant after its marked root has disappeared", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-browser-capacity-descendant-"));
  try {
    const stale = await manager(root, {
      processId: 99,
      dependencies: { isPidAlive: (pid) => pid === 99, findMarkedBrowserPids: () => [444] },
    }).acquire();
    await stale.captureOwnedProcessTree();
    let terminated: BrowserProcessIdentity[] | undefined;
    let childAlive = true;
    const recovered = await manager(root, {
        dependencies: {
          isPidAlive: (pid) => pid === 100 || (pid === 444 && childAlive),
          findMarkedBrowserPids: () => [],
          lookupProcessStartTimes: (pids) => new Map(
            pids.filter((pid) => pid !== 444 || childAlive).map((pid) => [pid, "test-start"]),
          ),
          terminateCapturedBrowserProcesses: async (processes) => {
            terminated = processes;
            childAlive = false;
            return true;
          },
        },
      }).acquire();
    assert.deepEqual(terminated, [{ pid: 444, startedAt: "test-start" }]);
    await recovered.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser leases preserve a reused recorded pid without signalling it", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-browser-capacity-reused-pid-"));
  try {
    const stale = await manager(root, {
      processId: 99,
      dependencies: { isPidAlive: (pid) => pid === 99, findMarkedBrowserPids: () => [444] },
    }).acquire();
    await stale.captureOwnedProcessTree();
    let terminated = false;
    await assert.rejects(
      manager(root, {
        dependencies: {
          isPidAlive: (pid) => pid === 100 || pid === 444,
          findMarkedBrowserPids: () => [],
          lookupProcessStartTimes: (pids) => new Map(pids.map((pid) => [pid, pid === 444 ? "reused-start" : "test-start"])),
          terminateCapturedBrowserProcesses: async () => {
            terminated = true;
            return true;
          },
        },
      }).acquire(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "browser_busy",
    );
    assert.equal(terminated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser capacity configuration uses generic variables before Surface compatibility aliases", () => {
  const config = browserAutomationRuntimeConfig({
    BROWSER_AUTOMATION_LEASE_DIR: "~/shared-browser-budget",
    SURFACE_BROWSER_LEASE_DIR: "/ignored",
    BROWSER_AUTOMATION_MAX_ACTIVE: "2",
    SURFACE_BROWSER_MAX_ACTIVE: "1",
    BROWSER_AUTOMATION_ACQUIRE_TIMEOUT_MS: "20",
    BROWSER_AUTOMATION_COMMAND_TIMEOUT_MS: "1000",
    BROWSER_AUTOMATION_AUTH_IDLE_TIMEOUT_MS: "2000",
    XDG_STATE_HOME: "/ignored-state-home",
  });
  assert.equal(config.maxActive, 2);
  assert.equal(config.acquireTimeoutMs, 20);
  assert.equal(config.commandTimeoutMs, 1000);
  assert.equal(config.authIdleTimeoutMs, 2000);
  assert.equal(config.leaseDir.endsWith("shared-browser-budget"), true);
});
