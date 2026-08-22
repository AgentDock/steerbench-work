/**
 * @fileoverview Regression tests for deterministic CP4 dependency-ledger generation.
 * @module test/cp4-dependency-ledger
 *
 * Covers exact corpus binding, claim validation, clique expansion, stable ordering,
 * connected components, and byte-for-byte comparison with the committed ledger.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDependencyLedgerMatches,
  generateCp4DependencyLedger
} from "../src/cp4-dependency-ledger.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORPUS = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const DEPENDENCY_SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, "SHORTCUT_DEPENDENCY_SPEC.json"), "utf8"));
const DIGEST = "a".repeat(64);
const KINDS = [
  "recertified_pair_or_mirror_id",
  "immutable_upstream_source_example_id",
  "generating_template_lineage_id"
];

function compareCodePointStrings(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function corpusScenarioIds() {
  return fs.readdirSync(CORPUS)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(CORPUS, name), "utf8")).id)
    .sort(compareCodePointStrings);
}

const SCENARIO_IDS = corpusScenarioIds();

function sourceReceipt(artifact = "integrity-audit/v2-audit/cp4-source.json", sha256 = DIGEST) {
  return { artifact, sha256 };
}

function emptyClaims() {
  return Object.fromEntries(KINDS.map((kind) => [kind, []]));
}

function makeRecertification() {
  return {
    records: SCENARIO_IDS.map((scenarioId) => ({
      scenario_id: scenarioId,
      dependency_claims: emptyClaims()
    }))
  };
}

function addClaim(recertification, scenarioIds, kind, id, receipt = sourceReceipt()) {
  const records = new Map(recertification.records.map((record) => [record.scenario_id, record]));
  for (const scenarioId of scenarioIds) {
    records.get(scenarioId).dependency_claims[kind].push({ id, source_receipt: receipt });
  }
}

function committedSpec(candidate) {
  const spec = structuredClone(DEPENDENCY_SPEC);
  spec.ledger = {
    status: "owner_recertified",
    owner_signature: "fixture-scientific-owner",
    recertified_at: "2026-08-21T00:00:00Z",
    scenario_ids: structuredClone(candidate.scenario_ids),
    edges: structuredClone(candidate.edges),
    components: structuredClone(candidate.components)
  };
  return spec;
}

test("generates an exact 106-row singleton candidate", () => {
  const generated = generateCp4DependencyLedger(makeRecertification(), {
    dependencySpec: DEPENDENCY_SPEC
  });

  assert.equal(generated.scenario_ids.length, 106);
  assert.deepEqual(generated.scenario_ids, SCENARIO_IDS);
  assert.deepEqual(generated.edges, []);
  assert.deepEqual(generated.components, SCENARIO_IDS.map((scenarioId) => [scenarioId]));
  assert.equal(assertDependencyLedgerMatches(generated, committedSpec(generated)), true);
});

test("rejects a 106-row candidate whose scenario ID set drifts from the frozen hash", () => {
  const recertification = makeRecertification();
  recertification.records.at(-1).scenario_id = "scenario-not-in-the-frozen-corpus";

  assert.throws(
    () => generateCp4DependencyLedger(recertification, { dependencySpec: DEPENDENCY_SPEC }),
    /does not match the frozen corpus ID-set hash/u
  );
});

test("rejects forbidden broad dependency claims", () => {
  for (const forbidden of DEPENDENCY_SPEC.edge_rules.forbidden_sources) {
    const recertification = makeRecertification();
    recertification.records[0].dependency_claims[forbidden] = [];
    assert.throws(
      () => generateCp4DependencyLedger(recertification, { dependencySpec: DEPENDENCY_SPEC }),
      new RegExp(`forbidden broad dependency claim ${forbidden}`, "u")
    );
  }
});

test("fails closed on missing claims, unsupported kinds, and malformed receipts", () => {
  const missingClaims = makeRecertification();
  delete missingClaims.records[0].dependency_claims;
  assert.throws(
    () => generateCp4DependencyLedger(missingClaims, { dependencySpec: DEPENDENCY_SPEC }),
    /dependency_claims is required/u
  );

  const missingArray = makeRecertification();
  delete missingArray.records[0].dependency_claims[KINDS[0]];
  assert.throws(
    () => generateCp4DependencyLedger(missingArray, { dependencySpec: DEPENDENCY_SPEC }),
    /must be an explicit array/u
  );

  const unsupported = makeRecertification();
  unsupported.records[0].dependency_claims.unregistered_family = [];
  assert.throws(
    () => generateCp4DependencyLedger(unsupported, { dependencySpec: DEPENDENCY_SPEC }),
    /unsupported dependency claim kind unregistered_family/u
  );

  const malformed = makeRecertification();
  addClaim(malformed, [SCENARIO_IDS[0]], KINDS[0], "pair-1", sourceReceipt("source.json", "not-a-digest"));
  assert.throws(
    () => generateCp4DependencyLedger(malformed, { dependencySpec: DEPENDENCY_SPEC }),
    /source_receipt\.sha256 must be a lowercase SHA-256 digest/u
  );

  const conflicting = makeRecertification();
  addClaim(conflicting, [SCENARIO_IDS[0]], KINDS[0], "pair-1", sourceReceipt("source-a.json"));
  addClaim(conflicting, [SCENARIO_IDS[1]], KINDS[0], "pair-1", sourceReceipt("source-b.json"));
  assert.throws(
    () => generateCp4DependencyLedger(conflicting, { dependencySpec: DEPENDENCY_SPEC }),
    /claim "pair-1" has conflicting source receipts/u
  );
});

test("normalizes record order, clique endpoints, edges, and components", () => {
  const recertification = makeRecertification();
  const members = [SCENARIO_IDS.at(-1), SCENARIO_IDS[53], SCENARIO_IDS[0]];
  const receipt = sourceReceipt("sources/lineage-😀.json");
  const reversedReceiptKeys = { sha256: receipt.sha256, artifact: receipt.artifact };
  addClaim(recertification, members, KINDS[2], "lineage-😀", reversedReceiptKeys);
  addClaim(recertification, [members[0]], KINDS[2], "lineage-Ω", sourceReceipt("sources/lineage-Ω.json"));
  recertification.records.reverse();
  for (const record of recertification.records) {
    record.dependency_claims[KINDS[2]].reverse();
  }

  const generated = generateCp4DependencyLedger(recertification, {
    dependencySpec: DEPENDENCY_SPEC
  });
  const sortedMembers = [...members].sort(compareCodePointStrings);

  assert.deepEqual(generated.scenario_ids, SCENARIO_IDS);
  assert.deepEqual(generated.edges, [
    { left: sortedMembers[0], right: sortedMembers[1], kind: KINDS[2], source_receipt: receipt },
    { left: sortedMembers[0], right: sortedMembers[2], kind: KINDS[2], source_receipt: receipt },
    { left: sortedMembers[1], right: sortedMembers[2], kind: KINDS[2], source_receipt: receipt }
  ]);
  assert.deepEqual(Object.keys(generated.edges[0].source_receipt), ["artifact", "sha256"]);
  assert.deepEqual(
    generated.components.find((component) => component.includes(sortedMembers[0])),
    sortedMembers
  );
});

test("requires owner resolution when one endpoint pair has multiple claims or kinds", () => {
  const [left, right] = SCENARIO_IDS;
  const crossKind = makeRecertification();
  addClaim(crossKind, [left, right], KINDS[0], "pair-one", sourceReceipt("sources/pair-one.json"));
  addClaim(crossKind, [left, right], KINDS[1], "source-one", sourceReceipt("sources/source-one.json"));
  assert.throws(
    () => generateCp4DependencyLedger(crossKind, { dependencySpec: DEPENDENCY_SPEC }),
    /multiple claims or kinds.*owner resolution is required/u
  );

  const sameKind = makeRecertification();
  addClaim(sameKind, [left, right], KINDS[0], "pair-one", sourceReceipt("sources/pair-one.json"));
  addClaim(sameKind, [left, right], KINDS[0], "pair-two", sourceReceipt("sources/pair-two.json"));
  assert.throws(
    () => generateCp4DependencyLedger(sameKind, { dependencySpec: DEPENDENCY_SPEC }),
    /multiple claims or kinds.*owner resolution is required/u
  );
});

test("detects an omitted true edge in the committed ledger", () => {
  const recertification = makeRecertification();
  addClaim(recertification, SCENARIO_IDS.slice(0, 2), KINDS[0], "pair-one");
  const generated = generateCp4DependencyLedger(recertification, { dependencySpec: DEPENDENCY_SPEC });
  const omitted = generateCp4DependencyLedger(makeRecertification(), { dependencySpec: DEPENDENCY_SPEC });

  assert.throws(
    () => assertDependencyLedgerMatches(generated, committedSpec(omitted)),
    /committed dependency edge bytes differ from generated bytes/u
  );
});

test("detects an invented edge in the committed ledger", () => {
  const generated = generateCp4DependencyLedger(makeRecertification(), { dependencySpec: DEPENDENCY_SPEC });
  const inventedRows = makeRecertification();
  addClaim(inventedRows, SCENARIO_IDS.slice(0, 2), KINDS[0], "invented-pair");
  const invented = generateCp4DependencyLedger(inventedRows, { dependencySpec: DEPENDENCY_SPEC });

  assert.throws(
    () => assertDependencyLedgerMatches(generated, committedSpec(invented)),
    /committed dependency edge bytes differ from generated bytes/u
  );
});

test("detects committed component drift", () => {
  const recertification = makeRecertification();
  addClaim(recertification, SCENARIO_IDS.slice(0, 2), KINDS[0], "pair-one");
  const generated = generateCp4DependencyLedger(recertification, { dependencySpec: DEPENDENCY_SPEC });
  const drifted = committedSpec(generated);
  drifted.ledger.components = SCENARIO_IDS.map((scenarioId) => [scenarioId]);

  assert.throws(
    () => assertDependencyLedgerMatches(generated, drifted),
    /committed dependency components do not equal the edge-derived components/u
  );
});

test("rejects self and duplicate edges in a committed ledger", () => {
  const generated = generateCp4DependencyLedger(makeRecertification(), { dependencySpec: DEPENDENCY_SPEC });
  const selfEdge = committedSpec(generated);
  selfEdge.ledger.edges = [{
    left: SCENARIO_IDS[0],
    right: SCENARIO_IDS[0],
    kind: KINDS[0],
    source_receipt: sourceReceipt()
  }];
  assert.throws(() => assertDependencyLedgerMatches(generated, selfEdge), /self-edges are forbidden/u);

  const duplicate = committedSpec(generated);
  duplicate.ledger.edges = [
    {
      left: SCENARIO_IDS[0],
      right: SCENARIO_IDS[1],
      kind: KINDS[0],
      source_receipt: sourceReceipt()
    },
    {
      left: SCENARIO_IDS[0],
      right: SCENARIO_IDS[1],
      kind: KINDS[0],
      source_receipt: sourceReceipt()
    }
  ];
  assert.throws(() => assertDependencyLedgerMatches(generated, duplicate), /duplicate dependency edge/u);
});
