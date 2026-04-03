import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { MailAccount } from "../../contracts/account.js";
import type {
  AttachmentDownloadEnvelope,
  AttachmentListEnvelope,
  FetchUnreadQuery,
  NormalizedThreadRecord,
  ReadResultEnvelope,
  SearchQuery,
} from "../../contracts/mail.js";
import { notImplemented } from "../../lib/errors.js";
import type { AuthStatus, MailProviderAdapter, ProviderContext } from "../types.js";
import { launchOutlookSession, probeOutlookAuth, promptForOutlookLogin } from "./session.js";

function outlookProfileDir(context: ProviderContext): string {
  return join(context.accountPaths.authDir, "profile");
}

export class OutlookWebPlaywrightAdapter implements MailProviderAdapter {
  readonly provider = "outlook" as const;
  readonly transport = "outlook-web-playwright";

  async login(account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: false });

    try {
      await session.page.goto("https://outlook.office.com/mail/", { waitUntil: "domcontentloaded" });
      await promptForOutlookLogin(profileDir);
      return await probeOutlookAuth(session.page, { timeoutMs: context.config.providerTimeoutMs });
    } finally {
      await session.context.close();
    }
  }

  async logout(_account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    const profileDir = outlookProfileDir(context);
    rmSync(profileDir, { recursive: true, force: true });
    return {
      status: "unauthenticated",
      detail: "Removed the Outlook persistent profile directory for this account.",
    };
  }

  async authStatus(_account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    const profileDir = outlookProfileDir(context);
    if (!existsSync(profileDir)) {
      return { status: "unauthenticated", detail: "No Outlook browser profile found for this account." };
    }

    const profileEntries = readdirSync(profileDir);
    if (profileEntries.length === 0) {
      return { status: "unauthenticated", detail: "Outlook profile directory exists but is empty." };
    }

    let session;
    try {
      session = await launchOutlookSession(profileDir, { headless: true });
      return await probeOutlookAuth(session.page, { timeoutMs: context.config.providerTimeoutMs });
    } catch (error) {
      return {
        status: "unknown",
        detail:
          error instanceof Error
            ? `Could not probe Outlook auth state: ${error.message}`
            : "Could not probe Outlook auth state.",
      };
    } finally {
      await session?.context.close();
    }
  }

  async search(account: MailAccount, _query: SearchQuery): Promise<NormalizedThreadRecord[]> {
    notImplemented("Outlook Playwright search is not wired yet.", account.name);
  }

  async fetchUnread(account: MailAccount, _query: FetchUnreadQuery): Promise<NormalizedThreadRecord[]> {
    notImplemented("Outlook Playwright fetch-unread is not wired yet.", account.name);
  }

  async readMessage(account: MailAccount): Promise<ReadResultEnvelope> {
    notImplemented("Outlook Playwright read is not wired yet.", account.name);
  }

  async listAttachments(account: MailAccount): Promise<AttachmentListEnvelope> {
    notImplemented("Outlook attachment listing is not wired yet.", account.name);
  }

  async downloadAttachment(account: MailAccount): Promise<AttachmentDownloadEnvelope> {
    notImplemented("Outlook attachment download is not wired yet.", account.name);
  }
}
