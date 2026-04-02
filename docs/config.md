# Config

## Goal

Define the global Surface CLI settings, their meanings, and how configuration is resolved.

## Precedence

Current expected precedence:

1. command-line flags
2. environment variables
3. config file
4. built-in defaults

## Expected Config File

Suggested default path:

```text
~/.surface-cli/config.toml
```

## Candidate V1 Global Settings

### Storage

- `cache_dir`
  Root directory for SQLite, cached bodies, attachments, and auth artifacts.

### Fetch And Cache

- `max_cached_body_bytes`
  Maximum normalized body bytes stored during `search` and `fetch-unread`.
- `default_result_limit`
  Default limit for `search` and `fetch-unread` when no explicit limit is passed.
- `provider_timeout_ms`
  Timeout budget for provider fetch operations.

### Summarization

- `summarizer_backend`
  Suggested values: `openrouter`, `openclaw`, `none`
- `summarizer_model`
  Default model used for summarization when a backend supports model selection.
- `summary_input_max_bytes`
  Maximum bytes of normalized body content sent into summarization.
- `summarizer_timeout_ms`
  Timeout budget for summarization requests.

## Candidate Environment Variables

- `SURFACE_CACHE_DIR`
- `SURFACE_MAX_CACHED_BODY_BYTES`
- `SURFACE_DEFAULT_RESULT_LIMIT`
- `SURFACE_PROVIDER_TIMEOUT_MS`
- `SURFACE_SUMMARIZER_BACKEND`
- `SURFACE_SUMMARIZER_MODEL`
- `SURFACE_SUMMARY_INPUT_MAX_BYTES`
- `SURFACE_SUMMARIZER_TIMEOUT_MS`

Secrets such as API keys should not be stored in the config file. They should live in
environment variables or provider/account-specific auth storage.

## Questions To Freeze In M1

- whether `summarizer_backend` should support `auto` in v1 or stay explicit
- whether truncation should be measured in bytes only
- whether `cache_dir` should default to `~/.surface-cli`
- whether provider timeout should be one global setting or split by provider/transport later

## Non-Goals

- defining provider-specific account settings here
- storing provider secrets directly in the config file
