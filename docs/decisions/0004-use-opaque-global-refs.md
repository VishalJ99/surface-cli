# ADR 0004: Use Opaque Global Refs For Threads, Messages, And Attachments

## Status

Accepted

## Context

Surface CLI commands such as `read`, `attachment list`, and later write actions must
target stable local entities without depending on prior search output files or
provider-specific identifiers.

## Decision

Use opaque globally unique local refs with entity prefixes:

- `thr_<ulid>`
- `msg_<ulid>`
- `att_<ulid>`

These refs are generated and persisted in local state and reused across repeated
provider syncs for the same underlying entity.

## Consequences

- callers treat refs as opaque values
- provider-specific IDs remain internal
- local state must maintain the mapping from refs to provider locators
