import assert from "node:assert/strict";
import test from "node:test";

import { htmlToText } from "./html.js";

test("htmlToText preserves hyperlink targets inline with anchor text", () => {
  const html =
    '<p>See attachment at this <a href="https://www.dropbox.com/s/example">Dropbox folder here</a>.</p>';

  assert.equal(
    htmlToText(html),
    "See attachment at this Dropbox folder here[https://www.dropbox.com/s/example].",
  );
});

test("htmlToText preserves hrefs for anchors without visible text", () => {
  const html = '<p>Open <a href="https://example.com"><img src="example.png" /></a> now.</p>';

  assert.equal(htmlToText(html), "Open https://example.com now.");
});

test("htmlToText leaves non-link anchor text unchanged", () => {
  const html = "<p>Use the <a>local cache</a> if it is fresh.</p>";

  assert.equal(htmlToText(html), "Use the local cache if it is fresh.");
});
