# ADR 0014: Outlook Mail Writes Use Playwright UI Fallbacks Where OWA Payloads Are Unstable

## Status

Accepted

## Context

Outlook Web exposes two broad paths for live actions:

- direct `service.svc` calls such as `CreateItem`
- browser-visible UI actions driven through Playwright

RSVP was stabilized through direct `CreateItem` response objects, but general message-compose
payloads for send, reply, reply-all, and forward proved brittle. Slight payload mismatches returned
`OwaSerializationException`, and the exact compose shape varied across actions.

Separately, Outlook does not always expose the same controls in the same place:

- `Reply all` may be hidden behind the message overflow menu and then require a second inline
  activator click before the compose editor becomes editable
- `Archive` may be available from the inbox-selection ribbon while being absent in search/read views

## Decision

For Outlook v1:

- keep RSVP on direct OWA `CreateItem`
- implement send, reply, reply-all, forward, and archive through Playwright UI automation
- explicitly support documented selector fallbacks when the primary control is not exposed

## Consequences

- the write path is slower than a perfect direct API integration, but it is much easier to keep working
- selector fallbacks are transport-specific and must be documented when they materially affect behavior
- future work can replace individual UI actions with direct OWA calls if those payloads become stable enough
