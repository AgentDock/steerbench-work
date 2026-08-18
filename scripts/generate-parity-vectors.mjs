// Generates integrations/tinker/parity-vectors.json: the bridge file that
// lets the Python Tinker reward adapter (integrations/tinker/steerbench_env.py)
// score responses without reimplementing the Node render pipeline or holding
// its own copy of the scoring policy table.
//
// The file carries three things:
//
//   1. Rendered model inputs for every scenario in the set, produced by the
//      same reshapeToLegacy + buildModelInputFor pipeline the benchmark runner
//      uses, in the exact wire format the runner sends (system prompt plus a
//      opaque "scenario_ref: <token>" user header). Python reads these; it
//      never renders.
//
//   2. The scoring vocabulary (allowed commit_permission values) and the
//      canonical expected_action -> required commit_permission mapping, read
//      from src/schema.mjs and src/scorer.mjs. Python reads the table from
//      the file, so the policy lives in exactly one codebase.
//
//   3. Response parity cases: synthetic response strings with expected
//      format/correctness results computed here by the real Node scorer
//      (isCorrectByPermission). The Python adapter replays them in its
//      __main__ self-test; test/parity-vectors.test.mjs replays them on the
//      Node side.
//
// Reward contract note: the adapter's format gate is STRICTER than the
// benchmark trial extractor. The benchmark side (src/schema.mjs) recovers
// fenced JSON and infers commit_permission from policy_action so that off
// the shelf models can still be scored. The RL reward intentionally requires
// a top-level JSON object with an explicit, valid commit_permission field;
// a policy being trained should not be paid for output the extractor had to
// rescue. The edge cases below pin that divergence explicitly.
//
// Labels exported here are benchmark-owner pre-gold labels; every output
// carries label_source so downstream consumers cannot mistake them for
// human-adjudicated gold.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildScenarioManifest } from "../src/manifest.mjs";
import { reshapeToLegacy, buildModelInputFor } from "../src/canonical-runner.mjs";
import { STEERBENCH_STEERING_SYSTEM_PROMPT } from "../src/prompts.mjs";
import { ALLOWED_COMMIT_PERMISSION, SCORED_FIELD } from "../src/schema.mjs";
import { CANONICAL_SCORING_MAPPING, isCorrectByPermission } from "../src/scorer.mjs";
import { renderUserMessage } from "../src/model-input.mjs";

const USAGE = `Usage: node scripts/generate-parity-vectors.mjs

Regenerates integrations/tinker/parity-vectors.json: rendered inputs, gold
labels, the canonical scoring map, and scorer test cases for the Python
reward adapter.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

export const EXPORTER_VERSION = "generate-parity-vectors.mjs/0.1.0";
export const LABEL_SOURCE = "benchmark-owner-pre-gold";

const SCENARIO_SET = "steerbench-work-2026-05";
const SCENARIO_SET_DIR = "scenario-sets/steerbench-work-2026-05";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATH = path.join(repoRoot, "integrations", "tinker", "parity-vectors.json");

/**
 * Strict reward-contract parse of a response string.
 *
 * The response must be a top-level JSON object whose commit_permission field
 * is a string in the allowed enum. No fenced-block recovery, no inference
 * from policy_action. Returns the commit_permission value, or null when the
 * response fails the contract. This function defines check_format for both
 * sides of the parity test; steerbench_env.py mirrors it line for line.
 *
 * @param {string} responseStr
 * @returns {string|null}
 */
export function strictCommitPermission(responseStr) {
  let obj;
  try {
    obj = JSON.parse(responseStr);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const value = obj.commit_permission;
  if (typeof value !== "string" || !ALLOWED_COMMIT_PERMISSION.includes(value)) return null;
  return value;
}

/**
 * Score one synthetic response against a scenario's expected action.
 * Format comes from the strict contract above; correctness comes from the
 * real scorer (isCorrectByPermission). A response that fails the format
 * gate can never be correct.
 *
 * @param {string} expectedAction
 * @param {string} responseStr
 * @returns {{ expected_format_ok: boolean, expected_correct: boolean }}
 */
export function scoreResponseCase(expectedAction, responseStr) {
  const value = strictCommitPermission(responseStr);
  if (value === null) {
    return { expected_format_ok: false, expected_correct: false };
  }
  return {
    expected_format_ok: true,
    expected_correct: isCorrectByPermission(expectedAction, value) === true
  };
}

/**
 * Full-schema response in the shape the steering prompt asks for. Used for
 * the per-scenario gate cases so the parity set exercises realistic output,
 * not just minimal objects.
 */
function fullSchemaResponse(commitPermission) {
  const blocked = commitPermission === "blocked";
  return JSON.stringify({
    policy_action: blocked ? "request_approval" : "continue",
    commit_permission: commitPermission,
    human_required: blocked,
    clarification_mode: "none",
    confidence: 0.9,
    reason: blocked
      ? "Material risk before the boundary; hold for review."
      : "Current evidence supports the action; commit now.",
    state_to_show: ["proposed_action", "evidence", "risk_flags"]
  });
}

// Edge catalog: responses that pin the strict reward contract, including the
// cases where it is deliberately stricter than the benchmark extractor.
const EDGE_CASES = [
  { name: "minimal-blocked", response: '{"commit_permission":"blocked"}' },
  { name: "minimal-allowed", response: '{"commit_permission":"allowed"}' },
  { name: "surrounding-whitespace", response: '  {\n  "commit_permission": "allowed"\n}  ' },
  { name: "enum-violation", response: '{"commit_permission":"maybe"}' },
  { name: "case-sensitive-enum", response: '{"commit_permission":"Allowed"}' },
  // The benchmark extractor would infer blocked/allowed from policy_action
  // here; the reward contract refuses to.
  { name: "policy-action-only", response: '{"policy_action":"continue","reason":"looks fine"}' },
  // The benchmark extractor would recover the embedded object; the reward
  // contract requires bare JSON.
  { name: "fenced-json", response: '```json\n{"commit_permission":"blocked"}\n```' },
  { name: "prose-then-json", response: 'The gate should hold. {"commit_permission":"blocked"}' },
  { name: "bare-word", response: "blocked" },
  { name: "json-array", response: '["blocked"]' },
  { name: "boolean-value", response: '{"commit_permission":true}' },
  { name: "null-value", response: '{"commit_permission":null}' }
];

/**
 * Pick one representative scenario per distinct expected_action (first id in
 * sorted order) to host the edge catalog, so edge expectations are pinned
 * against every branch of the scoring mapping without inflating the file
 * with 106 copies of the same cases.
 */
function edgeHostScenarios(scenarios) {
  const hosts = new Map();
  for (const s of [...scenarios].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!hosts.has(s.expected_action)) hosts.set(s.expected_action, s);
  }
  return [...hosts.values()];
}

export function buildParityVectors() {
  const manifest = buildScenarioManifest({
    scenarioSet: SCENARIO_SET,
    scenarioSetDir: SCENARIO_SET_DIR,
    scenarioSetDirAbsolute: path.join(repoRoot, SCENARIO_SET_DIR)
  });

  const scenarios = [];
  for (const entry of manifest.scenarios) {
    if (entry.expected_action == null) {
      throw new Error(`Scenario ${entry.id} has no expected_action; cannot export a reward label`);
    }
    const required = CANONICAL_SCORING_MAPPING[entry.expected_action];
    if (!required) {
      throw new Error(`Scenario ${entry.id} expected_action "${entry.expected_action}" is not in CANONICAL_SCORING_MAPPING`);
    }
    const rawPath = path.join(repoRoot, SCENARIO_SET_DIR, entry.file);
    const rawJson = JSON.parse(fs.readFileSync(rawPath, "utf8"));
    const scenario = reshapeToLegacy(rawJson);
    const { model_input } = buildModelInputFor(scenario);
    scenarios.push({
      id: entry.id,
      file: entry.file,
      sha256: entry.sha256,
      expected_action: entry.expected_action,
      required_commit_permission: required,
      // Exact user-message bytes the benchmark runner sends. The system
      // prompt is shared and hoisted to the top level of this file.
      user_input: renderUserMessage({ scenarioId: entry.id, modelInput: model_input })
    });
  }

  const responseCases = [];
  // Per-scenario gate pair: one allowed response and one blocked response,
  // so every scenario's gold label is exercised in both directions.
  for (const s of scenarios) {
    for (const permission of ALLOWED_COMMIT_PERMISSION) {
      const response = fullSchemaResponse(permission);
      responseCases.push({
        case_id: `${s.id}::gate-${permission}`,
        scenario_id: s.id,
        expected_action: s.expected_action,
        response,
        ...scoreResponseCase(s.expected_action, response)
      });
    }
  }
  // Edge catalog against one host scenario per expected_action.
  for (const host of edgeHostScenarios(scenarios)) {
    for (const edge of EDGE_CASES) {
      responseCases.push({
        case_id: `${host.id}::edge-${edge.name}`,
        scenario_id: host.id,
        expected_action: host.expected_action,
        response: edge.response,
        ...scoreResponseCase(host.expected_action, edge.response)
      });
    }
  }

  return {
    schema_version: "steerbench.tinker_parity_vectors.v1",
    exporter_version: EXPORTER_VERSION,
    label_source: LABEL_SOURCE,
    generated_at: new Date().toISOString(),
    scenario_set: SCENARIO_SET,
    scenario_set_dir: SCENARIO_SET_DIR,
    scoring_field: SCORED_FIELD,
    allowed_commit_permission: [...ALLOWED_COMMIT_PERMISSION],
    canonical_scoring_mapping: { ...CANONICAL_SCORING_MAPPING },
    system_prompt: STEERBENCH_STEERING_SYSTEM_PROMPT,
    scenario_count: scenarios.length,
    scenarios,
    response_case_count: responseCases.length,
    response_cases: responseCases
  };
}

function main() {
  const vectors = buildParityVectors();
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(vectors, null, 2) + "\n");

  const byAction = {};
  for (const s of vectors.scenarios) {
    byAction[s.expected_action] = (byAction[s.expected_action] || 0) + 1;
  }
  const bytes = fs.statSync(OUTPUT_PATH).size;
  console.log(`parity vectors written: ${path.relative(repoRoot, OUTPUT_PATH)}`);
  console.log(`  exporter_version: ${vectors.exporter_version}`);
  console.log(`  label_source: ${vectors.label_source}`);
  console.log(`  scenarios: ${vectors.scenario_count}`);
  console.log(`  expected_action histogram: ${JSON.stringify(byAction)}`);
  console.log(`  response cases: ${vectors.response_case_count} (gate pairs: ${vectors.scenario_count * 2}, edge: ${vectors.response_case_count - vectors.scenario_count * 2})`);
  console.log(`  file size: ${(bytes / 1024).toFixed(1)} KiB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
