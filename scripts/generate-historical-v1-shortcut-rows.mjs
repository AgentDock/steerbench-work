#!/usr/bin/env node
// Generate the audit-only input rows for the frozen historical-v1 shortcut
// calibration. Raw scenarios are read only here, never by the production
// shortcut command, and every byte hash is checked before any row is parsed.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_SCORING_MAPPING } from "../src/scorer.mjs";
import {
  HISTORICAL_V1_SHORTCUT_ROWS_SCHEMA_VERSION,
  hasExactServiceSignatureKey,
  typedSortedMultiset
} from "../src/shortcut-gate.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_CORPUS = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const DEFAULT_RELEASE_MANIFEST = path.join(ROOT, "results/v2026-05/release-manifest.json");
const DEFAULT_OUT = path.join(ROOT, "HISTORICAL_V1_SHORTCUT_ROWS.json");
const EXPECTED_SCENARIO_COUNT = 106;
const EXPECTED_RELEASE = "v2026-05";
const EXPECTED_SCENARIO_SET = "steerbench-work-2026-05";
const SHA256_RE = /^[0-9a-f]{64}$/u;

function compareCodePointStrings(left, right) {
  const a = [...left].map((character) => character.codePointAt(0));
  const b = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function sortedStrings(values) {
  return [...values].sort(compareCodePointStrings);
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseJsonBytes(bytes, location) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`cannot parse ${location}: ${error.message}`);
  }
}

function assertFrozenReleaseManifest(manifest) {
  if (manifest?.schema_version !== "steerbench.release_manifest.v1") {
    throw new Error("unsupported historical release manifest");
  }
  if (manifest.release !== EXPECTED_RELEASE || manifest.scenario_set !== EXPECTED_SCENARIO_SET) {
    throw new Error("historical release manifest identifies a different release or scenario set");
  }
  if (manifest.scenario_count !== EXPECTED_SCENARIO_COUNT) {
    throw new Error("historical release manifest does not contain the frozen scenario count");
  }
  if (manifest.scenario_hashes === null
    || typeof manifest.scenario_hashes !== "object"
    || Array.isArray(manifest.scenario_hashes)) {
    throw new Error("historical release manifest scenario_hashes must be an object");
  }
  const scenarioIds = Object.keys(manifest.scenario_hashes);
  if (scenarioIds.length !== EXPECTED_SCENARIO_COUNT) {
    throw new Error("historical release manifest requires exactly 106 scenario hashes");
  }
  if (JSON.stringify(scenarioIds) !== JSON.stringify(sortedStrings(scenarioIds))) {
    throw new Error("historical release manifest scenario hashes must use sorted scenario IDs");
  }
  for (const scenarioId of scenarioIds) {
    if (!SHA256_RE.test(manifest.scenario_hashes[scenarioId])) {
      throw new Error(`historical release manifest hash for ${scenarioId} is not SHA-256`);
    }
  }
  return scenarioIds;
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--corpus", "--release-manifest", "--out"].includes(argument)) {
      if (index + 1 >= argv.length) throw new Error(`${argument} requires a value`);
      parsed[argument.slice(2).replaceAll("-", "_")] = argv[++index];
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  return parsed;
}

function historicalAuditRow(scenario, scenarioId) {
  if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
    throw new Error(`historical scenario ${scenarioId} must be an object`);
  }
  if (scenario.id !== scenarioId) {
    throw new Error(`historical scenario ID mismatch for ${scenarioId}`);
  }
  const expectedAction = scenario.expected_behavior?.correct_action;
  if (!Object.hasOwn(CANONICAL_SCORING_MAPPING, expectedAction)) {
    throw new Error(`historical scenario ${scenarioId} has an unknown expected action`);
  }
  const evidence = scenario.evidence || [];
  if (!Array.isArray(evidence)) throw new Error(`historical scenario ${scenarioId}.evidence must be an array`);
  const statuses = [];
  const literalToolCallEvidenceIds = [];
  let signaturePresence = false;
  for (const [index, record] of evidence.entries()) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`historical scenario ${scenarioId}.evidence[${index}] must be an object`);
    }
    const status = record.status ?? "";
    if (typeof status !== "string") {
      throw new Error(`historical scenario ${scenarioId}.evidence[${index}].status must be a string when present`);
    }
    statuses.push(status);
    if (hasExactServiceSignatureKey(record.tool_call_result)) signaturePresence = true;
    if (record.source_type === "tool_call") {
      const literalId = record.legacy_id || record.id;
      if (typeof literalId !== "string" || literalId.length === 0) {
        throw new Error(`historical scenario ${scenarioId}.evidence[${index}] lacks a literal tool-call evidence ID`);
      }
      literalToolCallEvidenceIds.push(literalId);
    }
  }
  return {
    scenario_id: scenarioId,
    label: CANONICAL_SCORING_MAPPING[expectedAction],
    evidence_count_status: [evidence.length, typedSortedMultiset(statuses)],
    signature_presence: signaturePresence,
    literal_tool_call_evidence_ids: typedSortedMultiset(literalToolCallEvidenceIds)
  };
}

/**
 * Build the frozen historical-v1 shortcut rows after checking all raw hashes.
 *
 * @param {object} [options] Input path overrides.
 * @param {string} [options.corpusPath] Raw historical scenario directory.
 * @param {string} [options.releaseManifestPath] Frozen release manifest.
 * @returns {object} Audit-only rows and their exact release bindings.
 */
export function generateHistoricalV1ShortcutRows({
  corpusPath = DEFAULT_CORPUS,
  releaseManifestPath = DEFAULT_RELEASE_MANIFEST
} = {}) {
  const absoluteCorpus = path.resolve(corpusPath);
  const absoluteManifest = path.resolve(releaseManifestPath);
  const manifestBytes = fs.readFileSync(absoluteManifest);
  const releaseManifest = parseJsonBytes(manifestBytes, `release manifest ${absoluteManifest}`);
  const scenarioIds = assertFrozenReleaseManifest(releaseManifest);

  const directoryEntries = fs.readdirSync(absoluteCorpus, { withFileTypes: true });
  const scenarioFiles = directoryEntries
    .filter((entry) => entry.name.endsWith(".json") && !entry.name.startsWith("_"))
    .sort((left, right) => compareCodePointStrings(left.name, right.name));
  if (scenarioFiles.some((entry) => !entry.isFile())) {
    throw new Error("historical scenario corpus refuses non-file JSON entries");
  }
  const fileScenarioIds = scenarioFiles.map((entry) => entry.name.slice(0, -".json".length));
  if (JSON.stringify(fileScenarioIds) !== JSON.stringify(scenarioIds)) {
    throw new Error("historical scenario files differ from the release-manifest ID set");
  }

  // Read and hash the complete set first. No scenario JSON is parsed and no
  // feature or label is extracted until every frozen byte hash has matched.
  const sources = scenarioFiles.map((entry, index) => {
    const scenarioId = scenarioIds[index];
    const filePath = path.join(absoluteCorpus, entry.name);
    const bytes = fs.readFileSync(filePath);
    return { scenarioId, filePath, bytes, sha256: sha256Bytes(bytes) };
  });
  const mismatches = sources.filter(
    (source) => source.sha256 !== releaseManifest.scenario_hashes[source.scenarioId]
  );
  if (mismatches.length > 0) {
    throw new Error(`historical scenario byte hash mismatch: ${mismatches.map((source) => source.scenarioId).join(", ")}`);
  }

  const scenarioHashes = Object.fromEntries(sources.map((source) => [source.scenarioId, source.sha256]));
  const rows = sources.map((source) => historicalAuditRow(
    parseJsonBytes(source.bytes, `historical scenario ${source.filePath}`),
    source.scenarioId
  ));
  return {
    schema_version: HISTORICAL_V1_SHORTCUT_ROWS_SCHEMA_VERSION,
    release_manifest_sha256: sha256Bytes(manifestBytes),
    scenario_count: EXPECTED_SCENARIO_COUNT,
    scenario_hashes: scenarioHashes,
    rows
  };
}

/**
 * Serialize historical rows with stable indentation and a final newline.
 *
 * @param {object} artifact Generated historical rows.
 * @returns {string} Deterministic JSON bytes.
 */
export function serializeHistoricalV1ShortcutRows(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/**
 * Generate and write the frozen historical-v1 shortcut rows.
 *
 * @param {object} [options] Generation and output path overrides.
 * @param {string} [options.corpusPath] Raw historical scenario directory.
 * @param {string} [options.releaseManifestPath] Frozen release manifest.
 * @param {string} [options.outPath] Destination JSON file.
 * @returns {{artifact: object, bytes: string}} Written artifact and exact bytes.
 */
export function writeHistoricalV1ShortcutRows({
  corpusPath = DEFAULT_CORPUS,
  releaseManifestPath = DEFAULT_RELEASE_MANIFEST,
  outPath = DEFAULT_OUT
} = {}) {
  const artifact = generateHistoricalV1ShortcutRows({ corpusPath, releaseManifestPath });
  const bytes = serializeHistoricalV1ShortcutRows(artifact);
  fs.writeFileSync(path.resolve(outPath), bytes);
  return { artifact, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const outPath = path.resolve(options.out || DEFAULT_OUT);
    const { artifact } = writeHistoricalV1ShortcutRows({
      corpusPath: options.corpus ? path.resolve(options.corpus) : DEFAULT_CORPUS,
      releaseManifestPath: options.release_manifest
        ? path.resolve(options.release_manifest)
        : DEFAULT_RELEASE_MANIFEST,
      outPath
    });
    process.stdout.write(`wrote ${outPath}: ${artifact.scenario_count} historical audit rows\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
