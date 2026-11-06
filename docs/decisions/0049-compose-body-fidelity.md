# 0049: Plain-text compose fidelity

All send/reply/reply-all/forward paths canonicalize CRLF and lone CR to LF,
NBSP to spaces, line-end spaces/tabs away, and boundary newlines away. Interior
newlines are significant: a line break and a blank paragraph must not compare equal.

Outlook selects exactly one visible, contenteditable Message body. A DOM Range
selects that editor alone and one native insertHTML operation inserts escaped text
and explicit br elements without keyboard paragraph/list autoformat. This editor
check is necessary but not proof of persistence: OWA's virtual reply history lives
outside that DOM and may be appended, or authored text may be lost, during autosave.
Reply/forward quotations are explicitly reconstructed from the selected message.

After an exact draft ID and byte-verified uploads exist, close the compose and
navigate away so the editor cannot overwrite later writes. PATCH the whole intended
HTML body on that exact provider draft, then fetch it independently with GetItem and
require exact normalized equality. This full-body provider write, not virtual-editor
serialization, is the authoritative compose operation. Draft success returns this
verified ID. Sending uses the same verified draft's REST /send endpoint, not another
UI serialization or new-message creation. A mismatch never reaches /send.

Gmail creates a draft for both draft and send, fetches its raw MIME from the provider,
compares the decoded plain-text body to the intended MIME, then sends that same draft
ID only on equality. A verification failure leaves a draft for inspection. No automatic
retry or duplicate raw-message send is permitted after an ambiguous send result.

Gmail and IMAP/SMTP use the shared MIME builder, with CRLF throughout the wire body.
IMAP decodes both stored and delivery MIME before dispatch and compares against the
intended body; drafts additionally compare the freshly fetched provider copy. SMTP
has no editable remote draft to send by ID, so its pre-send check is the exact outgoing
MIME, not a provider-rendered preview. Live IMAP proof requires a configured test sink.

The HTML reader recognizes br, br/ and br / consistently without adding a second
newline for self-closing void elements. Existing arbitrary incoming HTML paragraph
extraction is otherwise unchanged.

No public result schema changes. Existing recipient/write safety policies still apply.

## Persisted Outlook receipts

Editor equality alone is insufficient: autosave can lag, conversation fragments can
omit draft bodies, and the latest thread message is not a compose receipt. Track
CreateItem/UpdateItem response IDs for this compose, then fetch that exact ID with
GetItem (AllProperties, HTML). Require IsDraft and a complete Body, and compare the
whole normalized body exactly. An empty or unavailable body must never pass for a
nonempty request. Poll boundedly for autosave convergence, fail closed on timeout,
and verify after the canonical provider write and immediately before a send.

Detect attachment completion using saved filename metadata and a byte-for-byte
provider download, not visible filename chips. Image tiles need not render filename
text. Exchange Size includes transport overhead and is not a byte-length receipt.
Require a distinct saved attachment ID for each requested file.

Persist and return the verified draft's exact message_ref, never a subject-search or
latest-thread guess. On failure retain the draft for inspection and return its refs
in the existing error envelope with retryable=false. If identity recovery fails,
explicitly report that a draft may exist and must be inspected before retrying. Do
not automatically retry the compose or discard a possibly valuable draft.

Conversation refresh hydrates every IsDraft item with full GetItem properties, so
subsequent mail read --refresh does not replace a verified body with an empty fragment.

The warm-session compatibility fingerprint includes the full-draft-read revision,
so default reads do not reuse a daemon running the older fragment-only reader.

Outlook persistence uses immediate SQLite transactions to avoid lock upgrades when
a warm reader and a compose receipt are committed concurrently.
