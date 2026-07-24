import assert from "node:assert/strict";
import test from "node:test";
import { aggregatorJobIdentity, getProvider, parseAtsUrl } from "../src/providers.mjs";

test("parses a global Lever job URL without lowercasing the site identifier", () => {
  const result = parseAtsUrl("https://jobs.lever.co/AcmeCo/2b319d7a");

  assert.equal(result.provider, "lever");
  assert.equal(result.identifier, "AcmeCo");
  assert.equal(result.region, "global");
  assert.equal(result.apiUrl, "https://api.lever.co/v0/postings/AcmeCo?mode=json");
});

test("parses an EU Lever URL", () => {
  const result = parseAtsUrl("https://jobs.eu.lever.co/example/123");

  assert.equal(result.provider, "lever");
  assert.equal(result.region, "eu");
  assert.match(result.apiUrl, /^https:\/\/api\.eu\.lever\.co/);
});

test("parses legacy and current Greenhouse URLs", () => {
  const legacy = parseAtsUrl("https://boards.greenhouse.io/example?gh_jid=123");
  const current = parseAtsUrl("https://job-boards.greenhouse.io/example/jobs/123");

  assert.equal(legacy.identifier, "example");
  assert.equal(current.identifier, "example");
  assert.equal(current.apiUrl, "https://boards-api.greenhouse.io/v1/boards/example/jobs");
});

test("parses an Ashby job URL", () => {
  const result = parseAtsUrl("https://jobs.ashbyhq.com/example/123/application");

  assert.equal(result.provider, "ashby");
  assert.equal(result.identifier, "example");
  assert.equal(result.apiUrl, "https://api.ashbyhq.com/posting-api/job-board/example");
});

test("parses Gem board and job URLs into the same public API board", () => {
  const board = parseAtsUrl("https://jobs.gem.com/Agora");
  const job = parseAtsUrl("https://jobs.gem.com/agora/am9icG9zdDoyExample");

  assert.equal(board.provider, "gem");
  assert.equal(board.identifier, "agora");
  assert.equal(board.key, job.key);
  assert.equal(board.apiUrl, "https://api.gem.com/job_board/v0/agora/job_posts/");
});

test("parses Getro network and job URLs into one public board", () => {
  const board = parseAtsUrl("https://hv.getro.com/jobs");
  const job = parseAtsUrl("https://hv.getro.com/companies/acme/jobs/123-software-engineer");
  const organization = parseAtsUrl("https://www.getro.org/jobs");

  assert.equal(board.provider, "getro");
  assert.equal(board.identifier, "hv");
  assert.equal(board.key, job.key);
  assert.equal(board.boardUrl, "https://hv.getro.com/jobs");
  assert.equal(organization.identifier, "getro.org");
  assert.equal(parseAtsUrl("https://api.getro.com/api/v2/jobs"), null);
});

test("parses a BambooHR careers URL", () => {
  const result = parseAtsUrl("https://acme.bamboohr.com/careers/42");
  assert.equal(result.provider, "bamboohr");
  assert.equal(result.identifier, "acme");
  assert.equal(result.apiUrl, "https://acme.bamboohr.com/careers/list");

  const discoveredFromRobots = parseAtsUrl("https://another-company.bamboohr.com/robots.txt");
  assert.equal(discoveredFromRobots.identifier, "another-company");
  assert.equal(parseAtsUrl("https://support.bamboohr.com/articles"), null);
});

test("parses localized and API Workday URLs into the same board", () => {
  const publicUrl = parseAtsUrl("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Berlin/Engineer_R123");
  const apiUrl = parseAtsUrl("https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs");
  const caseVariant = parseAtsUrl("https://acme.wd5.myworkdayjobs.com/external");
  assert.equal(publicUrl.provider, "workday");
  assert.equal(publicUrl.identifier, "acme|wd5|External");
  assert.equal(publicUrl.key, apiUrl.key);
  assert.equal(publicUrl.key, caseVariant.key);
  assert.equal(publicUrl.apiUrl, "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs");
});

test("parses path-based myworkdaysite.com boards into the shared Workday identifier", () => {
  const localized = parseAtsUrl(
    "https://wd1.myworkdaysite.com/en-US/recruiting/abinbev/GHQ/job/TANZANIA-DSM-HQ/OPERATOR_30022343",
  );
  const bare = parseAtsUrl("https://wd1.myworkdaysite.com/recruiting/abinbev/GHQ");
  assert.equal(localized.provider, "workday");
  assert.equal(localized.identifier, "abinbev|wd1|GHQ");
  assert.equal(localized.key, bare.key);
  assert.equal(localized.boardUrl, "https://wd1.myworkdaysite.com/recruiting/abinbev/GHQ");
  assert.equal(localized.apiUrl, "https://wd1.myworkdaysite.com/wday/cxs/abinbev/GHQ/jobs");

  // The same tenant|wdN|site on the host-based domain must collapse to one canonical board.
  const hostBased = parseAtsUrl("https://abinbev.wd1.myworkdayjobs.com/GHQ");
  assert.equal(hostBased.key, localized.key);

  // Implementation sandboxes and non-recruiting paths are not boards.
  assert.equal(parseAtsUrl("https://impl-wd501.myworkdaysite.com/recruiting/syssero/Syssero_External"), null);
  assert.equal(parseAtsUrl("https://wd1.myworkdaysite.com/wday/other/abinbev/GHQ"), null);
});

test("parses iCIMS and Paylocity board identifiers", () => {
  const icims = parseAtsUrl("https://careers-acme.icims.com/jobs/123/software-engineer/job");
  const paylocity = parseAtsUrl(
    "https://recruiting.paylocity.com/recruiting/jobs/All/12345678-abcd-1234-abcd-123456789abc/acme",
  );
  assert.equal(icims.provider, "icims");
  assert.equal(icims.identifier, "careers-acme");
  assert.equal(icims.apiUrl, "https://careers-acme.icims.com/sitemap.xml");
  assert.equal(paylocity.provider, "paylocity");
  assert.equal(paylocity.identifier, "12345678-abcd-1234-abcd-123456789abc");
});

test("parses Spark Hire Recruit (Comeet) board and job URLs", () => {
  const board = parseAtsUrl("https://www.comeet.com/jobs/fluenttech/E5.00E");
  const job = parseAtsUrl(
    "https://www.comeet.com/jobs/fluenttech/E5.00E/big-data-engineer/D0.A6B",
  );
  assert.equal(board.provider, "sparkhire");
  assert.equal(board.identifier, "fluenttech|E5.00E");
  assert.equal(board.key, job.key);
  assert.equal(board.apiUrl, "https://www.comeet.com/jobs/fluenttech/E5.00E");
});

test("rejects unrelated and provider system URLs", () => {
  assert.equal(parseAtsUrl("https://example.com/jobs"), null);
  assert.equal(parseAtsUrl("https://jobs.ashbyhq.com/embed"), null);
  assert.equal(parseAtsUrl("https://jobs.gem.com/robots.txt"), null);
  assert.equal(parseAtsUrl("https://www.getro.com/jobs"), null);
  assert.equal(parseAtsUrl("not a URL"), null);
});

test("maps aggregator target URLs to the native ATS job identity", () => {
  // Greenhouse/Ashby/Lever/SmartRecruiters match on the globally-unique id extracted from the URL,
  // which equals the native source_id even when the board slug or its casing was rebranded.
  assert.deepEqual(
    aggregatorJobIdentity("https://boards.greenhouse.io/star-catcher/jobs/4326578009"),
    { provider: "greenhouse", sourceId: "4326578009" },
  );
  assert.deepEqual(
    aggregatorJobIdentity("https://job-boards.greenhouse.io/capco/jobs/8038012?gh_jid=8038012"),
    { provider: "greenhouse", sourceId: "8038012" },
  );
  assert.deepEqual(
    aggregatorJobIdentity("https://jobs.ashbyhq.com/ostrom/7b54377b-d5de-4d3c-83e7-c507995f8dbf"),
    { provider: "ashby", sourceId: "7b54377b-d5de-4d3c-83e7-c507995f8dbf" },
  );
  assert.deepEqual(
    aggregatorJobIdentity("https://jobs.ashbyhq.com/ostrom/7b54377b/application"),
    { provider: "ashby", sourceId: "7b54377b" },
  );
  assert.deepEqual(
    aggregatorJobIdentity("https://jobs.lever.co/palantir/67110929-adea-41c3-851a-8882e222d9e4"),
    { provider: "lever", sourceId: "67110929-adea-41c3-851a-8882e222d9e4" },
  );
  assert.deepEqual(
    aggregatorJobIdentity("https://jobs.smartrecruiters.com/WesternDigital/744000139130068-lead"),
    { provider: "smartrecruiters", sourceId: "744000139130068" },
  );

  // Workday req ids repeat across tenants, so the whole native key is returned and it must equal
  // the key the native crawler builds for the same posting.
  const workday = aggregatorJobIdentity(
    "https://adobe.wd5.myworkdayjobs.com/external_experienced/job/New-York/Product-Security-Engineer_R168782",
  );
  const nativeBoard = parseAtsUrl("https://adobe.wd5.myworkdayjobs.com/external_experienced");
  assert.equal(workday.key, `${nativeBoard.key}:Product-Security-Engineer_R168782`);

  // Career sites we do not crawl, board/landing pages, and junk stay unique to the aggregator.
  assert.equal(aggregatorJobIdentity("https://www.amazon.jobs/en/jobs/123/swe"), null);
  assert.equal(aggregatorJobIdentity("https://boards.greenhouse.io/star-catcher"), null);
  assert.equal(aggregatorJobIdentity("https://adobe.wd5.myworkdayjobs.com/external_experienced"), null);
  assert.equal(aggregatorJobIdentity("not a URL"), null);
});

test("SmartRecruiters pagination does not truncate when totalFound is absent", async () => {
  // Number(undefined ?? 0) is 0, so `jobs.length >= totalFound` used to be true after the very
  // first page: a 250-job board returned 100 jobs, and the snapshot closed the other 150.
  const pages = [
    { content: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` })) },
    { content: Array.from({ length: 100 }, (_, i) => ({ id: `b${i}` })) },
    { content: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}` })) },
  ];
  let call = 0;
  const jobs = await getProvider("smartrecruiters").fetchJobs(
    { apiUrl: "https://api.smartrecruiters.com/v1/companies/acme/postings" },
    async () => new Response(JSON.stringify(pages[call++]), { headers: { "content-type": "application/json" } }),
  );
  assert.equal(jobs.length, 250);
});

test("Lever pagination stops when a board repeats a page", async () => {
  // A board whose API ignores `skip` used to drive the loop to its 1,000-page ceiling, issuing a
  // thousand requests and accumulating 100,000 duplicates before failing.
  const page = Array.from({ length: 100 }, (_, i) => ({ id: `job-${i}` }));
  let calls = 0;
  const jobs = await getProvider("lever").fetchJobs(
    { apiUrl: "https://api.lever.co/v0/postings/acme" },
    async () => {
      calls += 1;
      return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
    },
  );
  assert.equal(jobs.length, 100);
  assert.equal(calls, 2, "should stop after the first repeated page, not run to the page ceiling");
});

test("Greenhouse regional board hosts parse as boards", () => {
  // job-boards.eu/.anz are already fetched by the domain-matched discovery target and answer on the
  // same boards-api endpoint; the parser used to reject them, discarding the whole EU cohort.
  for (const host of ["boards.greenhouse.io", "job-boards.greenhouse.io", "job-boards.eu.greenhouse.io", "job-boards.anz.greenhouse.io"]) {
    const board = parseAtsUrl(`https://${host}/anydesk`);
    assert.equal(board?.provider, "greenhouse", host);
    assert.equal(board?.identifier, "anydesk", host);
  }
  // Greenhouse's marketing and API hosts are still not boards.
  assert.equal(parseAtsUrl("https://www.greenhouse.io/pricing")?.provider, undefined);
});
