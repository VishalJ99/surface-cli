import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadProjectDotenv,
  parseDotenv,
  parseRememberedAuthAccounts,
  rememberAuthAccountInProjectEnv,
  upsertProjectDotenv,
} from "./dotenv.js";

test("parseDotenv handles comments, export prefixes, and quoted values", () => {
  assert.deepEqual(
    parseDotenv([
      "# ignored",
      "SURFACE_CACHE_DIR=/tmp/surface",
      "export SURFACE_TEST_RECIPIENTS=\"a@example.com,b@example.com\"",
      "SURFACE_SECRET='literal#hash'",
      "NOT VALID=value",
      "BROKEN",
      "",
    ].join("\n")),
    {
      SURFACE_CACHE_DIR: "/tmp/surface",
      SURFACE_TEST_RECIPIENTS: "a@example.com,b@example.com",
      SURFACE_SECRET: "literal#hash",
    },
  );
});

test("loadProjectDotenv loads Surface keys without overriding existing process env", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-dotenv-"));
  const path = join(dir, ".env");
  const previous = process.env.SURFACE_CACHE_DIR;
  const previousPath = process.env.PATH;
  try {
    process.env.SURFACE_CACHE_DIR = "/already/set";
    upsertProjectDotenv(path, {
      SURFACE_CACHE_DIR: "/from/file",
      SURFACE_PROVIDER_TIMEOUT_MS: "12345",
      PATH: "/should/not/load",
    });

    const result = loadProjectDotenv(path);
    assert.equal(process.env.SURFACE_CACHE_DIR, "/already/set");
    assert.equal(process.env.SURFACE_PROVIDER_TIMEOUT_MS, "12345");
    assert.equal(process.env.PATH, previousPath);
    assert.deepEqual(result.loaded, ["SURFACE_PROVIDER_TIMEOUT_MS"]);
  } finally {
    if (previous === undefined) {
      delete process.env.SURFACE_CACHE_DIR;
    } else {
      process.env.SURFACE_CACHE_DIR = previous;
    }
    delete process.env.SURFACE_PROVIDER_TIMEOUT_MS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rememberAuthAccountInProjectEnv merges remembered accounts", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-remember-"));
  const path = join(dir, ".env");
  const previousAccounts = process.env.SURFACE_REMEMBERED_AUTH_ACCOUNTS;
  const previousInterval = process.env.SURFACE_AUTH_CHECK_INTERVAL_SECONDS;
  try {
    upsertProjectDotenv(path, {
      SURFACE_REMEMBERED_AUTH_ACCOUNTS: "personal",
      SURFACE_AUTH_CHECK_INTERVAL_SECONDS: "3600",
    });

    const result = rememberAuthAccountInProjectEnv("uni", {
      envPath: path,
      authCheckIntervalSeconds: 86_400,
    });

    assert.deepEqual(result.rememberedAccounts, ["personal", "uni"]);
    assert.equal(result.authCheckIntervalSeconds, 3600);
    assert.deepEqual(parseRememberedAuthAccounts(process.env.SURFACE_REMEMBERED_AUTH_ACCOUNTS), ["personal", "uni"]);
    assert.match(readFileSync(path, "utf8"), /SURFACE_REMEMBERED_AUTH_ACCOUNTS=personal,uni/);
    assert.match(readFileSync(path, "utf8"), /SURFACE_AUTH_CHECK_INTERVAL_SECONDS=3600/);
  } finally {
    if (previousAccounts === undefined) {
      delete process.env.SURFACE_REMEMBERED_AUTH_ACCOUNTS;
    } else {
      process.env.SURFACE_REMEMBERED_AUTH_ACCOUNTS = previousAccounts;
    }
    if (previousInterval === undefined) {
      delete process.env.SURFACE_AUTH_CHECK_INTERVAL_SECONDS;
    } else {
      process.env.SURFACE_AUTH_CHECK_INTERVAL_SECONDS = previousInterval;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
