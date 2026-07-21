# Production operations

The production deployment is self-contained in Cloudflare: a Worker serves the
HeroUI app and API, D1 stores the searchable job index, provider-specific Queues
run refreshes, R2 archives closed jobs, and Cron Triggers schedule refresh and
Common Crawl discovery. GitHub, Vercel, and a continuously running local machine
are not required.

## One-command provisioning

1. Upgrade the target Cloudflare account to Workers Paid.
2. Authenticate once with `wrangler login`.
3. Run `npm run cloudflare:provision` using Node.js 22.13 or newer.

The command creates or reuses the D1 database, R2 bucket, all queues and the
dead-letter queue; applies migrations; builds and deploys the site; installs a
random operator secret; imports the complete local board registry; and queues
the initial refresh. The generated secret and production URL are stored only in
the ignored `.env.production` file.

## Normal operation

- Every 15 minutes, due boards are claimed and sent to their provider queue.
- Active boards refresh every 6 hours, empty boards every 72 hours, invalid
  boards monthly, and failures use exponential backoff.
- Weekly discovery samples four recent Common Crawl indexes and adds newly seen
  public ATS boards without guessing identifiers.
- Getro boards use their own low-concurrency queue because a large network can
  require many paginated public-feed requests.
- Closed jobs remain queryable for 30 days, then move to compressed NDJSON in R2.
- `/api/health` reports counts and per-provider health without exposing operator
  credentials.

Use the token in `.env.production` for protected operator endpoints. Re-running
the provisioning command is safe for existing queues, R2, and D1 resources; it
also deploys the current code and reimports the canonical registry.
