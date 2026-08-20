# SteadyLink TypeScript SDK

[![CI](https://github.com/SteadyLink-io/typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/SteadyLink-io/typescript-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@steadylink/sdk.svg)](https://www.npmjs.com/package/@steadylink/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The official TypeScript client for the [SteadyLink API](https://steadylink.io/docs/developers/api-reference).

## Requirements

- Node.js 20 or newer
- A SteadyLink workspace and API key

The client also works in runtimes that provide the standard Fetch API. Management API keys must only be used in trusted server environments.

## Installation

```bash
npm install @steadylink/sdk
```

## Quick start

```ts
import { SteadyLink } from "@steadylink/sdk";

const client = new SteadyLink({
  apiKey: process.env.STEADYLINK_API_KEY!,
  workspaceId: process.env.STEADYLINK_WORKSPACE_ID,
});

const { items: buckets } = await client.listBuckets();
```

Create a scoped API key in **Dashboard > Developers**. You can use `accessToken` instead of `apiKey` for a signed-in user session. Pass exactly one authentication method.

## Upload a file

```ts
import { readFile } from "node:fs/promises";

const data = await readFile("./campaign-hero.webp");

const asset = await client.uploadFile("bucket_id", {
  filename: "campaign-hero.webp",
  size: data.byteLength,
  contentType: "image/webp",
  path: "campaign/",
  data,
});
```

`uploadFile` creates an upload session, sends the bytes to the presigned storage URL, and finalizes the upload. SteadyLink credentials are never attached to the storage request.

## Replace a file

```ts
await client.replaceFile("bucket_id", "campaign/campaign-hero.webp", {
  filename: "campaign-hero.webp",
  size: data.byteLength,
  contentType: "image/webp",
  data,
});
```

The replacement creates a new revision. Existing delivery URLs continue to work.

## Configuration

```ts
const client = new SteadyLink({
  apiKey: process.env.STEADYLINK_API_KEY!,
  workspaceId: "workspace_id",
  baseUrl: "https://api.steadylink.io",
  timeoutMs: 30_000,
  maxRetries: 2,
});
```

| Option | Description |
| --- | --- |
| `apiKey` | Server-side management API key. |
| `accessToken` | User access token. Use this or `apiKey`, not both. |
| `workspaceId` | Workspace used for workspace-scoped operations. |
| `baseUrl` | API origin. Useful for private or preview environments. |
| `timeoutMs` | Request timeout in milliseconds. Defaults to `30000`. |
| `maxRetries` | Maximum transient retries. Defaults to `2`. |
| `fetch` | Custom Fetch implementation for testing or alternate runtimes. |

## Errors and retries

```ts
import { SteadyLinkError, SteadyLinkNetworkError } from "@steadylink/sdk";

try {
  await client.listBuckets();
} catch (error) {
  if (error instanceof SteadyLinkError) {
    console.error(error.status, error.code, error.requestId, error.detail);
  } else if (error instanceof SteadyLinkNetworkError) {
    console.error(error.message, error.cause);
  }
}
```

The client retries `429`, `502`, `503`, and `504` responses for safe HTTP methods. A mutating request is only retried when it carries an idempotency key.

## Security

- Keep management API keys out of browser bundles, mobile apps, logs, and source control.
- Give each integration the smallest set of scopes it needs.
- Use `uploadToUrl` for presigned storage uploads. It does not attach SteadyLink authentication headers.
- Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/SteadyLink-io/typescript-sdk/security/advisories/new).

## Documentation

- [SDK guide](https://steadylink.io/docs/sdks)
- [API reference](https://steadylink.io/docs/developers/api-reference)
- [Issues](https://github.com/SteadyLink-io/typescript-sdk/issues)

## Development

```bash
npm install
npm test
npm pack --dry-run
```

See the [contributing guide](https://github.com/SteadyLink-io/typescript-sdk/blob/main/CONTRIBUTING.md) for the development and release process.

## License

[MIT](LICENSE)
