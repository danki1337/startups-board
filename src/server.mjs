import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDatabaseStats, queryActiveJobs } from "./database.mjs";

const COMPANY_COLORS = [
  "bg-[#ebe7ff] text-[#5436a8]",
  "bg-[#ffe8dc] text-[#9b3d0a]",
  "bg-[#e1f1ef] text-[#15645a]",
  "bg-[#e8eefc] text-[#294f9f]",
  "bg-[#f4e5ef] text-[#8c326d]",
  "bg-[#f1eadb] text-[#76551f]",
  "bg-[#e5efe3] text-[#386a31]",
  "bg-[#e7ecf0] text-[#34495b]",
];

export function startApiServer(options = {}) {
  const port = Number(options.port ?? process.env.JOBS_API_PORT ?? 3002);
  const hostname = options.hostname ?? "127.0.0.1";
  const databasePath = resolve(options.databasePath ?? "data/jobs.db");

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    setCors(response, request);

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    try {
      if (url.pathname === "/health") {
        const stats = await getDatabaseStats(databasePath);
        sendJson(response, 200, { ok: true, databasePath, ...stats });
        return;
      }
      if (url.pathname === "/api/stats") {
        sendJson(response, 200, await getDatabaseStats(databasePath));
        return;
      }
      if (url.pathname === "/api/jobs") {
        // The frontend paginates with the production route's opaque-cursor contract, so this
        // local server accepts the same `cursor` parameter (a base64 offset here) and returns
        // `nextCursor`. Without it the jobs table stops dead at the first page.
        const requestedOffset = decodeOffsetCursor(url.searchParams.get("cursor"))
          ?? Number(url.searchParams.get("offset") ?? 0);
        const result = await queryActiveJobs(
          {
            search: url.searchParams.get("search"),
            location: url.searchParams.get("location"),
            company: url.searchParams.get("company"),
            provider: url.searchParams.get("provider"),
            workplace: url.searchParams.get("workplace"),
            category: url.searchParams.get("category"),
            employmentType: url.searchParams.get("employmentType"),
            postedWithin: url.searchParams.get("postedWithin"),
            sort: url.searchParams.get("sort"),
            limit: url.searchParams.get("limit"),
            offset: requestedOffset,
          },
          databasePath,
        );
        const consumed = requestedOffset + result.jobs.length;
        sendJson(response, 200, {
          ...result,
          jobs: result.jobs.map(toPublicJob),
          nextCursor: result.jobs.length > 0 && consumed < result.total
            ? Buffer.from(JSON.stringify({ offset: consumed })).toString("base64")
            : null,
        });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });

  server.listen(port, hostname, () => {
    console.log(`Jobs API listening on http://${hostname}:${port}`);
  });
  return server;
}

export function toPublicJob(job) {
  const company = job.companyName || humanizeIdentifier(job.companyIdentifier, job.provider);
  return {
    id: job.key,
    title: job.title,
    company,
    companyMark: initials(company),
    companyLogoUrl: job.companyLogoUrl || null,
    companyColor: COMPANY_COLORS[hash(company) % COMPANY_COLORS.length],
    location: job.location || "Location not specified",
    workplace: job.workplace,
    employmentType: job.employmentType,
    category: job.category,
    source: titleCase(job.provider),
    publishedAt: job.publishedAt,
    description: job.description || "",
    skills: [],
    url: job.url,
  };
}

function humanizeIdentifier(value, provider) {
  let identifier = String(value || "Unknown company");
  if (provider === "workday") identifier = identifier.split("|")[0];
  if (provider === "icims") identifier = identifier.replace(/^(?:careers|jobs)[.-]/i, "");
  if (provider === "paylocity" && /^[a-f0-9-]{8,}$/i.test(identifier)) {
    return `Paylocity employer ${identifier.slice(0, 6).toLocaleUpperCase()}`;
  }
  return identifier
    .replace(/^www\./, "")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase();
}

function titleCase(value) {
  const text = String(value || "");
  if (text.toLocaleLowerCase() === "bamboohr") return "BambooHR";
  if (text.toLocaleLowerCase() === "icims") return "iCIMS";
  return text ? text[0].toLocaleUpperCase() + text.slice(1) : text;
}

function hash(value) {
  let result = 0;
  for (const character of value) result = (result * 31 + character.codePointAt(0)) >>> 0;
  return result;
}

function decodeOffsetCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return Number.isInteger(cursor.offset) && cursor.offset >= 0 ? cursor.offset : null;
  } catch {
    return null;
  }
}

function setCors(response, request) {
  // The dev frontend's port varies (vinext defaults to 3000, older setups used 3001), so any
  // localhost origin is acceptable for this local-only API rather than a single hardcoded port.
  const origin = request?.headers?.origin;
  const isLocal = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  response.setHeader("access-control-allow-origin", isLocal ? origin : "http://localhost:3000");
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("cache-control", "no-store");
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startApiServer();
