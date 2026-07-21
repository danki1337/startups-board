import assert from "node:assert/strict";
import test from "node:test";
import { buildReport } from "../src/report.mjs";

test("distinguishes all discovered boards from a validation sample", () => {
  const report = buildReport(
    [
      {
        provider: "lever",
        validation: { status: "active", jobCount: 2 },
      },
    ],
    { discoveredBoardCount: 592 },
  );

  assert.match(report, /Discovered board candidates: 592/);
  assert.match(report, /Boards validated: 1/);
});
