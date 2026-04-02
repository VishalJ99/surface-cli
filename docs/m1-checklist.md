# M1 Checklist

## Goal

Milestone 1 is complete when the public contract, local state model, and provider
implementation boundary are explicit enough that Gmail and Outlook can be built
against them without guessing.

## Already Agreed

- the public command name is `fetch-unread`
- `search` and `fetch-unread` share one result schema
- threads are the top-level result unit
- messages are elements within threads
- `read` takes a stable `message_ref`
- attachment download is a separate command from `read`
- Surface CLI should emit machine-readable JSON to stdout
- Surface CLI should use SQLite as local source of truth for refs and cache metadata
- later commands should resolve refs from SQLite, not from old result JSON files

## Decisions Required To Clear M1

### 1. Exact Public JSON Schema

Freeze the exact stdout JSON contract for:

- `surface mail search`
- `surface mail fetch-unread`
- `surface mail read`
- `surface attachment list`
- `surface attachment download`

This includes:

- exact top-level fields
- exact thread object shape
- exact message object shape
- exact attachment metadata shape
- whether summaries live at thread level, message level, or both

### 2. Stable Ref Format

Freeze:

- how `thread_ref` is generated
- how `message_ref` is generated
- whether refs are opaque UUID/ULID-like values or structured strings
- whether refs are globally unique or only unique within an account

### 3. Provider Locator Storage

Freeze what the local state must retain so later commands can resolve a ref back to
the provider transport.

Examples:

- provider thread identifier
- provider message identifier
- mailbox or folder hint
- web URL if useful
- any transport-specific locator needed for later actions

### 4. Cache And Truncation Semantics

Freeze:

- what `search` and `fetch-unread` cache by default
- whether truncation is measured in bytes
- the default truncation limit
- what `read` does on cache miss
- what `read` does on truncated cache
- whether `read --refresh` exists in v1

### 5. Config Surface

Freeze the initial global settings and their exact names.

Minimum likely set:

- `cache_dir`
- `max_cached_body_bytes`
- `default_result_limit`
- `provider_timeout_ms`
- `summarizer_backend`
- `summarizer_model`
- `summary_input_max_bytes`
- `summarizer_timeout_ms`

### 6. Summary Ownership

Freeze whether summarization is:

- required
- optional
- skipped when no backend is configured

Also freeze what the CLI returns when summary generation does not occur.

### 7. Base Error Shape

Freeze the minimum public error JSON envelope even if the full error catalog lands later.

At minimum:

- error code
- message
- retryability
- relevant ref or account if available

### 8. SQLite Schema Outline

Freeze the first-pass table set at a structural level.

Minimum likely entities:

- accounts
- threads
- messages
- thread_messages
- attachments
- provider_locators
- bodies
- summaries

Exact columns can still evolve in M2, but the model must be agreed in M1.

## Explicitly Deferred To Later Milestones

- full write-action contract details
- detailed Gmail implementation
- detailed Outlook Playwright implementation
- comprehensive error catalog
- contract test harness implementation

## Exit Criteria

M1 is done when:

1. `docs/cli-contract.md` has concrete schemas instead of placeholders
2. `docs/provider-contract.md` defines the stable adapter boundary
3. `docs/cache-and-db.md` defines the lookup and cache model clearly
4. `docs/config.md` defines the initial settings and precedence
5. any remaining architecture choices are captured as ADRs, not chat-only decisions
