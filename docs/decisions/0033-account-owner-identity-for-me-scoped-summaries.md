# ADR 0033: Store Account-Owner Identity For ME-Scoped Summaries

## Status

Accepted

## Context

Surface summaries expose `needs_action`, but that flag is only useful to automation if it means
"the selected account owner needs to act now." Email transport state alone is not enough for that
semantic. Provider envelopes can identify sender/recipient email addresses, while message bodies
often refer to the user by display name, surname format, initials, or local shorthand.

PER-172 also found that the Outlook `uni` account was registered locally with a placeholder email.
Using that value as ME would make action classification brittle or wrong.

## Decision

Surface stores account-owner identity in SQLite, separate from auth files and local policy config.
The identity includes:

- primary email
- display name
- email aliases
- name aliases
- source/trust metadata for primary email and display name
- verification/update timestamps

`surface account add ... --email <email>` seeds a configured identity. Provider auth may upgrade
that identity when it can prove the authenticated mailbox email. Gmail does this through the Gmail
profile endpoint during `auth login` and `auth status`. Outlook currently does not have a reliable
mailbox identity extraction path, so users can set the identity explicitly:

```bash
surface account identity set uni \
  --email v.jain24@imperial.ac.uk \
  --name "Vishal Jain" \
  --name-alias Vishal \
  --name-alias "Jain, Vishal"
```

Summary generation includes the account-owner identity in the canonical summary payload and prompt.
Summary fingerprints include the prompt version and identity semantics, so old summaries generated
without ME-scoped semantics are invalidated instead of being reused.

When identity changes, Surface clears stored summaries for that account so cache-only reads do not
continue exposing stale `needs_action` values generated under the previous identity.

No mail read/search command accepts per-command ME flags. Commands use the stored identity for the
selected account automatically.

## Consequences

- `needs_action` can be judged from the selected account owner's perspective rather than as a
  generic "thread may need attention" hint.
- Email aliases support deterministic envelope matching, while name aliases help the model interpret
  body-text references such as "Vishal, can you..." without guessing from opaque institutional
  addresses.
- Provider-verified identity is preferred when available, but user-confirmed aliases remain
  necessary for accounts whose email address is not human-readable.
- Outlook needs a future provider-specific identity extraction path if it should become fully
  automatic.
- Summary cache reuse now depends on prompt version and account-owner identity, not just thread
  contents and clipping policy.
