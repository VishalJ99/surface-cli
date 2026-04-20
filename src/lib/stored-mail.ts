import { existsSync, readFileSync } from "node:fs";

import type { MailAccount } from "../contracts/account.js";
import type {
  AttachmentMeta,
  MessageInvite,
  MessageParticipant,
  MessageResult,
  ThreadParticipant,
  ThreadResult,
} from "../contracts/mail.js";
import type { StoredMessageRecord, SurfaceDatabase } from "../state/database.js";

function storedAttachments(
  db: SurfaceDatabase,
  messageRef: string,
): AttachmentMeta[] {
  return db.listAttachmentsForMessage(messageRef).map((attachment) => ({
    attachment_id: attachment.attachment_id,
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
    inline: Boolean(attachment.inline),
  }));
}

function storedMessage(record: StoredMessageRecord, attachments: AttachmentMeta[]): MessageResult {
  const hasReadableCache = Boolean(record.body_cache_path && existsSync(record.body_cache_path));

  return {
    message_ref: record.message_ref,
    envelope: {
      from:
        record.from_name || record.from_email
          ? {
              name: record.from_name ?? "",
              email: record.from_email ?? "",
            }
          : null,
      to: JSON.parse(record.to_json) as MessageParticipant[],
      cc: JSON.parse(record.cc_json) as MessageParticipant[],
      sent_at: record.sent_at,
      received_at: record.received_at,
      unread: Boolean(record.unread),
      ...(record.subject ? { subject: record.subject } : {}),
    },
    snippet: record.snippet,
    body: {
      text: hasReadableCache && record.body_cache_path ? readFileSync(record.body_cache_path, "utf8") : "",
      truncated: Boolean(record.body_truncated),
      cached: hasReadableCache && Boolean(record.body_cached),
      cached_bytes: record.body_cached_bytes,
    },
    attachments,
    ...(record.invite_json ? { invite: JSON.parse(record.invite_json) as MessageInvite } : {}),
  };
}

export function threadHasReadableCache(db: SurfaceDatabase, threadRef: string): boolean {
  const messages = db.listStoredMessagesForThread(threadRef);
  return messages.length > 0 && messages.every((message) => Boolean(message.body_cache_path && existsSync(message.body_cache_path)));
}

export function loadStoredThread(
  db: SurfaceDatabase,
  account: MailAccount,
  threadRef: string,
): ThreadResult | null {
  const thread = db.getStoredThread(threadRef);
  if (!thread) {
    return null;
  }

  return {
    thread_ref: thread.thread_ref,
    source: {
      provider: account.provider,
      transport: account.transport,
    },
    envelope: {
      subject: thread.subject ?? "",
      participants: JSON.parse(thread.participants_json) as ThreadParticipant[],
      mailbox: thread.mailbox ?? "inbox",
      labels: JSON.parse(thread.labels_json) as string[],
      received_at: thread.received_at,
      message_count: thread.message_count,
      unread_count: thread.unread_count,
      has_attachments: Boolean(thread.has_attachments),
    },
    summary: db.findSummary(threadRef),
    messages: db.listStoredMessagesForThread(threadRef).map((message) =>
      storedMessage(message, storedAttachments(db, message.message_ref))),
  };
}
