# ADR 0036: HTML Hyperlinks Are Preserved Inline In Body Text

## Status

Accepted

## Context

Surface caches and returns `body.text` as its public message-body field. For HTML-first messages,
that body text is derived by flattening the HTML into plain text.

Without special handling, HTML anchor tags lose their target URLs during that flattening step. The
result is that a cached/plain-text read may show text like `There’s a Dropbox folder here` while
dropping the actual Dropbox URL, even though that URL is operationally important.

Adding a separate `links[]` field would expand the public contract and the stored message shape.

## Decision

Surface preserves HTML hyperlink targets inline in `body.text` instead of adding a new field.

When a message body comes from HTML:

- visible anchor text is emitted as `anchor text[URL]`
- anchors with no visible text emit the bare `URL`
- this happens in the shared HTML-to-text normalization path so the same rule applies to Gmail and
  Outlook body normalization

## Consequences

- cached `body.txt` files and SQLite-backed reads keep operational URLs that would otherwise be lost
- agents can recover actionable links from `body.text` alone without a schema change
- plain-text body output becomes slightly noisier because hyperlink targets are now rendered inline
- existing `body.text` consumers should treat bracketed URLs as normalized plain-text content, not
  as a separate structured field
