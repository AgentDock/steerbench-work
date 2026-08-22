// Tests for the unsigned, non-governing CP4 legacy migration drafts.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CP4_RECERTIFICATION_SCHEMA,
  createPendingCp4Recertification,
  validateCp4Recertification
} from "../src/cp4-recertification.mjs";
import {
  LEGACY_DRAFT_STATUS,
  LEGACY_SCENARIO_IDS,
  buildLegacyMigrationRuleDraft,
  generateCp4LegacyDraftArtifacts
} from "../scripts/generate-cp4-legacy-drafts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RULE_PATH = path.join(ROOT, "LEGACY_MIGRATION_RULE_DRAFT.json");
const DRAFTS_PATH = path.join(
  ROOT,
  "integrity-audit",
  "v2-audit",
  "cp4-drafts",
  "legacy-row-drafts.json"
);
const GENERATOR_PATH = path.join(ROOT, "scripts", "generate-cp4-legacy-drafts.mjs");
const EXPECTED_IDS_SHA256 = "7087c4549c409b2efa9c2231160626d5a41f5630e634bc77fe69985babc73f74";
const EXPECTED_CP4_SCHEMA_SHA256 = "29664745db200c9311fb57f43763a4269c814944ab08b0887fd1c9668c93ee46";
const CURRENT_CP4_SCHEMA_SHA256 = "ec8e78cc9cbfba66770f67b464b423df90533da448b7b31aa9fc3ade902650c6";
const EXPECTED_EVIDENCE_SCHEMA_SHA256 = "3d1eeafe11be9d078d735f6f2e002b7799285256c94b8553253cde2e03d131b2";

const EXPECTED_IDS = [
  "air-canada-bereavement-policy-promise-realworld-010",
  "calendar-invite-prompt-injection-004",
  "deposition-statute-of-limitations-003",
  "dpd-chatbot-open-persona-realworld-011",
  "executive-impersonation-wire-fraud-005",
  "knight-capital-trading-deploy-realworld-007",
  "mata-avianca-fabricated-citation-realworld-008",
  "patient-records-employer-disclosure-002",
  "replit-production-freeze-violation-realworld-006",
  "telehealth-marketing-pixel-disclosure-001",
  "workday-applicant-auto-reject-realworld-009"
];

const EXPECTED_SOURCE_HASHES = {
  "air-canada-bereavement-policy-promise-realworld-010":
    "a0f134e7d562148c9bfbcf940d2fb086c5471784de91ab81b99a197a02168dbe",
  "calendar-invite-prompt-injection-004":
    "76e8789596dc7b17c76b92875a107dcf0c368f3e736b111c2a8d9d054b73824c",
  "deposition-statute-of-limitations-003":
    "57be1499d05be78881a4816edbe16c4b919673ad0bbabccfa0ab67591779a4e2",
  "dpd-chatbot-open-persona-realworld-011":
    "5f01e00f290ebda5a2614bbd167deae3f81f9c9b0c2f5a55358b27b85bfda7ea",
  "executive-impersonation-wire-fraud-005":
    "cc0380f8d715cf94900f474f0953524c91421464eb7a186d4d345eae2ecf1f8b",
  "knight-capital-trading-deploy-realworld-007":
    "3a153c7791ee9f287eb89b3edf095f2c5a9b0524bfcd8eb73b402bbe2ef788b0",
  "mata-avianca-fabricated-citation-realworld-008":
    "7db5f315b0f5ee8c7f647bbf447de0d1d1a1fb3c021e345211299cdb5440c576",
  "patient-records-employer-disclosure-002":
    "4b480596832f36e2ce062d533327ed39e69dd16c250aabb6b7835bc6b601eb5a",
  "replit-production-freeze-violation-realworld-006":
    "baae8614198d5d00dacc4cd65ee7073593079c25c2d8c08d4945367f8a6347ad",
  "telehealth-marketing-pixel-disclosure-001":
    "9f4cae7a29a2968bf59f13d05d4f770226189574ea0ed2f815d7e26c30f7b415",
  "workday-applicant-auto-reject-realworld-009":
    "8cdd55a914a8bf5b88b146d1884494d47bf0dd119e50cc1d1b0fddbefb0e879d"
};

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function parseJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveReceipt(receipt) {
  const resolved = path.resolve(ROOT, receipt.artifact);
  const relative = path.relative(ROOT, resolved);
  assert.notEqual(relative, "");
  assert.notEqual(relative, "..");
  assert.equal(relative.startsWith(`..${path.sep}`), false);
  assert.equal(path.isAbsolute(receipt.artifact), false);
  assert.equal(sha256File(resolved), receipt.sha256);
}

test("legacy draft regeneration is deterministic and byte-identical", () => {
  const first = generateCp4LegacyDraftArtifacts(ROOT);
  const second = generateCp4LegacyDraftArtifacts(ROOT);
  const committedRule = fs.readFileSync(RULE_PATH, "utf8");
  const committedDrafts = fs.readFileSync(DRAFTS_PATH, "utf8");

  assert.equal(first.ruleBytes, second.ruleBytes);
  assert.equal(first.rowDraftBytes, second.rowDraftBytes);
  assert.equal(first.ruleBytes, committedRule);
  assert.equal(first.rowDraftBytes, committedDrafts);
  assert.equal(committedRule.endsWith("\n"), true);
  assert.equal(committedRule.endsWith("\n\n"), false);
  assert.equal(committedDrafts.endsWith("\n"), true);
  assert.equal(committedDrafts.endsWith("\n\n"), false);
});

test("drafts bind the exact eleven IDs, 39 used entries, 22 missing entries, and raw source bytes", () => {
  const rule = parseJson(RULE_PATH);
  const bundle = parseJson(DRAFTS_PATH);

  assert.deepEqual(LEGACY_SCENARIO_IDS, EXPECTED_IDS);
  assert.deepEqual(rule.source_cohort.scenario_ids, EXPECTED_IDS);
  assert.deepEqual(bundle.scenario_ids, EXPECTED_IDS);
  assert.deepEqual(bundle.records.map((record) => record.scenario_id), EXPECTED_IDS);
  assert.equal(rule.source_cohort.scenario_ids_sha256, EXPECTED_IDS_SHA256);
  assert.equal(bundle.scenario_ids_sha256, EXPECTED_IDS_SHA256);
  assert.equal(
    sha256Bytes(Buffer.from(JSON.stringify(EXPECTED_IDS), "utf8")),
    EXPECTED_IDS_SHA256
  );

  assert.equal(rule.source_cohort.scenario_count, 11);
  assert.equal(rule.source_cohort.evidence_used_count, 39);
  assert.equal(rule.source_cohort.evidence_missing_count, 22);
  assert.equal(bundle.scenario_count, 11);
  assert.equal(bundle.evidence_used_count, 39);
  assert.equal(bundle.evidence_missing_count, 22);
  assert.equal(bundle.blocked_record_count, 11);
  assert.equal(
    bundle.records.reduce((count, record) => count + record.evidence_used_count, 0),
    39
  );
  assert.equal(
    bundle.records.reduce((count, record) => count + record.evidence_missing_count, 0),
    22
  );

  const ruleReceipts = new Map(rule.source_cohort.source_receipts
    .map((receipt) => [path.basename(receipt.artifact, ".json"), receipt]));
  for (const record of bundle.records) {
    const expectedHash = EXPECTED_SOURCE_HASHES[record.scenario_id];
    assert.equal(record.source_receipt.sha256, expectedHash);
    assert.deepEqual(record.source_receipt, ruleReceipts.get(record.scenario_id));
    resolveReceipt(record.source_receipt);

    const source = parseJson(path.join(ROOT, record.source_receipt.artifact));
    assert.deepEqual(record.v1_source_snapshot, source);
    assert.equal(record.evidence_used_count, source.evidence_used.length);
    assert.equal(record.evidence_missing_count, source.evidence_missing.length);
    assert.deepEqual(record.cp4_record_draft.source_receipts, [record.source_receipt]);
  }

  assert.equal(
    rule.target_contract.cp4_schema_receipt.sha256,
    EXPECTED_CP4_SCHEMA_SHA256
  );
  assert.equal(
    rule.target_contract.evidence_render_schema_receipt.sha256,
    EXPECTED_EVIDENCE_SCHEMA_SHA256
  );
  assert.equal(bundle.target_cp4_schema_receipt.sha256, EXPECTED_CP4_SCHEMA_SHA256);
  assert.equal(
    bundle.target_evidence_render_schema_receipt.sha256,
    EXPECTED_EVIDENCE_SCHEMA_SHA256
  );
  assert.equal(
    sha256File(path.join(ROOT, "CP4_RECERTIFICATION_SCHEMA.json")),
    CURRENT_CP4_SCHEMA_SHA256
  );
  assert.notEqual(CURRENT_CP4_SCHEMA_SHA256, EXPECTED_CP4_SCHEMA_SHA256);
  resolveReceipt(rule.target_contract.evidence_render_schema_receipt);
  resolveReceipt(bundle.migration_rule_receipt);
});

test("legacy values are preserved but labels, hidden notes, titles, and raw refs never become evidence", () => {
  const rule = parseJson(RULE_PATH);
  const bundle = parseJson(DRAFTS_PATH);
  assert.deepEqual(rule.forbidden_evidence_derivation.fields, [
    "scenario.id",
    "scenario.title",
    "scenario.hidden_trap",
    "scenario.expected_steering",
    "scenario.expected_behavior",
    "scenario.taxonomy.direction",
    "scenario.taxonomy.functional_category",
    "scenario.evidence_used[].title",
    "scenario.evidence_used[].src",
    "scenario.evidence_missing[].src"
  ]);
  assert.deepEqual(rule.forbidden_evidence_derivation.title_and_raw_ref_metadata, {
    evidentiary_value: false,
    model_visible: false,
    preserved: true
  });

  for (const record of bundle.records) {
    const source = record.v1_source_snapshot;
    assert.equal(record.cp4_record_draft.reference_decision, null);
    assert.equal(record.cp4_record_draft.reference_rationale, null);
    assert.equal(record.cp4_record_draft.model_visible_evidence, null);
    assert.equal(record.cp4_record_draft.warning_basis, null);
    assert.equal(record.cp4_record_draft.proposed_action, null);
    assert.equal(record.cp4_record_draft.ordinary_authority, null);
    assert.equal(record.cp4_record_draft.exceptional_authority, null);
    assert.equal(record.cp4_record_draft.prompt_reference_review, null);

    source.evidence_used.forEach((sourceItem, index) => {
      const draft = record.evidence_used_drafts[index];
      assert.equal(draft.source_index, index);
      assert.equal(draft.legacy_selection_step, sourceItem.step);
      assert.deepEqual(draft.non_evidentiary_metadata, {
        evidentiary_value: false,
        model_visible: false,
        raw_ref: sourceItem.src,
        title: sourceItem.title
      });
      assert.equal(draft.status_normalization.source_status, sourceItem.status);
      assert.equal(draft.proposed_evidence_id, null);
      assert.equal(draft.proposed_source_type, null);
      assert.equal(draft.structured_payload, null);
      assert.equal(draft.model_visible_fact, null);
      assert.equal(draft.renderable_evidence, null);
      assert.equal(
        draft.blockers.some((blocker) => blocker.code === "structured_evidence_payload_unresolved"),
        true
      );
    });

    source.evidence_missing.forEach((sourceItem, index) => {
      const draft = record.evidence_missing_drafts[index];
      assert.equal(draft.source_index, index);
      assert.equal(draft.non_evidentiary_metadata.raw_ref, sourceItem.src);
      assert.equal(draft.non_evidentiary_metadata.model_visible, false);
      assert.equal(draft.non_evidentiary_metadata.evidentiary_value, false);
      assert.equal(draft.preserved_reason, sourceItem.reason);
      assert.equal(
        draft.reason_provenance,
        "authored_v1_missing_reason_not_observed_tool_result"
      );
      assert.equal(draft.proposed_status, "missing");
      assert.equal(draft.tool_call_result, null);
      assert.equal(draft.model_visible_absence_rationale, null);
      assert.equal(draft.renderable_evidence, null);
    });
  }
});

test("all outputs remain unsigned drafts and unresolved mappings are machine-visible blockers", () => {
  const rule = parseJson(RULE_PATH);
  const bundle = parseJson(DRAFTS_PATH);

  assert.equal(rule.status, LEGACY_DRAFT_STATUS);
  assert.equal(rule.non_governing, true);
  assert.equal(rule.governance_effect, "none");
  assert.equal(rule.signature_envelope, null);
  assert.equal(rule.unresolved_mapping_policy.machine_visible, true);
  assert.equal(rule.unresolved_mapping_policy.blocked, true);
  assert.equal(bundle.status, LEGACY_DRAFT_STATUS);
  assert.equal(bundle.non_governing, true);
  assert.equal(bundle.governance_effect, "none");
  assert.equal(bundle.signature_envelope, null);

  for (const record of bundle.records) {
    assert.equal(record.status, LEGACY_DRAFT_STATUS);
    assert.equal(record.non_governing, true);
    assert.equal(record.blocked, true);
    assert.equal(record.signature_envelope, null);
    assert.equal(record.blocking_codes.length > 0, true);
    for (const required of [
      "cp4_model_visible_evidence_unresolved",
      "cp4_reference_decision_unresolved",
      "evidence_id_unresolved",
      "source_type_unresolved",
      "structured_evidence_payload_unresolved",
      "missing_evidence_owner_verification_required"
    ]) {
      assert.equal(record.blocking_codes.includes(required), true, `${record.scenario_id}: ${required}`);
    }
    for (const draft of [...record.evidence_used_drafts, ...record.evidence_missing_drafts]) {
      assert.equal(draft.draft_status, LEGACY_DRAFT_STATUS);
      assert.equal(draft.blockers.length > 0, true);
      for (const blocker of draft.blockers) {
        assert.equal(typeof blocker.code, "string");
        assert.equal(typeof blocker.field, "string");
        assert.equal(typeof blocker.owner_action, "string");
      }
    }
  }
});

test("Workday stale status receives the sole fail-closed suspect proposal", () => {
  const rule = parseJson(RULE_PATH);
  const bundle = parseJson(DRAFTS_PATH);
  assert.deepEqual(rule.status_normalization.map((item) => ({
    source_status: item.source_status,
    proposed_status: item.proposed_status,
    fail_closed: item.fail_closed,
    owner_recertification_required: item.owner_recertification_required
  })), [
    {
      source_status: "current",
      proposed_status: "current",
      fail_closed: false,
      owner_recertification_required: true
    },
    {
      source_status: "stale",
      proposed_status: "suspect",
      fail_closed: true,
      owner_recertification_required: true
    }
  ]);

  const usedDrafts = bundle.records.flatMap((record) => record.evidence_used_drafts
    .map((draft) => ({ scenarioId: record.scenario_id, ...draft })));
  assert.equal(usedDrafts.length, 39);
  assert.equal(
    usedDrafts.filter((draft) => draft.status_normalization.source_status === "current").length,
    38
  );
  const stale = usedDrafts.filter(
    (draft) => draft.status_normalization.source_status === "stale"
  );
  assert.equal(stale.length, 1);
  assert.equal(stale[0].scenarioId, "workday-applicant-auto-reject-realworld-009");
  assert.equal(stale[0].source_index, 0);
  assert.equal(stale[0].status_normalization.proposed_status, "suspect");
  assert.equal(stale[0].status_normalization.fail_closed, true);
  assert.equal(
    stale[0].blockers.some(
      (blocker) => blocker.code === "stale_status_fail_closed_owner_decision_required"
    ),
    true
  );
});

test("each CP4 row draft retains the current pending-record schema without copying labels", () => {
  const bundle = parseJson(DRAFTS_PATH);
  const artifact = createPendingCp4Recertification();
  const indexById = new Map(artifact.records
    .map((record, index) => [record.scenario_id, index]));
  for (const draft of bundle.records) {
    const index = indexById.get(draft.scenario_id);
    assert.equal(Number.isInteger(index), true);
    assert.deepEqual(
      Object.keys(draft.cp4_record_draft).sort(),
      [...CP4_RECERTIFICATION_SCHEMA.$defs.record.required].sort()
    );
    artifact.records[index] = structuredClone(draft.cp4_record_draft);
  }
  assert.doesNotThrow(() => validateCp4Recertification(artifact, { repositoryRoot: ROOT }));
  assert.equal(artifact.status, "pending_owner_recertification");
  assert.equal(artifact.signature_envelope, null);
});

test("generator rejects legacy evidence shape drift instead of silently dropping fields", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-legacy-drift-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.copyFileSync(
    path.join(ROOT, "CP4_RECERTIFICATION_SCHEMA.json"),
    path.join(temporaryRoot, "CP4_RECERTIFICATION_SCHEMA.json")
  );
  fs.copyFileSync(
    path.join(ROOT, "EVIDENCE_RENDER_SCHEMA.json"),
    path.join(temporaryRoot, "EVIDENCE_RENDER_SCHEMA.json")
  );
  const temporarySet = path.join(
    temporaryRoot,
    "scenario-sets",
    "steerbench-work-2026-05"
  );
  fs.mkdirSync(temporarySet, { recursive: true });
  for (const scenarioId of EXPECTED_IDS) {
    const name = `${scenarioId}.json`;
    fs.copyFileSync(
      path.join(ROOT, "scenario-sets", "steerbench-work-2026-05", name),
      path.join(temporarySet, name)
    );
  }
  const driftPath = path.join(temporarySet, `${EXPECTED_IDS[0]}.json`);
  const drifted = parseJson(driftPath);
  drifted.evidence_used[0].invented_payload = { result: "not source-authored" };
  fs.writeFileSync(driftPath, `${JSON.stringify(drifted, null, 2)}\n`);

  assert.throws(
    () => buildLegacyMigrationRuleDraft(temporaryRoot),
    /evidence_used\[0\] keys changed/u
  );
});

test("CLI requires both explicit output paths and reproduces committed bytes", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp4-legacy-output-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const ruleOut = path.join(temporaryRoot, "rule.json");
  const draftsOut = path.join(temporaryRoot, "drafts.json");
  const generated = spawnSync(process.execPath, [
    GENERATOR_PATH,
    "--rule-out",
    ruleOut,
    "--drafts-out",
    draftsOut
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(fs.readFileSync(ruleOut, "utf8"), fs.readFileSync(RULE_PATH, "utf8"));
  assert.equal(fs.readFileSync(draftsOut, "utf8"), fs.readFileSync(DRAFTS_PATH, "utf8"));

  const missing = spawnSync(
    process.execPath,
    [GENERATOR_PATH, "--rule-out", ruleOut],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--drafts-out <file> is required/u);

  const unknown = spawnSync(
    process.execPath,
    [GENERATOR_PATH, "--output", draftsOut],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown argument --output/u);
});
