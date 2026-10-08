import assert from "node:assert/strict";
import test from "node:test";
import { assetUrl, contentTypeFor, parseAssetRef } from "../dist/index.js";
import steadylinkLoader, { createSteadyLinkLoader } from "../dist/next-loader.js";

test("assetUrl builds stable delivery URLs with documented transform params", () => {
  assert.equal(assetUrl("abc"), "https://cdn.steadylink.io/a/abc");
  assert.equal(
    assetUrl("abc", { version: 3, width: 1200, height: 630, fit: "cover", focus: "auto", format: "webp", quality: 10 }, "https://media.example.com/"),
    "https://media.example.com/a/abc?v=3&w=1200&h=630&fm=webp&q=30&fit=cover&focus=auto",
  );
  assert.equal(assetUrl("abc", { focalPoint: { x: 0.4, y: 2 } }), "https://cdn.steadylink.io/a/abc?fp-x=0.4&fp-y=1");
  assert.throws(() => assetUrl(""), /assetId/);
});

test("parseAssetRef accepts IDs, paths, and URLs", () => {
  assert.equal(parseAssetRef("3f2a")?.assetId, "3f2a");
  assert.equal(parseAssetRef("/a/3f2a?v=2")?.params.get("v"), "2");
  const absolute = parseAssetRef("https://media.example.com/a/3f2a");
  assert.equal(absolute?.assetId, "3f2a");
  assert.equal(absolute?.origin, "https://media.example.com");
  assert.equal(parseAssetRef("/images/hero.png"), undefined);
  assert.equal(parseAssetRef("https://example.com/hero.png"), undefined);
});

test("next/image loader resizes SteadyLink assets and leaves other sources alone", () => {
  assert.equal(steadylinkLoader({ src: "3f2a", width: 640 }), "https://cdn.steadylink.io/a/3f2a?w=640&fm=webp&q=75");
  assert.equal(steadylinkLoader({ src: "/a/3f2a?v=4", width: 1080, quality: 90 }), "https://cdn.steadylink.io/a/3f2a?v=4&w=1080&fm=webp&q=90");
  assert.equal(steadylinkLoader({ src: "https://media.example.com/a/3f2a?fm=png", width: 320 }), "https://media.example.com/a/3f2a?fm=png&w=320&q=75");
  assert.equal(steadylinkLoader({ src: "/logo.svg", width: 64 }), "/logo.svg");

  const custom = createSteadyLinkLoader({ origin: "https://img.example.com", format: false, quality: 60, fit: "inside" });
  assert.equal(custom({ src: "3f2a", width: 256 }), "https://img.example.com/a/3f2a?w=256&q=60&fit=inside");
});

test("next/image loader reads NEXT_PUBLIC_STEADYLINK_CDN_URL", () => {
  process.env.NEXT_PUBLIC_STEADYLINK_CDN_URL = "https://assets.example.org";
  try {
    assert.equal(steadylinkLoader({ src: "id1", width: 100 }), "https://assets.example.org/a/id1?w=100&fm=webp&q=75");
  } finally {
    delete process.env.NEXT_PUBLIC_STEADYLINK_CDN_URL;
  }
});

test("contentTypeFor guesses common types", () => {
  assert.equal(contentTypeFor("Hero.WEBP"), "image/webp");
  assert.equal(contentTypeFor("report.pdf"), "application/pdf");
  assert.equal(contentTypeFor("LICENSE"), "application/octet-stream");
});
