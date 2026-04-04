# ADR 0023: Gmail Attachment Bytes Come From Inline Parts Or `attachments.get`

## Status

Accepted

## Context

Surface needs Gmail attachment download behavior that matches the provider-neutral contract:

- attachment metadata is returned from `read` / `attachment list`
- `attachment download` writes bytes under `~/.surface-cli/downloads/<account_id>/...`

Gmail message payloads expose attachment bytes in two different ways:

- small parts may already contain inline base64url data
- larger attachments require `users.messages.attachments.get`

## Decision

When normalizing Gmail messages, Surface stores attachment locator data that is sufficient to
download bytes later. Gmail attachment download should:

1. use inline base64url part data when it is already present
2. otherwise call `users.messages.attachments.get`

The CLI does not rely on browser download prompts or raw MIME reconstruction for Gmail
attachment bytes.

## Consequences

- Gmail attachment download stays fully API-driven and headless
- small attachments can be downloaded without an extra provider round trip
- larger attachments still resolve cleanly from stored Gmail locators
- the stored locator model needs to preserve `message_id` and `attachment_id` for deferred
  downloads
