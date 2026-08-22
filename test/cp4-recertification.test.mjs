// Checkpoint-4 recertification contract tests.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADAPTATION_RECORDS,
  ADAPTATION_SOURCE_RECEIPT_CONTRACT,
  AUTHORITY_RECORD_IDS,
  CP4_RECERTIFICATION_SCHEMA,
  DEPENDENCY_CLAIM_KEYS,
  EXPECTED_SCENARIO_IDS,
  OWNER_ATTESTATION,
  OWNER_RECERTIFIED,
  PROVISIONAL_RECORDS,
  REFERENCE_DECISIONS,
  SCENARIO_IDS_SHA256,
  canonicalizeCp4Payload,
  canonicalizeCp4Recertification,
  cp4PayloadSha256,
  createPendingCp4Recertification,
  validateCp4Recertification
} from "../src/cp4-recertification.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SET = path.join(ROOT, "scenario-sets", "steerbench-work-2026-05");

function receiptFor(artifact, repositoryRoot = ROOT) {
  return {
    artifact,
    sha256: crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(repositoryRoot, artifact)))
      .digest("hex")
  };
}

function signTestArtifact(artifact) {
  artifact.signature_envelope = {
    owner_id: "synthetic-test-owner",
    signed_at: "2026-08-21T12:34:56Z",
    payload_sha256: cp4PayloadSha256(artifact),
    attestation: OWNER_ATTESTATION,
    signature: "test-only-owner-supplied-opaque-attestation"
  };
  return artifact;
}

function completeArtifact(
  receipt = receiptFor("VALIDATION_PLAN.md"),
  adaptationSources = null
) {
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
  const sources = adaptationSources || [
    frozenAdaptationWrapper("XSTest"),
    frozenAdaptationWrapper("OR-Bench")
  ];
  for (const source of sources) {
    for (const [scenarioId, expectedDataset] of Object.entries(ADAPTATION_RECORDS)) {
      if (expectedDataset === source.wrapper.upstream.dataset_name) {
        configureAdaptationFromWrapper(
          artifact,
          scenarioId,
          source.wrapper,
          source.receipt
        );
      }
    }
  }
  return signTestArtifact(artifact);
}

function rowById(artifact, scenarioId) {
  return artifact.records.find((record) => record.scenario_id === scenarioId);
}

function configureAdaptationFromWrapper(artifact, scenarioId, wrapper, sourceReceipt) {
  const record = rowById(artifact, scenarioId);
  const mapping = wrapper.mappings.find(
    (candidate) => candidate.local_scenario_id === scenarioId
  );
  assert.ok(mapping, "test wrapper must map " + scenarioId);
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

function frozenAdaptationWrapper(dataset) {
  const filename = dataset === "XSTest"
    ? "sources/cp4/xstest-adaptation-source-receipt.json"
    : "sources/cp4/or-bench-adaptation-source-receipt.json";
  return {
    filename,
    wrapper: JSON.parse(fs.readFileSync(path.join(ROOT, filename), "utf8")),
    receipt: receiptFor(filename)
  };
}

function completeArtifactWithFrozenAdaptationWrappers() {
  return completeArtifact();
}

test("schema freezes all plan fields, exact IDs, and the three exact cohorts", () => {
  assert.equal(EXPECTED_SCENARIO_IDS.length, 106);
  assert.equal(new Set(EXPECTED_SCENARIO_IDS).size, 106);
  assert.deepEqual(EXPECTED_SCENARIO_IDS, [...EXPECTED_SCENARIO_IDS].sort());
  assert.equal(
    crypto.createHash("sha256").update(JSON.stringify(EXPECTED_SCENARIO_IDS)).digest("hex"),
    SCENARIO_IDS_SHA256
  );
  assert.deepEqual(AUTHORITY_RECORD_IDS, [
    "amazon-hiring-mirror-advance-candidate-tier-b-005",
    "apple-card-mirror-credit-extension-tier-b-004",
    "cloudflare-regex-mirror-dry-run-deploy-tier-b-016",
    "crowdstrike-mirror-staged-sensor-update-tier-b-015",
    "facebook-bgp-mirror-canaried-config-tier-b-014",
    "robodebt-mirror-eligible-notice-tier-b-010",
    "tesla-autopilot-mirror-lane-change-tier-b-008"
  ]);
  assert.deepEqual(Object.keys(ADAPTATION_RECORDS).sort(), [
    "orbench-illegal-bypass-rate-limit-tier-c-015",
    "orbench-privacy-public-record-lookup-tier-c-014",
    "xstest-homonym-kill-process-tier-c-011",
    "xstest-safe-context-exploit-in-ctf-tier-c-013",
    "xstest-safe-target-destroy-fixtures-tier-c-012"
  ]);
  assert.deepEqual(Object.keys(PROVISIONAL_RECORDS).sort(), [
    "eval-leakage-001",
    "fixture-regenerate-authorized-adversarial-006",
    "heldout-audit-authorized-adversarial-003"
  ]);
  assert.deepEqual(
    CP4_RECERTIFICATION_SCHEMA.$defs.record.required,
    [
      "scenario_id",
      "source_receipts",
      "proposed_action",
      "ordinary_authority",
      "exceptional_authority",
      "model_visible_evidence",
      "warning_basis",
      "reference_decision",
      "reference_rationale",
      "dependency_claims",
      "adaptation_license",
      "prompt_reference_review",
      "authority_review",
      "provisional_review"
    ]
  );
  assert.deepEqual(DEPENDENCY_CLAIM_KEYS, [
    "recertified_pair_or_mirror_id",
    "immutable_upstream_source_example_id",
    "generating_template_lineage_id"
  ]);
  assert.deepEqual(ADAPTATION_SOURCE_RECEIPT_CONTRACT.cross_bound_fields, [
    "upstream.dataset_name",
    "upstream.immutable_revision",
    "upstream.source_artifact.sha256",
    "mappings[].local_scenario_id",
    "mappings[].upstream_source_example_or_prompt_id",
    "upstream.license_evidence.declared_identifier"
  ]);
  assert.equal(
    ADAPTATION_SOURCE_RECEIPT_CONTRACT.direct_raw_artifact_hash_match,
    "forbidden"
  );
});

test("reference decisions preserve all six canonical actions and the current corpus distribution", () => {
  assert.deepEqual(REFERENCE_DECISIONS, [
    "continue",
    "proceed",
    "block",
    "request_approval",
    "escalate",
    "ask_clarification"
  ]);
  const counts = {};
  for (const file of fs.readdirSync(SET)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .sort()) {
    const scenario = JSON.parse(fs.readFileSync(path.join(SET, file), "utf8"));
    const decision = scenario.expected_behavior.correct_action;
    assert.equal(REFERENCE_DECISIONS.includes(decision), true, scenario.id);
    counts[decision] = (counts[decision] || 0) + 1;
  }
  assert.deepEqual(counts, {
    block: 46,
    continue: 56,
    escalate: 3,
    request_approval: 1
  });

  const accepted = createPendingCp4Recertification();
  accepted.records[0].reference_decision = "request_approval";
  accepted.records[1].reference_decision = "escalate";
  accepted.records[2].reference_decision = "proceed";
  accepted.records[3].reference_decision = "ask_clarification";
  assert.doesNotThrow(() => validateCp4Recertification(accepted));

  accepted.records[0].reference_decision = "allow";
  assert.throws(
    () => validateCp4Recertification(accepted),
    /reference_decision is outside the allowed enum/
  );
});

test("unsigned pending template validates cleanly with explicit cohort shells", () => {
  const artifact = createPendingCp4Recertification();
  const validated = validateCp4Recertification(artifact);
  assert.notStrictEqual(validated, artifact);
  assert.notStrictEqual(validated.records, artifact.records);
  assert.equal(validated.status, "pending_owner_recertification");
  assert.equal(validated.signature_envelope, null);
  assert.deepEqual(validated.records.map((record) => record.scenario_id), EXPECTED_SCENARIO_IDS);
  assert.equal(artifact.records.filter((record) => record.authority_review !== null).length, 7);
  assert.equal(artifact.records.filter((record) => record.adaptation_license !== null).length, 5);
  assert.equal(artifact.records.filter((record) => record.provisional_review !== null).length, 3);
  for (const record of artifact.records) {
    assert.deepEqual(Object.keys(record.dependency_claims), DEPENDENCY_CLAIM_KEYS);
    for (const key of DEPENDENCY_CLAIM_KEYS) {
      assert.deepEqual(record.dependency_claims[key], []);
    }
  }
  assert.equal(canonicalizeCp4Recertification(artifact), JSON.stringify(validated));
});

test("record count, exact ID census, and record order fail closed", () => {
  const tooShort = createPendingCp4Recertification();
  tooShort.records.pop();
  assert.throws(
    () => validateCp4Recertification(tooShort),
    /exactly 106 records/
  );

  const wrongId = createPendingCp4Recertification();
  wrongId.records[0].scenario_id = "synthetic-unknown-id";
  assert.throws(
    () => validateCp4Recertification(wrongId),
    /exact sorted corpus IDs/
  );

  const outOfOrder = createPendingCp4Recertification();
  [outOfOrder.records[0], outOfOrder.records[1]] =
    [outOfOrder.records[1], outOfOrder.records[0]];
  assert.throws(
    () => validateCp4Recertification(outOfOrder),
    /records must contain the exact sorted corpus IDs/
  );
});

test("missing plan fields and cohort omissions or additions fail closed", () => {
  const missingField = createPendingCp4Recertification();
  delete missingField.records[0].warning_basis;
  assert.throws(
    () => validateCp4Recertification(missingField),
    /warning_basis is required/
  );

  const missingAuthority = createPendingCp4Recertification();
  rowById(
    missingAuthority,
    "amazon-hiring-mirror-advance-candidate-tier-b-005"
  ).authority_review = null;
  assert.throws(
    () => validateCp4Recertification(missingAuthority),
    /authority_review is required for the exact authority cohort/
  );

  const extraAuthority = createPendingCp4Recertification();
  extraAuthority.records[0].authority_review = structuredClone(
    rowById(
      extraAuthority,
      "amazon-hiring-mirror-advance-candidate-tier-b-005"
    ).authority_review
  );
  assert.throws(
    () => validateCp4Recertification(extraAuthority),
    /authority_review is forbidden outside the exact authority cohort/
  );

  const missingAdaptation = createPendingCp4Recertification();
  rowById(
    missingAdaptation,
    "orbench-illegal-bypass-rate-limit-tier-c-015"
  ).adaptation_license = null;
  assert.throws(
    () => validateCp4Recertification(missingAdaptation),
    /adaptation_license is required for the exact adaptation cohort/
  );

  const missingProvisional = createPendingCp4Recertification();
  rowById(
    missingProvisional,
    "eval-leakage-001"
  ).provisional_review = null;
  assert.throws(
    () => validateCp4Recertification(missingProvisional),
    /provisional_review is required for the exact provisional cohort/
  );
});

test("populated pending fields are checked, but null review content remains unsigned and valid", () => {
  const artifact = createPendingCp4Recertification();
  const receipt = receiptFor("VALIDATION_PLAN.md");
  artifact.records[0].source_receipts = [receipt];
  artifact.records[0].proposed_action = {
    actor: "worker_agent",
    principal: null,
    operation: null,
    target: null,
    scope: null
  };
  assert.doesNotThrow(() => validateCp4Recertification(artifact));

  artifact.signature_envelope = {
    owner_id: "not-allowed-while-pending",
    signed_at: "2026-08-21T12:34:56Z",
    payload_sha256: cp4PayloadSha256(artifact),
    attestation: OWNER_ATTESTATION,
    signature: "test-only"
  };
  assert.throws(
    () => validateCp4Recertification(artifact),
    /pending artifacts must have a null signature_envelope/
  );
});

test("owner-recertified artifact requires every completed field and validates cleanly", () => {
  const artifact = completeArtifact();
  const validated = validateCp4Recertification(artifact);
  assert.deepEqual(validated, JSON.parse(canonicalizeCp4Recertification(artifact)));
  assert.deepEqual(validated.records.map((record) => record.scenario_id), EXPECTED_SCENARIO_IDS);
  assert.equal(
    artifact.signature_envelope.payload_sha256,
    crypto.createHash("sha256").update(canonicalizeCp4Payload(artifact)).digest("hex")
  );

  const incomplete = createPendingCp4Recertification();
  incomplete.status = OWNER_RECERTIFIED;
  signTestArtifact(incomplete);
  assert.throws(
    () => validateCp4Recertification(incomplete),
    /must contain primary source receipts/
  );

  const incompleteAdaptation = completeArtifact();
  rowById(
    incompleteAdaptation,
    "xstest-homonym-kill-process-tier-c-011"
  ).adaptation_license.license = null;
  signTestArtifact(incompleteAdaptation);
  assert.throws(
    () => validateCp4Recertification(incompleteAdaptation),
    /transformation and license reviews are required/
  );

  const distinctPromptHash = completeArtifact();
  const promptReview = distinctPromptHash.records[0].prompt_reference_review;
  promptReview.reviewed_prompt_sha256 = crypto.createHash("sha256")
    .update("distinct reviewed prompt bytes", "utf8")
    .digest("hex");
  assert.notEqual(
    promptReview.reviewed_prompt_sha256,
    promptReview.source_receipts[0].sha256
  );
  signTestArtifact(distinctPromptHash);
  assert.doesNotThrow(() => validateCp4Recertification(distinctPromptHash));

  promptReview.reviewed_prompt_sha256 = crypto.createHash("sha256")
    .update("different prompt bytes after owner binding", "utf8")
    .digest("hex");
  assert.throws(
    () => validateCp4Recertification(distinctPromptHash),
    /payload_sha256 does not bind the canonical payload/
  );
});

test("the two frozen adaptation wrappers cross-bind all five adaptation records", () => {
  const artifact = completeArtifactWithFrozenAdaptationWrappers();
  assert.doesNotThrow(() => validateCp4Recertification(artifact));
  for (const record of artifact.records.filter(
    (candidate) => candidate.adaptation_license !== null
  )) {
    const localReceiptHash = record.adaptation_license.source_receipts[0].sha256;
    assert.notEqual(
      localReceiptHash,
      record.adaptation_license.upstream_artifact_sha256,
      record.scenario_id + " must exercise wrapper binding, not direct raw equality"
    );
  }
});

test("adaptation wrappers reject every cross-bound mismatch and malformed content", async (t) => {
  const frozen = frozenAdaptationWrapper("XSTest");
  const frozenOrBench = frozenAdaptationWrapper("OR-Bench");

  async function runCase(name, mutateWrapper, expectedError, rawContent = null) {
    await t.test(name, () => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-wrapper-test-"));
      try {
        fs.writeFileSync(path.join(temporaryRoot, "base.txt"), "synthetic base receipt\n");
        const wrapper = structuredClone(frozen.wrapper);
        if (mutateWrapper) mutateWrapper(wrapper);
        const wrapperBytes = rawContent === null
          ? JSON.stringify(wrapper, null, 2) + "\n"
          : rawContent;
        fs.writeFileSync(path.join(temporaryRoot, "wrapper.json"), wrapperBytes);
        fs.writeFileSync(
          path.join(temporaryRoot, "or-wrapper.json"),
          JSON.stringify(frozenOrBench.wrapper, null, 2) + "\n"
        );
        const baseReceipt = receiptFor("base.txt", temporaryRoot);
        const wrapperReceipt = receiptFor("wrapper.json", temporaryRoot);
        const orWrapperReceipt = receiptFor("or-wrapper.json", temporaryRoot);
        const artifact = completeArtifact(baseReceipt, [
          { wrapper: frozen.wrapper, receipt: wrapperReceipt },
          { wrapper: frozenOrBench.wrapper, receipt: orWrapperReceipt }
        ]);
        assert.throws(
          () => validateCp4Recertification(
            artifact,
            { repositoryRoot: temporaryRoot }
          ),
          expectedError
        );
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    });
  }

  await runCase(
    "dataset name",
    (wrapper) => {
      wrapper.upstream.dataset_name = "OR-Bench";
    },
    /upstream\.dataset_name does not match/
  );
  await runCase(
    "immutable revision",
    (wrapper) => {
      wrapper.upstream.immutable_revision = "different-immutable-revision";
    },
    /upstream\.immutable_revision does not match/
  );
  await runCase(
    "embedded source artifact hash",
    (wrapper) => {
      wrapper.upstream.source_artifact.sha256 = "0".repeat(64);
    },
    /upstream\.source_artifact\.sha256 does not match/
  );
  await runCase(
    "local scenario mapping",
    (wrapper) => {
      wrapper.mappings[0].local_scenario_id = "wrong-local-scenario";
    },
    /mappings do not match the exact local scenario cohort/
  );
  await runCase(
    "upstream example or prompt ID",
    (wrapper) => {
      wrapper.mappings[0].upstream_source_example_or_prompt_id = "wrong-upstream-id";
    },
    /upstream_source_example_or_prompt_id does not match/
  );
  await runCase(
    "declared license identifier",
    (wrapper) => {
      wrapper.upstream.license_evidence.declared_identifier = "wrong-license";
    },
    /declared_identifier does not match/
  );
  await runCase(
    "wrong wrapper schema",
    (wrapper) => {
      wrapper.schema_version = "wrong.wrapper.v1";
    },
    /schema_version is not the CP4 adaptation source wrapper/
  );
  await runCase(
    "malformed JSON wrapper shape",
    null,
    /schema_version is required/,
    "{}\n"
  );
  await runCase(
    "non-JSON wrapper",
    null,
    /must resolve to valid JSON/,
    "not JSON\n"
  );
});

test("a matching bare artifact hash cannot bypass revision, mapping, or license provenance", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-raw-hash-test-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporaryRoot, "base.txt"), "synthetic base receipt\n");
  fs.writeFileSync(
    path.join(temporaryRoot, "bare-upstream.csv"),
    "prompt,label\nsynthetic prompt,safe\n"
  );
  const xstest = frozenAdaptationWrapper("XSTest");
  const orBench = frozenAdaptationWrapper("OR-Bench");
  fs.writeFileSync(
    path.join(temporaryRoot, "x-wrapper.json"),
    JSON.stringify(xstest.wrapper, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "or-wrapper.json"),
    JSON.stringify(orBench.wrapper, null, 2) + "\n"
  );
  const artifact = completeArtifact(
    receiptFor("base.txt", temporaryRoot),
    [
      {
        wrapper: xstest.wrapper,
        receipt: receiptFor("x-wrapper.json", temporaryRoot)
      },
      {
        wrapper: orBench.wrapper,
        receipt: receiptFor("or-wrapper.json", temporaryRoot)
      }
    ]
  );
  const adaptation = rowById(
    artifact,
    "xstest-homonym-kill-process-tier-c-011"
  ).adaptation_license;
  const bareReceipt = receiptFor("bare-upstream.csv", temporaryRoot);
  adaptation.source_receipts = [bareReceipt];
  adaptation.upstream_artifact_sha256 = bareReceipt.sha256;
  adaptation.immutable_upstream_revision = "false-revision";
  adaptation.upstream_source_example_or_prompt_id = "false-example-id";
  adaptation.license.identifier = "false-license";
  signTestArtifact(artifact);

  assert.equal(adaptation.source_receipts[0].sha256, adaptation.upstream_artifact_sha256);
  assert.throws(
    () => validateCp4Recertification(
      artifact,
      { repositoryRoot: temporaryRoot }
    ),
    /must resolve to valid JSON when used as an adaptation wrapper/
  );
});

test("receipt paths and raw SHA-256 bytes fail closed on every unsafe case", (t) => {
  const badHash = createPendingCp4Recertification();
  badHash.records[0].source_receipts = [{
    artifact: "VALIDATION_PLAN.md",
    sha256: "0".repeat(64)
  }];
  assert.throws(() => validateCp4Recertification(badHash), /SHA-256 mismatch/);

  const absolute = createPendingCp4Recertification();
  absolute.records[0].source_receipts = [{
    artifact: path.join(ROOT, "VALIDATION_PLAN.md"),
    sha256: receiptFor("VALIDATION_PLAN.md").sha256
  }];
  assert.throws(() => validateCp4Recertification(absolute), /repository-relative, not absolute/);

  const traversal = createPendingCp4Recertification();
  traversal.records[0].source_receipts = [{
    artifact: "../VALIDATION_PLAN.md",
    sha256: "0".repeat(64)
  }];
  assert.throws(() => validateCp4Recertification(traversal), /traversal/);

  const missing = createPendingCp4Recertification();
  missing.records[0].source_receipts = [{
    artifact: "does-not-exist.receipt",
    sha256: "0".repeat(64)
  }];
  assert.throws(() => validateCp4Recertification(missing), /cannot resolve/);

  const directory = createPendingCp4Recertification();
  directory.records[0].source_receipts = [{
    artifact: "src",
    sha256: "0".repeat(64)
  }];
  assert.throws(() => validateCp4Recertification(directory), /not a regular file/);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-receipt-test-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const rawBytes = Buffer.from("raw\r\nreceipt\u0000bytes", "utf8");
  fs.writeFileSync(path.join(temporaryRoot, "receipt.bin"), rawBytes);
  fs.symlinkSync("receipt.bin", path.join(temporaryRoot, "receipt-link.bin"));
  const rawDigest = crypto.createHash("sha256").update(rawBytes).digest("hex");

  const validRawReceipt = createPendingCp4Recertification();
  validRawReceipt.records[0].source_receipts = [{
    artifact: "receipt.bin",
    sha256: rawDigest
  }];
  assert.doesNotThrow(() => validateCp4Recertification(
    validRawReceipt,
    { repositoryRoot: temporaryRoot }
  ));

  const symlink = createPendingCp4Recertification();
  symlink.records[0].source_receipts = [{
    artifact: "receipt-link.bin",
    sha256: rawDigest
  }];
  assert.throws(
    () => validateCp4Recertification(symlink, { repositoryRoot: temporaryRoot }),
    /symlink paths are forbidden/
  );

  const racedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-receipt-race-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-receipt-outside-"));
  t.after(() => fs.rmSync(racedRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const racedPath = path.join(racedRoot, "receipt.bin");
  const backupPath = path.join(racedRoot, "receipt-original.bin");
  const outsidePath = path.join(outsideRoot, "outside.bin");
  fs.writeFileSync(racedPath, rawBytes);
  fs.writeFileSync(outsidePath, rawBytes);
  const resolvedRacedPath = fs.realpathSync(racedPath);
  const racedReceipt = createPendingCp4Recertification();
  racedReceipt.records[0].source_receipts = [{
    artifact: "receipt.bin",
    sha256: rawDigest
  }];
  const originalOpenSync = fs.openSync;
  let swappedBeforeOpen = false;
  fs.openSync = function openWithReceiptSwap(target, flags, mode) {
    if (!swappedBeforeOpen && target === resolvedRacedPath) {
      fs.renameSync(racedPath, backupPath);
      fs.symlinkSync(outsidePath, racedPath);
      swappedBeforeOpen = true;
    }
    return originalOpenSync.call(fs, target, flags, mode);
  };
  try {
    assert.throws(
      () => validateCp4Recertification(racedReceipt, { repositoryRoot: racedRoot }),
      /stable non-symlink file/
    );
    assert.equal(swappedBeforeOpen, true);
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test("signature envelope binds the canonical payload but does not pretend to verify crypto", () => {
  const artifact = completeArtifact();
  const boundDigest = artifact.signature_envelope.payload_sha256;
  artifact.records[0].reference_rationale += " Mutated after owner binding.";
  assert.throws(
    () => validateCp4Recertification(artifact),
    /does not bind the canonical payload/
  );

  const badDate = completeArtifact();
  badDate.signature_envelope.signed_at = "2026-02-30T12:34:56Z";
  assert.throws(
    () => validateCp4Recertification(badDate),
    /not a real UTC timestamp/
  );

  const opaqueSignature = completeArtifact();
  assert.equal(cp4PayloadSha256(opaqueSignature), boundDigest);
  opaqueSignature.signature_envelope.signature = "different-owner-supplied-opaque-value";
  assert.equal(cp4PayloadSha256(opaqueSignature), boundDigest);
  assert.doesNotThrow(() => validateCp4Recertification(opaqueSignature));
});

test("dependency claims stay explicit, sorted, and share one receipted meaning", () => {
  const artifact = createPendingCp4Recertification();
  const planReceipt = receiptFor("VALIDATION_PLAN.md");
  const auditReceipt = receiptFor("AUDIT.md");
  artifact.records[0].dependency_claims.recertified_pair_or_mirror_id = [{
    id: "shared-pair",
    source_receipt: planReceipt
  }];
  artifact.records[1].dependency_claims.recertified_pair_or_mirror_id = [{
    id: "shared-pair",
    source_receipt: auditReceipt
  }];
  assert.throws(
    () => validateCp4Recertification(artifact),
    /shared claim with a different source_receipt/
  );

  const unsorted = createPendingCp4Recertification();
  unsorted.records[0].dependency_claims.generating_template_lineage_id = [
    { id: "z-template", source_receipt: planReceipt },
    { id: "a-template", source_receipt: planReceipt }
  ];
  assert.throws(
    () => validateCp4Recertification(unsorted),
    /Unicode code-point order/
  );

  const missingKey = createPendingCp4Recertification();
  delete missingKey.records[0].dependency_claims.immutable_upstream_source_example_id;
  assert.throws(
    () => validateCp4Recertification(missingKey),
    /immutable_upstream_source_example_id is required/
  );
});
