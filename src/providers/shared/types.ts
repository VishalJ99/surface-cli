export interface HTMLParserLike {
  onOpenTag(tag: string): void;
  onCloseTag(tag: string): void;
  onText(text: string): void;
  text(): string;
}
