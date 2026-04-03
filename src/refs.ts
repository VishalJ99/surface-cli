import { monotonicFactory } from "ulid";

const createUlid = monotonicFactory();

function buildRef(prefix: string): string {
  return `${prefix}_${createUlid()}`;
}

export function makeAccountId(): string {
  return buildRef("acc");
}

export function makeThreadRef(): string {
  return buildRef("thr");
}

export function makeMessageRef(): string {
  return buildRef("msg");
}

export function makeAttachmentId(): string {
  return buildRef("att");
}
