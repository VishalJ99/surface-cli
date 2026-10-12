# ADR 0014: Outlook Mail Writes Use Playwright UI Fallbacks Where OWA Payloads Are Unstable

Related implementation: PER-492

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
- recipient entry can leave the floating suggestions list open after Enter, causing that overlay to
  intercept the next recipient field; Outlook can also rerender the contenteditable while preserving
  committed chips inside it

## Decision

For Outlook v1:

- keep RSVP on direct OWA `CreateItem`
- implement send, reply, reply-all, forward, and archive through Playwright UI automation
- explicitly support documented selector fallbacks when the primary control is not exposed
- for each supplied recipient email, select only the exact raw-address action or an exact directory
  option ending in that address; then wait for the picker to close and verify that Outlook preserved
  every prior chip and committed exactly one new chip with the selected identity
- fail the compose action before subject, body, draft, or send finalization when exact recipient
  selection or chip verification does not succeed

## Consequences

- the write path is slower than a perfect direct API integration, but it is much easier to keep working
- selector fallbacks are transport-specific and must be documented when they materially affect behavior
- Outlook contact chips do not always retain the email in their accessible label; directory options
  therefore provide the exact-address evidence, while the resulting chip must match the selected
  display identity and preserve the previous chip set
- future work can replace individual UI actions with direct OWA calls if those payloads become stable enough
