import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ImapFlow,
  type FetchMessageObject,
  type ListResponse,
  type MailboxObject,
  type SearchObject,
} from "imapflow";
import {
  simpleParser,
  type AddressObject,
  type Attachment,
  type EmailAddress,
  type ParsedMail,
} from "mailparser";

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
  SentMessageResult,
  SentQuery,
  ThreadParticipant,
} from "../../contracts/mail.js";
import { SurfaceError, notImplemented } from "../../lib/errors.js";
import { toPublicSentMessage } from "../../lib/public-mail.js";
import { messageMatchesRecipient, normalizeComparableEmail, sentMessagesFromStoredThread } from "../../lib/sent-mail.js";
import { assertWriteAllowed } from "../../lib/write-safety.js";
import { makeAttachmentId, makeMessageRef, makeThreadRef } from "../../refs.js";
import { summarizeAndPersistThreads } from "../../summarizer.js";
import type { StoredMessageRecord } from "../../state/database.js";
import type { AuthStatus, MailProviderAdapter, ProviderContext } from "../types.js";
import { htmlToText } from "../shared/html.js";
import { annotateBodyWithInlineAttachments } from "../shared/inline-attachments.js";
import { clearImapSmtpAuthState, readImapSmtpAuthState, writeImapSmtpAuthState } from "./auth.js";

const DEFAULT_MAILBOX = "INBOX";
const MAX_FETCH_BATCH = 25;
const ARCHIVE_RECOVERY_SCAN_LIMIT = 100;

interface ImapMessageLocator {
  [key: string]: string | number | null;
  mailbox: string;
  uid_validity: string;
  uid: number;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
}

interface ImapThreadLocator {
  [key: string]: string | number | null;
  mailbox: string;
  uid_validity: string;
  uid: number;
}

interface ImapAttachmentLocator {
  [key: string]: string | number | null;
  mailbox: string;
  uid_validity: string;
  uid: number;
  index: number;
  checksum: string | null;
  filename: string | null;
}

function sourceInfo(account: MailAccount) {
  return {
    provider: account.provider,
    transport: account.transport,
  } as const;
}

function securityOptions(mode: "tls" | "starttls" | "none"): Pick<ConstructorParameters<typeof ImapFlow>[0], "secure" | "doSTARTTLS"> {
  switch (mode) {
    case "tls":
      return { secure: true };
    case "starttls":
      return { secure: false, doSTARTTLS: true };
    case "none":
      return { secure: false, doSTARTTLS: false };
  }
}

async function withImapClient<T>(
  account: MailAccount,
  context: ProviderContext,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const state = readImapSmtpAuthState(account, context);
  const client = new ImapFlow({
    host: state.imap.host,
    port: state.imap.port,
    ...securityOptions(state.imap.security),
    auth: {
      user: state.username,
      pass: state.password,
    },
    connectionTimeout: context.config.providerTimeoutMs,
    greetingTimeout: context.config.providerTimeoutMs,
    socketTimeout: context.config.providerTimeoutMs,
    disableAutoIdle: true,
    logger: false,
  });

  try {
    await client.connect();
    return await work(client);
  } finally {
    try {
      if (client.usable) {
        await client.logout();
      } else {
        client.close();
      }
    } catch {
      client.close();
    }
  }
}

function normalizeMailboxAlias(value: string | undefined): string {
  const normalized = (value ?? "inbox").trim().toLowerCase();
  if (!normalized) {
    return "inbox";
  }
  switch (normalized) {
    case "inbox":
      return "inbox";
    case "sent":
    case "sent-mail":
    case "sent mail":
    case "sent items":
      return "sent";
    case "archive":
    case "archives":
    case "all mail":
      return "archive";
    case "draft":
    case "drafts":
      return "drafts";
    case "trash":
    case "bin":
    case "deleted":
    case "deleted items":
      return "trash";
    case "spam":
    case "junk":
    case "junk mail":
      return "spam";
    default:
      return value?.trim() ?? DEFAULT_MAILBOX;
  }
}

function specialUseMatches(mailbox: ListResponse, expected: string): boolean {
  return mailbox.specialUse?.trim().toLowerCase() === expected.toLowerCase();
}

function mailboxNameMatches(mailbox: ListResponse, names: string[]): boolean {
  const candidates = [mailbox.path, mailbox.name].map((entry) => entry.trim().toLowerCase());
  return names.some((name) => candidates.includes(name.trim().toLowerCase()));
}

function mailboxLabel(mailbox: string): string {
  const normalized = mailbox.trim().toLowerCase();
  switch (normalized) {
    case "inbox":
      return "inbox";
    case "sent":
    case "sent mail":
    case "sent items":
      return "sent";
    case "archive":
    case "archives":
    case "all mail":
      return "archive";
    case "draft":
    case "drafts":
      return "drafts";
    case "trash":
    case "bin":
    case "deleted items":
      return "trash";
    case "spam":
    case "junk":
    case "junk mail":
      return "spam";
    default:
      return normalized || "inbox";
  }
}

function resolveMailboxPath(mailboxes: ListResponse[], requested: string | undefined): string {
  const alias = normalizeMailboxAlias(requested);
  const specialUsesByAlias: Record<string, string[]> = {
    inbox: ["\\Inbox"],
    sent: ["\\Sent"],
    archive: ["\\Archive", "\\All"],
    drafts: ["\\Drafts"],
    trash: ["\\Trash"],
    spam: ["\\Junk"],
  };
  const namesByAlias: Record<string, string[]> = {
    inbox: ["inbox"],
    sent: ["sent", "sent mail", "sent items"],
    archive: ["archive", "archives", "all mail"],
    drafts: ["draft", "drafts"],
    trash: ["trash", "bin", "deleted", "deleted items"],
    spam: ["spam", "junk", "junk mail"],
  };

  const specialUses = specialUsesByAlias[alias];
  if (specialUses) {
    const matched = mailboxes.find((mailbox) =>
      specialUses.some((specialUse) => specialUseMatches(mailbox, specialUse)));
    if (matched) {
      return matched.path;
    }
  }

  const names = namesByAlias[alias];
  if (names) {
    const matched = mailboxes.find((mailbox) => mailboxNameMatches(mailbox, names));
    if (matched) {
      return matched.path;
    }
  }

  const exact = mailboxes.find((mailbox) => mailbox.path.trim().toLowerCase() === alias.trim().toLowerCase());
  if (exact) {
    return exact.path;
  }

  return alias === "inbox" ? DEFAULT_MAILBOX : alias;
}

function imapThreadProviderKey(locator: ImapThreadLocator): string {
  return `imap-thread:${locator.mailbox}:${locator.uid_validity}:${locator.uid}`;
}

function imapMessageProviderKey(locator: ImapMessageLocator): string {
  return `imap-message:${locator.mailbox}:${locator.uid_validity}:${locator.uid}`;
}

function imapAttachmentProviderKey(messageLocator: ImapMessageLocator, attachment: NormalizedAttachmentRecord, index: number): string {
  const checksum = attachment.locator?.locator.checksum;
  if (typeof checksum === "string" && checksum) {
    return `imap-attachment:${messageLocator.mailbox}:${messageLocator.uid_validity}:${messageLocator.uid}:${checksum}`;
  }
  return `imap-attachment:${messageLocator.mailbox}:${messageLocator.uid_validity}:${messageLocator.uid}:${attachment.filename}:${index}`;
}

function parseThreadLocator(locatorJson: string): ImapThreadLocator {
  const parsed = JSON.parse(locatorJson) as Record<string, unknown>;
  return {
    mailbox: typeof parsed.mailbox === "string" && parsed.mailbox ? parsed.mailbox : DEFAULT_MAILBOX,
    uid_validity: typeof parsed.uid_validity === "string" && parsed.uid_validity ? parsed.uid_validity : "",
    uid: typeof parsed.uid === "number" ? parsed.uid : 0,
  };
}

function parseMessageLocator(locatorJson: string): ImapMessageLocator {
  const parsed = JSON.parse(locatorJson) as Record<string, unknown>;
  return {
    mailbox: typeof parsed.mailbox === "string" && parsed.mailbox ? parsed.mailbox : DEFAULT_MAILBOX,
    uid_validity: typeof parsed.uid_validity === "string" && parsed.uid_validity ? parsed.uid_validity : "",
    uid: typeof parsed.uid === "number" ? parsed.uid : 0,
    message_id: typeof parsed.message_id === "string" && parsed.message_id ? parsed.message_id : null,
    in_reply_to: typeof parsed.in_reply_to === "string" && parsed.in_reply_to ? parsed.in_reply_to : null,
    references: typeof parsed.references === "string" && parsed.references ? parsed.references : null,
  };
}

function parseAttachmentLocator(locatorJson: string): ImapAttachmentLocator {
  const parsed = JSON.parse(locatorJson) as Record<string, unknown>;
  return {
    mailbox: typeof parsed.mailbox === "string" && parsed.mailbox ? parsed.mailbox : DEFAULT_MAILBOX,
    uid_validity: typeof parsed.uid_validity === "string" && parsed.uid_validity ? parsed.uid_validity : "",
    uid: typeof parsed.uid === "number" ? parsed.uid : 0,
    index: typeof parsed.index === "number" ? parsed.index : -1,
    checksum: typeof parsed.checksum === "string" && parsed.checksum ? parsed.checksum : null,
    filename: typeof parsed.filename === "string" && parsed.filename ? parsed.filename : null,
  };
}

function uidValidityString(mailbox: MailboxObject): string {
  return mailbox.uidValidity.toString();
}

function participantFromAddress(address: EmailAddress | undefined): MessageParticipant {
  return {
    name: address?.name ?? address?.address ?? "",
    email: address?.address ?? "",
  };
}

function addressesFromObject(value: AddressObject | AddressObject[] | undefined): MessageParticipant[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((entry) => entry.value.map(participantFromAddress));
}

function firstAddressFromObject(value: AddressObject | undefined): MessageParticipant | null {
  const first = value?.value[0];
  if (!first) {
    return null;
  }
  return participantFromAddress(first);
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

function flagsToLabels(mailbox: string, flags: Set<string> | undefined): string[] {
  const labels = new Set<string>([mailboxLabel(mailbox)]);
  if (!flags?.has("\\Seen")) {
    labels.add("unread");
  }
  if (flags?.has("\\Flagged")) {
    labels.add("flagged");
  }
  if (flags?.has("\\Answered")) {
    labels.add("answered");
  }
  if (flags?.has("\\Draft")) {
    labels.add("draft");
  }
  return [...labels];
}

function referencesToString(value: string[] | string | undefined): string | null {
  if (Array.isArray(value)) {
    const joined = value.filter(Boolean).join(" ").trim();
    return joined || null;
  }
  return value?.trim() || null;
}

function messageBodyText(parsed: ParsedMail): string {
  const text = parsed.text?.replace(/\r\n/g, "\n").trim();
  if (text) {
    return text;
  }
  if (typeof parsed.html === "string") {
    return htmlToText(parsed.html);
  }
  return "";
}

function snippetFromBody(bodyText: string, fallback: string | undefined): string {
  const normalized = bodyText.replace(/\s+/gu, " ").trim();
  return (normalized || fallback || "").slice(0, 240);
}

function normalizeAttachment(
  attachment: Attachment,
  messageLocator: ImapMessageLocator,
  index: number,
): NormalizedAttachmentRecord {
  const filename = attachment.filename?.trim() || `attachment-${index + 1}`;
  return {
    attachment_id: "",
    filename,
    mime_type: attachment.contentType || "application/octet-stream",
    size_bytes: typeof attachment.size === "number" ? attachment.size : null,
    inline: attachment.contentDisposition?.toLowerCase() === "inline" || attachment.related === true,
    locator: {
      kind: "attachment",
      locator: {
        mailbox: messageLocator.mailbox,
        uid_validity: messageLocator.uid_validity,
        uid: messageLocator.uid,
        index,
        checksum: attachment.checksum || null,
        filename,
      },
    },
  };
}

async function normalizeFetchedMessage(
  account: MailAccount,
  mailboxPath: string,
  uidValidity: string,
  fetched: FetchMessageObject,
): Promise<NormalizedThreadRecord> {
  if (!fetched.source) {
    throw new SurfaceError("transport_error", "IMAP fetch did not return message source.", {
      account: account.name,
    });
  }

  const parsed = await simpleParser(fetched.source);
  const messageLocator: ImapMessageLocator = {
    mailbox: mailboxPath,
    uid_validity: uidValidity,
    uid: fetched.uid,
    message_id: parsed.messageId ?? fetched.envelope?.messageId ?? null,
    in_reply_to: parsed.inReplyTo ?? fetched.envelope?.inReplyTo ?? null,
    references: referencesToString(parsed.references),
  };
  const threadLocator: ImapThreadLocator = {
    mailbox: mailboxPath,
    uid_validity: uidValidity,
    uid: fetched.uid,
  };

  const bodyWithoutInlineMarkers = messageBodyText(parsed);
  const attachments = parsed.attachments.map((attachment, index) => normalizeAttachment(attachment, messageLocator, index));
  const bodyText = annotateBodyWithInlineAttachments(bodyWithoutInlineMarkers, attachments);
  const sentAt = parsed.date?.toISOString() ?? dateToIso(fetched.envelope?.date) ?? dateToIso(fetched.internalDate);
  const receivedAt = dateToIso(fetched.internalDate) ?? sentAt;
  const subject = parsed.subject ?? fetched.envelope?.subject ?? "";
  const unread = !fetched.flags?.has("\\Seen");
  const labels = flagsToLabels(mailboxPath, fetched.flags);
  const envelope: MessageEnvelope = {
    from: firstAddressFromObject(parsed.from),
    to: addressesFromObject(parsed.to),
    cc: addressesFromObject(parsed.cc),
    sent_at: sentAt,
    received_at: receivedAt,
    unread,
    ...(subject ? { subject } : {}),
  };

  const message: NormalizedMessageRecord = {
    message_ref: "",
    envelope,
    snippet: snippetFromBody(bodyText, fetched.envelope?.subject),
    body: {
      text: bodyText,
      truncated: false,
      cached: true,
      cached_bytes: Buffer.byteLength(bodyText, "utf8"),
    },
    attachments,
    provider_ids: {
      message_id: `${mailboxPath}:${uidValidity}:${fetched.uid}`,
      ...(messageLocator.message_id ? { internet_message_id: messageLocator.message_id } : {}),
    },
    locator: {
      kind: "message",
      locator: messageLocator,
    },
  };

  return {
    thread_ref: "",
    source: sourceInfo(account),
    envelope: {
      subject,
      participants: uniqueParticipants([envelope]),
      mailbox: mailboxLabel(mailboxPath),
      labels,
      received_at: receivedAt,
      message_count: 1,
      unread_count: unread ? 1 : 0,
      has_attachments: attachments.length > 0,
    },
    summary: null,
    messages: [message],
    provider_ids: {
      thread_id: `${mailboxPath}:${uidValidity}:${fetched.uid}`,
    },
    locator: {
      kind: "thread",
      locator: threadLocator,
    },
  };
}

function dateToIso(value: Date | string | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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

function buildArchiveEnvelope(account: MailAccount, messageRef: string, threadRef: string): ArchiveResultEnvelope {
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

interface PersistThreadOverrides {
  threadRefsByProviderKey?: Map<string, string>;
  messageRefsByProviderKey?: Map<string, string>;
  attachmentRefsByProviderKey?: Map<string, string>;
}

function persistThreads(
  account: MailAccount,
  context: ProviderContext,
  threads: NormalizedThreadRecord[],
  overrides: PersistThreadOverrides = {},
): NormalizedThreadRecord[] {
  return context.db.transaction(() => {
    const persistedThreads: NormalizedThreadRecord[] = [];

    for (const thread of threads) {
      const threadLocator = thread.locator?.locator as ImapThreadLocator | undefined;
      if (!threadLocator?.uid || !threadLocator.uid_validity) {
        throw new SurfaceError("transport_error", "IMAP thread is missing UID locator data.", {
          account: account.name,
        });
      }

      const threadProviderKey = imapThreadProviderKey(threadLocator);
      const resolvedThreadRef =
        overrides.threadRefsByProviderKey?.get(threadProviderKey)
        ?? context.db.findEntityRefByProviderKey("thread", account.account_id, threadProviderKey)
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
        provider_key: threadProviderKey,
        locator_json: JSON.stringify(threadLocator),
      });

      const persistedMessages: NormalizedMessageRecord[] = [];
      const messageRefs: string[] = [];
      for (const message of thread.messages) {
        const messageLocator = message.locator?.locator as ImapMessageLocator | undefined;
        if (!messageLocator?.uid || !messageLocator.uid_validity) {
          throw new SurfaceError("transport_error", "IMAP message is missing UID locator data.", {
            account: account.name,
            threadRef: resolvedThreadRef,
          });
        }

        const messageProviderKey = imapMessageProviderKey(messageLocator);
        const resolvedMessageRef =
          overrides.messageRefsByProviderKey?.get(messageProviderKey)
          ?? context.db.findEntityRefByProviderKey("message", account.account_id, messageProviderKey)
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
          provider_key: messageProviderKey,
          locator_json: JSON.stringify(messageLocator),
        });

        const persistedAttachments: NormalizedAttachmentRecord[] = [];
        for (const [index, attachment] of message.attachments.entries()) {
          const providerKey = imapAttachmentProviderKey(messageLocator, attachment, index);
          const resolvedAttachmentId =
            overrides.attachmentRefsByProviderKey?.get(providerKey)
            ?? context.db.findEntityRefByProviderKey("attachment", account.account_id, providerKey)
            ?? makeAttachmentId();
          const attachmentLocator = attachment.locator?.locator as ImapAttachmentLocator | undefined;
          context.db.upsertProviderLocator({
            entity_kind: "attachment",
            entity_ref: resolvedAttachmentId,
            account_id: account.account_id,
            provider_key: providerKey,
            locator_json: JSON.stringify(attachmentLocator ?? {}),
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

      persistedThreads.push({
        ...thread,
        thread_ref: resolvedThreadRef,
        messages: persistedMessages,
      });
    }

    return persistedThreads;
  });
}

async function fetchUidThreads(
  account: MailAccount,
  client: ImapFlow,
  mailboxPath: string,
  uids: number[],
): Promise<NormalizedThreadRecord[]> {
  if (uids.length === 0) {
    return [];
  }
  const mailbox = await client.mailboxOpen(mailboxPath);
  const uidValidity = uidValidityString(mailbox);
  const threads: NormalizedThreadRecord[] = [];
  const batches: number[][] = [];
  for (let index = 0; index < uids.length; index += MAX_FETCH_BATCH) {
    batches.push(uids.slice(index, index + MAX_FETCH_BATCH));
  }

  for (const batch of batches) {
    for await (const fetched of client.fetch(batch, {
      source: true,
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      threadId: true,
    }, { uid: true })) {
      threads.push(await normalizeFetchedMessage(account, mailboxPath, uidValidity, fetched));
    }
  }

  return threads.sort((left, right) =>
    Date.parse(right.envelope.received_at ?? "") - Date.parse(left.envelope.received_at ?? ""),
  );
}

function sameIsoInstant(left: string | null, right: string | null): boolean {
  if (!left || !right) {
    return false;
  }
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    return left === right;
  }
  return Math.abs(leftMs - rightMs) <= 1000;
}

function archivedThreadMatchesStoredMessage(
  stored: StoredMessageRecord,
  sourceLocator: ImapMessageLocator,
  thread: NormalizedThreadRecord,
): boolean {
  const message = thread.messages[0];
  const messageLocator = message?.locator?.locator as ImapMessageLocator | undefined;
  if (!message || !messageLocator) {
    return false;
  }

  if (sourceLocator.message_id && messageLocator.message_id === sourceLocator.message_id) {
    return true;
  }

  if ((stored.subject ?? "") !== (message.envelope.subject ?? "")) {
    return false;
  }
  if (normalizeComparableEmail(stored.from_email) !== normalizeComparableEmail(message.envelope.from?.email)) {
    return false;
  }

  const sentAtMatches = sameIsoInstant(stored.sent_at, message.envelope.sent_at);
  const receivedAtMatches = sameIsoInstant(stored.received_at, message.envelope.received_at);
  return sentAtMatches || receivedAtMatches || stored.snippet === message.snippet;
}

async function recoverArchivedThreadAfterMove(
  account: MailAccount,
  client: ImapFlow,
  archivePath: string,
  stored: StoredMessageRecord,
  sourceLocator: ImapMessageLocator,
  movedUid: number | undefined,
): Promise<NormalizedThreadRecord | null> {
  if (movedUid) {
    const [movedThread] = await fetchUidThreads(account, client, archivePath, [movedUid]);
    return movedThread ?? null;
  }

  if (sourceLocator.message_id) {
    await client.mailboxOpen(archivePath);
    const matches = await client.search({ header: { "message-id": sourceLocator.message_id } }, { uid: true });
    const uids = Array.isArray(matches) ? matches.slice(-ARCHIVE_RECOVERY_SCAN_LIMIT).reverse() : [];
    const threads = await fetchUidThreads(account, client, archivePath, uids);
    const matched = threads.find((thread) => archivedThreadMatchesStoredMessage(stored, sourceLocator, thread));
    if (matched) {
      return matched;
    }
  }

  await client.mailboxOpen(archivePath);
  const all = await client.search({ all: true }, { uid: true });
  const recentUids = Array.isArray(all) ? all.slice(-ARCHIVE_RECOVERY_SCAN_LIMIT).reverse() : [];
  const recentThreads = await fetchUidThreads(account, client, archivePath, recentUids);
  return recentThreads.find((thread) => archivedThreadMatchesStoredMessage(stored, sourceLocator, thread)) ?? null;
}

function buildSearchObject(query: SearchQuery): SearchObject {
  const search: SearchObject = { all: true };
  if (query.text?.trim()) {
    search.text = query.text.trim();
  }
  if (query.from?.trim()) {
    search.from = query.from.trim();
  }
  if (query.subject?.trim()) {
    search.subject = query.subject.trim();
  }
  if (query.unread_only || query.labels?.some((label) => label.trim().toLowerCase() === "unread")) {
    search.seen = false;
  }
  if (query.labels?.some((label) => ["read", "seen"].includes(label.trim().toLowerCase()))) {
    search.seen = true;
  }
  if (query.labels?.some((label) => label.trim().toLowerCase() === "flagged")) {
    search.flagged = true;
  }
  return search;
}

function buildSentSearch(query: SentQuery): { search: SearchObject; fetchLimit: number } {
  const search: SearchObject = { all: true };
  const fetchLimit = query.recipient?.trim() ? Math.min(Math.max(query.limit * 5, query.limit), 100) : query.limit;
  if (query.recipient?.trim()) {
    search.or = [
      { to: query.recipient.trim() },
      { cc: query.recipient.trim() },
    ];
  }
  return { search, fetchLimit };
}

function filterSentMessagesForQuery(messages: SentMessageResult[], query: SentQuery): SentMessageResult[] {
  return messages
    .filter((message) => messageMatchesRecipient(message, query.recipient))
    .slice(0, query.limit);
}

function threadMatchesLabels(thread: NormalizedThreadRecord, labels: string[] | undefined): boolean {
  if ((labels?.length ?? 0) === 0) {
    return true;
  }
  const available = new Set(thread.envelope.labels.map((label) => label.trim().toLowerCase()));
  return labels?.every((label) => available.has(label.trim().toLowerCase())) ?? true;
}

async function searchMailbox(
  account: MailAccount,
  context: ProviderContext,
  query: SearchQuery,
): Promise<NormalizedThreadRecord[]> {
  return withImapClient(account, context, async (client) => {
    const mailboxes = await client.list();
    const mailboxPath = resolveMailboxPath(mailboxes, query.mailbox);
    await client.mailboxOpen(mailboxPath);
    const matches = await client.search(buildSearchObject(query), { uid: true });
    const uids = Array.isArray(matches) ? matches.slice(-query.limit).reverse() : [];
    const normalized = await fetchUidThreads(account, client, mailboxPath, uids);
    const persisted = persistThreads(account, context, normalized.filter((thread) => threadMatchesLabels(thread, query.labels)));
    return summarizeAndPersistThreads(persisted, context.config, context.db, context.db.getAccountIdentity(account));
  });
}

async function fetchUnreadMailbox(
  account: MailAccount,
  context: ProviderContext,
  query: FetchUnreadQuery,
): Promise<NormalizedThreadRecord[]> {
  return withImapClient(account, context, async (client) => {
    const mailboxPath = resolveMailboxPath(await client.list(), "inbox");
    await client.mailboxOpen(mailboxPath);
    const matches = await client.search({ seen: false }, { uid: true });
    const uids = Array.isArray(matches) ? matches.slice(-query.limit).reverse() : [];
    const normalized = await fetchUidThreads(account, client, mailboxPath, uids);
    const persisted = persistThreads(account, context, normalized);
    return summarizeAndPersistThreads(persisted, context.config, context.db, context.db.getAccountIdentity(account));
  });
}

async function refreshUidThread(
  account: MailAccount,
  context: ProviderContext,
  locator: ImapThreadLocator | ImapMessageLocator,
): Promise<NormalizedThreadRecord | null> {
  return withImapClient(account, context, async (client) => {
    const mailbox = await client.mailboxOpen(locator.mailbox);
    if (uidValidityString(mailbox) !== locator.uid_validity) {
      throw new SurfaceError("cache_miss", `IMAP UIDVALIDITY changed for mailbox '${locator.mailbox}'.`, {
        account: account.name,
      });
    }
    const fetched = await client.fetchOne(String(locator.uid), {
      source: true,
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      threadId: true,
    }, { uid: true });
    if (!fetched) {
      return null;
    }
    const normalized = await normalizeFetchedMessage(account, locator.mailbox, locator.uid_validity, fetched);
    const [persisted] = persistThreads(account, context, [normalized]);
    if (persisted) {
      const [summarized] = await summarizeAndPersistThreads([persisted], context.config, context.db, context.db.getAccountIdentity(account));
      return summarized ?? persisted;
    }
    return null;
  });
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

  const locator = parseMessageLocator(locatorRow.locator_json);
  const refreshed = await refreshUidThread(account, context, locator);
  if (!refreshed) {
    throw new SurfaceError("not_found", `Message '${messageRef}' could not be refreshed from IMAP.`, {
      account: account.name,
      messageRef,
    });
  }
  const stored = context.db.getStoredMessage(messageRef);
  if (!stored) {
    throw new SurfaceError("not_found", `Message '${messageRef}' was not found after IMAP refresh.`, {
      account: account.name,
      messageRef,
    });
  }
  return stored;
}

function requireMessageForAccount(account: MailAccount, messageRef: string, context: ProviderContext): StoredMessageRecord {
  const stored = context.db.getStoredMessage(messageRef);
  if (!stored) {
    throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
      account: account.name,
      messageRef,
    });
  }
  if (stored.account_id !== account.account_id) {
    throw new SurfaceError("invalid_argument", `Message '${messageRef}' does not belong to account '${account.name}'.`, {
      account: account.name,
      messageRef,
      threadRef: stored.thread_ref,
    });
  }
  return stored;
}

function attachmentMetas(context: ProviderContext, messageRef: string): AttachmentListEnvelope["attachments"] {
  return context.db.listAttachmentsForMessage(messageRef).map((attachment) => ({
    attachment_id: attachment.attachment_id,
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
    inline: Boolean(attachment.inline),
  }));
}

function attachmentIdentityKeys(locator: ImapAttachmentLocator): string[] {
  const keys: string[] = [];
  if (locator.checksum) {
    keys.push(`checksum:${locator.checksum}`);
  }
  keys.push(`position:${locator.index}:${(locator.filename ?? "").trim().toLowerCase()}`);
  return keys;
}

function buildAttachmentRefOverrides(
  context: ProviderContext,
  messageRef: string,
  messageLocator: ImapMessageLocator,
  attachments: NormalizedAttachmentRecord[],
): Map<string, string> {
  const existingRefsByIdentity = new Map<string, string>();
  for (const existing of context.db.listAttachmentsForMessage(messageRef)) {
    const locatorRow = context.db.findProviderLocator("attachment", existing.attachment_id);
    if (!locatorRow) {
      continue;
    }
    const existingLocator = parseAttachmentLocator(locatorRow.locator_json);
    for (const key of attachmentIdentityKeys(existingLocator)) {
      existingRefsByIdentity.set(key, existing.attachment_id);
    }
  }

  const refsByProviderKey = new Map<string, string>();
  for (const [index, attachment] of attachments.entries()) {
    const providerKey = imapAttachmentProviderKey(messageLocator, attachment, index);
    const attachmentLocator = attachment.locator?.locator as ImapAttachmentLocator | undefined;
    if (!attachmentLocator) {
      continue;
    }
    const existingRef = attachmentIdentityKeys(attachmentLocator)
      .map((key) => existingRefsByIdentity.get(key))
      .find((ref): ref is string => Boolean(ref));
    if (existingRef) {
      refsByProviderKey.set(providerKey, existingRef);
    }
  }

  return refsByProviderKey;
}

async function fetchSentMessages(
  account: MailAccount,
  context: ProviderContext,
  query: SentQuery,
): Promise<SentMessageResult[]> {
  if (query.thread_ref) {
    const locatorRow = context.db.findProviderLocator("thread", query.thread_ref);
    if (locatorRow) {
      await refreshUidThread(account, context, parseThreadLocator(locatorRow.locator_json));
    }
    return sentMessagesFromStoredThread(account, context, query);
  }

  return withImapClient(account, context, async (client) => {
    const mailboxes = await client.list();
    const sentPath = resolveMailboxPath(mailboxes, "sent");
    await client.mailboxOpen(sentPath);
    const { search, fetchLimit } = buildSentSearch(query);
    const matches = await client.search(search, { uid: true });
    const uids = Array.isArray(matches) ? matches.slice(-fetchLimit).reverse() : [];
    const normalized = await fetchUidThreads(account, client, sentPath, uids);
    const persisted = persistThreads(account, context, normalized);
    const summarized = await summarizeAndPersistThreads(persisted, context.config, context.db, context.db.getAccountIdentity(account));
    return filterSentMessagesForQuery(
      summarized.flatMap((thread) => thread.messages.map((message) => toPublicSentMessage(thread, message))),
      query,
    );
  });
}

function sanitizeAttachmentFilename(filename: string): string {
  const sanitized = filename.replace(/[\\/:*?"<>|\u0000-\u001F]/gu, "_").trim();
  return sanitized || "attachment";
}

async function readMessageSource(
  account: MailAccount,
  context: ProviderContext,
  locator: ImapMessageLocator,
): Promise<Buffer> {
  return withImapClient(account, context, async (client) => {
    const mailbox = await client.mailboxOpen(locator.mailbox);
    if (uidValidityString(mailbox) !== locator.uid_validity) {
      throw new SurfaceError("cache_miss", `IMAP UIDVALIDITY changed for mailbox '${locator.mailbox}'.`, {
        account: account.name,
      });
    }
    const fetched = await client.fetchOne(String(locator.uid), { source: true }, { uid: true });
    if (!fetched || !fetched.source) {
      throw new SurfaceError("not_found", `IMAP message '${locator.uid}' was not found in '${locator.mailbox}'.`, {
        account: account.name,
      });
    }
    return fetched.source;
  });
}

async function mutateSeenFlag(
  account: MailAccount,
  context: ProviderContext,
  messageRefs: string[],
  unread: boolean,
): Promise<MarkMessagesResultEnvelope["updated"]> {
  const updated: MarkMessagesResultEnvelope["updated"] = [];
  const touchedThreads = new Set<string>();

  await withImapClient(account, context, async (client) => {
    const targets = messageRefs.map((messageRef) => {
      const stored = requireMessageForAccount(account, messageRef, context);
      const locatorRow = context.db.findProviderLocator("message", messageRef);
      if (!locatorRow) {
        throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
          account: account.name,
          messageRef,
          threadRef: stored.thread_ref,
        });
      }
      return { messageRef, stored, locator: parseMessageLocator(locatorRow.locator_json) };
    });

    const byMailbox = new Map<string, typeof targets>();
    for (const target of targets) {
      byMailbox.set(target.locator.mailbox, [...(byMailbox.get(target.locator.mailbox) ?? []), target]);
    }

    for (const [mailboxPath, mailboxTargets] of byMailbox) {
      const mailbox = await client.mailboxOpen(mailboxPath);
      for (const target of mailboxTargets) {
        if (uidValidityString(mailbox) !== target.locator.uid_validity) {
          throw new SurfaceError("cache_miss", `IMAP UIDVALIDITY changed for mailbox '${mailboxPath}'.`, {
            account: account.name,
            messageRef: target.messageRef,
            threadRef: target.stored.thread_ref,
          });
        }
      }
      const uids = mailboxTargets.map((target) => target.locator.uid);
      if (unread) {
        await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      }
      for (const target of mailboxTargets) {
        updated.push({
          message_ref: target.messageRef,
          thread_ref: target.stored.thread_ref,
          unread,
        });
        touchedThreads.add(target.stored.thread_ref);
      }
    }
  });

  context.db.updateMessagesUnreadState(messageRefs, unread);
  context.db.recomputeThreadUnreadCounts([...touchedThreads]);
  return updated;
}

export const imapAdapterTestHooks = {
  archivedThreadMatchesStoredMessage,
  buildSentSearch,
  filterSentMessagesForQuery,
  resolveMailboxPath,
};

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
    query: SearchQuery,
    context: ProviderContext,
  ): Promise<NormalizedThreadRecord[]> {
    return searchMailbox(account, context, query);
  }

  async fetchUnread(
    account: MailAccount,
    query: FetchUnreadQuery,
    context: ProviderContext,
  ): Promise<NormalizedThreadRecord[]> {
    return fetchUnreadMailbox(account, context, query);
  }

  async fetchSent(
    account: MailAccount,
    query: SentQuery,
    context: ProviderContext,
  ): Promise<SentMessageResult[]> {
    return fetchSentMessages(account, context, query);
  }

  async refreshThread(account: MailAccount, threadRef: string, context: ProviderContext): Promise<void> {
    const locatorRow = context.db.findProviderLocator("thread", threadRef);
    if (!locatorRow) {
      throw new SurfaceError("cache_miss", `No provider locator exists for thread '${threadRef}'.`, {
        account: account.name,
        threadRef,
      });
    }
    await refreshUidThread(account, context, parseThreadLocator(locatorRow.locator_json));
  }

  async readMessage(
    account: MailAccount,
    messageRef: string,
    refresh: boolean,
    context: ProviderContext,
  ): Promise<ReadResultEnvelope> {
    const stored = requireMessageForAccount(account, messageRef, context);
    const attachments = attachmentMetas(context, messageRef);
    const hasReadableCache = Boolean(stored.body_cache_path && existsSync(stored.body_cache_path));
    if (!refresh && hasReadableCache) {
      return buildReadEnvelope(account, messageRef, stored.thread_ref, parseStoredMessage(stored), attachments, "hit");
    }

    const refreshed = await refreshStoredMessage(account, messageRef, context);
    return buildReadEnvelope(
      account,
      messageRef,
      refreshed.thread_ref,
      parseStoredMessage(refreshed),
      attachmentMetas(context, messageRef),
      hasReadableCache ? "refreshed" : "miss",
    );
  }

  async listAttachments(
    account: MailAccount,
    messageRef: string,
    context: ProviderContext,
  ): Promise<AttachmentListEnvelope> {
    requireMessageForAccount(account, messageRef, context);
    return {
      schema_version: "1",
      command: "attachment-list",
      account: account.name,
      message_ref: messageRef,
      attachments: attachmentMetas(context, messageRef),
    };
  }

  async downloadAttachment(
    account: MailAccount,
    messageRef: string,
    attachmentId: string,
    context: ProviderContext,
  ): Promise<AttachmentDownloadEnvelope> {
    requireMessageForAccount(account, messageRef, context);
    const attachment = context.db.listAttachmentsForMessage(messageRef).find((entry) => entry.attachment_id === attachmentId);
    if (!attachment) {
      throw new SurfaceError("not_found", `Attachment '${attachmentId}' was not found for message '${messageRef}'.`, {
        account: account.name,
        messageRef,
      });
    }

    const messageLocatorRow = context.db.findProviderLocator("message", messageRef);
    const attachmentLocatorRow = context.db.findProviderLocator("attachment", attachmentId);
    if (!messageLocatorRow || !attachmentLocatorRow) {
      await refreshStoredMessage(account, messageRef, context);
    }
    const refreshedMessageLocatorRow = context.db.findProviderLocator("message", messageRef);
    const refreshedAttachmentLocatorRow = context.db.findProviderLocator("attachment", attachmentId);
    if (!refreshedMessageLocatorRow || !refreshedAttachmentLocatorRow) {
      throw new SurfaceError("cache_miss", `No provider locator exists for attachment '${attachmentId}'.`, {
        account: account.name,
        messageRef,
      });
    }

    const messageLocator = parseMessageLocator(refreshedMessageLocatorRow.locator_json);
    const attachmentLocator = parseAttachmentLocator(refreshedAttachmentLocatorRow.locator_json);
    const parsed = await simpleParser(await readMessageSource(account, context, messageLocator));
    const matched = parsed.attachments.find((candidate, index) =>
      (attachmentLocator.checksum && candidate.checksum === attachmentLocator.checksum)
      || (attachmentLocator.index === index && (!attachmentLocator.filename || candidate.filename === attachmentLocator.filename)),
    );
    if (!matched) {
      throw new SurfaceError("not_found", `Attachment '${attachmentId}' could not be found in IMAP message '${messageRef}'.`, {
        account: account.name,
        messageRef,
      });
    }

    const targetDir = join(context.accountPaths.downloadsDir, messageRef);
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${attachmentId}__${sanitizeAttachmentFilename(attachment.filename)}`);
    writeFileSync(targetPath, matched.content);
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
    context: ProviderContext,
  ): Promise<ArchiveResultEnvelope> {
    assertWriteAllowed(context.config, account, { to: [], cc: [], bcc: [] }, { disposition: "non_send" });
    const stored = requireMessageForAccount(account, messageRef, context);
    const locatorRow = context.db.findProviderLocator("message", messageRef);
    if (!locatorRow) {
      throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
        account: account.name,
        messageRef,
        threadRef: stored.thread_ref,
      });
    }
    const locator = parseMessageLocator(locatorRow.locator_json);

    await withImapClient(account, context, async (client) => {
      const mailboxes = await client.list();
      const archivePath = resolveMailboxPath(mailboxes, "archive");
      const archiveExists = mailboxes.some((mailbox) => mailbox.path === archivePath);
      if (!archiveExists) {
        throw new SurfaceError("unsupported", "This IMAP account does not expose an archive mailbox.", {
          account: account.name,
          messageRef,
          threadRef: stored.thread_ref,
        });
      }
      const mailbox = await client.mailboxOpen(locator.mailbox);
      if (uidValidityString(mailbox) !== locator.uid_validity) {
        throw new SurfaceError("cache_miss", `IMAP UIDVALIDITY changed for mailbox '${locator.mailbox}'.`, {
          account: account.name,
          messageRef,
          threadRef: stored.thread_ref,
        });
      }
      const moveResult = await client.messageMove(String(locator.uid), archivePath, { uid: true });
      const newUid = moveResult && moveResult.uidMap ? moveResult.uidMap.get(locator.uid) : undefined;
      const refreshedThread = await recoverArchivedThreadAfterMove(account, client, archivePath, stored, locator, newUid);
      const refreshedMessage = refreshedThread?.messages[0];
      const refreshedThreadLocator = refreshedThread?.locator?.locator as ImapThreadLocator | undefined;
      const refreshedMessageLocator = refreshedMessage?.locator?.locator as ImapMessageLocator | undefined;
      const [persisted] = refreshedThread && refreshedMessage && refreshedThreadLocator && refreshedMessageLocator
        ? persistThreads(account, context, [refreshedThread], {
          threadRefsByProviderKey: new Map([[imapThreadProviderKey(refreshedThreadLocator), stored.thread_ref]]),
          messageRefsByProviderKey: new Map([[imapMessageProviderKey(refreshedMessageLocator), messageRef]]),
          attachmentRefsByProviderKey: buildAttachmentRefOverrides(
            context,
            messageRef,
            refreshedMessageLocator,
            refreshedMessage.attachments,
          ),
        })
        : [];
      if (!persisted) {
        context.db.markThreadArchived(stored.thread_ref);
      }
    });

    return buildArchiveEnvelope(account, messageRef, stored.thread_ref);
  }

  async markRead(
    account: MailAccount,
    messageRefs: string[],
    context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope> {
    assertWriteAllowed(context.config, account, { to: [], cc: [], bcc: [] }, { disposition: "non_send" });
    return buildMarkMessagesEnvelope(account, "mark-read", await mutateSeenFlag(account, context, messageRefs, false));
  }

  async markUnread(
    account: MailAccount,
    messageRefs: string[],
    context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope> {
    assertWriteAllowed(context.config, account, { to: [], cc: [], bcc: [] }, { disposition: "non_send" });
    return buildMarkMessagesEnvelope(account, "mark-unread", await mutateSeenFlag(account, context, messageRefs, true));
  }
}
