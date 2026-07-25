import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  companyDisplayExpression,
  companyMatchExpression,
  humanizeIdentifier,
  normalizeCompanyValue,
} from "../src/company-name.mjs";

// The invariant this module exists to hold, checked against a real SQLite rather than against a
// second copy of the expected answer written in JavaScript -- which is precisely how the three
// implementations that preceded it drifted apart without anyone noticing.
//
// What drift cost, measured on production before the fix: the table rendered an iCIMS board as
// "Vhchealth" while the filter matched "careers vhchealth", so ?company=Vhchealth returned 0 where
// ?company=Careers%20Vhchealth returned 664. Across iCIMS (218,421 active jobs) and Paylocity
// (95,507) that was 25% of the index where clicking the company name emptied the table.

function withRows(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE jobs (
    company_identifier TEXT NOT NULL,
    company_name TEXT,
    provider TEXT NOT NULL
  )`);
  const insert = db.prepare("INSERT INTO jobs (company_identifier, company_name, provider) VALUES (?, ?, ?)");
  for (const row of rows) insert.run(row.identifier, row.name ?? null, row.provider);
  return db;
}

// Every provider shape the index actually contains, with a real production example for each.
const CASES = [
  { provider: "greenhouse", identifier: "stripe", name: "Stripe", expected: "Stripe" },
  { provider: "greenhouse", identifier: "acme-corp", name: null, expected: "Acme Corp" },
  { provider: "ashby", identifier: "deliveroo", name: "Deliveroo", expected: "Deliveroo" },
  // Workday identifiers are "tenant|wdN|site"; only the tenant is a company.
  { provider: "workday", identifier: "roche|wd3|roche-ext", name: null, expected: "Roche" },
  { provider: "workday", identifier: "aaco|wd1|site", name: null, expected: "Aaco" },
  // iCIMS tenants register as the careers subdomain. This is the case that was broken.
  { provider: "icims", identifier: "careers-vhchealth", name: null, expected: "Vhchealth" },
  { provider: "icims", identifier: "careers-reliant-rehab", name: null, expected: "Reliant Rehab" },
  { provider: "icims", identifier: "jobs.didiglobal", name: null, expected: "Didiglobal" },
  // A careers- prefix on any OTHER provider is part of the name, not packaging -- the strip is
  // gated on the provider in both the JS and the SQL, and this pins that they agree about it.
  { provider: "greenhouse", identifier: "careers-collective", name: null, expected: "Careers Collective" },
  // Paylocity boards are keyed by a bare GUID. The ingester now reads the real employer out of
  // pageData.ModuleTitle; a board whose ATS published none falls back to the identifier, which is
  // ugly but round-trips -- unlike the invented "Paylocity employer 54C656" it replaced.
  { provider: "paylocity", identifier: "54c656b3-6cbc", name: "Toyota Sunnyvale", expected: "Toyota Sunnyvale" },
  // Lower-case, because \b\w only uppercases a character that STARTS a word and a digit already
  // occupies that position here. Ugly, and pinned deliberately: it is what the column expression
  // computes too, which is the only property that matters for the filter to work.
  { provider: "paylocity", identifier: "54c656b3-6cbc", name: null, expected: "54c656b3 6cbc" },
  // A name is a name whatever it contains; only the identifier fallback gets rewritten.
  { provider: "lever", identifier: "alphabet", name: "Alphabet, Inc.", expected: "Alphabet, Inc." },
];

test("the rendered company name round-trips through the filter's SQL", () => {
  const db = withRows(CASES.map((row) => ({ ...row })));
  const matched = db.prepare(`SELECT ${companyMatchExpression()} AS value FROM jobs`).all();

  CASES.forEach((row, index) => {
    const rendered = row.name || humanizeIdentifier(row.identifier, row.provider);
    assert.equal(rendered, row.expected, `display for ${row.provider}:${row.identifier}`);
    // This is the whole point: what the table renders, normalized, must be what the column
    // expression computes -- otherwise clicking the name filters to nothing.
    assert.equal(
      normalizeCompanyValue(rendered),
      matched[index].value,
      `round-trip for ${row.provider}:${row.identifier}`,
    );
  });
});

test("the dropdown aggregate groups on the same value the filter matches", () => {
  // Two boards of one Workday company, which is exactly the case the display expression exists for:
  // grouped raw they are three unrecognisable rows, grouped on the tenant they are one company.
  const db = withRows([
    { identifier: "roche|wd3|roche-ext", name: null, provider: "workday" },
    { identifier: "roche|wd5|roche-int", name: null, provider: "workday" },
    { identifier: "careers-vhchealth", name: null, provider: "icims" },
  ]);
  // Spread: node:sqlite hands back null-prototype rows, which deepEqual distinguishes from plain
  // objects.
  const rows = db.prepare(`
    SELECT ${companyDisplayExpression()} AS company, count(*) AS n FROM jobs GROUP BY company ORDER BY company
  `).all().map((row) => ({ ...row }));

  assert.deepEqual(rows, [
    { company: "roche", n: 2 },
    { company: "vhchealth", n: 1 },
  ]);
});

test("a table alias changes the SQL but not the answer", () => {
  const db = withRows([{ identifier: "careers-vhchealth", name: null, provider: "icims" }]);
  const bare = db.prepare(`SELECT ${companyMatchExpression()} AS value FROM jobs`).get();
  const aliased = db.prepare(`SELECT ${companyMatchExpression("j")} AS value FROM jobs j`).get();
  assert.equal(bare.value, aliased.value);
  assert.equal(bare.value, "vhchealth");
});

test("separators are read one at a time on both sides", () => {
  // SQLite has no regex, so the column side can only replace character by character: "acme--corp"
  // becomes "acme  corp" there no matter what. A collapsing `+` on the JS side would have made the
  // two stop comparing equal -- the near-miss this module exists to eliminate.
  const db = withRows([{ identifier: "acme--corp", name: null, provider: "greenhouse" }]);
  const matched = db.prepare(`SELECT ${companyMatchExpression()} AS value FROM jobs`).get();
  assert.equal(normalizeCompanyValue(humanizeIdentifier("acme--corp", "greenhouse")), matched.value);
});
