# Cache And DB

## Goal

Define the local state model for Surface CLI.

## Current Direction

Use a small local SQLite database as the source of truth for normalized mail state
and cache metadata.

The provider remains the ultimate source of truth when local state is missing,
stale, truncated, or explicitly refreshed.

## What Gets Stored

SQLite should store enough information to resolve refs and power later commands:

- accounts
- `thread_ref`
- `message_ref`
- thread/message relationship
- provider and transport
- provider locator data required for later reads/actions
- normalized envelope metadata
- normalized body metadata
- truncation state
- attachment metadata
- summary metadata
- timestamps such as `first_seen_at`, `last_synced_at`, `last_read_at`

## Cache Behavior

- `search` and `fetch-unread` should upsert results into SQLite.
- They should also cache normalized non-summary body content up to a truncation limit.
- `read <message_ref>` should check local state first.
- On cache miss, truncation, or refresh, `read` should fetch live and update local state.

## Suggested On-Disk Layout

```text
~/.surface-cli/
  state.db
  cache/
    accounts/
      <account_id>/
        messages/
          <message_ref>/
            body.txt
            meta.json
        attachments/
  auth/
    <account_id>/
```

SQLite is the lookup source of truth. File cache is the large-body/attachment storage.

## Cache Clearing

Expected command model:

- `surface cache stats`
- `surface cache prune`
- `surface cache clear --account <account>`
- `surface cache clear --message <message_ref>`
- `surface cache clear --all`

Auth data should not be deleted by cache commands.

## Open Questions

- exact SQLite schema and migration strategy
- whether summaries belong only in SQLite, only on disk, or both
- truncation settings and defaults
- attachment retention policy
- how to represent stale vs fresh mailbox state

See also `docs/m1-checklist.md` and `docs/config.md` for the remaining M1 decisions that
must be frozen before implementation begins.
