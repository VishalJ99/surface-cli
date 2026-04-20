# ADR 0031: Reuse Thread Summaries And Batch OpenClaw By Whole Thread

## Status

Accepted

## Context

`search` and `fetch-unread` return thread-level summaries, but PER-165 showed that the
dominant latency cost was repeated one-thread-at-a-time OpenClaw invocations. That made
polling workflows expensive even when the same unread threads were fetched repeatedly.

Surface also needs batching to stay faithful to the thread-first contract. A thread must
never be split across summary requests, and a failed summary batch must not fail the mail
fetch itself.

## Decision

Surface should summarize against a canonical per-thread payload and reuse summaries when
that payload has not changed.

Specifically:

- build a canonical summary input from normalized thread data
- compute and persist a fingerprint of that canonical payload alongside the summary row
- reuse a stored summary when `backend`, `model`, and `fingerprint` all match
- for OpenClaw, batch whole-thread payloads into bounded chunks instead of invoking one
  process per thread
- default the OpenClaw batch caps to `3` threads and `64 KiB` of canonical summary input
  based on follow-up benchmarking against the shipped `openclaw/agent:main` path
- use low thinking for the default OpenClaw summary path
- if a batch fails to parse or times out, split it recursively until either smaller batches
  succeed or a single-thread summary fails
- if a single-thread summary still fails, return `summary: null` for that thread and keep
  the parent command successful
- record the OpenClaw summary target as `openclaw/agent:<agent_id>` instead of shelling out
  to discover agent metadata on every summary call

The batching unit is always the whole thread. Surface must never split a single thread
across multiple summary requests.

## Consequences

- repeated polling commands can approach the no-summary latency path when threads are unchanged
- summary generation becomes more failure-tolerant because one bad batch can be retried as
  smaller batches
- the batch defaults are tuned for the current OpenClaw wrapper behavior, not just the raw
  model context size, so future backend changes may justify retuning them
- summary rows in SQLite now include a fingerprint field
- OpenClaw summaries must explicitly guard against cross-thread contamination because a
  single prompt can contain multiple threads
- summarization remains optional: backend failures still degrade to `summary: null`
