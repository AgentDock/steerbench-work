// Tests for the self-contained, hash-activatable CP4 legacy migration rule.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEGACY_MIGRATION_RULE_ACTIVATION,
  LEGACY_MIGRATION_RULE_ARTIFACT,
  LEGACY_MIGRATION_RULE_SCHEMA_VERSION,
  LEGACY_RENDERABLE_DESTINATIONS,
  LEGACY_SCENARIO_IDS,
  buildLegacyMigrationRule,
  loadAndValidateLegacyMigrationRule,
  serializeLegacyMigrationRule,
  validateLegacyMigrationRule
} from "../src/cp4-legacy-migration-rule.mjs";
import {
  buildLegacyMigrationRuleArtifact,
  generateLegacyMigrationRuleArtifact
} from "../scripts/generate-cp4-legacy-migration-rule.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RULE_PATH = path.join(ROOT, LEGACY_MIGRATION_RULE_ARTIFACT);
const DESIGN_ARTIFACT = "integrity-audit/v2-audit/LEGACY_MIGRATION_RULE_DESIGN.md";
const EXPECTED_RULE_SHA256 =
  "bd0aa9130470154611d995a4dcee2a85125a23735ac411a1d6c2cea7c17915fc";
const EXPECTED_DESIGN_SHA256 =
  "6506ec9a1cacb9853defcab0e7abd90cca8b52d4e80cf47968d40cb856abccd9";
const EXPECTED_DRAFT_SHA256 =
  "e618e3071e4bf8d98dd7caa48d7fab9133fd66ec621f646ba522102e6d13812c";
const EXPECTED_ROW_DRAFTS_SHA256 =
  "2491897ea9d3eebd2d01c6ec0fa7d44cf13fb26747578d13ef91324896783c79";

const EXPECTED_TOP_LEVEL_KEYS = [
  "activation",
  "activation_contract",
  "approval_scope",
  "cp4_field_policy",
  "cp4_record_receipt_policy",
  "design_receipt",
  "evidence_missing_mapping",
  "evidence_used_mapping",
  "forbidden_evidence_derivation",
  "purpose",
  "render_destination_policy",
  "schema_version",
  "source_cohort",
  "source_preservation",
  "status_normalization",
  "target_contract",
  "unresolved_mapping_policy"
];

const EXPECTED_EXCLUSIONS = [
  "the_38_current_evidence_statuses",
  "the_workday_suspect_status_proposal",
  "any_used_fact",
  "any_missing_reason",
  "evidence_ids",
  "source_types",
  "labels",
  "row_edits",
  "cp4_itself",
  "model_calls",
  "spend",
  "publication",
  "push"
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

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function copyArtifact(sourceRoot, destinationRoot, artifact) {
  const destination = path.join(destinationRoot, ...artifact.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, ...artifact.split("/")), destination);
}

function requiredArtifacts({ includeRule = true, includeScenarios = true } = {}) {
  const artifacts = [
    "CP4_RECERTIFICATION_SCHEMA.json",
    "EVIDENCE_RENDER_SCHEMA.json",
    DESIGN_ARTIFACT
  ];
  if (includeRule) artifacts.push(LEGACY_MIGRATION_RULE_ARTIFACT);
  if (includeScenarios) {
    artifacts.push(...LEGACY_SCENARIO_IDS.map(
      (scenarioId) => `scenario-sets/steerbench-work-2026-05/${scenarioId}.json`
    ));
  }
  return artifacts;
}

function createScratchRoot(t, options) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sbw-legacy-rule-"));
  t.after(() => fs.rmSync(scratch, { force: true, recursive: true }));
  for (const artifact of requiredArtifacts(options)) copyArtifact(ROOT, scratch, artifact);
  return scratch;
}

test("legacy rule regeneration is deterministic, canonical, and byte-identical", () => {
  const first = buildLegacyMigrationRuleArtifact(ROOT);
  const second = buildLegacyMigrationRuleArtifact(ROOT);
  const committed = fs.readFileSync(RULE_PATH, "utf8");

  assert.equal(first.bytes, second.bytes);
  assert.equal(first.bytes, committed);
  assert.equal(first.receipt.sha256, EXPECTED_RULE_SHA256);
  assert.equal(sha256(Buffer.from(committed, "utf8")), EXPECTED_RULE_SHA256);
  assert.equal(committed.endsWith("\n"), true);
  assert.equal(committed.endsWith("\n\n"), false);
  assert.equal((committed.match(/\n$/u) ?? []).length, 1);
  assert.equal(serializeLegacyMigrationRule(JSON.parse(committed)), committed);
});

test("committed rule has the exact lifecycle and self-contained design binding", () => {
  const { rule, receipt } = loadAndValidateLegacyMigrationRule(ROOT);
  assert.equal(receipt.artifact, LEGACY_MIGRATION_RULE_ARTIFACT);
  assert.equal(receipt.sha256, EXPECTED_RULE_SHA256);
  assert.deepEqual(Object.keys(rule).sort(), [...EXPECTED_TOP_LEVEL_KEYS].sort());
  assert.equal(rule.schema_version, LEGACY_MIGRATION_RULE_SCHEMA_VERSION);
  assert.equal(rule.activation, LEGACY_MIGRATION_RULE_ACTIVATION);
  assert.deepEqual(rule.design_receipt, {
    artifact: DESIGN_ARTIFACT,
    sha256: EXPECTED_DESIGN_SHA256
  });
  assert.equal(
    sha256(fs.readFileSync(path.join(ROOT, DESIGN_ARTIFACT))),
    EXPECTED_DESIGN_SHA256
  );
  assert.equal(rule.activation_contract.self_claimed_approval, false);
  assert.equal(rule.activation_contract.separate_signature_envelope, false);
  for (const forbidden of [
    "status",
    "non_governing",
    "governance_effect",
    "signature_envelope",
    "required_owner_decisions"
  ]) {
    assert.equal(Object.hasOwn(rule, forbidden), false, forbidden);
  }
});

test("approval scope excludes every scientific and operational claim in ruling C", () => {
  const rule = buildLegacyMigrationRule(ROOT);
  assert.equal(rule.approval_scope.covers_only, "field_by_field_mapping_mechanics");
  assert.deepEqual(rule.approval_scope.excluded_certifications, EXPECTED_EXCLUSIONS);
  assert.deepEqual(rule.approval_scope.remaining_owner_decisions, [
    "recertify_evidence_statuses",
    "assign_evidence_ids_and_source_types",
    "supply_structured_evidence_payloads",
    "verify_missing_evidence_reasons",
    "complete_cp4_row_reviews",
    "approve_governing_cp4_artifact"
  ]);
  assert.equal(rule.status_normalization.length, 2);
  for (const normalization of rule.status_normalization) {
    assert.equal(normalization.proposal_only, true);
    assert.equal(normalization.fact_certified, false);
    assert.equal(normalization.owner_recertification_required, true);
  }
});

test("rule freezes the exact twelve renderable destinations and typed-field hierarchy", () => {
  const rule = buildLegacyMigrationRule(ROOT);
  const policy = rule.render_destination_policy;
  assert.equal(policy.exact_renderable_key_count, 12);
  assert.deepEqual(policy.exact_renderable_keys, LEGACY_RENDERABLE_DESTINATIONS);
  assert.deepEqual(Object.keys(policy.renderable_key_types).sort(), [
    ...LEGACY_RENDERABLE_DESTINATIONS
  ].sort());
  assert.equal(
    policy.per_entry_destination,
    "separate_per_entry_owner_recertification_required"
  );
  assert.equal(
    policy.typed_field_preference,
    "typed_fields_required_when_content_matches_a_typed_field"
  );
  assert.equal(policy.value_policy, "allowed_only_when_no_typed_field_fits");
  assert.equal(
    policy.tool_call_result_policy,
    "genuine_tool_call_payload_only_and_source_type_must_equal_tool_call"
  );
  assert.equal(policy.source_type_consistency, "required");
  assert.equal(policy.non_rendering_only_content, "forbidden");
  assert.equal(policy.schema_extension, "forbidden");
  assert.deepEqual(policy.forbidden_evidence_carriers, [
    "id",
    "legacy_id",
    "title",
    "raw_ref"
  ]);
});

test("rule binds the exact 11-ID cohort and every raw authored-row receipt", () => {
  const rule = buildLegacyMigrationRule(ROOT);
  assert.deepEqual(rule.source_cohort.scenario_ids, LEGACY_SCENARIO_IDS);
  assert.equal(rule.source_cohort.scenario_count, 11);
  assert.equal(rule.source_cohort.evidence_used_count, 39);
  assert.equal(rule.source_cohort.evidence_missing_count, 22);
  assert.equal(rule.source_cohort.source_receipts.length, 11);
  assert.deepEqual(
    rule.source_cohort.source_receipts.map((receipt) =>
      path.basename(receipt.artifact, ".json")),
    LEGACY_SCENARIO_IDS
  );
  for (const receipt of rule.source_cohort.source_receipts) {
    const scenarioId = path.basename(receipt.artifact, ".json");
    assert.equal(receipt.sha256, EXPECTED_SOURCE_HASHES[scenarioId]);
    assert.equal(
      sha256(fs.readFileSync(path.join(ROOT, ...receipt.artifact.split("/")))),
      receipt.sha256
    );
  }
  assert.deepEqual(
    rule.cp4_record_receipt_policy.complete_legacy_record_required_receipts,
    ["raw_authored_legacy_row", "exact_legacy_migration_rule_raw_bytes"]
  );
  assert.equal(rule.cp4_record_receipt_policy.non_cohort_rule_receipt, "forbidden");
  assert.equal(
    rule.cp4_record_receipt_policy.rule_receipt_artifact,
    LEGACY_MIGRATION_RULE_ARTIFACT
  );
});

test("the governing candidate preserves both review artifacts byte-for-byte", () => {
  assert.equal(
    sha256(fs.readFileSync(path.join(ROOT, "LEGACY_MIGRATION_RULE_DRAFT.json"))),
    EXPECTED_DRAFT_SHA256
  );
  assert.equal(
    sha256(fs.readFileSync(
      path.join(ROOT, "integrity-audit/v2-audit/cp4-drafts/legacy-row-drafts.json")
    )),
    EXPECTED_ROW_DRAFTS_SHA256
  );
});

test("validator fails closed on semantic, shape, receipt, and raw-byte mutations", () => {
  const mutations = [
    (rule) => { rule.activation = "already_approved"; },
    (rule) => { rule.signature_envelope = null; },
    (rule) => { rule.approval_scope.excluded_certifications.pop(); },
    (rule) => { rule.render_destination_policy.exact_renderable_keys[0] = "raw_ref"; },
    (rule) => { rule.source_cohort.source_receipts[0].sha256 = "0".repeat(64); },
    (rule) => { rule.status_normalization[0].fact_certified = true; }
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(buildLegacyMigrationRule(ROOT));
    mutate(candidate);
    assert.throws(
      () => validateLegacyMigrationRule(candidate, { repositoryRoot: ROOT }),
      /differs from the exact frozen candidate contract/u
    );
  }

  const candidate = buildLegacyMigrationRule(ROOT);
  const noncanonical = JSON.stringify(candidate);
  assert.throws(
    () => validateLegacyMigrationRule(candidate, {
      repositoryRoot: ROOT,
      rawBytes: noncanonical
    }),
    /raw bytes are not canonical deterministic JSON/u
  );
});

test("loader rejects a mutated authored-row source even when JSON remains valid", (t) => {
  const scratch = createScratchRoot(t);
  const firstSource = path.join(
    scratch,
    "scenario-sets/steerbench-work-2026-05",
    `${LEGACY_SCENARIO_IDS[0]}.json`
  );
  fs.appendFileSync(firstSource, "\n", "utf8");
  assert.throws(
    () => loadAndValidateLegacyMigrationRule(scratch),
    /raw SHA-256 changed/u
  );
});

test("loader rejects a final rule-file symlink", (t) => {
  const scratch = createScratchRoot(t, { includeRule: false });
  const target = path.join(scratch, "rule-target.json");
  fs.copyFileSync(RULE_PATH, target);
  fs.symlinkSync("rule-target.json", path.join(scratch, LEGACY_MIGRATION_RULE_ARTIFACT));
  assert.throws(
    () => loadAndValidateLegacyMigrationRule(scratch),
    /symlink paths are forbidden/u
  );
});

test("generator rejects a symlink target before writing any bytes", (t) => {
  const scratch = createScratchRoot(t, { includeRule: false });
  const victim = path.join(scratch, "victim.txt");
  const original = "must remain untouched\n";
  fs.writeFileSync(victim, original, "utf8");
  fs.symlinkSync("victim.txt", path.join(scratch, LEGACY_MIGRATION_RULE_ARTIFACT));

  assert.throws(
    () => generateLegacyMigrationRuleArtifact(scratch),
    /existing output target must not be a symlink/u
  );
  assert.equal(fs.readFileSync(victim, "utf8"), original);
});

test("generator rejects a non-regular output target", (t) => {
  const scratch = createScratchRoot(t, { includeRule: false });
  fs.mkdirSync(path.join(scratch, LEGACY_MIGRATION_RULE_ARTIFACT));
  assert.throws(
    () => generateLegacyMigrationRuleArtifact(scratch),
    /existing output target must be a regular file/u
  );
});

test("loader rejects an intermediate authored-source symlink", (t) => {
  const scratch = createScratchRoot(t, { includeScenarios: false });
  for (const scenarioId of LEGACY_SCENARIO_IDS) {
    const sourceArtifact = `scenario-sets/steerbench-work-2026-05/${scenarioId}.json`;
    const targetArtifact = `real-scenario-sets/steerbench-work-2026-05/${scenarioId}.json`;
    copyArtifact(ROOT, scratch, targetArtifact.replace("real-scenario-sets", "scenario-sets"));
    const copied = path.join(scratch, ...sourceArtifact.split("/"));
    const target = path.join(scratch, ...targetArtifact.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(copied, target);
  }
  fs.rmSync(path.join(scratch, "scenario-sets"), { force: true, recursive: true });
  fs.symlinkSync("real-scenario-sets", path.join(scratch, "scenario-sets"), "dir");
  assert.throws(
    () => loadAndValidateLegacyMigrationRule(scratch),
    /symlink paths are forbidden/u
  );
});
