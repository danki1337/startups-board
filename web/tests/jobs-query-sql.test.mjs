import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

// The statements queryJobs actually builds, captured from a recording D1 rather than grepped out of
// the source. Every bug pinned below was invisible in a source grep and obvious in the SQL: the
// missing ESCAPE reads perfectly well as `LIKE ?`, and the count's condition slice reads perfectly
// well as `slice(0, -1)`.

const hasBuild = await access(new URL("../dist/server/index.js", import.meta.url))
  .then(() => true, () => false);
const testWithBuild = hasBuild
  ? test
  : (name) => test(name, { skip: "web/dist is absent - run `npm run build` in web/ first" }, () => {});

// ONE recorder for the whole file, writing into whichever array `capture` has installed. It cannot
// be per-call: the cloudflare:workers shim resolves to a data: URL, module instances are cached by
// specifier, and its `export const env` is evaluated exactly once -- so a second recorder handed to
// __CLOUDFLARE_TEST_ENV__ would never be seen and every capture after the first would come back
// empty. Cache-busting the worker import does not help, because the shim is the module that holds
// the binding.
let sink = [];

const recorder = {
  prepare: (sql) => {
    const record = { sql, bindings: [] };
    const statement = {
      bind: (...bindings) => {
        record.bindings = bindings;
        return statement;
      },
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    };
    sink.push(record);
    return statement;
  },
  batch: async (prepared) => prepared.map(() => ({ results: [{ total: 0 }] })),
};

globalThis.__CLOUDFLARE_TEST_ENV__ = { DB: recorder };

const worker = hasBuild
  ? (await import(new URL("../dist/server/index.js", import.meta.url).href)).default
  : null;

async function capture(search) {
  sink = [];
  const response = await worker.fetch(
    new Request(`http://localhost/api/jobs?${search}`),
    { DB: recorder, ASSETS: { fetch: async () => new Response("", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200, `GET /api/jobs?${search}`);
  return sink;
}

// The row query is the one that selects columns; the count is the one that counts. Naming them by
// shape rather than by position keeps these tests from breaking every time a statement is added.
const rowQuery = (statements) => statements.find((s) => /FROM \(/.test(s.sql));
const countQuery = (statements) => statements.find((s) => /count\(\*\) AS total/.test(s.sql));

testWithBuild("a LIKE filter escapes the caller's wildcards", async () => {
  const statements = await capture("location=100%25%20remote");
  const rows = rowQuery(statements);

  // Without ESCAPE the value is not matched, it is executed. Measured on production before the fix,
  // ?location=%25 returned all 1,240,216 active rows and ?location=_aris was byte-for-byte the same
  // response as ?location=paris.
  assert.match(rows.sql, /LIKE \? ESCAPE '\\'/);
  assert.ok(
    rows.bindings.includes("%100\\% remote%"),
    `expected an escaped binding, got ${JSON.stringify(rows.bindings)}`,
  );
});

testWithBuild("the location filter narrows through the FTS index first", async () => {
  const statements = await capture("location=new%20york");
  const rows = rowQuery(statements);

  // A leading-wildcard LIKE over an expression cannot use any index, so this was a scan of every
  // active row: 3.5s in production against 0.52s for the indexed ?city=Berlin. jobs_fts has indexed
  // the location column since the first migration.
  assert.match(rows.sql, /jobs_fts WHERE jobs_fts MATCH \?/);
  assert.ok(
    rows.bindings.some((value) => value === 'location:("new" AND "york"*)'),
    `expected a location-scoped MATCH, got ${JSON.stringify(rows.bindings)}`,
  );
});

testWithBuild("the oldest sort reads the raw column so the index can serve it", async () => {
  const statements = await capture("sort=oldest");
  const rows = rowQuery(statements);

  // coalesce(published_at, '') and published_at order identically -- SQLite already puts NULLs
  // first in ASC -- but only one of them is the indexed column. The expression made ?sort=oldest a
  // full sort of 1.24M rows and the slowest request the API served, at 5.9s.
  assert.doesNotMatch(rows.sql, /coalesce\(j\.published_at/);
  assert.match(rows.sql, /ORDER BY j\.published_at ASC, j\.key DESC/);
});

testWithBuild("a browse count keeps every filter when the cursor is not a keyset", async () => {
  // An offset cursor belongs to the search path. Reaching browse with one -- clearing the search box
  // while paging, or sharing that URL -- used to make the count slice off its last condition on the
  // assumption that it was the cursor clause, when no cursor clause had been added at all.
  const offsetCursor = Buffer.from(JSON.stringify({ offset: 20 })).toString("base64");
  const statements = await capture(`workplace=Remote&cursor=${encodeURIComponent(offsetCursor)}`);
  const rows = rowQuery(statements);
  const count = countQuery(statements);

  assert.match(rows.sql, /j\.workplace IN/);
  // The count is prepared even on a cursor page (it is simply not executed), so its WHERE is
  // observable here and must still carry the filter.
  assert.match(count.sql, /j\.workplace IN/);
});

testWithBuild("the company filter compares against the shared display expression", async () => {
  const statements = await capture("company=Vhchealth");
  const rows = rowQuery(statements);

  // The iCIMS careers- strip, which is what made ?company=Vhchealth return 0 while the table linked
  // to exactly that value. See src/company-name.mjs and test/company-name.test.mjs.
  assert.match(rows.sql, /provider = 'icims'/);
  assert.ok(
    rows.bindings.includes("vhchealth"),
    `expected the normalized company value, got ${JSON.stringify(rows.bindings)}`,
  );
});
