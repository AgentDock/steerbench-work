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
  "cp4-legacy-rule-receipt-missing",
  "cp4-legacy-rule-receipt-hash",
  "cp4-legacy-authored-receipt-missing",
  "cp4-legacy-authored-receipt-wrong-id",
  "cp4-legacy-authored-receipt-nested-in-row",
  "cp4-legacy-authored-receipt-cross-row",
  "cp4-legacy-authored-receipt-outside-cohort",
  "cp4-legacy-authored-receipt-hash-alias-nested",
  "cp4-legacy-rule-receipt-outside-cohort",
  "cp4-legacy-rule-receipt-nested-in-cohort",
  "cp4-legacy-rule-receipt-hash-alias-nested",
  "cp4-legacy-rule-receipt-count-spoof",
  "cp4-pending-approval-envelope",
  "cp4-approval-envelope-missing",
  "cp4-approval-envelope-stale",
  "cp4-approval-envelope-invalid-utc",
  "cp4-approval-envelope-role",
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
  "cp4-activation-cp4-payload-forgery",
  "cp4-activation-dependency-envelope-missing",
  "cp4-activation-generated-ledger-mismatch",
  "cp4-activation-ledger-digest-mismatch",
  "cp4-activation-dependency-role",
  "cp4-activation-timestamp-invalid",
  "cp4-activation-timestamp-inconsistent",
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

const EXPECTED_AUDIT_SOURCES = [
  "CP4_RECERTIFICATION.json",
  "CP4_RECERTIFICATION_SCHEMA.json",
  "EVIDENCE_RENDER_SCHEMA.json",
  "HISTORICAL_V1_SHORTCUT_ROWS.json",
  "LEGACY_MIGRATION_RULE.json",
  "SHORTCUT_DEPENDENCY_SPEC.json",
  "SHORTCUT_FEATURE_SPEC.json",
  "VALIDATION_PLAN.md",
  "integrity-audit/v2-audit/LEGACY_MIGRATION_RULE_DESIGN.md",
  "integrity-audit/v2-audit/cp4-red-fixtures.mjs",
  "results/v2026-05/release-manifest.json",
  "scenario-sets/steerbench-work-2026-05/air-canada-bereavement-policy-promise-realworld-010.json",
  "scenario-sets/steerbench-work-2026-05/calendar-invite-prompt-injection-004.json",
  "scenario-sets/steerbench-work-2026-05/deposition-statute-of-limitations-003.json",
  "scenario-sets/steerbench-work-2026-05/dpd-chatbot-open-persona-realworld-011.json",
  "scenario-sets/steerbench-work-2026-05/executive-impersonation-wire-fraud-005.json",
  "scenario-sets/steerbench-work-2026-05/knight-capital-trading-deploy-realworld-007.json",
  "scenario-sets/steerbench-work-2026-05/mata-avianca-fabricated-citation-realworld-008.json",
  "scenario-sets/steerbench-work-2026-05/patient-records-employer-disclosure-002.json",
  "scenario-sets/steerbench-work-2026-05/replit-production-freeze-violation-realworld-006.json",
  "scenario-sets/steerbench-work-2026-05/telehealth-marketing-pixel-disclosure-001.json",
  "scenario-sets/steerbench-work-2026-05/workday-applicant-auto-reject-realworld-009.json",
  "scripts/generate-cp4-legacy-migration-rule.mjs",
  "scripts/generate-cp4-recertification.mjs",
  "sources/cp4/or-bench-adaptation-source-receipt.json",
  "sources/cp4/xstest-adaptation-source-receipt.json",
  "src/cp4-dependency-ledger.mjs",
  "src/cp4-legacy-migration-rule.mjs",
  "src/cp4-recertification.mjs",
  "src/shortcut-gate.mjs",
  "test/cp4-activation-fixture.mjs"
].sort();

const ACTIVATION_BOUNDARY_CASES = [
  [
    "cp4-activation-cp4-payload-forgery",
    /artifact\.signature_envelope\.payload_sha256 does not bind the canonical payload/u
  ],
  [
    "cp4-activation-dependency-envelope-missing",
    /committed dependency ledger\.signature_envelope must be an object/u
  ],
  [
    "cp4-activation-generated-ledger-mismatch",
    /committed dependency edge bytes differ from generated bytes/u
  ],
  [
    "cp4-activation-ledger-digest-mismatch",
    /dependency ledger envelope does not bind its canonical payload/u
  ],
  [
    "cp4-activation-dependency-role",
    /dependency ledger\.signature_envelope\.role must equal scientific_owner/u
  ],
  [
    "cp4-activation-timestamp-invalid",
    /dependency ledger\.signature_envelope\.approved_at is not a real UTC timestamp/u
  ],
  [
    "cp4-activation-timestamp-inconsistent",
    /dependency ledger\.recertified_at must equal its envelope approved_at/u
  ]
];

const CP4_APPROVAL_BOUNDARY_CASES = [
  [
    "cp4-pending-approval-envelope",
    /pending artifacts must have a null signature_envelope/u
  ],
  [
    "cp4-approval-envelope-missing",
    /artifact\.signature_envelope is required for owner_recertified status/u
  ],
  [
    "cp4-approval-envelope-stale",
    /artifact\.signature_envelope\.payload_sha256 does not bind the canonical payload/u
  ],
  [
    "cp4-approval-envelope-invalid-utc",
    /artifact\.signature_envelope\.approved_at is not a real UTC timestamp/u
  ],
  [
    "cp4-approval-envelope-role",
    /artifact\.signature_envelope\.role must equal scientific_owner/u
  ]
];

const LEGACY_RECEIPT_BOUNDARY_CASES = [
  [
    "cp4-legacy-rule-receipt-missing",
    /must contain the exact LEGACY_MIGRATION_RULE\.json receipt/u
  ],
  [
    "cp4-legacy-rule-receipt-hash",
    /SHA-256 mismatch for "LEGACY_MIGRATION_RULE\.json"/u
  ],
  [
    "cp4-legacy-authored-receipt-missing",
    /must contain the exact authored-row receipt for/u
  ],
  [
    "cp4-legacy-authored-receipt-wrong-id",
    /must not contain reserved authored-row receipt for .* outside its matching legacy cohort record/u
  ],
  [
    "cp4-legacy-authored-receipt-nested-in-row",
    /matching legacy cohort record permits it only in top-level source_receipts/u
  ],
  [
    "cp4-legacy-authored-receipt-cross-row",
    /must not contain reserved authored-row receipt for .* outside its matching legacy cohort record/u
  ],
  [
    "cp4-legacy-authored-receipt-outside-cohort",
    /must not contain reserved authored-row receipt for .* outside its matching legacy cohort record/u
  ],
  [
    "cp4-legacy-authored-receipt-hash-alias-nested",
    /reserved authored-row receipt must use its canonical scenario artifact/u
  ],
  [
    "cp4-legacy-rule-receipt-outside-cohort",
    /must not contain LEGACY_MIGRATION_RULE\.json outside the exact legacy cohort/u
  ],
  [
    "cp4-legacy-rule-receipt-nested-in-cohort",
    /legacy cohort records permit it only in top-level source_receipts/u
  ],
  [
    "cp4-legacy-rule-receipt-hash-alias-nested",
    /reserved legacy rule receipt must use canonical artifact LEGACY_MIGRATION_RULE\.json/u
  ],
  [
    "cp4-legacy-rule-receipt-count-spoof",
    /must contain the exact LEGACY_MIGRATION_RULE\.json receipt/u
  ]
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

test("activation fixtures fail at seven distinct production validation boundaries", () => {
  for (const [subtestId, expectedError] of ACTIVATION_BOUNDARY_CASES) {
    const bad = spawnSync(process.execPath, [
      SCRIPT,
      "--subtest",
      subtestId,
      "--variant",
      "bad"
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(bad.status, 0, `${subtestId} known-bad fixture exited zero`);
    assert.match(bad.stderr, expectedError, `${subtestId} failed at the wrong boundary`);

    const corrected = spawnSync(process.execPath, [
      SCRIPT,
      "--subtest",
      subtestId,
      "--variant",
      "corrected"
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(corrected.status, 0, `${subtestId}: ${corrected.stderr}`);
  }
});

test("CP4 approval-envelope fixtures fail at exact production validation boundaries", () => {
  for (const [subtestId, expectedError] of CP4_APPROVAL_BOUNDARY_CASES) {
    const bad = spawnSync(process.execPath, [
      SCRIPT,
      "--subtest",
      subtestId,
      "--variant",
      "bad"
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(bad.status, 0, `${subtestId} known-bad fixture exited zero`);
    assert.match(bad.stderr, expectedError, `${subtestId} failed at the wrong boundary`);

    const corrected = spawnSync(process.execPath, [
      SCRIPT,
      "--subtest",
      subtestId,
      "--variant",
      "corrected"
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(corrected.status, 0, `${subtestId}: ${corrected.stderr}`);
  }
});

test("legacy migration receipt fixtures fail at exact production validation boundaries", () => {
  for (const [subtestId, expectedError] of LEGACY_RECEIPT_BOUNDARY_CASES) {
    const bad = spawnSync(process.execPath, [
      SCRIPT,
      "--subtest",
      subtestId,
      "--variant",
      "bad"
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(bad.status, 0, `${subtestId} known-bad fixture exited zero`);
    assert.match(bad.stderr, expectedError, `${subtestId} failed at the wrong boundary`);

    const corrected = spawnSync(process.execPath, [
      SCRIPT,
      "--subtest",
      subtestId,
      "--variant",
      "corrected"
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(corrected.status, 0, `${subtestId}: ${corrected.stderr}`);
  }
});

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
  assert.deepEqual(Object.keys(receipt.audit_source_hashes), EXPECTED_AUDIT_SOURCES);
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
  assert.equal(measurements.approval_envelope, null);
  assert.equal(
    measurements.approval_envelope_semantics,
    "Neutral role, strict UTC timestamp, and payload digest; no identity or cryptographic-authentication claim."
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
