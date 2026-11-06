import assert from "node:assert/strict";
import test from "node:test";
import { simpleParser } from "mailparser";
import { assertComposeBody, normalizeComposeBody, composeBodyHtml } from "./compose-body.js";
import { buildRawMimeMessage } from "./compose-attachments.js";
import { htmlToText } from "../providers/shared/html.js";

const body = "Hello,\n\nFirst paragraph.\n\nSecond paragraph.\nSame paragraph.\n\n1. Literal list\n- Literal bullet <&>\n\nBest,\nTester";

test("canonicalization keeps single breaks and blank paragraphs distinct", () => {
  assert.equal(normalizeComposeBody("Hello, \r\n\r\nBody\rNext\n"), "Hello,\n\nBody\nNext");
  assertComposeBody(body.replace(/\n/g, "\r\n"), body);
  for (const changed of [body.replace("paragraph.\nSame", "paragraph.\n\nSame"), body + "old draft", body.replace("1. ", "")]) {
    assert.throws(() => assertComposeBody(changed, body), /read-back differs/);
  }
});

test("HTML escapes content and retains exact breaks without block or list heuristics", () => {
  assert.equal(htmlToText(composeBodyHtml(body)), body);
  assert.equal(htmlToText("One<br/>Two<br /><br/>Three"), "One\nTwo\n\nThree");
});

for (const attachments of [[], [{path: "/tmp/test.txt", filename: "test.txt", mime_type: "text/plain", size_bytes: 1, content_base64: "eA=="}]]) {
  test(`MIME roundtrip preserves paragraphs with ${attachments.length} attachments`, async () => {
    const raw = buildRawMimeMessage({from: "self@example.test", to: ["self@example.test"], cc: [], bcc: [], subject: "Spacing", body: body.replace(/\n/g, "\r"), attachments});
    assert.doesNotMatch(raw, /(?<!\r)\n|\r(?!\n)/);
    assertComposeBody((await simpleParser(raw)).text ?? "", body);
  });
}
