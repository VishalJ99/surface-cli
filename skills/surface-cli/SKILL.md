---
name: surface-cli
description: "Use the Surface mail CLI to read and act on Gmail and Outlook mail through one JSON-first contract. Prefer this skill when handling multi-account email from the terminal: listing accounts, checking auth, fetching unread threads, searching mail, reading by message_ref, downloading attachments, sending or drafting mail, archiving, marking read or unread, and RSVP on Outlook. Use refs returned by Surface, not positional indexes into old JSON."
metadata: {"openclaw":{"emoji":"📬","homepage":"https://github.com/VishalJ99/surface-cli","requires":{"bins":["surface"]}}}
---

# Surface CLI

Surface is a local-first mail CLI for Gmail and Outlook. It prints machine-readable JSON to
stdout and stores local state in `~/.surface-cli`.

## Use This Skill When

- the user wants to read or triage email from Gmail or Outlook
- the user needs a provider-neutral CLI for search, unread fetch, read, attachments, or actions
- you need stable `thread_ref` / `message_ref` values for follow-up commands

## Prerequisites

1. Surface CLI installed (`surface --help` should work)
2. At least one configured account
3. Valid auth for the target account

Check setup:

```bash
surface account list
surface auth status
```

## Account Setup

Add an account:

```bash
surface account add personal_2 --provider gmail --transport gmail-api --email you@example.com
surface account add uni --provider outlook --transport outlook-web-playwright --email you@example.com
```

Log in:

```bash
surface auth login personal_2
surface auth login uni
```

Local policy lives in:

```text
~/.surface-cli/config.toml
```

Important local knobs:

- `writes_enabled`
- `send_mode`
- `test_recipients`
- `test_account_allowlist`

## Common Operations

### List Accounts

```bash
surface account list
surface auth status
surface auth status personal_2
```

### Fetch Unread Threads

```bash
surface mail fetch-unread --account uni --limit 10
surface mail fetch-unread --account personal_2 --limit 20
```

### Search Mail

```bash
surface mail search --account uni --text "invoice" --limit 10
surface mail search --account personal_2 --text "has:attachment newer_than:30d" --limit 5
```

### Read One Message

```bash
surface mail read msg_01...
surface mail read msg_01... --refresh
surface mail read msg_01... --mark-read
```

### Attachments

```bash
surface attachment list msg_01...
surface attachment download msg_01... att_01...
```

### Compose And Send

```bash
surface mail send --account personal_2 --to recipient@example.com --subject "Hello" --body "Test"
surface mail send --account personal_2 --to recipient@example.com --subject "Hello" --body "Test" --draft
surface mail reply msg_01... --body "Thanks"
surface mail reply msg_01... --body "Thanks" --draft
surface mail reply-all msg_01... --body "Thanks everyone"
surface mail forward msg_01... --to recipient@example.com --body "FYI"
```

### Mailbox Actions

```bash
surface mail archive msg_01...
surface mail mark-read msg_01...
surface mail mark-unread msg_01...
surface mail rsvp msg_01... --response accept
```

## Workflow

1. Start with `surface account list` if the target account is unclear.
2. Use `surface auth status` before assuming a provider is ready.
3. For triage, prefer `fetch-unread` or `search` and inspect the returned thread/message refs.
4. Read only the messages you need with `surface mail read <message_ref>`.
5. Act using refs from Surface output. Do not rely on array positions from previous JSON.

## Important Rules

- Surface outputs JSON on stdout. Parse it instead of scraping terminal text.
- Use `message_ref` and `thread_ref` for follow-up commands.
- `read` is cache-first by default. Use `--refresh` when you need live provider state.
- `read` does not download attachments. Use `surface attachment download`.
- `fetch-unread` and `search` do not mutate mailbox state.
- `--draft` is the safe compose path when you do not need to send immediately.

## Provider Notes

- Gmail and Outlook both support read, search, unread fetch, attachments, send/reply/forward,
  archive, mark-read, mark-unread, and `--draft`.
- Outlook supports RSVP now.
- Gmail invite detection exists, but Gmail RSVP is deferred until explicit Google Calendar
  integration. Do not assume `surface mail rsvp` works on Gmail.

## Safety

- Respect local write-safety policy from `~/.surface-cli/config.toml` and any `SURFACE_*` env vars.
- Do not send mail unless write safety is enabled locally.
- Prefer the configured sink recipients from local config; do not invent recipients.
- For send-like tests, use `--draft` unless the task explicitly requires a live send.
- Do not assume Gmail RSVP works; it is intentionally deferred until Calendar integration exists.
- When testing live sends, only send to recipients already configured locally for safe testing.

## Examples

```bash
surface account list
surface auth status
surface mail fetch-unread --account uni --limit 10
surface mail search --account personal_2 --text 'has:attachment newer_than:30d' --limit 5
surface mail read msg_01...
surface mail read msg_01... --mark-read
surface attachment list msg_01...
surface attachment download msg_01... att_01...
surface mail reply msg_01... --body 'Thanks' --draft
surface mail archive msg_01...
```
