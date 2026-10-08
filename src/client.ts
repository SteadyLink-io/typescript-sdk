import { byteLength, isBlob, isNodeRuntime, isReadableStream, prepareBody, xhrPut, type ByteProgress, type UploadData } from "./body.js";
import { SteadyLinkError, SteadyLinkNetworkError, SteadyLinkTimeoutError, SteadyLinkUploadError } from "./errors.js";
import { contentTypeFor } from "./mime.js";
import type {
  Bucket, Collection, CollectionInput, DeliveryPolicy, Fetch, FileDetails, FileListing, Page, ReplaceOptions, ReplaceResult,
  ReplaceTarget, ReplacementUpload, RequestOptions, Revision, SignedGrant, SignedLink, SignedLinkOptions, SteadyLinkClientOptions,
  UploadBatch, UploadedFile, UploadFileInput, UploadInput, UploadOptions, UploadSession, UploadSource, Visibility, WaitOptions, WebhookEvent,
} from "./types.js";
import { assetUrl, DEFAULT_API_URL, DEFAULT_APP_URL, DEFAULT_CDN_URL, type TransformOptions } from "./url.js";

/** Every presigned upload URL is signed for this content type; the stored type comes from the session. */
const STORAGE_CONTENT_TYPE = "application/octet-stream";
const TERMINAL = new Set(["ready", "blocked", "failed", "cancelled"]);
const BATCH_LIMIT = 100;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal?.reason) };
  signal?.addEventListener("abort", onAbort, { once: true });
});
const retryableStatus = (status: number) => status === 429 || status === 502 || status === 503 || status === 504;
const id = (value: string) => encodeURIComponent(value);
function query(values: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}
/** Normalizes folder segments into `a/b/` (or "" for the bucket root). */
export function joinFolder(...parts: Array<string | undefined>): string {
  const segments = parts.flatMap(part => (part ?? "").replace(/\\/g, "/").split("/")).filter(segment => segment && segment !== ".");
  if (segments.includes("..")) throw new TypeError("Folder paths cannot contain '..'");
  return segments.length ? `${segments.join("/")}/` : "";
}
async function mapLimit<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => { while (next < items.length) { const index = next++; await worker(items[index] as T, index) } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
}

/** Storage providers answer with XML (S3/R2) or JSON (API fallback); keep the useful part. */
function describeStorageError(status: number, text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) { try { return JSON.parse(trimmed) } catch { /* fall through */ } }
  const code = /<Code>([^<]+)<\/Code>/.exec(trimmed)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(trimmed)?.[1];
  if (code || message) return { detail: { code, message: `Storage rejected the upload (HTTP ${status}): ${[code, message].filter(Boolean).join(" - ")}` } };
  return trimmed ? `Storage rejected the upload (HTTP ${status}): ${trimmed.slice(0, 200)}` : `Storage rejected the upload (HTTP ${status})`;
}

export class SteadyLink {
  private readonly apiKey: string | undefined;
  private readonly accessToken: string | undefined;
  private readonly workspaceId: string | undefined;
  readonly baseUrl: string;
  readonly cdnUrl: string;
  readonly appUrl: string;
  private readonly fetcher: Fetch;
  private readonly customFetch: boolean;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: SteadyLinkClientOptions) {
    if (Boolean(options.apiKey) === Boolean(options.accessToken)) throw new TypeError("Use exactly one of apiKey or accessToken");
    const fetcher = options.fetch ?? globalThis.fetch;
    if (!fetcher) throw new TypeError("A Fetch implementation is required in this runtime");
    this.apiKey = options.apiKey;
    this.accessToken = options.accessToken;
    this.workspaceId = options.workspaceId;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.cdnUrl = (options.cdnUrl ?? DEFAULT_CDN_URL).replace(/\/+$/, "");
    this.appUrl = (options.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, "");
    this.customFetch = Boolean(options.fetch);
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 0;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { retry, timeoutMs, ...init } = options;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (this.apiKey) headers.set("X-API-Key", this.apiKey);
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (this.workspaceId) headers.set("X-Workspace-Id", this.workspaceId);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const mayRetry = retry !== false && (["GET", "HEAD", "OPTIONS"].includes(method) || headers.has("Idempotency-Key"));
    const limit = timeoutMs ?? this.timeoutMs;
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const abort = () => controller.abort(init.signal?.reason);
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      const timeout = limit > 0 ? setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), limit) : undefined;
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

  /**
   * Uploads bytes to a presigned storage URL without sending SteadyLink credentials.
   * Streams are sent with an explicit Content-Length, so large files are never buffered.
   */
  async uploadToUrl(uploadUrl: string, body: UploadData | BodyInit, contentType = STORAGE_CONTENT_TYPE, signal?: AbortSignal, options: { size?: number; onProgress?: ByteProgress } = {}): Promise<void> {
    await this.sendBytes(uploadUrl, body as UploadData, { "Content-Type": contentType }, options.size, options.onProgress, signal);
  }

  private async sendBytes(url: string, data: UploadData, headers: Record<string, string>, size: number | undefined, onProgress: ByteProgress | undefined, signal: AbortSignal | undefined): Promise<void> {
    if (onProgress && !this.customFetch && !isNodeRuntime() && typeof XMLHttpRequest !== "undefined" && !isReadableStream(data)) {
      let result: { status: number; text: string };
      try { result = await xhrPut(url, data as Blob, headers, onProgress, signal) } catch (cause) { throw new SteadyLinkNetworkError("The file upload could not be completed", cause) }
      if (result.status < 200 || result.status >= 300) throw new SteadyLinkError(result.status, describeStorageError(result.status, result.text));
      return;
    }
    const prepared = prepareBody(data, size, onProgress);
    const requestHeaders = new Headers(headers);
    if (prepared.streaming && prepared.total) requestHeaders.set("Content-Length", String(prepared.total));
    const init: RequestInit & { duplex?: "half" } = { method: "PUT", headers: requestHeaders, body: prepared.body };
    if (prepared.streaming) init.duplex = "half";
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timeout = this.uploadTimeoutMs > 0 ? setTimeout(() => controller.abort(new DOMException("Upload timed out", "TimeoutError")), this.uploadTimeoutMs) : undefined;
    init.signal = controller.signal;
    if (onProgress && !prepared.reportsProgress) onProgress(0, prepared.total);
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch (cause) {
      throw new SteadyLinkNetworkError(signal?.aborted ? "The upload was cancelled" : "The file upload could not be completed", cause);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    if (!response.ok) throw new SteadyLinkError(response.status, describeStorageError(response.status, await response.text().catch(() => "")), response.headers);
    if (onProgress) onProgress(prepared.total, prepared.total);
  }

  // ---------------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------------

  /** Stable delivery link for an asset. It survives replacements; transforms are optional. */
  link(assetId: string, options: TransformOptions = {}): string { return assetUrl(assetId, options, this.cdnUrl) }

  /** Creates a revocable, expiring link for a private asset. */
  async createSignedLink(assetId: string, options: SignedLinkOptions = {}): Promise<SignedLink> {
    const grant = await this.request<SignedGrant & { token: string }>(`/api/assets/${id(assetId)}/signed-url${query({ ttl: options.ttlSeconds, name: options.name, revision: options.revision })}`, { method: "POST" });
    return { ...grant, url: this.link(assetId, { token: grant.token }) };
  }
  listSignedLinks(assetId: string) { return this.request<{ items: SignedGrant[] }>(`/api/assets/${id(assetId)}/signed-urls`) }
  revokeSignedLink(assetId: string, grantId: string) { return this.request<unknown>(`/api/assets/${id(assetId)}/signed-urls/${id(grantId)}`, { method: "DELETE" }) }

  // ---------------------------------------------------------------------------
  // Buckets and files
  // ---------------------------------------------------------------------------

  listBuckets(limit = 100, cursor?: string) { return this.request<Page<Bucket>>(`/api/assets/${query({ limit, cursor })}`) }
  /** Finds a bucket by ID, slug, or name (case-insensitive). */
  async findBucket(ref: string): Promise<Bucket | undefined> {
    const needle = ref.toLowerCase();
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.listBuckets(100, cursor);
      const match = result.items.find(bucket => bucket.id === ref || bucket.slug?.toLowerCase() === needle || bucket.name.toLowerCase() === needle);
      if (match) return match;
      if (!result.nextCursor || result.items.length < 100) return undefined;
      cursor = result.nextCursor;
    }
    return undefined;
  }
  createBucket(name: string, slug?: string) { return this.request<{ id: string }>("/api/assets/", { method: "POST", body: JSON.stringify(slug ? { name, slug } : { name }) }) }
  getBucket(bucketId: string) { return this.request<Bucket>(`/api/assets/${id(bucketId)}`) }
  /** @deprecated Use getBucket for buckets or getFile for file assets. */
  getAsset(assetId: string) { return this.request<Record<string, unknown>>(`/api/assets/${id(assetId)}`) }
  /** Deletes a bucket and everything in it. This cannot be undone. */
  deleteBucket(bucketId: string) { return this.request<unknown>(`/api/assets/${id(bucketId)}`, { method: "DELETE" }) }

  /** Lists the folders and files directly inside `prefix` (the bucket root by default). */
  listFiles(bucketId: string, options: { prefix?: string } = {}) {
    return this.request<FileListing>(`/api/assets/${id(bucketId)}/objects${query({ prefix: options.prefix ? joinFolder(options.prefix) : undefined })}`);
  }
  /** Lists files across every bucket in the workspace. */
  listAllFiles(options: { limit?: number; cursor?: string } = {}) {
    return this.request<Page<FileListing["items"][number]>>(`/api/assets/objects${query({ limit: options.limit, cursor: options.cursor })}`);
  }
  /** Reads a file by its stable asset ID, including its bucket and key. */
  getFile(assetId: string) { return this.request<FileDetails>(`/api/assets/object/${id(assetId)}/stat`) }
  /** Reads a file by bucket and key. */
  statFile(bucketId: string, key: string) { return this.request<FileDetails>(`/api/assets/${id(bucketId)}/objects/stat${query({ key })}`) }
  setVisibility(bucketId: string, key: string, visibility: Visibility | "inherit") {
    return this.request<{ updated: boolean }>(`/api/assets/${id(bucketId)}/objects/visibility${query({ key, visibility })}`, { method: "POST" });
  }
  /** Deletes a file, all of its revisions, and cached transforms. Its link stops working. */
  deleteFile(bucketId: string, key: string) { return this.request<{ deleted: boolean }>(`/api/assets/${id(bucketId)}/objects${query({ key })}`, { method: "DELETE" }) }
  renameFile(bucketId: string, fromKey: string, toKey: string) {
    return this.request<{ renamed: boolean }>(`/api/assets/${id(bucketId)}/objects/rename${query({ from_key: fromKey, to_key: toKey })}`, { method: "POST" });
  }
  createFolder(bucketId: string, path: string) { return this.request<unknown>(`/api/assets/${id(bucketId)}/folders${query({ path })}`, { method: "POST" }) }

  // ---------------------------------------------------------------------------
  // Uploads
  // ---------------------------------------------------------------------------

  createUploadBatch(bucketId: string, files: UploadInput[]) {
    return this.request<UploadBatch>("/api/upload-batches", { method: "POST", body: JSON.stringify({ bucketId, files: files.map(({ filename, size, contentType, path }) => ({ filename, size, contentType: contentType ?? "application/octet-stream", path: path ?? "" })) }) });
  }
  getUploadBatch(batchId: string) { return this.request<UploadBatch>(`/api/upload-batches/${id(batchId)}`) }
  completeUpload(uploadSessionId: string, idempotencyKey = `complete-${uploadSessionId}`) { return this.request<UploadSession>(`/api/upload-sessions/${id(uploadSessionId)}/complete`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey } }) }
  cancelUpload(uploadSessionId: string) { return this.request<UploadSession>(`/api/upload-sessions/${id(uploadSessionId)}`, { method: "DELETE" }) }

  /** Sends the bytes for one upload session, directly to storage or through the API. */
  async sendUploadBytes(session: Pick<UploadSession, "id" | "uploadUrl" | "expectedSize">, data: UploadData, options: { onProgress?: ByteProgress; signal?: AbortSignal; via?: "presigned" | "api" } = {}): Promise<void> {
    const size = session.expectedSize ?? byteLength(data);
    if (options.via === "api") {
      const headers: Record<string, string> = { "Content-Type": STORAGE_CONTENT_TYPE };
      if (this.apiKey) headers["X-API-Key"] = this.apiKey;
      if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
      if (this.workspaceId) headers["X-Workspace-Id"] = this.workspaceId;
      await this.sendBytes(`${this.baseUrl}/api/upload-sessions/${id(session.id)}/content`, data, headers, size, options.onProgress, options.signal);
      return;
    }
    if (!session.uploadUrl) throw new SteadyLinkError(500, "The API did not return a presigned upload URL");
    await this.sendBytes(session.uploadUrl, data, { "Content-Type": STORAGE_CONTENT_TYPE }, size, options.onProgress, options.signal);
  }

  /** Polls an upload batch until the given sessions (or all of them) are ready, blocked, failed, or cancelled. */
  async waitForUploads(batchId: string, sessionIds?: string[], options: WaitOptions = {}): Promise<UploadBatch> {
    const deadline = Date.now() + (options.timeoutMs ?? 300_000);
    let interval = options.intervalMs ?? 750;
    while (true) {
      const batch = await this.getUploadBatch(batchId);
      const watched = sessionIds ? batch.files.filter(file => sessionIds.includes(file.id)) : batch.files;
      if (watched.every(file => TERMINAL.has(file.status))) return batch;
      if (Date.now() >= deadline) throw new SteadyLinkTimeoutError(`Upload batch ${batchId} was still processing after ${options.timeoutMs ?? 300_000} ms`);
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
      interval = Math.min(interval * 1.5, 3_000);
    }
  }

  /**
   * Uploads one or more files and returns their stable links.
   *
   * Handles batching (100 files per batch), parallel byte uploads, completion,
   * optional finalization wait, and optional visibility changes.
   */
  async upload(bucketId: string, input: UploadSource | UploadSource[], options: UploadOptions = {}): Promise<UploadedFile[]> {
    const sources = (Array.isArray(input) ? input : [input]).map(source => {
      const size = source.size ?? byteLength(source.data);
      if (size === undefined) throw new TypeError(`size is required for streamed file ${source.filename}`);
      const blobType = isBlob(source.data) ? source.data.type : "";
      return { ...source, size, contentType: source.contentType || blobType || contentTypeFor(source.filename), path: joinFolder(options.folder, source.path) };
    });
    const wait = options.visibility ? (options.wait === false ? true : options.wait ?? true) : options.wait ?? true;
    const waitOptions: WaitOptions = typeof wait === "object" ? { ...wait } : {};
    if (options.signal && !waitOptions.signal) waitOptions.signal = options.signal;
    const results: UploadedFile[] = [];

    for (let offset = 0; offset < sources.length; offset += BATCH_LIMIT) {
      const chunk = sources.slice(offset, offset + BATCH_LIMIT);
      const batch = await this.createUploadBatch(bucketId, chunk);
      const sessions = new Map<string, UploadSession>();
      const failures = new Map<string, { code: string; message: string }>();
      await mapLimit(chunk, options.concurrency ?? 4, async (source, index) => {
        const session = batch.files[index];
        if (!session) throw new SteadyLinkError(500, "The API returned fewer upload sessions than requested");
        sessions.set(session.id, session);
        const onProgress = options.onProgress ? (loaded: number, total: number) => options.onProgress?.({ filename: source.filename, index: offset + index, loaded, total }) : undefined;
        try {
          const sendOptions: { onProgress?: ByteProgress; signal?: AbortSignal; via?: "presigned" | "api" } = {};
          if (onProgress) sendOptions.onProgress = onProgress;
          if (options.signal) sendOptions.signal = options.signal;
          if (options.via) sendOptions.via = options.via;
          await this.sendUploadBytes(session, source.data, sendOptions);
          sessions.set(session.id, { ...session, ...(await this.completeUpload(session.id)) });
        } catch (error) {
          if (options.signal?.aborted) throw error;
          failures.set(session.id, { code: error instanceof SteadyLinkError && error.code ? error.code : "upload_failed", message: error instanceof Error ? error.message : String(error) });
          await this.cancelUpload(session.id).catch(() => undefined);
        }
      });

      const pending = [...sessions.keys()].filter(sessionId => !failures.has(sessionId));
      if (wait && pending.length) {
        const finished = await this.waitForUploads(batch.id, pending, waitOptions);
        for (const file of finished.files) if (sessions.has(file.id)) sessions.set(file.id, file);
      }

      for (const session of batch.files) {
        const current = sessions.get(session.id) ?? session;
        const key = `${current.path ?? ""}${current.filename}`;
        const result: UploadedFile = {
          uploadSessionId: current.id,
          batchId: batch.id,
          bucketId,
          filename: current.filename,
          key,
          status: failures.has(current.id) ? "failed" : current.status,
          assetId: failures.has(current.id) ? null : current.objectAssetId ?? null,
          revisionNumber: current.revisionNumber ?? null,
          url: current.objectAssetId && !failures.has(current.id) ? this.link(current.objectAssetId) : null,
          error: failures.get(current.id) ?? current.error ?? null,
        };
        if (options.visibility && result.status === "ready") {
          await this.setVisibility(bucketId, key, options.visibility);
          result.visibility = options.visibility;
        }
        results.push(result);
      }
    }

    const failed = results.filter(result => result.error || ["failed", "blocked", "cancelled"].includes(result.status));
    if (failed.length && options.throwOnError !== false) {
      const first = failed[0];
      throw new SteadyLinkUploadError(`${failed.length} of ${results.length} uploads failed${first?.error ? `: ${first.filename}: ${first.error.message}` : ""}`, results);
    }
    return results;
  }

  /** Creates, uploads, and completes one file without waiting for finalization. */
  async uploadFile(bucketId: string, file: UploadFileInput, signal?: AbortSignal) {
    const batch = await this.createUploadBatch(bucketId, [file]);
    const upload = batch.files[0];
    if (!upload?.uploadUrl) throw new SteadyLinkError(500, "The API did not return a presigned upload URL");
    await this.sendBytes(upload.uploadUrl, file.data as UploadData, { "Content-Type": STORAGE_CONTENT_TYPE }, file.size, undefined, signal);
    return this.completeUpload(upload.id);
  }

  // ---------------------------------------------------------------------------
  // Replacement and revisions
  // ---------------------------------------------------------------------------

  createReplacementUpload(bucketId: string, size: number, contentType = "application/octet-stream") {
    return this.request<ReplacementUpload>(`/api/assets/${id(bucketId)}/objects/upload-temp${query({ size, content_type: contentType })}`, { method: "POST" });
  }
  finishReplacement(bucketId: string, key: string, tempKey: string, originalFilename?: string) {
    return this.request<{ replaced: boolean; version: number }>(`/api/assets/${id(bucketId)}/objects/replace${query({ key, upload_temp_key: tempKey, original_filename: originalFilename })}`, { method: "POST" });
  }

  /**
   * Publishes new bytes as the next revision of an existing file. The asset ID
   * and every link to it stay the same. `target` is an asset ID or `{ bucketId, key }`.
   */
  async replace(target: ReplaceTarget, source: UploadSource, options: ReplaceOptions = {}): Promise<ReplaceResult> {
    let bucketId: string;
    let key: string;
    let assetId: string | null = null;
    if (typeof target === "string" || "assetId" in target) {
      assetId = typeof target === "string" ? target : target.assetId;
      const details = await this.getFile(assetId);
      if (!details.bucketId) throw new SteadyLinkError(404, `Asset ${assetId} is not linked to a bucket file`);
      bucketId = details.bucketId;
      key = details.key;
    } else {
      ({ bucketId, key } = target);
    }
    const size = source.size ?? byteLength(source.data);
    if (size === undefined) throw new TypeError("size is required when replacing with a stream");
    const contentType = source.contentType || (isBlob(source.data) ? source.data.type : "") || contentTypeFor(source.filename);
    const pending = await this.createReplacementUpload(bucketId, size, contentType);
    await this.sendBytes(pending.uploadUrl, source.data, { "Content-Type": STORAGE_CONTENT_TYPE }, size, options.onProgress, options.signal);
    const result = await this.finishReplacement(bucketId, key, pending.tempKey, source.filename);
    if (!assetId) assetId = await this.statFile(bucketId, key).then(file => file.objectAssetId, () => null);
    return { ...result, bucketId, key, assetId, url: assetId ? this.link(assetId) : null };
  }

  /** @deprecated Use replace({ bucketId, key }, file). */
  async replaceFile(bucketId: string, key: string, file: Omit<UploadFileInput, "path">, signal?: AbortSignal) {
    const replacement = await this.createReplacementUpload(bucketId, file.size, file.contentType ?? "application/octet-stream");
    await this.sendBytes(replacement.uploadUrl, file.data as UploadData, { "Content-Type": STORAGE_CONTENT_TYPE }, file.size, undefined, signal);
    return this.finishReplacement(bucketId, key, replacement.tempKey, file.filename);
  }

  /** Lists retained revisions, newest first. */
  listVersions(assetId: string) { return this.request<Revision[]>(`/api/assets/${id(assetId)}/versions`) }
  updateVersion(assetId: string, version: number, changes: { label?: string | null; note?: string | null }) {
    return this.request<Pick<Revision, "id" | "versionNumber" | "label" | "note">>(`/api/assets/${id(assetId)}/versions/${version}`, { method: "PATCH", body: JSON.stringify(changes) });
  }
  /** Makes a retained revision current again. Links keep working and now serve that revision. */
  promoteVersion(assetId: string, version: number) {
    return this.request<{ promoted: boolean; versionNumber: number; revisionId: string }>(`/api/assets/${id(assetId)}/versions/${version}/promote`, { method: "POST" });
  }
  /** Alias for promoteVersion. */
  rollback(assetId: string, version: number) { return this.promoteVersion(assetId, version) }
  deleteVersion(assetId: string, version: number, options: { force?: boolean } = {}) {
    return this.request<unknown>(`/api/assets/${id(assetId)}/versions/${version}${query({ force: options.force ? "true" : undefined })}`, { method: "DELETE" });
  }

  // ---------------------------------------------------------------------------
  // Collections
  // ---------------------------------------------------------------------------

  private withPortalUrl<T extends { slug: string }>(collection: T): T & { url: string } { return { ...collection, url: `${this.appUrl}/c/${encodeURIComponent(collection.slug)}` } }
  async listCollections(): Promise<{ items: Collection[] }> {
    const result = await this.request<{ items: Array<Omit<Collection, "url">> }>("/api/collections");
    return { items: result.items.map(item => this.withPortalUrl(item)) };
  }
  async createCollection(input: CollectionInput): Promise<Collection> { return this.withPortalUrl(await this.request<Omit<Collection, "url">>("/api/collections", { method: "POST", body: JSON.stringify(input) })) }
  async getCollection(collectionId: string): Promise<Collection> { return this.withPortalUrl(await this.request<Omit<Collection, "url">>(`/api/collections/${id(collectionId)}`)) }
  async updateCollection(collectionId: string, changes: Partial<CollectionInput>): Promise<Collection> {
    return this.withPortalUrl(await this.request<Omit<Collection, "url">>(`/api/collections/${id(collectionId)}`, { method: "PATCH", body: JSON.stringify(changes) }));
  }
  deleteCollection(collectionId: string) { return this.request<void>(`/api/collections/${id(collectionId)}`, { method: "DELETE" }) }
  /** Adds an asset. Pass `version` to pin a revision; omit it to follow the current revision. */
  addToCollection(collectionId: string, assetId: string, version?: number) {
    return this.request<Record<string, unknown>>(`/api/collections/${id(collectionId)}/items`, { method: "POST", body: JSON.stringify(version ? { assetId, version } : { assetId }) });
  }
  removeFromCollection(collectionId: string, itemId: string) { return this.request<void>(`/api/collections/${id(collectionId)}/items/${id(itemId)}`, { method: "DELETE" }) }
  pinCollectionItem(collectionId: string, itemId: string, version: number | null) {
    return this.request<Record<string, unknown>>(`/api/collections/${id(collectionId)}/items/${id(itemId)}`, { method: "PATCH", body: JSON.stringify({ version }) });
  }
  reorderCollection(collectionId: string, itemIds: string[]) {
    return this.request<Record<string, unknown>>(`/api/collections/${id(collectionId)}/items/order`, { method: "PUT", body: JSON.stringify({ itemIds }) });
  }

  // ---------------------------------------------------------------------------
  // Platform controls
  // ---------------------------------------------------------------------------

  createMigration(bucketId: string, files: UploadInput[]) { return this.request<{ id: string; status: string; uploadBatch: UploadBatch }>("/api/platform/migrations", { method: "POST", body: JSON.stringify({ bucketId, files }) }) }
  listMigrations() { return this.request<{ items: Array<Record<string, unknown>> }>("/api/platform/migrations") }
  setFocalPoint(assetId: string, x: number, y: number) { return this.request<{ x: number; y: number }>(`/api/platform/assets/${id(assetId)}/focal-point`, { method: "PUT", body: JSON.stringify({ x, y }) }) }
  listDeliveryDomains() { return this.request<{ items: Array<Record<string, unknown>> }>("/api/platform/domains") }
  addDeliveryDomain(hostname: string) { return this.request<Record<string, unknown>>("/api/platform/domains", { method: "POST", body: JSON.stringify({ hostname }) }) }
  verifyDeliveryDomain(domainId: string) { return this.request<Record<string, unknown>>(`/api/platform/domains/${id(domainId)}/verify`, { method: "POST" }) }
  getDeliveryPolicy() { return this.request<DeliveryPolicy>("/api/platform/delivery-policy") }
  setDeliveryPolicy(policy: Pick<DeliveryPolicy, "mode" | "countries"> & { storageRegion?: string }) { return this.request<DeliveryPolicy>("/api/platform/delivery-policy", { method: "PUT", body: JSON.stringify(policy) }) }
  createWebhook(url: string, events: WebhookEvent[]) { return this.request<Record<string, unknown>>("/api/platform/webhooks", { method: "POST", body: JSON.stringify({ url, events }) }) }
  listWebhooks() { return this.request<{ availableEvents: WebhookEvent[]; items: Array<Record<string, unknown>> }>("/api/platform/webhooks") }
  testWebhook(webhookId: string) { return this.request<{ queued: boolean }>(`/api/platform/webhooks/${id(webhookId)}/test`, { method: "POST" }) }
  configureSso(configuration: { issuer: string; clientId: string; clientSecret?: string; emailDomains: string[]; enabled: boolean; enforce: boolean }) { return this.request<Record<string, unknown>>("/api/platform/sso", { method: "PUT", body: JSON.stringify(configuration) }) }
}
