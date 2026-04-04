import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MailAccount } from "../../contracts/account.js";
import type {
  ArchiveResultEnvelope,
  AttachmentDownloadEnvelope,
  AttachmentListEnvelope,
  FetchUnreadQuery,
  ForwardInput,
  MarkMessagesResultEnvelope,
  MessageEnvelope,
  MessageInvite,
  MessageParticipant,
  NormalizedAttachmentRecord,
  NormalizedMessageRecord,
  NormalizedThreadRecord,
  ReadResultEnvelope,
  ReplyInput,
  RsvpResponse,
  RsvpResultEnvelope,
  SearchQuery,
  SendMessageInput,
  SendResultEnvelope,
  ThreadParticipant,
} from "../../contracts/mail.js";
import { SurfaceError, notImplemented } from "../../lib/errors.js";
import { makeAttachmentId, makeMessageRef, makeThreadRef } from "../../refs.js";
import { summarizeThread } from "../../summarizer.js";
import type { StoredMessageRecord } from "../../state/database.js";
import type { AuthStatus, MailProviderAdapter, ProviderContext } from "../types.js";
import { downloadGmailAttachmentBytes, getGmailThread, listGmailThreads, type GmailThreadRecord } from "./api.js";
import { clearGmailAuthState, gmailAuthStatus, runGmailLogin } from "./oauth.js";
import {
  decodeBase64UrlBytes,
  decodePartData,
  extractMessageBodies,
  headerDateToIso,
  headerIndex,
  internalDateToIso,
  isCalendarPart,
  iterParts,
  normalizeGmailBody,
  parseCalendarInvite,
  parseMailbox,
  parseMailboxes,
  type GmailMessagePayload,
  type GmailPart,
} from "./normalize.js";

function sourceInfo(account: MailAccount) {
  return {
    provider: account.provider,
    transport: account.transport,
  } as const;
}

function gmailThreadProviderKey(threadId: string): string {
  return `gmail-thread:${threadId}`;
}

function gmailMessageProviderKey(messageId: string): string {
  return `gmail-message:${messageId}`;
}

function gmailAttachmentProviderKey(
  messageId: string,
  attachment: NormalizedAttachmentRecord,
  index: number,
): string {
  const attachmentId = attachment.locator?.locator.attachment_id;
  return typeof attachmentId === "string" && attachmentId
    ? `gmail-attachment:${messageId}:${attachmentId}`
    : `gmail-attachment:${messageId}:${attachment.filename}:${index}`;
}

function uniqueParticipants(messages: MessageEnvelope[]): ThreadParticipant[] {
  const seen = new Set<string>();
  const participants: ThreadParticipant[] = [];

  const push = (role: ThreadParticipant["role"], mailbox: MessageParticipant | null | undefined) => {
    if (!mailbox || (!mailbox.email && !mailbox.name)) {
      return;
    }
    const key = `${role}:${mailbox.email}:${mailbox.name}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    participants.push({
      role,
      name: mailbox.name,
      email: mailbox.email,
    });
  };

  for (const message of messages) {
    push("from", message.from);
    for (const mailbox of message.to) {
      push("to", mailbox);
    }
    for (const mailbox of message.cc) {
      push("cc", mailbox);
    }
  }

  return participants;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function gmailMailbox(labels: string[]): string {
  if (labels.includes("DRAFT")) {
    return "drafts";
  }
  if (labels.includes("SENT")) {
    return "sent";
  }
  if (labels.includes("TRASH")) {
    return "trash";
  }
  if (labels.includes("SPAM")) {
    return "spam";
  }
  if (labels.includes("INBOX")) {
    return "inbox";
  }
  return "archive";
}

function partSizeBytes(part: GmailPart): number | null {
  if (typeof part.body?.size === "number") {
    return part.body.size;
  }
  if (part.body?.data) {
    return decodeBase64UrlBytes(part.body.data).byteLength;
  }
  return null;
}

function extractAttachmentRecords(message: GmailMessagePayload): NormalizedAttachmentRecord[] {
  const messageId = message.id ?? "";
  const attachments: NormalizedAttachmentRecord[] = [];
  let index = 0;
  for (const part of iterParts(message.payload)) {
    if (!(part.filename ?? "").trim()) {
      continue;
    }

    const attachmentId = part.body?.attachmentId;
    const inlineData = part.body?.data;
    attachments.push({
      attachment_id: "",
      filename: part.filename ?? `attachment-${index + 1}`,
      mime_type: part.mimeType ?? "application/octet-stream",
      size_bytes: partSizeBytes(part),
      inline: Boolean(part.headers && headerIndex(part.headers)["content-disposition"]?.toLowerCase().includes("inline")),
      locator: {
        kind: "attachment",
        locator: {
          message_id: messageId,
          attachment_id: attachmentId ?? null,
          part_id: part.partId ?? null,
          inline_data: inlineData ?? null,
          filename: part.filename ?? null,
        },
      },
    });
    index += 1;
  }
  return attachments;
}

async function extractCalendarText(
  account: MailAccount,
  context: ProviderContext,
  message: GmailMessagePayload,
): Promise<string> {
  const messageId = message.id ?? "";
  if (!messageId) {
    return "";
  }

  for (const part of iterParts(message.payload)) {
    if (!isCalendarPart(part)) {
      continue;
    }

    if (part.body?.data) {
      return decodePartData(part);
    }

    if (part.body?.attachmentId) {
      const payload = await downloadGmailAttachmentBytes(account, context, messageId, part.body.attachmentId);
      if (payload.data) {
        return Buffer.from(decodeBase64UrlBytes(payload.data)).toString("utf8");
      }
    }
  }

  return "";
}

function mapCalendarPartstat(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.toUpperCase() : "";
  switch (normalized) {
    case "ACCEPTED":
      return "accept";
    case "DECLINED":
      return "decline";
    case "TENTATIVE":
      return "tentative";
    case "NEEDS-ACTION":
      return "needs_response";
    default:
      return null;
  }
}

async function normalizeGmailMessage(
  account: MailAccount,
  context: ProviderContext,
  message: GmailMessagePayload,
): Promise<NormalizedMessageRecord> {
  const indexedHeaders = headerIndex(message.payload?.headers);
  const subject = indexedHeaders.subject ?? "";
  const from = parseMailbox(indexedHeaders.from);
  const to = parseMailboxes(indexedHeaders.to);
  const cc = parseMailboxes(indexedHeaders.cc);
  const sentAt = headerDateToIso(indexedHeaders.date) ?? internalDateToIso(message.internalDate);
  const receivedAt = internalDateToIso(message.internalDate) ?? headerDateToIso(indexedHeaders.date);
  const unread = (message.labelIds ?? []).includes("UNREAD");
  const body = normalizeGmailBody(message.payload, message.snippet ?? "");
  const attachments = extractAttachmentRecords(message);

  let invite: MessageInvite | undefined;
  const calendarText = await extractCalendarText(account, context, message);
  if (calendarText) {
    const parsedInvite = parseCalendarInvite(calendarText, {
      mailboxEmail: account.email,
      recipientEmails: [...to, ...cc].map((mailbox) => mailbox.email),
    });
    if (parsedInvite.meeting) {
      invite = {
        is_invite: true,
        rsvp_supported: false,
        response_status: mapCalendarPartstat(parsedInvite.meeting.response_type),
        available_rsvp_responses: [],
      };
    }
  }

  return {
    message_ref: "",
    envelope: {
      from,
      to,
      cc,
      sent_at: sentAt,
      received_at: receivedAt,
      unread,
      ...(subject ? { subject } : {}),
    },
    snippet: message.snippet ?? body.text.slice(0, 240),
    body: {
      text: body.text,
      truncated: false,
      cached: true,
      cached_bytes: Buffer.byteLength(body.text, "utf8"),
    },
    attachments,
    ...(invite ? { invite } : {}),
    provider_ids: {
      ...(message.id ? { message_id: message.id } : {}),
      ...(indexedHeaders["message-id"] ? { internet_message_id: indexedHeaders["message-id"] } : {}),
    },
    locator: {
      kind: "message",
      locator: {
        thread_id: message.threadId ?? null,
        message_id: message.id ?? null,
      },
    },
  };
}

async function normalizeGmailThread(
  account: MailAccount,
  context: ProviderContext,
  thread: GmailThreadRecord,
): Promise<NormalizedThreadRecord> {
  const normalizedMessages = await Promise.all((thread.messages ?? []).map((message) => normalizeGmailMessage(account, context, message)));
  const messages = normalizedMessages
    .slice()
    .sort((left, right) => Date.parse(right.envelope.received_at ?? right.envelope.sent_at ?? "") - Date.parse(left.envelope.received_at ?? left.envelope.sent_at ?? ""));

  const latestMessage = messages[0] ?? null;
  const unreadCount = messages.filter((message) => message.envelope.unread).length;
  const labels = [...new Set((thread.messages?.flatMap((message) => message.labelIds ?? []) ?? []).map(normalizeLabel))];

  return {
    thread_ref: "",
    source: sourceInfo(account),
    envelope: {
      subject: latestMessage?.envelope.subject ?? "",
      participants: uniqueParticipants(messages.map((message) => message.envelope)),
      mailbox: gmailMailbox(thread.messages?.[0]?.labelIds ?? []),
      labels,
      received_at: latestMessage?.envelope.received_at ?? null,
      message_count: messages.length,
      unread_count: unreadCount,
      has_attachments: messages.some((message) => message.attachments.length > 0),
    },
    summary: null,
    messages,
    provider_ids: {
      ...(thread.id ? { thread_id: thread.id } : {}),
    },
    locator: {
      kind: "thread",
      locator: {
        thread_id: thread.id ?? null,
      },
    },
  };
}

function parseStoredMessage(record: StoredMessageRecord) {
  const envelope: MessageEnvelope = {
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
  };

  return {
    envelope,
    body: {
      text: record.body_cache_path && existsSync(record.body_cache_path) ? readFileSync(record.body_cache_path, "utf8") : "",
      truncated: Boolean(record.body_truncated),
      cached: Boolean(record.body_cached),
      cached_bytes: record.body_cached_bytes,
    },
    invite: record.invite_json ? JSON.parse(record.invite_json) as MessageInvite : undefined,
  };
}

function buildReadEnvelope(
  account: MailAccount,
  messageRef: string,
  threadRef: string,
  parsed: ReturnType<typeof parseStoredMessage>,
  attachments: AttachmentListEnvelope["attachments"],
  cacheStatus: ReadResultEnvelope["cache"]["status"],
): ReadResultEnvelope {
  return {
    schema_version: "1",
    command: "read",
    account: account.name,
    message_ref: messageRef,
    thread_ref: threadRef,
    source: sourceInfo(account),
    cache: {
      status: cacheStatus,
      truncated: parsed.body.truncated,
    },
    message: {
      envelope: parsed.envelope,
      body: parsed.body,
      attachments,
      ...(parsed.invite ? { invite: parsed.invite } : {}),
    },
  };
}

async function maybeSummarizeThreads(
  threads: NormalizedThreadRecord[],
  context: ProviderContext,
): Promise<NormalizedThreadRecord[]> {
  if (context.config.summarizerBackend === "none") {
    return threads;
  }

  const summarized: NormalizedThreadRecord[] = [];
  for (const thread of threads) {
    summarized.push({
      ...thread,
      summary: await summarizeThread(thread, context.config),
    });
  }
  return summarized;
}

async function persistThreads(
  account: MailAccount,
  context: ProviderContext,
  threads: NormalizedThreadRecord[],
): Promise<NormalizedThreadRecord[]> {
  return context.db.transaction(() => {
    const persistedThreads: NormalizedThreadRecord[] = [];

    for (const thread of threads) {
      const threadId = thread.provider_ids?.thread_id;
      if (!threadId) {
        throw new SurfaceError("transport_error", "Gmail thread is missing a thread id.", {
          account: account.name,
        });
      }

      const resolvedThreadRef =
        context.db.findEntityRefByProviderKey("thread", account.account_id, gmailThreadProviderKey(threadId))
        ?? makeThreadRef();

      context.db.upsertThread({
        thread_ref: resolvedThreadRef,
        account_id: account.account_id,
        subject: thread.envelope.subject,
        participants: thread.envelope.participants,
        mailbox: thread.envelope.mailbox,
        labels: thread.envelope.labels,
        received_at: thread.envelope.received_at,
        message_count: thread.envelope.message_count,
        unread_count: thread.envelope.unread_count,
        has_attachments: thread.envelope.has_attachments,
      });
      context.db.upsertProviderLocator({
        entity_kind: "thread",
        entity_ref: resolvedThreadRef,
        account_id: account.account_id,
        provider_key: gmailThreadProviderKey(threadId),
        locator_json: JSON.stringify(thread.locator?.locator ?? { thread_id: threadId }),
      });

      const persistedMessages: NormalizedMessageRecord[] = [];
      const messageRefs: string[] = [];
      for (const message of thread.messages) {
        const messageId = message.provider_ids?.message_id;
        if (!messageId) {
          throw new SurfaceError("transport_error", "Gmail message is missing a message id.", {
            account: account.name,
            threadRef: resolvedThreadRef,
          });
        }

        const resolvedMessageRef =
          context.db.findEntityRefByProviderKey("message", account.account_id, gmailMessageProviderKey(messageId))
          ?? makeMessageRef();

        const messageDir = join(context.accountPaths.messagesDir, resolvedMessageRef);
        mkdirSync(messageDir, { recursive: true });
        const bodyCachePath = join(messageDir, "body.txt");
        writeFileSync(bodyCachePath, message.body.text, "utf8");

        context.db.upsertMessage({
          message_ref: resolvedMessageRef,
          account_id: account.account_id,
          thread_ref: resolvedThreadRef,
          subject: message.envelope.subject ?? thread.envelope.subject,
          from_name: message.envelope.from?.name ?? null,
          from_email: message.envelope.from?.email ?? null,
          to_json: JSON.stringify(message.envelope.to),
          cc_json: JSON.stringify(message.envelope.cc),
          sent_at: message.envelope.sent_at,
          received_at: message.envelope.received_at,
          unread: message.envelope.unread,
          snippet: message.snippet,
          body_cache_path: bodyCachePath,
          body_cached: true,
          body_truncated: message.body.truncated,
          body_cached_bytes: Buffer.byteLength(message.body.text, "utf8"),
          invite_json: message.invite ? JSON.stringify(message.invite) : null,
        });
        context.db.upsertProviderLocator({
          entity_kind: "message",
          entity_ref: resolvedMessageRef,
          account_id: account.account_id,
          provider_key: gmailMessageProviderKey(messageId),
          locator_json: JSON.stringify(
            message.locator?.locator ?? {
              thread_id: threadId,
              message_id: messageId,
            },
          ),
        });

        const persistedAttachments: NormalizedAttachmentRecord[] = [];
        for (const [index, attachment] of message.attachments.entries()) {
          const providerKey = gmailAttachmentProviderKey(messageId, attachment, index);
          const resolvedAttachmentId =
            context.db.findEntityRefByProviderKey("attachment", account.account_id, providerKey) ?? makeAttachmentId();
          context.db.upsertProviderLocator({
            entity_kind: "attachment",
            entity_ref: resolvedAttachmentId,
            account_id: account.account_id,
            provider_key: providerKey,
            locator_json: JSON.stringify(attachment.locator?.locator ?? {}),
          });
          persistedAttachments.push({
            ...attachment,
            attachment_id: resolvedAttachmentId,
          });
        }

        context.db.replaceAttachments(
          resolvedMessageRef,
          persistedAttachments.map((attachment) => ({
            attachment_id: attachment.attachment_id,
            filename: attachment.filename,
            mime_type: attachment.mime_type,
            size_bytes: attachment.size_bytes,
            inline: attachment.inline,
            saved_to: null,
          })),
        );

        persistedMessages.push({
          ...message,
          message_ref: resolvedMessageRef,
          body: {
            ...message.body,
            cached: true,
            cached_bytes: Buffer.byteLength(message.body.text, "utf8"),
          },
          attachments: persistedAttachments,
        });
        messageRefs.push(resolvedMessageRef);
      }

      context.db.replaceThreadMessages(resolvedThreadRef, messageRefs);
      if (thread.summary) {
        context.db.upsertSummary(resolvedThreadRef, thread.summary);
      }

      persistedThreads.push({
        ...thread,
        thread_ref: resolvedThreadRef,
        messages: persistedMessages,
      });
    }

    return persistedThreads;
  });
}

async function fetchAndPersistGmailThread(
  account: MailAccount,
  context: ProviderContext,
  threadId: string,
): Promise<void> {
  const thread = await getGmailThread(account, context, threadId);
  const normalized = await normalizeGmailThread(account, context, thread);
  const withSummary = (await maybeSummarizeThreads([normalized], context))[0]!;
  await persistThreads(account, context, [withSummary]);
}

async function refreshStoredMessage(
  account: MailAccount,
  messageRef: string,
  context: ProviderContext,
): Promise<StoredMessageRecord> {
  const locatorRow = context.db.findProviderLocator("message", messageRef);
  if (!locatorRow) {
    throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
      account: account.name,
      messageRef,
    });
  }

  const locator = JSON.parse(locatorRow.locator_json) as { thread_id?: string | null };
  if (!locator.thread_id) {
    throw new SurfaceError("transport_error", `Message '${messageRef}' is missing a Gmail thread id.`, {
      account: account.name,
      messageRef,
    });
  }

  await fetchAndPersistGmailThread(account, context, locator.thread_id);
  const refreshed = context.db.getStoredMessage(messageRef);
  if (!refreshed) {
    throw new SurfaceError("not_found", `Message '${messageRef}' could not be refreshed from Gmail.`, {
      account: account.name,
      messageRef,
    });
  }
  return refreshed;
}

async function fetchGmailThreads(
  account: MailAccount,
  context: ProviderContext,
  options: { kind: "search" | "fetch-unread"; queryText?: string; limit: number },
): Promise<NormalizedThreadRecord[]> {
  const queryParts: string[] = [];
  if (options.kind === "fetch-unread") {
    queryParts.push("is:unread");
  }
  if (options.queryText) {
    queryParts.push(options.queryText);
  }

  const threadStubs = await listGmailThreads(account, context, {
    maxResults: options.limit,
    ...(queryParts.length > 0 ? { q: queryParts.join(" ").trim() } : {}),
  });

  if (threadStubs.length === 0) {
    return [];
  }

  const hydrated = await Promise.all(
    threadStubs
      .map((thread) => thread.id)
      .filter((threadId): threadId is string => Boolean(threadId))
      .map((threadId) => getGmailThread(account, context, threadId)),
  );

  const normalized = await Promise.all(hydrated.map((thread) => normalizeGmailThread(account, context, thread)));
  const summarized = await maybeSummarizeThreads(normalized, context);
  return persistThreads(account, context, summarized);
}

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

  async search(account: MailAccount, query: SearchQuery, context: ProviderContext): Promise<NormalizedThreadRecord[]> {
    return fetchGmailThreads(account, context, {
      kind: "search",
      queryText: query.text,
      limit: query.limit,
    });
  }

  async fetchUnread(
    account: MailAccount,
    query: FetchUnreadQuery,
    context: ProviderContext,
  ): Promise<NormalizedThreadRecord[]> {
    return fetchGmailThreads(account, context, {
      kind: "fetch-unread",
      limit: query.limit,
    });
  }

  async readMessage(
    account: MailAccount,
    messageRef: string,
    refresh: boolean,
    context: ProviderContext,
  ): Promise<ReadResultEnvelope> {
    const stored = context.db.getStoredMessage(messageRef);
    if (!stored) {
      throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
        account: account.name,
        messageRef,
      });
    }

    const attachments = context.db.listAttachmentsForMessage(messageRef).map((attachment) => ({
      attachment_id: attachment.attachment_id,
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      inline: Boolean(attachment.inline),
    }));

    const hasReadableCache = Boolean(stored.body_cache_path && existsSync(stored.body_cache_path));
    if (!refresh && hasReadableCache) {
      return buildReadEnvelope(account, messageRef, stored.thread_ref, parseStoredMessage(stored), attachments, "hit");
    }

    const refreshed = await refreshStoredMessage(account, messageRef, context);
    const refreshedAttachments = context.db.listAttachmentsForMessage(messageRef).map((attachment) => ({
      attachment_id: attachment.attachment_id,
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      inline: Boolean(attachment.inline),
    }));
    return buildReadEnvelope(
      account,
      messageRef,
      refreshed.thread_ref,
      parseStoredMessage(refreshed),
      refreshedAttachments,
      "refreshed",
    );
  }

  async listAttachments(
    account: MailAccount,
    messageRef: string,
    context: ProviderContext,
  ): Promise<AttachmentListEnvelope> {
    const message = context.db.findMessageByRef(messageRef);
    if (!message) {
      throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
        account: account.name,
        messageRef,
      });
    }

    return {
      schema_version: "1",
      command: "attachment-list",
      account: account.name,
      message_ref: messageRef,
      attachments: context.db.listAttachmentsForMessage(messageRef).map((attachment) => ({
        attachment_id: attachment.attachment_id,
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        inline: Boolean(attachment.inline),
      })),
    };
  }

  async downloadAttachment(
    account: MailAccount,
    messageRef: string,
    attachmentId: string,
    context: ProviderContext,
  ): Promise<AttachmentDownloadEnvelope> {
    const storedMessage = context.db.findMessageByRef(messageRef);
    if (!storedMessage) {
      throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
        account: account.name,
        messageRef,
      });
    }

    const attachment = context.db.listAttachmentsForMessage(messageRef).find((entry) => entry.attachment_id === attachmentId);
    if (!attachment) {
      throw new SurfaceError("not_found", `Attachment '${attachmentId}' was not found for message '${messageRef}'.`, {
        account: account.name,
        messageRef,
      });
    }

    let locatorRow = context.db.findProviderLocator("attachment", attachmentId);
    if (!locatorRow) {
      await refreshStoredMessage(account, messageRef, context);
      locatorRow = context.db.findProviderLocator("attachment", attachmentId);
    }
    if (!locatorRow) {
      throw new SurfaceError("cache_miss", `No provider locator exists for attachment '${attachmentId}'.`, {
        account: account.name,
        messageRef,
      });
    }

    const locator = JSON.parse(locatorRow.locator_json) as {
      message_id?: string | null;
      attachment_id?: string | null;
      inline_data?: string | null;
    };

    let bytes: Buffer | null = null;
    if (locator.inline_data) {
      bytes = decodeBase64UrlBytes(locator.inline_data);
    } else if (locator.message_id && locator.attachment_id) {
      const payload = await downloadGmailAttachmentBytes(account, context, locator.message_id, locator.attachment_id);
      if (!payload.data) {
        throw new SurfaceError("transport_error", `Gmail attachment '${attachmentId}' returned no data.`, {
          account: account.name,
          messageRef,
        });
      }
      bytes = decodeBase64UrlBytes(payload.data);
    }

    if (!bytes) {
      throw new SurfaceError("unsupported", `Attachment '${attachmentId}' does not expose downloadable Gmail bytes.`, {
        account: account.name,
        messageRef,
      });
    }

    const targetDir = join(context.accountPaths.downloadsDir, messageRef);
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${attachmentId}__${attachment.filename}`);
    writeFileSync(targetPath, bytes);
    context.db.updateAttachmentSavedTo(attachmentId, targetPath);

    return {
      schema_version: "1",
      command: "attachment-download",
      account: account.name,
      message_ref: messageRef,
      attachment: {
        attachment_id: attachmentId,
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        inline: Boolean(attachment.inline),
        saved_to: targetPath,
      },
    };
  }

  async rsvp(account: MailAccount, _messageRef: string, _response: RsvpResponse): Promise<RsvpResultEnvelope> {
    notImplemented("Gmail RSVP is deferred pending explicit Google Calendar integration.", account.name);
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
}
