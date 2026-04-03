import type { MailAccount } from "../contracts/account.js";
import type {
  AttachmentDownloadEnvelope,
  AttachmentListEnvelope,
  FetchUnreadQuery,
  NormalizedThreadRecord,
  ReadResultEnvelope,
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
  downloadAttachment(
    account: MailAccount,
    messageRef: string,
    attachmentId: string,
    context: ProviderContext,
  ): Promise<AttachmentDownloadEnvelope>;
}
