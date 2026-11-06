import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Page, APIRequestContext } from "playwright-core";
import { assertSavedCompose, findSavedAttachment, OutlookComposeReceipt, savedComposeIds } from "./compose-receipt.js";
import { fetchConversationBundle } from "./extract.js";

const body = "Hello,\n\nOne.\nTwo.\n\nBest,\nTester";
const item = { IsDraft: true, ItemId: { Id: "draft-1" }, Body: { BodyType: "HTML", Value: body.replaceAll("\n", "<br>") } };
const attachment = { filename: "photo.jpg", mime_type: "image/jpeg", size_bytes: 3, content_base64: "YWJj", path: "/unused/photo.jpg" };
const saved = { Name: "photo.jpg", Size: 3, IsInline: true, AttachmentId: { Id: "att-1" } };
const captured = { serviceUrl: "https://example.test/owa/service.svc", headers: {} };
const response = (data: any) => ({ ok: () => true, status: () => 200, json: async () => data, dispose: async () => {} });
const itemResponse = (value: any) => ({ Body: { ResponseMessages: { Items: [{ ResponseClass: "Success", Items: [value] }] } } });

test("saved body equality rejects empty, missing, truncated, and changed interior breaks", () => {
  assertSavedCompose(item, body);
  for (const bad of [
    { ...item, Body: { Value: "" } }, { ...item, Body: undefined },
    { ...item, Body: { ...item.Body, IsTruncated: true } },
    { ...item, Body: { Value: body.replaceAll("\n", "<br><br>") } },
    { ...item, IsDraft: false },
  ]) assert.throws(() => assertSavedCompose(bad, body), /body|draft/i);
});

test("draft receipt selects exact save IDs, not subject or thread ordering", () => {
  assert.deepEqual(savedComposeIds(itemResponse(item)), ["draft-1"]);
  assert.deepEqual(savedComposeIds(itemResponse({ ...item, IsDraft: false })), []);
  assert.deepEqual(savedComposeIds({ Body: { ResponseMessages: { Items: [{ ResponseClass: "Error", Items: [item] }] } } }), []);
});

test("image uploads are verified from provider metadata without filename UI text", () => {
  assert.equal(findSavedAttachment({ Attachments: [saved] }, attachment), saved);
  // Exchange Size includes transport overhead; only downloaded bytes establish equality.
  assert.equal(findSavedAttachment({ Attachments: [{ ...saved, Size: 173 }] }, attachment)?.Name, "photo.jpg");
  assert.equal(findSavedAttachment({ Attachments: [saved] }, attachment, new Set(["att-1"])), undefined);
});

function fixture(value: any, bytes = "abc") {
  const page = Object.assign(new EventEmitter(), { waitForTimeout: async () => {} }) as unknown as Page;
  const request = {
    post: async () => response(itemResponse(value)),
    get: async () => ({ ...response({}), body: async () => Buffer.from(bytes) }),
  } as unknown as APIRequestContext;
  const receipt = new OutlookComposeReceipt(page, request, captured);
  receipt.ids.add("draft-1");
  return receipt;
}

test("persisted image bytes must match even when filename and size match", async () => {
  const good = fixture({ ...item, Attachments: [saved] });
  await good.verify(body, [attachment], 1);
  good.stop();
  const bad = fixture({ ...item, Attachments: [saved] }, "xyz");
  await assert.rejects(bad.verify(body, [attachment], 1), /byte-for-byte/);
  bad.stop();
});

test("finalization fails hard on an empty saved reply body and keeps the draft identity", async () => {
  const receipt = fixture({ ...item, Body: { Value: "" } });
  await assert.rejects(receipt.verify(body, [], 1), /read-back differs/);
  assert.deepEqual([...receipt.ids], ["draft-1"]);
  receipt.stop();
});

test("missing upload and ambiguous saved identities never report success", async () => {
  const receipt = fixture(item);
  await assert.rejects(receipt.verify(body, [attachment], 1), /not been persisted/);
  receipt.ids.add("draft-2");
  await assert.rejects(receipt.read(), /Multiple/);
  receipt.stop();
});

test("conversation refresh hydrates draft body from full GetItem, not an empty fragment", async () => {
  const request = { post: async (url: string) => response(url.includes("GetItem&")
    ? itemResponse(item)
    : { Body: { ResponseMessages: { Items: [{ Conversation: { ConversationNodes: [{ Items: [{ ...item, Body: undefined, UniqueBody: { Value: "" } }] }] } }] } } }),
  } as unknown as APIRequestContext;
  const bundle = await fetchConversationBundle(request, captured, "conversation-1");
  assert.deepEqual(bundle.entries[0]?.item.Body, item.Body);
  assert.equal(bundle.entries[0]?.item.UniqueBody, undefined);
});

test("canonical body write targets only the observed unsent draft with escaped HTML", async () => {
  const page = Object.assign(new EventEmitter(), { waitForTimeout: async () => {} }) as unknown as Page;
  let patched: any;
  const request = {
    post: async () => response(itemResponse(item)),
    patch: async (url: string, options: any) => { patched = { url, options }; return response({}); },
  } as unknown as APIRequestContext;
  const receipt = new OutlookComposeReceipt(page, request, captured);
  receipt.ids.add("draft-1");
  await receipt.replaceBody("Hello <&>\n\nBody");
  assert.match(patched.url, /messages\('draft-1'\)/);
  assert.deepEqual(patched.options.data, { Body: { ContentType: "HTML", Content: "Hello &lt;&amp;&gt;<br><br>Body" } });
  receipt.stop();
});

test("send-by-ID refuses an empty provider body before any send request", async () => {
  const receipt = fixture({ ...item, Body: { Value: "" } });
  await assert.rejects(receipt.sendVerifiedDraft(body, [], 1), /read-back differs/);
  receipt.stop();
});

test("send-by-ID sends the exact verified draft, not a newly serialized compose", async () => {
  const page = Object.assign(new EventEmitter(), { waitForTimeout: async () => {} }) as unknown as Page;
  const sends: string[] = [];
  const request = { post: async (url: string) => {
    if (url.endsWith("/send")) { sends.push(url); return { ...response({}), status: () => 202 }; }
    return response(itemResponse(item));
  } } as unknown as APIRequestContext;
  const receipt = new OutlookComposeReceipt(page, request, captured);
  receipt.ids.add("draft-1");
  await receipt.sendVerifiedDraft(body, [], 1);
  assert.equal(sends.length, 1);
  assert.match(sends[0]!, /messages\('draft-1'\)\/send$/);
  receipt.stop();
});
