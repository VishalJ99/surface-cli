# ADR 0029: Gmail RSVP Uses Google Calendar API

## Status

Accepted

Supersedes: `0026-gmail-rsvp-is-deferred-to-calendar-integration.md`

## Context

Surface already detects Gmail invite messages by parsing `text/calendar` MIME parts in the email
body. The CLI contract for RSVP already exists and is provider-neutral:

```text
surface mail rsvp <message_ref> --response <accept|decline|tentative>
```

Unlike Outlook, Gmail does not expose RSVP as a mail-side mutation. The live response state belongs
to Google Calendar events, keyed from the invite metadata in the email.

## Decision

Surface implements Gmail RSVP by:

- extracting the invite `UID` from the email calendar MIME part
- resolving the matching Google Calendar event via `iCalUID`
- patching the signed-in attendee's `responseStatus` through the Calendar API
- re-reading Calendar state to populate the normalized `invite` result

Gmail RSVP remains behind the existing `mail rsvp` command. No provider-specific CLI is added.

Gmail auth now requires Google Calendar write scope in addition to Gmail scopes. Existing Gmail
accounts must re-run `surface auth login <account>` once after this change so Surface can obtain
the broader token.

Invite reads/searches keep working even if Calendar scope is missing. In that case Surface falls
back to the invite state parsed from the email payload instead of failing the whole read path.

## Consequences

- Gmail invite messages now report `rsvp_supported: true` when Surface has enough invite identity
  to resolve a Calendar event
- `surface mail rsvp` works for Gmail without introducing browser automation
- Gmail invite state after RSVP is sourced from Google Calendar rather than the static email body
- Gmail users need Calendar API enabled in their Google Cloud project and must re-consent once
  after the new scope is added
