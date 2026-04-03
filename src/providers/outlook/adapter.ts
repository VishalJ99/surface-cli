import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MailAccount } from "../../contracts/account.js";
import type {
  AttachmentDownloadEnvelope,
  AttachmentListEnvelope,
  MessageEnvelope,
  MessageParticipant,
  NormalizedAttachmentRecord,
  NormalizedMessageRecord,
  FetchUnreadQuery,
  NormalizedThreadRecord,
  ReadResultEnvelope,
  SearchQuery,
  ThreadParticipant,
} from "../../contracts/mail.js";
import { SurfaceError, notImplemented } from "../../lib/errors.js";
import { makeAttachmentId, makeMessageRef, makeThreadRef } from "../../refs.js";
import { summarizeThread } from "../../summarizer.js";
import type { AuthStatus, MailProviderAdapter, ProviderContext } from "../types.js";
import { launchOutlookSession, probeOutlookAuth, promptForOutlookLogin } from "./session.js";
import {
  applySearchQuery,
  applyUnreadFilter,
  captureOutlookServiceSession,
  collectSearchConversationIds,
  collectUnreadConversationIds,
  fetchConversationBundle,
  type OutlookConversationItem,
  type OutlookThreadBundle,
} from "./extract.js";
import {
  buildOutlookInvite,
  mailboxFromExchange,
  mailboxesFromExchange,
  messageIdentity,
  normalizeOutlookBody,
  normalizeResponseObjects,
} from "./normalize.js";
import type { StoredMessageRecord } from "../../state/database.js";

function outlookProfileDir(context: ProviderContext): string {
  return join(context.accountPaths.authDir, "profile");
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
  const body = normalizeOutlookBody(item);
  const invite = buildOutlookInvite(item);
  const from = mailboxFromExchange((item.From as Record<string, unknown> | undefined) ?? null)
    ?? mailboxFromExchange((item.Sender as Record<string, unknown> | undefined) ?? null);
  const to = mailboxesFromExchange(item.ToRecipients as Array<Record<string, unknown>> | undefined);
  const cc = mailboxesFromExchange(item.CcRecipients as Array<Record<string, unknown>> | undefined);
  const messageId =
    typeof (item.ItemId as Record<string, unknown> | undefined)?.Id === "string"
      ? (item.ItemId as Record<string, unknown>).Id as string
      : undefined;
  const internetMessageId = typeof item.InternetMessageId === "string" ? item.InternetMessageId : undefined;
  const instanceKey = typeof item.InstanceKey === "string" ? item.InstanceKey : undefined;
  const key = messageProviderKey(entry, conversationId);
  const attachments = buildAttachments(entry, key);
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

  return {
    message_ref: "",
    envelope,
    snippet: typeof item.Preview === "string" ? item.Preview : body.text.slice(0, 240),
    body: {
      text: body.text,
      truncated: false,
      cached: true,
      cached_bytes: Buffer.byteLength(body.text, "utf8"),
    },
    attachments,
    ...(invite.is_invite
      ? {
          invite: {
            is_invite: invite.is_invite,
            rsvp_supported: invite.rsvp_supported,
            response_status: invite.response_status,
          },
        }
      : {}),
    ...(Object.keys(providerIds).length > 0 ? { provider_ids: providerIds } : {}),
    locator: {
      kind: "message",
      locator: {
        conversation_id: conversationId,
        message_id: messageId ?? null,
        internet_message_id: internetMessageId ?? null,
        instance_key: instanceKey ?? null,
        parent_internet_message_id: entry.nodeMetadata.parentInternetMessageId,
      },
    },
  };
}

function normalizeThread(bundle: OutlookThreadBundle): NormalizedThreadRecord {
  const messages = bundle.entries.map((entry) => normalizeMessage(entry, bundle.conversationId));
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
    invite: record.invite_json ? JSON.parse(record.invite_json) : undefined,
  };
}

function locatorValue(locator: NormalizedThreadRecord["locator"] | NormalizedMessageRecord["locator"], key: string): string {
  const value = locator?.locator[key];
  return typeof value === "string" ? value : "";
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

async function maybeSummarizeThreads(
  threads: NormalizedThreadRecord[],
  context: ProviderContext,
): Promise<NormalizedThreadRecord[]> {
  if (context.config.summarizerBackend === "none") {
    return threads;
  }

  const summarized: NormalizedThreadRecord[] = [];
  for (const thread of threads) {
    const summary = await summarizeThread(thread, context.config);
    summarized.push({
      ...thread,
      summary,
    });
  }
  return summarized;
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

async function fetchOutlookThreads(
  account: MailAccount,
  context: ProviderContext,
  options: { kind: "search" | "fetch-unread"; queryText?: string; limit: number },
): Promise<NormalizedThreadRecord[]> {
  const profileDir = outlookProfileDir(context);
  if (!existsSync(profileDir)) {
    throw new SurfaceError("reauth_required", "Outlook profile directory is missing for this account.", {
      account: account.name,
    });
  }

  const session = await launchOutlookSession(profileDir, { headless: true });
  try {
    const { context: browserContext, page } = session;
    const capturedSession = await captureOutlookServiceSession(browserContext, page, {
      timeoutMs: context.config.providerTimeoutMs,
    });

    let conversationIds: string[];
    if (options.kind === "fetch-unread") {
      await applyUnreadFilter(page);
      conversationIds = await collectUnreadConversationIds(page, options.limit);
    } else {
      await applySearchQuery(page, options.queryText ?? "");
      conversationIds = await collectSearchConversationIds(page, options.limit);
    }

    const bundles: OutlookThreadBundle[] = [];
    for (const conversationId of conversationIds) {
      bundles.push(await fetchConversationBundle(browserContext.request, capturedSession, conversationId));
    }

    const normalized = bundles.map((bundle) => normalizeThread(bundle));
    const summarized = await maybeSummarizeThreads(normalized, context);
    return await persistThreads(account, context, summarized);
  } finally {
    await session.context.close();
    session.cleanup?.();
  }
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
    return fetchOutlookThreads(account, context, {
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
    return fetchOutlookThreads(account, context, {
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

    const locatorRow = context.db.findProviderLocator("message", messageRef);
    if (!locatorRow) {
      if (hasReadableCache) {
        return buildReadEnvelope(account, messageRef, stored.thread_ref, parseStoredMessage(stored), attachments, "hit");
      }
      throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
        account: account.name,
        messageRef,
      });
    }

    const locator = JSON.parse(locatorRow.locator_json) as Record<string, string | null>;
    const conversationId = typeof locator.conversation_id === "string" ? locator.conversation_id : "";
    if (!conversationId) {
      throw new SurfaceError("transport_error", `Message '${messageRef}' is missing an Outlook conversation id.`, {
        account: account.name,
        messageRef,
      });
    }

    const profileDir = outlookProfileDir(context);
    const session = await launchOutlookSession(profileDir, { headless: true });
    try {
      const capturedSession = await captureOutlookServiceSession(session.context, session.page, {
        timeoutMs: context.config.providerTimeoutMs,
      });
      const bundle = await fetchConversationBundle(session.context.request, capturedSession, conversationId);
      const normalizedThread = normalizeThread(bundle);
      await persistThreads(account, context, [normalizedThread]);
    } finally {
      await session.context.close();
      session.cleanup?.();
    }

    const refreshed = context.db.getStoredMessage(messageRef);
    if (!refreshed) {
      throw new SurfaceError("not_found", `Message '${messageRef}' could not be refreshed from Outlook.`, {
        account: account.name,
        messageRef,
      });
    }

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

  async downloadAttachment(account: MailAccount): Promise<AttachmentDownloadEnvelope> {
    notImplemented("Outlook attachment download is not wired yet.", account.name);
  }
}
