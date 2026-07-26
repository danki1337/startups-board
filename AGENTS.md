# Aboard

A job index built from public ATS boards: a Cloudflare Worker + D1 + Queues backend (`src/`,
`cloudflare/`) and a vinext/React 19 frontend (`web/`).

The product is **Aboard**. The deployed resources are still named `startups-board` — the worker, the
D1 database, the R2 bucket, all thirteen queues and the workers.dev subdomain — and that is
deliberate: renaming a Cloudflare resource creates a NEW one, so it would mean re-provisioning the
database, re-creating every queue and migrating 1.2M rows to change a string nobody sees. The name
follows the domain whenever a custom one lands; until then the two differ on purpose.

## Skills

**Any task touching `web/app/` loads the `product-design` skill first**
(`.claude/skills/product-design/SKILL.md`). It carries the interface conventions, the exemplars of
what has already gone wrong here, and — importantly — `references/coverage-gaps.md`, the list of
things that have no standard yet. Several of the conventions are counterintuitive and were paid for
in shipped defects; do not re-derive them from the JSX.

## Governance

- **Deterministic rules live in `tools/design-lint.mjs`, not in prose.** It runs in `npm test` and
  in CI. If you find a defect the linter could have caught, add the rule in the same change. If it
  could not have, add an exemplar.
- **New guidance needs evidence.** A rule enters `interface-quality.md` when it points at a real
  defect in `exemplars.md`, not when it sounds correct.
- **Boundaries are written down.** `ats-marks.tsx` is exempt from the colour and type rules because
  it holds vendor brand assets. Any future exemption is named and justified in the linter itself —
  an unexplained ignore is how a linter stops meaning anything.

## Verification

`npm test` (the full suite + design lint; Node 22+, see .nvmrc) and `cd web && npm run build` must both pass. UI work is
verified in the browser, not in the source: run the preview, exercise the interaction, read the
rendered DOM. Several past defects were invisible in JSX and obvious on screen.

## Deploy

`npm run cloudflare:deploy` builds `web/` and publishes the worker. Migrations are separate and run
first: `npm run cloudflare:migrate`. `.env.production` holds the live `ADMIN_TOKEN` and must never
be committed.
