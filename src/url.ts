export const DEFAULT_API_URL = "https://api.steadylink.io";
export const DEFAULT_CDN_URL = "https://cdn.steadylink.io";
export const DEFAULT_APP_URL = "https://steadylink.io";

export type ImageFormat = "webp" | "jpg" | "png";
export type ImageFit = "cover" | "contain" | "inside" | "outside";

/** Delivery parameters understood by `GET /a/{asset_id}`. */
export interface TransformOptions {
  /** Pin delivery to one retained revision. Omit to follow the current revision. */
  version?: number;
  /** Target width in pixels. */
  width?: number;
  /** Target height in pixels. */
  height?: number;
  /** Output format. */
  format?: ImageFormat;
  /** Output quality. The API accepts 30 to 95; values are clamped. */
  quality?: number;
  fit?: ImageFit;
  /** `auto` picks high-detail framing when `fit` is `cover`. */
  focus?: "center" | "auto";
  /** Explicit focal point, each coordinate 0 to 1. Use with `fit: "cover"`. */
  focalPoint?: { x: number; y: number };
  /** Signed access token for a private asset. */
  token?: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Applies transform options to a URLSearchParams instance, overwriting existing keys. */
export function applyTransform(params: URLSearchParams, options: TransformOptions = {}): URLSearchParams {
  if (options.version !== undefined) params.set("v", String(Math.trunc(options.version)));
  if (options.width) params.set("w", String(Math.round(options.width)));
  if (options.height) params.set("h", String(Math.round(options.height)));
  if (options.format) params.set("fm", options.format);
  if (options.quality !== undefined) params.set("q", String(Math.round(clamp(options.quality, 30, 95))));
  if (options.fit) params.set("fit", options.fit);
  if (options.focus) params.set("focus", options.focus);
  if (options.focalPoint) {
    params.set("fp-x", String(clamp(options.focalPoint.x, 0, 1)));
    params.set("fp-y", String(clamp(options.focalPoint.y, 0, 1)));
  }
  if (options.token) params.set("token", options.token);
  return params;
}

/**
 * Builds the stable delivery URL for an asset: `https://cdn.steadylink.io/a/{assetId}`.
 * The URL keeps working when the file is replaced; add `version` to pin one revision.
 */
export function assetUrl(assetId: string, options: TransformOptions = {}, origin: string = DEFAULT_CDN_URL): string {
  if (!assetId) throw new TypeError("assetId is required");
  const query = applyTransform(new URLSearchParams(), options).toString();
  return `${origin.replace(/\/+$/, "")}/a/${encodeURIComponent(assetId)}${query ? `?${query}` : ""}`;
}

const ASSET_PATH = /^\/a\/([^/?#]+)\/?$/;

/**
 * Extracts an asset ID from a raw ID, an `/a/{id}` path, or a full delivery URL.
 * Returns undefined when the value is not a SteadyLink asset reference.
 */
export function parseAssetRef(value: string): { assetId: string; params: URLSearchParams; origin?: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return { assetId: trimmed, params: new URLSearchParams() };
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const url = new URL(trimmed, "https://placeholder.invalid");
    const match = ASSET_PATH.exec(url.pathname);
    if (!match?.[1]) return undefined;
    const ref: { assetId: string; params: URLSearchParams; origin?: string } = { assetId: decodeURIComponent(match[1]), params: url.searchParams };
    if (absolute) ref.origin = url.origin;
    return ref;
  } catch {
    return undefined;
  }
}
