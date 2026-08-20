export type Fetch = typeof globalThis.fetch;

export interface SteadyLinkClientOptions {
  /** A server-side management API key. Never expose this value in browser code. */
  apiKey?: string;
  /** A short-lived user access token. */
  accessToken?: string;
  workspaceId?: string;
  baseUrl?: string;
  fetch?: Fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface UploadInput { filename: string; size: number; contentType?: string; path?: string }
export interface UploadFileInput extends UploadInput { data: BodyInit }
export interface UploadSession {
  id: string;
  batchId: string;
  bucketId: string;
  objectAssetId: string | null;
  filename: string;
  path: string;
  contentType: string;
  expectedSize: number;
  status: string;
  revisionNumber: number | null;
  error: { code: string; message: string } | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  uploadUrl?: string;
}
export interface UploadBatch { id: string; status: string; totalFiles: number; completedFiles?: number; failedFiles?: number; files: UploadSession[] }
export interface DeliveryPolicy { mode: "all" | "allow" | "deny"; countries: string[]; storageRegion: string; availableStorageRegions?: string[] }
export type WebhookEvent = "asset.revision.published" | "asset.scan.completed" | "asset.delivery.threshold" | "migration.completed";
export interface ReplacementUpload { uploadUrl: string; tempKey: string }
export interface RequestOptions extends RequestInit { /** Retries are enabled for safe methods and requests carrying an idempotency key. */ retry?: boolean }

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

export class SteadyLinkNetworkError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) { super(message); this.name = "SteadyLinkNetworkError"; this.cause = cause }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const retryableStatus = (status: number) => status === 429 || status === 502 || status === 503 || status === 504;

export class SteadyLink {
  private readonly apiKey: string | undefined;
  private readonly accessToken: string | undefined;
  private readonly workspaceId: string | undefined;
  private readonly baseUrl: string;
  private readonly fetcher: Fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: SteadyLinkClientOptions) {
    if (Boolean(options.apiKey) === Boolean(options.accessToken)) throw new TypeError("Use exactly one of apiKey or accessToken");
    const fetcher = options.fetch ?? globalThis.fetch;
    if (!fetcher) throw new TypeError("A Fetch implementation is required in this runtime");
    this.apiKey = options.apiKey;
    this.accessToken = options.accessToken;
    this.workspaceId = options.workspaceId;
    this.baseUrl = (options.baseUrl ?? "https://api.steadylink.io").replace(/\/$/, "");
    this.fetcher = fetcher;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
  }

  async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (this.apiKey) headers.set("X-API-Key", this.apiKey);
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (this.workspaceId) headers.set("X-Workspace-Id", this.workspaceId);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const mayRetry = init.retry !== false && (["GET", "HEAD", "OPTIONS"].includes(method) || headers.has("Idempotency-Key"));
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const abort = () => controller.abort(init.signal?.reason);
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, method, headers, signal: controller.signal });
      } catch (cause) {
        clearTimeout(timeout);
        init.signal?.removeEventListener("abort", abort);
        if (mayRetry && attempt < this.maxRetries && !init.signal?.aborted) { await sleep(250 * 2 ** attempt++); continue }
        throw new SteadyLinkNetworkError(init.signal?.aborted ? "The SteadyLink request was cancelled" : "The SteadyLink API could not be reached", cause);
      }
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abort);
      const contentType = response.headers.get("content-type") ?? "";
      const body = response.status === 204 ? undefined : contentType.includes("json") ? await response.json().catch(() => undefined) : await response.text().catch(() => undefined);
      if (response.ok) return body as T;
      if (mayRetry && retryableStatus(response.status) && attempt < this.maxRetries) {
        const retryAfter = response.headers.get("retry-after");
        await sleep(retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : 250 * 2 ** attempt++);
        continue;
      }
      throw new SteadyLinkError(response.status, body, response.headers);
    }
  }

  listBuckets(limit = 100) { return this.request<{ items: Array<{ id: string; name: string; slug?: string }> }>(`/api/assets/?limit=${encodeURIComponent(String(limit))}`) }
  getAsset(assetId: string) { return this.request<Record<string, unknown>>(`/api/assets/${encodeURIComponent(assetId)}`) }
  createUploadBatch(bucketId: string, files: UploadInput[]) {
    return this.request<UploadBatch>("/api/upload-batches", { method: "POST", body: JSON.stringify({ bucketId, files: files.map(({ filename, size, contentType, path }) => ({ filename, size, contentType: contentType ?? "application/octet-stream", path: path ?? "" })) }) });
  }
  /** Uploads bytes to a presigned URL without leaking SteadyLink credentials. */
  async uploadToUrl(uploadUrl: string, body: BodyInit, contentType = "application/octet-stream", signal?: AbortSignal): Promise<void> {
    const init: RequestInit = { method: "PUT", headers: { "Content-Type": contentType }, body };
    if (signal) init.signal = signal;
    const response = await this.fetcher(uploadUrl, init);
    if (!response.ok) throw new SteadyLinkError(response.status, await response.text().catch(() => response.statusText), response.headers);
  }
  async uploadFile(bucketId: string, file: UploadFileInput, signal?: AbortSignal) {
    const batch = await this.createUploadBatch(bucketId, [file]);
    const upload = batch.files[0];
    if (!upload?.uploadUrl) throw new SteadyLinkError(500, "The API did not return a presigned upload URL");
    await this.uploadToUrl(upload.uploadUrl, file.data, file.contentType ?? "application/octet-stream", signal);
    return this.completeUpload(upload.id);
  }
  completeUpload(uploadSessionId: string, idempotencyKey = `complete-${uploadSessionId}`) { return this.request<Record<string, unknown>>(`/api/upload-sessions/${encodeURIComponent(uploadSessionId)}/complete`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey } }) }
  cancelUpload(uploadSessionId: string) { return this.request<void>(`/api/upload-sessions/${encodeURIComponent(uploadSessionId)}`, { method: "DELETE" }) }
  createReplacementUpload(bucketId: string, size: number, contentType = "application/octet-stream") { const query = new URLSearchParams({ size: String(size), content_type: contentType }); return this.request<ReplacementUpload>(`/api/assets/${encodeURIComponent(bucketId)}/objects/upload-temp?${query}`, { method: "POST" }) }
  finishReplacement(bucketId: string, key: string, tempKey: string, originalFilename?: string) { const query = new URLSearchParams({ key, upload_temp_key: tempKey }); if (originalFilename) query.set("original_filename", originalFilename); return this.request<{ replaced: boolean; version: number }>(`/api/assets/${encodeURIComponent(bucketId)}/objects/replace?${query}`, { method: "POST" }) }
  async replaceFile(bucketId: string, key: string, file: Omit<UploadFileInput, "path">, signal?: AbortSignal) {
    const replacement = await this.createReplacementUpload(bucketId, file.size, file.contentType ?? "application/octet-stream");
    await this.uploadToUrl(replacement.uploadUrl, file.data, file.contentType ?? "application/octet-stream", signal);
    return this.finishReplacement(bucketId, key, replacement.tempKey, file.filename);
  }
  createMigration(bucketId: string, files: UploadInput[]) { return this.request<{ id: string; status: string; uploadBatch: UploadBatch }>("/api/platform/migrations", { method: "POST", body: JSON.stringify({ bucketId, files }) }) }
  setFocalPoint(assetId: string, x: number, y: number) { return this.request<{ x: number; y: number }>(`/api/platform/assets/${encodeURIComponent(assetId)}/focal-point`, { method: "PUT", body: JSON.stringify({ x, y }) }) }
  listDeliveryDomains() { return this.request<{ items: Array<Record<string, unknown>> }>("/api/platform/domains") }
  addDeliveryDomain(hostname: string) { return this.request<Record<string, unknown>>("/api/platform/domains", { method: "POST", body: JSON.stringify({ hostname }) }) }
  verifyDeliveryDomain(domainId: string) { return this.request<Record<string, unknown>>(`/api/platform/domains/${encodeURIComponent(domainId)}/verify`, { method: "POST" }) }
  getDeliveryPolicy() { return this.request<DeliveryPolicy>("/api/platform/delivery-policy") }
  setDeliveryPolicy(policy: Pick<DeliveryPolicy, "mode" | "countries"> & { storageRegion?: string }) { return this.request<DeliveryPolicy>("/api/platform/delivery-policy", { method: "PUT", body: JSON.stringify(policy) }) }
  createWebhook(url: string, events: WebhookEvent[]) { return this.request<Record<string, unknown>>("/api/platform/webhooks", { method: "POST", body: JSON.stringify({ url, events }) }) }
  listWebhooks() { return this.request<{ availableEvents: WebhookEvent[]; items: Array<Record<string, unknown>> }>("/api/platform/webhooks") }
  testWebhook(webhookId: string) { return this.request<{ queued: boolean }>(`/api/platform/webhooks/${encodeURIComponent(webhookId)}/test`, { method: "POST" }) }
  listMigrations() { return this.request<{ items: Array<Record<string, unknown>> }>("/api/platform/migrations") }
  configureSso(configuration: { issuer: string; clientId: string; clientSecret?: string; emailDomains: string[]; enabled: boolean; enforce: boolean }) { return this.request<Record<string, unknown>>("/api/platform/sso", { method: "PUT", body: JSON.stringify(configuration) }) }
}
