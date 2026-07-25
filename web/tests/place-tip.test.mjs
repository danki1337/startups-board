import assert from "node:assert/strict";
import test from "node:test";

import { placeTip } from "../app/place-tip.mjs";

// A cell mid-table with plenty of room either side.
const anchor = (left, width, top = 400, height = 18) =>
  ({ left, top, width, bottom: top + height });

test("the bubble is centred on its anchor", () => {
  // The case the change is for: the bubble is wider than the cropped text it explains, so aligning
  // their left edges (what it used to do) hung it off to one side.
  const { left } = placeTip(anchor(200, 265), 360, 30, 1440);
  assert.equal(left + 360 / 2, 200 + 265 / 2, "bubble centre should equal anchor centre");
});

test("a narrower bubble is centred too", () => {
  const { left } = placeTip(anchor(600, 400), 120, 30, 1440);
  assert.equal(left + 120 / 2, 600 + 400 / 2);
});

test("centring never pushes the bubble off either edge", () => {
  // A cropped cell hard against the left rail: centred, this would start at a negative left.
  const nearLeft = placeTip(anchor(12, 60), 360, 30, 1440);
  assert.equal(nearLeft.left, 8, "clamps to the 8px gutter rather than going negative");

  // And the mirror case on the right.
  const nearRight = placeTip(anchor(1380, 50), 360, 30, 1440);
  assert.equal(nearRight.left, 1440 - 360 - 8);
  assert.ok(nearRight.left + 360 <= 1440 - 8);
});

test("a bubble wider than the viewport pins to the left gutter, not past it", () => {
  // The upper clamp bound (viewportWidth - width - 8) goes negative here. Without the Math.max
  // guarding it, Math.min would pick that negative bound and place the bubble off-screen -- the
  // opposite of what a clamp is for.
  const { left } = placeTip(anchor(100, 40), 500, 30, 380);
  assert.equal(left, 8);
});

test("it sits above the anchor, and flips below only when there is no room", () => {
  const roomy = placeTip(anchor(400, 200, 400), 300, 30, 1440);
  assert.equal(roomy.top, 400 - 30 - 8, "8px above the anchor");

  // A row at the very top of the viewport: above would be off-screen, so it goes under instead.
  const cramped = placeTip(anchor(400, 200, 10), 300, 30, 1440);
  assert.equal(cramped.top, 10 + 18 + 8, "8px below the anchor's bottom");
});
