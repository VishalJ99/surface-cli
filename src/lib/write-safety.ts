import type { MailAccount } from "../contracts/account.js";
import type { SendMode, SendMessageInput, ReplyInput, ForwardInput } from "../contracts/mail.js";
import type { SurfaceConfig } from "../config.js";
import { SurfaceError } from "./errors.js";

export interface ResolvedWriteRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export function collectWriteRecipients(
  input: SendMessageInput | ReplyInput | ForwardInput,
): ResolvedWriteRecipients {
  return {
    to: "to" in input ? input.to : [],
    cc: input.cc,
    bcc: input.bcc,
  };
}

export function assertWriteAllowed(
  config: SurfaceConfig,
  account: MailAccount,
  recipients: ResolvedWriteRecipients,
  options: { disposition?: "send" | "draft" | "non_send" } = {},
): { sendMode: SendMode } {
  if (!config.writesEnabled) {
    throw new SurfaceError(
      "writes_disabled",
      "Write actions are disabled. Set SURFACE_WRITES_ENABLED=1 to enable them locally.",
      { account: account.name },
    );
  }

  if (config.testAccountAllowlist.length > 0 && !config.testAccountAllowlist.includes(account.name)) {
    throw new SurfaceError(
      "writes_disabled",
      `Account '${account.name}' is not on the configured write allowlist.`,
      { account: account.name },
    );
  }

  const disposition = options.disposition ?? "send";
  if (disposition === "non_send") {
    return {
      sendMode: config.sendMode,
    };
  }

  if (disposition === "send" && config.sendMode !== "allow_send") {
    throw new SurfaceError(
      "writes_disabled",
      "Live send is disabled unless SURFACE_SEND_MODE=allow_send. Rerun with --draft or enable live send locally.",
      { account: account.name },
    );
  }

  const requestedRecipients = [...recipients.to, ...recipients.cc, ...recipients.bcc];
  const disallowed = requestedRecipients.filter((recipient) => !config.testRecipients.includes(recipient));
  if (disallowed.length > 0) {
    throw new SurfaceError(
      "writes_disabled",
      `Recipients are not on the configured test allowlist: ${disallowed.join(", ")}`,
      { account: account.name },
    );
  }

  return {
    sendMode: config.sendMode,
  };
}
