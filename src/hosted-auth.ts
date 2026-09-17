import { timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { MailAccount } from "./contracts/account.js";
import { SurfaceError } from "./lib/errors.js";
import { makeAuthSessionId } from "./refs.js";
import type { AccountRuntimeContext } from "./runtime.js";
import {
  extractOutlookUiIdentity,
  launchOutlookSession,
  probeOutlookAuth,
  type OutlookSession,
} from "./providers/outlook/session.js";
import type { AuthStatus } from "./providers/types.js";

const DEFAULT_AUTH_SESSION_TTL_SECONDS = 20 * 60;
const MAX_ACTION_TEXT_LENGTH = 512;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_SCREENSHOT_DIMENSION = 4_096;
const MAX_SCROLL_DELTA = 2_000;
const AUTH_SESSION_ID_PATTERN = /^auth_[0-9A-HJKMNP-TV-Z]{26}$/;

const ALLOWED_BROWSER_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
]);

export type HostedAuthStatus =
  | "starting"
  | "awaiting_browser"
  | "probing"
  | "authenticated"
  | "cancelled"
  | "expired"
  | "failed";

type HostedAuthReason =
  | "browser_start_failed"
  | "browser_close_failed"
  | "cancelled_by_client"
  | "session_expired"
  | "profile_promotion_failed";

export type HostedAuthIdentityStatus =
  | "not_requested"
  | "not_checked"
  | "matched"
  | "unavailable"
  | "mismatched";

export interface HostedAuthPublicSession {
  schema_version: "1";
  account: string;
  provider: "outlook";
  transport: "outlook-web-playwright";
  session_id: string;
  status: HostedAuthStatus;
  expires_at: string;
  reason?: HostedAuthReason;
  probe?: {
    status: AuthStatus["status"];
  };
  identity?: {
    status: HostedAuthIdentityStatus;
  };
}

export interface HostedAuthBrowser {
  screenshot(): Promise<Buffer>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  probe(timeoutMs: number): Promise<AuthStatus>;
  identity(): Promise<string | null>;
  close(): Promise<void>;
}

export interface HostedAuthBrowserFactory {
  create(options: {
    profileDir: string;
    headless: boolean;
    outlookUrl: string;
  }): Promise<HostedAuthBrowser>;
}

export interface HostedAuthServiceOptions {
  account: MailAccount;
  context: AccountRuntimeContext;
  token: string;
  ttlSeconds?: number;
  headless?: boolean;
  outlookUrl?: string;
  expectedEmails?: string[];
  browserFactory?: HostedAuthBrowserFactory;
}

export interface HostedAuthHttpServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

interface HostedAuthSession {
  sessionId: string;
  status: HostedAuthStatus;
  expiresAtMs: number;
  candidateDir: string;
  candidateProfileDir: string;
  browser: HostedAuthBrowser | null;
  reason: HostedAuthReason | undefined;
  probe: AuthStatus["status"] | undefined;
  expectedEmails: string[];
  identityStatus: HostedAuthIdentityStatus;
  expiryTimer: NodeJS.Timeout | undefined;
}

interface PromotionState {
  version: 1;
  session_id: string;
  phase: "prepared" | "active_moved" | "candidate_promoted";
}

interface HostedAuthDaemonLock {
  version: 1;
  pid: number;
  created_at: string;
}

function isOutlookHostedAuthAccount(account: MailAccount): account is MailAccount & {
  provider: "outlook";
  transport: "outlook-web-playwright";
} {
  return account.provider === "outlook" && account.transport === "outlook-web-playwright";
}

function writePrivateJson(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function removeFileIfPresent(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale recovery marker must never prevent a later login attempt.
  }
}

function removeDirectoryIfPresent(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Candidate cleanup is retried by the next explicit auth attempt when needed.
  }
}

function safeSessionId(value: string): boolean {
  return AUTH_SESSION_ID_PATTERN.test(value);
}

function normalizeExpectedEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/iu.test(normalized)) {
    throw new SurfaceError("invalid_argument", "expected_email must be a valid email address.");
  }
  return normalized;
}

function normalizeExpectedEmails(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map(normalizeExpectedEmail))];
  if (normalized.length > 8) {
    throw new SurfaceError("invalid_argument", "At most 8 expected email aliases are allowed.");
  }
  return normalized;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function candidateAppearsInRunningCommand(candidateDir: string): boolean {
  try {
    const commands = execFileSync("ps", ["-axo", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return commands.split("\n").some((command) => command.includes(candidateDir));
  } catch {
    // If process inspection is unavailable, leaving a stale candidate is safer than deleting it.
    return true;
  }
}

function strictInteger(value: unknown, field: string, bounds: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new SurfaceError("invalid_argument", `${field} must be an integer between ${bounds.min} and ${bounds.max}.`);
  }
  return value;
}

function publicStatus(account: HostedAuthServiceOptions["account"], session: HostedAuthSession): HostedAuthPublicSession {
  const result: HostedAuthPublicSession = {
    schema_version: "1",
    account: account.name,
    provider: "outlook",
    transport: "outlook-web-playwright",
    session_id: session.sessionId,
    status: session.status,
    expires_at: new Date(session.expiresAtMs).toISOString(),
  };
  if (session.reason) {
    result.reason = session.reason;
  }
  if (session.probe) {
    result.probe = { status: session.probe };
  }
  if (session.identityStatus !== "not_requested") {
    result.identity = { status: session.identityStatus };
  }
  return result;
}

class PlaywrightHostedAuthBrowser implements HostedAuthBrowser {
  private constructor(
    private readonly session: OutlookSession,
    private readonly outlookUrl: string,
  ) {}

  static async create(options: {
    profileDir: string;
    headless: boolean;
    outlookUrl: string;
  }): Promise<PlaywrightHostedAuthBrowser> {
    const session = await launchOutlookSession(options.profileDir, { headless: options.headless });
    try {
      await session.page.goto(options.outlookUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch {
      // Microsoft login pages can keep loading after the interactive surface is usable. The
      // screenshot/control transport remains available and finalize performs the real probe.
    }
    return new PlaywrightHostedAuthBrowser(session, options.outlookUrl);
  }

  async screenshot(): Promise<Buffer> {
    return this.session.page.screenshot({ type: "png", timeout: 15_000 });
  }

  private viewport(): { width: number; height: number } {
    const viewport = this.session.page.viewportSize();
    if (!viewport) {
      throw new SurfaceError("transport_error", "Browser viewport is unavailable.");
    }
    return viewport;
  }

  async click(x: number, y: number): Promise<void> {
    const viewport = this.viewport();
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw new SurfaceError("invalid_argument", "Click coordinates are outside the browser viewport.");
    }
    await this.session.page.mouse.click(x, y);
  }

  async type(text: string): Promise<void> {
    await this.session.page.keyboard.insertText(text);
  }

  async key(key: string): Promise<void> {
    await this.session.page.keyboard.press(key);
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.session.page.mouse.wheel(deltaX, deltaY);
  }

  async probe(timeoutMs: number): Promise<AuthStatus> {
    return probeOutlookAuth(this.session.page, { outlookUrl: this.outlookUrl, timeoutMs });
  }

  async identity(): Promise<string | null> {
    return extractOutlookUiIdentity(this.session.page);
  }

  async close(): Promise<void> {
    await this.session.context.close();
    this.session.cleanup?.();
  }
}

export const playwrightHostedAuthBrowserFactory: HostedAuthBrowserFactory = {
  create: PlaywrightHostedAuthBrowser.create,
};

function safelyCloseBrowser(browser: HostedAuthBrowser | null): Promise<void> {
  if (!browser) {
    return Promise.resolve();
  }
  return browser.close().catch(() => undefined);
}

export class HostedOutlookAuthService {
  private readonly account: HostedAuthServiceOptions["account"];
  private readonly context: AccountRuntimeContext;
  private readonly token: string;
  private readonly ttlMs: number;
  private readonly headless: boolean;
  private readonly outlookUrl: string;
  private readonly browserFactory: HostedAuthBrowserFactory;
  private readonly candidateRoot: string;
  private readonly daemonLockPath: string;
  private readonly promotionStatePath: string;
  private readonly defaultExpectedEmails: string[];
  private readonly sessions = new Map<string, HostedAuthSession>();
  private activeSessionId: string | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private daemonLockHeld = false;

  constructor(options: HostedAuthServiceOptions) {
    if (!isOutlookHostedAuthAccount(options.account)) {
      throw new SurfaceError(
        "unsupported",
        "Hosted browser auth only supports outlook-web-playwright accounts.",
        { account: options.account.name },
      );
    }
    if (!options.token.trim()) {
      throw new SurfaceError("invalid_configuration", "Hosted auth requires a non-empty service token.");
    }

    this.account = options.account;
    this.context = options.context;
    this.token = options.token;
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_AUTH_SESSION_TTL_SECONDS) * 1_000;
    this.headless = options.headless ?? false;
    this.outlookUrl = options.outlookUrl ?? "https://outlook.office.com/mail/";
    this.browserFactory = options.browserFactory ?? playwrightHostedAuthBrowserFactory;
    this.candidateRoot = join(this.context.accountPaths.authDir, "hosted-auth");
    this.daemonLockPath = join(this.context.accountPaths.authDir, "hosted-auth.lock");
    this.promotionStatePath = join(this.context.accountPaths.authDir, "hosted-auth-promotion.json");
    this.defaultExpectedEmails = normalizeExpectedEmails(options.expectedEmails ?? []);

    this.acquireDaemonLock();
    try {
      mkdirSync(this.candidateRoot, { recursive: true, mode: 0o700 });
      this.recoverInterruptedPromotion();
      this.pruneExpiredCandidates();
    } catch (error) {
      this.releaseDaemonLock();
      throw error;
    }
  }

  private acquireDaemonLock(): void {
    const lock: HostedAuthDaemonLock = {
      version: 1,
      pid: process.pid,
      created_at: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(this.daemonLockPath, `${JSON.stringify(lock)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        this.daemonLockHeld = true;
        return;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "EEXIST") {
          throw new SurfaceError("invalid_configuration", "Could not acquire the hosted auth daemon lock.");
        }
      }

      let existing: HostedAuthDaemonLock;
      try {
        existing = JSON.parse(readFileSync(this.daemonLockPath, "utf8")) as HostedAuthDaemonLock;
      } catch {
        throw new SurfaceError("invalid_configuration", "Hosted auth daemon lock is malformed; resolve it before starting another daemon.");
      }
      if (existing.version !== 1 || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || Number.isNaN(Date.parse(existing.created_at))) {
        throw new SurfaceError("invalid_configuration", "Hosted auth daemon lock is malformed; resolve it before starting another daemon.");
      }
      if (isPidAlive(existing.pid)) {
        throw new SurfaceError("invalid_configuration", "A hosted auth daemon already owns this Outlook account profile.");
      }
      removeFileIfPresent(this.daemonLockPath);
    }
    throw new SurfaceError("invalid_configuration", "Could not acquire the hosted auth daemon lock.");
  }

  private releaseDaemonLock(): void {
    if (!this.daemonLockHeld) {
      return;
    }
    removeFileIfPresent(this.daemonLockPath);
    this.daemonLockHeld = false;
  }

  private candidateDirFor(sessionId: string): string {
    if (!safeSessionId(sessionId)) {
      throw new SurfaceError("invalid_argument", "Invalid hosted auth session id.");
    }
    return join(this.candidateRoot, sessionId);
  }

  private backupDirFor(sessionId: string): string {
    if (!safeSessionId(sessionId)) {
      throw new SurfaceError("invalid_argument", "Invalid hosted auth session id.");
    }
    return join(this.candidateRoot, `backup-${sessionId}`);
  }

  private activeProfileDir(): string {
    return join(this.context.accountPaths.authDir, "profile");
  }

  private assertCandidatePath(path: string, sessionId: string): void {
    const expected = this.candidateDirFor(sessionId);
    if (resolve(path) !== resolve(expected) || dirname(path) !== this.candidateRoot || basename(path) !== sessionId) {
      throw new SurfaceError("invalid_configuration", "Hosted auth candidate path escaped its account auth directory.");
    }
  }

  private recoverInterruptedPromotion(): void {
    if (!existsSync(this.promotionStatePath)) {
      return;
    }

    let state: PromotionState;
    try {
      state = JSON.parse(readFileSync(this.promotionStatePath, "utf8")) as PromotionState;
    } catch {
      // Do not infer which directory is safe to modify from a malformed state record.
      return;
    }

    if (state.version !== 1 || !safeSessionId(state.session_id)) {
      return;
    }

    const activeProfileDir = this.activeProfileDir();
    const backupDir = this.backupDirFor(state.session_id);
    if ((state.phase === "prepared" || state.phase === "active_moved") && !existsSync(activeProfileDir) && existsSync(backupDir)) {
      renameSync(backupDir, activeProfileDir);
      removeFileIfPresent(this.promotionStatePath);
      return;
    }

    if (state.phase === "candidate_promoted" && existsSync(activeProfileDir)) {
      removeDirectoryIfPresent(backupDir);
      removeFileIfPresent(this.promotionStatePath);
      return;
    }

    if (state.phase === "candidate_promoted" && !existsSync(activeProfileDir) && existsSync(backupDir)) {
      renameSync(backupDir, activeProfileDir);
      removeFileIfPresent(this.promotionStatePath);
      return;
    }

    removeFileIfPresent(this.promotionStatePath);
  }

  private pruneExpiredCandidates(): void {
    try {
      for (const entry of readdirSync(this.candidateRoot, { withFileTypes: true, encoding: "utf8" })) {
        if (!entry.isDirectory() || !safeSessionId(entry.name)) {
          continue;
        }
        const candidateDir = this.candidateDirFor(entry.name);
        let state: { version?: unknown; session_id?: unknown; expires_at?: unknown };
        try {
          state = JSON.parse(readFileSync(join(candidateDir, "session.json"), "utf8")) as typeof state;
        } catch {
          continue;
        }
        const expiresAtMs = typeof state.expires_at === "string" ? Date.parse(state.expires_at) : Number.NaN;
        if (
          state.version !== 1
          || state.session_id !== entry.name
          || !Number.isFinite(expiresAtMs)
          || expiresAtMs >= Date.now()
          || candidateAppearsInRunningCommand(candidateDir)
        ) {
          continue;
        }
        this.assertCandidatePath(candidateDir, entry.name);
        removeDirectoryIfPresent(candidateDir);
      }
    } catch {
      // Filesystem inspection failures must preserve candidates for explicit later recovery.
    }
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private sessionById(sessionId: string): HostedAuthSession {
    if (!safeSessionId(sessionId)) {
      throw new SurfaceError("not_found", "Hosted auth session was not found.", { account: this.account.name });
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SurfaceError("not_found", "Hosted auth session was not found.", { account: this.account.name });
    }
    return session;
  }

  private clearActiveSession(session: HostedAuthSession): void {
    if (this.activeSessionId === session.sessionId) {
      this.activeSessionId = null;
    }
  }

  private async cleanupCandidate(session: HostedAuthSession): Promise<boolean> {
    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = undefined;
    }
    const browser = session.browser;
    if (browser) {
      try {
        await browser.close();
        session.browser = null;
      } catch {
        // A still-owned Chrome profile must remain untouched. The session retains the browser so a
        // later cancellation, daemon shutdown, or restart can retry safe cleanup.
        return false;
      }
    }
    this.assertCandidatePath(session.candidateDir, session.sessionId);
    removeDirectoryIfPresent(session.candidateDir);
    return true;
  }

  private expireIfDue(session: HostedAuthSession): boolean {
    if (Date.now() < session.expiresAtMs) {
      return false;
    }
    return true;
  }

  private async expire(session: HostedAuthSession): Promise<void> {
    if (["authenticated", "cancelled", "expired", "failed"].includes(session.status)) {
      return;
    }
    session.status = "expired";
    session.reason = "session_expired";
    await this.cleanupCandidate(session);
    this.clearActiveSession(session);
  }

  private assertInteractive(session: HostedAuthSession): void {
    if (this.expireIfDue(session)) {
      throw new SurfaceError("auth_expired", "Hosted auth session has expired.", { account: this.account.name });
    }
    if (session.status === "starting") {
      throw new SurfaceError("auth_pending", "Hosted browser is still starting.", {
        account: this.account.name,
        retryable: true,
      });
    }
    if (session.status !== "awaiting_browser" || !session.browser) {
      throw new SurfaceError("session_invalid", "Hosted auth session is not accepting browser interaction.", {
        account: this.account.name,
      });
    }
  }

  private scheduleExpiry(session: HostedAuthSession): void {
    const delay = Math.max(0, session.expiresAtMs - Date.now());
    session.expiryTimer = setTimeout(() => {
      void this.runSerialized(async () => {
        if (this.expireIfDue(session)) {
          await this.expire(session);
        }
      });
    }, delay);
    session.expiryTimer.unref();
  }

  private async startBrowser(session: HostedAuthSession): Promise<void> {
    try {
      const browser = await this.browserFactory.create({
        profileDir: session.candidateProfileDir,
        headless: this.headless,
        outlookUrl: this.outlookUrl,
      });
      if (this.expireIfDue(session) || session.status !== "starting") {
        await safelyCloseBrowser(browser);
        if (this.expireIfDue(session)) {
          await this.expire(session);
        }
        return;
      }
      session.browser = browser;
      session.status = "awaiting_browser";
    } catch {
      session.status = "failed";
      session.reason = "browser_start_failed";
      await this.cleanupCandidate(session);
      this.clearActiveSession(session);
    }
  }

  begin(expectedEmails = this.defaultExpectedEmails): HostedAuthPublicSession {
    const normalizedExpectedEmails = normalizeExpectedEmails(expectedEmails);
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (active && !["authenticated", "cancelled", "expired", "failed"].includes(active.status)) {
      if (active.expectedEmails.join("\u0000") !== normalizedExpectedEmails.join("\u0000")) {
        throw new SurfaceError("session_invalid", "Hosted auth already has an active session with different expected identity aliases.");
      }
      return publicStatus(this.account, active);
    }

    const sessionId = makeAuthSessionId();
    const candidateDir = this.candidateDirFor(sessionId);
    const candidateProfileDir = join(candidateDir, "profile");
    mkdirSync(candidateProfileDir, { recursive: true, mode: 0o700 });
    writePrivateJson(join(candidateDir, "session.json"), {
      version: 1,
      session_id: sessionId,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + this.ttlMs).toISOString(),
    });

    const session: HostedAuthSession = {
      sessionId,
      status: "starting",
      expiresAtMs: Date.now() + this.ttlMs,
      candidateDir,
      candidateProfileDir,
      browser: null,
      reason: undefined,
      probe: undefined,
      expectedEmails: normalizedExpectedEmails,
      identityStatus: normalizedExpectedEmails.length > 0 ? "not_checked" : "not_requested",
      expiryTimer: undefined,
    };
    this.sessions.set(sessionId, session);
    this.activeSessionId = sessionId;
    this.scheduleExpiry(session);
    void this.runSerialized(() => this.startBrowser(session));
    return publicStatus(this.account, session);
  }

  status(sessionId: string): HostedAuthPublicSession {
    const session = this.sessionById(sessionId);
    if (this.expireIfDue(session) && !["authenticated", "cancelled", "expired", "failed"].includes(session.status)) {
      session.status = "expired";
      session.reason = "session_expired";
      this.clearActiveSession(session);
      void this.runSerialized(() => this.cleanupCandidate(session));
    }
    return publicStatus(this.account, session);
  }

  currentStatus():
    | { schema_version: "1"; account: string; provider: "outlook"; status: "idle" }
    | HostedAuthPublicSession {
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (!active) {
      return {
        schema_version: "1",
        account: this.account.name,
        provider: "outlook",
        status: "idle",
      };
    }
    return publicStatus(this.account, active);
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    return this.runSerialized(async () => {
      const session = this.sessionById(sessionId);
      if (this.expireIfDue(session)) {
        await this.expire(session);
        throw new SurfaceError("auth_expired", "Hosted auth session has expired.", { account: this.account.name });
      }
      this.assertInteractive(session);
      return session.browser!.screenshot();
    });
  }

  async interact(sessionId: string, action: "click" | "type" | "key" | "scroll", payload: unknown): Promise<HostedAuthPublicSession> {
    return this.runSerialized(async () => {
      const session = this.sessionById(sessionId);
      if (this.expireIfDue(session)) {
        await this.expire(session);
        return publicStatus(this.account, session);
      }
      this.assertInteractive(session);
      const input = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : (() => { throw new SurfaceError("invalid_argument", "Browser interaction input must be a JSON object."); })();

      switch (action) {
        case "click": {
          const x = strictInteger(input.x, "x", { min: 0, max: MAX_SCREENSHOT_DIMENSION });
          const y = strictInteger(input.y, "y", { min: 0, max: MAX_SCREENSHOT_DIMENSION });
          await session.browser!.click(x, y);
          break;
        }
        case "type": {
          if (typeof input.text !== "string" || input.text.length === 0 || input.text.length > MAX_ACTION_TEXT_LENGTH) {
            throw new SurfaceError("invalid_argument", `text must contain 1-${MAX_ACTION_TEXT_LENGTH} characters.`);
          }
          if (/\p{Cc}/u.test(input.text.replace(/\t/g, ""))) {
            throw new SurfaceError("invalid_argument", "text cannot contain control characters.");
          }
          await session.browser!.type(input.text);
          break;
        }
        case "key": {
          if (typeof input.key !== "string" || !ALLOWED_BROWSER_KEYS.has(input.key)) {
            throw new SurfaceError("invalid_argument", "Browser key is not allowlisted.");
          }
          await session.browser!.key(input.key);
          break;
        }
        case "scroll": {
          const deltaX = strictInteger(input.delta_x ?? 0, "delta_x", { min: -MAX_SCROLL_DELTA, max: MAX_SCROLL_DELTA });
          const deltaY = strictInteger(input.delta_y ?? 0, "delta_y", { min: -MAX_SCROLL_DELTA, max: MAX_SCROLL_DELTA });
          await session.browser!.scroll(deltaX, deltaY);
          break;
        }
      }

      return publicStatus(this.account, session);
    });
  }

  private promoteCandidate(session: HostedAuthSession): void {
    const activeProfileDir = this.activeProfileDir();
    const backupDir = this.backupDirFor(session.sessionId);
    this.assertCandidatePath(session.candidateDir, session.sessionId);
    if (existsSync(backupDir)) {
      throw new SurfaceError("invalid_configuration", "A previous hosted auth promotion backup is still present.");
    }

    writePrivateJson(this.promotionStatePath, {
      version: 1,
      session_id: session.sessionId,
      phase: "prepared",
    } satisfies PromotionState);

    let activeMoved = false;
    let candidatePromoted = false;
    try {
      if (existsSync(activeProfileDir)) {
        renameSync(activeProfileDir, backupDir);
        activeMoved = true;
        writePrivateJson(this.promotionStatePath, {
          version: 1,
          session_id: session.sessionId,
          phase: "active_moved",
        } satisfies PromotionState);
      }

      renameSync(session.candidateProfileDir, activeProfileDir);
      candidatePromoted = true;
      writePrivateJson(this.promotionStatePath, {
        version: 1,
        session_id: session.sessionId,
        phase: "candidate_promoted",
      } satisfies PromotionState);
      removeDirectoryIfPresent(backupDir);
      removeFileIfPresent(this.promotionStatePath);
      removeDirectoryIfPresent(session.candidateDir);
    } catch (error) {
      if (activeMoved && candidatePromoted && existsSync(activeProfileDir) && existsSync(backupDir)) {
        try {
          renameSync(activeProfileDir, session.candidateProfileDir);
          renameSync(backupDir, activeProfileDir);
          removeFileIfPresent(this.promotionStatePath);
        } catch {
          // The durable marker makes the next daemon startup recover the profile that remains.
        }
      } else if (activeMoved && !existsSync(activeProfileDir) && existsSync(backupDir)) {
        try {
          renameSync(backupDir, activeProfileDir);
          removeFileIfPresent(this.promotionStatePath);
        } catch {
          // The durable marker makes the next daemon startup restore the prior profile.
        }
      }
      throw error;
    }
  }

  async finalize(sessionId: string): Promise<HostedAuthPublicSession> {
    return this.runSerialized(async () => {
      const session = this.sessionById(sessionId);
      if (session.status === "authenticated") {
        return publicStatus(this.account, session);
      }
      if (this.expireIfDue(session)) {
        await this.expire(session);
        return publicStatus(this.account, session);
      }
      this.assertInteractive(session);
      session.status = "probing";

      let probe: AuthStatus;
      try {
        probe = await session.browser!.probe(this.context.config.providerTimeoutMs);
      } catch {
        probe = { status: "unknown" };
      }
      session.probe = probe.status;

      if (this.expireIfDue(session)) {
        await this.expire(session);
        return publicStatus(this.account, session);
      }
      if (probe.status !== "authenticated") {
        session.status = "awaiting_browser";
        return publicStatus(this.account, session);
      }

      if (session.expectedEmails.length > 0) {
        let observedIdentity: string | null = null;
        try {
          observedIdentity = await session.browser!.identity();
        } catch {
          observedIdentity = null;
        }
        if (!observedIdentity) {
          session.status = "awaiting_browser";
          session.identityStatus = "unavailable";
          return publicStatus(this.account, session);
        }
        if (!session.expectedEmails.includes(normalizeExpectedEmail(observedIdentity))) {
          session.status = "awaiting_browser";
          session.identityStatus = "mismatched";
          return publicStatus(this.account, session);
        }
        session.identityStatus = "matched";
      }

      let promoted = false;
      try {
        // Chrome must release every candidate-profile file before an atomic rename can make it the
        // active profile. A close failure is a hard stop: retaining the old active profile is safer
        // than racing an unknown browser process.
        await session.browser!.close();
        session.browser = null;
        this.promoteCandidate(session);
        promoted = true;
        session.status = "authenticated";
        if (session.expiryTimer) {
          clearTimeout(session.expiryTimer);
          session.expiryTimer = undefined;
        }
        this.clearActiveSession(session);
      } catch {
        session.status = "failed";
        session.reason = session.browser ? "browser_close_failed" : "profile_promotion_failed";
        this.clearActiveSession(session);
      } finally {
        if (!promoted) {
          await this.cleanupCandidate(session);
        }
      }
      return publicStatus(this.account, session);
    });
  }

  async cancel(sessionId: string): Promise<HostedAuthPublicSession> {
    return this.runSerialized(async () => {
      const session = this.sessionById(sessionId);
      if (session.status === "authenticated") {
        throw new SurfaceError("session_invalid", "An authenticated hosted auth session cannot be cancelled.", {
          account: this.account.name,
        });
      }
      if (["cancelled", "expired", "failed"].includes(session.status)) {
        return publicStatus(this.account, session);
      }
      session.status = "cancelled";
      session.reason = "cancelled_by_client";
      await this.cleanupCandidate(session);
      this.clearActiveSession(session);
      return publicStatus(this.account, session);
    });
  }

  async close(): Promise<void> {
    await this.runSerialized(async () => {
      let allBrowsersClosed = true;
      const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
      if (active && !["authenticated", "cancelled", "expired", "failed"].includes(active.status)) {
        active.status = "cancelled";
        active.reason = "cancelled_by_client";
        allBrowsersClosed = await this.cleanupCandidate(active);
        this.clearActiveSession(active);
      }
      for (const session of this.sessions.values()) {
        if (session === active || !session.browser) {
          continue;
        }
        allBrowsersClosed = (await this.cleanupCandidate(session)) && allBrowsersClosed;
      }
      if (allBrowsersClosed) {
        this.releaseDaemonLock();
      }
    });
  }

  authorize(authorization: string | undefined): boolean {
    if (!authorization?.startsWith("Bearer ")) {
      return false;
    }
    const provided = Buffer.from(authorization.slice("Bearer ".length));
    const expected = Buffer.from(this.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendSafeError(response: ServerResponse, statusCode: number, code: string, message: string): void {
  sendJson(response, statusCode, {
    schema_version: "1",
    error: {
      code,
      message,
      retryable: false,
      account: null,
      message_ref: null,
      thread_ref: null,
    },
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new SurfaceError("invalid_argument", "Request body is too large.");
    }
    chunks.push(bytes);
  }
  if (size === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SurfaceError("invalid_argument", "Request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SurfaceError("invalid_argument", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function safeHttpStatus(error: unknown): { statusCode: number; code: string; message: string } {
  if (!(error instanceof SurfaceError)) {
    return { statusCode: 500, code: "internal_error", message: "Hosted auth request failed." };
  }
  switch (error.code) {
    case "not_found":
      return { statusCode: 404, code: "not_found", message: "Hosted auth session was not found." };
    case "auth_pending":
      return { statusCode: 409, code: "auth_pending", message: "Hosted browser is still starting." };
    case "auth_expired":
      return { statusCode: 410, code: "auth_expired", message: "Hosted auth session has expired." };
    case "session_invalid":
      return { statusCode: 409, code: "session_invalid", message: "Hosted auth session is not accepting that action." };
    case "invalid_argument":
      return { statusCode: 400, code: "invalid_argument", message: error.message };
    default:
      return { statusCode: 400, code: "request_rejected", message: "Hosted auth request was rejected." };
  }
}

function requireEmptyObject(input: Record<string, unknown>): void {
  if (Object.keys(input).length > 0) {
    throw new SurfaceError("invalid_argument", "This endpoint does not accept request fields.");
  }
}

function expectedEmailsFromBeginInput(input: Record<string, unknown>): string[] | undefined {
  const permitted = new Set(["expected_email", "expected_emails"]);
  if (Object.keys(input).some((key) => !permitted.has(key))) {
    throw new SurfaceError("invalid_argument", "Begin only accepts expected_email or expected_emails.");
  }
  const expectedEmails: string[] = [];
  if (input.expected_email !== undefined) {
    if (typeof input.expected_email !== "string") {
      throw new SurfaceError("invalid_argument", "expected_email must be a string.");
    }
    expectedEmails.push(input.expected_email);
  }
  if (input.expected_emails !== undefined) {
    if (!Array.isArray(input.expected_emails) || input.expected_emails.some((value) => typeof value !== "string")) {
      throw new SurfaceError("invalid_argument", "expected_emails must be an array of strings.");
    }
    expectedEmails.push(...input.expected_emails);
  }
  return input.expected_email === undefined && input.expected_emails === undefined
    ? undefined
    : normalizeExpectedEmails(expectedEmails);
}

export async function startHostedOutlookAuthServer(options: HostedAuthServiceOptions & {
  host: string;
  port: number;
}): Promise<HostedAuthHttpServer> {
  const service = new HostedOutlookAuthService(options);
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        if (!service.authorize(request.headers.authorization)) {
          sendSafeError(response, 401, "forbidden", "Authorization required.");
          return;
        }
        const method = request.method ?? "";
        const url = new URL(request.url ?? "/", "http://localhost");
        const path = url.pathname;

        if (method === "GET" && path === "/health") {
          sendJson(response, 200, {
            schema_version: "1",
            status: "ok",
            account: options.account.name,
            provider: "outlook",
          });
          return;
        }
        if (method === "GET" && path === "/v1/auth/status") {
          sendJson(response, 200, service.currentStatus());
          return;
        }
        if (method === "POST" && path === "/v1/auth/begin") {
          const expectedEmails = expectedEmailsFromBeginInput(await readJsonBody(request));
          sendJson(response, 202, service.begin(expectedEmails));
          return;
        }

        const statusMatch = /^\/v1\/auth\/(auth_[0-9A-HJKMNP-TV-Z]{26})\/status$/u.exec(path);
        if (method === "GET" && statusMatch) {
          sendJson(response, 200, service.status(statusMatch[1]!));
          return;
        }
        const screenshotMatch = /^\/v1\/auth\/(auth_[0-9A-HJKMNP-TV-Z]{26})\/screenshot$/u.exec(path);
        if (method === "GET" && screenshotMatch) {
          const screenshot = await service.screenshot(screenshotMatch[1]!);
          response.writeHead(200, {
            "content-type": "image/png",
            "cache-control": "no-store",
          });
          response.end(screenshot);
          return;
        }
        const finalizeMatch = /^\/v1\/auth\/(auth_[0-9A-HJKMNP-TV-Z]{26})\/finalize$/u.exec(path);
        if (method === "POST" && finalizeMatch) {
          requireEmptyObject(await readJsonBody(request));
          sendJson(response, 200, await service.finalize(finalizeMatch[1]!));
          return;
        }
        const cancelMatch = /^\/v1\/auth\/(auth_[0-9A-HJKMNP-TV-Z]{26})\/cancel$/u.exec(path);
        if (method === "POST" && cancelMatch) {
          requireEmptyObject(await readJsonBody(request));
          sendJson(response, 200, await service.cancel(cancelMatch[1]!));
          return;
        }
        const interactionMatch = /^\/v1\/auth\/(auth_[0-9A-HJKMNP-TV-Z]{26})\/interaction\/(click|type|key|scroll)$/u.exec(path);
        if (method === "POST" && interactionMatch) {
          const action = interactionMatch[2]! as "click" | "type" | "key" | "scroll";
          sendJson(response, 200, await service.interact(interactionMatch[1]!, action, await readJsonBody(request)));
          return;
        }

        sendSafeError(response, 404, "not_found", "Hosted auth endpoint was not found.");
      } catch (error) {
        const safe = safeHttpStatus(error);
        sendSafeError(response, safe.statusCode, safe.code, safe.message);
      }
    })();
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port, options.host, () => resolveListen());
    });
  } catch (error) {
    await service.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await service.close();
    throw new SurfaceError("transport_error", "Hosted auth server did not expose a TCP address.");
  }

  return {
    host: options.host,
    port: address.port,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await service.close();
    },
  };
}

export function readHostedAuthToken(options: { tokenFile?: string; environment?: NodeJS.ProcessEnv } = {}): string {
  const environment = options.environment ?? process.env;
  if (options.tokenFile) {
    let token: string;
    let mode: number;
    try {
      const tokenPath = resolve(options.tokenFile);
      mode = statSync(tokenPath).mode & 0o777;
      token = readFileSync(tokenPath, "utf8").trim();
    } catch {
      throw new SurfaceError("invalid_configuration", "Hosted auth token file could not be read.");
    }
    if ((mode & 0o077) !== 0) {
      throw new SurfaceError("invalid_configuration", "Hosted auth token file must not be group- or world-readable.");
    }
    if (token.length < 24) {
      throw new SurfaceError("invalid_configuration", "Hosted auth token must contain at least 24 characters.");
    }
    return token;
  }

  const token = environment.SURFACE_AUTH_SERVICE_TOKEN?.trim();
  if (!token || token.length < 24) {
    throw new SurfaceError(
      "invalid_configuration",
      "Set SURFACE_AUTH_SERVICE_TOKEN or pass --auth-token-file with a token of at least 24 characters.",
    );
  }
  return token;
}

export const hostedAuthDefaults = {
  ttlSeconds: DEFAULT_AUTH_SESSION_TTL_SECONDS,
  maxActionTextLength: MAX_ACTION_TEXT_LENGTH,
};
