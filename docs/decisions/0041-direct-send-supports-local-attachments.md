# ADR 0041: Direct Send Supports Local Attachments

## Status

Accepted

## Context

`surface mail send` is the user-facing command for composing a new outbound message. The command
already supports direct send versus draft disposition through `--draft`, but it did not expose a
public way to include local files.

Attachments are provider-neutral at the CLI boundary but provider-specific at transport time:

- Gmail sends or drafts raw MIME through Google APIs.
- Generic IMAP/SMTP sends raw MIME through SMTP and appends stored copies through IMAP.
- Outlook v1 composes through Outlook Web UI automation.

## Decision

Expose repeatable direct-send attachment input as:

```bash
surface mail send ... --attach ./file-a.txt --attach ./file-b.pdf
```

The CLI resolves each path before provider dispatch and passes normalized attachment data through
`SendMessageInput.attachments`:

- absolute local path for transports that need browser upload
- filename
- MIME type inferred from common file extensions, falling back to `application/octet-stream`
- byte size
- base64 bytes for API/SMTP MIME composition

`SendResultEnvelope.attachments` exposes only filename, MIME type, and size. It must not expose local
paths or file bytes.

In v1, attachment upload is scoped to the direct `mail send` command. Reply, reply-all, and forward
attachment upload remain future work because they need separate action semantics and provider UI/API
validation.

## Consequences

- Gmail and IMAP/SMTP can share the same multipart MIME builder.
- IMAP/SMTP keeps Bcc out of the delivery MIME while preserving it in the stored sent/draft copy.
- Outlook continues to use the accepted Playwright UI write path and uploads local files through the
  compose attachment controls.
- Result JSON grows an `attachments` metadata array for all send-like result envelopes; commands
  without uploaded attachments return an empty array.
