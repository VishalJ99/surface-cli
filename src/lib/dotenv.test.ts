import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { SurfaceError } from "./errors.js";

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

test("loadProjectDotenv loads only remembered-auth/local-state keys without overriding existing process env", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-dotenv-"));
  const path = join(dir, ".env");
  const previous = process.env.SURFACE_CACHE_DIR;
  const previousPath = process.env.PATH;
  const previousWrites = process.env.SURFACE_WRITES_ENABLED;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  const previousInterval = process.env.SURFACE_AUTH_CHECK_INTERVAL_SECONDS;
  try {
    process.env.SURFACE_CACHE_DIR = "/already/set";
    upsertProjectDotenv(path, {
      SURFACE_CACHE_DIR: "/from/file",
      SURFACE_AUTH_CHECK_INTERVAL_SECONDS: "12345",
      SURFACE_WRITES_ENABLED: "1",
      OPENROUTER_API_KEY: "should-not-load",
      PATH: "/should/not/load",
    });

    const result = loadProjectDotenv(path);
    assert.equal(process.env.SURFACE_CACHE_DIR, "/already/set");
    assert.equal(process.env.SURFACE_AUTH_CHECK_INTERVAL_SECONDS, "12345");
    assert.equal(process.env.SURFACE_WRITES_ENABLED, previousWrites);
    assert.equal(process.env.OPENROUTER_API_KEY, previousOpenRouter);
    assert.equal(process.env.PATH, previousPath);
    assert.deepEqual(result.loaded, ["SURFACE_AUTH_CHECK_INTERVAL_SECONDS"]);
  } finally {
    if (previous === undefined) {
      delete process.env.SURFACE_CACHE_DIR;
    } else {
      process.env.SURFACE_CACHE_DIR = previous;
    }
    if (previousInterval === undefined) {
      delete process.env.SURFACE_AUTH_CHECK_INTERVAL_SECONDS;
    } else {
      process.env.SURFACE_AUTH_CHECK_INTERVAL_SECONDS = previousInterval;
    }
    if (previousWrites === undefined) {
      delete process.env.SURFACE_WRITES_ENABLED;
    } else {
      process.env.SURFACE_WRITES_ENABLED = previousWrites;
    }
    if (previousOpenRouter === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousOpenRouter;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectDotenv wraps unreadable dotenv paths in SurfaceError", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-dotenv-dir-"));
  const path = join(dir, ".env");
  try {
    mkdirSync(path);
    assert.throws(
      () => loadProjectDotenv(path),
      (error) => error instanceof SurfaceError
        && error.code === "invalid_configuration"
        && /Could not read project \.env/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseRememberedAuthAccounts accepts JSON arrays and legacy comma lists", () => {
  assert.deepEqual(parseRememberedAuthAccounts("[\"personal\",\"work,prod\",\"school account\"]"), [
    "personal",
    "work,prod",
    "school account",
  ]);
  assert.deepEqual(parseRememberedAuthAccounts("personal,uni,personal"), ["personal", "uni"]);
});

test("rememberAuthAccountInProjectEnv merges remembered accounts", () => {
  const dir = mkdtempSync(join(tmpdir(), "surface-remember-"));
  const path = join(dir, ".env");
  const previousAccounts = process.env.SURFACE_REMEMBERED_AUTH_ACCOUNTS;
  const previousInterval = process.env.SURFACE_AUTH_CHECK_INTERVAL_SECONDS;
  try {
    upsertProjectDotenv(path, {
      SURFACE_REMEMBERED_AUTH_ACCOUNTS: JSON.stringify(["personal", "work,prod"]),
      SURFACE_AUTH_CHECK_INTERVAL_SECONDS: "3600",
    });

    const result = rememberAuthAccountInProjectEnv("uni", {
      envPath: path,
      authCheckIntervalSeconds: 86_400,
    });

    assert.deepEqual(result.rememberedAccounts, ["personal", "work,prod", "uni"]);
    assert.equal(result.authCheckIntervalSeconds, 3600);
    assert.deepEqual(parseRememberedAuthAccounts(process.env.SURFACE_REMEMBERED_AUTH_ACCOUNTS), [
      "personal",
      "work,prod",
      "uni",
    ]);
    assert.equal(
      parseDotenv(readFileSync(path, "utf8")).SURFACE_REMEMBERED_AUTH_ACCOUNTS,
      JSON.stringify(["personal", "work,prod", "uni"]),
    );
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
