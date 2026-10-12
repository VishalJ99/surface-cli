import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OUTLOOK_TEMP_PROFILE_MARKER_FILENAME,
  OUTLOOK_TEMP_PROFILE_PREFIX,
  createOutlookTempProfileClone,
  pruneOutlookTempProfiles,
} from "./temp-profiles.js";

const NOW = new Date("2026-06-21T12:00:00Z");

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "surface-outlook-prune-"));
}

function makeProfile(root: string, name: string, options: { old?: boolean; markerPid?: number } = {}): string {
  const profileDir = join(root, name);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "Cookies"), "browser cache\n", "utf8");

  if (options.markerPid !== undefined) {
    writeFileSync(
      join(profileDir, OUTLOOK_TEMP_PROFILE_MARKER_FILENAME),
      `${JSON.stringify({
        version: 1,
        created_at: new Date(NOW.getTime() - 7_200_000).toISOString(),
        owner_pid: options.markerPid,
        created_by: "surface-cli",
        provider: "outlook",
      })}\n`,
      "utf8",
    );
  }

  if (options.old) {
    const oldDate = new Date(NOW.getTime() - 7_200_000);
    utimesSync(profileDir, oldDate, oldDate);
  }

  return profileDir;
}

test("pruneOutlookTempProfiles deletes stale Surface Outlook temp profiles", () => {
  const root = makeRoot();
  try {
    const stale = makeProfile(root, "surface-outlook-old", { old: true });

    const result = pruneOutlookTempProfiles({
      tmpRoot: root,
      now: NOW,
      maxAgeSeconds: 3600,
      processArgs: [],
      isPidAlive: () => false,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.skipped_young, 0);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createOutlookTempProfileClone copies the source profile and writes a marker", () => {
  const root = makeRoot();
  try {
    const source = join(root, "source-profile");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "Cookies"), "persistent cookies\n", "utf8");

    const clone = createOutlookTempProfileClone(source, { tmpRoot: root, now: NOW });

    assert.equal(clone.startsWith(join(root, OUTLOOK_TEMP_PROFILE_PREFIX)), true);
    assert.equal(existsSync(join(clone, "Cookies")), true);
    assert.equal(existsSync(join(clone, OUTLOOK_TEMP_PROFILE_MARKER_FILENAME)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOutlookTempProfiles preserves young Outlook temp profiles", () => {
  const root = makeRoot();
  try {
    const young = makeProfile(root, "surface-outlook-young");

    const result = pruneOutlookTempProfiles({
      tmpRoot: root,
      now: NOW,
      maxAgeSeconds: 3600,
      processArgs: [],
      isPidAlive: () => false,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.removed, 0);
    assert.equal(result.skipped_young, 1);
    assert.equal(existsSync(young), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOutlookTempProfiles preserves profiles with a live owner pid marker", () => {
  const root = makeRoot();
  try {
    const active = makeProfile(root, "surface-outlook-active-marker", { markerPid: 12_345 });

    const result = pruneOutlookTempProfiles({
      tmpRoot: root,
      now: NOW,
      maxAgeSeconds: 3600,
      processArgs: [],
      isPidAlive: (pid) => pid === 12_345,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.removed, 0);
    assert.equal(result.skipped_active, 1);
    assert.equal(existsSync(active), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOutlookTempProfiles preserves profiles referenced by active process args", () => {
  const root = makeRoot();
  try {
    const active = makeProfile(root, "surface-outlook-active-process", { old: true });

    const result = pruneOutlookTempProfiles({
      tmpRoot: root,
      now: NOW,
      maxAgeSeconds: 3600,
      processArgs: [`/Applications/Google Chrome --user-data-dir=${active}`],
      isPidAlive: () => false,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.removed, 0);
    assert.equal(result.skipped_active, 1);
    assert.equal(existsSync(active), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOutlookTempProfiles ignores nonmatching children and never deletes the temp root", () => {
  const root = makeRoot();
  try {
    const unrelated = makeProfile(root, "surface-gmail-old", { old: true });

    const result = pruneOutlookTempProfiles({
      tmpRoot: root,
      now: NOW,
      maxAgeSeconds: 3600,
      processArgs: [],
      isPidAlive: () => false,
    });

    assert.equal(result.scanned, 0);
    assert.equal(result.removed, 0);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOutlookTempProfiles dry-run reports reclaimable profiles without deleting", () => {
  const root = makeRoot();
  try {
    const stale = makeProfile(root, "surface-outlook-dry-run", { old: true });

    const result = pruneOutlookTempProfiles({
      tmpRoot: root,
      now: NOW,
      maxAgeSeconds: 3600,
      dryRun: true,
      processArgs: [],
      isPidAlive: () => false,
    });

    assert.equal(result.dry_run, true);
    assert.equal(result.removed, 1);
    assert.ok(result.removed_bytes > 0);
    assert.equal(existsSync(stale), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
