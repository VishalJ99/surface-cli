# Decision: Require reliable account-owner identity for ME-scoped summaries
Ticket: PER-172
Timestamp: 2026-04-21T12:19:09Z

## What I decided
ME-scoped summary semantics must not rely on an Outlook account registry email when that value is a placeholder or otherwise unverified. Before Surface uses `needs_action` as "does ME need to act now?", the summarizer should receive a reliable account-owner identity, preferably the authenticated mailbox email derived during provider auth/status or refresh, falling back to the configured account email only when it is real and trusted.

## Why
The PER-172 benchmark had to use a local-only ME override for `uni` because the Surface account registry stores `uni@placeholder.local`. That was acceptable for an offline benchmark, but it would be unsafe in production: a wrong ME identity can invert `needs_action`, especially in threads where the latest message is from the account owner.

## Impact
Implementation should add or derive authenticated mailbox identity for Outlook and pass it into the summary payload/prompt. Summary fingerprinting should include the prompt/identity semantics so old summaries generated without reliable ME identity do not survive as if they were valid under the new contract. If reliable identity is unavailable, Surface should either disable ME-scoped action labeling for that account or return a conservative/unknown state rather than pretending the boolean is trustworthy.

## How to undo
Reject ME-scoped `needs_action` as a production contract and keep `needs_action` as a generic "thread may require attention" model hint. If doing that, remove account-owner identity from the summarizer prompt, rerun PER-172-style benchmarks against the generic semantics, and update docs so agents do not interpret the flag as user-action-required.
