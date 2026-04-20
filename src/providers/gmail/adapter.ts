import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MailAccount } from "../../contracts/account.js";
import type {
  ArchiveResultEnvelope,
  AttachmentDownloadEnvelope,
  AttachmentListEnvelope,
  ComposeRecipients,
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
import { SurfaceError } from "../../lib/errors.js";
import { assertWriteAllowed } from "../../lib/write-safety.js";
import { makeAttachmentId, makeMessageRef, makeThreadRef } from "../../refs.js";
import { summarizeThread } from "../../summarizer.js";
import type { StoredMessageRecord } from "../../state/database.js";
import type { AuthStatus, MailProviderAdapter, ProviderContext } from "../types.js";
import { annotateBodyWithInlineAttachments } from "../shared/inline-attachments.js";
import {
  createGmailDraft,
  downloadGmailAttachmentBytes,
  getGoogleCalendarEvent,
  getGmailThread,
  listGmailThreads,
  listGoogleCalendarEventsByIcalUid,
  modifyGmailMessage,
  modifyGmailThread,
  patchGoogleCalendarEvent,
  sendGmailRawMessage,
  type GoogleCalendarEventRecord,
  type GmailMessageReference,
  type GmailThreadRecord,
} from "./api.js";
import { clearGmailAuthState, gmailAuthStatus, runGmailLogin } from "./oauth.js";
import {
  decodeBase64UrlBytes,
  decodePartData,
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

function quoteGmailSearchValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return '""';
  }
  return /[\s"]/u.test(normalized) ? `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : normalized;
}

function gmailMailboxSearchOperator(mailbox: string): string {
  const normalized = mailbox.trim().toLowerCase();
  switch (normalized) {
    case "drafts":
      return "in:drafts";
    case "sent":
      return "in:sent";
    case "trash":
      return "in:trash";
    case "spam":
      return "in:spam";
    case "inbox":
      return "in:inbox";
    case "archive":
      return "in:archive";
    default:
      return `in:${quoteGmailSearchValue(normalized)}`;
  }
}

function gmailLabelSearchOperator(label: string): string {
  const normalized = normalizeLabel(label);
  switch (normalized) {
    case "unread":
      return "is:unread";
    case "read":
      return "is:read";
    case "starred":
      return "is:starred";
    case "important":
      return "label:important";
    case "inbox":
    case "sent":
    case "drafts":
    case "trash":
    case "spam":
    case "archive":
      return gmailMailboxSearchOperator(normalized);
    default:
      return `label:${quoteGmailSearchValue(normalized)}`;
  }
}

function buildGmailSearchQuery(query: SearchQuery): string | undefined {
  const parts: string[] = [];
  if (query.text?.trim()) {
    parts.push(query.text.trim());
  }
  if (query.from?.trim()) {
    parts.push(`from:${quoteGmailSearchValue(query.from)}`);
  }
  if (query.subject?.trim()) {
    parts.push(`subject:${quoteGmailSearchValue(query.subject)}`);
  }
  if (query.mailbox?.trim()) {
    parts.push(gmailMailboxSearchOperator(query.mailbox));
  }
  for (const label of query.labels ?? []) {
    if (!label.trim()) {
      continue;
    }
    parts.push(gmailLabelSearchOperator(label));
  }
  return parts.length > 0 ? parts.join(" ").trim() : undefined;
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

function mapGoogleCalendarResponseStatus(value: string | undefined | null): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  switch (normalized) {
    case "accepted":
      return "accept";
    case "declined":
      return "decline";
    case "tentative":
      return "tentative";
    case "needsaction":
      return "needs_response";
    default:
      return null;
  }
}

function googleCalendarResponseStatusForRsvp(response: RsvpResponse): "accepted" | "declined" | "tentative" {
  switch (response) {
    case "accept":
      return "accepted";
    case "decline":
      return "declined";
    case "tentative":
      return "tentative";
  }
}

function googleCalendarEventStart(event: GoogleCalendarEventRecord): string | null {
  return event.start?.dateTime ?? event.start?.date ?? null;
}

function normalizeComparableDatePrefix(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function chooseGoogleCalendarEvent(
  events: GoogleCalendarEventRecord[],
  meetingStart: string | null,
): GoogleCalendarEventRecord | null {
  if (events.length === 0) {
    return null;
  }

  const targetDate = normalizeComparableDatePrefix(meetingStart);
  if (targetDate) {
    const match = events.find((event) => normalizeComparableDatePrefix(googleCalendarEventStart(event)) === targetDate);
    if (match) {
      return match;
    }
  }

  return events[0] ?? null;
}

function pickCalendarAttendee(
  event: GoogleCalendarEventRecord,
  attendeeEmail: string | null,
  fallbackEmail: string,
): { email: string; response_status: string | null } | null {
  const normalizedTarget = (attendeeEmail ?? fallbackEmail).trim().toLowerCase();
  const normalizedFallback = fallbackEmail.trim().toLowerCase();
  const attendees = event.attendees ?? [];

  const chosen =
    attendees.find((attendee) => attendee.self === true)
    ?? attendees.find((attendee) => (attendee.email ?? "").trim().toLowerCase() === normalizedTarget)
    ?? attendees.find((attendee) => (attendee.email ?? "").trim().toLowerCase() === normalizedFallback);

  if (!chosen?.email) {
    return normalizedTarget
      ? { email: normalizedTarget, response_status: null }
      : null;
  }

  return {
    email: chosen.email,
    response_status: mapGoogleCalendarResponseStatus(chosen.responseStatus),
  };
}

async function hydrateGmailInviteMetadataFromCalendar(
  account: MailAccount,
  context: ProviderContext,
  metadata: {
    invite: MessageInvite;
    calendar_uid: string | null;
    attendee_email: string | null;
    meeting_start: string | null;
  },
): Promise<{
  invite: MessageInvite;
  calendar_uid: string | null;
  attendee_email: string | null;
  meeting_start: string | null;
}> {
  if (!metadata.calendar_uid) {
    return metadata;
  }

  try {
    const events = await listGoogleCalendarEventsByIcalUid(account, context, "primary", metadata.calendar_uid);
    const event = chooseGoogleCalendarEvent(events, metadata.meeting_start);
    if (!event) {
      return metadata;
    }

    const attendee = pickCalendarAttendee(event, metadata.attendee_email, account.email);
    return {
      ...metadata,
      attendee_email: attendee?.email ?? metadata.attendee_email,
      invite: {
        ...metadata.invite,
        rsvp_supported: true,
        response_status: attendee?.response_status ?? metadata.invite.response_status,
        available_rsvp_responses: ["accept", "decline", "tentative"],
      },
    };
  } catch (error) {
    if (error instanceof SurfaceError && (error.code === "reauth_required" || error.code === "transport_error")) {
      return metadata;
    }
    throw error;
  }
}

async function extractGmailInviteMetadata(
  account: MailAccount,
  context: ProviderContext,
  message: GmailMessagePayload,
  participants: { to: MessageParticipant[]; cc: MessageParticipant[] },
): Promise<{
  invite: MessageInvite;
  calendar_uid: string | null;
  attendee_email: string | null;
  meeting_start: string | null;
} | null> {
  const calendarText = await extractCalendarText(account, context, message);
  if (!calendarText) {
    return null;
  }

  const parsedInvite = parseCalendarInvite(calendarText, {
    mailboxEmail: account.email,
    recipientEmails: [...participants.to, ...participants.cc].map((mailbox) => mailbox.email),
  });
  const meeting = parsedInvite.meeting;
  if (!meeting) {
    return null;
  }

  const metadata = {
    invite: {
      is_invite: true,
      rsvp_supported: Boolean(meeting.uid),
      response_status: mapCalendarPartstat(meeting.response_type),
      available_rsvp_responses: meeting.uid ? (["accept", "decline", "tentative"] satisfies RsvpResponse[]) : [],
    },
    calendar_uid: meeting.uid ?? null,
    attendee_email: meeting.attendee?.email ?? null,
    meeting_start: meeting.start ?? null,
  };
  return hydrateGmailInviteMetadataFromCalendar(account, context, metadata);
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
  const bodyText = annotateBodyWithInlineAttachments(body.text, attachments);

  const inviteMetadata = await extractGmailInviteMetadata(account, context, message, { to, cc });
  const invite = inviteMetadata?.invite;

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
    snippet: message.snippet ?? bodyText.slice(0, 240),
    body: {
      text: bodyText,
      truncated: false,
      cached: true,
      cached_bytes: Buffer.byteLength(bodyText, "utf8"),
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
        calendar_uid: inviteMetadata?.calendar_uid ?? null,
        attendee_email: inviteMetadata?.attendee_email ?? null,
        meeting_start: inviteMetadata?.meeting_start ?? null,
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

function normalizeEmailList(values: Array<string | null | undefined>): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return [...deduped];
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function prefixSubject(subject: string, prefix: "Re" | "Fwd"): string {
  const normalized = subject.trim();
  if (!normalized) {
    return `${prefix}:`;
  }
  const matcher = prefix === "Re" ? /^re:\s/i : /^(fwd|fw):\s/i;
  return matcher.test(normalized) ? normalized : `${prefix}: ${normalized}`;
}

function quoteLines(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function buildReplyBody(inputBody: string, stored: StoredMessageRecord): string {
  const parsed = parseStoredMessage(stored);
  const originalBody = parsed.body.text.trim();
  const originalFrom = parsed.envelope.from?.email ?? parsed.envelope.from?.name ?? "unknown sender";
  const originalDate = parsed.envelope.sent_at ?? parsed.envelope.received_at ?? "unknown time";
  if (!originalBody) {
    return inputBody;
  }
  return `${inputBody}\n\nOn ${originalDate}, ${originalFrom} wrote:\n${quoteLines(originalBody)}`;
}

function buildForwardBody(inputBody: string, stored: StoredMessageRecord): string {
  const parsed = parseStoredMessage(stored);
  const originalBody = parsed.body.text.trim();
  const lines = [
    inputBody,
    "",
    "---------- Forwarded message ---------",
    `From: ${parsed.envelope.from?.email ?? parsed.envelope.from?.name ?? ""}`,
    `Date: ${parsed.envelope.sent_at ?? parsed.envelope.received_at ?? ""}`,
    `Subject: ${parsed.envelope.subject ?? ""}`,
    `To: ${parsed.envelope.to.map((mailbox) => mailbox.email).join(", ")}`,
  ];
  if (parsed.envelope.cc.length > 0) {
    lines.push(`Cc: ${parsed.envelope.cc.map((mailbox) => mailbox.email).join(", ")}`);
  }
  lines.push("", originalBody);
  return lines.join("\n").trim();
}

function encodeMimeBase64Url(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

function buildRawMimeMessage(input: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
}): string {
  const lines = [
    `From: ${sanitizeHeaderValue(input.from)}`,
    ...(input.to.length > 0 ? [`To: ${input.to.map(sanitizeHeaderValue).join(", ")}`] : []),
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.map(sanitizeHeaderValue).join(", ")}`] : []),
    ...(input.bcc.length > 0 ? [`Bcc: ${input.bcc.map(sanitizeHeaderValue).join(", ")}`] : []),
    `Subject: ${sanitizeHeaderValue(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${sanitizeHeaderValue(input.inReplyTo)}`] : []),
    ...(input.references ? [`References: ${sanitizeHeaderValue(input.references)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body.replace(/\r\n/g, "\n"),
    "",
  ];
  return lines.join("\r\n");
}

function parseMessageLocator(locatorJson: string): {
  thread_id: string | null;
  message_id: string | null;
  calendar_uid: string | null;
  attendee_email: string | null;
  meeting_start: string | null;
} {
  const parsed = JSON.parse(locatorJson) as Record<string, unknown>;
  return {
    thread_id: typeof parsed.thread_id === "string" && parsed.thread_id ? parsed.thread_id : null,
    message_id: typeof parsed.message_id === "string" && parsed.message_id ? parsed.message_id : null,
    calendar_uid: typeof parsed.calendar_uid === "string" && parsed.calendar_uid ? parsed.calendar_uid : null,
    attendee_email: typeof parsed.attendee_email === "string" && parsed.attendee_email ? parsed.attendee_email : null,
    meeting_start: typeof parsed.meeting_start === "string" && parsed.meeting_start ? parsed.meeting_start : null,
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
    source: sourceInfo(account),
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

async function resolveGmailMessageContext(
  account: MailAccount,
  messageRef: string,
  context: ProviderContext,
): Promise<{
  stored: StoredMessageRecord;
  threadId: string;
  messageId: string;
  thread: GmailThreadRecord;
  message: GmailMessagePayload;
  headers: Record<string, string>;
}> {
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
    });
  }

  let locator = parseMessageLocator(locatorRow.locator_json);
  if (!locator.thread_id || !locator.message_id) {
    stored = await refreshStoredMessage(account, messageRef, context);
    locatorRow = context.db.findProviderLocator("message", messageRef);
    if (!locatorRow) {
      throw new SurfaceError("cache_miss", `No provider locator exists for message '${messageRef}'.`, {
        account: account.name,
        messageRef,
      });
    }
    locator = parseMessageLocator(locatorRow.locator_json);
  }

  if (!locator.thread_id || !locator.message_id) {
    throw new SurfaceError("transport_error", `Message '${messageRef}' is missing Gmail thread or message ids.`, {
      account: account.name,
      messageRef,
    });
  }

  const thread = await getGmailThread(account, context, locator.thread_id);
  const message = (thread.messages ?? []).find((entry) => entry.id === locator.message_id);
  if (!message) {
    throw new SurfaceError("not_found", `Gmail could not find message '${messageRef}' in thread '${locator.thread_id}'.`, {
      account: account.name,
      messageRef,
    });
  }

  return {
    stored,
    threadId: locator.thread_id,
    messageId: locator.message_id,
    thread,
    message,
    headers: headerIndex(message.payload?.headers),
  };
}

async function resolveGmailRsvpTarget(
  account: MailAccount,
  messageRef: string,
  context: ProviderContext,
): Promise<{
  stored: StoredMessageRecord;
  message: GmailMessagePayload;
  threadRef: string;
  calendarUid: string;
  attendeeEmail: string;
  meetingStart: string | null;
  invite: MessageInvite;
}> {
  const target = await resolveGmailMessageContext(account, messageRef, context);
  const inviteMetadata = await extractGmailInviteMetadata(account, context, target.message, {
    to: parseMailboxes(target.headers.to),
    cc: parseMailboxes(target.headers.cc),
  });

  if (!inviteMetadata?.calendar_uid) {
    throw new SurfaceError("unsupported", `Message '${messageRef}' is not a Gmail calendar invite with a resolvable UID.`, {
      account: account.name,
      messageRef,
    });
  }

  if (!inviteMetadata.invite.rsvp_supported) {
    throw new SurfaceError("unsupported", `Message '${messageRef}' is not a Gmail invite Surface can RSVP to.`, {
      account: account.name,
      messageRef,
    });
  }

  const attendeeEmail =
    inviteMetadata.attendee_email?.trim().toLowerCase()
    || account.email.trim().toLowerCase();
  if (!attendeeEmail) {
    throw new SurfaceError("unsupported", `Message '${messageRef}' does not expose an attendee email for RSVP.`, {
      account: account.name,
      messageRef,
    });
  }

  return {
    stored: target.stored,
    message: target.message,
    threadRef: target.stored.thread_ref,
    calendarUid: inviteMetadata.calendar_uid,
    attendeeEmail,
    meetingStart: inviteMetadata.meeting_start,
    invite: inviteMetadata.invite,
  };
}

async function performGmailRsvp(
  account: MailAccount,
  context: ProviderContext,
  target: {
    calendarUid: string;
    attendeeEmail: string;
    meetingStart: string | null;
  },
  response: RsvpResponse,
): Promise<MessageInvite> {
  const events = await listGoogleCalendarEventsByIcalUid(account, context, "primary", target.calendarUid);
  const event = chooseGoogleCalendarEvent(events, target.meetingStart);
  if (!event?.id) {
    throw new SurfaceError(
      "not_found",
      `Google Calendar could not find an event matching invite UID '${target.calendarUid}'.`,
      { account: account.name },
    );
  }

  const attendee = pickCalendarAttendee(event, target.attendeeEmail, account.email);
  if (!attendee?.email) {
    throw new SurfaceError(
      "unsupported",
      `Google Calendar event '${event.id}' does not expose an attendee that Surface can RSVP as.`,
      { account: account.name },
    );
  }

  const patched = await patchGoogleCalendarEvent(account, context, "primary", event.id, {
    attendeesOmitted: true,
    attendees: [
      {
        email: attendee.email,
        responseStatus: googleCalendarResponseStatusForRsvp(response),
      },
    ],
  });

  const refreshed = patched.id
    ? await getGoogleCalendarEvent(account, context, "primary", patched.id)
    : patched;
  const refreshedAttendee = pickCalendarAttendee(refreshed, attendee.email, account.email);

  return {
    is_invite: true,
    rsvp_supported: true,
    response_status: refreshedAttendee?.response_status ?? mapGoogleCalendarResponseStatus(googleCalendarResponseStatusForRsvp(response)),
    available_rsvp_responses: ["accept", "decline", "tentative"],
  };
}

async function refreshRefsFromGmailResponse(
  account: MailAccount,
  context: ProviderContext,
  response: GmailMessageReference,
): Promise<{ thread_ref: string | null; message_ref: string | null }> {
  const threadId = response.threadId ?? null;
  if (threadId) {
    await fetchAndPersistGmailThread(account, context, threadId);
  }

  const threadRef =
    threadId
      ? context.db.findEntityRefByProviderKey("thread", account.account_id, gmailThreadProviderKey(threadId)) ?? null
      : null;
  const messageRef =
    response.id
      ? context.db.findEntityRefByProviderKey("message", account.account_id, gmailMessageProviderKey(response.id)) ?? null
      : null;

  if (threadRef && !messageRef) {
    const latest = latestStoredThreadMessage(threadRef, context);
    return {
      thread_ref: threadRef,
      message_ref: latest.message_ref,
    };
  }

  return {
    thread_ref: threadRef,
    message_ref: messageRef,
  };
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

async function sendOrDraftGmailMessage(
  account: MailAccount,
  context: ProviderContext,
  payload: {
    raw: string;
    threadId?: string | null;
    draft: boolean;
  },
): Promise<{ status: SendResultEnvelope["status"]; refs: { thread_ref: string | null; message_ref: string | null } }> {
  if (payload.draft) {
    const draft = await createGmailDraft(account, context, {
      raw: payload.raw,
      threadId: payload.threadId ?? null,
    });
    return {
      status: "drafted",
      refs: await refreshRefsFromGmailResponse(account, context, draft.message ?? {}),
    };
  }

  const message = await sendGmailRawMessage(account, context, {
    raw: payload.raw,
    threadId: payload.threadId ?? null,
  });
  return {
    status: "sent",
    refs: await refreshRefsFromGmailResponse(account, context, message),
  };
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
    const queryText = buildGmailSearchQuery(query);
    const threads = await fetchGmailThreads(account, context, {
      kind: "search",
      ...(queryText ? { queryText } : {}),
      limit: query.limit,
    });
    return threads.filter((thread) => threadMatchesStructuredFilters(thread, query)).slice(0, query.limit);
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

  async refreshThread(
    account: MailAccount,
    threadRef: string,
    context: ProviderContext,
  ): Promise<void> {
    const locatorRow = context.db.findProviderLocator("thread", threadRef);
    if (!locatorRow) {
      throw new SurfaceError("cache_miss", `No provider locator exists for thread '${threadRef}'.`, {
        account: account.name,
        threadRef,
      });
    }

    const locator = JSON.parse(locatorRow.locator_json) as { thread_id?: string | null };
    if (!locator.thread_id) {
      throw new SurfaceError("transport_error", `Thread '${threadRef}' is missing a Gmail thread id.`, {
        account: account.name,
        threadRef,
      });
    }

    await fetchAndPersistGmailThread(account, context, locator.thread_id);
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

  async rsvp(account: MailAccount, messageRef: string, response: RsvpResponse, context: ProviderContext): Promise<RsvpResultEnvelope> {
    const target = await resolveGmailRsvpTarget(account, messageRef, context);
    const invite = await performGmailRsvp(account, context, target, response);
    context.db.updateInviteForThread(target.threadRef, {
      is_invite: true,
      rsvp_supported: invite.rsvp_supported,
      response_status: invite.response_status,
      available_rsvp_responses: invite.available_rsvp_responses,
    });
    return buildRsvpEnvelope(account, messageRef, target.threadRef, response, invite);
  }

  async sendMessage(
    account: MailAccount,
    input: SendMessageInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    const recipients = {
      to: normalizeEmailList(input.to),
      cc: normalizeEmailList(input.cc),
      bcc: normalizeEmailList(input.bcc),
    };
    if (recipients.to.length === 0) {
      throw new SurfaceError("invalid_argument", "Gmail send requires at least one --to recipient.", {
        account: account.name,
      });
    }

    assertWriteAllowed(context.config, account, recipients, {
      disposition: input.draft ? "draft" : "send",
    });

    const raw = encodeMimeBase64Url(
      buildRawMimeMessage({
        from: account.email,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: input.subject,
        body: input.body,
      }),
    );

    const result = await sendOrDraftGmailMessage(account, context, {
      raw,
      draft: input.draft,
    });

    return buildSendEnvelope(
      account,
      "send",
      result.status,
      input.subject,
      recipientsFromInput(recipients),
      result.refs,
      null,
    );
  }

  async reply(
    account: MailAccount,
    messageRef: string,
    input: ReplyInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    const target = await resolveGmailMessageContext(account, messageRef, context);
    const selfEmail = account.email.trim().toLowerCase();
    const replyTo = parseMailbox(target.headers["reply-to"]);
    const from = parseMailbox(target.headers.from);
    let to = normalizeEmailList([replyTo?.email, from?.email]).filter((email) => email.trim().toLowerCase() !== selfEmail);
    if (to.length === 0) {
      to = normalizeEmailList(
        parseMailboxes(target.headers.to)
          .map((mailbox) => mailbox.email)
          .filter((email) => email.trim().toLowerCase() !== selfEmail),
      );
    }
    const recipients = {
      to,
      cc: normalizeEmailList(input.cc),
      bcc: normalizeEmailList(input.bcc),
    };
    if (recipients.to.length === 0) {
      throw new SurfaceError("unsupported", `Message '${messageRef}' does not expose a reply target.`, {
        account: account.name,
        messageRef,
      });
    }

    assertWriteAllowed(context.config, account, recipients, {
      disposition: input.draft ? "draft" : "send",
    });

    const originalMessageId = target.headers["message-id"] ?? null;
    const references = target.headers.references
      ? `${target.headers.references}${originalMessageId ? ` ${originalMessageId}` : ""}`.trim()
      : originalMessageId;
    const subject = prefixSubject(target.stored.subject ?? target.headers.subject ?? "", "Re");
    const raw = encodeMimeBase64Url(
      buildRawMimeMessage({
        from: account.email,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject,
        body: buildReplyBody(input.body, target.stored),
        inReplyTo: originalMessageId,
        references,
      }),
    );

    const result = await sendOrDraftGmailMessage(account, context, {
      raw,
      threadId: target.threadId,
      draft: input.draft,
    });

    return buildSendEnvelope(
      account,
      "reply",
      result.status,
      subject,
      recipientsFromInput(recipients),
      result.refs,
      messageRef,
    );
  }

  async replyAll(
    account: MailAccount,
    messageRef: string,
    input: ReplyInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    const target = await resolveGmailMessageContext(account, messageRef, context);
    const selfEmail = account.email.trim().toLowerCase();
    const replyTo = parseMailbox(target.headers["reply-to"]);
    const from = parseMailbox(target.headers.from);
    const originalTo = parseMailboxes(target.headers.to).map((mailbox) => mailbox.email);
    const originalCc = parseMailboxes(target.headers.cc).map((mailbox) => mailbox.email);

    let to = normalizeEmailList([
      replyTo?.email && replyTo.email.trim().toLowerCase() !== selfEmail ? replyTo.email : null,
      from?.email && from.email.trim().toLowerCase() !== selfEmail ? from.email : null,
    ]);

    if (to.length === 0) {
      to = normalizeEmailList(originalTo.filter((email) => email.trim().toLowerCase() !== selfEmail));
    }
    if (to.length === 0 && from?.email) {
      to = normalizeEmailList([from.email]);
    }

    const cc = normalizeEmailList([
      ...originalTo.filter((email) => !to.includes(email) && email.trim().toLowerCase() !== selfEmail),
      ...originalCc.filter((email) => !to.includes(email) && email.trim().toLowerCase() !== selfEmail),
      ...input.cc,
    ]);
    const bcc = normalizeEmailList(input.bcc);

    const recipients = { to, cc, bcc };
    if (recipients.to.length === 0) {
      throw new SurfaceError("unsupported", `Message '${messageRef}' does not expose reply-all recipients.`, {
        account: account.name,
        messageRef,
      });
    }

    assertWriteAllowed(context.config, account, recipients, {
      disposition: input.draft ? "draft" : "send",
    });

    const originalMessageId = target.headers["message-id"] ?? null;
    const references = target.headers.references
      ? `${target.headers.references}${originalMessageId ? ` ${originalMessageId}` : ""}`.trim()
      : originalMessageId;
    const subject = prefixSubject(target.stored.subject ?? target.headers.subject ?? "", "Re");
    const raw = encodeMimeBase64Url(
      buildRawMimeMessage({
        from: account.email,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject,
        body: buildReplyBody(input.body, target.stored),
        inReplyTo: originalMessageId,
        references,
      }),
    );

    const result = await sendOrDraftGmailMessage(account, context, {
      raw,
      threadId: target.threadId,
      draft: input.draft,
    });

    return buildSendEnvelope(
      account,
      "reply-all",
      result.status,
      subject,
      recipientsFromInput(recipients),
      result.refs,
      messageRef,
    );
  }

  async forward(
    account: MailAccount,
    messageRef: string,
    input: ForwardInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope> {
    const target = await resolveGmailMessageContext(account, messageRef, context);
    const recipients = {
      to: normalizeEmailList(input.to),
      cc: normalizeEmailList(input.cc),
      bcc: normalizeEmailList(input.bcc),
    };
    if (recipients.to.length === 0) {
      throw new SurfaceError("invalid_argument", "Gmail forward requires at least one --to recipient.", {
        account: account.name,
      });
    }

    assertWriteAllowed(context.config, account, recipients, {
      disposition: input.draft ? "draft" : "send",
    });

    const subject = prefixSubject(target.stored.subject ?? target.headers.subject ?? "", "Fwd");
    const raw = encodeMimeBase64Url(
      buildRawMimeMessage({
        from: account.email,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject,
        body: buildForwardBody(input.body, target.stored),
      }),
    );

    const result = await sendOrDraftGmailMessage(account, context, {
      raw,
      draft: input.draft,
    });

    return buildSendEnvelope(
      account,
      "forward",
      result.status,
      subject,
      recipientsFromInput(recipients),
      result.refs,
      messageRef,
    );
  }

  async archive(
    account: MailAccount,
    messageRef: string,
    context: ProviderContext,
  ): Promise<ArchiveResultEnvelope> {
    assertWriteAllowed(context.config, account, { to: [], cc: [], bcc: [] }, { disposition: "non_send" });
    const target = await resolveGmailMessageContext(account, messageRef, context);
    await modifyGmailThread(account, context, target.threadId, {
      removeLabelIds: ["INBOX"],
    });
    await fetchAndPersistGmailThread(account, context, target.threadId);
    return buildArchiveEnvelope(account, messageRef, target.stored.thread_ref);
  }

  async markRead(
    account: MailAccount,
    messageRefs: string[],
    context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope> {
    assertWriteAllowed(context.config, account, { to: [], cc: [], bcc: [] }, { disposition: "non_send" });
    const touchedThreadIds = new Set<string>();
    const updated: MarkMessagesResultEnvelope["updated"] = [];

    for (const messageRef of messageRefs) {
      const target = await resolveGmailMessageContext(account, messageRef, context);
      await modifyGmailMessage(account, context, target.messageId, {
        removeLabelIds: ["UNREAD"],
      });
      touchedThreadIds.add(target.threadId);
      updated.push({
        message_ref: messageRef,
        thread_ref: target.stored.thread_ref,
        unread: false,
      });
    }

    for (const threadId of touchedThreadIds) {
      await fetchAndPersistGmailThread(account, context, threadId);
    }

    return buildMarkMessagesEnvelope(account, "mark-read", updated);
  }

  async markUnread(
    account: MailAccount,
    messageRefs: string[],
    context: ProviderContext,
  ): Promise<MarkMessagesResultEnvelope> {
    assertWriteAllowed(context.config, account, { to: [], cc: [], bcc: [] }, { disposition: "non_send" });
    const touchedThreadIds = new Set<string>();
    const updated: MarkMessagesResultEnvelope["updated"] = [];

    for (const messageRef of messageRefs) {
      const target = await resolveGmailMessageContext(account, messageRef, context);
      await modifyGmailMessage(account, context, target.messageId, {
        addLabelIds: ["UNREAD"],
      });
      touchedThreadIds.add(target.threadId);
      updated.push({
        message_ref: messageRef,
        thread_ref: target.stored.thread_ref,
        unread: true,
      });
    }

    for (const threadId of touchedThreadIds) {
      await fetchAndPersistGmailThread(account, context, threadId);
    }

    return buildMarkMessagesEnvelope(account, "mark-unread", updated);
  }
}
