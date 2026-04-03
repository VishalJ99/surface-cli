export interface ErrorEnvelope {
  schema_version: "1";
  error: {
    code: string;
    message: string;
    retryable: boolean;
    account: string | null;
    message_ref: string | null;
    thread_ref: string | null;
  };
}

export class SurfaceError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly account: string | null;
  readonly messageRef: string | null;
  readonly threadRef: string | null;

  constructor(
    code: string,
    message: string,
    options?: {
      retryable?: boolean;
      account?: string | null;
      messageRef?: string | null;
      threadRef?: string | null;
    },
  ) {
    super(message);
    this.name = "SurfaceError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.account = options?.account ?? null;
    this.messageRef = options?.messageRef ?? null;
    this.threadRef = options?.threadRef ?? null;
  }
}

export function errorToEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof SurfaceError) {
    return {
      schema_version: "1",
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        account: error.account,
        message_ref: error.messageRef,
        thread_ref: error.threadRef,
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    schema_version: "1",
    error: {
      code: "internal_error",
      message,
      retryable: false,
      account: null,
      message_ref: null,
      thread_ref: null,
    },
  };
}

export function notImplemented(message: string, account?: string): never {
  throw new SurfaceError("not_implemented", message, { account: account ?? null });
}
