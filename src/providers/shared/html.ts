import type { HTMLParserLike } from "./types.js";

interface AnchorContext {
  href: string;
  partStartIndex: number;
}

class HtmlTextExtractor implements HTMLParserLike {
  private static readonly BLOCK_TAGS = new Set(["br", "div", "p", "li", "tr", "hr"]);
  private static readonly IGNORED_TAGS = new Set(["head", "script", "style"]);

  private readonly parts: string[] = [];
  private readonly anchorStack: AnchorContext[] = [];
  private ignoredDepth = 0;

  onOpenTag(tag: string, attrs: Record<string, string> = {}): void {
    if (HtmlTextExtractor.IGNORED_TAGS.has(tag)) {
      this.ignoredDepth += 1;
      return;
    }
    if (this.ignoredDepth > 0) {
      return;
    }
    if (tag === "a") {
      const href = attrs.href?.trim();
      this.anchorStack.push({
        href: href ? decodeEntities(href) : "",
        partStartIndex: this.parts.length,
      });
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
    if (tag === "a") {
      this.appendAnchorHref();
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

  private appendAnchorHref(): void {
    const anchor = this.anchorStack.pop();
    if (!anchor?.href) {
      return;
    }

    const visibleText = this.parts.slice(anchor.partStartIndex).join("");
    const hasVisibleText = /\S/.test(visibleText);
    this.trimTrailingWhitespace(anchor.partStartIndex);
    this.parts.push(hasVisibleText ? `[${anchor.href}]` : anchor.href);
  }

  private trimTrailingWhitespace(minIndex: number): void {
    while (this.parts.length > minIndex) {
      const last = this.parts.at(-1) ?? "";
      const trimmed = last.replace(/\s+$/g, "");
      if (trimmed.length === last.length) {
        return;
      }
      if (trimmed.length > 0) {
        this.parts[this.parts.length - 1] = trimmed;
        return;
      }
      this.parts.pop();
    }
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
      parser.onOpenTag(tagName, parseTagAttributes(rawTag));
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

function parseTagAttributes(rawTag: string): Record<string, string> {
  const match = rawTag.match(/^<\s*\/?\s*[^\s/>]+(.*?)\/?>$/);
  const attributeSource = match?.[1] ?? "";
  const attributes: Record<string, string> = {};
  const attributePattern =
    /([^\s"'=<>`/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let attributeMatch: RegExpExecArray | null = null;

  while ((attributeMatch = attributePattern.exec(attributeSource)) !== null) {
    const name = (attributeMatch[1] ?? "").toLowerCase();
    const value = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? "";
    if (!name || !value) {
      continue;
    }
    attributes[name] = decodeEntities(value);
  }

  return attributes;
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
