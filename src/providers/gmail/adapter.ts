import type { MailAccount } from "../../contracts/account.js";
import type {
  ArchiveResultEnvelope,
  AttachmentDownloadEnvelope,
  AttachmentListEnvelope,
  FetchUnreadQuery,
  ForwardInput,
  MarkMessagesResultEnvelope,
  NormalizedThreadRecord,
  ReadResultEnvelope,
  ReplyInput,
  RsvpResponse,
  RsvpResultEnvelope,
  SendMessageInput,
  SendResultEnvelope,
  SearchQuery,
} from "../../contracts/mail.js";
import { notImplemented } from "../../lib/errors.js";
import type { AuthStatus, MailProviderAdapter, ProviderContext } from "../types.js";
import { clearGmailAuthState, gmailAuthStatus, runGmailLogin } from "./oauth.js";

export class GmailApiAdapter implements MailProviderAdapter {
  readonly provider = "gmail" as const;
  readonly transport = "gmail-api";

  async login(account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    const result = await runGmailLogin(account, context);
    if (result.authenticatedEmail && result.authenticatedEmail !== account.email) {
      context.db.upsertAccount({
        name: account.name,
        provider: account.provider,
        transport: account.transport,
        email: result.authenticatedEmail,
      });
    }

    return {
      status: "authenticated",
      detail: result.authenticatedEmail
        ? `Authenticated as ${result.authenticatedEmail}.`
        : "Gmail OAuth complete.",
    };
  }

  async logout(_account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    clearGmailAuthState(context);
    return {
      status: "unauthenticated",
      detail: "Removed the stored Gmail token and copied client secret for this account.",
    };
  }

  async authStatus(account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    const status = await gmailAuthStatus(account, context);
    return status.authenticated
      ? { status: "authenticated", detail: status.detail }
      : { status: "unauthenticated", detail: status.detail };
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

  async sendMessage(account: MailAccount, _input: SendMessageInput): Promise<SendResultEnvelope> {
    notImplemented("Gmail send is not wired yet.", account.name);
  }

  async reply(account: MailAccount, _messageRef: string, _input: ReplyInput): Promise<SendResultEnvelope> {
    notImplemented("Gmail reply is not wired yet.", account.name);
  }

  async replyAll(account: MailAccount, _messageRef: string, _input: ReplyInput): Promise<SendResultEnvelope> {
    notImplemented("Gmail reply-all is not wired yet.", account.name);
  }

  async forward(account: MailAccount, _messageRef: string, _input: ForwardInput): Promise<SendResultEnvelope> {
    notImplemented("Gmail forward is not wired yet.", account.name);
  }

  async archive(account: MailAccount, _messageRef: string): Promise<ArchiveResultEnvelope> {
    notImplemented("Gmail archive is not wired yet.", account.name);
  }

  async markRead(account: MailAccount, _messageRefs: string[]): Promise<MarkMessagesResultEnvelope> {
    notImplemented("Gmail mark-read is not wired yet.", account.name);
  }

  async markUnread(account: MailAccount, _messageRefs: string[]): Promise<MarkMessagesResultEnvelope> {
    notImplemented("Gmail mark-unread is not wired yet.", account.name);
  }

  async downloadAttachment(account: MailAccount): Promise<AttachmentDownloadEnvelope> {
    notImplemented("Gmail attachment download is not wired yet.", account.name);
  }
}
