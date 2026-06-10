// Scenario manifest module for SteerBench-Work.
//
// One scenario manifest is built at run-plan time and frozen into the run
// root as SCENARIO_MANIFEST.json. The runner reads scenarios from the live
// directory but verifies each one's file hash against the manifest before
// using it. The validator reads the manifest from the run root, re-hashes
// the live files, and fails on any drift.
//
// The manifest is the contract between the protocol snapshot and any
// downstream artifact. A scenario whose bytes change after the manifest
// is written cannot enter scoring without explicit re-planning.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeDomain } from "./normalize.mjs";

/**
 * Compute SHA-256 of a file's raw bytes. Reads as a Buffer to avoid
 * normalization through utf-8 round-tripping.
 */
export function sha256File(filePath) {
  const bytes = fs.readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build a scenario manifest by enumerating *.json files under
 * `scenarioSetDir`. Skips files that do not parse, files that have no
 * `id`, and files whose name starts with an underscore.
 *
 * If `scenarioFilter` is provided as a Set<string> of scenario ids, the
 * manifest contains only those scenarios. Used by smoke mode so the
 * manifest reflects the scenarios that will actually be run.
 *
 * The returned object is intended to be serialized as JSON with 2-space
 * indent and frozen into the run root.
 */
export function buildScenarioManifest({
  scenarioSet,
  scenarioSetDir,
  scenarioSetDirAbsolute,
  scenarioFilter = null
}) {
  // scenarioSetDir is what the manifest records (portable, usually
  // relative to the runner repo root). scenarioSetDirAbsolute is what
  // the manifest builder actually reads from on disk; it defaults to
  // scenarioSetDir for backward compatibility when the caller does not
  // distinguish the two.
  const readDir = scenarioSetDirAbsolute || scenarioSetDir;
  if (!fs.existsSync(readDir)) {
    throw new Error(`Scenario set directory not found: ${readDir}`);
  }
  const names = fs.readdirSync(readDir)
    .filter((n) => n.endsWith(".json") && !n.startsWith("_"))
    .sort();

  const scenarios = [];
  for (const name of names) {
    const filePath = path.join(readDir, name);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      throw new Error(`Failed to parse scenario file ${name}: ${e.message}`);
    }
    if (!json.id) {
      throw new Error(`Scenario file ${name} is missing required field "id"`);
    }
    if (scenarioFilter !== null && !scenarioFilter.has(json.id)) continue;
    // One canonical domain. For tagged scenarios it comes from
    // taxonomy.domain; for the synthetic baselines it is normalized once
    // from their raw top-level label. The raw label is consumed here and
    // not carried forward as a field.
    const domain = normalizeDomain({
      taxonomyDomain: json.taxonomy?.domain ?? null,
      legacyDomain: json.domain ?? null
    });
    scenarios.push({
      id: json.id,
      file: name,
      sha256: sha256File(filePath),
      expected_action: json.expected_behavior?.correct_action ?? null,
      direction: json.taxonomy?.direction ?? null,
      functional_category: json.taxonomy?.functional_category ?? null,
      domain,
      source_provenance: json.taxonomy?.source_provenance ?? null,
      irreversibility_class: json.irreversibility_class ?? null,
      action_verb: json.action_verb ?? null,
      tags: Array.isArray(json.tags) ? json.tags : [],
      license: json.license ?? null,
      version: json.version ?? null
    });
  }

  if (scenarioFilter !== null) {
    const matchedIds = new Set(scenarios.map((s) => s.id));
    const missing = [...scenarioFilter].filter((id) => !matchedIds.has(id));
    if (missing.length > 0) {
      throw new Error(`scenarioFilter referenced unknown scenarios: ${missing.join(", ")}`);
    }
  }

  // Release-style identity. The folder name carries the release tag;
  // count, hashes, taxonomy, and scoring contract live in the manifest.
  // `name` is the family ("steerbench-work"); `release` is the dated
  // identifier inside that family ("2026-05").
  const [family, release] = scenarioSet.split("-").reduce((acc, part) => {
    if (acc.length === 0 || /^\d{4}/.test(part)) acc.push(part);
    else acc[acc.length - 1] = `${acc[acc.length - 1]}-${part}`;
    return acc;
  }, []);

  return {
    schema_version: "steerbench.scenario_manifest.v1",
    name: family || scenarioSet,
    release: release || null,
    role: "reported",
    scoring_field: "commit_permission",
    scenario_set: scenarioSet,
    scenario_set_dir: scenarioSetDir,
    generated_at: new Date().toISOString(),
    scenario_count: scenarios.length,
    scenarios
  };
}

/**
 * Read SCENARIO_MANIFEST.json from a run root.
 */
export function loadScenarioManifestFromRunRoot(runRoot) {
  const p = path.join(runRoot, "SCENARIO_MANIFEST.json");
  if (!fs.existsSync(p)) {
    throw new Error(`SCENARIO_MANIFEST.json missing at ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Write SCENARIO_MANIFEST.json into a run root.
 */
export function writeScenarioManifestToRunRoot(runRoot, manifest) {
  fs.mkdirSync(runRoot, { recursive: true });
  const p = path.join(runRoot, "SCENARIO_MANIFEST.json");
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
  return p;
}

/**
 * Build a quick lookup map from scenario id to its manifest entry.
 */
export function indexManifestById(manifest) {
  const map = new Map();
  for (const s of manifest.scenarios) map.set(s.id, s);
  return map;
}

/**
 * Re-hash every scenario file referenced by the manifest and report
 * drift. Returns { ok, drifted: [{id, expected_sha256, live_sha256}],
 * missing: [id] }.
 */
export function verifyManifestAgainstLive(manifest, scenarioSetDir) {
  const drifted = [];
  const missing = [];
  for (const entry of manifest.scenarios) {
    const filePath = path.join(scenarioSetDir, entry.file);
    if (!fs.existsSync(filePath)) {
      missing.push(entry.id);
      continue;
    }
    const liveHash = sha256File(filePath);
    if (liveHash !== entry.sha256) {
      drifted.push({
        id: entry.id,
        file: entry.file,
        expected_sha256: entry.sha256,
        live_sha256: liveHash
      });
    }
  }
  return {
    ok: drifted.length === 0 && missing.length === 0,
    drifted,
    missing
  };
}
