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
    setCors(response);

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
        const result = await queryActiveJobs(
          {
            search: url.searchParams.get("search"),
            location: url.searchParams.get("location"),
            provider: url.searchParams.get("provider"),
            workplace: url.searchParams.get("workplace"),
            category: url.searchParams.get("category"),
            limit: url.searchParams.get("limit"),
            offset: url.searchParams.get("offset"),
          },
          databasePath,
        );
        sendJson(response, 200, {
          ...result,
          jobs: result.jobs.map(toPublicJob),
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

function setCors(response) {
  response.setHeader("access-control-allow-origin", "http://localhost:3001");
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("cache-control", "no-store");
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startApiServer();
