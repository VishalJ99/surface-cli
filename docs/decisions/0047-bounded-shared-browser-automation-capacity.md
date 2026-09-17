# ADR 0047: Browser Automation Uses A Shared Bounded Capacity Lease

## Status

Accepted

## Context

PER-510 adds a long-lived Outlook browser-auth daemon alongside ordinary Outlook commands and
warm read sessions. Each Playwright persistent context launches Chromium and can consume material
RAM. Dross may use different `SURFACE_CACHE_DIR` values for separate accounts, so a lock below one
account cache cannot cap browser use across accounts or processes.

The limit must protect only browser processes that Surface launched. It must not enumerate or kill
an operator's unrelated Chrome. A crashed Surface parent can leave Chromium descendants behind, so
deleting a lease merely because its parent PID or wall-clock TTL expired would permit unbounded
browser accumulation.

## Decision

Use a private, per-UID shared lease root. Its default is
`${XDG_STATE_HOME:-~/.local/state}/browser-automation/leases`; `BROWSER_AUTOMATION_LEASE_DIR`
selects another root. `SURFACE_BROWSER_LEASE_DIR` remains a compatibility alias. The root is
checked as a non-symlink directory owned by the current UID and permissioned `0700`.

The root contains a private SQLite ledger. A `BEGIN IMMEDIATE` transaction creates one immutable
shared maximum-active budget and reserves a lease before Surface calls Playwright. The initial
default is one active browser. Participants use `BROWSER_AUTOMATION_MAX_ACTIVE` and must agree on
the same limit for one root. Contention and SQLite busy states return retryable `browser_busy`
without waiting indefinitely.

Every Surface Chromium root receives a random inert command-line marker. At launch, Surface records
the marker's current same-UID descendant tree with each process's start-time fingerprint. Both the
normal context-close path and later dead-parent recovery run the same verification before deleting a
lease. If the marker tree or a recorded descendant remains with the recorded fingerprint, Surface
uses a bounded `SIGTERM` then `SIGKILL` sequence only for that same-UID captured process set and
verifies every member has exited. A fingerprint mismatch is a possible PID reuse and preserves the
slot; Surface never signals it. Unavailable process inspection also preserves the slot.

Stateless Outlook browser commands have a configurable 45-second default deadline.
`surface auth serve` is exempt from that command deadline but has a 20-minute fixed lifetime and a
five-minute interaction-only idle lifetime. Warm sessions default to five minutes idle and one hour
maximum age. Status and screenshot polls do not refresh hosted-auth idleness. Unix-socket warm
session input, queue depth, and serialized response bytes are bounded.

## Consequences

- Surface cannot accumulate an unbounded number of its own Chromium contexts during repeated
  commands, failed retries, or cross-account auth.
- A capacity cap is not a claim that Chromium RSS is constant. The local fixture lifecycle test
  verifies repeated browser close/release behavior only; production RSS remains deployment-specific.
- A process-inspection failure or ambiguous stale descendant can temporarily block a new browser
  until an operator resolves it. This is deliberate safety over freeing a possibly live Chrome.
- Another browser CLI may share the ledger by implementing the documented SQLite schema and marker
  protocol. It must not change the shared maximum while any leases are active.
