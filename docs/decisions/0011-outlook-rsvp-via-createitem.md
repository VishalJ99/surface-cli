# ADR 0011: Outlook RSVP Uses OWA CreateItem Response Objects

## Status

Accepted

## Context

Surface CLI needs to support live RSVP actions for Outlook school accounts that are only accessible
through Outlook Web and Playwright. The initial browser-driven approach tried to open the calendar
event UI and click Accept, Decline, or Tentative controls, but that was brittle:

- the event was not always visible in the selected calendar view
- the original meeting request page did not consistently expose actionable RSVP controls
- browser automation against the calendar UI was slower and harder to verify

The Outlook conversation payload already exposes meeting-request `ResponseObjects` such as
`AcceptItem`, `TentativelyAcceptItem`, and `DeclineItem`, along with the message `ItemId` and
`ChangeKey`.

## Decision

Implement Outlook RSVP by calling the Outlook Web `service.svc` `CreateItem` action directly with
the corresponding meeting-response object:

- `accept` -> `AcceptItem`
- `decline` -> `DeclineItem`
- `tentative` -> `TentativelyAcceptItem`

The provider stores the message `ChangeKey` in the internal locator so RSVP actions can reference
the meeting request precisely.

After each RSVP action, Surface refreshes the conversation and updates stored invite metadata.
Because Outlook may stop returning the original meeting-request item once response messages exist,
Surface derives the current `invite.response_status` from the latest response message in the thread
and propagates that state back onto invite-bearing messages already stored locally.

## Consequences

- RSVP is faster and more reliable than browser-clicking the calendar UI
- Outlook RSVP depends on having a valid message `ItemId` and `ChangeKey`
- local invite state remains accurate even when the original meeting-request payload becomes stale
- the implementation is Outlook-web-specific and should stay behind the normalized provider adapter
