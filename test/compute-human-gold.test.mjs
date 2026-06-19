/**
 * @fileoverview Unit tests for the human-gold aggregator.
 * @module test/compute-human-gold
 *
 * Covers the load-bearing logic: majority needs two votes, a flag abstains
 * (never votes), Fleiss kappa drops items a rater skipped, the gold comes from
 * the majority, and the adjudication queue catches no-majority and flagged axes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fleissKappa, majority, computeAxis, buildHumanGold } from "../scripts/compute-human-gold.mjs";

test("majority needs >=2; a three-way split has none", () => {
  assert.equal(majority(["allowed", "allowed", "blocked"]), "allowed");
  assert.equal(majority(["low", "medium", "high"]), null);
  assert.equal(majority(["blocked", "blocked"]), "blocked");
  assert.equal(majority(["allowed"]), null);
});

test("fleiss kappa: perfect agreement = 1, and items with a null rater are dropped", () => {
  const items = [
    { byRater: { a: "allowed", b: "allowed", c: "allowed" } },
    { byRater: { a: "blocked", b: "blocked", c: "blocked" } },
    { byRater: { a: "allowed", b: null, c: "allowed" } } // dropped: b skipped it
  ];
  const k = fleissKappa(items, ["a", "b", "c"], ["allowed", "blocked"]);
  assert.equal(k.value, 1);
  assert.equal(k.n_items, 2);
  assert.equal(k.exact_agreement, 1);
});

test("a flag is an abstention, not a vote; gold is the majority; alignment vs canonical", () => {
  const axis = { key: "gate_state", categories: ["allowed", "blocked"], diagnosticOnly: false };
  const scenarioIds = ["s1", "s2"];
  const raterData = {
    r1: { s1: { labels: { gate_state: "blocked" } }, s2: { labels: { gate_state: "allowed", flagged: { gate_state: true } } } },
    r2: { s1: { labels: { gate_state: "blocked" } }, s2: { labels: { gate_state: "allowed" } } },
    r3: { s1: { labels: { gate_state: "allowed" } }, s2: { labels: { gate_state: "allowed" } } }
  };
  const canonical = { s1: { gate_state: "blocked", is_diagnostic: true }, s2: { gate_state: "allowed", is_diagnostic: true } };
  const out = computeAxis(axis, scenarioIds, raterData, ["r1", "r2", "r3"], canonical);
  assert.equal(out.gold.s1, "blocked"); // 2 blocked vs 1 allowed
  assert.equal(out.gold.s2, "allowed"); // r1 flagged (abstains), r2 + r3 allowed
  assert.ok(out.adjudication_queue.some((a) => a.scenario_id === "s2" && a.flagged === true));
  assert.equal(out.canonical_alignment.match, 2); // both majorities match canonical
  assert.equal(out.iaa.n_items, 1); // only s1 has all three voting; s2 has a null (flag)
});

test("buildHumanGold reads rater dirs and produces majority gold + counts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "human-gold-"));
  const labels = path.join(root, "labels");
  const fixture = {
    rater_1: { x1: "blocked", x2: "allowed" },
    rater_2: { x1: "blocked", x2: "allowed" },
    rater_3: { x1: "allowed", x2: "allowed" }
  };
  for (const [r, recs] of Object.entries(fixture)) {
    const d = path.join(labels, r);
    fs.mkdirSync(d, { recursive: true });
    for (const [id, gate] of Object.entries(recs)) {
      fs.writeFileSync(
        path.join(d, `${id}.json`),
        JSON.stringify({ scenario_id: id, labels: { gate_state: gate, irreversibility_tier: "low", functional_category: "not_applicable" } })
      );
    }
  }
  const scenarios = [
    { id: "x1", user_request: "u", expected_behavior: { correct_action: "hold" }, irreversibility_class: "high", source_basis: "" },
    { id: "x2", user_request: "u", expected_behavior: { correct_action: "continue" }, irreversibility_class: "low", source_basis: "" }
  ];
  const res = buildHumanGold({ labelsDir: labels, raters: ["rater_1", "rater_2", "rater_3"], scenarios });
  assert.equal(res.axes.gate_state.gold.x1, "blocked"); // 2 of 3
  assert.equal(res.axes.gate_state.gold.x2, "allowed"); // 3 of 3
  assert.equal(res.rater_record_counts.rater_1, 2);
  assert.equal(res.axes.gate_state.iaa.n_items, 2); // all three voted both
});
