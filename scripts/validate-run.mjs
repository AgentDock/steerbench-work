// validate-run.mjs
//
// Confirms a planned SteerBench-Work run directory is canonical-quality
// before any aggregator, leaderboard publisher, or downstream analysis
// loads it. Reads every protocol field from the run-root snapshots
// (RUN_PLAN.json, PROMPT.txt, SCENARIO_MANIFEST.json, VARIANT_CONFIGS.json,
// SCORING_RULE.json), recomputes published metrics from raw trial files,
// and writes a validator-report.json into the run root.
//
// CLI:
//   node scripts/validate-run.mjs --run <path-to-run-root> [--variant <name>] [--quiet]
//
// Exit 0 if every check passes; the aggregator only runs against a
// run root with a `pass: true` validator-report.json.
//
// Drift checks:
//   - PROMPT.txt bytes hash must equal RUN_PLAN.prompt_sha256
//   - Every variant's config_hash in VARIANT_CONFIGS.json must equal
//     RUN_PLAN.variant_config_hashes[variant]
//   - Every scenario file referenced by SCENARIO_MANIFEST.json must
//     still hash to the recorded sha256 on the live filesystem
//   - Every trial-N.json must carry matching run_id, variant_key,
//     variant_config_hash, scenario_id, scenario_sha256, prompt_sha256,
//     trial, and expected_action
//   - cell.json fields must match a fresh recompute from the trial files
//   - Variants in run-state.completed must equal planned_variants for
//     the run to validate as a complete reported run

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import {
  loadRunPlan,
  loadVariantConfigs,
  loadRunPrompt
} from "../src/run-plan.mjs";
import {
  loadScenarioManifestFromRunRoot,
  indexManifestById,
  sha256File
} from "../src/manifest.mjs";
import { loadRunState, variantCellsComplete, VARIANT_STATUS } from "../src/run-state.mjs";
import { TRIAL_STATUS } from "../src/trial-store.mjs";
import { computeCellScore, irreversibilityWeight, weightedSeverity, directionalErrorRates, CANONICAL_SCORING_MAPPING } from "../src/scorer.mjs";
import { isCanonicalActionEffect, isCanonicalDomain } from "../src/normalize.mjs";

const REPORT_FILENAME = "validator-report.json";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) =>
    (args.find((a) => a.startsWith(`${flag}=`)) || "").split("=")[1] ||
    (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  return {
    runArg: get("--run"),
    variantArg: get("--variant"),
    quiet: args.includes("--quiet"),
    allowIncomplete: args.includes("--allow-incomplete")
  };
}

function readJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function validateSnapshots(runRoot, errors) {
  const plan = loadRunPlan(runRoot);
  const variantConfigs = loadVariantConfigs(runRoot);
  const manifest = loadScenarioManifestFromRunRoot(runRoot);
  const prompt = loadRunPrompt(runRoot);

  const livePromptSha = createHash("sha256").update(prompt).digest("hex");
  if (livePromptSha !== plan.prompt_sha256) {
    errors.push(`PROMPT.txt hash ${livePromptSha} differs from RUN_PLAN.prompt_sha256 ${plan.prompt_sha256}`);
  }
  for (const v of plan.planned_variants) {
    const vc = variantConfigs.variants[v];
    if (!vc) {
      errors.push(`Variant ${v} missing from VARIANT_CONFIGS.json`);
      continue;
    }
    const expected = plan.variant_config_hashes[v];
    if (vc.config_hash !== expected) {
      errors.push(`Variant ${v} config_hash ${vc.config_hash} differs from RUN_PLAN ${expected}`);
    }
  }

  return { plan, variantConfigs, manifest };
}

function resolveScenarioSetDir(planScenarioSetDir) {
  return path.isAbsolute(planScenarioSetDir)
    ? planScenarioSetDir
    : path.join(runnerRoot, planScenarioSetDir);
}

function validateLiveScenarios(plan, manifest, errors) {
  const resolvedDir = resolveScenarioSetDir(plan.scenario_set_dir);
  for (const entry of manifest.scenarios) {
    const filePath = path.join(resolvedDir, entry.file);
    if (!fs.existsSync(filePath)) {
      errors.push(`Scenario file missing on live filesystem: ${entry.file}`);
      continue;
    }
    const liveSha = sha256File(filePath);
    if (liveSha !== entry.sha256) {
      errors.push(`Scenario ${entry.id} (${entry.file}) drifted from manifest: live=${liveSha} manifest=${entry.sha256}`);
    }
  }
}

function validateVariant({ runRoot, plan, variantKey, manifest, errors, log, allowIncomplete = false }) {
  const variantDir = path.join(runRoot, variantKey);
  if (!fs.existsSync(variantDir)) {
    errors.push(`${variantKey}: variant directory missing at ${variantDir}`);
    return;
  }
  const summary = readJsonOrNull(path.join(variantDir, "summary.json"));
  const cells = readJsonOrNull(path.join(variantDir, "cells.json"));
  if (!summary) errors.push(`${variantKey}: summary.json missing or unparseable`);
  if (!cells || !Array.isArray(cells)) {
    errors.push(`${variantKey}: cells.json missing or not an array`);
    return;
  }

  const manifestById = indexManifestById(manifest);
  const expectedConfigHash = plan.variant_config_hashes[variantKey];
  let cellsValidated = 0, cellsWithIssues = 0, infraTrials = 0;
  const seenScenarioIds = new Set();
  for (const cell of cells) {
    const sid = cell.scenario_id;
    if (!sid) { errors.push(`${variantKey}: cell without scenario_id`); cellsWithIssues++; continue; }
    seenScenarioIds.add(sid);
    const manifestEntry = manifestById.get(sid);
    if (!manifestEntry) {
      errors.push(`${variantKey}/${sid}: scenario id not in manifest`);
      cellsWithIssues++; continue;
    }

    const cellDir = path.join(variantDir, sid);
    if (!fs.existsSync(cellDir)) {
      errors.push(`${variantKey}/${sid}: cell directory missing`);
      cellsWithIssues++; continue;
    }
    const cellJsonPath = path.join(cellDir, "cell.json");
    const cellJson = readJsonOrNull(cellJsonPath);
    if (!cellJson) {
      errors.push(`${variantKey}/${sid}: cell.json missing or unparseable`);
      cellsWithIssues++; continue;
    }

    // Per-trial provenance + status check
    const trialRecords = [];
    let trialIssue = false;
    for (let t = 1; t <= plan.n_trials_per_cell; t += 1) {
      const tp = path.join(cellDir, `trial-${t}.json`);
      const trial = readJsonOrNull(tp);
      if (!trial) {
        errors.push(`${variantKey}/${sid}/trial-${t}.json missing or unparseable`);
        trialIssue = true; continue;
      }
      // Provenance match
      const expectedProv = {
        run_id: plan.run_id,
        scenario_id: sid,
        scenario_sha256: manifestEntry.sha256,
        variant_key: variantKey,
        variant_config_hash: expectedConfigHash,
        prompt_sha256: plan.prompt_sha256,
        trial: t,
        expected_action: manifestEntry.expected_action
      };
      for (const [k, v] of Object.entries(expectedProv)) {
        if (trial[k] !== v) {
          errors.push(`${variantKey}/${sid}/trial-${t}: provenance ${k} drift (file=${JSON.stringify(trial[k])} expected=${JSON.stringify(v)})`);
          trialIssue = true;
        }
      }
      if (!Object.values(TRIAL_STATUS).includes(trial.status)) {
        errors.push(`${variantKey}/${sid}/trial-${t}: unknown trial status ${trial.status}`);
        trialIssue = true;
      }
      if (trial.status === TRIAL_STATUS.INFRASTRUCTURE_FAILED) {
        infraTrials += 1;
      }
      trialRecords.push(trial);
    }
    if (trialIssue) { cellsWithIssues++; continue; }

    // Recompute and compare
    const recomputed = computeCellScore(trialRecords, manifestEntry.expected_action);
    const fieldsToCheck = [
      "n_trials", "n_correct_trials",
      "modal_commit_permission", "modal_count", "modal_correct",
      "pass_all_trials"
    ];
    const mismatches = [];
    for (const f of fieldsToCheck) {
      if (JSON.stringify(cellJson[f]) !== JSON.stringify(recomputed[f])) {
        mismatches.push(`${f}: cell=${JSON.stringify(cellJson[f])} recompute=${JSON.stringify(recomputed[f])}`);
      }
    }
    // Secondary-metric and stratification metadata must match the manifest.
    const expectedWeight = irreversibilityWeight(manifestEntry.irreversibility_class);
    if (cellJson.irreversibility_weight !== expectedWeight) {
      mismatches.push(`irreversibility_weight: cell=${JSON.stringify(cellJson.irreversibility_weight)} expected=${expectedWeight} (class=${JSON.stringify(manifestEntry.irreversibility_class)})`);
    }
    const expectedEffect = manifestEntry.action_verb ?? null;
    if ((cellJson.action_effect ?? null) !== expectedEffect) {
      mismatches.push(`action_effect: cell=${JSON.stringify(cellJson.action_effect)} manifest_action_verb=${JSON.stringify(expectedEffect)}`);
    }
    if ((cellJson.domain ?? null) !== (manifestEntry.domain ?? null)) {
      mismatches.push(`domain: cell=${JSON.stringify(cellJson.domain)} manifest_domain=${JSON.stringify(manifestEntry.domain)}`);
    }
    if (!isCanonicalDomain(manifestEntry.domain)) {
      mismatches.push(`domain: manifest_domain=${JSON.stringify(manifestEntry.domain)} is not in the canonical domain vocabulary`);
    }
    if (!isCanonicalActionEffect(expectedEffect)) {
      mismatches.push(`action_effect: manifest_action_verb=${JSON.stringify(expectedEffect)} is not in the canonical action-effect vocabulary`);
    }
    if (mismatches.length > 0) {
      errors.push(`${variantKey}/${sid}: cell.json diverges from trial recompute -- ${mismatches.join("; ")}`);
      cellsWithIssues++;
    } else {
      cellsValidated++;
    }
  }

  // Every manifest scenario must appear in cells for a complete reported
  // validation. With --allow-incomplete, validate the subset that is present
  // without letting the run pass as complete.
  if (!allowIncomplete) {
    for (const m of manifest.scenarios) {
      if (!seenScenarioIds.has(m.id)) {
        errors.push(`${variantKey}: scenario ${m.id} present in manifest but missing from cells.json`);
      }
    }
  }

  // A reported summary must cover every planned scenario. A subset run
  // (summary over fewer scenarios than the manifest) must never validate
  // as a complete reported result.
  if (!allowIncomplete && summary && summary.n_scenarios !== manifest.scenario_count) {
    errors.push(`${variantKey}: summary.n_scenarios=${summary.n_scenarios} does not equal manifest.scenario_count=${manifest.scenario_count} (a subset run cannot validate as a complete reported run)`);
  }

  // Secondary severity summary must recompute from the cells.
  if (summary) {
    const sev = weightedSeverity(cells);
    const round4 = (x) => (x == null ? null : Number(x.toFixed(4)));
    const tradeoff = directionalErrorRates(cells);
    const sevChecks = [
      ["weighted_possible_total", sev.weighted_possible_total, summary.weighted_possible_total ?? null],
      ["weighted_miss_total", sev.weighted_miss_total, summary.weighted_miss_total ?? null],
      ["weighted_miss_rate", round4(sev.weighted_miss_rate), summary.weighted_miss_rate ?? null],
      ["weighted_modal_accuracy", round4(sev.weighted_modal_accuracy), summary.weighted_modal_accuracy ?? null],
      ["under_refusal_count", tradeoff.under_refusal_count, summary.under_refusal_count ?? null],
      ["under_refusal_possible", tradeoff.under_refusal_possible, summary.under_refusal_possible ?? null],
      ["under_refusal_rate", round4(tradeoff.under_refusal_rate), summary.under_refusal_rate ?? null],
      ["over_refusal_count", tradeoff.over_refusal_count, summary.over_refusal_count ?? null],
      ["over_refusal_possible", tradeoff.over_refusal_possible, summary.over_refusal_possible ?? null],
      ["over_refusal_rate", round4(tradeoff.over_refusal_rate), summary.over_refusal_rate ?? null]
    ];
    for (const [name, recomputeVal, summaryVal] of sevChecks) {
      if (JSON.stringify(recomputeVal) !== JSON.stringify(summaryVal)) {
        errors.push(`${variantKey}: summary ${name}=${JSON.stringify(summaryVal)} does not recompute from cells (${JSON.stringify(recomputeVal)})`);
      }
    }
  }

  log(`  ${variantKey}: ${cellsValidated} cells validated, ${cellsWithIssues} with issues, ${infraTrials} infrastructure-failed trials`);
}

function main() {
  const { runArg, variantArg, quiet, allowIncomplete } = parseArgs();
  if (!runArg) {
    console.error(`Usage: node scripts/validate-run.mjs --run <path> [--variant <name>] [--quiet] [--allow-incomplete]`);
    process.exit(1);
  }
  const runRoot = path.isAbsolute(runArg) ? runArg : path.resolve(process.cwd(), runArg);
  const log = (msg) => { if (!quiet) console.log(msg); };

  log(`Validating run: ${runRoot}`);

  const errors = [];
  let plan, manifest;
  try {
    const snap = validateSnapshots(runRoot, errors);
    plan = snap.plan;
    manifest = snap.manifest;
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }

  // Run-state lifecycle check
  let runState;
  try { runState = loadRunState(runRoot); }
  catch (e) { console.error(`FAIL: ${e.message}`); process.exit(1); }

  const variantsToCheck = variantArg ? [variantArg] : plan.planned_variants;

  // Scenario-file drift check
  validateLiveScenarios(plan, manifest, errors);

  // Per-variant trial + recompute checks
  for (const v of variantsToCheck) {
    validateVariant({ runRoot, plan, variantKey: v, manifest, errors, log, allowIncomplete });
  }

  // Run completeness check (planned variants must all be completed)
  const notCompleted = plan.planned_variants.filter(
    (v) => runState.variant_runs[v]?.status !== VARIANT_STATUS.COMPLETED
  );
  if (notCompleted.length > 0 && !allowIncomplete) {
    errors.push(`Run is not complete. Variants without status=completed: ${notCompleted.join(", ")} (pass --allow-incomplete to validate a partial run)`);
  }

  // A variant whose run-state says "completed" must actually have every
  // manifest scenario filled on disk. Catches a state file that claims
  // completion over a subset.
  for (const v of variantsToCheck) {
    if (runState.variant_runs[v]?.status === VARIANT_STATUS.COMPLETED) {
      const cov = variantCellsComplete(runRoot, v, manifest, plan.n_trials_per_cell);
      if (!cov.complete) {
        errors.push(`${v}: run-state says completed but ${cov.missing.length} manifest scenario(s) have no full cell on disk (first missing: ${cov.missing.slice(0, 3).join(", ")})`);
      }
    }
  }

  // Scoring-rule snapshot must match the live mapping the scorer uses
  const scoringRulePath = path.join(runRoot, "SCORING_RULE.json");
  const scoringRule = readJsonOrNull(scoringRulePath);
  if (!scoringRule) {
    errors.push(`SCORING_RULE.json missing or unparseable at ${scoringRulePath}`);
  } else {
    const liveMapping = CANONICAL_SCORING_MAPPING;
    for (const k of Object.keys(liveMapping)) {
      if (scoringRule.mapping[k] !== liveMapping[k]) {
        errors.push(`SCORING_RULE.json mapping["${k}"] = ${scoringRule.mapping[k]} differs from live scorer mapping ${liveMapping[k]}`);
      }
    }
  }

  const report = {
    schema_version: "steerbench.validator_report.v1",
    run_id: plan.run_id,
    run_root: path.relative(runnerRoot, runRoot) || ".",
    validated_at: new Date().toISOString(),
    pass: errors.length === 0,
    error_count: errors.length,
    errors,
    checks: {
      prompt_hash_matches_plan: true,
      variant_config_hashes_match_plan: true,
      scenario_files_match_manifest: true,
      trial_provenance_intact: true,
      cell_recompute_matches: true,
      run_complete: notCompleted.length === 0
    }
  };
  // The checks block above is a high-level summary; if any error mentions
  // a check class, mark that class false.
  for (const err of errors) {
    if (err.startsWith("PROMPT.txt hash")) report.checks.prompt_hash_matches_plan = false;
    if (err.includes("config_hash")) report.checks.variant_config_hashes_match_plan = false;
    if (err.includes("drifted from manifest") || err.includes("Scenario file missing")) report.checks.scenario_files_match_manifest = false;
    if (err.includes("provenance")) report.checks.trial_provenance_intact = false;
    if (err.includes("recompute")) report.checks.cell_recompute_matches = false;
    if (err.startsWith("Run is not complete")) report.checks.run_complete = false;
  }
  fs.writeFileSync(path.join(runRoot, REPORT_FILENAME), JSON.stringify(report, null, 2));

  log("");
  log(`Run state: planned_variants=${plan.planned_variants.length}, overall_status=${runState.overall_status}`);
  log(`Errors: ${errors.length}`);
  if (errors.length > 0) {
    log("\nErrors:");
    for (const e of errors) log(`  - ${e}`);
  }

  if (errors.length > 0) {
    console.error("\nVALIDATION FAILED");
    process.exit(1);
  }
  log("\nVALIDATION PASSED");
}

main();
