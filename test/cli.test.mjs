import assert from "node:assert/strict";
import test from "node:test";
import { selectValidationSample } from "../src/validation.mjs";

test("validation samples providers in a round robin", () => {
  const boards = [
    { provider: "ashby", key: "a1" },
    { provider: "ashby", key: "a2" },
    { provider: "ashby", key: "a3" },
    { provider: "greenhouse", key: "g1" },
    { provider: "greenhouse", key: "g2" },
    { provider: "lever", key: "l1" },
    { provider: "lever", key: "l2" },
  ];

  assert.deepEqual(
    selectValidationSample(boards, 6).map((board) => board.key),
    ["a1", "g1", "l1", "a2", "g2", "l2"],
  );
});
