// Fail-closed evidence selection, validation, and model-facing rendering.
//
// EVIDENCE_RENDER_SCHEMA.json is the sole contract for source evidence keys,
// types, enums, and visibility. This module interprets that contract; it does
// not keep a second field allowlist in code.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { opaqueEvidenceId } from "./id-map.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const EVIDENCE_RENDER_SCHEMA_PATH = path.join(ROOT, "EVIDENCE_RENDER_SCHEMA.json");

function loadContract() {
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(EVIDENCE_RENDER_SCHEMA_PATH, "utf8"));
  } catch (error) {
    throw new Error(`cannot load evidence render schema: ${error.message}`);
  }
  if (contract?.schema_version !== "steerbench.evidence-render.v1"
    || contract?.fence_language !== "json"
    || !isPlainObject(contract.generated_fields?.evidence_ref)
    || !isPlainObject(contract.source_record)
    || contract.source_record.type !== "object"
    || contract.source_record.additional_properties !== false
    || !Array.isArray(contract.source_record.required)
    || !isPlainObject(contract.source_record.properties)) {
    throw new Error(`invalid evidence render schema: ${EVIDENCE_RENDER_SCHEMA_PATH}`);
  }
  for (const [key, rule] of Object.entries(contract.source_record.properties)) {
    if (!key || !isPlainObject(rule) || typeof rule.render !== "boolean") {
      throw new Error(`invalid evidence source rule for ${JSON.stringify(key)}`);
    }
  }
  return deepFreeze(contract);
}

export const EVIDENCE_RENDER_SCHEMA = loadContract();

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

function typeMatches(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === "object") return isPlainObject(value);
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "null") return value === null;
    return typeof value === type;
  });
}

function validateJsonValue(value, location) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} must contain a finite JSON number`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error(`${location} contains a sparse array`);
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
  throw new Error(`${location} contains a non-JSON value`);
}

function validateByRule(value, rule, location) {
  if (!typeMatches(value, rule.type)) {
    const expected = Array.isArray(rule.type) ? rule.type.join(" or ") : rule.type;
    throw new Error(`${location} must be ${expected}`);
  }
  if (rule.enum && !rule.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${location} is outside the allowed enum`);
  }
  if (typeof value === "string") {
    if (rule.min_length !== undefined && value.length < rule.min_length) {
      throw new Error(`${location} is shorter than ${rule.min_length}`);
    }
    if (rule.pattern && !new RegExp(rule.pattern, "u").test(value)) {
      throw new Error(`${location} does not match ${rule.pattern}`);
    }
  }
  if (isPlainObject(value)) {
    const properties = rule.properties || {};
    for (const key of rule.required || []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${location}.${key} is required`);
    }
    if (rule.additional_properties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) throw new Error(`${location}.${key} is not allowed`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateByRule(child, properties[key], `${location}.${key}`);
      else validateJsonValue(child, `${location}.${key}`);
    }
  } else {
    validateJsonValue(value, location);
  }
}

/**
 * Validate one raw source evidence record against the frozen contract.
 *
 * @param {object} record - Raw scenario evidence object.
 * @param {string} [location] - Diagnostic path used in failures.
 * @returns {void}
 */
export function validateEvidenceSourceRecord(record, location = "evidence") {
  validateByRule(record, EVIDENCE_RENDER_SCHEMA.source_record, location);
}

/**
 * Preserve raw evidence fields and resolve the decision-point selection with
 * an exact, unique id/legacy_id join.
 *
 * @param {Array<object>} records - Raw scenario evidence records.
 * @param {Array<string>} selectedIds - decision_point.evidence_ids.
 * @returns {{evidence:Array<object>, evidenceIds:Array<string>}}
 *   Runtime evidence plus selected runtime join keys in authored order.
 */
export function prepareRuntimeEvidence(records = [], selectedIds = []) {
  if (!Array.isArray(records)) throw new Error("evidence must be an array");
  if (!Array.isArray(selectedIds)) throw new Error("decision_point.evidence_ids must be an array");

  const aliases = new Map();
  const evidence = records.map((source, index) => {
    validateEvidenceSourceRecord(source, `evidence[${index}]`);
    const runtimeId = source.legacy_id || source.id;
    for (const alias of new Set([source.id, source.legacy_id].filter(Boolean))) {
      if (aliases.has(alias)) {
        throw new Error(`evidence alias ${JSON.stringify(alias)} is not unique`);
      }
      aliases.set(alias, { index, runtimeId });
    }
    return { ...structuredClone(source), evidence_id: runtimeId };
  });

  const selectedRecords = new Set();
  const evidenceIds = selectedIds.map((selectedId, index) => {
    if (typeof selectedId !== "string" || !selectedId) {
      throw new Error(`decision_point.evidence_ids[${index}] must be a non-empty string`);
    }
    const match = aliases.get(selectedId);
    if (!match) {
      throw new Error(
        `decision_point.evidence_ids id ${JSON.stringify(selectedId)} does not resolve exactly`
      );
    }
    if (selectedRecords.has(match.index)) {
      throw new Error(`selected evidence record ${JSON.stringify(selectedId)} appears more than once`);
    }
    selectedRecords.add(match.index);
    return match.runtimeId;
  });

  return { evidence, evidenceIds };
}

function canonicalize(value, location = "value") {
  validateJsonValue(value, location);
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${location}[${index}]`));
  if (!isPlainObject(value)) return value;
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    output[key] = canonicalize(value[key], `${location}.${key}`);
  }
  return output;
}

/**
 * Serialize JSON with recursive object-key sorting and escaped backticks.
 * Array order and JSON primitive types are preserved.
 *
 * @param {*} value - JSON-compatible value.
 * @returns {string} Deterministic, single-line canonical JSON.
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value)).replaceAll("`", "\\u0060");
}

/**
 * Render selected runtime evidence records as independently parseable fenced
 * canonical JSON objects in the supplied selection order.
 *
 * @param {object} args
 * @param {string} args.scenarioId - Descriptive scenario join key, never rendered.
 * @param {Array<object>} args.evidence - Selected runtime evidence records.
 * @param {(scenarioId:string,evidenceId:string)=>string} [args.evidenceIdFor]
 *   Opaque evidence-reference resolver.
 * @returns {string} Fenced records, or "none" for an empty selection.
 */
export function renderEvidenceRecords({ scenarioId, evidence, evidenceIdFor = opaqueEvidenceId }) {
  if (!Array.isArray(evidence)) throw new Error("selected evidence must be an array");
  const seenRuntimeIds = new Set();
  const records = evidence.map((runtimeRecord, index) => {
    if (!isPlainObject(runtimeRecord)) throw new Error(`selected evidence[${index}] must be an object`);
    const { evidence_id: evidenceId, ...source } = runtimeRecord;
    if (typeof evidenceId !== "string" || !evidenceId) {
      throw new Error(`selected evidence[${index}].evidence_id must be a non-empty string`);
    }
    if (seenRuntimeIds.has(evidenceId)) {
      throw new Error(`selected evidence id ${JSON.stringify(evidenceId)} appears more than once`);
    }
    seenRuntimeIds.add(evidenceId);
    validateEvidenceSourceRecord(source, `selected evidence[${index}]`);

    const evidenceRef = evidenceIdFor(scenarioId, evidenceId);
    validateByRule(
      evidenceRef,
      EVIDENCE_RENDER_SCHEMA.generated_fields.evidence_ref,
      `selected evidence[${index}].evidence_ref`
    );
    const visible = { evidence_ref: evidenceRef };
    for (const [key, rule] of Object.entries(EVIDENCE_RENDER_SCHEMA.source_record.properties)) {
      if (rule.render && Object.hasOwn(source, key)) visible[key] = source[key];
    }

    const json = canonicalJson(visible);
    const parsed = JSON.parse(json);
    if (Object.hasOwn(source, "tool_call_result")
      && !isDeepStrictEqual(parsed.tool_call_result, source.tool_call_result)) {
      throw new Error(`selected evidence[${index}].tool_call_result changed during rendering`);
    }
    return `\`\`\`${EVIDENCE_RENDER_SCHEMA.fence_language}\n${json}\n\`\`\``;
  });
  return records.length ? records.join("\n") : "none";
}
