// aggregate-canonical.mjs
//
// Reads a validated SteerBench-Work run directory and produces the
// aggregate artifacts that the leaderboard, the site, and the paper
// consume. Refuses to run unless `validator-report.json` exists in the
// run root and reports `pass: true`.
//
// CLI:
//   node scripts/aggregate-canonical.mjs --run <path> [--force-without-validator]
//
// Outputs (written to the run root):
//   aggregate-summary.json       per-variant totals + breakdowns by
//                                direction, functional_category, domain,
//                                source_provenance, irreversibility_class
//   leaderboard-rows.json        leaderboard.json-compatible row shape
//   reliability-table.json       modal_accuracy + pass_all_trials per variant
//   failure-pattern-summary.json scenarios where two or more variants
//                                modal-miss, top 100
//
// Does not score, does not infer, does not edit. Reads validated
// cell.json + summary.json files and reshapes them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRunPlan } from "../src/run-plan.mjs";
import { loadRunState } from "../src/run-state.mjs";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) =>
    (args.find((a) => a.startsWith(`${flag}=`)) || "").split("=")[1] ||
    (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  return {
    runArg: get("--run"),
    forceWithoutValidator: args.includes("--force-without-validator")
  };
}

function readJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function pct(c, t) {
  if (!t) return null;
  return Number((c / t).toFixed(4));
}

function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    low: Number(Math.max(0, center - spread).toFixed(4)),
    high: Number(Math.min(1, center + spread).toFixed(4))
  };
}

function trialAccuracy(cells) {
  let correct = 0;
  let total = 0;
  for (const c of cells) {
    if (c.expected_action == null || c.provider_filtered === true) continue;
    if (typeof c.n_correct_trials !== "number" || typeof c.n_trials !== "number") continue;
    correct += c.n_correct_trials;
    total += c.n_trials;
  }
  return {
    correct,
    total,
    rate: total > 0 ? Number((correct / total).toFixed(4)) : null
  };
}

function parseScore(score) {
  const [a, b] = String(score || "0/0").split("/").map(Number);
  return { correct: a || 0, total: b || 0 };
}

function aggregateByKey(cells, keyFn) {
  const buckets = new Map();
  for (const c of cells) {
    if (c.expected_action == null) continue;
    const key = keyFn(c);
    if (key == null) continue;
    if (!buckets.has(key)) {
      buckets.set(key, { total: 0, modal_correct: 0, pass_all: 0 });
    }
    const b = buckets.get(key);
    b.total += 1;
    if (c.modal_correct === true) b.modal_correct += 1;
    if (c.pass_all_trials === true) b.pass_all += 1;
  }
  const out = {};
  for (const [key, b] of buckets) {
    out[key] = {
      total: b.total,
      modal_correct: b.modal_correct,
      modal_rate: pct(b.modal_correct, b.total),
      pass_all_trials_rate: pct(b.pass_all, b.total)
    };
  }
  return out;
}

function buildLeaderboardRow(variantKey, summary, cells = []) {
  if (!summary) return null;
  const modalScore = parseScore(summary.modal_score);
  const passAllScore = parseScore(summary.pass_all_trials_score);
  const meanTrial = trialAccuracy(cells);
  return {
    kind: "model_subset",
    variant: variantKey,
    model: summary.label || variantKey,
    n_scenarios: summary.n_scenarios,
    n_trials_per_cell: summary.n_trials_per_cell,
    modal_score: summary.modal_score,
    modal_accuracy: summary.modal_accuracy,
    modal_accuracy_ci95: wilson(modalScore.correct, modalScore.total),
    pass_all_trials_score: summary.pass_all_trials_score,
    pass_all_trials_rate: summary.pass_all_trials_rate,
    pass_all_trials_ci95: wilson(passAllScore.correct, passAllScore.total),
    mean_trial_accuracy: meanTrial.rate,
    mean_trial_accuracy_score: `${meanTrial.correct}/${meanTrial.total}`,
    mean_trial_accuracy_ci95: wilson(meanTrial.correct, meanTrial.total),
    weighted_miss_rate: summary.weighted_miss_rate ?? null,
    weighted_modal_accuracy: summary.weighted_modal_accuracy ?? null,
    under_refusal_count: summary.under_refusal_count ?? null,
    under_refusal_possible: summary.under_refusal_possible ?? null,
    under_refusal_rate: summary.under_refusal_rate ?? null,
    over_refusal_count: summary.over_refusal_count ?? null,
    over_refusal_possible: summary.over_refusal_possible ?? null,
    over_refusal_rate: summary.over_refusal_rate ?? null,
    cost_usd_estimate: summary.cost_usd_estimate,
    parse_failures: summary.n_parse_failed,
    truncated: summary.n_truncated,
    errors: summary.n_errors,
    infrastructure_failed: summary.n_infrastructure_failed
  };
}

function buildFailurePatternSummary(perVariant) {
  // For each scenario id, list variants that missed (modal or pass_all).
  // Surface scenarios where more than one variant missed; that is a
  // pattern of difficulty, not a single-variant weakness.
  const byScenario = new Map();
  for (const [variantKey, { cells }] of Object.entries(perVariant)) {
    for (const c of cells) {
      if (c.expected_action == null) continue;
      if (!byScenario.has(c.scenario_id)) {
        byScenario.set(c.scenario_id, {
          scenario_id: c.scenario_id,
          direction: c.direction,
          functional_category: c.functional_category,
          domain: c.domain,
          source_provenance: c.source_provenance,
          irreversibility_class: c.irreversibility_class,
          expected_action: c.expected_action,
          variants_total: 0,
          modal_misses: [],
          pass_all_misses: []
        });
      }
      const e = byScenario.get(c.scenario_id);
      e.variants_total += 1;
      if (c.modal_correct === false) e.modal_misses.push(variantKey);
      if (c.pass_all_trials === false) e.pass_all_misses.push(variantKey);
    }
  }
  const recurring = [];
  for (const e of byScenario.values()) {
    if (e.modal_misses.length >= 2) recurring.push(e);
  }
  recurring.sort((a, b) => b.modal_misses.length - a.modal_misses.length);
  return {
    n_scenarios_with_at_least_two_modal_misses: recurring.length,
    recurring: recurring.slice(0, 100)
  };
}

function loadVariantOutputs(runRoot, variantKey) {
  const variantDir = path.join(runRoot, variantKey);
  const summary = readJsonOrNull(path.join(variantDir, "summary.json"));
  const cells = readJsonOrNull(path.join(variantDir, "cells.json"));
  return { summary, cells: Array.isArray(cells) ? cells : [] };
}

function main() {
  const { runArg, forceWithoutValidator } = parseArgs();
  if (!runArg) {
    console.error(`Usage: node scripts/aggregate-canonical.mjs --run <path> [--force-without-validator]`);
    process.exit(1);
  }
  const runRoot = path.isAbsolute(runArg) ? runArg : path.resolve(process.cwd(), runArg);

  // Hard gate: validator-report.json must exist and pass.
  const reportPath = path.join(runRoot, "validator-report.json");
  const report = readJsonOrNull(reportPath);
  if (!forceWithoutValidator) {
    if (!report) {
      console.error(`REFUSED: validator-report.json missing at ${reportPath}. Run validate-run first, or pass --force-without-validator for a debugging aggregation.`);
      process.exit(1);
    }
    if (report.pass !== true) {
      console.error(`REFUSED: validator-report.json reports pass=false (${report.error_count} errors). Aggregator does not write publish artifacts from a failed-validation run.`);
      process.exit(1);
    }
  }

  const plan = loadRunPlan(runRoot);
  const runState = loadRunState(runRoot);
  if (!forceWithoutValidator && runState.overall_status !== "completed") {
    console.error(`REFUSED: run-state overall_status=${runState.overall_status}; publish aggregation requires a completed run. Use --force-without-validator only for local debugging artifacts.`);
    process.exit(1);
  }

  const perVariant = {};
  for (const v of plan.planned_variants) {
    const out = loadVariantOutputs(runRoot, v);
    if (!out.summary || out.cells.length === 0) {
      console.error(`Warning: variant ${v} has no summary.json or empty cells.json; skipping in aggregation`);
      continue;
    }
    perVariant[v] = out;
  }

  // Per-variant breakdowns
  const perVariantBreakdowns = {};
  for (const [variantKey, { cells }] of Object.entries(perVariant)) {
    const scoredCells = cells.filter((c) => c.expected_action != null);
    perVariantBreakdowns[variantKey] = {
      coverage: {
        scored_total: scoredCells.length,
        with_domain: scoredCells.filter((c) => c.domain != null).length,
        with_action_effect: scoredCells.filter((c) => c.action_effect != null).length,
        with_failure_taxonomy: scoredCells.filter((c) => c.direction != null && c.functional_category != null && c.source_provenance != null).length,
        with_irreversibility_class: scoredCells.filter((c) => c.irreversibility_class != null).length
      },
      by_direction: aggregateByKey(cells, (c) => c.direction || null),
      by_functional_category: aggregateByKey(cells, (c) => c.functional_category || null),
      by_domain: aggregateByKey(cells, (c) => c.domain || null),
      by_source_provenance: aggregateByKey(cells, (c) => c.source_provenance || null),
      by_irreversibility_class: aggregateByKey(cells, (c) => c.irreversibility_class || null),
      by_action_effect: aggregateByKey(cells, (c) => c.action_effect || null)
    };
  }

  const aggregateSummary = {
    schema_version: "steerbench.aggregate_summary.v1",
    aggregated_at: new Date().toISOString(),
    run_id: plan.run_id,
    run_root: path.relative(runnerRoot, runRoot) || ".",
    validator_report_pass: report?.pass ?? null,
    validator_report_at: report?.validated_at ?? null,
    run_plan: {
      scenario_set: plan.scenario_set,
      scenario_count: plan.scenario_count,
      n_trials_per_cell: plan.n_trials_per_cell,
      planned_variants: plan.planned_variants,
      prompt_sha256: plan.prompt_sha256,
      scoring_field: plan.scoring_field
    },
    overall_status: runState.overall_status,
    per_variant: Object.fromEntries(
      Object.entries(perVariant).map(([k, { summary }]) => [k, summary])
    ),
    breakdowns: perVariantBreakdowns
  };
  fs.writeFileSync(path.join(runRoot, "aggregate-summary.json"), JSON.stringify(aggregateSummary, null, 2));

  const leaderboardRows = plan.planned_variants
    .map((v) => buildLeaderboardRow(v, perVariant[v]?.summary, perVariant[v]?.cells))
    .filter(Boolean);
  fs.writeFileSync(path.join(runRoot, "leaderboard-rows.json"), JSON.stringify({
    schema_version: "steerbench.leaderboard_rows.v1",
    generated_at: new Date().toISOString(),
    run_id: plan.run_id,
    run_root: path.relative(runnerRoot, runRoot) || ".",
    rows: leaderboardRows
  }, null, 2));

  const reliabilityTable = plan.planned_variants.map((v) => {
    const s = perVariant[v]?.summary;
    if (!s) return null;
    return {
      variant: v,
      model: s.label,
      n_scenarios: s.n_scenarios,
      n_trials_per_cell: s.n_trials_per_cell,
      modal_accuracy: s.modal_accuracy,
      pass_all_trials_rate: s.pass_all_trials_rate,
      modal_accuracy_ci95: wilson(parseScore(s.modal_score).correct, parseScore(s.modal_score).total),
      pass_all_trials_ci95: wilson(parseScore(s.pass_all_trials_score).correct, parseScore(s.pass_all_trials_score).total),
      mean_trial_accuracy: trialAccuracy(perVariant[v]?.cells || []).rate,
      mean_trial_accuracy_ci95: wilson(
        trialAccuracy(perVariant[v]?.cells || []).correct,
        trialAccuracy(perVariant[v]?.cells || []).total
      )
    };
  }).filter(Boolean);
  fs.writeFileSync(path.join(runRoot, "reliability-table.json"), JSON.stringify({
    schema_version: "steerbench.reliability_table.v1",
    generated_at: new Date().toISOString(),
    run_id: plan.run_id,
    rows: reliabilityTable
  }, null, 2));

  const failurePatterns = buildFailurePatternSummary(perVariant);
  fs.writeFileSync(path.join(runRoot, "failure-pattern-summary.json"), JSON.stringify({
    schema_version: "steerbench.failure_pattern_summary.v1",
    generated_at: new Date().toISOString(),
    run_id: plan.run_id,
    ...failurePatterns
  }, null, 2));

  console.log("Aggregation complete.");
  console.log(`  aggregate-summary.json       written`);
  console.log(`  leaderboard-rows.json        written (${leaderboardRows.length} rows)`);
  console.log(`  reliability-table.json       written`);
  console.log(`  failure-pattern-summary.json written (${failurePatterns.n_scenarios_with_at_least_two_modal_misses} recurring scenarios)`);
}

main();
