// Tests for the human validation scenario loader and record shaper. Runs against
// the real released scenario set so the 106/76/30 split is verified, not
// mocked, and the record shape matches the agreement scorer's expectation.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadGoldScenarios,
  isDiagnostic,
  buildGoldRecord
} from "../src/gold-scenarios.mjs";

test("loads all 106 scenarios, id-sorted, no manifest noise", () => {
  const scenarios = loadGoldScenarios();
  assert.equal(scenarios.length, 106);
  assert.ok(scenarios.every((s) => s.id && (s.user_request || s.event?.user_request)));
  const ids = scenarios.map((s) => s.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
});

test("76 scenarios are diagnostic, 30 are baselines", () => {
  const scenarios = loadGoldScenarios();
  const diagnostic = scenarios.filter(isDiagnostic);
  assert.equal(diagnostic.length, 76);
  assert.equal(scenarios.length - diagnostic.length, 30);
});

test("diagnostic record keeps the chosen mechanism", () => {
  const scenario = loadGoldScenarios().find(isDiagnostic);
  const rec = buildGoldRecord({
    scenario,
    rater: "rater_1",
    gate: "blocked",
    tier: "high",
    mechanism: "missing-information",
    now: new Date("2026-06-14T00:00:00Z")
  });
  assert.equal(rec.scenario_id, scenario.id);
  assert.equal(rec.annotator, "rater_1");
  assert.equal(rec.is_human, true);
  assert.deepEqual(rec.labels, {
    gate_state: "blocked",
    irreversibility_tier: "high",
    functional_category: "missing-information",
    rationale: ""
  });
  assert.equal(rec.labeled_at_utc, "2026-06-14T00:00:00.000Z");
});

test("baseline record forces not_applicable regardless of mechanism arg", () => {
  const scenario = loadGoldScenarios().find((s) => !isDiagnostic(s));
  const rec = buildGoldRecord({
    scenario,
    rater: "rater_2",
    gate: "allowed",
    tier: "low",
    mechanism: "lexical-overfitting", // should be ignored for a baseline
    now: new Date("2026-06-14T00:00:00Z")
  });
  assert.equal(rec.labels.functional_category, "not_applicable");
});
