# ADR 0019: Live E2E Coverage Stays Opt-In And CLI-Driven In V1

## Status

Accepted

## Context

Surface needs real Outlook end-to-end coverage because the hardest regressions are integration
regressions:

- provider auth/session drift
- write action breakage
- CLI JSON contract mismatches
- SQLite state not matching the action outcome

At the same time, Surface is intentionally lean. Introducing a full browser-test framework,
fixtures service, or a second testing product surface would add a lot of weight for relatively
small immediate value.

## Decision

V1 live integration coverage will use one opt-in TypeScript script that:

- invokes the built `surface` CLI as a subprocess
- consumes stdout JSON exactly like an external agent would
- uses unique subjects and follow-up CLI queries for verification
- only falls back to local SQLite inspection when the public CLI contract does not yet expose the
  state needed for a final assertion

This script is not part of the default build or unit-test flow. It runs only when explicitly
enabled by local environment variables and recipient/account allowlists.

## Consequences

- the e2e path stays lightweight and easy to understand
- the test exercises the real public CLI boundary instead of private helper functions
- v1 avoids a heavyweight dedicated test framework
- some assertions still depend on current CLI contract limits, so future richer public state may
  let the script remove its remaining SQLite fallback
