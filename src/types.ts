import type { UploadData } from "./body.js";

export type Fetch = typeof globalThis.fetch;
export type Visibility = "public" | "private";

export interface SteadyLinkClientOptions {
  /** A server-side management API key. Never expose this value in browser code. */
  apiKey?: string;
  /** A short-lived user access token. */
  accessToken?: string;
  workspaceId?: string;
  /** API origin. Defaults to https://api.steadylink.io. */
  baseUrl?: string;
  /** Delivery origin used to build links. Defaults to https://cdn.steadylink.io. */
  cdnUrl?: string;
  /** Web app origin used to build collection portal links. Defaults to https://steadylink.io. */
  appUrl?: string;
  fetch?: Fetch;
  /** Timeout for JSON API calls. Byte uploads are not limited unless `uploadTimeoutMs` is set. */
  timeoutMs?: number;
  /** Timeout for byte uploads in milliseconds. Defaults to 0 (no timeout). */
  uploadTimeoutMs?: number;
  maxRetries?: number;
}

export interface RequestOptions extends RequestInit {
  /** Retries are enabled for safe methods and requests carrying an idempotency key. */
  retry?: boolean;
  /** Per-request timeout override. 0 disables the timeout. */
  timeoutMs?: number;
}

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface Bucket {
  id: string;
  name: string;
  slug: string | null;
  kind?: string;
  createdAt?: string;
  isPrivate?: boolean;
  settings?: unknown;
}

export interface FolderEntry { name: string; path: string }

export interface FileEntry {
  /** Bucket listing row ID. */
  id: string;
  /** Stable asset ID used in `/a/{assetId}` links. Null until finalization links the file. */
  objectAssetId: string | null;
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
  visibility: Visibility;
  contentType: string | null;
  bucketId?: string;
  bucketName?: string;
  parent?: string | null;
}

export interface FileListing { prefix: string; folders: FolderEntry[]; items: FileEntry[]; revision: string | null }

export interface FileDetails {
  bucketId?: string;
  key: string;
  id: string | null;
  objectAssetId: string | null;
  size: number;
  contentType: string | null;
  etag?: string | null;
  lastModified: string | null;
  metadata?: Record<string, string>;
  assetVersionId?: string | null;
  scanStatus?: string | null;
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

/** One file for `upload()`. `size` is required only when `data` is a stream. */
export interface UploadSource {
  filename: string;
  data: UploadData;
  size?: number;
  /** Stored content type. Guessed from the filename when omitted. */
  contentType?: string;
  /** Folder inside the bucket, for example `campaign/launch/`. Joined after `UploadOptions.folder`. */
  path?: string;
}

export interface UploadProgress { filename: string; index: number; loaded: number; total: number }

export interface WaitOptions { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }

export interface UploadOptions {
  /** Folder prefix applied to every file. */
  folder?: string;
  /** Set each finished file to public or private. Implies `wait`. */
  visibility?: Visibility;
  /** Wait for finalization so each result has an asset ID and link. Defaults to true. */
  wait?: boolean | WaitOptions;
  /** Parallel byte uploads. Defaults to 4. */
  concurrency?: number;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /**
   * `presigned` (default) sends bytes straight to object storage.
   * `api` streams bytes through the SteadyLink API, for networks that block the storage host.
   */
  via?: "presigned" | "api";
  /** Throw SteadyLinkUploadError when any file fails. Defaults to true. */
  throwOnError?: boolean;
}

export interface UploadedFile {
  uploadSessionId: string;
  batchId: string;
  bucketId: string;
  filename: string;
  /** Bucket-relative key, for example `campaign/hero.webp`. */
  key: string;
  /** `ready`, `committing`, `scanning`, `blocked`, `failed`, or `cancelled`. */
  status: string;
  assetId: string | null;
  revisionNumber: number | null;
  /** Stable delivery link. Null until the asset ID is known. */
  url: string | null;
  visibility?: Visibility;
  error: { code: string; message: string } | null;
}

export type ReplaceTarget = string | { assetId: string } | { bucketId: string; key: string };

export interface ReplaceOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ReplaceResult {
  replaced: boolean;
  version: number;
  bucketId: string;
  key: string;
  assetId: string | null;
  url: string | null;
}

export interface ReplacementUpload { uploadUrl: string; tempKey: string }

export interface Revision {
  id: string;
  versionNumber: number;
  storageKey?: string;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  mime: string | null;
  hash: string | null;
  label: string | null;
  note: string | null;
  createdBy?: string | null;
  isCurrent: boolean;
  scanStatus: string | null;
  metadataStatus: string | null;
  createdAt: string;
}

export interface SignedLinkOptions {
  /** Lifetime in seconds. The API clamps it between 60 and 2,592,000. Default 300. */
  ttlSeconds?: number;
  /** Internal label, up to 200 characters. */
  name?: string;
  /** Pin the grant to one revision. Omit to follow the current revision. */
  revision?: number;
}

export interface SignedGrant { id: string; name: string | null; revisionNumber: number | null; expiresAt: string; revokedAt?: string | null; createdAt?: string }
export interface SignedLink extends SignedGrant { token: string; url: string }

export type CollectionAccessMode = "public" | "private" | "password" | "expiring";

export interface CollectionInput {
  name: string;
  description?: string;
  accessMode?: CollectionAccessMode;
  password?: string;
  expiresAt?: string;
  noindex?: boolean;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  accessMode: CollectionAccessMode;
  expiresAt: string | null;
  noindex: boolean;
  viewCount: number;
  downloadCount: number;
  itemCount: number | null;
  createdAt: string;
  updatedAt: string;
  branding?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
  /** Portal URL built from `appUrl` and the slug. */
  url: string;
}

export interface DeliveryPolicy { mode: "all" | "allow" | "deny"; countries: string[]; storageRegion: string; availableStorageRegions?: string[] }
export type WebhookEvent = "asset.revision.published" | "asset.scan.completed" | "asset.delivery.threshold" | "migration.completed";
