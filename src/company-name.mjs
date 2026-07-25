// One definition of "what is this company called", shared by every place that has to answer it.
//
// There used to be three, and they disagreed. The table rendered `humanizeIdentifier`, the filter
// compared against an inline SQL expression in jobs-query.ts, and the Company dropdown was built
// from a second, slightly different copy of that expression in cloudflare/src/database.mjs. So an
// iCIMS board stored as "careers-vhchealth" rendered as "Vhchealth" in the table, was offered as
// "Careers Vhchealth" in the dropdown, and matched as "careers vhchealth" in the filter -- which
// means clicking the company name in a row returned zero jobs. Measured on production that was
// iCIMS (218,421 jobs) plus Paylocity (95,507) = 313,928 active postings, 25% of the index, where
// the most obvious interaction on the page emptied the table.
//
// The invariant these three functions exist to hold, pinned by test/company-name.test.mjs:
//
//   normalizeCompanyValue(humanizeIdentifier(identifier, provider))
//     === what companyMatchExpression() computes for the same row
//
// Anything that renders, offers, or matches a company name goes through here.

// iCIMS tenants are almost always registered as the careers subdomain rather than the company
// ("careers-vhchealth", "jobs.acme"), so the prefix is packaging, not part of the name.
const ICIMS_PREFIX = /^(?:careers|jobs)[.-]/i;

/**
 * The company name as a reader should see it: the provider's own name when there is one, otherwise
 * the identifier with its provider-specific packaging removed and separators read as spaces.
 *
 * @param {string} value  company_name if present, else company_identifier
 * @param {string} provider
 */
export function humanizeIdentifier(value, provider) {
  let identifier = value || "Unknown company";
  // Workday identifiers are "tenant|wdN|site"; only the tenant is a company.
  if (provider === "workday") identifier = identifier.split("|")[0];
  if (provider === "icims") identifier = identifier.replace(ICIMS_PREFIX, "");
  // Paylocity boards are keyed by a bare GUID and used to render as "Paylocity employer 54C656" --
  // a label invented here, present in no column, and therefore unmatchable by the filter it was
  // handed to. The generic path below at least round-trips. It is also nearly moot now: the
  // Paylocity payload carries the real employer in window.pageData.ModuleTitle and the ingester
  // reads it, so a board only reaches this line when its ATS published no title at all.
  return identifier
    .replace(/^www\./, "")
    // One space per separator, NOT per run of them. SQLite has no regex, so the column side can only
    // replace character by character -- "acme--corp" becomes "acme  corp" there no matter what. A
    // `+` here would collapse it to one space and the two sides would stop comparing equal, which is
    // precisely the class of near-miss this module exists to eliminate. HTML collapses the run when
    // it renders, so nothing is visibly different.
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

/**
 * The same value reduced to its comparison form. Case and separators are the only things a company
 * name can differ by between the stored row and the value a chip or a dropdown hands back.
 *
 * @param {string} value
 */
export function normalizeCompanyValue(value) {
  // Per separator, not per run -- see the note in humanizeIdentifier. The trim mirrors the SQL
  // trim() below, for identifiers that begin or end with a separator.
  return String(value ?? "").toLowerCase().replace(/[._-]/g, " ").trim();
}

/**
 * SQL for the identifier with its provider-specific packaging removed -- the column-side half of
 * `humanizeIdentifier`, minus the cosmetics (case, separators) that `normalizeCompanyValue` folds
 * away on both sides anyway.
 *
 * SQLite has no regex, so the two prefixes are matched by length. `instr` returns 0 when absent,
 * which is why the Workday branch tests it explicitly rather than relying on substr.
 *
 * @param {string} [alias] table alias, e.g. "j" -- omit when the query selects from `jobs` directly
 */
function identifierExpression(alias = "") {
  const q = alias ? `${alias}.` : "";
  return `CASE
    WHEN instr(${q}company_identifier, '|') > 0
      THEN substr(${q}company_identifier, 1, instr(${q}company_identifier, '|') - 1)
    WHEN ${q}provider = 'icims' AND lower(substr(${q}company_identifier, 1, 8)) IN ('careers-', 'careers.')
      THEN substr(${q}company_identifier, 9)
    WHEN ${q}provider = 'icims' AND lower(substr(${q}company_identifier, 1, 5)) IN ('jobs-', 'jobs.')
      THEN substr(${q}company_identifier, 6)
    ELSE ${q}company_identifier
  END`;
}

/**
 * The display value the Company dropdown groups on -- a real name when a provider supplied one,
 * otherwise the cleaned identifier. Still in the stored casing; prettyCompanies() titlecases it for
 * display, exactly as the table does.
 *
 * @param {string} [alias]
 */
export function companyDisplayExpression(alias = "") {
  const q = alias ? `${alias}.` : "";
  return `coalesce(nullif(${q}company_name, ''), ${identifierExpression(alias)})`;
}

/**
 * The display value reduced to the same comparison form `normalizeCompanyValue` produces, so the
 * filter's equality test compares like with like.
 *
 * @param {string} [alias]
 */
export function companyMatchExpression(alias = "") {
  return `trim(lower(replace(replace(replace(${companyDisplayExpression(alias)}, '-', ' '), '_', ' '), '.', ' ')))`;
}
