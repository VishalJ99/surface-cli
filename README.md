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
- live Gmail `fetch-unread`, `search`, `read`, `attachment list`, `attachment download`, `send`, `reply`, `reply-all`, `forward`, `archive`, `mark-read`, `mark-unread`, and `--draft` on send-like actions
- Outlook Playwright auth lifecycle wired to persistent profiles under `~/.surface-cli/auth/<account_id>/profile`
- live Outlook `fetch-unread`, `search`, `read`, `attachment list`, `attachment download`, `send`, `reply`, `reply-all`, `forward`, `archive`, `mark-read`, `mark-unread`, `rsvp`, and `--draft` on send-like actions
- summary backends for `openrouter` and `openclaw`
- lean opt-in Outlook v1 and Gmail v1 live e2e coverage via `npm run e2e:outlook-v1` and `npm run e2e:gmail-v1`

What is still intentionally incomplete:

- Gmail RSVP
- draft lifecycle commands
- move / delete
- broader automated coverage beyond the opt-in provider v1 e2e scripts and cache-prune policy

## Setup

Surface supports two setup modes:

- standard single-machine setup
  Surface runs on the same machine where you can access the browser, localhost callback ports,
  and any required GUI prompts
- headless remote setup
  Surface runs on a remote machine such as a Mac mini, while a second local machine helps with
  Gmail OAuth browser approval or Outlook browser-profile bootstrap

The correct split is:

- the machine that actually runs `surface` for day-to-day mail work is the canonical Surface host
- that host owns:
  - `~/.surface-cli/state.db`
  - `~/.surface-cli/auth/`
  - `~/.surface-cli/cache/`
  - `~/.surface-cli/downloads/`
- `~/.surface-cli/config.toml` is auto-created on first run and stores local policy only
  such as summarizer and write-safety settings
- account registry and auth state do not live in `config.toml`

### Install Surface

For development from a checkout:

```bash
npm install
npm run build
npm link
```

For a published install, use npm:

```bash
npm install -g surface-cli
```

### Standard Single-Machine Setup

Use this when the same machine can:

- open Chrome locally
- receive loopback OAuth callbacks on `localhost`
- show any required Microsoft or Google auth UI

Typical flow:

1. install Surface on that machine
2. add accounts there
3. run `surface auth login <account>` there
4. use that same machine for normal `surface mail ...` commands

Gmail:

- place a Google desktop OAuth client secret at `./client_secret.json` or set
  `SURFACE_GMAIL_CLIENT_SECRET_FILE`
- add the account first:
  - `surface account add personal --provider gmail --transport gmail-api --email you@example.com`
- run:
  - `surface auth login personal`

For Outlook auth:

- `surface auth login <account>` opens Chrome against the account profile directory
- `surface auth status [account]` probes Outlook headlessly and reports whether the profile lands in the mailbox or a sign-in flow
- `surface auth logout <account>` clears the stored Outlook profile for that account

### Headless Remote Setup

Use this when your real Surface host is remote, for example a headless Mac mini, VM, or server.

In this mode:

- install Surface on the remote machine first
- add accounts on the remote machine first
- the remote machine is the source of truth for all Surface state
- install Surface locally too if you want to use `--remote-host` auth helpers
- `--remote-host` assumes the named account already exists on the remote machine
- remote auth only warns before replacement when the remote account already reports `authenticated`
- if the remote auth-state probe times out or fails, Surface proceeds without an overwrite warning
  instead of blocking the remote auth flow

#### Gmail On A Headless Remote Host

The remote host is the real Surface runtime. Your local machine is only a browser helper.

1. on the remote host, install Surface and add the Gmail account
2. on the local machine, ensure `surface` is installed too
3. on the local machine, run:

```bash
surface auth login <gmail-account> --remote-host <ssh-host>
```

What happens:

- Surface starts SSH port forwarding first
- Surface runs the Gmail OAuth listener on the remote host
- you open the Google auth URL locally
- the OAuth callback is forwarded back to the remote host
- the refresh token is stored on the remote host under `~/.surface-cli/auth/<account_id>/`

#### Outlook On A Headless Remote Host

The remote host is again the real Surface runtime. Your local machine is only an auth/bootstrap
helper.

1. on the remote host, install Surface and add the Outlook account
2. on the local machine, ensure `surface` is installed too
3. on the local machine, run:

```bash
surface auth login <outlook-account> --remote-host <ssh-host>
```

What happens:

- Surface opens local Chrome in a dedicated Surface profile
- you complete the Microsoft sign-in locally
- Surface syncs that profile to the remote host
- Surface validates the copied profile on the remote host with `surface auth status <account>`

This is why headless remote auth currently requires `surface` to exist on both machines:

- local machine: helper for browser/UI work
- remote machine: canonical Surface runtime and state owner

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

For the live Gmail v1 e2e script:

```bash
export SURFACE_E2E_ENABLE=1
export SURFACE_E2E_ACCOUNT='personal_2'
npm run e2e:gmail-v1
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

## Publish To ClawHub

ClawHub publishes the skill folder, not the whole repo. The publish unit is:

```text
skills/surface-cli/
  SKILL.md
```

Recommended release order:

1. publish the CLI package to npm so ClawHub can install `surface`
2. log into ClawHub
3. publish the skill folder

Example:

```bash
npm publish
clawhub login
clawhub publish ./skills/surface-cli \
  --slug surface-cli \
  --name "Surface CLI" \
  --version 0.1.0 \
  --changelog "Initial Surface CLI skill release"
```

Before publishing, verify the package payload:

```bash
npm pack --dry-run
openclaw skills info surface-cli
```
