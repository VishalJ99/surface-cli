# ADR 0038: Sent Mail Query Is Message-First

## Status

Accepted

## Context

Surface's existing retrieval commands are thread-first. That is correct for inbox triage because
the useful unit is usually a conversation that may need a reply, archive, read-state change, or
watch.

Sent mail is different. A sent-mail query is primarily an action log for the account owner. The
thing the user did is one sent message, even when several sent messages live inside the same
conversation. Returning the last N sent threads would make `--limit` ambiguous and could hide
multiple recent sends in one conversation.

Agents still need a direct way to jump from a sent message back into its conversation when more
context is needed.

## Decision

Add:

```bash
surface mail sent --account <account> [--limit <n>] [--recipient <email>] [--session <session_id>]
```

`sent` is message-first:

- the default limit is 10
- `--limit` means sent messages, not threads
- each result includes both `message_ref` and `thread_ref`
- the public result has top-level `messages[]`, not `threads[]`
- agents should use `surface mail thread get <thread_ref> --refresh` when they need full
  conversation context

The optional `--recipient` filter is a normalized recipient filter for sent messages. Providers may
use native recipient search where available, but the public contract is still based on normalized
message recipients that Surface can expose.

Provider results are still persisted through the existing normalized thread/message cache. No
SQLite schema migration is required for this command because the existing `messages` table already
stores sender, recipients, timestamps, body cache path, and stable refs, while thread-level provider
locators preserve refreshability.

## Consequences

- `search` and `fetch-unread` remain thread-first.
- `sent` can return multiple messages from the same thread.
- `sent` output is smaller and more action-oriented than a full thread result, but includes
  `thread_ref` for follow-up reads.
- Outlook v1 may need to inspect a bounded set of sent-folder conversations and extract
  account-authored messages; account-owner identity should be configured for reliable filtering.
- If a future use case needs fully offline message-first sent history, Surface may add message-level
  mailbox/label columns, but provider-backed v1 sent queries do not require that schema change.
