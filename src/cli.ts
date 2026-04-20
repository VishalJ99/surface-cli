#!/usr/bin/env node

import { Command, Option } from "commander";
import { statSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { accountInputSchema } from "./contracts/account.js";
import { SurfaceError, errorToEnvelope } from "./lib/errors.js";
import { writeJson } from "./lib/json.js";
import { toPublicThread } from "./lib/public-mail.js";
import { runRemoteAuthLogin } from "./lib/remote-auth.js";
import { loadStoredThread, threadHasReadableCache } from "./lib/stored-mail.js";
import { nowIsoUtc } from "./lib/time.js";
import { resolveProviderAdapter } from "./providers/index.js";
import { createAccountRuntimeContext, createRuntimeContext } from "./runtime.js";

interface GlobalOptions {
  config?: string;
}

function positiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Expected a positive integer.");
  }
  return parsed;
}

function collectStringOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function directorySizeBytes(rootPath: string): number {
  if (!existsSync(rootPath)) {
    return 0;
  }

  const stats = statSync(rootPath);
  if (stats.isFile()) {
    return stats.size;
  }

  let total = 0;
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    total += directorySizeBytes(join(rootPath, entry.name));
  }
  return total;
}

async function runAction(
  options: GlobalOptions,
  action: (context: ReturnType<typeof createRuntimeContext>) => Promise<void> | void,
): Promise<void> {
  const context = createRuntimeContext(
    options.config ? { configPath: options.config } : {},
  );
  try {
    await action(context);
  } finally {
    context.db.close();
  }
}

async function runAccountAction(
  options: GlobalOptions,
  accountName: string,
  action: (context: ReturnType<typeof createAccountRuntimeContext>) => Promise<void> | void,
): Promise<void> {
  await runAction(options, async (context) => {
    const account = context.db.findAccountByName(accountName);
    if (!account) {
      throw new SurfaceError("not_found", `Account '${accountName}' was not found.`, {
        account: accountName,
      });
    }
    await action(createAccountRuntimeContext(context, account));
  });
}

async function runMessageAction(
  options: GlobalOptions,
  messageRef: string,
  action: (
    context: ReturnType<typeof createAccountRuntimeContext>,
    resolved: { message_ref: string; thread_ref: string; account_id: string },
  ) => Promise<void> | void,
): Promise<void> {
  await runAction(options, async (context) => {
    const resolved = context.db.findMessageByRef(messageRef);
    if (!resolved) {
      throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
        messageRef,
      });
    }

    const account = context.db.findAccountById(resolved.account_id);
    if (!account) {
      throw new SurfaceError("not_found", `Account for message '${messageRef}' was not found.`, {
        messageRef,
      });
    }

    await action(createAccountRuntimeContext(context, account), resolved);
  });
}

async function runMessageBatchAction(
  options: GlobalOptions,
  messageRefs: string[],
  action: (
    context: ReturnType<typeof createAccountRuntimeContext>,
    resolved: Array<{ message_ref: string; thread_ref: string; account_id: string }>,
  ) => Promise<void> | void,
): Promise<void> {
  await runAction(options, async (context) => {
    if (messageRefs.length === 0) {
      throw new SurfaceError("invalid_argument", "At least one message ref is required.");
    }

    const resolved = messageRefs.map((messageRef) => {
      const record = context.db.findMessageByRef(messageRef);
      if (!record) {
        throw new SurfaceError("not_found", `Message '${messageRef}' was not found.`, {
          messageRef,
        });
      }
      return record;
    });

    const accountId = resolved[0]!.account_id;
    if (resolved.some((record) => record.account_id !== accountId)) {
      throw new SurfaceError(
        "invalid_argument",
        "All message refs in one mark-read or mark-unread command must belong to the same account.",
      );
    }

    const account = context.db.findAccountById(accountId);
    if (!account) {
      throw new SurfaceError("not_found", `Account for the provided message refs was not found.`);
    }

    await action(createAccountRuntimeContext(context, account), resolved);
  });
}

async function runThreadAction(
  options: GlobalOptions,
  threadRef: string,
  action: (
    context: ReturnType<typeof createAccountRuntimeContext>,
    resolved: { thread_ref: string; account_id: string },
  ) => Promise<void> | void,
): Promise<void> {
  await runAction(options, async (context) => {
    const resolved = context.db.findThreadByRef(threadRef);
    if (!resolved) {
      throw new SurfaceError("not_found", `Thread '${threadRef}' was not found.`, {
        threadRef,
      });
    }

    const account = context.db.findAccountById(resolved.account_id);
    if (!account) {
      throw new SurfaceError("not_found", `Account for thread '${threadRef}' was not found.`, {
        threadRef,
      });
    }

    await action(createAccountRuntimeContext(context, account), resolved);
  });
}

const program = new Command();
program
  .name("surface")
  .description("Multi-provider mail CLI for Surface.")
  .showHelpAfterError()
  .addOption(new Option("--config <path>", "Config file path").env("SURFACE_CONFIG_PATH"));

const accountCommand = program.command("account").description("Manage Surface accounts.");

accountCommand
  .command("add")
  .argument("<name>", "Logical account name, for example work or personal")
  .requiredOption("--provider <provider>", "Provider family, for example gmail or outlook")
  .requiredOption("--transport <transport>", "Transport name, for example gmail-api")
  .requiredOption("--email <email>", "Primary mailbox email address")
  .action(async (name: string, options, command: Command) => {
    await runAction(command.optsWithGlobals<GlobalOptions>(), (context) => {
      const parsed = accountInputSchema.parse({
        name,
        provider: options.provider,
        transport: options.transport,
        email: options.email,
      });
      const account = context.db.upsertAccount(parsed);
      writeJson({
        schema_version: "1",
        command: "account-add",
        account,
      });
    });
  });

accountCommand.command("list").action(async (_options, command: Command) => {
  await runAction(command.optsWithGlobals<GlobalOptions>(), (context) => {
    writeJson({
      schema_version: "1",
      command: "account-list",
      accounts: context.db.listAccounts(),
    });
  });
});

accountCommand
  .command("remove")
  .argument("<name>", "Logical account name")
  .action(async (name: string, _options, command: Command) => {
    await runAction(command.optsWithGlobals<GlobalOptions>(), (context) => {
      const removed = context.db.removeAccountByName(name);
      if (!removed) {
        throw new SurfaceError("not_found", `Account '${name}' was not found.`, {
          account: name,
        });
      }

      writeJson({
        schema_version: "1",
        command: "account-remove",
        removed_account: removed.name,
      });
    });
  });

const authCommand = program.command("auth").description("Manage provider authentication state.");

authCommand
  .command("login")
  .argument("<account>", "Logical account name")
  .option("--remote-host <host>", "Run auth login against an existing Surface account on a remote host")
  .action(async (accountName: string, options, command: Command) => {
    if (options.remoteHost) {
      await runAction(command.optsWithGlobals<GlobalOptions>(), async (context) => {
        writeJson(await runRemoteAuthLogin(context, accountName, options.remoteHost));
      });
      return;
    }

    await runAccountAction(command.optsWithGlobals<GlobalOptions>(), accountName, async (context) => {
      const adapter = resolveProviderAdapter(context.account);
      const status = await adapter.login(context.account, context);
      writeJson({
        schema_version: "1",
        command: "auth-login",
        account: context.account.name,
        provider: context.account.provider,
        transport: context.account.transport,
        status,
      });
    });
  });

authCommand
  .command("status")
  .argument("[account]", "Logical account name")
  .action(async (accountName: string | undefined, _options, command: Command) => {
    const globalOptions = command.optsWithGlobals<GlobalOptions>();
    if (accountName) {
      await runAccountAction(globalOptions, accountName, async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        const status = await adapter.authStatus(context.account, context);
        writeJson({
          schema_version: "1",
          command: "auth-status",
          account: context.account.name,
          provider: context.account.provider,
          transport: context.account.transport,
          status,
        });
      });
      return;
    }

    await runAction(globalOptions, async (context) => {
      const statuses = [];
      for (const account of context.db.listAccounts()) {
        const adapter = resolveProviderAdapter(account);
        const accountContext = createAccountRuntimeContext(context, account);
        const status = await adapter.authStatus(account, accountContext);
        statuses.push({
          account: account.name,
          provider: account.provider,
          transport: account.transport,
          status,
        });
      }

      writeJson({
        schema_version: "1",
        command: "auth-status",
        accounts: statuses,
      });
    });
  });

authCommand
  .command("logout")
  .argument("<account>", "Logical account name")
  .action(async (accountName: string, _options, command: Command) => {
    await runAccountAction(command.optsWithGlobals<GlobalOptions>(), accountName, async (context) => {
      const adapter = resolveProviderAdapter(context.account);
      const status = await adapter.logout(context.account, context);
      writeJson({
        schema_version: "1",
        command: "auth-logout",
        account: context.account.name,
        status,
      });
    });
  });

const mailCommand = program.command("mail").description("Search, fetch, and read mail.");

mailCommand
  .command("search")
  .requiredOption("--account <account>", "Logical account name")
  .option("--text <query>", "Free-text search query")
  .option("--from <sender>", "Sender filter")
  .option("--subject <subject>", "Subject filter")
  .option("--mailbox <mailbox>", "Mailbox filter")
  .option("--label <label>", "Label filter", collectStringOption, [])
  .addOption(new Option("--limit <limit>", "Max results to return").argParser(positiveInt))
  .action(async (options, command: Command) => {
    await runAccountAction(
      command.optsWithGlobals<GlobalOptions>(),
      options.account,
      async (context) => {
        const labels = (options.label as string[] | undefined)?.map((label) => label.trim()).filter(Boolean) ?? [];
        const text = normalizeOptionalString(options.text);
        const from = normalizeOptionalString(options.from);
        const subject = normalizeOptionalString(options.subject);
        const mailbox = normalizeOptionalString(options.mailbox);
        const query = {
          ...(text ? { text } : {}),
          ...(from ? { from } : {}),
          ...(subject ? { subject } : {}),
          ...(mailbox ? { mailbox } : {}),
          ...(labels.length > 0 ? { labels } : {}),
          limit: options.limit ?? context.config.defaultResultLimit,
          unread_only: false as const,
        };
        if (!query.text && !query.from && !query.subject && !query.mailbox && !query.labels) {
          throw new SurfaceError(
            "invalid_argument",
            "Search requires at least one of --text, --from, --subject, --mailbox, or --label.",
            { account: context.account.name },
          );
        }

        const adapter = resolveProviderAdapter(context.account);
        const threads = await adapter.search(context.account, query, context);

        writeJson({
          schema_version: "1",
          command: "search",
          generated_at: nowIsoUtc(),
          account: context.account.name,
          query,
          threads: threads.map(toPublicThread),
        });
      },
    );
  });

mailCommand
  .command("fetch-unread")
  .requiredOption("--account <account>", "Logical account name")
  .addOption(new Option("--limit <limit>", "Max threads to return").argParser(positiveInt))
  .action(async (options, command: Command) => {
    await runAccountAction(
      command.optsWithGlobals<GlobalOptions>(),
      options.account,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        const threads = await adapter.fetchUnread(
          context.account,
          {
            limit: options.limit ?? context.config.defaultResultLimit,
            unread_only: true,
          },
          context,
        );

        writeJson({
          schema_version: "1",
          command: "fetch-unread",
          generated_at: nowIsoUtc(),
          account: context.account.name,
          query: {
            limit: options.limit ?? context.config.defaultResultLimit,
            unread_only: true,
          },
          threads: threads.map(toPublicThread),
        });
      },
    );
  });

mailCommand
  .command("thread")
  .description("Inspect thread state.")
  .command("get")
  .argument("<thread_ref>", "Stable thread ref")
  .option("--refresh", "Bypass local cache and fetch live", false)
  .action(async (threadRef: string, options, command: Command) => {
    await runThreadAction(
      command.optsWithGlobals<GlobalOptions>(),
      threadRef,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        let cacheStatus: "hit" | "refreshed" = "hit";
        if (Boolean(options.refresh) || !threadHasReadableCache(context.db, threadRef)) {
          await adapter.refreshThread(context.account, threadRef, context);
          cacheStatus = "refreshed";
        }

        const thread = loadStoredThread(context.db, context.account, threadRef);
        if (!thread) {
          throw new SurfaceError("not_found", `Thread '${threadRef}' was not found.`, {
            account: context.account.name,
            threadRef,
          });
        }

        writeJson({
          schema_version: "1",
          command: "thread-get",
          account: context.account.name,
          thread_ref: threadRef,
          cache: {
            status: cacheStatus,
          },
          thread,
        });
      },
    );
  });

mailCommand
  .command("read")
  .argument("<message_ref>", "Stable message ref")
  .option("--refresh", "Bypass local cache and fetch live", false)
  .option("--mark-read", "Mark the message as read after resolving the ref", false)
  .action(async (messageRef: string, options, command: Command) => {
    await runMessageAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRef,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        if (Boolean(options.markRead)) {
          await adapter.markRead(context.account, [messageRef], context);
        }
        writeJson(await adapter.readMessage(context.account, messageRef, Boolean(options.refresh), context));
      },
    );
  });

mailCommand
  .command("rsvp")
  .argument("<message_ref>", "Stable message ref")
  .requiredOption("--response <response>", "One of: accept, decline, tentative")
  .action(async (messageRef: string, options, command: Command) => {
    const response = String(options.response).toLowerCase();
    if (!["accept", "decline", "tentative"].includes(response)) {
      throw new SurfaceError(
        "invalid_argument",
        "RSVP response must be one of: accept, decline, tentative.",
        { messageRef },
      );
    }

    await runMessageAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRef,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(await adapter.rsvp(context.account, messageRef, response as "accept" | "decline" | "tentative", context));
      },
    );
  });

mailCommand
  .command("send")
  .requiredOption("--account <account>", "Logical account name")
  .requiredOption("--to <email>", "Recipient email address", collectStringOption, [])
  .option("--cc <email>", "Cc recipient email address", collectStringOption, [])
  .option("--bcc <email>", "Bcc recipient email address", collectStringOption, [])
  .requiredOption("--subject <subject>", "Message subject")
  .requiredOption("--body <body>", "Message body text")
  .option("--draft", "Save to drafts instead of sending", false)
  .action(async (options, command: Command) => {
    await runAccountAction(
      command.optsWithGlobals<GlobalOptions>(),
      options.account,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(
          await adapter.sendMessage(
            context.account,
            {
              to: options.to,
              cc: options.cc ?? [],
              bcc: options.bcc ?? [],
              subject: options.subject,
              body: options.body,
              draft: Boolean(options.draft),
            },
            context,
          ),
        );
      },
    );
  });

mailCommand
  .command("reply")
  .argument("<message_ref>", "Stable message ref")
  .requiredOption("--body <body>", "Reply body text")
  .option("--cc <email>", "Cc recipient email address", collectStringOption, [])
  .option("--bcc <email>", "Bcc recipient email address", collectStringOption, [])
  .option("--draft", "Save to drafts instead of sending", false)
  .action(async (messageRef: string, options, command: Command) => {
    await runMessageAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRef,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(
          await adapter.reply(
            context.account,
            messageRef,
            {
              cc: options.cc ?? [],
              bcc: options.bcc ?? [],
              body: options.body,
              draft: Boolean(options.draft),
            },
            context,
          ),
        );
      },
    );
  });

mailCommand
  .command("reply-all")
  .argument("<message_ref>", "Stable message ref")
  .requiredOption("--body <body>", "Reply body text")
  .option("--cc <email>", "Cc recipient email address", collectStringOption, [])
  .option("--bcc <email>", "Bcc recipient email address", collectStringOption, [])
  .option("--draft", "Save to drafts instead of sending", false)
  .action(async (messageRef: string, options, command: Command) => {
    await runMessageAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRef,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(
          await adapter.replyAll(
            context.account,
            messageRef,
            {
              cc: options.cc ?? [],
              bcc: options.bcc ?? [],
              body: options.body,
              draft: Boolean(options.draft),
            },
            context,
          ),
        );
      },
    );
  });

mailCommand
  .command("forward")
  .argument("<message_ref>", "Stable message ref")
  .requiredOption("--to <email>", "Recipient email address", collectStringOption, [])
  .option("--cc <email>", "Cc recipient email address", collectStringOption, [])
  .option("--bcc <email>", "Bcc recipient email address", collectStringOption, [])
  .requiredOption("--body <body>", "Forward body text")
  .option("--draft", "Save to drafts instead of sending", false)
  .action(async (messageRef: string, options, command: Command) => {
    await runMessageAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRef,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(
          await adapter.forward(
            context.account,
            messageRef,
            {
              to: options.to,
              cc: options.cc ?? [],
              bcc: options.bcc ?? [],
              body: options.body,
              draft: Boolean(options.draft),
            },
            context,
          ),
        );
      },
    );
  });

mailCommand
  .command("archive")
  .argument("<message_ref>", "Stable message ref")
  .action(async (messageRef: string, _options, command: Command) => {
    await runMessageAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRef,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(await adapter.archive(context.account, messageRef, context));
      },
    );
  });

mailCommand
  .command("mark-read")
  .argument("<message_refs...>", "One or more stable message refs")
  .action(async (messageRefs: string[], _options, command: Command) => {
    await runMessageBatchAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRefs,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(await adapter.markRead(context.account, messageRefs, context));
      },
    );
  });

mailCommand
  .command("mark-unread")
  .argument("<message_refs...>", "One or more stable message refs")
  .action(async (messageRefs: string[], _options, command: Command) => {
    await runMessageBatchAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRefs,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(await adapter.markUnread(context.account, messageRefs, context));
      },
    );
  });

const attachmentCommand = program.command("attachment").description("Inspect and download attachments.");

attachmentCommand
  .command("list")
  .argument("<message_ref>", "Stable message ref")
  .action(async (messageRef: string, options, command: Command) => {
    void options;
    await runMessageAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRef,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(await adapter.listAttachments(context.account, messageRef, context));
      },
    );
  });

attachmentCommand
  .command("download")
  .argument("<message_ref>", "Stable message ref")
  .argument("<attachment_id>", "Stable attachment id")
  .action(async (messageRef: string, attachmentId: string, options, command: Command) => {
    void options;
    await runMessageAction(
      command.optsWithGlobals<GlobalOptions>(),
      messageRef,
      async (context) => {
        const adapter = resolveProviderAdapter(context.account);
        writeJson(await adapter.downloadAttachment(context.account, messageRef, attachmentId, context));
      },
    );
  });

const cacheCommand = program.command("cache").description("Inspect and manage cache state.");

cacheCommand.command("stats").action(async (_options, command: Command) => {
  await runAction(command.optsWithGlobals<GlobalOptions>(), (context) => {
    writeJson({
      schema_version: "1",
      command: "cache-stats",
      cache_root: context.paths.rootDir,
      sizes: {
        state_db_bytes: existsSync(context.paths.stateDbPath) ? statSync(context.paths.stateDbPath).size : 0,
        auth_bytes: directorySizeBytes(context.paths.authDir),
        cache_bytes: directorySizeBytes(context.paths.cacheDir),
        downloads_bytes: directorySizeBytes(context.paths.downloadsDir),
      },
    });
  });
});

cacheCommand.command("prune").action(async (_options, command: Command) => {
  await runAction(command.optsWithGlobals<GlobalOptions>(), (context) => {
    writeJson({
      schema_version: "1",
      command: "cache-prune",
      status: "noop",
      cache_root: context.paths.cacheDir,
    });
  });
});

cacheCommand
  .command("clear")
  .option("--account <account>", "Clear cached bodies for one account")
  .option("--message <message_ref>", "Clear cached bodies for one message ref")
  .option("--all", "Clear all cached bodies", false)
  .action(async (options, command: Command) => {
    await runAction(command.optsWithGlobals<GlobalOptions>(), (context) => {
      if (options.all) {
        rmSync(context.paths.cacheDir, { recursive: true, force: true });
        writeJson({
          schema_version: "1",
          command: "cache-clear",
          cleared: "all",
        });
        return;
      }

      if (options.account) {
        const account = context.db.findAccountByName(options.account);
        if (!account) {
          throw new SurfaceError("not_found", `Account '${options.account}' was not found.`, {
            account: options.account,
          });
        }
        const accountCacheDir = join(context.paths.cacheDir, account.account_id);
        rmSync(accountCacheDir, { recursive: true, force: true });
        writeJson({
          schema_version: "1",
          command: "cache-clear",
          cleared: "account",
          account: options.account,
        });
        return;
      }

      if (options.message) {
        for (const account of context.db.listAccounts()) {
          const messageCacheDir = join(context.paths.cacheDir, account.account_id, "messages", options.message);
          rmSync(messageCacheDir, { recursive: true, force: true });
        }
        writeJson({
          schema_version: "1",
          command: "cache-clear",
          cleared: "message",
          message_ref: options.message,
        });
        return;
      }

      throw new SurfaceError(
        "invalid_argument",
        "Specify one of --account, --message, or --all for cache clear.",
      );
    });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  writeJson(errorToEnvelope(error));
  process.exitCode = 1;
});
