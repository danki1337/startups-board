import { getD1 } from "../../../db";

type JobRow = {
  key: string;
  title: string;
  companyIdentifier: string;
  companyName: string | null;
  companyLogoUrl: string | null;
  location: string | null;
  workplace: "Remote" | "Hybrid" | "On-site" | "Unspecified";
  employmentType: string | null;
  category: "Engineering" | "AI & Research" | "Product & Design" | "Sales & Marketing" | "Operations" | "Other";
  provider: string;
  publishedAt: string | null;
  url: string;
};

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const search = ftsQuery(url.searchParams.get("search"));
  const conditions = ["j.is_active = 1"];
  const bindings: unknown[] = [];
  const from = search
    ? "jobs j JOIN jobs_fts ON jobs_fts.rowid = j.rowid"
    : "jobs j";

  if (search) {
    conditions.push("jobs_fts MATCH ?");
    bindings.push(search);
  }
  addLikeFilter(conditions, bindings, "lower(coalesce(j.location, ''))", url.searchParams.get("location"));
  addExactFilter(conditions, bindings, "j.provider", url.searchParams.get("provider")?.toLowerCase());
  addExactFilter(conditions, bindings, "j.workplace", url.searchParams.get("workplace"));
  addExactFilter(conditions, bindings, "j.category", url.searchParams.get("category"));

  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (cursor) {
    conditions.push("(coalesce(j.published_at, '') < ? OR (coalesce(j.published_at, '') = ? AND j.key > ?))");
    bindings.push(cursor.publishedAt, cursor.publishedAt, cursor.key);
  }

  const limit = clampInteger(url.searchParams.get("limit"), 100, 1, 100);
  const where = conditions.join(" AND ");
  const db = getD1();
  const select = db.prepare(`
    SELECT
      j.key,
      j.title,
      j.company_identifier AS companyIdentifier,
      j.company_name AS companyName,
      coalesce(j.company_logo_url, c.logo_url) AS companyLogoUrl,
      j.location,
      j.workplace,
      j.employment_type AS employmentType,
      j.category,
      j.provider,
      j.published_at AS publishedAt,
      j.url
    FROM ${from}
    LEFT JOIN boards b ON b.key = j.board_key
    LEFT JOIN companies c ON c.key = b.company_key
    WHERE ${where}
    ORDER BY coalesce(j.published_at, '') DESC, j.key
    LIMIT ?
  `).bind(...bindings, limit);

  const countConditions = conditions.filter((condition) => !condition.includes("j.published_at") && !condition.includes("j.key >"));
  const countBindingCount = bindings.length - (cursor ? 3 : 0);
  const count = db.prepare(`SELECT count(*) AS total FROM ${from} WHERE ${countConditions.join(" AND ")}`)
    .bind(...bindings.slice(0, countBindingCount));
  const [rowsResult, countResult] = await db.batch([select, count]);
  const rows = rowsResult.results as unknown as JobRow[];
  const total = Number((countResult.results[0] as { total?: number } | undefined)?.total ?? 0);
  const last = rows.at(-1);

  return Response.json({
    jobs: rows.map(toPublicJob),
    total,
    limit,
    nextCursor: rows.length === limit && last
      ? encodeCursor({ publishedAt: last.publishedAt ?? "", key: last.key })
      : null,
  }, {
    headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" },
  });
}

function addLikeFilter(conditions: string[], bindings: unknown[], column: string, value: string | null) {
  const normalized = value?.trim().toLowerCase().slice(0, 48);
  if (!normalized) return;
  conditions.push(`${column} LIKE ?`);
  bindings.push(`%${normalized}%`);
}

function addExactFilter(conditions: string[], bindings: unknown[], column: string, value?: string | null) {
  if (!value) return;
  conditions.push(`${column} = ?`);
  bindings.push(value);
}

function ftsQuery(value: string | null) {
  const tokens = value?.trim().toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._+#-]*/gu)?.slice(0, 8) ?? [];
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function encodeCursor(value: { publishedAt: string; key: string }) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

function decodeCursor(value: string | null) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(decodeURIComponent(escape(atob(value))));
    return typeof cursor.publishedAt === "string" && typeof cursor.key === "string" ? cursor : null;
  } catch {
    return null;
  }
}

function toPublicJob(job: JobRow) {
  const company = job.companyName || humanizeIdentifier(job.companyIdentifier, job.provider);
  return {
    id: job.key,
    title: job.title,
    company,
    companyMark: initials(company),
    companyLogoUrl: job.companyLogoUrl,
    companyColor: companyColor(company),
    location: job.location || "Location not specified",
    workplace: job.workplace,
    employmentType: job.employmentType,
    category: job.category,
    source: titleCase(job.provider),
    publishedAt: job.publishedAt,
    description: "",
    skills: [],
    url: job.url,
  };
}

function humanizeIdentifier(value: string, provider: string) {
  let identifier = value || "Unknown company";
  if (provider === "workday") identifier = identifier.split("|")[0];
  if (provider === "icims") identifier = identifier.replace(/^(?:careers|jobs)[.-]/i, "");
  if (provider === "paylocity" && /^[a-f0-9-]{8,}$/i.test(identifier)) {
    return `Paylocity employer ${identifier.slice(0, 6).toUpperCase()}`;
  }
  return identifier.replace(/^www\./, "").replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function titleCase(value: string) {
  if (value === "bamboohr") return "BambooHR";
  if (value === "icims") return "iCIMS";
  if (value === "sparkhire") return "Spark Hire";
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function companyColor(value: string) {
  const colors = [
    "bg-[#ebe7ff] text-[#5436a8]", "bg-[#ffe8dc] text-[#9b3d0a]",
    "bg-[#e1f1ef] text-[#15645a]", "bg-[#e8eefc] text-[#294f9f]",
    "bg-[#f4e5ef] text-[#8c326d]", "bg-[#f1eadb] text-[#76551f]",
    "bg-[#e5efe3] text-[#386a31]", "bg-[#e7ecf0] text-[#34495b]",
  ];
  let hash = 0;
  for (const character of value) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return colors[hash % colors.length];
}

function clampInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}
