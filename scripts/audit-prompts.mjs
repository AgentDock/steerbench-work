#!/usr/bin/env node
/**
 * @fileoverview Zero-API dry audit of the allowlisted, task-split annotation
 * prompts. Builds every prompt that WOULD be sent, leak-scans the evidence each
 * one carries, and writes an audit artifact. Run and pass this before any live
 * annotation call.
 * @module scripts/audit-prompts
 *
 * @remarks
 * Two prompt views per the task split:
 *   - scenario-label (right_call + irreversibility): evidence only, no model output.
 *   - mechanism (functional_category): evidence + the observable refusal.
 *
 * The leak scan runs on the EVIDENCE (user) prompt with the output-format line
 * removed, so the label names in the question are not mistaken for leaks. It
 * fails if the evidence contains the scenario's own id or title, the answer
 * values, or any answer-telegraphing field name or structural token. The
 * scenario id appears only in this audit record, never inside a prompt.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildScenarioLabelSystemPrompt,
  buildScenarioLabelUserPrompt,
  buildMechanismSystemPrompt,
  buildMechanismUserPrompt
} from "../src/annotator-panel.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.join(__dirname, "..");
const SCENARIO_DIR = path.join(runnerRoot, "scenario-sets", "steerbench-work-2026-05");

/**
 * Scan the evidence portion of a user prompt for leaks. Strips the output-format
 * instruction first so the requested label keys are not flagged.
 *
 * The scan matches each scenario's OWN answer content, not generic tokens. A
 * generic substring list (mirror, direction, taxonomy, expected_, ...) false-
 * positives on legitimate operational English (e.g. `expected_output_lines=1400`,
 * "workspace mirror, for human readability", "our fraud taxonomy",
 * `direction='right'`), so the scan uses per-scenario value matching instead: the
 * id, title, the irreversibility/taxonomy answer values (exact), and the
 * hidden-trap / incident-narrative / expected-behavior texts (opening fragment).
 * This catches a real leak of THIS scenario's answer while leaving ordinary
 * evidence wording alone.
 *
 * @param {string} userPrompt
 * @param {object} scenario - raw scenario (for its own answer values)
 * @returns {string[]} list of leak hits (empty = clean)
 */
// Answer-key / construction field NAMES the allowlist excludes. Matched as JSON
// keys ("name":), which is precise: a forbidden key in the prompt means the
// builder leaked that field. Only DISTINCTIVE answer-key names are listed.
// Common operational keys that legitimately appear nested in tool results
// (title = a doc/issue title, tier = a subscription tier, direction = a compass
// heading) are deliberately NOT listed: the top-level scenario title/tier are
// already excluded by the allowlist, and the scenario title VALUE is checked
// separately below, so listing the bare key would only flag legitimate evidence.
const FORBIDDEN_KEYS = Object.freeze([
  "irreversibility_class", "hidden_trap", "taxonomy",
  "expected_behavior", "expected_steering", "expected_evidence", "evidence_used", "evidence_missing",
  "incident_narrative", "steering_intervention", "cost_comparison", "quantified_impact",
  "integrity_flags_fired", "legacy_id", "raw_ref",
  "source_basis", "source_url", "source_quote", "source_incident_url", "source_incident_summary",
  "tier_a_subcategory", "incident_class", "mirror_explanation", "structural_distinction"
]);

/**
 * Scan the evidence portion of a user prompt. Strips the output-format line so
 * the requested label keys are not flagged.
 *
 * FAIL = a builder leak: a forbidden field KEY appears (e.g. `"raw_ref":`), or
 * the scenario's own id/title/answer-text appears verbatim. Value words (high,
 * direction, mirror, taxonomy) are NOT failed: those are ordinary evidence
 * English and the fields they come from are not in the allowlist anyway.
 * REVIEW = the scenario's evidence itself names the failure direction; a
 * scenario-content question for the operator, not a redaction bug.
 *
 * @param {string} userPrompt
 * @param {object} scenario
 * @returns {{ fail: string[], review: string[] }}
 */
function leakScan(userPrompt, scenario) {
  const evidence = userPrompt
    .split("\n")
    .filter((line) => !/^Return only JSON:/i.test(line.trim()))
    .join("\n")
    .toLowerCase();
  const fail = [];
  const review = [];

  for (const key of FORBIDDEN_KEYS) {
    if (evidence.includes(`"${key}"`)) fail.push(`key:${key}`);
  }
  for (const [name, val] of [["scenario_id", scenario.id], ["scenario_title", scenario.title]]) {
    if (typeof val === "string" && val.trim().length >= 6 && evidence.includes(val.toLowerCase())) fail.push(name);
  }
  const fc = scenario.taxonomy && scenario.taxonomy.functional_category;
  if (typeof fc === "string" && evidence.includes(fc.toLowerCase())) fail.push("functional_category_value");
  for (const tok of ["hard_to_reverse", "soft_to_reverse"]) {
    if (evidence.includes(tok)) fail.push(`irreversibility_value:${tok}`);
  }
  const texts = [
    ["hidden_trap", scenario.hidden_trap],
    ["context.hidden_trap", scenario.context && scenario.context.hidden_trap],
    ["incident_narrative", scenario.incident_narrative],
    ["expected.human_correction", scenario.expected_behavior && scenario.expected_behavior.human_correction]
  ];
  for (const [name, val] of texts) {
    if (typeof val !== "string") continue;
    const frag = val.toLowerCase().trim().slice(0, 40);
    if (frag.length >= 20 && evidence.includes(frag)) fail.push(`text:${name}`);
  }

  for (const tok of ["over-refusal", "under-refusal", "over_refusal", "under_refusal"]) {
    if (evidence.includes(tok)) review.push(`evidence_mentions:${tok}`);
  }
  return { fail, review };
}

/**
 * Build one audit record for a (scenario, prompt-type) pair.
 *
 * @param {object} scenario
 * @param {string} type - "scenario-label" | "mechanism"
 * @param {string} system - system prompt
 * @param {string} user - user/evidence prompt
 * @returns {object}
 */
function record(scenario, type, system, user) {
  const full = system + "\n\n" + user;
  const scan = leakScan(user, scenario);
  return {
    scenario_id: scenario.id, // audit record only, NEVER inside the prompt
    type,
    prompt_sha256: crypto.createHash("sha256").update(full).digest("hex"),
    prompt_bytes: Buffer.byteLength(full, "utf8"),
    leak_hits: scan.fail,
    review_hits: scan.review,
    user_preview: user.slice(0, 500)
  };
}

function main() {
  const scenarios = fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), "utf8")));

  const sysScenario = buildScenarioLabelSystemPrompt();
  const sysMech = buildMechanismSystemPrompt();

  const records = [];
  for (const s of scenarios) {
    records.push(record(s, "scenario-label", sysScenario, buildScenarioLabelUserPrompt(s)));
    if (s.taxonomy && s.taxonomy.functional_category) {
      records.push(record(s, "mechanism", sysMech, buildMechanismUserPrompt(s)));
    }
  }

  const leaked = records.filter((r) => r.leak_hits.length > 0);
  const reviewScenarios = [...new Set(records.filter((r) => r.review_hits.length > 0).map((r) => r.scenario_id))];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(runnerRoot, "runs", "annotator-panel", "prompt-audits", stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const artifact = {
    generated_at_utc: new Date().toISOString(),
    scenario_label_system_sha256: crypto.createHash("sha256").update(sysScenario).digest("hex"),
    mechanism_system_sha256: crypto.createHash("sha256").update(sysMech).digest("hex"),
    total_prompts: records.length,
    scenario_label_prompts: records.filter((r) => r.type === "scenario-label").length,
    mechanism_prompts: records.filter((r) => r.type === "mechanism").length,
    leaked_prompts: leaked.length,
    review_scenarios: reviewScenarios,
    pass: leaked.length === 0,
    records
  };
  fs.writeFileSync(path.join(outDir, "prompt-audit.json"), JSON.stringify(artifact, null, 2));

  console.log("DRY PROMPT AUDIT (zero API)");
  console.log(`  scenarios: ${scenarios.length}`);
  console.log(`  scenario-label prompts: ${artifact.scenario_label_prompts}`);
  console.log(`  mechanism prompts: ${artifact.mechanism_prompts}`);
  console.log(`  total prompts audited: ${artifact.total_prompts}`);
  console.log(`  builder leaks (FAIL): ${leaked.length}`);
  console.log(`  RESULT: ${artifact.pass ? "PASS — no builder leaks" : "FAIL"}`);
  if (leaked.length) {
    console.log("\n  LEAKS:");
    for (const r of leaked.slice(0, 40)) console.log(`    ${r.type}  ${r.scenario_id}  ->  ${r.leak_hits.join(", ")}`);
  }
  if (reviewScenarios.length) {
    console.log(`\n  REVIEW (non-failing — scenario evidence names the failure direction; operator decides): ${reviewScenarios.length}`);
    for (const id of reviewScenarios.slice(0, 40)) console.log(`    ${id}`);
  }
  console.log(`\n  artifact: ${path.relative(runnerRoot, path.join(outDir, "prompt-audit.json"))}`);
  process.exit(artifact.pass ? 0 : 1);
}

main();
