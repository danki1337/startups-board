import assert from "node:assert/strict";
import test from "node:test";
import { syncBoard, syncJobs, summarizeSync } from "../src/jobs.mjs";
import { parseAtsUrl } from "../src/providers.mjs";

test("normalizes listed Ashby jobs into the shared schema", async () => {
  const board = parseAtsUrl("https://jobs.ashbyhq.com/example/123");
  const result = await syncBoard(board, {
    retries: 0,
    syncedAt: "2026-07-20T00:00:00.000Z",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          jobs: [
            {
              title: "Product Engineer",
              location: "Remote",
              workplaceType: "Remote",
              employmentType: "FullTime",
              department: "Engineering",
              descriptionPlain: "Build the product.",
              publishedAt: "2026-07-19T12:00:00Z",
              jobUrl: "https://jobs.ashbyhq.com/example/job-123",
              applyUrl: "https://jobs.ashbyhq.com/example/job-123/application",
              isListed: true,
            },
            {
              title: "Unlisted role",
              jobUrl: "https://jobs.ashbyhq.com/example/hidden",
              isListed: false,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  assert.equal(result.board.status, "active");
  assert.equal(result.board.jobCount, 1);
  assert.equal(result.jobs[0].key, "ashby:global:example:job-123");
  assert.equal(result.jobs[0].workplace, "Remote");
  assert.equal(result.jobs[0].category, "Engineering");
  assert.equal(result.jobs[0].employmentType, "Full-Time");
  assert.equal(result.jobs[0].companyIdentifier, "example");
});

test("normalizes Gem public job-board posts into the shared schema", async () => {
  const board = parseAtsUrl("https://jobs.gem.com/agora/example-job");
  const result = await syncBoard(board, {
    retries: 0,
    syncedAt: "2026-07-20T00:00:00.000Z",
    fetchImpl: async () => Response.json([{
      id: "job-123",
      title: "Senior Fullstack Engineer",
      first_published_at: "2026-03-03T20:57:49.071Z",
      content: "<p>Build reliable products.</p>",
      content_plain: "Build reliable products.",
      departments: [{ id: "department-1", name: "Engineering" }],
      offices: [{ name: "HQ", location: { name: "Jersey City, United States" } }],
      location: { name: "Jersey City, United States" },
      location_type: "remote",
      employment_type: "full_time",
      absolute_url: "https://jobs.gem.com/agora/job-123",
    }]),
  });

  assert.equal(result.board.status, "active");
  assert.equal(result.board.jobCount, 1);
  assert.equal(result.jobs[0].key, "gem:global:agora:job-123");
  assert.equal(result.jobs[0].location, "Jersey City, United States");
  assert.equal(result.jobs[0].workplace, "Remote");
  assert.equal(result.jobs[0].employmentType, "full time");
  assert.equal(result.jobs[0].category, "Engineering");
  assert.equal(result.jobs[0].publishedAt, "2026-03-03T20:57:49.071Z");
});

test("discovers, paginates, and normalizes Getro network jobs", async () => {
  const board = parseAtsUrl("https://hv.getro.com/jobs");
  const seenPages = [];
  const page = (start, count) => Array.from({ length: count }, (_, index) => ({
    id: start + index,
    title: index === 0 && start === 0 ? "Senior Platform Engineer" : `Role ${start + index}`,
    organization: {
      name: "Acme",
      slug: "acme",
      logo_url: "https://cdn.getro.com/companies/acme",
    },
    locations: ["New York, NY", "United States"],
    work_mode: "on_site",
    employment_type: "full_time",
    created_at: 1784505600,
    slug: `${start + index}-role`,
    url: `https://careers.example.com/jobs/${start + index}`,
    compensation_public: true,
    compensation_amount_min_cents: 15000000,
    compensation_amount_max_cents: 20000000,
    compensation_currency: "USD",
    compensation_period: "year",
  }));
  const result = await syncBoard(board, {
    retries: 0,
    syncedAt: "2026-07-20T00:00:00.000Z",
    fetchImpl: async (url, init = {}) => {
      if (url === board.boardUrl) {
        return new Response(
          `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
            props: { pageProps: { network: { id: 234 } } },
          })}</script></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      const { page: requestedPage, hits_per_page: pageSize } = JSON.parse(init.body);
      seenPages.push(requestedPage);
      assert.equal(pageSize, 100);
      return Response.json({
        results: {
          jobs: requestedPage === 0 ? page(0, 100) : page(100, 1),
          count: 101,
        },
      });
    },
  });

  assert.deepEqual(seenPages, [0, 1]);
  assert.equal(result.jobs.length, 101);
  assert.equal(result.jobs[0].provider, "getro");
  assert.equal(result.jobs[0].companyName, "Acme");
  assert.equal(result.jobs[0].companyLogoUrl, "https://cdn.getro.com/companies/acme");
  assert.equal(result.jobs[0].workplace, "On-site");
  assert.equal(result.jobs[0].employmentType, "full time");
  assert.equal(result.jobs[0].publishedAt, "2026-07-20T00:00:00.000Z");
  assert.deepEqual(result.jobs[0].compensation, {
    currency: "USD",
    interval: "year",
    min: 150000,
    max: 200000,
  });
});

test("extracts and normalizes Spark Hire Recruit public careers data", async () => {
  const board = parseAtsUrl("https://www.comeet.com/jobs/fluenttech/E5.00E");
  const company = {
    name: "Fluent Trade Technologies",
    logos: { small: { url: "https://cdn.example.com/fluent.png" } },
  };
  const positions = [{
    uid: "D0.A6B",
    name: "Big Data Engineer",
    department: "Engineering",
    location: { name: "Ukraine – Remote", is_remote: true },
    employment_type: "Full-time",
    workplace_type: "Remote",
    time_updated: "2026-07-16T10:28:06Z",
    url_comeet_hosted_page: "https://www.comeet.com/jobs/fluenttech/E5.00E/big-data-engineer/D0.A6B",
  }];
  const result = await syncBoard(board, {
    retries: 0,
    syncedAt: "2026-07-20T00:00:00.000Z",
    fetchImpl: async () => new Response(`
      <script>
        COMPANY_DATA = ${JSON.stringify(company)};
        COMPANY_POSITIONS_DATA = ${JSON.stringify(positions)};
      </script>
    `, { status: 200 }),
  });

  assert.equal(result.board.status, "active");
  assert.equal(result.jobs[0].companyName, "Fluent Trade Technologies");
  assert.equal(result.jobs[0].companyLogoUrl, "https://cdn.example.com/fluent.png");
  assert.equal(result.jobs[0].workplace, "Remote");
  assert.equal(result.jobs[0].key, "sparkhire:global:fluenttech|e5.00e:D0.A6B");
});

test("paginates Lever boards until the final partial page", async () => {
  const board = parseAtsUrl("https://jobs.lever.co/example");
  const seenSkips = [];
  const result = await syncBoard(board, {
    retries: 0,
    fetchImpl: async (url) => {
      const skip = Number(new URL(url).searchParams.get("skip"));
      seenSkips.push(skip);
      const count = skip === 0 ? 100 : 2;
      const jobs = Array.from({ length: count }, (_, index) => ({
        id: `job-${skip + index}`,
        text: `Role ${skip + index}`,
        hostedUrl: `https://jobs.lever.co/example/job-${skip + index}`,
        applyUrl: `https://jobs.lever.co/example/job-${skip + index}/apply`,
        categories: { location: "New York", commitment: "Full-time" },
      }));
      return new Response(JSON.stringify(jobs), { status: 200 });
    },
  });

  assert.deepEqual(seenSkips, [0, 100]);
  assert.equal(result.jobs.length, 102);
});

test("paginates and normalizes Workday jobs", async () => {
  const board = parseAtsUrl("https://acme.wd5.myworkdayjobs.com/en-US/External");
  const seenOffsets = [];
  const result = await syncBoard(board, {
    retries: 0,
    syncedAt: "2026-07-20T12:00:00.000Z",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      seenOffsets.push(body.offset);
      const jobs = body.offset === 0
        ? Array.from({ length: 20 }, (_, index) => ({
            title: `Engineer ${index}`,
            externalPath: `/job/Remote/Engineer-${index}_R${index}`,
            locationsText: "Remote",
            postedOn: "Posted 2 Days Ago",
          }))
        : [{ title: "Designer", externalPath: "/job/London/Designer_R20", locationsText: "London" }];
      return new Response(JSON.stringify({ jobPostings: jobs, total: 21 }), { status: 200 });
    },
  });
  assert.deepEqual(seenOffsets, [0, 20]);
  assert.equal(result.jobs.length, 21);
  assert.equal(result.jobs[0].provider, "workday");
  assert.equal(result.jobs[0].workplace, "Remote");
  assert.equal(result.jobs[0].publishedAt, "2026-07-18T12:00:00.000Z");
});

test("accepts changing Workday totals and stops a silently repeated page", async () => {
  const board = parseAtsUrl("https://acme.wd5.myworkdayjobs.com/en-US/External");
  const seenOffsets = [];
  const page = (start) => Array.from({ length: 20 }, (_, index) => ({
    title: `Role ${start + index}`,
    externalPath: `/job/Remote/Role-${start + index}_R${start + index}`,
    locationsText: "Remote",
  }));
  const result = await syncBoard(board, {
    retries: 0,
    fetchImpl: async (_url, init) => {
      const { offset } = JSON.parse(init.body);
      seenOffsets.push(offset);
      if (offset === 0) return Response.json({ jobPostings: page(0), total: 41 });
      if (offset === 20) return Response.json({ jobPostings: page(20), total: 50 });
      return Response.json({ jobPostings: page(20), total: 50 });
    },
  });

  assert.deepEqual(seenOffsets, [0, 20, 40]);
  assert.equal(result.jobs.length, 40);
});

test("normalizes BambooHR, iCIMS, and Paylocity jobs", async () => {
  const bamboo = await syncBoard(parseAtsUrl("https://acme.bamboohr.com/careers"), {
    retries: 0,
    fetchImpl: async () => new Response(JSON.stringify({ result: [{
      id: 7,
      jobOpeningName: "Support Engineer",
      departmentLabel: "Engineering",
      employmentStatusLabel: "Full-time",
      location: { city: "Austin", state: "TX" },
    }] }), { status: 200 }),
  });
  const icims = await syncBoard(parseAtsUrl("https://careers-acme.icims.com/jobs/7/support-engineer/job"), {
    retries: 0,
    fetchImpl: async () => new Response(
      "<?xml version=\"1.0\"?><urlset><url><loc>https://careers-acme.icims.com/jobs/7/support-engineer/job</loc><lastmod>2026-07-19</lastmod></url></urlset>",
      { status: 200 },
    ),
  });
  const paylocity = await syncBoard(
    parseAtsUrl("https://recruiting.paylocity.com/recruiting/jobs/All/12345678-abcd-1234-abcd-123456789abc/acme"),
    {
      retries: 0,
      fetchImpl: async () => new Response(
        `<script>window.pageData = ${JSON.stringify({ Jobs: [{
          JobId: 9,
          JobTitle: "Remote Product Manager",
          IsRemote: true,
          JobLocation: { City: "Denver", State: "CO" },
          PublishedDate: "/Date(1784505600000)/",
        }] })};</script>`,
        { status: 200 },
      ),
    },
  );

  assert.equal(bamboo.jobs[0].location, "Austin, TX");
  assert.equal(icims.jobs[0].title, "Support Engineer");
  assert.equal(paylocity.jobs[0].workplace, "Remote");
  assert.equal(paylocity.jobs[0].sourceId, "9");
});

test("syncs boards concurrently and summarizes providers", async () => {
  const boards = [
    parseAtsUrl("https://jobs.lever.co/example"),
    parseAtsUrl("https://job-boards.greenhouse.io/example"),
  ];
  const result = await syncJobs(boards, {
    retries: 0,
    concurrency: 2,
    fetchImpl: async (url) => {
      if (url.includes("lever.co")) {
        return new Response(JSON.stringify([{ id: "l1", text: "Engineer", hostedUrl: "https://jobs.lever.co/example/l1" }]), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ jobs: [{ id: 1, title: "Designer", absolute_url: "https://job-boards.greenhouse.io/example/jobs/1" }] }),
        { status: 200 },
      );
    },
  });
  const summary = summarizeSync(result);

  assert.equal(summary.boardCount, 2);
  assert.equal(summary.jobCount, 2);
  assert.equal(summary.providers.lever.jobs, 1);
  assert.equal(summary.providers.greenhouse.jobs, 1);
});

test("enforces provider-specific concurrency below the global limit", async () => {
  const boards = Array.from({ length: 6 }, (_, index) =>
    parseAtsUrl(`https://job-boards.greenhouse.io/example-${index}`),
  );
  let active = 0;
  let maximumActive = 0;

  await syncJobs(boards, {
    concurrency: 6,
    providerConcurrency: { greenhouse: 2 },
    retries: 0,
    fetchImpl: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      active -= 1;
      return Response.json({ jobs: [] });
    },
  });

  assert.equal(maximumActive, 2);
});

test("streams completed boards without retaining the full job dataset", async () => {
  const boards = [parseAtsUrl("https://job-boards.greenhouse.io/example")];
  const uploaded = [];
  const result = await syncJobs(boards, {
    retries: 0,
    retainJobs: false,
    onBoardSynced: async (boardResult) => uploaded.push(boardResult),
    fetchImpl: async () => Response.json({
      jobs: [{ id: 1, title: "Engineer", absolute_url: "https://job-boards.greenhouse.io/example/jobs/1" }],
    }),
  });

  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].jobs.length, 1);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.totalJobCount, 1);
  assert.equal(summarizeSync(result).jobCount, 1);
});

test("repairs malformed Unicode from upstream job descriptions", async () => {
  const board = parseAtsUrl("https://job-boards.greenhouse.io/example");
  const result = await syncBoard(board, {
    retries: 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          jobs: [
            {
              id: 1,
              title: `Engineer ${String.fromCharCode(0xd800)}`,
              content: `<p>Valid emoji 😀 and broken ${String.fromCharCode(0xdc00)}</p>`,
              absolute_url: "https://job-boards.greenhouse.io/example/jobs/1",
            },
          ],
        }),
        { status: 200 },
      ),
  });

  assert.equal(result.jobs[0].title, "Engineer �");
  assert.match(result.jobs[0].descriptionPlain, /Valid emoji 😀 and broken �/);
});

test("does not split an emoji when truncating job descriptions", async () => {
  const board = parseAtsUrl("https://job-boards.greenhouse.io/example");
  const result = await syncBoard(board, {
    retries: 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          jobs: [
            {
              id: 1,
              title: "Engineer",
              content: `<p>${"a".repeat(3998)}😀 after cutoff</p>`,
              absolute_url: "https://job-boards.greenhouse.io/example/jobs/1",
            },
          ],
        }),
        { status: 200 },
      ),
  });

  assert.equal(result.jobs[0].descriptionPlain.length, 3999);
  assert.equal(result.jobs[0].descriptionPlain.at(-1), "…");
  assert.doesNotMatch(JSON.stringify(result.jobs[0]), /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/i);
});
