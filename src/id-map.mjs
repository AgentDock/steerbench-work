// Opaque identifier lookup for every model-visible byte.
//
// ID_MAP.json is authoritative wherever it has an entry: tokens are read from
// it rather than recomputed, so renaming a source id while keeping its mapped
// token leaves rendered bytes identical. Missing maps and unmapped ids fail
// closed. A frozen run must never invent a token outside the reviewed map.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAP_SALT = "steerbench-work-v2-id-map";
const SCENARIO_TOKEN = /^s-[0-9a-f]{10}$/;
const EVIDENCE_TOKEN = /^e-[0-9a-f]{10}$/;
const MAP_PATH = path.join(ROOT, "ID_MAP.json");

let map = null;

function validateMap(candidate, file) {
  if (candidate?.version !== 1 || candidate?.salt !== MAP_SALT
    || !candidate.scenarios || typeof candidate.scenarios !== "object"
    || Array.isArray(candidate.scenarios)
    || !candidate.evidence || typeof candidate.evidence !== "object"
    || Array.isArray(candidate.evidence)) {
    throw new Error(`invalid opaque id map: ${file}`);
  }

  const tokens = [];
  for (const [scenarioId, token] of Object.entries(candidate.scenarios)) {
    if (!scenarioId || !SCENARIO_TOKEN.test(token)) {
      throw new Error(`invalid scenario token in opaque id map: ${scenarioId}=${JSON.stringify(token)}`);
    }
    tokens.push(token);
  }
  for (const [scenarioId, table] of Object.entries(candidate.evidence)) {
    if (!Object.hasOwn(candidate.scenarios, scenarioId)
      || !table || typeof table !== "object" || Array.isArray(table)) {
      throw new Error(`invalid evidence table in opaque id map: ${scenarioId}`);
    }
    for (const [evidenceId, token] of Object.entries(table)) {
      if (!evidenceId || !EVIDENCE_TOKEN.test(token)) {
        throw new Error(`invalid evidence token in opaque id map: ${scenarioId}/${evidenceId}=${JSON.stringify(token)}`);
      }
      tokens.push(token);
    }
  }
  if (new Set(tokens).size !== tokens.length) {
    throw new Error(`opaque id map contains duplicate tokens: ${file}`);
  }
}

function load() {
  if (map) return map;
  if (!fs.existsSync(MAP_PATH)) {
    throw new Error(`opaque id map not found: ${MAP_PATH}`);
  }
  map = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  validateMap(map, MAP_PATH);
  return map;
}

/**
 * Build validated opaque-ID resolvers for an in-memory map.
 *
 * Production does not call this function: it always reads the committed
 * ID_MAP.json. Offline tests use it to prove rename/token invariants without
 * introducing a runtime environment override.
 *
 * @param {object} candidate - Complete map-shaped object to validate.
 * @param {string} [source] - Diagnostic label for validation errors.
 * @returns {{scenarioIdFor:(scenarioId:string)=>string,evidenceIdFor:(scenarioId:string,evidenceId:string)=>string}}
 *   Fail-closed lookup functions bound to the validated candidate.
 */
export function opaqueIdResolversForMap(candidate, source = "in-memory opaque id map") {
  const boundMap = structuredClone(candidate);
  validateMap(boundMap, source);
  return {
    scenarioIdFor(scenarioId) {
      return scenarioTokenFor(boundMap, scenarioId);
    },
    evidenceIdFor(scenarioId, evidenceId) {
      return evidenceTokenFor(boundMap, scenarioId, evidenceId);
    }
  };
}

function scenarioTokenFor(candidate, scenarioId) {
  if (typeof scenarioId !== "string" || !scenarioId) {
    throw new Error(`cannot map a non-string scenario id: ${JSON.stringify(scenarioId)}`);
  }
  const token = candidate.scenarios[scenarioId];
  if (!token) throw new Error(`scenario id is absent from the opaque id map: ${scenarioId}`);
  return token;
}

function evidenceTokenFor(candidate, scenarioId, evidenceId) {
  if (typeof scenarioId !== "string" || !scenarioId) {
    throw new Error(`cannot map evidence without a scenario id: ${JSON.stringify(scenarioId)}`);
  }
  if (typeof evidenceId !== "string" || !evidenceId) {
    throw new Error(`cannot map a non-string evidence id: ${JSON.stringify(evidenceId)}`);
  }
  const token = candidate.evidence?.[scenarioId]?.[evidenceId];
  if (!token) throw new Error(`evidence id is absent from the opaque id map: ${scenarioId}/${evidenceId}`);
  return token;
}

/**
 * Opaque token for a scenario id.
 *
 * @param {string} scenarioId - Descriptive source id (join key, never rendered).
 * @returns {string} Opaque token safe to render.
 * @throws Error if the id is missing or not a string.
 */
export function opaqueScenarioId(scenarioId) {
  return scenarioTokenFor(load(), scenarioId);
}

/**
 * Opaque token for an evidence identifier within a scenario.
 *
 * @param {string} scenarioId - Descriptive scenario id (join key, never rendered).
 * @param {string} evidenceId - Descriptive evidence id or legacy_id.
 * @returns {string} Opaque token safe to render.
 * @throws Error if either identifier is missing or not a string.
 */
export function opaqueEvidenceId(scenarioId, evidenceId) {
  return evidenceTokenFor(load(), scenarioId, evidenceId);
}
