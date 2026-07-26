import assert from "node:assert/strict";
import test from "node:test";

import { imageDimensions, isUsableLogoRatio, LOGO_MAX_RATIO, LOGO_MIN_RATIO } from "../src/logo-shape.mjs";
import { CONSTRUCTED_LOGO_PROVIDERS, verifyLogoShape } from "../src/company-logo.mjs";

// Every fixture below is a real shape measured on production, not an invented one.
const png = (width, height) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

test("reads dimensions out of each format's header", () => {
  // `type` comes from the FILE, not from any content-type header. Workday serves real PNGs
  // announced as text/plain, and a relay that echoed that header would hand the browser
  // text/plain + nosniff and get nothing painted.
  assert.deepEqual(imageDimensions(png(512, 512)), { width: 512, height: 512, type: "image/png" });

  const gif = new Uint8Array(16);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  new DataView(gif.buffer).setUint16(6, 64, true);
  new DataView(gif.buffer).setUint16(8, 64, true);
  assert.deepEqual(imageDimensions(gif), { width: 64, height: 64, type: "image/gif" });

  // viewBox wins over width/height: a logo built to scale states width="100%", which says nothing
  // about its proportions.
  const svg = new TextEncoder().encode('<svg viewBox="0 0 300 55" width="100%" height="100%"></svg>');
  assert.deepEqual(imageDimensions(svg), { width: 300, height: 55, type: "image/svg+xml" });

  // An ICO directory entry stores 0 for 256.
  const ico = new Uint8Array(16);
  new DataView(ico.buffer).setUint16(0, 0, true);
  new DataView(ico.buffer).setUint16(2, 1, true);
  ico[6] = 0;
  ico[7] = 0;
  assert.deepEqual(imageDimensions(ico), { width: 256, height: 256, type: "image/x-icon" });
});

test("a 200 that is not an image is not an image", () => {
  // CDNs answer a missing asset with the site's HTML shell and a 200. Treating that as a logo is
  // how an unusable URL got stored in the first place.
  const html = new TextEncoder().encode("<!DOCTYPE html><html><head><title>Not found</title></head></html>");
  assert.equal(imageDimensions(html), null);
  assert.equal(imageDimensions(new Uint8Array(4)), null);
  assert.equal(imageDimensions(null), null);
});

test("the ratio window rejects the banners Workday actually serves", () => {
  // Measured on production, 2026-07-25.
  for (const [width, height] of [[300, 55], [596, 167], [287, 45], [2560, 576], [2161, 1199], [1875, 980]]) {
    assert.equal(isUsableLogoRatio(width, height), false, `${width}x${height} should be rejected`);
  }
  // Square-ish logos survive.
  for (const [width, height] of [[512, 512], [32, 32], [200, 160], [160, 200]]) {
    assert.equal(isUsableLogoRatio(width, height), true, `${width}x${height} should be kept`);
  }
  // The boundaries are inclusive, so a logo exactly at the limit is not thrown away.
  assert.equal(isUsableLogoRatio(LOGO_MAX_RATIO * 100, 100), true);
  assert.equal(isUsableLogoRatio(LOGO_MIN_RATIO * 100, 100), true);
  assert.equal(isUsableLogoRatio(0, 100), false);
  assert.equal(isUsableLogoRatio(100, 0), false);
});

test("verifyLogoShape keeps square images and drops everything else", async () => {
  const respond = (bytes, init = {}) => async () => new Response(bytes, {
    status: init.status ?? 200,
    headers: { "content-type": init.type ?? "image/png" },
  });

  assert.equal(await verifyLogoShape("https://x/logo.png", respond(png(512, 512))), "https://x/logo.png");
  // A banner is rejected even though the request succeeded -- the whole point of the check.
  assert.equal(await verifyLogoShape("https://x/logo.png", respond(png(596, 167))), null);
  assert.equal(await verifyLogoShape("https://x/logo.png", respond(png(512, 512), { status: 404 })), null);
  assert.equal(await verifyLogoShape("https://x/logo.png", respond(png(512, 512), { type: "text/html" })), null);
  assert.equal(await verifyLogoShape(null, respond(png(512, 512))), null);
  // A fetch that throws is a missing logo, not a crash: the caller must fall through to scraping.
  assert.equal(await verifyLogoShape("https://x/logo.png", async () => { throw new Error("dns"); }), null);
});

test("only Workday's payload logo is treated as constructed", () => {
  // Getro, Spark Hire and Paylocity send a URL the ATS itself stores, so those stay trusted.
  assert.equal(CONSTRUCTED_LOGO_PROVIDERS.has("workday"), true);
  for (const provider of ["getro", "sparkhire", "paylocity", "greenhouse", "ashby"]) {
    assert.equal(CONSTRUCTED_LOGO_PROVIDERS.has(provider), false, `${provider} should stay trusted`);
  }
});

test("candidates come back best-first, so a bad top pick is recoverable", async () => {
  const { extractLogoCandidates, firstUsableLogo } = await import("../src/company-logo.mjs");
  const html = `
    <link rel="icon" href="/favicon.png">
    <meta property="og:image" content="https://cdn.example.com/share-banner.jpg">
    <link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">
  `;
  // apple-touch-icon outranks icon, which outranks og:image -- the banner is last, not first.
  assert.deepEqual(extractLogoCandidates(html, "https://boards.example.com/acme"), [
    "https://cdn.example.com/touch.png",
    "https://boards.example.com/favicon.png",
    "https://cdn.example.com/share-banner.jpg",
  ]);
  assert.deepEqual(extractLogoCandidates("", "https://x"), []);

  // The walk skips a banner and keeps going rather than giving up on the first failure -- the whole
  // reason it exists.
  const png = (width, height) => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  };
  const shapes = { "https://x/banner.png": png(600, 100), "https://x/square.png": png(256, 256) };
  const request = async (url) => new Response(shapes[url], { headers: { "content-type": "image/png" } });
  assert.equal(await firstUsableLogo(["https://x/banner.png", "https://x/square.png"], request), "https://x/square.png");
  assert.equal(await firstUsableLogo(["https://x/banner.png"], request), null);
  assert.equal(await firstUsableLogo([], request), null);
});
