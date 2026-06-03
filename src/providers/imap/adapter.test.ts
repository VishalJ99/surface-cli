import assert from "node:assert/strict";
import test from "node:test";

import type { ListResponse } from "imapflow";

import type { MailAccount } from "../../contracts/account.js";
import type { NormalizedAttachmentRecord, SentMessageResult } from "../../contracts/mail.js";
import type { StoredMessageRecord } from "../../state/database.js";
import { imapAdapterTestHooks } from "./adapter.js";

function mailbox(input: Partial<ListResponse> & Pick<ListResponse, "path">): ListResponse {
  return {
    path: input.path,
    name: input.name ?? input.path,
    listed: true,
    subscribed: false,
    delimiter: "/",
    flags: new Set(),
    specialUse: input.specialUse,
  } as ListResponse;
}

function sentMessage(input: {
  messageRef: string;
  to?: string[];
  cc?: string[];
}): SentMessageResult {
  const participants = (input.to ?? []).map((email) => ({ name: email, email }));
  const cc = (input.cc ?? []).map((email) => ({ name: email, email }));
  return {
    message_ref: input.messageRef,
    thread_ref: `thr_${input.messageRef}`,
    source: {
      provider: "imap",
      transport: "imap-smtp",
    },
    envelope: {
      from: { name: "Surface Tester", email: "tester@example.com" },
      to: participants,
      cc,
      sent_at: "2026-06-03T12:00:00.000Z",
      received_at: "2026-06-03T12:00:00.000Z",
      unread: false,
    },
    snippet: "",
    body: {
      text: "",
      truncated: false,
      cached: true,
      cached_bytes: 0,
    },
    attachments: [],
  };
}

function account(): MailAccount {
  return {
    account_id: "acc_imap",
    name: "imap",
    provider: "imap",
    transport: "imap-smtp",
    email: "surface@example.com",
    created_at: "2026-06-03T12:00:00.000Z",
    updated_at: "2026-06-03T12:00:00.000Z",
  };
}

function storedMessage(input: {
  subject?: string;
  from?: string;
  sentAt?: string;
  receivedAt?: string;
  snippet?: string;
}): StoredMessageRecord {
  return {
    message_ref: "msg_existing",
    account_id: "acc_existing",
    thread_ref: "thr_existing",
    subject: input.subject ?? "Archive me",
    from_name: "Sender",
    from_email: input.from ?? "sender@example.com",
    to_json: "[]",
    cc_json: "[]",
    sent_at: input.sentAt ?? "2026-06-03T12:00:00.000Z",
    received_at: input.receivedAt ?? "2026-06-03T12:00:01.000Z",
    unread: 0,
    snippet: input.snippet ?? "Archive me body",
    body_cache_path: null,
    body_cached: 0,
    body_truncated: 0,
    body_cached_bytes: 0,
    invite_json: null,
  };
}

test("resolveMailboxPath treats IMAP \\All special-use as archive", () => {
  assert.equal(
    imapAdapterTestHooks.resolveMailboxPath([
      mailbox({ path: "INBOX", specialUse: "\\Inbox" }),
      mailbox({ path: "[Provider]/Everything", specialUse: "\\All" }),
    ], "archive"),
    "[Provider]/Everything",
  );
});

test("buildSentSearch narrows recipient searches through To or Cc and overfetches for post-filtering", () => {
  const { search, fetchLimit } = imapAdapterTestHooks.buildSentSearch({
    recipient: "recipient@example.com",
    limit: 10,
  });

  assert.equal(fetchLimit, 50);
  assert.deepEqual(search.or, [
    { to: "recipient@example.com" },
    { cc: "recipient@example.com" },
  ]);
});

test("filterSentMessagesForQuery keeps exact normalized To and Cc recipient matches only", () => {
  const messages = [
    sentMessage({ messageRef: "msg_to", to: ["Recipient@Example.com"] }),
    sentMessage({ messageRef: "msg_cc", cc: ["recipient@example.com"] }),
    sentMessage({ messageRef: "msg_substring", to: ["not-recipient@example.com"] }),
  ];

  assert.deepEqual(
    imapAdapterTestHooks
      .filterSentMessagesForQuery(messages, { recipient: "recipient@example.com", limit: 10 })
      .map((message) => message.message_ref),
    ["msg_to", "msg_cc"],
  );
});

test("buildComposeRaw hides Bcc from delivery MIME while preserving it for stored copies", () => {
  const raw = imapAdapterTestHooks.buildComposeRaw({
    account: account(),
    recipients: {
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      bcc: ["hidden@example.com"],
    },
    subject: "Surface probe",
    body: "Hello",
    messageId: "<surface-test@example.com>",
  });

  assert.match(raw.deliveryRaw, /^To: to@example\.com/m);
  assert.match(raw.deliveryRaw, /^Cc: cc@example\.com/m);
  assert.match(raw.deliveryRaw, /^Date: /m);
  assert.doesNotMatch(raw.deliveryRaw, /^Bcc:/m);
  assert.match(raw.storedRaw, /^Date: /m);
  assert.match(raw.storedRaw, /^Bcc: hidden@example\.com/m);
});

test("buildComposeRaw neutralizes bare CR and LF header injection", () => {
  const raw = imapAdapterTestHooks.buildComposeRaw({
    account: account(),
    recipients: {
      to: ["to@example.com\rBcc: injected@example.com"],
      cc: [],
      bcc: [],
    },
    subject: "Surface\rBcc: injected@example.com\nCc: injected@example.com",
    body: "Hello",
    messageId: "<surface-test@example.com>",
  });

  assert.match(raw.deliveryRaw, /^To: to@example\.com Bcc: injected@example\.com/m);
  assert.match(raw.deliveryRaw, /^Subject: Surface Bcc: injected@example\.com Cc: injected@example\.com/m);
  assert.doesNotMatch(raw.deliveryRaw, /^Bcc: injected@example\.com/m);
  assert.doesNotMatch(raw.deliveryRaw, /^Cc: injected@example\.com/m);
});

test("IMAP drafts append as seen drafts and sent appends as seen", () => {
  assert.deepEqual(imapAdapterTestHooks.draftAppendFlags, ["\\Draft", "\\Seen"]);
  assert.deepEqual(imapAdapterTestHooks.sentAppendFlags, ["\\Seen"]);
});

test("IMAP attachment provider keys remain unique for duplicate checksum parts", () => {
  const messageLocator = {
    mailbox: "INBOX",
    uid_validity: "1",
    uid: 42,
    message_id: "<invite@example.com>",
    in_reply_to: null,
    references: null,
  };
  const attachment = (index: number): NormalizedAttachmentRecord => ({
    attachment_id: "",
    filename: "invite.ics",
    mime_type: "text/calendar",
    size_bytes: 123,
    inline: false,
    locator: {
      kind: "attachment",
      locator: {
        mailbox: "INBOX",
        uid_validity: "1",
        uid: 42,
        index,
        checksum: "same-calendar-checksum",
        filename: "invite.ics",
      },
    },
  });

  assert.notEqual(
    imapAdapterTestHooks.imapAttachmentProviderKey(messageLocator, attachment(0), 0),
    imapAdapterTestHooks.imapAttachmentProviderKey(messageLocator, attachment(1), 1),
  );
});

test("reply recipients treat Reply-To as authoritative over From", () => {
  const recipients = imapAdapterTestHooks.buildReplyRecipients({
    replyTo: ["support@example.com"],
    from: ["sender@example.com"],
    originalTo: ["surface@example.com"],
    inputCc: [],
    inputBcc: [],
    selfEmails: new Set(["surface@example.com"]),
  });

  assert.deepEqual(recipients.to, ["support@example.com"]);
  assert.deepEqual(recipients.cc, []);
  assert.deepEqual(recipients.bcc, []);
});

test("reply-all recipients do not add From when Reply-To is present", () => {
  const recipients = imapAdapterTestHooks.buildReplyAllRecipients({
    replyTo: ["support@example.com"],
    from: ["sender@example.com"],
    originalTo: ["surface@example.com", "other@example.com"],
    originalCc: ["cc@example.com"],
    inputCc: ["manual@example.com"],
    inputBcc: [],
    selfEmails: new Set(["surface@example.com"]),
  });

  assert.deepEqual(recipients.to, ["support@example.com"]);
  assert.deepEqual(recipients.cc, ["other@example.com", "cc@example.com", "manual@example.com"]);
  assert.deepEqual(recipients.bcc, []);
});

test("replyReferences appends the original Message-ID to existing references", () => {
  assert.equal(
    imapAdapterTestHooks.replyReferences({
      messageId: "<latest@example.com>",
      references: "<root@example.com>",
    }),
    "<root@example.com> <latest@example.com>",
  );
  assert.equal(
    imapAdapterTestHooks.replyReferences({
      messageId: "<latest@example.com>",
      references: null,
    }),
    "<latest@example.com>",
  );
});

test("archivedThreadMatchesStoredMessage matches moved messages by Message-ID", () => {
  const stored = storedMessage({});
  const thread = sentMessage({ messageRef: "msg_moved" });

  assert.equal(
    imapAdapterTestHooks.archivedThreadMatchesStoredMessage(
      stored,
      {
        mailbox: "INBOX",
        uid_validity: "1",
        uid: 10,
        message_id: "<message@example.com>",
        in_reply_to: null,
        references: null,
      },
      {
        ...thread,
        envelope: {
          subject: "Archive me",
          participants: [],
          mailbox: "archive",
          labels: ["archive"],
          received_at: "2026-06-03T12:00:01.000Z",
          message_count: 1,
          unread_count: 0,
          has_attachments: false,
        },
        summary: null,
        messages: [{
          ...thread,
          locator: {
            kind: "message",
            locator: {
              mailbox: "Archive",
              uid_validity: "2",
              uid: 20,
              message_id: "<message@example.com>",
              in_reply_to: null,
              references: null,
            },
          },
        }],
      },
    ),
    true,
  );
});

test("archivedThreadMatchesStoredMessage can recover no-Message-ID moves with normalized envelope facts", () => {
  const stored = storedMessage({});
  const message = sentMessage({ messageRef: "msg_moved" });

  assert.equal(
    imapAdapterTestHooks.archivedThreadMatchesStoredMessage(
      stored,
      {
        mailbox: "INBOX",
        uid_validity: "1",
        uid: 10,
        message_id: null,
        in_reply_to: null,
        references: null,
      },
      {
        thread_ref: "thr_moved",
        source: message.source,
        envelope: {
          subject: "Archive me",
          participants: [],
          mailbox: "archive",
          labels: ["archive"],
          received_at: "2026-06-03T12:00:01.000Z",
          message_count: 1,
          unread_count: 0,
          has_attachments: false,
        },
        summary: null,
        messages: [{
          ...message,
          envelope: {
            ...message.envelope,
            subject: "Archive me",
            from: { name: "Sender", email: "sender@example.com" },
            sent_at: "2026-06-03T12:00:00.000Z",
            received_at: "2026-06-03T12:00:01.000Z",
          },
          snippet: "Archive me body",
          locator: {
            kind: "message",
            locator: {
              mailbox: "Archive",
              uid_validity: "2",
              uid: 20,
              message_id: null,
              in_reply_to: null,
              references: null,
            },
          },
        }],
      },
    ),
    true,
  );
});
