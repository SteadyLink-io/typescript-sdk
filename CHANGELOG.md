# Changelog

## 0.2.0

- `upload()` for one or many files: batching, parallel transfers, progress, finalization wait, visibility, and a stable link in every result.
- Large files stream to storage with an explicit Content-Length. `@steadylink/sdk/node` adds `fileFromPath()`.
- `replace()` by asset ID, link, or bucket and key. The link stays the same.
- Links: `link()`, `assetUrl()`, transform options, `createSignedLink()`, `listSignedLinks()`, `revokeSignedLink()`.
- Files: `findBucket()`, `listFiles()`, `listAllFiles()`, `getFile()`, `statFile()`, `setVisibility()`, `deleteFile()`, `renameFile()`, `createFolder()`.
- Revisions: `listVersions()`, `rollback()` / `promoteVersion()`, `updateVersion()`, `deleteVersion()`.
- Collections: create, read, update, delete, add, remove, pin, and reorder items.
- `@steadylink/sdk/next-loader`: a `next/image` custom loader for `/a/{id}` URLs.
- Fix: presigned uploads always send `Content-Type: application/octet-stream`, which is what the URLs are signed for.
- Node.js 18 is now the minimum supported version.

## 0.1.0

- Initial public preview of the SteadyLink TypeScript SDK.
- Typed management API authentication, upload batches, replacements, delivery policy, migrations, webhooks, and SSO helpers.
- Safe presigned uploads, request timeouts, structured errors, and idempotency-aware retries.
