import type { MailProvider } from "./account.js";

export interface SourceInfo {
  provider: MailProvider;
  transport: string;
}

export interface MessageParticipant {
  name: string;
  email: string;
}

export interface ThreadParticipant extends MessageParticipant {
  role: "from" | "to" | "cc" | "bcc";
}

export interface ThreadEnvelope {
  subject: string;
  participants: ThreadParticipant[];
  mailbox: string;
  labels: string[];
  received_at: string | null;
  message_count: number;
  unread_count: number;
  has_attachments: boolean;
}

export interface ThreadSummary {
  backend: string;
  model: string;
  brief: string;
  needs_action: boolean;
  importance: "low" | "medium" | "high";
}

export type RsvpResponse = "accept" | "decline" | "tentative";
export type SendMode = "draft_only" | "allow_send";

export interface MessageEnvelope {
  subject?: string;
  from: MessageParticipant | null;
  to: MessageParticipant[];
  cc: MessageParticipant[];
  sent_at: string | null;
  received_at: string | null;
  unread: boolean;
}

export interface MessageBody {
  text: string;
  truncated: boolean;
  cached: boolean;
  cached_bytes: number;
}

export interface AttachmentMeta {
  attachment_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
  inline: boolean;
}

export interface MessageInvite {
  is_invite: boolean;
  rsvp_supported: boolean;
  response_status: string | null;
  available_rsvp_responses: RsvpResponse[];
}

export interface MessageResult {
  message_ref: string;
  envelope: MessageEnvelope;
  snippet: string;
  body: MessageBody;
  attachments: AttachmentMeta[];
  invite?: MessageInvite;
}

export interface ThreadResult {
  thread_ref: string;
  source: SourceInfo;
  envelope: ThreadEnvelope;
  summary: ThreadSummary | null;
  messages: MessageResult[];
}

export interface SearchQuery {
  text: string;
  limit: number;
  unread_only: boolean;
}

export interface FetchUnreadQuery {
  limit: number;
  unread_only: true;
}

export interface SearchResultEnvelope {
  schema_version: "1";
  command: "search" | "fetch-unread";
  generated_at: string;
  account: string;
  query: {
    text?: string;
    limit: number;
    unread_only: boolean;
  };
  threads: ThreadResult[];
}

export interface ReadResultEnvelope {
  schema_version: "1";
  command: "read";
  account: string;
  message_ref: string;
  thread_ref: string;
  source: SourceInfo;
  cache: {
    status: "hit" | "miss" | "refreshed";
    truncated: boolean;
  };
  message: Omit<MessageResult, "message_ref" | "snippet">;
}

export interface AttachmentListEnvelope {
  schema_version: "1";
  command: "attachment-list";
  account: string;
  message_ref: string;
  attachments: AttachmentMeta[];
}

export interface AttachmentDownloadEnvelope {
  schema_version: "1";
  command: "attachment-download";
  account: string;
  message_ref: string;
  attachment: AttachmentMeta & {
    saved_to: string;
  };
}

export interface ComposeRecipients {
  to: MessageParticipant[];
  cc: MessageParticipant[];
  bcc: MessageParticipant[];
}

export interface SendMessageInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface ReplyInput {
  cc: string[];
  bcc: string[];
  body: string;
}

export interface ForwardInput {
  to: string[];
  cc: string[];
  bcc: string[];
  body: string;
}

export interface SendResultEnvelope {
  schema_version: "1";
  command: "send" | "reply" | "reply-all" | "forward";
  account: string;
  source: SourceInfo;
  status: "sent" | "drafted";
  subject: string;
  recipients: ComposeRecipients;
  thread_ref: string | null;
  message_ref: string | null;
  in_reply_to_message_ref: string | null;
}

export interface ArchiveResultEnvelope {
  schema_version: "1";
  command: "archive";
  account: string;
  message_ref: string;
  thread_ref: string;
  source: SourceInfo;
  status: "archived";
}

export interface RsvpResultEnvelope {
  schema_version: "1";
  command: "rsvp";
  account: string;
  message_ref: string;
  thread_ref: string;
  source: SourceInfo;
  response: RsvpResponse;
  invite: MessageInvite | null;
}

export interface ProviderLocator {
  kind: "thread" | "message" | "attachment";
  locator: Record<string, string | number | boolean | null>;
}

export interface NormalizedAttachmentRecord extends AttachmentMeta {
  locator?: ProviderLocator;
}

export interface NormalizedMessageRecord extends Omit<MessageResult, "attachments"> {
  provider_ids?: {
    message_id?: string;
    internet_message_id?: string;
  };
  locator?: ProviderLocator;
  attachments: NormalizedAttachmentRecord[];
}

export interface NormalizedThreadRecord extends Omit<ThreadResult, "messages"> {
  provider_ids?: {
    thread_id?: string;
  };
  locator?: ProviderLocator;
  messages: NormalizedMessageRecord[];
}
