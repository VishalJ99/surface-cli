# ADR 0046: Expose Surface Through a Typed MCP Wrapper

## Status

Proposed

## Context

Surface already exposes its supported behavior through a JSON-first CLI contract. The CLI owns
account and stable-ref resolution, provider dispatch, write-policy enforcement, cache and database
cleanup, and stable success and error envelopes. Reimplementing those concerns inside an MCP server
would create a second public contract that could drift from the CLI.

ChatGPT can connect to a local stdio MCP server through Secure MCP Tunnel. MCP tool descriptions,
schemas, and safety annotations are visible to the model, so a generic command runner would expose
more host authority than the mail workflows require and would make individual operations harder to
describe accurately.

## Decision

Surface ships a `surface-mcp` stdio executable built with the stable MCP TypeScript v2 server
package. It invokes the co-packaged `dist/cli.js` with `process.execPath`, an explicit argument array,
atomic `--flag=value` tokens for every value-bearing option, and `shell: false`. Calls are serialized
through a single FIFO because CLI processes share Surface state and provider session resources. The
wrapper parses the CLI's single JSON stdout envelope and
returns it as schema-advertised MCP structured content. Errors from non-idempotent tools are
conservatively changed to non-retryable `mcp_outcome_unknown` unless the wrapper can prove they
occurred before the provider action, because an action may have completed before a later failure.
Timeouts, oversized output, malformed output, and subprocess failures become bounded MCP errors;
stderr is never returned as model-visible content.

The server exposes one typed tool for every established mail, attachment, session, account-list,
identity-read, and non-interactive auth-check capability. Mixed-semantics CLI flags become separate
MCP tools: draft versus live send, rebaseline versus normal unread sync, and mark-read versus message
read. Live sends, replies, forwards, RSVP, archive, read-state changes, rebaseline, session stop, and
attachment download require an explicit confirmation input in addition to Surface's existing
server-side write and recipient allowlists.

The MCP boundary does not expose a raw command tool, global `--config`, account mutation, interactive
login or logout, `auth check --login-if-stale`, skill installation, or cache administration. Those
remain local operator tasks. Configuration and state paths are fixed in the server environment.
Compose attachment paths are disabled unless they resolve inside roots configured through
`SURFACE_MCP_ATTACHMENT_ROOTS`; tool callers cannot select new roots. Roots must be absolute and
narrower than the filesystem root, and per-file plus aggregate size limits apply before execution.
Mail content is treated as untrusted external data and cannot relax confirmations or Surface policy.

Provider-controlled filenames are sanitized before attachment downloads are written. This applies
to every provider because the MCP attachment tool makes the download path remotely invocable.
After a successful download, the wrapper verifies that the canonical file remains inside Surface's
download root and embeds bounded bytes as an MCP resource. The MCP result redacts the absolute
`saved_to` path; oversized files remain host-local with an opaque delivery status.

The initial transport is stdio only. Secure MCP Tunnel provides the private bridge to ChatGPT; a
public HTTPS transport and public plugin distribution are separate deployment decisions.

## Consequences

- MCP behavior inherits Surface's CLI, provider, stable-ref, JSON-envelope, and write-safety contracts
  instead of duplicating them.
- focused schemas and static safety annotations let ChatGPT distinguish reads, drafts, and live writes
- subprocess isolation adds startup overhead, and FIFO execution limits throughput, in exchange for a
  narrow and auditable host boundary
- interactive authentication and local administration must still be performed with `surface` outside
  ChatGPT
- local file attachment support requires an explicit server-side allowlisted staging root
- compose can use only pre-staged host files; remote upload/staging remains a separate design
- bounded downloaded attachments are returned as embedded MCP resources instead of unusable
  host-only paths
- ambiguous non-idempotent CLI errors are deliberately reclassified at the MCP boundary to prevent
  unsafe automatic retries
- Gmail attachment-download filename handling is tightened to preserve the provider-wide path
  containment invariant
- promoting this ADR to Accepted requires review of the matching PER-454 agent decision
