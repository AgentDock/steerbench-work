// Checkpoint-4 red-fixture publication and pending-state regressions.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "integrity-audit/v2-audit/cp4-red-fixtures.mjs");
const RECEIPT = path.join(ROOT, "integrity-audit/v2-audit/cp4-red-fixture-receipt.json");
const MATRIX = path.join(ROOT, "integrity-audit/v2-audit/RED_TEST_MATRIX.cp4.json");
const BLOCKED_STATUS = "CP4_BLOCKED_PENDING_OWNER_RECERTIFICATION";
const EXPECTED_SUBTEST_IDS = [
  "cp4-corpus-count",
  "cp4-corpus-order",
  "cp4-corpus-id",
  "cp4-committed-artifact-binding",
  "cp4-authority-cohort-omission",
  "cp4-authority-cohort-addition",
  "cp4-adaptation-cohort-omission",
  "cp4-adaptation-cohort-addition",
  "cp4-provisional-cohort-omission",
  "cp4-provisional-cohort-addition",
  "cp4-missing-plan-field",
  "cp4-receipt-absolute",
  "cp4-receipt-traversal",
  "cp4-receipt-symlink",
  "cp4-receipt-hash",
  "cp4-pending-signature",
  "cp4-owner-envelope-missing",
  "cp4-owner-envelope-stale",
  "cp4-owner-envelope-invalid-utc",
  "cp4-action-continue",
  "cp4-action-proceed",
  "cp4-action-block",
  "cp4-action-request-approval",
  "cp4-action-escalate",
  "cp4-action-ask-clarification",
  "cp4-action-unknown",
  "cp4-dependency-missing",
  "cp4-dependency-broad",
  "cp4-dependency-receipt-mismatch",
  "cp4-dependency-clique",
  "cp4-dependency-omitted-edge",
  "cp4-dependency-invented-edge",
  "cp4-dependency-component-drift",
  "cp4-adaptation-dataset",
  "cp4-adaptation-revision",
  "cp4-adaptation-upstream-hash",
  "cp4-adaptation-local-mapping",
  "cp4-adaptation-upstream-id",
  "cp4-adaptation-license",
  "cp4-historical-coordinated-tamper",
  "cp4-pending-owner-blocks",
  "cp4-pending-dependency-blocks"
];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function currentCorpusTreeBinding() {
  const corpus = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
  const entries = fs.readdirSync(corpus)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .sort()
    .map((filename) => ({
      filename,
      raw_sha256: sha256(fs.readFileSync(path.join(corpus, filename)))
    }));
  return {
    algorithm: "sha256(JSON.stringify(sorted[{filename,raw_sha256}]))",
    file_count: entries.length,
    sorted_filename_raw_sha256_manifest: sha256(JSON.stringify(entries))
  };
}

test("CP4 receipt and matrix bind every required isolated red subtest", () => {
  const receiptBytes = fs.readFileSync(RECEIPT);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const matrix = readJson(MATRIX);
  const receiptHash = sha256(receiptBytes);

  assert.equal(receipt.checkpoint, 4);
  assert.equal(receipt.status, BLOCKED_STATUS);
  assert.equal(receipt.production_v2, null);
  assert.equal(receipt.required_subtest_count, EXPECTED_SUBTEST_IDS.length);
  assert.equal(receipt.all_required_subtests_executed, true);
  assert.equal(receipt.all_bad_fixtures_exited_nonzero_before_replacement, true);
  assert.equal(receipt.all_corrected_fixtures_passed, true);
  for (const [relative, expected] of Object.entries(receipt.audit_source_hashes)) {
    assert.equal(
      sha256(fs.readFileSync(path.join(ROOT, relative))),
      expected,
      `${relative} drifted from the receipt`
    );
  }
  assert.deepEqual(
    receipt.executions.map((row) => row.subtest_id),
    EXPECTED_SUBTEST_IDS
  );
  assert.equal(new Set(EXPECTED_SUBTEST_IDS).size, EXPECTED_SUBTEST_IDS.length);
  for (const execution of receipt.executions) {
    assert.equal(execution.owning_checkpoint, 4);
    assert.equal(execution.bad_exit_nonzero, true);
    assert.equal(execution.corrected_exit_zero, true);
  }

  assert.equal(matrix.checkpoint, 4);
  assert.equal(matrix.status, BLOCKED_STATUS);
  assert.equal(matrix.production_v2, null);
  assert.equal(matrix.receipt_sha256, receiptHash);
  assert.equal(matrix.required_subtest_count, EXPECTED_SUBTEST_IDS.length);
  assert.deepEqual(matrix.rows.map((row) => row.subtest_id), EXPECTED_SUBTEST_IDS);
  assert.equal(matrix.aggregate.unique_subtest_ids, true);
  assert.equal(matrix.aggregate.all_required_subtests_present, true);
  assert.equal(matrix.aggregate.all_bad_fixtures_blocked, true);
  assert.equal(matrix.aggregate.all_corrected_fixtures_passed, true);
  assert.equal(matrix.aggregate.owner_recertification_pending, true);
  assert.equal(matrix.aggregate.dependency_ledger_pending, true);
  for (const row of matrix.rows) {
    assert.equal(row.executed_receipt_sha256, receiptHash);
  }
});

test("CP4 receipt cannot be mistaken for corpus repair or scientific recertification", () => {
  const receipt = readJson(RECEIPT);
  const measurements = receipt.measurements;

  assert.equal(measurements.scientific_status, BLOCKED_STATUS);
  assert.equal(measurements.production_v2, null);
  assert.equal(measurements.scenario_count, 106);
  assert.equal(measurements.scenario_ids_match_current_corpus, true);
  assert.deepEqual(measurements.current_corpus_tree, currentCorpusTreeBinding());
  assert.equal(measurements.owner_recertification_status, "pending_owner_recertification");
  assert.equal(measurements.owner_signature_envelope, null);
  assert.equal(
    measurements.owner_signature_trust_boundary,
    "First-hand owner approval recorded in chat and bound in Git is the trust boundary; the signature envelope is a tamper-evident payload-hash binding, not cryptographic authentication."
  );
  assert.deepEqual(measurements.committed_cp4_artifact, {
    artifact: "CP4_RECERTIFICATION.json",
    sha256: sha256(fs.readFileSync(path.join(ROOT, "CP4_RECERTIFICATION.json"))),
    generator: "scripts/generate-cp4-recertification.mjs",
    generator_byte_identical: true,
    scenario_count: 106,
    signature_envelope: null
  });
  assert.equal(
    receipt.audit_source_hashes["CP4_RECERTIFICATION.json"],
    measurements.committed_cp4_artifact.sha256
  );
  assert.match(
    receipt.audit_source_hashes["scripts/generate-cp4-recertification.mjs"],
    /^[0-9a-f]{64}$/u
  );
  assert.equal(measurements.dependency_ledger_status, "pending_cp4_recertification");
  assert.equal(measurements.dependency_production_v2, null);
  assert.match(measurements.scientific_limit, /No row is claimed repaired/u);
  assert.deepEqual(measurements.exact_reference_actions, [
    "continue",
    "proceed",
    "block",
    "request_approval",
    "escalate",
    "ask_clarification"
  ]);
  assert.deepEqual(measurements.historical_v1_calibration, {
    scope: "historical_in_sample_not_held_out",
    signature_presence_correct: 98,
    literal_tool_call_evidence_ids_correct: 100,
    evidence_count_status_correct: 103,
    evidence_count_status_plus_signature_correct: 106
  });
  for (const source of Object.values(measurements.adaptation_source_receipts)) {
    assert.equal(source.review_status, "pending_owner_review");
    assert.equal(source.signature_envelope, null);
  }
});

test("CP4 harness deterministically reproduces the committed pending receipt and matrix", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-red-publish-"));
  try {
    const temporaryReceipt = path.join(temporaryRoot, "receipt.json");
    const temporaryMatrix = path.join(temporaryRoot, "matrix.json");
    const completed = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SBW_CP4_RECEIPT_PATH: temporaryReceipt,
        SBW_CP4_MATRIX_PATH: temporaryMatrix
      }
    });
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(fs.readFileSync(temporaryReceipt, "utf8"), fs.readFileSync(RECEIPT, "utf8"));
    assert.equal(fs.readFileSync(temporaryMatrix, "utf8"), fs.readFileSync(MATRIX, "utf8"));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a failing isolated bad fixture cannot replace prior receipt or matrix bytes", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-red-sentinel-"));
  try {
    const temporaryReceipt = path.join(temporaryRoot, "receipt.json");
    const temporaryMatrix = path.join(temporaryRoot, "matrix.json");
    const receiptSentinel = "prior receipt must survive\n";
    const matrixSentinel = "prior matrix must survive\n";
    fs.writeFileSync(temporaryReceipt, receiptSentinel);
    fs.writeFileSync(temporaryMatrix, matrixSentinel);
    const failed = spawnSync(process.execPath, [
      SCRIPT,
      "--subtest",
      "cp4-receipt-hash",
      "--variant",
      "bad"
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SBW_CP4_RECEIPT_PATH: temporaryReceipt,
        SBW_CP4_MATRIX_PATH: temporaryMatrix
      }
    });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readFileSync(temporaryReceipt, "utf8"), receiptSentinel);
    assert.equal(fs.readFileSync(temporaryMatrix, "utf8"), matrixSentinel);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
