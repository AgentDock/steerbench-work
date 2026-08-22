/**
 * @fileoverview Deterministic CP4 dependency-ledger generation and activation.
 * @module src/cp4-dependency-ledger
 *
 * Expands exact recertified dependency claims into receipt-bearing clique
 * edges, derives every connected component, and compares the result with the
 * owner-recertified ledger committed in SHORTCUT_DEPENDENCY_SPEC.json.
 */

import crypto from "node:crypto";

import {
  OWNER_RECERTIFIED,
  canonicalJson,
  cp4PayloadSha256,
  validateCp4Recertification
} from "./cp4-recertification.mjs";

const EXPECTED_SCENARIO_COUNT = 106;
const EXPECTED_ID_SET_SHA256 = "549af6d6d7b63e18720d90e7446fde0d4399b7d3766e34e1212017ee667c62fc";
const SHA256_RE = /^[0-9a-f]{64}$/u;
const UTC_RFC3339_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const DEPENDENCY_LEDGER_KEYS = [
  "status",
  "recertified_at",
  "scenario_ids",
  "edges",
  "components",
  "signature_envelope"
];
const DEPENDENCY_LEDGER_PAYLOAD_KEYS = [
  "status",
  "recertified_at",
  "scenario_ids",
  "edges",
  "components"
];
const DEPENDENCY_SIGNATURE_ENVELOPE_KEYS = [
  "owner_id",
  "signed_at",
  "cp4_payload_sha256",
  "ledger_payload_sha256",
  "attestation",
  "signature"
];
/** Exact owner statement bound by every completed dependency envelope. */
export const DEPENDENCY_OWNER_ATTESTATION =
  "I attest that I reviewed and recertified this CP4 dependency ledger.";
/** Trust limit disclosed beside every dependency-envelope payload binding. */
export const DEPENDENCY_SIGNATURE_TRUST_BOUNDARY =
  "First-hand owner approval recorded in chat and bound in Git is the trust boundary; the signature envelope is a tamper-evident payload-hash binding, not cryptographic authentication.";
const ALLOWED_KINDS = [
  "recertified_pair_or_mirror_id",
  "immutable_upstream_source_example_id",
  "generating_template_lineage_id"
];
const FORBIDDEN_CLAIMS = [
  "topic",
  "domain",
  "scenario_pattern",
  "risk_resolved",
  "detector_conflict",
  "missing_value"
];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCodePointStrings(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function sortedStrings(values) {
  return [...values].sort(compareCodePointStrings);
}

function jsonBytes(value) {
  return JSON.stringify(value);
}

function assertExactKeys(value, keys, location) {
  if (!isPlainObject(value)) throw new Error(`${location} must be an object`);
  const actual = sortedStrings(Object.keys(value));
  const expected = sortedStrings(keys);
  if (jsonBytes(actual) !== jsonBytes(expected)) {
    throw new Error(`${location} must contain exactly ${keys.join(", ")}`);
  }
}

function assertNonemptyString(value, location) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
}

function assertStrictUtcTimestamp(value, location) {
  if (typeof value !== "string" || !UTC_RFC3339_RE.test(value)) {
    throw new Error(`${location} must be strict UTC RFC3339`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)
    || new Date(parsed).toISOString().replace(".000Z", "Z") !== value) {
    throw new Error(`${location} is not a real UTC timestamp`);
  }
}

function normalizeReceipt(value, location) {
  assertExactKeys(value, ["artifact", "sha256"], location);
  assertNonemptyString(value.artifact, `${location}.artifact`);
  if (!SHA256_RE.test(value.sha256)) {
    throw new Error(`${location}.sha256 must be a lowercase SHA-256 digest`);
  }
  return { artifact: value.artifact, sha256: value.sha256 };
}

function assertSameStringSet(actual, expected, location) {
  if (!Array.isArray(actual)
    || actual.some((value) => typeof value !== "string")
    || jsonBytes(sortedStrings(actual)) !== jsonBytes(sortedStrings(expected))) {
    throw new Error(`${location} differs from the frozen CP4 contract`);
  }
}

/**
 * Validate the frozen CP4 dependency specification and ledger shape.
 *
 * Pending ledgers must keep every activation field explicitly null. Completed
 * ledger bytes are validated by {@link validateDependencyActivation}.
 *
 * @param {object} spec Parsed SHORTCUT_DEPENDENCY_SPEC.json.
 * @returns {true} True when the frozen specification contract is intact.
 * @throws {Error} If contract metadata, pending state, or ledger keys drift.
 */
export function validateCp4DependencySpec(spec) {
  if (!isPlainObject(spec) || spec.schema_version !== "steerbench.shortcut_dependency_spec.v1") {
    throw new Error("unsupported shortcut dependency spec");
  }
  assertExactKeys(spec, [
    "schema_version",
    "expected_scenario_count",
    "corpus_id_set_sha256",
    "seed",
    "edge_rules",
    "component_rule",
    "ledger_contract",
    "ledger"
  ], "shortcut dependency spec");
  if (spec.expected_scenario_count !== EXPECTED_SCENARIO_COUNT) {
    throw new Error("shortcut dependency spec must require exactly 106 scenarios");
  }
  if (spec.corpus_id_set_sha256 !== EXPECTED_ID_SET_SHA256) {
    throw new Error("shortcut dependency spec corpus ID-set hash differs from the frozen CP4 hash");
  }
  if (spec.seed !== 20260815) throw new Error("shortcut dependency spec seed differs from the frozen CP4 seed");
  assertExactKeys(spec.edge_rules, [
    "allowed_kinds",
    "forbidden_sources",
    "normalization",
    "duplicates",
    "self_edges",
    "source_receipt"
  ], "edge_rules");
  assertSameStringSet(spec.edge_rules?.allowed_kinds, ALLOWED_KINDS, "edge_rules.allowed_kinds");
  assertSameStringSet(spec.edge_rules?.forbidden_sources, FORBIDDEN_CLAIMS, "edge_rules.forbidden_sources");
  if (spec.edge_rules.normalization !== "endpoints_unicode_code_point_sorted"
    || spec.edge_rules.duplicates !== "forbidden"
    || spec.edge_rules.self_edges !== "forbidden"
    || spec.edge_rules.source_receipt !== "required_per_edge") {
    throw new Error("edge_rules differ from the frozen CP4 contract");
  }
  assertExactKeys(spec.component_rule, [
    "algorithm",
    "edge_order",
    "component_members",
    "component_order",
    "singletons",
    "cross_fold_edges",
    "every_row_held_out_exactly_once"
  ], "component_rule");
  if (spec.component_rule.algorithm !== "undirected_connected_components"
    || spec.component_rule.edge_order !== "stable_sorted"
    || spec.component_rule.component_members !== "stable_sorted"
    || spec.component_rule.component_order !== "first_member_stable_sorted"
    || spec.component_rule.singletons !== "included"
    || spec.component_rule.cross_fold_edges !== "forbidden"
    || spec.component_rule.every_row_held_out_exactly_once !== true) {
    throw new Error("component_rule differs from the frozen CP4 contract");
  }
  if (!isPlainObject(spec.ledger_contract)) throw new Error("ledger_contract must be an object");
  assertExactKeys(spec.ledger_contract, [
    "recertified_status",
    "required_keys",
    "signature_envelope_keys",
    "canonicalization",
    "signature_payload",
    "owner_attestation",
    "signature_trust_boundary",
    "edge_keys",
    "source_receipt_keys"
  ], "ledger_contract");
  assertSameStringSet(
    spec.ledger_contract.required_keys,
    DEPENDENCY_LEDGER_KEYS,
    "ledger_contract.required_keys"
  );
  assertSameStringSet(
    spec.ledger_contract.signature_envelope_keys,
    DEPENDENCY_SIGNATURE_ENVELOPE_KEYS,
    "ledger_contract.signature_envelope_keys"
  );
  if (spec.ledger_contract.recertified_status !== "owner_recertified"
    || spec.ledger_contract.canonicalization
      !== "recursive_unicode_code_point_object_keys_arrays_preserved_utf8"
    || spec.ledger_contract.signature_payload
      !== "all_ledger_fields_except_signature_envelope"
    || spec.ledger_contract.owner_attestation !== DEPENDENCY_OWNER_ATTESTATION
    || spec.ledger_contract.signature_trust_boundary
      !== DEPENDENCY_SIGNATURE_TRUST_BOUNDARY) {
    throw new Error("ledger_contract signature metadata differ from the frozen CP4 contract");
  }
  assertSameStringSet(
    spec.ledger_contract.edge_keys,
    ["left", "right", "kind", "source_receipt"],
    "ledger_contract.edge_keys"
  );
  assertSameStringSet(
    spec.ledger_contract.source_receipt_keys,
    ["artifact", "sha256"],
    "ledger_contract.source_receipt_keys"
  );
  assertExactKeys(spec.ledger, DEPENDENCY_LEDGER_KEYS, "dependency ledger");
  if (spec.ledger.status === "pending_cp4_recertification") {
    for (const key of DEPENDENCY_LEDGER_KEYS.filter((key) => key !== "status")) {
      if (spec.ledger[key] !== null) {
        throw new Error(`pending dependency ledger.${key} must be null`);
      }
    }
  } else if (spec.ledger.status !== "owner_recertified") {
    throw new Error("dependency ledger has an unsupported status");
  }
  return true;
}

function dependencyLedgerPayload(ledger) {
  assertExactKeys(ledger, DEPENDENCY_LEDGER_KEYS, "dependency ledger");
  const payload = Object.create(null);
  for (const key of DEPENDENCY_LEDGER_PAYLOAD_KEYS) payload[key] = ledger[key];
  return payload;
}

/**
 * Canonicalize the dependency-ledger payload covered by its owner envelope.
 *
 * @param {object} ledger Dependency ledger from SHORTCUT_DEPENDENCY_SPEC.json.
 * @returns {string} Compact canonical JSON excluding `signature_envelope`.
 */
export function canonicalizeDependencyLedgerPayload(ledger) {
  return canonicalJson(dependencyLedgerPayload(ledger));
}

/**
 * Hash the canonical dependency-ledger payload bytes.
 *
 * @param {object} ledger Dependency ledger from SHORTCUT_DEPENDENCY_SPEC.json.
 * @returns {string} Lowercase SHA-256 digest.
 */
export function dependencyLedgerPayloadSha256(ledger) {
  return crypto.createHash("sha256")
    .update(canonicalizeDependencyLedgerPayload(ledger), "utf8")
    .digest("hex");
}

function validateDependencySignatureEnvelope(ledger, cp4Artifact) {
  if (ledger.status !== "owner_recertified") {
    throw new Error("committed dependency ledger is not owner-recertified");
  }
  assertExactKeys(
    ledger.signature_envelope,
    DEPENDENCY_SIGNATURE_ENVELOPE_KEYS,
    "committed dependency ledger.signature_envelope"
  );
  const envelope = ledger.signature_envelope;
  assertNonemptyString(envelope.owner_id, "committed dependency ledger.signature_envelope.owner_id");
  if (!SHA256_RE.test(envelope.cp4_payload_sha256)) {
    throw new Error("committed dependency ledger.signature_envelope.cp4_payload_sha256 must be a lowercase SHA-256 digest");
  }
  if (!SHA256_RE.test(envelope.ledger_payload_sha256)) {
    throw new Error("committed dependency ledger.signature_envelope.ledger_payload_sha256 must be a lowercase SHA-256 digest");
  }
  if (envelope.attestation !== DEPENDENCY_OWNER_ATTESTATION) {
    throw new Error("committed dependency ledger.signature_envelope.attestation differs from the frozen statement");
  }
  assertNonemptyString(
    envelope.signature,
    "committed dependency ledger.signature_envelope.signature"
  );
  const actualCp4Digest = cp4PayloadSha256(cp4Artifact);
  if (envelope.cp4_payload_sha256 !== actualCp4Digest
    || envelope.cp4_payload_sha256 !== cp4Artifact.signature_envelope.payload_sha256) {
    throw new Error("committed dependency ledger does not bind the signed canonical CP4 payload");
  }
  const actualLedgerDigest = dependencyLedgerPayloadSha256(ledger);
  if (envelope.ledger_payload_sha256 !== actualLedgerDigest) {
    throw new Error("committed dependency ledger signature envelope does not bind its canonical payload");
  }
  assertStrictUtcTimestamp(ledger.recertified_at, "committed dependency ledger.recertified_at");
  assertStrictUtcTimestamp(
    envelope.signed_at,
    "committed dependency ledger.signature_envelope.signed_at"
  );
  if (ledger.recertified_at !== envelope.signed_at) {
    throw new Error("committed dependency ledger.recertified_at must equal its envelope signed_at");
  }
  return {
    cp4_payload_sha256: actualCp4Digest,
    ledger_payload_sha256: actualLedgerDigest,
    signed_at: envelope.signed_at
  };
}

function validateScenarioIds(values, spec, location, requireSorted = false) {
  if (!Array.isArray(values)) throw new Error(`${location} must be an array`);
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    assertNonemptyString(values[index], `${location}[${index}]`);
    if (seen.has(values[index])) throw new Error(`${location} contains duplicate scenario IDs`);
    seen.add(values[index]);
  }
  if (values.length !== EXPECTED_SCENARIO_COUNT) throw new Error(`${location} must contain exactly 106 scenario IDs`);
  const sorted = sortedStrings(values);
  if (requireSorted && jsonBytes(values) !== jsonBytes(sorted)) {
    throw new Error(`${location} must be Unicode-code-point sorted`);
  }
  const digest = crypto.createHash("sha256").update(jsonBytes(sorted)).digest("hex");
  if (digest !== spec.corpus_id_set_sha256) throw new Error(`${location} does not match the frozen corpus ID-set hash`);
  return sorted;
}

function compareEdges(left, right) {
  return compareCodePointStrings(left.left, right.left)
    || compareCodePointStrings(left.right, right.right)
    || compareCodePointStrings(left.kind, right.kind);
}

function deriveComponents(scenarioIds, edges) {
  const adjacency = new Map(scenarioIds.map((scenarioId) => [scenarioId, new Set()]));
  for (const edge of edges) {
    adjacency.get(edge.left).add(edge.right);
    adjacency.get(edge.right).add(edge.left);
  }
  const visited = new Set();
  const components = [];
  for (const scenarioId of scenarioIds) {
    if (visited.has(scenarioId)) continue;
    const pending = [scenarioId];
    const component = [];
    visited.add(scenarioId);
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const current = pending[cursor];
      component.push(current);
      for (const neighbor of sortedStrings(adjacency.get(current))) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
    components.push(sortedStrings(component));
  }
  return components.sort((left, right) => compareCodePointStrings(left[0], right[0]));
}

function validateEdges(edges, scenarioIds, location) {
  if (!Array.isArray(edges)) throw new Error(`${location} must be an array`);
  const corpusIds = new Set(scenarioIds);
  const pairs = new Set();
  const normalized = edges.map((edge, index) => {
    const edgeLocation = `${location}[${index}]`;
    assertExactKeys(edge, ["left", "right", "kind", "source_receipt"], edgeLocation);
    assertNonemptyString(edge.left, `${edgeLocation}.left`);
    assertNonemptyString(edge.right, `${edgeLocation}.right`);
    if (!corpusIds.has(edge.left) || !corpusIds.has(edge.right)) throw new Error(`${edgeLocation} endpoint is outside the corpus`);
    if (edge.left === edge.right) throw new Error("dependency self-edges are forbidden");
    if (compareCodePointStrings(edge.left, edge.right) >= 0) throw new Error(`${edgeLocation} endpoints are not Unicode-code-point sorted`);
    if (!ALLOWED_KINDS.includes(edge.kind)) throw new Error(`${edgeLocation}.kind is unsupported`);
    const pair = jsonBytes([edge.left, edge.right]);
    if (pairs.has(pair)) throw new Error("duplicate dependency edge");
    pairs.add(pair);
    return {
      left: edge.left,
      right: edge.right,
      kind: edge.kind,
      source_receipt: normalizeReceipt(edge.source_receipt, `${edgeLocation}.source_receipt`)
    };
  }).sort(compareEdges);
  if (jsonBytes(edges) !== jsonBytes(normalized)) throw new Error(`${location} is not in deterministic sorted byte order`);
  return normalized;
}

function validateComponents(components, scenarioIds, edges, location) {
  if (!Array.isArray(components)) throw new Error(`${location} must be an array`);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (!Array.isArray(component) || component.length === 0) throw new Error(`${location}[${index}] must be a non-empty array`);
    for (let member = 0; member < component.length; member += 1) {
      assertNonemptyString(component[member], `${location}[${index}][${member}]`);
    }
  }
  const derived = deriveComponents(scenarioIds, edges);
  if (jsonBytes(components) !== jsonBytes(derived)) {
    throw new Error(`${location} do not equal the edge-derived components`);
  }
  return derived;
}

function validateCandidate(candidate, spec, location) {
  assertExactKeys(candidate, ["scenario_ids", "edges", "components"], location);
  const scenarioIds = validateScenarioIds(candidate.scenario_ids, spec, `${location}.scenario_ids`, true);
  const edges = validateEdges(candidate.edges, scenarioIds, `${location}.edges`);
  const components = validateComponents(candidate.components, scenarioIds, edges, `${location} components`);
  return { scenario_ids: scenarioIds, edges, components };
}

/**
 * Generate the deterministic dependency-ledger candidate from CP4 records.
 *
 * @param {object} recertificationLedger CP4 artifact containing a `records` array.
 * @param {object} options Generator options.
 * @param {object} options.dependencySpec Parsed SHORTCUT_DEPENDENCY_SPEC.json.
 * @returns {{scenario_ids:Array<string>,edges:Array<object>,components:Array<Array<string>>}} Derived candidate ledger.
 * @throws {Error} If the corpus binding, claims, receipts, or edge provenance are invalid.
 */
export function generateCp4DependencyLedger(recertificationLedger, { dependencySpec } = {}) {
  validateCp4DependencySpec(dependencySpec);
  if (!isPlainObject(recertificationLedger) || !Array.isArray(recertificationLedger.records)) {
    throw new Error("recertificationLedger.records must be an array");
  }
  const groups = new Map(ALLOWED_KINDS.map((kind) => [kind, new Map()]));
  const scenarioIds = [];
  const seenScenarioIds = new Set();
  recertificationLedger.records.forEach((record, rowIndex) => {
    const location = `recertificationLedger.records[${rowIndex}]`;
    if (!isPlainObject(record)) throw new Error(`${location} must be an object`);
    assertNonemptyString(record.scenario_id, `${location}.scenario_id`);
    if (seenScenarioIds.has(record.scenario_id)) throw new Error("recertification records contain duplicate scenario IDs");
    seenScenarioIds.add(record.scenario_id);
    scenarioIds.push(record.scenario_id);
    if (!Object.hasOwn(record, "dependency_claims")) throw new Error(`${location}.dependency_claims is required`);
    if (!isPlainObject(record.dependency_claims)) throw new Error(`${location}.dependency_claims must be an object`);
    for (const kind of Object.keys(record.dependency_claims)) {
      if (FORBIDDEN_CLAIMS.includes(kind)) throw new Error(`forbidden broad dependency claim ${kind}`);
      if (!ALLOWED_KINDS.includes(kind)) throw new Error(`unsupported dependency claim kind ${kind}`);
    }
    for (const kind of ALLOWED_KINDS) {
      const claims = record.dependency_claims[kind];
      if (!Array.isArray(claims)) throw new Error(`${location}.dependency_claims.${kind} must be an explicit array`);
      const seenClaims = new Set();
      for (let claimIndex = 0; claimIndex < claims.length; claimIndex += 1) {
        if (!Object.hasOwn(claims, claimIndex)) throw new Error(`${location}.dependency_claims.${kind} must not be sparse`);
        const claim = claims[claimIndex];
        const claimLocation = `${location}.dependency_claims.${kind}[${claimIndex}]`;
        assertExactKeys(claim, ["id", "source_receipt"], claimLocation);
        assertNonemptyString(claim.id, `${claimLocation}.id`);
        if (seenClaims.has(claim.id)) throw new Error(`${claimLocation}.id duplicates a claim in the same row`);
        seenClaims.add(claim.id);
        const receipt = normalizeReceipt(claim.source_receipt, `${claimLocation}.source_receipt`);
        const kindGroups = groups.get(kind);
        if (!kindGroups.has(claim.id)) kindGroups.set(claim.id, { receipt, scenarioIds: [] });
        const group = kindGroups.get(claim.id);
        if (jsonBytes(group.receipt) !== jsonBytes(receipt)) {
          throw new Error(`${kind} claim ${JSON.stringify(claim.id)} has conflicting source receipts`);
        }
        group.scenarioIds.push(record.scenario_id);
      }
    }
  });
  const sortedScenarioIds = validateScenarioIds(scenarioIds, dependencySpec, "recertification scenario IDs");
  const edges = [];
  const edgeClaims = new Map();
  for (const kind of ALLOWED_KINDS) {
    const kindGroups = groups.get(kind);
    for (const claimId of sortedStrings(kindGroups.keys())) {
      const group = kindGroups.get(claimId);
      const members = sortedStrings(group.scenarioIds);
      for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
          const left = members[leftIndex];
          const right = members[rightIndex];
          if (left === right) throw new Error("dependency self-edges are forbidden");
          const pair = jsonBytes([left, right]);
          if (edgeClaims.has(pair)) {
            throw new Error(`endpoint pair ${pair} arises from multiple claims or kinds; owner resolution is required`);
          }
          edgeClaims.set(pair, { kind, claimId });
          edges.push({ left, right, kind, source_receipt: { ...group.receipt } });
        }
      }
    }
  }
  edges.sort(compareEdges);
  return {
    scenario_ids: sortedScenarioIds,
    edges,
    components: deriveComponents(sortedScenarioIds, edges)
  };
}

/**
 * Assert that generated dependency bytes equal the owner-recertified ledger.
 *
 * @param {object} generatedLedger Candidate returned by {@link generateCp4DependencyLedger}.
 * @param {object} committedSpec Parsed committed SHORTCUT_DEPENDENCY_SPEC.json.
 * @returns {true} True when scenario, edge, and component bytes match exactly.
 * @throws {Error} If either ledger is malformed or any committed byte differs.
 */
export function assertDependencyLedgerMatches(generatedLedger, committedSpec) {
  validateCp4DependencySpec(committedSpec);
  const generated = validateCandidate(generatedLedger, committedSpec, "generated dependency ledger");
  const ledger = committedSpec.ledger;
  assertExactKeys(ledger, DEPENDENCY_LEDGER_KEYS, "committed dependency ledger");
  if (ledger.status !== "owner_recertified") throw new Error("committed dependency ledger is not owner-recertified");
  const committed = validateCandidate({
    scenario_ids: ledger.scenario_ids,
    edges: ledger.edges,
    components: ledger.components
  }, committedSpec, "committed dependency");
  if (jsonBytes(generated.scenario_ids) !== jsonBytes(committed.scenario_ids)) {
    throw new Error("committed dependency scenario ID bytes differ from generated bytes");
  }
  if (jsonBytes(generated.edges) !== jsonBytes(committed.edges)) {
    throw new Error("committed dependency edge bytes differ from generated bytes");
  }
  if (jsonBytes(generated.components) !== jsonBytes(committed.components)) {
    throw new Error("committed dependency component bytes differ from generated bytes");
  }
  return true;
}

/**
 * Validate the complete CP4-to-dependency-ledger activation boundary.
 *
 * The CP4 artifact supplies the signed dependency claims. This validator
 * verifies that artifact, regenerates the dependency graph, compares every
 * generated ledger byte with the committed ledger, and checks both declared
 * payload digests and the dependency ledger's signing timestamp. Signature
 * authenticity remains outside this deterministic validator.
 *
 * @param {object} recertificationLedger Complete signed CP4 recertification artifact.
 * @param {object} committedSpec Parsed committed SHORTCUT_DEPENDENCY_SPEC.json.
 * @param {object} [options] CP4 validation options.
 * @param {string} [options.repositoryRoot] Absolute root used to resolve CP4 receipts.
 * @returns {{cp4_payload_sha256:string,ledger_payload_sha256:string,signed_at:string}} Verified activation receipt.
 * @throws {Error} If CP4, regenerated ledger, hashes, timestamps, or envelopes differ.
 */
export function validateDependencyActivation(
  recertificationLedger,
  committedSpec,
  options = {}
) {
  const validatedCp4 = validateCp4Recertification(recertificationLedger, options);
  if (validatedCp4.status !== OWNER_RECERTIFIED) {
    throw new Error("dependency activation requires an owner-recertified CP4 artifact");
  }
  const generated = generateCp4DependencyLedger(validatedCp4, {
    dependencySpec: committedSpec
  });
  assertDependencyLedgerMatches(generated, committedSpec);
  return validateDependencySignatureEnvelope(committedSpec.ledger, validatedCp4);
}
