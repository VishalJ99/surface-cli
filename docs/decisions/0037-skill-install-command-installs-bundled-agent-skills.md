# ADR 0037: Skill Install Command Installs Bundled Agent Skills

## Status

Accepted

## Context

Surface has two installation surfaces:

- the npm package, which installs the `surface` CLI binary
- the agent skill, which teaches Codex, Claude Code, or OpenClaw when and how to use the CLI

OpenClaw has ClawHub, but Codex and Claude Code users previously had to curl
`skills/surface-cli/SKILL.md` from the repository. That made the install path
depend on mutable `main` branch contents and could install skill text that did
not match the npm package version.

## Decision

The npm package includes `skills/surface-cli/SKILL.md`.

Surface exposes:

```bash
surface skill install codex
surface skill install claude-code
surface skill install all
```

`claude` is accepted as an alias for `claude-code`.

The command copies the bundled skill into the default user skill directory for
the target agent:

- Codex: `~/.codex/skills/surface-cli/SKILL.md`
- Claude Code: `~/.claude/skills/surface-cli/SKILL.md`

The command returns a machine-readable `skill-install` envelope listing the
source and destination paths for each installed copy.

## Consequences

- `npm install -g surface-cli` plus `surface skill install <target>` is enough
  to install matching CLI and skill content for Codex or Claude Code.
- Users no longer need to curl a raw GitHub URL for normal Codex or Claude Code
  setup.
- Release verification must include `npm pack --dry-run` to confirm the skill
  file is included in the npm payload.
- ClawHub remains the OpenClaw distribution path; this command is for local user
  skill installs.
