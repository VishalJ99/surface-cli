# Surface CLI

A clean, local-first mail CLI for humans and agents.

The core idea is simple:

- normalize Gmail and Outlook into one mail contract
- keep provider transport hidden behind adapters
- return cheap message summaries by default
- fetch full bodies only when asked
- make write actions draft-first unless explicitly sent

## Design Principles

- Separate `provider` from `transport`.
  Gmail is usually `provider=gmail`, `transport=gmail-api`.
  Outlook may be `provider=outlook`, `transport=graph-api` or `transport=outlook-web-playwright`.
- Keep the public contract stable even if the transport changes.
- Make listing/search cheap.
  `unread` and `search` should return envelope metadata plus optional summary, not entire bodies.
- Treat large content as artifacts, not stdout.
  The CLI should print concise JSON manifests and store heavy bodies/attachments on disk.
- Draft first for writes.
  Agents should usually create drafts, then a policy or human decides whether to send.
- Expose capabilities explicitly.
  Not every account will support every action equally well, especially browser-driven Outlook flows.

## CLI Shape

Top-level groups:

- `surface account`
- `surface auth`
- `surface mail`
- `surface attachment`
- `surface agent`

Example command set:

```bash
surface account add work --provider gmail --transport gmail-api --email me@company.com
surface account add school --provider outlook --transport outlook-web-playwright --email me@school.edu

surface auth login work
surface auth login school

surface mail unread --account work --limit 25 --summarize --json
surface mail search --account all --from billing@vendor.com --has-attachment --view summary --json
surface mail read msg_01HV... --body text --json

surface attachment list msg_01HV...
surface attachment download msg_01HV... --attachment att_02 --out ./downloads/

surface mail reply msg_01HV... --body-file ./reply.md --mode draft
surface mail send-draft drf_01HV...
surface mail archive msg_01HV...
surface mail mark-read msg_01HV...

surface agent triage --account work --limit 50 --policy ./policy.md --out ./triage.json
surface agent apply ./actions.json --dry-run
```

## Suggested Behavior

### `surface mail unread`

Default output:

- message envelope
- snippet
- attachment count
- thread id
- unread state
- optional summary block

Not full body by default.

### `surface mail search`

Default output should also be envelope-first.

Good pattern:

- `--view envelope`
- `--view summary`
- `--view full`

Where:

- `envelope` is cheap metadata plus snippet
- `summary` adds LLM summary artifacts
- `full` hydrates bodies and stores them on disk

This is cleaner than making search always return full contents.

### `surface mail read`

This is the explicit expensive read.

It should return or materialize:

- normalized plain text body
- HTML path if available
- headers
- quoted history if requested
- attachment metadata

## Public Contracts

TypeScript is a good fit here because:

- Playwright support is strong
- Gmail API support is mature
- you can define stable typed contracts for agents and adapters

### Account

```ts
type ProviderId = "gmail" | "outlook";

type TransportId =
  | "gmail-api"
  | "graph-api"
  | "outlook-web-playwright";

type AccountId = string;

interface MailAccount {
  id: AccountId;
  provider: ProviderId;
  transport: TransportId;
  email: string;
  displayName?: string;
  scopes: string[];
  authRef: string;
  capabilities: CapabilitySet;
  defaultMailbox?: string;
}
```

### Capabilities

```ts
interface CapabilitySet {
  search: boolean;
  unread: boolean;
  readBody: boolean;
  downloadAttachment: boolean;
  send: boolean;
  draft: boolean;
  reply: boolean;
  replyAll: boolean;
  forward: boolean;
  archive: boolean;
  trash: boolean;
  move: boolean;
  tag: boolean;
  markRead: boolean;
  markUnread: boolean;
  star: boolean;
  rsvp: boolean;
}
```

This matters because `outlook-web-playwright` may support the same user-visible action set, but the reliability characteristics are different. The agent layer should inspect capability flags, not assume parity.

### Message Envelope

```ts
interface MessageEnvelope {
  id: string;
  providerId: string;
  accountId: string;
  threadId: string;
  subject: string;
  from: Contact;
  to: Contact[];
  cc: Contact[];
  bcc?: Contact[];
  receivedAt: string;
  sentAt?: string;
  unread: boolean;
  mailbox: MailboxRef;
  tags: string[];
  snippet?: string;
  hasAttachments: boolean;
  attachmentCount: number;
  importance?: "low" | "normal" | "high";
}

interface Contact {
  name?: string;
  email: string;
}

interface MailboxRef {
  id: string;
  kind:
    | "inbox"
    | "archive"
    | "sent"
    | "drafts"
    | "trash"
    | "spam"
    | "custom";
  name: string;
}
```

### Message Summary

```ts
interface MessageSummary {
  messageId: string;
  model: string;
  brief: string;
  category:
    | "personal"
    | "work"
    | "finance"
    | "sales"
    | "support"
    | "meeting"
    | "promo"
    | "unknown";
  urgency: "low" | "medium" | "high";
  needsAction: boolean;
  actionType?:
    | "reply"
    | "review"
    | "pay"
    | "rsvp"
    | "ignore"
    | "track";
  deadline?: string;
  people: string[];
  entities: string[];
  summaryBullets: string[];
}
```

The summary should be small and stable. It exists to help a stronger model decide what to open next.

### Full Message

```ts
interface MessageBody {
  messageId: string;
  text?: string;
  htmlPath?: string;
  headers?: Record<string, string>;
  quotedText?: string;
  attachments: AttachmentMeta[];
}

interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  inline: boolean;
  downloadUrl?: string;
}
```

### Search Query

Do not make provider-native query syntax the primary API.

Use a normalized query object, and optionally allow provider-specific escape hatches.

```ts
interface MailQuery {
  text?: string;
  from?: string[];
  to?: string[];
  subject?: string;
  mailbox?: string[];
  tags?: string[];
  unread?: boolean;
  hasAttachment?: boolean;
  receivedAfter?: string;
  receivedBefore?: string;
  threadId?: string;
  limit?: number;
  cursor?: string;
  providerQuery?: string;
}
```

### Actions

Do not try to invent one giant ad hoc action blob. Keep action kinds explicit.

```ts
type ActionKind =
  | "draft_new"
  | "draft_reply"
  | "draft_reply_all"
  | "draft_forward"
  | "send_draft"
  | "archive"
  | "trash"
  | "move"
  | "tag_add"
  | "tag_remove"
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "rsvp";

interface ActionRequest {
  kind: ActionKind;
  accountId: string;
  messageId?: string;
  threadId?: string;
  draft?: DraftInput;
  destinationMailbox?: string;
  tags?: string[];
  rsvp?: "accept" | "decline" | "tentative";
  dryRun?: boolean;
}

interface DraftInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtmlPath?: string;
  attachments?: string[];
}
```

## Provider Adapter Contract

The key interface is the provider adapter. This is where Gmail API and Outlook Playwright diverge, but the rest of the app should not care.

```ts
interface MailProviderAdapter {
  readonly provider: ProviderId;
  readonly transport: TransportId;

  getCapabilities(account: MailAccount): Promise<CapabilitySet>;

  login(account: MailAccount): Promise<void>;
  logout(account: MailAccount): Promise<void>;
  refreshAuth(account: MailAccount): Promise<void>;

  listUnread(account: MailAccount, query?: MailQuery): Promise<MessageEnvelope[]>;
  search(account: MailAccount, query: MailQuery): Promise<MessageEnvelope[]>;
  readMessage(account: MailAccount, messageId: string): Promise<MessageBody>;
  downloadAttachment(
    account: MailAccount,
    messageId: string,
    attachmentId: string,
    outDir: string,
  ): Promise<AttachmentMeta>;

  perform(account: MailAccount, action: ActionRequest): Promise<ActionResult>;
}

interface ActionResult {
  ok: boolean;
  messageId?: string;
  draftId?: string;
  providerId?: string;
  warnings?: string[];
}
```

## Output Model

For agent use, the CLI should prefer `--json` and write artifacts to disk.

Suggested run layout:

```text
.surface/
  accounts.yaml
  auth/
  runs/
    2026-04-02T14-00-00Z/
      manifest.json
      summaries.ndjson
      bodies/
      attachments/
```

Good command output pattern:

```json
{
  "runId": "2026-04-02T14-00-00Z",
  "accountIds": ["work"],
  "view": "summary",
  "messages": [
    {
      "id": "msg_01HV",
      "threadId": "thr_01HV",
      "subject": "Invoice overdue",
      "from": { "email": "billing@vendor.com" },
      "receivedAt": "2026-04-02T09:12:00Z",
      "summaryPath": ".surface/runs/2026-04-02T14-00-00Z/summaries.ndjson"
    }
  ]
}
```

The important part is that the CLI does not dump giant email bodies into stdout unless explicitly requested.

## Agent Layer

Treat the agent layer as a thin orchestration layer over the core mail commands, not as the provider integration itself.

Good agent commands:

- `surface agent triage`
- `surface agent plan`
- `surface agent apply`

Suggested flow:

1. `triage` fetches unread or search results and creates summaries.
2. `plan` proposes actions against those summaries.
3. `apply` executes approved actions, usually with `dryRun` first.

This gives you a clean safety boundary and makes testing much easier.

## Recommended V1 Scope

Start smaller than your instinct.

Build these first:

- account registry
- auth per account
- Gmail via API
- Outlook via Playwright
- unread
- search
- read
- attachment list/download
- draft reply
- send draft
- archive
- mark read/unread

Add later:

- reply all
- forward
- move/tag
- RSVP
- background sync
- watch mode
- threading helpers

## Opinionated Choices

- `search` should not return full contents by default.
- `read` should be the only command that hydrates a full body unless `--view full` is explicit.
- summaries should be separate artifacts, not mixed into raw message bodies
- draft creation should be a first-class action
- provider-specific quirks should stay inside adapters
- browser automation should be treated as a transport, not the public interface

## Clean Mental Model

If the tool feels good, it will have three layers:

1. Provider adapters: Gmail API, Outlook Playwright, later Graph.
2. Core normalized mail service: accounts, messages, search, read, actions.
3. Agent workflow layer: triage, summarize, plan, apply.

That is the shape to aim for.
