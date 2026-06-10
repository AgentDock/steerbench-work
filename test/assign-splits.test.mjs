// Tests for scripts/assign-splits.mjs, run against the real published
// scenario set so the grouping rule and direction derivation are checked
// on live data, not fixtures.
//
// Pins the two protocol guarantees: same seed always reproduces the same
// assignment, and a family never straddles splits.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadScenarios,
  assignSplits,
  SPLIT_NAMES
} from "../scripts/assign-splits.mjs";

const setDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scenario-sets",
  "steerbench-work-2026-05"
);
const scenarios = loadScenarios(setDir);
const RATIOS = [70, 15, 15];

test("loads the full published scenario set with derived directions", () => {
  assert.equal(scenarios.length, 106);
  const proceed = scenarios.filter((s) => s.direction === "must_proceed").length;
  const hold = scenarios.filter((s) => s.direction === "must_hold").length;
  assert.equal(proceed, 56);
  assert.equal(hold, 50);
  assert.equal(new Set(scenarios.map((s) => s.family)).size, 30);
});

test("same seed produces byte-identical assignments and summaries", () => {
  const a = assignSplits(scenarios, { seed: 7, ratios: RATIOS });
  const b = assignSplits(scenarios, { seed: 7, ratios: RATIOS });
  assert.deepEqual(a.assignments, b.assignments);
  assert.deepEqual(a.per_split, b.per_split);
});

test("seed changes the family roster", () => {
  const rosters = new Set();
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = assignSplits(scenarios, { seed, ratios: RATIOS });
    rosters.add(JSON.stringify(r.assignments));
  }
  assert.ok(rosters.size > 1, "five seeds all produced the same assignment");
});

test("no family straddles splits", () => {
  const { assignments } = assignSplits(scenarios, { seed: 1, ratios: RATIOS });
  const familySplit = new Map();
  for (const s of scenarios) {
    const split = assignments[s.id];
    if (!familySplit.has(s.family)) familySplit.set(s.family, split);
    assert.equal(
      split,
      familySplit.get(s.family),
      `family ${s.family} appears in both ${familySplit.get(s.family)} and ${split}`
    );
  }
});

test("every scenario gets exactly one valid split", () => {
  const { assignments } = assignSplits(scenarios, { seed: 1, ratios: RATIOS });
  assert.equal(Object.keys(assignments).length, scenarios.length);
  for (const s of scenarios) {
    assert.ok(
      SPLIT_NAMES.includes(assignments[s.id]),
      `scenario ${s.id} has split "${assignments[s.id]}"`
    );
  }
});

test("per-split counts track the ratio targets within family granularity", () => {
  const { per_split } = assignSplits(scenarios, { seed: 1, ratios: RATIOS });
  let totalCount = 0;
  let totalProceed = 0;
  for (const name of SPLIT_NAMES) {
    const s = per_split[name];
    totalCount += s.scenario_count;
    totalProceed += s.direction.must_proceed;
    // Whole-family packing cannot hit the target exactly; the largest
    // small-family sizes bound the deviation.
    assert.ok(
      Math.abs(s.scenario_count - s.target_count) <= 6,
      `${name} count ${s.scenario_count} too far from target ${s.target_count}`
    );
  }
  assert.equal(totalCount, scenarios.length);
  assert.equal(totalProceed, 56);
});
