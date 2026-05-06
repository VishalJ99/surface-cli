import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MailAccount } from "../contracts/account.js";
import type { NormalizedThreadRecord } from "../contracts/mail.js";
import { SurfaceDatabase } from "../state/database.js";
import { syncUnreadStateWithFetcher } from "./unread-state.js";

function createTestStore(): { db: SurfaceDatabase; account: MailAccount; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "surface-unread-state-"));
  const db = new SurfaceDatabase(join(root, "state.db"));
  const account = db.upsertAccount({
    name: "work",
    provider: "gmail",
    transport: "gmail-api",
    email: "work@example.com",
  });

  return {
    db,
    account,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function storedMessage(
  db: SurfaceDatabase,
  account: MailAccount,
  input: {
    threadRef: string;
    messageRef: string;
    receivedAt: string;
    unread: boolean;
  },
): void {
  db.upsertThread({
    thread_ref: input.threadRef,
    account_id: account.account_id,
    subject: input.threadRef,
    participants: [],
    mailbox: "inbox",
    labels: input.unread ? ["inbox", "unread"] : ["inbox"],
    received_at: input.receivedAt,
    message_count: 1,
    unread_count: input.unread ? 1 : 0,
    has_attachments: false,
  });
  db.upsertMessage({
    message_ref: input.messageRef,
    account_id: account.account_id,
    thread_ref: input.threadRef,
    subject: input.threadRef,
    from_name: null,
    from_email: null,
    to_json: "[]",
    cc_json: "[]",
    sent_at: null,
    received_at: input.receivedAt,
    unread: input.unread,
    snippet: "",
    body_cache_path: null,
    body_cached: false,
    body_truncated: false,
    body_cached_bytes: 0,
    invite_json: null,
  });
  db.replaceThreadMessages(input.threadRef, [input.messageRef]);
}

function fetchedThread(input: {
  threadRef: string;
  messageRef: string;
  receivedAt: string;
}): NormalizedThreadRecord {
  return {
    thread_ref: input.threadRef,
    source: {
      provider: "gmail",
      transport: "gmail-api",
    },
    envelope: {
      subject: input.threadRef,
      participants: [],
      mailbox: "inbox",
      labels: ["inbox", "unread"],
      received_at: input.receivedAt,
      message_count: 1,
      unread_count: 1,
      has_attachments: false,
    },
    summary: null,
    messages: [
      {
        message_ref: input.messageRef,
        envelope: {
          subject: input.threadRef,
          from: null,
          to: [],
          cc: [],
          sent_at: null,
          received_at: input.receivedAt,
          unread: true,
        },
        snippet: "",
        body: {
          text: "",
          truncated: false,
          cached: true,
          cached_bytes: 0,
        },
        attachments: [],
      },
    ],
  };
}

test("syncUnreadStateWithFetcher clears stale unread only inside the bounded candidate window", async () => {
  const { db, account, cleanup } = createTestStore();
  try {
    storedMessage(db, account, {
      threadRef: "thr_current",
      messageRef: "msg_current",
      receivedAt: "2026-05-06T10:00:00Z",
      unread: true,
    });
    storedMessage(db, account, {
      threadRef: "thr_stale",
      messageRef: "msg_stale",
      receivedAt: "2026-05-06T09:00:00Z",
      unread: true,
    });
    storedMessage(db, account, {
      threadRef: "thr_outside_window",
      messageRef: "msg_outside_window",
      receivedAt: "2026-05-06T08:00:00Z",
      unread: true,
    });

    const result = await syncUnreadStateWithFetcher(
      { db, account },
      { limit: 2, rebaseline: false },
      async () => [
        fetchedThread({
          threadRef: "thr_current",
          messageRef: "msg_current",
          receivedAt: "2026-05-06T10:00:00Z",
        }),
      ],
    );

    assert.equal(result.mode, "bounded");
    assert.equal(result.sync.local_unread_candidates, 2);
    assert.equal(result.sync.stale_cleared, 1);
    assert.deepEqual(result.cleared, [{ message_ref: "msg_stale", thread_ref: "thr_stale" }]);
    assert.equal(db.getStoredMessage("msg_current")?.unread, 1);
    assert.equal(db.getStoredMessage("msg_stale")?.unread, 0);
    assert.equal(db.getStoredThread("thr_stale")?.unread_count, 0);
    assert.equal(db.getStoredMessage("msg_outside_window")?.unread, 1);
  } finally {
    cleanup();
  }
});

test("syncUnreadStateWithFetcher rebaseline clears account unread before fetching and reports a full provider window", async () => {
  const { db, account, cleanup } = createTestStore();
  try {
    storedMessage(db, account, {
      threadRef: "thr_stale_one",
      messageRef: "msg_stale_one",
      receivedAt: "2026-05-06T09:00:00Z",
      unread: true,
    });
    storedMessage(db, account, {
      threadRef: "thr_stale_two",
      messageRef: "msg_stale_two",
      receivedAt: "2026-05-06T08:00:00Z",
      unread: true,
    });

    const result = await syncUnreadStateWithFetcher(
      { db, account },
      { limit: 1, rebaseline: true },
      async () => {
        assert.equal(db.getStoredMessage("msg_stale_one")?.unread, 0);
        assert.equal(db.getStoredMessage("msg_stale_two")?.unread, 0);
        storedMessage(db, account, {
          threadRef: "thr_provider_unread",
          messageRef: "msg_provider_unread",
          receivedAt: "2026-05-06T10:00:00Z",
          unread: true,
        });
        return [
          fetchedThread({
            threadRef: "thr_provider_unread",
            messageRef: "msg_provider_unread",
            receivedAt: "2026-05-06T10:00:00Z",
          }),
        ];
      },
    );

    assert.equal(result.mode, "rebaseline");
    assert.equal(result.status.partial, true);
    assert.equal(result.status.truncated, true);
    assert.equal(result.status.reason, "provider_returned_limit");
    assert.equal(result.sync.account_unread_cleared_before_fetch, 2);
    assert.equal(result.sync.local_unread_candidates, 0);
    assert.equal(result.sync.stale_cleared, 0);
    assert.deepEqual(result.cleared, []);
    assert.equal(db.getStoredMessage("msg_stale_one")?.unread, 0);
    assert.equal(db.getStoredMessage("msg_stale_two")?.unread, 0);
    assert.equal(db.getStoredMessage("msg_provider_unread")?.unread, 1);
  } finally {
    cleanup();
  }
});
