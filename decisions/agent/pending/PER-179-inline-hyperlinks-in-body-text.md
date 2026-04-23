# Decision: Preserve HTML hyperlinks inline in cached body text
Ticket: PER-179
Timestamp: 2026-04-23T11:45:00Z

## What I decided
Keep the single public/stored `body.text` field and preserve HTML anchor targets inline as
`anchor text[URL]` during HTML-to-text normalization.

## Why
The current plain-text cache drops HTML-only link targets, which makes cached reads lose important
operational links such as Dropbox handoff URLs. A new `links[]` field would widen the public
contract and stored message shape for a problem that can be solved inside the existing text field.

## Impact
Cached `body.txt` content changes for HTML messages with anchors. Outlook and Gmail both inherit the
behavior through the shared HTML normalizer.

## How to undo
Revert the shared HTML normalization change and ADR 0036, then regenerate any message cache entries
that should drop inline URLs again.
