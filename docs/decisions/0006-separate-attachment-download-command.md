# ADR 0006: Keep Attachment Download Separate From `read`

## Status

Accepted

## Context

`read` is a data retrieval operation and should be safe for both humans and agents.
Downloading attachments writes files and should be an explicit side effect.

## Decision

- `surface mail read <message_ref>` returns message content plus attachment metadata
- `surface attachment list <message_ref>` returns attachment metadata only
- `surface attachment download <message_ref> <attachment_id>` performs the file write

## Consequences

- `read` remains side-effect free
- agents can inspect attachments before deciding to download them
- file writes stay explicit in the command surface
- provider adapters can implement metadata and download behavior independently
