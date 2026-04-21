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
- refresh thread
- read message
- send
- reply
- reply-all
- forward
- archive
- mark-read
- mark-unread
- rsvp when meeting invites are supported by the provider
- list attachments
- download attachment

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
  refreshThread(account: MailAccount, threadRef: string): Promise<void>;
  readMessage(account: MailAccount, messageRef: string, refresh?: boolean): Promise<ReadResultEnvelope>;
  sendMessage(account: MailAccount, input: SendMessageInput): Promise<SendResultEnvelope>;
  reply(account: MailAccount, messageRef: string, input: ReplyInput): Promise<SendResultEnvelope>;
  replyAll(account: MailAccount, messageRef: string, input: ReplyInput): Promise<SendResultEnvelope>;
  forward(account: MailAccount, messageRef: string, input: ForwardInput): Promise<SendResultEnvelope>;
  archive(account: MailAccount, messageRef: string): Promise<ArchiveResultEnvelope>;
  markRead(account: MailAccount, messageRefs: string[]): Promise<MarkMessagesResultEnvelope>;
  markUnread(account: MailAccount, messageRefs: string[]): Promise<MarkMessagesResultEnvelope>;
  rsvp(
    account: MailAccount,
    messageRef: string,
    response: "accept" | "decline" | "tentative",
  ): Promise<RsvpResultEnvelope>;

  listAttachments(account: MailAccount, messageRef: string): Promise<AttachmentListEnvelope>;
  downloadAttachment(
    account: MailAccount,
    messageRef: string,
    attachmentId: string,
  ): Promise<AttachmentDownloadEnvelope>;
}
```

The adapter returns normalized mail-domain objects, not provider-native payloads.

## Normalization Rules

Provider-specific payloads must be mapped into:

- stable local refs
- normalized envelope data
- normalized body text
- attachment metadata
- provider locator data stored internally for later thread reads, message reads, and actions

Providers should persist normalized thread/message state before summary generation so summary
reuse can be keyed from the stored canonical thread content rather than provider-native payloads.

Providers should also keep account-owner identity current when they can verify it during auth.
Gmail can update the primary identity from the authenticated Gmail profile. Outlook v1 currently
only verifies that a browser profile reaches the mailbox UI, so user-confirmed identity may be
required until a reliable Outlook mailbox identity extraction path exists.

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
- `mark_read`
- `mark_unread`
- `rsvp`

Capabilities are account/transport-level. Message applicability should be derived from message facts.

## Warm Session Rules

- transports may optionally support explicit warm session ids for repeated live operations
- the default adapter behavior remains stateless when no session id is provided
- v1 warm session support is intentionally transport-specific rather than universal
- read-path warm sessions must remain bound to one account/provider/transport and fail closed on mismatch or expiry

## Write Action Rules

- write actions must stay behind explicit local enablement and recipient/account allowlists
- `archive` is part of the supported v1 action set
- read-state mutations such as `mark-read`, `mark-unread`, and `read --mark-read` are mailbox mutations
  and must stay behind explicit local write enablement and any configured account allowlist
- `delete` is intentionally deferred
- providers may use transport-specific fallback paths when the primary UI or API surface is not stable,
  but those fallbacks must be documented in `docs/decisions/`
- write results should resolve back into local `thread_ref` / `message_ref` values when practical

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
- summary reuse must not change the public result shape; unchanged threads may reuse stored
  summaries when the canonical content is unchanged
- summary fingerprints include prompt version and account-owner identity semantics so ME-scoped
  `needs_action` changes invalidate older generic summaries

## Provider Locator Requirements

Each provider must persist enough locator data for later resolution from local refs.

At minimum:

- provider thread identifier
- provider message identifier
- provider attachment identifier when attachment download is supported
- account identifier
- mailbox or folder hint when useful
- any transport-specific locator required for subsequent read/download/action calls
- any transport-specific locator required for subsequent thread refresh calls

These locators are internal storage concerns and should not be exposed in the public stdout JSON contract.

## Still Deferred

- preferred fixture strategy for browser-driven Outlook flows
- draft lifecycle commands such as list/update/send-existing-discard
