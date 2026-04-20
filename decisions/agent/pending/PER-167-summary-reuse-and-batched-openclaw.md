# Decision: Reuse unchanged summaries and batch whole threads for OpenClaw
Ticket: PER-167
Timestamp: 2026-04-20T13:55:00Z

## What I decided
Surface should cache summaries by a fingerprint of the canonical summary input and only re-summarize threads whose fingerprint changed. For new or changed threads on the OpenClaw backend, Surface should summarize whole threads in bounded batches with fallback splitting instead of issuing one OpenClaw call per thread.

## Why
The measured latency is dominated by repeated OpenClaw wrapper overhead, not by Outlook fetch time or raw email body size. Reusing unchanged summaries cuts polling cost to near zero for stable threads, and batching whole threads amortizes the OpenClaw bootstrap cost without splitting thread context across calls.

## Impact
This affects the summarizer implementation, SQLite summary storage, and provider search/fetch paths for Gmail and Outlook. It also changes summarization failure handling, because one failed batch may need to be split and retried before falling back to `summary: null`.

## How to undo
Remove the summary fingerprint column and reuse logic, revert the OpenClaw batch helper to one-thread-at-a-time calls, and restore the previous provider summarization loops.
