# Decision: Tune default OpenClaw summary batches to 3 threads and 64 KiB
Ticket: PER-167
Timestamp: 2026-04-20T19:05:00Z

## What I decided
Set the default OpenClaw summary batch caps to `3` whole threads and `64 KiB` of canonical
summary input, and remove the temporary env-based benchmark overrides from the code path.

## Why
Follow-up live benchmarks on the shipped `openclaw/agent:main` backend showed that the prior
`6` thread / `32 KiB` defaults were materially worse on multi-thread workloads. On the same
top-10 unread Outlook thread set, `3/64 KiB` consistently outperformed the old default and
completed `10/10` summaries across repeated runs, while `3/32 KiB` proved unstable and
`4-5/64 KiB` configurations collapsed. On the common top-5 unread case, `3/64 KiB` also beat
`6/64 KiB`, so the chosen default held up on both stressed and common workloads.

## Impact
Fresh summary generation should scale better for common unread and search workloads without
changing the thread-first contract. Summary fidelity stays unchanged based on a read-only
evaluation of the resulting summaries across candidate configs.

## How to undo
Change the `OPENCLAW_BATCH_MAX_THREADS` and `OPENCLAW_BATCH_MAX_INPUT_BYTES` constants in
`src/summarizer.ts`, then rerun the PER-167 benchmark harness on the same account and thread
set before shipping a different default.
