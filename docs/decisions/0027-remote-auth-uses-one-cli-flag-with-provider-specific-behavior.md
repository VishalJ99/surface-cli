# ADR 0027: Remote Auth Uses One CLI Flag With Provider-Specific Behavior

## Status

Accepted

## Context

Surface needs to authenticate Gmail and Outlook accounts on a remote headless host, but the
useful auth state is different for each provider:

- Gmail uses OAuth refresh tokens and a loopback callback server
- Outlook Web uses a persisted browser profile/session

We still want one public CLI shape instead of separate bootstrap commands.

## Decision

Use one public command:

- `surface auth login <account> --remote-host <host>`

Provider-specific behavior sits behind that shared flag:

- Gmail:
  - start the SSH loopback tunnel first
  - reuse the remote account's stored `client_secret.json` when present
  - otherwise copy a chosen local `client_secret.json` to the remote account auth directory
  - run the remote Gmail OAuth flow so the callback lands on the remote Surface process
- Outlook:
  - launch local Chrome in a dedicated Surface profile
  - let the user complete Microsoft sign-in locally
  - sync that profile to the remote account auth directory
  - validate the synced profile on the remote host with `surface auth status <account>`

Shared rules:

- the account must already exist on the remote host
- warn before replacement only when the remote account currently reports
  `status = "authenticated"`
- if the remote account is missing auth state or reports `status = "unauthenticated"`,
  proceed without an overwrite warning
- if the remote auth-state probe times out or fails, treat it as best-effort:
  - do not block the remote auth flow just to decide whether to warn
  - proceed without an overwrite warning
  - return `status = "unknown"` if post-sync validation cannot complete

Remote orchestration lives at the CLI layer rather than the provider-adapter interface.

## Consequences

- users learn one remote auth entrypoint instead of a separate bootstrap command
- provider adapters stay focused on local auth mechanics
- Gmail remote auth stays lightweight and token-based
- Outlook remote auth stays explicit about browser-profile transfer
- remote auth depends on SSH and, for Outlook, `rsync` being available on the local machine
