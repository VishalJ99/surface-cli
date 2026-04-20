import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { ThreadSummary, NormalizedThreadRecord } from "./contracts/mail.js";
import type { SurfaceConfig } from "./config.js";
import type { SurfaceDatabase } from "./state/database.js";

const execFileAsync = promisify(execFile);
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENCLAW_BATCH_MAX_THREADS = 3;
const OPENCLAW_BATCH_MAX_INPUT_BYTES = 64 * 1024;
const OPENCLAW_SUMMARY_THINKING = "low";

interface SummaryShape {
  brief: string;
  needs_action: boolean;
  importance: "low" | "medium" | "high";
}

interface SummaryThreadPayload {
  thread_ref: string;
  source: NormalizedThreadRecord["source"];
  subject: string;
  participants: NormalizedThreadRecord["envelope"]["participants"];
  messages: Array<{
    from: NormalizedThreadRecord["messages"][number]["envelope"]["from"];
    to: NormalizedThreadRecord["messages"][number]["envelope"]["to"];
    cc: NormalizedThreadRecord["messages"][number]["envelope"]["cc"];
    sent_at: string | null;
    received_at: string | null;
    snippet: string;
    body: string;
    invite: NormalizedThreadRecord["messages"][number]["invite"] | null;
    attachments: Array<{
      filename: string;
      mime_type: string;
      size_bytes: number | null;
      inline: boolean;
    }>;
  }>;
}

interface PreparedSummaryThread {
  thread: NormalizedThreadRecord;
  payload: SummaryThreadPayload;
  fingerprint: string;
  inputBytes: number;
}

interface SummaryTarget {
  backend: "openrouter" | "openclaw";
  model: string;
}

function clipUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return input;
  }

  let clipped = input;
  while (clipped && Buffer.byteLength(clipped, "utf8") > maxBytes) {
    clipped = clipped.slice(0, Math.max(0, Math.floor(clipped.length * 0.9)));
  }
  return clipped;
}

function buildThreadPayload(thread: NormalizedThreadRecord, maxBytes: number): SummaryThreadPayload {
  let remainingBytes = maxBytes;
  const messages: SummaryThreadPayload["messages"] = [];

  for (const message of thread.messages) {
    if (remainingBytes <= 0) {
      break;
    }

    const bodyText = clipUtf8(message.body.text, remainingBytes);
    remainingBytes -= Buffer.byteLength(bodyText, "utf8");

    messages.push({
      from: message.envelope.from,
      to: message.envelope.to,
      cc: message.envelope.cc,
      sent_at: message.envelope.sent_at,
      received_at: message.envelope.received_at,
      snippet: message.snippet,
      body: bodyText,
      invite: message.invite ?? null,
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        inline: attachment.inline,
      })),
    });
  }

  return {
    thread_ref: thread.thread_ref,
    source: thread.source,
    subject: thread.envelope.subject,
    participants: thread.envelope.participants,
    messages,
  };
}

function buildSinglePrompt(payload: SummaryThreadPayload): string {
  return JSON.stringify(
    {
      instructions: [
        "Summarize this email thread for an automation agent.",
        "Return JSON only.",
        "Use exactly this shape: {\"brief\": string, \"needs_action\": boolean, \"importance\": \"low\" | \"medium\" | \"high\"}.",
        "Keep brief to one or two sentences.",
        "Base the summary on the latest state of the thread, not stale quoted history.",
        "Do not infer named programs, teams, organizations, or context that are not explicitly present in the thread.",
        "When details are ambiguous, prefer generic wording over guessed specifics.",
      ],
      thread: payload,
    },
    null,
    2,
  );
}

function buildBatchPrompt(batch: PreparedSummaryThread[]): string {
  return JSON.stringify(
    {
      instructions: [
        "Summarize each email thread for an automation agent.",
        "Return JSON only.",
        "Use exactly this shape: {\"summaries\": [{\"thread_ref\": string, \"brief\": string, \"needs_action\": boolean, \"importance\": \"low\" | \"medium\" | \"high\"}]}",
        "Return exactly one summary object per input thread.",
        "Do not omit threads, add extra threads, or merge two threads into one summary.",
        "Keep each brief to one or two sentences.",
        "Base each summary on the latest state of that thread, not stale quoted history.",
        "Summarize each thread independently. Never carry named programs, teams, organizations, or context from one thread into another.",
        "Do not infer named programs, teams, organizations, or context that are not explicitly present in that thread.",
        "When details are ambiguous, prefer generic wording over guessed specifics.",
      ],
      threads: batch.map((entry) => entry.payload),
    },
    null,
    2,
  );
}

function makeFingerprint(payload: SummaryThreadPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function prepareThread(thread: NormalizedThreadRecord, config: SurfaceConfig): PreparedSummaryThread {
  const payload = buildThreadPayload(thread, config.summaryInputMaxBytes);
  return {
    thread,
    payload,
    fingerprint: makeFingerprint(payload),
    inputBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
  };
}

function stripMarkdownFences(rawText: string): string {
  const fencedMatch = rawText.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch?.[1]?.trim() ?? rawText.trim();
}

function tryParseSummaryObject(rawText: string): SummaryShape {
  const parsed = JSON.parse(stripMarkdownFences(rawText)) as Record<string, unknown>;
  const candidate =
    parsed.summary && typeof parsed.summary === "object"
      ? parsed.summary as Record<string, unknown>
      : parsed;

  const brief = typeof candidate.brief === "string" ? candidate.brief.trim() : "";
  const needsAction = typeof candidate.needs_action === "boolean" ? candidate.needs_action : false;
  const importance = candidate.importance === "low" || candidate.importance === "medium" || candidate.importance === "high"
    ? candidate.importance
    : "medium";

  if (!brief) {
    throw new Error("Summary response did not contain a brief.");
  }

  return {
    brief,
    needs_action: needsAction,
    importance,
  };
}

function tryParseBatchSummaryObject(rawText: string, expectedThreadRefs: string[]): Map<string, SummaryShape> {
  const parsed = JSON.parse(stripMarkdownFences(rawText)) as Record<string, unknown>;
  const items = Array.isArray(parsed.summaries) ? parsed.summaries : [];
  const summaries = new Map<string, SummaryShape>();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const threadRef = typeof record.thread_ref === "string" ? record.thread_ref : "";
    if (!threadRef || summaries.has(threadRef)) {
      continue;
    }

    const parsedSummary = tryParseSummaryObject(JSON.stringify(record));
    summaries.set(threadRef, parsedSummary);
  }

  if (expectedThreadRefs.some((threadRef) => !summaries.has(threadRef))) {
    throw new Error("Batch summary response omitted one or more threads.");
  }

  return summaries;
}

function extractJsonFromMixedOutput(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function extractTextFromOpenClawEnvelope(rawOutput: string): string {
  const parsed = JSON.parse(extractJsonFromMixedOutput(rawOutput)) as Record<string, unknown>;

  const payloads =
    Array.isArray(parsed.payloads)
      ? parsed.payloads
      : parsed.result && typeof parsed.result === "object" && Array.isArray((parsed.result as Record<string, unknown>).payloads)
        ? (parsed.result as Record<string, unknown>).payloads as unknown[]
        : Array.isArray(parsed.outputs)
          ? parsed.outputs
          : [];

  for (const payload of payloads) {
    if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).text === "string") {
      return (payload as Record<string, unknown>).text as string;
    }
  }

  if (typeof parsed.summary === "string") {
    return parsed.summary;
  }

  return rawOutput;
}

async function summarizeWithOpenRouter(payload: SummaryThreadPayload, config: SurfaceConfig): Promise<SummaryShape> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required when summarizer_backend = openrouter.");
  }

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.summarizerModel,
      temperature: 0,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You summarize email threads for downstream automation. Return strict JSON only with no markdown.",
        },
        {
          role: "user",
          content: buildSinglePrompt(payload),
        },
      ],
    }),
    signal: AbortSignal.timeout(config.summarizerTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const responsePayload = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = responsePayload.choices?.[0]?.message?.content;
  const rawText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
      : "";
  return tryParseSummaryObject(rawText);
}

async function runOpenClawPrompt(prompt: string, config: SurfaceConfig): Promise<string> {
  const agentId = process.env.SURFACE_OPENCLAW_AGENT ?? "main";
  const { stdout } = await execFileAsync(
    "openclaw",
    [
      "--no-color",
      "--log-level",
      "silent",
      "agent",
      "--agent",
      agentId,
      "--json",
      "--thinking",
      OPENCLAW_SUMMARY_THINKING,
      "--timeout",
      String(Math.max(10, Math.ceil(config.summarizerTimeoutMs / 1000))),
      "--message",
      prompt,
    ],
    {
      timeout: config.summarizerTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  return extractTextFromOpenClawEnvelope(stdout);
}

async function summarizeOpenClawSingle(thread: PreparedSummaryThread, config: SurfaceConfig): Promise<SummaryShape> {
  return tryParseSummaryObject(await runOpenClawPrompt(buildSinglePrompt(thread.payload), config));
}

function buildOpenClawBatches(threads: PreparedSummaryThread[]): PreparedSummaryThread[][] {
  const batches: PreparedSummaryThread[][] = [];
  let currentBatch: PreparedSummaryThread[] = [];
  let currentBytes = 0;

  for (const thread of threads) {
    const nextBytes = currentBytes + thread.inputBytes;
    if (
      currentBatch.length > 0
      && (currentBatch.length >= OPENCLAW_BATCH_MAX_THREADS || nextBytes > OPENCLAW_BATCH_MAX_INPUT_BYTES)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(thread);
    currentBytes += thread.inputBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

async function summarizeOpenClawBatch(
  batch: PreparedSummaryThread[],
  config: SurfaceConfig,
): Promise<Map<string, SummaryShape>> {
  if (batch.length === 1) {
    return new Map([[batch[0]!.thread.thread_ref, await summarizeOpenClawSingle(batch[0]!, config)]]);
  }

  try {
    const parsed = tryParseBatchSummaryObject(
      await runOpenClawPrompt(buildBatchPrompt(batch), config),
      batch.map((thread) => thread.thread.thread_ref),
    );
    return parsed;
  } catch (error) {
    if (batch.length === 1) {
      throw error;
    }

    const midpoint = Math.ceil(batch.length / 2);
    const left = await summarizeOpenClawBatch(batch.slice(0, midpoint), config);
    const right = await summarizeOpenClawBatch(batch.slice(midpoint), config);
    return new Map([...left, ...right]);
  }
}

async function summarizeWithOpenClaw(
  threads: PreparedSummaryThread[],
  config: SurfaceConfig,
): Promise<Map<string, SummaryShape | null>> {
  const summaries = new Map<string, SummaryShape | null>();

  for (const batch of buildOpenClawBatches(threads)) {
    try {
      const parsed = await summarizeOpenClawBatch(batch, config);
      for (const thread of batch) {
        summaries.set(thread.thread.thread_ref, parsed.get(thread.thread.thread_ref) ?? null);
      }
    } catch {
      for (const thread of batch) {
        summaries.set(thread.thread.thread_ref, null);
      }
    }
  }

  return summaries;
}

async function resolveSummaryTarget(config: SurfaceConfig): Promise<SummaryTarget> {
  if (config.summarizerBackend === "openrouter") {
    return {
      backend: "openrouter",
      model: config.summarizerModel,
    };
  }

  const agentId = process.env.SURFACE_OPENCLAW_AGENT ?? "main";
  return {
    backend: "openclaw",
    model: `openclaw/agent:${agentId}`,
  };
}

export async function summarizeAndPersistThreads(
  threads: NormalizedThreadRecord[],
  config: SurfaceConfig,
  db: SurfaceDatabase,
): Promise<NormalizedThreadRecord[]> {
  if (config.summarizerBackend === "none") {
    return threads;
  }

  const target = await resolveSummaryTarget(config);
  const preparedThreads = threads.map((thread) => prepareThread(thread, config));
  const summaries = new Map<string, ThreadSummary | null>();
  const pending: PreparedSummaryThread[] = [];

  for (const prepared of preparedThreads) {
    const stored = db.findStoredSummary(prepared.thread.thread_ref);
    if (
      stored
      && stored.backend === target.backend
      && stored.model === target.model
      && stored.fingerprint === prepared.fingerprint
    ) {
      summaries.set(prepared.thread.thread_ref, {
        backend: stored.backend,
        model: stored.model,
        brief: stored.brief,
        needs_action: Boolean(stored.needs_action),
        importance: stored.importance,
      });
      continue;
    }

    pending.push(prepared);
  }

  if (pending.length > 0) {
    if (target.backend === "openrouter") {
      for (const prepared of pending) {
        try {
          const parsed = await summarizeWithOpenRouter(prepared.payload, config);
          const summary: ThreadSummary = {
            backend: target.backend,
            model: target.model,
            brief: parsed.brief,
            needs_action: parsed.needs_action,
            importance: parsed.importance,
          };
          db.upsertSummary(prepared.thread.thread_ref, summary, prepared.fingerprint);
          summaries.set(prepared.thread.thread_ref, summary);
        } catch {
          db.clearSummary(prepared.thread.thread_ref);
          summaries.set(prepared.thread.thread_ref, null);
        }
      }
    } else {
      const parsed = await summarizeWithOpenClaw(pending, config);
      for (const prepared of pending) {
        const summaryShape = parsed.get(prepared.thread.thread_ref) ?? null;
        if (summaryShape) {
          const summary: ThreadSummary = {
            backend: target.backend,
            model: target.model,
            brief: summaryShape.brief,
            needs_action: summaryShape.needs_action,
            importance: summaryShape.importance,
          };
          db.upsertSummary(prepared.thread.thread_ref, summary, prepared.fingerprint);
          summaries.set(prepared.thread.thread_ref, summary);
          continue;
        }

        db.clearSummary(prepared.thread.thread_ref);
        summaries.set(prepared.thread.thread_ref, null);
      }
    }
  }

  return threads.map((thread) => ({
    ...thread,
    summary: summaries.get(thread.thread_ref) ?? null,
  }));
}
