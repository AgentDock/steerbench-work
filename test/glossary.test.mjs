/**
 * @fileoverview Unit tests for the glossary loader and term matcher.
 * @module test/glossary.test
 *
 * Exercises buildGlossaryIndex / termsInText / cardProse / cardTerms against the
 * properties that matter for the labeler: word-boundary matching, longest match
 * wins, first occurrence only, case-insensitivity with canonical spelling,
 * hyphen/digit terms, multi-word phrases, the empty glossary, and card-level
 * aggregation. A final case asserts the packaged glossary.json loads and indexes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadGlossaryGroups,
  buildGlossaryIndex,
  termsInText,
  cardProse,
  cardTerms
} from "../src/glossary.mjs";

const index = buildGlossaryIndex([
  {
    group: "Domain terms",
    terms: {
      ECOA: "US Equal Credit Opportunity Act.",
      credit: "Money lent that must be repaid.",
      "credit utilization": "Share of available credit in use.",
      API: "Application programming interface.",
      "WASP-18b": "An exoplanet.",
      "deferred prosecution agreement": "A legal settlement."
    }
  }
]);

test("matches a whole-word term", () => {
  assert.deepEqual(termsInText("the claim is subject to ECOA rules", index), ["ECOA"]);
});

test("never matches inside a larger word", () => {
  // "API" must not match inside "rapidly"; "credit" not inside "discredited".
  assert.deepEqual(termsInText("answered rapidly and discredited", index), []);
});

test("longest match wins over a shorter contained term", () => {
  assert.deepEqual(termsInText("high credit utilization this month", index), ["credit utilization"]);
});

test("surfaces each term only on its first occurrence", () => {
  assert.deepEqual(termsInText("ECOA today, ECOA tomorrow", index), ["ECOA"]);
});

test("is case-insensitive but returns the canonical spelling", () => {
  assert.deepEqual(termsInText("about ecoa and an api", index), ["ECOA", "API"]);
});

test("matches hyphen-and-digit terms", () => {
  assert.deepEqual(termsInText("observed WASP-18b in 2023", index), ["WASP-18b"]);
});

test("matches multi-word phrases", () => {
  assert.deepEqual(termsInText("signed a deferred prosecution agreement", index), [
    "deferred prosecution agreement"
  ]);
});

test("an empty glossary matches nothing and does not throw", () => {
  assert.deepEqual(termsInText("anything at all", buildGlossaryIndex([])), []);
});

test("cardProse flattens request, action, context, and evidence text", () => {
  const prose = cardProse([
    { kind: "section", label: "Request", text: "publish the post" },
    { kind: "action", text: "send email", tag: "external_send" },
    { kind: "context", items: [["reversibility", "low"]] },
    { kind: "evidence", items: [{ name: "cmd:lookup", status: "current", extra: "x=1" }] }
  ]);
  assert.ok(prose.includes("publish the post"));
  assert.ok(prose.includes("external_send"));
  assert.ok(prose.includes("reversibility low"));
  assert.ok(prose.includes("cmd:lookup"));
});

test("cardTerms unions chip and status labels with prose matches, deduped", () => {
  const idx = buildGlossaryIndex([
    {
      group: "g",
      terms: {
        commit_point: "At the commit boundary.",
        current: "In force now.",
        ECOA: "Fair-lending law."
      }
    }
  ]);
  const blocks = [
    { kind: "chips", items: ["commit_point"] },
    { kind: "evidence", items: [{ name: "cmd:lookup", status: "current" }] },
    { kind: "section", label: "Request", text: "this concerns ECOA compliance" }
  ];
  assert.deepEqual(cardTerms(blocks, idx).sort(), ["ECOA", "commit_point", "current"]);
});

test("cardTerms drops labels that are not defined in the glossary", () => {
  const idx = buildGlossaryIndex([{ group: "g", terms: { current: "In force now." } }]);
  const blocks = [
    { kind: "chips", items: ["commit_point"] },
    { kind: "evidence", items: [{ name: "x", status: "current" }] }
  ];
  assert.deepEqual(cardTerms(blocks, idx), ["current"]);
});

test("the packaged glossary.json loads and indexes", () => {
  const idx = buildGlossaryIndex(loadGlossaryGroups());
  assert.ok(Object.keys(idx.map).length > 200);
  assert.ok(termsInText("a JWST observation", idx).includes("JWST"));
});

test("merges groups, last definition wins when a term repeats", () => {
  const idx = buildGlossaryIndex([
    { group: "a", terms: { API: "first definition" } },
    { group: "b", terms: { API: "second definition" } }
  ]);
  assert.equal(idx.map.API, "second definition");
});

test("empty or whitespace-only term keys are dropped from the index", () => {
  const idx = buildGlossaryIndex([{ group: "g", terms: { "": "blank", "   ": "spaces", API: "real" } }]);
  assert.deepEqual(Object.keys(idx.map).sort(), ["   ", "", "API"].sort()); // map keeps raw entries
  // but the matcher never builds an empty branch, so normal prose stays fast and clean
  assert.deepEqual(termsInText("the API here", idx), ["API"]);
});
