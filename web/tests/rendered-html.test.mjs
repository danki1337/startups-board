import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

// dist/ is a build artifact and deliberately not committed, so a fresh clone has nothing to
// render until `npm run build` produces it. Skipping (rather than failing) keeps `npm test`
// green for contributors while still exercising the rendered HTML wherever a build exists.
const hasBuild = await access(new URL("../dist/server/index.js", import.meta.url))
  .then(() => true, () => false);
const testWithBuild = hasBuild
  ? test
  : (name) => test(name, { skip: "web/dist is absent - run `npm run build` in web/ first" }, () => {});

// A stub D1 so the server render exercises the real queryJobs -> table path with deterministic
// rows. The page no longer carries a demo fixture, so without a database it would render its empty
// state and the test would assert nothing about the table.
const STUB_ROW = {
  key: "greenhouse:global:acme:1",
  title: "Staff Platform Engineer",
  companyIdentifier: "acme",
  companyName: "Acme",
  companyLogoUrl: null,
  location: "Berlin, Germany",
  country: "de",
  workplace: "Hybrid",
  employmentType: "Full time",
  category: "Engineering",
  provider: "greenhouse",
  publishedAt: "2026-07-20T00:00:00.000Z",
  url: "https://job-boards.greenhouse.io/acme/jobs/1",
};

function stubD1() {
  const statement = { bind: () => statement };
  return {
    prepare: () => statement,
    batch: async () => [{ results: [STUB_ROW] }, { results: [{ total: 1 }] }],
  };
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  globalThis.__CLOUDFLARE_TEST_ENV__ = { DB: stubD1() };
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      DB: stubD1(),
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

testWithBuild("server-renders the Startups.board jobs table", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Startup jobs — Startups\.board/);
  assert.match(html, /<table/);
  assert.match(html, /Workplace/);
  // The filter row renders one dropdown pill per filter, then the search field and the date pill.
  assert.match(html, /placeholder="Search"/);
  assert.match(html, />Title</);
  assert.match(html, />Job type</);
  assert.match(html, />Country</);
  assert.match(html, />Industry</);
  assert.match(html, />ATS</);
  assert.match(html, />Any time</);
  // City has no dropdown of its own, and sort is not a control at all.
  assert.doesNotMatch(html, />City</);
  assert.doesNotMatch(html, />Sort</);
  // Rows come from the stub D1, proving the server render actually queries rather than falling
  // back to a bundled fixture.
  assert.match(html, /Staff Platform Engineer/);
  assert.match(html, /Acme/);
  assert.match(html, /Berlin, Germany/);
  assert.doesNotMatch(html, /Find the work|worth doing|How the index works/i);
  assert.doesNotMatch(html, /Sample data|Demo fallback/i);
});

testWithBuild("keeps HeroUI controls and table-first filters", async () => {
  const [explorer, styles, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/jobs-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(explorer, /from "@heroui\/react"/);
  assert.match(explorer, /from "react-virtuoso"/);
  assert.match(explorer, /<TableVirtuoso/);
  assert.match(explorer, /endReached=/);
  assert.match(explorer, /<FilterDropdownBar/);
  assert.match(explorer, /<table/);
  assert.match(explorer, /FILTER_CATEGORIES/);
  assert.match(explorer, /FilterCheckbox/);
  // Selected filters are dashed "[icon] is [value]" chips.
  assert.match(explorer, /<FilterChip/);
  assert.match(explorer, /border-dashed/);
  // Date posted is a FilterDropdown like every other pill, not a HeroUI Select.
  assert.match(explorer, /<DateDropdown/);
  assert.doesNotMatch(explorer, /<Select\.Trigger/);
  assert.match(explorer, /watchlistOnly/);
  // One page, one layout: the earlier /v2-/v4 experiments and their `variant` switch are gone.
  assert.doesNotMatch(explorer, /variant/);
  // Hover feedback is instant everywhere; only press-scale and the dropdown enter keep a transition.
  assert.doesNotMatch(explorer, /transition-colors/);
  assert.doesNotMatch(styles, /transition: background-color/);
  // The dropdown popover still plays its one-shot enter.
  assert.match(styles, /@keyframes dropdown-in/);
  assert.match(explorer, /dropdown-in/);
  // Pink is the primary.
  assert.match(styles, /--accent: #ff73e5/);
  assert.match(styles, /@import "@heroui\/styles"/);
  assert.match(layout, /Startup jobs — Startups\.board/);
  assert.match(packageJson, /"@heroui\/react"/);
  assert.match(packageJson, /"react-virtuoso"/);
});

testWithBuild("ranks text search by relevance with a bounded count", async () => {
  const query = await readFile(new URL("../app/jobs-query.ts", import.meta.url), "utf8");
  // Search is ordered by bm25 relevance (title-weighted) blended with recency, not raw date.
  assert.match(query, /bm25\(jobs_fts/);
  assert.match(query, /SEARCH_WEIGHTS/);
  assert.match(query, /SEARCH_RECENCY/);
  // A broad search's total is capped ("N+") instead of an exact multi-second count.
  assert.match(query, /COUNT_CAP/);
  assert.match(query, /totalCapped/);
  // A lone single-character token is dropped so "a" cannot prefix-match the whole table.
  assert.match(query, /token\.length >= 2/);
  // Punctuation tech terms (c++, c#) ride alongside the FTS match as a substring filter.
  assert.match(query, /SPECIAL_TERMS/);
  assert.match(query, /specialSearchTerms/);
  // An exact title match outranks bm25's preference for titles that repeat the term.
  assert.match(query, /SEARCH_EXACTNESS/);
  assert.match(query, /exactnessPatterns/);
  // The recency nudge stays smaller than the exactness tiers, or it decides the order itself.
  assert.match(query, /\* 0\.0012/);
  // Repeat postings of one title at one company collapse to a single result row.
  assert.match(query, /collapseDuplicates/);
  assert.match(query, /SEARCH_OVERFETCH/);
  // Jobs-side predicates carry SQLite's unary + on the search path so the FTS index drives the plan.
  // Without it, a search combined with a column filter took 33s and returned a 500.
  assert.match(query, /const filtered = \(expression: string\) => \(isSearch \? `\+\$\{expression\}` : expression\)/);
  assert.match(query, /filtered\("j\.published_at"\)/);
  assert.match(query, /filtered\("j\.country"\)/);
});
