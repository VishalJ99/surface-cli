import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { sanitizeDownloadedAttachmentFilename } from "./attachment-filename.js";

test("downloaded attachment filenames cannot traverse out of the target directory", () => {
  const targetDir = resolve(join(tmpdir(), "surface-download-target"));
  const unsafeNames = [
    "../../../../Library/LaunchAgents/payload.plist",
    "..\\..\\private\\payload.txt",
    "folder/subfolder/file.pdf",
    "folder:classic-mac-path.txt",
  ];

  for (const unsafeName of unsafeNames) {
    const sanitized = sanitizeDownloadedAttachmentFilename(unsafeName);
    const targetPath = resolve(join(targetDir, `att_01__${sanitized}`));
    const child = relative(targetDir, targetPath);
    assert.equal(child.startsWith(".."), false, unsafeName);
    assert.equal(/[\\/]/u.test(sanitized), false, unsafeName);
  }
});

test("downloaded attachment filename sanitizer preserves readable names and has a fallback", () => {
  assert.equal(sanitizeDownloadedAttachmentFilename("  quarterly   report.pdf  "), "quarterly report.pdf");
  assert.equal(sanitizeDownloadedAttachmentFilename(""), "attachment");
});
