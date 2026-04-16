# ADR 0026: Gmail RSVP Is Deferred To Explicit Google Calendar Integration

## Status

Superseded by `0029-gmail-rsvp-uses-google-calendar-api.md`

## Context

Surface supports RSVP for Outlook because Outlook Web exposes meeting-response objects through the
mail-side OWA flow.

For Gmail, invite messages can be detected from calendar MIME parts inside email, but actually
changing RSVP state is a calendar operation rather than a Gmail mail mutation.

## Decision

Gmail v1 should detect invite-like messages in read/search output, but `surface mail rsvp` for
Gmail remains deferred until Surface adds explicit Google Calendar integration.

The follow-up implementation is tracked separately and should not be faked through partial Gmail
mail-only heuristics.

## Consequences

- Gmail v1 keeps read/search parity with Outlook while remaining honest about RSVP support
- invite metadata may show `is_invite: true` with `rsvp_supported: false`
- future Gmail RSVP work will require additional Google Calendar scopes and account re-consent
- the deferred implementation is tracked outside the core Gmail v1 milestone
