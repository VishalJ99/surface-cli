# ADR 0016: Outlook Drafts Use Autosave And Best-Effort Resolution

## Status

Accepted

## Context

Outlook Web draft creation reuses the same compose flows as live send, reply, reply-all, and
forward, but the UI does not expose one stable "save draft" control across those flows.

Observed behavior in the live Outlook transport:

- new-message compose may expose a visible `Close` control after autosave
- inline reply/reply-all/forward compose often does not expose a usable close control
- autosave can materialize a draft before the compose surface is explicitly closed
- OWA-backed refreshes for drafted messages can return sparse metadata, especially for draft-only
  recipients and body content

## Decision

For Outlook v1:

- `--draft` uses the same compose pipeline as live send-like actions
- the provider waits for Outlook autosave, then uses a visible `Close` control if one exists
- if no close control is available, Surface does not fail draft creation solely because the inline
  compose surface stayed open; it closes the browser session after autosave
- draft resolution is best-effort:
  - new send/forward drafts resolve through a subject search
  - reply/reply-all drafts resolve by refreshing the conversation and reading the latest stored
    message for the thread
- when stored draft metadata is sparse, the action result envelope may fall back to the compose
  input recipients instead of trusting the refreshed provider payload

## Consequences

- Outlook draft creation works for the v1 send-like command set without inventing a second compose path
- draft result envelopes can still return stable `thread_ref` and `message_ref` values in the common case
- `mail read` on a drafted message may still expose incomplete draft metadata until dedicated draft
  lifecycle work lands
- future draft lifecycle commands should treat draft inspection and mutation as a separate piece of
  work rather than assuming send-like `--draft` is already full draft management
