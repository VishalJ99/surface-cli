# ADR 0045: Prune Outlook Temp Browser Profiles Opportunistically

## Status

Accepted

## Context

Headless Outlook commands clone the persistent browser profile from `auth/<account_id>/profile` into
an OS temp directory named `surface-outlook-*` before launching Chromium. Normal command shutdown
removes that clone, but interrupted runs can leave large browser-profile copies behind.

The persistent Outlook auth profile contains the real local browser session and must remain under
Surface auth storage. The temp clones are disposable working copies created only so headless
Playwright runs do not mutate the persistent profile directly.

## Decision

Surface prunes stale Outlook temp profile clones opportunistically before creating a new headless
Outlook clone. There is no background janitor, LaunchAgent, or implicit reauth daemon.

The prune routine only considers direct children of the OS temp root whose basenames start with
`surface-outlook-`. A profile is prunable only when it is older than the configured max age and is
not associated with a live owner PID marker or active browser process arguments. The default max age
is six hours.

`surface cache prune` exposes the same routine with `--dry-run` and `--max-age-seconds` options.
Cache commands may delete these disposable temp clones, but they must not delete auth material,
downloaded attachments, account state, or the persistent Outlook profile under `~/.surface-cli/auth`.

## Consequences

- routine Outlook use self-heals leaked temp clones without an always-on service
- interrupted temp clones are reclaimable while live browser sessions stay protected by age and
  activity checks
- `surface cache prune --dry-run` gives operators a safe preview of reclaimable Outlook temp data
- auth and cache boundaries remain separate: persistent provider auth lives under `auth/`, while
  `surface-outlook-*` temp clones are disposable
