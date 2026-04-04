# ADR 0021: Local `config.toml` Stores Policy, Not Account State

## Status

Accepted

## Context

Surface now needs a durable local place for settings such as:

- outbound test recipients
- test account allowlists
- summarizer preferences
- timeout and result-limit overrides

At the same time, Surface already has two better sources of truth for mutable mail state:

- SQLite for accounts, refs, cache metadata, and provider locators
- `~/.surface-cli/auth/` for tokens and browser profiles

Mixing account registry or auth state into `config.toml` would create drift and force Surface
to keep the same information synchronized across multiple stores.

## Decision

Surface should create `~/.surface-cli/config.toml` automatically when missing, but the file is
only for local policy and preference knobs.

It should not become the source of truth for:

- account registration
- provider transport identity
- OAuth tokens
- browser profiles

Those remain in SQLite and `~/.surface-cli/auth/`.

## Consequences

- agents have one stable local place to read outbound-test policy without exposing private
  addresses in the tracked repo
- account add/remove/auth flows do not need to mirror provider state into config
- local config cleanup on account rename/remove remains a separate UX decision rather than an
  accidental side effect of the storage model
