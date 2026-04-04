# Surface CLI

A lean, local-first mail CLI for multi-provider, multi-account email.

Surface normalizes Gmail and Outlook behind one contract, keeps local state in SQLite,
stores auth/cache/downloads under `~/.surface-cli`, and prints machine-readable JSON to
stdout for automation.

## Current V1 Shape

Top-level groups:

- `surface account`
- `surface auth`
- `surface mail`
- `surface attachment`
- `surface cache`

Current command surface:

```bash
surface account add work --provider gmail --transport gmail-api --email me@company.com
surface account add school --provider outlook --transport outlook-web-playwright --email me@school.edu

surface auth login work
surface auth status
surface auth logout school

surface mail fetch-unread --account work --limit 25
surface mail search --account work --text invoice --limit 10
surface mail read msg_01...
surface mail send --account school --to me@example.com --subject "hello" --body "test"
surface mail send --account school --to me@example.com --subject "hello" --body "test" --draft
surface mail reply msg_01... --body "Thanks"
surface mail reply-all msg_01... --body "Thanks all"
surface mail forward msg_01... --to me@example.com --body "FYI"
surface mail archive msg_01...
surface mail rsvp msg_01... --response tentative

surface attachment list msg_01...
surface attachment download msg_01... att_01...

surface cache stats
surface cache prune
surface cache clear --account work
```

## Core Decisions

- `fetch-unread` is the public command name.
- Threads are the top-level result unit.
- Messages are elements within a thread.
- `read` takes a stable `message_ref`.
- Attachment download is separate from `read`.
- Machine-facing commands emit JSON on stdout.
- SQLite is the local source of truth for refs and cache metadata.

See the source-of-truth docs for the exact contracts:

- `docs/cli-contract.md`
- `docs/provider-contract.md`
- `docs/cache-and-db.md`
- `docs/config.md`

## Current Implementation Status

The repo now contains a working TypeScript scaffold under `src/`:

- CLI entrypoint and command groups
- config loading from `~/.surface-cli/config.toml`
- SQLite-backed local account state
- adapter registry for `gmail-api` and `outlook-web-playwright`
- donor normalization utilities ported from the legacy Surface repo for Gmail and Outlook
- Gmail OAuth login wired to Google desktop-app OAuth with stored refresh tokens under `~/.surface-cli/auth/<account_id>/gmail-token.json`
- live Gmail `fetch-unread`, `search`, `read`, `attachment list`, and `attachment download`
- Outlook Playwright auth lifecycle wired to persistent profiles under `~/.surface-cli/auth/<account_id>/profile`
- live Outlook `fetch-unread`, `search`, `read`, `attachment list`, `attachment download`, `send`, `reply`, `reply-all`, `forward`, `archive`, `mark-read`, `mark-unread`, `rsvp`, and `--draft` on send-like actions
- summary backends for `openrouter` and `openclaw`
- lean opt-in Outlook v1 live e2e coverage via `npm run e2e:outlook-v1`

What is still intentionally incomplete:

- Gmail write actions, `--draft`, and RSVP
- draft lifecycle commands
- move / delete
- broader automated coverage beyond the opt-in Outlook v1 e2e script and cache-prune policy

For Gmail auth:

- place a Google desktop OAuth client secret at `./client_secret.json` or set
  `SURFACE_GMAIL_CLIENT_SECRET_FILE`
- add the account first:
  - `surface account add personal --provider gmail --transport gmail-api --email you@example.com`
- run:
  - `surface auth login personal`
- on a remote host, forward the callback port first:

```bash
ssh -L 8765:127.0.0.1:8765 <host>
surface auth login personal
```

Surface prints the Google auth URL to `stderr`. Open it in a browser on the machine where
`localhost:8765` is forwarded to the Surface host.

For Outlook auth:

- `surface auth login <account>` opens Chrome against the account profile directory
- `surface auth status [account]` probes Outlook headlessly and reports whether the profile lands in the mailbox or a sign-in flow
- `surface auth logout <account>` clears the stored Outlook profile for that account

If Chrome is installed in a non-default location, set:

```bash
export SURFACE_CHROME_PATH="/absolute/path/to/Google Chrome"
```

For the live Outlook v1 e2e script:

```bash
export SURFACE_E2E_ENABLE=1
export SURFACE_TEST_RECIPIENTS='sender@example.com,recipient@example.com,observer@example.com'
export SURFACE_TEST_ACCOUNT_ALLOWLIST='uni'
npm run e2e:outlook-v1
```

For live write-path testing, also set:

```bash
export SURFACE_WRITES_ENABLED=1
export SURFACE_SEND_MODE=allow_send
export SURFACE_TEST_RECIPIENTS='sender@example.com,recipient@example.com,observer@example.com'
export SURFACE_TEST_ACCOUNT_ALLOWLIST='uni'
```

## Local State

```text
~/.surface-cli/
  config.toml
  state.db
  auth/
    <account_id>/
  cache/
    <account_id>/
      messages/
        <message_ref>/
  downloads/
    <account_id>/
      <message_ref>/
```

## Development

```bash
npm install
npm run check
npm run build
npm run surface -- --help
```
