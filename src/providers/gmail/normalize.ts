import { Buffer } from "node:buffer";

import type { MessageParticipant } from "../../contracts/mail.js";
import { htmlToText } from "../shared/html.js";

const WINDOWS_TIMEZONE_ALIASES: Record<string, string> = {
  UTC: "UTC",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
};

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailBody {
  data?: string;
  attachmentId?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
}

function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g, (_match, charset, encoding, encoded) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return Buffer.from(encoded, "base64").toString(charset);
      }
      const normalized = encoded.replace(/_/g, " ").replace(/=([A-Fa-f0-9]{2})/g, (_inner: string, hex: string) => {
        return String.fromCharCode(Number.parseInt(hex, 16));
      });
      return Buffer.from(normalized, "binary").toString(charset);
    } catch {
      return encoded;
    }
  });
}

export function decodeHeaderValue(value: string | undefined | null): string {
  if (!value) {
    return "";
  }
  return decodeEncodedWords(value);
}

export function headerIndex(headers: GmailHeader[] | undefined | null): Record<string, string> {
  const indexed: Record<string, string> = {};
  for (const header of headers ?? []) {
    const name = (header.name ?? "").toLowerCase();
    if (!name || indexed[name]) {
      continue;
    }
    indexed[name] = header.value ?? "";
  }
  return indexed;
}

function splitAddressList(value: string): Array<{ name: string; email: string }> {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(.*)<([^>]+)>$/);
      if (!match) {
        return { name: "", email: item.replace(/^mailto:/i, "") };
      }
      return {
        name: decodeHeaderValue(match[1]?.trim().replace(/^"|"$/g, "") ?? ""),
        email: match[2]?.trim() ?? "",
      };
    });
}

export function parseMailbox(value: string | undefined | null): MessageParticipant | null {
  if (!value) {
    return null;
  }
  const first = splitAddressList(decodeHeaderValue(value))[0];
  return first ? { name: first.name, email: first.email } : null;
}

export function parseMailboxes(value: string | undefined | null): MessageParticipant[] {
  if (!value) {
    return [];
  }
  return splitAddressList(decodeHeaderValue(value)).filter((item) => item.name !== "" || item.email !== "");
}

export function normalizeDate(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function internalDateToIso(internalDateMs: string | undefined | null): string | null {
  if (!internalDateMs) {
    return null;
  }
  const parsed = Number.parseInt(internalDateMs, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return normalizeDate(new Date(parsed));
}

export function headerDateToIso(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : normalizeDate(parsed);
}

export function *iterParts(part: GmailPart | undefined | null): Generator<GmailPart> {
  if (!part) {
    return;
  }
  yield part;
  for (const child of part.parts ?? []) {
    yield* iterParts(child);
  }
}

export function partCharset(part: GmailPart): string {
  const contentType = headerIndex(part.headers)["content-type"] ?? "";
  const match = contentType.match(/charset="?([^";]+)"?/i);
  return match?.[1] ?? "utf-8";
}

export function decodeBase64UrlBytes(data: string): Buffer {
  const padding = "=".repeat((4 - (data.length % 4 || 4)) % 4);
  return Buffer.from(data + padding, "base64url");
}

export function decodeBytes(value: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(value);
  } catch {
    return new TextDecoder("utf-8").decode(value);
  }
}

export function decodePartData(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) {
    return "";
  }
  return decodeBytes(decodeBase64UrlBytes(data), partCharset(part));
}

export function extractMessageBodies(payload: GmailPart | undefined | null): {
  plainBody: string;
  htmlBody: string;
} {
  let plainBody = "";
  let htmlBody = "";

  for (const part of iterParts(payload)) {
    const mimeType = (part.mimeType ?? "").toLowerCase();
    if (!["text/plain", "text/html"].includes(mimeType) || part.filename) {
      continue;
    }

    const decoded = decodePartData(part).trim();
    if (!decoded) {
      continue;
    }

    if (mimeType === "text/plain" && !plainBody) {
      plainBody = decoded;
    }

    if (mimeType === "text/html" && !htmlBody) {
      htmlBody = decoded;
    }

    if (plainBody && htmlBody) {
      break;
    }
  }

  return { plainBody, htmlBody };
}

function unfoldIcsLines(value: string): string[] {
  const lines: string[] = [];
  for (const rawLine of value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (/^[ \t]/.test(rawLine) && lines.length > 0) {
      lines[lines.length - 1] += rawLine.slice(1);
      continue;
    }
    if (rawLine) {
      lines.push(rawLine);
    }
  }
  return lines;
}

function parseIcsContentLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const separator = line.indexOf(":");
  if (separator === -1) {
    return null;
  }
  const left = line.slice(0, separator);
  const value = line.slice(separator + 1);
  const [name, ...paramSegments] = left.split(";");
  const params: Record<string, string> = {};

  for (const segment of paramSegments) {
    const [key, paramValue = ""] = segment.split("=", 2);
    if (!key) {
      continue;
    }
    params[key.toUpperCase()] = paramValue.replace(/^"|"$/g, "");
  }

  if (!name) {
    return null;
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeIcsValue(value: string | undefined | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function resolveIcsTimezone(tzid: string | undefined): string | undefined {
  if (!tzid) {
    return undefined;
  }
  return WINDOWS_TIMEZONE_ALIASES[tzid] ?? tzid;
}

function parseIcsDatetime(value: string | undefined, params: Record<string, string>): string | null {
  if (!value) {
    return null;
  }

  const raw = value.trim();
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  if (raw.endsWith("Z")) {
    const parsed = new Date(raw.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    return Number.isNaN(parsed.getTime()) ? raw : normalizeDate(parsed);
  }

  const timezoneName = resolveIcsTimezone(params.TZID);
  const normalized = raw.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6");
  if (!timezoneName) {
    return normalized;
  }
  return `${normalized}[${timezoneName}]`;
}

function normalizeEmail(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function icsMailbox(value: string | undefined, params: Record<string, string>): MessageParticipant | null {
  const email = (value ?? "").replace(/^mailto:/i, "");
  const name = unescapeIcsValue(params.CN) ?? "";
  if (!name && !email) {
    return null;
  }
  return { name, email };
}

export function parseCalendarInvite(
  icsText: string,
  options: { mailboxEmail?: string | null; recipientEmails: string[] },
): {
  meeting: Record<string, unknown> | null;
  availableRsvpActions: string[];
} {
  let method: string | null = null;
  let inEvent = false;
  const eventProperties = new Map<string, { params: Record<string, string>; value: string }>();
  const attendees: Array<{ params: Record<string, string>; value: string }> = [];

  for (const line of unfoldIcsLines(icsText)) {
    const parsed = parseIcsContentLine(line);
    if (!parsed) {
      continue;
    }

    const upperValue = parsed.value.toUpperCase();
    if (parsed.name === "METHOD" && !method) {
      method = upperValue;
      continue;
    }
    if (parsed.name === "BEGIN" && upperValue === "VEVENT") {
      inEvent = true;
      continue;
    }
    if (parsed.name === "END" && upperValue === "VEVENT") {
      break;
    }
    if (!inEvent) {
      continue;
    }

    if (parsed.name === "ATTENDEE") {
      attendees.push({ params: parsed.params, value: parsed.value });
      continue;
    }

    if (!eventProperties.has(parsed.name)) {
      eventProperties.set(parsed.name, { params: parsed.params, value: parsed.value });
    }
  }

  if (eventProperties.size === 0 && attendees.length === 0) {
    return { meeting: null, availableRsvpActions: [] };
  }

  const attendeeTargets = new Set([
    normalizeEmail(options.mailboxEmail),
    ...options.recipientEmails.map((email) => normalizeEmail(email)),
  ]);
  attendeeTargets.delete("");

  let selectedAttendee:
    | {
        mailbox: MessageParticipant | null;
        partstat: string | null;
        rsvp: boolean;
        role: string | null;
      }
    | undefined;

  for (const attendee of attendees) {
    const mailbox = icsMailbox(attendee.value, attendee.params);
    if (!mailbox || !attendeeTargets.has(normalizeEmail(mailbox.email))) {
      continue;
    }
    selectedAttendee = {
      mailbox,
      partstat: attendee.params.PARTSTAT?.toUpperCase() ?? null,
      rsvp: attendee.params.RSVP?.toUpperCase() === "TRUE",
      role: attendee.params.ROLE?.toUpperCase() ?? null,
    };
    break;
  }

  const requestType = method;
  const status = eventProperties.get("STATUS")?.value?.toUpperCase() ?? null;
  const availableRsvpActions =
    requestType === "REQUEST" && status !== "CANCELLED" && selectedAttendee
      ? ["AcceptItem", "TentativelyAcceptItem", "DeclineItem"]
      : [];

  const start = eventProperties.get("DTSTART");
  const end = eventProperties.get("DTEND");
  const timezone = start?.params.TZID ?? end?.params.TZID ?? null;
  const organizer = eventProperties.get("ORGANIZER")
    ? icsMailbox(eventProperties.get("ORGANIZER")?.value, eventProperties.get("ORGANIZER")?.params ?? {})
    : null;

  const meeting: Record<string, unknown> = {
    request_type: requestType,
    response_type: selectedAttendee?.partstat ?? null,
    organizer,
    location: unescapeIcsValue(eventProperties.get("LOCATION")?.value) ?? null,
    start: parseIcsDatetime(start?.value, start?.params ?? {}),
    end: parseIcsDatetime(end?.value, end?.params ?? {}),
    uid: eventProperties.get("UID")?.value ?? null,
    status,
    timezone,
    available_rsvp_actions: availableRsvpActions,
  };

  if (selectedAttendee?.mailbox) {
    meeting.attendee = selectedAttendee.mailbox;
  }
  if (selectedAttendee?.role) {
    meeting.attendee_role = selectedAttendee.role;
  }

  return {
    meeting,
    availableRsvpActions,
  };
}

export function normalizeGmailBody(payload: GmailPart | undefined | null, snippet: string): {
  text: string;
  html: string;
} {
  const { plainBody, htmlBody } = extractMessageBodies(payload);
  return {
    text: plainBody || htmlToText(htmlBody) || snippet,
    html: htmlBody,
  };
}
