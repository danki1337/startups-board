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

async function render(search = "") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  globalThis.__CLOUDFLARE_TEST_ENV__ = { DB: stubD1() };
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost/${search}`, { headers: { accept: "text/html" } }),
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
  assert.match(html, /<title>Startup jobs — Aboard/);
  assert.match(html, /<table/);
  assert.match(html, /Workplace/);
  // The first column and its filter pill call the same field the same name.
  assert.match(html, />Title</);
  // The filter row renders one dropdown pill per filter, then the search field and the date pill.
  assert.match(html, /placeholder="Search"/);
  assert.match(html, />Title</);
  assert.match(html, />Job type</);
  assert.match(html, />Country</);
  assert.match(html, />ATS</);
  // The date pill shows the cropped label ("All", "24h", "7d"); the menu below it spells each one
  // out, but that only exists once the popover is opened.
  assert.match(html, />All</);
  assert.doesNotMatch(html, />Any time</);
  // City and Industry have no dropdown of their own, and sort is not a control at all. Both
  // filters still work from a URL or a chip -- only the pill is gone. Industry is hidden because
  // 55% of active jobs have no industry, so selecting every option returns half the index.
  assert.doesNotMatch(html, />City</);
  assert.doesNotMatch(html, />Industry</);
  assert.doesNotMatch(html, />Sort</);
  // The results table is virtualized, which renders nothing until it mounts and measures unless it
  // is given initialItemCount. Without that the server shipped a header over an empty box and the
  // rows it had already queried were invisible until hydration (and invisible to crawlers full
  // stop). Assert real cells in the markup, not just data in the RSC payload.
  assert.match(html, /<td/);
  assert.match(html, /<tbody/);
  // Rows come from the stub D1, proving the server render actually queries rather than falling
  // back to a bundled fixture.
  assert.match(html, /Staff Platform Engineer/);
  assert.match(html, /Acme/);
  assert.match(html, /Berlin, Germany/);
  assert.doesNotMatch(html, /Find the work|worth doing|How the index works/i);
  assert.doesNotMatch(html, /Sample data|Demo fallback/i);
  // The posting is reachable without a mouse, and reachable by a crawler. Opening a job used to be
  // an onClick on the <tr> with no tabIndex, no role and no key handler -- so a keyboard user could
  // reach the watchlist star, the company and the location and had no way at all to reach the job,
  // which is WCAG 2.1.1 at level A. It also meant 1.24M postings carried no href.
  assert.match(html, /<a[^>]+href="https:\/\/job-boards\.greenhouse\.io\/acme\/jobs\/1"[^>]*>Staff Platform Engineer</);
});

testWithBuild("Clear all appears only once there is more than one thing to clear", async () => {
  // With a single filter its own chip already carries an X that does exactly what Clear all does,
  // so the two sat side by side offering the same action twice.
  const one = await (await render("?workplace=Remote")).text();
  assert.match(one, /Remote/, "the workplace chip should be on the page");
  assert.doesNotMatch(one, />Clear all</);

  const two = await (await render("?workplace=Remote&country=de")).text();
  assert.match(two, />Clear all</);

  // The date filter has no chip of its own -- the date pill shows its own selection -- but Clear all
  // resets it too, so one chip plus a date really is two filters.
  const chipPlusDate = await (await render("?workplace=Remote&postedWithin=7")).text();
  assert.match(chipPlusDate, />Clear all</);

  // No filters at all: the whole strip is collapsed, so neither appears.
  const none = await (await render()).text();
  assert.doesNotMatch(none, />Clear all</);
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
  // Cropped values get their full text back on hover/focus. The tooltip is portalled to <body> and
  // measures the element first: the previous ::after version was clipped out of existence by the
  // same overflow:hidden that truncated the text, and it fired on values that were never cropped.
  assert.match(explorer, /useTruncationTip/);
  assert.match(explorer, /createPortal/);
  assert.match(explorer, /scrollWidth <= el\.clientWidth/);
  assert.match(styles, /\.tip-bubble/);
  assert.doesNotMatch(explorer, /data-tip/);
  // Country is a multi-select like industry: the API already read it as a comma-separated set.
  assert.match(explorer, /country: string\[\]/);
  assert.match(explorer, /selected=\{filters\.country\}/);
  assert.match(explorer, /FILTER_VALUE_MAX/);
  assert.doesNotMatch(explorer, /SearchSelectList/);
  // Every scroll box is inside a rounded, clipped container, so the scrollbar is styled rather than
  // left as a macOS overlay bar drawn over the sticky table header and the dropdowns' checkboxes.
  // The native bar is hidden outright and replaced by an overlay drawn as a sibling of the scroller.
  // Neither native option survives a rounded, clipped container: a gutter cuts a white notch out of
  // the corners, an overlay bar gets sliced by the same radius.
  assert.match(explorer, /<OverlayScrollbar/);
  assert.match(styles, /\.overlay-scrollbar-thumb/);
  assert.match(styles, /scrollbar-width: none/);
  assert.doesNotMatch(styles, /scrollbar-width: thin/);
  // `none`, not `contain`: contain still allows the box to rubber-band past its own top, and the
  // sticky column header rides that bounce.
  assert.match(styles, /overscroll-behavior: none/);
  // The row separator is an inset shadow, not a border, so it adds no height and rows are exactly
  // the 60px fixedItemHeight promises.
  assert.match(styles, /box-shadow: inset 0 -1px 0/);
  assert.doesNotMatch(styles, /tbody tr td \{[^}]*border-bottom/);
  // Company has a dropdown of its own, backed by the job_companies aggregate.
  assert.match(explorer, /<CompanyCheckList/);
  assert.match(explorer, /companiesUrl/);
  // The section claims the viewport and the card flexes into what is left, so the page itself does
  // not scroll and the sticky column header cannot be carried off with it.
  assert.match(explorer, /min-h-\[100dvh\]/);
  assert.match(explorer, /TABLE_MIN_HEIGHT/);
  // Dropdown rows share one radius.
  assert.doesNotMatch(explorer, /rounded-lg px-2 py-1\.5/);
  // A failed fetch is a visible, retryable state rather than a console message: the first page gets
  // an error panel, a stale-results banner, and infinite scroll keeps its cursor so it can retry.
  assert.match(explorer, /Couldn&rsquo;t load jobs/);
  assert.match(explorer, /setRetryToken/);
  assert.match(explorer, /setPagingError/);
  assert.match(explorer, /<JobsSkeleton/);
  // Logo outcomes outlive the row: the virtualizer unmounts a row as it leaves the viewport, so
  // per-row state made every scroll-back replay the placeholder and fade on an image already held
  // in the browser cache.
  assert.match(explorer, /const logoOutcome = new Map<string, "ok" \| "bad">\(\)/);
  // The TABLE logo is eager and low-priority: virtualization already limits it to rows near the
  // viewport, so lazy only added a second visibility check. The dropdown mark stays lazy -- that
  // list is long and mostly off-screen, which is the case lazy exists for.
  assert.match(explorer, /loading="eager"/);
  assert.match(explorer, /fetchPriority="low"/);
  // One page, one layout: the earlier /v2-/v4 experiments and their `variant` switch are gone.
  assert.doesNotMatch(explorer, /variant/);
  // Hover feedback is instant everywhere; only press-scale and the dropdown enter keep a transition.
  assert.doesNotMatch(explorer, /transition-colors/);
  assert.doesNotMatch(styles, /transition: background-color/);
  // The dropdown popover still plays its one-shot enter.
  assert.match(styles, /@keyframes dropdown-in/);
  assert.match(explorer, /dropdown-in/);
  // Pink is the primary, at the brand hue. --accent-strong is the text-safe partner: the brand
  // colour is 3.80:1 on white, which clears the 3:1 a focus ring needs but not the 4.5:1 body text
  // does, so the two are deliberately different values and both are asserted.
  assert.match(styles, /--accent: #f50fb4/);
  // Deliberately the same value: every pink foreground is the brand colour now. The token stays
  // separate because it marks the text-bearing uses, which is where a darker shade would go back.
  assert.match(styles, /--accent-strong: #f50fb4/);
  // The wash is the one pink that must NOT match -- text is drawn on it.
  assert.doesNotMatch(styles, /--accent-wash: #f50fb4/);
  assert.match(styles, /@import "@heroui\/styles"/);
  assert.match(layout, /Startup jobs — Aboard/);
  assert.match(packageJson, /"@heroui\/react"/);
  assert.match(packageJson, /"react-virtuoso"/);
  // TWO text colours, and only two. --ink is what you read, --muted is everything supporting it.
  // There used to be four (--muted-strong at 0.88 and --glyph #868990 as well), which with a single
  // 700 weight left colour as the ONLY hierarchy signal and then spent it on distinctions nobody
  // could name. Both survivors clear 4.5:1 on the darkest ground either sits on.
  assert.match(styles, /--ink: #16161a/);
  assert.match(styles, /--muted: rgba\(60, 60, 67, 0\.74\)/);
  // The retired pair must not come back as tokens -- the comment explaining them may mention the
  // names, so this checks for a DEFINITION rather than a mention.
  assert.doesNotMatch(styles, /^\s*--muted-strong:/m);
  assert.doesNotMatch(styles, /^\s*--glyph:/m);
  // The accent and the danger ink are deliberately NOT part of that scale: they are semantic, not a
  // step in a neutral ramp.
  assert.match(styles, /--accent-strong: #f50fb4/);
  assert.match(styles, /--danger-ink: #8a1f1f/);
  // The previous accent survived the palette change in three focus rings because it sat INSIDE a
  // shadow-[...] arbitrary value, which the colour rule's regex did not reach into. Both the rule
  // and the rings are fixed; this pins the rings.
  assert.doesNotMatch(explorer, /#FF73E5/i);
  // A social card at last: the image had been sitting unreferenced in public/, so every link to the
  // site anywhere unfurled as a bare URL.
  assert.match(layout, /openGraph/);
  assert.match(layout, /startups-board-og\.png/);
  // The wordmark above the headline, served as a cacheable asset rather than inlined path data, and
  // named for screen readers -- a wordmark that reads as nothing is a wordmark that is not there.
  assert.match(explorer, /aboard-wordmark\.webp/);
  assert.match(explorer, /alt="Aboard"/);
});

testWithBuild("ranks text search by relevance with a bounded count", async () => {
  const query = await readFile(new URL("../app/jobs-query.ts", import.meta.url), "utf8");
  // Relevance still decides which postings match and which survive the result cap; the rows that
  // come back are then ordered newest-first, which is what people scan a job board for.
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
  // Only the first page counts. Infinite scroll never reads `total` off a cursor response, and for
  // an unfiltered browse the count is count(*) over ~1.2M rows -- the request's most expensive
  // statement, paid on every scroll page and thrown away. Skipping it took page 2+ from ~800ms to
  // ~150ms in production.
  assert.match(query, /const withCount = !cursor/);
  assert.match(query, /total: number \| null/);
});

test("the wordmark is a lossless WebP that still carries its alpha", async () => {
  // The logo sits on the page background with a soft drop shadow, so losing the alpha channel would
  // put a white box behind it, and a lossy encode would ring around every letter edge. Both are the
  // kind of thing that looks fine in a thumbnail and wrong at 3x, so they are asserted from the
  // file's own header rather than trusted to the conversion command.
  const bytes = await readFile(new URL("../public/aboard-wordmark.webp", import.meta.url));
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
  // VP8L is the lossless codec. VP8 (no L) would mean someone re-encoded it lossy.
  const chunk = bytes.subarray(12, 16).toString("ascii");
  assert.equal(chunk, "VP8L", `expected lossless VP8L, got ${chunk}`);
  // After VP8L comes the chunk size, then a 0x2f signature byte at 20, then ONE 32-bit LE field:
  // width-1 (14 bits), height-1 (14 bits), alpha_is_used (1 bit), version (3 bits). Reading it from
  // 22 instead of 21 puts every field a byte out and the alpha flag reads 0 on an image that has one.
  assert.equal(bytes[20], 0x2f, "VP8L signature byte");
  const header = bytes.readUInt32LE(21);
  assert.equal((header & 0x3fff) + 1, 354, "intrinsic width, which the markup declares");
  assert.equal(((header >> 14) & 0x3fff) + 1, 151, "intrinsic height");
  assert.ok((header >> 28) & 1, "the alpha channel must survive the conversion");
});
