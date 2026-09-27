import { SurfaceError } from "../../lib/errors.js";

export function isMicrosoftSignInUrl(pageUrl: string): boolean {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    return hostname === "login.microsoft.com"
      || hostname === "login.microsoftonline.com"
      || hostname === "login.live.com";
  } catch {
    return false;
  }
}

export function assertOutlookNotOnSignInPage(pageUrl: string): void {
  if (isMicrosoftSignInUrl(pageUrl)) {
    throw new SurfaceError(
      "reauth_required",
      "Outlook requires interactive Microsoft sign-in. Reauthenticate this account in a headful session.",
      { retryable: true },
    );
  }
}
