import type { HTMLParserLike } from "./types.js";

class HtmlTextExtractor implements HTMLParserLike {
  private static readonly BLOCK_TAGS = new Set(["br", "div", "p", "li", "tr", "hr"]);
  private static readonly IGNORED_TAGS = new Set(["head", "script", "style"]);

  private readonly parts: string[] = [];
  private ignoredDepth = 0;

  onOpenTag(tag: string): void {
    if (HtmlTextExtractor.IGNORED_TAGS.has(tag)) {
      this.ignoredDepth += 1;
      return;
    }
    if (this.ignoredDepth > 0) {
      return;
    }
    if (HtmlTextExtractor.BLOCK_TAGS.has(tag)) {
      this.parts.push("\n");
    }
  }

  onCloseTag(tag: string): void {
    if (HtmlTextExtractor.IGNORED_TAGS.has(tag)) {
      this.ignoredDepth = Math.max(0, this.ignoredDepth - 1);
      return;
    }
    if (this.ignoredDepth > 0) {
      return;
    }
    if (HtmlTextExtractor.BLOCK_TAGS.has(tag)) {
      this.parts.push("\n");
    }
  }

  onText(text: string): void {
    if (this.ignoredDepth > 0) {
      return;
    }
    this.parts.push(text);
  }

  text(): string {
    return this.parts.join("");
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function walkHtml(value: string, parser: HtmlTextExtractor): void {
  const tagPattern = /<\/?([a-zA-Z0-9]+)(?:\s[^>]*?)?>/g;
  let cursor = 0;
  let match: RegExpExecArray | null = null;

  while ((match = tagPattern.exec(value)) !== null) {
    if (match.index > cursor) {
      parser.onText(decodeEntities(value.slice(cursor, match.index)));
    }
    const rawTag = match[0];
    const tagName = (match[1] ?? "").toLowerCase();
    if (rawTag.startsWith("</")) {
      parser.onCloseTag(tagName);
    } else {
      parser.onOpenTag(tagName);
      if (rawTag.endsWith("/>")) {
        parser.onCloseTag(tagName);
      }
    }
    cursor = match.index + rawTag.length;
  }

  if (cursor < value.length) {
    parser.onText(decodeEntities(value.slice(cursor)));
  }
}

export function htmlToText(value: string): string {
  if (!value) {
    return "";
  }

  const parser = new HtmlTextExtractor();
  walkHtml(value, parser);

  return parser
    .text()
    .replace(/\r/g, "")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}
