# PER-369: Integrate and guard Outlook lifecycle cleanup

Preserve the user-authorized canonical additive resource/lifecycle changes while retaining
PER-569 account-scoped warm-session reuse/config compatibility and PER-492 recipient verification.
Use shared bounded cleanup outside the reservation transaction; keep daemon health synchronous.

Independent review identified unsafe PID reuse, argv-crossing Chromium identity and unchecked
delayed group SIGKILL. Signals now require separate executable identity, exact actual daemon
entrypoint and account/session/socket bindings, original start identity, and immediate revalidation.
Orphan reaping also revalidates markers, dead ownership and full group membership before every
signal. ADR 0048 documents cleanup and the additive `cache-prune` counters. No live mailbox tests.

Pending review/closure: primary agent to verify combined release, promote/correct ADR, and archive
this decision. The original canonical dirty checkout remains unchanged.

Disposition: independently reviewed; folded into accepted ADR 0048. The combined 97-test suite, TypeScript check and build pass on Mac mini. Live process verification follows in PER-569.
