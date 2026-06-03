# ADR 0042: IMAP Auth Uses Provider Presets

## Status

Accepted

## Context

Generic IMAP/SMTP accounts require incoming and outgoing server settings, but common providers
publish stable settings. Requiring every user to type six server flags for those providers makes
setup feel harder than it needs to be and increases copy/paste mistakes.

At the same time, generic IMAP is not a browser or OAuth flow. It authenticates to IMAP/SMTP with a
mailbox password or app-specific password. Providers that require interactive OAuth or browser 2FA
need provider-specific support instead of the generic password transport.

## Decision

`surface auth login <account>` for `provider=imap` can infer server settings from a built-in preset
when no explicit server flags are provided.

The preset key is the domain from `--username` when present, otherwise the account email. Initial
presets are limited to verified GMX domains:

- `gmx.com`: IMAP `imap.gmx.com:993 tls`, SMTP `mail.gmx.com:587 starttls`
- `gmx.net`: IMAP `imap.gmx.net:993 tls`, SMTP `mail.gmx.net:587 starttls`

If any server flag is provided, all server flags must be provided. This avoids mixing preset and
manual values in a way that is hard to reason about. If no preset exists for the mailbox domain,
Surface fails with an explicit message asking for the IMAP/SMTP host, port, and security flags.

## Consequences

- GMX setup can be documented as a short username/password login.
- Custom IMAP providers remain supported through explicit server settings.
- Generic IMAP auth remains password/app-password based; browser 2FA and provider OAuth remain out
  of scope for the generic transport.
