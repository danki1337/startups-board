import assert from "node:assert/strict";
import test from "node:test";
import { toPublicJob } from "../src/server.mjs";

test("maps database jobs to the public API schema", () => {
  const result = toPublicJob({
    key: "greenhouse:global:example:1",
    provider: "greenhouse",
    companyIdentifier: "example-company",
    companyName: "Example, Inc.",
    companyLogoUrl: "https://cdn.example.test/logo.png",
    title: "Machine Learning Engineer",
    location: "Remote",
    workplace: "Remote",
    employmentType: "Full-time",
    category: "AI & Research",
    publishedAt: "2026-07-20T10:00:00.000Z",
    url: "https://job-boards.greenhouse.io/example/jobs/1",
    description: "Build models.",
  });

  assert.equal(result.company, "Example, Inc.");
  assert.equal(result.companyLogoUrl, "https://cdn.example.test/logo.png");
  assert.equal(result.source, "Greenhouse");
  assert.equal(result.title, "Machine Learning Engineer");
});
