# ADR 0028: Inline Attachments Are Surfaced In Body Text

## Status

Accepted

## Context

Some messages contain important visual content as inline attachments, especially pasted screenshots in
Outlook or inline MIME image parts in Gmail. In those cases, `body.text` may otherwise omit the
visual content entirely even though the message has meaningful embedded context.

Relying on `attachments[]` alone is not enough for agentic workflows because agents often read body
text first and may not realize there is embedded image content to inspect.

## Decision

Surface keeps inline files in `attachments[]`, but also appends a short plain-text section to
`body.text` whenever inline attachments exist:

- `Inline attachments:`
- one marker per inline item, such as `[inline image: image001.png]`

Image MIME types use `inline image`; all other inline files use `inline attachment`.

## Consequences

- agents can detect embedded visual content from `body.text` without losing the structured
  attachment metadata
- `attachment list` and `attachment download` remain the source of truth for bytes
- plain-text body output may include extra lines for signature images or other small inline assets
  when providers expose them as inline attachments
