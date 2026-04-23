# Decision: Treat ClawHub skill publishes as requiring committed skill state
Ticket: PER-175
Timestamp: 2026-04-23T10:18:00Z

## What I decided
For this release flow, I am treating `clawhub publish ./skills/surface-cli ...` as if it only
reliably publishes committed skill contents, not dirty working-tree edits.

## Why
I updated `skills/surface-cli/SKILL.md` locally with watcher guidance and published
`surface-cli@0.3.3`. ClawHub accepted the publish and advanced the latest tag to `0.3.3`, but
`clawhub inspect surface-cli --version 0.3.3 --file SKILL.md` still returned the pre-edit skill
text. That mismatch means the publish path did not include the intended local edits.

The most plausible explanation is that ClawHub packages committed repository state rather than the
dirty worktree, or otherwise resolves the skill folder from a committed snapshot. Either way, the
observed constraint is the same for Surface releases: do not rely on uncommitted skill edits being
published.

## Impact
- Skill changes should be committed before publishing to ClawHub.
- `surface-cli@0.3.3` is a stale doc-only skill version and should not be treated as the intended
  watcher-guidance release.
- The corrected release should be republished as a new version after commit and then re-inspected.

## How to undo
If later validation shows ClawHub does publish dirty working-tree contents and this mismatch had a
different cause, archive this note and remove any repo convention that requires committing before
publishing.
