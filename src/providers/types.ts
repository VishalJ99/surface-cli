import type { MailAccount } from "../contracts/account.js";
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
} from "../contracts/mail.js";
import type { AccountPaths, SurfacePaths } from "../paths.js";
import type { SurfaceDatabase } from "../state/database.js";
import type { SurfaceConfig } from "../config.js";

export interface AuthStatus {
  status: "authenticated" | "unauthenticated" | "unknown";
  detail?: string;
}

export interface ProviderContext {
  config: SurfaceConfig;
  paths: SurfacePaths;
  accountPaths: AccountPaths;
  db: SurfaceDatabase;
}

export interface MailProviderAdapter {
  readonly provider: MailAccount["provider"];
  readonly transport: string;

  login(account: MailAccount, context: ProviderContext): Promise<AuthStatus>;
  logout(account: MailAccount, context: ProviderContext): Promise<AuthStatus>;
  authStatus(account: MailAccount, context: ProviderContext): Promise<AuthStatus>;

  search(
    account: MailAccount,
    query: SearchQuery,
    context: ProviderContext,
  ): Promise<NormalizedThreadRecord[]>;
  fetchUnread(
    account: MailAccount,
    query: FetchUnreadQuery,
    context: ProviderContext,
  ): Promise<NormalizedThreadRecord[]>;
  refreshThread(
    account: MailAccount,
    threadRef: string,
    context: ProviderContext,
  ): Promise<void>;
  readMessage(
    account: MailAccount,
    messageRef: string,
    refresh: boolean,
    context: ProviderContext,
  ): Promise<ReadResultEnvelope>;
  listAttachments(
    account: MailAccount,
    messageRef: string,
    context: ProviderContext,
  ): Promise<AttachmentListEnvelope>;
  rsvp(
    account: MailAccount,
    messageRef: string,
    response: RsvpResponse,
    context: ProviderContext,
  ): Promise<RsvpResultEnvelope>;
  sendMessage(
    account: MailAccount,
    input: SendMessageInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope>;
  reply(
    account: MailAccount,
    messageRef: string,
    input: ReplyInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope>;
  replyAll(
    account: MailAccount,
    messageRef: string,
    input: ReplyInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope>;
  forward(
    account: MailAccount,
    messageRef: string,
    input: ForwardInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope>;
  archive(
    account: MailAccount,
    messageRef: string,
    context: ProviderContext,
  ): Promise<ArchiveResultEnvelope>;
  markRead(
    account: MailAccount,
    messageRefs: string[],
    context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope>;
  markUnread(
    account: MailAccount,
    messageRefs: string[],
    context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope>;
  downloadAttachment(
    account: MailAccount,
    messageRef: string,
    attachmentId: string,
    context: ProviderContext,
  ): Promise<AttachmentDownloadEnvelope>;
}
