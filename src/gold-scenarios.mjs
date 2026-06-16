/**
 * @fileoverview Shared scenario loading and record shaping for the human validation
 * verdict pass.
 * @module src/gold-scenarios
 *
 * The verdict human validation pass labels gate and irreversibility on all 106 scenarios
 * and the failure mechanism only on the 76 diagnostic ones. Diagnostic vs
 * baseline is decided by `source_basis` (the 30 calibration baselines carry an
 * empty source_basis and no taxonomy tag), never by the redacted answer-key
 * `functional_category`, which the rater must not see.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Canonical released scenario set. */
export const SCENARIO_DIR = path.join(here, "..", "scenario-sets", "steerbench-work-2026-05");

/** Normalizes source_basis (string or array) to a trimmed string. */
function sourceBasisText(scenario) {
  const sb = scenario.source_basis;
  if (Array.isArray(sb)) return sb.join(" ").trim();
  return typeof sb === "string" ? sb.trim() : "";
}

/**
 * A scenario is diagnostic (gets a failure-mechanism label) when it has a
 * non-empty source_basis. Baselines have an empty source_basis and are auto
 * marked not_applicable.
 *
 * @param {object} scenario
 * @returns {boolean}
 */
export function isDiagnostic(scenario) {
  return sourceBasisText(scenario).length > 0;
}

/**
 * Loads all real scenarios from a scenario-set directory, id-sorted for a
 * stable order across raters and resumable sessions. Non-scenario JSON
 * (manifests, schemas) is excluded by requiring an id and a user request.
 *
 * @param {string} [dir] - scenario-set directory
 * @returns {object[]}
 */
export function loadGoldScenarios(dir = SCENARIO_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .filter((s) => s && s.id && (s.user_request || s.event?.user_request))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Builds a human-annotated gold label record in the shape the agreement scorer consumes.
 * Baselines always get functional_category = not_applicable.
 *
 * @param {object} args - scenario, rater, gate, tier, mechanism, note
 * @returns {object}
 */
export function buildGoldRecord({ scenario, rater, gate, tier, mechanism, note = "", now = new Date() }) {
  return {
    scenario_id: scenario.id,
    annotator: rater,
    is_human: true,
    ok: true,
    labels: {
      gate_state: gate,
      irreversibility_tier: tier,
      functional_category: isDiagnostic(scenario) ? mechanism : "not_applicable",
      rationale: note || ""
    },
    labeled_at_utc: now.toISOString()
  };
}
