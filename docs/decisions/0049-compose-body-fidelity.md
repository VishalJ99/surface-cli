# 0049: Plain-text compose fidelity

All send/reply/reply-all/forward paths canonicalize CRLF and lone CR to LF,
NBSP to spaces, line-end spaces/tabs away, and boundary newlines away. Interior
newlines are significant: a line break and a blank paragraph must not compare equal.

Outlook selects exactly one visible, contenteditable Message body. A DOM Range
selects that editor alone and one native insertHTML operation replaces its contents
with escaped text and explicit br elements. Keyboard typing, paragraph tags and
browser list autoformat are not used. Reply/forward quotations are reconstructed
from the selected stored message, rather than retaining arbitrary old compose HTML.
The entire editable body is compared exactly after insertion and again immediately
before finalization, including after attachment upload. A mismatch or generated list
fails closed and leaves the compose unsent.

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
