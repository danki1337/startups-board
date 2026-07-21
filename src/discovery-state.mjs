export function createDiscoveryState(value) {
  const targets = value?.targets && typeof value.targets === "object" ? value.targets : {};
  return {
    schemaVersion: 1,
    updatedAt: value?.updatedAt ?? null,
    targets: { ...targets },
  };
}

export function crawlCoverageKey(index, target) {
  return `${index.id}|${target.provider}|${target.pattern}`;
}

export function getSampledPages(state, index, target) {
  const record = state.targets[crawlCoverageKey(index, target)];
  return Array.isArray(record?.sampledPages) ? record.sampledPages : [];
}

export function recordCrawlCoverage(state, index, target, result, sampledAt = new Date().toISOString()) {
  const key = crawlCoverageKey(index, target);
  const previous = state.targets[key];
  const totalPages = Math.max(0, Number(result.totalPages ?? 0));
  const sampledPages = uniqueSorted([
    ...(Array.isArray(previous?.sampledPages) ? previous.sampledPages : []),
    ...(Array.isArray(result.sampledPages) ? result.sampledPages : []),
  ]).filter((page) => page < totalPages);

  state.targets[key] = {
    indexId: index.id,
    provider: target.provider,
    pattern: target.pattern,
    totalPages,
    sampledPages,
    completed: totalPages === 0 || sampledPages.length >= totalPages,
    lastSampledAt: sampledAt,
  };
  state.updatedAt = sampledAt;
  return state.targets[key];
}

export function summarizeCrawlCoverage(state) {
  const records = Object.values(state.targets);
  const totalPages = records.reduce((sum, record) => sum + Number(record.totalPages ?? 0), 0);
  const sampledPages = records.reduce(
    (sum, record) => sum + Math.min(record.sampledPages?.length ?? 0, Number(record.totalPages ?? 0)),
    0,
  );
  return {
    targets: records.length,
    completedTargets: records.filter((record) => record.completed).length,
    totalPages,
    sampledPages,
    completion: totalPages ? Number((sampledPages / totalPages).toFixed(4)) : 1,
  };
}

function uniqueSorted(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value >= 0))]
    .sort((left, right) => left - right);
}
