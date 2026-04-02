# Docs

This directory is the source of truth for Surface CLI behavior.

## Files

- `cli-contract.md`
  Public commands, flags, refs, and JSON response contracts.
- `provider-contract.md`
  Provider adapter contract and implementation rules.
- `cache-and-db.md`
  Local SQLite, cache layout, and refresh behavior.
- `config.md`
  Global configuration keys, defaults, and precedence.
- `m1-checklist.md`
  Exact decisions required to clear Milestone 1.
- `decisions/`
  Architecture Decision Records (ADRs).

## Working Rule

If code and docs disagree, the docs should be treated as stale and updated in the same change.
