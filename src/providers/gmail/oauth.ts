import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

import type { MailAccount } from "../../contracts/account.js";
import { SurfaceError } from "../../lib/errors.js";
import type { ProviderContext } from "../types.js";

const GMAIL_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

const DEFAULT_CALLBACK_PORT = 8765;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface GoogleInstalledClientSecret {
  installed: {
    client_id: string;
    client_secret: string;
    auth_uri: string;
    token_uri: string;
    redirect_uris?: string[];
    project_id?: string;
  };
}

interface GmailTokenState {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export interface GmailAccessToken {
  accessToken: string;
  tokenType: string;
  scope: string;
  expiryDate: number | null;
}

function callbackPort(): number {
  const rawValue = process.env.SURFACE_GMAIL_CALLBACK_PORT;
  if (!rawValue) {
    return DEFAULT_CALLBACK_PORT;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new SurfaceError(
      "invalid_configuration",
      "SURFACE_GMAIL_CALLBACK_PORT must be a valid TCP port between 1 and 65535.",
    );
  }
  return parsed;
}

export function gmailTokenPath(context: ProviderContext): string {
  return resolve(context.accountPaths.authDir, "gmail-token.json");
}

export function gmailClientSecretPath(context: ProviderContext): string {
  return resolve(context.accountPaths.authDir, "client_secret.json");
}

function cwdClientSecretPath(): string {
  return resolve(process.cwd(), "client_secret.json");
}

function ensureAuthDir(context: ProviderContext): void {
  mkdirSync(context.accountPaths.authDir, { recursive: true });
}

function loadClientSecret(path: string): GoogleInstalledClientSecret {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GoogleInstalledClientSecret;
    if (!parsed.installed?.client_id || !parsed.installed?.client_secret) {
      throw new Error("Missing installed OAuth client fields.");
    }
    return parsed;
  } catch (error) {
    throw new SurfaceError(
      "invalid_configuration",
      `Could not read Gmail OAuth client credentials from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveClientSecretSource(context: ProviderContext): string {
  const storedPath = gmailClientSecretPath(context);
  if (existsSync(storedPath)) {
    return storedPath;
  }

  const envPath = process.env.SURFACE_GMAIL_CLIENT_SECRET_FILE;
  if (envPath) {
    const resolvedEnvPath = resolve(envPath);
    if (!existsSync(resolvedEnvPath)) {
      throw new SurfaceError(
        "not_found",
        `SURFACE_GMAIL_CLIENT_SECRET_FILE points to a missing file: ${resolvedEnvPath}`,
        {},
      );
    }
    return resolvedEnvPath;
  }

  const localPath = cwdClientSecretPath();
  if (existsSync(localPath)) {
    return localPath;
  }

  throw new SurfaceError(
    "not_found",
    "Missing Gmail OAuth desktop client credentials. Set SURFACE_GMAIL_CLIENT_SECRET_FILE or place client_secret.json in the current working directory before running Gmail auth login.",
    {},
  );
}

function copyClientSecretIntoAuthDir(sourcePath: string, context: ProviderContext): string {
  ensureAuthDir(context);
  const destinationPath = gmailClientSecretPath(context);
  if (resolve(sourcePath) !== destinationPath) {
    copyFileSync(sourcePath, destinationPath);
  }
  return destinationPath;
}

function readTokenState(context: ProviderContext): GmailTokenState {
  const tokenPath = gmailTokenPath(context);
  if (!existsSync(tokenPath)) {
    throw new SurfaceError("not_found", `No Gmail token file found at ${tokenPath}.`);
  }

  try {
    return JSON.parse(readFileSync(tokenPath, "utf8")) as GmailTokenState;
  } catch (error) {
    throw new SurfaceError(
      "invalid_configuration",
      `Could not read Gmail token state from ${tokenPath}: ${error instanceof Error ? error.message : String(error)}`,
      {},
    );
  }
}

function writeTokenState(context: ProviderContext, tokenState: GmailTokenState): void {
  ensureAuthDir(context);
  writeFileSync(gmailTokenPath(context), `${JSON.stringify(tokenState, null, 2)}\n`, "utf8");
}

function applyTokenResponse(existing: GmailTokenState | null, response: TokenResponse): GmailTokenState {
  const tokenState: GmailTokenState = {
    access_token: response.access_token,
  };

  const refreshToken = response.refresh_token ?? existing?.refresh_token;
  if (refreshToken) {
    tokenState.refresh_token = refreshToken;
  }

  const scope = response.scope ?? existing?.scope;
  if (scope) {
    tokenState.scope = scope;
  }

  tokenState.token_type = response.token_type ?? existing?.token_type ?? "Bearer";

  const expiryDate =
    typeof response.expires_in === "number" ? Date.now() + response.expires_in * 1000 : existing?.expiry_date;
  if (expiryDate) {
    tokenState.expiry_date = expiryDate;
  }

  return tokenState;
}

async function postTokenForm(
  tokenUri: string,
  params: Record<string, string>,
  account: MailAccount,
): Promise<TokenResponse> {
  const body = new URLSearchParams(params);
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new SurfaceError(
      "auth_failed",
      `Gmail token exchange failed: ${response.status} ${response.statusText} ${responseText}`.trim(),
      { account: account.name },
    );
  }

  try {
    return JSON.parse(responseText) as TokenResponse;
  } catch (error) {
    throw new SurfaceError(
      "auth_failed",
      `Gmail token exchange returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { account: account.name },
    );
  }
}

function pkceVerifier(): string {
  return randomBytes(48).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function oauthState(): string {
  return randomBytes(24).toString("hex");
}

function emitLoginInstructions(authUrl: string, port: number, account: MailAccount): void {
  process.stderr.write(
    [
      "",
      `Gmail OAuth bootstrap for account '${account.name}'`,
      `1. If you are on a remote host, run: ssh -L ${port}:127.0.0.1:${port} <host>`,
      "2. Open the URL below in a browser on the machine where localhost forwards to this host.",
      "3. Sign in to Google and approve the requested Gmail scopes.",
      "4. Wait for the browser to redirect back to localhost and Surface to finish.",
      "",
      authUrl,
      "",
    ].join("\n"),
  );
}

async function waitForAuthorizationCode(port: number, expectedState: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let settled = false;
    const server = createServer((request, response) => {
      const requestUrl = request.url ? new URL(request.url, `http://localhost:${port}`) : null;
      const code = requestUrl?.searchParams.get("code");
      const state = requestUrl?.searchParams.get("state");
      const error = requestUrl?.searchParams.get("error");

      if (error) {
        response.statusCode = 400;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end(`Surface Gmail auth failed: ${error}\n`);
        if (!settled) {
          settled = true;
          server.close();
          rejectPromise(new SurfaceError("auth_failed", `Gmail authorization returned error '${error}'.`));
        }
        return;
      }

      if (!code || !state) {
        response.statusCode = 400;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("Surface Gmail auth callback was missing the required code/state parameters.\n");
        return;
      }

      if (state !== expectedState) {
        response.statusCode = 400;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("Surface Gmail auth state mismatch.\n");
        if (!settled) {
          settled = true;
          server.close();
          rejectPromise(new SurfaceError("auth_failed", "Gmail authorization state mismatch."));
        }
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Surface Gmail auth complete. You may close this tab.\n");
      if (!settled) {
        settled = true;
        server.close();
        resolvePromise(code);
      }
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectPromise(
        new SurfaceError(
          "auth_failed",
          error.code === "EADDRINUSE"
            ? `Port ${port} is already in use. Set SURFACE_GMAIL_CALLBACK_PORT to a free port and retry Gmail auth login.`
            : `Could not start Gmail callback server on port ${port}: ${error.message}`,
        ),
      );
    });

    server.listen(port, "127.0.0.1");

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      rejectPromise(
        new SurfaceError(
          "auth_failed",
          `Timed out waiting for the Gmail OAuth callback on port ${port}.`,
          { retryable: true },
        ),
      );
    }, CALLBACK_TIMEOUT_MS);

    server.on("close", () => {
      clearTimeout(timer);
    });
  });
}

async function fetchAuthenticatedEmail(accessToken: string, account: MailAccount): Promise<string | null> {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new SurfaceError(
      "auth_failed",
      `Could not fetch the authenticated Gmail profile: ${response.status} ${response.statusText}`,
      { account: account.name },
    );
  }

  const payload = (await response.json()) as { emailAddress?: string };
  return payload.emailAddress ?? null;
}

export async function runGmailLogin(account: MailAccount, context: ProviderContext): Promise<{
  authenticatedEmail: string | null;
}> {
  const sourceClientSecretPath = resolveClientSecretSource(context);
  const storedClientSecretPath = copyClientSecretIntoAuthDir(sourceClientSecretPath, context);
  const clientSecret = loadClientSecret(storedClientSecretPath);

  const port = callbackPort();
  const redirectUri = `http://localhost:${port}`;
  const state = oauthState();
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);

  const authorizationUrl = new URL(clientSecret.installed.auth_uri);
  authorizationUrl.searchParams.set("client_id", clientSecret.installed.client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", GMAIL_OAUTH_SCOPES.join(" "));
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("prompt", "consent");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  emitLoginInstructions(authorizationUrl.toString(), port, account);
  const code = await waitForAuthorizationCode(port, state);

  const tokens = await postTokenForm(
    clientSecret.installed.token_uri,
    {
      client_id: clientSecret.installed.client_id,
      client_secret: clientSecret.installed.client_secret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    },
    account,
  );

  const tokenState = applyTokenResponse(null, tokens);
  writeTokenState(context, tokenState);
  const authenticatedEmail = await fetchAuthenticatedEmail(tokenState.access_token, account);
  return { authenticatedEmail };
}

export async function ensureGmailAccessToken(
  account: MailAccount,
  context: ProviderContext,
): Promise<GmailAccessToken> {
  const clientSecretPath = gmailClientSecretPath(context);
  if (!existsSync(clientSecretPath)) {
    throw new SurfaceError(
      "auth_failed",
      "Gmail auth state is incomplete because the stored client_secret.json is missing. Run 'surface auth login <account>' again.",
      { account: account.name, retryable: true },
    );
  }

  const clientSecret = loadClientSecret(clientSecretPath);
  const tokenState = readTokenState(context);
  const expiryDate = tokenState.expiry_date ?? null;
  const now = Date.now();
  const isValid = tokenState.access_token && expiryDate !== null && expiryDate - now > 60_000;

  if (isValid) {
    return {
      accessToken: tokenState.access_token,
      tokenType: tokenState.token_type ?? "Bearer",
      scope: tokenState.scope ?? "",
      expiryDate,
    };
  }

  if (!tokenState.refresh_token) {
    throw new SurfaceError(
      "auth_failed",
      "Gmail token state is missing a refresh token. Run 'surface auth login <account>' again.",
      { account: account.name, retryable: true },
    );
  }

  const refreshed = await postTokenForm(
    clientSecret.installed.token_uri,
    {
      client_id: clientSecret.installed.client_id,
      client_secret: clientSecret.installed.client_secret,
      grant_type: "refresh_token",
      refresh_token: tokenState.refresh_token,
    },
    account,
  );

  const refreshedState = applyTokenResponse(tokenState, refreshed);
  writeTokenState(context, refreshedState);
  return {
    accessToken: refreshedState.access_token,
    tokenType: refreshedState.token_type ?? "Bearer",
    scope: refreshedState.scope ?? "",
    expiryDate: refreshedState.expiry_date ?? null,
  };
}

export async function gmailAuthStatus(account: MailAccount, context: ProviderContext): Promise<{
  authenticated: boolean;
  detail: string;
}> {
  if (!existsSync(gmailTokenPath(context))) {
    return {
      authenticated: false,
      detail: "No Gmail token file found for this account.",
    };
  }

  try {
    const accessToken = await ensureGmailAccessToken(account, context);
    const email = await fetchAuthenticatedEmail(accessToken.accessToken, account);
    return {
      authenticated: true,
      detail: email ? `Authenticated as ${email}.` : "Refresh token is valid.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      authenticated: false,
      detail: message,
    };
  }
}

export function clearGmailAuthState(context: ProviderContext): void {
  rmSync(gmailTokenPath(context), { force: true });
  rmSync(gmailClientSecretPath(context), { force: true });
}
