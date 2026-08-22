/**
 * @fileoverview Shared complete CP4 fixture for dependency-activation tests.
 * @module test/cp4-activation-fixture
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADAPTATION_RECORDS,
  OWNER_RECERTIFIED,
  cp4PayloadSha256,
  createPendingCp4Recertification
} from "../src/cp4-recertification.mjs";
import {
  LEGACY_MIGRATION_RULE_ARTIFACT,
  LEGACY_SCENARIO_IDS,
  loadAndValidateLegacyMigrationRule
} from "../src/cp4-legacy-migration-rule.mjs";

export const ACTIVATION_TEST_APPROVED_AT = "2026-08-21T12:34:56Z";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEGACY_APPROVAL_RECORD_LINE_RE =
  /^approval_record artifact=LEGACY_MIGRATION_RULE\.json(?: [^\r\n]*)?\r?\n?/gm;

/**
 * Replace any existing legacy-rule approval record with controlled fixture text.
 *
 * @param {string} sourcePlan Source validation-plan text.
 * @param {string} approvalLine Controlled record text, or an empty string.
 * @returns {string} Scratch-plan text with only the controlled record(s).
 */
export function withControlledLegacyApprovalRecord(sourcePlan, approvalLine) {
  const planWithoutLegacyApproval = sourcePlan.replace(
    LEGACY_APPROVAL_RECORD_LINE_RE,
    ""
  );
  const planWithTrailingNewline = planWithoutLegacyApproval.endsWith("\n")
    ? planWithoutLegacyApproval
    : planWithoutLegacyApproval + "\n";
  return approvalLine.length === 0
    ? planWithTrailingNewline
    : planWithTrailingNewline + approvalLine + "\n";
}

function copyArtifact(sourceRoot, destinationRoot, artifact) {
  const destination = path.join(destinationRoot, artifact);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, artifact), destination);
}

function createActivatedCp4TestRoot() {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-activated-root-"));
  const legacyRule = loadAndValidateLegacyMigrationRule(ROOT);
  const artifacts = [
    LEGACY_MIGRATION_RULE_ARTIFACT,
    "CP4_RECERTIFICATION_SCHEMA.json",
    "EVIDENCE_RENDER_SCHEMA.json",
    "integrity-audit/v2-audit/LEGACY_MIGRATION_RULE_DESIGN.md",
    "sources/cp4/xstest-adaptation-source-receipt.json",
    "sources/cp4/or-bench-adaptation-source-receipt.json",
    ...legacyRule.rule.source_cohort.source_receipts.map((receipt) => receipt.artifact)
  ];
  for (const artifact of artifacts) copyArtifact(ROOT, repositoryRoot, artifact);

  const plan = fs.readFileSync(path.join(ROOT, "VALIDATION_PLAN.md"), "utf8");
  const approvalLine = "approval_record artifact=" + LEGACY_MIGRATION_RULE_ARTIFACT
    + " sha256=" + legacyRule.receipt.sha256
    + " approved_on=2026-08-21 role=scientific_owner";
  fs.writeFileSync(
    path.join(repositoryRoot, "VALIDATION_PLAN.md"),
    withControlledLegacyApprovalRecord(plan, approvalLine)
  );
  return repositoryRoot;
}

export const ACTIVATED_CP4_TEST_ROOT = createActivatedCp4TestRoot();
process.once("exit", () => {
  fs.rmSync(ACTIVATED_CP4_TEST_ROOT, { recursive: true, force: true });
});

/**
 * Create a raw-byte source receipt for a repository artifact.
 *
 * @param {string} artifact Repository-relative artifact path.
 * @param {string} repositoryRoot Test repository root.
 * @returns {{artifact:string,sha256:string}} Receipt bound to the current bytes.
 */
export function activationTestReceipt(
  artifact = "VALIDATION_PLAN.md",
  repositoryRoot = ACTIVATED_CP4_TEST_ROOT
) {
  return {
    artifact,
    sha256: crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(repositoryRoot, artifact)))
      .digest("hex")
  };
}

/**
 * Replace the fixture's neutral CP4 envelope after a payload mutation.
 *
 * @param {object} artifact Complete CP4 fixture.
 * @param {string} approvedAt Strict UTC timestamp.
 * @returns {object} The same artifact, rebound for deterministic tests.
 */
export function signActivationTestCp4(
  artifact,
  approvedAt = ACTIVATION_TEST_APPROVED_AT
) {
  artifact.signature_envelope = {
    payload_sha256: cp4PayloadSha256(artifact),
    approved_at: approvedAt,
    role: "scientific_owner"
  };
  return artifact;
}

function rowById(artifact, scenarioId) {
  return artifact.records.find((record) => record.scenario_id === scenarioId);
}

function frozenAdaptationWrapper(dataset, repositoryRoot) {
  const filename = dataset === "XSTest"
    ? "sources/cp4/xstest-adaptation-source-receipt.json"
    : "sources/cp4/or-bench-adaptation-source-receipt.json";
  return {
    wrapper: JSON.parse(fs.readFileSync(path.join(repositoryRoot, filename), "utf8")),
    receipt: activationTestReceipt(filename, repositoryRoot)
  };
}

function configureAdaptationFromWrapper(artifact, scenarioId, wrapper, sourceReceipt) {
  const record = rowById(artifact, scenarioId);
  const mapping = wrapper.mappings.find(
    (candidate) => candidate.local_scenario_id === scenarioId
  );
  if (mapping === undefined) throw new Error(`test wrapper does not map ${scenarioId}`);
  Object.assign(record.adaptation_license, {
    upstream_dataset: wrapper.upstream.dataset_name,
    immutable_upstream_revision: wrapper.upstream.immutable_revision,
    upstream_source_example_or_prompt_id:
      mapping.upstream_source_example_or_prompt_id,
    upstream_artifact_sha256: wrapper.upstream.source_artifact.sha256,
    source_receipts: [sourceReceipt]
  });
  record.adaptation_license.license.identifier =
    wrapper.upstream.license_evidence.declared_identifier;
}

/**
 * Build a fully populated, digest-bound CP4 recertification fixture.
 *
 * The fixture uses real repository receipts so the production CP4 validator can
 * exercise its complete activation path without bypasses or mocks.
 *
 * @param {object} [options] Fixture options.
 * @param {string} [options.approvedAt] Approval-envelope timestamp.
 * @param {string} [options.repositoryRoot] Activated scratch repository root.
 * @returns {object} Complete owner-recertified CP4 artifact.
 */
export function createCompleteActivationTestCp4({
  approvedAt = ACTIVATION_TEST_APPROVED_AT,
  repositoryRoot = ACTIVATED_CP4_TEST_ROOT
} = {}) {
  const receipt = activationTestReceipt("VALIDATION_PLAN.md", repositoryRoot);
  const legacyRule = loadAndValidateLegacyMigrationRule(repositoryRoot);
  const artifact = createPendingCp4Recertification();
  artifact.status = OWNER_RECERTIFIED;

  for (const record of artifact.records) {
    record.source_receipts = [receipt];
    record.proposed_action = {
      actor: "worker_agent",
      principal: null,
      operation: "perform the exact recertified operation",
      target: "the exact recertified target",
      scope: "the exact recertified scope"
    };
    record.ordinary_authority = {
      status: "established",
      rationale: "The synthetic test receipt supports the ordinary-authority conclusion.",
      source_receipts: [receipt]
    };
    record.exceptional_authority = {
      status: "not_applicable",
      rationale: "The synthetic test record does not rely on exceptional authority.",
      source_receipts: []
    };
    record.model_visible_evidence = {
      evidence_ids: [],
      facts: ["Synthetic test fact reviewed against the source receipt."],
      absence_rationale: null,
      source_receipts: [receipt]
    };
    record.warning_basis = {
      warnings: [],
      rationale: "No warning is asserted by this synthetic completed-record fixture.",
      source_receipts: []
    };
    record.reference_decision = "continue";
    record.reference_rationale =
      "The synthetic reference decision follows the reviewed action and evidence.";
    record.prompt_reference_review = {
      reviewed_prompt_sha256: receipt.sha256,
      prompt_decision_consistent: true,
      contradictions: [],
      rationale: "The synthetic prompt and reference decision were reviewed as a pair.",
      source_receipts: [receipt]
    };

    if (record.authority_review !== null) {
      Object.assign(record.authority_review, {
        grantor: "synthetic grantor",
        authorized_actor: "worker_agent",
        authorized_role: "synthetic operator",
        exact_action: "perform the exact recertified operation",
        target: "the exact recertified target",
        scope: "the exact recertified scope",
        temporal_validity: "valid for the synthetic fixture timestamp",
        legal_authority: "synthetic legal-authority finding",
        operational_delegation: "synthetic action-specific delegation",
        safety_clearance: "synthetic safety-clearance finding",
        supporting_artifact: receipt,
        conclusion: "authority_established",
        rationale: "The uniform authority schema was completed for this test record."
      });
    }

    if (record.adaptation_license !== null) {
      Object.assign(record.adaptation_license, {
        upstream_dataset: ADAPTATION_RECORDS[record.scenario_id],
        immutable_upstream_revision: "synthetic-immutable-upstream-revision",
        upstream_source_example_or_prompt_id: "synthetic-upstream-example-id",
        upstream_artifact_sha256: receipt.sha256,
        transformation: {
          what_changed: "The source example was transformed into an agent action boundary.",
          why: "The synthetic fixture exercises adaptation provenance."
        },
        license: {
          identifier: "synthetic-test-license",
          redistribution_status: "redistribution reviewed for the synthetic fixture",
          compatible: true,
          rationale: "The synthetic fixture records a completed compatibility conclusion."
        },
        source_receipts: [receipt]
      });
      if (record.adaptation_license.official_source_review !== null) {
        Object.assign(record.adaptation_license.official_source_review, {
          court_filed_characterization: "synthetic reviewed characterization",
          sec_filing_access_endpoint: "synthetic reviewed SEC endpoint",
          sec_supported_automation_method: "synthetic reviewed SEC automation method",
          delaware_access_rules: "synthetic reviewed Delaware access rules",
          delaware_automation_rules: "synthetic reviewed Delaware automation rules",
          target_record_existence: "synthetic reviewed target-record finding",
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
          authorized_actor: "worker_agent",
          scope: "synthetic held-out scope",
          target: "synthetic held-out target",
          temporal_validity: "synthetic validity interval",
          signature_trust: "synthetic signature-trust finding"
        });
      } else if (record.provisional_review.kind === "evaluation_provenance") {
        Object.assign(record.provisional_review, {
          evaluation_provenance_status: "synthetic suspected provenance",
          contamination_assessment: "synthetic suspected-only assessment",
          numeric_claim_resolution: "synthetic 0.61 versus 0.62 discrepancy resolved"
        });
      } else {
        Object.assign(record.provisional_review, {
          fixture_regeneration_script: "synthetic fixture-regeneration script receipt",
          exact_diff: "synthetic exact diff receipt",
          row_counts: "synthetic before-and-after row counts",
          grader_and_heldout_non_change: "synthetic grader and held-out non-change receipt"
        });
      }
    }
  }

  for (let index = 0; index < LEGACY_SCENARIO_IDS.length; index += 1) {
    const record = rowById(artifact, LEGACY_SCENARIO_IDS[index]);
    record.source_receipts.push(
      structuredClone(legacyRule.rule.source_cohort.source_receipts[index]),
      structuredClone(legacyRule.receipt)
    );
    record.source_receipts.sort((left, right) => {
      if (left.artifact < right.artifact) return -1;
      if (left.artifact > right.artifact) return 1;
      return 0;
    });
  }

  for (const dataset of ["XSTest", "OR-Bench"]) {
    const source = frozenAdaptationWrapper(dataset, repositoryRoot);
    for (const [scenarioId, expectedDataset] of Object.entries(ADAPTATION_RECORDS)) {
      if (expectedDataset === dataset) {
        configureAdaptationFromWrapper(
          artifact,
          scenarioId,
          source.wrapper,
          source.receipt
        );
      }
    }
  }

  return signActivationTestCp4(artifact, approvedAt);
}
