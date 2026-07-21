import assert from "node:assert/strict";
import test from "node:test";
import { parseAtsUrl } from "../src/providers.mjs";

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
