# ADR 0020: Gmail Auth Uses Loopback OAuth And Stored Refresh Tokens

## Status

Accepted

## Context

Unlike Outlook Web, Gmail does not require a persisted browser session for the provider
contract Surface needs. Gmail exposes a stable API surface, so the useful auth state is
OAuth token material rather than a long-lived browser profile.

Surface also needs a Gmail auth flow that works on a remote machine such as a headless
Mac mini without copying a browser profile around.

## Decision

For `provider=gmail`, `transport=gmail-api`:

- use a Google desktop-app OAuth client
- run a local loopback callback server on the Surface host
- print the Google auth URL so the user can open it in any browser that can reach the
  forwarded localhost callback
- copy the chosen `client_secret.json` into:
  - `~/.surface-cli/auth/<account_id>/client_secret.json`
- store the resulting refresh-token state under:
  - `~/.surface-cli/auth/<account_id>/gmail-token.json`

The default callback port is fixed for operational simplicity and may be overridden with
`SURFACE_GMAIL_CALLBACK_PORT`.

Remote auth is expected to work through SSH local port forwarding rather than a browser
session running on the Surface host.

## Consequences

- Gmail auth is lighter and easier to migrate than Outlook auth
- Gmail commands can refresh access tokens headlessly after the one-time consent flow
- Surface does not need a persistent Gmail browser profile or a profile-copy workflow
- the Gmail auth flow depends on access to a Google desktop OAuth client secret file
