# Surface CLI

Outlook and Gmail from one local, JSON-first mail CLI.

Surface solves the annoying mail automation case: you have a school or work
Microsoft 365 account, IMAP is disabled, Graph app permissions need tenant admin
approval, and normal mail CLIs stop there. Surface uses the Outlook web session
you can already access in Chrome, so there is no Microsoft app registration,
Graph permission grant, tenant consent, or IMAP toggle to ask IT for.

If you can sign in to Outlook on the web, Surface can give your agent a local
CLI for that mailbox.

Surface is especially useful for coding agents and personal assistants because it
keeps mail work compact:

- one CLI contract for Gmail and Outlook
- multi-account support with stable account names
- stable `thread_ref`, `message_ref`, `attachment_id`, and `session_id` values
- thread-first `search` and `fetch-unread` results
- optional automatic summaries for search/fetch triage, with cached summary reuse
  so repeated checks do not keep bloating context
- local SQLite state, cached bodies, auth profiles, and downloads under
  `~/.surface-cli`
- first-class headless/remote setup for Mac mini, VM, or server hosts

Surface is not an admin bypass. It uses the same mailbox access you already have.
If your organization blocks Outlook on the web or browser automation entirely,
Surface cannot override that policy.

## Fast Install

Surface requires Node.js 20 or newer.

Install the CLI first:

```bash
npm install -g surface-cli
surface --help
```

Then install the skill for the agent you use.

### OpenClaw

OpenClaw installs the hosted Surface skill from ClawHub:

```bash
openclaw skills install surface-cli
openclaw skills check
```

If `openclaw skills check` reports the `surface` binary as missing, run
`npm install -g surface-cli` on that same machine.

### Codex

Codex reads user skills from `~/.agents/skills`:

```bash
mkdir -p ~/.agents/skills/surface-cli
curl -fsSL https://raw.githubusercontent.com/VishalJ99/surface-cli/main/skills/surface-cli/SKILL.md \
  -o ~/.agents/skills/surface-cli/SKILL.md
```

Restart Codex if the skill does not appear immediately. Codex can invoke it
automatically from the description, or you can mention `$surface-cli`.

### Claude Code

Claude Code reads personal skills from `~/.claude/skills`:

```bash
mkdir -p ~/.claude/skills/surface-cli
curl -fsSL https://raw.githubusercontent.com/VishalJ99/surface-cli/main/skills/surface-cli/SKILL.md \
  -o ~/.claude/skills/surface-cli/SKILL.md
```

Claude Code exposes the skill as `/surface-cli` and may also load it
automatically when the task matches the skill description.

## Setup

Add the accounts you want Surface to manage:

```bash
surface account add uni --provider outlook --email you@school.edu
surface account add personal --provider gmail --email you@gmail.com
surface account list
```

For Outlook school/work accounts, set the mailbox owner's identity explicitly.
This helps summaries decide whether a thread needs action from you:

```bash
surface account identity set uni \
  --email you@school.edu \
  --name "Your Name" \
  --name-alias "FirstName"
```

Log in:

```bash
surface auth login uni
surface auth status uni
```

Outlook auth opens Chrome and stores a dedicated browser profile under
`~/.surface-cli/auth/<account_id>/profile`. You do not need Azure, Graph, IMAP,
Exchange app passwords, or admin approval. You do need Chrome and the ability to
complete your normal Microsoft sign-in flow.

For Gmail, `surface auth login <account>` uses a Google desktop OAuth client and
stores the refresh token under `~/.surface-cli/auth/<account_id>/`. Place the
client secret at `./client_secret.json` or set `SURFACE_GMAIL_CLIENT_SECRET_FILE`.

## Headless Remote Setup

Surface is designed for remote hosts, including a Mac mini or other headless box
running OpenClaw, Codex, or Claude Code.

The rule is simple: install Surface and the agent skill on the machine where the
agent will run day to day. That machine is the canonical Surface host and owns:

```text
~/.surface-cli/state.db
~/.surface-cli/auth/
~/.surface-cli/cache/
~/.surface-cli/downloads/
```

Use your laptop only as an auth helper when the host cannot show a browser.

For example, if OpenClaw runs on a Mac mini, install both pieces there:

```bash
ssh macmini 'npm install -g surface-cli && openclaw skills install surface-cli'
```

If Codex or Claude Code runs on the remote host instead, run the matching skill
install command from the Fast Install section inside that remote shell.

Outlook remote setup:

```bash
ssh macmini 'surface account add uni --provider outlook --email you@school.edu'
ssh macmini 'surface account identity set uni --email you@school.edu --name "Your Name"'

surface auth login uni --remote-host macmini
ssh macmini 'surface auth status uni'
```

The remote Outlook auth flow opens Chrome locally, lets you complete Microsoft
sign-in on your laptop, syncs the dedicated Surface browser profile to the remote
host, then validates it there.

Gmail uses the same public remote command:

```bash
surface auth login personal --remote-host macmini
```

For Gmail, Surface starts SSH port forwarding so the OAuth callback lands on the
remote Surface process and the refresh token is stored on the remote host.

## Token-Efficient Mail Triage

Surface commands print JSON on stdout. Agents should parse the JSON and act on
stable refs rather than scraping terminal text or copying whole mail bodies into
chat.

Fetch unread threads:

```bash
surface mail fetch-unread --account uni --limit 10
```

Search with structured filters:

```bash
surface mail search --account uni --from registrar@school.edu --subject "deadline" --limit 10
surface mail search --account personal --mailbox inbox --label unread --text "invoice" --limit 10
```

Read only the thread or message you need:

```bash
surface mail thread get thr_01...
surface mail thread get thr_01... --refresh
surface mail read msg_01...
surface mail read msg_01... --refresh
```

For Outlook-heavy sessions, start a warm browser session and pass its `session_id`
to follow-up read commands:

```bash
surface session start --account uni
surface mail fetch-unread --account uni --session sess_01... --limit 10
surface mail search --account uni --session sess_01... --text "exam board" --limit 10
surface session stop sess_01...
```

Optional summaries are controlled locally. New configs default to
`summarizer_backend = "none"` so mail reads never require paid or external model
calls unless you opt in. To enable summaries, set `summarizer_backend` in
`~/.surface-cli/config.toml` or `SURFACE_SUMMARIZER_BACKEND` in the environment.

Supported summary backends:

- `openrouter`, using `OPENROUTER_API_KEY`
- `openclaw`, using the local `openclaw` CLI

When summaries are enabled, Surface summarizes a capped canonical per-thread
payload, stores summary fingerprints in SQLite, and reuses matching summaries on
later checks. This keeps recurring inbox watches and searches from repeatedly
feeding unchanged threads back into your agent context.

Email content may be sent to the configured summarizer provider when summaries
are enabled. Keep `summarizer_backend = "none"` if all mail content must remain
local to the provider and Surface cache.

## Common Commands

```bash
surface account list
surface account identity show uni

surface auth status
surface auth logout uni

surface mail fetch-unread --account uni --limit 25
surface mail search --account uni --text "project update" --limit 10
surface mail thread get thr_01... --refresh
surface mail read msg_01... --refresh

surface attachment list msg_01...
surface attachment download msg_01... att_01...

surface mail send --account uni --to you@example.com --subject "hello" --body "test" --draft
surface mail reply msg_01... --body "Thanks" --draft
surface mail archive msg_01...
surface mail mark-read msg_01...
surface mail mark-unread msg_01...
surface mail rsvp msg_01... --response tentative

surface cache stats
surface cache prune
```

Write actions are guarded by local policy in `~/.surface-cli/config.toml` and
`SURFACE_*` environment variables. Use `--draft` for safe compose flows unless
you have explicitly enabled live sends.

## What Works Today

Surface v1 supports:

- Gmail via Google APIs
- Outlook via Outlook Web and Playwright
- account add/list/remove
- auth login/status/logout
- account-owner identity for summaries
- `search` and `fetch-unread`
- thread refresh and message read
- attachment list/download
- send/reply/reply-all/forward with `--draft`
- archive, mark-read, mark-unread, RSVP
- Outlook warm sessions for repeated read-path commands
- optional summaries through OpenRouter or OpenClaw

Intentionally incomplete:

- draft lifecycle commands
- move/delete
- broad automated live coverage beyond the opt-in Gmail and Outlook v1 e2e
  scripts

## State And Config

Surface stores local state under `~/.surface-cli`:

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

`config.toml` stores local policy and preferences only. Account registry, auth
material, cache metadata, and account-owner identity live in SQLite and auth
storage, not in `config.toml`.

## Contract Docs

These are the source-of-truth docs for behavior changes:

- `docs/cli-contract.md`
- `docs/provider-contract.md`
- `docs/cache-and-db.md`
- `docs/config.md`
- `docs/decisions/`

External skill docs:

- OpenClaw skills: https://docs.openclaw.ai/cli/skills
- Codex skills: https://developers.openai.com/codex/skills
- Claude Code skills: https://code.claude.com/docs/en/skills

## Development

```bash
npm install
npm run check
npm run build
npm run surface -- --help
```

For live Outlook v1 e2e:

```bash
export SURFACE_E2E_ENABLE=1
export SURFACE_TEST_RECIPIENTS='sender@example.com,recipient@example.com,observer@example.com'
export SURFACE_TEST_ACCOUNT_ALLOWLIST='uni'
npm run e2e:outlook-v1
```

For live Gmail v1 e2e:

```bash
export SURFACE_E2E_ENABLE=1
export SURFACE_E2E_ACCOUNT='personal'
npm run e2e:gmail-v1
```

For live write-path testing:

```bash
export SURFACE_WRITES_ENABLED=1
export SURFACE_SEND_MODE=allow_send
export SURFACE_TEST_RECIPIENTS='sender@example.com,recipient@example.com,observer@example.com'
export SURFACE_TEST_ACCOUNT_ALLOWLIST='uni'
```

## Publish To ClawHub

ClawHub publishes the skill folder, not the whole repo:

```text
skills/surface-cli/
  SKILL.md
```

Release order:

1. publish the CLI package to npm so the skill can install `surface`
2. sync the intended `SKILL.md` into the active OpenClaw workspace if needed
3. publish the skill folder
4. inspect the hosted skill

```bash
npm publish
clawhub login
clawhub publish ./skills/surface-cli \
  --slug surface-cli \
  --name "Surface CLI" \
  --version <version> \
  --changelog "<release notes>"

clawhub inspect surface-cli --json
clawhub inspect surface-cli --file SKILL.md
```

Before publishing, verify the package payload:

```bash
npm pack --dry-run
openclaw skills info surface-cli
```
