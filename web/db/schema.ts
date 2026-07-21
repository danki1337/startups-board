import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const companies = sqliteTable("companies", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  domain: text("domain"),
  logoUrl: text("logo_url"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const boards = sqliteTable("boards", {
  key: text("key").primaryKey(),
  provider: text("provider").notNull(),
  identifier: text("identifier").notNull(),
  region: text("region").notNull().default("global"),
  boardUrl: text("board_url").notNull(),
  apiUrl: text("api_url").notNull(),
  companyKey: text("company_key"),
  status: text("status").notNull().default("new"),
  queueState: text("queue_state").notNull().default("idle"),
  jobCount: integer("job_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  lastSyncedAt: text("last_synced_at"),
  nextSyncAt: text("next_sync_at").notNull(),
  lastError: text("last_error"),
  discoveredAt: text("discovered_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("boards_due_idx").on(table.queueState, table.nextSyncAt),
  index("boards_provider_status_idx").on(table.provider, table.status),
]);

export const jobs = sqliteTable("jobs", {
  key: text("key").primaryKey(),
  sourceId: text("source_id").notNull(),
  boardKey: text("board_key").notNull(),
  provider: text("provider").notNull(),
  companyIdentifier: text("company_identifier").notNull(),
  companyName: text("company_name"),
  companyLogoUrl: text("company_logo_url"),
  title: text("title").notNull(),
  location: text("location"),
  workplace: text("workplace").notNull().default("Unspecified"),
  employmentType: text("employment_type"),
  category: text("category").notNull().default("Other"),
  publishedAt: text("published_at"),
  url: text("url").notNull(),
  fingerprint: text("fingerprint").notNull(),
  seenRunId: text("seen_run_id").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  firstSeenAt: text("first_seen_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  closedAt: text("closed_at"),
}, (table) => [
  index("jobs_active_published_idx").on(table.isActive, table.publishedAt, table.key),
  index("jobs_provider_active_idx").on(table.provider, table.isActive, table.publishedAt),
  index("jobs_board_active_idx").on(table.boardKey, table.isActive),
  index("jobs_workplace_active_idx").on(table.workplace, table.isActive, table.publishedAt),
  index("jobs_category_active_idx").on(table.category, table.isActive, table.publishedAt),
]);

export const syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  boardKey: text("board_key").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  jobCount: integer("job_count").notNull().default(0),
  changedJobs: integer("changed_jobs").notNull().default(0),
  closedJobs: integer("closed_jobs").notNull().default(0),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  index("sync_runs_board_idx").on(table.boardKey, table.startedAt),
  index("sync_runs_provider_idx").on(table.provider, table.startedAt),
]);

export const providerHealth = sqliteTable("provider_health", {
  provider: text("provider").primaryKey(),
  successfulRuns: integer("successful_runs").notNull().default(0),
  failedRuns: integer("failed_runs").notNull().default(0),
  activeJobs: integer("active_jobs").notNull().default(0),
  lastSuccessAt: text("last_success_at"),
  lastFailureAt: text("last_failure_at"),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull(),
});

export const discoveryPages = sqliteTable("discovery_pages", {
  key: text("key").primaryKey(),
  indexId: text("index_id").notNull(),
  provider: text("provider").notNull(),
  pattern: text("pattern").notNull(),
  page: integer("page").notNull(),
  totalPages: integer("total_pages").notNull(),
  urlCount: integer("url_count").notNull().default(0),
  processedAt: text("processed_at").notNull(),
}, (table) => [index("discovery_pages_target_idx").on(table.indexId, table.provider, table.pattern)]);

export const failedTasks = sqliteTable("failed_tasks", {
  id: text("id").primaryKey(),
  taskType: text("task_type").notNull(),
  provider: text("provider"),
  boardKey: text("board_key"),
  payload: text("payload").notNull(),
  error: text("error").notNull(),
  attempts: integer("attempts").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const systemState = sqliteTable("system_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
