function errorMessage(status: number, body: unknown): string {
  if (typeof body === "string" && body) return body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const detail = record.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).message === "string") return String((detail as Record<string, unknown>).message);
    if (typeof record.message === "string") return record.message;
  }
  return `SteadyLink request failed with HTTP ${status}`;
}

/** A non-success response returned by the SteadyLink API or a presigned storage URL. */
export class SteadyLinkError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, body: unknown, headers?: Headers) {
    super(errorMessage(status, body));
    this.name = "SteadyLinkError";
    this.status = status;
    const record = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
    this.detail = record?.detail ?? body;
    const detail = this.detail && typeof this.detail === "object" ? this.detail as Record<string, unknown> : undefined;
    this.code = typeof (detail?.code ?? record?.code) === "string" ? String(detail?.code ?? record?.code) : undefined;
    this.requestId = headers?.get("x-request-id") ?? (typeof record?.requestId === "string" ? record.requestId : undefined);
    const retryAfter = headers?.get("retry-after");
    this.retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : undefined;
  }
}

/** The request never produced an HTTP response (DNS, TLS, timeout, or cancellation). */
export class SteadyLinkNetworkError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) { super(message); this.name = "SteadyLinkNetworkError"; this.cause = cause }
}

/** An upload finished processing too slowly for the configured wait timeout. */
export class SteadyLinkTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "SteadyLinkTimeoutError" }
}

/** One or more files in an `upload()` call failed. `results` holds every file's outcome. */
export class SteadyLinkUploadError<T = unknown> extends Error {
  readonly results: T[];
  constructor(message: string, results: T[]) { super(message); this.name = "SteadyLinkUploadError"; this.results = results }
}
