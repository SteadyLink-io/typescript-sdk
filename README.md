# SteadyLink TypeScript SDK

[![npm](https://img.shields.io/npm/v/@steadylink/sdk.svg)](https://www.npmjs.com/package/@steadylink/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The official TypeScript client for the [SteadyLink API](https://steadylink.io/docs/developers/api-reference). Upload files, replace them without changing their link, mint signed links for private files, roll back revisions, and serve resized images through `next/image`.

- Node.js 18+, Bun, Deno, edge runtimes, and browsers (standard `fetch`)
- ESM with bundled type definitions, zero runtime dependencies
- Streams large files straight to storage without buffering them in memory

```bash
npm install @steadylink/sdk
```

## Quick start

```ts
import { SteadyLink } from "@steadylink/sdk";
import { fileFromPath } from "@steadylink/sdk/node";

const steadylink = new SteadyLink({ apiKey: process.env.STEADYLINK_API_KEY! });

const bucket = await steadylink.findBucket("marketing"); // ID, slug, or name
const [hero] = await steadylink.upload(bucket!.id, await fileFromPath("./hero.webp"), { folder: "campaign" });

console.log(hero.url); // https://cdn.steadylink.io/a/3f2a...  (this link never changes)
```

Create a scoped key in **Dashboard > Developers** (`assets:read` to read, `assets:write` to upload). Keep management keys on the server.

## Uploads

`upload()` creates upload sessions (100 per batch), sends the bytes directly to object storage, completes each session, and by default waits until SteadyLink has finalized the files so every result carries its asset ID and link.

```ts
const results = await steadylink.upload(bucketId, [
  { filename: "logo.svg", data: svgString },
  { filename: "hero.png", data: pngBytes },                   // Uint8Array, ArrayBuffer, or Blob
  { filename: "intro.mp4", data: stream, size: 52_428_800 },  // streams need a size
], {
  folder: "launch/2026",
  visibility: "public",   // or "private"; omit to inherit the bucket default
  concurrency: 4,
  onProgress: ({ filename, loaded, total }) => console.log(filename, Math.round((loaded / total) * 100)),
});

for (const file of results) console.log(file.key, file.assetId, file.url);
```

| Option | Default | Description |
| --- | --- | --- |
| `folder` | bucket root | Folder prefix for every file. Each source can add its own `path`. |
| `visibility` | inherit | Set each finished file to `public` or `private`. |
| `wait` | `true` | Wait for finalization. `false` returns right after upload; `{ timeoutMs, intervalMs }` tunes polling. |
| `concurrency` | `4` | Parallel transfers. |
| `onProgress` | none | Byte progress per file. |
| `via` | `"presigned"` | `"api"` streams bytes through the SteadyLink API when the storage host is blocked. |
| `throwOnError` | `true` | Throw `SteadyLinkUploadError` (with `.results`) when any file fails. |

### Large files

`fileFromPath()` from `@steadylink/sdk/node` returns a lazily opened stream plus its size, so multi-gigabyte files go to storage without being read into memory. Any `ReadableStream` works the same way when you pass `size`.

```ts
import { fileFromPath } from "@steadylink/sdk/node";

const [video] = await steadylink.upload(bucketId, await fileFromPath("./keynote.mp4"), {
  onProgress: ({ loaded, total }) => process.stdout.write(`\r${((loaded / total) * 100).toFixed(1)}%`),
});
```

Byte uploads have no timeout by default; set `uploadTimeoutMs` on the client to add one.

### Browsers

Keep the API key on your server. Create the session there and give the browser only its presigned `uploadUrl`:

```ts
// server: create the session
const batch = await steadylink.createUploadBatch(bucketId, [{ filename, size, contentType }]);
return Response.json({ session: batch.files[0] });

// browser: PUT the bytes to session.uploadUrl with Content-Type: application/octet-stream

// server: finalize
await steadylink.completeUpload(sessionId);
```

When the SDK itself runs in a browser (for example with a short-lived `accessToken`), passing `onProgress` uses `XMLHttpRequest` so you get real upload progress.

## Replace a file, keep the link

A replacement publishes a new revision behind the same asset ID. Every link, embed, and QR code keeps working and now serves the new bytes.

```ts
// By asset ID (or a /a/{id} link)
const result = await steadylink.replace("3f2a...", await fileFromPath("./hero-v2.webp"));
console.log(result.version, result.url); // 4  https://cdn.steadylink.io/a/3f2a...

// By bucket and key
await steadylink.replace({ bucketId, key: "campaign/hero.webp" }, { filename: "hero.webp", data: bytes });
```

## Links

```ts
steadylink.link(assetId);                                   // follows the current revision
steadylink.link(assetId, { width: 1200, height: 630, fit: "cover", focus: "auto", format: "webp", quality: 80 });
steadylink.link(assetId, { version: 3 });                   // pinned revision, cached for a year

// Private files: revocable, expiring links
const signed = await steadylink.createSignedLink(assetId, { ttlSeconds: 3600, name: "client preview" });
signed.url; // https://cdn.steadylink.io/a/{id}?token=...
await steadylink.revokeSignedLink(assetId, signed.id);
```

`assetUrl(assetId, options, origin)` builds the same URLs without a client, for example in browser code.

| Option | Query | Notes |
| --- | --- | --- |
| `version` | `v` | Pin one revision. |
| `width`, `height` | `w`, `h` | Pixels. |
| `format` | `fm` | `webp`, `jpg`, `png`. |
| `quality` | `q` | Clamped to 30-95. |
| `fit` | `fit` | `cover`, `contain`, `inside`, `outside`. |
| `focus` | `focus` | `center` or `auto` (with `fit: "cover"`). |
| `focalPoint` | `fp-x`, `fp-y` | Each 0-1. |
| `token` | `token` | Signed access token. |

## Files, revisions, and collections

```ts
const { items: buckets } = await steadylink.listBuckets();
const listing = await steadylink.listFiles(bucketId, { prefix: "campaign/" });
const details = await steadylink.getFile(assetId);           // bucketId, key, size, contentType...
await steadylink.setVisibility(bucketId, "campaign/hero.webp", "private");
await steadylink.deleteFile(bucketId, "campaign/old.webp");  // removes every revision; the link stops working

const revisions = await steadylink.listVersions(assetId);    // newest first
await steadylink.rollback(assetId, 2);                       // make revision 2 current again
await steadylink.updateVersion(assetId, 3, { label: "Approved" });

const kit = await steadylink.createCollection({ name: "Press kit", accessMode: "public" });
await steadylink.addToCollection(kit.id, assetId);           // follows the current revision
console.log(kit.url);                                        // https://steadylink.io/c/press-kit
```

## next/image loader

**A Cloudinary or UploadThing alternative where the link never breaks.** Upload once, keep the asset ID in your CMS or code, and replace the file whenever you like. `next/image` keeps requesting the same `/a/{id}` URL and SteadyLink resizes whatever revision is current.

```js
// steadylink-loader.js
export { default } from "@steadylink/sdk/next-loader";
```

```js
// next.config.js
module.exports = {
  images: { loader: "custom", loaderFile: "./steadylink-loader.js" },
};
```

```tsx
import Image from "next/image";

<Image src="3f2a9c1e-..." alt="Launch hero" width={1200} height={630} sizes="100vw" />
// srcset entries like https://cdn.steadylink.io/a/3f2a9c1e-...?w=1200&fm=webp&q=75
```

`src` can be an asset ID, an `/a/{id}` path, or a full delivery URL (its host and query, such as `v=3`, are kept). Any other `src` is returned unchanged, so local images keep working. For a custom delivery domain or other defaults:

```js
// steadylink-loader.js
import { createSteadyLinkLoader } from "@steadylink/sdk/next-loader";

export default createSteadyLinkLoader({
  origin: process.env.NEXT_PUBLIC_STEADYLINK_CDN_URL, // e.g. https://media.example.com
  format: "webp",   // false keeps the source format
  quality: 75,
  fit: "inside",
});
```

## Errors and retries

```ts
import { SteadyLinkError, SteadyLinkNetworkError, SteadyLinkUploadError } from "@steadylink/sdk";

try {
  await steadylink.upload(bucketId, files);
} catch (error) {
  if (error instanceof SteadyLinkUploadError) console.error(error.results.filter(result => result.error));
  else if (error instanceof SteadyLinkError) console.error(error.status, error.code, error.requestId);
  else if (error instanceof SteadyLinkNetworkError) console.error(error.message, error.cause);
}
```

JSON calls retry `429`, `502`, `503`, and `504` for safe methods and for writes that carry an idempotency key (upload completion does). Byte uploads are never retried automatically.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | | Server-side management key. |
| `accessToken` | | User access token. Use this or `apiKey`. |
| `workspaceId` | | Workspace for user tokens. |
| `baseUrl` | `https://api.steadylink.io` | API origin. |
| `cdnUrl` | `https://cdn.steadylink.io` | Delivery origin for links. |
| `appUrl` | `https://steadylink.io` | Origin for collection portal links. |
| `timeoutMs` | `30000` | Timeout for JSON calls. |
| `uploadTimeoutMs` | `0` | Timeout for byte uploads (0 means none). |
| `maxRetries` | `2` | Transient retries. |
| `fetch` | `globalThis.fetch` | Custom Fetch implementation. |

## Security

- Keep management API keys out of browser bundles, mobile apps, logs, and source control.
- Give each integration the smallest set of scopes it needs.
- Presigned storage uploads never carry SteadyLink credentials.
- Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/SteadyLink-io/typescript-sdk/security/advisories/new).

## Development

```bash
npm install
npm test          # builds with tsc, then runs node --test against a mocked fetch
npm pack --dry-run
```

## License

[MIT](LICENSE)
