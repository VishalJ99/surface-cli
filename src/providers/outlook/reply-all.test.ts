import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { clickReplyAllAction } from "./adapter.js";

const executablePath = process.env.SURFACE_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

for (const mode of ["button", "menuitem-button", "overflow"] as const) {
  test(`reply-all opens one composer through ${mode} with hidden duplicates`, async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <button aria-label="Reply all" style="display:none">Hidden</button>
        ${mode === "overflow" ? `
          <div role="menuitem" aria-label="Reply all" onclick="window.wrong = true">Unrelated toolbar action</div>
          <button aria-label="More items" onclick="document.querySelector('[role=menu]').hidden = false">More</button>
          <div role="menu" hidden><div role="menuitem" aria-label="Reply all" onclick="compose()">Reply all</div></div>
        ` : `<button aria-label="Reply all" role="${mode === "button" ? "button" : "menuitem"}" onclick="compose()">Reply all</button>`}
        <div aria-label="Reply all" role="menuitem" style="display:none" onclick="window.wrong = true">Hidden overflow copy</div>
        <script>
          window.calls = 0;
          function compose() {
            window.calls++;
            const menu = document.querySelector('[role=menu]');
            if (menu) menu.hidden = true;
            setTimeout(() => {
              const body = document.createElement('div');
              body.setAttribute('role', 'textbox');
              body.setAttribute('aria-label', 'Message body');
              body.contentEditable = 'true';
              body.textContent = 'Ready';
              document.body.appendChild(body);
            }, 100);
          }
        </script>`);
      await clickReplyAllAction(page);
      assert.equal(await page.locator('[role="textbox"]:visible').count(), 1);
      assert.deepEqual(await page.evaluate(() => ({calls: (window as any).calls, wrong: !!(window as any).wrong})), {calls: 1, wrong: false});
    } finally {
      await browser.close();
    }
  });
}
