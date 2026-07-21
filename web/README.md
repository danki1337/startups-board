# Startups.board web

The public HeroUI frontend for Startups.board: a searchable index of startup roles published on company ATS pages.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed by vinext. The page currently uses a representative dataset in `app/jobs.ts`; the next implementation step is connecting it to the normalized jobs database produced by the discovery service.

## Verify

```bash
npm run build
npm test
```

## Main files

- `app/jobs-explorer.tsx` — interactive search and filters
- `app/jobs.ts` — typed preview job data
- `app/globals.css` — visual system and motion
- `app/layout.tsx` — metadata and social preview
