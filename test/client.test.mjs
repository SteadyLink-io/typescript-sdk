import assert from "node:assert/strict";
import test from "node:test";
import { SteadyLink, SteadyLinkError } from "../dist/index.js";

test("authenticates management requests and normalizes upload manifests", async () => {
  let captured;
  const client = new SteadyLink({ apiKey: "slk_test", baseUrl: "https://api.example", fetch: async (url, init) => {
    captured = { url, init };
    return Response.json({ id: "batch", files: [] }, { status: 201 });
  }});
  await client.createUploadBatch("bucket", [{ filename: "hero.png", size: 12, contentType: "image/png" }]);
  assert.equal(captured.init.headers.get("X-API-Key"), "slk_test");
  assert.deepEqual(JSON.parse(captured.init.body).files, [{ filename: "hero.png", size: 12, contentType: "image/png", path: "" }]);
});

test("does not send API credentials to presigned storage URLs", async () => {
  let headers;
  const client = new SteadyLink({ apiKey: "secret", fetch: async (_url, init) => { headers = new Headers(init.headers); return new Response(null, { status: 200 }) } });
  await client.uploadToUrl("https://storage.example/upload", new Uint8Array([1]), "image/png");
  assert.equal(headers.get("X-API-Key"), null);
  assert.equal(headers.get("Authorization"), null);
  assert.equal(headers.get("Content-Type"), "image/png");
});

test("uploadFile completes the full upload flow", async () => {
  const calls = [];
  const client = new SteadyLink({ apiKey: "secret", fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/upload-batches")) return Response.json({ id: "batch", files: [{ id: "session", uploadUrl: "https://storage.example/upload", contentType: "image/png" }] }, { status: 201 });
    if (url === "https://storage.example/upload") return new Response(null, { status: 200 });
    return Response.json({ status: "committing" }, { status: 202 });
  }});
  await client.uploadFile("bucket", { filename: "hero.png", size: 3, contentType: "image/png", data: new Uint8Array([1, 2, 3]) });
  assert.equal(calls.length, 3);
  assert.equal(new Headers(calls[1].init.headers).has("X-API-Key"), false);
  assert.deepEqual(JSON.parse(calls[0].init.body).files, [{ filename: "hero.png", size: 3, contentType: "image/png", path: "" }]);
});

test("preserves structured API errors", async () => {
  const client = new SteadyLink({ apiKey: "secret", maxRetries: 0, fetch: async () => Response.json({ detail: { code: "usage_limit", message: "Upgrade required" } }, { status: 429, headers: { "x-request-id": "req_1" } }) });
  await assert.rejects(client.listBuckets(), error => error instanceof SteadyLinkError && error.status === 429 && error.code === "usage_limit" && error.requestId === "req_1");
});

test("requires exactly one authentication method", () => {
  assert.throws(() => new SteadyLink({}), /exactly one/);
  assert.throws(() => new SteadyLink({ apiKey: "a", accessToken: "b" }), /exactly one/);
});
