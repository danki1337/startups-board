# Audit and improvement plan — 2026-07-25

Everything below was measured against production
(`startups-board.dilizarov8823.workers.dev`, 1,240,216 active jobs) or reproduced in the source.
Nothing here is speculative; each item names the evidence.

---

## A. Correctness

### A1 — LIKE wildcards from the URL are unescaped · **confirmed live**

`addLikeFilter` ([web/app/jobs-query.ts:713](web/app/jobs-query.ts:713)) interpolates the user's
value into `LIKE '%value%'` with no `ESCAPE`, unlike `queryTitleSuggestions` and
`queryCompanySuggestions`, which both have it.

```
/api/jobs?location=%25    total=1240216   (the unfiltered total)
/api/jobs?location=_aris  total=5662      (identical to location=paris)
/api/jobs?title=%25       total=1240216
```

Two consequences: a company whose location or title genuinely contains `%` or `_` cannot be
filtered, and `?title=%` is a full scan **plus an unbounded `count(*)` over 1.24M rows** — the most
expensive statement the API can be made to run, reachable by anyone.

**Fix.** Escape `\ % _` and bind `ESCAPE '\'`, matching the two functions that already do it. A
value that is *only* wildcards reduces to empty and is dropped rather than becoming `%%%`.

### A2 — Clicking a company in the table returns zero jobs for 25% of the index · **confirmed live**

```
/api/jobs?company=Vhchealth                     total=0     ← what the table links to
/api/jobs?company=Careers%20Vhchealth           total=664   ← what is actually stored
/api/jobs?company=Paylocity%20employer%2054C656 total=0
```

Three separate implementations of "what is this company called" disagree:

| | where | `careers-vhchealth` becomes |
|---|---|---|
| `humanizeIdentifier` | table cell, chip, `toPublicJob` | `Vhchealth` (strips `careers-`) |
| `COMPANY_DISPLAY_SQL` | the filter's equality test | `careers vhchealth` |
| `refreshCompanySuggestions` | the dropdown aggregate | `Careers Commonspirit` |

So the table renders a name the filter cannot find, and the dropdown offers a name no reader
recognises. This is **iCIMS (218,421 jobs) + Paylocity (95,507 jobs) = 313,928 active jobs, 25% of
the index**, where the single most obvious interaction on the page — click the company — empties the
table and says "No matching jobs".

**Fix, three parts.**

- **A2a.** Paylocity's payload already carries the real employer name and it is being thrown away.
  `window.pageData.ModuleTitle` is `"Toyota Sunnyvale"` on the board whose identifier is
  `54c656b3-…`. Read it in `fetchPaylocityJobs` and set `companyName`. That gives 95,507 jobs a real
  name, a working filter and a real dropdown entry — and it is the *right* fix, not a compensating
  one.
- **A2b.** Extract the company-display expression to one exported constant shared by
  `jobs-query.ts` and `cloudflare/src/database.mjs` (today it is written out twice), and teach it the
  iCIMS `careers-`/`careers.`/`jobs-`/`jobs.` strip that `humanizeIdentifier` already performs.
- **A2c.** A test that pins the invariant for each provider shape:
  `normalizeCompanyValue(humanizeIdentifier(id, provider))` must equal what the SQL expression
  produces. This is the assertion whose absence let three implementations drift.

### A3 — A genuinely empty result is treated as a failed server render

[web/app/page.tsx:15](web/app/page.tsx:15): `if ((page.total ?? 0) > 0) return page;`

A shared URL that legitimately matches nothing (`?search=asdkjhasd`) falls through to the "database
unreachable" branch, so `hasServerData` is false, the client refetches the identical query, and the
reader sees *No matching jobs → skeleton → No matching jobs*. Zero results is an answer, not an
error.

**Fix.** Return the page whenever the query succeeded; fall through only on a thrown error.

### A4 — The count query drops a real filter when a browse request carries a search cursor

[web/app/jobs-query.ts:348](web/app/jobs-query.ts:348) slices the last condition off on
`!isSearch && cursor`, assuming it is the cursor clause. But the clause is only pushed when the
cursor is a *keyset* cursor ([:281](web/app/jobs-query.ts:281)). Hand a browse request an offset
cursor — clear the search box while paging, share the URL — and the slice removes a genuine filter
instead. Currently masked because `withCount` is false whenever a cursor exists, so the malformed
statement is prepared and never run. It is a live trap for the next person who changes either line.

**Fix.** Gate the slice on the same condition that pushes the clause.

### A5 — A remote URL is built from unvalidated database text

[web/app/jobs-explorer.tsx:166](web/app/jobs-explorer.tsx:166) does
`src={`https://flagcdn.com/${cc}.svg`}` where `cc` is `job.country`, ingested from a dozen ATS
payloads. Any stored value becomes a path segment.

**Fix.** Render the `<img>` only for `/^[a-z]{2}$/`; anything else falls back to the emoji path that
already exists beside it.

### A6 — A one-character company filter skips the FTS narrowing and full-scans

`companyFtsQuery` drops tokens shorter than two characters and returns null, but the exact-match
condition is still added on `companyValue?.trim()` being truthy
([:190](web/app/jobs-query.ts:190)). `?company=X` therefore evaluates
`lower(replace(replace(replace(coalesce(…)))))= 'x'` over every active row, with no index and an
unbounded count.

**Fix.** When there is no FTS narrowing to apply, the equality still runs but the count is bounded —
or, more simply, a value with no usable token matches nothing and is dropped.

---

## B. Performance — four unindexed paths, all measured

Two runs each, warm, against production:

| request | time | cause |
|---|---|---|
| `sort=oldest` | **5.9 s** | `ORDER BY coalesce(published_at,'')` — an expression, so `jobs_active_published_idx` cannot satisfy it; sorts 1.24M rows |
| `location=new york` | **3.5 s** | leading-wildcard LIKE over `lower(coalesce(location,''))` — full scan |
| `sort=company` | **3.6 s** | `ORDER BY lower(coalesce(company_name, company_identifier))` — expression, no index |
| `employmentType=Full-time` | **3.3 s** | `lower(replace(employment_type,'-',' '))` — expression, no index |
| — for contrast — | | |
| `country=de,fr,gb` | 0.55 s | indexed |
| `city=Berlin` | 0.52 s | indexed |
| `company=Stripe` | 0.78 s | FTS-narrowed |
| `title=Software Engineer` | 0.81 s | FTS-narrowed |

### B1 — `sort=oldest`: drop the coalesce

`coalesce(published_at,'') ASC` and `published_at ASC` order identically in SQLite — the empty
string sorts before every ISO date, and SQLite already puts NULLs first in ASC. The `coalesce` buys
nothing and costs the index. Removing it also means the oldest-sort cursor needs the same two-phase
null handling `newest` already has, inverted (nulls first, then dates).

### B2 — `location`: narrow through FTS first

`jobs_fts` already indexes `location` ([0001_production.sql:60](cloudflare/migrations/0001_production.sql:60)).
This is exactly the shape that took the title filter from ~4 s to ~0.2 s and the company filter from
13.4 s to 0.94 s: FTS narrows, the LIKE stays as the exactness check.

### B3/B4 — expression indexes (migration `0013`)

```sql
CREATE INDEX jobs_company_sort_idx
  ON jobs(is_active, lower(coalesce(company_name, company_identifier)), key);
CREATE INDEX jobs_employment_active_idx
  ON jobs(lower(replace(employment_type, '-', ' ')), is_active, published_at DESC);
```

SQLite has supported indexes on deterministic expressions since 3.9; both expressions above are
deterministic and are written to match the query text exactly. No backfill — an index builds itself.

---

## C. Accessibility

### C1 — The primary action of the entire product is mouse-only · WCAG 2.1.1, Level A

Opening a posting is `onClick` on the `<tr>` ([:2029](web/app/jobs-explorer.tsx:2029)) with no
`tabIndex`, no `role`, no key handler. A keyboard user can reach the watchlist star, the company
button and the location button — everything *except* the job. There is also nothing for a crawler to
follow, so 1.24M postings are invisible to search engines.

**Fix.** Make the job title a real `<a href={job.url}>` inside its cell. A `<td>` may legally contain
an anchor (only wrapping the `<tr>` is illegal, which is what the current comment is about). That
restores keyboard access, middle-click, "open in new tab", and gives every row a crawlable link. The
row click stays for mouse users, and its `closest("a,button")` guard already defers to it.

### C2 — `--muted` fails AA on body text

`rgba(60,60,67,0.6)` over `--canvas` resolves to ≈`rgb(137,137,141)`, luminance 0.251 → **3.43:1**.
It is used for real body copy: the empty state, "Location not specified", the multi-location label.

**Fix.** Take it to the lightest value that clears 4.5:1 and keeps the hierarchy against
`--muted-strong`.

---

## D. Reach

### D1 — No `robots.txt`, no sitemap, no social card

A public index of 1.24M job postings ships `title` and `description` and nothing else: no
`openGraph`, no `twitter`, no canonical, no `robots.txt`, no sitemap. With C1 landed (every row a
real link) there is finally something worth crawling.

**Fix.** `robots.txt` and a small `sitemap.xml` (the site's own filter surfaces, not 1.24M rows) plus
OpenGraph/Twitter metadata in `layout.tsx`.

---

## E. Hygiene

- **E1.** Delete the 8 unused `LineIcon` components left from an earlier design — the entire current
  lint warning count.
- **E2.** Delete `cleanupClosedJobs`, superseded by `archiveAndCleanupClosedJobs` and called by
  nothing.

---

## Verification

- `npm test` (92 tests + design lint + web lint) and `cd web && npm run build`.
- New tests: LIKE escaping, the company-display invariant per provider, the oldest-sort cursor,
  `loadFirstPage` on a zero-result query.
- Re-measure all four B paths against production after deploy; the target is < 1 s each.
- Re-run the A2 probes: `?company=Vhchealth` and the Paylocity board must both return their real
  totals.
- Keyboard: Tab into the table, confirm the title takes focus and Enter opens the posting.

## Found during the pass, fixed beyond the plan

- **Three focus rings kept the previous accent pink** (`#FF73E5`) through the change that replaced
  every other instance of it, because they sit inside `shadow-[inset_0_0_0_1.5px_#FF73E5]` and the
  linter's colour rule only matched a hex that *filled* an arbitrary value. Rings fixed, and the
  rule widened to look inside brackets — which is what `AGENTS.md` asks for when a linter could have
  caught something and didn't.
- **Five copies of "what is this company called"**, not the three the audit found: `src/server.mjs`
  and `src/database.mjs` (the local dev API and its query layer) each held their own. All five now
  import `src/company-name.mjs`.
- **Every remaining untokenized colour promoted or merged**: `#F5F5FA` collapsed into
  `--control-hover` (two levels apart and doing the same job), `#ECECF4` → `--control-active`,
  `#868990` → `--glyph`, and the error banner's pair → `--danger-wash` / `--danger-ink`.

## Deliberately not in this pass

- The **title pipeline** (`~/.claude/plans/graceful-nibbling-noodle.md`) — a 1.24M-row backfill and
  its own migration. Unchanged and still worth doing; it is a separate piece of work, not a bug fix.
- The **corpus skew** — a board called Startups.board led by Amazon, Lowe's and J.P. Morgan. Also
  real, also its own piece.
- **Where the undated rows sit in `sort=oldest`.** Ascending puts the ~82k rows with no publish date
  first, so "Oldest" opens on hundreds of pages of "—". That is unchanged behaviour — `coalesce(…,
  '')` did exactly the same, since `''` sorts before every date — and it is now 10× faster, but it
  is still wrong: a posting with no date is not the oldest posting. Moving it means running the
  dated phase first and handing off to the undated tail at the end, the mirror of what `newest`
  does. The reason it is not in this pass: the handoff only fires after ~1.16M dated rows are
  exhausted, so it cannot be exercised end-to-end, and an untestable rewrite of the pagination
  cursor is not worth a cosmetic ordering preference. Worth doing with a seeded fixture database
  behind it.
