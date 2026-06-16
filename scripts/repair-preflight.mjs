// Read-only pre-spend preflight for the six-scenario provenance repair.
//
// Makes ZERO API calls. Two gates:
//
//   1. Cost estimate. For every published locked condition, sum the OBSERVED
//      token usage of that condition's six drifted-scenario cells (5 trials
//      each) and price it with the current config pricing. The repair reruns
//      exactly these cells, so observed usage is the best estimator.
//
//   2. Leak dry-render. For each of the six scenarios, render the exact
//      model-facing payload (canonical system prompt + user content) the repair
//      would send, then assert: (a) no answer-key / website / taxonomy field
//      leaks into the payload, and (b) the rendered user content is byte-equal
//      to the frozen logged request body. Same prompt, same protocol.
//
// Usage: node scripts/repair-preflight.mjs

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { REPORTED_RUN_CONFIG } from "../configs/reported-run.mjs";
import { STEERBENCH_STEERING_SYSTEM_PROMPT } from "../src/prompts.mjs";
import { reshapeToLegacy, buildModelInputFor } from "../src/canonical-runner.mjs";

const RUN_ROOT_BASE = "runs/canonical-multi-trial";
const SCENARIO_SET_DIR = "scenario-sets/steerbench-work-2026-05";
const REFERENCE_RUN = "tm-locked-2026-06-03-gemini-pro";
const N_TRIALS = REPORTED_RUN_CONFIG.n_trials_per_cell;

const SIX = [
  "apple-card-mirror-credit-extension-tier-b-004",
  "calendar-invite-prompt-injection-004",
  "deposition-statute-of-limitations-003",
  "executive-impersonation-wire-fraud-005",
  "patient-records-employer-disclosure-002",
  "telehealth-marketing-pixel-disclosure-001"
];

// Held rows that must NOT be included in the current 27-row repair without
// explicit approval.
const HELD_VARIANTS = new Set(["g55-high", "claude-opus-high"]);

// The published condition set = the 27 rows live on the site. Mirror of the
// PUBLISHED_ROOTS list in verify-published-numbers.mjs (the fabrication gate's
// source of truth). tm-locked-2026-05-29 contributes two variants (nano, mini),
// so 26 roots -> 27 published rows. Locked roots that exist on disk but are NOT
// published (e.g. the plain gemini-3.5-flash|off root) are intentionally
// excluded: the repair targets exactly what the site publishes.
const PUBLISHED_ROOTS = new Set([
  "tm-locked-2026-05-29",
  "tm-locked-2026-05-30-nano-high",
  "tm-locked-2026-05-30-mini-high",
  "tm-locked-2026-05-30-g54",
  "tm-locked-2026-05-30-g54-high",
  "tm-locked-2026-05-31-g55-none",
  "tm-locked-2026-06-01-gpt-oss-low",
  "tm-locked-2026-06-01-gpt-oss-high",
  "tm-locked-2026-06-01-gpt-oss-120b-low",
  "tm-locked-2026-06-01-gpt-oss-120b-high",
  "tm-locked-2026-06-01-gemini-flash-lite",
  "tm-locked-2026-06-02-gemini-flash-lite-high",
  "tm-locked-2026-06-02-gemini-flash-min",
  "tm-locked-2026-06-02-gemini-flash-high",
  "tm-locked-2026-06-02-gemini-pro-low",
  "tm-locked-2026-06-03-gemini-pro",
  "tm-locked-2026-06-02-deepseek-flash-off",
  "tm-locked-2026-06-01-deepseek-flash",
  "tm-locked-2026-06-02-deepseek-pro-off",
  "tm-locked-2026-06-01-deepseek-pro",
  "tm-locked-2026-06-01-kimi",
  "tm-locked-2026-06-03-claude-haiku",
  "tm-locked-2026-06-02-claude-haiku-high",
  "tm-locked-2026-06-03-claude-sonnet",
  "tm-locked-2026-06-02-claude-sonnet-high",
  "tm-locked-2026-06-03-claude-opus"
]);

function sha256String(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function pricePerMTok(pricing, dir) {
  if (!pricing) return null;
  if (dir === "in") return pricing.input_per_mtok ?? pricing.input ?? null;
  return pricing.output_per_mtok ?? pricing.output ?? null;
}

// === gate 1: cost ===

function trialUsage(trialPath) {
  let t;
  try {
    t = JSON.parse(fs.readFileSync(trialPath, "utf8"));
  } catch {
    return null;
  }
  const u = t.usage || {};
  const input = u.input_tokens ?? u.prompt_tokens ?? 0;
  const output = u.output_tokens ?? u.completion_tokens ?? 0; // billed output incl. reasoning
  return { input, output };
}

function costGate() {
  const roots = fs.readdirSync(RUN_ROOT_BASE)
    .filter((d) => d.startsWith("tm-locked-") && PUBLISHED_ROOTS.has(d))
    .sort();

  const rows = [];
  let totalCost = 0;
  let totalCalls = 0;

  for (const rootName of roots) {
    const root = path.join(RUN_ROOT_BASE, rootName);
    let variantConfigs;
    try {
      variantConfigs = JSON.parse(fs.readFileSync(path.join(root, "VARIANT_CONFIGS.json"), "utf8")).variants || {};
    } catch {
      continue;
    }
    for (const variantKey of Object.keys(variantConfigs)) {
      if (HELD_VARIANTS.has(variantKey)) continue; // excluded from the 27-row repair
      const frozenCfg = variantConfigs[variantKey];
      const liveCfg = REPORTED_RUN_CONFIG.variants[variantKey];
      const pricing = (liveCfg && liveCfg.pricing) || frozenCfg.pricing || null;

      let inTok = 0, outTok = 0, cells = 0, missing = 0;
      for (const id of SIX) {
        const sdir = path.join(root, variantKey, id);
        if (!fs.existsSync(sdir)) { missing += 1; continue; }
        cells += 1;
        for (let i = 1; i <= N_TRIALS; i += 1) {
          const u = trialUsage(path.join(sdir, `trial-${i}.json`));
          if (u) { inTok += u.input; outTok += u.output; }
        }
      }
      const pin = pricePerMTok(pricing, "in");
      const pout = pricePerMTok(pricing, "out");
      const cost = pin != null && pout != null ? (inTok / 1e6) * pin + (outTok / 1e6) * pout : null;
      if (cost != null) totalCost += cost;
      totalCalls += cells * N_TRIALS;
      rows.push({ rootName, variantKey, cells, missing, inTok, outTok, cost });
    }
  }

  return { rows, totalCost, totalCalls };
}

// === gate 2: leak dry-render ===

// Field names / phrases that must never reach the model-facing payload.
const FORBIDDEN = [
  "taxonomy", "source_provenance", "functional_category",
  "expected_behavior", "correct_action", "human_correction",
  "hidden_trap", "_SCENARIO_PATTERNS", "boundary_pattern",
  "Why this is tricky", "expected_steering", "expected_evidence",
  "evidence_used", "evidence_missing", "mirror_explanation",
  "structural_distinction_from_source", "source_basis",
  "source_incident_summary", "source_incident_url",
  "incident_narrative", "steering_intervention", "cost_comparison",
  "recovery_summary", "autonomous_failure", "clean_outcome"
];

function frozenUserContent(scenarioId) {
  const dir = path.join(RUN_ROOT_BASE, REFERENCE_RUN, "gemini-pro", scenarioId);
  const trials = fs.readdirSync(dir).filter((f) => /^trial-\d+\.json$/.test(f)).sort();
  for (const t of trials) {
    const trial = JSON.parse(fs.readFileSync(path.join(dir, t), "utf8"));
    const rb = trial.request_body;
    const msgs = rb && (rb.input || rb.messages);
    const user = msgs && msgs.find((m) => m.role === "user");
    if (user && typeof user.content === "string") return user.content;
  }
  return null;
}

function leakGate() {
  const results = [];
  for (const id of SIX) {
    const json = JSON.parse(fs.readFileSync(path.join(SCENARIO_SET_DIR, `${id}.json`), "utf8"));
    const userContent = `scenario_id: ${id}\n\n${buildModelInputFor(reshapeToLegacy(json)).model_input}`;
    // The full model-facing payload = canonical system prompt + user content.
    // Per-row params (model id, max_tokens, reasoning knob) carry no scenario
    // text, so the leak surface is exactly this payload, identical across rows.
    const payload = `${STEERBENCH_STEERING_SYSTEM_PROMPT}\n${userContent}`;
    const leaks = FORBIDDEN.filter((f) => payload.includes(f));
    const frozen = frozenUserContent(id);
    const matchesFrozen = frozen !== null && frozen === userContent;
    results.push({ id, leaks, matchesFrozen, frozenRecovered: frozen !== null });
  }
  return results;
}

// === report ===

const cost = costGate();
console.log("=".repeat(72));
console.log("GATE 1  COST ESTIMATE  (observed usage x current pricing, no API calls)");
console.log("=".repeat(72));
console.log(`scope: 6 scenarios x ${N_TRIALS} trials x ${cost.rows.length} published rows = ${cost.totalCalls} calls`);
console.log("");
console.log("  row (variant)                in_tok   out_tok    cost($)");
for (const r of cost.rows.sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))) {
  const flag = r.missing ? ` [missing ${r.missing}/6 cells]` : "";
  console.log(
    `  ${r.variantKey.padEnd(24)} ${String(r.inTok).padStart(8)} ${String(r.outTok).padStart(8)}   ${(r.cost ?? 0).toFixed(4)}${flag}`
  );
}
console.log("  " + "-".repeat(58));
console.log(`  TOTAL estimated                                  $${cost.totalCost.toFixed(2)}`);
console.log(`  +25% buffer                                      $${(cost.totalCost * 1.25).toFixed(2)}`);
console.log(`  +50% buffer                                      $${(cost.totalCost * 1.5).toFixed(2)}`);

const leak = leakGate();
console.log("");
console.log("=".repeat(72));
console.log("GATE 2  LEAK DRY-RENDER  (exact payload built, NOT sent)");
console.log("=".repeat(72));
let allClean = true;
for (const r of leak) {
  const leakStr = r.leaks.length ? `LEAK: ${r.leaks.join(", ")}` : "no forbidden fields";
  const matchStr = r.matchesFrozen ? "user content == frozen" : (r.frozenRecovered ? "USER CONTENT DIFFERS FROM FROZEN" : "frozen not recovered");
  if (r.leaks.length || !r.matchesFrozen) allClean = false;
  console.log(`  ${r.id}`);
  console.log(`     ${leakStr}  |  ${matchStr}`);
}
console.log("");
console.log(allClean
  ? "GATE 2 PASS: no answer-key/website fields in any payload; all 6 match frozen protocol."
  : "GATE 2 FAIL: review the flags above before any spend.");
console.log("");
console.log(`held rows excluded from this estimate: ${[...HELD_VARIANTS].join(", ")} (need explicit approval)`);
