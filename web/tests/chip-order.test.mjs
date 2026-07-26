import assert from "node:assert/strict";
import test from "node:test";

// orderChips lives in a .tsx file, so it is restated here as the same twelve lines the component
// runs. Not ideal -- the real thing would move to its own module -- but the ordering rule is worth
// pinning, and the alternative is no coverage at all.
let chipOrder = [];
const chipId = (chip) => `${chip.kind}:${chip.label}`;
function orderChips(chips) {
  const ids = chips.map(chipId);
  const present = new Set(ids);
  const known = new Set(chipOrder);
  chipOrder = [...chipOrder.filter((id) => present.has(id)), ...ids.filter((id) => !known.has(id))];
  const rank = new Map(chipOrder.map((id, index) => [id, index]));
  return [...chips].sort((left, right) => rank.get(chipId(left)) - rank.get(chipId(right)));
}

const chip = (kind, label) => ({ kind, label });
const labels = (chips) => chips.map((c) => c.label);

test("a newly applied filter goes to the end", () => {
  chipOrder = [];
  // The construction order is fixed: search, then country, then source. Applying them in the
  // opposite order must NOT re-sort them into that fixed sequence.
  orderChips([chip("source", "Ashby")]);
  const two = orderChips([chip("country", "Germany"), chip("source", "Ashby")]);
  assert.deepEqual(labels(two), ["Ashby", "Germany"], "the country was applied second and belongs last");

  const three = orderChips([chip("search", "“nurse”"), chip("country", "Germany"), chip("source", "Ashby")]);
  assert.deepEqual(labels(three), ["Ashby", "Germany", "“nurse”"]);
});

test("removing a chip does not disturb the others", () => {
  chipOrder = [];
  orderChips([chip("source", "Ashby")]);
  orderChips([chip("country", "Germany"), chip("source", "Ashby")]);
  orderChips([chip("search", "“x”"), chip("country", "Germany"), chip("source", "Ashby")]);
  const after = orderChips([chip("search", "“x”"), chip("source", "Ashby")]);
  assert.deepEqual(labels(after), ["Ashby", "“x”"]);
});

test("re-adding a removed chip puts it at the end again", () => {
  chipOrder = [];
  orderChips([chip("source", "Ashby"), chip("country", "Germany")]);
  orderChips([chip("country", "Germany")]);            // Ashby cleared
  const back = orderChips([chip("country", "Germany"), chip("source", "Ashby")]);
  assert.deepEqual(labels(back), ["Germany", "Ashby"], "it was applied again, so it is newest");
});

test("clearing everything leaves no stale order behind", () => {
  chipOrder = [];
  orderChips([chip("source", "Ashby"), chip("country", "Germany")]);
  assert.deepEqual(labels(orderChips([])), []);
  assert.deepEqual(chipOrder, [], "ids that no longer exist are dropped, not accumulated");
});
