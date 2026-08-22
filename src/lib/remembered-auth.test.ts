import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SurfaceError } from "./errors.js";
import {
  readRememberedAuthState,
  rememberedAuthStatePath,
  rememberAuthAccountInState,
} from "./remembered-auth.js";

test("rememberAuthAccountInState writes remembered auth metadata under the Surface root", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-remembered-auth-"));
  try {
    const first = rememberAuthAccountInState(dir, "personal", { authCheckIntervalSeconds: 3600 });
    const second = rememberAuthAccountInState(dir, "work, prod", { authCheckIntervalSeconds: 7200 });

    assert.equal(first.statePath, rememberedAuthStatePath(dir));
    assert.deepEqual(second.rememberedAccounts, ["personal", "work, prod"]);
    assert.equal(second.authCheckIntervalSeconds, 3600);
    assert.deepEqual(JSON.parse(readFileSync(rememberedAuthStatePath(dir), "utf8")), {
      version: 1,
      accounts: ["personal", "work, prod"],
      auth_check_interval_seconds: 3600,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRememberedAuthState returns an empty state when none exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-remembered-auth-empty-"));
  try {
    assert.deepEqual(readRememberedAuthState(dir, 123), {
      version: 1,
      accounts: [],
      auth_check_interval_seconds: 123,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRememberedAuthState fails closed for malformed state", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-remembered-auth-bad-"));
  try {
    writeFileSync(rememberedAuthStatePath(dir), "{\"version\":1,\"accounts\":[1]}\n", "utf8");
    assert.throws(
      () => readRememberedAuthState(dir, 86_400),
      (error) => error instanceof SurfaceError
        && error.code === "invalid_configuration"
        && /accounts array of strings/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
