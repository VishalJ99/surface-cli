# PER-304 remembered auth env boundary

## Decision

`surface auth login --remember-me` should write remembered-auth metadata to the project `.env`, not
raw provider credentials.

## Rationale

The user asked for project `.env` support so automation can remember auth and catch stale sessions.
Surface already has accepted decisions that provider auth state belongs under local auth storage,
not config or tracked project files. Storing OAuth refresh tokens, Outlook browser cookies, or
mailbox passwords directly in `.env` would raise disclosure risk and create a second source of
truth.

## Implementation Direction

- write `SURFACE_REMEMBERED_AUTH_ACCOUNTS` as a JSON array and
  `SURFACE_AUTH_CHECK_INTERVAL_SECONDS` to `.env`
- keep provider tokens/profiles/password state in Surface auth storage
- let advanced local users point `SURFACE_CACHE_DIR` at a project-local ignored directory when they
  intentionally want all Surface state local to the checkout
- only auto-load those remembered-auth/local-state keys from project `.env`; write-safety and
  summarizer settings remain explicit process-env or `config.toml` policy
- expose `surface auth check --remembered-only --due-only` as the scheduler-friendly stale-auth
  probe
- support `surface auth login <account> --remote-host <host> --remember-me` by writing the marker
  in the remote project `.env` after remote auth succeeds

## Review Needed

Confirm whether this safer interpretation satisfies the desired OpenClaw/Codex automation workflow,
or whether a narrower provider-specific secret export is needed later.
