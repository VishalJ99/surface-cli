import type {
  AttachmentMeta,
  MessageResult,
  NormalizedAttachmentRecord,
  NormalizedMessageRecord,
  NormalizedThreadRecord,
  ThreadResult,
} from "../contracts/mail.js";

function toPublicAttachment(attachment: NormalizedAttachmentRecord): AttachmentMeta {
  return {
    attachment_id: attachment.attachment_id,
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
    inline: attachment.inline,
  };
}

function toPublicMessage(message: NormalizedMessageRecord): MessageResult {
  return {
    message_ref: message.message_ref,
    envelope: message.envelope,
    snippet: message.snippet,
    body: message.body,
    attachments: message.attachments.map(toPublicAttachment),
    ...(message.invite ? { invite: message.invite } : {}),
  };
}

export function toPublicThread(thread: NormalizedThreadRecord): ThreadResult {
  return {
    thread_ref: thread.thread_ref,
    source: thread.source,
    envelope: thread.envelope,
    summary: thread.summary,
    messages: thread.messages.map(toPublicMessage),
  };
}
