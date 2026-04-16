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

Surface should create this file automatically when missing. It is for local policy and
preferences only, not account registry or auth state.

## V1 Global Settings

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

### Autonomous Test Safety

- `writes_enabled`
  Values: `true`, `false`
  Default: `false`
- `send_mode`
  Values: `draft_only`, `allow_send`
  Default: `draft_only`
- `test_recipients`
  Local-only allowlist of email addresses that automated test sends may target.
  Default: empty
- `test_account_allowlist`
  Optional list of account names that automation may use for write-path testing.
  Default: empty

## Environment Variables

- `SURFACE_CACHE_DIR`
- `SURFACE_DEFAULT_RESULT_LIMIT`
- `SURFACE_PROVIDER_TIMEOUT_MS`
- `SURFACE_SUMMARIZER_BACKEND`
- `SURFACE_SUMMARIZER_MODEL`
- `SURFACE_SUMMARY_INPUT_MAX_BYTES`
- `SURFACE_SUMMARIZER_TIMEOUT_MS`
- `SURFACE_OPENCLAW_AGENT`
- `OPENROUTER_API_KEY`
- `SURFACE_GMAIL_CLIENT_SECRET_FILE`
- `SURFACE_GMAIL_CALLBACK_PORT`
- `SURFACE_WRITES_ENABLED`
- `SURFACE_SEND_MODE`
- `SURFACE_TEST_RECIPIENTS`
- `SURFACE_TEST_ACCOUNT_ALLOWLIST`

Secrets such as API keys should not be stored in the config file. They should live in
environment variables or provider/account-specific auth storage.

Summarizer backend runtime requirements:

- `openrouter`
  Requires `OPENROUTER_API_KEY` in the shell environment.
- `openclaw`
  Requires the `openclaw` CLI to be installed and configured locally.
  Surface currently invokes:
  `openclaw --no-color --log-level silent agent --agent <id> --json --message ...`
  The default agent id is `main`, or `SURFACE_OPENCLAW_AGENT` if set.
  If OpenClaw model auth is stale or unavailable, Surface should still return mail results
  with `summary: null`.

Gmail auth runtime requirements:

- `SURFACE_GMAIL_CLIENT_SECRET_FILE`
  Optional path to a Google desktop OAuth client secret JSON file.
  If unset, Surface also checks:
  - the account-scoped stored copy under `~/.surface-cli/auth/<account_id>/client_secret.json`
  - `./client_secret.json` in the current working directory
- `SURFACE_GMAIL_CALLBACK_PORT`
  Optional loopback callback port for Gmail OAuth.
  Default: `8765`

For headless remote setup, the expected pattern is:

```bash
surface auth login <gmail-account> --remote-host <host>
```

Surface starts the SSH port-forward for you before the OAuth approval URL is printed.
If the remote account already has `~/.surface-cli/auth/<account_id>/client_secret.json`, Surface
reuses it. A local `client_secret.json` or `SURFACE_GMAIL_CLIENT_SECRET_FILE` is only required
when the remote host does not already have Gmail OAuth client credentials stored for that account.

For Outlook headless remote setup, use the same public command:

```bash
surface auth login <outlook-account> --remote-host <host>
```

That path launches local Chrome in a dedicated Surface profile, waits for the user to finish
Microsoft sign-in locally, then syncs the resulting profile to the remote host and validates it
with `surface auth status <account>` there.

Shared remote-auth behavior:

- the account must already exist on the remote host
- if the remote account currently reports `status = "authenticated"`, Surface warns before
  replacing the remote auth state
- if the remote account is missing auth state or reports `status = "unauthenticated"`, Surface
  proceeds without an overwrite warning

For a public repo, prefer local environment variables for write safety instead of
committing real recipient addresses into tracked files.

Example local-only setup:

```bash
export SURFACE_WRITES_ENABLED=1
export SURFACE_SEND_MODE=allow_send
export SURFACE_TEST_RECIPIENTS='sender@example.com,recipient@example.com,observer@example.com'
export SURFACE_TEST_ACCOUNT_ALLOWLIST='uni'
```

Current write-path behavior:

- if `SURFACE_WRITES_ENABLED` is not set, do not send
- if `SURFACE_SEND_MODE=draft_only`, send-like commands without `--draft` should error and instruct the caller to rerun with `--draft`
- if `SURFACE_SEND_MODE=allow_send`, send-like commands without `--draft` may send when every recipient is on `SURFACE_TEST_RECIPIENTS`
- `--draft` should remain available in both modes for `send`, `reply`, `reply-all`, and `forward`
- reject live write actions when the acting account is not on `SURFACE_TEST_ACCOUNT_ALLOWLIST`
- `archive` requires `SURFACE_WRITES_ENABLED=1` and any configured account allowlist, but it does not check recipients
- `mark-read`, `mark-unread`, and `read --mark-read` require `SURFACE_WRITES_ENABLED=1` and any configured account allowlist, but they do not check recipients

## Questions To Revisit Later

- whether provider timeout should later split by provider/transport

## Non-Goals

- defining provider-specific account settings here
- storing provider secrets directly in the config file
- defining truncation configuration before truncation is implemented
- defining provider-specific draft lifecycle commands before the first `--draft` implementation lands
- mirroring account add/remove/auth state into `config.toml`
