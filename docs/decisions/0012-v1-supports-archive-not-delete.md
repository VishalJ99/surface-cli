# ADR 0012: Support `archive` In V1, Not `delete`

## Status

Accepted

## Context

Surface CLI is intended to be automation-friendly, and destructive mail actions carry
outsized risk when they are exposed early to agents or scripts.

## Decision

V1 supports `surface mail archive <message_ref>` but does not support `delete`.

## Consequences

- automation can remove mail from the inbox without putting it on a deletion path
- the public action surface stays useful for triage while remaining safer by default
- `delete`, `trash`, and permanent removal flows are deferred until later
