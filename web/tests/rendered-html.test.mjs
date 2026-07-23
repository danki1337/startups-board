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
  // The compact filter bar renders Search, Title, Location, Add filter, Date and Save view as pills;
  // the rest of the filters stay hidden behind "Add filter" until the client toggles them.
  assert.match(html, /placeholder="Search"/);
  assert.match(html, />Title</);
  assert.match(html, />Location</);
  assert.match(html, /Add filter/);
  assert.match(html, /Save view/);
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
  assert.match(explorer, /<FilterBar/);
  assert.match(explorer, /<table/);
  // Filters are multi-select pills plus HeroUI Select dropdowns (FilterSelect) for the single-value
  // fields; the multi-select pills express "Remote or Hybrid" that one dropdown cannot.
  assert.match(explorer, /MultiSelect/);
  assert.match(explorer, /FilterSelect/);
  assert.match(explorer, /<Select\.Trigger/);
  // Saved views and the company watchlist toggle live in the results toolbar.
  assert.match(explorer, /ViewsToolbar/);
  assert.match(explorer, /watchlistOnly/);
  // The pills use HeroUI's ToggleButtonGroup, which owns selection state and the aria wiring the
  // hand-rolled buttons used to set themselves.
  assert.match(explorer, /<ToggleButtonGroup/);
  assert.match(explorer, /selectionMode="multiple"/);
  assert.match(styles, /@import "@heroui\/styles"/);
  assert.match(layout, /Startup jobs — Startups\.board/);
  assert.match(packageJson, /"@heroui\/react"/);
  assert.match(packageJson, /"react-virtuoso"/);
});
