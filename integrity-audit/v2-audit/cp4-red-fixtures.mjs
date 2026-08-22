#!/usr/bin/env node
// Checkpoint-4 executable red fixtures and deterministic pending-state receipt.
//
// Every known-bad fixture runs in a separate child process and must exit
// nonzero. Every synthetic corrected fixture also runs in its own child and
// must exit zero. The receipt and matrix are replaced only after all children
// satisfy that contract. This harness never claims that the corpus has been
// repaired or owner-recertified.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADAPTATION_RECORDS,
  AUTHORITY_RECORD_IDS,
  EXPECTED_SCENARIO_IDS,
  OWNER_ATTESTATION,
  OWNER_RECERTIFIED,
  PENDING_OWNER_RECERTIFICATION,
  PROVISIONAL_RECORDS,
  REFERENCE_DECISIONS,
  SCENARIO_IDS_SHA256,
  canonicalizeCp4Recertification,
  cp4PayloadSha256,
  createPendingCp4Recertification,
  validateCp4Recertification
} from "../../src/cp4-recertification.mjs";
import {
  assertDependencyLedgerMatches,
  generateCp4DependencyLedger
} from "../../src/cp4-dependency-ledger.mjs";
import {
  generateCp4RecertificationArtifact
} from "../../scripts/generate-cp4-recertification.mjs";
import {
  calibrateHistoricalV1InSample,
  typedCanonicalKey
} from "../../src/shortcut-gate.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RECEIPT_PATH = process.env.SBW_CP4_RECEIPT_PATH
  ? path.resolve(process.env.SBW_CP4_RECEIPT_PATH)
  : fileURLToPath(new URL("./cp4-red-fixture-receipt.json", import.meta.url));
const MATRIX_PATH = process.env.SBW_CP4_MATRIX_PATH
  ? path.resolve(process.env.SBW_CP4_MATRIX_PATH)
  : fileURLToPath(new URL("./RED_TEST_MATRIX.cp4.json", import.meta.url));
const DEPENDENCY_SPEC_PATH = path.join(ROOT, "SHORTCUT_DEPENDENCY_SPEC.json");
const FEATURE_SPEC_PATH = path.join(ROOT, "SHORTCUT_FEATURE_SPEC.json");
const HISTORICAL_ROWS_PATH = path.join(ROOT, "HISTORICAL_V1_SHORTCUT_ROWS.json");
const COMMITTED_CP4_PATH = path.join(ROOT, "CP4_RECERTIFICATION.json");
const RELEASE_MANIFEST_PATH = path.join(ROOT, "results/v2026-05/release-manifest.json");
const SET_PATH = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const DEPENDENCY_SPEC = JSON.parse(fs.readFileSync(DEPENDENCY_SPEC_PATH, "utf8"));
const FEATURE_SPEC = JSON.parse(fs.readFileSync(FEATURE_SPEC_PATH, "utf8"));
const HISTORICAL_ROWS = JSON.parse(fs.readFileSync(HISTORICAL_ROWS_PATH, "utf8"));
const RELEASE_MANIFEST_BYTES = fs.readFileSync(RELEASE_MANIFEST_PATH);
const RELEASE_MANIFEST = JSON.parse(RELEASE_MANIFEST_BYTES.toString("utf8"));
const DIGEST = "a".repeat(64);
const BLOCKED_STATUS = "CP4_BLOCKED_PENDING_OWNER_RECERTIFICATION";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stableBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

const SUBTESTS = [
  ["cp4-corpus-count", 5, "exact 106-row count"],
  ["cp4-corpus-order", 5, "exact sorted scenario order"],
  ["cp4-corpus-id", 5, "exact frozen scenario IDs"],
  ["cp4-committed-artifact-binding", 5, "committed pending artifact and generator byte binding"],
  ["cp4-authority-cohort-omission", 11, "authority cohort omission"],
  ["cp4-authority-cohort-addition", 11, "authority cohort addition"],
  ["cp4-adaptation-cohort-omission", 15, "adaptation cohort omission"],
  ["cp4-adaptation-cohort-addition", 15, "adaptation cohort addition"],
  ["cp4-provisional-cohort-omission", 4, "provisional cohort omission"],
  ["cp4-provisional-cohort-addition", 4, "provisional cohort addition"],
  ["cp4-missing-plan-field", 5, "missing recertification plan field"],
  ["cp4-receipt-absolute", 3, "absolute source receipt path"],
  ["cp4-receipt-traversal", 3, "traversing source receipt path"],
  ["cp4-receipt-symlink", 3, "symlink source receipt path"],
  ["cp4-receipt-hash", 3, "source receipt raw-byte hash"],
  ["cp4-pending-signature", 5, "signature forbidden while pending"],
  ["cp4-owner-envelope-missing", 5, "owner envelope required when complete"],
  ["cp4-owner-envelope-stale", 5, "owner envelope binds current payload"],
  ["cp4-owner-envelope-invalid-utc", 5, "owner envelope strict UTC timestamp"],
  ...REFERENCE_DECISIONS.map((decision) => [
    `cp4-action-${decision.replaceAll("_", "-")}`,
    7,
    `exact reference action ${decision}`
  ]),
  ["cp4-action-unknown", 7, "unknown reference action"],
  ["cp4-dependency-missing", 12, "missing dependency claims"],
  ["cp4-dependency-broad", 12, "forbidden broad dependency source"],
  ["cp4-dependency-receipt-mismatch", 12, "shared dependency receipt mismatch"],
  ["cp4-dependency-clique", 12, "dependency clique expansion"],
  ["cp4-dependency-omitted-edge", 12, "omitted dependency edge"],
  ["cp4-dependency-invented-edge", 12, "invented dependency edge"],
  ["cp4-dependency-component-drift", 12, "dependency component drift"],
  ["cp4-adaptation-dataset", 15, "adaptation dataset binding"],
  ["cp4-adaptation-revision", 15, "adaptation immutable revision binding"],
  ["cp4-adaptation-upstream-hash", 15, "adaptation upstream artifact hash binding"],
  ["cp4-adaptation-local-mapping", 15, "adaptation local scenario mapping"],
  ["cp4-adaptation-upstream-id", 15, "adaptation upstream example ID binding"],
  ["cp4-adaptation-license", 15, "adaptation license binding"],
  ["cp4-historical-coordinated-tamper", 12, "historical coordinated projection tamper"],
  ["cp4-pending-owner-blocks", 5, "pending owner state stays blocking"],
  ["cp4-pending-dependency-blocks", 12, "pending dependency state stays blocking"]
].map(([subtest_id, finding_id, label]) => ({ subtest_id, finding_id, label }));

assert.equal(new Set(SUBTESTS.map((row) => row.subtest_id)).size, SUBTESTS.length);

function receiptFor(artifact, repositoryRoot = ROOT) {
  return {
    artifact,
    sha256: sha256(fs.readFileSync(path.join(repositoryRoot, artifact)))
  };
}

function signSyntheticArtifact(artifact) {
  artifact.signature_envelope = {
    owner_id: "synthetic-red-fixture-owner",
    signed_at: "2026-08-21T12:34:56Z",
    payload_sha256: cp4PayloadSha256(artifact),
    attestation: OWNER_ATTESTATION,
    signature: "synthetic-red-fixture-opaque-attestation"
  };
  return artifact;
}

function completeSyntheticArtifact(receipt = receiptFor("VALIDATION_PLAN.md")) {
  const artifact = createPendingCp4Recertification();
  artifact.status = OWNER_RECERTIFIED;
  for (const record of artifact.records) {
    record.source_receipts = [receipt];
    record.proposed_action = {
      actor: "synthetic_worker",
      principal: null,
      operation: "perform the exact synthetic operation",
      target: "the exact synthetic target",
      scope: "the exact synthetic scope"
    };
    record.ordinary_authority = {
      status: "established",
      rationale: "Synthetic mechanics-only authority basis.",
      source_receipts: [receipt]
    };
    record.exceptional_authority = {
      status: "not_applicable",
      rationale: "Exceptional authority is not used by this synthetic fixture.",
      source_receipts: []
    };
    record.model_visible_evidence = {
      evidence_ids: [],
      facts: ["Synthetic mechanics-only evidence fact."],
      absence_rationale: null,
      source_receipts: [receipt]
    };
    record.warning_basis = {
      warnings: [],
      rationale: "No warning is asserted by this synthetic fixture.",
      source_receipts: []
    };
    record.reference_decision = "continue";
    record.reference_rationale = "Synthetic mechanics-only reference rationale.";
    record.prompt_reference_review = {
      reviewed_prompt_sha256: receipt.sha256,
      prompt_decision_consistent: true,
      contradictions: [],
      rationale: "Synthetic prompt/reference mechanics review.",
      source_receipts: [receipt]
    };
    if (record.authority_review !== null) {
      Object.assign(record.authority_review, {
        grantor: "synthetic grantor",
        authorized_actor: "synthetic_worker",
        authorized_role: "synthetic operator",
        exact_action: "perform the exact synthetic operation",
        target: "the exact synthetic target",
        scope: "the exact synthetic scope",
        temporal_validity: "valid at the synthetic fixture timestamp",
        legal_authority: "synthetic legal-authority finding",
        operational_delegation: "synthetic action-specific delegation",
        safety_clearance: "synthetic safety-clearance finding",
        supporting_artifact: receipt,
        conclusion: "authority_established",
        rationale: "Synthetic uniform authority-review record."
      });
    }
    if (record.adaptation_license !== null) {
      Object.assign(record.adaptation_license, {
        upstream_dataset: ADAPTATION_RECORDS[record.scenario_id],
        immutable_upstream_revision: "synthetic-immutable-revision",
        upstream_source_example_or_prompt_id: "synthetic-upstream-id",
        upstream_artifact_sha256: receipt.sha256,
        transformation: {
          what_changed: "Synthetic source transformed into an action-boundary fixture.",
          why: "Exercise adaptation-binding mechanics."
        },
        license: {
          identifier: "synthetic-license",
          redistribution_status: "synthetic review complete",
          compatible: true,
          rationale: "Synthetic license compatibility conclusion."
        },
        source_receipts: [receipt]
      });
      if (record.adaptation_license.official_source_review !== null) {
        Object.assign(record.adaptation_license.official_source_review, {
          court_filed_characterization: "synthetic reviewed characterization",
          sec_filing_access_endpoint: "synthetic SEC endpoint",
          sec_supported_automation_method: "synthetic SEC method",
          delaware_access_rules: "synthetic Delaware access rules",
          delaware_automation_rules: "synthetic Delaware automation rules",
          target_record_existence: "synthetic target-record finding",
          reference_decision: record.reference_decision,
          source_receipts: [receipt]
        });
      }
    }
    if (record.provisional_review !== null) {
      record.provisional_review.source_receipts = [receipt];
      if (record.provisional_review.kind === "heldout_authorization") {
        Object.assign(record.provisional_review, {
          acting_identity: "synthetic acting identity",
          authorized_actor: "synthetic_worker",
          scope: "synthetic held-out scope",
          target: "synthetic held-out target",
          temporal_validity: "synthetic validity interval",
          signature_trust: "synthetic signature-trust finding"
        });
      } else if (record.provisional_review.kind === "evaluation_provenance") {
        Object.assign(record.provisional_review, {
          evaluation_provenance_status: "synthetic suspected provenance",
          contamination_assessment: "synthetic suspected-only assessment",
          numeric_claim_resolution: "synthetic numeric discrepancy resolution"
        });
      } else {
        Object.assign(record.provisional_review, {
          fixture_regeneration_script: "synthetic regeneration receipt",
          exact_diff: "synthetic exact diff",
          row_counts: "synthetic before-and-after counts",
          grader_and_heldout_non_change: "synthetic non-change receipt"
        });
      }
    }
  }
  return signSyntheticArtifact(artifact);
}

function rowById(artifact, scenarioId) {
  return artifact.records.find((record) => record.scenario_id === scenarioId);
}

function wrapperPath(dataset) {
  return dataset === "XSTest"
    ? "sources/cp4/xstest-adaptation-source-receipt.json"
    : "sources/cp4/or-bench-adaptation-source-receipt.json";
}

function frozenWrapper(dataset) {
  const relative = wrapperPath(dataset);
  return {
    relative,
    value: JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8")),
    receipt: receiptFor(relative)
  };
}

function configureAdaptation(artifact, scenarioId, wrapper, sourceReceipt) {
  const record = rowById(artifact, scenarioId);
  const mapping = wrapper.mappings.find((row) => row.local_scenario_id === scenarioId);
  assert.ok(mapping, `missing adaptation mapping for ${scenarioId}`);
  Object.assign(record.adaptation_license, {
    upstream_dataset: wrapper.upstream.dataset_name,
    immutable_upstream_revision: wrapper.upstream.immutable_revision,
    upstream_source_example_or_prompt_id: mapping.upstream_source_example_or_prompt_id,
    upstream_artifact_sha256: wrapper.upstream.source_artifact.sha256,
    source_receipts: [sourceReceipt]
  });
  record.adaptation_license.license.identifier =
    wrapper.upstream.license_evidence.declared_identifier;
}

function completeWithFrozenWrappers() {
  const artifact = completeSyntheticArtifact();
  for (const dataset of ["XSTest", "OR-Bench"]) {
    const frozen = frozenWrapper(dataset);
    for (const [scenarioId, expectedDataset] of Object.entries(ADAPTATION_RECORDS)) {
      if (expectedDataset === dataset) {
        configureAdaptation(artifact, scenarioId, frozen.value, frozen.receipt);
      }
    }
  }
  return signSyntheticArtifact(artifact);
}

function withScratchWrapper(mutate, callback) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-red-wrapper-"));
  try {
    fs.writeFileSync(path.join(temporaryRoot, "base.txt"), "synthetic base receipt\n");
    const baseReceipt = receiptFor("base.txt", temporaryRoot);
    const frozenByDataset = {};
    for (const dataset of ["XSTest", "OR-Bench"]) {
      const frozen = frozenWrapper(dataset).value;
      frozenByDataset[dataset] = frozen;
      const scratch = structuredClone(frozen);
      if (dataset === "XSTest") mutate(scratch);
      const filename = `${dataset.toLowerCase().replaceAll("-", "")}.json`;
      fs.writeFileSync(path.join(temporaryRoot, filename), stableBytes(scratch));
    }
    const artifact = completeSyntheticArtifact(baseReceipt);
    for (const [scenarioId, dataset] of Object.entries(ADAPTATION_RECORDS)) {
      const filename = `${dataset.toLowerCase().replaceAll("-", "")}.json`;
      configureAdaptation(
        artifact,
        scenarioId,
        frozenByDataset[dataset],
        receiptFor(filename, temporaryRoot)
      );
    }
    signSyntheticArtifact(artifact);
    callback(artifact, temporaryRoot);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function emptyDependencyArtifact() {
  return createPendingCp4Recertification();
}

function addDependencyClaim(artifact, scenarioIds, kind, id, receipt) {
  for (const scenarioId of scenarioIds) {
    rowById(artifact, scenarioId).dependency_claims[kind].push({
      id,
      source_receipt: receipt
    });
  }
}

function ownerDependencySpec(candidate) {
  const spec = structuredClone(DEPENDENCY_SPEC);
  spec.ledger = {
    status: "owner_recertified",
    owner_signature: "synthetic-red-fixture-owner",
    recertified_at: "2026-08-21T12:34:56Z",
    scenario_ids: structuredClone(candidate.scenario_ids),
    edges: structuredClone(candidate.edges),
    components: structuredClone(candidate.components)
  };
  return spec;
}

function historicalReleaseBinding() {
  return {
    release_manifest_sha256: sha256(RELEASE_MANIFEST_BYTES),
    scenario_hashes: structuredClone(RELEASE_MANIFEST.scenario_hashes)
  };
}

function currentCorpusTreeBinding() {
  const entries = fs.readdirSync(SET_PATH)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .sort()
    .map((filename) => ({
      filename,
      raw_sha256: sha256(fs.readFileSync(path.join(SET_PATH, filename)))
    }));
  return {
    algorithm: "sha256(JSON.stringify(sorted[{filename,raw_sha256}]))",
    file_count: entries.length,
    sorted_filename_raw_sha256_manifest: sha256(JSON.stringify(entries))
  };
}

function validateCommittedCp4Bytes(bytes) {
  const text = bytes.toString("utf8");
  const parsed = JSON.parse(text);
  const validated = validateCp4Recertification(parsed);
  const generated = generateCp4RecertificationArtifact();
  assert.equal(validated.status, PENDING_OWNER_RECERTIFICATION);
  assert.equal(validated.signature_envelope, null);
  assert.equal(validated.scenario_count, 106);
  assert.deepEqual(
    validated.records.map((record) => record.scenario_id),
    EXPECTED_SCENARIO_IDS
  );
  assert.equal(text, generated.bytes, "committed CP4 candidate must equal generator bytes");
  return validated;
}

function runSubtest(id, variant) {
  const bad = variant === "bad";
  if (["cp4-corpus-count", "cp4-corpus-order", "cp4-corpus-id"].includes(id)) {
    const artifact = createPendingCp4Recertification();
    if (bad && id === "cp4-corpus-count") artifact.records.pop();
    if (bad && id === "cp4-corpus-order") [artifact.records[0], artifact.records[1]] = [artifact.records[1], artifact.records[0]];
    if (bad && id === "cp4-corpus-id") artifact.records[0].scenario_id = "invented-scenario";
    validateCp4Recertification(artifact);
    return;
  }

  if (id === "cp4-committed-artifact-binding") {
    let bytes = fs.readFileSync(COMMITTED_CP4_PATH);
    if (bad) {
      const drifted = JSON.parse(bytes.toString("utf8"));
      drifted.records[0].reference_rationale = "synthetic ungenerated candidate drift";
      bytes = Buffer.from(`${canonicalizeCp4Recertification(drifted)}\n`, "utf8");
    }
    validateCommittedCp4Bytes(bytes);
    return;
  }

  const cohortCases = {
    "cp4-authority-cohort-omission": () => {
      const artifact = createPendingCp4Recertification();
      if (bad) rowById(artifact, AUTHORITY_RECORD_IDS[0]).authority_review = null;
      return artifact;
    },
    "cp4-authority-cohort-addition": () => {
      const artifact = createPendingCp4Recertification();
      if (bad) artifact.records.find((row) => !AUTHORITY_RECORD_IDS.includes(row.scenario_id)).authority_review = {};
      return artifact;
    },
    "cp4-adaptation-cohort-omission": () => {
      const artifact = createPendingCp4Recertification();
      if (bad) rowById(artifact, Object.keys(ADAPTATION_RECORDS)[0]).adaptation_license = null;
      return artifact;
    },
    "cp4-adaptation-cohort-addition": () => {
      const artifact = createPendingCp4Recertification();
      if (bad) artifact.records.find((row) => !Object.hasOwn(ADAPTATION_RECORDS, row.scenario_id)).adaptation_license = {};
      return artifact;
    },
    "cp4-provisional-cohort-omission": () => {
      const artifact = createPendingCp4Recertification();
      if (bad) rowById(artifact, Object.keys(PROVISIONAL_RECORDS)[0]).provisional_review = null;
      return artifact;
    },
    "cp4-provisional-cohort-addition": () => {
      const artifact = createPendingCp4Recertification();
      if (bad) artifact.records.find((row) => !Object.hasOwn(PROVISIONAL_RECORDS, row.scenario_id)).provisional_review = {};
      return artifact;
    }
  };
  if (Object.hasOwn(cohortCases, id)) {
    validateCp4Recertification(cohortCases[id]());
    return;
  }

  if (id === "cp4-missing-plan-field") {
    const artifact = createPendingCp4Recertification();
    if (bad) delete artifact.records[0].warning_basis;
    validateCp4Recertification(artifact);
    return;
  }

  if (["cp4-receipt-absolute", "cp4-receipt-traversal", "cp4-receipt-hash"].includes(id)) {
    const artifact = createPendingCp4Recertification();
    const valid = receiptFor("VALIDATION_PLAN.md");
    if (bad && id === "cp4-receipt-absolute") valid.artifact = path.join(ROOT, "VALIDATION_PLAN.md");
    if (bad && id === "cp4-receipt-traversal") valid.artifact = "../VALIDATION_PLAN.md";
    if (bad && id === "cp4-receipt-hash") valid.sha256 = "0".repeat(64);
    artifact.records[0].source_receipts = [valid];
    validateCp4Recertification(artifact);
    return;
  }

  if (id === "cp4-receipt-symlink") {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-red-receipt-"));
    try {
      fs.writeFileSync(path.join(temporaryRoot, "receipt.bin"), "raw receipt bytes\n");
      fs.symlinkSync("receipt.bin", path.join(temporaryRoot, "receipt-link.bin"));
      const artifact = createPendingCp4Recertification();
      artifact.records[0].source_receipts = [receiptFor(
        bad ? "receipt-link.bin" : "receipt.bin",
        temporaryRoot
      )];
      validateCp4Recertification(artifact, { repositoryRoot: temporaryRoot });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
    return;
  }

  if (id === "cp4-pending-signature") {
    const artifact = createPendingCp4Recertification();
    if (bad) artifact.signature_envelope = {
      owner_id: "not-allowed-while-pending",
      signed_at: "2026-08-21T12:34:56Z",
      payload_sha256: DIGEST,
      attestation: OWNER_ATTESTATION,
      signature: "synthetic"
    };
    validateCp4Recertification(artifact);
    return;
  }

  if (["cp4-owner-envelope-missing", "cp4-owner-envelope-stale", "cp4-owner-envelope-invalid-utc"].includes(id)) {
    const artifact = completeWithFrozenWrappers();
    if (bad && id === "cp4-owner-envelope-missing") artifact.signature_envelope = null;
    if (bad && id === "cp4-owner-envelope-stale") artifact.records[0].reference_rationale += " stale mutation";
    if (bad && id === "cp4-owner-envelope-invalid-utc") artifact.signature_envelope.signed_at = "2026-02-30T12:34:56Z";
    validateCp4Recertification(artifact);
    return;
  }

  if (id.startsWith("cp4-action-") && id !== "cp4-action-unknown") {
    const decision = id.slice("cp4-action-".length).replaceAll("-", "_");
    const artifact = createPendingCp4Recertification();
    artifact.records[0].reference_decision = bad ? `${decision}_unknown` : decision;
    validateCp4Recertification(artifact);
    return;
  }
  if (id === "cp4-action-unknown") {
    const artifact = createPendingCp4Recertification();
    artifact.records[0].reference_decision = bad ? "allow" : REFERENCE_DECISIONS[0];
    validateCp4Recertification(artifact);
    return;
  }

  if ([
    "cp4-dependency-missing",
    "cp4-dependency-broad",
    "cp4-dependency-receipt-mismatch",
    "cp4-dependency-clique",
    "cp4-dependency-omitted-edge",
    "cp4-dependency-invented-edge",
    "cp4-dependency-component-drift"
  ].includes(id)) {
    const artifact = emptyDependencyArtifact();
    const planReceipt = receiptFor("VALIDATION_PLAN.md");
    if (id === "cp4-dependency-missing") {
      if (bad) delete artifact.records[0].dependency_claims;
      generateCp4DependencyLedger(artifact, { dependencySpec: DEPENDENCY_SPEC });
      return;
    }
    if (id === "cp4-dependency-broad") {
      if (bad) artifact.records[0].dependency_claims.topic = [];
      generateCp4DependencyLedger(artifact, { dependencySpec: DEPENDENCY_SPEC });
      return;
    }
    if (id === "cp4-dependency-receipt-mismatch") {
      addDependencyClaim(artifact, [EXPECTED_SCENARIO_IDS[0]], "recertified_pair_or_mirror_id", "shared-pair", planReceipt);
      addDependencyClaim(
        artifact,
        [EXPECTED_SCENARIO_IDS[1]],
        "recertified_pair_or_mirror_id",
        "shared-pair",
        bad ? receiptFor("AUDIT.md") : planReceipt
      );
      generateCp4DependencyLedger(artifact, { dependencySpec: DEPENDENCY_SPEC });
      return;
    }
    if (id === "cp4-dependency-clique") {
      addDependencyClaim(
        artifact,
        EXPECTED_SCENARIO_IDS.slice(0, bad ? 2 : 3),
        "generating_template_lineage_id",
        "three-row-lineage",
        planReceipt
      );
      const candidate = generateCp4DependencyLedger(artifact, { dependencySpec: DEPENDENCY_SPEC });
      assert.equal(candidate.edges.length, 3, "three members must expand to a complete three-edge clique");
      return;
    }
    addDependencyClaim(
      artifact,
      EXPECTED_SCENARIO_IDS.slice(0, 2),
      "recertified_pair_or_mirror_id",
      "pair-one",
      planReceipt
    );
    const generated = generateCp4DependencyLedger(artifact, { dependencySpec: DEPENDENCY_SPEC });
    const committed = ownerDependencySpec(generated);
    if (bad && id === "cp4-dependency-omitted-edge") {
      committed.ledger.edges = [];
      committed.ledger.components = EXPECTED_SCENARIO_IDS.map((scenarioId) => [scenarioId]);
    }
    if (bad && id === "cp4-dependency-invented-edge") {
      const inventedArtifact = emptyDependencyArtifact();
      addDependencyClaim(
        inventedArtifact,
        EXPECTED_SCENARIO_IDS.slice(0, 2),
        "recertified_pair_or_mirror_id",
        "pair-one",
        planReceipt
      );
      addDependencyClaim(
        inventedArtifact,
        EXPECTED_SCENARIO_IDS.slice(2, 4),
        "recertified_pair_or_mirror_id",
        "invented-pair",
        planReceipt
      );
      const invented = generateCp4DependencyLedger(inventedArtifact, { dependencySpec: DEPENDENCY_SPEC });
      committed.ledger.edges = invented.edges;
      committed.ledger.components = invented.components;
    }
    if (bad && id === "cp4-dependency-component-drift") {
      committed.ledger.components = EXPECTED_SCENARIO_IDS.map((scenarioId) => [scenarioId]);
    }
    assertDependencyLedgerMatches(generated, committed);
    return;
  }

  if ([
    "cp4-adaptation-dataset",
    "cp4-adaptation-revision",
    "cp4-adaptation-upstream-hash",
    "cp4-adaptation-upstream-id",
    "cp4-adaptation-license"
  ].includes(id)) {
    const artifact = completeWithFrozenWrappers();
    const record = rowById(artifact, "xstest-homonym-kill-process-tier-c-011");
    if (bad && id === "cp4-adaptation-dataset") record.adaptation_license.upstream_dataset = "OR-Bench";
    if (bad && id === "cp4-adaptation-revision") record.adaptation_license.immutable_upstream_revision = "wrong-revision";
    if (bad && id === "cp4-adaptation-upstream-hash") record.adaptation_license.upstream_artifact_sha256 = "0".repeat(64);
    if (bad && id === "cp4-adaptation-upstream-id") record.adaptation_license.upstream_source_example_or_prompt_id = "wrong-upstream-id";
    if (bad && id === "cp4-adaptation-license") record.adaptation_license.license.identifier = "wrong-license";
    signSyntheticArtifact(artifact);
    validateCp4Recertification(artifact);
    return;
  }

  if (id === "cp4-adaptation-local-mapping") {
    withScratchWrapper(
      (wrapper) => {
        if (bad) wrapper.mappings[0].local_scenario_id = "wrong-local-scenario";
      },
      (artifact, temporaryRoot) => validateCp4Recertification(
        artifact,
        { repositoryRoot: temporaryRoot }
      )
    );
    return;
  }

  if (id === "cp4-historical-coordinated-tamper") {
    const artifact = structuredClone(HISTORICAL_ROWS);
    if (bad) {
      const projectionKeys = [
        "label",
        "evidence_count_status",
        "signature_presence",
        "literal_tool_call_evidence_ids"
      ];
      const first = Object.fromEntries(projectionKeys.map((key) => [key, artifact.rows[0][key]]));
      const second = Object.fromEntries(projectionKeys.map((key) => [key, artifact.rows[1][key]]));
      Object.assign(artifact.rows[0], second);
      Object.assign(artifact.rows[1], first);
      assert.deepEqual(
        artifact.rows.map((row) => typedCanonicalKey(Object.fromEntries(projectionKeys.map((key) => [key, row[key]])))).sort(),
        HISTORICAL_ROWS.rows.map((row) => typedCanonicalKey(Object.fromEntries(projectionKeys.map((key) => [key, row[key]])))).sort()
      );
    }
    calibrateHistoricalV1InSample(artifact, FEATURE_SPEC, historicalReleaseBinding());
    return;
  }

  if (id === "cp4-pending-owner-blocks") {
    const pending = validateCp4Recertification(createPendingCp4Recertification());
    if (bad) assert.equal(pending.status, OWNER_RECERTIFIED, "pending owner state must not be treated as complete");
    assert.equal(pending.status, PENDING_OWNER_RECERTIFICATION);
    assert.equal(pending.signature_envelope, null);
    return;
  }

  if (id === "cp4-pending-dependency-blocks") {
    const generated = generateCp4DependencyLedger(emptyDependencyArtifact(), {
      dependencySpec: DEPENDENCY_SPEC
    });
    if (bad) {
      assertDependencyLedgerMatches(generated, DEPENDENCY_SPEC);
      return;
    }
    assert.equal(DEPENDENCY_SPEC.ledger.status, "pending_cp4_recertification");
    assert.throws(
      () => assertDependencyLedgerMatches(generated, DEPENDENCY_SPEC),
      /committed dependency ledger/
    );
    return;
  }

  throw new Error(`unknown subtest ${id}`);
}

function cp4Measurements() {
  const committedCp4Bytes = fs.readFileSync(COMMITTED_CP4_PATH);
  const pending = validateCommittedCp4Bytes(committedCp4Bytes);
  const corpusFiles = fs.readdirSync(SET_PATH)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .sort();
  const corpusIds = corpusFiles.map((name) => (
    JSON.parse(fs.readFileSync(path.join(SET_PATH, name), "utf8")).id
  )).sort();
  const decisionCounts = {};
  for (const name of corpusFiles) {
    const scenario = JSON.parse(fs.readFileSync(path.join(SET_PATH, name), "utf8"));
    const decision = scenario.expected_behavior?.correct_action;
    decisionCounts[decision] = (decisionCounts[decision] || 0) + 1;
  }
  const adaptationReceipts = Object.fromEntries(["XSTest", "OR-Bench"].map((dataset) => {
    const frozen = frozenWrapper(dataset);
    return [dataset, {
      artifact: frozen.relative,
      sha256: frozen.receipt.sha256,
      review_status: frozen.value.review_status,
      signature_envelope: frozen.value.signature_envelope,
      mapping_count: frozen.value.mappings.length
    }];
  }));
  const historical = calibrateHistoricalV1InSample(
    HISTORICAL_ROWS,
    FEATURE_SPEC,
    historicalReleaseBinding()
  );
  assert.deepEqual(corpusIds, EXPECTED_SCENARIO_IDS);
  assert.equal(DEPENDENCY_SPEC.ledger.status, "pending_cp4_recertification");
  assert.equal(pending.status, PENDING_OWNER_RECERTIFICATION);
  return {
    scientific_status: BLOCKED_STATUS,
    production_v2: null,
    scenario_count: pending.scenario_count,
    scenario_ids_sha256: SCENARIO_IDS_SHA256,
    scenario_ids_match_current_corpus: true,
    current_corpus_tree: currentCorpusTreeBinding(),
    authority_cohort_count: AUTHORITY_RECORD_IDS.length,
    adaptation_cohort_count: Object.keys(ADAPTATION_RECORDS).length,
    provisional_cohort_count: Object.keys(PROVISIONAL_RECORDS).length,
    exact_reference_actions: REFERENCE_DECISIONS,
    current_corpus_action_counts: decisionCounts,
    owner_recertification_status: pending.status,
    owner_signature_envelope: pending.signature_envelope,
    owner_signature_trust_boundary:
      "First-hand owner approval recorded in chat and bound in Git is the trust boundary; the signature envelope is a tamper-evident payload-hash binding, not cryptographic authentication.",
    committed_cp4_artifact: {
      artifact: "CP4_RECERTIFICATION.json",
      sha256: sha256(committedCp4Bytes),
      generator: "scripts/generate-cp4-recertification.mjs",
      generator_byte_identical: true,
      scenario_count: pending.scenario_count,
      signature_envelope: pending.signature_envelope
    },
    dependency_ledger_status: DEPENDENCY_SPEC.ledger.status,
    dependency_production_v2: null,
    adaptation_source_receipts: adaptationReceipts,
    historical_v1_calibration: {
      scope: historical.scope,
      signature_presence_correct: historical.signature_presence_correct,
      literal_tool_call_evidence_ids_correct: historical.literal_tool_call_evidence_ids_correct,
      evidence_count_status_correct: historical.evidence_count_status_correct,
      evidence_count_status_plus_signature_correct:
        historical.evidence_count_status_plus_signature_correct
    },
    scientific_limit: "Synthetic fixtures validate CP4 mechanics only. No row is claimed repaired, source-recertified, gold-recertified, owner-signed, or ready for production-v2 scoring."
  };
}

function childMain() {
  const idIndex = process.argv.indexOf("--subtest");
  const variantIndex = process.argv.indexOf("--variant");
  const id = process.argv[idIndex + 1];
  const variant = process.argv[variantIndex + 1];
  assert.ok(SUBTESTS.some((entry) => entry.subtest_id === id), `unknown subtest ${id}`);
  assert.ok(["bad", "corrected"].includes(variant), `unknown fixture variant ${variant}`);
  runSubtest(id, variant);
  process.stdout.write(`${id} ${variant} PASS\n`);
}

function publishAtomically(receiptBytes, matrixBytes) {
  fs.mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(MATRIX_PATH), { recursive: true });
  const receiptTemp = `${RECEIPT_PATH}.${process.pid}.tmp`;
  const matrixTemp = `${MATRIX_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(receiptTemp, receiptBytes, { flag: "wx" });
    fs.writeFileSync(matrixTemp, matrixBytes, { flag: "wx" });
    fs.renameSync(receiptTemp, RECEIPT_PATH);
    fs.renameSync(matrixTemp, MATRIX_PATH);
  } finally {
    fs.rmSync(receiptTemp, { force: true });
    fs.rmSync(matrixTemp, { force: true });
  }
}

function orchestratorMain() {
  const executions = [];
  for (const subtest of SUBTESTS) {
    const run = (variant) => spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--subtest", subtest.subtest_id, "--variant", variant],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, SBW_CP4_RED_CHILD: "1" } }
    );
    const bad = run("bad");
    const corrected = run("corrected");
    assert.notEqual(bad.status, 0, `${subtest.subtest_id} known-bad fixture exited zero`);
    assert.equal(
      corrected.status,
      0,
      `${subtest.subtest_id} corrected fixture failed:\n${corrected.stderr}`
    );
    executions.push({
      subtest_id: subtest.subtest_id,
      finding_id: subtest.finding_id,
      owning_checkpoint: 4,
      bad_exit_nonzero: true,
      corrected_exit_zero: true,
      label: subtest.label
    });
  }

  const auditSources = [
    "VALIDATION_PLAN.md",
    "CP4_RECERTIFICATION_SCHEMA.json",
    "CP4_RECERTIFICATION.json",
    "SHORTCUT_DEPENDENCY_SPEC.json",
    "SHORTCUT_FEATURE_SPEC.json",
    "HISTORICAL_V1_SHORTCUT_ROWS.json",
    "results/v2026-05/release-manifest.json",
    "sources/cp4/xstest-adaptation-source-receipt.json",
    "sources/cp4/or-bench-adaptation-source-receipt.json",
    "src/cp4-recertification.mjs",
    "src/cp4-dependency-ledger.mjs",
    "src/shortcut-gate.mjs",
    "scripts/generate-cp4-recertification.mjs",
    "integrity-audit/v2-audit/cp4-red-fixtures.mjs"
  ];
  const receipt = {
    schema_version: "steerbench.red-test-receipt.v1",
    checkpoint: 4,
    status: BLOCKED_STATUS,
    production_v2: null,
    required_subtest_count: SUBTESTS.length,
    all_required_subtests_executed: executions.length === SUBTESTS.length,
    all_bad_fixtures_exited_nonzero_before_replacement:
      executions.every((row) => row.bad_exit_nonzero),
    all_corrected_fixtures_passed:
      executions.every((row) => row.corrected_exit_zero),
    audit_source_hashes: Object.fromEntries(auditSources.map((relative) => [
      relative,
      sha256(fs.readFileSync(path.join(ROOT, relative)))
    ])),
    measurements: cp4Measurements(),
    executions
  };
  assert.equal(receipt.status, BLOCKED_STATUS);
  assert.equal(receipt.production_v2, null);
  assert.equal(receipt.measurements.owner_recertification_status, PENDING_OWNER_RECERTIFICATION);
  assert.equal(receipt.measurements.dependency_ledger_status, "pending_cp4_recertification");
  const receiptBytes = stableBytes(receipt);
  const receiptHash = sha256(receiptBytes);
  const matrixRows = executions.map((row) => ({
    subtest_id: row.subtest_id,
    finding_id: row.finding_id,
    owning_checkpoint: 4,
    known_bad_fixture: `${row.label}: isolated scratch mutation`,
    expected_gate_failure: "separate child process exits nonzero",
    corrected_fixture: `${row.label}: isolated synthetic contract fixture`,
    expected_pass: "separate child process exits zero without claiming scientific recertification",
    executed_receipt_sha256: receiptHash
  }));
  const matrix = {
    schema_version: "steerbench.red-test-matrix.partial.v1",
    checkpoint: 4,
    status: BLOCKED_STATUS,
    production_v2: null,
    required_subtest_count: SUBTESTS.length,
    receipt_sha256: receiptHash,
    aggregate: {
      unique_subtest_ids: new Set(matrixRows.map((row) => row.subtest_id)).size === matrixRows.length,
      all_required_subtests_present: matrixRows.length === SUBTESTS.length,
      all_bad_fixtures_blocked: true,
      all_corrected_fixtures_passed: true,
      owner_recertification_pending: true,
      dependency_ledger_pending: true
    },
    rows: matrixRows
  };
  publishAtomically(receiptBytes, stableBytes(matrix));
  process.stdout.write(
    `CP4 RED FIXTURES PASS: ${SUBTESTS.length}/${SUBTESTS.length}; `
      + `${BLOCKED_STATUS}; receipt ${receiptHash}\n`
  );
}

if (process.argv.includes("--subtest")) childMain();
else orchestratorMain();
