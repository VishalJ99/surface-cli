# PER-569: Reuse warm Outlook sessions for default live reads

Default Outlook provider-backed read commands should select an account/provider/transport-bound,
unexpired healthy session, join a starting session, or reserve and start one. An immediate SQLite
transaction on the existing registry protects only selection/reservation/spawn; no schema change
or new output directory is needed. Explicit session starts remain independent, and explicit IDs
fail closed. Preserve existing cache predicates, stateless writes and non-Outlook dispatch.

Readiness must check the actual socket and wait up to 60 seconds of browser/bootstrap allowance
plus twice the configured provider timeout (navigation and mailbox readiness). A failed caller-owned
startup terminates its daemon process group and records failure; joining callers do not kill it.
Provider operation errors are propagated without retry. Default TTL remains one hour idle / seven
days maximum age. Documentation: proposed ADR 0047 and CLI/provider/cache contracts.

Disposition: independently reviewed; folded into accepted ADR 0047. Source review and 63 offline tests, TypeScript check/build passed on Mac mini. Live installation verification follows in PER-569.

Automatic reuse requires a private SHA-256 fingerprint of effective runtime config and inherited
summarizer credentials/agent environment. A bounded five-second ping responds independently of
serialized browser operations and the new daemon protocol does not renew TTL. Legacy or incompatible daemons remain
available to explicit users but are skipped for automatic reuse; no raw credentials or new public
fields are exposed. This preserves the caller's selected summarizer settings without changing them.
