# ADR 0009: Clone The Outlook Browser Profile For Headless Reads

## Status

Accepted

## Context

The persistent Outlook Chrome profile may already be open in a visible browser session.
Chromium refuses to reuse the same profile directory concurrently, which blocks headless
automation and can risk profile corruption.

## Decision

When Surface launches Outlook headlessly for auth probes, fetches, searches, or refresh
reads, it should clone the stored persistent profile to a temporary user-data-dir and
launch Playwright against the clone.

Interactive login continues to use the canonical persistent profile directly.

## Consequences

- Surface can read mail while the visible Chrome profile is already open
- the canonical auth profile remains the single durable source of Outlook session state
- headless runs pay a small local copy cost in exchange for safe concurrent access
- headless writes to browser state are discarded after the run, which is acceptable for read-path operations
