import { parseAtsUrl } from "./providers.mjs";

export function createRegistry() {
  return new Map();
}

export function addDiscoveredUrl(registry, rawUrl, metadata = {}) {
  const candidate = parseAtsUrl(rawUrl, metadata.provider);
  if (!candidate) return null;

  const now = metadata.discoveredAt ?? new Date().toISOString();
  const existing = registry.get(candidate.key);

  if (existing) {
    existing.discoverySources = unique([
      ...existing.discoverySources,
      ...(metadata.discoverySource ? [metadata.discoverySource] : []),
    ]);
    existing.sampleUrls = unique([...existing.sampleUrls, rawUrl]).slice(0, 3);
    return existing;
  }

  const record = {
    ...candidate,
    discoverySources: metadata.discoverySource ? [metadata.discoverySource] : [],
    sampleUrls: [rawUrl],
    firstDiscoveredAt: now,
    validation: null,
  };

  registry.set(record.key, record);
  return record;
}

export function registryToArray(registry) {
  return [...registry.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function arrayToRegistry(records) {
  const registry = createRegistry();
  for (const record of records) {
    const candidate = parseAtsUrl(record.boardUrl, record.provider);
    const normalized = {
      ...record,
      ...(candidate ?? {}),
      discoverySources: Array.isArray(record.discoverySources) ? record.discoverySources : [],
      sampleUrls: Array.isArray(record.sampleUrls) ? record.sampleUrls : [record.boardUrl].filter(Boolean),
    };
    const existing = registry.get(normalized.key);
    if (!existing) {
      registry.set(normalized.key, normalized);
      continue;
    }

    existing.discoverySources = unique([...existing.discoverySources, ...normalized.discoverySources]);
    existing.sampleUrls = unique([...existing.sampleUrls, ...normalized.sampleUrls]).slice(0, 3);
    if (
      normalized.firstDiscoveredAt
      && (!existing.firstDiscoveredAt || normalized.firstDiscoveredAt < existing.firstDiscoveredAt)
    ) {
      existing.firstDiscoveredAt = normalized.firstDiscoveredAt;
    }
    if (!existing.validation && normalized.validation) existing.validation = normalized.validation;
  }
  return registry;
}

function unique(values) {
  return [...new Set(values)];
}
