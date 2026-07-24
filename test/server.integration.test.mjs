import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importJobSnapshot } from "../src/database.mjs";
import { startApiServer } from "../src/server.mjs";

test("serves paginated jobs and health from SQLite", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "startups-board-api-"));
  const databasePath = join(directory, "jobs.db");
  const jobsPath = join(directory, "jobs.json");
  const syncPath = join(directory, "sync.json");
  const syncedAt = "2026-07-20T10:00:00.000Z";
  const board = {
    key: "greenhouse:global:example",
    provider: "greenhouse",
    identifier: "example",
    status: "active",
    jobCount: 1,
    syncedAt,
    error: null,
  };
  const job = {
    key: "greenhouse:global:example:1",
    sourceId: "1",
    boardKey: board.key,
    provider: "greenhouse",
    companyIdentifier: "example-company",
    title: "Machine Learning Engineer",
    location: "Remote",
    workplace: "Remote",
    employmentType: "Full-time",
    department: "AI",
    category: "AI & Research",
    descriptionPlain: "Build models.",
    publishedAt: syncedAt,
    url: "https://job-boards.greenhouse.io/example/jobs/1",
    applyUrl: "https://job-boards.greenhouse.io/example/jobs/1",
    compensation: null,
    syncedAt,
  };

  const summary = { boardCount: 1, jobCount: 1, statuses: { active: 1 } };
  await writeFile(jobsPath, JSON.stringify({ syncedAt, summary, jobs: [job] }));
  await writeFile(syncPath, JSON.stringify({ syncedAt, summary, boards: [board] }));
  await importJobSnapshot({ databasePath, jobsPath, syncPath });

  const server = startApiServer({ port: 0, databasePath });
  context.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${origin}/health`).then((response) => response.json());
  assert.equal(health.activeJobs, 1);

  const payload = await fetch(`${origin}/api/jobs?search=machine&limit=10`).then((response) =>
    response.json(),
  );
  assert.equal(payload.total, 1);
  assert.equal(payload.jobs[0].company, "Example Company");
  assert.equal(payload.jobs[0].source, "Greenhouse");
});
