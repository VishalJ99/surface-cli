import type { MessageParticipant } from "../../contracts/mail.js";
import { htmlToText } from "../shared/html.js";

export function mailboxFromExchange(value: Record<string, unknown> | null | undefined): MessageParticipant | null {
  const mailbox = (value?.Mailbox as Record<string, unknown> | undefined) ?? value;
  const email = typeof mailbox?.EmailAddress === "string" ? mailbox.EmailAddress : "";
  const name = typeof mailbox?.Name === "string" ? mailbox.Name : "";
  if (!email && !name) {
    return null;
  }
  return { name, email };
}

export function mailboxesFromExchange(
  values: Array<Record<string, unknown>> | null | undefined,
): MessageParticipant[] {
  const result: MessageParticipant[] = [];
  for (const value of values ?? []) {
    const mailbox = mailboxFromExchange(value);
    if (mailbox) {
      result.push(mailbox);
    }
  }
  return result;
}

export function normalizeResponseObjects(values: Array<Record<string, unknown>> | null | undefined): string[] {
  const result: string[] = [];
  for (const value of values ?? []) {
    const rawType = typeof value.__type === "string" ? value.__type : "";
    const normalized = rawType.split(":", 1)[0];
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}

export function itemIdData(
  value: Record<string, unknown> | null | undefined,
): { id: string; change_key: string } | null {
  if (!value) {
    return null;
  }
  const id = typeof value.Id === "string" ? value.Id : "";
  const changeKey = typeof value.ChangeKey === "string" ? value.ChangeKey : "";
  if (!id && !changeKey) {
    return null;
  }
  return { id, change_key: changeKey };
}

export function messageIdentity(item: Record<string, unknown>, conversationId: string): string {
  const itemId = (item.ItemId as Record<string, unknown> | undefined)?.Id;
  const internetMessageId = item.InternetMessageId;
  const instanceKey = item.InstanceKey;
  if (typeof itemId === "string" && itemId) {
    return itemId;
  }
  if (typeof internetMessageId === "string" && internetMessageId) {
    return internetMessageId;
  }
  if (typeof instanceKey === "string" && instanceKey) {
    return instanceKey;
  }
  return `${conversationId}:${String(item.DateTimeReceived ?? item.Subject ?? "unknown")}`;
}

export function normalizeOutlookBody(item: Record<string, unknown>): {
  text: string;
  html: string;
} {
  const uniqueBody = item.UniqueBody as Record<string, unknown> | undefined;
  const body = item.Body as Record<string, unknown> | undefined;
  const preview = typeof item.Preview === "string" ? item.Preview : "";
  const bodyHtml =
    (typeof uniqueBody?.Value === "string" ? uniqueBody.Value : "") ||
    (typeof body?.Value === "string" ? body.Value : "");

  return {
    text: bodyHtml ? htmlToText(bodyHtml) : preview,
    html: bodyHtml,
  };
}

export function buildOutlookInvite(item: Record<string, unknown>): {
  is_invite: boolean;
  rsvp_supported: boolean;
  response_status: string | null;
  meeting: Record<string, unknown> | null;
} {
  const itemClass = typeof item.ItemClass === "string" ? item.ItemClass : "";
  const responseObjects = normalizeResponseObjects(item.ResponseObjects as Array<Record<string, unknown>> | undefined);
  const isInvite = itemClass === "IPM.Schedule.Meeting.Request";
  if (!isInvite) {
    return {
      is_invite: false,
      rsvp_supported: false,
      response_status: null,
      meeting: null,
    };
  }

  const meeting = {
    request_type: item.MeetingRequestType ?? null,
    response_type: item.ResponseType ?? null,
    organizer: mailboxFromExchange((item.Organizer as Record<string, unknown> | undefined) ?? null)
      ?? mailboxFromExchange((item.Sender as Record<string, unknown> | undefined) ?? null),
    location:
      ((item.Location as Record<string, unknown> | undefined)?.DisplayName as string | undefined) ?? null,
    start: item.Start ?? null,
    end: item.End ?? null,
    associated_calendar_item: itemIdData(
      (item.AssociatedCalendarItemId as Record<string, unknown> | undefined) ?? null,
    ),
    available_rsvp_actions: responseObjects.filter((action) =>
      ["AcceptItem", "TentativelyAcceptItem", "DeclineItem", "ProposeNewTime"].includes(action),
    ),
  };

  return {
    is_invite: true,
    rsvp_supported: Array.isArray(meeting.available_rsvp_actions) && meeting.available_rsvp_actions.length > 0,
    response_status: typeof item.ResponseType === "string" ? item.ResponseType : null,
    meeting,
  };
}
