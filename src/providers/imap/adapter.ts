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
  SearchQuery,
  SendMessageInput,
  SendResultEnvelope,
  SentMessageResult,
  SentQuery,
} from "../../contracts/mail.js";
import { SurfaceError, notImplemented } from "../../lib/errors.js";
import type { AuthStatus, MailProviderAdapter, ProviderContext } from "../types.js";
import { clearImapSmtpAuthState, readImapSmtpAuthState, writeImapSmtpAuthState } from "./auth.js";

export class ImapSmtpAdapter implements MailProviderAdapter {
  readonly provider = "imap" as const;
  readonly transport = "imap-smtp";

  async login(account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    if (!context.authLoginOptions) {
      throw new SurfaceError("invalid_argument", "Missing IMAP/SMTP auth login options.", {
        account: account.name,
      });
    }
    const state = writeImapSmtpAuthState(account, context, context.authLoginOptions);
    return {
      status: "authenticated",
      detail: `Stored IMAP/SMTP auth for ${state.username} using ${state.imap.host}:${state.imap.port}.`,
    };
  }

  async logout(_account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    clearImapSmtpAuthState(context);
    return {
      status: "unauthenticated",
      detail: "Removed stored IMAP/SMTP auth for this account.",
    };
  }

  async authStatus(account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    try {
      const state = readImapSmtpAuthState(account, context);
      return {
        status: "authenticated",
        detail: `Stored IMAP/SMTP auth for ${state.username} using ${state.imap.host}:${state.imap.port}.`,
      };
    } catch (error) {
      if (error instanceof SurfaceError && error.code === "reauth_required") {
        return {
          status: "unauthenticated",
          detail: error.message,
        };
      }
      throw error;
    }
  }

  async search(
    account: MailAccount,
    _query: SearchQuery,
    _context: ProviderContext,
  ): Promise<NormalizedThreadRecord[]> {
    notImplemented("IMAP search is not implemented yet.", account.name);
  }

  async fetchUnread(
    account: MailAccount,
    _query: FetchUnreadQuery,
    _context: ProviderContext,
  ): Promise<NormalizedThreadRecord[]> {
    notImplemented("IMAP fetch-unread is not implemented yet.", account.name);
  }

  async fetchSent(
    account: MailAccount,
    _query: SentQuery,
    _context: ProviderContext,
  ): Promise<SentMessageResult[]> {
    notImplemented("IMAP sent-mail lookup is not implemented yet.", account.name);
  }

  async refreshThread(account: MailAccount, threadRef: string, _context: ProviderContext): Promise<void> {
    notImplemented(`IMAP thread refresh is not implemented yet for '${threadRef}'.`, account.name);
  }

  async readMessage(
    account: MailAccount,
    messageRef: string,
    _refresh: boolean,
    _context: ProviderContext,
  ): Promise<ReadResultEnvelope> {
    notImplemented(`IMAP message read is not implemented yet for '${messageRef}'.`, account.name);
  }

  async listAttachments(
    account: MailAccount,
    messageRef: string,
    _context: ProviderContext,
  ): Promise<AttachmentListEnvelope> {
    notImplemented(`IMAP attachment list is not implemented yet for '${messageRef}'.`, account.name);
  }

  async downloadAttachment(
    account: MailAccount,
    messageRef: string,
    attachmentId: string,
    _context: ProviderContext,
  ): Promise<AttachmentDownloadEnvelope> {
    notImplemented(`IMAP attachment download is not implemented yet for '${messageRef}/${attachmentId}'.`, account.name);
  }

  async rsvp(
    account: MailAccount,
    messageRef: string,
    _response: RsvpResponse,
    _context: ProviderContext,
  ): Promise<RsvpResultEnvelope> {
    throw new SurfaceError("unsupported", `Generic IMAP RSVP is not supported for '${messageRef}'.`, {
      account: account.name,
      messageRef,
    });
  }

  async sendMessage(
    account: MailAccount,
    _input: SendMessageInput,
    _context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    notImplemented("IMAP/SMTP send is not implemented yet.", account.name);
  }

  async reply(
    account: MailAccount,
    messageRef: string,
    _input: ReplyInput,
    _context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    notImplemented(`IMAP/SMTP reply is not implemented yet for '${messageRef}'.`, account.name);
  }

  async replyAll(
    account: MailAccount,
    messageRef: string,
    _input: ReplyInput,
    _context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    notImplemented(`IMAP/SMTP reply-all is not implemented yet for '${messageRef}'.`, account.name);
  }

  async forward(
    account: MailAccount,
    messageRef: string,
    _input: ForwardInput,
    _context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    notImplemented(`IMAP/SMTP forward is not implemented yet for '${messageRef}'.`, account.name);
  }

  async archive(
    account: MailAccount,
    messageRef: string,
    _context: ProviderContext,
  ): Promise<ArchiveResultEnvelope> {
    notImplemented(`IMAP archive is not implemented yet for '${messageRef}'.`, account.name);
  }

  async markRead(
    account: MailAccount,
    _messageRefs: string[],
    _context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope> {
    notImplemented("IMAP mark-read is not implemented yet.", account.name);
  }

  async markUnread(
    account: MailAccount,
    _messageRefs: string[],
    _context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope> {
    notImplemented("IMAP mark-unread is not implemented yet.", account.name);
  }
}
