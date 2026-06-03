# ADR 0040: Generic IMAP Uses IMAP/SMTP Transport

## Status

Accepted

## Context

Generic mailbox providers such as GMX expose reading and mailbox mutations through IMAP, but
sending still happens through SMTP. Users think of this as one mail account, while Surface needs a
transport name that is precise enough for auth, write behavior, and debugging.

Surface also keeps account state in SQLite and auth material under `~/.surface-cli/auth/`; local
policy remains in `config.toml`. Adding generic IMAP support should not change the normalized
provider database schema.

## Decision

Surface adds `provider = "imap"` with default `transport = "imap-smtp"`.

`surface auth login <account>` for this transport stores IMAP host/port/security, SMTP
host/port/security, username, and mailbox/app password in the account auth directory. The password
must come from a local source such as an environment variable, file, or password-command; it is not
stored in the public repo, command docs, or `config.toml`.

IMAP locators use the existing provider locator table. Thread and message identity is based on the
mailbox plus IMAP UID/UIDVALIDITY, with RFC message IDs used as additional metadata when present.

## Consequences

- Generic IMAP accounts do not need a Google Cloud project or OAuth client JSON.
- Existing Gmail and Outlook account behavior remains unchanged.
- The existing SQLite schema remains sufficient because provider locators already store
  transport-specific JSON.
- RSVP remains unsupported for generic IMAP until calendar invite execution is explicitly designed.
