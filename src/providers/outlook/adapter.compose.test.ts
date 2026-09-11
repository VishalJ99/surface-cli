import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Page } from "playwright-core";

import { SurfaceError } from "../../lib/errors.js";
import { outlookAdapterTestHooks } from "./adapter.js";
import { launchOutlookSession } from "./session.js";

async function installComposeFixture(page: Page): Promise<void> {
  await page.setContent(`
    <style>
      [contenteditable="true"] { display: block; min-height: 24px; width: 520px; border: 1px solid #777; }
      #FloatingSuggestionsList { position: fixed; inset: 0; z-index: 10; background: rgb(255 255 255 / 95%); }
      #FloatingSuggestionsList button { margin: 80px 12px; }
    </style>
    <button id="cc-toggle" type="button">Cc</button>
    <button id="bcc-toggle" type="button">Bcc</button>
    <div aria-label="To" contenteditable="true" style="display: none"></div>
    <div id="MSG_fixture_TO" role="group" data-recipient-group="To"></div>
    <div id="MSG_fixture_CC" role="group" data-recipient-group="Cc"></div>
    <div id="MSG_fixture_BCC" role="group" data-recipient-group="Bcc"></div>
    <input aria-label="Subject">
    <div role="textbox" aria-label="Message body" contenteditable="true"></div>
  `);

  await page.evaluate("globalThis.__name = (target) => target");
  await page.evaluate(() => {
    const tokenSelector = "._EType_RECIPIENT_ENTITY[contenteditable='false']";
    let pickerTimer: ReturnType<typeof setTimeout> | undefined;
    let tokenSequence = 0;

    const typedAddress = (editor: HTMLElement): string => {
      const copy = editor.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(tokenSelector).forEach((token) => token.remove());
      return (copy.textContent ?? "").replaceAll("\u200b", "").trim();
    };

    const installEditor = (label: string, existingTokens: Element[] = []): HTMLElement => {
      const group = document.querySelector(`[data-recipient-group="${label}"]`);
      if (!group) throw new Error(`Missing ${label} group`);
      const editor = document.createElement("div");
      editor.setAttribute("aria-label", label);
      editor.setAttribute("contenteditable", "true");
      editor.setAttribute("tabindex", "0");
      editor.setAttribute("aria-controls", "FloatingSuggestionsList");
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Enter") event.preventDefault();
      });
      editor.addEventListener("input", () => {
        if (pickerTimer) clearTimeout(pickerTimer);
        const address = typedAddress(editor);
        if (!address) return;
        pickerTimer = setTimeout(() => showPicker(label, address), 40);
      });
      for (const token of existingTokens) editor.append("\u200b", token, "\u200b");
      group.replaceChildren(editor);
      return editor;
    };

    const commitRecipient = (label: string, requestedAddress: string, displayName?: string): void => {
      const oldEditor = [...document.querySelectorAll<HTMLElement>(
        `[aria-label="${label}"][contenteditable="true"]`,
      )].find((candidate) => candidate.getClientRects().length > 0);
      if (!oldEditor) throw new Error(`Missing ${label} editor`);
      const existingTokens = window.__replaceExistingRecipient
        ? []
        : [...oldEditor.querySelectorAll(tokenSelector)];
      const committedAddress = window.__commitWrongAddress ? "wrong@example.test" : requestedAddress;
      const savedContact = requestedAddress === "copy@example.test"
        ? `Copy Person <${committedAddress}>`
        : null;
      const token = document.createElement("span");
      token.id = `REK_fixture_${tokenSequence++}`;
      token.className = "_Entity _EType_RECIPIENT_ENTITY _EReadonly_1";
      token.setAttribute("contenteditable", "false");
      token.setAttribute("draggable", "true");
      token.setAttribute("aria-label", displayName ? `offline${displayName}` : savedContact ?? committedAddress);
      const presence = document.createElement("span");
      presence.setAttribute("aria-hidden", "true");
      presence.textContent = "presence-glyph";
      const text = document.createElement("span");
      text.className = "textContainer-fixture individualText-fixture";
      text.textContent = displayName ?? savedContact ?? committedAddress;
      const remove = document.createElement("span");
      remove.setAttribute("aria-hidden", "true");
      remove.textContent = "remove-glyph";
      token.append(presence, text, remove);
      installEditor(label, [...existingTokens, token]);
      document.querySelector("#FloatingSuggestionsList")?.remove();
    };

    const showPicker = (label: string, address: string): void => {
      document.querySelector("#FloatingSuggestionsList")?.remove();
      const picker = document.createElement("div");
      picker.id = "FloatingSuggestionsList";
      picker.setAttribute("aria-label", "Recipient Picker");
      picker.setAttribute("role", "listbox");
      const wrong = document.createElement("button");
      wrong.type = "button";
      wrong.setAttribute("role", "option");
      wrong.setAttribute("aria-label", "Suggested Person - wrong@example.test");
      wrong.textContent = "Suggested Person - wrong@example.test";
      picker.append(wrong);
      if (!window.__omitExactAddress) {
        const exact = document.createElement("button");
        exact.type = "button";
        if (address === "two@example.test") {
          exact.setAttribute("role", "option");
          exact.setAttribute("aria-label", `Directory Two - ${address}`);
          exact.textContent = `Directory Two ${address}`;
          exact.addEventListener("click", () => commitRecipient(label, address, "Directory Two"));
        } else {
          exact.textContent = `Use this address: ${address}`;
          exact.addEventListener("click", () => commitRecipient(label, address));
        }
        picker.append(exact);
      }
      document.body.append(picker);
    };

    installEditor("To");
    document.querySelector("#cc-toggle")?.addEventListener("click", () => installEditor("Cc"));
    document.querySelector("#bcc-toggle")?.addEventListener("click", () => installEditor("Bcc"));
  });
}

async function withComposeFixture(run: (page: Page) => Promise<void>): Promise<void> {
  const profileDir = mkdtempSync(join(tmpdir(), "surface-outlook-compose-test-"));
  const session = await launchOutlookSession(profileDir, { headless: true });
  try {
    session.page.setDefaultTimeout(700);
    await installComposeFixture(session.page);
    await run(session.page);
  } finally {
    await session.context.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

async function committedRecipients(page: Page, label: "To" | "Cc" | "Bcc"): Promise<string[]> {
  return page
    .locator(`[aria-label="${label}"][contenteditable="true"] ._EType_RECIPIENT_ENTITY[contenteditable="false"]`)
    .evaluateAll((tokens) => tokens.map((token) => token.getAttribute("aria-label") ?? ""));
}

async function preloadRecipient(
  page: Page,
  label: "To" | "Cc" | "Bcc",
  address: string,
): Promise<void> {
  if (label !== "To") {
    await page.getByRole("button", { name: label, exact: true }).click();
  }
  await page.evaluate(({ recipientLabel, recipientAddress }) => {
    const editor = [...document.querySelectorAll<HTMLElement>(
      `[aria-label="${recipientLabel}"][contenteditable="true"]`,
    )].find((candidate) => candidate.getClientRects().length > 0);
    if (!editor) throw new Error(`Missing ${recipientLabel} editor`);
    const token = document.createElement("span");
    token.id = `PRELOADED_${recipientLabel}`;
    token.className = "_Entity _EType_RECIPIENT_ENTITY _EReadonly_1";
    token.setAttribute("contenteditable", "false");
    token.setAttribute("draggable", "true");
    token.setAttribute("aria-label", recipientAddress);
    const presence = document.createElement("span");
    presence.setAttribute("aria-hidden", "true");
    presence.textContent = "presence-glyph";
    const text = document.createElement("span");
    text.textContent = recipientAddress;
    const remove = document.createElement("span");
    remove.setAttribute("aria-hidden", "true");
    remove.textContent = "remove-glyph";
    token.append(presence, text, remove);
    editor.append("\u200b", token, "\u200b");
  }, { recipientLabel: label, recipientAddress: address });
}

test("Outlook compose commits exact recipients across picker overlays and field rerenders", async () => {
  await withComposeFixture(async (page) => {
    await preloadRecipient(page, "Cc", "existing@example.test");

    await outlookAdapterTestHooks.fillRecipientField(page, "To", ["one@example.test", "two@example.test"]);
    await outlookAdapterTestHooks.fillRecipientField(page, "Cc", ["copy@example.test"]);
    await outlookAdapterTestHooks.fillRecipientField(page, "Bcc", ["hidden@example.test"]);
    await page.locator('input[aria-label="Subject"]').fill("Fixture subject");
    await outlookAdapterTestHooks.fillComposeBody(page, "Fixture body");

    assert.deepEqual(await committedRecipients(page, "To"), ["one@example.test", "offlineDirectory Two"]);
    assert.deepEqual(await committedRecipients(page, "Cc"), [
      "existing@example.test",
      "Copy Person <copy@example.test>",
    ]);
    assert.deepEqual(await committedRecipients(page, "Bcc"), ["hidden@example.test"]);
    assert.equal(await page.locator('input[aria-label="Subject"]').inputValue(), "Fixture subject");
    assert.equal(await page.locator('[aria-label="Message body"]').innerText(), "Fixture body");
    assert.equal(await page.locator("#FloatingSuggestionsList").count(), 0);
  });
});

test("Outlook compose fails if committing a recipient replaces an existing chip", async () => {
  await withComposeFixture(async (page) => {
    await preloadRecipient(page, "To", "existing@example.test");
    await page.evaluate(() => { window.__replaceExistingRecipient = true; });
    await assert.rejects(
      outlookAdapterTestHooks.fillRecipientField(page, "To", ["added@example.test"]),
      (error: unknown) => error instanceof SurfaceError && error.code === "transport_error",
    );
  });
});

test("Outlook compose fails when the picker commits a different recipient", async () => {
  await withComposeFixture(async (page) => {
    await page.evaluate(() => { window.__commitWrongAddress = true; });
    await assert.rejects(
      outlookAdapterTestHooks.fillRecipientField(page, "To", ["expected@example.test"]),
      (error: unknown) => error instanceof SurfaceError && error.code === "transport_error",
    );
    assert.deepEqual(await committedRecipients(page, "To"), ["wrong@example.test"]);
  });
});

test("Outlook compose fails when the picker never offers the exact address", async () => {
  await withComposeFixture(async (page) => {
    await page.evaluate(() => { window.__omitExactAddress = true; });
    await assert.rejects(
      outlookAdapterTestHooks.fillRecipientField(page, "To", ["missing@example.test"]),
      (error: unknown) => error instanceof SurfaceError && error.code === "transport_error",
    );
    assert.deepEqual(await committedRecipients(page, "To"), []);
  });
});

declare global {
  interface Window {
    __commitWrongAddress?: boolean;
    __omitExactAddress?: boolean;
    __replaceExistingRecipient?: boolean;
  }
}
