# Decision: Treat ClawHub skill publishes as sourcing the OpenClaw workspace copy
Ticket: PER-175
Timestamp: 2026-04-23T10:18:00Z

## What I decided
For this release flow, I am treating `clawhub publish ... --slug surface-cli` as sourcing the
tracked OpenClaw workspace skill copy at `~/.openclaw/workspace/skills/surface-cli/`, not the repo
copy under `skills/surface-cli/`.

## Why
I updated `skills/surface-cli/SKILL.md` locally with watcher guidance and published
`surface-cli@0.3.3`. ClawHub accepted the publish and advanced the latest tag to `0.3.3`, but
`clawhub inspect surface-cli --version 0.3.3 --file SKILL.md` still returned the pre-edit skill
text. Republishing after commit as `0.3.4` produced the same stale hosted file, so “commit first”
was not sufficient.

The hosted `SKILL.md` sha256 for `0.3.4` matched
`~/.openclaw/workspace/skills/surface-cli/SKILL.md`, not the repo file and not the legacy
`~/.openclaw/skills/surface-cli/SKILL.md` copy. That means the effective publish source in this
environment is the OpenClaw workspace skill copy.

## Impact
- Before publishing, sync the intended `SKILL.md` into `~/.openclaw/workspace/skills/surface-cli/`
  or publish directly from that path.
- `surface-cli@0.3.3` and `surface-cli@0.3.4` are stale doc-only skill versions and should not be
  treated as the intended watcher-guidance release.
- The corrected release should be republished as a new version after the workspace copy is synced
  and then re-inspected.

## How to undo
If later validation shows the publish path can be forced to use the repo folder directly and this
workspace-copy behavior was incidental to this environment, archive this note and replace it with
the narrower confirmed release rule.
