# Provider Contract

## Goal

Define the normalized interface each provider transport must implement so Gmail,
Outlook, generic IMAP, and later providers can plug into the same CLI contract.

## Terminology

- `provider`
  User-visible provider family such as Gmail or Outlook.
- `transport`
  Concrete integration path such as Gmail API or Outlook Playwright.

Examples:

- `provider=gmail`, `transport=gmail-api`
- `provider=outlook`, `transport=outlook-web-playwright`
- `provider=imap`, `transport=imap-smtp`

## Requirements

Each provider implementation must support:

- account auth lifecycle
- search
- fetch-unread
- fetch sent messages
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

New provider transports may land in staged milestones, but they must explicitly return
machine-readable unsupported/not-implemented errors for unimplemented capabilities until they meet
the full requirement set above.

## Required Adapter Interface

Each provider transport should implement a shared adapter interface equivalent to:

```ts
interface MailProviderAdapter {
  readonly provider: "gmail" | "outlook" | "imap";
  readonly transport: string;

  login(account: MailAccount, context: ProviderContext): Promise<AuthStatus>;
  logout(account: MailAccount, context: ProviderContext): Promise<AuthStatus>;
  authStatus(account: MailAccount, context: ProviderContext): Promise<AuthStatus>;

  search(account: MailAccount, query: SearchQuery, context: ProviderContext): Promise<ThreadResult[]>;
  fetchUnread(account: MailAccount, query: FetchUnreadQuery, context: ProviderContext): Promise<ThreadResult[]>;
  fetchSent(account: MailAccount, query: SentQuery, context: ProviderContext): Promise<SentMessageResult[]>;
  refreshThread(account: MailAccount, threadRef: string, context: ProviderContext): Promise<void>;
  readMessage(
    account: MailAccount,
    messageRef: string,
    refresh: boolean,
    context: ProviderContext,
  ): Promise<ReadResultEnvelope>;
  sendMessage(account: MailAccount, input: SendMessageInput, context: ProviderContext): Promise<SendResultEnvelope>;
  reply(
    account: MailAccount,
    messageRef: string,
    input: ReplyInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope>;
  replyAll(
    account: MailAccount,
    messageRef: string,
    input: ReplyInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope>;
  forward(
    account: MailAccount,
    messageRef: string,
    input: ForwardInput,
    context: ProviderContext,
  ): Promise<SendResultEnvelope>;
  archive(account: MailAccount, messageRef: string, context: ProviderContext): Promise<ArchiveResultEnvelope>;
  markRead(account: MailAccount, messageRefs: string[], context: ProviderContext): Promise<MarkMessagesResultEnvelope>;
  markUnread(account: MailAccount, messageRefs: string[], context: ProviderContext): Promise<MarkMessagesResultEnvelope>;
  rsvp(
    account: MailAccount,
    messageRef: string,
    response: "accept" | "decline" | "tentative",
    context: ProviderContext,
  ): Promise<RsvpResultEnvelope>;

  listAttachments(account: MailAccount, messageRef: string, context: ProviderContext): Promise<AttachmentListEnvelope>;
  downloadAttachment(
    account: MailAccount,
    messageRef: string,
    attachmentId: string,
    context: ProviderContext,
  ): Promise<AttachmentDownloadEnvelope>;
}
```

The adapter returns normalized mail-domain objects, not provider-native payloads.

`surface mail sync-unread-state` is intentionally a CLI/cache operation layered on the existing
`fetchUnread` adapter method. Providers do not need a separate full-history unread sync hook for
the bounded v1 command.

`surface mail sent` is intentionally a provider adapter method because it is message-first while
`search` and `fetchUnread` are thread-first. Providers should return newest sent messages up to the
query limit, include stable `thread_ref` values on every result, and persist any fetched
conversation/message state through the same normalized cache used by search/fetch. When
`SentQuery.thread_ref` is present, providers should refresh that specific thread when possible and
return account-authored sent messages from the normalized stored thread, optionally also applying
the recipient filter.

`ProviderContext.authLoginOptions` carries provider-specific one-shot login settings collected by
the CLI. In v1 this is used by `imap-smtp` for IMAP/SMTP host, port, security mode, username, and
password source flags. Providers must store durable auth material under the account auth directory,
not in the repo or local policy config.

## Normalization Rules

Provider-specific payloads must be mapped into:

- stable local refs
- normalized envelope data
- normalized body text
- attachment metadata
- provider locator data stored internally for later thread reads, message reads, and actions

When a provider body comes from HTML, normalized body text should preserve hyperlink targets inline
as `anchor text[URL]` so plain-text cache/read paths do not drop operational links.

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
- sent result schema, including `message_ref` and `thread_ref`
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
