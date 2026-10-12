# ADR 0048: Bound Outlook Resource And Session Cleanup

## Status

Accepted (PER-369; preserves ADR 0047 default session reuse)

## Context

Failed browser setup, close errors, retained request listeners/responses and stale session owners
can leave disposable Outlook resources behind. PID liveness alone does not establish ownership:
a stale registry PID or browser group may have been reused by an unrelated process.

## Decision

Close Outlook browser contexts and disposable cloned profiles together, including partial launch
failures. Closure is idempotent and attempts profile cleanup even when context close fails. Remove
service capture request listeners in `finally` and dispose fetched response bodies in `finally`.

Use one bounded caller-side shutdown path for explicit stop, expired/stale session reconciliation
and failed owned startup. Prefer authenticated shutdown RPC (five seconds); verified daemon PIDs
then receive SIGTERM with 35 seconds for browser cleanup, followed by SIGKILL with a two-second exit
wait. Before every signal, independently verify the executable, actual daemon entrypoint, exact
session/account/socket arguments and original process start identity. Unverified PIDs are never
signalled. Source daemons launch through absolute `process.execPath` and the resolved tsx loader.
Registry/socket readiness and the ADR 0047 `60000 + 2 * provider_timeout_ms` budget are preserved.

Termination happens outside the short startup reservation transaction. Daemon health remains a
pure synchronous check; it never asks its own daemon to shut down. Session list reconciles stale
rows. Browser cleanup happens before the daemon exits, including connected socket teardown.

Before headless clone startup and `cache prune`, opportunistically reap only orphan Playwright
Chromium browser groups tied to a valid Surface Outlook temp-profile marker whose owner is dead.
Require exact direct temp-root child/profile match, marker and process age of at least ten minutes,
separately captured Chrome/Chromium executable identity, root group leadership and ownership of
all visible group members. Revalidate profile, owner, executable, process start identity and group
membership immediately before both SIGTERM and delayed SIGKILL. Unsupported/uncertain process
identity is skipped. Existing six-hour profile pruning and active-owner/profile guards remain.

`cache-prune` adds `outlook_orphan_chromium` counters (`dry_run`, `planned`, `terminated`,
`force_killed`, `exited`, `skipped_changed`, `errors`). A dry run never signals or deletes.

## Consequences

Cleanup failure paths are testable with synthetic sessions, processes and response bodies. No
mailbox JSON, SQLite schema, cached message semantics, summaries, auth profile or download policy
changes. Process metadata cannot eliminate the final OS race between an identity check and a
signal; macOS has no PID handle primitive here. Unknown executable/entrypoint layouts fail closed
for process signalling. Live browser cleanup still needs device smoke verification.
