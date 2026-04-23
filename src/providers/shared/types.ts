export interface HTMLParserLike {
  onOpenTag(tag: string, attrs?: Record<string, string>): void;
  onCloseTag(tag: string): void;
  onText(text: string): void;
  text(): string;
}
