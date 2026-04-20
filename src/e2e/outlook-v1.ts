import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createRuntimeContext } from "../runtime.js";
import type {
  ReadResultEnvelope,
  SearchResultEnvelope,
  SendResultEnvelope,
  ThreadGetResultEnvelope,
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

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`Missing required environment variable ${name}.`);
  }
  return value;
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

  fail(`Timed out waiting for a search result thread matching subject '${subject}'.`);
}

async function main(): Promise<void> {
  assert(
    process.env.SURFACE_E2E_ENABLE === "1",
    "Refusing to run live Outlook e2e without SURFACE_E2E_ENABLE=1.",
  );

  const account = process.env.SURFACE_E2E_ACCOUNT?.trim() || "uni";
  const recipients = parseCsv(requireEnv("SURFACE_TEST_RECIPIENTS"));
  assert(recipients.length >= 2, "Need at least two addresses in SURFACE_TEST_RECIPIENTS for reply-all coverage.");

  const [primaryRecipient, ccRecipient, bccRecipient] = recipients;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SURFACE_WRITES_ENABLED: "1",
    SURFACE_SEND_MODE: "allow_send",
  };

  const baseSubject = uniqueSubject("outlook-v1");
  const sendBody = `surface e2e send body ${Date.now()}`;
  const replyBody = `surface e2e reply body ${Date.now()}`;
  const replyAllBody = `surface e2e reply-all body ${Date.now()}`;
  const forwardBody = `surface e2e forward body ${Date.now()}`;

  console.log(`Running live Outlook v1 e2e on account '${account}' with subject '${baseSubject}'.`);

  const sendResult = await runSurfaceJson<SendResultEnvelope>(
    [
      "mail",
      "send",
      "--account",
      account,
      "--to",
      primaryRecipient!,
      "--cc",
      ccRecipient!,
      ...(bccRecipient ? ["--bcc", bccRecipient] : []),
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

  const subjectSearch = await runSurfaceJson<SearchResultEnvelope>(
    ["mail", "search", "--account", account, "--subject", baseSubject, "--limit", "10"],
    childEnv,
  );
  assert(
    subjectSearch.threads.some((thread) => thread.thread_ref === sendResult.thread_ref),
    "structured subject search did not return the sent Outlook thread",
  );
  console.log("search --subject: verified structured search path");

  const cachedThread = await runSurfaceJson<ThreadGetResultEnvelope>(
    ["mail", "thread", "get", sendResult.thread_ref],
    childEnv,
  );
  assert(cachedThread.thread.thread_ref === sendResult.thread_ref, "thread get returned the wrong Outlook thread");
  assert(cachedThread.thread.messages.length >= 1, "thread get did not return any Outlook messages");
  console.log("thread get: verified cached thread lookup");

  const readResult = await runSurfaceJson<ReadResultEnvelope>(
    ["mail", "read", sendResult.message_ref],
    childEnv,
  );
  assert(readResult.message.envelope.subject === baseSubject, "read returned the wrong subject after send");
  assert(
    normalizeAssertionText(readResult.message.body.text).includes(normalizeAssertionText(sendBody)),
    "read did not expose the sent body text in the cached message",
  );
  console.log("read: verified sent body and subject");

  const markUnreadResult = await runSurfaceJson<{ updated: Array<{ unread: boolean }> }>(
    ["mail", "mark-unread", sendResult.message_ref],
    childEnv,
  );
  assert(markUnreadResult.updated[0]?.unread === true, "mark-unread did not return unread=true");
  const markReadViaRead = await runSurfaceJson<ReadResultEnvelope>(
    ["mail", "read", sendResult.message_ref, "--mark-read"],
    childEnv,
  );
  assert(markReadViaRead.message.envelope.unread === false, "read --mark-read did not return unread=false");
  console.log("mark-unread/read --mark-read: verified read-state mutation");

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

  const refreshedThread = await runSurfaceJson<ThreadGetResultEnvelope>(
    ["mail", "thread", "get", sendResult.thread_ref, "--refresh"],
    childEnv,
  );
  assert(refreshedThread.cache.status === "refreshed", "thread get --refresh did not report refreshed status");
  assert(
    refreshedThread.thread.messages.length >= repliedThread.messages.length,
    "thread get --refresh did not expose the refreshed Outlook thread state",
  );
  console.log("thread get --refresh: verified live thread refresh");

  const replyAllResult = await runSurfaceJson<SendResultEnvelope>(
    ["mail", "reply-all", sendResult.message_ref, "--body", replyAllBody],
    childEnv,
  );
  assert(replyAllResult.status === "sent", "reply-all did not report status=sent");
  assert(replyAllResult.thread_ref === sendResult.thread_ref, "reply-all resolved a different thread_ref");
  assert(replyAllResult.recipients.cc.length > 0, "reply-all did not preserve any non-primary recipients");
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
      primaryRecipient!,
      "--cc",
      ccRecipient!,
      ...(bccRecipient ? ["--bcc", bccRecipient] : []),
      "--body",
      forwardBody,
    ],
    childEnv,
  );
  assert(forwardResult.status === "sent", "forward did not report status=sent");
  assert(forwardResult.subject.startsWith("Fw:"), "forward subject did not start with 'Fw:'");
  await pollThreadBySubject(
    childEnv,
    account,
    forwardResult.subject,
    (thread) => thread.messages.length >= 1,
  );
  console.log(`forward: verified search visibility for '${forwardResult.subject}'`);

  const archiveResult = await runSurfaceJson<{ status: string; thread_ref: string }>(
    ["mail", "archive", sendResult.message_ref],
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

  console.log("Outlook v1 e2e completed successfully.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
