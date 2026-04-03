import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ThreadSummary, NormalizedThreadRecord } from "./contracts/mail.js";
import type { SurfaceConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

interface SummaryShape {
  brief: string;
  needs_action: boolean;
  importance: "low" | "medium" | "high";
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

function buildThreadPayload(thread: NormalizedThreadRecord, maxBytes: number): Record<string, unknown> {
  let remainingBytes = maxBytes;
  const messages: Array<Record<string, unknown>> = [];

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
      unread: message.envelope.unread,
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
    envelope: thread.envelope,
    messages,
  };
}

function buildPrompt(thread: NormalizedThreadRecord, config: SurfaceConfig): string {
  return JSON.stringify(
    {
      instructions: [
        "Summarize this email thread for an automation agent.",
        "Return JSON only.",
        "Use exactly this shape: {\"brief\": string, \"needs_action\": boolean, \"importance\": \"low\" | \"medium\" | \"high\"}.",
        "Keep brief to one or two sentences.",
      ],
      thread: buildThreadPayload(thread, config.summaryInputMaxBytes),
    },
    null,
    2,
  );
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

async function summarizeWithOpenRouter(thread: NormalizedThreadRecord, config: SurfaceConfig): Promise<ThreadSummary> {
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
          content: buildPrompt(thread, config),
        },
      ],
    }),
    signal: AbortSignal.timeout(config.summarizerTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  const rawText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
      : "";
  const parsed = tryParseSummaryObject(rawText);

  return {
    backend: "openrouter",
    model: config.summarizerModel,
    brief: parsed.brief,
    needs_action: parsed.needs_action,
    importance: parsed.importance,
  };
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

async function resolveOpenClawModel(agentId: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("openclaw", ["agents", "list", "--json"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const payload = JSON.parse(stdout) as Array<{ id?: string; model?: string; isDefault?: boolean }>;
    const matched = payload.find((agent) => agent.id === agentId)
      ?? payload.find((agent) => agent.isDefault);
    return matched?.model ?? "openclaw/local-agent";
  } catch {
    return "openclaw/local-agent";
  }
}

async function summarizeWithOpenClaw(thread: NormalizedThreadRecord, config: SurfaceConfig): Promise<ThreadSummary> {
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
      "medium",
      "--timeout",
      String(Math.max(10, Math.ceil(config.summarizerTimeoutMs / 1000))),
      "--message",
      buildPrompt(thread, config),
    ],
    {
      timeout: config.summarizerTimeoutMs,
      maxBuffer: 1024 * 1024,
    },
  );

  const parsed = tryParseSummaryObject(extractTextFromOpenClawEnvelope(stdout));
  return {
    backend: "openclaw",
    model: await resolveOpenClawModel(agentId),
    brief: parsed.brief,
    needs_action: parsed.needs_action,
    importance: parsed.importance,
  };
}

export async function summarizeThread(
  thread: NormalizedThreadRecord,
  config: SurfaceConfig,
): Promise<ThreadSummary | null> {
  if (config.summarizerBackend === "none") {
    return null;
  }

  try {
    if (config.summarizerBackend === "openrouter") {
      return await summarizeWithOpenRouter(thread, config);
    }
    return await summarizeWithOpenClaw(thread, config);
  } catch {
    return null;
  }
}
