# ADR 0010: Keep Machine-Facing Commands JSON-First On `stdout`

## Status

Accepted

## Context

The primary caller for Surface CLI is automation such as OpenClaw. Human-friendly output
is still useful, but the core contract must be reliable for machine parsing.

## Decision

For machine-facing commands such as:

- `mail search`
- `mail fetch-unread`
- `mail read`
- `attachment list`
- `attachment download`

`stdout` should carry the structured JSON result.

Progress, warnings, and logs belong on `stderr`.

## Consequences

- agents can parse results without relying on a separate skill or pretty-output parser
- JSON output becomes part of the public CLI contract and must be kept stable
- human-oriented output modes, if added later, should remain explicit rather than replacing JSON by default
