import { locationCountry } from "./locations.mjs";

const PROVIDERS = {
  lever: {
    discoveryTargets: [
      { pattern: "jobs.lever.co/*", region: "global" },
      { pattern: "jobs.eu.lever.co/*", region: "eu" },
    ],
    parse(url) {
      const host = url.hostname.toLowerCase();
      const region = host === "jobs.eu.lever.co" ? "eu" : "global";

      if (host !== "jobs.lever.co" && host !== "jobs.eu.lever.co") return null;

      const identifier = firstPathSegment(url);
      if (!isSharedHostIdentifier(identifier) || LEVER_RESERVED_PATHS.has(identifier.toLowerCase())) return null;

      const jobHost = region === "eu" ? "jobs.eu.lever.co" : "jobs.lever.co";
      const apiHost = region === "eu" ? "api.eu.lever.co" : "api.lever.co";

      return board({
        provider: "lever",
        identifier,
        region,
        boardUrl: `https://${jobHost}/${encodeURIComponent(identifier)}`,
        apiUrl: `https://${apiHost}/v0/postings/${encodeURIComponent(identifier)}?mode=json`,
      });
    },
    fetchJobs: fetchLeverJobs,
    normalizeJob: normalizeLeverJob,
    async validate(candidate, request) {
      const payload = await fetchLeverJobs(candidate, request);

      return {
        jobCount: payload.length,
        sampleTitles: payload.slice(0, 3).map((job) => job.text).filter(Boolean),
      };
    },
  },

  greenhouse: {
    // A single domain match covers boards. and job-boards. plus any future shared host; parse()
    // still only accepts the two board hosts, so the wider net cannot pollute the registry.
    discoveryTargets: [
      {
        pattern: "*.greenhouse.io/*",
        query: "greenhouse.io",
        matchType: "domain",
        region: "global",
      },
    ],
    parse(url) {
      const host = url.hostname.toLowerCase();
      if (host !== "boards.greenhouse.io" && host !== "job-boards.greenhouse.io") {
        return null;
      }

      const identifier = firstPathSegment(url);
      if (!isSharedHostIdentifier(identifier) || GREENHOUSE_RESERVED_PATHS.has(identifier.toLowerCase())) return null;

      return board({
        provider: "greenhouse",
        identifier,
        region: "global",
        boardUrl: `https://job-boards.greenhouse.io/${encodeURIComponent(identifier)}`,
        apiUrl: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identifier)}/jobs`,
      });
    },
    fetchJobs: fetchGreenhouseJobs,
    normalizeJob: normalizeGreenhouseJob,
    async validate(candidate, request) {
      const jobs = await fetchGreenhouseJobs(candidate, request);

      return {
        jobCount: jobs.length,
        sampleTitles: jobs.slice(0, 3).map((job) => job.title).filter(Boolean),
      };
    },
  },

  ashby: {
    discoveryTargets: [{ pattern: "jobs.ashbyhq.com/*", region: "global" }],
    parse(url) {
      if (url.hostname.toLowerCase() !== "jobs.ashbyhq.com") return null;

      const identifier = firstPathSegment(url);
      if (!isSharedHostIdentifier(identifier) || ASHBY_RESERVED_PATHS.has(identifier.toLowerCase())) return null;

      return board({
        provider: "ashby",
        identifier,
        region: "global",
        boardUrl: `https://jobs.ashbyhq.com/${encodeURIComponent(identifier)}`,
        apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(identifier)}`,
      });
    },
    fetchJobs: fetchAshbyJobs,
    normalizeJob: normalizeAshbyJob,
    async validate(candidate, request) {
      const listedJobs = await fetchAshbyJobs(candidate, request);
      return {
        jobCount: listedJobs.length,
        sampleTitles: listedJobs.slice(0, 3).map((job) => job.title).filter(Boolean),
      };
    },
  },

  gem: {
    discoveryTargets: [{ pattern: "jobs.gem.com/*", region: "global" }],
    parse(url) {
      if (url.hostname.toLowerCase() !== "jobs.gem.com") return null;

      const identifier = firstPathSegment(url)?.toLocaleLowerCase("en-US");
      if (!isSharedHostIdentifier(identifier) || GEM_RESERVED_PATHS.has(identifier)) return null;

      return board({
        provider: "gem",
        identifier,
        region: "global",
        boardUrl: `https://jobs.gem.com/${encodeURIComponent(identifier)}`,
        apiUrl: `https://api.gem.com/job_board/v0/${encodeURIComponent(identifier)}/job_posts/`,
      });
    },
    fetchJobs: fetchGemJobs,
    normalizeJob: normalizeGemJob,
    async validate(candidate, request) {
      const jobs = await fetchGemJobs(candidate, request);
      return {
        jobCount: jobs.length,
        sampleTitles: jobs.slice(0, 3).map((job) => job.title).filter(Boolean),
      };
    },
  },

  getro: {
    discoveryTargets: [
      {
        pattern: "*.getro.com/jobs/*",
        query: "getro.com",
        matchType: "domain",
        region: "global",
      },
      {
        pattern: "getro.org/jobs/*",
        query: "getro.org",
        matchType: "domain",
        region: "global",
      },
    ],
    parse(url) {
      const host = url.hostname.toLocaleLowerCase("en-US");
      const subdomainMatch = /^([a-z0-9][a-z0-9-]*)\.getro\.com$/.exec(host);
      const isGetroOrg = host === "getro.org" || host === "www.getro.org";
      if (!subdomainMatch && !isGetroOrg) return null;

      const subdomain = subdomainMatch?.[1] ?? "getro.org";
      if (GETRO_RESERVED_SUBDOMAINS.has(subdomain)) return null;
      const boardHost = isGetroOrg ? "www.getro.org" : host;

      return board({
        provider: "getro",
        identifier: subdomain,
        region: "global",
        boardUrl: `https://${boardHost}/jobs`,
        apiUrl: `https://${boardHost}/jobs`,
      });
    },
    fetchJobs: fetchGetroJobs,
    normalizeJob: normalizeGetroJob,
    async validate(candidate, request) {
      const jobs = await fetchGetroJobs(candidate, request);
      return {
        jobCount: jobs.length,
        sampleTitles: jobs.slice(0, 3).map((job) => job.title).filter(Boolean),
      };
    },
  },

  sparkhire: {
    // Domain match also captures bare-host and regional comeet.com URLs the www. prefix missed.
    discoveryTargets: [
      {
        pattern: "*.comeet.com/jobs/*",
        query: "comeet.com",
        matchType: "domain",
        region: "global",
      },
    ],
    parse(url) {
      const host = url.hostname.toLocaleLowerCase();
      if (host !== "comeet.com" && host !== "www.comeet.com") return null;
      const segments = decodedPathSegments(url);
      if (segments[0]?.toLocaleLowerCase() !== "jobs") return null;
      const slug = segments[1]?.toLocaleLowerCase("en-US");
      const companyUid = segments[2];
      if (!slug || !companyUid || !/^[a-z0-9.]+$/i.test(companyUid)) return null;
      const identifier = `${slug}|${companyUid}`;
      const boardUrl = `https://www.comeet.com/jobs/${encodeURIComponent(slug)}/${encodeURIComponent(companyUid)}`;
      return board({
        provider: "sparkhire",
        identifier,
        region: "global",
        boardUrl,
        apiUrl: boardUrl,
      });
    },
    fetchJobs: fetchSparkHireJobs,
    normalizeJob: normalizeSparkHireJob,
    async validate(candidate, request) {
      const jobs = await fetchSparkHireJobs(candidate, request);
      return {
        jobCount: jobs.length,
        sampleTitles: jobs.slice(0, 3).map((job) => job.name).filter(Boolean),
      };
    },
  },

  bamboohr: {
    discoveryTargets: [
      {
        pattern: "*.bamboohr.com/careers/*",
        query: "bamboohr.com",
        matchType: "domain",
        region: "global",
      },
    ],
    parse(url) {
      const match = /^([a-z0-9][a-z0-9-]*)\.bamboohr\.com$/i.exec(url.hostname);
      if (!match) return null;
      const identifier = match[1].toLocaleLowerCase();
      if (BAMBOOHR_RESERVED_SUBDOMAINS.has(identifier)) return null;
      return board({
        provider: "bamboohr",
        identifier,
        region: "global",
        boardUrl: `https://${identifier}.bamboohr.com/careers`,
        apiUrl: `https://${identifier}.bamboohr.com/careers/list`,
      });
    },
    fetchJobs: fetchBambooHrJobs,
    normalizeJob: normalizeBambooHrJob,
    async validate(candidate, request) {
      const jobs = await fetchBambooHrJobs(candidate, request);
      return {
        jobCount: jobs.length,
        sampleTitles: jobs.slice(0, 3).map((job) => job.jobOpeningName).filter(Boolean),
      };
    },
  },

  workday: {
    discoveryTargets: [
      {
        pattern: "*.myworkdayjobs.com/*",
        query: "myworkdayjobs.com",
        matchType: "domain",
        region: "global",
      },
      {
        pattern: "*.myworkdaysite.com/*",
        query: "myworkdaysite.com",
        matchType: "domain",
        region: "global",
      },
    ],
    parse(url) {
      const host = url.hostname.toLocaleLowerCase();
      // Workday's newer myworkdaysite.com family carries the tenant in the path rather than the
      // host: https://{wdN}.myworkdaysite.com/[{locale}/]recruiting/{tenant}/{site}/... Both
      // families map onto the same tenant|wdN|site identifier, so a board reachable on both
      // domains deduplicates to one canonical record instead of ingesting every job twice.
      const siteMatch = /^(impl-)?(wd\d+)\.myworkdaysite\.com$/.exec(host);
      if (siteMatch) {
        if (siteMatch[1]) return null; // impl-* hosts are implementation sandboxes, not live boards
        const segments = decodedPathSegments(url);
        const offset = /^[a-z]{2}-[a-z]{2}$/i.test(segments[0] ?? "") ? 1 : 0;
        if (segments[offset]?.toLocaleLowerCase() !== "recruiting") return null;
        const tenant = segments[offset + 1]?.toLocaleLowerCase();
        const siteId = segments[offset + 2];
        if (!tenant || !siteId || WORKDAY_RESERVED_PATHS.has(siteId.toLocaleLowerCase())) return null;
        const dataCenter = siteMatch[2];
        return board({
          provider: "workday",
          identifier: `${tenant}|${dataCenter}|${siteId}`,
          region: "global",
          boardUrl: `https://${host}/recruiting/${encodeURIComponent(tenant)}/${encodeURIComponent(siteId)}`,
          apiUrl: `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(siteId)}/jobs`,
        });
      }

      const match = /^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
      if (!match) return null;

      const segments = decodedPathSegments(url);
      let siteId = null;
      if (segments[0]?.toLocaleLowerCase() === "wday" && segments[1]?.toLocaleLowerCase() === "cxs") {
        siteId = segments[3];
      } else if (/^[a-z]{2}-[a-z]{2}$/i.test(segments[0] ?? "")) {
        siteId = segments[1];
      } else {
        siteId = segments[0];
      }
      if (!siteId || WORKDAY_RESERVED_PATHS.has(siteId.toLocaleLowerCase())) return null;

      const company = match[1];
      const dataCenter = match[2];
      const identifier = `${company}|${dataCenter}|${siteId}`;
      const baseUrl = `https://${host}`;
      return board({
        provider: "workday",
        identifier,
        region: "global",
        boardUrl: `${baseUrl}/${encodeURIComponent(siteId)}`,
        apiUrl: `${baseUrl}/wday/cxs/${encodeURIComponent(company)}/${encodeURIComponent(siteId)}/jobs`,
      });
    },
    fetchJobs: fetchWorkdayJobs,
    normalizeJob: normalizeWorkdayJob,
    async validate(candidate, request) {
      const jobs = await fetchWorkdayJobs(candidate, request);
      return {
        jobCount: jobs.length,
        sampleTitles: jobs.slice(0, 3).map((job) => job.title).filter(Boolean),
      };
    },
  },

  icims: {
    discoveryTargets: [
      {
        pattern: "*.icims.com/jobs/*",
        query: "icims.com",
        matchType: "domain",
        region: "global",
      },
    ],
    parse(url) {
      const host = url.hostname.toLocaleLowerCase();
      if (!host.endsWith(".icims.com")) return null;
      if (!url.pathname.toLocaleLowerCase().includes("/jobs/")) return null;
      const identifier = host.slice(0, -".icims.com".length);
      // Requiring a careers-/jobs- host prefix rejected live tenants such as
      // 1stheritage-curo.icims.com, so the /jobs/ path plus a reserved-subdomain guard carries the
      // filtering instead and validation prunes whatever is actually dead.
      if (!identifier || identifier.includes(".") || ICIMS_RESERVED_SUBDOMAINS.has(identifier)) return null;
      return board({
        provider: "icims",
        identifier,
        region: "global",
        boardUrl: `https://${host}/jobs/intro`,
        apiUrl: `https://${host}/sitemap.xml`,
      });
    },
    fetchJobs: fetchIcimsJobs,
    normalizeJob: normalizeIcimsJob,
    async validate(candidate, request) {
      const jobs = await fetchIcimsJobs(candidate, request);
      return {
        jobCount: jobs.length,
        sampleTitles: jobs.slice(0, 3).map((job) => job.title).filter(Boolean),
      };
    },
  },

  paylocity: {
    // The /jobs/All/ prefix missed Details/ and legacy paths that still reveal the company GUID;
    // the host prefix is broad enough while staying far cheaper than a paylocity.com domain match.
    discoveryTargets: [
      {
        pattern: "recruiting.paylocity.com/*",
        region: "global",
      },
    ],
    parse(url) {
      if (url.hostname.toLocaleLowerCase() !== "recruiting.paylocity.com") return null;
      const segments = decodedPathSegments(url);
      const allIndex = segments.findIndex((segment) => segment.toLocaleLowerCase() === "all");
      let identifier = allIndex >= 0 ? segments[allIndex + 1] : null;
      // Job-detail URLs (/recruiting/jobs/Details/{jobId}/{company-slug}) carry no board GUID, but
      // any URL that does carry one exposes it as a UUID path segment.
      if (!identifier) {
        identifier = segments.find((segment) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) ?? null;
      }
      // Paylocity boards are keyed by company GUID; with the discovery target widened to the whole
      // recruiting host, anything looser would let slugs and job ids masquerade as boards.
      if (!identifier
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) {
        return null;
      }
      return board({
        provider: "paylocity",
        identifier: identifier.toLocaleLowerCase(),
        region: "global",
        boardUrl: `https://recruiting.paylocity.com/recruiting/jobs/All/${encodeURIComponent(identifier)}/`,
        apiUrl: `https://recruiting.paylocity.com/recruiting/jobs/All/${encodeURIComponent(identifier)}/`,
      });
    },
    fetchJobs: fetchPaylocityJobs,
    normalizeJob: normalizePaylocityJob,
    async validate(candidate, request) {
      const jobs = await fetchPaylocityJobs(candidate, request);
      return {
        jobCount: jobs.length,
        sampleTitles: jobs.slice(0, 3).map((job) => job.JobTitle).filter(Boolean),
      };
    },
  },
};

const GREENHOUSE_RESERVED_PATHS = new Set(["embed", "jobs", "privacy"]);
const ASHBY_RESERVED_PATHS = new Set(["embed", "jobs"]);
const GEM_RESERVED_PATHS = new Set([
  "api",
  "favicon.ico",
  "job_board",
  "robots.txt",
  "sitemap.xml",
]);
const GETRO_RESERVED_SUBDOMAINS = new Set([
  "api",
  "cdn",
  "cdn-customers",
  "developers",
  "help",
  "talkto",
  "www",
]);
const LEVER_RESERVED_PATHS = new Set(["robots.txt"]);
const ICIMS_RESERVED_SUBDOMAINS = new Set([
  "api",
  "app",
  "developer",
  "help",
  "login",
  "support",
  "www",
]);
const BAMBOOHR_RESERVED_SUBDOMAINS = new Set([
  "api",
  "app",
  "blog",
  "documentation",
  "help",
  "partners",
  "support",
  "www",
]);
const WORKDAY_RESERVED_PATHS = new Set(["job", "jobs", "search", "robots.txt"]);
const LEVER_PAGE_SIZE = 100;
const LEVER_MAX_PAGES = 1_000;
const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_MAX_PAGES = 5_000;
const GETRO_PAGE_SIZE = 100;
const GETRO_MAX_PAGES = 10_000;

export class InvalidPayloadError extends Error {}

// Retired ATS subdomains keep answering with HTTP 200 and an HTML page, which used to surface as a
// raw SyntaxError and get retried every 15 minutes forever. A non-JSON body means the identifier is
// no longer a board, so it is reported as an invalid payload and backed off for 30 days.
export async function readJson(response) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    const contentType = response.headers?.get?.("content-type") ?? "unknown";
    throw new InvalidPayloadError(
      `Expected JSON but received ${contentType} from ${response.url || "the ATS"}`,
    );
  }
}

export function getProvider(name) {
  return PROVIDERS[name] ?? null;
}

export function listProviders() {
  return Object.keys(PROVIDERS);
}

export function getDiscoveryTargets(providerNames = listProviders()) {
  return providerNames.flatMap((providerName) => {
    const provider = getProvider(providerName);
    if (!provider) throw new Error(`Unsupported provider: ${providerName}`);

    return provider.discoveryTargets.map((target) => ({ provider: providerName, ...target }));
  });
}

export function parseAtsUrl(value, providerHint) {
  const url = safeUrl(value);
  if (!url) return null;

  if (providerHint) {
    const provider = getProvider(providerHint);
    if (!provider) throw new Error(`Unsupported provider: ${providerHint}`);
    return provider.parse(url);
  }

  for (const provider of Object.values(PROVIDERS)) {
    const result = provider.parse(url);
    if (result) return result;
  }

  return null;
}

async function fetchLeverJobs(candidate, request) {
  const jobs = [];

  for (let page = 0; page < LEVER_MAX_PAGES; page += 1) {
    const url = new URL(candidate.apiUrl);
    url.searchParams.set("mode", "json");
    url.searchParams.set("skip", String(page * LEVER_PAGE_SIZE));
    url.searchParams.set("limit", String(LEVER_PAGE_SIZE));

    const response = await request(url.toString());
    const payload = await readJson(response);
    if (!Array.isArray(payload)) throw new InvalidPayloadError("Expected a job array");

    jobs.push(...payload);
    if (payload.length < LEVER_PAGE_SIZE) return jobs;
  }

  throw new InvalidPayloadError(`Lever board exceeded ${LEVER_MAX_PAGES * LEVER_PAGE_SIZE} jobs`);
}

async function fetchGreenhouseJobs(candidate, request) {
  const url = new URL(candidate.apiUrl);
  url.searchParams.set("content", "true");
  const response = await request(url.toString());
  const payload = await readJson(response);

  if (!payload || !Array.isArray(payload.jobs)) {
    throw new InvalidPayloadError("Expected an object containing a jobs array");
  }

  return payload.jobs;
}

async function fetchAshbyJobs(candidate, request) {
  const url = new URL(candidate.apiUrl);
  url.searchParams.set("includeCompensation", "true");
  const response = await request(url.toString());
  const payload = await readJson(response);

  if (!payload || !Array.isArray(payload.jobs)) {
    throw new InvalidPayloadError("Expected an object containing a jobs array");
  }

  return payload.jobs.filter((job) => job.isListed !== false);
}

async function fetchGemJobs(candidate, request) {
  const response = await request(candidate.apiUrl);
  const payload = await readJson(response);
  if (!Array.isArray(payload)) {
    throw new InvalidPayloadError("Expected a Gem job array");
  }
  return payload;
}

async function fetchGetroJobs(candidate, request) {
  const boardResponse = await request(candidate.boardUrl, {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  const html = await boardResponse.text();
  const nextData = parseScriptJson(html, "__NEXT_DATA__");
  const collectionId = nextData?.props?.pageProps?.network?.id;
  if (!collectionId) {
    throw new InvalidPayloadError("Expected a Getro network ID in __NEXT_DATA__");
  }

  const jobs = [];
  const seenJobs = new Set();
  const endpoint = `https://api.getro.com/api/v2/collections/${encodeURIComponent(collectionId)}/search/jobs`;

  for (let page = 0; page < GETRO_MAX_PAGES; page += 1) {
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: new URL(candidate.boardUrl).origin,
        referer: candidate.boardUrl,
      },
      body: JSON.stringify({
        hits_per_page: GETRO_PAGE_SIZE,
        page,
        filters: "",
        query: "",
      }),
    });
    const payload = await readJson(response);
    const pageJobs = payload?.results?.jobs;
    const total = payload?.results?.count;
    if (!Array.isArray(pageJobs) || !Number.isFinite(total)) {
      throw new InvalidPayloadError("Expected Getro jobs and count fields");
    }

    if (!pageJobs.length) return jobs;
    let added = 0;
    for (const job of pageJobs) {
      const key = cleanString(job.id) || cleanString(job.slug) || cleanString(job.url);
      if (!key || seenJobs.has(key)) continue;
      seenJobs.add(key);
      jobs.push(job);
      added += 1;
    }

    if (!added || pageJobs.length < GETRO_PAGE_SIZE || jobs.length >= total) return jobs;
  }

  throw new InvalidPayloadError(`Getro board exceeded ${GETRO_MAX_PAGES * GETRO_PAGE_SIZE} jobs`);
}

async function fetchSparkHireJobs(candidate, request) {
  const response = await request(candidate.apiUrl, { headers: { accept: "text/html" } });
  const html = await response.text();
  const company = parseAssignedJson(html, "COMPANY_DATA");
  const positions = parseAssignedJson(html, "COMPANY_POSITIONS_DATA");
  if (!company || !Array.isArray(positions)) {
    throw new InvalidPayloadError("Expected Spark Hire Recruit company and positions data");
  }
  return positions.map((position) => ({
    ...position,
    company_name: position.company_name || company.name,
    company_logo_url: company.logos?.small?.url || company.logos?.medium?.url || null,
  }));
}

async function fetchBambooHrJobs(candidate, request) {
  const response = await request(candidate.apiUrl);
  const payload = await readJson(response);
  if (!payload || !Array.isArray(payload.result)) {
    throw new InvalidPayloadError("Expected a BambooHR result array");
  }
  return payload.result;
}

async function fetchWorkdayJobs(candidate, request) {
  const jobs = [];
  const seenJobs = new Set();

  for (let page = 0; page < WORKDAY_MAX_PAGES; page += 1) {
    const response = await request(candidate.apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(candidate.boardUrl).origin,
        referer: candidate.boardUrl,
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: WORKDAY_PAGE_SIZE,
        offset: page * WORKDAY_PAGE_SIZE,
        searchText: "",
      }),
    });
    const payload = await readJson(response);
    if (!payload || !Array.isArray(payload.jobPostings) || !Number.isFinite(payload.total)) {
      throw new InvalidPayloadError("Expected Workday jobPostings and total fields");
    }

    if (!payload.jobPostings.length) return jobs;

    let added = 0;
    for (const job of payload.jobPostings) {
      const key = cleanString(job.externalPath)
        || `${cleanString(job.title) ?? ""}|${cleanString(job.locationsText) ?? ""}`;
      if (seenJobs.has(key)) continue;
      seenJobs.add(key);
      jobs.push(job);
      added += 1;
    }

    // Workday totals can genuinely change while a board is being updated, and
    // blocked endpoints can silently repeat a page. Follow changing totals, but
    // stop on a partial/repeated page so either case cannot loop forever.
    if (!added || payload.jobPostings.length < WORKDAY_PAGE_SIZE || jobs.length >= payload.total) {
      return jobs;
    }
  }

  throw new InvalidPayloadError(`Workday board exceeded ${WORKDAY_MAX_PAGES * WORKDAY_PAGE_SIZE} jobs`);
}

async function fetchIcimsJobs(candidate, request) {
  const response = await request(candidate.apiUrl, { headers: { accept: "application/xml,text/xml" } });
  const xml = await response.text();
  if (!/<(?:urlset|sitemapindex)(?:\s|>)/i.test(xml)) {
    throw new InvalidPayloadError("Expected an iCIMS XML sitemap");
  }

  const jobs = [];
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const url = decodeXml(block[1].match(/<loc>([\s\S]*?)<\/loc>/i)?.[1]);
    if (!url || !/\/jobs\//i.test(url) || /\/jobs\/(?:intro)?\/?$/i.test(url)) continue;
    const parsed = safeUrl(url);
    const segments = parsed ? decodedPathSegments(parsed) : [];
    const jobsIndex = segments.findIndex((segment) => segment.toLocaleLowerCase() === "jobs");
    const sourceId = jobsIndex >= 0 ? segments[jobsIndex + 1] : null;
    const titleSlug = jobsIndex >= 0 ? segments[jobsIndex + 2] : null;
    if (!sourceId || !titleSlug) continue;
    jobs.push({
      id: sourceId,
      title: titleFromSlug(titleSlug),
      url,
      updatedAt: decodeXml(block[1].match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1]),
    });
  }
  return jobs;
}

async function fetchPaylocityJobs(candidate, request) {
  const response = await request(candidate.apiUrl, { headers: { accept: "text/html" } });
  const html = await response.text();
  const pageData = html.match(/window\.pageData\s*=\s*({[\s\S]*?})\s*;<\/script>/i)?.[1]
    ?? html.match(/window\.pageData\s*=\s*({[\s\S]*?})\s*;/i)?.[1];
  if (!pageData) throw new InvalidPayloadError("Expected Paylocity window.pageData");

  let payload;
  try {
    payload = JSON.parse(pageData);
  } catch {
    throw new InvalidPayloadError("Paylocity pageData was not valid JSON");
  }
  if (!Array.isArray(payload.Jobs)) throw new InvalidPayloadError("Expected a Paylocity Jobs array");
  return payload.Jobs;
}

function normalizeLeverJob(candidate, job, syncedAt) {
  return normalizedJob(candidate, syncedAt, {
    sourceId: job.id,
    title: job.text,
    location: job.categories?.location,
    workplace: normalizeWorkplace(job.workplaceType),
    employmentType: job.categories?.commitment,
    department: job.categories?.department || job.categories?.team,
    descriptionPlain: job.descriptionPlain || job.descriptionBodyPlain || job.openingPlain,
    descriptionHtml: job.description || job.descriptionBody || job.opening,
    publishedAt: timestampFromMilliseconds(job.createdAt),
    url: job.hostedUrl,
    applyUrl: job.applyUrl,
    compensation: job.salaryRange ?? job.salaryDescriptionPlain ?? null,
  });
}

function normalizeGreenhouseJob(candidate, job, syncedAt) {
  return normalizedJob(candidate, syncedAt, {
    sourceId: job.id,
    title: job.title,
    location: job.location?.name,
    workplace: normalizeWorkplace(job.metadata?.find?.((item) => /workplace/i.test(item.name))?.value),
    employmentType: job.metadata?.find?.((item) => /employment|commitment/i.test(item.name))?.value,
    department: job.departments?.map((department) => department.name).filter(Boolean).join(" · "),
    descriptionPlain: stripHtml(job.content),
    descriptionHtml: job.content,
    publishedAt: job.updated_at,
    url: job.absolute_url,
    applyUrl: job.absolute_url,
    compensation: null,
  });
}

function normalizeAshbyJob(candidate, job, syncedAt) {
  return normalizedJob(candidate, syncedAt, {
    sourceId: job.id || lastPathSegment(job.jobUrl) || lastPathSegment(job.applyUrl),
    title: job.title,
    location: job.location,
    workplace: normalizeWorkplace(job.workplaceType || (job.isRemote ? "Remote" : null)),
    employmentType: normalizeEmploymentType(job.employmentType),
    department: job.department || job.team,
    descriptionPlain: job.descriptionPlain,
    descriptionHtml: job.descriptionHtml,
    publishedAt: job.publishedAt,
    url: job.jobUrl,
    applyUrl: job.applyUrl,
    compensation: job.compensation ?? null,
  });
}

function normalizeGemJob(candidate, job, syncedAt) {
  const officeLocations = job.offices
    ?.map((office) => office.location?.name || office.name)
    .filter(Boolean)
    .join(" · ");
  const location = job.location?.name || officeLocations;

  return normalizedJob(candidate, syncedAt, {
    sourceId: job.id || job.internal_job_id || lastPathSegment(job.absolute_url),
    title: job.title,
    location,
    workplace: normalizeWorkplace(`${job.location_type ?? ""} ${location ?? ""}`),
    employmentType: normalizeEmploymentType(job.employment_type),
    department: job.departments?.map((department) => department.name).filter(Boolean).join(" · "),
    descriptionPlain: job.content_plain || stripHtml(job.content),
    descriptionHtml: job.content,
    publishedAt: job.first_published_at || job.updated_at || job.created_at,
    url: job.absolute_url,
    applyUrl: job.absolute_url,
    compensation: null,
  });
}

function normalizeGetroJob(candidate, job, syncedAt) {
  const organization = job.organization || {};
  const locations = job.locations || job.searchable_locations || job.searchableLocations;
  const location = Array.isArray(locations) ? locations.filter(Boolean).join(" · ") : locations;
  const organizationSlug = cleanString(organization.slug);
  const jobSlug = cleanString(job.slug);
  const fallbackUrl = organizationSlug && jobSlug
    ? `${new URL(candidate.boardUrl).origin}/companies/${encodeURIComponent(organizationSlug)}/jobs/${encodeURIComponent(jobSlug)}`
    : candidate.boardUrl;
  const compensationPublic = job.compensation_public ?? job.compensationPublic;
  const minimumCents = job.compensation_amount_min_cents ?? job.compensationAmountMinCents;
  const maximumCents = job.compensation_amount_max_cents ?? job.compensationAmountMaxCents;
  const compensation = compensationPublic && (Number.isFinite(minimumCents) || Number.isFinite(maximumCents))
    ? {
        currency: job.compensation_currency ?? job.compensationCurrency,
        interval: job.compensation_period ?? job.compensationPeriod,
        min: Number.isFinite(minimumCents) ? minimumCents / 100 : null,
        max: Number.isFinite(maximumCents) ? maximumCents / 100 : null,
      }
    : null;

  return normalizedJob(candidate, syncedAt, {
    sourceId: job.id || jobSlug || job.url,
    companyName: organization.name,
    companyLogoUrl: organization.logo_url || organization.logoUrl,
    title: job.title,
    location,
    workplace: normalizeWorkplace(job.work_mode || job.workMode),
    employmentType: normalizeEmploymentType(job.employment_type || job.employmentType),
    department: arrayOrString(job.job_functions || job.jobFunctions),
    descriptionPlain: null,
    publishedAt: timestampFromSeconds(job.created_at ?? job.createdAt),
    url: job.url || fallbackUrl,
    applyUrl: job.url || fallbackUrl,
    compensation,
  });
}

function normalizeSparkHireJob(candidate, job, syncedAt) {
  const descriptionHtml = job.custom_fields?.details
    ?.map((field) => field?.value)
    .filter(Boolean)
    .join("\n");
  return normalizedJob(candidate, syncedAt, {
    sourceId: job.uid || lastPathSegment(job.url_comeet_hosted_page),
    companyName: job.company_name,
    companyLogoUrl: job.company_logo_url,
    title: job.name,
    location: job.location?.display_name || job.location?.name,
    workplace: normalizeWorkplace(job.workplace_type || (job.location?.is_remote ? "Remote" : null)),
    employmentType: normalizeEmploymentType(job.employment_type),
    department: job.department,
    descriptionPlain: stripHtml(descriptionHtml),
    descriptionHtml,
    publishedAt: job.time_updated,
    url: job.url_comeet_hosted_page || job.url_recruit_hosted_page || job.url_active_page,
    applyUrl: job.url_active_page || job.url_comeet_hosted_page,
    compensation: null,
  });
}

function normalizeBambooHrJob(candidate, job, syncedAt) {
  const location = job.location && typeof job.location === "object"
    ? [job.location.city, job.location.state, job.location.country].filter(Boolean).join(", ")
    : job.location;
  const url = `https://${candidate.identifier}.bamboohr.com/careers/${encodeURIComponent(job.id)}`;
  return normalizedJob(candidate, syncedAt, {
    sourceId: job.id,
    title: job.jobOpeningName,
    location,
    workplace: normalizeWorkplace(`${location ?? ""} ${job.jobOpeningName ?? ""}`),
    employmentType: job.employmentStatusLabel,
    department: job.departmentLabel,
    descriptionPlain: job.description,
    publishedAt: job.datePosted,
    url,
    applyUrl: url,
    compensation: null,
  });
}

function normalizeWorkdayJob(candidate, job, syncedAt) {
  // boardUrl already encodes the family-specific shape ({tenant}.wdN.myworkdayjobs.com/{site}
  // vs wdN.myworkdaysite.com/recruiting/{tenant}/{site}), so job and logo URLs append to it
  // rather than reconstructing a host-based path that only exists on the older domain.
  const boardBase = candidate.boardUrl.replace(/\/$/, "");
  const externalPath = cleanString(job.externalPath) || "";
  const url = `${boardBase}${externalPath.startsWith("/") ? "" : "/"}${externalPath}`;
  return normalizedJob(candidate, syncedAt, {
    sourceId: lastPathSegment(url) || externalPath,
    title: job.title,
    location: job.locationsText,
    workplace: normalizeWorkplace(`${job.locationsText ?? ""} ${job.title ?? ""}`),
    employmentType: job.timeType,
    department: job.jobFamily,
    descriptionPlain: null,
    publishedAt: relativeDate(job.postedOn, syncedAt),
    url,
    applyUrl: url,
    // Every Workday tenant serves its customer's own logo from a fixed path, so this needs no
    // extra request at ingestion. The frontend falls back to the generated monogram if it 404s.
    companyLogoUrl: `${boardBase}/assets/logo`,
    compensation: null,
  });
}

function normalizeIcimsJob(candidate, job, syncedAt) {
  return normalizedJob(candidate, syncedAt, {
    sourceId: job.id,
    title: job.title,
    location: null,
    workplace: "Unspecified",
    employmentType: null,
    department: null,
    descriptionPlain: null,
    publishedAt: job.updatedAt,
    url: job.url,
    applyUrl: job.url,
    compensation: null,
  });
}

function normalizePaylocityJob(candidate, job, syncedAt) {
  const locationObject = job.JobLocation || {};
  const location = [locationObject.City, locationObject.State].filter(Boolean).join(", ")
    || job.LocationName;
  const url = job.JobId
    ? `https://recruiting.paylocity.com/recruiting/Jobs/Details/${encodeURIComponent(job.JobId)}`
    : candidate.boardUrl;
  return normalizedJob(candidate, syncedAt, {
    sourceId: job.JobId || `${job.JobTitle}|${location}`,
    title: decodeHtml(job.JobTitle),
    location: decodeHtml(location),
    workplace: normalizeWorkplace(job.IsRemote ? "Remote" : `${location ?? ""} ${job.JobTitle ?? ""}`),
    employmentType: job.EmploymentType,
    department: decodeHtml(job.HiringDepartment),
    descriptionPlain: null,
    publishedAt: job.PublishedDate,
    url,
    applyUrl: url,
    compensation: null,
  });
}

function normalizedJob(candidate, syncedAt, values) {
  const sourceId = cleanString(values.sourceId) || stableFallbackId(values);
  const url = cleanString(values.url) || cleanString(values.applyUrl);
  const title = cleanString(values.title) || "Untitled role";
  const department = cleanString(values.department);

  return {
    key: `${candidate.key}:${sourceId}`,
    sourceId,
    boardKey: candidate.key,
    provider: candidate.provider,
    companyIdentifier: candidate.identifier,
    companyName: cleanString(values.companyName),
    companyLogoUrl: cleanString(values.companyLogoUrl),
    title,
    location: cleanString(values.location),
    // Resolved once here rather than per query; ~86% of postings yield a country, remote-only
    // strings resolve to null and are surfaced through the separate "Anywhere" filter.
    country: locationCountry(values.location),
    workplace: values.workplace || "Unspecified",
    employmentType: cleanString(values.employmentType),
    department,
    category: classifyJob(title, department),
    descriptionPlain: truncate(cleanString(values.descriptionPlain), 4_000),
    publishedAt: isoTimestamp(values.publishedAt),
    url,
    applyUrl: cleanString(values.applyUrl) || url,
    compensation: compactCompensation(values.compensation),
    syncedAt,
  };
}

function classifyJob(title, department) {
  const value = `${title ?? ""} ${department ?? ""}`.toLocaleLowerCase();
  if (/\b(ai|ml|machine learning|research|scientist|data science|llm|nlp)\b/.test(value)) {
    return "AI & Research";
  }
  if (/\b(engineer|engineering|developer|software|security|devops|sre|infrastructure|qa)\b/.test(value)) {
    return "Engineering";
  }
  if (/\b(product|design|designer|ux|ui)\b/.test(value)) return "Product & Design";
  if (/\b(sales|marketing|growth|account executive|business development|customer success)\b/.test(value)) {
    return "Sales & Marketing";
  }
  if (/\b(finance|legal|people|recruit|talent|operations|operator|chief of staff|support)\b/.test(value)) {
    return "Operations";
  }
  return "Other";
}

function normalizeWorkplace(value) {
  const normalized = cleanString(Array.isArray(value) ? value.join(" ") : value)
    ?.replaceAll("_", "-")
    .toLocaleLowerCase();
  if (!normalized) return "Unspecified";
  if (normalized.includes("hybrid")) return "Hybrid";
  if (normalized.includes("remote")) return "Remote";
  if (normalized.includes("on-site") || normalized.includes("onsite") || normalized.includes("office")) {
    return "On-site";
  }
  return "Unspecified";
}

function normalizeEmploymentType(value) {
  const normalized = cleanString(value);
  if (!normalized) return null;
  return normalized.replace(/([a-z])([A-Z])/g, "$1-$2").replaceAll("_", " ");
}

function timestampFromMilliseconds(value) {
  if (!Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function timestampFromSeconds(value) {
  if (!Number.isFinite(value)) return null;
  return new Date(value * 1_000).toISOString();
}

function arrayOrString(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(" · ") : value;
}

function isoTimestamp(value) {
  if (!value) return null;
  const aspNetTimestamp = String(value).match(/^\/Date\((\d+)/)?.[1];
  if (aspNetTimestamp) return new Date(Number(aspNetTimestamp)).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function relativeDate(value, relativeTo) {
  const text = cleanString(value)?.toLocaleLowerCase();
  if (!text) return null;
  const date = new Date(relativeTo);
  if (Number.isNaN(date.valueOf())) return null;
  if (text.includes("today")) return date.toISOString();

  const match = text.match(/(\d+)\+?\s+(day|week|month)/);
  if (!match) return isoTimestamp(value);
  const multiplier = match[2] === "week" ? 7 : match[2] === "month" ? 30 : 1;
  date.setUTCDate(date.getUTCDate() - Number(match[1]) * multiplier);
  return date.toISOString();
}

function stripHtml(value) {
  return cleanString(value)
    ?.replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const string = repairUnicode(String(value)).trim();
  return string || null;
}

function isSharedHostIdentifier(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(value);
}

function repairUnicode(value) {
  let repaired = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        repaired += value[index] + value[index + 1];
        index += 1;
      } else repaired += "�";
    } else if (code >= 0xdc00 && code <= 0xdfff) repaired += "�";
    else repaired += value[index];
  }
  return repaired;
}

function lastPathSegment(value) {
  const url = safeUrl(value);
  return url ? url.pathname.split("/").filter(Boolean).at(-1) : null;
}

function decodedPathSegments(url) {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function titleFromSlug(value) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep malformed upstream slugs usable instead of failing the whole sitemap.
  }
  return decoded
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function decodeXml(value) {
  return value ? decodeHtml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")) : null;
}

function decodeHtml(value) {
  if (value === undefined || value === null) return null;
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stableFallbackId(values) {
  return encodeURIComponent([values.title, values.location, values.url].filter(Boolean).join("|") || "unknown");
}

function truncate(value, maximum) {
  if (!value || value.length <= maximum) return value;
  let end = maximum - 1;
  const lastIncluded = value.charCodeAt(end - 1);
  const firstExcluded = value.charCodeAt(end);
  if (
    lastIncluded >= 0xd800 &&
    lastIncluded <= 0xdbff &&
    firstExcluded >= 0xdc00 &&
    firstExcluded <= 0xdfff
  ) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

function compactCompensation(value) {
  if (!value) return null;
  if (typeof value === "string") return truncate(value, 500);
  if (value.compensationTierSummary || value.scrapeableCompensationSalarySummary) {
    return truncate(value.compensationTierSummary || value.scrapeableCompensationSalarySummary, 500);
  }
  if (typeof value === "object") {
    const compact = {};
    for (const key of ["currency", "interval", "min", "max"]) {
      if (value[key] !== undefined && value[key] !== null) compact[key] = value[key];
    }
    return Object.keys(compact).length ? compact : null;
  }
  return null;
}

function parseAssignedJson(source, variableName) {
  const assignment = new RegExp(`\\b${variableName}\\s*=`).exec(source);
  if (!assignment) return null;
  let start = assignment.index + assignment[0].length;
  while (/\s/.test(source[start] ?? "")) start += 1;
  if (source[start] !== "[" && source[start] !== "{") return null;

  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[" || character === "{") stack.push(character);
    else if (character === "]" || character === "}") {
      const opening = stack.pop();
      if ((opening === "[" && character !== "]") || (opening === "{" && character !== "}")) return null;
      if (!stack.length) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseScriptJson(source, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`<script[^>]+id=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i"));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function board({ provider, identifier, region, boardUrl, apiUrl }) {
  const keyIdentifier = ["ashby", "gem", "getro", "sparkhire", "workday"].includes(provider)
    ? identifier.toLocaleLowerCase("en-US")
    : identifier;
  return {
    key: `${provider}:${region}:${keyIdentifier}`,
    provider,
    identifier,
    region,
    boardUrl,
    apiUrl,
  };
}

function firstPathSegment(url) {
  const rawSegment = url.pathname.split("/").filter(Boolean)[0];
  if (!rawSegment) return null;

  try {
    return decodeURIComponent(rawSegment).trim() || null;
  } catch {
    return rawSegment.trim() || null;
  }
}

function safeUrl(value) {
  try {
    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(withProtocol);
  } catch {
    return null;
  }
}
