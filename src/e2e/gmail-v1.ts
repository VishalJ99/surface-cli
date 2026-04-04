import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createRuntimeContext } from "../runtime.js";
import type {
  AttachmentDownloadEnvelope,
  AttachmentListEnvelope,
  ReadResultEnvelope,
  SearchResultEnvelope,
  SendResultEnvelope,
  ThreadResult,
} from "../contracts/mail.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function uniqueSubject(prefix: string): string {
  return `[surface-e2e] ${prefix} ${Date.now()}`;
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeAssertionText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveTestRecipients(): string[] {
  const fromEnv = process.env.SURFACE_TEST_RECIPIENTS?.trim();
  if (fromEnv) {
    return parseCsv(fromEnv);
  }

  const runtime = createRuntimeContext(
    process.env.SURFACE_CONFIG_PATH ? { configPath: process.env.SURFACE_CONFIG_PATH } : {},
  );
  try {
    return runtime.config.testRecipients;
  } finally {
    runtime.db.close();
  }
}

async function runSurfaceJson<T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      let parsed: unknown = null;
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : null;
      } catch (error) {
        rejectPromise(
          new Error(
            `surface ${args.join(" ")} returned non-JSON stdout.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\n${String(error)}`,
          ),
        );
        return;
      }

      if (code !== 0) {
        rejectPromise(
          new Error(
            `surface ${args.join(" ")} failed with exit code ${code}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          ),
        );
        return;
      }

      resolvePromise(parsed as T);
    });
  });
}

async function pollThreadBySubject(
  env: NodeJS.ProcessEnv,
  account: string,
  subject: string,
  predicate: (thread: ThreadResult) => boolean,
): Promise<ThreadResult> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const search = await runSurfaceJson<SearchResultEnvelope>(
      ["mail", "search", "--account", account, "--text", subject, "--limit", "10"],
      env,
    );
    const thread = search.threads.find((candidate) => candidate.envelope.subject.includes(subject));
    if (thread && predicate(thread)) {
      return thread;
    }
    await sleep(2_500);
  }

  fail(`Timed out waiting for a Gmail thread matching subject '${subject}'.`);
}

async function findAttachmentMessage(env: NodeJS.ProcessEnv, account: string): Promise<{
  message_ref: string;
  attachment_id: string;
}> {
  const search = await runSurfaceJson<SearchResultEnvelope>(
    ["mail", "search", "--account", account, "--text", "has:attachment newer_than:3650d", "--limit", "10"],
    env,
  );

  for (const thread of search.threads) {
    for (const message of thread.messages) {
      const attachment = message.attachments[0];
      if (attachment) {
        return {
          message_ref: message.message_ref,
          attachment_id: attachment.attachment_id,
        };
      }
    }
  }

  fail("Could not find a Gmail message with an attachment for live download verification.");
}

async function findInboxMessage(env: NodeJS.ProcessEnv, account: string): Promise<{
  thread_ref: string;
  message_ref: string;
}> {
  const search = await runSurfaceJson<SearchResultEnvelope>(
    ["mail", "search", "--account", account, "--text", "in:inbox newer_than:3650d", "--limit", "10"],
    env,
  );

  for (const thread of search.threads) {
    const message = thread.messages[0];
    if (message) {
      return {
        thread_ref: thread.thread_ref,
        message_ref: message.message_ref,
      };
    }
  }

  fail("Could not find a Gmail inbox message for archive/read-state verification.");
}

async function main(): Promise<void> {
  assert(
    process.env.SURFACE_E2E_ENABLE === "1",
    "Refusing to run live Gmail e2e without SURFACE_E2E_ENABLE=1.",
  );

  const account = process.env.SURFACE_E2E_ACCOUNT?.trim() || "personal_2";
  const recipients = resolveTestRecipients();
  assert(recipients.length >= 1, "Need at least one address in SURFACE_TEST_RECIPIENTS for Gmail e2e.");
  const primaryRecipient = recipients[0]!;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SURFACE_WRITES_ENABLED: "1",
    SURFACE_SEND_MODE: "allow_send",
    SURFACE_SUMMARIZER_BACKEND: "none",
  };

  const baseSubject = uniqueSubject("gmail-v1");
  const sendBody = `surface gmail e2e send body ${Date.now()}`;
  const replyBody = `surface gmail e2e reply body ${Date.now()}`;
  const replyAllBody = `surface gmail e2e reply-all body ${Date.now()}`;
  const forwardBody = `surface gmail e2e forward body ${Date.now()}`;
  const draftSubject = uniqueSubject("gmail-v1-draft");

  console.log(`Running live Gmail v1 e2e on account '${account}' with subject '${baseSubject}'.`);

  const sendResult = await runSurfaceJson<SendResultEnvelope>(
    [
      "mail",
      "send",
      "--account",
      account,
      "--to",
      primaryRecipient,
      "--subject",
      baseSubject,
      "--body",
      sendBody,
    ],
    childEnv,
  );
  assert(sendResult.status === "sent", "send did not report status=sent");
  assert(sendResult.thread_ref, "send did not resolve a thread_ref");
  assert(sendResult.message_ref, "send did not resolve a message_ref");
  console.log(`send: ${sendResult.message_ref} in ${sendResult.thread_ref}`);

  const sentThread = await pollThreadBySubject(
    childEnv,
    account,
    baseSubject,
    (thread) => thread.messages.length >= 1,
  );
  const baseMessageCount = sentThread.messages.length;
  console.log(`search: found thread ${sentThread.thread_ref} with ${baseMessageCount} message(s)`);

  const readResult = await runSurfaceJson<ReadResultEnvelope>(
    ["mail", "read", sendResult.message_ref],
    childEnv,
  );
  assert(readResult.message.envelope.subject === baseSubject, "read returned the wrong subject after send");
  assert(
    normalizeAssertionText(readResult.message.body.text).includes(normalizeAssertionText(sendBody)),
    "read did not expose the sent body text in the cached Gmail message",
  );
  console.log("read: verified sent body and subject");

  const replyResult = await runSurfaceJson<SendResultEnvelope>(
    ["mail", "reply", sendResult.message_ref, "--body", replyBody],
    childEnv,
  );
  assert(replyResult.status === "sent", "reply did not report status=sent");
  assert(replyResult.thread_ref === sendResult.thread_ref, "reply resolved a different thread_ref");
  const repliedThread = await pollThreadBySubject(
    childEnv,
    account,
    baseSubject,
    (thread) => thread.messages.length > baseMessageCount,
  );
  console.log(`reply: thread now has ${repliedThread.messages.length} message(s)`);

  const replyAllResult = await runSurfaceJson<SendResultEnvelope>(
    ["mail", "reply-all", sendResult.message_ref, "--body", replyAllBody],
    childEnv,
  );
  assert(replyAllResult.status === "sent", "reply-all did not report status=sent");
  assert(replyAllResult.thread_ref === sendResult.thread_ref, "reply-all resolved a different thread_ref");
  const replyAllThread = await pollThreadBySubject(
    childEnv,
    account,
    baseSubject,
    (thread) => thread.messages.length > repliedThread.messages.length,
  );
  console.log(`reply-all: thread now has ${replyAllThread.messages.length} message(s)`);

  const forwardResult = await runSurfaceJson<SendResultEnvelope>(
    [
      "mail",
      "forward",
      sendResult.message_ref,
      "--to",
      primaryRecipient,
      "--body",
      forwardBody,
    ],
    childEnv,
  );
  assert(forwardResult.status === "sent", "forward did not report status=sent");
  assert(forwardResult.subject.startsWith("Fwd:"), "forward subject did not start with 'Fwd:'");
  await pollThreadBySubject(
    childEnv,
    account,
    forwardResult.subject,
    (thread) => thread.messages.length >= 1,
  );
  console.log(`forward: verified search visibility for '${forwardResult.subject}'`);

  const sendDraftResult = await runSurfaceJson<SendResultEnvelope>(
    [
      "mail",
      "send",
      "--account",
      account,
      "--to",
      primaryRecipient,
      "--subject",
      draftSubject,
      "--body",
      `surface gmail e2e draft body ${Date.now()}`,
      "--draft",
    ],
    {
      ...childEnv,
      SURFACE_SEND_MODE: "draft_only",
    },
  );
  assert(sendDraftResult.status === "drafted", "send --draft did not report status=drafted");
  assert(sendDraftResult.message_ref, "send --draft did not resolve a message_ref");
  console.log(`send --draft: ${sendDraftResult.message_ref}`);

  const replyDraftResult = await runSurfaceJson<SendResultEnvelope>(
    ["mail", "reply", sendResult.message_ref, "--body", `surface gmail e2e reply draft ${Date.now()}`, "--draft"],
    {
      ...childEnv,
      SURFACE_SEND_MODE: "draft_only",
    },
  );
  assert(replyDraftResult.status === "drafted", "reply --draft did not report status=drafted");
  console.log(`reply --draft: ${replyDraftResult.message_ref}`);

  const attachmentTarget = await findAttachmentMessage(childEnv, account);
  const attachmentList = await runSurfaceJson<AttachmentListEnvelope>(
    ["attachment", "list", attachmentTarget.message_ref],
    childEnv,
  );
  assert(attachmentList.attachments.length > 0, "attachment list returned no attachments for the chosen Gmail message");
  const attachmentDownload = await runSurfaceJson<AttachmentDownloadEnvelope>(
    ["attachment", "download", attachmentTarget.message_ref, attachmentTarget.attachment_id],
    childEnv,
  );
  assert(existsSync(attachmentDownload.attachment.saved_to), "attachment download did not create the expected file");
  console.log(`attachment download: ${attachmentDownload.attachment.saved_to}`);

  const inboxTarget = await findInboxMessage(childEnv, account);
  const markReadResult = await runSurfaceJson<{ updated: Array<{ unread: boolean }> }>(
    ["mail", "mark-read", inboxTarget.message_ref],
    childEnv,
  );
  assert(markReadResult.updated[0]?.unread === false, "mark-read did not return unread=false");
  const readAfterMarkRead = await runSurfaceJson<ReadResultEnvelope>(
    ["mail", "read", inboxTarget.message_ref, "--refresh"],
    childEnv,
  );
  assert(readAfterMarkRead.message.envelope.unread === false, "mark-read was not reflected by a refreshed read");

  const markUnreadResult = await runSurfaceJson<{ updated: Array<{ unread: boolean }> }>(
    ["mail", "mark-unread", inboxTarget.message_ref],
    childEnv,
  );
  assert(markUnreadResult.updated[0]?.unread === true, "mark-unread did not return unread=true");
  const readAfterMarkUnread = await runSurfaceJson<ReadResultEnvelope>(
    ["mail", "read", inboxTarget.message_ref, "--refresh"],
    childEnv,
  );
  assert(readAfterMarkUnread.message.envelope.unread === true, "mark-unread was not reflected by a refreshed read");

  const readMarked = await runSurfaceJson<ReadResultEnvelope>(
    ["mail", "read", inboxTarget.message_ref, "--mark-read"],
    childEnv,
  );
  assert(readMarked.message.envelope.unread === false, "read --mark-read did not return unread=false");
  console.log("mark-read/mark-unread/read --mark-read: verified read-state mutation");

  const archiveResult = await runSurfaceJson<{ status: string; thread_ref: string }>(
    ["mail", "archive", inboxTarget.message_ref],
    childEnv,
  );
  assert(archiveResult.status === "archived", "archive did not report status=archived");

  const runtime = createRuntimeContext(
    process.env.SURFACE_CONFIG_PATH ? { configPath: process.env.SURFACE_CONFIG_PATH } : {},
  );
  try {
    const archived = runtime.db.connection
      .prepare("SELECT mailbox FROM threads WHERE thread_ref = ? LIMIT 1")
      .get(archiveResult.thread_ref) as { mailbox: string } | undefined;
    assert(archived?.mailbox === "archive", "archive did not persist mailbox=archive in local state");
  } finally {
    runtime.db.close();
  }
  console.log("archive: verified local thread mailbox state");

  console.log("Gmail v1 e2e completed successfully.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
