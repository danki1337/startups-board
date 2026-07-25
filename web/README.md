# Aboard web

The public HeroUI frontend for Aboard: a searchable index of startup roles published on company ATS pages.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed by vinext. The page reads the real index: in production the
server render queries D1 directly, and in local dev it falls back to the SQLite API on
port 3002 (`npm run serve` from the repository root).

## Verify

```bash
npm run build
npm test
```

## Main files

- `app/jobs-explorer.tsx` — interactive search and filters
- `app/jobs.ts` — the shared `Job` type and filter option lists
- `app/globals.css` — visual system and motion
- `app/layout.tsx` — metadata and social preview
