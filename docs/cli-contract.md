# CLI Contract

## Goal

Define the public Surface CLI commands and their machine-readable JSON output.

## Command Groups

- `surface account`
- `surface auth`
- `surface mail`
- `surface attachment`
- `surface cache`

## Current V1 Command Shape

### Accounts And Auth

- `surface account add <name> --provider <provider> --transport <transport> --email <email>`
- `surface account list`
- `surface account remove <account>`
- `surface auth login <account> [--remote-host <host>]`
- `surface auth status [account]`
- `surface auth logout <account>`

Gmail auth notes:

- `surface auth login <account>` for `gmail-api` uses a loopback OAuth flow and prints the Google
  authorization URL to `stderr`
- Gmail RSVP also depends on Google Calendar scope. After enabling Calendar API for the same Google
  Cloud project, existing Gmail accounts must re-run `surface auth login <account>` once so
  Surface can store a token with Calendar access.
- `surface auth login <account> --remote-host <host>` keeps the same public command but changes the
  transport details:
  - Gmail starts an SSH port-forward to the remote host first, then runs the remote loopback OAuth
    flow so the callback lands on the remote Surface process
  - Gmail reuses the remote account's stored `client_secret.json` when present and only falls back
    to a local client secret file/env override when the remote host does not already have one
  - Outlook performs local browser login in a dedicated Surface Chrome profile, then syncs that
    profile to the remote account auth path and validates it remotely
- Remote auth login assumes the named account already exists on the remote host
- Remote auth login only warns before replacement when the remote account currently reports
  `status = "authenticated"`
- Gmail auth resolves desktop OAuth credentials from:
  - `SURFACE_GMAIL_CLIENT_SECRET_FILE`
  - the stored per-account copy under `~/.surface-cli/auth/<account_id>/client_secret.json`
  - `./client_secret.json` in the current working directory
- Gmail auth stores refresh-token state under:
  - `~/.surface-cli/auth/<account_id>/gmail-token.json`

Remote auth login returns the normal `auth-login` envelope plus:

- `remote_host`
  Present only when `--remote-host <host>` was used.

Example remote auth login result:

```json
{
  "schema_version": "1",
  "command": "auth-login",
  "account": "personal",
  "provider": "gmail",
  "transport": "gmail-api",
  "remote_host": "dross",
  "status": {
    "status": "authenticated",
    "detail": "Authenticated as you@example.com."
  }
}
```

### Mail

- `surface mail search --account <account> [--text <query>] [--from <sender>] [--subject <subject>] [--mailbox <mailbox>] [--label <label>]...`
- `surface mail fetch-unread ...`
- `surface mail thread get <thread_ref> [--refresh]`
- `surface mail read <message_ref> [--mark-read]`
- `surface mail send --account <account> --to <email> [--cc <email>] [--bcc <email>] --subject <subject> --body <body> [--draft]`
- `surface mail reply <message_ref> --body <body> [--cc <email>] [--bcc <email>] [--draft]`
- `surface mail reply-all <message_ref> --body <body> [--cc <email>] [--bcc <email>] [--draft]`
- `surface mail forward <message_ref> --to <email> [--cc <email>] [--bcc <email>] --body <body> [--draft]`
- `surface mail archive <message_ref>`
- `surface mail mark-read <message_ref>...`
- `surface mail mark-unread <message_ref>...`
- `surface mail rsvp <message_ref> --response <accept|decline|tentative>`

### Attachments

- `surface attachment list <message_ref>`
- `surface attachment download <message_ref> <attachment_id>`

### Cache

- `surface cache stats`
- `surface cache prune`
- `surface cache clear --account <account>`
- `surface cache clear --message <message_ref>`
- `surface cache clear --all`

## Naming Decisions

- `fetch-unread` is the public command name.
- Threads are the top-level result unit.
- Messages are elements within a thread.
- `thread get` should accept a stable `thread_ref`.
- `read` should accept a stable `message_ref`.
- Commands should not require JSON paths into prior command output.
- Refs should be opaque globally unique strings prefixed by entity kind.
- Draft creation should be an explicit `--draft` flag on send-like commands, not a silent config rewrite of `send`.
- `read` stays side-effect free by default, with `--mark-read` as an explicit convenience flag.

## Stable Ref Format

Recommended v1 format:

- `thread_ref = "thr_<ulid>"`
- `message_ref = "msg_<ulid>"`
- `attachment_id = "att_<ulid>"`

Examples:

- `thr_01JQ6YH6A6VX8P1TQ0N3K4W8M2`
- `msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P`
- `att_01JQ6YJ3G4M7YJ6M2Y1P3A8S4T`

These refs are:

- opaque to callers
- globally unique within the local Surface store
- stable across repeated searches/fetches for the same underlying provider entity

## Shared Result Shape For `search` And `fetch-unread`

Both commands should return the same top-level shape:

```json
{
  "schema_version": "1",
  "command": "fetch-unread",
  "generated_at": "2026-04-03T09:12:44Z",
  "account": "work",
  "query": {
    "limit": 25,
    "unread_only": true
  },
  "threads": []
}
```

Each thread should contain:

- `thread_ref`
- `source`
- `envelope`
- `summary`
- `messages[]`

Each message should contain:

- `message_ref`
- `envelope`
- `snippet`
- `body`
- `attachments`

`body.text` may include explicit inline-content markers such as `[inline image: image001.png]`
when the original message contains embedded inline attachments that would otherwise be invisible in
plain-text output.

## Recommended Concrete V1 Shapes

The simplest stable contract is:

- thread-level summary
- message-level body/snippet
- message-level attachment metadata
- provider locator data never exposed directly in stdout JSON
- summary is optional; if absent or `null`, no summary was generated

### `surface mail fetch-unread`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "fetch-unread",
  "generated_at": "2026-04-03T09:12:44Z",
  "account": "work",
  "query": {
    "limit": 25,
    "unread_only": true
  },
  "threads": [
    {
      "thread_ref": "thr_01JQ6YH6A6VX8P1TQ0N3K4W8M2",
      "source": {
        "provider": "gmail",
        "transport": "gmail-api"
      },
      "envelope": {
        "subject": "Invoice INV-1042 overdue",
        "participants": [
          {
            "name": "Vendor Billing",
            "email": "billing@vendor.com",
            "role": "from"
          },
          {
            "name": "Vishal Jain",
            "email": "recipient@example.com",
            "role": "to"
          }
        ],
        "mailbox": "inbox",
        "labels": ["inbox", "unread"],
        "received_at": "2026-04-03T08:41:11Z",
        "message_count": 1,
        "unread_count": 1,
        "has_attachments": true
      },
      "summary": {
        "backend": "openrouter",
        "model": "openai/gpt-4o-mini",
        "brief": "Vendor invoice reminder requiring payment review.",
        "needs_action": true,
        "importance": "high"
      },
      "messages": [
        {
          "message_ref": "msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P",
          "envelope": {
            "from": {
              "name": "Vendor Billing",
              "email": "billing@vendor.com"
            },
            "to": [
              {
                "name": "Vishal Jain",
                "email": "recipient@example.com"
              }
            ],
            "cc": [],
            "sent_at": "2026-04-03T08:40:57Z",
            "received_at": "2026-04-03T08:41:11Z",
            "unread": true
          },
          "snippet": "This is a reminder that invoice INV-1042 is now overdue and requires your attention.",
          "body": {
            "text": "This is a reminder that invoice INV-1042 is now overdue and requires your attention.\n\nPlease review the attached PDF and arrange payment.",
            "truncated": false,
            "cached": true,
            "cached_bytes": 141
          },
          "attachments": [
            {
              "attachment_id": "att_01JQ6YJ3G4M7YJ6M2Y1P3A8S4T",
              "filename": "invoice-1042.pdf",
              "mime_type": "application/pdf",
              "size_bytes": 48291,
              "inline": false
            }
          ]
        }
      ]
    }
  ]
}
```

### `surface mail search`

Same shape as `fetch-unread`, but `command = "search"` and `query` reflects the passed criteria.
At least one of `--text`, `--from`, `--subject`, `--mailbox`, or `--label` is required.

Example:

```json
{
  "schema_version": "1",
  "command": "search",
  "generated_at": "2026-04-03T09:20:10Z",
  "account": "work",
  "query": {
    "from": "billing@vendor.com",
    "subject": "invoice",
    "mailbox": "inbox",
    "labels": ["unread"],
    "limit": 10,
    "unread_only": false
  },
  "threads": []
}
```

### `surface mail thread get <thread_ref>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "thread-get",
  "account": "work",
  "thread_ref": "thr_01JQ6YH6A6VX8P1TQ0N3K4W8M2",
  "cache": {
    "status": "refreshed"
  },
  "thread": {
    "thread_ref": "thr_01JQ6YH6A6VX8P1TQ0N3K4W8M2",
    "source": {
      "provider": "gmail",
      "transport": "gmail-api"
    },
    "envelope": {
      "subject": "Invoice INV-1042 overdue",
      "participants": [
        {
          "name": "Vendor Billing",
          "email": "billing@vendor.com",
          "role": "from"
        },
        {
          "name": "Vishal Jain",
          "email": "recipient@example.com",
          "role": "to"
        }
      ],
      "mailbox": "inbox",
      "labels": ["inbox", "unread"],
      "received_at": "2026-04-03T08:41:11Z",
      "message_count": 1,
      "unread_count": 1,
      "has_attachments": true
    },
    "summary": {
      "backend": "openrouter",
      "model": "openai/gpt-4o-mini",
      "brief": "Vendor invoice reminder requiring payment review.",
      "needs_action": true,
      "importance": "high"
    },
    "messages": [
      {
        "message_ref": "msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P",
        "envelope": {
          "from": {
            "name": "Vendor Billing",
            "email": "billing@vendor.com"
          },
          "to": [
            {
              "name": "Vishal Jain",
              "email": "recipient@example.com"
            }
          ],
          "cc": [],
          "sent_at": "2026-04-03T08:40:57Z",
          "received_at": "2026-04-03T08:41:11Z",
          "unread": true
        },
        "snippet": "This is a reminder that invoice INV-1042 is now overdue and requires your attention.",
        "body": {
          "text": "This is a reminder that invoice INV-1042 is now overdue and requires your attention.\n\nPlease review the attached PDF and arrange payment.",
          "truncated": false,
          "cached": true,
          "cached_bytes": 141
        },
        "attachments": [
          {
            "attachment_id": "att_01JQ6YJ3G4M7YJ6M2Y1P3A8S4T",
            "filename": "invoice-1042.pdf",
            "mime_type": "application/pdf",
            "size_bytes": 48291,
            "inline": false
          }
        ]
      }
    ]
  }
}
```

### `surface mail read <message_ref>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "read",
  "account": "work",
  "message_ref": "msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P",
  "thread_ref": "thr_01JQ6YH6A6VX8P1TQ0N3K4W8M2",
  "source": {
    "provider": "gmail",
    "transport": "gmail-api"
  },
  "cache": {
    "status": "hit",
    "truncated": false
  },
  "message": {
    "envelope": {
      "subject": "Invoice INV-1042 overdue",
      "from": {
        "name": "Vendor Billing",
        "email": "billing@vendor.com"
      },
      "to": [
        {
          "name": "Vishal Jain",
          "email": "recipient@example.com"
        }
      ],
      "cc": [],
      "sent_at": "2026-04-03T08:40:57Z",
      "received_at": "2026-04-03T08:41:11Z",
      "unread": true
    },
    "body": {
      "text": "This is a reminder that invoice INV-1042 is now overdue and requires your attention.\n\nPlease review the attached PDF and arrange payment.",
      "truncated": false,
      "cached": true,
      "cached_bytes": 141
    },
    "attachments": [
      {
        "attachment_id": "att_01JQ6YJ3G4M7YJ6M2Y1P3A8S4T",
        "filename": "invoice-1042.pdf",
        "mime_type": "application/pdf",
        "size_bytes": 48291,
        "inline": false
      }
    ]
  }
}
```

### `surface mail mark-read <message_ref>...`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "mark-read",
  "account": "uni",
  "source": {
    "provider": "outlook",
    "transport": "outlook-web-playwright"
  },
  "updated": [
    {
      "message_ref": "msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P",
      "thread_ref": "thr_01JQ6YH6A6VX8P1TQ0N3K4W8M2",
      "unread": false
    }
  ]
}
```

### `surface mail mark-unread <message_ref>...`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "mark-unread",
  "account": "uni",
  "source": {
    "provider": "outlook",
    "transport": "outlook-web-playwright"
  },
  "updated": [
    {
      "message_ref": "msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P",
      "thread_ref": "thr_01JQ6YH6A6VX8P1TQ0N3K4W8M2",
      "unread": true
    }
  ]
}
```

### `surface attachment list <message_ref>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "attachment-list",
  "account": "work",
  "message_ref": "msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P",
  "attachments": [
    {
      "attachment_id": "att_01JQ6YJ3G4M7YJ6M2Y1P3A8S4T",
      "filename": "invoice-1042.pdf",
      "mime_type": "application/pdf",
      "size_bytes": 48291,
      "inline": false
    }
  ]
}
```

### `surface attachment download <message_ref> <attachment_id>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "attachment-download",
  "account": "work",
  "message_ref": "msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P",
  "attachment": {
    "attachment_id": "att_01JQ6YJ3G4M7YJ6M2Y1P3A8S4T",
    "filename": "invoice-1042.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 48291,
    "inline": false,
    "saved_to": "~/.surface-cli/downloads/acc_work/msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P/att_01JQ6YJ3G4M7YJ6M2Y1P3A8S4T__invoice-1042.pdf"
  }
}
```

### `surface mail rsvp <message_ref> --response <accept|decline|tentative>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "rsvp",
  "account": "uni",
  "message_ref": "msg_01JQ6YH93Q2E6VYJ5H0Y3R6N9P",
  "thread_ref": "thr_01JQ6YH6A6VX8P1TQ0N3K4W8M2",
  "source": {
    "provider": "outlook",
    "transport": "outlook-web-playwright"
  },
  "response": "tentative",
  "invite": {
    "is_invite": true,
    "rsvp_supported": true,
    "response_status": "tentative",
    "available_rsvp_responses": ["accept", "decline", "tentative"]
  }
}
```

### `surface mail send --account <account> --to <email> --subject <subject> --body <body>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "send",
  "account": "uni",
  "source": {
    "provider": "outlook",
    "transport": "outlook-web-playwright"
  },
  "status": "sent",
  "subject": "[surface-test] PER-93 send probe 1775231001",
  "recipients": {
    "to": [
      {
        "name": "Jain, Vishal",
        "email": "sender@example.com"
      }
    ],
    "cc": [
      {
        "name": "recipient@example.com",
        "email": "recipient@example.com"
      }
    ],
    "bcc": [
      {
        "name": "observer@example.com",
        "email": "observer@example.com"
      }
    ]
  },
  "thread_ref": "thr_01KNA0DABKTH156DG3WWAKX791",
  "message_ref": "msg_01KNA0DABPKVWT5W8A1NT443NZ",
  "in_reply_to_message_ref": null
}
```

### `surface mail send --account <account> --to <email> --subject <subject> --body <body> --draft`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "send",
  "account": "uni",
  "source": {
    "provider": "outlook",
    "transport": "outlook-web-playwright"
  },
  "status": "drafted",
  "subject": "[surface-test] draft probe",
  "recipients": {
    "to": [
      {
        "name": "Jain, Vishal",
        "email": "sender@example.com"
      }
    ],
    "cc": [],
    "bcc": []
  },
  "thread_ref": "thr_01DRAFTEXAMPLE000000000000",
  "message_ref": "msg_01DRAFTEXAMPLE000000000000",
  "in_reply_to_message_ref": null
}
```

### `surface mail reply <message_ref>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "reply",
  "account": "uni",
  "source": {
    "provider": "outlook",
    "transport": "outlook-web-playwright"
  },
  "status": "sent",
  "subject": "Re: [surface-test] PER-93 send probe 1775231001",
  "recipients": {
    "to": [
      {
        "name": "Jain, Vishal",
        "email": "sender@example.com"
      }
    ],
    "cc": [],
    "bcc": []
  },
  "thread_ref": "thr_01KNA0DABKTH156DG3WWAKX791",
  "message_ref": "msg_01KNA0EB3BADKWQVXFYKKK4BXN",
  "in_reply_to_message_ref": "msg_01KNA0DABPKVWT5W8A1NT443NZ"
}
```

### `surface mail reply-all <message_ref>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "reply-all",
  "account": "uni",
  "source": {
    "provider": "outlook",
    "transport": "outlook-web-playwright"
  },
  "status": "sent",
  "subject": "Re: [surface-test] PER-93 send probe 1775231001",
  "recipients": {
    "to": [],
    "cc": [
      {
        "name": "recipient@example.com",
        "email": "recipient@example.com"
      }
    ],
    "bcc": []
  },
  "thread_ref": "thr_01KNA0DABKTH156DG3WWAKX791",
  "message_ref": "msg_01KNA0SHGG78SP6ZBXKPBHPTV0",
  "in_reply_to_message_ref": "msg_01KNA0DABPKVWT5W8A1NT443NZ"
}
```

### `surface mail forward <message_ref>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "forward",
  "account": "uni",
  "source": {
    "provider": "outlook",
    "transport": "outlook-web-playwright"
  },
  "status": "sent",
  "subject": "Fw: [surface-test] PER-93 send probe 1775231001",
  "recipients": {
    "to": [
      {
        "name": "recipient@example.com",
        "email": "recipient@example.com"
      }
    ],
    "cc": [
      {
        "name": "Jain, Vishal",
        "email": "sender@example.com"
      }
    ],
    "bcc": [
      {
        "name": "observer@example.com",
        "email": "observer@example.com"
      }
    ]
  },
  "thread_ref": "thr_01KNA0DABKTH156DG3WWAKX791",
  "message_ref": "msg_01KNA0TQXP9QCA0T4P48C3NG1G",
  "in_reply_to_message_ref": "msg_01KNA0DABPKVWT5W8A1NT443NZ"
}
```

### `surface mail archive <message_ref>`

Recommended example:

```json
{
  "schema_version": "1",
  "command": "archive",
  "account": "uni",
  "message_ref": "msg_01KNA0DABPKVWT5W8A1NT443NZ",
  "thread_ref": "thr_01KNA0DABKTH156DG3WWAKX791",
  "source": {
    "provider": "outlook",
    "transport": "outlook-web-playwright"
  },
  "status": "archived"
}
```

### Error Envelope

Recommended minimum public error shape:

```json
{
  "schema_version": "1",
  "error": {
    "code": "reauth_required",
    "message": "Authentication expired for account 'work'.",
    "retryable": true,
    "account": "work",
    "message_ref": null,
    "thread_ref": null
  }
}
```

## Invite Metadata

Do not overload `summary` with action execution semantics.

In particular:

- remove generic fields like `action_hint` from the summary object
- keep invite metadata on the message itself
- keep RSVP response execution as a separate explicit command

Current v1 shape:

```json
{
  "invite": {
    "is_invite": true,
    "rsvp_supported": true,
    "response_status": "tentative",
    "available_rsvp_responses": ["accept", "decline", "tentative"]
  }
}
```

`response_status` should reflect the latest known RSVP state for the current user. For Outlook,
this may be inferred from newer response messages in the thread when the original meeting request
payload is stale.

## Public Terms

- `envelope`
  Structured metadata such as subject, participants, time, unread state, mailbox, labels.
- `snippet`
  Short preview text from the email body.
- `body`
  Normalized non-summary content, subject to truncation policy.
- `summary`
  Interpreted summary generated by configured summarization backend.

## Recommended Decisions

- summaries should live at the thread level in v1
- snippets and bodies should live at the message level
- refs should be opaque globally unique strings prefixed by entity kind
- `search` should not expose pagination in v1 unless the first provider implementation forces it
- `read --refresh` should exist in v1
- `summary` should be `null` when no summary was generated
- truncation should not be enforced in the first implementation slice; `truncated` should remain `false` until truncation logic is added
- `archive` is supported in v1, but `delete` is not
- `--draft` should return the same envelope shape as send-like commands, with `status = "drafted"`

## Remaining Open Questions

- exact flag names for truncation and refresh behavior
- draft lifecycle commands such as list/update/send-existing/discard

See also `docs/m1-checklist.md` for the specific decisions required to clear Milestone 1.
