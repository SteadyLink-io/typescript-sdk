import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SteadyLink, SteadyLinkUploadError } from "../dist/index.js";
import { fileFromPath } from "../dist/node.js";

/** A tiny fake SteadyLink API. Routes are "METHOD /path" -> handler(url, init, body). */
function fakeApi(routes) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    if (body && typeof body.getReader === "function") { const chunks = []; for await (const chunk of body) chunks.push(chunk); body = Buffer.concat(chunks).toString() }
    else if (body instanceof Uint8Array) body = Buffer.from(body).toString();
    calls.push({ method, url, headers: new Headers(init.headers), body });
    const key = `${method} ${url.origin === "https://api.test" ? url.pathname : url.origin + url.pathname}`;
    const handler = routes[key];
    if (!handler) return Response.json({ detail: `No route for ${key}` }, { status: 404 });
    const result = await handler({ url, init, body, calls });
    return result instanceof Response ? result : Response.json(result ?? {}, { status: 200 });
  };
  return { fetch, calls };
}

const session = (id, overrides = {}) => ({
  id, batchId: "batch-1", bucketId: "bucket-1", objectAssetId: null, filename: `${id}.png`, path: "", contentType: "image/png",
  expectedSize: 3, status: "created", revisionNumber: null, error: null, expiresAt: "", createdAt: "", updatedAt: "",
  uploadUrl: `https://storage.test/${id}`, ...overrides,
});

const client = (fetch, extra = {}) => new SteadyLink({ apiKey: "slk_test", baseUrl: "https://api.test", cdnUrl: "https://cdn.test", fetch, ...extra });

test("upload() sends bytes as octet-stream, completes, waits, and returns stable links", async () => {
  let polls = 0;
  const api = fakeApi({
    "POST /api/upload-batches": ({ body }) => {
      const files = JSON.parse(body).files;
      return Response.json({ id: "batch-1", status: "active", totalFiles: files.length, files: files.map((file, index) => session(`s${index}`, { filename: file.filename, path: file.path, contentType: file.contentType })) }, { status: 201 });
    },
    "PUT https://storage.test/s0": () => new Response(null, { status: 200 }),
    "POST /api/upload-sessions/s0/complete": () => Response.json(session("s0", { status: "committing", filename: "hero.png", path: "campaign/" }), { status: 202 }),
    "GET /api/upload-batches/batch-1": () => {
      polls += 1;
      const ready = polls > 1;
      return { id: "batch-1", status: ready ? "complete" : "active", totalFiles: 1, files: [session("s0", { filename: "hero.png", path: "campaign/", status: ready ? "ready" : "scanning", objectAssetId: ready ? "asset-1" : null, revisionNumber: ready ? 1 : null })] };
    },
  });
  const progress = [];
  const [result] = await client(api.fetch).upload("bucket-1", { filename: "hero.png", data: new Uint8Array([1, 2, 3]) }, { folder: "campaign", wait: { intervalMs: 1 }, onProgress: event => progress.push(event) });

  assert.deepEqual(result, { uploadSessionId: "s0", batchId: "batch-1", bucketId: "bucket-1", filename: "hero.png", key: "campaign/hero.png", status: "ready", assetId: "asset-1", revisionNumber: 1, url: "https://cdn.test/a/asset-1", error: null });
  const manifest = JSON.parse(api.calls[0].body).files[0];
  assert.deepEqual(manifest, { filename: "hero.png", size: 3, contentType: "image/png", path: "campaign/" });
  const put = api.calls.find(call => call.method === "PUT");
  assert.equal(put.headers.get("content-type"), "application/octet-stream", "presigned URLs are signed for octet-stream");
  assert.equal(put.headers.get("x-api-key"), null, "credentials never reach storage");
  assert.equal(put.headers.get("content-length"), "3");
  assert.equal(put.body, "\u0001\u0002\u0003");
  assert.equal(api.calls.find(call => call.url.pathname.endsWith("/complete")).headers.get("idempotency-key"), "complete-s0");
  assert.equal(polls, 2);
  assert.deepEqual(progress.at(-1), { filename: "hero.png", index: 0, loaded: 3, total: 3 });
});

test("upload() applies visibility after finalization", async () => {
  const api = fakeApi({
    "POST /api/upload-batches": () => Response.json({ id: "batch-1", files: [session("s0", { filename: "a.txt" })] }, { status: 201 }),
    "PUT https://storage.test/s0": () => new Response(null),
    "POST /api/upload-sessions/s0/complete": () => session("s0", { status: "committing", filename: "a.txt" }),
    "GET /api/upload-batches/batch-1": () => ({ id: "batch-1", files: [session("s0", { filename: "a.txt", status: "ready", objectAssetId: "asset-a" })] }),
    "POST /api/assets/bucket-1/objects/visibility": () => ({ updated: true }),
  });
  const [result] = await client(api.fetch).upload("bucket-1", { filename: "a.txt", data: "abc" }, { visibility: "public", wait: false });
  assert.equal(result.visibility, "public");
  const call = api.calls.find(entry => entry.url.pathname.endsWith("/visibility"));
  assert.equal(call.url.searchParams.get("key"), "a.txt");
  assert.equal(call.url.searchParams.get("visibility"), "public");
});

test("upload() reports per-file failures, cancels the session, and throws by default", async () => {
  const routes = {
    "POST /api/upload-batches": () => Response.json({ id: "batch-1", files: [session("s0", { filename: "ok.png" }), session("s1", { filename: "bad.png" })] }, { status: 201 }),
    "PUT https://storage.test/s0": () => new Response(null),
    "PUT https://storage.test/s1": () => new Response("<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature does not match</Message></Error>", { status: 403 }),
    "POST /api/upload-sessions/s0/complete": () => session("s0", { status: "committing", filename: "ok.png" }),
    "DELETE /api/upload-sessions/s1": () => session("s1", { status: "cancelled" }),
    "GET /api/upload-batches/batch-1": () => ({ id: "batch-1", files: [session("s0", { filename: "ok.png", status: "ready", objectAssetId: "asset-ok" }), session("s1", { filename: "bad.png", status: "cancelled" })] }),
  };
  const files = [{ filename: "ok.png", data: "abc" }, { filename: "bad.png", data: "abc" }];
  const api = fakeApi(routes);
  await assert.rejects(client(api.fetch).upload("bucket-1", files, { wait: { intervalMs: 1 } }), error => {
    assert.ok(error instanceof SteadyLinkUploadError);
    assert.equal(error.results.length, 2);
    assert.equal(error.results[0].url, "https://cdn.test/a/asset-ok");
    assert.equal(error.results[1].status, "failed");
    assert.match(error.results[1].error.message, /Storage rejected the upload \(HTTP 403\): SignatureDoesNotMatch - The request signature/);
    assert.equal(error.results[1].error.code, "SignatureDoesNotMatch");
    return true;
  });
  assert.ok(api.calls.some(call => call.method === "DELETE" && call.url.pathname === "/api/upload-sessions/s1"));

  const results = await client(fakeApi(routes).fetch).upload("bucket-1", files, { wait: { intervalMs: 1 }, throwOnError: false });
  assert.deepEqual(results.map(result => result.status), ["ready", "failed"]);
});

test("upload() splits more than 100 files into multiple batches", async () => {
  let batches = 0;
  const api = fakeApi({
    "POST /api/upload-batches": ({ body }) => {
      batches += 1;
      const files = JSON.parse(body).files;
      return Response.json({ id: `batch-${batches}`, files: files.map((file, index) => session(`b${batches}-${index}`, { filename: file.filename, uploadUrl: "https://storage.test/any" })) }, { status: 201 });
    },
    "PUT https://storage.test/any": () => new Response(null),
  });
  const original = api.fetch;
  const fetch = async (input, init) => (String(input).includes("/complete") ? Response.json({ status: "committing" }, { status: 202 }) : original(input, init));
  const files = Array.from({ length: 150 }, (_, index) => ({ filename: `f${index}.txt`, data: "x" }));
  const results = await client(fetch).upload("bucket-1", files, { wait: false, concurrency: 16 });
  assert.equal(batches, 2);
  assert.equal(results.length, 150);
  assert.equal(JSON.parse(api.calls[0].body).files.length, 100);
});

test("upload() requires a size for streams and can stream through the API", async () => {
  await assert.rejects(client(async () => new Response(null)).upload("bucket-1", { filename: "s.bin", data: new Blob(["abc"]).stream() }), /size is required/);

  const api = fakeApi({
    "POST /api/upload-batches": () => Response.json({ id: "batch-1", files: [session("s0", { filename: "s.bin" })] }, { status: 201 }),
    "PUT /api/upload-sessions/s0/content": () => session("s0", { status: "uploaded" }),
    "POST /api/upload-sessions/s0/complete": () => session("s0", { status: "committing" }),
  });
  await client(api.fetch).upload("bucket-1", { filename: "s.bin", size: 3, data: new Blob(["abc"]).stream() }, { via: "api", wait: false });
  const put = api.calls.find(call => call.method === "PUT");
  assert.equal(put.headers.get("x-api-key"), "slk_test");
  assert.equal(put.headers.get("content-length"), "3");
  assert.equal(put.body, "abc");
});

test("replace() resolves an asset ID, uploads a temp object, and publishes a revision", async () => {
  const api = fakeApi({
    "GET /api/assets/object/asset-1/stat": () => ({ bucketId: "bucket-1", key: "campaign/hero.png", id: "row", objectAssetId: "asset-1", size: 1, contentType: "image/png", lastModified: null }),
    "POST /api/assets/bucket-1/objects/upload-temp": () => ({ uploadUrl: "https://storage.test/temp", tempKey: "uploads/temp/x" }),
    "PUT https://storage.test/temp": () => new Response(null),
    "POST /api/assets/bucket-1/objects/replace": () => ({ replaced: true, version: 4 }),
  });
  const result = await client(api.fetch).replace("asset-1", { filename: "hero-v2.png", data: new Uint8Array(5) });
  assert.deepEqual(result, { replaced: true, version: 4, bucketId: "bucket-1", key: "campaign/hero.png", assetId: "asset-1", url: "https://cdn.test/a/asset-1" });
  const temp = api.calls.find(call => call.url.pathname.endsWith("/upload-temp"));
  assert.equal(temp.url.searchParams.get("size"), "5");
  assert.equal(temp.url.searchParams.get("content_type"), "image/png");
  assert.equal(api.calls.find(call => call.method === "PUT").headers.get("content-type"), "application/octet-stream");
  const publish = api.calls.at(-1);
  assert.equal(publish.url.searchParams.get("key"), "campaign/hero.png");
  assert.equal(publish.url.searchParams.get("upload_temp_key"), "uploads/temp/x");
  assert.equal(publish.url.searchParams.get("original_filename"), "hero-v2.png");
});

test("replace() by bucket and key looks up the asset ID afterwards", async () => {
  const api = fakeApi({
    "POST /api/assets/b/objects/upload-temp": () => ({ uploadUrl: "https://storage.test/temp", tempKey: "t" }),
    "PUT https://storage.test/temp": () => new Response(null),
    "POST /api/assets/b/objects/replace": () => ({ replaced: true, version: 2 }),
    "GET /api/assets/b/objects/stat": () => ({ key: "doc.pdf", objectAssetId: "asset-doc" }),
  });
  const result = await client(api.fetch).replace({ bucketId: "b", key: "doc.pdf" }, { filename: "doc.pdf", data: "pdf" });
  assert.equal(result.url, "https://cdn.test/a/asset-doc");
});

test("links, signed links, revisions, deletes, and collections hit the documented routes", async () => {
  const api = fakeApi({
    "POST /api/assets/asset-1/signed-url": () => Response.json({ id: "grant-1", token: "tok.en", name: "preview", revisionNumber: 2, expiresAt: "2026-10-02T00:00:00" }, { status: 201 }),
    "GET /api/assets/asset-1/versions": () => [{ versionNumber: 2, isCurrent: true }],
    "POST /api/assets/asset-1/versions/1/promote": () => ({ promoted: true, versionNumber: 1, revisionId: "r1" }),
    "DELETE /api/assets/asset-1/versions/2": () => ({}),
    "DELETE /api/assets/bucket-1/objects": () => ({ deleted: true }),
    "GET /api/assets/bucket-1/objects": () => ({ prefix: "a/", folders: [], items: [], revision: null }),
    "POST /api/collections": () => Response.json({ id: "c1", slug: "launch-kit", name: "Launch kit" }, { status: 201 }),
    "POST /api/collections/c1/items": () => Response.json({ id: "item-1" }, { status: 201 }),
  });
  const steadylink = client(api.fetch, { appUrl: "https://app.test" });

  assert.equal(steadylink.link("asset-1", { width: 640, quality: 120, format: "webp" }), "https://cdn.test/a/asset-1?w=640&fm=webp&q=95");
  const signed = await steadylink.createSignedLink("asset-1", { ttlSeconds: 3600, name: "preview", revision: 2 });
  assert.equal(signed.url, "https://cdn.test/a/asset-1?token=tok.en");
  const signCall = api.calls[0];
  assert.deepEqual(Object.fromEntries(signCall.url.searchParams), { ttl: "3600", name: "preview", revision: "2" });

  assert.equal((await steadylink.listVersions("asset-1"))[0].versionNumber, 2);
  assert.equal((await steadylink.rollback("asset-1", 1)).promoted, true);
  await steadylink.deleteVersion("asset-1", 2, { force: true });
  assert.equal(api.calls.at(-1).url.searchParams.get("force"), "true");
  await steadylink.deleteFile("bucket-1", "a/b.png");
  assert.equal(api.calls.at(-1).url.searchParams.get("key"), "a/b.png");
  await steadylink.listFiles("bucket-1", { prefix: "/a" });
  assert.equal(api.calls.at(-1).url.searchParams.get("prefix"), "a/");

  const collection = await steadylink.createCollection({ name: "Launch kit", accessMode: "public" });
  assert.equal(collection.url, "https://app.test/c/launch-kit");
  await steadylink.addToCollection("c1", "asset-1", 2);
  assert.deepEqual(JSON.parse(api.calls.at(-1).body), { assetId: "asset-1", version: 2 });
});

test("streamed uploads reach a real HTTP server with Content-Length and no buffering", async () => {
  const received = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(200).end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/upload`;
  try {
    const directory = await mkdtemp(join(tmpdir(), "steadylink-sdk-"));
    const path = join(directory, "big.bin");
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 7);
    await writeFile(path, bytes);
    const source = await fileFromPath(path);
    assert.equal(source.size, bytes.length);
    assert.equal(source.contentType, "application/octet-stream");

    const steadylink = new SteadyLink({ apiKey: "slk_test" });
    let last;
    await steadylink.uploadToUrl(url, source.data, "application/octet-stream", undefined, { size: source.size, onProgress: loaded => { last = loaded } });
    assert.equal(received[0].headers["content-length"], String(bytes.length));
    assert.equal(received[0].headers["transfer-encoding"], undefined, "storage providers reject chunked uploads");
    assert.equal(received[0].headers["x-api-key"], undefined);
    assert.equal(received[0].body.equals(bytes), true);
    assert.equal(last, bytes.length);
  } finally {
    server.close();
  }
});
