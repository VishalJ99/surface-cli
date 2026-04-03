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
  Default: `~/.surface-cli`

### Fetch And Cache

- `default_result_limit`
  Default limit for `search` and `fetch-unread` when no explicit limit is passed.
  Default: `50`
- `provider_timeout_ms`
  Timeout budget for provider fetch operations.
  Default: `30000`

### Summarization

- `summarizer_backend`
  Values: `openrouter`, `openclaw`, `none`
  Default: `none`
- `summarizer_model`
  Default model used for summarization when a backend supports model selection.
  Default: `openai/gpt-4o-mini`
- `summary_input_max_bytes`
  Maximum bytes of normalized body content sent into summarization.
  Default: `16384`
- `summarizer_timeout_ms`
  Timeout budget for summarization requests.
  Default: `20000`

## Candidate Environment Variables

- `SURFACE_CACHE_DIR`
- `SURFACE_DEFAULT_RESULT_LIMIT`
- `SURFACE_PROVIDER_TIMEOUT_MS`
- `SURFACE_SUMMARIZER_BACKEND`
- `SURFACE_SUMMARIZER_MODEL`
- `SURFACE_SUMMARY_INPUT_MAX_BYTES`
- `SURFACE_SUMMARIZER_TIMEOUT_MS`

Secrets such as API keys should not be stored in the config file. They should live in
environment variables or provider/account-specific auth storage.

## Questions To Freeze In M1

- whether provider timeout should later split by provider/transport

## Non-Goals

- defining provider-specific account settings here
- storing provider secrets directly in the config file
- defining truncation configuration before truncation is implemented
