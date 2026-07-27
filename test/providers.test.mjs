import assert from "node:assert/strict";
import test from "node:test";
import { aggregatorJobIdentity, getProvider, parseAtsUrl, workdayLocation } from "../src/providers.mjs";

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

test("Lever pagination throws when a board repeats a page, instead of truncating", async () => {
  // A board whose API ignores `skip` used to drive the loop to its 1,000-page ceiling; then it
  // stopped after the repeat but RETURNED the partial list -- which read as "the board shrank" and
  // closed everything past the repeat point. A repeated page is a failed refresh: the throw
  // classifies it invalid, which leaves the board's previous snapshot alone.
  const page = Array.from({ length: 100 }, (_, i) => ({ id: `job-${i}` }));
  let calls = 0;
  await assert.rejects(
    getProvider("lever").fetchJobs(
      { apiUrl: "https://api.lever.co/v0/postings/acme" },
      async () => {
        calls += 1;
        return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
      },
    ),
    /repeated a page/,
  );
  assert.equal(calls, 2, "still stops after the first repeated page, not the page ceiling");
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

test("an Ashby board slug may contain spaces", () => {
  // Verified live: api.ashbyhq.com/posting-api/job-board/Solana%20Foundation returns 9 jobs, and
  // no hyphenated or squashed variant of the slug exists -- solana-foundation and solanafoundation
  // both 404. firstPathSegment decodes the %20 before the identifier is validated, and the space
  // failed the character class, so parse() returned null and the board was discarded at discovery.
  // The only Solana Foundation posting in the index was the single copy Getro happened to re-list.
  const result = parseAtsUrl("https://jobs.ashbyhq.com/Solana%20Foundation");
  assert.equal(result?.provider, "ashby");
  assert.equal(result.identifier, "solana foundation");
  assert.equal(result.apiUrl, "https://api.ashbyhq.com/posting-api/job-board/solana%20foundation");
});

test("Ashby identifiers are lower-cased, because Ashby resolves them case-insensitively", () => {
  // /Solana%20Foundation, /solana%20foundation and /SOLANA%20FOUNDATION all return the same board.
  // Registering two casings would register two boards and duplicate every posting on it -- the
  // collision already fixed for Greenhouse, SmartRecruiters and Rippling. Lever is NOT included:
  // it is genuinely case-sensitive, which the first test in this file pins.
  const upper = parseAtsUrl("https://jobs.ashbyhq.com/Deliveroo/123");
  const lower = parseAtsUrl("https://jobs.ashbyhq.com/deliveroo/123");
  assert.equal(upper.key, lower.key);
  assert.equal(upper.identifier, "deliveroo");
});

test("a slug carries internal spaces only -- the edges are trimmed off", () => {
  // firstPathSegment trims the decoded segment, so a stray leading or trailing %20 is dropped
  // rather than becoming part of the identifier (and then part of the API URL, which would 404).
  assert.equal(parseAtsUrl("https://jobs.ashbyhq.com/%20acme%20")?.identifier, "acme");
  assert.equal(parseAtsUrl("https://jobs.ashbyhq.com/two%20word%20co")?.identifier, "two word co");
  // A segment that is nothing but a space is not an identifier at all.
  assert.equal(parseAtsUrl("https://jobs.ashbyhq.com/%20"), null);
});

test("Workday's location count gives up the place hidden in the posting path", () => {
  // locationsText is literally "2 Locations" on 28,214 active rows -- a number, not a place, so
  // those rows resolved to no country, drew no flag and could not be filtered by city. The primary
  // location is published in externalPath all the same.
  assert.equal(
    workdayLocation("2 Locations", "/job/Beijing/Clinical-Research-Expert_202607-118594-1"),
    "Beijing · 2 Locations",
  );
  // Workday writes spaces as hyphens in the path.
  assert.equal(workdayLocation("3 Locations", "/job/New-York/Staff-Engineer_123"), "New York · 3 Locations");
  assert.equal(workdayLocation("Multiple locations", "/job/Chengdu/Analyst_9"), "Chengdu · Multiple locations");
});

test("a real location, or a path with no place in it, is left alone", () => {
  // Only the count case is rewritten; a named location passes straight through.
  assert.equal(workdayLocation("Guangzhou", "/job/Guangzhou/Manager_1"), "Guangzhou");
  // No usable path segment: keep the bare count rather than inventing a place.
  assert.equal(workdayLocation("2 Locations", "/details/Something_1"), "2 Locations");
  assert.equal(workdayLocation("2 Locations", ""), "2 Locations");
  assert.equal(workdayLocation(null, "/job/Berlin/Role_1"), null);
});

test("Workday pagination survives the total:0 every page after the first reports", async () => {
  // Verified live against usbank.wd1: offset 0 answers total=1486, offsets 20 and 40 answer
  // total=0 while still returning 20 real postings each. The stop condition was
  // `jobs.length >= payload.total`, so after two pages it asked `40 >= 0`, said yes, and dropped
  // the other 1,446. The registry wore that plainly: 1,509 active Workday boards held EXACTLY 40
  // jobs, ten times the next most common value, with no bump at 20, 60 or 80.
  const PAGE = 20;
  const REAL_TOTAL = 65;
  const pages = [];
  for (let offset = 0; offset < REAL_TOTAL; offset += PAGE) {
    pages.push({
      // Only the first page tells the truth about the count, exactly as Workday does.
      total: offset === 0 ? REAL_TOTAL : 0,
      jobPostings: Array.from({ length: Math.min(PAGE, REAL_TOTAL - offset) }, (_, index) => ({
        title: `Role ${offset + index}`,
        externalPath: `/job/Berlin/Role-${offset + index}`,
        locationsText: "Berlin",
      })),
    });
  }

  let call = 0;
  const request = async () => new Response(JSON.stringify(pages[call++]), { headers: { "content-type": "application/json" } });
  const workday = getProvider("workday");
  const jobs = await workday.fetchJobs(
    { apiUrl: "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/careers/jobs", boardUrl: "https://acme.wd1.myworkdayjobs.com/careers" },
    request,
  );

  assert.equal(jobs.length, REAL_TOTAL, "every page is walked, not just the two that fit under total:0");
  assert.equal(call, pages.length, "and it stops on the short final page rather than paging forever");
});

test("Workday still stops when a real total says it should", async () => {
  // The zeros are ignored, not all totals: a board whose count genuinely moves mid-crawl must still
  // bound the walk, which is what the original stop condition was written for.
  const pages = [
    { total: 20, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `A${i}`, externalPath: `/job/X/A-${i}` })) },
    { total: 20, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `B${i}`, externalPath: `/job/X/B-${i}` })) },
  ];
  let call = 0;
  const request = async () => new Response(JSON.stringify(pages[call++]), { headers: { "content-type": "application/json" } });
  const jobs = await getProvider("workday").fetchJobs(
    { apiUrl: "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/careers/jobs", boardUrl: "https://acme.wd1.myworkdayjobs.com/careers" },
    request,
  );
  assert.equal(jobs.length, 20, "a full page that already meets the stated total ends the walk");
  assert.equal(call, 1);
});

test("Greenhouse reads the company name it was already being sent", () => {
  // All 4,553 Greenhouse boards used to fall back to humanising their URL slug, because this field
  // was in the payload and unread. A slug has no spaces: "paperlessparts" rendered as
  // "Paperlessparts", which read wrong in the table AND could not be found --
  // ?company=Paperless%20Parts returned 0 of its 18 jobs and a search for "paperless parts"
  // returned nothing, while "paperlessparts" returned all 18. The board was never missing.
  const candidate = parseAtsUrl("https://job-boards.greenhouse.io/paperlessparts");
  const normalized = getProvider("greenhouse").normalizeJob(candidate, {
    id: 4321,
    title: "Senior Technical Consultant",
    company_name: "Paperless Parts",
    location: { name: "Boston, MA" },
    absolute_url: "https://job-boards.greenhouse.io/paperlessparts/jobs/4321",
    updated_at: "2026-07-20T00:00:00.000Z",
  }, "2026-07-27T00:00:00.000Z");

  assert.equal(normalized.companyName, "Paperless Parts");
  // The identifier still rides along -- it is the board key and the fallback when a provider sends
  // no name at all, which is still true of eight of the twelve.
  assert.equal(normalized.companyIdentifier, "paperlessparts");
});

test("a Greenhouse board that sends no company name still falls back to its slug", () => {
  const candidate = parseAtsUrl("https://job-boards.greenhouse.io/example");
  const normalized = getProvider("greenhouse").normalizeJob(candidate, {
    id: 1,
    title: "Engineer",
    absolute_url: "https://job-boards.greenhouse.io/example/jobs/1",
  }, "2026-07-27T00:00:00.000Z");

  assert.equal(normalized.companyName, null, "null, not an empty string -- the display coalesce tests for NULL");
  assert.equal(normalized.companyIdentifier, "example");
});
