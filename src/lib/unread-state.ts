import type {
  FetchUnreadQuery,
  NormalizedThreadRecord,
  SyncUnreadStateResultEnvelope,
} from "../contracts/mail.js";
import { resolveProviderAdapter } from "../providers/index.js";
import type { AccountRuntimeContext } from "../runtime.js";
import { sessionFetchUnread } from "../session.js";
import type { StoredUnreadMessageCandidate } from "../state/database.js";
import { toPublicThread } from "./public-mail.js";
import { nowIsoUtc } from "./time.js";

export interface SyncUnreadStateOptions {
  limit: number;
  rebaseline: boolean;
  session?: string;
}

type SyncUnreadStateContext = Pick<AccountRuntimeContext, "account" | "db">;
type FetchUnread = (query: FetchUnreadQuery) => Promise<NormalizedThreadRecord[]>;

function unreadMessagesFromThreads(threads: NormalizedThreadRecord[]): StoredUnreadMessageCandidate[] {
  const unreadMessages: StoredUnreadMessageCandidate[] = [];
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.envelope.unread) {
        unreadMessages.push({
          message_ref: message.message_ref,
          thread_ref: thread.thread_ref,
        });
      }
    }
  }
  return unreadMessages;
}

export async function syncUnreadStateWithFetcher(
  context: SyncUnreadStateContext,
  options: SyncUnreadStateOptions,
  fetchUnread: FetchUnread,
): Promise<SyncUnreadStateResultEnvelope> {
  const query: FetchUnreadQuery = {
    limit: options.limit,
    unread_only: true,
  };

  const rebaselineCleared = options.rebaseline
    ? context.db.clearUnreadForAccount(context.account.account_id)
    : [];

  const threads = await fetchUnread(query);
  const fetchedUnreadMessages = unreadMessagesFromThreads(threads);
  const fetchedUnreadRefs = new Set(fetchedUnreadMessages.map((message) => message.message_ref));

  const localCandidates = options.rebaseline
    ? []
    : context.db.listUnreadMessageCandidatesForAccount(context.account.account_id, query.limit);
  const staleCandidates = localCandidates.filter((message) => !fetchedUnreadRefs.has(message.message_ref));

  if (staleCandidates.length > 0) {
    context.db.updateMessagesUnreadState(
      staleCandidates.map((message) => message.message_ref),
      false,
    );
    context.db.recomputeThreadUnreadCounts(staleCandidates.map((message) => message.thread_ref));
  }

  const providerReturnedLimit = threads.length >= query.limit;

  return {
    schema_version: "1",
    command: "sync-unread-state",
    generated_at: nowIsoUtc(),
    account: context.account.name,
    query,
    mode: options.rebaseline ? "rebaseline" : "bounded",
    status: {
      partial: providerReturnedLimit,
      truncated: providerReturnedLimit,
      reason: providerReturnedLimit ? "provider_returned_limit" : null,
    },
    sync: {
      provider_returned_threads: threads.length,
      provider_unread_messages: fetchedUnreadMessages.length,
      comparison_limit: query.limit,
      local_unread_candidates: localCandidates.length,
      stale_cleared: staleCandidates.length,
      account_unread_cleared_before_fetch: rebaselineCleared.length,
    },
    cleared: staleCandidates,
    threads: threads.map(toPublicThread),
  };
}

export async function syncUnreadState(
  context: AccountRuntimeContext,
  options: SyncUnreadStateOptions,
): Promise<SyncUnreadStateResultEnvelope> {
  return syncUnreadStateWithFetcher(
    context,
    options,
    options.session
      ? (query) => sessionFetchUnread(context, options.session!, query)
      : (query) => resolveProviderAdapter(context.account).fetchUnread(context.account, query, context),
  );
}
