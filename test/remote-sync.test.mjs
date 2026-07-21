import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteSync } from "../src/remote-sync.mjs";

test("uploads a compact fingerprinted board snapshot", async () => {
  let request;
  const remote = createRemoteSync({
    endpoint: "https://example.test/api/internal/sync",
    token: "secret",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ ok: true });
    },
  });

  await remote.push({
    board: {
      key: "ashby:global:example",
      provider: "ashby",
      identifier: "example",
      status: "active",
      jobCount: 1,
      syncedAt: "2026-07-21T00:00:00.000Z",
    },
    jobs: [{
      key: "ashby:global:example:one",
      sourceId: "one",
      boardKey: "ashby:global:example",
      provider: "ashby",
      companyIdentifier: "example",
      companyName: "Example, Inc.",
      companyLogoUrl: "https://cdn.example.test/logo.png",
      title: "Engineer",
      location: "Remote",
      workplace: "Remote",
      employmentType: "Full-time",
      category: "Engineering",
      descriptionPlain: "This large description must not be uploaded.",
      publishedAt: "2026-07-20T00:00:00.000Z",
      url: "https://jobs.ashbyhq.com/example/one",
    }],
  });

  const payload = JSON.parse(request.init.body);
  assert.equal(request.url, "https://example.test/api/internal/sync");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.equal(payload.jobs[0].descriptionPlain, undefined);
  assert.equal(payload.jobs[0].companyName, "Example, Inc.");
  assert.equal(payload.jobs[0].companyLogoUrl, "https://cdn.example.test/logo.png");
  assert.match(payload.jobs[0].fingerprint, /^[a-f0-9]{64}$/);
});

test("authenticates through a private Sites deployment when configured", async () => {
  let request;
  const remote = createRemoteSync({
    endpoint: "https://example.test/api/internal/sync",
    token: "sync-secret",
    sitesToken: "sites-secret",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ ok: true });
    },
  });

  await remote.push({
    board: {
      key: "lever:global:example",
      provider: "lever",
      identifier: "example",
      status: "empty",
      jobCount: 0,
      syncedAt: "2026-07-21T00:00:00.000Z",
    },
    jobs: [],
  });

  assert.equal(request.init.headers["OAI-Sites-Authorization"], "Bearer sites-secret");
});
