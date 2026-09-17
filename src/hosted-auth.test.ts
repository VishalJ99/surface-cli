import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MailAccount } from "./contracts/account.js";
import {
  HostedOutlookAuthService,
  readHostedAuthToken,
  startHostedOutlookAuthServer,
  type HostedAuthBrowser,
  type HostedAuthBrowserFactory,
} from "./hosted-auth.js";
import { makeAuthSessionId } from "./refs.js";
import type { AccountRuntimeContext } from "./runtime.js";

const TOKEN = "test-token-that-is-long-enough-for-hosted-auth";
const TEST_BROWSER_LEASE_DIR = mkdtempSync(join(tmpdir(), "surface-hosted-auth-browser-leases-"));
const PREVIOUS_BROWSER_LEASE_DIR = process.env.BROWSER_AUTOMATION_LEASE_DIR;
process.env.BROWSER_AUTOMATION_LEASE_DIR = TEST_BROWSER_LEASE_DIR;
test.after(() => {
  if (PREVIOUS_BROWSER_LEASE_DIR === undefined) {
    delete process.env.BROWSER_AUTOMATION_LEASE_DIR;
  } else {
    process.env.BROWSER_AUTOMATION_LEASE_DIR = PREVIOUS_BROWSER_LEASE_DIR;
  }
  rmSync(TEST_BROWSER_LEASE_DIR, { recursive: true, force: true });
});

function account(): MailAccount {
  return {
    account_id: "acc_hosted_auth_test",
    name: "uni",
    provider: "outlook",
    transport: "outlook-web-playwright",
    email: "user@example.test",
    created_at: "2026-09-17T10:00:00Z",
    updated_at: "2026-09-17T10:00:00Z",
  };
}

function context(root: string): AccountRuntimeContext {
  const currentAccount = account();
  const authDir = join(root, "auth", currentAccount.account_id);
  mkdirSync(authDir, { recursive: true });
  return {
    account: currentAccount,
    config: {
      cacheDir: root,
      defaultResultLimit: 50,
      providerTimeoutMs: 2_000,
      authCheckIntervalSeconds: 86_400,
      summarizerBackend: "none",
      summarizerModel: "test",
      summaryInputMaxBytes: 1024,
      summarizerTimeoutMs: 1_000,
      writesEnabled: false,
      sendMode: "draft_only",
      testRecipients: [],
      testAccountAllowlist: [],
    },
    configPath: join(root, "config.toml"),
    paths: {
      rootDir: root,
      configPath: join(root, "config.toml"),
      stateDbPath: join(root, "state.db"),
      authDir: join(root, "auth"),
      cacheDir: join(root, "cache"),
      downloadsDir: join(root, "downloads"),
      sessionsDir: join(root, "sessions"),
    },
    db: {} as AccountRuntimeContext["db"],
    accountPaths: {
      authDir,
      cacheDir: join(root, "cache", currentAccount.account_id),
      messagesDir: join(root, "cache", currentAccount.account_id, "messages"),
      downloadsDir: join(root, "downloads", currentAccount.account_id),
    },
  };
}

class FixtureBrowser implements HostedAuthBrowser {
  closed = false;
  closeAttempts = 0;
  readonly calls: string[] = [];

  constructor(
    private readonly probeStatus: "authenticated" | "unauthenticated",
    private readonly identityValue: string | null = null,
    private closeFailuresRemaining = 0,
  ) {}

  async screenshot(): Promise<Buffer> {
    return Buffer.from("fixture-png");
  }

  async click(x: number, y: number): Promise<void> {
    this.calls.push(`click:${x},${y}`);
  }

  async type(text: string): Promise<void> {
    this.calls.push(`type:${text.length}`);
  }

  async key(key: string): Promise<void> {
    this.calls.push(`key:${key}`);
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    this.calls.push(`scroll:${deltaX},${deltaY}`);
  }

  async probe(): Promise<{ status: "authenticated" | "unauthenticated" }> {
    return { status: this.probeStatus };
  }

  async identity(): Promise<string | null> {
    return this.identityValue;
  }

  async close(): Promise<void> {
    this.closeAttempts += 1;
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      throw new Error("fixture browser close failed");
    }
    this.closed = true;
  }
}

function fixtureBrowserFactory(
  probeStatus: "authenticated" | "unauthenticated",
  fixtureOptions: { identity?: string | null; closeFailures?: number } = {},
): {
  factory: HostedAuthBrowserFactory;
  browsers: FixtureBrowser[];
} {
  const browsers: FixtureBrowser[] = [];
  return {
    browsers,
    factory: {
      async create(options) {
        writeFileSync(join(options.profileDir, "candidate-state.txt"), "candidate\n", "utf8");
        const browser = new FixtureBrowser(probeStatus, fixtureOptions.identity, fixtureOptions.closeFailures);
        browsers.push(browser);
        return browser;
      },
    },
  };
}

async function waitForStatus(
  service: HostedOutlookAuthService,
  sessionId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (service.status(sessionId).status === expected) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`Timed out waiting for hosted auth status '${expected}'.`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

test("hosted auth idle expiry ignores status and screenshot polls but resets after a browser action", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-idle-"));
  try {
    const runtime = context(root);
    const fixture = fixtureBrowserFactory("unauthenticated");
    const service = new HostedOutlookAuthService({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      browserFactory: fixture.factory,
      ttlSeconds: 1,
      idleTimeoutSeconds: 0.15,
    });
    const session = service.begin();
    await waitForStatus(service, session.session_id, "awaiting_browser");

    await wait(80);
    assert.equal(service.status(session.session_id).status, "awaiting_browser");
    await service.screenshot(session.session_id);
    await wait(80);
    assert.equal(service.status(session.session_id).status, "expired");
    assert.equal(service.status(session.session_id).reason, "session_idle_expired");
    assert.equal(fixture.browsers[0]?.closed, true);
    await service.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted auth interaction extends idle only until the fixed maximum lifetime", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-max-age-"));
  try {
    const runtime = context(root);
    const fixture = fixtureBrowserFactory("unauthenticated");
    const service = new HostedOutlookAuthService({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      browserFactory: fixture.factory,
      ttlSeconds: 0.18,
      idleTimeoutSeconds: 1,
    });
    const session = service.begin();
    await waitForStatus(service, session.session_id, "awaiting_browser");
    await wait(90);
    await service.interact(session.session_id, "click", { x: 1, y: 1 });
    await wait(120);
    assert.equal(service.status(session.session_id).status, "expired");
    assert.equal(service.status(session.session_id).reason, "session_expired");
    await service.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted auth begin is replay-safe and only promotes a probed candidate profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-"));
  try {
    const runtime = context(root);
    const activeProfile = join(runtime.accountPaths.authDir, "profile");
    mkdirSync(activeProfile, { recursive: true });
    writeFileSync(join(activeProfile, "active-state.txt"), "old active profile\n", "utf8");
    const fixture = fixtureBrowserFactory("authenticated");
    const service = new HostedOutlookAuthService({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      browserFactory: fixture.factory,
    });

    const [first, replay] = [service.begin(), service.begin()];
    assert.equal(first.session_id, replay.session_id);
    assert.equal(first.status, "starting");
    assert.equal(JSON.stringify(first).includes("profile"), false);
    await waitForStatus(service, first.session_id, "awaiting_browser");

    const typed = await service.interact(first.session_id, "type", { text: "one-time-code" });
    assert.equal(typed.status, "awaiting_browser");
    const finalized = await service.finalize(first.session_id);
    assert.equal(finalized.status, "authenticated");
    assert.equal(finalized.probe?.status, "authenticated");
    assert.equal(existsSync(join(activeProfile, "active-state.txt")), false);
    assert.equal(existsSync(join(activeProfile, "candidate-state.txt")), true);
    assert.equal(fixture.browsers[0]?.closed, true);

    const finalReplay = await service.finalize(first.session_id);
    assert.deepEqual(finalReplay, finalized);
    await assert.rejects(
      () => service.cancel(first.session_id),
      (error: unknown) => error instanceof Error && /cannot be cancelled/.test(error.message),
    );
    await service.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted auth requires a UI-derived expected Outlook identity before promotion", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-identity-"));
  try {
    const runtime = context(root);
    const activeProfile = join(runtime.accountPaths.authDir, "profile");
    mkdirSync(activeProfile, { recursive: true });
    writeFileSync(join(activeProfile, "active-state.txt"), "old active profile\n", "utf8");
    const matchedFixture = fixtureBrowserFactory("authenticated", { identity: "USER@EXAMPLE.TEST" });
    const matched = new HostedOutlookAuthService({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      expectedEmails: ["user@example.test"],
      browserFactory: matchedFixture.factory,
    });
    const matchingSession = matched.begin();
    await waitForStatus(matched, matchingSession.session_id, "awaiting_browser");
    const verified = await matched.finalize(matchingSession.session_id);
    assert.equal(verified.status, "authenticated");
    assert.equal(verified.identity?.status, "matched");
    await matched.close();

    const mismatchRoot = mkdtempSync(join(tmpdir(), "surface-hosted-auth-identity-mismatch-"));
    try {
      const mismatchRuntime = context(mismatchRoot);
      const mismatchActiveProfile = join(mismatchRuntime.accountPaths.authDir, "profile");
      mkdirSync(mismatchActiveProfile, { recursive: true });
      writeFileSync(join(mismatchActiveProfile, "active-state.txt"), "old active profile\n", "utf8");
      const mismatchFixture = fixtureBrowserFactory("authenticated", { identity: "different@example.test" });
      const mismatch = new HostedOutlookAuthService({
        account: mismatchRuntime.account,
        context: mismatchRuntime,
        token: TOKEN,
        expectedEmails: ["user@example.test"],
        browserFactory: mismatchFixture.factory,
      });
      const mismatchSession = mismatch.begin();
      await waitForStatus(mismatch, mismatchSession.session_id, "awaiting_browser");
      const rejected = await mismatch.finalize(mismatchSession.session_id);
      assert.equal(rejected.status, "awaiting_browser");
      assert.equal(rejected.identity?.status, "mismatched");
      assert.equal(existsSync(join(mismatchActiveProfile, "active-state.txt")), true);
      await mismatch.cancel(mismatchSession.session_id);
      await mismatch.close();
    } finally {
      rmSync(mismatchRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted auth does not promote when the candidate browser cannot be closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-close-failure-"));
  try {
    const runtime = context(root);
    const activeProfile = join(runtime.accountPaths.authDir, "profile");
    mkdirSync(activeProfile, { recursive: true });
    writeFileSync(join(activeProfile, "active-state.txt"), "old active profile\n", "utf8");
    const fixture = fixtureBrowserFactory("authenticated", { closeFailures: 1 });
    const service = new HostedOutlookAuthService({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      browserFactory: fixture.factory,
    });
    const session = service.begin();
    await waitForStatus(service, session.session_id, "awaiting_browser");
    const result = await service.finalize(session.session_id);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "browser_close_failed");
    assert.equal(existsSync(join(activeProfile, "active-state.txt")), true);
    assert.equal(existsSync(join(activeProfile, "candidate-state.txt")), false);
    assert.equal(fixture.browsers[0]?.closeAttempts, 2);
    assert.equal(fixture.browsers[0]?.closed, true);
    await service.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted auth cancellation, unauthenticated finalize, and expiry retain the active profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-"));
  try {
    const runtime = context(root);
    const activeProfile = join(runtime.accountPaths.authDir, "profile");
    mkdirSync(activeProfile, { recursive: true });
    writeFileSync(join(activeProfile, "active-state.txt"), "old active profile\n", "utf8");
    const fixture = fixtureBrowserFactory("unauthenticated");
    const service = new HostedOutlookAuthService({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      browserFactory: fixture.factory,
      ttlSeconds: 0.02,
    });

    const first = service.begin();
    await waitForStatus(service, first.session_id, "awaiting_browser");
    const notReady = await service.finalize(first.session_id);
    assert.equal(notReady.status, "awaiting_browser");
    assert.equal(notReady.probe?.status, "unauthenticated");
    assert.equal(existsSync(join(activeProfile, "active-state.txt")), true);

    const cancelled = await service.cancel(first.session_id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(existsSync(join(activeProfile, "active-state.txt")), true);
    assert.equal(existsSync(join(runtime.accountPaths.authDir, "hosted-auth", first.session_id)), false);

    const second = service.begin();
    await waitForStatus(service, second.session_id, "awaiting_browser");
    await new Promise((resolveWait) => setTimeout(resolveWait, 35));
    const expired = service.status(second.session_id);
    assert.equal(expired.status, "expired");
    await waitForStatus(service, second.session_id, "expired");
    assert.equal(existsSync(join(activeProfile, "active-state.txt")), true);
    assert.equal(existsSync(join(runtime.accountPaths.authDir, "hosted-auth", second.session_id)), false);
    await service.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted auth startup restores an interrupted promotion before creating a browser", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-recovery-"));
  try {
    const runtime = context(root);
    const sessionId = makeAuthSessionId();
    const candidateRoot = join(runtime.accountPaths.authDir, "hosted-auth");
    const backupProfile = join(candidateRoot, `backup-${sessionId}`);
    mkdirSync(backupProfile, { recursive: true });
    writeFileSync(join(backupProfile, "active-state.txt"), "restorable profile\n", "utf8");
    writeFileSync(
      join(runtime.accountPaths.authDir, "hosted-auth-promotion.json"),
      JSON.stringify({ version: 1, session_id: sessionId, phase: "active_moved" }),
      "utf8",
    );

    const fixture = fixtureBrowserFactory("unauthenticated");
    const service = new HostedOutlookAuthService({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      browserFactory: fixture.factory,
    });
    assert.equal(existsSync(join(runtime.accountPaths.authDir, "profile", "active-state.txt")), true);
    assert.equal(existsSync(join(runtime.accountPaths.authDir, "hosted-auth-promotion.json")), false);
    assert.equal(existsSync(backupProfile), false);
    assert.equal(fixture.browsers.length, 0);
    await service.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted auth owns one account profile and prunes only valid expired candidate directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-lock-"));
  try {
    const runtime = context(root);
    const first = new HostedOutlookAuthService({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      browserFactory: fixtureBrowserFactory("unauthenticated").factory,
    });
    assert.throws(
      () => new HostedOutlookAuthService({
        account: runtime.account,
        context: runtime,
        token: TOKEN,
        browserFactory: fixtureBrowserFactory("unauthenticated").factory,
      }),
      /already owns this Outlook account profile/,
    );
    await first.close();

    const candidateRoot = join(runtime.accountPaths.authDir, "hosted-auth");
    const expiredId = makeAuthSessionId();
    const expiredDir = join(candidateRoot, expiredId);
    mkdirSync(expiredDir, { recursive: true });
    writeFileSync(join(expiredDir, "session.json"), JSON.stringify({
      version: 1,
      session_id: expiredId,
      expires_at: "2000-01-01T00:00:00.000Z",
    }), "utf8");

    const malformedId = makeAuthSessionId();
    const malformedDir = join(candidateRoot, malformedId);
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, "session.json"), "not-json", "utf8");

    const unexpiredId = makeAuthSessionId();
    const unexpiredDir = join(candidateRoot, unexpiredId);
    mkdirSync(unexpiredDir, { recursive: true });
    writeFileSync(join(unexpiredDir, "session.json"), JSON.stringify({
      version: 1,
      session_id: unexpiredId,
      expires_at: "2999-01-01T00:00:00.000Z",
    }), "utf8");

    const restarted = new HostedOutlookAuthService({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      browserFactory: fixtureBrowserFactory("unauthenticated").factory,
    });
    assert.equal(existsSync(expiredDir), false);
    assert.equal(existsSync(malformedDir), true);
    assert.equal(existsSync(unexpiredDir), true);
    await restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function chromeAvailable(): boolean {
  const candidates = [
    process.env.SURFACE_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ];
  return candidates.some((candidate) => typeof candidate === "string" && existsSync(candidate));
}

async function startFixturePage(): Promise<{ url: string; close(): Promise<void> }> {
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><body style="margin:0;font-family:sans-serif">
      <input id="email" style="position:absolute;left:40px;top:60px;width:260px;height:32px" />
      <button id="signin" style="position:absolute;left:40px;top:130px;width:160px;height:36px">Sign in</button>
      <div role="listitem" aria-label="owner@example.test">Spoofed sender address in a message</div>
      <div data-automationid="mectrl_currentAccount_secondary">different@example.test</div>
      <div id="mailbox" role="listbox" hidden>Inbox</div>
      <script>
        const inbox = document.getElementById('mailbox');
        const showInbox = () => { inbox.hidden = false; };
        if (localStorage.getItem('fixture-authenticated') === 'yes') showInbox();
        document.getElementById('signin').addEventListener('click', () => {
          localStorage.setItem('fixture-authenticated', 'yes');
          showInbox();
        });
      </script>
      </body></html>`);
  });
  await new Promise<void>((resolveListen) => fixture.listen(0, "127.0.0.1", () => resolveListen()));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()));
    },
  };
}

async function requestJson(url: string, path: string, init: RequestInit = {}): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

test("hosted auth server drives a real Playwright fixture through screenshot and bounded input", { skip: !chromeAvailable(), timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-http-"));
  const page = await startFixturePage();
  let server: Awaited<ReturnType<typeof startHostedOutlookAuthServer>> | undefined;
  try {
    const runtime = context(root);
    server = await startHostedOutlookAuthServer({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      headless: true,
      outlookUrl: page.url,
    });
    const baseUrl = `http://${server.host}:${server.port}`;
    const unauthorized = await fetch(`${baseUrl}/v1/auth/status`);
    assert.equal(unauthorized.status, 401);

    const [first, replay] = await Promise.all([
      requestJson(baseUrl, "/v1/auth/begin", { method: "POST" }),
      requestJson(baseUrl, "/v1/auth/begin", { method: "POST" }),
    ]);
    assert.equal(first.response.status, 202);
    assert.equal(first.body.session_id, replay.body.session_id);
    const sessionId = String(first.body.session_id);

    let status = first.body;
    for (let index = 0; index < 100 && status.status !== "awaiting_browser"; index += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      status = (await requestJson(baseUrl, `/v1/auth/${sessionId}/status`)).body;
    }
    assert.equal(status.status, "awaiting_browser");

    const screenshot = await fetch(`${baseUrl}/v1/auth/${sessionId}/screenshot`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await screenshot.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    await requestJson(baseUrl, `/v1/auth/${sessionId}/interaction/click`, { method: "POST", body: JSON.stringify({ x: 100, y: 75 }) });
    const typed = await requestJson(baseUrl, `/v1/auth/${sessionId}/interaction/type`, { method: "POST", body: JSON.stringify({ text: "fixture-user" }) });
    assert.equal(JSON.stringify(typed.body).includes("fixture-user"), false);
    await requestJson(baseUrl, `/v1/auth/${sessionId}/interaction/key`, { method: "POST", body: JSON.stringify({ key: "Tab" }) });
    await requestJson(baseUrl, `/v1/auth/${sessionId}/interaction/scroll`, { method: "POST", body: JSON.stringify({ delta_y: 120 }) });
    await requestJson(baseUrl, `/v1/auth/${sessionId}/interaction/click`, { method: "POST", body: JSON.stringify({ x: 100, y: 145 }) });

    const finalized = await requestJson(baseUrl, `/v1/auth/${sessionId}/finalize`, { method: "POST" });
    assert.equal(finalized.response.status, 200);
    assert.equal(finalized.body.status, "authenticated");
    assert.equal((finalized.body.probe as { status?: string }).status, "authenticated");
  } finally {
    await server?.close();
    await page.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted auth rejects a message-sender email when the Outlook account control differs", { skip: !chromeAvailable(), timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-identity-selector-"));
  const page = await startFixturePage();
  let server: Awaited<ReturnType<typeof startHostedOutlookAuthServer>> | undefined;
  try {
    const runtime = context(root);
    server = await startHostedOutlookAuthServer({
      account: runtime.account,
      context: runtime,
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      headless: true,
      outlookUrl: page.url,
      expectedEmails: ["owner@example.test"],
    });
    const baseUrl = `http://${server.host}:${server.port}`;
    const started = await requestJson(baseUrl, "/v1/auth/begin", { method: "POST" });
    const sessionId = String(started.body.session_id);
    let status = started.body;
    for (let index = 0; index < 100 && status.status !== "awaiting_browser"; index += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      status = (await requestJson(baseUrl, `/v1/auth/${sessionId}/status`)).body;
    }
    assert.equal(status.status, "awaiting_browser");
    await requestJson(baseUrl, `/v1/auth/${sessionId}/interaction/click`, { method: "POST", body: JSON.stringify({ x: 100, y: 145 }) });
    const finalized = await requestJson(baseUrl, `/v1/auth/${sessionId}/finalize`, { method: "POST" });
    assert.equal(finalized.response.status, 200);
    assert.equal(finalized.body.status, "awaiting_browser");
    assert.equal((finalized.body.identity as { status?: string }).status, "mismatched");
    assert.equal(existsSync(join(runtime.accountPaths.authDir, "profile")), false);
  } finally {
    await server?.close();
    await page.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted auth token files fail closed when permissions are broad", () => {
  const root = mkdtempSync(join(tmpdir(), "surface-hosted-auth-token-"));
  try {
    const tokenPath = join(root, "token");
    writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
    assert.equal(readHostedAuthToken({ tokenFile: tokenPath }), TOKEN);
    chmodSync(tokenPath, 0o644);
    assert.throws(() => readHostedAuthToken({ tokenFile: tokenPath }), /must not be group- or world-readable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
