import assert from "node:assert/strict";
import test from "node:test";

import { SurfaceError } from "../../lib/errors.js";
import { assertOutlookNotOnSignInPage, isMicrosoftSignInUrl } from "./auth-state.js";

test("Outlook FIDO bridge is identified as a sign-in page", () => {
  const url = "https://login.microsoft.com/organizations/bridge/fido?iiv=1";
  assert.equal(isMicrosoftSignInUrl(url), true);
  assert.throws(
    () => assertOutlookNotOnSignInPage(url),
    (error: unknown) => error instanceof SurfaceError
      && error.code === "reauth_required"
      && error.retryable,
  );
});

test("Outlook mailbox remains eligible for readiness polling", () => {
  const url = "https://outlook.office.com/mail/inbox";
  assert.equal(isMicrosoftSignInUrl(url), false);
  assert.doesNotThrow(() => assertOutlookNotOnSignInPage(url));
});
