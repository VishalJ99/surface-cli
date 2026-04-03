# Provider Contract

## Goal

Define the normalized interface each provider transport must implement so Gmail,
Outlook, and later providers can plug into the same CLI contract.

## Terminology

- `provider`
  User-visible provider family such as Gmail or Outlook.
- `transport`
  Concrete integration path such as Gmail API or Outlook Playwright.

Examples:

- `provider=gmail`, `transport=gmail-api`
- `provider=outlook`, `transport=outlook-web-playwright`

## Requirements

Each provider implementation must support:

- account auth lifecycle
- search
- fetch-unread
- read message
- rsvp when meeting invites are supported by the provider
- list attachments
- download attachment

Later write actions should also share the same normalized contract.

## Required Adapter Interface

Each provider transport should implement a shared adapter interface equivalent to:

```ts
interface MailProviderAdapter {
  readonly provider: "gmail" | "outlook";
  readonly transport: string;

  login(account: MailAccount): Promise<void>;
  logout(account: MailAccount): Promise<void>;
  authStatus(account: MailAccount): Promise<AuthStatus>;

  search(account: MailAccount, query: SearchQuery): Promise<ThreadResult[]>;
  fetchUnread(account: MailAccount, query: FetchUnreadQuery): Promise<ThreadResult[]>;
  readMessage(account: MailAccount, messageRef: string, refresh?: boolean): Promise<MessageReadResult>;
  rsvp(
    account: MailAccount,
    messageRef: string,
    response: "accept" | "decline" | "tentative",
  ): Promise<RsvpResult>;

  listAttachments(account: MailAccount, messageRef: string): Promise<AttachmentMeta[]>;
  downloadAttachment(
    account: MailAccount,
    messageRef: string,
    attachmentId: string,
  ): Promise<AttachmentDownloadResult>;
}
```

The adapter returns normalized mail-domain objects, not provider-native payloads.

## Normalization Rules

Provider-specific payloads must be mapped into:

- stable local refs
- normalized envelope data
- normalized body text
- attachment metadata
- provider locator data stored internally for later reads/actions

Public JSON must not leak transport-specific field names unless explicitly documented.

## Capability Model

Each account/provider transport should expose capability flags such as:

- `search`
- `fetch_unread`
- `read`
- `attachment_list`
- `attachment_download`
- `reply`
- `reply_all`
- `forward`
- `archive`
- `rsvp`

Capabilities are account/transport-level. Message applicability should be derived from message facts.

## Invite And RSVP Rules

- invite metadata belongs on the message object, not the summary
- RSVP-capable providers should expose `invite.is_invite`, `invite.rsvp_supported`,
  `invite.response_status`, and `invite.available_rsvp_responses`
- `response_status` should reflect the latest known user response for that invite, even if the
  original provider payload is stale and the provider must infer the state from newer messages
- RSVP execution should be idempotent enough that repeated requests do not corrupt local state;
  the provider should refresh and persist the latest thread state after an RSVP action

## Conformance Expectations

Each provider should pass the same contract tests for:

- search result schema
- fetch-unread result schema
- read behavior on cache hit and cache miss
- attachment metadata shape
- machine-readable error codes

## Provider Locator Requirements

Each provider must persist enough locator data for later resolution from local refs.

At minimum:

- provider thread identifier
- provider message identifier
- account identifier
- mailbox or folder hint when useful
- any transport-specific locator required for subsequent read/download/action calls

These locators are internal storage concerns and should not be exposed in the public stdout JSON contract.

## Still Deferred

- exact interface surface for write actions
- preferred fixture strategy for browser-driven Outlook flows
