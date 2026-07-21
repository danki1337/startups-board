export function buildReport(boards, context = {}) {
  const byProvider = groupBy(boards, (board) => board.provider);
  const statuses = countBy(boards, (board) => board.validation?.status ?? "unvalidated");
  const activeJobs = boards.reduce((total, board) => total + (board.validation?.jobCount ?? 0), 0);

  const lines = [
    "# ATS discovery proof of concept",
    "",
    `Generated: ${new Date().toISOString()}`,
    context.indexId ? `Common Crawl index: ${context.indexId}` : null,
    "",
    "## Summary",
    "",
    `- Discovered board candidates: ${context.discoveredBoardCount ?? boards.length}`,
    `- Boards validated: ${boards.length}`,
    `- Active boards: ${statuses.active ?? 0}`,
    `- Empty boards: ${statuses.empty ?? 0}`,
    `- Invalid boards: ${statuses.invalid ?? 0}`,
    `- Validation errors: ${statuses.error ?? 0}`,
    `- Active jobs represented: ${activeJobs}`,
    "",
    "## Validated sample by provider",
    "",
    "| Provider | Boards | Active | Jobs |",
    "| --- | ---: | ---: | ---: |",
  ].filter((line) => line !== null);

  for (const [provider, providerBoards] of [...byProvider.entries()].sort()) {
    lines.push(
      `| ${provider} | ${providerBoards.length} | ${providerBoards.filter(isActive).length} | ${providerBoards.reduce(jobTotal, 0)} |`,
    );
  }

  lines.push(
    "",
    "## Notes",
    "",
    "This is a sampled discovery run, not a claim of complete ATS coverage. Common Crawl can lag behind the live web, and authenticated or unindexed boards will not appear.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

function isActive(board) {
  return board.validation?.status === "active";
}

function jobTotal(total, board) {
  return total + (board.validation?.jobCount ?? 0);
}

function groupBy(values, keyFor) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function countBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
