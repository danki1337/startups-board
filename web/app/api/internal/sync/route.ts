import { env } from "cloudflare:workers";
import { getD1 } from "../../../../db";

type RemoteBoard = {
  key: string;
  provider: string;
  identifier: string;
  status: "active" | "empty" | "invalid" | "error";
  jobCount: number;
  syncedAt: string;
  error?: string | null;
};

type RemoteJob = {
  key: string;
  sourceId: string;
  boardKey: string;
  provider: string;
  companyIdentifier: string;
  companyName?: string | null;
  companyLogoUrl?: string | null;
  title: string;
  location?: string | null;
  workplace: string;
  employmentType?: string | null;
  category: string;
  publishedAt?: string | null;
  url: string;
  fingerprint: string;
};

export async function POST(request: Request) {
  const expectedToken = (env as unknown as { SYNC_TOKEN?: string }).SYNC_TOKEN;
  const suppliedToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expectedToken || suppliedToken !== expectedToken) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json() as { board?: RemoteBoard; jobs?: RemoteJob[] };
  if (!isBoard(payload.board) || !Array.isArray(payload.jobs)) {
    return Response.json({ error: "A valid board and jobs array are required" }, { status: 400 });
  }

  const board = payload.board;
  const jobs = payload.jobs.filter((job) => isJob(job) && job.boardKey === board.key);
  const db = getD1();
  let changedJobs = 0;
  let closedJobs = 0;
  const company = jobs.find((job) => job.companyName);
  const companyKey = board.provider === "getro" || !company?.companyName ? null : `company:${board.key}`;

  if (companyKey && company?.companyName) {
    await db.prepare(`
      INSERT INTO companies (key, name, logo_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        name = excluded.name,
        logo_url = coalesce(excluded.logo_url, companies.logo_url),
        updated_at = excluded.updated_at
    `).bind(companyKey, company.companyName, company.companyLogoUrl ?? null, board.syncedAt, board.syncedAt).run();
  }

  if (board.status !== "error") {
    const current = await db.prepare(
      "SELECT key, source_id AS sourceId FROM jobs WHERE board_key = ? AND is_active = 1",
    ).bind(board.key).all<{ key: string; sourceId: string }>();
    const incomingSourceIds = new Set(jobs.map((job) => job.sourceId));
    const missingKeys = current.results
      .filter((job) => !incomingSourceIds.has(job.sourceId))
      .map((job) => job.key);

    for (const batch of chunks(jobs, 40)) {
      const results = await db.batch(batch.map((job) => db.prepare(`
        INSERT INTO jobs (
          key, source_id, board_key, provider, company_identifier, company_name,
          company_logo_url, title,
          location, workplace, employment_type, category, published_at, url,
          fingerprint, seen_run_id, is_active, first_seen_at, updated_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET
          source_id = excluded.source_id,
          board_key = excluded.board_key,
          provider = excluded.provider,
          company_identifier = excluded.company_identifier,
          company_name = excluded.company_name,
          company_logo_url = excluded.company_logo_url,
          title = excluded.title,
          location = excluded.location,
          workplace = excluded.workplace,
          employment_type = excluded.employment_type,
          category = excluded.category,
          published_at = excluded.published_at,
          url = excluded.url,
          fingerprint = excluded.fingerprint,
          is_active = 1,
          updated_at = excluded.updated_at,
          closed_at = NULL
        WHERE jobs.fingerprint <> excluded.fingerprint OR jobs.is_active = 0
      `).bind(
        job.key,
        job.sourceId,
        job.boardKey,
        job.provider,
        job.companyIdentifier,
        job.companyName ?? null,
        job.companyLogoUrl ?? null,
        job.title,
        job.location ?? null,
        job.workplace,
        job.employmentType ?? null,
        job.category,
        job.publishedAt ?? null,
        job.url,
        job.fingerprint,
        board.syncedAt,
        board.syncedAt,
        board.syncedAt,
      )));
      changedJobs += results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
    }

    for (const batch of chunks(missingKeys, 40)) {
      const results = await db.batch(batch.map((key) => db.prepare(`
        UPDATE jobs
        SET is_active = 0, closed_at = ?, updated_at = ?
        WHERE key = ? AND is_active = 1
      `).bind(board.syncedAt, board.syncedAt, key)));
      closedJobs += results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
    }
  }

  await db.prepare(`
    INSERT INTO boards (
      key, provider, identifier, region, board_url, api_url, company_key,
      status, queue_state, job_count, failure_count, last_synced_at, next_sync_at,
      last_error, discovered_at, updated_at
    ) VALUES (?, ?, ?, 'global', '', '', ?, ?, 'idle', ?, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      provider = excluded.provider,
      identifier = excluded.identifier,
      status = excluded.status,
      queue_state = 'idle',
      job_count = excluded.job_count,
      failure_count = CASE WHEN excluded.status = 'error' THEN boards.failure_count + 1 ELSE 0 END,
      last_synced_at = excluded.last_synced_at,
      next_sync_at = excluded.next_sync_at,
      last_error = excluded.last_error,
      company_key = coalesce(excluded.company_key, boards.company_key),
      updated_at = excluded.updated_at
  `).bind(
    board.key,
    board.provider,
    board.identifier,
    companyKey,
    board.status,
    board.jobCount,
    board.syncedAt,
    board.syncedAt,
    board.error ?? null,
    board.syncedAt,
    board.syncedAt,
  ).run();

  return Response.json({ ok: true, boardKey: board.key, changedJobs, closedJobs });
}

function isBoard(value: RemoteBoard | undefined): value is RemoteBoard {
  return Boolean(
    value?.key
    && value.provider
    && value.identifier
    && value.syncedAt
    && ["active", "empty", "invalid", "error"].includes(value.status),
  );
}

function isJob(value: RemoteJob): value is RemoteJob {
  return Boolean(
    value?.key
    && value.sourceId
    && value.boardKey
    && value.provider
    && value.companyIdentifier
    && value.title
    && value.url
    && value.fingerprint,
  );
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
