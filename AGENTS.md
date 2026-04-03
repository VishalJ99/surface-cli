# AGENTS.md

## Purpose

Surface CLI is a contract-first mail CLI for multi-provider, multi-account email.
Its primary consumer is external automation such as OpenClaw, but the CLI must also
work standalone.

## Source Of Truth

When changing behavior, consult and keep these in sync in this order:

1. `docs/cli-contract.md`
2. `docs/provider-contract.md`
3. `docs/cache-and-db.md`
4. `docs/decisions/`
5. `README.md`
6. implementation under `src/`

Do not invent behavior that conflicts with these docs.

## Project Layout

- `README.md`
  High-level overview and shape of the tool.
- `docs/cli-contract.md`
  Public commands, flags, refs, and JSON output contracts.
- `docs/provider-contract.md`
  Adapter interface and provider implementation rules.
- `docs/cache-and-db.md`
  SQLite schema, cache paths, truncation, and refresh rules.
- `docs/decisions/`
  ADRs for architecture and public contract decisions.
- `src/cli.ts`
  Root TypeScript CLI entrypoint.
- `src/contracts/`
  Canonical code-level contracts and normalized mail types.
- `src/state/`
  SQLite schema and local state helpers.
- `src/providers/`
  Provider adapters plus donor normalization logic carried forward from the legacy repo.

## Command Model

- Keep `search` and `fetch-unread` aligned to the same result schema.
- `fetch-unread` is a first-class public command name. Do not rename it to `unread`.
- Threads are the top-level result unit.
- Messages are elements inside threads.
- Commands that act on a specific email should accept stable refs, not positional JSON paths.

## Data Model Rules

- Public JSON should expose normalized mail state, not transport-specific payloads.
- Use `thread_ref` and `message_ref` as stable local refs.
- Store transport/provider locators internally so later commands can resolve refs.
- `read` is cache-first, then provider fetch on cache miss, truncation, or refresh.
- `read` returns attachment metadata only.
- Attachment download is a separate command.

## Autonomous Development Safety

- Treat live mailboxes as production data even during development.
- Read-path commands may run autonomously against configured accounts.
- Write actions must remain draft-first unless explicit send behavior is both implemented and locally enabled.
- Do not hardcode real personal email addresses into the public repo for testing.
- Use local-only config or environment variables for test recipients and write-action allowlists.
- Autonomous send tests must only target recipients on the configured allowlist.
- Autonomous test messages should use a clear subject prefix such as `[surface-test]`.
- Prefer self-addressed or sink-mailbox tests over third-party recipients.
- When testing writes, record the created draft or sent message refs in the final response so cleanup is possible.
- If write safety configuration is missing, do not send mail. Draft creation may still be acceptable if the current task requires it.

## Documentation Rules

When changing public behavior:

- update the relevant file in `docs/`
- update or add an ADR if the change affects architecture or contract decisions
- update `README.md` if the high-level shape changed

Do not leave important design decisions only in commits, Linear tickets, or chat history.

## ADR Rules

Create or update an ADR when changing:

- command names
- public JSON schemas
- SQLite schema or lookup model
- cache behavior or truncation policy
- `thread_ref` / `message_ref` format
- summarization backend behavior
- provider adapter interface
- action semantics such as draft-first vs send

## Tidy Up Before Finishing

Before completing work:

- remove dead code and outdated comments
- update docs affected by the change
- update tests or add missing tests
- ensure public names match the documented contract
- call out unresolved decisions explicitly
- prefer small atomic commits over large mixed commits
- keep each commit scoped to one logical change or ticket slice when practical
- include the active Linear issue ID in commit messages
- commit incrementally during longer implementations so GitHub history stays readable and reversible
- do not batch unrelated refactors, docs, and behavior changes into one commit unless they are inseparable

## Linear

Use Linear for execution tracking, not as the architecture source of truth.
Relevant Linear issues should reference the ADR or contract doc they implement.

## Ticket Discipline

- Every substantive task must map to a Linear issue under the Surface project.
- Before starting meaningful work, identify the active issue ID in commentary.
- If no suitable issue exists, create one before continuing.
- If a task touches multiple issues, state one primary active issue and list secondary related issues.
- When scope changes materially, update the existing issue or create a follow-up issue.
- When a task is complete, move the issue to `Done`.
- Do not leave completed work only in git history or chat without a corresponding Linear update.
