# Decision: Wrap the Surface JSON CLI with focused MCP tools
Ticket: PER-454
Timestamp: 2026-08-22T14:28:05Z

## What I decided
Implement a stdio MCP server as a typed, serialized subprocess wrapper around the co-packaged
Surface JSON CLI. Use the stable MCP TypeScript v2 server package, retain the stable CLI envelope
shapes, split mixed read/write modes into separately annotated tools, and keep bootstrap, interactive auth, cache
administration, raw commands, caller-selected config, and unrestricted paths outside the MCP surface.

## Why
The CLI is Surface's established public contract and already centralizes provider dispatch, stable
refs, write gates, recipient allowlists, and state cleanup. Calling it with an argv array preserves
those guarantees while avoiding a second orchestration layer. Focused tools give the model accurate
schemas and safety metadata; a raw runner, interactive login, or arbitrary paths would grant
unnecessary host authority. Stdio is sufficient because Secure MCP Tunnel can bridge a local stdio
server into ChatGPT.

## Impact
The package gains a `surface-mcp` executable, typed mail/session tools, a subprocess runner, tests,
and a private-connection runbook. MCP calls are FIFO and bounded. Stable CLI envelope shapes remain,
but ambiguous non-idempotent errors are reclassified as `mcp_outcome_unknown` at the MCP boundary so
clients do not retry an action that may already have completed. Live actions remain subject to both
explicit MCP confirmation and existing Surface policy. Attachment paths work only under narrow,
server-configured allowlisted roots and size bounds. Gmail download filename handling is also
strengthened to preserve the existing provider-wide output-path containment invariant.
Value-bearing CLI options use atomic `--flag=value` tokens so option-looking mail content cannot be
reparsed as executable CLI configuration or change draft/send semantics. Bounded downloaded files
are returned as MCP embedded resources after canonical download-root verification; the MCP boundary
redacts the absolute `saved_to` host path. Larger downloads remain host-local, and compose still
requires files to be pre-staged in allowlisted host roots.

## How to undo
Remove the MCP entrypoint, MCP implementation and tests, package dependencies and bin entry, MCP
documentation, and ADR 0046. The existing `surface` CLI remains unchanged.
