#!/usr/bin/env node
// Generate an unsigned, non-governing migration-rule draft and row-draft
// bundle for the exact eleven legacy-format SteerBench scenarios. The
// generator is offline and fail-closed: it preserves source JSON and raw-byte
// receipts, but it never converts author labels or reference metadata into
// model-visible evidence or a CP4 reference decision.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CP4_SCHEMA_VERSION,
  createPendingCp4Recertification
} from "../src/cp4-recertification.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIO_DIRECTORY = "scenario-sets/steerbench-work-2026-05";
const RULE_ARTIFACT = "LEGACY_MIGRATION_RULE_DRAFT.json";
const DRAFTS_ARTIFACT = "integrity-audit/v2-audit/cp4-drafts/legacy-row-drafts.json";

export const LEGACY_DRAFT_STATUS = "draft_pending_owner_recertification";
export const LEGACY_SCENARIO_IDS = Object.freeze([
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
]);

const EXPECTED_COUNTS = Object.freeze({
  scenarios: 11,
  evidence_used: 39,
  evidence_missing: 22,
  source_status_current: 38,
  source_status_stale: 1
});

const REQUIRED_OWNER_DECISIONS = Object.freeze([
  {
    code: "approve_migration_rule",
    decision: "Approve or replace this frozen field-by-field migration rule before any live row changes."
  },
  {
    code: "recertify_evidence_statuses",
    decision: "Recertify every proposed evidence status, including the fail-closed stale-to-suspect treatment for Workday."
  },
  {
    code: "assign_evidence_ids_and_source_types",
    decision: "Assign owner-approved evidence IDs and source types; filenames and titles are not sufficient evidence."
  },
  {
    code: "supply_structured_evidence_payloads",
    decision: "Supply source-supported structured payloads or facts for used references; do not derive them from titles, paths, labels, or hidden notes."
  },
  {
    code: "verify_missing_evidence_reasons",
    decision: "Verify each preserved missing-evidence reason and decide whether it may become a source-supported absence rationale without inventing a tool result."
  },
  {
    code: "complete_cp4_row_reviews",
    decision: "Recertify proposed action, authority, warnings, reference decision and rationale, and prompt consistency against primary receipts."
  },
  {
    code: "sign_governing_cp4_artifact",
    decision: "Sign only a completed governing CP4 artifact; this draft bundle must remain unsigned and non-governing."
  }
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCodePointStrings(left, right) {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0);
    const rightPoint = rightPoints[index].codePointAt(0);
    if (leftPoint < rightPoint) return -1;
    if (leftPoint > rightPoint) return 1;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalize(value, location = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} must contain a finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => canonicalize(child, `${location}[${index}]`));
  }
  if (!isPlainObject(value)) throw new Error(`${location} must contain only JSON values`);
  const canonical = Object.create(null);
  for (const key of Object.keys(value).sort(compareCodePointStrings)) {
    canonical[key] = canonicalize(value[key], `${location}.${key}`);
  }
  return canonical;
}

/**
 * Serialize a JSON value with recursively code-point-sorted keys.
 *
 * @param {*} value JSON-compatible value.
 * @returns {string} Deterministic pretty-printed bytes with one final newline.
 */
export function canonicalDraftBytes(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function scenarioArtifact(scenarioId) {
  return `${SCENARIO_DIRECTORY}/${scenarioId}.json`;
}

function receiptFor(repositoryRoot, artifact) {
  const bytes = fs.readFileSync(path.join(repositoryRoot, artifact));
  return { artifact, sha256: sha256(bytes) };
}

function assertExactKeys(value, expectedKeys, location) {
  if (!isPlainObject(value)) throw new Error(`${location} must be an object`);
  const actual = Object.keys(value).sort(compareCodePointStrings);
  const expected = [...expectedKeys].sort(compareCodePointStrings);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${location} keys changed; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
}

function assertNonemptyString(value, location) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
}

function loadLegacySources(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw new Error("repositoryRoot must be an absolute path");
  }
  const rows = LEGACY_SCENARIO_IDS.map((scenarioId) => {
    const artifact = scenarioArtifact(scenarioId);
    const bytes = fs.readFileSync(path.join(repositoryRoot, artifact));
    const source = JSON.parse(bytes.toString("utf8"));
    if (!isPlainObject(source) || source.id !== scenarioId) {
      throw new Error(`${artifact} must contain the frozen scenario ID ${scenarioId}`);
    }
    if (!Array.isArray(source.evidence_used) || !Array.isArray(source.evidence_missing)) {
      throw new Error(`${artifact} must retain both legacy evidence arrays`);
    }
    source.evidence_used.forEach((item, index) => {
      const location = `${artifact}.evidence_used[${index}]`;
      assertExactKeys(item, ["step", "src", "title", "status"], location);
      if (!Number.isInteger(item.step) || item.step < 0) {
        throw new Error(`${location}.step must be a non-negative integer`);
      }
      assertNonemptyString(item.src, `${location}.src`);
      assertNonemptyString(item.title, `${location}.title`);
      if (!["current", "stale"].includes(item.status)) {
        throw new Error(`${location}.status has no frozen draft normalization`);
      }
    });
    source.evidence_missing.forEach((item, index) => {
      const location = `${artifact}.evidence_missing[${index}]`;
      assertExactKeys(item, ["src", "reason"], location);
      assertNonemptyString(item.src, `${location}.src`);
      assertNonemptyString(item.reason, `${location}.reason`);
    });
    return {
      scenarioId,
      artifact,
      bytes,
      receipt: { artifact, sha256: sha256(bytes) },
      source
    };
  });

  const used = rows.flatMap((row) => row.source.evidence_used);
  const missing = rows.flatMap((row) => row.source.evidence_missing);
  const current = used.filter((item) => item.status === "current").length;
  const stale = used.filter((item) => item.status === "stale").length;
  if (rows.length !== EXPECTED_COUNTS.scenarios
    || used.length !== EXPECTED_COUNTS.evidence_used
    || missing.length !== EXPECTED_COUNTS.evidence_missing
    || current !== EXPECTED_COUNTS.source_status_current
    || stale !== EXPECTED_COUNTS.source_status_stale) {
    throw new Error("legacy cohort counts changed from the frozen 11/39/22 and 38-current/1-stale census");
  }
  const staleLocations = rows.flatMap((row) => row.source.evidence_used
    .map((item, index) => ({ scenarioId: row.scenarioId, index, status: item.status })))
    .filter((item) => item.status === "stale");
  if (staleLocations.length !== 1
    || staleLocations[0].scenarioId !== "workday-applicant-auto-reject-realworld-009"
    || staleLocations[0].index !== 0) {
    throw new Error("the frozen stale status must remain Workday evidence_used[0]");
  }
  return rows;
}

function scenarioIdsSha256() {
  return sha256(Buffer.from(JSON.stringify(LEGACY_SCENARIO_IDS), "utf8"));
}

/**
 * Build the unsigned non-governing legacy migration-rule draft.
 *
 * @param {string} [repositoryRoot] Absolute SteerBench repository root.
 * @returns {object} Migration-rule draft.
 */
export function buildLegacyMigrationRuleDraft(repositoryRoot = ROOT) {
  const sources = loadLegacySources(repositoryRoot);
  return {
    schema_version: "steerbench.cp4_legacy_migration_rule_draft.v1",
    status: LEGACY_DRAFT_STATUS,
    non_governing: true,
    governance_effect: "none",
    purpose: "Preserve the exact legacy source rows and expose unresolved CP4 mappings for owner recertification without changing live scenarios.",
    target_contract: {
      cp4_schema_version: CP4_SCHEMA_VERSION,
      cp4_schema_receipt: receiptFor(repositoryRoot, "CP4_RECERTIFICATION_SCHEMA.json"),
      evidence_render_schema_receipt: receiptFor(repositoryRoot, "EVIDENCE_RENDER_SCHEMA.json")
    },
    source_cohort: {
      selection: "explicit_scenario_id_allowlist_only",
      scenario_count: EXPECTED_COUNTS.scenarios,
      scenario_ids: [...LEGACY_SCENARIO_IDS],
      scenario_ids_sha256: scenarioIdsSha256(),
      evidence_used_count: EXPECTED_COUNTS.evidence_used,
      evidence_missing_count: EXPECTED_COUNTS.evidence_missing,
      source_receipts: sources.map((source) => source.receipt)
    },
    source_preservation: {
      parsed_json_snapshot: "preserve_every_source_field_and_value_exactly",
      raw_source_binding: "sha256_of_raw_file_bytes",
      receipt_scope: "authored_v1_row_bytes_only_not_external_fact_verification",
      unknown_legacy_evidence_field_behavior: "fail_closed",
      source_mutation: "forbidden"
    },
    forbidden_evidence_derivation: {
      fields: [
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
      ],
      treatment: "These values may be preserved in the archival source snapshot or non-rendered reference metadata, but may not populate model-visible evidence, structured evidence payloads, warnings, reference decisions, or reference rationales.",
      title_and_raw_ref_metadata: {
        preserved: true,
        model_visible: false,
        evidentiary_value: false
      }
    },
    evidence_used_mapping: {
      step: "preserve_as_legacy_selection_step_only",
      src: "preserve_as_non_evidentiary_raw_ref_metadata_only",
      title: "preserve_as_non_evidentiary_title_metadata_only",
      status: "apply_status_normalization_then_require_owner_recertification",
      evidence_id: "unresolved",
      source_type: "unresolved",
      structured_payload: "unresolved",
      model_visible_fact: "unresolved",
      unresolved_outcome: "block_row"
    },
    evidence_missing_mapping: {
      src: "preserve_as_non_evidentiary_raw_ref_metadata_only",
      reason: "preserve_verbatim_as_authored_missing_reason_not_as_observed_tool_result",
      proposed_status: "missing",
      tool_call_result: null,
      model_visible_absence_rationale: "unresolved_pending_owner_verification",
      unresolved_outcome: "block_row"
    },
    status_normalization: [
      {
        source_status: "current",
        proposed_status: "current",
        fail_closed: false,
        owner_recertification_required: true,
        rationale: "The draft preserves the authored status spelling but does not certify its truth."
      },
      {
        source_status: "stale",
        proposed_status: "suspect",
        fail_closed: true,
        owner_recertification_required: true,
        rationale: "The render contract has no stale value; suspect is the conservative proposed treatment and cannot become governing without owner approval."
      }
    ],
    cp4_field_policy: {
      source_receipts: "bind_only_the_raw_authored_legacy_row",
      proposed_action: "null_until_owner_recertifies_actor_principal_operation_target_and_scope",
      ordinary_authority: "null_until_owner_recertifies",
      exceptional_authority: "null_until_owner_recertifies",
      model_visible_evidence: "null_until_all_selected_evidence_has_source_supported_structured_content",
      warning_basis: "null_until_owner_recertifies_without_labels_or_hidden_notes",
      reference_decision: "null_never_copy_expected_behavior_correct_action",
      reference_rationale: "null_never_copy_expected_steering_or_hidden_trap",
      prompt_reference_review: "null_until_owner_recertifies",
      signature_envelope: null
    },
    unresolved_mapping_policy: {
      machine_visible: true,
      blocked: true,
      required_fields: [
        "evidence_id",
        "source_type",
        "structured_evidence_payload_or_source_supported_fact",
        "owner_recertified_status",
        "owner_verified_missing_evidence_disposition",
        "complete_cp4_row_review"
      ],
      outcome: "draft_remains_non_governing_and_ineligible_for_live_row_replacement"
    },
    required_owner_decisions: REQUIRED_OWNER_DECISIONS.map((item) => ({ ...item })),
    signature_envelope: null
  };
}

function statusNormalization(sourceStatus) {
  if (sourceStatus === "current") {
    return {
      source_status: "current",
      proposed_status: "current",
      fail_closed: false,
      owner_recertification_required: true
    };
  }
  return {
    source_status: "stale",
    proposed_status: "suspect",
    fail_closed: true,
    owner_recertification_required: true
  };
}

function usedEvidenceDraft(item, index) {
  const normalization = statusNormalization(item.status);
  const blockers = [
    {
      code: "evidence_id_unresolved",
      field: "proposed_evidence_id",
      owner_action: "Assign an owner-approved evidence ID and update the governing ID map separately."
    },
    {
      code: "source_type_unresolved",
      field: "proposed_source_type",
      owner_action: "Classify the source from an inspected artifact; do not infer it from the filename extension alone."
    },
    {
      code: "structured_evidence_payload_unresolved",
      field: "structured_payload",
      owner_action: "Supply source-supported structured content; title and raw_ref are not evidence facts."
    },
    {
      code: "evidence_status_owner_recertification_required",
      field: "status_normalization.proposed_status",
      owner_action: "Approve or replace the proposed status against a primary receipt."
    }
  ];
  if (normalization.fail_closed) {
    blockers.push({
      code: "stale_status_fail_closed_owner_decision_required",
      field: "status_normalization.proposed_status",
      owner_action: "Approve suspect, replace it with a source-supported allowed status, or exclude the reference."
    });
  }
  return {
    draft_status: LEGACY_DRAFT_STATUS,
    source_index: index,
    legacy_selection_step: item.step,
    non_evidentiary_metadata: {
      raw_ref: item.src,
      title: item.title,
      model_visible: false,
      evidentiary_value: false
    },
    status_normalization: normalization,
    proposed_evidence_id: null,
    proposed_source_type: null,
    structured_payload: null,
    model_visible_fact: null,
    renderable_evidence: null,
    blockers
  };
}

function missingEvidenceDraft(item, index) {
  return {
    draft_status: LEGACY_DRAFT_STATUS,
    source_index: index,
    non_evidentiary_metadata: {
      raw_ref: item.src,
      model_visible: false,
      evidentiary_value: false
    },
    preserved_reason: item.reason,
    reason_provenance: "authored_v1_missing_reason_not_observed_tool_result",
    proposed_status: "missing",
    tool_call_result: null,
    model_visible_absence_rationale: null,
    renderable_evidence: null,
    blockers: [
      {
        code: "missing_evidence_owner_verification_required",
        field: "preserved_reason",
        owner_action: "Verify the absence against a primary receipt before using it as model-visible rationale."
      },
      {
        code: "missing_evidence_disposition_unresolved",
        field: "model_visible_absence_rationale",
        owner_action: "Decide whether to retain, replace, or remove this missing-evidence requirement."
      }
    ]
  };
}

function cp4RecordShells() {
  return new Map(createPendingCp4Recertification().records
    .map((record) => [record.scenario_id, record]));
}

function recordBlockers(usedDrafts, missingDrafts) {
  const codes = new Set([
    "cp4_proposed_action_unresolved",
    "cp4_authority_review_unresolved",
    "cp4_model_visible_evidence_unresolved",
    "cp4_warning_basis_unresolved",
    "cp4_reference_decision_unresolved",
    "cp4_prompt_reference_review_unresolved"
  ]);
  for (const draft of [...usedDrafts, ...missingDrafts]) {
    for (const blocker of draft.blockers) codes.add(blocker.code);
  }
  return [...codes].sort(compareCodePointStrings);
}

/**
 * Build the unsigned non-governing eleven-row CP4 migration draft bundle.
 *
 * @param {object} [options] Build options.
 * @param {string} [options.repositoryRoot] Absolute SteerBench repository root.
 * @param {object} [options.ruleDraft] Rule draft to bind into the bundle.
 * @returns {object} Legacy row-draft bundle.
 */
export function buildLegacyRowDraftBundle({
  repositoryRoot = ROOT,
  ruleDraft = buildLegacyMigrationRuleDraft(repositoryRoot)
} = {}) {
  const sources = loadLegacySources(repositoryRoot);
  const shells = cp4RecordShells();
  const ruleBytes = canonicalDraftBytes(ruleDraft);
  const records = sources.map((source) => {
    const usedDrafts = source.source.evidence_used.map(usedEvidenceDraft);
    const missingDrafts = source.source.evidence_missing.map(missingEvidenceDraft);
    const shell = structuredClone(shells.get(source.scenarioId));
    if (!shell) throw new Error(`CP4 schema has no record shell for ${source.scenarioId}`);
    shell.source_receipts = [source.receipt];
    return {
      scenario_id: source.scenarioId,
      status: LEGACY_DRAFT_STATUS,
      non_governing: true,
      blocked: true,
      source_receipt: source.receipt,
      v1_source_snapshot: structuredClone(source.source),
      evidence_used_count: usedDrafts.length,
      evidence_missing_count: missingDrafts.length,
      evidence_used_drafts: usedDrafts,
      evidence_missing_drafts: missingDrafts,
      cp4_record_draft: shell,
      blocking_codes: recordBlockers(usedDrafts, missingDrafts),
      signature_envelope: null
    };
  });

  return {
    schema_version: "steerbench.cp4_legacy_row_drafts.v1",
    status: LEGACY_DRAFT_STATUS,
    non_governing: true,
    governance_effect: "none",
    migration_rule_receipt: {
      artifact: RULE_ARTIFACT,
      sha256: sha256(Buffer.from(ruleBytes, "utf8"))
    },
    target_cp4_schema_receipt: receiptFor(repositoryRoot, "CP4_RECERTIFICATION_SCHEMA.json"),
    target_evidence_render_schema_receipt: receiptFor(repositoryRoot, "EVIDENCE_RENDER_SCHEMA.json"),
    scenario_count: EXPECTED_COUNTS.scenarios,
    scenario_ids: [...LEGACY_SCENARIO_IDS],
    scenario_ids_sha256: scenarioIdsSha256(),
    evidence_used_count: EXPECTED_COUNTS.evidence_used,
    evidence_missing_count: EXPECTED_COUNTS.evidence_missing,
    blocked_record_count: records.length,
    records,
    required_owner_decisions: REQUIRED_OWNER_DECISIONS.map((item) => ({ ...item })),
    signature_envelope: null
  };
}

/**
 * Generate both deterministic committed-artifact byte strings in memory.
 *
 * @param {string} [repositoryRoot] Absolute SteerBench repository root.
 * @returns {{ruleDraft: object, ruleBytes: string, rowDraftBundle: object, rowDraftBytes: string}}
 *   Generated values and canonical bytes.
 */
export function generateCp4LegacyDraftArtifacts(repositoryRoot = ROOT) {
  const ruleDraft = buildLegacyMigrationRuleDraft(repositoryRoot);
  const rowDraftBundle = buildLegacyRowDraftBundle({ repositoryRoot, ruleDraft });
  return {
    ruleDraft,
    ruleBytes: canonicalDraftBytes(ruleDraft),
    rowDraftBundle,
    rowDraftBytes: canonicalDraftBytes(rowDraftBundle)
  };
}

/**
 * Write both legacy draft artifacts to explicit destinations.
 *
 * @param {object} options Write options.
 * @param {string} options.ruleOutPath Migration-rule output path.
 * @param {string} options.draftsOutPath Row-draft bundle output path.
 * @param {string} [options.repositoryRoot] Absolute SteerBench repository root.
 * @returns {ReturnType<typeof generateCp4LegacyDraftArtifacts>} Generated values.
 */
export function writeCp4LegacyDraftArtifacts({
  ruleOutPath,
  draftsOutPath,
  repositoryRoot = ROOT
}) {
  assertNonemptyString(ruleOutPath, "ruleOutPath");
  assertNonemptyString(draftsOutPath, "draftsOutPath");
  const generated = generateCp4LegacyDraftArtifacts(repositoryRoot);
  const resolvedRuleOut = path.resolve(ruleOutPath);
  const resolvedDraftsOut = path.resolve(draftsOutPath);
  fs.mkdirSync(path.dirname(resolvedRuleOut), { recursive: true });
  fs.mkdirSync(path.dirname(resolvedDraftsOut), { recursive: true });
  fs.writeFileSync(resolvedRuleOut, generated.ruleBytes);
  fs.writeFileSync(resolvedDraftsOut, generated.rowDraftBytes);
  return generated;
}

function parseArguments(argv) {
  const values = { ruleOutPath: null, draftsOutPath: null };
  const mapping = new Map([
    ["--rule-out", "ruleOutPath"],
    ["--drafts-out", "draftsOutPath"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = mapping.get(argument);
    if (!key) throw new Error(`unknown argument ${argument}`);
    if (values[key] !== null) throw new Error(`duplicate argument ${argument}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values[key] = value;
  }
  if (values.ruleOutPath === null) throw new Error("--rule-out <file> is required");
  if (values.draftsOutPath === null) throw new Error("--drafts-out <file> is required");
  return values;
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const generated = writeCp4LegacyDraftArtifacts(options);
    process.stdout.write(
      `wrote ${RULE_ARTIFACT} and ${DRAFTS_ARTIFACT}: `
      + `${generated.rowDraftBundle.scenario_count} blocked legacy drafts\n`
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
