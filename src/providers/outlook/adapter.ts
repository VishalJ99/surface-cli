import { existsSync, readdirSync } from "node:fs";
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

function outlookProfileDir(context: ProviderContext): string {
  return join(context.accountPaths.authDir, "profile");
}

export class OutlookWebPlaywrightAdapter implements MailProviderAdapter {
  readonly provider = "outlook" as const;
  readonly transport = "outlook-web-playwright";

  async login(account: MailAccount): Promise<AuthStatus> {
    notImplemented(
      "Outlook Playwright login is not wired yet. The next step is to port the persistent-profile bootstrap into this adapter.",
      account.name,
    );
  }

  async logout(account: MailAccount): Promise<AuthStatus> {
    notImplemented(
      "Outlook logout is not wired yet. For now, remove the profile under ~/.surface-cli/auth/<account_id>/profile manually.",
      account.name,
    );
  }

  async authStatus(_account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    const profileDir = outlookProfileDir(context);
    if (!existsSync(profileDir)) {
      return { status: "unauthenticated", detail: "No Outlook browser profile found for this account." };
    }

    const profileEntries = readdirSync(profileDir);
    return profileEntries.length > 0
      ? { status: "authenticated", detail: "Persistent Outlook browser profile is present." }
      : { status: "unauthenticated", detail: "Outlook profile directory exists but is empty." };
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
