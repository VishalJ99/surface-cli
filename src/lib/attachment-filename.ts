export function sanitizeDownloadedAttachmentFilename(filename: string): string {
  const sanitized = filename
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized || "attachment";
}
