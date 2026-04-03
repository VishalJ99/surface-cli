import Database from "better-sqlite3";
import type { DatabaseConnection } from "better-sqlite3";

import type { MailAccount } from "../contracts/account.js";
import { makeAccountId } from "../refs.js";
import { nowIsoUtc } from "../lib/time.js";

export class SurfaceDatabase {
  readonly connection: DatabaseConnection;

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
        locator_json TEXT NOT NULL,
        PRIMARY KEY(entity_kind, entity_ref)
      );

      CREATE TABLE IF NOT EXISTS summaries (
        thread_ref TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        model TEXT NOT NULL,
        brief TEXT NOT NULL,
        needs_action INTEGER NOT NULL DEFAULT 0,
        importance TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        FOREIGN KEY(thread_ref) REFERENCES threads(thread_ref) ON DELETE CASCADE
      );
    `);
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
