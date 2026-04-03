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
- `surface auth login <account>`
- `surface auth status [account]`
- `surface auth logout <account>`

### Mail Read Path

- `surface mail search ...`
- `surface mail fetch-unread ...`
- `surface mail read <message_ref>`

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
- `read` should accept a stable `message_ref`.
- Commands should not require JSON paths into prior command output.
- Refs should be opaque globally unique strings prefixed by entity kind.

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
            "email": "personal@example.com",
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
                "email": "personal@example.com"
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

Example:

```json
{
  "schema_version": "1",
  "command": "search",
  "generated_at": "2026-04-03T09:20:10Z",
  "account": "work",
  "query": {
    "text": "invoice",
    "limit": 10,
    "unread_only": false
  },
  "threads": []
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
          "email": "personal@example.com"
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

## Deferred Action Metadata

Do not overload `summary` with action execution semantics.

In particular:

- remove generic fields like `action_hint` from the summary object
- keep write-action support out of the read-path contract for now
- when RSVP or invite handling is added, model it explicitly on the message itself

Likely later shape:

```json
{
  "invite": {
    "is_invite": true,
    "rsvp_supported": true,
    "response_status": "needs_response"
  }
}
```

That is clearer than implying RSVP capability through summary fields.

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

## Remaining Open Questions

- exact flag names for truncation and refresh behavior
- exact shape of write/action commands

See also `docs/m1-checklist.md` for the specific decisions required to clear Milestone 1.
