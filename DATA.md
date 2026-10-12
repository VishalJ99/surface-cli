- `.env` — Local-only dotenv file for Surface runtime overrides such as compatibility remembered-auth account names, auth-check cadence, and `SURFACE_CACHE_DIR`; ignored by git.
- `.surface-cli/` — Optional project-local Surface state root when `SURFACE_CACHE_DIR` points inside the checkout; contains SQLite state, auth material, cache, downloads, remembered-auth state, and auth-check state; ignored by git.
- `outputs/` — Local-only generated reports and benchmark artifacts. May contain private mailbox content; ignored by git and not suitable for repository commits.

- `src/session.test.ts` — Synthetic account/session/socket fixtures for PER-569 default Outlook read dispatch, concurrent startup, readiness, expiry and failure regression tests; no live mailbox data.
- `src/providers/outlook/adapter.compose.test.ts` — Self-contained local Playwright fixture for Outlook recipient-picker and compose-field behavior; uses synthetic addresses and no mailbox state.
- `src/session-lifecycle.test.ts` — Synthetic daemon identity/PID reuse and shutdown fixtures for PER-369; no live mailboxes.
- `src/providers/outlook/orphan-chromium.test.ts` — Synthetic profile markers and process groups for safe orphan reaping, including executable spoofing and delayed PID reuse.
- `src/providers/outlook/session-lifecycle.test.ts` — Mock browser launch/close resources for partial-setup and idempotent cleanup verification.
- `src/providers/outlook/extract.test.ts` — Mock capture listeners and API response bodies for deterministic resource-release verification.
