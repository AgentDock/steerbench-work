#!/usr/bin/env node
// Offline shortcut-gate runner. This script only reads local artifacts and
// performs deterministic calculations. It has no provider or model path.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  calibrateHistoricalV1InSample,
  evaluateShortcutGate,
  typedCanonicalKey
} from "../src/shortcut-gate.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_CORPUS = path.join(ROOT, "scenario-sets/steerbench-work-2026-05");
const DEFAULT_FEATURE_SPEC = path.join(ROOT, "SHORTCUT_FEATURE_SPEC.json");
const DEFAULT_DEPENDENCY_SPEC = path.join(ROOT, "SHORTCUT_DEPENDENCY_SPEC.json");
const DEFAULT_HISTORICAL_ROWS = path.join(ROOT, "HISTORICAL_V1_SHORTCUT_ROWS.json");
const HISTORICAL_RELEASE_MANIFEST = path.join(ROOT, "results/v2026-05/release-manifest.json");

/**
 * Resolve the complete frozen source set that a shortcut-row artifact binds.
 * Directory entries use the same recursive typed-manifest hash as
 * {@link hashSourcePath}; callers may override individual paths explicitly.
 *
 * @param {object} [options] Source-path overrides.
 * @param {string} [options.corpusPath] Scenario-set directory.
 * @param {string} [options.featureSpecPath] Feature-spec file.
 * @param {string} [options.dependencySpecPath] Dependency-spec file.
 * @param {string} [options.patternsPath] Scenario-pattern sidecar.
 * @returns {Record<string, string>} Absolute paths keyed by source-hash name.
 */
export function defaultShortcutSourcePaths({
  corpusPath = DEFAULT_CORPUS,
  featureSpecPath = DEFAULT_FEATURE_SPEC,
  dependencySpecPath = DEFAULT_DEPENDENCY_SPEC,
  patternsPath = path.join(corpusPath, "_SCENARIO_PATTERNS.json")
} = {}) {
  return {
    corpus: path.resolve(corpusPath),
    renderer: path.join(ROOT, "src"),
    feature_spec: path.resolve(featureSpecPath),
    dependency_spec: path.resolve(dependencySpecPath),
    evidence_schema: path.join(ROOT, "EVIDENCE_RENDER_SCHEMA.json"),
    warning_rules: path.join(ROOT, "WARNING_RULES.json"),
    proposed_access_schema: path.join(ROOT, "PROPOSED_ACCESS_SCHEMA.json"),
    id_map: path.join(ROOT, "ID_MAP.json"),
    scenario_patterns: path.resolve(patternsPath)
  };
}

function readJsonDocument(filePath, label) {
  try {
    const bytes = fs.readFileSync(filePath);
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`cannot read ${label} at ${filePath}: ${error.message}`);
  }
}

function readJson(filePath, label) {
  return readJsonDocument(filePath, label).value;
}

function compareCodePointStrings(left, right) {
  const a = [...left].map((character) => character.codePointAt(0));
  const b = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function directoryEntries(root, current = root) {
  const entries = [];
  for (const name of fs.readdirSync(current).sort(compareCodePointStrings)) {
    const absolute = path.join(current, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`source hash refuses symlink ${absolute}`);
    if (stat.isDirectory()) entries.push(...directoryEntries(root, absolute));
    else if (stat.isFile()) {
      entries.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        sha256: sha256Bytes(fs.readFileSync(absolute))
      });
    } else {
      throw new Error(`source hash refuses non-file ${absolute}`);
    }
  }
  return entries;
}

/**
 * Hash a source file or directory under the frozen shortcut-spec algorithm.
 *
 * @param {string} sourcePath File or directory to hash.
 * @returns {string} Lowercase SHA-256 digest.
 */
export function hashSourcePath(sourcePath) {
  const absolute = path.resolve(sourcePath);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`source hash refuses symlink ${absolute}`);
  if (stat.isFile()) return sha256Bytes(fs.readFileSync(absolute));
  if (!stat.isDirectory()) throw new Error(`source path is neither file nor directory: ${absolute}`);
  const entries = directoryEntries(absolute).sort((left, right) => compareCodePointStrings(left.path, right.path));
  return sha256Bytes(typedCanonicalKey(entries));
}

function parseArguments(argv) {
  const parsed = { sources: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if ([
      "--rows",
      "--historical-rows",
      "--out",
      "--feature-spec",
      "--dependency-spec",
      "--corpus",
      "--patterns"
    ].includes(argument)) {
      if (index + 1 >= argv.length) throw new Error(`${argument} requires a value`);
      parsed[argument.slice(2).replaceAll("-", "_")] = argv[++index];
      continue;
    }
    if (argument === "--source") {
      if (index + 1 >= argv.length) throw new Error("--source requires name=path");
      const assignment = argv[++index];
      const separator = assignment.indexOf("=");
      if (separator <= 0 || separator === assignment.length - 1) throw new Error("--source requires name=path");
      const name = assignment.slice(0, separator);
      if (Object.hasOwn(parsed.sources, name)) throw new Error(`duplicate --source ${name}`);
      parsed.sources[name] = assignment.slice(separator + 1);
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  return parsed;
}

function writeReport(report, outputPath) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(outputPath, serialized);
  else process.stdout.write(serialized);
}

/**
 * Run the offline CLI and return its process-style status.
 *
 * @param {Array<string>} argv CLI arguments without node/script prefixes.
 * @returns {number} Zero on pass, two on a fail-closed corpus status.
 */
export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const featureSpecPath = path.resolve(options.feature_spec || DEFAULT_FEATURE_SPEC);
  const dependencySpecPath = path.resolve(options.dependency_spec || DEFAULT_DEPENDENCY_SPEC);
  const corpusPath = path.resolve(options.corpus || DEFAULT_CORPUS);
  const patternsPath = path.resolve(options.patterns || path.join(corpusPath, "_SCENARIO_PATTERNS.json"));
  const featureSpec = readJson(featureSpecPath, "shortcut feature spec");
  const dependencySpec = readJson(dependencySpecPath, "shortcut dependency spec");
  const historicalRowsPath = path.resolve(options.historical_rows || DEFAULT_HISTORICAL_ROWS);
  const historicalRows = readJson(historicalRowsPath, "historical v1 shortcut rows");
  const historicalRelease = readJsonDocument(
    HISTORICAL_RELEASE_MANIFEST,
    "historical v1 release manifest"
  );
  if (historicalRelease.value?.schema_version !== "steerbench.release_manifest.v1"
    || historicalRelease.value?.release !== "v2026-05"
    || historicalRelease.value?.scenario_set !== "steerbench-work-2026-05"
    || historicalRelease.value?.scenario_count !== featureSpec.expected_scenario_count) {
    throw new Error("historical v1 release manifest differs from the frozen release contract");
  }
  const historical = calibrateHistoricalV1InSample(historicalRows, featureSpec, {
    release_manifest_sha256: sha256Bytes(historicalRelease.bytes),
    scenario_hashes: historicalRelease.value.scenario_hashes
  });

  let productionGate;
  if (!options.rows) {
    productionGate = evaluateShortcutGate({ featureSpec, dependencySpec });
  } else {
    const rowArtifactPath = path.resolve(options.rows);
    const rowArtifact = readJson(rowArtifactPath, "shortcut row artifact");
    const required = featureSpec.row_artifact.required_source_hashes;
    const defaultSources = defaultShortcutSourcePaths({
      corpusPath,
      featureSpecPath,
      dependencySpecPath,
      patternsPath
    });
    const actualSourceHashes = {};
    for (const name of required) {
      const sourcePath = options.sources[name] || defaultSources[name];
      if (!sourcePath) throw new Error(`production row evaluation requires --source ${name}=PATH`);
      actualSourceHashes[name] = hashSourcePath(sourcePath);
    }
    productionGate = evaluateShortcutGate({
      featureSpec,
      dependencySpec,
      rowArtifact,
      actualSourceHashes,
      scenarioPatterns: readJson(patternsPath, "scenario patterns")
    });
  }

  writeReport({
    schema_version: "steerbench.shortcut_check.v1",
    historical_v1_calibration: historical,
    production_gate: productionGate
  }, options.out ? path.resolve(options.out) : null);
  return productionGate.status === "PASS" ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
