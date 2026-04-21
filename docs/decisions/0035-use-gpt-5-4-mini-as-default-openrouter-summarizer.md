# ADR 0035: Use GPT-5.4 Mini As Default OpenRouter Summarizer

## Status

Accepted

## Context

Surface supports optional summaries through explicit backends. The default backend remains `none`
so mail reads never depend on paid or externally authenticated model calls, but when users enable
the OpenRouter backend, Surface still needs a sensible default model.

PER-172 compared GPT-5.2 chat, GPT-5.3 chat, GPT-5.4 mini, and GPT-5.4 nano on representative
cached `uni` threads with ME-scoped `needs_action` and causal-chain summary requirements.

## Decision

Use `openai/gpt-5.4-mini` as the default `summarizer_model` for new configs and for runtime
fallback when no model is configured.

The default `summarizer_backend` stays `none`; users must explicitly opt in to `openrouter` or
`openclaw`.

## Consequences

- New OpenRouter summary setups default to the model that had the best observed balance of latency,
  action-flag reliability, and hallucination risk in PER-172.
- Existing config files are not rewritten automatically. Users with
  `summarizer_model = "openai/gpt-4o-mini"` must update their local config if they want the new
  recommended model.
- Summary cache fingerprints already include backend/model, prompt version, clipping policy, and
  account-owner identity semantics, so switching models naturally avoids reusing old summaries.
