// Deterministic construction and fail-closed validation for the owner-approval
// candidate that governs migration mechanics for the exact CP4 legacy cohort.
// This module never reads files at import time and never claims owner approval.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIO_DIRECTORY = "scenario-sets/steerbench-work-2026-05";
const SHA256_RE = /^[0-9a-f]{64}$/u;
const DRIVE_RELATIVE_RE = /^[A-Za-z]:/u;

export const LEGACY_MIGRATION_RULE_ARTIFACT = "LEGACY_MIGRATION_RULE.json";
export const LEGACY_MIGRATION_RULE_SCHEMA_VERSION =
  "steerbench.cp4_legacy_migration_rule.v1";
export const LEGACY_MIGRATION_RULE_ACTIVATION =
  "owner_approval_of_exact_raw_sha256_required_before_use";

export const LEGACY_SCENARIO_IDS = deepFreeze([
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

export const LEGACY_RENDERABLE_DESTINATIONS = deepFreeze([
  "amount_usd",
  "approval_threshold_usd",
  "effective_from",
  "effective_until",
  "evaluation_provenance",
  "protected_path_match",
  "source_type",
  "status",
  "supervisor_approval_threshold_months",
  "timezone",
  "tool_call_result",
  "value"
]);

const EXPECTED_SOURCE_HASHES = deepFreeze({
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
});

const EXPECTED_COUNTS = deepFreeze({
  evidence_missing: 22,
  evidence_used: 39,
  scenarios: 11,
  source_status_current: 38,
  source_status_stale: 1
});

const EXPECTED_CP4_SCHEMA = deepFreeze({
  artifact: "CP4_RECERTIFICATION_SCHEMA.json",
  schema_version: "steerbench.cp4_recertification.v1",
  sha256: "ec8e78cc9cbfba66770f67b464b423df90533da448b7b31aa9fc3ade902650c6"
});

const EXPECTED_EVIDENCE_RENDER_SCHEMA = deepFreeze({
  artifact: "EVIDENCE_RENDER_SCHEMA.json",
  schema_version: "steerbench.evidence-render.v1",
  sha256: "3d1eeafe11be9d078d735f6f2e002b7799285256c94b8553253cde2e03d131b2"
});

const EXPECTED_DESIGN = deepFreeze({
  artifact: "integrity-audit/v2-audit/LEGACY_MIGRATION_RULE_DESIGN.md",
  sha256: "6506ec9a1cacb9853defcab0e7abd90cca8b52d4e80cf47968d40cb856abccd9"
});

const RENDERABLE_KEY_TYPES = deepFreeze({
  amount_usd: "number",
  approval_threshold_usd: "number",
  effective_from: "date_string_yyyy_mm_dd",
  effective_until: "date_string_yyyy_mm_dd",
  evaluation_provenance: "object_matching_evidence_render_schema",
  protected_path_match: "boolean",
  source_type: "enum_string",
  status: "enum_string",
  supervisor_approval_threshold_months: "integer",
  timezone: "nonempty_string",
  tool_call_result: "object",
  value: "number_or_string"
});

const APPROVAL_EXCLUSIONS = deepFreeze([
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
]);

const REMAINING_OWNER_DECISIONS = deepFreeze([
  "recertify_evidence_statuses",
  "assign_evidence_ids_and_source_types",
  "supply_structured_evidence_payloads",
  "verify_missing_evidence_reasons",
  "complete_cp4_row_reviews",
  "approve_governing_cp4_artifact"
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCodePointStrings(left, right) {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const limit = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < limit; index += 1) {
    const leftCodePoint = leftPoints[index].codePointAt(0);
    const rightCodePoint = rightPoints[index].codePointAt(0);
    if (leftCodePoint < rightCodePoint) return -1;
    if (leftCodePoint > rightCodePoint) return 1;
  }
  return leftPoints.length - rightPoints.length;
}

function validateJsonValue(value, location) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${location} must contain only finite JSON numbers`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error(`${location} must not contain sparse arrays`);
      }
      validateJsonValue(value[index], `${location}[${index}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      validateJsonValue(child, `${location}.${key}`);
    }
    return;
  }
  throw new Error(`${location} must contain only JSON values`);
}

function canonicalize(value, location = "value") {
  validateJsonValue(value, location);
  if (Array.isArray(value)) {
    return value.map((child, index) => canonicalize(child, `${location}[${index}]`));
  }
  if (!isPlainObject(value)) return value;
  const canonical = Object.create(null);
  for (const key of Object.keys(value).sort(compareCodePointStrings)) {
    canonical[key] = canonicalize(value[key], `${location}.${key}`);
  }
  return canonical;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
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

function assertRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw new Error("repositoryRoot must be an absolute path");
  }
  const stats = fs.statSync(repositoryRoot);
  if (!stats.isDirectory()) throw new Error("repositoryRoot must be a directory");
}

function assertCanonicalArtifactPath(artifact, location) {
  assertNonemptyString(artifact, location);
  if (path.posix.isAbsolute(artifact)
    || path.win32.isAbsolute(artifact)
    || DRIVE_RELATIVE_RE.test(artifact)
    || artifact.includes("\\")) {
    throw new Error(`${location} must be a canonical repository-relative path`);
  }
  const segments = artifact.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${location} contains a non-canonical path segment`);
  }
  if (path.posix.normalize(artifact) !== artifact) {
    throw new Error(`${location} must be a canonical repository-relative path`);
  }
}

function readRepositoryFile(repositoryRoot, artifact) {
  assertRepositoryRoot(repositoryRoot);
  assertCanonicalArtifactPath(artifact, "artifact");
  const rootRealPath = fs.realpathSync(repositoryRoot);
  if (!fs.statSync(rootRealPath).isDirectory()) {
    throw new Error("repositoryRoot must resolve to a directory");
  }
  const rootPrefix = rootRealPath.endsWith(path.sep)
    ? rootRealPath
    : `${rootRealPath}${path.sep}`;
  const segments = artifact.split("/");
  let currentPath = rootRealPath;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      currentPath = path.join(currentPath, segments[index]);
      const stats = fs.lstatSync(currentPath);
      if (stats.isSymbolicLink()) throw new Error("symlink paths are forbidden");
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw new Error("an intermediate path is not a directory");
      }
      if (index === segments.length - 1 && !stats.isFile()) {
        throw new Error("artifact target is not a regular file");
      }
    }
  } catch (error) {
    throw new Error(`${artifact} cannot resolve to a regular non-symlink file: ${error.message}`);
  }
  if (!currentPath.startsWith(rootPrefix)) {
    throw new Error(`${artifact} resolves outside repositoryRoot`);
  }

  let descriptor;
  try {
    if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
      throw new Error("this platform does not expose O_NOFOLLOW");
    }
    descriptor = fs.openSync(
      currentPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const openedStats = fs.fstatSync(descriptor);
    if (!openedStats.isFile()) throw new Error("opened artifact is not a regular file");
    const pathStats = fs.statSync(currentPath);
    if (pathStats.dev !== openedStats.dev || pathStats.ino !== openedStats.ino) {
      throw new Error("artifact path changed while it was being opened");
    }
    const openedPath = fs.realpathSync(currentPath);
    if (!openedPath.startsWith(rootPrefix)) {
      throw new Error("opened artifact resolves outside repositoryRoot");
    }
    return fs.readFileSync(descriptor);
  } catch (error) {
    throw new Error(`${artifact} cannot be opened as a stable non-symlink file: ${error.message}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseJsonBytes(bytes, artifact) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${artifact} must contain valid JSON: ${error.message}`);
  }
}

function readPinnedJson(repositoryRoot, expected) {
  const bytes = readRepositoryFile(repositoryRoot, expected.artifact);
  const actualHash = sha256(bytes);
  if (actualHash !== expected.sha256) {
    throw new Error(
      `${expected.artifact} raw SHA-256 changed; expected ${expected.sha256}, received ${actualHash}`
    );
  }
  const value = parseJsonBytes(bytes, expected.artifact);
  const actualSchemaVersion = value?.schema_version
    ?? value?.properties?.schema_version?.const;
  if (!isPlainObject(value) || actualSchemaVersion !== expected.schema_version) {
    throw new Error(`${expected.artifact} schema_version changed`);
  }
  return { bytes, value };
}

function scenarioArtifact(scenarioId) {
  return `${SCENARIO_DIRECTORY}/${scenarioId}.json`;
}

function loadLegacySources(repositoryRoot) {
  const rows = LEGACY_SCENARIO_IDS.map((scenarioId) => {
    const artifact = scenarioArtifact(scenarioId);
    const bytes = readRepositoryFile(repositoryRoot, artifact);
    const actualHash = sha256(bytes);
    if (actualHash !== EXPECTED_SOURCE_HASHES[scenarioId]) {
      throw new Error(
        `${artifact} raw SHA-256 changed; expected ${EXPECTED_SOURCE_HASHES[scenarioId]}, received ${actualHash}`
      );
    }
    const source = parseJsonBytes(bytes, artifact);
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
      if (item.status !== "current" && item.status !== "stale") {
        throw new Error(`${location}.status has no frozen migration normalization`);
      }
    });
    source.evidence_missing.forEach((item, index) => {
      const location = `${artifact}.evidence_missing[${index}]`;
      assertExactKeys(item, ["src", "reason"], location);
      assertNonemptyString(item.src, `${location}.src`);
      assertNonemptyString(item.reason, `${location}.reason`);
    });
    return {
      receipt: { artifact, sha256: actualHash },
      scenarioId,
      source
    };
  });

  const used = rows.flatMap((row) => row.source.evidence_used);
  const missing = rows.flatMap((row) => row.source.evidence_missing);
  const current = used.filter((item) => item.status === "current");
  const stale = used.filter((item) => item.status === "stale");
  if (rows.length !== EXPECTED_COUNTS.scenarios
    || used.length !== EXPECTED_COUNTS.evidence_used
    || missing.length !== EXPECTED_COUNTS.evidence_missing
    || current.length !== EXPECTED_COUNTS.source_status_current
    || stale.length !== EXPECTED_COUNTS.source_status_stale) {
    throw new Error("legacy cohort changed from the frozen 11/39/22 and 38-current/1-stale census");
  }

  const staleLocations = rows.flatMap((row) => row.source.evidence_used
    .map((item, index) => ({ index, scenarioId: row.scenarioId, status: item.status })))
    .filter((item) => item.status === "stale");
  if (staleLocations.length !== 1
    || staleLocations[0].scenarioId !== "workday-applicant-auto-reject-realworld-009"
    || staleLocations[0].index !== 0) {
    throw new Error("the frozen stale status must remain Workday evidence_used[0]");
  }
  return rows;
}

function validateEvidenceRenderContract(schema) {
  assertExactKeys(
    schema,
    ["schema_version", "fence_language", "generated_fields", "source_record"],
    EXPECTED_EVIDENCE_RENDER_SCHEMA.artifact
  );
  const properties = schema.source_record?.properties;
  if (!isPlainObject(properties)) {
    throw new Error("EVIDENCE_RENDER_SCHEMA.json source_record.properties must be an object");
  }
  const actualRenderable = Object.entries(properties)
    .filter(([, property]) => isPlainObject(property) && property.render === true)
    .map(([key]) => key)
    .sort(compareCodePointStrings);
  if (JSON.stringify(actualRenderable) !== JSON.stringify(LEGACY_RENDERABLE_DESTINATIONS)) {
    throw new Error("EVIDENCE_RENDER_SCHEMA.json must retain the exact twelve renderable keys");
  }
  for (const forbidden of ["id", "legacy_id", "title", "raw_ref"]) {
    if (!isPlainObject(properties[forbidden]) || properties[forbidden].render !== false) {
      throw new Error(`EVIDENCE_RENDER_SCHEMA.json source_record.properties.${forbidden} must remain non-rendering`);
    }
  }
}

function scenarioIdsSha256() {
  return sha256(Buffer.from(JSON.stringify(LEGACY_SCENARIO_IDS), "utf8"));
}

/**
 * Build the self-contained legacy migration-rule candidate from pinned inputs.
 *
 * @param {string} [repositoryRoot] Absolute SteerBench repository root.
 * @returns {object} Exact rule candidate. The object does not claim approval.
 */
export function buildLegacyMigrationRule(repositoryRoot = ROOT) {
  assertRepositoryRoot(repositoryRoot);
  const cp4Schema = readPinnedJson(repositoryRoot, EXPECTED_CP4_SCHEMA);
  const evidenceSchema = readPinnedJson(repositoryRoot, EXPECTED_EVIDENCE_RENDER_SCHEMA);
  const designBytes = readRepositoryFile(repositoryRoot, EXPECTED_DESIGN.artifact);
  const designHash = sha256(designBytes);
  if (designHash !== EXPECTED_DESIGN.sha256) {
    throw new Error(
      `${EXPECTED_DESIGN.artifact} raw SHA-256 changed; expected ${EXPECTED_DESIGN.sha256}, received ${designHash}`
    );
  }
  validateEvidenceRenderContract(evidenceSchema.value);
  const sources = loadLegacySources(repositoryRoot);

  return {
    schema_version: LEGACY_MIGRATION_RULE_SCHEMA_VERSION,
    activation: LEGACY_MIGRATION_RULE_ACTIVATION,
    activation_contract: {
      authority_record: "VALIDATION_PLAN.md",
      approval_record_cardinality: "exactly_one_matching_record",
      approval_record_format: "approval_record artifact=LEGACY_MIGRATION_RULE.json sha256=<64 lowercase hex> approved_on=YYYY-MM-DD role=scientific_owner",
      approval_statement_storage: "private_session_record_only_not_repository",
      effective_when: "exact_neutral_plan_record_binds_raw_sha256_real_date_and_scientific_owner_role",
      change_control: "any_raw_byte_change_requires_a_new_hash_and_new_plan_approval_record",
      self_claimed_approval: false,
      separate_signature_envelope: false
    },
    purpose: "Govern only the field-by-field mechanics for migrating the exact eleven legacy source rows into CP4 without certifying any row content.",
    design_receipt: {
      artifact: EXPECTED_DESIGN.artifact,
      sha256: designHash
    },
    approval_scope: {
      covers_only: "field_by_field_mapping_mechanics",
      excluded_certifications: [...APPROVAL_EXCLUSIONS],
      remaining_owner_decisions: [...REMAINING_OWNER_DECISIONS]
    },
    target_contract: {
      cp4_schema_version: EXPECTED_CP4_SCHEMA.schema_version,
      cp4_schema_receipt: {
        artifact: EXPECTED_CP4_SCHEMA.artifact,
        sha256: sha256(cp4Schema.bytes)
      },
      evidence_render_schema_receipt: {
        artifact: EXPECTED_EVIDENCE_RENDER_SCHEMA.artifact,
        sha256: sha256(evidenceSchema.bytes)
      }
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
      source_mutation: "forbidden",
      unknown_legacy_evidence_field_behavior: "fail_closed"
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
    render_destination_policy: {
      exact_renderable_key_count: LEGACY_RENDERABLE_DESTINATIONS.length,
      exact_renderable_keys: [...LEGACY_RENDERABLE_DESTINATIONS],
      renderable_key_types: { ...RENDERABLE_KEY_TYPES },
      per_entry_destination: "separate_per_entry_owner_recertification_required",
      source_receipt_requirement: "destination_content_must_be_backed_by_source_receipts",
      source_type_consistency: "required",
      type_consistency: "destination_value_must_conform_to_the_frozen_renderable_key_type",
      typed_field_preference: "typed_fields_required_when_content_matches_a_typed_field",
      value_policy: "allowed_only_when_no_typed_field_fits",
      tool_call_result_policy: "genuine_tool_call_payload_only_and_source_type_must_equal_tool_call",
      non_rendering_only_content: "forbidden",
      schema_extension: "forbidden",
      forbidden_evidence_carriers: ["id", "legacy_id", "title", "raw_ref"]
    },
    evidence_used_mapping: {
      step: "preserve_as_legacy_selection_step_only",
      src: "preserve_as_non_evidentiary_raw_ref_metadata_only",
      title: "preserve_as_non_evidentiary_title_metadata_only",
      status: "apply_status_normalization_then_require_owner_recertification",
      evidence_id: "unresolved_until_separate_per_entry_owner_recertification",
      source_type: "unresolved_until_separate_per_entry_owner_recertification",
      structured_payload: "separate_per_entry_owner_recertification_of_renderable_destination_required",
      model_visible_fact: "source_supported_content_required_in_a_renderable_destination",
      source_receipts: "required_for_each_selected_entry",
      unresolved_outcome: "block_row"
    },
    evidence_missing_mapping: {
      src: "preserve_as_non_evidentiary_raw_ref_metadata_only",
      reason: "preserve_verbatim_as_authored_missing_reason_not_as_observed_tool_result",
      proposed_status: "missing",
      tool_call_result: null,
      model_visible_absence_rationale: "separate_per_entry_owner_recertification_of_source_supported_renderable_destination_required",
      unresolved_outcome: "block_row"
    },
    status_normalization: [
      {
        source_status: "current",
        proposed_status: "current",
        fail_closed: false,
        owner_recertification_required: true,
        proposal_only: true,
        fact_certified: false,
        rationale: "The mechanic preserves the authored status spelling but does not certify any of the 38 current statuses as true."
      },
      {
        source_status: "stale",
        proposed_status: "suspect",
        fail_closed: true,
        owner_recertification_required: true,
        proposal_only: true,
        fact_certified: false,
        rationale: "The render contract has no stale value; suspect is a conservative proposal for Workday evidence_used[0], not a certified fact."
      }
    ],
    cp4_field_policy: {
      source_receipts: "bind_raw_authored_legacy_row_and_exact_legacy_migration_rule_raw_bytes",
      proposed_action: "null_until_owner_recertifies_actor_principal_operation_target_and_scope",
      ordinary_authority: "null_until_owner_recertifies",
      exceptional_authority: "null_until_owner_recertifies",
      model_visible_evidence: "null_until_all_selected_evidence_has_source_supported_structured_content",
      warning_basis: "null_until_owner_recertifies_without_labels_or_hidden_notes",
      reference_decision: "null_never_copy_expected_behavior_correct_action",
      reference_rationale: "null_never_copy_expected_steering_or_hidden_trap",
      prompt_reference_review: "null_until_owner_recertifies"
    },
    cp4_record_receipt_policy: {
      authored_row_receipt: "exact_source_cohort_receipt_for_the_record_scenario_id",
      complete_legacy_record_required_receipts: [
        "raw_authored_legacy_row",
        "exact_legacy_migration_rule_raw_bytes"
      ],
      cohort_matching: "exact_scenario_id_membership_not_count",
      non_cohort_rule_receipt: "forbidden",
      pending_blank_shells: "valid_without_legacy_receipts_until_complete",
      rule_receipt_artifact: LEGACY_MIGRATION_RULE_ARTIFACT,
      rule_receipt_sha256: "sha256_of_exact_raw_rule_bytes_recorded_with_owner_approval"
    },
    unresolved_mapping_policy: {
      blocked: true,
      machine_visible: true,
      required_fields: [
        "evidence_id",
        "source_type",
        "owner_approved_renderable_destination",
        "structured_evidence_payload_or_source_supported_fact",
        "owner_recertified_status",
        "owner_verified_missing_evidence_disposition",
        "complete_cp4_row_review"
      ],
      outcome: "row_completion_blocked_until_all_required_owner_decisions_and_receipts_exist"
    }
  };
}

/**
 * Serialize a legacy migration rule with recursively code-point-sorted keys,
 * two-space indentation, and exactly one trailing LF.
 *
 * @param {*} rule JSON-compatible rule value.
 * @returns {string} Canonical rule bytes.
 */
export function serializeLegacyMigrationRule(rule) {
  return `${JSON.stringify(canonicalize(rule), null, 2)}\n`;
}

/**
 * Validate an in-memory legacy migration rule against all pinned source bytes.
 *
 * @param {*} rule Candidate rule.
 * @param {object} [options] Validation options.
 * @param {string} [options.repositoryRoot] Absolute SteerBench repository root.
 * @param {Buffer|string} [options.rawBytes] Optional raw bytes to require exact canonical equality.
 * @returns {object} Detached validated rule.
 */
export function validateLegacyMigrationRule(rule, {
  repositoryRoot = ROOT,
  rawBytes
} = {}) {
  const expected = buildLegacyMigrationRule(repositoryRoot);
  const actualBytes = serializeLegacyMigrationRule(rule);
  const expectedBytes = serializeLegacyMigrationRule(expected);
  if (actualBytes !== expectedBytes) {
    throw new Error("legacy migration rule differs from the exact frozen candidate contract");
  }
  if (rawBytes !== undefined) {
    if (typeof rawBytes !== "string" && !Buffer.isBuffer(rawBytes)) {
      throw new Error("rawBytes must be a string or Buffer");
    }
    const suppliedBytes = Buffer.isBuffer(rawBytes)
      ? rawBytes
      : Buffer.from(rawBytes, "utf8");
    if (!suppliedBytes.equals(Buffer.from(actualBytes, "utf8"))) {
      throw new Error("legacy migration rule raw bytes are not canonical deterministic JSON");
    }
  }
  return JSON.parse(actualBytes);
}

/**
 * Read and fully validate the committed legacy migration-rule raw bytes.
 *
 * @param {string} [repositoryRoot] Absolute SteerBench repository root.
 * @returns {{rule: object, receipt: {artifact: string, sha256: string}}}
 *   Validated rule and its exact raw-byte receipt.
 */
export function loadAndValidateLegacyMigrationRule(repositoryRoot = ROOT) {
  const rawBytes = readRepositoryFile(repositoryRoot, LEGACY_MIGRATION_RULE_ARTIFACT);
  const rule = parseJsonBytes(rawBytes, LEGACY_MIGRATION_RULE_ARTIFACT);
  const validated = validateLegacyMigrationRule(rule, { repositoryRoot, rawBytes });
  const digest = sha256(rawBytes);
  if (!SHA256_RE.test(digest)) throw new Error("legacy migration rule SHA-256 is invalid");
  return {
    rule: validated,
    receipt: {
      artifact: LEGACY_MIGRATION_RULE_ARTIFACT,
      sha256: digest
    }
  };
}
