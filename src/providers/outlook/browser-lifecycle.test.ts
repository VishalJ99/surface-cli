import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrowserLeaseManager } from "../../lib/browser-capacity.js";
import { errorToEnvelope } from "../../lib/errors.js";
import { launchOutlookSession } from "./session.js";

function chromeAvailable(): boolean {
  return [
    process.env.SURFACE_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].some((candidate) => typeof candidate === "string" && existsSync(candidate));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function withLifecycleEnvironment<T>(leaseDir: string, action: () => Promise<T>): Promise<T> {
  const previous = {
    leaseDir: process.env.BROWSER_AUTOMATION_LEASE_DIR,
    maxActive: process.env.BROWSER_AUTOMATION_MAX_ACTIVE,
  };
  process.env.BROWSER_AUTOMATION_LEASE_DIR = leaseDir;
  process.env.BROWSER_AUTOMATION_MAX_ACTIVE = "1";
  return action().finally(() => {
    if (previous.leaseDir === undefined) {
      delete process.env.BROWSER_AUTOMATION_LEASE_DIR;
    } else {
      process.env.BROWSER_AUTOMATION_LEASE_DIR = previous.leaseDir;
    }
    if (previous.maxActive === undefined) {
      delete process.env.BROWSER_AUTOMATION_MAX_ACTIVE;
    } else {
      process.env.BROWSER_AUTOMATION_MAX_ACTIVE = previous.maxActive;
    }
  });
}

test("repeated local Chromium command sessions release capacity and their deadline closes the browser", { skip: !chromeAvailable(), timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-browser-lifecycle-"));
  const profileDir = join(root, "profile");
  const leaseDir = join(root, "leases");
  try {
    await withLifecycleEnvironment(leaseDir, async () => {
      for (let index = 0; index < 6; index += 1) {
        const session = await launchOutlookSession(profileDir, {
          headless: true,
          purpose: "command",
          commandTimeoutMs: 5_000,
        });
        await session.page.setContent(`<main>fixture ${index}</main>`);
        await session.close();
        const next = await new BrowserLeaseManager({ leaseDir, maxActive: 1 }).acquire();
        await next.release();
      }

      const deadlineSession = await launchOutlookSession(profileDir, {
        headless: true,
        purpose: "command",
        commandTimeoutMs: 40,
      });
      const interrupted = deadlineSession.page.waitForTimeout(1_000);
      await assert.rejects(interrupted, (error: unknown) => errorToEnvelope(error).error.code === "browser_deadline_exceeded");
      assert.equal(deadlineSession.deadlineExceeded(), true);
      await deadlineSession.close();
      const next = await new BrowserLeaseManager({ leaseDir, maxActive: 1 }).acquire();
      await next.release();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed Chromium launch releases its reserved capacity only after the marker scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-browser-launch-failure-"));
  const profileDir = join(root, "profile");
  const leaseDir = join(root, "leases");
  const previousExecutable = process.env.SURFACE_CHROME_PATH;
  try {
    await withLifecycleEnvironment(leaseDir, async () => {
      process.env.SURFACE_CHROME_PATH = join(root, "missing-chrome");
      await assert.rejects(
        launchOutlookSession(profileDir, { headless: true, purpose: "command" }),
      );
      const next = await new BrowserLeaseManager({ leaseDir, maxActive: 1 }).acquire();
      await next.release();
    });
  } finally {
    if (previousExecutable === undefined) {
      delete process.env.SURFACE_CHROME_PATH;
    } else {
      process.env.SURFACE_CHROME_PATH = previousExecutable;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
