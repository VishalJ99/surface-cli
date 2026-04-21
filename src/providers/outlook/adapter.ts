import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright-core";

import type { MailAccount } from "../../contracts/account.js";
import type {
  ArchiveResultEnvelope,
  AttachmentDownloadEnvelope,
  AttachmentListEnvelope,
  ComposeRecipients,
  ForwardInput,
  MarkMessagesResultEnvelope,
  MessageEnvelope,
  MessageInvite,
  MessageParticipant,
  NormalizedAttachmentRecord,
  NormalizedMessageRecord,
  FetchUnreadQuery,
  NormalizedThreadRecord,
  ReadResultEnvelope,
  ReplyInput,
  RsvpResponse,
  RsvpResultEnvelope,
  SendMessageInput,
  SendResultEnvelope,
  SearchQuery,
  ThreadParticipant,
} from "../../contracts/mail.js";
import { SurfaceError } from "../../lib/errors.js";
import { assertWriteAllowed, collectWriteRecipients } from "../../lib/write-safety.js";
import { makeAttachmentId, makeMessageRef, makeThreadRef } from "../../refs.js";
import { summarizeAndPersistThreads } from "../../summarizer.js";
import type { AuthStatus, MailProviderAdapter, ProviderContext } from "../types.js";
import { annotateBodyWithInlineAttachments } from "../shared/inline-attachments.js";
import { launchOutlookSession, probeOutlookAuth, promptForOutlookLogin, type OutlookSession } from "./session.js";
import {
  applySearchQuery,
  applyUnreadFilter,
  captureOutlookServiceSession,
  collectCurrentConversationIds,
  collectSearchConversationIds,
  collectUnreadConversationIds,
  fetchConversationBundle,
  waitForOutlookMailboxReady,
  type OutlookConversationItem,
  type OutlookThreadBundle,
} from "./extract.js";
import {
  buildOutlookInvite,
  itemIdData,
  mailboxFromExchange,
  mailboxesFromExchange,
  messageIdentity,
  normalizeOutlookBody,
} from "./normalize.js";
import type { StoredMessageRecord } from "../../state/database.js";

function outlookProfileDir(context: ProviderContext): string {
  return join(context.accountPaths.authDir, "profile");
}

async function withManagedOutlookSession<T>(
  context: ProviderContext,
  browserSession: OutlookSession | undefined,
  work: (session: OutlookSession) => Promise<T>,
): Promise<T> {
  if (browserSession) {
    return work(browserSession);
  }

  const profileDir = outlookProfileDir(context);
  if (!existsSync(profileDir)) {
    throw new SurfaceError("reauth_required", "Outlook profile directory is missing for this account.", {
      account: null,
    });
  }

  const session = await launchOutlookSession(profileDir, { headless: true });
  try {
    return await work(session);
  } finally {
    await session.context.close();
    session.cleanup?.();
  }
}

function threadProviderKey(conversationId: string): string {
  return `outlook-thread:${conversationId}`;
}

function messageProviderKey(entry: OutlookConversationItem, conversationId: string): string {
  return `outlook-message:${messageIdentity(entry.item, conversationId)}`;
}

function attachmentProviderKey(
  messageKey: string,
  attachment: NormalizedAttachmentRecord,
  index: number,
): string {
  const locatorAttachmentId = attachment.locator?.locator.attachment_id;
  return typeof locatorAttachmentId === "string" && locatorAttachmentId
    ? `outlook-attachment:${locatorAttachmentId}`
    : `${messageKey}:attachment:${index}:${attachment.filename}:${attachment.size_bytes ?? ""}`;
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

function quoteOutlookSearchValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return '""';
  }
  return /[\s"]/u.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

function buildOutlookSearchQuery(query: SearchQuery): string | undefined {
  const parts: string[] = [];
  if (query.text?.trim()) {
    parts.push(query.text.trim());
  }
  if (query.from?.trim()) {
    parts.push(`from:${quoteOutlookSearchValue(query.from)}`);
  }
  if (query.subject?.trim()) {
    parts.push(`subject:${quoteOutlookSearchValue(query.subject)}`);
  }
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

function threadMatchesStructuredFilters(thread: NormalizedThreadRecord, query: SearchQuery): boolean {
  if (query.mailbox?.trim() && thread.envelope.mailbox.trim().toLowerCase() !== query.mailbox.trim().toLowerCase()) {
    return false;
  }

  if ((query.labels?.length ?? 0) > 0) {
    const available = new Set(thread.envelope.labels.map((label) => label.trim().toLowerCase()));
    if ((query.labels ?? []).some((label) => !available.has(label.trim().toLowerCase()))) {
      return false;
    }
  }

  return true;
}

function inferThreadRsvpStatus(messages: NormalizedMessageRecord[]): string | null {
  let latest: { status: string; at: number } | null = null;

  for (const message of messages) {
    const subject = (message.envelope.subject ?? "").toLowerCase();
    const timestamp = Date.parse(message.envelope.received_at ?? message.envelope.sent_at ?? "");
    const at = Number.isFinite(timestamp) ? timestamp : 0;

    if (subject.startsWith("accepted:")) {
      if (!latest || at >= latest.at) {
        latest = { status: "accept", at };
      }
    }
    if (subject.startsWith("declined:")) {
      if (!latest || at >= latest.at) {
        latest = { status: "decline", at };
      }
    }
    if (subject.startsWith("tentative:")) {
      if (!latest || at >= latest.at) {
        latest = { status: "tentative", at };
      }
    }
  }

  return latest?.status ?? null;
}

function buildAttachments(entry: OutlookConversationItem, messageKey: string): NormalizedAttachmentRecord[] {
  const rawItem = entry.item;
  const rawAttachments = Array.isArray(rawItem.Attachments)
    ? rawItem.Attachments as Array<Record<string, unknown>>
    : [];

  return rawAttachments.map((attachment, index) => {
    const filename = typeof attachment.Name === "string" ? attachment.Name : `attachment-${index + 1}`;
    const attachmentId =
      typeof (attachment.AttachmentId as Record<string, unknown> | undefined)?.Id === "string"
        ? (attachment.AttachmentId as Record<string, unknown>).Id as string
        : "";

    return {
      attachment_id: "",
      filename,
      mime_type: typeof attachment.ContentType === "string" ? attachment.ContentType : "application/octet-stream",
      size_bytes: typeof attachment.Size === "number" ? attachment.Size : null,
      inline: Boolean(attachment.IsInline),
      locator: {
        kind: "attachment",
        locator: {
          attachment_id: attachmentId || null,
          filename,
          index,
          message_key: messageKey,
        },
      },
    };
  });
}

function normalizeMessage(
  entry: OutlookConversationItem,
  conversationId: string,
): NormalizedMessageRecord {
  const item = entry.item;
  const invite = buildOutlookInvite(item);
  const from = mailboxFromExchange((item.From as Record<string, unknown> | undefined) ?? null)
    ?? mailboxFromExchange((item.Sender as Record<string, unknown> | undefined) ?? null);
  const to = mailboxesFromExchange(item.ToRecipients as Array<Record<string, unknown>> | undefined);
  const cc = mailboxesFromExchange(item.CcRecipients as Array<Record<string, unknown>> | undefined);
  const itemId = itemIdData((item.ItemId as Record<string, unknown> | undefined) ?? null);
  const messageId = itemId?.id;
  const messageChangeKey = itemId?.change_key;
  const internetMessageId = typeof item.InternetMessageId === "string" ? item.InternetMessageId : undefined;
  const instanceKey = typeof item.InstanceKey === "string" ? item.InstanceKey : undefined;
  const key = messageProviderKey(entry, conversationId);
  const attachments = buildAttachments(entry, key);
  const body = normalizeOutlookBody(item);
  const bodyText = annotateBodyWithInlineAttachments(body.text, attachments);
  const envelope: MessageEnvelope = {
    from,
    to,
    cc,
    sent_at: typeof item.DateTimeSent === "string" ? item.DateTimeSent : null,
    received_at:
      typeof item.DateTimeReceived === "string"
        ? item.DateTimeReceived
        : typeof item.ReceivedOrRenewTime === "string"
          ? item.ReceivedOrRenewTime
          : null,
    unread: item.IsRead === true ? false : true,
    ...(typeof item.Subject === "string" ? { subject: item.Subject } : {}),
  };
  const providerIds = {
    ...(messageId ? { message_id: messageId } : {}),
    ...(internetMessageId ? { internet_message_id: internetMessageId } : {}),
  };
  const associatedCalendarItem = invite.meeting?.associated_calendar_item ?? null;

  return {
    message_ref: "",
    envelope,
    snippet: typeof item.Preview === "string" ? item.Preview : bodyText.slice(0, 240),
    body: {
      text: bodyText,
      truncated: false,
      cached: true,
      cached_bytes: Buffer.byteLength(bodyText, "utf8"),
    },
    attachments,
    ...(invite.is_invite
      ? {
          invite: {
            is_invite: invite.is_invite,
            rsvp_supported: invite.rsvp_supported,
            response_status: invite.response_status,
            available_rsvp_responses: invite.available_rsvp_responses,
          },
        }
      : {}),
    ...(Object.keys(providerIds).length > 0 ? { provider_ids: providerIds } : {}),
    locator: {
      kind: "message",
      locator: {
        conversation_id: conversationId,
        message_id: messageId ?? null,
        message_change_key: messageChangeKey ?? null,
        internet_message_id: internetMessageId ?? null,
        instance_key: instanceKey ?? null,
        parent_internet_message_id: entry.nodeMetadata.parentInternetMessageId,
        associated_calendar_item_id: associatedCalendarItem?.id ?? null,
        associated_calendar_change_key: associatedCalendarItem?.change_key ?? null,
        meeting_start: typeof invite.meeting?.start === "string" ? invite.meeting.start : null,
        meeting_end: typeof invite.meeting?.end === "string" ? invite.meeting.end : null,
      },
    },
  };
}

function normalizeThread(bundle: OutlookThreadBundle): NormalizedThreadRecord {
  const baseMessages = bundle.entries.map((entry) => normalizeMessage(entry, bundle.conversationId));
  const inferredRsvpStatus = inferThreadRsvpStatus(baseMessages);
  const messages = inferredRsvpStatus
    ? baseMessages.map((message) =>
        message.invite
          ? {
              ...message,
              invite: {
                ...message.invite,
                response_status: inferredRsvpStatus,
              },
            }
          : message)
    : baseMessages;
  const latestMessage = messages[0] ?? null;
  const unreadCount = messages.filter((message) => message.envelope.unread).length;
  const hasAttachments = messages.some((message) => message.attachments.length > 0)
    || bundle.entries.some((entry) => entry.item.HasAttachments === true);
  const labels = unreadCount > 0 ? ["inbox", "unread"] : ["inbox"];

  return {
    thread_ref: "",
    source: {
      provider: "outlook",
      transport: "outlook-web-playwright",
    },
    envelope: {
      subject: latestMessage?.envelope.subject ?? "",
      participants: uniqueParticipants(messages.map((message) => message.envelope)),
      mailbox: "inbox",
      labels,
      received_at: latestMessage?.envelope.received_at ?? null,
      message_count: messages.length,
      unread_count: unreadCount,
      has_attachments: hasAttachments,
    },
    summary: null,
    messages,
    provider_ids: {
      thread_id: bundle.conversationId,
    },
    locator: {
      kind: "thread",
      locator: {
        conversation_id: bundle.conversationId,
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

function locatorValue(locator: NormalizedThreadRecord["locator"] | NormalizedMessageRecord["locator"], key: string): string {
  const value = locator?.locator[key];
  return typeof value === "string" ? value : "";
}

interface OutlookMessageLocator {
  conversation_id: string;
  message_id: string | null;
  message_change_key: string | null;
  internet_message_id: string | null;
  instance_key: string | null;
  parent_internet_message_id: string | null;
  associated_calendar_item_id: string | null;
  associated_calendar_change_key: string | null;
  meeting_start: string | null;
  meeting_end: string | null;
}

interface OutlookAttachmentLocator {
  attachment_id: string | null;
  filename: string | null;
  index: number | null;
  message_key: string | null;
}

interface OutlookThreadLocator {
  conversation_id: string;
}

function parseOutlookMessageLocator(locatorJson: string): OutlookMessageLocator {
  const locator = JSON.parse(locatorJson) as Record<string, unknown>;
  const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  return {
    conversation_id: typeof locator.conversation_id === "string" ? locator.conversation_id : "",
    message_id: stringOrNull(locator.message_id),
    message_change_key: stringOrNull(locator.message_change_key),
    internet_message_id: stringOrNull(locator.internet_message_id),
    instance_key: stringOrNull(locator.instance_key),
    parent_internet_message_id: stringOrNull(locator.parent_internet_message_id),
    associated_calendar_item_id: stringOrNull(locator.associated_calendar_item_id),
    associated_calendar_change_key: stringOrNull(locator.associated_calendar_change_key),
    meeting_start: stringOrNull(locator.meeting_start),
    meeting_end: stringOrNull(locator.meeting_end),
  };
}

function parseOutlookThreadLocator(locatorJson: string): OutlookThreadLocator {
  const locator = JSON.parse(locatorJson) as Record<string, unknown>;
  return {
    conversation_id: typeof locator.conversation_id === "string" ? locator.conversation_id : "",
  };
}

function parseOutlookAttachmentLocator(locatorJson: string): OutlookAttachmentLocator {
  const locator = JSON.parse(locatorJson) as Record<string, unknown>;
  return {
    attachment_id: typeof locator.attachment_id === "string" && locator.attachment_id ? locator.attachment_id : null,
    filename: typeof locator.filename === "string" && locator.filename ? locator.filename : null,
    index: typeof locator.index === "number" ? locator.index : null,
    message_key: typeof locator.message_key === "string" && locator.message_key ? locator.message_key : null,
  };
}

function sanitizeAttachmentFilename(filename: string): string {
  const sanitized = filename
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "attachment";
}

function participantFromEmail(email: string): MessageParticipant {
  return {
    name: email,
    email,
  };
}

function recipientsFromInput(input: { to: string[]; cc: string[]; bcc: string[] }): ComposeRecipients {
  return {
    to: input.to.map(participantFromEmail),
    cc: input.cc.map(participantFromEmail),
    bcc: input.bcc.map(participantFromEmail),
  };
}

function recipientsFromStored(
  stored: StoredMessageRecord | undefined,
  fallback: { to: string[]; cc: string[]; bcc: string[] },
): ComposeRecipients {
  if (!stored) {
    return recipientsFromInput(fallback);
  }

  const parsed = parseStoredMessage(stored);
  return {
    to: parsed.envelope.to.length > 0 ? parsed.envelope.to : fallback.to.map(participantFromEmail),
    cc: parsed.envelope.cc.length > 0 ? parsed.envelope.cc : fallback.cc.map(participantFromEmail),
    bcc: fallback.bcc.map(participantFromEmail),
  };
}

function normalizeEmailList(values: string[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return [...deduped];
}

function sourceInfo(account: MailAccount) {
  return {
    provider: account.provider,
    transport: account.transport,
  } as const;
}

async function persistThreads(
  account: MailAccount,
  context: ProviderContext,
  threads: NormalizedThreadRecord[],
): Promise<NormalizedThreadRecord[]> {
  return context.db.transaction(() => {
    const persistedThreads: NormalizedThreadRecord[] = [];

    for (const thread of threads) {
      const conversationId = thread.provider_ids?.thread_id ?? locatorValue(thread.locator, "conversation_id");
      if (!conversationId) {
        throw new SurfaceError("transport_error", "Outlook thread is missing a conversation id.", {
          account: account.name,
        });
      }

      const resolvedThreadRef =
        context.db.findEntityRefByProviderKey("thread", account.account_id, threadProviderKey(conversationId))
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
        provider_key: threadProviderKey(conversationId),
        locator_json: JSON.stringify(thread.locator?.locator ?? { conversation_id: conversationId }),
      });

      const persistedMessages: NormalizedMessageRecord[] = [];
      const messageRefs: string[] = [];
      for (const message of thread.messages) {
        const providerKey = messageProviderKey(
          {
            item: {
              ItemId: { Id: message.provider_ids?.message_id },
              InternetMessageId: message.provider_ids?.internet_message_id,
              InstanceKey: locatorValue(message.locator, "instance_key"),
              DateTimeReceived: message.envelope.received_at,
              Subject: message.envelope.subject ?? thread.envelope.subject,
            },
            nodeMetadata: {
              parentInternetMessageId: locatorValue(message.locator, "parent_internet_message_id") || null,
              hasQuotedText: null,
              isRootNode: null,
            },
          },
          conversationId,
        );
        const resolvedMessageRef =
          context.db.findEntityRefByProviderKey("message", account.account_id, providerKey) ?? makeMessageRef();

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
          provider_key: providerKey,
          locator_json: JSON.stringify(message.locator?.locator ?? {}),
        });

        const persistedAttachments: NormalizedAttachmentRecord[] = [];
        for (const [index, attachment] of message.attachments.entries()) {
          const providerKeyForAttachment = attachmentProviderKey(providerKey, attachment, index);
          const resolvedAttachmentId =
            context.db.findEntityRefByProviderKey("attachment", account.account_id, providerKeyForAttachment)
            ?? makeAttachmentId();
          context.db.upsertProviderLocator({
            entity_kind: "attachment",
            entity_ref: resolvedAttachmentId,
            account_id: account.account_id,
            provider_key: providerKeyForAttachment,
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
      const threadInviteStatus = inferThreadRsvpStatus(persistedMessages);
      if (threadInviteStatus) {
        context.db.updateInviteStatusForThread(resolvedThreadRef, threadInviteStatus);
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

async function refreshOutlookConversationWithSession(
  account: MailAccount,
  conversationId: string,
  context: ProviderContext,
  browserSession: OutlookSession,
): Promise<void> {
  const capturedSession = await captureOutlookServiceSession(browserSession.context, browserSession.page, {
    timeoutMs: context.config.providerTimeoutMs,
  });
  const bundle = await fetchConversationBundle(browserSession.context.request, capturedSession, conversationId);
  const persisted = await persistThreads(account, context, [normalizeThread(bundle)]);
  await summarizeAndPersistThreads(persisted, context.config, context.db, context.db.getAccountIdentity(account));
}

async function refreshOutlookConversation(
  account: MailAccount,
  conversationId: string,
  context: ProviderContext,
): Promise<void> {
  await withManagedOutlookSession(context, undefined, (session) =>
    refreshOutlookConversationWithSession(account, conversationId, context, session));
}

async function refreshStoredMessageWithSession(
  account: MailAccount,
  messageRef: string,
  context: ProviderContext,
  browserSession: OutlookSession,
): Promise<StoredMessageRecord> {
  const locatorRow = context.db.findProviderLocator("message", messageRef);
  if (!locatorRow) {
    throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
      account: account.name,
      messageRef,
    });
  }

  const locator = parseOutlookMessageLocator(locatorRow.locator_json);
  if (!locator.conversation_id) {
    throw new SurfaceError("transport_error", `Message '${messageRef}' is missing an Outlook conversation id.`, {
      account: account.name,
      messageRef,
      });
  }

  await refreshOutlookConversationWithSession(account, locator.conversation_id, context, browserSession);
  const refreshed = context.db.getStoredMessage(messageRef);
  if (!refreshed) {
    throw new SurfaceError("not_found", `Message '${messageRef}' could not be refreshed from Outlook.`, {
      account: account.name,
      messageRef,
    });
  }

  return refreshed;
}

async function refreshStoredMessage(
  account: MailAccount,
  messageRef: string,
  context: ProviderContext,
): Promise<StoredMessageRecord> {
  return withManagedOutlookSession(context, undefined, (session) =>
    refreshStoredMessageWithSession(account, messageRef, context, session));
}

async function resolveRsvpLocator(
  account: MailAccount,
  messageRef: string,
  context: ProviderContext,
): Promise<{ locator: OutlookMessageLocator; stored: StoredMessageRecord }> {
  let stored = context.db.getStoredMessage(messageRef);
  if (!stored) {
    throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
      account: account.name,
      messageRef,
    });
  }

  if (!stored.invite_json) {
    throw new SurfaceError("unsupported", `Message '${messageRef}' is not a meeting invite.`, {
      account: account.name,
      messageRef,
      threadRef: stored.thread_ref,
    });
  }

  let locatorRow = context.db.findProviderLocator("message", messageRef);
  if (!locatorRow) {
    stored = await refreshStoredMessage(account, messageRef, context);
    locatorRow = context.db.findProviderLocator("message", messageRef);
  }

  if (!locatorRow) {
    throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
      account: account.name,
      messageRef,
      threadRef: stored.thread_ref,
    });
  }

  let locator = parseOutlookMessageLocator(locatorRow.locator_json);
  if (!locator.message_id || !locator.message_change_key) {
    stored = await refreshStoredMessage(account, messageRef, context);
    locatorRow = context.db.findProviderLocator("message", messageRef);
    if (!locatorRow) {
      throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
        account: account.name,
        messageRef,
        threadRef: stored.thread_ref,
      });
    }
    locator = parseOutlookMessageLocator(locatorRow.locator_json);
  }

  if (!locator.message_id || !locator.message_change_key) {
    throw new SurfaceError(
      "unsupported",
      `Message '${messageRef}' does not expose enough Outlook item metadata for RSVP actions.`,
      {
        account: account.name,
        messageRef,
        threadRef: stored.thread_ref,
      },
    );
  }

  return { locator, stored };
}

async function resolveMessageActionTarget(
  account: MailAccount,
  messageRef: string,
  context: ProviderContext,
): Promise<{ locator: OutlookMessageLocator; stored: StoredMessageRecord }> {
  let stored = context.db.getStoredMessage(messageRef);
  if (!stored) {
    throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
      account: account.name,
      messageRef,
    });
  }

  let locatorRow = context.db.findProviderLocator("message", messageRef);
  if (!locatorRow) {
    stored = await refreshStoredMessage(account, messageRef, context);
    locatorRow = context.db.findProviderLocator("message", messageRef);
  }

  if (!locatorRow) {
    throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
      account: account.name,
      messageRef,
      threadRef: stored.thread_ref,
    });
  }

  let locator = parseOutlookMessageLocator(locatorRow.locator_json);
  if (!locator.conversation_id) {
    stored = await refreshStoredMessage(account, messageRef, context);
    locatorRow = context.db.findProviderLocator("message", messageRef);
    if (!locatorRow) {
      throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
        account: account.name,
        messageRef,
        threadRef: stored.thread_ref,
      });
    }
    locator = parseOutlookMessageLocator(locatorRow.locator_json);
  }

  if (!locator.conversation_id) {
    throw new SurfaceError(
      "unsupported",
      `Message '${messageRef}' does not expose enough Outlook metadata for mail actions.`,
      {
        account: account.name,
        messageRef,
        threadRef: stored.thread_ref,
      },
    );
  }

  return { locator, stored };
}

async function resolveMessageStateTarget(
  account: MailAccount,
  messageRef: string,
  context: ProviderContext,
): Promise<{ locator: OutlookMessageLocator; stored: StoredMessageRecord }> {
  let resolved = await resolveMessageActionTarget(account, messageRef, context);
  if (!resolved.locator.message_id) {
    const refreshed = await refreshStoredMessage(account, messageRef, context);
    const locatorRow = context.db.findProviderLocator("message", messageRef);
    if (!locatorRow) {
      throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
        account: account.name,
        messageRef,
        threadRef: refreshed.thread_ref,
      });
    }
    resolved = {
      stored: refreshed,
      locator: parseOutlookMessageLocator(locatorRow.locator_json),
    };
  }

  if (!resolved.locator.message_id) {
    throw new SurfaceError(
      "unsupported",
      `Message '${messageRef}' does not expose enough Outlook metadata for read-state actions.`,
      {
        account: account.name,
        messageRef,
        threadRef: resolved.stored.thread_ref,
      },
    );
  }

  return resolved;
}

async function resolveAttachmentDownloadTarget(
  account: MailAccount,
  messageRef: string,
  attachmentId: string,
  context: ProviderContext,
): Promise<{
  stored: StoredMessageRecord;
  messageLocator: OutlookMessageLocator;
  attachment: {
    attachment_id: string;
    filename: string;
    mime_type: string;
    size_bytes: number | null;
    inline: boolean;
    saved_to: string | null;
  };
  attachmentLocator: OutlookAttachmentLocator;
}> {
  const message = context.db.findMessageByRef(messageRef);
  if (!message) {
    throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
      account: account.name,
      messageRef,
    });
  }

  const storedAttachment = context.db.findAttachmentById(attachmentId);
  if (!storedAttachment || storedAttachment.message_ref !== messageRef) {
    throw new SurfaceError("not_found", `Attachment '${attachmentId}' was not found on message '${messageRef}'.`, {
      account: account.name,
      messageRef,
      threadRef: message.thread_ref,
    });
  }

  let stored = context.db.getStoredMessage(messageRef);
  if (!stored) {
    throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
      account: account.name,
      messageRef,
      threadRef: message.thread_ref,
    });
  }

  let messageLocatorRow = context.db.findProviderLocator("message", messageRef);
  let attachmentLocatorRow = context.db.findProviderLocator("attachment", attachmentId);
  if (!messageLocatorRow || !attachmentLocatorRow) {
    stored = await refreshStoredMessage(account, messageRef, context);
    messageLocatorRow = context.db.findProviderLocator("message", messageRef);
    attachmentLocatorRow = context.db.findProviderLocator("attachment", attachmentId);
  }

  if (!messageLocatorRow || !attachmentLocatorRow) {
    throw new SurfaceError(
      "cache_miss",
      `Attachment '${attachmentId}' is missing provider locator data required for download.`,
      {
        account: account.name,
        messageRef,
        threadRef: stored.thread_ref,
      },
    );
  }

  let messageLocator = parseOutlookMessageLocator(messageLocatorRow.locator_json);
  let attachmentLocator = parseOutlookAttachmentLocator(attachmentLocatorRow.locator_json);
  if (!messageLocator.message_id || !attachmentLocator.attachment_id) {
    stored = await refreshStoredMessage(account, messageRef, context);
    messageLocatorRow = context.db.findProviderLocator("message", messageRef);
    attachmentLocatorRow = context.db.findProviderLocator("attachment", attachmentId);
    if (!messageLocatorRow || !attachmentLocatorRow) {
      throw new SurfaceError(
        "cache_miss",
        `Attachment '${attachmentId}' is missing provider locator data required for download.`,
        {
          account: account.name,
          messageRef,
          threadRef: stored.thread_ref,
        },
      );
    }
    messageLocator = parseOutlookMessageLocator(messageLocatorRow.locator_json);
    attachmentLocator = parseOutlookAttachmentLocator(attachmentLocatorRow.locator_json);
  }

  if (!messageLocator.message_id || !attachmentLocator.attachment_id) {
    throw new SurfaceError(
      "unsupported",
      `Attachment '${attachmentId}' does not expose enough Outlook metadata for download.`,
      {
        account: account.name,
        messageRef,
        threadRef: stored.thread_ref,
      },
    );
  }

  const attachment = context.db
    .listAttachmentsForMessage(messageRef)
    .find((candidate) => candidate.attachment_id === attachmentId);
  if (!attachment) {
    throw new SurfaceError("not_found", `Attachment '${attachmentId}' was not found on message '${messageRef}'.`, {
      account: account.name,
      messageRef,
      threadRef: stored.thread_ref,
    });
  }

  return {
    stored,
    messageLocator,
    attachment: {
      attachment_id: attachment.attachment_id,
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      inline: Boolean(attachment.inline),
      saved_to: attachment.saved_to,
    },
    attachmentLocator,
  };
}

async function openConversationForAction(
  page: Page,
  locator: OutlookMessageLocator,
  queryText: string,
): Promise<void> {
  await page.goto("https://outlook.office.com/mail/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await waitForOutlookMailboxReady(page, 30_000);
  await applySearchQuery(page, queryText);

  let row = page.locator(`[role="option"][data-convid="${locator.conversation_id}"]`).first();
  if ((await row.count()) === 0) {
    row = page.locator('[role="option"]').filter({ hasText: queryText }).first();
  }

  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(1_500);
}

async function ensureRecipientField(page: Page, label: "To" | "Cc" | "Bcc") {
  let field = page.locator(`[aria-label="${label}"][contenteditable="true"]`).first();
  if ((await field.count()) > 0) {
    return field;
  }

  const toggle = page.getByText(label, { exact: true }).last();
  await toggle.click();
  await page.waitForTimeout(400);
  field = page.locator(`[aria-label="${label}"][contenteditable="true"]`).first();
  await field.waitFor({ timeout: 10_000 });
  return field;
}

async function fillRecipientField(page: Page, label: "To" | "Cc" | "Bcc", recipients: string[]): Promise<void> {
  const normalizedRecipients = normalizeEmailList(recipients);
  if (normalizedRecipients.length === 0) {
    return;
  }

  const field = await ensureRecipientField(page, label);
  for (const recipient of normalizedRecipients) {
    await field.click();
    await field.type(recipient);
    await field.press("Enter");
    await page.waitForTimeout(150);
  }
}

async function fillComposeBody(page: Page, body: string): Promise<void> {
  const editor = page.locator('[role="textbox"][aria-label="Message body"]').first();
  await editor.waitFor({ timeout: 15_000 });
  await editor.click();
  if (body.trim()) {
    await editor.type(body);
  }
}

async function sendCurrentCompose(page: Page): Promise<void> {
  await page.locator('button[aria-label="Send"]').first().click();
  await page.waitForTimeout(4_000);
}

async function saveCurrentComposeDraft(page: Page): Promise<void> {
  await page.waitForTimeout(6_000);
  const closeButtons = page.locator('button[aria-label="Close"]:visible');
  if ((await closeButtons.count()) > 0) {
    await closeButtons.first().click();
    await page.waitForTimeout(2_000);
    return;
  }

  await page.waitForTimeout(1_000);
}

async function finalizeCurrentCompose(
  page: Page,
  disposition: "send" | "draft",
): Promise<SendResultEnvelope["status"]> {
  if (disposition === "draft") {
    await saveCurrentComposeDraft(page);
    return "drafted";
  }

  await sendCurrentCompose(page);
  return "sent";
}

async function clickReplyAllAction(page: Page): Promise<void> {
  const primaryButton = page.getByRole("button", { name: /reply all/i }).first();
  if ((await primaryButton.count()) > 0) {
    await primaryButton.click();
    return;
  }

  await page.locator('button[aria-label="More items"]').last().click();
  await page.waitForTimeout(600);
  const fallback = page.getByRole("menuitem", { name: /reply all/i }).first();
  await fallback.waitFor({ timeout: 10_000 });
  await fallback.click({ force: true });
  await page.waitForTimeout(800);
  const inlineActivator = page.locator('div[aria-label="Reply all"]').last();
  if ((await inlineActivator.count()) > 0) {
    await inlineActivator.click({ force: true });
  }
}

async function findResolvedSearchTarget(
  account: MailAccount,
  subject: string,
  context: ProviderContext,
): Promise<{ thread_ref: string | null; message_ref: string | null; stored: StoredMessageRecord | null }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const threads = await fetchOutlookThreads(account, context, {
      kind: "search",
      queryText: subject,
      limit: 5,
      summarize: false,
    });
    const thread = threads.find((candidate) => candidate.envelope.subject.includes(subject)) ?? threads[0];
    if (thread) {
      const messageRef = thread.messages[0]?.message_ref ?? null;
      return {
        thread_ref: thread.thread_ref,
        message_ref: messageRef,
        stored: messageRef ? context.db.getStoredMessage(messageRef) ?? null : null,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return {
    thread_ref: null,
    message_ref: null,
    stored: null,
  };
}

function latestStoredThreadMessage(
  threadRef: string,
  context: ProviderContext,
): { message_ref: string | null; stored: StoredMessageRecord | null } {
  const messageRef = context.db.listMessageRefsForThread(threadRef)[0] ?? null;
  return {
    message_ref: messageRef,
    stored: messageRef ? context.db.getStoredMessage(messageRef) ?? null : null,
  };
}

function buildSendEnvelope(
  account: MailAccount,
  command: SendResultEnvelope["command"],
  status: SendResultEnvelope["status"],
  subject: string,
  recipients: ComposeRecipients,
  result: { thread_ref: string | null; message_ref: string | null },
  inReplyToMessageRef: string | null,
): SendResultEnvelope {
  return {
    schema_version: "1",
    command,
    account: account.name,
    source: sourceInfo(account),
    status,
    subject,
    recipients,
    thread_ref: result.thread_ref,
    message_ref: result.message_ref,
    in_reply_to_message_ref: inReplyToMessageRef,
  };
}

function buildArchiveEnvelope(
  account: MailAccount,
  messageRef: string,
  threadRef: string,
): ArchiveResultEnvelope {
  return {
    schema_version: "1",
    command: "archive",
    account: account.name,
    message_ref: messageRef,
    thread_ref: threadRef,
    source: sourceInfo(account),
    status: "archived",
  };
}

function buildMarkMessagesEnvelope(
  account: MailAccount,
  command: MarkMessagesResultEnvelope["command"],
  updated: MarkMessagesResultEnvelope["updated"],
): MarkMessagesResultEnvelope {
  return {
    schema_version: "1",
    command,
    account: account.name,
    source: sourceInfo(account),
    updated,
  };
}

function buildCreateItemHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    action: "CreateItem",
    "content-type": "application/json; charset=utf-8",
  };
}

function buildOutlookRestHeaders(headers: Record<string, string>): Record<string, string> {
  const restHeaders: Record<string, string> = {};
  if (headers.authorization) {
    restHeaders.authorization = headers.authorization;
  }
  if (headers.prefer) {
    restHeaders.prefer = headers.prefer;
  }
  return restHeaders;
}

function buildOutlookRestAttachmentValueUrl(messageId: string, attachmentId: string): string {
  return `https://outlook.office.com/api/v2.0/me/messages('${encodeURIComponent(messageId)}')/attachments('${encodeURIComponent(attachmentId)}')/$value`;
}

function buildOutlookRestMessageUrl(messageId: string): string {
  return `https://outlook.office.com/api/v2.0/me/messages('${encodeURIComponent(messageId)}')`;
}

function buildMeetingResponseType(response: RsvpResponse): "AcceptItem" | "DeclineItem" | "TentativelyAcceptItem" {
  switch (response) {
    case "accept":
      return "AcceptItem";
    case "decline":
      return "DeclineItem";
    case "tentative":
      return "TentativelyAcceptItem";
  }
}

function buildMeetingResponsePayload(locator: OutlookMessageLocator, response: RsvpResponse): Record<string, unknown> {
  if (!locator.message_id || !locator.message_change_key) {
    throw new SurfaceError("unsupported", "Outlook RSVP requires a message id and change key.");
  }

  return {
    __type: "CreateItemJsonRequest:#Exchange",
    Header: {
      __type: "JsonRequestHeaders:#Exchange",
      RequestServerVersion: "V2017_08_18",
      TimeZoneContext: {
        __type: "TimeZoneContext:#Exchange",
        TimeZoneDefinition: {
          __type: "TimeZoneDefinitionType:#Exchange",
          Id: "GMT Standard Time",
        },
      },
    },
    Body: {
      __type: "CreateItemRequest:#Exchange",
      MessageDisposition: "SendAndSaveCopy",
      Items: [
        {
          __type: `${buildMeetingResponseType(response)}:#Exchange`,
          ReferenceItemId: {
            __type: "ItemId:#Exchange",
            Id: locator.message_id,
            ChangeKey: locator.message_change_key,
          },
        },
      ],
    },
  };
}

async function performOutlookRsvpAction(
  session: Awaited<ReturnType<typeof launchOutlookSession>>,
  locator: OutlookMessageLocator,
  response: RsvpResponse,
  timeoutMs: number,
): Promise<void> {
  const capturedSession = await captureOutlookServiceSession(session.context, session.page, {
    timeoutMs,
  });
  const serviceResponse = await session.context.request.post(
    `${capturedSession.serviceUrl}?action=CreateItem&app=Mail&n=999`,
    {
      headers: buildCreateItemHeaders(capturedSession.headers),
      data: JSON.stringify(buildMeetingResponsePayload(locator, response)),
      timeout: timeoutMs,
    },
  );

  if (!serviceResponse.ok()) {
    throw new SurfaceError(
      "transport_error",
      `Outlook RSVP request failed with status ${serviceResponse.status()}.`,
    );
  }

  const data = await serviceResponse.json();
  const responseMessage = data?.Body?.ResponseMessages?.Items?.[0];
  if (responseMessage?.ResponseCode !== "NoError") {
    throw new SurfaceError(
      "transport_error",
      `Outlook RSVP request failed with response code '${responseMessage?.ResponseCode ?? "UnknownError"}'.`,
    );
  }
}

async function performOutlookReadStateAction(
  session: Awaited<ReturnType<typeof launchOutlookSession>>,
  locator: OutlookMessageLocator,
  unread: boolean,
  timeoutMs: number,
): Promise<void> {
  if (!locator.message_id) {
    throw new SurfaceError("unsupported", "Outlook read-state mutation requires a message id.");
  }

  const capturedSession = await captureOutlookServiceSession(session.context, session.page, {
    timeoutMs,
  });
  const response = await session.context.request.fetch(
    buildOutlookRestMessageUrl(locator.message_id),
    {
      method: "PATCH",
      headers: {
        ...buildOutlookRestHeaders(capturedSession.headers),
        "content-type": "application/json",
      },
      data: JSON.stringify({ IsRead: !unread }),
      failOnStatusCode: false,
      timeout: timeoutMs,
    },
  );

  if (!response.ok()) {
    throw new SurfaceError(
      "transport_error",
      `Outlook read-state update failed with status ${response.status()}.`,
    );
  }

  const data = await response.json();
  if (typeof data?.IsRead !== "boolean" || data.IsRead !== !unread) {
    throw new SurfaceError(
      "transport_error",
      `Outlook read-state update did not return the expected IsRead=${!unread} state.`,
    );
  }
}

function buildRsvpEnvelope(
  account: MailAccount,
  messageRef: string,
  threadRef: string,
  response: RsvpResponse,
  invite: MessageInvite | undefined,
): RsvpResultEnvelope {
  return {
    schema_version: "1",
    command: "rsvp",
    account: account.name,
    message_ref: messageRef,
    thread_ref: threadRef,
    source: {
      provider: account.provider,
      transport: account.transport,
    },
    response,
    invite: invite ?? null,
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
    source: {
      provider: account.provider,
      transport: account.transport,
    },
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

async function fetchOutlookThreadsWithSession(
  account: MailAccount,
  context: ProviderContext,
  browserSession: OutlookSession,
  options: {
    kind: "search" | "fetch-unread" | "browse-current-folder";
    queryText?: string;
    limit: number;
    fetchLimit?: number;
    summarize?: boolean;
    postFilter?: (thread: NormalizedThreadRecord) => boolean;
  },
): Promise<NormalizedThreadRecord[]> {
  const { context: playwrightContext, page } = browserSession;
  const capturedSession = await captureOutlookServiceSession(playwrightContext, page, {
    timeoutMs: context.config.providerTimeoutMs,
  });

  let conversationIds: string[];
  if (options.kind === "fetch-unread") {
    await applyUnreadFilter(page);
    conversationIds = await collectUnreadConversationIds(page, options.fetchLimit ?? options.limit);
  } else if (options.kind === "browse-current-folder") {
    conversationIds = await collectCurrentConversationIds(page, options.fetchLimit ?? options.limit);
  } else {
    await applySearchQuery(page, options.queryText ?? "");
    conversationIds = await collectSearchConversationIds(page, options.fetchLimit ?? options.limit);
  }

  const bundles: OutlookThreadBundle[] = [];
  for (const conversationId of conversationIds) {
    bundles.push(await fetchConversationBundle(playwrightContext.request, capturedSession, conversationId));
  }

  const normalized = bundles.map((bundle) => normalizeThread(bundle));
  const filtered = options.postFilter ? normalized.filter(options.postFilter) : normalized;
  const limited = filtered.slice(0, options.limit);
  const persisted = await persistThreads(account, context, limited);
  return options.summarize === false
    ? persisted
    : await summarizeAndPersistThreads(persisted, context.config, context.db, context.db.getAccountIdentity(account));
}

async function fetchOutlookThreads(
  account: MailAccount,
  context: ProviderContext,
  options: {
    kind: "search" | "fetch-unread" | "browse-current-folder";
    queryText?: string;
    limit: number;
    fetchLimit?: number;
    summarize?: boolean;
    postFilter?: (thread: NormalizedThreadRecord) => boolean;
  },
): Promise<NormalizedThreadRecord[]> {
  const profileDir = outlookProfileDir(context);
  if (!existsSync(profileDir)) {
    throw new SurfaceError("reauth_required", "Outlook profile directory is missing for this account.", {
      account: account.name,
    });
  }

  return withManagedOutlookSession(context, undefined, (session) =>
    fetchOutlookThreadsWithSession(account, context, session, options));
}

export async function searchOutlookWithSession(
  account: MailAccount,
  query: SearchQuery,
  context: ProviderContext,
  browserSession?: OutlookSession,
): Promise<NormalizedThreadRecord[]> {
  const queryText = buildOutlookSearchQuery(query);
  const normalizedLabels = new Set((query.labels ?? []).map((label) => label.trim().toLowerCase()).filter(Boolean));
  const postFilter = (thread: NormalizedThreadRecord) => threadMatchesStructuredFilters(thread, query);

  if (!queryText && normalizedLabels.has("unread")) {
    const threads = await withManagedOutlookSession(context, browserSession, (session) =>
      fetchOutlookThreadsWithSession(account, context, session, {
        kind: "fetch-unread",
        limit: query.limit,
        fetchLimit: Math.min(Math.max(query.limit * 3, query.limit), 100),
        postFilter,
      }));
    return threads.slice(0, query.limit);
  }

  const threads = await withManagedOutlookSession(context, browserSession, (session) =>
    fetchOutlookThreadsWithSession(account, context, session, {
      kind: queryText ? "search" : "browse-current-folder",
      ...(queryText ? { queryText } : {}),
      limit: query.limit,
      fetchLimit: Math.min(Math.max(query.limit * 3, query.limit), 100),
      postFilter,
    }));
  return threads.slice(0, query.limit);
}

export async function fetchUnreadOutlookWithSession(
  account: MailAccount,
  query: FetchUnreadQuery,
  context: ProviderContext,
  browserSession?: OutlookSession,
): Promise<NormalizedThreadRecord[]> {
  return withManagedOutlookSession(context, browserSession, (session) =>
    fetchOutlookThreadsWithSession(account, context, session, {
      kind: "fetch-unread",
      limit: query.limit,
    }));
}

export async function refreshOutlookThreadWithSession(
  account: MailAccount,
  threadRef: string,
  context: ProviderContext,
  browserSession?: OutlookSession,
): Promise<void> {
  const locatorRow = context.db.findProviderLocator("thread", threadRef);
  if (!locatorRow) {
    throw new SurfaceError("cache_miss", `No provider locator exists for thread '${threadRef}'.`, {
      account: account.name,
      threadRef,
    });
  }

  const locator = parseOutlookThreadLocator(locatorRow.locator_json);
  if (!locator.conversation_id) {
    throw new SurfaceError("transport_error", `Thread '${threadRef}' is missing an Outlook conversation id.`, {
      account: account.name,
      threadRef,
    });
  }

  await withManagedOutlookSession(context, browserSession, (session) =>
    refreshOutlookConversationWithSession(account, locator.conversation_id, context, session));
}

export async function readOutlookMessageWithSession(
  account: MailAccount,
  messageRef: string,
  refresh: boolean,
  context: ProviderContext,
  browserSession?: OutlookSession,
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

  const refreshed = await withManagedOutlookSession(context, browserSession, (session) =>
    refreshStoredMessageWithSession(account, messageRef, context, session));

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

async function mutateOutlookReadState(
  account: MailAccount,
  messageRefs: string[],
  unread: boolean,
  context: ProviderContext,
): Promise<MarkMessagesResultEnvelope> {
  if (messageRefs.length === 0) {
    throw new SurfaceError("invalid_argument", "At least one message ref is required.", {
      account: account.name,
    });
  }

  assertWriteAllowed(context.config, account, { to: [], cc: [], bcc: [] }, { disposition: "non_send" });

  const targets = [];
  for (const messageRef of messageRefs) {
    targets.push(await resolveMessageStateTarget(account, messageRef, context));
  }

  const profileDir = outlookProfileDir(context);
  const session = await launchOutlookSession(profileDir, { headless: true });
  try {
    for (const target of targets) {
      await performOutlookReadStateAction(session, target.locator, unread, context.config.providerTimeoutMs);
    }
  } finally {
    await session.context.close();
    session.cleanup?.();
  }

  const threadRefs = targets.map((target) => target.stored.thread_ref);
  context.db.updateMessagesUnreadState(messageRefs, unread);
  context.db.recomputeThreadUnreadCounts(threadRefs);

  return buildMarkMessagesEnvelope(
    account,
    unread ? "mark-unread" : "mark-read",
    targets.map((target, index) => ({
      message_ref: messageRefs[index]!,
      thread_ref: target.stored.thread_ref,
      unread,
    })),
  );
}

export class OutlookWebPlaywrightAdapter implements MailProviderAdapter {
  readonly provider = "outlook" as const;
  readonly transport = "outlook-web-playwright";

  async login(account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: false });

    try {
      await session.page.goto("https://outlook.office.com/mail/", { waitUntil: "domcontentloaded" });
      await promptForOutlookLogin(profileDir);
      return await probeOutlookAuth(session.page, { timeoutMs: context.config.providerTimeoutMs });
    } finally {
      await session.context.close();
      session.cleanup?.();
    }
  }

  async logout(_account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    const profileDir = outlookProfileDir(context);
    rmSync(profileDir, { recursive: true, force: true });
    return {
      status: "unauthenticated",
      detail: "Removed the Outlook persistent profile directory for this account.",
    };
  }

  async authStatus(_account: MailAccount, context: ProviderContext): Promise<AuthStatus> {
    const profileDir = outlookProfileDir(context);
    if (!existsSync(profileDir)) {
      return { status: "unauthenticated", detail: "No Outlook browser profile found for this account." };
    }

    const profileEntries = readdirSync(profileDir);
    if (profileEntries.length === 0) {
      return { status: "unauthenticated", detail: "Outlook profile directory exists but is empty." };
    }

    let session;
    try {
      session = await launchOutlookSession(profileDir, { headless: true });
      return await probeOutlookAuth(session.page, { timeoutMs: context.config.providerTimeoutMs });
    } catch (error) {
      return {
        status: "unknown",
        detail:
          error instanceof Error
            ? `Could not probe Outlook auth state: ${error.message}`
            : "Could not probe Outlook auth state.",
      };
    } finally {
      await session?.context.close();
      session?.cleanup?.();
    }
  }

  async search(account: MailAccount, query: SearchQuery, context: ProviderContext): Promise<NormalizedThreadRecord[]> {
    return searchOutlookWithSession(account, query, context);
  }

  async fetchUnread(
    account: MailAccount,
    query: FetchUnreadQuery,
    context: ProviderContext,
  ): Promise<NormalizedThreadRecord[]> {
    return fetchUnreadOutlookWithSession(account, query, context);
  }

  async refreshThread(
    account: MailAccount,
    threadRef: string,
    context: ProviderContext,
  ): Promise<void> {
    await refreshOutlookThreadWithSession(account, threadRef, context);
  }

  async readMessage(
    account: MailAccount,
    messageRef: string,
    refresh: boolean,
    context: ProviderContext,
  ): Promise<ReadResultEnvelope> {
    return readOutlookMessageWithSession(account, messageRef, refresh, context);
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

  async rsvp(
    account: MailAccount,
    messageRef: string,
    response: RsvpResponse,
    context: ProviderContext,
  ): Promise<RsvpResultEnvelope> {
    const { locator, stored } = await resolveRsvpLocator(account, messageRef, context);
    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: true });

    try {
      await performOutlookRsvpAction(session, locator, response, context.config.providerTimeoutMs);
    } finally {
      await session.context.close();
      session.cleanup?.();
    }

    const refreshed = await refreshStoredMessage(account, messageRef, context);
    const parsed = parseStoredMessage(refreshed);
    return buildRsvpEnvelope(account, messageRef, stored.thread_ref, response, parsed.invite);
  }

  async markRead(
    account: MailAccount,
    messageRefs: string[],
    context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope> {
    return mutateOutlookReadState(account, messageRefs, false, context);
  }

  async markUnread(
    account: MailAccount,
    messageRefs: string[],
    context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope> {
    return mutateOutlookReadState(account, messageRefs, true, context);
  }

  async sendMessage(
    account: MailAccount,
    input: SendMessageInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    const normalizedInput = {
      to: normalizeEmailList(input.to),
      cc: normalizeEmailList(input.cc),
      bcc: normalizeEmailList(input.bcc),
      subject: input.subject.trim(),
      body: input.body,
      draft: input.draft,
    };

    if (normalizedInput.to.length === 0) {
      throw new SurfaceError("invalid_argument", "Send requires at least one --to recipient.", {
        account: account.name,
      });
    }
    if (!normalizedInput.subject) {
      throw new SurfaceError("invalid_argument", "Send requires a non-empty --subject.", {
        account: account.name,
      });
    }

    assertWriteAllowed(
      context.config,
      account,
      collectWriteRecipients(normalizedInput),
      { disposition: normalizedInput.draft ? "draft" : "send" },
    );

    let status: SendResultEnvelope["status"] = "sent";
    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: true });
    try {
      await session.page.goto("https://outlook.office.com/mail/", {
        waitUntil: "domcontentloaded",
        timeout: context.config.providerTimeoutMs,
      });
      await waitForOutlookMailboxReady(session.page, context.config.providerTimeoutMs);
      await session.page.locator('button[aria-label="New email"]').first().click();
      await session.page.waitForTimeout(1_500);
      await fillRecipientField(session.page, "To", normalizedInput.to);
      await fillRecipientField(session.page, "Cc", normalizedInput.cc);
      await fillRecipientField(session.page, "Bcc", normalizedInput.bcc);
      await session.page.locator('input[aria-label="Subject"]').fill(normalizedInput.subject);
      await fillComposeBody(session.page, normalizedInput.body);
      status = await finalizeCurrentCompose(session.page, normalizedInput.draft ? "draft" : "send");
    } finally {
      await session.context.close();
      session.cleanup?.();
    }

    const resolved = await findResolvedSearchTarget(account, normalizedInput.subject, context);
    return buildSendEnvelope(
      account,
      "send",
      status,
      normalizedInput.subject,
      recipientsFromStored(resolved.stored ?? undefined, normalizedInput),
      resolved,
      null,
    );
  }

  async reply(
    account: MailAccount,
    messageRef: string,
    input: ReplyInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    const target = await resolveMessageActionTarget(account, messageRef, context);
    const normalizedInput = {
      cc: normalizeEmailList(input.cc),
      bcc: normalizeEmailList(input.bcc),
      body: input.body,
      draft: input.draft,
    };

    assertWriteAllowed(
      context.config,
      account,
      collectWriteRecipients({ to: [], ...normalizedInput }),
      { disposition: normalizedInput.draft ? "draft" : "send" },
    );

    let status: SendResultEnvelope["status"] = "sent";
    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: true });
    try {
      await openConversationForAction(
        session.page,
        target.locator,
        target.stored.subject ?? target.locator.internet_message_id ?? messageRef,
      );
      await session.page.locator('button[aria-label="Reply"]').first().click();
      await session.page.waitForTimeout(1_500);
      await fillRecipientField(session.page, "Cc", normalizedInput.cc);
      await fillRecipientField(session.page, "Bcc", normalizedInput.bcc);
      await fillComposeBody(session.page, normalizedInput.body);
      status = await finalizeCurrentCompose(session.page, normalizedInput.draft ? "draft" : "send");
    } finally {
      await session.context.close();
      session.cleanup?.();
    }

    await refreshOutlookConversation(account, target.locator.conversation_id, context);
    const latest = latestStoredThreadMessage(target.stored.thread_ref, context);
    const subject = latest.stored?.subject ?? target.stored.subject ?? "";
    return buildSendEnvelope(
      account,
      "reply",
      status,
      subject,
      recipientsFromStored(latest.stored ?? undefined, { to: [], cc: normalizedInput.cc, bcc: normalizedInput.bcc }),
      { thread_ref: target.stored.thread_ref, message_ref: latest.message_ref },
      messageRef,
    );
  }

  async replyAll(
    account: MailAccount,
    messageRef: string,
    input: ReplyInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    const target = await resolveMessageActionTarget(account, messageRef, context);
    const normalizedInput = {
      cc: normalizeEmailList(input.cc),
      bcc: normalizeEmailList(input.bcc),
      body: input.body,
      draft: input.draft,
    };

    assertWriteAllowed(
      context.config,
      account,
      collectWriteRecipients({ to: [], ...normalizedInput }),
      { disposition: normalizedInput.draft ? "draft" : "send" },
    );

    let status: SendResultEnvelope["status"] = "sent";
    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: true });
    try {
      await openConversationForAction(
        session.page,
        target.locator,
        target.stored.subject ?? target.locator.internet_message_id ?? messageRef,
      );
      await clickReplyAllAction(session.page);
      await session.page.waitForTimeout(1_500);
      await fillRecipientField(session.page, "Cc", normalizedInput.cc);
      await fillRecipientField(session.page, "Bcc", normalizedInput.bcc);
      await fillComposeBody(session.page, normalizedInput.body);
      status = await finalizeCurrentCompose(session.page, normalizedInput.draft ? "draft" : "send");
    } finally {
      await session.context.close();
      session.cleanup?.();
    }

    await refreshOutlookConversation(account, target.locator.conversation_id, context);
    const latest = latestStoredThreadMessage(target.stored.thread_ref, context);
    const subject = latest.stored?.subject ?? target.stored.subject ?? "";
    return buildSendEnvelope(
      account,
      "reply-all",
      status,
      subject,
      recipientsFromStored(latest.stored ?? undefined, { to: [], cc: normalizedInput.cc, bcc: normalizedInput.bcc }),
      { thread_ref: target.stored.thread_ref, message_ref: latest.message_ref },
      messageRef,
    );
  }

  async forward(
    account: MailAccount,
    messageRef: string,
    input: ForwardInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    const target = await resolveMessageActionTarget(account, messageRef, context);
    const normalizedInput = {
      to: normalizeEmailList(input.to),
      cc: normalizeEmailList(input.cc),
      bcc: normalizeEmailList(input.bcc),
      body: input.body,
      draft: input.draft,
    };

    if (normalizedInput.to.length === 0) {
      throw new SurfaceError("invalid_argument", "Forward requires at least one --to recipient.", {
        account: account.name,
        messageRef,
        threadRef: target.stored.thread_ref,
      });
    }

    assertWriteAllowed(
      context.config,
      account,
      collectWriteRecipients(normalizedInput),
      { disposition: normalizedInput.draft ? "draft" : "send" },
    );

    let forwardedSubject = target.stored.subject ?? "";
    let status: SendResultEnvelope["status"] = "sent";
    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: true });
    try {
      await openConversationForAction(
        session.page,
        target.locator,
        target.stored.subject ?? target.locator.internet_message_id ?? messageRef,
      );
      await session.page.locator('button[aria-label="Forward"]').first().click();
      await session.page.waitForTimeout(1_500);
      await fillRecipientField(session.page, "To", normalizedInput.to);
      await fillRecipientField(session.page, "Cc", normalizedInput.cc);
      await fillRecipientField(session.page, "Bcc", normalizedInput.bcc);
      await fillComposeBody(session.page, normalizedInput.body);
      forwardedSubject = await session.page.locator('input[aria-label="Subject"]').inputValue();
      status = await finalizeCurrentCompose(session.page, normalizedInput.draft ? "draft" : "send");
    } finally {
      await session.context.close();
      session.cleanup?.();
    }

    const resolved = await findResolvedSearchTarget(account, forwardedSubject, context);
    return buildSendEnvelope(
      account,
      "forward",
      status,
      forwardedSubject,
      recipientsFromStored(resolved.stored ?? undefined, normalizedInput),
      resolved,
      messageRef,
    );
  }

  async archive(
    account: MailAccount,
    messageRef: string,
    context: ProviderContext,
  ): Promise<ArchiveResultEnvelope> {
    const target = await resolveMessageActionTarget(account, messageRef, context);

    assertWriteAllowed(context.config, account, { to: [], cc: [], bcc: [] }, { disposition: "non_send" });

    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: true });
    try {
      await session.page.goto("https://outlook.office.com/mail/", {
        waitUntil: "domcontentloaded",
        timeout: context.config.providerTimeoutMs,
      });
      await waitForOutlookMailboxReady(session.page, context.config.providerTimeoutMs);
      let row = session.page.locator(`[role="option"][data-convid="${target.locator.conversation_id}"]`).first();
      if ((await row.count()) === 0) {
        row = session.page
          .locator('[role="option"]')
          .filter({ hasText: target.stored.subject ?? target.locator.internet_message_id ?? messageRef })
          .first();
      }
      await row.waitFor({ timeout: 15_000 });
      await row.click();
      await session.page.waitForTimeout(1_500);
      await session.page.locator('button[aria-label="Archive"]').first().click();
      await session.page.waitForTimeout(2_500);
    } finally {
      await session.context.close();
      session.cleanup?.();
    }

    context.db.markThreadArchived(target.stored.thread_ref);
    return buildArchiveEnvelope(account, messageRef, target.stored.thread_ref);
  }

  async downloadAttachment(
    account: MailAccount,
    messageRef: string,
    attachmentId: string,
    context: ProviderContext,
  ): Promise<AttachmentDownloadEnvelope> {
    const target = await resolveAttachmentDownloadTarget(account, messageRef, attachmentId, context);
    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: true });

    let savedTo: string | null = null;
    try {
      const capturedSession = await captureOutlookServiceSession(session.context, session.page, {
        timeoutMs: context.config.providerTimeoutMs,
      });
      const response = await session.context.request.get(
        buildOutlookRestAttachmentValueUrl(
          target.messageLocator.message_id!,
          target.attachmentLocator.attachment_id!,
        ),
        {
          headers: buildOutlookRestHeaders(capturedSession.headers),
          failOnStatusCode: false,
          timeout: context.config.providerTimeoutMs,
        },
      );

      if (!response.ok()) {
        throw new SurfaceError(
          "transport_error",
          `Outlook attachment download failed with status ${response.status()}.`,
          {
            account: account.name,
            messageRef,
            threadRef: target.stored.thread_ref,
          },
        );
      }

      const downloadDir = join(context.accountPaths.downloadsDir, messageRef);
      mkdirSync(downloadDir, { recursive: true });
      const filename = sanitizeAttachmentFilename(target.attachment.filename);
      savedTo = join(downloadDir, `${attachmentId}__${filename}`);
      writeFileSync(savedTo, await response.body());
    } finally {
      await session.context.close();
      session.cleanup?.();
    }

    context.db.updateAttachmentSavedTo(attachmentId, savedTo);
    return {
      schema_version: "1",
      command: "attachment-download",
      account: account.name,
      message_ref: messageRef,
      attachment: {
        attachment_id: attachmentId,
        filename: target.attachment.filename,
        mime_type: target.attachment.mime_type,
        size_bytes: target.attachment.size_bytes,
        inline: target.attachment.inline,
        saved_to: savedTo,
      },
    };
  }
}
