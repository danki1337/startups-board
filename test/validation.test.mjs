import assert from "node:assert/strict";
import test from "node:test";
import { parseAtsUrl } from "../src/providers.mjs";
import { validateBoard } from "../src/validation.mjs";

test("marks a valid board active and counts jobs", async () => {
  const board = parseAtsUrl("https://jobs.lever.co/example/123");
  const validation = await validateBoard(board, {
    retries: 0,
    fetchImpl: async () => new Response(JSON.stringify([{ text: "Engineer" }, { text: "Designer" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(validation.status, "active");
  assert.equal(validation.jobCount, 2);
  assert.deepEqual(validation.sampleTitles, ["Engineer", "Designer"]);
});

test("marks a missing board invalid", async () => {
  const board = parseAtsUrl("https://jobs.ashbyhq.com/missing/123");
  const validation = await validateBoard(board, {
    retries: 0,
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });

  assert.equal(validation.status, "invalid");
  assert.equal(validation.jobCount, 0);
});
