import Database from "better-sqlite3";

import type { MailAccount } from "../contracts/account.js";
import type { MessageInvite, ThreadParticipant, ThreadSummary } from "../contracts/mail.js";
import { makeAccountId } from "../refs.js";
import { nowIsoUtc } from "../lib/time.js";

export interface StoredMessageRecord {
  message_ref: string;
  account_id: string;
  thread_ref: string;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  to_json: string;
  cc_json: string;
  sent_at: string | null;
  received_at: string | null;
  unread: number;
  snippet: string;
  body_cache_path: string | null;
  body_cached: number;
  body_truncated: number;
  body_cached_bytes: number;
  invite_json: string | null;
}

export interface StoredThreadRecord {
  thread_ref: string;
  account_id: string;
  subject: string | null;
  mailbox: string | null;
  participants_json: string;
  labels_json: string;
  received_at: string | null;
  message_count: number;
  unread_count: number;
  has_attachments: number;
}

export interface StoredProviderLocator {
  entity_kind: string;
  entity_ref: string;
  account_id: string;
  provider_key: string;
  locator_json: string;
}

export interface StoredSummaryRecord {
  thread_ref: string;
  backend: string;
  model: string;
  brief: string;
  needs_action: number;
  importance: "low" | "medium" | "high";
  fingerprint: string | null;
}

export interface StoredSessionRecord {
  session_id: string;
  account_id: string;
  provider: string;
  transport: string;
  socket_path: string;
  auth_token: string;
  status: "starting" | "running" | "expired" | "closed" | "failed";
  pid: number | null;
  idle_timeout_seconds: number;
  max_age_seconds: number;
  error_detail: string | null;
  created_at: string;
  last_used_at: string;
  closed_at: string | null;
}

export class SurfaceDatabase {
  readonly connection: InstanceType<typeof Database>;

  constructor(path: string) {
    this.connection = new Database(path);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        transport TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        thread_ref TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        subject TEXT,
        mailbox TEXT,
        participants_json TEXT NOT NULL DEFAULT '[]',
        labels_json TEXT NOT NULL DEFAULT '[]',
        received_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        message_ref TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        thread_ref TEXT NOT NULL,
        subject TEXT,
        from_name TEXT,
        from_email TEXT,
        to_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        sent_at TEXT,
        received_at TEXT,
        unread INTEGER NOT NULL DEFAULT 0,
        snippet TEXT NOT NULL DEFAULT '',
        body_cache_path TEXT,
        body_cached INTEGER NOT NULL DEFAULT 0,
        body_truncated INTEGER NOT NULL DEFAULT 0,
        body_cached_bytes INTEGER NOT NULL DEFAULT 0,
        invite_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
        FOREIGN KEY(thread_ref) REFERENCES threads(thread_ref) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS thread_messages (
        thread_ref TEXT NOT NULL,
        message_ref TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(thread_ref, message_ref),
        FOREIGN KEY(thread_ref) REFERENCES threads(thread_ref) ON DELETE CASCADE,
        FOREIGN KEY(message_ref) REFERENCES messages(message_ref) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY,
        message_ref TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER,
        inline INTEGER NOT NULL DEFAULT 0,
        saved_to TEXT,
        FOREIGN KEY(message_ref) REFERENCES messages(message_ref) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS provider_locators (
        entity_kind TEXT NOT NULL,
        entity_ref TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        locator_json TEXT NOT NULL,
        PRIMARY KEY(entity_kind, entity_ref),
        UNIQUE(entity_kind, account_id, provider_key)
      );

      CREATE TABLE IF NOT EXISTS summaries (
        thread_ref TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        model TEXT NOT NULL,
        brief TEXT NOT NULL,
        needs_action INTEGER NOT NULL DEFAULT 0,
        importance TEXT NOT NULL,
        fingerprint TEXT,
        generated_at TEXT NOT NULL,
        FOREIGN KEY(thread_ref) REFERENCES threads(thread_ref) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        transport TEXT NOT NULL,
        socket_path TEXT NOT NULL,
        auth_token TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        idle_timeout_seconds INTEGER NOT NULL,
        max_age_seconds INTEGER NOT NULL,
        error_detail TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY(account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
      );
    `);

    this.ensureColumn("threads", "participants_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("messages", "invite_json", "TEXT");
    this.ensureColumn("summaries", "fingerprint", "TEXT");
    this.ensureProviderLocatorSchema();
  }

  private tableColumns(tableName: string): string[] {
    return (
      this.connection
        .prepare(`PRAGMA table_info(${tableName})`)
        .all() as Array<{ name: string }>
    ).map((column) => column.name);
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    if (this.tableColumns(tableName).includes(columnName)) {
      return;
    }
    this.connection.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  private ensureProviderLocatorSchema(): void {
    const columns = this.tableColumns("provider_locators");
    if (columns.includes("account_id") && columns.includes("provider_key")) {
      return;
    }

    this.connection.exec(`
      ALTER TABLE provider_locators RENAME TO provider_locators_legacy;

      CREATE TABLE provider_locators (
        entity_kind TEXT NOT NULL,
        entity_ref TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        locator_json TEXT NOT NULL,
        PRIMARY KEY(entity_kind, entity_ref),
        UNIQUE(entity_kind, account_id, provider_key)
      );
    `);

    if (columns.length > 0) {
      this.connection.exec(`
        INSERT OR IGNORE INTO provider_locators (
          entity_kind,
          entity_ref,
          account_id,
          provider_key,
          locator_json
        )
        SELECT
          entity_kind,
          entity_ref,
          '',
          entity_ref,
          locator_json
        FROM provider_locators_legacy;
      `);
    }

    this.connection.exec("DROP TABLE IF EXISTS provider_locators_legacy;");
  }

  upsertAccount(input: {
    name: string;
    provider: MailAccount["provider"];
    transport: string;
    email: string;
  }): MailAccount {
    const existing = this.findAccountByName(input.name);
    const timestamp = nowIsoUtc();
    if (existing) {
      this.connection
        .prepare(
          `
          UPDATE accounts
          SET provider = @provider,
              transport = @transport,
              email = @email,
              updated_at = @updated_at
          WHERE name = @name
          `,
        )
        .run({
          name: input.name,
          provider: input.provider,
          transport: input.transport,
          email: input.email,
          updated_at: timestamp,
        });
      return this.findAccountByName(input.name)!;
    }

    const account: MailAccount = {
      account_id: makeAccountId(),
      name: input.name,
      provider: input.provider,
      transport: input.transport,
      email: input.email,
      created_at: timestamp,
      updated_at: timestamp,
    };

    this.connection
      .prepare(
        `
        INSERT INTO accounts (
          account_id,
          name,
          provider,
          transport,
          email,
          created_at,
          updated_at
        ) VALUES (
          @account_id,
          @name,
          @provider,
          @transport,
          @email,
          @created_at,
          @updated_at
        )
        `,
      )
      .run(account);

    return account;
  }

  listAccounts(): MailAccount[] {
    return this.connection
      .prepare(
        `
        SELECT account_id, name, provider, transport, email, created_at, updated_at
        FROM accounts
        ORDER BY name ASC
        `,
      )
      .all() as MailAccount[];
  }

  findAccountByName(name: string): MailAccount | undefined {
    return this.connection
      .prepare(
        `
        SELECT account_id, name, provider, transport, email, created_at, updated_at
        FROM accounts
        WHERE name = ?
        LIMIT 1
        `,
      )
      .get(name) as MailAccount | undefined;
  }

  findAccountById(accountId: string): MailAccount | undefined {
    return this.connection
      .prepare(
        `
        SELECT account_id, name, provider, transport, email, created_at, updated_at
        FROM accounts
        WHERE account_id = ?
        LIMIT 1
        `,
      )
      .get(accountId) as MailAccount | undefined;
  }

  removeAccountByName(name: string): MailAccount | undefined {
    const existing = this.findAccountByName(name);
    if (!existing) {
      return undefined;
    }

    this.connection.prepare("DELETE FROM accounts WHERE name = ?").run(name);
    return existing;
  }

  transaction<T>(work: () => T): T {
    return (this.connection as unknown as {
      transaction: <F extends () => T>(fn: F) => F;
    }).transaction(work)();
  }

  findEntityRefByProviderKey(
    entityKind: "thread" | "message" | "attachment",
    accountId: string,
    providerKey: string,
  ): string | undefined {
    const row = this.connection
      .prepare(
        `
        SELECT entity_ref
        FROM provider_locators
        WHERE entity_kind = ?
          AND account_id = ?
          AND provider_key = ?
        LIMIT 1
        `,
      )
      .get(entityKind, accountId, providerKey) as { entity_ref: string } | undefined;
    return row?.entity_ref;
  }

  upsertProviderLocator(input: {
    entity_kind: "thread" | "message" | "attachment";
    entity_ref: string;
    account_id: string;
    provider_key: string;
    locator_json: string;
  }): void {
    this.connection
      .prepare(
        `
        INSERT INTO provider_locators (
          entity_kind,
          entity_ref,
          account_id,
          provider_key,
          locator_json
        ) VALUES (
          @entity_kind,
          @entity_ref,
          @account_id,
          @provider_key,
          @locator_json
        )
        ON CONFLICT(entity_kind, entity_ref) DO UPDATE SET
          account_id = excluded.account_id,
          provider_key = excluded.provider_key,
          locator_json = excluded.locator_json
        `,
      )
      .run(input);
  }

  findProviderLocator(
    entityKind: "thread" | "message" | "attachment",
    entityRef: string,
  ): StoredProviderLocator | undefined {
    return this.connection
      .prepare(
        `
        SELECT entity_kind, entity_ref, account_id, provider_key, locator_json
        FROM provider_locators
        WHERE entity_kind = ?
          AND entity_ref = ?
        LIMIT 1
        `,
      )
      .get(entityKind, entityRef) as StoredProviderLocator | undefined;
  }

  upsertThread(input: {
    thread_ref: string;
    account_id: string;
    subject: string;
    participants: ThreadParticipant[];
    mailbox: string;
    labels: string[];
    received_at: string | null;
    message_count: number;
    unread_count: number;
    has_attachments: boolean;
  }): void {
    const timestamp = nowIsoUtc();
    const existing = this.connection
      .prepare("SELECT thread_ref FROM threads WHERE thread_ref = ? LIMIT 1")
      .get(input.thread_ref) as { thread_ref: string } | undefined;

    if (!existing) {
      this.connection
        .prepare(
          `
          INSERT INTO threads (
            thread_ref,
            account_id,
            subject,
            mailbox,
            participants_json,
            labels_json,
            received_at,
            message_count,
            unread_count,
            has_attachments,
            first_seen_at,
            last_synced_at
          ) VALUES (
            @thread_ref,
            @account_id,
            @subject,
            @mailbox,
            @participants_json,
            @labels_json,
            @received_at,
            @message_count,
            @unread_count,
            @has_attachments,
            @first_seen_at,
            @last_synced_at
          )
          `,
        )
        .run({
          ...input,
          participants_json: JSON.stringify(input.participants),
          labels_json: JSON.stringify(input.labels),
          has_attachments: input.has_attachments ? 1 : 0,
          first_seen_at: timestamp,
          last_synced_at: timestamp,
        });
      return;
    }

    this.connection
      .prepare(
        `
        UPDATE threads
        SET subject = @subject,
            mailbox = @mailbox,
            participants_json = @participants_json,
            labels_json = @labels_json,
            received_at = @received_at,
            message_count = @message_count,
            unread_count = @unread_count,
            has_attachments = @has_attachments,
            last_synced_at = @last_synced_at
        WHERE thread_ref = @thread_ref
        `,
      )
      .run({
        ...input,
        participants_json: JSON.stringify(input.participants),
        labels_json: JSON.stringify(input.labels),
        has_attachments: input.has_attachments ? 1 : 0,
        last_synced_at: timestamp,
      });
  }

  upsertMessage(input: {
    message_ref: string;
    account_id: string;
    thread_ref: string;
    subject: string | null;
    from_name: string | null;
    from_email: string | null;
    to_json: string;
    cc_json: string;
    sent_at: string | null;
    received_at: string | null;
    unread: boolean;
    snippet: string;
    body_cache_path: string | null;
    body_cached: boolean;
    body_truncated: boolean;
    body_cached_bytes: number;
    invite_json: string | null;
  }): void {
    const timestamp = nowIsoUtc();
    const existing = this.connection
      .prepare("SELECT message_ref FROM messages WHERE message_ref = ? LIMIT 1")
      .get(input.message_ref) as { message_ref: string } | undefined;

    const payload = {
      ...input,
      unread: input.unread ? 1 : 0,
      body_cached: input.body_cached ? 1 : 0,
      body_truncated: input.body_truncated ? 1 : 0,
    };

    if (!existing) {
      this.connection
        .prepare(
          `
          INSERT INTO messages (
            message_ref,
            account_id,
            thread_ref,
            subject,
            from_name,
            from_email,
            to_json,
            cc_json,
            sent_at,
            received_at,
            unread,
            snippet,
            body_cache_path,
            body_cached,
            body_truncated,
            body_cached_bytes,
            invite_json,
            first_seen_at,
            last_synced_at
          ) VALUES (
            @message_ref,
            @account_id,
            @thread_ref,
            @subject,
            @from_name,
            @from_email,
            @to_json,
            @cc_json,
            @sent_at,
            @received_at,
            @unread,
            @snippet,
            @body_cache_path,
            @body_cached,
            @body_truncated,
            @body_cached_bytes,
            @invite_json,
            @first_seen_at,
            @last_synced_at
          )
          `,
        )
        .run({
          ...payload,
          first_seen_at: timestamp,
          last_synced_at: timestamp,
        });
      return;
    }

    this.connection
      .prepare(
        `
        UPDATE messages
        SET thread_ref = @thread_ref,
            subject = @subject,
            from_name = @from_name,
            from_email = @from_email,
            to_json = @to_json,
            cc_json = @cc_json,
            sent_at = @sent_at,
            received_at = @received_at,
            unread = @unread,
            snippet = @snippet,
            body_cache_path = @body_cache_path,
            body_cached = @body_cached,
            body_truncated = @body_truncated,
            body_cached_bytes = @body_cached_bytes,
            invite_json = @invite_json,
            last_synced_at = @last_synced_at
        WHERE message_ref = @message_ref
        `,
      )
      .run({
        ...payload,
        last_synced_at: timestamp,
      });
  }

  replaceThreadMessages(threadRef: string, messageRefs: string[]): void {
    this.connection.prepare("DELETE FROM thread_messages WHERE thread_ref = ?").run(threadRef);
    const insert = this.connection.prepare(
      `
      INSERT INTO thread_messages (
        thread_ref,
        message_ref,
        position
      ) VALUES (?, ?, ?)
      `,
    );
    for (const [index, messageRef] of messageRefs.entries()) {
      insert.run(threadRef, messageRef, index);
    }
  }

  replaceAttachments(
    messageRef: string,
    attachments: Array<{
      attachment_id: string;
      filename: string;
      mime_type: string;
      size_bytes: number | null;
      inline: boolean;
      saved_to: string | null;
    }>,
  ): void {
    const existingSavedTo = new Map(
      this.listAttachmentsForMessage(messageRef).map((attachment) => [attachment.attachment_id, attachment.saved_to]),
    );
    this.connection.prepare("DELETE FROM attachments WHERE message_ref = ?").run(messageRef);
    const insert = this.connection.prepare(
      `
      INSERT INTO attachments (
        attachment_id,
        message_ref,
        filename,
        mime_type,
        size_bytes,
        inline,
        saved_to
      ) VALUES (
        @attachment_id,
        @message_ref,
        @filename,
        @mime_type,
        @size_bytes,
        @inline,
        @saved_to
      )
      `,
    );

    for (const attachment of attachments) {
      insert.run({
        ...attachment,
        message_ref: messageRef,
        inline: attachment.inline ? 1 : 0,
        saved_to: attachment.saved_to ?? existingSavedTo.get(attachment.attachment_id) ?? null,
      });
    }
  }

  updateAttachmentSavedTo(attachmentId: string, savedTo: string | null): void {
    this.connection
      .prepare(
        `
        UPDATE attachments
        SET saved_to = ?
        WHERE attachment_id = ?
        `,
      )
      .run(savedTo, attachmentId);
  }

  upsertSummary(threadRef: string, summary: ThreadSummary, fingerprint: string | null): void {
    this.connection
      .prepare(
        `
        INSERT INTO summaries (
          thread_ref,
          backend,
          model,
          brief,
          needs_action,
          importance,
          fingerprint,
          generated_at
        ) VALUES (
          @thread_ref,
          @backend,
          @model,
          @brief,
          @needs_action,
          @importance,
          @fingerprint,
          @generated_at
        )
        ON CONFLICT(thread_ref) DO UPDATE SET
          backend = excluded.backend,
          model = excluded.model,
          brief = excluded.brief,
          needs_action = excluded.needs_action,
          importance = excluded.importance,
          fingerprint = excluded.fingerprint,
          generated_at = excluded.generated_at
        `,
      )
      .run({
        thread_ref: threadRef,
        backend: summary.backend,
        model: summary.model,
        brief: summary.brief,
        needs_action: summary.needs_action ? 1 : 0,
        importance: summary.importance,
        fingerprint,
        generated_at: nowIsoUtc(),
      });
  }

  clearSummary(threadRef: string): void {
    this.connection
      .prepare(
        `
        DELETE FROM summaries
        WHERE thread_ref = ?
        `,
      )
      .run(threadRef);
  }

  findStoredSummary(threadRef: string): StoredSummaryRecord | null {
    const row = this.connection
      .prepare(
        `
        SELECT thread_ref, backend, model, brief, needs_action, importance, fingerprint
        FROM summaries
        WHERE thread_ref = ?
        LIMIT 1
        `,
      )
      .get(threadRef) as StoredSummaryRecord | undefined;

    if (!row) {
      return null;
    }

    return row;
  }

  createSession(input: {
    session_id: string;
    account_id: string;
    provider: string;
    transport: string;
    socket_path: string;
    auth_token: string;
    idle_timeout_seconds: number;
    max_age_seconds: number;
  }): StoredSessionRecord {
    const timestamp = nowIsoUtc();
    this.connection
      .prepare(
        `
        INSERT INTO sessions (
          session_id,
          account_id,
          provider,
          transport,
          socket_path,
          auth_token,
          status,
          pid,
          idle_timeout_seconds,
          max_age_seconds,
          error_detail,
          created_at,
          last_used_at,
          closed_at
        ) VALUES (
          @session_id,
          @account_id,
          @provider,
          @transport,
          @socket_path,
          @auth_token,
          'starting',
          NULL,
          @idle_timeout_seconds,
          @max_age_seconds,
          NULL,
          @created_at,
          @last_used_at,
          NULL
        )
        `,
      )
      .run({
        ...input,
        created_at: timestamp,
        last_used_at: timestamp,
      });
    return this.getSession(input.session_id)!;
  }

  getSession(sessionId: string): StoredSessionRecord | undefined {
    return this.connection
      .prepare(
        `
        SELECT
          session_id,
          account_id,
          provider,
          transport,
          socket_path,
          auth_token,
          status,
          pid,
          idle_timeout_seconds,
          max_age_seconds,
          error_detail,
          created_at,
          last_used_at,
          closed_at
        FROM sessions
        WHERE session_id = ?
        LIMIT 1
        `,
      )
      .get(sessionId) as StoredSessionRecord | undefined;
  }

  listSessions(): StoredSessionRecord[] {
    return this.connection
      .prepare(
        `
        SELECT
          session_id,
          account_id,
          provider,
          transport,
          socket_path,
          auth_token,
          status,
          pid,
          idle_timeout_seconds,
          max_age_seconds,
          error_detail,
          created_at,
          last_used_at,
          closed_at
        FROM sessions
        ORDER BY created_at DESC
        `,
      )
      .all() as StoredSessionRecord[];
  }

  markSessionRunning(sessionId: string, pid: number | null): void {
    this.connection
      .prepare(
        `
        UPDATE sessions
        SET status = 'running',
            pid = ?,
            error_detail = NULL,
            closed_at = NULL
        WHERE session_id = ?
        `,
      )
      .run(pid, sessionId);
  }

  updateSessionProcessInfo(sessionId: string, pid: number | null): void {
    this.connection
      .prepare(
        `
        UPDATE sessions
        SET pid = ?
        WHERE session_id = ?
        `,
      )
      .run(pid, sessionId);
  }

  touchSession(sessionId: string): void {
    this.connection
      .prepare(
        `
        UPDATE sessions
        SET last_used_at = ?
        WHERE session_id = ?
        `,
      )
      .run(nowIsoUtc(), sessionId);
  }

  markSessionClosed(
    sessionId: string,
    status: StoredSessionRecord["status"],
    options: { errorDetail?: string | null; pid?: number | null } = {},
  ): void {
    this.connection
      .prepare(
        `
        UPDATE sessions
        SET status = @status,
            error_detail = @error_detail,
            pid = @pid,
            closed_at = @closed_at
        WHERE session_id = @session_id
        `,
      )
      .run({
        session_id: sessionId,
        status,
        error_detail: options.errorDetail ?? null,
        pid: options.pid ?? null,
        closed_at: nowIsoUtc(),
      });
  }

  findSummary(threadRef: string): ThreadSummary | null {
    const row = this.findStoredSummary(threadRef);
    if (!row) {
      return null;
    }

    return {
      backend: row.backend,
      model: row.model,
      brief: row.brief,
      needs_action: Boolean(row.needs_action),
      importance: row.importance,
    };
  }

  listAttachmentsForMessage(messageRef: string): Array<{
    attachment_id: string;
    filename: string;
    mime_type: string;
    size_bytes: number | null;
    inline: number;
    saved_to: string | null;
  }> {
    return this.connection
      .prepare(
        `
        SELECT attachment_id, filename, mime_type, size_bytes, inline, saved_to
        FROM attachments
        WHERE message_ref = ?
        ORDER BY filename ASC
        `,
      )
      .all(messageRef) as Array<{
      attachment_id: string;
      filename: string;
      mime_type: string;
      size_bytes: number | null;
      inline: number;
      saved_to: string | null;
    }>;
  }

  getStoredMessage(messageRef: string): StoredMessageRecord | undefined {
    return this.connection
      .prepare(
        `
        SELECT
          message_ref,
          account_id,
          thread_ref,
          subject,
          from_name,
          from_email,
          to_json,
          cc_json,
          sent_at,
          received_at,
          unread,
          snippet,
          body_cache_path,
          body_cached,
          body_truncated,
          body_cached_bytes,
          invite_json
        FROM messages
        WHERE message_ref = ?
        LIMIT 1
        `,
      )
      .get(messageRef) as StoredMessageRecord | undefined;
  }

  getStoredThread(threadRef: string): StoredThreadRecord | undefined {
    return this.connection
      .prepare(
        `
        SELECT
          thread_ref,
          account_id,
          subject,
          mailbox,
          participants_json,
          labels_json,
          received_at,
          message_count,
          unread_count,
          has_attachments
        FROM threads
        WHERE thread_ref = ?
        LIMIT 1
        `,
      )
      .get(threadRef) as StoredThreadRecord | undefined;
  }

  updateInviteStatusForThread(threadRef: string, responseStatus: string | null): void {
    this.updateInviteForThread(threadRef, { response_status: responseStatus });
  }

  updateInviteForThread(threadRef: string, patch: Partial<MessageInvite>): void {
    const rows = this.connection
      .prepare(
        `
        SELECT message_ref, invite_json
        FROM messages
        WHERE thread_ref = ?
          AND invite_json IS NOT NULL
        `,
      )
      .all(threadRef) as Array<{ message_ref: string; invite_json: string }>;

    if (rows.length === 0) {
      return;
    }

    const update = this.connection.prepare(
      `
      UPDATE messages
      SET invite_json = @invite_json,
          last_synced_at = @last_synced_at
      WHERE message_ref = @message_ref
      `,
    );
    const lastSyncedAt = nowIsoUtc();

    for (const row of rows) {
      const invite = JSON.parse(row.invite_json) as MessageInvite;
      update.run({
        message_ref: row.message_ref,
        invite_json: JSON.stringify({ ...invite, ...patch }),
        last_synced_at: lastSyncedAt,
      });
    }
  }

  listMessageRefsForThread(threadRef: string): string[] {
    return (
      this.connection
        .prepare(
          `
          SELECT message_ref
          FROM thread_messages
          WHERE thread_ref = ?
          ORDER BY position ASC
          `,
        )
        .all(threadRef) as Array<{ message_ref: string }>
    ).map((row) => row.message_ref);
  }

  listStoredMessagesForThread(threadRef: string): StoredMessageRecord[] {
    return this.connection
      .prepare(
        `
        SELECT
          m.message_ref,
          m.account_id,
          m.thread_ref,
          m.subject,
          m.from_name,
          m.from_email,
          m.to_json,
          m.cc_json,
          m.sent_at,
          m.received_at,
          m.unread,
          m.snippet,
          m.body_cache_path,
          m.body_cached,
          m.body_truncated,
          m.body_cached_bytes,
          m.invite_json
        FROM thread_messages tm
        INNER JOIN messages m ON m.message_ref = tm.message_ref
        WHERE tm.thread_ref = ?
        ORDER BY tm.position ASC
        `,
      )
      .all(threadRef) as StoredMessageRecord[];
  }

  markThreadArchived(threadRef: string): void {
    this.connection
      .prepare(
        `
        UPDATE threads
        SET mailbox = 'archive',
            labels_json = '["archive"]',
            last_synced_at = @last_synced_at
        WHERE thread_ref = @thread_ref
        `,
      )
      .run({
        thread_ref: threadRef,
        last_synced_at: nowIsoUtc(),
      });
  }

  updateMessagesUnreadState(messageRefs: string[], unread: boolean): void {
    if (messageRefs.length === 0) {
      return;
    }

    const update = this.connection.prepare(
      `
      UPDATE messages
      SET unread = @unread,
          last_synced_at = @last_synced_at
      WHERE message_ref = @message_ref
      `,
    );
    const lastSyncedAt = nowIsoUtc();

    for (const messageRef of messageRefs) {
      update.run({
        message_ref: messageRef,
        unread: unread ? 1 : 0,
        last_synced_at: lastSyncedAt,
      });
    }
  }

  recomputeThreadUnreadCounts(threadRefs: string[]): void {
    if (threadRefs.length === 0) {
      return;
    }

    const selectUnreadCount = this.connection.prepare(
      `
      SELECT COUNT(*) AS unread_count
      FROM messages
      WHERE thread_ref = ?
        AND unread = 1
      `,
    );
    const updateThread = this.connection.prepare(
      `
      UPDATE threads
      SET unread_count = @unread_count,
          labels_json = @labels_json,
          last_synced_at = @last_synced_at
      WHERE thread_ref = @thread_ref
      `,
    );
    const lastSyncedAt = nowIsoUtc();

    for (const threadRef of new Set(threadRefs)) {
      const row = selectUnreadCount.get(threadRef) as { unread_count: number };
      const unreadCount = row?.unread_count ?? 0;
      updateThread.run({
        thread_ref: threadRef,
        unread_count: unreadCount,
        labels_json: JSON.stringify(unreadCount > 0 ? ["inbox", "unread"] : ["inbox"]),
        last_synced_at: lastSyncedAt,
      });
    }
  }

  findMessageByRef(messageRef: string): {
    message_ref: string;
    thread_ref: string;
    account_id: string;
  } | undefined {
    return this.connection
      .prepare(
        `
        SELECT message_ref, thread_ref, account_id
        FROM messages
        WHERE message_ref = ?
        LIMIT 1
        `,
      )
      .get(messageRef) as
      | {
          message_ref: string;
          thread_ref: string;
          account_id: string;
        }
      | undefined;
  }

  findThreadByRef(threadRef: string): {
    thread_ref: string;
    account_id: string;
  } | undefined {
    return this.connection
      .prepare(
        `
        SELECT thread_ref, account_id
        FROM threads
        WHERE thread_ref = ?
        LIMIT 1
        `,
      )
      .get(threadRef) as
      | {
          thread_ref: string;
          account_id: string;
        }
      | undefined;
  }

  findAttachmentById(attachmentId: string): {
    attachment_id: string;
    message_ref: string;
  } | undefined {
    return this.connection
      .prepare(
        `
        SELECT attachment_id, message_ref
        FROM attachments
        WHERE attachment_id = ?
        LIMIT 1
        `,
      )
      .get(attachmentId) as
      | {
          attachment_id: string;
          message_ref: string;
        }
      | undefined;
  }
}
