# ADR 0007: Use Explicit Summarizer Backends With Null-On-Failure Semantics

## Status

Accepted

## Context

Surface CLI needs optional thread summaries for agent triage, but mail ingestion must
still work when no LLM backend is configured or a backend is temporarily unavailable.

## Decision

Use an explicit global setting:

- `summarizer_backend = openrouter | openclaw | none`

Backend behavior:

- `openrouter` uses `OPENROUTER_API_KEY`
- `openclaw` shells out to the local `openclaw` CLI
- `none` skips summarization entirely

If summarization does not happen for any reason, the command should still succeed and
the thread should return `summary: null`.

## Consequences

- summarization is optional rather than a hard dependency
- callers can rely on a stable schema regardless of backend state
- OpenRouter and OpenClaw remain swappable implementation details behind one contract
- backend-specific auth or availability failures degrade to `summary: null` instead of breaking fetch/search
