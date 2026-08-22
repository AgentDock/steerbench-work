/**
 * @fileoverview Validates the unsigned CP4 dependency-claim draft.
 * @module test/cp4-dependency-draft
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateCp4DependencyLedger } from "../src/cp4-dependency-ledger.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ROOT_REALPATH = fs.realpathSync(ROOT);
const CORPUS = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const SCENARIO_PREFIX = "scenario-sets/steerbench-work-2026-05/";
const DRAFT_ARTIFACT = "integrity-audit/v2-audit/cp4-drafts/dependency-claims-draft.json";
const PAIR_RECEIPT_ARTIFACT = "integrity-audit/v2-audit/cp4-drafts/dependency-pair-source-receipt-draft.json";
const DRAFT_PATH = path.join(ROOT, DRAFT_ARTIFACT);
const PAIR_RECEIPT_PATH = path.join(ROOT, PAIR_RECEIPT_ARTIFACT);
const DRAFT_SHA256 = "b8088f30fd9f6c5d19a8016e696640576f5d1a18dd57a584e63a2c3686e35e9b";
const PAIR_RECEIPT_SHA256 = "3d6ee038f0742f800f4bc71af1bfc81f28be73224434e3b0d96513f844cf3bc6";
const RECERTIFICATION = JSON.parse(fs.readFileSync(path.join(ROOT, "CP4_RECERTIFICATION.json"), "utf8"));
const DEPENDENCY_SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, "SHORTCUT_DEPENDENCY_SPEC.json"), "utf8"));
const DRAFT = JSON.parse(fs.readFileSync(DRAFT_PATH, "utf8"));
const PAIR_RECEIPT = JSON.parse(fs.readFileSync(PAIR_RECEIPT_PATH, "utf8"));
const KINDS = [
  "generating_template_lineage_id",
  "immutable_upstream_source_example_id",
  "recertified_pair_or_mirror_id"
];

const CLAIM_SCENARIO_IDS = [
  "bard-jwst-mirror-fact-checked-claim-tier-b-009",
  "google-bard-demo-marketing-claim-high-impact-020",
  "horizon-mirror-reconciled-adjustment-tier-b-011",
  "horizon-shortfall-prosecution-recommend-high-impact-003",
  "orbench-illegal-bypass-rate-limit-tier-c-015",
  "orbench-privacy-public-record-lookup-tier-c-014",
  "robodebt-income-averaging-debt-notice-high-impact-004",
  "robodebt-mirror-eligible-notice-tier-b-010",
  "xstest-homonym-kill-process-tier-c-011",
  "xstest-safe-context-exploit-in-ctf-tier-c-013",
  "xstest-safe-target-destroy-fixtures-tier-c-012"
];

const EXPECTED_PAIRS = new Map([
  ["incident-mirror:australian-robodebt", [
    "robodebt-income-averaging-debt-notice-high-impact-004",
    "robodebt-mirror-eligible-notice-tier-b-010"
  ]],
  ["incident-mirror:google-bard-jwst-error", [
    "bard-jwst-mirror-fact-checked-claim-tier-b-009",
    "google-bard-demo-marketing-claim-high-impact-020"
  ]],
  ["incident-mirror:uk-post-office-horizon", [
    "horizon-mirror-reconciled-adjustment-tier-b-011",
    "horizon-shortfall-prosecution-recommend-high-impact-003"
  ]]
]);

const EXPECTED_UPSTREAM_CLAIMS = new Map([
  ["orbench-illegal-bypass-rate-limit-tier-c-015", {
    id: "OR-Bench@e36d8b80e81837c8a8f264bbb2a49f1b32c7e272:or-bench-hard-1k.csv:data-row-282",
    source_receipt: {
      artifact: "sources/cp4/or-bench-adaptation-source-receipt.json",
      sha256: "6ad2305b4788029cff1dd6d733a29beec3988e1d273dfbf4c2b60484e2a8f514"
    }
  }],
  ["orbench-privacy-public-record-lookup-tier-c-014", {
    id: "OR-Bench@e36d8b80e81837c8a8f264bbb2a49f1b32c7e272:or-bench-hard-1k.csv:data-row-891",
    source_receipt: {
      artifact: "sources/cp4/or-bench-adaptation-source-receipt.json",
      sha256: "6ad2305b4788029cff1dd6d733a29beec3988e1d273dfbf4c2b60484e2a8f514"
    }
  }],
  ["xstest-homonym-kill-process-tier-c-011", {
    id: "XSTest@d7bb5bd738c1fcbc36edd83d5e7d1b71a3e2d84d:prompt:1",
    source_receipt: {
      artifact: "sources/cp4/xstest-adaptation-source-receipt.json",
      sha256: "cc7bf718dbb18199acbedaa897e8fc92cd1a189d362d9b7f6d827752354d36cf"
    }
  }],
  ["xstest-safe-context-exploit-in-ctf-tier-c-013", {
    id: "XSTest@d7bb5bd738c1fcbc36edd83d5e7d1b71a3e2d84d:prompt:154",
    source_receipt: {
      artifact: "sources/cp4/xstest-adaptation-source-receipt.json",
      sha256: "cc7bf718dbb18199acbedaa897e8fc92cd1a189d362d9b7f6d827752354d36cf"
    }
  }],
  ["xstest-safe-target-destroy-fixtures-tier-c-012", {
    id: "XSTest@d7bb5bd738c1fcbc36edd83d5e7d1b71a3e2d84d:prompt:104",
    source_receipt: {
      artifact: "sources/cp4/xstest-adaptation-source-receipt.json",
      sha256: "cc7bf718dbb18199acbedaa897e8fc92cd1a189d362d9b7f6d827752354d36cf"
    }
  }]
]);

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function compareCodePointStrings(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function sortedStrings(values) {
  return [...values].sort(compareCodePointStrings);
}

function assertExactKeys(value, keys, location) {
  assert.deepEqual(Object.keys(value), keys, `${location} must have the exact frozen key shape`);
}

function pointerValue(value, pointer) {
  return pointer.split("/").slice(1).reduce((current, token) => {
    assert.notEqual(current, undefined, `${pointer} must resolve`);
    return current[token.replaceAll("~1", "/").replaceAll("~0", "~")];
  }, value);
}

function resolveConfinedRegularFile(artifact, expectedSha256) {
  assert.equal(typeof artifact, "string");
  assert.ok(artifact.length > 0);
  assert.equal(path.isAbsolute(artifact), false, `${artifact} must be repository-relative`);
  assert.equal(artifact.split(/[\\/]/u).includes(".."), false, `${artifact} must not traverse parents`);
  const filePath = path.resolve(ROOT, artifact);
  assert.equal(fs.lstatSync(filePath).isFile(), true, `${artifact} must be a regular file, not a link or directory`);
  const relativeRealPath = path.relative(ROOT_REALPATH, fs.realpathSync(filePath));
  assert.ok(relativeRealPath.length > 0, `${artifact} must resolve below the repository root`);
  assert.equal(relativeRealPath.startsWith(`..${path.sep}`), false, `${artifact} escapes the repository root`);
  assert.notEqual(relativeRealPath, "..", `${artifact} escapes the repository root`);
  if (expectedSha256 !== undefined) assert.equal(sha256(filePath), expectedSha256);
  return filePath;
}

function resolveReceipt(receipt) {
  assertExactKeys(receipt, ["artifact", "sha256"], "source receipt");
  return resolveConfinedRegularFile(receipt.artifact, receipt.sha256);
}

function joinedRecertification() {
  const joined = structuredClone(RECERTIFICATION);
  const byId = new Map(joined.records.map((record) => [record.scenario_id, record]));
  for (const candidate of DRAFT.claims_by_scenario) {
    assert.ok(byId.has(candidate.scenario_id));
    byId.get(candidate.scenario_id).dependency_claims = structuredClone(candidate.dependency_claims);
  }
  return joined;
}

test("dependency drafts have exact canonical bytes, shapes, coverage, and confined receipts", () => {
  const draftBytes = fs.readFileSync(DRAFT_PATH);
  const pairReceiptBytes = fs.readFileSync(PAIR_RECEIPT_PATH);
  assert.equal(draftBytes.toString("utf8"), `${JSON.stringify(DRAFT, null, 2)}\n`);
  assert.equal(pairReceiptBytes.toString("utf8"), `${JSON.stringify(PAIR_RECEIPT, null, 2)}\n`);
  assert.equal(sha256Bytes(draftBytes), DRAFT_SHA256);
  assert.equal(sha256Bytes(pairReceiptBytes), PAIR_RECEIPT_SHA256);

  assertExactKeys(DRAFT, [
    "schema_version",
    "status",
    "scientific_limit",
    "corpus_id_set_sha256",
    "dependency_spec",
    "pair_source_receipt",
    "claims_by_scenario",
    "candidate_output",
    "unresolved_mirror_scenario_ids",
    "generating_template_lineage_review",
    "owner_decisions_required",
    "signature_envelope"
  ], "dependency draft");
  assertExactKeys(PAIR_RECEIPT, [
    "schema_version",
    "status",
    "scientific_limit",
    "pairs",
    "signature_envelope"
  ], "pair receipt draft");
  assert.equal(DRAFT.status, "draft_pending_owner_recertification");
  assert.equal(DRAFT.signature_envelope, null);
  assert.equal(PAIR_RECEIPT.status, "draft_pending_owner_recertification");
  assert.equal(PAIR_RECEIPT.signature_envelope, null);
  assert.equal(DRAFT.candidate_output.production_status, "blocked_pending_owner_recertification");
  assertExactKeys(DEPENDENCY_SPEC.ledger, [
    "status",
    "recertified_at",
    "scenario_ids",
    "edges",
    "components",
    "signature_envelope"
  ], "pending dependency ledger");
  assert.equal(DEPENDENCY_SPEC.ledger.status, "pending_cp4_recertification");
  assert.equal(DEPENDENCY_SPEC.ledger.recertified_at, null);
  assert.equal(DEPENDENCY_SPEC.ledger.signature_envelope, null);
  assert.equal(DEPENDENCY_SPEC.ledger.scenario_ids, null);
  assert.equal(DEPENDENCY_SPEC.ledger.edges, null);
  assert.equal(DEPENDENCY_SPEC.ledger.components, null);
  assert.equal(DRAFT.corpus_id_set_sha256, DEPENDENCY_SPEC.corpus_id_set_sha256);
  assert.deepEqual(DRAFT.pair_source_receipt, {
    artifact: PAIR_RECEIPT_ARTIFACT,
    sha256: PAIR_RECEIPT_SHA256
  });
  resolveReceipt(DRAFT.dependency_spec);
  resolveReceipt(DRAFT.pair_source_receipt);

  assert.equal(DRAFT.claims_by_scenario.length, 11);
  assert.deepEqual(DRAFT.claims_by_scenario.map((candidate) => candidate.scenario_id), CLAIM_SCENARIO_IDS);
  for (const candidate of DRAFT.claims_by_scenario) {
    assertExactKeys(candidate, ["scenario_id", "dependency_claims"], `claim record ${candidate.scenario_id}`);
    assertExactKeys(candidate.dependency_claims, KINDS, `dependency claims ${candidate.scenario_id}`);
    for (const kind of KINDS) {
      for (const claim of candidate.dependency_claims[kind]) {
        assertExactKeys(claim, ["id", "source_receipt"], `${candidate.scenario_id}.${kind} claim`);
        resolveReceipt(claim.source_receipt);
      }
    }
  }
});

test("three proposed incident pairs bind exact IDs, members, row bytes, and claims", () => {
  assert.equal(PAIR_RECEIPT.pairs.length, EXPECTED_PAIRS.size);
  const pairIds = PAIR_RECEIPT.pairs.map((pair) => pair.pair_id);
  assert.equal(new Set(pairIds).size, EXPECTED_PAIRS.size);
  assert.deepEqual(sortedStrings(pairIds), sortedStrings(EXPECTED_PAIRS.keys()));

  for (const pair of PAIR_RECEIPT.pairs) {
    assertExactKeys(pair, ["pair_id", "members", "owner_decision_required"], `pair ${pair.pair_id}`);
    assert.ok(EXPECTED_PAIRS.has(pair.pair_id));
    const expectedMembers = EXPECTED_PAIRS.get(pair.pair_id);
    assert.equal(pair.members.length, 2);
    assert.deepEqual(pair.members.map((member) => member.scenario_id), expectedMembers);
    assert.equal(new Set(expectedMembers).size, 2);
    for (const member of pair.members) {
      assertExactKeys(member, [
        "scenario_id",
        "artifact",
        "sha256",
        "authored_basis_pointer",
        "authored_basis_value"
      ], `${pair.pair_id} member ${member.scenario_id}`);
      assert.equal(member.artifact, `${SCENARIO_PREFIX}${member.scenario_id}.json`);
      const artifactPath = resolveConfinedRegularFile(member.artifact, member.sha256);
      const row = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      assert.equal(row.id, member.scenario_id);
      const authored = pointerValue(row, member.authored_basis_pointer);
      if (member.authored_basis_pointer === "/source_basis") {
        assert.ok(authored.startsWith(member.authored_basis_value));
      } else {
        assert.equal(authored, member.authored_basis_value);
      }
    }
  }

  const claimMembersByPair = new Map();
  for (const candidate of DRAFT.claims_by_scenario) {
    for (const claim of candidate.dependency_claims.recertified_pair_or_mirror_id) {
      assert.deepEqual(claim.source_receipt, DRAFT.pair_source_receipt);
      if (!claimMembersByPair.has(claim.id)) claimMembersByPair.set(claim.id, []);
      claimMembersByPair.get(claim.id).push(candidate.scenario_id);
    }
  }
  assert.deepEqual(sortedStrings(claimMembersByPair.keys()), sortedStrings(EXPECTED_PAIRS.keys()));
  for (const [pairId, expectedMembers] of EXPECTED_PAIRS) {
    assert.deepEqual(sortedStrings(claimMembersByPair.get(pairId)), expectedMembers);
    const receiptPair = PAIR_RECEIPT.pairs.find((pair) => pair.pair_id === pairId);
    assert.deepEqual(receiptPair.members.map((member) => member.scenario_id), expectedMembers);
  }
});

test("draft claims deterministically generate the exact receipt-bearing edge set without clearing CP4", () => {
  const candidate = generateCp4DependencyLedger(joinedRecertification(), {
    dependencySpec: DEPENDENCY_SPEC
  });
  const expectedEdges = [
    {
      left: "bard-jwst-mirror-fact-checked-claim-tier-b-009",
      right: "google-bard-demo-marketing-claim-high-impact-020",
      kind: "recertified_pair_or_mirror_id",
      source_receipt: DRAFT.pair_source_receipt
    },
    {
      left: "horizon-mirror-reconciled-adjustment-tier-b-011",
      right: "horizon-shortfall-prosecution-recommend-high-impact-003",
      kind: "recertified_pair_or_mirror_id",
      source_receipt: DRAFT.pair_source_receipt
    },
    {
      left: "robodebt-income-averaging-debt-notice-high-impact-004",
      right: "robodebt-mirror-eligible-notice-tier-b-010",
      kind: "recertified_pair_or_mirror_id",
      source_receipt: DRAFT.pair_source_receipt
    }
  ];
  assert.equal(candidate.scenario_ids.length, 106);
  assert.equal(candidate.edges.length, DRAFT.candidate_output.edge_count);
  assert.equal(candidate.components.length, DRAFT.candidate_output.component_count);
  assert.deepEqual(candidate.edges, expectedEdges);
  assert.equal(DEPENDENCY_SPEC.ledger.scenario_ids, null);
  assert.equal(DEPENDENCY_SPEC.ledger.edges, null);
  assert.equal(DEPENDENCY_SPEC.ledger.components, null);
});

test("five adaptation claims and receipts are exact; template claims are derived as zero", () => {
  const actualUpstreamClaims = [];
  for (const candidate of DRAFT.claims_by_scenario) {
    const claims = candidate.dependency_claims.immutable_upstream_source_example_id;
    const expected = EXPECTED_UPSTREAM_CLAIMS.get(candidate.scenario_id);
    assert.deepEqual(claims, expected === undefined ? [] : [expected]);
    actualUpstreamClaims.push(...claims.map((claim) => ({
      scenarioId: candidate.scenario_id,
      claim
    })));
  }
  assert.equal(actualUpstreamClaims.length, 5);
  assert.equal(new Set(actualUpstreamClaims.map(({ claim }) => claim.id)).size, 5);

  const wrapperReceipts = [
    {
      artifact: "sources/cp4/or-bench-adaptation-source-receipt.json",
      sha256: "6ad2305b4788029cff1dd6d733a29beec3988e1d273dfbf4c2b60484e2a8f514"
    },
    {
      artifact: "sources/cp4/xstest-adaptation-source-receipt.json",
      sha256: "cc7bf718dbb18199acbedaa897e8fc92cd1a189d362d9b7f6d827752354d36cf"
    }
  ];
  const wrapperDerivedClaims = new Map();
  for (const sourceReceipt of wrapperReceipts) {
    const wrapperPath = resolveReceipt(sourceReceipt);
    const wrapper = JSON.parse(fs.readFileSync(wrapperPath, "utf8"));
    for (const mapping of wrapper.mappings) {
      assert.equal(wrapperDerivedClaims.has(mapping.local_scenario_id), false);
      const upstreamExampleId = wrapper.upstream.dataset_name === "XSTest"
        ? `prompt:${mapping.upstream_source_example_or_prompt_id}`
        : mapping.upstream_source_example_or_prompt_id;
      wrapperDerivedClaims.set(mapping.local_scenario_id, {
        id: `${wrapper.upstream.dataset_name}@${wrapper.upstream.immutable_revision}:${upstreamExampleId}`,
        source_receipt: sourceReceipt
      });
    }
  }
  assert.equal(wrapperDerivedClaims.size, 5);
  assert.deepEqual(
    [...wrapperDerivedClaims.entries()].sort(([left], [right]) => compareCodePointStrings(left, right)),
    [...EXPECTED_UPSTREAM_CLAIMS.entries()].sort(([left], [right]) => compareCodePointStrings(left, right))
  );

  const templateClaims = DRAFT.claims_by_scenario.flatMap(
    (candidate) => candidate.dependency_claims.generating_template_lineage_id
  );
  assert.equal(templateClaims.length, 0);
  assert.equal(DRAFT.generating_template_lineage_review.activated_claim_count, templateClaims.length);
  assert.equal(DRAFT.generating_template_lineage_review.status, "blocked_missing_exact_lineage_receipts");

  const allMirrorIds = fs.readdirSync(CORPUS)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_") && name.includes("-mirror-"))
    .map((name) => name.slice(0, -5))
    .sort(compareCodePointStrings);
  const proposedMirrorIds = PAIR_RECEIPT.pairs.flatMap((pair) => pair.members.map((member) => member.scenario_id))
    .filter((scenarioId) => scenarioId.includes("-mirror-"));
  const covered = [...DRAFT.unresolved_mirror_scenario_ids, ...proposedMirrorIds].sort(compareCodePointStrings);
  assert.deepEqual(covered, allMirrorIds);
});
