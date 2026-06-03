import type { MailAccount } from "../contracts/account.js";
import type { MessageResult, SentMessageResult, SentQuery } from "../contracts/mail.js";
import type { ProviderContext } from "../providers/types.js";
import { SurfaceError } from "./errors.js";
import { loadStoredThread } from "./stored-mail.js";

export function normalizeComparableEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function accountIdentityEmails(account: MailAccount, context: ProviderContext): Set<string> {
  const identity = context.db.getAccountIdentity(account);
  return new Set(
    [identity.primary_email, account.email, ...identity.email_aliases]
      .map(normalizeComparableEmail)
      .filter(Boolean),
  );
}

export function messageMatchesRecipient(message: MessageResult, recipient: string | undefined): boolean {
  if (!recipient) {
    return true;
  }

  const normalizedRecipient = normalizeComparableEmail(recipient);
  return [...message.envelope.to, ...message.envelope.cc]
    .some((participant) => normalizeComparableEmail(participant.email) === normalizedRecipient);
}

function messageWasSentByAccount(message: MessageResult, emails: Set<string>): boolean {
  const fromEmail = normalizeComparableEmail(message.envelope.from?.email);
  return Boolean(fromEmail && emails.has(fromEmail));
}

export function sentTimestamp(message: Pick<MessageResult, "envelope">): number {
  const parsed = Date.parse(message.envelope.sent_at ?? message.envelope.received_at ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sentMessagesFromStoredThread(
  account: MailAccount,
  context: ProviderContext,
  query: SentQuery,
): SentMessageResult[] {
  if (!query.thread_ref) {
    return [];
  }

  const resolved = context.db.findThreadByRef(query.thread_ref);
  if (!resolved) {
    throw new SurfaceError("not_found", `Thread '${query.thread_ref}' was not found.`, {
      account: account.name,
      threadRef: query.thread_ref,
    });
  }

  if (resolved.account_id !== account.account_id) {
    throw new SurfaceError(
      "invalid_argument",
      `Thread '${query.thread_ref}' does not belong to account '${account.name}'.`,
      {
        account: account.name,
        threadRef: query.thread_ref,
      },
    );
  }

  const thread = loadStoredThread(context.db, account, query.thread_ref);
  if (!thread) {
    throw new SurfaceError("not_found", `Thread '${query.thread_ref}' was not found.`, {
      account: account.name,
      threadRef: query.thread_ref,
    });
  }

  const emails = accountIdentityEmails(account, context);
  return thread.messages
    .filter((message) => messageWasSentByAccount(message, emails))
    .filter((message) => messageMatchesRecipient(message, query.recipient))
    .sort((left, right) => sentTimestamp(right) - sentTimestamp(left))
    .slice(0, query.limit)
    .map((message) => ({
      ...message,
      thread_ref: thread.thread_ref,
      source: thread.source,
    }));
}
