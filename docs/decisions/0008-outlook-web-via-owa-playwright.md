# ADR 0008: Implement Outlook Via Playwright And The OWA Conversation API

## Status

Accepted

## Context

Surface CLI must support Outlook accounts that cannot rely on IMAP, especially school
and enterprise web-only flows. Pure IMAP/SMTP abstractions do not cover this reliably.

## Decision

Use a Playwright-backed Outlook transport that:

- authenticates with a persistent Chrome profile
- reaches the mailbox UI in Outlook Web
- captures authenticated OWA service headers from the browser session
- fetches thread content through the OWA conversation API

## Consequences

- Outlook support is not tied to IMAP availability
- the public CLI contract stays provider-neutral even though the Outlook transport is web-driven
- browser profile lifecycle becomes part of provider auth state
- DOM drift and OWA changes remain transport-specific maintenance concerns
