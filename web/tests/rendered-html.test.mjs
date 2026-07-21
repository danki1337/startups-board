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
  assert.match(html, /Company/);
  assert.match(html, /Workplace/);
  assert.match(html, /Ashby/);
  assert.match(html, /Role title/);
  assert.match(html, /All countries/);
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
  assert.match(explorer, /<SearchField/);
  assert.match(explorer, /<table/);
  // Filters are multi-select pills plus plain selects for date/sort; the old single-value
  // FilterSelect could not express "Remote or Hybrid".
  assert.match(explorer, /MultiSelect/);
  assert.match(explorer, /PlainSelect/);
  assert.match(explorer, /aria-pressed=/);
  assert.match(styles, /@import "@heroui\/styles"/);
  assert.match(layout, /Startup jobs — Startups\.board/);
  assert.match(packageJson, /"@heroui\/react"/);
  assert.match(packageJson, /"react-virtuoso"/);
});
