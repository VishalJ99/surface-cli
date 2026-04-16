import type { MailAccount } from "../../contracts/account.js";
import { SurfaceError } from "../../lib/errors.js";
import type { ProviderContext } from "../types.js";
import { ensureGmailAccessToken } from "./oauth.js";
import type { GmailMessagePayload } from "./normalize.js";

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";

export interface GmailThreadStub {
  id?: string;
  historyId?: string;
}

export interface GmailThreadRecord {
  id?: string;
  historyId?: string;
  snippet?: string;
  messages?: GmailMessagePayload[];
}

export interface GmailMessageMutation {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface GmailMessageReference {
  id?: string;
  threadId?: string;
  labelIds?: string[];
}

export interface GmailDraftRecord {
  id?: string;
  message?: GmailMessageReference;
}

export interface GoogleCalendarEventAttendee {
  email?: string;
  self?: boolean;
  organizer?: boolean;
  responseStatus?: string;
}

export interface GoogleCalendarEventDateTime {
  date?: string;
  dateTime?: string;
}

export interface GoogleCalendarEventRecord {
  id?: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  eventType?: string;
  attendeesOmitted?: boolean;
  attendees?: GoogleCalendarEventAttendee[];
  start?: GoogleCalendarEventDateTime;
  end?: GoogleCalendarEventDateTime;
}

interface GmailListThreadsResponse {
  threads?: GmailThreadStub[];
  nextPageToken?: string;
}

interface GmailAttachmentResponse {
  data?: string;
  size?: number;
}

interface GoogleCalendarEventsListResponse {
  items?: GoogleCalendarEventRecord[];
}

function gmailApiUrl(pathname: string, searchParams?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(`${GMAIL_API_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function googleCalendarApiUrl(
  pathname: string,
  searchParams?: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(`${GOOGLE_CALENDAR_API_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function gmailApiJson<T>(
  account: MailAccount,
  context: ProviderContext,
  pathname: string,
  init: {
    method?: string;
    searchParams?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    contentType?: string;
  } = {},
): Promise<T> {
  const token = await ensureGmailAccessToken(account, context);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.accessToken}`,
  };

  if (init.body !== undefined) {
    headers["content-type"] = init.contentType ?? "application/json";
  }

  const response = await fetch(gmailApiUrl(pathname, init.searchParams), {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined
      ? {}
      : {
          body: typeof init.body === "string" ? init.body : JSON.stringify(init.body),
        }),
    signal: AbortSignal.timeout(context.config.providerTimeoutMs),
  });

  const responseText = await response.text();
  if (!response.ok) {
    const code = response.status === 401 ? "reauth_required" : response.status === 404 ? "not_found" : "transport_error";
    throw new SurfaceError(
      code,
      `Gmail API request failed with HTTP ${response.status}: ${responseText || response.statusText}`,
      { account: account.name, retryable: response.status >= 500 },
    );
  }

  if (!responseText.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch (error) {
    throw new SurfaceError(
      "transport_error",
      `Gmail API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { account: account.name },
    );
  }
}

async function googleCalendarApiJson<T>(
  account: MailAccount,
  context: ProviderContext,
  pathname: string,
  init: {
    method?: string;
    searchParams?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    contentType?: string;
  } = {},
): Promise<T> {
  const token = await ensureGmailAccessToken(account, context);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.accessToken}`,
  };

  if (init.body !== undefined) {
    headers["content-type"] = init.contentType ?? "application/json";
  }

  const response = await fetch(googleCalendarApiUrl(pathname, init.searchParams), {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined
      ? {}
      : {
          body: typeof init.body === "string" ? init.body : JSON.stringify(init.body),
        }),
    signal: AbortSignal.timeout(context.config.providerTimeoutMs),
  });

  const responseText = await response.text();
  if (!response.ok) {
    const needsReauth =
      response.status === 401
      || (response.status === 403
        && /(insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|Request had insufficient authentication scopes)/i.test(
          responseText,
        ));
    const code = needsReauth ? "reauth_required" : response.status === 404 ? "not_found" : "transport_error";
    throw new SurfaceError(
      code,
      needsReauth
        ? `Google Calendar access is not authorized for this account. Re-run 'surface auth login ${account.name}' to grant Calendar permissions.`
        : `Google Calendar API request failed with HTTP ${response.status}: ${responseText || response.statusText}`,
      { account: account.name, retryable: response.status >= 500 },
    );
  }

  if (!responseText.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch (error) {
    throw new SurfaceError(
      "transport_error",
      `Google Calendar API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { account: account.name },
    );
  }
}

export async function listGmailThreads(
  account: MailAccount,
  context: ProviderContext,
  options: { q?: string; labelIds?: string[]; maxResults: number },
): Promise<GmailThreadStub[]> {
  const payload = await gmailApiJson<GmailListThreadsResponse>(account, context, "/threads", {
    searchParams: {
      maxResults: options.maxResults,
      ...(options.q ? { q: options.q } : {}),
      ...(options.labelIds && options.labelIds.length > 0 ? { labelIds: options.labelIds.join(",") } : {}),
    },
  });

  return payload.threads ?? [];
}

export async function getGmailThread(
  account: MailAccount,
  context: ProviderContext,
  threadId: string,
): Promise<GmailThreadRecord> {
  return gmailApiJson<GmailThreadRecord>(account, context, `/threads/${encodeURIComponent(threadId)}`, {
    searchParams: {
      format: "full",
    },
  });
}

export async function downloadGmailAttachmentBytes(
  account: MailAccount,
  context: ProviderContext,
  messageId: string,
  attachmentId: string,
): Promise<GmailAttachmentResponse> {
  return gmailApiJson<GmailAttachmentResponse>(
    account,
    context,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

export async function modifyGmailMessage(
  account: MailAccount,
  context: ProviderContext,
  messageId: string,
  mutation: GmailMessageMutation,
): Promise<GmailMessageReference> {
  return gmailApiJson<GmailMessageReference>(
    account,
    context,
    `/messages/${encodeURIComponent(messageId)}/modify`,
    {
      method: "POST",
      body: mutation,
    },
  );
}

export async function modifyGmailThread(
  account: MailAccount,
  context: ProviderContext,
  threadId: string,
  mutation: GmailMessageMutation,
): Promise<GmailThreadRecord> {
  return gmailApiJson<GmailThreadRecord>(
    account,
    context,
    `/threads/${encodeURIComponent(threadId)}/modify`,
    {
      method: "POST",
      body: mutation,
    },
  );
}

export async function sendGmailRawMessage(
  account: MailAccount,
  context: ProviderContext,
  payload: { raw: string; threadId?: string | null },
): Promise<GmailMessageReference> {
  return gmailApiJson<GmailMessageReference>(account, context, "/messages/send", {
    method: "POST",
    body: {
      raw: payload.raw,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
    },
  });
}

export async function createGmailDraft(
  account: MailAccount,
  context: ProviderContext,
  payload: { raw: string; threadId?: string | null },
): Promise<GmailDraftRecord> {
  return gmailApiJson<GmailDraftRecord>(account, context, "/drafts", {
    method: "POST",
    body: {
      message: {
        raw: payload.raw,
        ...(payload.threadId ? { threadId: payload.threadId } : {}),
      },
    },
  });
}

export async function listGoogleCalendarEventsByIcalUid(
  account: MailAccount,
  context: ProviderContext,
  calendarId: string,
  icalUid: string,
): Promise<GoogleCalendarEventRecord[]> {
  const payload = await googleCalendarApiJson<GoogleCalendarEventsListResponse>(
    account,
    context,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      searchParams: {
        iCalUID: icalUid,
        showDeleted: false,
        maxResults: 10,
      },
    },
  );

  return payload.items ?? [];
}

export async function getGoogleCalendarEvent(
  account: MailAccount,
  context: ProviderContext,
  calendarId: string,
  eventId: string,
): Promise<GoogleCalendarEventRecord> {
  return googleCalendarApiJson<GoogleCalendarEventRecord>(
    account,
    context,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
}

export async function patchGoogleCalendarEvent(
  account: MailAccount,
  context: ProviderContext,
  calendarId: string,
  eventId: string,
  patch: Record<string, unknown>,
): Promise<GoogleCalendarEventRecord> {
  return googleCalendarApiJson<GoogleCalendarEventRecord>(
    account,
    context,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: patch,
    },
  );
}
