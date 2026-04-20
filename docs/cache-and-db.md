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
- summary fingerprint metadata for reuse
- timestamps such as `first_seen_at`, `last_synced_at`, `last_read_at`

## Cache Behavior

- `search` and `fetch-unread` should upsert results into SQLite.
- In the first implementation slice, they should cache full normalized non-summary body content without truncation.
- `search`, `fetch-unread`, and `thread get --refresh` should persist normalized thread/message state before summary generation.
- Summaries should live in SQLite with backend, model, brief, action flags, importance, fingerprint, and generation time.
- When the canonical summary fingerprint is unchanged for the same backend/model, Surface should reuse the stored summary instead of regenerating it.
- `read <message_ref>` should check local state first.
- On cache miss, truncation, or refresh, `read` should fetch live and update local state.

## Suggested On-Disk Layout

```text
~/.surface-cli/
  config.toml
  state.db
  downloads/
    <account_id>/
      <message_ref>/
        <attachment_id>__<filename>
  cache/
    <account_id>/
      messages/
        <message_ref>/
          body.txt
          meta.json
  auth/
    <account_id>/
```

SQLite is the lookup source of truth.

Use the directories this way:

- `auth/`
  provider credentials or browser profiles
- `cache/`
  disposable local cache such as normalized message bodies
- `downloads/`
  explicit user-requested attachment downloads
  Surface should persist the last saved path in SQLite and preserve it across message refreshes
  when the stable `attachment_id` is unchanged

`downloads/` should not be treated as disposable cache.

## Cache Clearing

Expected command model:

- `surface cache stats`
- `surface cache prune`
- `surface cache clear --account <account>`
- `surface cache clear --message <message_ref>`
- `surface cache clear --all`

Auth data should not be deleted by cache commands.
Downloaded attachments should also not be deleted by cache commands unless explicitly documented later.

## Open Questions

- truncation settings and defaults after truncation is introduced
- attachment retention policy
- how to represent stale vs fresh mailbox state

See also `docs/m1-checklist.md` and `docs/config.md` for the remaining M1 decisions that
must be frozen before implementation begins.
