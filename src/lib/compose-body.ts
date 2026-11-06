import { SurfaceError } from "./errors.js";

// Canonicalize transport whitespace, never collapse or discard interior line breaks.
export function normalizeComposeBody(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");
}

export function composeBodyHtml(value: string): string {
  return normalizeComposeBody(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");
}

export function assertComposeBody(actual: string, expected: string): void {
  if (normalizeComposeBody(actual) !== normalizeComposeBody(expected)) {
    throw new SurfaceError("transport_error", "Compose body read-back differs from intended text; refusing to send.");
  }
}
