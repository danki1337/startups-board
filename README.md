# Startups.board

A near-zero-cost job-board system that discovers public ATS boards, refreshes
their current vacancies automatically, and serves the filterable HeroUI frontend.

The system currently supports:

- Lever, including global and EU boards.
- Greenhouse legacy and current hosted-board URLs.
- Ashby public job boards.
- Gem public hosted job boards.
- Getro public network job boards with full pagination.
- BambooHR public careers lists.
- Workday public CXS job feeds with full pagination.
- iCIMS public job sitemaps.
- Paylocity public recruiting pages.
- Spark Hire Recruit (Comeet) public careers pages.
- Common Crawl discovery across recent snapshots with evenly sampled index pages.
- Optional, credit-capped Firecrawl search for supplemental discovery.
- URL-file imports for repeatable or manually collected datasets.
- Concurrent validation, retry handling, and active-job counts.
- Provider-aware concurrency limits and jittered backoff to reduce synchronized throttling.
- Full public-job synchronization with provider-aware pagination.
- A normalized cross-provider job schema and streamed JSON exports.
- Incremental SQLite history, adaptive refresh scheduling, and a paginated local API.
- A HeroUI frontend with a virtualized `react-virtuoso` table and scroll-triggered API batches.
- JSON registry output and a Markdown coverage report.

## Requirements

- Node.js 22.13 or newer (required by the Cloudflare deployment tooling).
- The macOS `sqlite3` command-line tool.
- Network access to Common Crawl and the supported ATS APIs.

The data pipeline has no npm dependencies. The frontend installs its own packages
under `web/`.

## Quick start

Run the tests:

```bash
npm test
```

Run a deliberately small network proof of concept:

```bash
npm run poc -- --max-pages 1 --validation-limit 25
```

This writes generated files under `data/`:

- `discovered-boards.json`: deduplicated ATS board candidates.
- `validated-boards.json`: candidates with validation status and job counts.
- `discovery-report.md`: human-readable coverage summary.
- `jobs.json`: normalized current postings from every selected board.
- `job-sync.json`: per-board sync status and provider totals.

Generated data is ignored by Git because it can become large and should be regenerated.

## Run the local product

The database is already populated locally. Start the jobs API:

```bash
npm run serve
```

In a second terminal, start the frontend:

```bash
cd web
npm run dev -- --port 3001
```

Open `http://localhost:3001`. The API is at `http://localhost:3002`; its useful
endpoints are `/health`, `/api/stats`, and `/api/jobs`.

To run the API and updater together, without immediately repeating the large
initial sync:

```bash
npm run system -- --skip-initial-sync true --skip-initial-discovery true
```

## Hosted, unattended system

The production path separates short web requests from long ATS crawls:

1. Cloudflare Sites hosts the frontend, the read API, and a protected ingestion
   route. Its D1 database stores compact current-job rows and board state.
2. `.github/workflows/refresh-jobs.yml` runs daily, fetches every known public ATS
   board, and uploads each completed board immediately. A failed run can resume
   on the next schedule without constructing a giant in-memory payload.
3. `.github/workflows/discover-companies.yml` runs weekly, samples unseen Common
   Crawl index pages, and commits the expanded independent company registry.
4. A successful empty/active board snapshot closes listings absent from that
   board. A failed snapshot never closes existing jobs.

Full job descriptions remain in the optional local SQLite history, not in D1.
The hosted database retains the fields needed for search, filters, sorting, and
the original application link. This is important because the current local
database is about 692 MB, mostly description text, while D1's free per-database
limit is 500 MB.

After pushing this repository to GitHub, add these repository Actions secrets:

- `REMOTE_SYNC_URL`: `https://YOUR-SITE/api/internal/sync`
- `REMOTE_SYNC_TOKEN`: the same random value configured as the Sites runtime
  secret `SYNC_TOKEN`
- `REMOTE_SITES_TOKEN`: the Sites bypass token, required while the deployed site
  remains owner-only

Then run **Refresh hosted jobs** once with a small `sync_limit` such as `25`.
When that succeeds, run it without a limit for the initial import. Subsequent
runs write only new, changed, reopened, or closed jobs.

### Expected hosting cost

- GitHub Actions: $0 for standard runners in a public repository. Private
  repositories use the account's included minutes first.
- Cloudflare D1 free tier: 5 GB total storage, but at most 500 MB per database,
  5 million rows read/day, and 100,000 rows written/day.
- Cloudflare Workers paid plan: $5/month minimum. This is the recommended safe
  setup for the initial 150k+ job import and daily updates; the paid D1 limit is
  10 GB per database and its included quotas are much larger.

The practical budget is therefore **$0 while proving the pipeline with bounded
syncs, then about $5/month for reliable full-dataset operation**. No Firecrawl
subscription is required for daily refreshes because known ATS public endpoints
are queried directly.

## Commands

Discover boards without validating them:

```bash
npm run discover -- --max-pages 5
```

Merge discoveries from four recent Common Crawl snapshots:

```bash
npm run discover -- --index-count 4 --max-pages 5
```

Run a larger resumable identifier harvest across twelve snapshots. Each completed
Common Crawl page is checkpointed, so interrupted or repeated runs continue into
unseen index pages instead of paying for the same sample again:

```bash
npm run harvest
```

Firecrawl is optional. Create a free API key, then run a bounded search pass:

```bash
FIRECRAWL_API_KEY=fc-... npm run discover -- --firecrawl true --firecrawl-limit 50 --firecrawl-credit-budget 100
```

Validate a previous discovery result:

```bash
npm run validate -- --validation-limit 100 --concurrency 4
```

Synchronize every job from every board in the discovery registry:

```bash
npm run sync -- --concurrency 4
```

Synchronize only boards that are not yet present in SQLite:

```bash
npm run sync -- --only-new true --concurrency 4
```

Refresh active and failed boards now, empty boards after 24 hours, and invalid
boards after seven days:

```bash
npm run sync -- --adaptive true --concurrency 4
```

Use `--sync-limit 25` for a small test run. The full command reads
`data/discovered-boards.json` and writes `data/jobs.json` plus
`data/job-sync.json`. Boards are interleaved across providers, transient
requests are retried, and Lever result sets are paginated until complete.

Import an existing JSON snapshot into SQLite:

```bash
npm run database
```

Run the continuous updater by itself. It refreshes due boards every two hours and
runs discovery weekly by default:

```bash
npm run watch
```

Import known or externally collected ATS URLs without querying Common Crawl:

```bash
npm run discover -- --urls ./boards.txt --skip-common-crawl
```

The text file should contain one URL per line. JSON input can be either an array of URLs or an object with a `urls` array.

## Discovery behavior

Common Crawl results are divided into compressed index pages. The CLI queries the
page count and reads evenly spaced pages from the full range instead of taking
only the first results. Bounded samples rotate weekly, so repeated discovery
runs cover new index blocks instead of querying the same pages forever. Multiple
recent indexes can be merged to recover boards that were absent from the newest
crawl. A durable page-level coverage ledger makes larger multi-snapshot harvests
resumable and prevents redundant page downloads. BambooHR discovery extracts tenant identifiers from any public tenant
subdomain and validates the constructed careers endpoint afterward; requiring
Common Crawl to have captured `/careers` specifically missed valid tenants.

Discovery runs one GitHub Actions job per provider. A single job walked the
providers in a fixed order and hit its time limit before reaching the end of the
list, which is why Getro and Spark Hire stayed at 4 and 0 boards despite both
having Common Crawl coverage. Each provider now writes its own shard and
`scripts/merge-registry-shards.mjs` unions them back into the registry.

Firecrawl search is intentionally not the primary crawler. Its free plan is
useful for a small weekly discovery pass, while direct ATS endpoints update known
boards without consuming Firecrawl credits.

The public Common Crawl CDX service is not intended for exhaustive bulk
downloads. A future full-registry import should use the bulk URL Index through
Athena or a local analytical engine.

## Implemented scaling plan

1. Discover company identifiers independently from public ATS URLs in recent
   Common Crawl snapshots; never guess identifiers by probing ATS endpoints.
2. Normalize each supported ATS into one board and job schema, including the
   provider-specific pagination or sitemap format.
3. Merge candidates into the existing registry, validate them concurrently, and
   retain invalid/empty states so dead boards are not hammered repeatedly.
4. Refresh known active boards frequently and run the more expensive identifier
   discovery weekly.
5. Serve filtering and pagination from SQLite, while `react-virtuoso` renders
   only the visible browser rows and requests the next 100 jobs near the end.
6. Apply a global sync ceiling plus provider-specific limits: lower limits for
   Ashby and Paylocity, higher limits for direct public JSON APIs. Retries use
   exponential backoff with jitter.
7. Track provider health, failures, and job-volume changes; add each further public
   ATS adapter with fixtures before expanding crawl volume.

The architecture borrows the reference aggregator's useful operational ideas:
separate company discovery from job fetching, tune concurrency per ATS, retain
dead-board state, use multiple crawl snapshots, and monitor provider-level
volume. It deliberately improves two failure modes observed during live tests:
rotating bounded crawl samples accumulate coverage over time, and Workday pages
are deduplicated so changing totals or silently repeated pages cannot loop or
discard an otherwise valid board.

## Honest coverage boundary

For a known supported board, the synchronizer retrieves every currently
published public job exposed by that provider's public endpoint or sitemap. The
remaining coverage problem is discovering every board identifier: providers do
not publish global customer directories, Common Crawl can lag behind the live
web, and some ATS products require credentials.

Before the four new adapters were added, the local registry contained 6,567
discovered boards and 146,377 current postings from 5,447 active boards and 5,427
companies. That baseline was 95,174 Greenhouse, 48,827 Ashby, and 2,376 Lever
jobs. New providers only increase those totals after a fresh discovery and sync;
adding an adapter alone does not create a global customer directory.

To broaden the registry, query Common Crawl's bulk URL Index periodically (for
example through Athena), merge new identifiers into the registry, and then run
the normal sync. Avoid trying to enumerate customer identifiers against ATS
endpoints directly. Getro network subdomains are discovered from Common Crawl,
then their public network IDs are read from the server-rendered board before the
public search feed is paginated. Spark Hire Recruit uses its public hosted career
pages; its separate Careers API requires a company UID and API token.

## Design notes from the reference aggregator

`Feashliaa/job-board-aggregator` demonstrates several production-worthy ideas:
platform-specific concurrency, multiple Common Crawl snapshots, dead-board
caching, anomaly monitoring, and compressed static chunks. This project adopts
the multi-snapshot and adaptive-refresh ideas. Its headline job count is a
rolling union rather than a strict current-vacancy count: its merge step keeps
previously seen jobs for up to 30 days when they disappear from a fresh scrape.
Startups.board instead marks a job closed as soon as a successful board refresh
confirms it is absent, while retaining that closed record separately in SQLite.

We deliberately do not import that project's company files: its code is MIT, but
the curated datasets in its `data/` directory are CC BY-NC 4.0 and therefore
unsuitable as the foundation of a commercial product without permission. This
boundary was re-verified against the upstream README on 2026-07-21 and still
holds; an import of those files was attempted and reverted. If the coverage gap
is ever worth closing this way, the correct step is to ask the author for
commercial permission first, not to copy the files. Our registry is discovered
independently. SQLite plus server-side pagination is also a better fit for this
local, queryable product than downloading a million-job static bundle into the
browser.
