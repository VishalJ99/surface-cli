import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  planOutlookOrphanChromiumReap,
  reapOutlookOrphanChromium,
  type OutlookProcessSnapshot,
  type OutlookTempProfileSnapshot,
} from "./orphan-chromium.js";

const TMP_ROOT = "/tmp/surface-reaper-tests";
const PROFILE = join(TMP_ROOT, "surface-outlook-old-profile");
const NOW = new Date("2026-07-13T12:00:00Z");
const OWNER_PID = 4_200;
const BROWSER_PID = 8_100;

function marker(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    created_at: "2026-07-13T11:00:00Z",
    owner_pid: OWNER_PID,
    created_by: "surface-cli",
    provider: "outlook",
    ...overrides,
  };
}

function profile(overrides: Partial<OutlookTempProfileSnapshot> = {}): OutlookTempProfileSnapshot {
  return { profileDir: PROFILE, marker: marker(), ...overrides };
}

function browser(overrides: Partial<OutlookProcessSnapshot> = {}): OutlookProcessSnapshot {
  return {
    pid: BROWSER_PID,
    parentPid: 1,
    processGroupId: BROWSER_PID,
    startedAt: "Mon Jul 13 11:00:00 2026",
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    elapsedSeconds: 3_600,
    commandLine:
      `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --enable-automation --headless --user-data-dir=${PROFILE} --remote-debugging-pipe about:blank`,
    ...overrides,
  };
}

function renderer(overrides: Partial<OutlookProcessSnapshot> = {}): OutlookProcessSnapshot {
  return {
    pid: BROWSER_PID + 1,
    parentPid: BROWSER_PID,
    processGroupId: BROWSER_PID,
    startedAt: "Mon Jul 13 11:00:01 2026",
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper",
    elapsedSeconds: 3_599,
    commandLine:
      `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer --user-data-dir=${PROFILE}`,
    ...overrides,
  };
}

function plan(options: {
  profiles?: OutlookTempProfileSnapshot[];
  processes?: OutlookProcessSnapshot[];
  ownerAlive?: boolean;
  graceSeconds?: number;
} = {}) {
  return planOutlookOrphanChromiumReap({
    tmpRoot: TMP_ROOT,
    now: NOW,
    graceSeconds: options.graceSeconds ?? 600,
    profiles: options.profiles ?? [profile()],
    processes: options.processes ?? [browser(), renderer()],
    ownerPidLiveness: new Map([[OWNER_PID, options.ownerAlive ?? false]]),
  });
}

test("planner selects an old marked Playwright Chrome root whose owner is dead", () => {
  assert.deepEqual(plan(), [{
    profileDir: PROFILE,
    ownerPid: OWNER_PID,
    browserPid: BROWSER_PID,
    processGroupId: BROWSER_PID,
    startedAt: "Mon Jul 13 11:00:00 2026",
  }]);
});

test("planner requires an exact user-data-dir rather than a path substring", () => {
  const wrongProfile = `${PROFILE}-other`;
  assert.deepEqual(plan({
    processes: [browser({
      commandLine:
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --enable-automation --user-data-dir=${wrongProfile} --remote-debugging-pipe`,
    })],
  }), []);
});

test("planner never selects unrelated Chrome or a non-Chrome process with copied flags", () => {
  assert.deepEqual(plan({
    processes: [
      browser({
        commandLine:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --enable-automation --user-data-dir=/tmp/unrelated --remote-debugging-pipe",
      }),
      browser({
        pid: BROWSER_PID + 10,
        processGroupId: BROWSER_PID + 10,
        executablePath: "/usr/bin/not-a-browser",
        commandLine: `/usr/bin/not-a-browser --enable-automation --user-data-dir=${PROFILE} --remote-debugging-pipe`,
      }),
    ],
  }), []);
});

test("planner never promotes a renderer-only entry to browser root", () => {
  assert.deepEqual(plan({ processes: [renderer({ processGroupId: BROWSER_PID + 1 })] }), []);
});

test("planner preserves profiles whose marked owner is alive or liveness is unknown", () => {
  assert.deepEqual(plan({ ownerAlive: true }), []);
  assert.deepEqual(planOutlookOrphanChromiumReap({
    tmpRoot: TMP_ROOT,
    now: NOW,
    profiles: [profile()],
    processes: [browser()],
    ownerPidLiveness: new Map(),
  }), []);
});

test("planner rejects absent, invalid, or non-Surface markers", () => {
  for (const invalidMarker of [
    null,
    marker({ version: 2 }),
    marker({ created_by: "another-tool" }),
    marker({ provider: "gmail" }),
    marker({ owner_pid: 1 }),
    marker({ created_at: "not-a-date" }),
  ]) {
    assert.deepEqual(plan({ profiles: [profile({ marker: invalidMarker })] }), []);
  }
});

test("planner requires both the marker and browser process to be older than grace", () => {
  assert.deepEqual(plan({
    profiles: [profile({ marker: marker({ created_at: "2026-07-13T11:55:00Z" }) })],
  }), []);
  assert.deepEqual(plan({ processes: [browser({ elapsedSeconds: 599 })] }), []);
});

test("planner only accepts direct surface-outlook temp children", () => {
  assert.deepEqual(plan({ profiles: [profile({ profileDir: join(TMP_ROOT, "unrelated-profile") })] }), []);
  assert.deepEqual(plan({
    profiles: [profile({ profileDir: join(TMP_ROOT, "nested", "surface-outlook-old-profile") })],
  }), []);
});

test("planner rejects a browser that is not its process-group leader", () => {
  assert.deepEqual(plan({
    processes: [browser({ processGroupId: BROWSER_PID - 1 })],
  }), []);
});

test("planner rejects a process group containing a member outside the Chrome root tree", () => {
  assert.deepEqual(plan({
    processes: [
      browser(),
      renderer(),
      {
        pid: BROWSER_PID + 2,
        parentPid: 1,
        processGroupId: BROWSER_PID,
        startedAt: "Mon Jul 13 11:00:00 2026",
        executablePath: "/usr/bin/unrelated-worker",
        elapsedSeconds: 3_000,
        commandLine: "/usr/bin/unrelated-worker",
      },
    ],
  }), []);
});

test("reaper revalidates then sends SIGTERM to the negative process group only", async () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  const snapshots = [browser(), renderer()];
  const result = await reapOutlookOrphanChromium({
    tmpRoot: TMP_ROOT,
    now: NOW,
    graceSeconds: 600,
    dependencies: {
      snapshotProfiles: () => [profile()],
      snapshotProcesses: () => snapshots,
      isPidAlive: (pid) => pid === BROWSER_PID,
      kill: (pid, signal) => signals.push([pid, signal]),
      waitForProcessGroupExit: async () => true,
    },
  });

  assert.deepEqual(signals, [[-BROWSER_PID, "SIGTERM"]]);
  assert.deepEqual(result, {
    dry_run: false,
    planned: 1,
    terminated: 1,
    force_killed: 0,
    exited: 1,
    skipped_changed: 0,
    errors: [],
  });
});

test("reaper escalates a surviving group using only a negative SIGKILL target", async () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  let waitCalls = 0;
  const result = await reapOutlookOrphanChromium({
    tmpRoot: TMP_ROOT,
    now: NOW,
    dependencies: {
      snapshotProfiles: () => [profile()],
      snapshotProcesses: () => [browser(), renderer()],
      isPidAlive: (pid) => pid === BROWSER_PID,
      kill: (pid, signal) => signals.push([pid, signal]),
      waitForProcessGroupExit: async () => {
        waitCalls += 1;
        return waitCalls === 2;
      },
    },
  });

  assert.deepEqual(signals, [
    [-BROWSER_PID, "SIGTERM"],
    [-BROWSER_PID, "SIGKILL"],
  ]);
  assert.equal(result.force_killed, 1);
  assert.equal(result.exited, 1);
});

test("reaper sends no signal if the candidate changes before final validation", async () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  let snapshots = 0;
  const result = await reapOutlookOrphanChromium({
    tmpRoot: TMP_ROOT,
    now: NOW,
    dependencies: {
      snapshotProfiles: () => [profile()],
      snapshotProcesses: () => {
        snapshots += 1;
        return snapshots === 1 ? [browser(), renderer()] : [renderer({ processGroupId: BROWSER_PID + 1 })];
      },
      isPidAlive: (pid) => pid === BROWSER_PID,
      kill: (pid, signal) => signals.push([pid, signal]),
      waitForProcessGroupExit: async () => true,
    },
  });

  assert.deepEqual(signals, []);
  assert.equal(result.planned, 1);
  assert.equal(result.skipped_changed, 1);
});

test("reaper dry-run reports candidates without signalling", async () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  const result = await reapOutlookOrphanChromium({
    tmpRoot: TMP_ROOT,
    now: NOW,
    dryRun: true,
    dependencies: {
      snapshotProfiles: () => [profile()],
      snapshotProcesses: () => [browser(), renderer()],
      isPidAlive: (pid) => pid === BROWSER_PID,
      kill: (pid, signal) => signals.push([pid, signal]),
      waitForProcessGroupExit: async () => true,
    },
  });

  assert.deepEqual(signals, []);
  assert.equal(result.dry_run, true);
  assert.equal(result.planned, 1);
  assert.equal(result.terminated, 0);
});


test("planner rejects Chrome-looking argv owned by a Python executable", () => {
  assert.deepEqual(plan({ processes: [browser({ executablePath: "/usr/bin/python", commandLine:
    `/usr/bin/python /tmp/Chromium --enable-automation --user-data-dir=${PROFILE} --remote-debugging-pipe` })] }), []);
});

test("reaper refuses delayed SIGKILL after root PID identity or group ownership changes", async () => {
  for (const changed of [
    [browser({ startedAt: "Mon Jul 13 11:30:00 2026" }), renderer()],
    [browser({ executablePath: "/usr/bin/python" }), renderer()],
    [browser(), renderer({ parentPid: 1 })],
  ]) {
    const signals: Array<[number, NodeJS.Signals]> = [];
    let afterTerm = false;
    const result = await reapOutlookOrphanChromium({ tmpRoot: TMP_ROOT, now: NOW, dependencies: {
      snapshotProfiles: () => [profile()], snapshotProcesses: () => afterTerm ? changed : [browser(), renderer()],
      isPidAlive: pid => pid === BROWSER_PID,
      kill: (pid, signal) => { signals.push([pid, signal]); afterTerm = true; },
      waitForProcessGroupExit: async () => false,
    }});
    assert.deepEqual(signals, [[-BROWSER_PID, "SIGTERM"]]);
    assert.equal(result.force_killed, 0); assert.equal(result.skipped_changed, 1);
  }
});
