// Audit the boundary-pattern layer of the site data.
//
// Confirms three invariants:
//   - the boundary-pattern inference code never reads scored answer-key signal,
//     so a construction tag can never leak the scored label;
//   - every published scenario row carries complete, assigned boundary-pattern
//     fields, and curated risk patterns come only from the explicit sidecar;
//   - the scoring path (scorer, runner, validator, aggregator) never reads
//     boundary_pattern, keeping construction metadata out of the scored result.
//
// Usage: node scripts/audit-boundary-patterns.mjs [path-to-scenarios-detail.json]

import fs from "node:fs";
import path from "node:path";

const runnerRoot = process.cwd();
const siteDataPath = process.argv[2]
  ?? path.resolve(runnerRoot, "../steerbench-site/src/data/scenarios-detail.json");
const generatorPath = path.resolve(runnerRoot, "scripts/build-scenarios-detail.mjs");
const manifestPath = path.resolve(runnerRoot, "runs/canonical-multi-trial/tm-locked-2026-05-29/SCENARIO_MANIFEST.json");
const scenarioSetDir = path.resolve(runnerRoot, "scenario-sets/steerbench-work-2026-05");

function fail(message) {
  throw new Error(message);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function countBy(items, getKey) {
  const out = {};
  for (const item of items) {
    const key = typeof getKey === "function" ? getKey(item) : item[getKey];
    out[key ?? "null"] = (out[key ?? "null"] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) fail(`missing function ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function auditGeneratorSource() {
  const source = fs.readFileSync(generatorPath, "utf8");
  const inferenceCode = [
    functionBlock(source, "inferBoundaryPattern"),
    functionBlock(source, "inferredSecondaryPatterns"),
    functionBlock(source, "boundaryPatternFor")
  ].join("\n");

  for (const forbidden of [
    "expected_action",
    "correct_action",
    "PROCEED_ACTIONS",
    "HOLD_ACTIONS",
    "PROCEED",
    "HOLD"
  ]) {
    if (inferenceCode.includes(forbidden)) {
      fail(`boundary-pattern inference must not read scored answer-key signal: ${forbidden}`);
    }
  }
}

function auditSiteData() {
  const doc = readJson(siteDataPath);
  const scenarios = doc.scenarios || [];
  if (scenarios.length !== 106) fail(`expected 106 scenarios, got ${scenarios.length}`);
  if ((doc.models || []).length < 1) fail("site data has no model roster");

  const missingPattern = scenarios.filter((s) =>
    !s.boundary_pattern
    || !s.boundary_pattern_label
    || !s.boundary_pattern_definition
    || !s.boundary_pattern_source
    || !s.boundary_pattern_source_label
    || !s.boundary_pattern_inference_note
  );
  if (missingPattern.length) {
    fail(`missing boundary-pattern fields on ${missingPattern.length} rows: ${missingPattern.slice(0, 5).map((s) => s.id).join(", ")}`);
  }

  const unassigned = scenarios.filter((s) => s.boundary_pattern === "unassigned");
  if (unassigned.length) fail(`unassigned boundary patterns remain: ${unassigned.map((s) => s.id).join(", ")}`);

  const nullDirectionRisk = scenarios.filter((s) => s.direction == null && s.boundary_pattern === "risk_unresolved");
  if (nullDirectionRisk.length) {
    fail(`calibration/null-direction rows must not be labeled risk_unresolved: ${nullDirectionRisk.map((s) => s.id).join(", ")}`);
  }

  const inferredRisk = scenarios.filter((s) =>
    (s.boundary_pattern === "risk_resolved" || s.boundary_pattern === "risk_unresolved")
    && s.boundary_pattern_source !== "curated_sidecar"
  );
  if (inferredRisk.length) {
    fail(`risk_resolved/risk_unresolved must be explicit sidecar curation only: ${inferredRisk.map((s) => s.id).join(", ")}`);
  }

  const curated = scenarios.filter((s) => s.boundary_pattern_source === "curated_sidecar");
  if (curated.length !== 8) fail(`expected 8 curated sidecar rows, got ${curated.length}`);

  return {
    scenarios: scenarios.length,
    models: (doc.models || []).length,
    pattern_counts: countBy(scenarios, "boundary_pattern"),
    source_counts: countBy(scenarios, "boundary_pattern_source"),
    null_direction_pattern_counts: countBy(scenarios.filter((s) => s.direction == null), "boundary_pattern")
  };
}

function auditManifestSafety() {
  const locked = readJson(manifestPath);
  const sidecar = path.join(scenarioSetDir, "_SCENARIO_PATTERNS.json");
  if (!fs.existsSync(sidecar)) fail("missing underscore-prefixed boundary-pattern sidecar");

  const scenarioFiles = fs.readdirSync(scenarioSetDir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .sort();
  if (scenarioFiles.length !== 106) fail(`manifest-visible json count should be 106, got ${scenarioFiles.length}`);
  if (scenarioFiles.includes("_SCENARIO_PATTERNS.json")) fail("sidecar is manifest-visible");

  const lockedFiles = new Set(locked.scenarios.map((s) => s.file));
  const missing = scenarioFiles.filter((name) => !lockedFiles.has(name));
  if (missing.length) fail(`unexpected scenario files outside locked manifest: ${missing.join(", ")}`);
}

function auditScoringIsolation() {
  const files = [
    "src/scorer.mjs",
    "src/canonical-runner.mjs",
    "scripts/validate-run.mjs",
    "scripts/aggregate-canonical.mjs"
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.resolve(runnerRoot, rel), "utf8");
    if (text.includes("boundary_pattern")) fail(`${rel} must not read boundary_pattern`);
  }
}

auditGeneratorSource();
const dataSummary = auditSiteData();
auditManifestSafety();
auditScoringIsolation();

console.log(JSON.stringify({ ok: true, ...dataSummary }, null, 2));
