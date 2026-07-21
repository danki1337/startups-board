import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDatabaseStats, importJobSnapshot, queryActiveJobs } from "../src/database.mjs";

test("imports snapshots, updates jobs, and retains closed-job history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "startups-board-db-"));
  const databasePath = join(directory, "jobs.db");
  const jobsPath = join(directory, "jobs.json");
  const syncPath = join(directory, "sync.json");

  await writeSnapshot({
    jobsPath,
    syncPath,
    syncedAt: "2026-07-20T10:00:00.000Z",
    jobs: [job("one", "Platform Engineer"), job("two", "Product Manager")],
  });
  await importJobSnapshot({ databasePath, jobsPath, syncPath });

  let result = await queryActiveJobs({ search: "platform" }, databasePath);
  assert.equal(result.total, 1);
  assert.equal(result.jobs[0].title, "Platform Engineer");

  await writeSnapshot({
    jobsPath,
    syncPath,
    syncedAt: "2026-07-20T12:00:00.000Z",
    jobs: [{ ...job("one", "Staff Platform Engineer"), category: "Engineering" }],
  });
  await importJobSnapshot({ databasePath, jobsPath, syncPath });

  result = await queryActiveJobs({}, databasePath);
  assert.equal(result.total, 1);
  assert.equal(result.jobs[0].title, "Staff Platform Engineer");

  const concurrentReads = await Promise.all(
    Array.from({ length: 8 }, () => queryActiveJobs({ provider: "ashby" }, databasePath)),
  );
  assert.ok(concurrentReads.every((read) => read.total === 1));
  assert.deepEqual(await getDatabaseStats(databasePath), {
    activeJobs: 1,
    closedJobs: 1,
    activeBoards: 1,
    lastSyncedAt: "2026-07-20T12:00:00.000Z",
  });
});

function job(id, title) {
  return {
    key: `ashby:global:example:${id}`,
    sourceId: id,
    boardKey: "ashby:global:example",
    provider: "ashby",
    companyIdentifier: "example",
    title,
    location: "Remote",
    workplace: "Remote",
    employmentType: "Full-time",
    department: "Product & Engineering",
    category: title.includes("Product") ? "Product & Design" : "Engineering",
    descriptionPlain: "Build useful software.",
    publishedAt: "2026-07-20T09:00:00.000Z",
    url: `https://jobs.ashbyhq.com/example/${id}`,
    applyUrl: `https://jobs.ashbyhq.com/example/${id}/application`,
    compensation: "$100k",
    syncedAt: "2026-07-20T10:00:00.000Z",
  };
}

async function writeSnapshot({ jobsPath, syncPath, syncedAt, jobs }) {
  const syncedJobs = jobs.map((record) => ({ ...record, syncedAt }));
  await writeFile(
    jobsPath,
    JSON.stringify({
      syncedAt,
      summary: {
        boardCount: 1,
        jobCount: syncedJobs.length,
        statuses: { active: 1 },
      },
      jobs: syncedJobs,
    }),
  );
  await writeFile(
    syncPath,
    JSON.stringify({
      syncedAt,
      summary: {
        boardCount: 1,
        jobCount: syncedJobs.length,
        statuses: { active: 1 },
      },
      boards: [
        {
          key: "ashby:global:example",
          provider: "ashby",
          identifier: "example",
          status: "active",
          jobCount: syncedJobs.length,
          syncedAt,
          error: null,
        },
      ],
    }),
  );
}
