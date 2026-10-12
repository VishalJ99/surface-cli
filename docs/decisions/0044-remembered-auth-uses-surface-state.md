# ADR 0044: Remembered Auth Uses Surface State

## Status

Accepted

## Context

Surface needs an opt-in marker that tells automation which accounts should receive stale-auth
checks. The marker must work for local and remote auth. Remote auth already resolves the remote
Surface state root so it can place Gmail tokens, Outlook browser profiles, and IMAP auth material
under `auth/<account_id>/`.

Requiring a remote project checkout path for remembered auth created a second location rule that did
not match the rest of auth. It also made the intended reauth command longer than the user-facing
contract:

```bash
surface auth login <account> --remote-host <host> --remember-me
```

## Decision

`surface auth login <account> --remember-me` records remembered-auth metadata in
`remembered-auth.json` under the Surface state root:

- `version`
- `accounts`, written as a JSON array of account names
- `auth_check_interval_seconds`

The file stores only account/check metadata. Raw provider secrets remain in provider auth storage:

- Gmail refresh-token state under `auth/<account_id>/gmail-token.json`
- Outlook browser profiles under `auth/<account_id>/profile`
- IMAP/SMTP auth state under `auth/<account_id>/imap-smtp.json`

Local `--remember-me` also updates the project `.env` marker for compatibility with existing
repo-local automation. Surface continues to auto-load only `SURFACE_CACHE_DIR`,
`SURFACE_REMEMBERED_AUTH_ACCOUNTS`, and `SURFACE_AUTH_CHECK_INTERVAL_SECONDS` from project `.env`.

For `surface auth login <account> --remote-host <host> --remember-me`, Surface writes
`remembered-auth.json` under the remote Surface state root reported by the remote `surface` runtime
after remote auth succeeds. There is no `--remote-project-dir`; scheduled remote checks can run from
any working directory with the returned `check_command`, which includes `SURFACE_CACHE_DIR` when
needed:

```bash
ssh <host> 'SURFACE_CACHE_DIR=/path/to/surface-root surface auth check --remembered-only --due-only'
```

## Consequences

- the complete remote remembered-auth command is
  `surface auth login <account> --remote-host <host> --remember-me`
- remembered auth follows the same root as provider auth material and does not depend on a checkout
  path
- `surface auth check --remembered-only` reads both `remembered-auth.json` and compatibility
  `SURFACE_REMEMBERED_AUTH_ACCOUNTS` values
- malformed remembered-auth state fails closed with `invalid_configuration`
