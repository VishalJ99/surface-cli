import type { Page, Response, APIRequestContext } from "playwright-core";
import type { ComposeAttachmentInput } from "../../contracts/mail.js";
import { assertComposeBody, composeBodyHtml } from "../../lib/compose-body.js";
import { SurfaceError } from "../../lib/errors.js";
import { fetchOutlookItem, type OutlookCapturedSession } from "./extract.js";
import { normalizeOutlookBody } from "./normalize.js";

export function savedComposeIds(data: any): string[] {
  return (data?.Body?.ResponseMessages?.Items ?? [])
    .filter((response: any) => response.ResponseClass === "Success")
    .flatMap((response: any) => response.Items ?? [])
    .filter((item: any) => item.IsDraft !== false && typeof item.ItemId?.Id === "string")
    .map((item: any) => item.ItemId.Id);
}

export function assertSavedCompose(item: Record<string, any>, body: string): void {
  if (item.IsDraft !== true) throw new SurfaceError("transport_error", "Outlook did not return an unsent draft.");
  if (typeof item.Body?.Value !== "string" || item.Body?.IsTruncated === true) {
    throw new SurfaceError("transport_error", "Outlook draft body is absent or truncated; refusing to finalize.");
  }
  assertComposeBody(normalizeOutlookBody({ Body: item.Body }).text, body);
}

export function findSavedAttachment(
  item: Record<string, any>, attachment: ComposeAttachmentInput, used = new Set<string>(),
): Record<string, any> | undefined {
  return (item.Attachments ?? []).find((value: any) =>
    value.Name === attachment.filename
    && typeof value.AttachmentId?.Id === "string" && !used.has(value.AttachmentId.Id));
}

// Observe only this compose's save responses; never infer identity from subject or sort order.
export class OutlookComposeReceipt {
  readonly ids = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly handleResponse = (response: Response): void => {
    const request = response.request();
    const action = new URL(response.url()).searchParams.get("action") ?? request.headers().action;
    if (!response.url().includes("/service.svc") || !["CreateItem", "UpdateItem"].includes(action ?? "")) return;
    const operation = response.json().then((data) => {
      for (const id of savedComposeIds(data)) this.ids.add(id);
    }).catch(() => {}).finally(() => this.pending.delete(operation));
    this.pending.add(operation);
  };

  constructor(
    private readonly page: Page,
    private readonly request: APIRequestContext,
    private readonly captured: OutlookCapturedSession,
  ) { page.on("response", this.handleResponse); }

  stop(): void { this.page.off("response", this.handleResponse); }

  async read(): Promise<Record<string, any> | null> {
    await Promise.all(this.pending);
    if (this.ids.size > 1) throw new SurfaceError("transport_error", "Multiple Outlook draft identities observed; refusing to guess.");
    const id = [...this.ids][0];
    return id ? fetchOutlookItem(this.request, this.captured, id) : null;
  }

  private async messageUrl(): Promise<string> {
    const item = await this.read();
    if (!item || item.IsDraft !== true) throw new SurfaceError("transport_error", "No exact unsent Outlook draft is available.");
    return `https://outlook.office.com/api/v2.0/me/messages('${encodeURIComponent(item.ItemId.Id)}')`;
  }

  async replaceBody(body: string): Promise<void> {
    const response = await this.request.patch(await this.messageUrl(), {
      headers: { authorization: this.captured.headers.authorization ?? "", "content-type": "application/json" },
      data: { Body: { ContentType: "HTML", Content: composeBodyHtml(body) } },
      timeout: 15_000,
    });
    try {
      if (!response.ok()) throw new SurfaceError("transport_error", `Outlook draft body update failed: HTTP ${response.status()}.`);
    } finally { await response.dispose(); }
  }

  async sendVerifiedDraft(body: string, attachments: ComposeAttachmentInput[], timeoutMs = 60_000): Promise<void> {
    const item = await this.verify(body, attachments, timeoutMs);
    const url = `https://outlook.office.com/api/v2.0/me/messages('${encodeURIComponent(item.ItemId.Id)}')/send`;
    const response = await this.request.post(url, {
      headers: { authorization: this.captured.headers.authorization ?? "" }, timeout: 15_000,
    });
    try {
      if (response.status() !== 202) throw new SurfaceError("transport_error", `Outlook draft send returned HTTP ${response.status()}; inspect delivery before retrying.`);
    } finally { await response.dispose(); }
  }

  async verify(body: string | null, attachments: ComposeAttachmentInput[], timeoutMs = 60_000): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    let failure: unknown = new Error("No Outlook saved draft identity was observed.");
    do {
      try {
        const item = await this.read();
        if (!item) throw new Error("No Outlook saved draft identity was observed.");
        if (item.IsDraft !== true) throw new Error("Outlook did not return an unsent draft.");
        if (body !== null) assertSavedCompose(item, body);
        const used = new Set<string>();
        for (const attachment of attachments) {
          const saved = findSavedAttachment(item, attachment, used);
          if (!saved) throw new Error(`Outlook attachment '${attachment.filename}' has not been persisted completely.`);
          used.add(saved.AttachmentId.Id);
          const response = await this.request.get(
            `https://outlook.office.com/api/v2.0/me/messages('${encodeURIComponent(item.ItemId.Id)}')/attachments('${encodeURIComponent(saved.AttachmentId.Id)}')/$value`,
            { headers: { authorization: this.captured.headers.authorization ?? "" }, timeout: 15_000 },
          );
          try {
            if (!response.ok() || !(await response.body()).equals(Buffer.from(attachment.content_base64, "base64"))) {
              throw new Error(`Outlook attachment '${attachment.filename}' failed byte-for-byte read-back.`);
            }
          } finally { await response.dispose(); }
        }
        return item;
      } catch (error) { failure = error; }
      await this.page.waitForTimeout(1_000);
    } while (Date.now() < deadline);
    throw new SurfaceError("transport_error", failure instanceof Error ? failure.message : String(failure));
  }
}
