import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BrowserContext, Page } from "playwright-core";

import {
  closeOutlookSession,
  launchOutlookSession,
  type OutlookSession,
  type OutlookSessionLaunchDependencies,
} from "./session.js";

function makeProfileRoot(): { root: string; profileDir: string; cloneDir: string } {
  const root = mkdtempSync(join(tmpdir(), "surface-outlook-session-lifecycle-"));
  const profileDir = join(root, "profile");
  const cloneDir = join(root, "surface-outlook-test-clone");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "Cookies"), "test profile\n", "utf8");
  return { root, profileDir, cloneDir };
}

function fakePage(): Page {
  return {
    setDefaultTimeout() {},
  } as unknown as Page;
}

const noOrphanReap: NonNullable<OutlookSessionLaunchDependencies["reapOrphanChromium"]> = async () => ({
  dry_run: false,
  planned: 0,
  terminated: 0,
  force_killed: 0,
  exited: 0,
  skipped_changed: 0,
  errors: [],
});

test("closeOutlookSession is idempotent and cleans up when context close rejects", async () => {
  const closeError = new Error("context close failed");
  let closeCalls = 0;
  let cleanupCalls = 0;
  const session: OutlookSession = {
    context: {
      async close() {
        closeCalls += 1;
        throw closeError;
      },
    } as unknown as BrowserContext,
    page: fakePage(),
    cleanup() {
      cleanupCalls += 1;
    },
  };

  const firstClose = closeOutlookSession(session);
  const secondClose = closeOutlookSession(session);

  assert.equal(firstClose, secondClose);
  await assert.rejects(firstClose, (error) => error === closeError);
  await assert.rejects(secondClose, (error) => error === closeError);
  assert.equal(closeCalls, 1);
  assert.equal(cleanupCalls, 1);
});

test("launchOutlookSession removes a cloned profile when browser launch rejects", async () => {
  const { root, profileDir, cloneDir } = makeProfileRoot();
  const launchError = new Error("browser launch failed");
  let removeCalls = 0;
  const dependencies: OutlookSessionLaunchDependencies = {
    reapOrphanChromium: noOrphanReap,
    pruneTempProfiles: () => ({
      scanned: 0,
      removed: 0,
      skipped_active: 0,
      skipped_young: 0,
      skipped_error: 0,
      removed_bytes: 0,
      dry_run: false,
    }),
    createTempProfileClone: () => {
      mkdirSync(cloneDir, { recursive: true });
      return cloneDir;
    },
    removeTempProfile: (path) => {
      removeCalls += 1;
      rmSync(path, { recursive: true, force: true });
    },
    resolveChromeExecutablePath: () => "/test/chrome",
    launchPersistentContext: async () => {
      throw launchError;
    },
  };

  try {
    await assert.rejects(
      launchOutlookSession(profileDir, { headless: true }, dependencies),
      (error) => error === launchError,
    );
    assert.equal(removeCalls, 1);
    assert.equal(existsSync(cloneDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchOutlookSession closes the partial context and clone when page setup rejects", async () => {
  const { root, profileDir, cloneDir } = makeProfileRoot();
  const pageError = new Error("new page failed");
  let contextCloseCalls = 0;
  let removeCalls = 0;
  const context = {
    pages: () => [],
    newPage: async () => {
      throw pageError;
    },
    close: async () => {
      contextCloseCalls += 1;
    },
  } as unknown as BrowserContext;
  const dependencies: OutlookSessionLaunchDependencies = {
    reapOrphanChromium: noOrphanReap,
    pruneTempProfiles: () => ({
      scanned: 0,
      removed: 0,
      skipped_active: 0,
      skipped_young: 0,
      skipped_error: 0,
      removed_bytes: 0,
      dry_run: false,
    }),
    createTempProfileClone: () => {
      mkdirSync(cloneDir, { recursive: true });
      return cloneDir;
    },
    removeTempProfile: (path) => {
      removeCalls += 1;
      rmSync(path, { recursive: true, force: true });
    },
    resolveChromeExecutablePath: () => "/test/chrome",
    launchPersistentContext: async () => context,
  };

  try {
    await assert.rejects(
      launchOutlookSession(profileDir, { headless: true }, dependencies),
      (error) => error === pageError,
    );
    assert.equal(contextCloseCalls, 1);
    assert.equal(removeCalls, 1);
    assert.equal(existsSync(cloneDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
