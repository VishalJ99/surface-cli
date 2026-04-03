import { existsSync } from "node:fs";
import { join } from "node:path";

import type { MailAccount } from "../../contracts/account.js";
import type {
  AttachmentDownloadEnvelope,
  AttachmentListEnvelope,
  FetchUnreadQuery,
  NormalizedThreadRecord,
  ReadResultEnvelope,
  RsvpResponse,
  RsvpResultEnvelope,
  SearchQuery,
} from "../../contracts/mail.js";
import { notImplemented } from "../../lib/errors.js";
import type { AuthStatus, MailProviderAdapter, ProviderContext } from "../types.js";

function gmailTokenPath(context: ProviderContext): string {
  return join(context.accountPaths.authDir, "gmail-token.json");
}

export class GmailApiAdapter implements MailProviderAdapter {
  readonly provider = "gmail" as const;
  readonly transport = "gmail-api";

  async login(account: MailAccount): Promise<AuthStatus> {
    notImplemented(
      "Gmail OAuth login is not wired yet. The next step is to port the legacy desktop OAuth flow into this adapter.",
      account.name,
    );
  }

  async logout(account: MailAccount): Promise<AuthStatus> {
    notImplemented(
      "Gmail logout is not wired yet. For now, remove the auth state under ~/.surface-cli/auth/<account_id>/ manually.",
      account.name,
    );
  }

  async authStatus(_account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    return existsSync(gmailTokenPath(context))
      ? { status: "authenticated", detail: "Refresh token file is present." }
      : { status: "unauthenticated", detail: "No Gmail token file found for this account." };
  }

  async search(account: MailAccount, _query: SearchQuery): Promise<NormalizedThreadRecord[]> {
    notImplemented("Gmail search is not wired yet.", account.name);
  }

  async fetchUnread(account: MailAccount, _query: FetchUnreadQuery): Promise<NormalizedThreadRecord[]> {
    notImplemented("Gmail fetch-unread is not wired yet.", account.name);
  }

  async readMessage(account: MailAccount): Promise<ReadResultEnvelope> {
    notImplemented("Gmail read is not wired yet.", account.name);
  }

  async listAttachments(account: MailAccount): Promise<AttachmentListEnvelope> {
    notImplemented("Gmail attachment listing is not wired yet.", account.name);
  }

  async rsvp(account: MailAccount, _messageRef: string, _response: RsvpResponse): Promise<RsvpResultEnvelope> {
    notImplemented("Gmail RSVP is not wired yet.", account.name);
  }

  async downloadAttachment(account: MailAccount): Promise<AttachmentDownloadEnvelope> {
    notImplemented("Gmail attachment download is not wired yet.", account.name);
  }
}
