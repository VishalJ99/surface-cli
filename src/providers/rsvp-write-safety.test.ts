import assert from "node:assert/strict";
import test from "node:test";

import type { MailAccount } from "../contracts/account.js";
import { GmailApiAdapter } from "./gmail/adapter.js";
import { OutlookWebPlaywrightAdapter } from "./outlook/adapter.js";
import type { ProviderContext } from "./types.js";

function disabledContext(): ProviderContext & { db_was_accessed: () => boolean } {
  let dbWasAccessed = false;
  return {
    config: {
      cacheDir: "/tmp/surface-rsvp-test",
      defaultResultLimit: 50,
      providerTimeoutMs: 1_000,
      authCheckIntervalSeconds: 86_400,
      summarizerBackend: "none",
      summarizerModel: "test",
      summaryInputMaxBytes: 1_024,
      summarizerTimeoutMs: 1_000,
      writesEnabled: false,
      sendMode: "draft_only",
      testRecipients: [],
      testAccountAllowlist: [],
    },
    paths: {} as ProviderContext["paths"],
    accountPaths: {} as ProviderContext["accountPaths"],
    db: new Proxy({}, {
      get() {
        dbWasAccessed = true;
        throw new Error("Provider state must not be accessed before RSVP write policy.");
      },
    }) as ProviderContext["db"],
    db_was_accessed: () => dbWasAccessed,
  };
}

function account(provider: "gmail" | "outlook"): MailAccount {
  return {
    account_id: `acc_${provider}`,
    name: provider,
    provider,
    transport: provider === "gmail" ? "gmail-api" : "outlook-web-playwright",
    email: `${provider}@example.test`,
    created_at: "2026-09-17T10:00:00Z",
    updated_at: "2026-09-17T10:00:00Z",
  };
}

for (const [label, adapter, provider] of [
  ["Gmail", new GmailApiAdapter(), "gmail"],
  ["Outlook", new OutlookWebPlaywrightAdapter(), "outlook"],
] as const) {
  test(`${label} RSVP rejects disabled writes before any provider mutation path`, async () => {
    const context = disabledContext();
    await assert.rejects(
      () => adapter.rsvp(account(provider), "msg_test", "accept", context),
      (error: unknown) => error instanceof Error && /Write actions are disabled/.test(error.message),
    );
    assert.equal(context.db_was_accessed(), false);
  });
}
