# ADR 0043: Remembered Auth Uses Project Dotenv Metadata

## Status

Accepted

## Context

Surface needs an opt-in way for repo-local automation to know which accounts should be checked for
stale auth and how often to run that check. A project `.env` file is convenient because Codex,
OpenClaw, launchd jobs, and shells can load it without changing global machine config.

Surface already stores provider auth material under local auth storage:

- Gmail refresh-token state under `~/.surface-cli/auth/<account_id>/gmail-token.json`
- Outlook browser profiles under `~/.surface-cli/auth/<account_id>/profile`
- IMAP/SMTP auth state under `~/.surface-cli/auth/<account_id>/imap-smtp.json`

Putting raw tokens, browser cookies, or mailbox passwords directly into a tracked project checkout
or a dotenv file would make accidental disclosure more likely and would conflict with ADR 0021.

## Decision

`surface auth login <account> --remember-me` records remembered-auth metadata in the current
project `.env`:

- `SURFACE_REMEMBERED_AUTH_ACCOUNTS`, written as a JSON array of account names
- `SURFACE_AUTH_CHECK_INTERVAL_SECONDS`

The `.env` file is local-only and ignored by git. The provider secrets remain in Surface auth
storage. If the caller wants all Surface state, including auth material, under a project-local
directory, they may set `SURFACE_CACHE_DIR` in `.env`, but `--remember-me` does not write raw
credential values into `.env`.

Surface only auto-loads `SURFACE_CACHE_DIR`, `SURFACE_REMEMBERED_AUTH_ACCOUNTS`, and
`SURFACE_AUTH_CHECK_INTERVAL_SECONDS` from the project `.env`. Write-safety settings, summarizer
settings, and third-party API keys must still come from `config.toml` or the process environment.

For `surface auth login <account> --remote-host <host> --remember-me`, Surface writes the
remembered-auth metadata to the remote host after remote auth succeeds. The default remote project
directory is the same path as the local current working directory, with `--remote-project-dir` as an
override when the remote checkout path differs.

Surface also exposes `surface auth check` as the low-frequency health check entrypoint. The command
uses the existing provider auth probes, records the next due check in local Surface state, and
reports whether re-login is required.

`surface auth check --login-if-stale` may call the provider's normal login flow after a stale probe,
but it cannot silently complete OAuth, Microsoft sign-in, browser 2FA, or missing IMAP password
input. Those steps still require the normal local secret source or user consent.

## Consequences

- automation can run `surface auth check --remembered-only --due-only` on a frequent timer without
  probing providers until the recorded interval is due
- stale Gmail refresh tokens and stale Outlook profiles are detected through the same provider
  checks used by `surface auth status`
- Surface can prompt or launch the normal login flow when explicitly requested, but it does not
  impersonate the user or bypass provider consent
- project `.env` stays useful for local automation while remaining outside the secret source of
  truth
