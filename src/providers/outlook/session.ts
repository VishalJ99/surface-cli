import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { chromium, errors, type BrowserContext, type Page } from "playwright-core";

import type { AuthStatus } from "../types.js";
import { assertOutlookNotOnSignInPage, isMicrosoftSignInUrl } from "./auth-state.js";
import {
  createOutlookTempProfileClone,
  pruneOutlookTempProfiles,
} from "./temp-profiles.js";
import { reapOutlookOrphanChromium } from "./orphan-chromium.js";

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
  cleanup?: () => void;
}

export interface OutlookSessionLaunchDependencies {
  launchPersistentContext?: (
    userDataDir: string,
    options: Parameters<typeof chromium.launchPersistentContext>[1],
  ) => Promise<BrowserContext>;
  resolveChromeExecutablePath?: () => string;
  pruneTempProfiles?: typeof pruneOutlookTempProfiles;
  createTempProfileClone?: typeof createOutlookTempProfileClone;
  reapOrphanChromium?: typeof reapOutlookOrphanChromium;
  removeTempProfile?: (profileDir: string) => void;
}

const closingOutlookSessions = new WeakMap<OutlookSession, Promise<void>>();

async function closeOutlookResources(
  context: BrowserContext,
  cleanup: (() => void) | undefined,
): Promise<void> {
  let contextCloseFailed = false;
  let contextCloseError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;

  try {
    await context.close();
  } catch (error) {
    contextCloseFailed = true;
    contextCloseError = error;
  }

  try {
    cleanup?.();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (contextCloseFailed && cleanupFailed) {
    throw new AggregateError(
      [contextCloseError, cleanupError],
      "Failed to close the Outlook browser context and remove its temporary profile.",
    );
  }
  if (contextCloseFailed) {
    throw contextCloseError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
}

export function closeOutlookSession(session: OutlookSession): Promise<void> {
  const existing = closingOutlookSessions.get(session);
  if (existing) {
    return existing;
  }

  const closing = closeOutlookResources(session.context, session.cleanup);
  closingOutlookSessions.set(session, closing);
  return closing;
}

export async function launchOutlookSession(
  profileDir: string,
  options: { headless: boolean },
  dependencies: OutlookSessionLaunchDependencies = {},
): Promise<OutlookSession> {
  mkdirSync(profileDir, { recursive: true });
  let effectiveProfileDir = profileDir;
  let cleanup: (() => void) | undefined;

  if (options.headless && existsSync(profileDir) && readdirSync(profileDir).length > 0) {
    try {
      await (dependencies.reapOrphanChromium ?? reapOutlookOrphanChromium)();
    } catch {
      // Orphan reaping is best-effort and must not block Outlook account use.
    }
    try {
      (dependencies.pruneTempProfiles ?? pruneOutlookTempProfiles)();
    } catch {
      // Stale temp cleanup is opportunistic and must not block Outlook account use.
    }
    effectiveProfileDir = (dependencies.createTempProfileClone ?? createOutlookTempProfileClone)(profileDir);
    const removeTempProfile = dependencies.removeTempProfile;
    cleanup = () => {
      if (removeTempProfile) {
        removeTempProfile(effectiveProfileDir);
        return;
      }
      rmSync(effectiveProfileDir, { recursive: true, force: true });
    };
  }

  let context: BrowserContext | undefined;
  try {
    context = await (dependencies.launchPersistentContext ?? chromium.launchPersistentContext.bind(chromium))(
      effectiveProfileDir,
      {
        executablePath: (dependencies.resolveChromeExecutablePath ?? resolveChromeExecutablePath)(),
        headless: options.headless,
        viewport: { width: 1440, height: 960 },
      },
    );

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(15_000);
    return {
      context,
      page,
      ...(cleanup ? { cleanup } : {}),
    };
  } catch (error) {
    try {
      if (context) {
        await closeOutlookResources(context, cleanup);
      } else {
        cleanup?.();
      }
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Outlook browser session setup failed and its partial resources could not be fully closed.",
      );
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

    assertOutlookNotOnSignInPage(page.url());

    try {
      await waitForMessageList(page, Math.min(2_000, Math.max(500, deadline - Date.now())));
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(750);
    }
  }

  assertOutlookNotOnSignInPage(page.url());
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for Outlook mailbox UI.");
}

function classifyAuthBody(text: string, pageUrl: string): AuthStatus {
  const lowered = text.toLowerCase();
  if (isMicrosoftSignInUrl(pageUrl) || pageUrl.includes("/common/oauth2/")) {
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
