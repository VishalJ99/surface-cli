# PER-304 remembered auth env boundary

## Decision

`surface auth login --remember-me` should write remembered-auth metadata to Surface state, not raw
provider credentials. Local login may also update the project `.env` compatibility marker.

## Rationale

The user asked for remembered auth so automation can catch stale sessions. Remote auth already
knows the remote Surface auth/state root, so requiring `--remote-project-dir` for remembered auth
was unnecessary and made the command harder than the desired contract. Surface already has accepted
decisions that provider auth state belongs under local auth storage, not config or tracked project
files. Storing OAuth refresh tokens, Outlook browser cookies, or mailbox passwords directly in
`.env` would raise disclosure risk and create a second source of truth.

## Implementation Direction

- write `remembered-auth.json` under the Surface state root with a JSON account array and
  `auth_check_interval_seconds`
- for local login only, also write `SURFACE_REMEMBERED_AUTH_ACCOUNTS` as a JSON array and
  `SURFACE_AUTH_CHECK_INTERVAL_SECONDS` to `.env` as a compatibility marker
- keep provider tokens/profiles/password state in Surface auth storage
- let advanced local users point `SURFACE_CACHE_DIR` at a project-local ignored directory when they
  intentionally want all Surface state local to the checkout
- only auto-load those remembered-auth/local-state keys from project `.env`; write-safety and
  summarizer settings remain explicit process-env or `config.toml` policy
- expose `surface auth check --remembered-only --due-only` as the scheduler-friendly stale-auth
  probe
- support `surface auth login <account> --remote-host <host> --remember-me` by writing the marker
  in the remote Surface state root after remote auth succeeds; do not require `--remote-project-dir`

## Review Needed

Confirm whether this safer interpretation satisfies the desired OpenClaw/Codex automation workflow,
or whether a narrower provider-specific secret export is needed later.
