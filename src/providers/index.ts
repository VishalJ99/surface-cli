import type { MailAccount } from "../contracts/account.js";
import { SurfaceError } from "../lib/errors.js";
import { GmailApiAdapter } from "./gmail/adapter.js";
import { OutlookWebPlaywrightAdapter } from "./outlook/adapter.js";
import type { MailProviderAdapter } from "./types.js";

const providers: MailProviderAdapter[] = [new GmailApiAdapter(), new OutlookWebPlaywrightAdapter()];

export function resolveProviderAdapter(account: MailAccount): MailProviderAdapter {
  const adapter = providers.find(
    (candidate) => candidate.provider === account.provider && candidate.transport === account.transport,
  );

  if (!adapter) {
    throw new SurfaceError(
      "unsupported_transport",
      `No provider adapter is registered for ${account.provider}/${account.transport}.`,
      { account: account.name },
    );
  }

  return adapter;
}
