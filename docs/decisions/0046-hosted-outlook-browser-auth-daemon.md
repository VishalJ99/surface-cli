# ADR 0046: Hosted Outlook Browser Auth Uses A Bounded Candidate-Profile Daemon

## Status

Accepted

## Context

An Outlook school or work account may need an interactive Microsoft web sign-in on the same Linux
host that will later run Surface queries. Copying a local browser profile is not a workable hosted
interaction model: it neither gives a phone viewer access to a local Safari session nor proves that
the hosted profile can read Outlook.

Surface must preserve the existing active Outlook profile until a newly completed sign-in has passed
a real mailbox probe. The control path also needs a stable process lifetime across CLI invocations,
instead of an in-memory helper that disappears as soon as `surface auth login` exits.

## Decision

Add a standalone, one-account daemon:

```bash
surface auth serve <outlook-account> --host 127.0.0.1 --port <port> --expected-email <email>
```

The daemon exposes a bearer-token-protected HTTP lifecycle:

- `POST /v1/auth/begin`
- `GET /v1/auth/status` and `GET /v1/auth/<session_id>/status`
- `POST /v1/auth/<session_id>/finalize`
- `POST /v1/auth/<session_id>/cancel`

It also exposes a deliberately small remote interaction transport for a separately authenticated
hosted viewer: PNG screenshot, bounded coordinate click, bounded text entry, allowlisted special
keys, and bounded scroll. The viewer or reverse proxy belongs outside Surface. Surface does not
attempt to transfer Safari cookies or expose browser cookies, candidate paths, typed text, request
bodies, or service tokens in public JSON.

`begin` creates a fresh candidate Chrome profile under the account's auth directory. It never
copies the active profile. `finalize` runs the existing Outlook mailbox UI probe on that candidate
profile. If explicit expected email aliases were supplied at daemon startup or `begin`, it also
compares a visible Outlook account-control value against those aliases. Only an authenticated probe
and identity match close the candidate browser and promote its profile. The address never appears in
public daemon JSON; when no aliases were supplied, success proves only UI readiness. Chrome must
close successfully before promotion. The old profile is temporarily renamed to a private backup
during promotion and is restored on a local failure; a private marker lets a later daemon startup
recover an interrupted rename.

Candidate sessions have a fixed maximum lifetime. Cancel, timeout, daemon shutdown, browser-start
failure, and an unsuccessful probe leave the active profile untouched and remove the candidate.
Repeated `begin` requests share the one in-progress session; repeated successful `finalize` requests
return the same terminal status without a second promotion.

One owner-only per-account daemon lock prevents concurrent Chrome processes from opening the same
profile. At startup, after acquiring that lock and recovering a promotion marker, the daemon removes
only direct candidate directories whose private state record is valid and expired and which no live
process command references. A failed browser close retains the candidate for later safe cleanup;
it never permits promotion.

The daemon accepts a shared token from a 0600 `--auth-token-file` or
`SURFACE_AUTH_SERVICE_TOKEN`. The token is never generated or printed by Surface. It is intended
for a local/private Dross backend to inject into requests, not a browser URL.

No Microsoft Graph, IMAP, Exchange OAuth registration, or conditional-access workaround is added.
Microsoft sign-in, MFA, device checks, and conditional access continue to run normally in Chrome.

## Consequences

- Hosted Outlook auth can be completed and verified where Surface queries run.
- A browser viewer can work through an explicit, auditable interaction API in headless Chrome or a
  headed virtual display. Surface does not add a proxy, noVNC deployment, or a new mail-sync system.
- `surface auth login` retains its existing interactive and remote-host behavior.
- Deployment must keep the daemon reachable only through loopback/private routing and protect the
  shared token. A headed deployment needs a working display such as Xvfb; `--headless` supports the
  screenshot/control transport without a visible desktop.
- The active profile is persistent account auth state. Candidate profile state is disposable and is
  never used by normal query commands until promotion succeeds.
