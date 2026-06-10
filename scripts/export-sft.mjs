// SFT exporter for SteerBench-Work.
//
// Renders every scenario through the same pipeline the benchmark runner
// uses (reshapeToLegacy + buildModelInputFor), pairs it with the gold
// assistant response derived from expected_behavior, and writes Tinker
// cookbook SFT JSONL: one {"messages": [...]} object per line, nothing
// else. Provenance lives in a sidecar file next to the JSONL so the
// training file itself stays renderer-clean.
//
// Usage:
//   node scripts/export-sft.mjs --scenario-set-dir <dir> \
//     [--splits <splits.json> --split <name>] --out <dir>
//
// Two splits-file shapes are accepted:
//   plain map:  { "train": ["id-a", "id-b"], "val": ["id-c"] }
//   assignment artifact (scripts/assign-splits.mjs output), whose
//   `assignments` object maps scenario id -> split name

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { reshapeToLegacy, buildModelInputFor } from "../src/canonical-runner.mjs";
import { STEERBENCH_STEERING_SYSTEM_PROMPT } from "../src/prompts.mjs";
import { ALLOWED_POLICY_ACTIONS } from "../src/schema.mjs";
import { CANONICAL_SCORING_MAPPING } from "../src/scorer.mjs";
import { sha256File } from "../src/manifest.mjs";

const USAGE = `Usage: node scripts/export-sft.mjs --scenario-set-dir <dir> [--splits <file> --split <name>] --out <dir>

Exports supervised training-view rows ({"messages": [...]} JSONL, the
tinker-cookbook chat shape) plus a provenance sidecar per row.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

export const EXPORTER_VERSION = "sft-exporter/0.1.0";

// Labels exported now predate the human-gold pass, so every row says so.
export const LABEL_SOURCE = "benchmark-owner-pre-gold";

// expected_behavior.correct_action uses the scoring vocabulary, which is a
// superset of the model-facing policy_action enum. "block" and "proceed"
// are scoring verbs, not emittable actions, so the gold policy_action maps
// each to the schema action whose inferred gate state agrees with the
// canonical scoring mapping. Verbs already in the enum pass through.
const SCORING_VERB_TO_POLICY_ACTION = {
  block: "request_approval",
  proceed: "continue"
};

/**
 * Build the gold assistant response object for one scenario's
 * expected_behavior. Field set matches src/schema.mjs exactly.
 */
export function goldResponseFor(expectedBehavior) {
  const correctAction = expectedBehavior?.correct_action;
  const commitPermission = CANONICAL_SCORING_MAPPING[correctAction];
  if (!commitPermission) {
    throw new Error(`correct_action "${correctAction}" has no canonical scoring mapping`);
  }
  const policyAction = ALLOWED_POLICY_ACTIONS.includes(correctAction)
    ? correctAction
    : SCORING_VERB_TO_POLICY_ACTION[correctAction];
  if (!policyAction) {
    throw new Error(`correct_action "${correctAction}" maps to no policy_action`);
  }
  const blocked = commitPermission === "blocked";
  const clarificationMode = !blocked
    ? "none"
    : correctAction === "ask_clarification"
      ? "answer_then_commit"
      : "refuse_pending_auth";
  // Held gates explain the human correction; open gates explain why the
  // commit is clean. Collapse whitespace so the reason stays one line.
  const reasonSource = blocked
    ? expectedBehavior.human_correction || expectedBehavior.autonomous_failure
    : expectedBehavior.clean_outcome || expectedBehavior.recovery_summary;
  const reason = String(reasonSource || `Expected action: ${correctAction}.`)
    .replace(/\s+/g, " ")
    .trim();
  return {
    policy_action: policyAction,
    commit_permission: commitPermission,
    human_required: blocked,
    clarification_mode: clarificationMode,
    confidence: 1,
    reason
  };
}

/**
 * Render the three-message SFT example for one raw scenario JSON. The
 * system and user contents are byte-identical to what the benchmark
 * runner sends on the wire.
 */
export function messagesFor(rawScenario) {
  const { model_input } = buildModelInputFor(reshapeToLegacy(rawScenario));
  return [
    { role: "system", content: STEERBENCH_STEERING_SYSTEM_PROMPT },
    { role: "user", content: `scenario_id: ${rawScenario.id}\n\n${model_input}` },
    { role: "assistant", content: JSON.stringify(goldResponseFor(rawScenario.expected_behavior)) }
  ];
}

/**
 * Resolve the scenario-id set for one named split. Accepts both the plain
 * { name: [ids] } map and the assign-splits.mjs artifact, whose
 * `assignments` object maps scenario id -> split name. Returns null when
 * the split name is unknown to the file.
 */
function splitIdsFrom(splits, splitName) {
  const assignments = splits?.assignments;
  if (assignments && typeof assignments === "object" && !Array.isArray(assignments)) {
    const known = splits.per_split
      ? Object.keys(splits.per_split)
      : [...new Set(Object.values(assignments))];
    if (!known.includes(splitName)) return null;
    return new Set(
      Object.keys(assignments).filter((id) => assignments[id] === splitName)
    );
  }
  return Array.isArray(splits?.[splitName]) ? new Set(splits[splitName]) : null;
}

function listScenarioFiles(scenarioSetDir) {
  return fs.readdirSync(scenarioSetDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("_"))
    .map((e) => path.join(scenarioSetDir, e.name))
    .sort();
}

/**
 * Export the scenario set as SFT JSONL plus a provenance sidecar.
 * Returns { rows, jsonlPath, provenancePath }.
 */
export function exportSft({ scenarioSetDir, splitsPath, splitName, outDir }) {
  let splitIds = null;
  if (splitsPath) {
    if (!splitName) throw new Error("--splits requires --split <name>");
    const splits = JSON.parse(fs.readFileSync(splitsPath, "utf8"));
    splitIds = splitIdsFrom(splits, splitName);
    if (!splitIds) {
      throw new Error(`split "${splitName}" not found in ${splitsPath}`);
    }
  }

  const lines = [];
  const provenanceRows = [];
  const seenIds = new Set();
  for (const filePath of listScenarioFiles(scenarioSetDir)) {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw.id) throw new Error(`scenario without id: ${filePath}`);
    seenIds.add(raw.id);
    if (splitIds && !splitIds.has(raw.id)) continue;
    const line = JSON.stringify({ messages: messagesFor(raw) });
    lines.push(line);
    provenanceRows.push({
      scenario_id: raw.id,
      scenario_sha256: sha256File(filePath),
      split: splitName || null,
      label_source: LABEL_SOURCE,
      exporter_version: EXPORTER_VERSION,
      // SHA-256 of the exact JSONL line bytes (utf-8, no trailing newline),
      // so any row can be re-verified against the file directly.
      render_sha256: createHash("sha256").update(line, "utf8").digest("hex")
    });
  }

  if (splitIds) {
    const missing = [...splitIds].filter((id) => !seenIds.has(id));
    if (missing.length > 0) {
      throw new Error(`split ids missing from scenario set: ${missing.join(", ")}`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const jsonlPath = path.join(outDir, "sft.jsonl");
  const provenancePath = path.join(outDir, "sft.provenance.json");
  fs.writeFileSync(jsonlPath, lines.map((l) => `${l}\n`).join(""));
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenanceRows, null, 2)}\n`);
  return { rows: lines.length, jsonlPath, provenancePath };
}

function parseArgs(argv) {
  const args = {};
  const flags = {
    "--scenario-set-dir": "scenarioSetDir",
    "--splits": "splitsPath",
    "--split": "splitName",
    "--out": "outDir"
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    if (!key || argv[i + 1] === undefined) {
      throw new Error(`unexpected or valueless argument: ${argv[i]}`);
    }
    args[key] = argv[i + 1];
  }
  if (!args.scenarioSetDir || !args.outDir) {
    throw new Error("required: --scenario-set-dir <dir> --out <dir>");
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { rows, jsonlPath, provenancePath } = exportSft(parseArgs(process.argv.slice(2)));
  console.log(`wrote ${rows} rows`);
  console.log(`  ${jsonlPath}`);
  console.log(`  ${provenancePath}`);
}
