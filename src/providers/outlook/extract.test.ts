import assert from "node:assert/strict";
import test from "node:test";

import type {
  APIRequestContext,
  APIResponse,
  BrowserContext,
  Page,
  Request,
} from "playwright-core";

import { captureOutlookServiceSession, fetchConversationBundle } from "./extract.js";

type RequestListener = (request: Request) => unknown;

class FakeBrowserContext {
  private readonly requestListeners = new Set<RequestListener>();
  offCalls = 0;

  on(event: "request", listener: RequestListener): this {
    assert.equal(event, "request");
    this.requestListeners.add(listener);
    return this;
  }

  off(event: "request", listener: RequestListener): this {
    assert.equal(event, "request");
    this.offCalls += 1;
    this.requestListeners.delete(listener);
    return this;
  }

  emitRequest(request: Request): void {
    for (const listener of this.requestListeners) {
      listener(request);
    }
  }

  listenerCount(): number {
    return this.requestListeners.size;
  }
}

function serviceRequest(): Request {
  return {
    resourceType: () => "fetch",
    url: () => "https://outlook.office.com/owa/service.svc?action=GetConversationItems",
    headers: () => ({
      authorization: "Bearer test",
      "x-anchormailbox": "test@example.com",
      "x-owa-hosted-ux": "true",
      "x-owa-sessionid": "session-test",
      "x-req-source": "Mail",
      prefer: "outlook.body-content-type=html",
      "user-agent": "surface-test",
    }),
  } as unknown as Request;
}

function mailboxPage(onGoto: () => void | Promise<void>): Page {
  const page = {
    goto: async () => {
      await onGoto();
      return null;
    },
    locator: (selector: string) => {
      if (selector === "body") {
        return {
          innerText: async () => "Inbox",
        };
      }
      if (selector === '[role="listbox"]') {
        return {
          first: () => ({
            waitFor: async () => undefined,
          }),
        };
      }
      throw new Error(`Unexpected locator '${selector}'.`);
    },
    waitForTimeout: async () => undefined,
    url: () => "https://outlook.office.com/mail/",
  };
  return page as unknown as Page;
}

test("captureOutlookServiceSession removes its request listener after success", async () => {
  const context = new FakeBrowserContext();
  const page = mailboxPage(() => {
    context.emitRequest(serviceRequest());
  });

  const result = await captureOutlookServiceSession(
    context as unknown as BrowserContext,
    page,
    { timeoutMs: 1_000 },
  );

  assert.equal(result.serviceUrl, "https://outlook.office.com/owa/service.svc");
  assert.equal(context.listenerCount(), 0);
  assert.equal(context.offCalls, 1);
});

test("captureOutlookServiceSession removes its request listener after failure", async () => {
  const context = new FakeBrowserContext();
  const page = mailboxPage(() => {
    throw new Error("navigation failed");
  });

  await assert.rejects(
    captureOutlookServiceSession(
      context as unknown as BrowserContext,
      page,
      { timeoutMs: 1_000 },
    ),
    /navigation failed/,
  );

  assert.equal(context.listenerCount(), 0);
  assert.equal(context.offCalls, 1);
});

class FakeAPIResponse {
  disposeCalls = 0;

  constructor(
    private readonly responseOk: boolean,
    private readonly responseStatus: number,
    private readonly responseJson: () => Promise<unknown>,
  ) {}

  ok(): boolean {
    return this.responseOk;
  }

  status(): number {
    return this.responseStatus;
  }

  json(): Promise<unknown> {
    return this.responseJson();
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

function requestContextReturning(response: FakeAPIResponse): APIRequestContext {
  return {
    post: async () => response as unknown as APIResponse,
  } as unknown as APIRequestContext;
}

const capturedSession = {
  serviceUrl: "https://outlook.office.com/owa/service.svc",
  headers: {},
};

test("fetchConversationBundle disposes a successful response body", async () => {
  const response = new FakeAPIResponse(true, 200, async () => ({
    Body: {
      ResponseMessages: {
        Items: [{ Conversation: { ConversationNodes: [] } }],
      },
    },
  }));

  const bundle = await fetchConversationBundle(
    requestContextReturning(response),
    capturedSession,
    "conversation-1",
  );

  assert.deepEqual(bundle, { conversationId: "conversation-1", entries: [] });
  assert.equal(response.disposeCalls, 1);
});

test("fetchConversationBundle disposes a non-success response body", async () => {
  const response = new FakeAPIResponse(false, 503, async () => ({}));

  await assert.rejects(
    fetchConversationBundle(
      requestContextReturning(response),
      capturedSession,
      "conversation-2",
    ),
    /status 503/,
  );

  assert.equal(response.disposeCalls, 1);
});

test("fetchConversationBundle disposes its response when JSON parsing fails", async () => {
  const response = new FakeAPIResponse(true, 200, async () => {
    throw new Error("invalid json");
  });

  await assert.rejects(
    fetchConversationBundle(
      requestContextReturning(response),
      capturedSession,
      "conversation-3",
    ),
    /invalid json/,
  );

  assert.equal(response.disposeCalls, 1);
});
