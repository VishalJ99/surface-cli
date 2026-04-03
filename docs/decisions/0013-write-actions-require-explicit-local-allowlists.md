# ADR 0013: Live Write Actions Require Explicit Local Enablement And Allowlists

## Status

Accepted

## Context

Surface CLI can execute live mail actions such as send, reply, forward, RSVP, and archive.
Those actions must not become ambiently available just because an auth profile exists.

## Decision

Live write actions require explicit local configuration:

- `SURFACE_WRITES_ENABLED=1`
- an allowed `SURFACE_SEND_MODE`
- recipients on `SURFACE_TEST_RECIPIENTS` for send-like actions
- account names on `SURFACE_TEST_ACCOUNT_ALLOWLIST` when an allowlist is configured

`archive` is still gated by write enablement and account allowlists, but it does not check recipients.

## Consequences

- live sends do not happen by default
- local test environments can opt into controlled write-path verification
- safety policy lives in config/env rather than being hardcoded to one mailbox or repo state
- provider adapters can implement live actions without weakening the default safety posture
