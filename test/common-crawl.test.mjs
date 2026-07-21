import assert from "node:assert/strict";
import test from "node:test";
import {
  selectEvenlySpacedPages,
  selectRotatingPages,
  selectUnseenPages,
} from "../src/common-crawl.mjs";

test("selects all pages when the result is small", () => {
  assert.deepEqual(selectEvenlySpacedPages(3, 5), [0, 1, 2]);
});

test("samples large page ranges from beginning to end", () => {
  assert.deepEqual(selectEvenlySpacedPages(101, 5), [0, 25, 50, 75, 100]);
});

test("handles empty and single-page limits", () => {
  assert.deepEqual(selectEvenlySpacedPages(0, 5), []);
  assert.deepEqual(selectEvenlySpacedPages(100, 1), [49]);
});

test("rotates bounded samples so repeated discovery covers different pages", () => {
  assert.deepEqual(selectRotatingPages(20, 5, 0), [0, 4, 8, 12, 16]);
  assert.deepEqual(selectRotatingPages(20, 5, 1), [1, 5, 9, 13, 17]);
  assert.deepEqual(selectRotatingPages(3, 5, 99), [0, 1, 2]);
});

test("selects only unseen crawl pages for resumable harvesting", () => {
  assert.deepEqual(selectUnseenPages(10, 3, [0, 3, 6], 0), [1, 4, 7]);
  assert.deepEqual(selectUnseenPages(4, 10, [0, 2], 99), [1, 3]);
  assert.deepEqual(selectUnseenPages(3, 2, [0, 1, 2], 0), []);
});

test("skips a filtered Common Crawl block that contains no matching captures", async () => {
  const { discoverTarget } = await import("../src/common-crawl.mjs");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ pages: 3 }), { status: 200 });
    return new Response("No Captures found", { status: 404 });
  };

  const result = await discoverTarget(
    { provider: "greenhouse", pattern: "boards.greenhouse.io/*" },
    { index: { api: "https://example.test/index" }, maxPages: 1, fetchImpl },
  );

  assert.equal(calls, 2);
  assert.deepEqual(result.urls, []);
  assert.deepEqual(result.sampledPages, [1]);
});

test("retries transient Common Crawl proxy failures returned as HTTP 400", async () => {
  const { discoverTarget } = await import("../src/common-crawl.mjs");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("Connection aborted: RemoteDisconnected", {
        status: 400,
        headers: { "retry-after": "0" },
      });
    }
    if (calls === 2) return Response.json({ pages: 1 });
    return new Response(`${JSON.stringify({ url: "https://jobs.lever.co/example/one" })}\n`);
  };

  const result = await discoverTarget(
    { provider: "lever", pattern: "jobs.lever.co/*" },
    { index: { api: "https://example.test/index" }, maxPages: 1, fetchImpl },
  );

  assert.equal(calls, 3);
  assert.deepEqual(result.urls, ["https://jobs.lever.co/example/one"]);
});
