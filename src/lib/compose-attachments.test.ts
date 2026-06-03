import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  buildRawMimeMessage,
  composeAttachmentMetas,
  resolveLocalComposeAttachments,
} from "./compose-attachments.js";

test("resolveLocalComposeAttachments reads file metadata and bytes without exposing paths in public metadata", () => {
  const [attachment] = resolveLocalComposeAttachments(["tsconfig.json"]);

  assert.equal(attachment?.filename, "tsconfig.json");
  assert.equal(attachment?.mime_type, "application/json");
  assert.equal(typeof attachment?.size_bytes, "number");
  assert.ok(attachment?.content_base64);
  assert.deepEqual(composeAttachmentMetas([attachment!]), [
    {
      filename: "tsconfig.json",
      mime_type: "application/json",
      size_bytes: attachment!.size_bytes,
    },
  ]);
});

test("buildRawMimeMessage emits multipart MIME attachments and can hide Bcc for delivery copies", () => {
  const raw = buildRawMimeMessage({
    from: "surface@example.com",
    to: ["to@example.com"],
    cc: ["cc@example.com"],
    bcc: ["hidden@example.com"],
    subject: "Surface attachment probe",
    body: "Hello with file",
    messageId: "<surface-test@example.com>",
    includeBccHeader: false,
    attachments: [
      {
        path: "/tmp/report.txt",
        filename: "report.txt",
        mime_type: "text/plain",
        size_bytes: 11,
        content_base64: Buffer.from("hello file").toString("base64"),
      },
    ],
  });

  assert.match(raw, /^To: to@example\.com/m);
  assert.match(raw, /^Cc: cc@example\.com/m);
  assert.doesNotMatch(raw, /^Bcc:/m);
  assert.match(raw, /^Content-Type: multipart\/mixed; boundary="surface-/m);
  assert.match(raw, /Content-Type: text\/plain; name="report\.txt"/);
  assert.match(raw, /Content-Disposition: attachment; filename="report\.txt"/);
  assert.match(raw, new RegExp(Buffer.from("hello file").toString("base64")));
});
