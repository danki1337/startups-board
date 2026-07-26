import { env } from "cloudflare:workers";

// The raw D1 binding. There used to be a Drizzle client beside this (template leftover), whose
// schema had frozen at migration 0002 while production moved on to 0019 -- a typed model missing
// five columns the app reads, waiting for its first caller. The real schema lives in
// cloudflare/migrations/ and every query goes through hand-written SQL in jobs-query.ts.
export function getD1() {
  if (!env.DB) {
    throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  }
  return env.DB;
}
