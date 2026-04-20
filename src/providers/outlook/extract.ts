import { errors, type APIRequestContext, type BrowserContext, type Page } from "playwright-core";

const DEFAULT_OUTLOOK_URL = "https://outlook.office.com/mail/";
const OWA_REQUIRED_HEADER_KEYS = [
  "authorization",
  "x-anchormailbox",
  "x-owa-hosted-ux",
  "x-owa-sessionid",
  "x-req-source",
  "prefer",
  "user-agent",
] as const;

export interface OutlookCapturedSession {
  serviceUrl: string;
  headers: Record<string, string>;
}

export interface OutlookMessageRow {
  instanceKey: string;
  conversationId: string;
  ariaLabel: string;
  text: string;
}

export interface OutlookConversationItem {
  item: Record<string, unknown>;
  nodeMetadata: {
    parentInternetMessageId: string | null;
    hasQuotedText: boolean | null;
    isRootNode: boolean | null;
  };
}

export interface OutlookThreadBundle {
  conversationId: string;
  entries: OutlookConversationItem[];
}

async function bodyText(page: Page): Promise<string> {
  try {
    return await page.locator("body").innerText({ timeout: 2_000 });
  } catch {
    return "";
  }
}

async function maybeAdvanceAccountPicker(page: Page): Promise<boolean> {
  const text = await bodyText(page);
  if (!text.includes("Pick an account")) {
    return false;
  }

  for (const selector of [
    '[data-bind="text: session.tileDisplayName"]',
    '[data-bind="text: session.signInName"]',
  ]) {
    const locator = page.locator(selector);
    if ((await locator.count()) === 1) {
      await locator.first().click({ noWaitAfter: true });
      return true;
    }
  }

  const candidates = page.locator("div, button");
  const count = Math.min(await candidates.count(), 30);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    let textValue = "";
    try {
      textValue = (await candidate.innerText({ timeout: 500 })).trim();
    } catch {
      continue;
    }
    if (!textValue) {
      continue;
    }
    const lowered = textValue.toLowerCase();
    if (
      lowered.includes("use another account")
      || lowered.includes("terms of use")
      || lowered.includes("privacy")
    ) {
      continue;
    }
    if (!textValue.includes("@") && !textValue.includes("\n")) {
      continue;
    }
    await candidate.click({ noWaitAfter: true });
    return true;
  }

  return false;
}

async function waitForMessageList(page: Page, timeoutMs: number): Promise<void> {
  await page.locator('[role="listbox"]').first().waitFor({ timeout: timeoutMs });
}

export async function waitForOutlookMailboxReady(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (await maybeAdvanceAccountPicker(page)) {
      await page.waitForTimeout(1_500);
      continue;
    }

    try {
      await waitForMessageList(page, Math.min(2_000, Math.max(500, deadline - Date.now())));
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(750);
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new errors.TimeoutError("Timed out waiting for Outlook mailbox UI.");
}

function hasCompleteOwaHeaders(headers: Record<string, string>): boolean {
  return OWA_REQUIRED_HEADER_KEYS.every((key) => Boolean(headers[key]));
}

function inferServiceUrlFromMailboxUrl(mailboxUrl: string): string | null {
  try {
    const parsed = new URL(mailboxUrl);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (!path.startsWith("mail")) {
      return `${parsed.origin}/owa/service.svc`;
    }
    const segments = path.split("/");
    const mailboxSuffix = segments[1] || "";
    return mailboxSuffix ? `${parsed.origin}/owa/${mailboxSuffix}/service.svc` : `${parsed.origin}/owa/service.svc`;
  } catch {
    return null;
  }
}

export async function captureOutlookServiceSession(
  context: BrowserContext,
  page: Page,
  options: { outlookUrl?: string; timeoutMs: number },
): Promise<OutlookCapturedSession> {
  const headers: Record<string, string> = {};
  const observedServiceUrls: string[] = [];
  let preferredServiceUrl: string | null = null;
  let fallbackServiceUrl: string | null = null;

  context.on("request", (request) => {
    if (!["fetch", "xhr"].includes(request.resourceType())) {
      return;
    }
    if (!request.url().includes("/service.svc")) {
      return;
    }

    const rawServiceUrl = request.url().split("?", 1)[0] ?? request.url();
    if (!observedServiceUrls.includes(rawServiceUrl) && observedServiceUrls.length < 8) {
      observedServiceUrls.push(rawServiceUrl);
    }
    if (!fallbackServiceUrl) {
      fallbackServiceUrl = rawServiceUrl;
    }
    if (!rawServiceUrl.includes("/published/service.svc")) {
      preferredServiceUrl = rawServiceUrl;
    }

    const source = request.headers();
    for (const key of OWA_REQUIRED_HEADER_KEYS) {
      const value = source[key];
      if (value && !headers[key]) {
        headers[key] = value;
      }
    }
  });

  await page.goto(options.outlookUrl ?? DEFAULT_OUTLOOK_URL, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });
  await waitForOutlookMailboxReady(page, options.timeoutMs);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(3_000);
    const serviceUrl = preferredServiceUrl ?? inferServiceUrlFromMailboxUrl(page.url()) ?? fallbackServiceUrl;
    if (serviceUrl && hasCompleteOwaHeaders(headers)) {
      return {
        serviceUrl,
        headers,
      };
    }

    if (attempt === 0) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs });
      await waitForOutlookMailboxReady(page, options.timeoutMs);
      continue;
    }

    if (attempt === 1) {
      await applyUnreadFilter(page);
    }
  }

  throw new Error(
    `Could not capture Outlook service headers. Observed service URLs: ${observedServiceUrls.join(", ") || "none"}.`,
  );
}

export async function applyUnreadFilter(page: Page): Promise<void> {
  const filterButton = page.getByRole("button", { name: "Filter" }).first();
  await filterButton.waitFor({ timeout: 20_000 });
  await filterButton.click();
  await page.waitForTimeout(800);
  await page.locator("text=/^Unread$/").first().click();
  await page.waitForTimeout(2_000);
}

async function locateSearchBox(page: Page) {
  const candidates = [
    page.getByRole("searchbox", { name: /search/i }),
    page.getByRole("combobox", { name: /search/i }),
    page.getByRole("textbox", { name: /search/i }),
    page.locator('[role="searchbox"]'),
    page.locator('[role="combobox"][aria-label*="Search" i]'),
    page.locator('input[aria-label*="Search" i]'),
    page.locator('input[placeholder*="Search" i]'),
    page.locator('textarea[aria-label*="Search" i]'),
  ];

  for (const locator of candidates) {
    if ((await locator.count()) === 0) {
      continue;
    }
    const candidate = locator.first();
    try {
      await candidate.waitFor({ timeout: 2_000 });
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("Could not locate the Outlook search box.");
}

export async function applySearchQuery(page: Page, query: string): Promise<void> {
  const searchBox = await locateSearchBox(page);
  await searchBox.click();
  await page.waitForTimeout(500);
  try {
    await searchBox.press("Meta+A");
  } catch {
    try {
      await searchBox.press("Control+A");
    } catch {
      // Ignore if selection shortcuts are unavailable.
    }
  }
  await searchBox.fill(query);
  await searchBox.press("Enter");
  await page.waitForTimeout(3_000);
  await waitForMessageList(page, 30_000);
  await resetMessageListToTop(page);
}

async function collectVisibleRows(page: Page): Promise<OutlookMessageRow[]> {
  return page.locator('[role="option"]').evaluateAll((elements) =>
    elements.map((element) => ({
      instanceKey: element.id || "",
      conversationId: element.getAttribute("data-convid") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      text: ((element as HTMLElement).innerText || "").trim(),
    })),
  );
}

async function resetMessageListToTop(page: Page): Promise<void> {
  await page.locator('[role="listbox"]').first().evaluate((element) => {
    const candidates = [element, ...element.querySelectorAll("*")];
    const target = candidates.find((node) => node.scrollHeight > node.clientHeight + 5) as HTMLElement | undefined;
    (target ?? (element as HTMLElement)).scrollTop = 0;
  });
  await page.waitForTimeout(500);
}

async function scrollMessageList(page: Page): Promise<{ before: number; after: number }> {
  return page.locator('[role="listbox"]').first().evaluate((element) => {
    const candidates = [element, ...element.querySelectorAll("*")];
    const target = (candidates.find((node) => node.scrollHeight > node.clientHeight + 5) as HTMLElement | undefined)
      ?? (element as HTMLElement);
    const before = target.scrollTop;
    const delta = Math.max(Math.floor(target.clientHeight * 0.85), 600);
    target.scrollTop = Math.min(target.scrollTop + delta, target.scrollHeight);
    return {
      before,
      after: target.scrollTop,
    };
  });
}

async function maybeExpandFilteredResults(page: Page): Promise<boolean> {
  const searchLink = page.getByText("run a search for all filtered items", { exact: false });
  if ((await searchLink.count()) === 0) {
    return false;
  }
  await searchLink.first().click();
  await page.waitForTimeout(2_000);
  await resetMessageListToTop(page);
  return true;
}

async function collectRows(
  page: Page,
  options: {
    keyForRow: (row: OutlookMessageRow) => string;
    maxResults?: number;
    allowServerSearchExpansion?: boolean;
  },
): Promise<OutlookMessageRow[]> {
  const seen = new Map<string, OutlookMessageRow>();
  let stagnantRounds = 0;
  let expandedServerResults = false;

  await resetMessageListToTop(page);

  while (stagnantRounds < 4) {
    let grew = false;
    for (const row of await collectVisibleRows(page)) {
      const key = options.keyForRow(row);
      if (!key) {
        continue;
      }
      if (!seen.has(key)) {
        seen.set(key, row);
        grew = true;
        if (options.maxResults && seen.size >= options.maxResults) {
          return [...seen.values()];
        }
      }
    }

    const scrollState = await scrollMessageList(page);
    await page.waitForTimeout(800);
    const moved = scrollState.after > scrollState.before;

    if (grew || moved) {
      stagnantRounds = 0;
      continue;
    }

    if (options.allowServerSearchExpansion && !expandedServerResults && await maybeExpandFilteredResults(page)) {
      expandedServerResults = true;
      stagnantRounds = 0;
      continue;
    }

    stagnantRounds += 1;
  }

  return [...seen.values()];
}

function conversationRowKey(row: OutlookMessageRow): string {
  return row.conversationId;
}

function searchResultRowKey(row: OutlookMessageRow): string {
  if (row.instanceKey) {
    return row.instanceKey;
  }
  if (row.conversationId || row.ariaLabel || row.text) {
    return `${row.conversationId}|${row.ariaLabel}|${row.text}`;
  }
  return "";
}

export async function collectUnreadConversationIds(
  page: Page,
  limit: number,
): Promise<string[]> {
  const rows = await collectRows(page, {
    keyForRow: conversationRowKey,
    maxResults: limit,
    allowServerSearchExpansion: true,
  });
  return rows.map((row) => row.conversationId).filter(Boolean);
}

export async function collectCurrentConversationIds(
  page: Page,
  limit: number,
): Promise<string[]> {
  const rows = await collectRows(page, {
    keyForRow: conversationRowKey,
    maxResults: limit,
  });
  return rows.map((row) => row.conversationId).filter(Boolean);
}

export async function collectSearchConversationIds(
  page: Page,
  limit: number,
): Promise<string[]> {
  const rows = await collectRows(page, {
    keyForRow: searchResultRowKey,
    maxResults: limit,
  });
  const seen = new Set<string>();
  const conversationIds: string[] = [];
  for (const row of rows) {
    if (!row.conversationId || seen.has(row.conversationId)) {
      continue;
    }
    seen.add(row.conversationId);
    conversationIds.push(row.conversationId);
  }
  return conversationIds;
}

function buildConversationPayload(conversationId: string): Record<string, unknown> {
  return {
    __type: "GetConversationItemsJsonRequest:#Exchange",
    Header: {
      __type: "JsonRequestHeaders:#Exchange",
      RequestServerVersion: "V2017_08_18",
      TimeZoneContext: {
        __type: "TimeZoneContext:#Exchange",
        TimeZoneDefinition: {
          __type: "TimeZoneDefinitionType:#Exchange",
          Id: "GMT Standard Time",
        },
      },
    },
    Body: {
      __type: "GetConversationItemsRequest:#Exchange",
      Conversations: [
        {
          __type: "ConversationRequestType:#Exchange",
          ConversationId: { __type: "ItemId:#Exchange", Id: conversationId },
          SyncState: "",
        },
      ],
      ItemShape: {
        __type: "ItemResponseShape:#Exchange",
        BaseShape: "IdOnly",
        AddBlankTargetToLinks: true,
        BlockContentFromUnknownSenders: false,
        BlockExternalImagesIfSenderUntrusted: true,
        ClientSupportsIrm: true,
        CssScopeClassName: "rps_export",
        FilterHtmlContent: true,
        FilterInlineSafetyTips: true,
        InlineImageCustomDataTemplate: "{id}",
        InlineImageUrlTemplate:
          "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAEALAAAAAABAAEAAAIBTAA7",
        MaximumBodySize: 2_097_152,
        MaximumRecipientsToReturn: 100,
        ImageProxyCapability: "OwaAndConnectorsProxy",
        AdditionalProperties: [{ __type: "PropertyUri:#Exchange", FieldURI: "CanDelete" }],
        InlineImageUrlOnLoadTemplate: "",
        ExcludeBindForInlineAttachments: true,
        CalculateOnlyFirstBody: true,
        BodyShape: "UniqueFragment",
      },
      ShapeName: "ItemPart",
      SortOrder: "DateOrderDescending",
      MaxItemsToReturn: 100,
      Action: "ReturnRootNode",
      FoldersToIgnore: [],
      ReturnSubmittedItems: true,
      ReturnDeletedItems: true,
    },
  };
}

function buildOwaHeaders(baseHeaders: Record<string, string>, action: string): Record<string, string> {
  return {
    ...baseHeaders,
    action,
    "content-type": "application/json; charset=utf-8",
  };
}

export async function fetchConversationBundle(
  requestContext: APIRequestContext,
  session: OutlookCapturedSession,
  conversationId: string,
): Promise<OutlookThreadBundle> {
  const response = await requestContext.post(`${session.serviceUrl}?action=GetConversationItems&app=Mail&n=999`, {
    headers: buildOwaHeaders(session.headers, "GetConversationItems"),
    data: JSON.stringify(buildConversationPayload(conversationId)),
  });

  if (!response.ok()) {
    throw new Error(
      `GetConversationItems failed with status ${response.status()} for conversation ${conversationId}.`,
    );
  }

  const data = await response.json();
  const conversationNodes = (
    data?.Body?.ResponseMessages?.Items?.[0]?.Conversation?.ConversationNodes ?? []
  ) as Array<Record<string, unknown>>;

  const entries: OutlookConversationItem[] = [];
  for (const node of conversationNodes) {
    const nodeMetadata = {
      parentInternetMessageId:
        typeof node.ParentInternetMessageId === "string" ? node.ParentInternetMessageId : null,
      hasQuotedText: typeof node.HasQuotedText === "boolean" ? node.HasQuotedText : null,
      isRootNode: typeof node.IsRootNode === "boolean" ? node.IsRootNode : null,
    };
    const items = (node.Items ?? []) as Array<Record<string, unknown>>;
    for (const item of items) {
      entries.push({ item, nodeMetadata });
    }
  }

  return {
    conversationId,
    entries,
  };
}
