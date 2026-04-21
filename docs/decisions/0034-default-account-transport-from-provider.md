# ADR 0034: Default Account Transport From Provider

## Status

Accepted

## Context

Surface separates provider family from provider transport so the same public model can support
multiple implementations over time, such as API-backed and web-backed adapters. In v1, however,
each provider has exactly one implemented transport:

- Gmail uses `gmail-api`
- Outlook uses `outlook-web-playwright`

Requiring users and agents to pass both `--provider` and `--transport` during account onboarding
exposes implementation detail before it is useful.

## Decision

`surface account add` keeps `--provider` required, but makes `--transport` optional. When omitted,
Surface chooses the v1 default transport from the provider:

- `--provider gmail` defaults to `gmail-api`
- `--provider outlook` defaults to `outlook-web-playwright`

Explicit `--transport` remains supported so future alternate adapters can be selected without
changing the account storage model or public JSON shape.

## Consequences

- Normal onboarding commands are shorter and less brittle for humans and agents.
- Existing accounts and explicit transport usage continue to work.
- If a provider gains multiple production transports later, Surface can either keep the default as
  the recommended transport or require explicit `--transport` only for ambiguous providers.
