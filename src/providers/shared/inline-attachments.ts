import type { NormalizedAttachmentRecord } from "../../contracts/mail.js";

function inlineAttachmentMarker(attachment: Pick<NormalizedAttachmentRecord, "filename" | "mime_type">): string {
  const kind = attachment.mime_type.startsWith("image/") ? "image" : "attachment";
  const filename = attachment.filename.trim() || "unnamed";
  return `[inline ${kind}: ${filename}]`;
}

export function annotateBodyWithInlineAttachments(
  bodyText: string,
  attachments: ReadonlyArray<Pick<NormalizedAttachmentRecord, "filename" | "mime_type" | "inline">>,
): string {
  const inlineMarkers = attachments
    .filter((attachment) => attachment.inline)
    .map((attachment) => inlineAttachmentMarker(attachment));

  if (inlineMarkers.length === 0) {
    return bodyText;
  }

  const section = `Inline attachments:\n${inlineMarkers.join("\n")}`;
  const trimmedBody = bodyText.trim();
  return trimmedBody ? `${trimmedBody}\n\n${section}` : section;
}
