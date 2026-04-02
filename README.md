# Surface CLI

A clean, local-first mail CLI for multi-provider, multi-account email.

The core idea is simple:

- normalize Gmail and Outlook into one mail contract
- keep provider transport hidden behind adapters
- return cheap message summaries by default
- cache normalized full bodies when useful
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
  By default, writes should create drafts unless send is explicit.
- Expose capabilities explicitly.
  Not every account will support every action equally well, especially browser-driven Outlook flows.

## CLI Shape

Top-level groups:

- `surface account`
- `surface auth`
- `surface mail`
- `surface attachment`

Example command set:

```bash
surface account add work --provider gmail --transport gmail-api --email me@company.com
surface account add school --provider outlook --transport outlook-web-playwright --email me@school.edu

surface auth login work
surface auth login school

surface mail unread --account work --limit 25 --emit summary --hydrate text --json
surface mail search --account all --from billing@vendor.com --has-attachment --emit summary --hydrate text --json
surface mail read msg_01HV... --body text --json

surface attachment list msg_01HV...
surface attachment download msg_01HV... --attachment att_02 --out ./downloads/

surface mail reply msg_01HV... --body-file ./reply.md --mode draft
surface mail send-draft drf_01HV...
surface mail archive msg_01HV...
surface mail mark-read msg_01HV...
```

## Suggested Behavior

### `surface mail unread`

Default output:

- message envelope
- snippet
- attachment count
- thread id
- unread state
- summary block
- body reference if hydration is enabled

Default contract:

- emit summaries inline
- hydrate normalized text bodies into the run cache
- do not inline full bodies in stdout
- obey per-message and per-run byte budgets while hydrating

This keeps the result token-efficient while avoiding a second provider fetch later.

### `surface mail search`

Default output should also be envelope-first, but the key split is:

- `--emit refs`
- `--emit summary`
- `--emit full`

and independently:

- `--hydrate none`
- `--hydrate text`
- `--hydrate full`

Recommended default:

- `--emit summary`
- `--hydrate text`

That means:

- the command returns envelope metadata plus summaries in stdout
- the command also stores normalized text bodies on disk
- later reads can load from cache instead of hitting the provider again
- hydration should stop or truncate when byte budgets are exceeded

This is cleaner than making search always return full contents inline.

### `surface mail read`

This is the explicit expensive read.

It should return or materialize:

- normalized plain text body
- HTML path if available
- headers
- quoted history if requested
- attachment metadata

It should prefer cached bodies from a prior `search` or `unread` run when available.
If the cached body was truncated due to a budget, `read` can re-fetch the full message on demand.

## Public Contracts

TypeScript is a good fit here because:

- Playwright support is strong
- Gmail API support is mature
- you can define stable typed contracts for consumers and adapters

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

This matters because `outlook-web-playwright` may support the same user-visible action set, but the reliability characteristics are different. Consumers should inspect capability flags, not assume parity.

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

The summary should be small and stable. It exists to support broad, token-efficient triage.

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

### Hydration Metadata

```ts
interface BodyRef {
  messageId: string;
  status: "not_fetched" | "cached";
  format: "text" | "full";
  textPath?: string;
  htmlPath?: string;
  sizeBytes?: number;
  truncated?: boolean;
}
```

Use `BodyRef` on list/search results so the caller knows whether a later `read` will come from local cache or require a provider fetch.

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

### List/Search Result

`search` and `unread` should return a normalized result item rather than just an envelope:

```ts
interface MessageListItem {
  envelope: MessageEnvelope;
  summary?: MessageSummary;
  bodyRef?: BodyRef;
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

The CLI should prefer `--json` and write heavy artifacts to disk.

Suggested run layout:

```text
.surface/
  accounts.yaml
  auth/
  runs/
    2026-04-02T14-00-00Z/
      manifest.json
      messages.ndjson
      bodies/
      attachments/
```

Good command output pattern:

```json
{
  "runId": "2026-04-02T14-00-00Z",
  "accountIds": ["work"],
  "emit": "summary",
  "hydrate": "text",
  "messages": [
    {
      "envelope": {
        "id": "msg_01HV",
        "threadId": "thr_01HV",
        "subject": "Invoice overdue",
        "from": { "email": "billing@vendor.com" },
        "receivedAt": "2026-04-02T09:12:00Z"
      },
      "summary": {
        "brief": "Vendor invoice is overdue and needs payment review.",
        "urgency": "high",
        "needsAction": true,
        "actionType": "pay"
      },
      "bodyRef": {
        "messageId": "msg_01HV",
        "status": "cached",
        "format": "text",
        "textPath": ".surface/runs/2026-04-02T14-00-00Z/bodies/msg_01HV.txt"
      }
    }
  ]
}
```

The important part is that the CLI does not dump giant email bodies into stdout unless explicitly requested, but it can still cache those bodies locally during the initial fetch.

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
- `search` and `unread` should default to `--emit summary --hydrate text`.
- `read` should load from cache first and only hit the provider if the body was not already hydrated.
- full bodies should usually be stored on disk, not inlined into stdout JSON
- hydration should respect byte budgets so very large searches do not become accidental bulk exports
- summaries should be separate artifacts, not mixed into raw message bodies
- draft creation should be a first-class action
- provider-specific quirks should stay inside adapters
- browser automation should be treated as a transport, not the public interface

## Clean Mental Model

If the tool feels good, it will have three layers:

1. Provider adapters: Gmail API, Outlook Playwright, later Graph.
2. Core normalized mail service: accounts, messages, search, read, actions, cache.
3. External orchestration: OpenClaw or any other caller that shells out to the CLI.

That is the shape to aim for.
