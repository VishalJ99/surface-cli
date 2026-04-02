# Provider Contract

## Goal

Define the normalized interface each provider transport must implement so Gmail,
Outlook, and later providers can plug into the same CLI contract.

## Terminology

- `provider`
  User-visible provider family such as Gmail or Outlook.
- `transport`
  Concrete integration path such as Gmail API or Outlook Playwright.

Examples:

- `provider=gmail`, `transport=gmail-api`
- `provider=outlook`, `transport=outlook-web-playwright`

## Requirements

Each provider implementation must support:

- account auth lifecycle
- search
- fetch-unread
- read message
- list attachments
- download attachment

Later write actions should also share the same normalized contract.

## Normalization Rules

Provider-specific payloads must be mapped into:

- stable local refs
- normalized envelope data
- normalized body text
- attachment metadata
- provider locator data stored internally for later reads/actions

Public JSON must not leak transport-specific field names unless explicitly documented.

## Capability Model

Each account/provider transport should expose capability flags such as:

- `search`
- `fetch_unread`
- `read`
- `attachment_list`
- `attachment_download`
- `reply`
- `reply_all`
- `forward`
- `archive`
- `rsvp`

Capabilities are account/transport-level. Message applicability should be derived from message facts.

## Conformance Expectations

Each provider should pass the same contract tests for:

- search result schema
- fetch-unread result schema
- read behavior on cache hit and cache miss
- attachment metadata shape
- machine-readable error codes

## Open Questions

- exact interface surface for write actions
- preferred fixture strategy for browser-driven Outlook flows
- exact provider locator format stored in SQLite
