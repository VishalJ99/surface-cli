# ADR 0017: Outlook Attachment Download Uses The OWA-Authenticated REST Endpoint

## Status

Accepted

## Context

Surface already stores stable `message_ref` and `attachment_id` values plus Outlook locator
metadata from the OWA conversation payloads. Attachment download still needed a byte transport.

The obvious UI-driven options are weak:

- DOM scraping does not expose stable attachment download controls for every message shape
- browser download prompts are brittle in headless automation
- opening attachment previews is slower and more error-prone than a direct transport call

We also already capture an authenticated OWA browser session during Outlook commands.

## Decision

Outlook attachment download will:

- use Playwright only to bootstrap an authenticated OWA session and capture request headers
- resolve the stored Outlook `message_id` from the message locator and `attachment_id` from the
  attachment locator
- download bytes from:
  - `https://outlook.office.com/api/v2.0/me/messages('<message_id>')/attachments('<attachment_id>')/$value`
- save files under:
  - `~/.surface-cli/downloads/<account_id>/<message_ref>/<attachment_id>__<filename>`

If either the Outlook `message_id` or `attachment_id` is missing locally, Surface should refresh
the message from Outlook once and retry the download with the refreshed locators before failing.

Downloaded attachment paths are persisted in SQLite via `attachments.saved_to`, and refreshes
should preserve that path when the stable local `attachment_id` is unchanged.

## Consequences

- attachment download does not depend on brittle UI download flows
- the same path works for inline image attachments and regular file attachments
- Surface still depends on a live authenticated Outlook web profile for the initial bearer session
- if Outlook stops honoring the REST path for OWA-issued tokens, a new fallback will need a fresh
  ADR instead of being hidden in the adapter
