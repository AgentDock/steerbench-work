// Fail-closed Checkpoint-4 recertification validation and canonicalization.
//
// This module verifies structure, cohort coverage, source-receipt bytes,
// neutral role-based approval metadata, and its payload digest binding.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGACY_MIGRATION_RULE_ARTIFACT,
  LEGACY_SCENARIO_IDS,
  loadAndValidateLegacyMigrationRule
} from "./cp4-legacy-migration-rule.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHA256_RE = /^[0-9a-f]{64}$/u;
const UTC_RFC3339_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const GREGORIAN_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const DRIVE_RELATIVE_RE = /^[A-Za-z]:/u;
const VALIDATION_PLAN_ARTIFACT = "VALIDATION_PLAN.md";
const SCIENTIFIC_OWNER_ROLE = "scientific_owner";
const APPROVAL_RECORD_RE = /^approval_record artifact=(\S+) sha256=(\S+) approved_on=(\S+) role=(\S+)$/u;
const FROZEN_REFERENCE_DECISIONS = deepFreeze([
  "continue",
  "proceed",
  "block",
  "request_approval",
  "escalate",
  "ask_clarification"
]);

export const CP4_RECERTIFICATION_SCHEMA_PATH = path.join(
  ROOT,
  "CP4_RECERTIFICATION_SCHEMA.json"
);

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
  if (leftPoints.length < rightPoints.length) return -1;
  if (leftPoints.length > rightPoints.length) return 1;
  return 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateJsonValue(value, location) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(location + " must contain only finite JSON numbers");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error(location + " must not contain sparse arrays");
      }
      validateJsonValue(value[index], location + "[" + index + "]");
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      validateJsonValue(child, location + "." + key);
    }
    return;
  }
  throw new Error(location + " must contain only JSON values");
}

function canonicalizeValue(value, location) {
  validateJsonValue(value, location);
  if (Array.isArray(value)) {
    return value.map((child, index) => canonicalizeValue(
      child,
      location + "[" + index + "]"
    ));
  }
  if (!isPlainObject(value)) return value;
  const canonical = Object.create(null);
  for (const key of Object.keys(value).sort(compareCodePointStrings)) {
    canonical[key] = canonicalizeValue(value[key], location + "." + key);
  }
  return canonical;
}

/**
 * Serialize a JSON value with recursively code-point-sorted object keys.
 * Array order and JSON primitive types are preserved.
 *
 * @param {*} value JSON-compatible value.
 * @returns {string} Deterministic single-line JSON.
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalizeValue(value, "value"));
}

function assertExactKeys(value, expectedKeys, location) {
  if (!isPlainObject(value)) throw new Error(location + " must be an object");
  const expected = new Set(expectedKeys);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) throw new Error(location + "." + key + " is required");
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(location + "." + key + " is not allowed");
  }
}

function assertNonemptyString(value, location) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(location + " must be a non-empty string");
  }
}

function assertNullableString(value, location) {
  if (value !== null) assertNonemptyString(value, location);
}

function assertNullableBoolean(value, location) {
  if (value !== null && typeof value !== "boolean") {
    throw new Error(location + " must be boolean or null");
  }
}

function assertNullableSha256(value, location) {
  if (value !== null && !SHA256_RE.test(value)) {
    throw new Error(location + " must be a lowercase SHA-256 digest or null");
  }
}

function assertEnum(value, allowed, location, nullable = false) {
  if (nullable && value === null) return;
  if (!allowed.includes(value)) throw new Error(location + " is outside the allowed enum");
}

function assertUniqueStringArray(value, location) {
  if (!Array.isArray(value)) throw new Error(location + " must be an array");
  const seen = new Set();
  value.forEach((item, index) => {
    assertNonemptyString(item, location + "[" + index + "]");
    if (seen.has(item)) throw new Error(location + " contains duplicate value " + JSON.stringify(item));
    seen.add(item);
  });
}

function assertSortedUniqueBy(values, keyFor, location) {
  let previous = null;
  const seen = new Set();
  values.forEach((value, index) => {
    const key = keyFor(value);
    assertNonemptyString(key, location + "[" + index + "] sort key");
    if (seen.has(key)) throw new Error(location + " contains duplicate key " + JSON.stringify(key));
    if (previous !== null && compareCodePointStrings(previous, key) >= 0) {
      throw new Error(location + " must be in unique Unicode code-point order");
    }
    previous = key;
    seen.add(key);
  });
}

function loadContract() {
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(CP4_RECERTIFICATION_SCHEMA_PATH, "utf8"));
  } catch (error) {
    throw new Error("cannot load CP4 recertification schema: " + error.message);
  }
  if (!isPlainObject(contract)
    || contract.properties?.schema_version?.const !== "steerbench.cp4_recertification.v1"
    || contract.properties?.scenario_count?.const !== 106
    || contract.additionalProperties !== false
    || !isPlainObject(contract["x-steerbench"])) {
    throw new Error("invalid CP4 recertification schema");
  }
  const metadata = contract["x-steerbench"];
  const ids = metadata.expected_scenario_ids;
  if (!Array.isArray(ids) || ids.length !== 106) {
    throw new Error("CP4 schema must freeze exactly 106 scenario IDs");
  }
  assertSortedUniqueBy(ids, (id) => id, "CP4 schema scenario IDs");
  const idSetDigest = crypto.createHash("sha256")
    .update(JSON.stringify(ids), "utf8")
    .digest("hex");
  if (idSetDigest !== metadata.scenario_ids_sha256
    || idSetDigest !== contract.properties.scenario_ids_sha256?.const) {
    throw new Error("CP4 schema scenario ID digest does not bind its exact ID list");
  }
  if (!Array.isArray(metadata.authority_record_ids)
    || metadata.authority_record_ids.length !== 7) {
    throw new Error("CP4 schema must freeze exactly seven authority-review records");
  }
  assertSortedUniqueBy(
    metadata.authority_record_ids,
    (id) => id,
    "CP4 schema authority IDs"
  );
  if (!isPlainObject(metadata.adaptation_records)
    || Object.keys(metadata.adaptation_records).length !== 5) {
    throw new Error("CP4 schema must freeze exactly five adaptation records");
  }
  if (!isPlainObject(metadata.provisional_records)
    || Object.keys(metadata.provisional_records).length !== 3) {
    throw new Error("CP4 schema must freeze exactly three provisional records");
  }
  const expectedIds = new Set(ids);
  for (const id of metadata.authority_record_ids) {
    if (!expectedIds.has(id)) throw new Error("authority cohort contains an unknown scenario ID");
  }
  for (const [id, dataset] of Object.entries(metadata.adaptation_records)) {
    if (!expectedIds.has(id)) throw new Error("adaptation cohort contains an unknown scenario ID");
    if (!["XSTest", "OR-Bench"].includes(dataset)) {
      throw new Error("adaptation cohort contains an unknown upstream dataset");
    }
  }
  for (const [id, kind] of Object.entries(metadata.provisional_records)) {
    if (!expectedIds.has(id)) throw new Error("provisional cohort contains an unknown scenario ID");
    if (![
      "heldout_authorization",
      "evaluation_provenance",
      "fixture_regeneration"
    ].includes(kind)) {
      throw new Error("provisional cohort contains an unknown review kind");
    }
  }
  if (metadata.approval_role !== SCIENTIFIC_OWNER_ROLE
    || metadata.approval_timestamp !== "strict_utc_rfc3339") {
    throw new Error("CP4 neutral approval metadata changed");
  }
  const approvalEnvelope = contract.$defs?.signature_envelope;
  assertExactKeys(
    approvalEnvelope,
    ["type", "additionalProperties", "required", "properties"],
    "CP4 schema approval envelope"
  );
  if (approvalEnvelope.type !== "object"
    || approvalEnvelope.additionalProperties !== false
    || JSON.stringify(approvalEnvelope.required)
      !== JSON.stringify(["payload_sha256", "approved_at", "role"])) {
    throw new Error("CP4 schema approval envelope fields changed");
  }
  assertExactKeys(
    approvalEnvelope.properties,
    ["payload_sha256", "approved_at", "role"],
    "CP4 schema approval envelope properties"
  );
  if (approvalEnvelope.properties.payload_sha256?.pattern !== "^[0-9a-f]{64}$"
    || approvalEnvelope.properties.approved_at?.pattern
      !== "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
    || approvalEnvelope.properties.role?.const !== SCIENTIFIC_OWNER_ROLE) {
    throw new Error("CP4 schema approval envelope constraints changed");
  }
  const recordDecisionEnum = contract.$defs?.record?.properties
    ?.reference_decision?.enum?.filter((value) => value !== null);
  const officialDecisionEnum = contract.$defs?.official_source_review?.properties
    ?.reference_decision?.enum?.filter((value) => value !== null);
  if (JSON.stringify(recordDecisionEnum) !== JSON.stringify(FROZEN_REFERENCE_DECISIONS)
    || JSON.stringify(officialDecisionEnum) !== JSON.stringify(FROZEN_REFERENCE_DECISIONS)) {
    throw new Error("CP4 schema reference decisions differ from the six canonical actions");
  }
  const adaptationReceipt = metadata.adaptation_source_receipt;
  assertExactKeys(
    adaptationReceipt,
    [
      "schema_version",
      "receipt_kind",
      "review_status",
      "signature_envelope",
      "cross_bound_fields",
      "direct_raw_artifact_hash_match"
    ],
    "CP4 schema adaptation source receipt contract"
  );
  if (adaptationReceipt.schema_version
      !== "steerbench.cp4_adaptation_source_receipt.v1"
    || adaptationReceipt.receipt_kind !== "upstream_source_facts"
    || adaptationReceipt.review_status !== "pending_owner_review"
    || adaptationReceipt.signature_envelope !== "null"
    || adaptationReceipt.direct_raw_artifact_hash_match !== "forbidden"
    || JSON.stringify(adaptationReceipt.cross_bound_fields) !== JSON.stringify([
      "upstream.dataset_name",
      "upstream.immutable_revision",
      "upstream.source_artifact.sha256",
      "mappings[].local_scenario_id",
      "mappings[].upstream_source_example_or_prompt_id",
      "upstream.license_evidence.declared_identifier"
    ])) {
    throw new Error("CP4 schema adaptation source receipt contract changed");
  }
  return deepFreeze(contract);
}

export const CP4_RECERTIFICATION_SCHEMA = loadContract();
export const CP4_SCHEMA_VERSION =
  CP4_RECERTIFICATION_SCHEMA.properties.schema_version.const;
export const PENDING_OWNER_RECERTIFICATION = "pending_owner_recertification";
export const OWNER_RECERTIFIED = "owner_recertified";
export const EXPECTED_SCENARIO_IDS =
  CP4_RECERTIFICATION_SCHEMA["x-steerbench"].expected_scenario_ids;
export const SCENARIO_IDS_SHA256 =
  CP4_RECERTIFICATION_SCHEMA["x-steerbench"].scenario_ids_sha256;
export const AUTHORITY_RECORD_IDS =
  CP4_RECERTIFICATION_SCHEMA["x-steerbench"].authority_record_ids;
export const ADAPTATION_RECORDS =
  CP4_RECERTIFICATION_SCHEMA["x-steerbench"].adaptation_records;
export const PROVISIONAL_RECORDS =
  CP4_RECERTIFICATION_SCHEMA["x-steerbench"].provisional_records;
export const CP4_APPROVAL_ROLE =
  CP4_RECERTIFICATION_SCHEMA["x-steerbench"].approval_role;
export const REFERENCE_DECISIONS = FROZEN_REFERENCE_DECISIONS;
export const ADAPTATION_SOURCE_RECEIPT_CONTRACT =
  CP4_RECERTIFICATION_SCHEMA["x-steerbench"].adaptation_source_receipt;
export const DEPENDENCY_CLAIM_KEYS = deepFreeze([
  "recertified_pair_or_mirror_id",
  "immutable_upstream_source_example_id",
  "generating_template_lineage_id"
]);

const TOP_LEVEL_KEYS = deepFreeze([
  "schema_version",
  "status",
  "scenario_count",
  "scenario_ids_sha256",
  "records",
  "signature_envelope"
]);
const PAYLOAD_KEYS = TOP_LEVEL_KEYS.filter((key) => key !== "signature_envelope");
const RECORD_KEYS = deepFreeze([
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
]);
const AUTHORITY_RECORD_SET = new Set(AUTHORITY_RECORD_IDS);
const ADAPTATION_RECORD_SET = new Set(Object.keys(ADAPTATION_RECORDS));
const PROVISIONAL_RECORD_SET = new Set(Object.keys(PROVISIONAL_RECORDS));
const LEGACY_SCENARIO_ID_SET = new Set(LEGACY_SCENARIO_IDS);
const PUBLIC_RECORDS_REVIEW_ID =
  CP4_RECERTIFICATION_SCHEMA["x-steerbench"].public_records_official_review_id;
const WARNING_NAMES =
  CP4_RECERTIFICATION_SCHEMA.$defs.warning_record.properties.name.enum;
const WARNING_ORDER = new Map(WARNING_NAMES.map((name, index) => [name, index]));

function payloadFromArtifact(artifact) {
  assertExactKeys(artifact, TOP_LEVEL_KEYS, "artifact");
  const payload = Object.create(null);
  for (const key of PAYLOAD_KEYS) payload[key] = artifact[key];
  return payload;
}

/**
 * Canonicalize the top-level payload covered by the owner envelope.
 *
 * @param {object} artifact CP4 recertification artifact.
 * @returns {string} Canonical payload JSON excluding signature_envelope.
 */
export function canonicalizeCp4Payload(artifact) {
  return canonicalJson(payloadFromArtifact(artifact));
}

/**
 * Hash the canonical approval-bound payload bytes.
 *
 * @param {object} artifact CP4 recertification artifact.
 * @returns {string} Lowercase SHA-256 digest.
 */
export function cp4PayloadSha256(artifact) {
  return crypto.createHash("sha256")
    .update(canonicalizeCp4Payload(artifact), "utf8")
    .digest("hex");
}

function repositoryArtifactReader(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw new Error("repositoryRoot must be an absolute path");
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(repositoryRoot);
  } catch (error) {
    throw new Error("repositoryRoot cannot be resolved: " + error.message);
  }
  if (!fs.statSync(realRoot).isDirectory()) {
    throw new Error("repositoryRoot must resolve to a directory");
  }
  const cache = new Map();

  return function readRepositoryArtifact(artifact, location) {
    assertNonemptyString(artifact, location);
    if (path.posix.isAbsolute(artifact)
      || path.win32.isAbsolute(artifact)
      || DRIVE_RELATIVE_RE.test(artifact)) {
      throw new Error(location + " must be repository-relative, not absolute");
    }
    if (artifact.includes("\\")) {
      throw new Error(location + " must use canonical forward-slash separators");
    }
    const segments = artifact.split("/");
    if (segments.length === 0
      || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(location + " contains traversal or a non-canonical segment");
    }
    if (path.posix.normalize(artifact) !== artifact) {
      throw new Error(location + " is not a canonical repository-relative path");
    }

    let current = realRoot;
    try {
      for (let index = 0; index < segments.length; index += 1) {
        current = path.join(current, segments[index]);
        const stats = fs.lstatSync(current);
        if (stats.isSymbolicLink()) {
          throw new Error("symlink paths are forbidden");
        }
        if (index < segments.length - 1 && !stats.isDirectory()) {
          throw new Error("an intermediate path is not a directory");
        }
        if (index === segments.length - 1 && !stats.isFile()) {
          throw new Error("receipt target is not a regular file");
        }
      }
    } catch (error) {
      throw new Error(location + " cannot resolve to a regular non-symlink file: "
        + error.message);
    }
    const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (!current.startsWith(rootPrefix)) {
      throw new Error(location + " resolves outside repositoryRoot");
    }

    let resolved = cache.get(artifact);
    if (resolved === undefined) {
      let descriptor;
      try {
        if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
          throw new Error("this platform does not expose O_NOFOLLOW");
        }
        descriptor = fs.openSync(
          current,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        );
        const openedStats = fs.fstatSync(descriptor);
        if (!openedStats.isFile()) throw new Error("opened receipt is not a regular file");

        const currentStats = fs.statSync(current);
        if (currentStats.dev !== openedStats.dev || currentStats.ino !== openedStats.ino) {
          throw new Error("receipt path changed while it was being opened");
        }
        const openedPath = fs.realpathSync(current);
        if (!openedPath.startsWith(rootPrefix)) {
          throw new Error("opened receipt resolves outside repositoryRoot");
        }

        const rawBytes = fs.readFileSync(descriptor);
        resolved = {
          rawBytes,
          sha256: crypto.createHash("sha256").update(rawBytes).digest("hex")
        };
      } catch (error) {
        throw new Error(location + " cannot be opened as a stable non-symlink file: "
          + error.message);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
      cache.set(artifact, resolved);
    }
    return resolved;
  };
}

function sourceReceiptVerifier(readRepositoryArtifact) {
  return function verifySourceReceipt(receipt, location) {
    assertExactKeys(receipt, ["artifact", "sha256"], location);
    assertNonemptyString(receipt.artifact, location + ".artifact");
    if (!SHA256_RE.test(receipt.sha256)) {
      throw new Error(location + ".sha256 must be a lowercase SHA-256 digest");
    }
    const resolved = readRepositoryArtifact(receipt.artifact, location + ".artifact");
    if (resolved.sha256 !== receipt.sha256) {
      throw new Error(location + " SHA-256 mismatch for " + JSON.stringify(receipt.artifact));
    }
    return resolved;
  };
}

function assertPositiveInteger(value, location) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(location + " must be a positive integer");
  }
}

function validateAdaptationSourceWrapperShape(wrapper, location) {
  assertExactKeys(
    wrapper,
    [
      "schema_version",
      "receipt_kind",
      "review_status",
      "upstream",
      "mappings",
      "signature_envelope"
    ],
    location
  );
  if (wrapper.schema_version !== ADAPTATION_SOURCE_RECEIPT_CONTRACT.schema_version) {
    throw new Error(location + ".schema_version is not the CP4 adaptation source wrapper");
  }
  if (wrapper.receipt_kind !== ADAPTATION_SOURCE_RECEIPT_CONTRACT.receipt_kind) {
    throw new Error(location + ".receipt_kind is not upstream_source_facts");
  }
  if (wrapper.review_status !== ADAPTATION_SOURCE_RECEIPT_CONTRACT.review_status) {
    throw new Error(location + ".review_status differs from the frozen wrapper contract");
  }
  if (wrapper.signature_envelope !== null) {
    throw new Error(location + ".signature_envelope must be null");
  }

  const upstreamLocation = location + ".upstream";
  assertExactKeys(
    wrapper.upstream,
    [
      "dataset_name",
      "repository_url",
      "immutable_revision",
      "revision_url",
      "source_artifact",
      "upstream_id_convention",
      "license_evidence"
    ],
    upstreamLocation
  );
  for (const key of [
    "dataset_name",
    "repository_url",
    "immutable_revision",
    "revision_url",
    "upstream_id_convention"
  ]) {
    assertNonemptyString(wrapper.upstream[key], upstreamLocation + "." + key);
  }

  const sourceArtifactLocation = upstreamLocation + ".source_artifact";
  assertExactKeys(
    wrapper.upstream.source_artifact,
    [
      "path",
      "immutable_raw_url",
      "sha256",
      "byte_length",
      "data_record_count"
    ],
    sourceArtifactLocation
  );
  assertNonemptyString(wrapper.upstream.source_artifact.path, sourceArtifactLocation + ".path");
  assertNonemptyString(
    wrapper.upstream.source_artifact.immutable_raw_url,
    sourceArtifactLocation + ".immutable_raw_url"
  );
  if (!SHA256_RE.test(wrapper.upstream.source_artifact.sha256)) {
    throw new Error(sourceArtifactLocation + ".sha256 must be a lowercase SHA-256 digest");
  }
  assertPositiveInteger(
    wrapper.upstream.source_artifact.byte_length,
    sourceArtifactLocation + ".byte_length"
  );
  assertPositiveInteger(
    wrapper.upstream.source_artifact.data_record_count,
    sourceArtifactLocation + ".data_record_count"
  );

  const licenseLocation = upstreamLocation + ".license_evidence";
  assertExactKeys(
    wrapper.upstream.license_evidence,
    [
      "declared_identifier",
      "evidence_location",
      "artifact_path",
      "immutable_raw_url",
      "sha256",
      "byte_length"
    ],
    licenseLocation
  );
  for (const key of [
    "declared_identifier",
    "evidence_location",
    "artifact_path",
    "immutable_raw_url"
  ]) {
    assertNonemptyString(wrapper.upstream.license_evidence[key], licenseLocation + "." + key);
  }
  if (!SHA256_RE.test(wrapper.upstream.license_evidence.sha256)) {
    throw new Error(licenseLocation + ".sha256 must be a lowercase SHA-256 digest");
  }
  assertPositiveInteger(
    wrapper.upstream.license_evidence.byte_length,
    licenseLocation + ".byte_length"
  );

  if (!Array.isArray(wrapper.mappings) || wrapper.mappings.length === 0) {
    throw new Error(location + ".mappings must be a non-empty array");
  }
  const localIds = new Set();
  const upstreamIds = new Set();
  wrapper.mappings.forEach((mapping, index) => {
    const mappingLocation = location + ".mappings[" + index + "]";
    assertExactKeys(
      mapping,
      [
        "local_scenario_id",
        "upstream_source_example_or_prompt_id",
        "data_row",
        "csv_line",
        "prompt",
        "prompt_sha256",
        "source_fields"
      ],
      mappingLocation
    );
    assertNonemptyString(mapping.local_scenario_id, mappingLocation + ".local_scenario_id");
    assertNonemptyString(
      mapping.upstream_source_example_or_prompt_id,
      mappingLocation + ".upstream_source_example_or_prompt_id"
    );
    if (localIds.has(mapping.local_scenario_id)) {
      throw new Error(location + ".mappings contains a duplicate local_scenario_id");
    }
    if (upstreamIds.has(mapping.upstream_source_example_or_prompt_id)) {
      throw new Error(
        location + ".mappings contains a duplicate upstream_source_example_or_prompt_id"
      );
    }
    localIds.add(mapping.local_scenario_id);
    upstreamIds.add(mapping.upstream_source_example_or_prompt_id);
    assertPositiveInteger(mapping.data_row, mappingLocation + ".data_row");
    assertPositiveInteger(mapping.csv_line, mappingLocation + ".csv_line");
    if (mapping.csv_line !== mapping.data_row + 1) {
      throw new Error(mappingLocation + ".csv_line must equal data_row plus the CSV header");
    }
    assertNonemptyString(mapping.prompt, mappingLocation + ".prompt");
    if (!SHA256_RE.test(mapping.prompt_sha256)) {
      throw new Error(mappingLocation + ".prompt_sha256 must be a lowercase SHA-256 digest");
    }
    const actualPromptHash = crypto.createHash("sha256")
      .update(mapping.prompt, "utf8")
      .digest("hex");
    if (mapping.prompt_sha256 !== actualPromptHash) {
      throw new Error(mappingLocation + ".prompt_sha256 does not bind the exact prompt");
    }
    if (!isPlainObject(mapping.source_fields)) {
      throw new Error(mappingLocation + ".source_fields must be an object");
    }
    validateJsonValue(mapping.source_fields, mappingLocation + ".source_fields");
    if (mapping.source_fields.prompt !== mapping.prompt) {
      throw new Error(mappingLocation + ".source_fields.prompt must equal the mapped prompt");
    }
  });

}

function validateAdaptationSourceBinding(
  adaptation,
  scenarioId,
  location,
  verifyReceipt
) {
  let firstFailure = null;
  for (let index = 0; index < adaptation.source_receipts.length; index += 1) {
    const receipt = adaptation.source_receipts[index];
    const receiptLocation = location + ".source_receipts[" + index + "]";
    const resolved = verifyReceipt(receipt, receiptLocation);
    let wrapper;
    const wrapperText = resolved.rawBytes.toString("utf8");
    try {
      wrapper = JSON.parse(wrapperText);
    } catch {
      if (firstFailure === null) {
        firstFailure = new Error(
          receiptLocation + " must resolve to valid JSON when used as an adaptation wrapper"
        );
      }
      continue;
    }
    try {
      if (wrapperText !== JSON.stringify(wrapper, null, 2) + "\n") {
        throw new Error(receiptLocation + " wrapper bytes are not canonical JSON");
      }
      validateAdaptationSourceWrapperShape(wrapper, receiptLocation + " resolved JSON");
      if (wrapper.upstream.dataset_name !== adaptation.upstream_dataset) {
        throw new Error(receiptLocation
          + " wrapper upstream.dataset_name does not match adaptation upstream_dataset");
      }
      const expectedLocalIds = Object.entries(ADAPTATION_RECORDS)
        .filter(([, dataset]) => dataset === adaptation.upstream_dataset)
        .map(([localScenarioId]) => localScenarioId)
        .sort(compareCodePointStrings);
      const actualLocalIds = wrapper.mappings
        .map((mapping) => mapping.local_scenario_id)
        .sort(compareCodePointStrings);
      if (canonicalJson(actualLocalIds) !== canonicalJson(expectedLocalIds)) {
        throw new Error(
          receiptLocation + " wrapper mappings do not match the exact local scenario cohort"
        );
      }
      if (wrapper.upstream.immutable_revision !== adaptation.immutable_upstream_revision) {
        throw new Error(receiptLocation
          + " wrapper upstream.immutable_revision does not match the adaptation record");
      }
      if (wrapper.upstream.source_artifact.sha256 !== adaptation.upstream_artifact_sha256) {
        throw new Error(receiptLocation
          + " wrapper upstream.source_artifact.sha256 does not match the adaptation record");
      }
      const mappings = wrapper.mappings.filter(
        (mapping) => mapping.local_scenario_id === scenarioId
      );
      if (mappings.length !== 1) {
        throw new Error(receiptLocation
          + " wrapper must contain exactly one mapping for local scenario " + scenarioId);
      }
      if (mappings[0].upstream_source_example_or_prompt_id
        !== adaptation.upstream_source_example_or_prompt_id) {
        throw new Error(receiptLocation
          + " wrapper mapping upstream_source_example_or_prompt_id does not match");
      }
      if (wrapper.upstream.license_evidence.declared_identifier
        !== adaptation.license.identifier) {
        throw new Error(receiptLocation
          + " wrapper license declared_identifier does not match adaptation license.identifier");
      }
      return;
    } catch (error) {
      if (firstFailure === null) firstFailure = error;
    }
  }
  if (firstFailure !== null) throw firstFailure;
  throw new Error(
    location + " must resolve through an exact "
      + ADAPTATION_SOURCE_RECEIPT_CONTRACT.schema_version + " wrapper"
  );
}

function validateReceiptArray(value, location, verifyReceipt) {
  if (!Array.isArray(value)) throw new Error(location + " must be an array");
  value.forEach((receipt, index) => verifyReceipt(receipt, location + "[" + index + "]"));
  assertSortedUniqueBy(value, (receipt) => receipt.artifact, location);
}

function validateProposedAction(value, location, complete) {
  if (value === null) {
    if (complete) throw new Error(location + " must be complete for owner_recertified status");
    return;
  }
  assertExactKeys(value, ["actor", "principal", "operation", "target", "scope"], location);
  assertNullableString(value.actor, location + ".actor");
  assertNullableString(value.principal, location + ".principal");
  assertNullableString(value.operation, location + ".operation");
  assertNullableString(value.target, location + ".target");
  assertNullableString(value.scope, location + ".scope");
  if (complete) {
    assertNonemptyString(value.actor, location + ".actor");
    assertNonemptyString(value.operation, location + ".operation");
    assertNonemptyString(value.target, location + ".target");
    assertNonemptyString(value.scope, location + ".scope");
  }
}

function validateAuthorityBasis(value, location, complete, verifyReceipt) {
  if (value === null) {
    if (complete) throw new Error(location + " must be complete for owner_recertified status");
    return;
  }
  assertExactKeys(value, ["status", "rationale", "source_receipts"], location);
  assertEnum(
    value.status,
    ["established", "not_established", "not_applicable"],
    location + ".status",
    true
  );
  assertNullableString(value.rationale, location + ".rationale");
  validateReceiptArray(value.source_receipts, location + ".source_receipts", verifyReceipt);
  if (complete) {
    assertEnum(
      value.status,
      ["established", "not_established", "not_applicable"],
      location + ".status"
    );
    assertNonemptyString(value.rationale, location + ".rationale");
    if (value.status !== "not_applicable" && value.source_receipts.length === 0) {
      throw new Error(location + ".source_receipts must support the authority conclusion");
    }
  }
}

function validateModelVisibleEvidence(value, location, complete, verifyReceipt) {
  if (value === null) {
    if (complete) throw new Error(location + " must be complete for owner_recertified status");
    return;
  }
  assertExactKeys(
    value,
    ["evidence_ids", "facts", "absence_rationale", "source_receipts"],
    location
  );
  assertUniqueStringArray(value.evidence_ids, location + ".evidence_ids");
  assertUniqueStringArray(value.facts, location + ".facts");
  assertNullableString(value.absence_rationale, location + ".absence_rationale");
  validateReceiptArray(value.source_receipts, location + ".source_receipts", verifyReceipt);
  if (!complete) return;
  if (value.facts.length === 0) {
    if (value.evidence_ids.length !== 0) {
      throw new Error(location + ".evidence_ids cannot be populated without reviewed facts");
    }
    assertNonemptyString(value.absence_rationale, location + ".absence_rationale");
  } else {
    if (value.absence_rationale !== null) {
      throw new Error(location + ".absence_rationale must be null when facts are present");
    }
    if (value.source_receipts.length === 0) {
      throw new Error(location + ".source_receipts must support model-visible facts");
    }
  }
}

function validateWarningBasis(value, location, complete, verifyReceipt) {
  if (value === null) {
    if (complete) throw new Error(location + " must be complete for owner_recertified status");
    return;
  }
  assertExactKeys(value, ["warnings", "rationale", "source_receipts"], location);
  if (!Array.isArray(value.warnings)) throw new Error(location + ".warnings must be an array");
  let previousOrder = -1;
  const seen = new Set();
  value.warnings.forEach((warning, index) => {
    const warningLocation = location + ".warnings[" + index + "]";
    assertExactKeys(warning, ["name", "resolution", "basis"], warningLocation);
    assertEnum(warning.name, WARNING_NAMES, warningLocation + ".name");
    assertEnum(warning.resolution, ["active", "rebutted"], warningLocation + ".resolution");
    assertNonemptyString(warning.basis, warningLocation + ".basis");
    if (seen.has(warning.name)) {
      throw new Error(location + ".warnings contains duplicate warning " + warning.name);
    }
    const order = WARNING_ORDER.get(warning.name);
    if (order <= previousOrder) {
      throw new Error(location + ".warnings must follow the frozen warning registry order");
    }
    previousOrder = order;
    seen.add(warning.name);
  });
  assertNullableString(value.rationale, location + ".rationale");
  validateReceiptArray(value.source_receipts, location + ".source_receipts", verifyReceipt);
  if (complete) {
    assertNonemptyString(value.rationale, location + ".rationale");
    if (value.warnings.length > 0 && value.source_receipts.length === 0) {
      throw new Error(location + ".source_receipts must support warning conclusions");
    }
  }
}

function validateDependencyClaims(value, location, verifyReceipt) {
  assertExactKeys(value, DEPENDENCY_CLAIM_KEYS, location);
  for (const key of DEPENDENCY_CLAIM_KEYS) {
    const claims = value[key];
    const claimLocation = location + "." + key;
    if (!Array.isArray(claims)) throw new Error(claimLocation + " must be an array");
    claims.forEach((claim, index) => {
      const locationAtIndex = claimLocation + "[" + index + "]";
      assertExactKeys(claim, ["id", "source_receipt"], locationAtIndex);
      assertNonemptyString(claim.id, locationAtIndex + ".id");
      verifyReceipt(claim.source_receipt, locationAtIndex + ".source_receipt");
    });
    assertSortedUniqueBy(claims, (claim) => claim.id, claimLocation);
  }
}

function validatePromptReferenceReview(value, location, complete, verifyReceipt) {
  if (value === null) {
    if (complete) throw new Error(location + " must be complete for owner_recertified status");
    return;
  }
  assertExactKeys(
    value,
    [
      "reviewed_prompt_sha256",
      "prompt_decision_consistent",
      "contradictions",
      "rationale",
      "source_receipts"
    ],
    location
  );
  assertNullableSha256(value.reviewed_prompt_sha256, location + ".reviewed_prompt_sha256");
  assertNullableBoolean(
    value.prompt_decision_consistent,
    location + ".prompt_decision_consistent"
  );
  assertUniqueStringArray(value.contradictions, location + ".contradictions");
  assertNullableString(value.rationale, location + ".rationale");
  validateReceiptArray(value.source_receipts, location + ".source_receipts", verifyReceipt);
  if (complete) {
    if (!SHA256_RE.test(value.reviewed_prompt_sha256)) {
      throw new Error(location + ".reviewed_prompt_sha256 must bind reviewed prompt bytes");
    }
    if (value.prompt_decision_consistent !== true || value.contradictions.length !== 0) {
      throw new Error(location + " must record a contradiction-free prompt/reference pair");
    }
    assertNonemptyString(value.rationale, location + ".rationale");
    if (value.source_receipts.length === 0) {
      throw new Error(location + ".source_receipts must support the prompt/reference review");
    }
  }
}

function validateAuthorityReview(value, location, complete, verifyReceipt) {
  const keys = [
    "grantor",
    "authorized_actor",
    "authorized_role",
    "exact_action",
    "target",
    "scope",
    "temporal_validity",
    "legal_authority",
    "operational_delegation",
    "safety_clearance",
    "supporting_artifact",
    "conclusion",
    "rationale"
  ];
  assertExactKeys(value, keys, location);
  for (const key of keys.slice(0, 10)) {
    assertNullableString(value[key], location + "." + key);
  }
  if (value.supporting_artifact !== null) {
    verifyReceipt(value.supporting_artifact, location + ".supporting_artifact");
  }
  assertEnum(
    value.conclusion,
    ["authority_established", "authority_not_established"],
    location + ".conclusion",
    true
  );
  assertNullableString(value.rationale, location + ".rationale");
  if (complete) {
    for (const key of keys.slice(0, 10)) {
      assertNonemptyString(value[key], location + "." + key);
    }
    if (value.supporting_artifact === null) {
      throw new Error(location + ".supporting_artifact is required");
    }
    assertEnum(
      value.conclusion,
      ["authority_established", "authority_not_established"],
      location + ".conclusion"
    );
    assertNonemptyString(value.rationale, location + ".rationale");
  }
}

function validateOfficialSourceReview(value, location, complete, verifyReceipt) {
  const keys = [
    "court_filed_characterization",
    "sec_filing_access_endpoint",
    "sec_supported_automation_method",
    "delaware_access_rules",
    "delaware_automation_rules",
    "target_record_existence",
    "reference_decision",
    "source_receipts"
  ];
  assertExactKeys(value, keys, location);
  for (const key of keys.slice(0, 6)) {
    assertNullableString(value[key], location + "." + key);
  }
  assertEnum(
    value.reference_decision,
    REFERENCE_DECISIONS,
    location + ".reference_decision",
    true
  );
  validateReceiptArray(value.source_receipts, location + ".source_receipts", verifyReceipt);
  if (complete) {
    for (const key of keys.slice(0, 6)) {
      assertNonemptyString(value[key], location + "." + key);
    }
    assertEnum(
      value.reference_decision,
      REFERENCE_DECISIONS,
      location + ".reference_decision"
    );
    if (value.source_receipts.length === 0) {
      throw new Error(location + ".source_receipts must bind the official-source review");
    }
  }
}

function validateAdaptationLicense(
  value,
  scenarioId,
  location,
  complete,
  verifyReceipt
) {
  const keys = [
    "upstream_dataset",
    "immutable_upstream_revision",
    "upstream_source_example_or_prompt_id",
    "upstream_artifact_sha256",
    "transformation",
    "license",
    "source_receipts",
    "official_source_review"
  ];
  assertExactKeys(value, keys, location);
  assertEnum(value.upstream_dataset, ["XSTest", "OR-Bench"], location + ".upstream_dataset", true);
  if (value.upstream_dataset !== null
    && value.upstream_dataset !== ADAPTATION_RECORDS[scenarioId]) {
    throw new Error(location + ".upstream_dataset does not match the frozen adaptation cohort");
  }
  assertNullableString(
    value.immutable_upstream_revision,
    location + ".immutable_upstream_revision"
  );
  assertNullableString(
    value.upstream_source_example_or_prompt_id,
    location + ".upstream_source_example_or_prompt_id"
  );
  assertNullableSha256(
    value.upstream_artifact_sha256,
    location + ".upstream_artifact_sha256"
  );
  if (value.transformation !== null) {
    assertExactKeys(value.transformation, ["what_changed", "why"], location + ".transformation");
    assertNullableString(
      value.transformation.what_changed,
      location + ".transformation.what_changed"
    );
    assertNullableString(value.transformation.why, location + ".transformation.why");
  }
  if (value.license !== null) {
    assertExactKeys(
      value.license,
      ["identifier", "redistribution_status", "compatible", "rationale"],
      location + ".license"
    );
    assertNullableString(value.license.identifier, location + ".license.identifier");
    assertNullableString(
      value.license.redistribution_status,
      location + ".license.redistribution_status"
    );
    assertNullableBoolean(value.license.compatible, location + ".license.compatible");
    assertNullableString(value.license.rationale, location + ".license.rationale");
  }
  validateReceiptArray(value.source_receipts, location + ".source_receipts", verifyReceipt);
  if (scenarioId === PUBLIC_RECORDS_REVIEW_ID) {
    if (value.official_source_review === null) {
      throw new Error(location + ".official_source_review is required for " + scenarioId);
    }
    validateOfficialSourceReview(
      value.official_source_review,
      location + ".official_source_review",
      complete,
      verifyReceipt
    );
  } else if (value.official_source_review !== null) {
    throw new Error(location + ".official_source_review is only allowed for "
      + PUBLIC_RECORDS_REVIEW_ID);
  }
  if (complete) {
    assertEnum(value.upstream_dataset, ["XSTest", "OR-Bench"], location + ".upstream_dataset");
    assertNonemptyString(
      value.immutable_upstream_revision,
      location + ".immutable_upstream_revision"
    );
    assertNonemptyString(
      value.upstream_source_example_or_prompt_id,
      location + ".upstream_source_example_or_prompt_id"
    );
    if (!SHA256_RE.test(value.upstream_artifact_sha256)) {
      throw new Error(location + ".upstream_artifact_sha256 is required");
    }
    if (value.transformation === null || value.license === null) {
      throw new Error(location + " transformation and license reviews are required");
    }
    assertNonemptyString(
      value.transformation.what_changed,
      location + ".transformation.what_changed"
    );
    assertNonemptyString(value.transformation.why, location + ".transformation.why");
    assertNonemptyString(value.license.identifier, location + ".license.identifier");
    assertNonemptyString(
      value.license.redistribution_status,
      location + ".license.redistribution_status"
    );
    if (typeof value.license.compatible !== "boolean") {
      throw new Error(location + ".license.compatible must be a completed boolean conclusion");
    }
    assertNonemptyString(value.license.rationale, location + ".license.rationale");
    if (value.source_receipts.length === 0) {
      throw new Error(location + ".source_receipts must bind upstream provenance");
    }
    validateAdaptationSourceBinding(
      value,
      scenarioId,
      location,
      verifyReceipt
    );
  }
}

function validateProvisionalReview(value, expectedKind, location, complete, verifyReceipt) {
  const keysByKind = {
    heldout_authorization: [
      "kind",
      "acting_identity",
      "authorized_actor",
      "scope",
      "target",
      "temporal_validity",
      "signature_trust",
      "source_receipts"
    ],
    evaluation_provenance: [
      "kind",
      "evaluation_provenance_status",
      "contamination_assessment",
      "numeric_claim_resolution",
      "source_receipts"
    ],
    fixture_regeneration: [
      "kind",
      "fixture_regeneration_script",
      "exact_diff",
      "row_counts",
      "grader_and_heldout_non_change",
      "source_receipts"
    ]
  };
  const keys = keysByKind[expectedKind];
  assertExactKeys(value, keys, location);
  if (value.kind !== expectedKind) {
    throw new Error(location + ".kind must be " + expectedKind);
  }
  for (const key of keys.slice(1, -1)) {
    assertNullableString(value[key], location + "." + key);
    if (complete) assertNonemptyString(value[key], location + "." + key);
  }
  validateReceiptArray(value.source_receipts, location + ".source_receipts", verifyReceipt);
  if (complete && value.source_receipts.length === 0) {
    throw new Error(location + ".source_receipts must bind the provisional review");
  }
}

function validateRecord(record, index, complete, verifyReceipt) {
  const location = "artifact.records[" + index + "]";
  assertExactKeys(record, RECORD_KEYS, location);
  const expectedId = EXPECTED_SCENARIO_IDS[index];
  if (record.scenario_id !== expectedId) {
    throw new Error(location + ".scenario_id must be " + JSON.stringify(expectedId)
      + "; records must contain the exact sorted corpus IDs");
  }
  validateReceiptArray(record.source_receipts, location + ".source_receipts", verifyReceipt);
  if (complete && record.source_receipts.length === 0) {
    throw new Error(location + ".source_receipts must contain primary source receipts");
  }
  validateProposedAction(record.proposed_action, location + ".proposed_action", complete);
  validateAuthorityBasis(
    record.ordinary_authority,
    location + ".ordinary_authority",
    complete,
    verifyReceipt
  );
  validateAuthorityBasis(
    record.exceptional_authority,
    location + ".exceptional_authority",
    complete,
    verifyReceipt
  );
  validateModelVisibleEvidence(
    record.model_visible_evidence,
    location + ".model_visible_evidence",
    complete,
    verifyReceipt
  );
  validateWarningBasis(
    record.warning_basis,
    location + ".warning_basis",
    complete,
    verifyReceipt
  );
  assertEnum(
    record.reference_decision,
    REFERENCE_DECISIONS,
    location + ".reference_decision",
    true
  );
  assertNullableString(record.reference_rationale, location + ".reference_rationale");
  if (complete) {
    assertEnum(
      record.reference_decision,
      REFERENCE_DECISIONS,
      location + ".reference_decision"
    );
    assertNonemptyString(record.reference_rationale, location + ".reference_rationale");
  }
  validateDependencyClaims(
    record.dependency_claims,
    location + ".dependency_claims",
    verifyReceipt
  );
  validatePromptReferenceReview(
    record.prompt_reference_review,
    location + ".prompt_reference_review",
    complete,
    verifyReceipt
  );

  if (AUTHORITY_RECORD_SET.has(record.scenario_id)) {
    if (record.authority_review === null) {
      throw new Error(location + ".authority_review is required for the exact authority cohort");
    }
    validateAuthorityReview(
      record.authority_review,
      location + ".authority_review",
      complete,
      verifyReceipt
    );
  } else if (record.authority_review !== null) {
    throw new Error(location + ".authority_review is forbidden outside the exact authority cohort");
  }

  if (ADAPTATION_RECORD_SET.has(record.scenario_id)) {
    if (record.adaptation_license === null) {
      throw new Error(location + ".adaptation_license is required for the exact adaptation cohort");
    }
    validateAdaptationLicense(
      record.adaptation_license,
      record.scenario_id,
      location + ".adaptation_license",
      complete,
      verifyReceipt
    );
  } else if (record.adaptation_license !== null) {
    throw new Error(location + ".adaptation_license is forbidden outside the exact adaptation cohort");
  }

  if (PROVISIONAL_RECORD_SET.has(record.scenario_id)) {
    if (record.provisional_review === null) {
      throw new Error(location + ".provisional_review is required for the exact provisional cohort");
    }
    validateProvisionalReview(
      record.provisional_review,
      PROVISIONAL_RECORDS[record.scenario_id],
      location + ".provisional_review",
      complete,
      verifyReceipt
    );
  } else if (record.provisional_review !== null) {
    throw new Error(location + ".provisional_review is forbidden outside the exact provisional cohort");
  }

  if (complete
    && record.scenario_id === PUBLIC_RECORDS_REVIEW_ID
    && record.adaptation_license.official_source_review.reference_decision
      !== record.reference_decision) {
    throw new Error(location + " official-source and row reference decisions disagree");
  }
}

function validateSharedDependencyClaimReceipts(records) {
  const receiptsByClaim = new Map();
  records.forEach((record, recordIndex) => {
    for (const kind of DEPENDENCY_CLAIM_KEYS) {
      record.dependency_claims[kind].forEach((claim, claimIndex) => {
        const key = canonicalJson([kind, claim.id]);
        const receiptBytes = canonicalJson(claim.source_receipt);
        const previous = receiptsByClaim.get(key);
        if (previous !== undefined && previous !== receiptBytes) {
          throw new Error(
            "artifact.records[" + recordIndex + "].dependency_claims." + kind
              + "[" + claimIndex + "] repeats a shared claim with a different source_receipt"
          );
        }
        receiptsByClaim.set(key, receiptBytes);
      });
    }
  });
}

function hasExactSourceReceipt(receipts, expectedReceipt) {
  return receipts.some((receipt) => receipt.artifact === expectedReceipt.artifact
    && receipt.sha256 === expectedReceipt.sha256);
}

function collectReservedReceiptOccurrences(
  value,
  location,
  reservedIdentityByArtifact,
  reservedIdentityBySha256,
  results = [],
  ancestors = new Set()
) {
  if (value === null || typeof value !== "object" || ancestors.has(value)) return results;
  ancestors.add(value);
  if (isPlainObject(value)) {
    const artifactIdentity = reservedIdentityByArtifact.get(value.artifact);
    const sha256Identity = reservedIdentityBySha256.get(value.sha256);
    if (artifactIdentity !== undefined
      && sha256Identity !== undefined
      && artifactIdentity !== sha256Identity) {
      throw new Error(
        location + " combines a reserved migration artifact with a different reserved SHA-256 identity"
      );
    }
    const identity = artifactIdentity ?? sha256Identity;
    if (identity !== undefined) {
      results.push({
        actualArtifact: value.artifact,
        actualSha256: value.sha256,
        identity,
        location
      });
    }
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectReservedReceiptOccurrences(
        value[index],
        location + "[" + index + "]",
        reservedIdentityByArtifact,
        reservedIdentityBySha256,
        results,
        ancestors
      );
    }
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectReservedReceiptOccurrences(
        child,
        location + "." + key,
        reservedIdentityByArtifact,
        reservedIdentityBySha256,
        results,
        ancestors
      );
    }
  }
  ancestors.delete(value);
  return results;
}

function enforceLegacyMigrationReceiptPlacement(records, legacyRule, ruleReceipt) {
  const authoredReceiptById = new Map(
    LEGACY_SCENARIO_IDS.map((scenarioId, index) => [
      scenarioId,
      legacyRule.source_cohort.source_receipts[index]
    ])
  );
  const ruleIdentity = {
    kind: "rule",
    canonicalArtifact: ruleReceipt.artifact,
    sha256: ruleReceipt.sha256,
    scenarioId: null
  };
  const authoredIdentities = [...authoredReceiptById].map(([scenarioId, receipt]) => ({
    kind: "authored_row",
    canonicalArtifact: receipt.artifact,
    sha256: receipt.sha256,
    scenarioId
  }));
  const reservedIdentities = [ruleIdentity, ...authoredIdentities];
  const reservedIdentityByArtifact = new Map();
  const reservedIdentityBySha256 = new Map();
  for (const identity of reservedIdentities) {
    if (reservedIdentityByArtifact.has(identity.canonicalArtifact)
      || reservedIdentityBySha256.has(identity.sha256)) {
      throw new Error("legacy migration rule reserved receipt identities must be unique");
    }
    reservedIdentityByArtifact.set(identity.canonicalArtifact, identity);
    reservedIdentityBySha256.set(identity.sha256, identity);
  }
  const authoredIdentityById = new Map(
    authoredIdentities.map((identity) => [identity.scenarioId, identity])
  );

  records.forEach((record, recordIndex) => {
    if (!isPlainObject(record)) return;
    const location = "artifact.records[" + recordIndex + "]";
    const occurrences = collectReservedReceiptOccurrences(
      record,
      location,
      reservedIdentityByArtifact,
      reservedIdentityBySha256
    );
    const authoredIdentity = authoredIdentityById.get(record.scenario_id);
    const allowedIdentities = authoredIdentity === undefined
      ? new Set()
      : new Set([ruleIdentity, authoredIdentity]);
    const topLevelReceiptLocations = new Set(
      Array.isArray(record.source_receipts)
        ? record.source_receipts.map(
          (_receipt, receiptIndex) => location + ".source_receipts[" + receiptIndex + "]"
        )
        : []
    );

    const misplacedOccurrence = occurrences.find(
      (occurrence) => occurrence.actualArtifact !== occurrence.identity.canonicalArtifact
        || !allowedIdentities.has(occurrence.identity)
        || !topLevelReceiptLocations.has(occurrence.location)
    );
    if (misplacedOccurrence === undefined) return;
    if (misplacedOccurrence.actualArtifact
      !== misplacedOccurrence.identity.canonicalArtifact) {
      if (misplacedOccurrence.identity.kind === "rule") {
        throw new Error(
          misplacedOccurrence.location
            + " reserved legacy rule receipt must use canonical artifact "
            + LEGACY_MIGRATION_RULE_ARTIFACT
        );
      }
      throw new Error(
        misplacedOccurrence.location
          + " reserved authored-row receipt must use its canonical scenario artifact "
          + JSON.stringify(misplacedOccurrence.identity.canonicalArtifact)
      );
    }
    if (misplacedOccurrence.identity.kind === "rule") {
      if (!LEGACY_SCENARIO_ID_SET.has(record.scenario_id)) {
        throw new Error(
          misplacedOccurrence.location + " must not contain "
            + LEGACY_MIGRATION_RULE_ARTIFACT + " outside the exact legacy cohort"
        );
      }
      throw new Error(
        misplacedOccurrence.location + " must not contain "
          + LEGACY_MIGRATION_RULE_ARTIFACT
          + "; legacy cohort records permit it only in top-level source_receipts"
      );
    }
    const expectedScenarioId = misplacedOccurrence.identity.scenarioId;
    if (expectedScenarioId !== record.scenario_id) {
      throw new Error(
        misplacedOccurrence.location + " must not contain reserved authored-row receipt for "
          + JSON.stringify(expectedScenarioId) + " outside its matching legacy cohort record"
      );
    }
    throw new Error(
      misplacedOccurrence.location + " must not contain reserved authored-row receipt; "
        + "the matching legacy cohort record permits it only in top-level source_receipts"
    );
  });
}

function validateCompleteLegacyReceipts(records, legacyRule, ruleReceipt) {
  const authoredReceipts = legacyRule.source_cohort.source_receipts;
  const authoredReceiptById = new Map(
    LEGACY_SCENARIO_IDS.map((scenarioId, index) => [scenarioId, authoredReceipts[index]])
  );

  records.forEach((record, recordIndex) => {
    if (!LEGACY_SCENARIO_ID_SET.has(record.scenario_id)) return;
    const location = "artifact.records[" + recordIndex + "].source_receipts";
    const authoredReceipt = authoredReceiptById.get(record.scenario_id);
    if (!hasExactSourceReceipt(record.source_receipts, authoredReceipt)) {
      throw new Error(
        location + " must contain the exact authored-row receipt for "
          + JSON.stringify(record.scenario_id)
      );
    }
    if (record.source_receipts.filter(
      (receipt) => receipt.artifact === authoredReceipt.artifact
    ).length !== 1) {
      throw new Error(
        location + " must contain exactly one authored-row receipt for "
          + JSON.stringify(record.scenario_id)
      );
    }
    if (!hasExactSourceReceipt(record.source_receipts, ruleReceipt)) {
      throw new Error(
        location + " must contain the exact " + LEGACY_MIGRATION_RULE_ARTIFACT + " receipt"
      );
    }
    if (record.source_receipts.filter(
      (receipt) => receipt.artifact === LEGACY_MIGRATION_RULE_ARTIFACT
    ).length !== 1) {
      throw new Error(
        location + " must contain exactly one "
          + LEGACY_MIGRATION_RULE_ARTIFACT + " receipt"
      );
    }
  });
}

function assertRealGregorianDate(value, location) {
  if (!GREGORIAN_DATE_RE.test(value) || value.startsWith("0000-")) {
    throw new Error(location + " must be a real Gregorian YYYY-MM-DD date");
  }
  const parsed = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error(location + " must be a real Gregorian YYYY-MM-DD date");
  }
}

function validateLegacyRuleApprovalRecord(planBytes, ruleReceipt) {
  const lines = planBytes.toString("utf8").split("\n");
  const parsedRecords = lines
    .filter((line) => line.startsWith("approval_record"))
    .map((line, index) => {
      const match = APPROVAL_RECORD_RE.exec(line);
      if (match === null) {
        throw new Error(
          VALIDATION_PLAN_ARTIFACT + " approval_record line " + (index + 1)
            + " must match the exact neutral grammar"
        );
      }
      return {
        artifact: match[1],
        sha256: match[2],
        approvedOn: match[3],
        role: match[4]
      };
    });
  const matchingRecords = parsedRecords.filter(
    (record) => record.artifact === LEGACY_MIGRATION_RULE_ARTIFACT
  );
  if (matchingRecords.length === 0) {
    throw new Error(
      VALIDATION_PLAN_ARTIFACT + " must contain exactly one neutral approval_record for "
        + LEGACY_MIGRATION_RULE_ARTIFACT
    );
  }
  if (matchingRecords.length > 1) {
    throw new Error(
      VALIDATION_PLAN_ARTIFACT + " contains duplicate approval_record lines for "
        + LEGACY_MIGRATION_RULE_ARTIFACT
    );
  }
  const approval = matchingRecords[0];
  if (!SHA256_RE.test(approval.sha256) || approval.sha256 !== ruleReceipt.sha256) {
    throw new Error(
      VALIDATION_PLAN_ARTIFACT + " approval_record must bind the exact "
        + LEGACY_MIGRATION_RULE_ARTIFACT + " raw SHA-256"
    );
  }
  assertRealGregorianDate(
    approval.approvedOn,
    VALIDATION_PLAN_ARTIFACT + " approval_record approved_on"
  );
  if (approval.role !== CP4_APPROVAL_ROLE) {
    throw new Error(
      VALIDATION_PLAN_ARTIFACT + " approval_record role must equal "
        + CP4_APPROVAL_ROLE
    );
  }
}

function validateApprovalEnvelope(envelope, artifact) {
  assertExactKeys(
    envelope,
    ["payload_sha256", "approved_at", "role"],
    "artifact.signature_envelope"
  );
  if (!UTC_RFC3339_RE.test(envelope.approved_at)) {
    throw new Error("artifact.signature_envelope.approved_at must be strict UTC RFC3339");
  }
  const parsed = Date.parse(envelope.approved_at);
  if (!Number.isFinite(parsed)
    || new Date(parsed).toISOString().replace(".000Z", "Z") !== envelope.approved_at) {
    throw new Error("artifact.signature_envelope.approved_at is not a real UTC timestamp");
  }
  if (!SHA256_RE.test(envelope.payload_sha256)) {
    throw new Error("artifact.signature_envelope.payload_sha256 must be a lowercase SHA-256 digest");
  }
  if (envelope.role !== CP4_APPROVAL_ROLE) {
    throw new Error(
      "artifact.signature_envelope.role must equal " + CP4_APPROVAL_ROLE
    );
  }
  const actualDigest = cp4PayloadSha256(artifact);
  if (envelope.payload_sha256 !== actualDigest) {
    throw new Error("artifact.signature_envelope.payload_sha256 does not bind the canonical payload");
  }
}

/**
 * Validate a complete or pending CP4 artifact without mutating it.
 *
 * All populated source receipts are resolved beneath repositoryRoot and hashed
 * from raw bytes. Pending artifacts have no approval envelope. Owner-recertified
 * artifacts must have complete records, a neutral digest-bound approval
 * envelope, and an exact hash-bound legacy-rule approval record in the plan.
 *
 * @param {object} artifact CP4 recertification artifact.
 * @param {object} [options] Validation options.
 * @param {string} [options.repositoryRoot] Absolute repository root.
 * @returns {object} Detached canonical artifact.
 */
export function validateCp4Recertification(artifact, options = {}) {
  if (!isPlainObject(options)) throw new Error("options must be an object");
  for (const key of Object.keys(options)) {
    if (key !== "repositoryRoot") throw new Error("options." + key + " is not allowed");
  }
  const repositoryRoot = options.repositoryRoot ?? ROOT;
  assertExactKeys(artifact, TOP_LEVEL_KEYS, "artifact");
  if (artifact.schema_version !== CP4_SCHEMA_VERSION) {
    throw new Error("artifact.schema_version is unsupported");
  }
  assertEnum(
    artifact.status,
    [PENDING_OWNER_RECERTIFICATION, OWNER_RECERTIFIED],
    "artifact.status"
  );
  if (artifact.scenario_count !== 106) {
    throw new Error("artifact.scenario_count must equal 106");
  }
  if (artifact.scenario_ids_sha256 !== SCENARIO_IDS_SHA256) {
    throw new Error("artifact.scenario_ids_sha256 does not bind the frozen corpus IDs");
  }
  if (!Array.isArray(artifact.records) || artifact.records.length !== 106) {
    throw new Error("artifact.records must contain exactly 106 records");
  }
  const complete = artifact.status === OWNER_RECERTIFIED;
  const readRepositoryArtifact = repositoryArtifactReader(repositoryRoot);
  const verifyReceipt = sourceReceiptVerifier(readRepositoryArtifact);
  const legacyMigrationRule = complete
    ? loadAndValidateLegacyMigrationRule(repositoryRoot)
    : null;
  if (complete) {
    validateLegacyRuleApprovalRecord(
      readRepositoryArtifact(
        VALIDATION_PLAN_ARTIFACT,
        "legacy migration rule approval plan"
      ).rawBytes,
      legacyMigrationRule.receipt
    );
    enforceLegacyMigrationReceiptPlacement(
      artifact.records,
      legacyMigrationRule.rule,
      legacyMigrationRule.receipt
    );
  }
  artifact.records.forEach((record, index) => {
    validateRecord(record, index, complete, verifyReceipt);
  });
  validateSharedDependencyClaimReceipts(artifact.records);

  if (complete) {
    validateCompleteLegacyReceipts(
      artifact.records,
      legacyMigrationRule.rule,
      legacyMigrationRule.receipt
    );
  }

  if (complete) {
    if (artifact.signature_envelope === null) {
      throw new Error("artifact.signature_envelope is required for owner_recertified status");
    }
    validateApprovalEnvelope(artifact.signature_envelope, artifact);
  } else if (artifact.signature_envelope !== null) {
    throw new Error("pending artifacts must have a null signature_envelope");
  }
  return JSON.parse(canonicalJson(artifact));
}

/**
 * Validate and serialize a complete or pending artifact canonically.
 *
 * @param {object} artifact CP4 recertification artifact.
 * @param {object} [options] Options accepted by validateCp4Recertification.
 * @returns {string} Canonical JSON for the entire artifact.
 */
export function canonicalizeCp4Recertification(artifact, options = {}) {
  validateCp4Recertification(artifact, options);
  return canonicalJson(artifact);
}

function nullAuthorityReview() {
  return {
    grantor: null,
    authorized_actor: null,
    authorized_role: null,
    exact_action: null,
    target: null,
    scope: null,
    temporal_validity: null,
    legal_authority: null,
    operational_delegation: null,
    safety_clearance: null,
    supporting_artifact: null,
    conclusion: null,
    rationale: null
  };
}

function nullOfficialSourceReview() {
  return {
    court_filed_characterization: null,
    sec_filing_access_endpoint: null,
    sec_supported_automation_method: null,
    delaware_access_rules: null,
    delaware_automation_rules: null,
    target_record_existence: null,
    reference_decision: null,
    source_receipts: []
  };
}

function nullAdaptationLicense(scenarioId) {
  return {
    upstream_dataset: null,
    immutable_upstream_revision: null,
    upstream_source_example_or_prompt_id: null,
    upstream_artifact_sha256: null,
    transformation: null,
    license: null,
    source_receipts: [],
    official_source_review: scenarioId === PUBLIC_RECORDS_REVIEW_ID
      ? nullOfficialSourceReview()
      : null
  };
}

function nullProvisionalReview(kind) {
  if (kind === "heldout_authorization") {
    return {
      kind,
      acting_identity: null,
      authorized_actor: null,
      scope: null,
      target: null,
      temporal_validity: null,
      signature_trust: null,
      source_receipts: []
    };
  }
  if (kind === "evaluation_provenance") {
    return {
      kind,
      evaluation_provenance_status: null,
      contamination_assessment: null,
      numeric_claim_resolution: null,
      source_receipts: []
    };
  }
  return {
    kind,
    fixture_regeneration_script: null,
    exact_diff: null,
    row_counts: null,
    grader_and_heldout_non_change: null,
    source_receipts: []
  };
}

/**
 * Create the unsigned 106-row pending template.
 *
 * Cohort membership and dependency-claim keys are present explicitly. No
 * source facts, approval role, timestamp, or payload digest is invented.
 *
 * @returns {object} Mutable pending template.
 */
export function createPendingCp4Recertification() {
  return {
    schema_version: CP4_SCHEMA_VERSION,
    status: PENDING_OWNER_RECERTIFICATION,
    scenario_count: 106,
    scenario_ids_sha256: SCENARIO_IDS_SHA256,
    records: EXPECTED_SCENARIO_IDS.map((scenarioId) => ({
      scenario_id: scenarioId,
      source_receipts: [],
      proposed_action: null,
      ordinary_authority: null,
      exceptional_authority: null,
      model_visible_evidence: null,
      warning_basis: null,
      reference_decision: null,
      reference_rationale: null,
      dependency_claims: {
        recertified_pair_or_mirror_id: [],
        immutable_upstream_source_example_id: [],
        generating_template_lineage_id: []
      },
      adaptation_license: ADAPTATION_RECORD_SET.has(scenarioId)
        ? nullAdaptationLicense(scenarioId)
        : null,
      prompt_reference_review: null,
      authority_review: AUTHORITY_RECORD_SET.has(scenarioId)
        ? nullAuthorityReview()
        : null,
      provisional_review: PROVISIONAL_RECORD_SET.has(scenarioId)
        ? nullProvisionalReview(PROVISIONAL_RECORDS[scenarioId])
        : null
    })),
    signature_envelope: null
  };
}
