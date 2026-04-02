# ADR 0002: Use SQLite For Local State

## Status

Accepted

## Context

Surface CLI needs stable local refs, fast lookup for later commands, and a normalized
cache across multiple searches, unread fetches, providers, and accounts.

## Decision

Use a local SQLite database as the source of truth for normalized mail state and cache metadata.

## Consequences

- later commands do not depend on prior search JSON files
- `search` and `fetch-unread` should upsert into SQLite
- schema migrations will be required over time
- large body content and attachments may still live on disk with SQLite metadata pointers
