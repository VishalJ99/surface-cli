import { Buffer } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import type { ComposeAttachmentInput, ComposeAttachmentMeta } from "../contracts/mail.js";
import { SurfaceError } from "./errors.js";

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ics": "text/calendar",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".text": "text/plain",
  ".txt": "text/plain",
};

function expandUserPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function mimeTypeForPath(path: string): string {
  return MIME_TYPES_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function resolveLocalComposeAttachment(inputPath: string): ComposeAttachmentInput {
  if (!inputPath.trim()) {
    throw new SurfaceError("invalid_argument", "Attachment path must be non-empty.");
  }

  const resolvedPath = resolve(expandUserPath(inputPath));
  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch {
    throw new SurfaceError("invalid_argument", `Attachment '${inputPath}' was not found.`);
  }

  if (!stats.isFile()) {
    throw new SurfaceError("invalid_argument", `Attachment '${inputPath}' is not a regular file.`);
  }

  const content = readFileSync(resolvedPath);
  const filename = basename(resolvedPath).trim() || "attachment";
  return {
    path: resolvedPath,
    filename,
    mime_type: mimeTypeForPath(resolvedPath),
    size_bytes: content.length,
    content_base64: content.toString("base64"),
  };
}

export function resolveLocalComposeAttachments(paths: string[] | undefined): ComposeAttachmentInput[] {
  return (paths ?? []).map(resolveLocalComposeAttachment);
}

export function composeAttachmentMetas(
  attachments: readonly ComposeAttachmentInput[] | undefined,
): ComposeAttachmentMeta[] {
  return (attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
  }));
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function sanitizeMimeType(value: string): string {
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function sanitizeMimeParameter(value: string): string {
  const normalized = sanitizeHeaderValue(value).replace(/[\\"]/g, "_");
  return normalized || "attachment";
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

function makeMimeBoundary(): string {
  return `surface-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function encodeRawMimeBase64Url(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

export function rfc2822Date(value: Date = new Date()): string {
  return value.toUTCString().replace("GMT", "+0000");
}

export function buildRawMimeMessage(input: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  messageId?: string | undefined;
  date?: string | undefined;
  inReplyTo?: string | null | undefined;
  includeBccHeader?: boolean | undefined;
  references?: string | null | undefined;
  attachments?: readonly ComposeAttachmentInput[] | undefined;
}): string {
  const attachments = input.attachments ?? [];
  const includeBccHeader = input.includeBccHeader ?? true;
  const headers = [
    `From: ${sanitizeHeaderValue(input.from)}`,
    ...(input.to.length > 0 ? [`To: ${input.to.map(sanitizeHeaderValue).join(", ")}`] : []),
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.map(sanitizeHeaderValue).join(", ")}`] : []),
    ...(includeBccHeader && input.bcc.length > 0 ? [`Bcc: ${input.bcc.map(sanitizeHeaderValue).join(", ")}`] : []),
    `Subject: ${sanitizeHeaderValue(input.subject)}`,
    ...(input.messageId ? [`Message-ID: ${sanitizeHeaderValue(input.messageId)}`] : []),
    ...(input.date || input.messageId ? [`Date: ${sanitizeHeaderValue(input.date ?? rfc2822Date())}`] : []),
    ...(input.inReplyTo ? [`In-Reply-To: ${sanitizeHeaderValue(input.inReplyTo)}`] : []),
    ...(input.references ? [`References: ${sanitizeHeaderValue(input.references)}`] : []),
    "MIME-Version: 1.0",
  ];
  const body = input.body.replace(/\r\n/g, "\n");

  if (attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
      "",
    ].join("\r\n");
  }

  const boundary = makeMimeBoundary();
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    "",
  ];

  for (const attachment of attachments) {
    const filename = sanitizeMimeParameter(attachment.filename);
    lines.push(
      `--${boundary}`,
      `Content-Type: ${sanitizeMimeType(attachment.mime_type)}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(attachment.content_base64),
      "",
    );
  }

  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}
