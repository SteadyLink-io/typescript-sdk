import { applyTransform, DEFAULT_CDN_URL, parseAssetRef, type ImageFit, type ImageFormat } from "./url.js";

/** The props Next.js passes to a custom `next/image` loader. */
export interface ImageLoaderProps { src: string; width: number; quality?: number | undefined }

export interface SteadyLinkLoaderOptions {
  /** Delivery origin. Defaults to NEXT_PUBLIC_STEADYLINK_CDN_URL, then https://cdn.steadylink.io. */
  origin?: string | undefined;
  /** Output format. Defaults to `webp`. Pass `false` to keep the source format. */
  format?: ImageFormat | false | undefined;
  /** Quality when next/image does not pass one. Defaults to 75. */
  quality?: number | undefined;
  fit?: ImageFit | undefined;
}

function envOrigin(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NEXT_PUBLIC_STEADYLINK_CDN_URL || undefined;
}

/**
 * Creates a `next/image` loader that turns an asset ID (or `/a/{id}` URL) into a
 * resized SteadyLink delivery URL. Non-SteadyLink `src` values are returned unchanged.
 */
export function createSteadyLinkLoader(options: SteadyLinkLoaderOptions = {}) {
  return function steadylinkLoader({ src, width, quality }: ImageLoaderProps): string {
    const ref = parseAssetRef(src);
    if (!ref) return src;
    const origin = (ref.origin ?? options.origin ?? envOrigin() ?? DEFAULT_CDN_URL).replace(/\/+$/, "");
    const params = new URLSearchParams(ref.params);
    const transform: Parameters<typeof applyTransform>[1] = { width, quality: quality ?? options.quality ?? 75 };
    if (options.format !== false && !params.has("fm")) transform.format = options.format ?? "webp";
    if (options.fit && !params.has("fit")) transform.fit = options.fit;
    applyTransform(params, transform);
    return `${origin}/a/${encodeURIComponent(ref.assetId)}?${params}`;
  };
}

/**
 * Default loader. Use it from the file referenced by `images.loaderFile`:
 *
 * ```js
 * // steadylink-loader.js
 * export { default } from "@steadylink/sdk/next-loader";
 * ```
 */
const steadylinkLoader = createSteadyLinkLoader();
export default steadylinkLoader;
