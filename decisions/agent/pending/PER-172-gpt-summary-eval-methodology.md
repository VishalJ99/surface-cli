# Decision: Evaluate GPT summarizers with ME-scoped action flags and causal-chain briefs
Ticket: PER-172
Timestamp: 2026-04-21T11:31:36Z

## What I decided
The GPT model comparison will use a fixed cached `uni` thread set, direct OpenAI API calls, and a benchmark prompt that explicitly identifies the account owner as ME and asks for causal-chain summaries on multi-message threads. The benchmark payload will include messages in latest-first order and cap total body text at 64 KiB per thread, with body clipping recorded in the payload metadata.

## Why
The current Surface summary prompt leaves `needs_action` underspecified, so measuring models against it would mostly measure ambiguity. The report is intended to choose a future default for useful agent triage, so it should test the intended semantics: whether ME needs to act now, not whether the thread is generally active. A 64 KiB cap is larger than the current production triage cap and gives long threads enough room for causal-chain assessment without making the first report unbounded or dominated by giant historical quotes.

## Impact
The report will be a model-selection benchmark for the proposed semantics, not an exact measurement of the current shipped prompt. If the conclusions are used for implementation, Surface should also update the public summary semantics, prompt/fingerprint versioning, and Outlook account-owner identity handling before relying on the new action flag behavior.

## How to undo
Reject this methodology and rerun PER-172 with the current shipped prompt and `summary_input_max_bytes` value, or rerun with a different payload cap. The local report outputs under `outputs/per172-*` should be considered invalid for default-model selection if this decision is rejected.
