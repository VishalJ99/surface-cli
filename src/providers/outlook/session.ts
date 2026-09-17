import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { chromium, errors, type BrowserContext, type Page } from "playwright-core";

import {
  acquireSurfaceBrowserLease,
  browserAutomationRuntimeConfig,
} from "../../lib/browser-capacity.js";
import { BROWSER_COMMAND_DEADLINE_REASON, SurfaceError } from "../../lib/errors.js";
import type { AuthStatus } from "../types.js";
import {
  createOutlookTempProfileClone,
  pruneOutlookTempProfiles,
} from "./temp-profiles.js";

const DEFAULT_OUTLOOK_URL = "https://outlook.office.com/mail/";

function resolveChromeExecutablePath(): string {
  const explicitPath = process.env.SURFACE_CHROME_PATH;
  if (explicitPath) {
    return explicitPath;
  }

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
      : process.platform === "linux"
        ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]
        : [];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Could not find a Chrome executable for Outlook Playwright auth. Set SURFACE_CHROME_PATH explicitly.",
  );
}

export interface OutlookSession {
  context: BrowserContext;
  page: Page;
  // Internal process-recovery marker. It is never included in CLI or hosted-auth JSON.
  browserMarker: string;
  cleanup?: () => void;
  close(): Promise<void>;
  deadlineExceeded(): boolean;
}

export type OutlookSessionPurpose = "auth" | "command" | "interactive" | "warm";

export interface LaunchOutlookSessionOptions {
  headless: boolean;
  purpose?: OutlookSessionPurpose;
  commandTimeoutMs?: number;
}

export async function launchOutlookSession(
  profileDir: string,
  options: LaunchOutlookSessionOptions,
): Promise<OutlookSession> {
  const purpose = options.purpose ?? "command";
  const lease = await acquireSurfaceBrowserLease(purpose === "auth" ? "auth" : purpose === "warm" ? "warm" : "command");
  mkdirSync(profileDir, { recursive: true });
  let effectiveProfileDir = profileDir;
  let cleanup: (() => void) | undefined;
  let launchedContext: BrowserContext | undefined;

  try {
    if (options.headless && existsSync(profileDir) && readdirSync(profileDir).length > 0) {
      try {
        pruneOutlookTempProfiles();
      } catch {
        // Stale temp cleanup is opportunistic and must not block Outlook account use.
      }
      effectiveProfileDir = createOutlookTempProfileClone(profileDir);
      cleanup = () => rmSync(effectiveProfileDir, { recursive: true, force: true });
    }

    const context = await chromium.launchPersistentContext(effectiveProfileDir, {
      executablePath: resolveChromeExecutablePath(),
      headless: options.headless,
      viewport: { width: 1440, height: 960 },
      // This inert marker lets a later Surface process identify only its own Chromium process
      // when recovering a lease whose parent process was forcefully terminated.
      args: [lease.marker],
    });
    launchedContext = context;

    const page = context.pages()[0] ?? (await context.newPage());
    await lease.captureOwnedProcessTree();
    const commandTimeoutMs = options.commandTimeoutMs ?? browserAutomationRuntimeConfig().commandTimeoutMs;
    page.setDefaultTimeout(Math.min(15_000, commandTimeoutMs));
    page.setDefaultNavigationTimeout(commandTimeoutMs);

    let deadlineExceeded = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let closePromise: Promise<void> | undefined;
    let releasePromise: Promise<void> | undefined;
    const releaseLease = (): Promise<void> => {
      releasePromise ??= lease.release();
      return releasePromise;
    };
    const clearDeadline = () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        clearDeadline();
        if (deadlineExceeded) {
          await context.close({ reason: BROWSER_COMMAND_DEADLINE_REASON });
        } else {
          await context.close();
        }
        try {
          cleanup?.();
        } finally {
          await releaseLease();
        }
      })();
      return closePromise;
    };
    context.once("close", () => {
      clearDeadline();
      // A browser crash has already closed Chrome. Reclaim the capacity slot even when the normal
      // caller never reaches its finally block.
      void releaseLease().catch(() => undefined);
    });
    if (purpose === "command") {
      deadlineTimer = setTimeout(() => {
        deadlineExceeded = true;
        void close().catch(() => undefined);
      }, commandTimeoutMs);
      deadlineTimer.unref();
    }
    return {
      context,
      page,
      browserMarker: lease.marker,
      ...(cleanup ? { cleanup } : {}),
      close,
      deadlineExceeded: () => deadlineExceeded,
    };
  } catch (error) {
    if (launchedContext) {
      try {
        await launchedContext.close();
        cleanup?.();
        await lease.release();
      } catch {
        // A context that cannot close may still own Chromium/profile files. Retain the incomplete
        // lease for fail-closed recovery rather than freeing its capacity slot.
        throw new SurfaceError("browser_busy", "Browser launch could not be verified as stopped; retry shortly.", {
          retryable: true,
        });
      }
      throw error;
    }
    try {
      // A Playwright launch can reject after Chromium has started. Verify the marker-owned tree
      // is gone before removing its lease or candidate profile; otherwise the slot remains held
      // and stale recovery can safely retry the owned-child reap later.
      await lease.releaseAfterFailedLaunch();
      cleanup?.();
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }
}

async function bodyText(page: Page): Promise<string> {
  try {
    return await page.locator("body").innerText({ timeout: 3_000 });
  } catch {
    return "";
  }
}

async function maybeAdvanceAccountPicker(page: Page): Promise<boolean> {
  const text = await bodyText(page);
  if (!text.includes("Pick an account")) {
    return false;
  }

  const candidates = page.locator('button, [role="button"]');
  const count = Math.min(await candidates.count(), 12);

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    let candidateText = "";
    try {
      candidateText = (await candidate.innerText({ timeout: 1_000 })).trim();
    } catch {
      continue;
    }

    const lowered = candidateText.toLowerCase();
    if (!candidateText) {
      continue;
    }
    if (lowered.includes("use another account") || lowered.includes("terms of use") || lowered.includes("privacy")) {
      continue;
    }
    if (!candidateText.includes("@") && !candidateText.includes("\n")) {
      continue;
    }

    await candidate.click();
    return true;
  }

  return false;
}

async function waitForMessageList(page: Page, timeoutMs: number): Promise<void> {
  await page.locator('[role="listbox"]').first().waitFor({ timeout: timeoutMs });
}

async function waitForMailboxReady(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (await maybeAdvanceAccountPicker(page)) {
      await page.waitForTimeout(1_500);
      continue;
    }

    try {
      await waitForMessageList(page, Math.min(2_000, Math.max(500, deadline - Date.now())));
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(750);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for Outlook mailbox UI.");
}

function classifyAuthBody(text: string, pageUrl: string): AuthStatus {
  const lowered = text.toLowerCase();
  const loginUrls = ["login.microsoftonline.com", "login.live.com", "/common/oauth2/"];
  if (loginUrls.some((fragment) => pageUrl.includes(fragment))) {
    return { status: "unauthenticated", detail: "Outlook is on a Microsoft login page." };
  }

  const unauthenticatedMarkers = [
    "sign in",
    "enter password",
    "stay signed in",
    "pick an account",
    "use another account",
    "microsoft account",
  ];
  if (unauthenticatedMarkers.some((marker) => lowered.includes(marker))) {
    return { status: "unauthenticated", detail: "Outlook profile needs interactive sign-in." };
  }

  return { status: "unknown", detail: "Could not determine whether Outlook is authenticated." };
}

function normalizedUiEmail(value: string): string | null {
  const match = value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/iu);
  return match ? match[0]!.toLowerCase() : null;
}

// The Outlook Web shell does not expose a stable mailbox-identity API. Read only Microsoft account
// control elements, never document-wide email-looking labels or message text. A missing value is an
// honest unknown, not confirmation of the configured email.
export async function extractOutlookUiIdentity(page: Page): Promise<string | null> {
  const accountControls = '[data-automationid="mectrl_currentAccount_primary"], [data-automationid="mectrl_currentAccount_secondary"], [data-automationid="mectrl_account_email"]';
  const readValues = async (): Promise<string[]> => page
    .locator(accountControls)
    .evaluateAll((elements) => elements.slice(0, 12).flatMap((element) => {
      const candidates = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.textContent,
      ];
      return candidates
        .filter((candidate): candidate is string => typeof candidate === "string")
        .map((candidate) => candidate.slice(0, 512));
    }))
    .catch(() => [] as string[]);

  let values = await readValues();
  if (values.length === 0) {
    // On some Outlook shells this opens the account pane that owns the same mectrl controls. This
    // selector is deliberately narrow: it must not turn a message sender or title into identity.
    const accountMenu = page.locator('[data-automationid="mectrl_main_trigger"], #mectrl_main_trigger').first();
    try {
      if (await accountMenu.count()) {
        await accountMenu.click({ timeout: 2_000 });
        values = await readValues();
      }
    } catch {
      // The UI may have no account trigger in a minimal or changed Outlook shell.
    }
  }

  for (const value of values) {
    const email = normalizedUiEmail(value);
    if (email) {
      return email;
    }
  }
  return null;
}

export async function probeOutlookAuth(
  page: Page,
  options: { outlookUrl?: string; timeoutMs: number },
): Promise<AuthStatus> {
  const outlookUrl = options.outlookUrl ?? DEFAULT_OUTLOOK_URL;
  await page.goto(outlookUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });

  try {
    await waitForMailboxReady(page, options.timeoutMs);
    return {
      status: "authenticated",
      detail: "Outlook mailbox UI loaded successfully with the current persistent profile.",
    };
  } catch (error) {
    const text = await bodyText(page);
    const classified = classifyAuthBody(text, page.url());
    if (classified.status !== "unknown") {
      return classified;
    }

    if (error instanceof errors.TimeoutError) {
      return {
        status: "unknown",
        detail: "Timed out while probing Outlook auth state. The session may still require manual interaction.",
      };
    }

    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : "Unknown Outlook auth probe failure.",
    };
  }
}

export async function promptForOutlookLogin(profileDir: string): Promise<void> {
  console.error("");
  console.error("One-time Outlook profile bootstrap");
  console.error(`Profile directory: ${profileDir}`);
  console.error(`URL: ${DEFAULT_OUTLOOK_URL}`);
  console.error("1. A Chrome window will open using the persistent Surface profile.");
  console.error("2. Sign in to Outlook and complete MFA if prompted.");
  console.error("3. Wait until the inbox is fully loaded.");
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error("No interactive TTY detected, so Surface will not wait for Enter.");
    return;
  }

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    await readline.question("Press Enter here once Outlook is signed in and the inbox is visible...");
  } finally {
    readline.close();
  }
}
