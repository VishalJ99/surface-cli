# ADR 0005: Keep `auth`, `cache`, And `downloads` As Top-Level Storage Roots

## Status

Accepted

## Context

Surface CLI stores three different classes of local data:

- auth state and browser profiles
- disposable cached message bodies and metadata
- explicit user-kept downloads such as attachments

These have different retention, safety, and cleanup behavior.

## Decision

Use top-level storage roots under `~/.surface-cli/`:

- `auth/<account_id>/`
- `cache/<account_id>/`
- `downloads/<account_id>/`

Do not put `accounts/<account_id>/auth|cache|downloads` under a single mixed subtree.

## Consequences

- cache maintenance commands can safely target only cache data
- auth cleanup and logout remain separate from cache lifecycle
- downloads remain explicit artifacts instead of being treated as disposable cache
- account identity still remains the next-level boundary inside each storage root
