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

## Command Model

- Enumerate accounts with `surface account list`
- Check auth with `surface auth status [account]`
- Broad triage:
  - `surface mail fetch-unread --account <account> --limit <n>`
  - `surface mail search --account <account> --text <query> --limit <n>`
- Read one message:
  - `surface mail read <message_ref>`
  - `surface mail read <message_ref> --mark-read`
- Attachments:
  - `surface attachment list <message_ref>`
  - `surface attachment download <message_ref> <attachment_id>`
- Write and mailbox actions:
  - `surface mail send --account <account> --to <email> --subject <subject> --body <body> [--draft]`
  - `surface mail reply <message_ref> --body <body> [--cc <email>] [--bcc <email>] [--draft]`
  - `surface mail reply-all <message_ref> --body <body> [--cc <email>] [--bcc <email>] [--draft]`
  - `surface mail forward <message_ref> --to <email> [--cc <email>] [--bcc <email>] --body <body> [--draft]`
  - `surface mail archive <message_ref>`
  - `surface mail mark-read <message_ref>...`
  - `surface mail mark-unread <message_ref>...`
  - `surface mail rsvp <message_ref> --response <accept|decline|tentative>`

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

## Examples

```bash
surface account list
surface auth status
surface mail fetch-unread --account uni --limit 10
surface mail search --account personal_2 --text 'has:attachment newer_than:30d' --limit 5
surface mail read msg_01...
surface attachment list msg_01...
surface attachment download msg_01... att_01...
surface mail reply msg_01... --body 'Thanks' --draft
surface mail archive msg_01...
```
