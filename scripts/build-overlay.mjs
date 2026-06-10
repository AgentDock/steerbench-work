// MAINTAINER-ONLY. Builds the provenance overlay for the six-scenario repair.
//
// Why this exists: six scenario files were edited after the locked runs, so the
// six live files no longer hash-match the manifests the locked runs froze. The
// model-facing input did not change (proven by integrity-audit), so the locked
// runs' scores are valid for the bytes they scored. The repair reruns only the
// six against the current files. The published release must then be assembled as
// an explicit OVERLAY: per model, 100 cells from the original locked root + 6
// cells from the repair root.
//
// This script materializes that overlay WITHOUT mutating originals and WITHOUT
// rewriting any provenance field:
//
//   - Each overlay scenario dir is a SYMLINK to the real cell dir (original root
//     for the 100 unchanged, repair root for the 6). The underlying trial files
//     keep their true run_id, dates, request/response bodies.
//   - The overlay summary.json is RECOMPUTED from the 106 cells with the exact
//     scorer.mjs math the runner uses, and is explicitly stamped overlay:true
//     with a per-cell source map, so it can never be mistaken for a single-root
//     run.
//   - The overlay SCENARIO_MANIFEST.json is the CURRENT manifest (current file
//     hashes + current taxonomy), which is what the release claims to publish.
//   - An overlay validator checks the real publish claim: every cell's
//     scenario_sha256 equals the current live file hash; all 106 scenarios are
//     present with the planned trial count; each cell is internally consistent
//     with its trials. It does NOT require a single run_id, because the overlay
//     is mixed-provenance by design (and records that explicitly).
//
// Modes:
//   --noop                  the 6 are taken from the ORIGINAL root too, so the
//                           overlay must reproduce the current site exactly.
//                           Used to prove the machinery before any spend.
//   --repair-root <path>    the 6 are taken from this repair root.
//
// Usage:
//   node scripts/build-overlay.mjs --out runs/overlay-2026-06-07 --noop
//   node scripts/build-overlay.mjs --out runs/overlay-2026-06-07 --repair-root runs/canonical-repair-2026-06-07

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File, buildScenarioManifest } from "../src/manifest.mjs";
import { weightedSeverity, directionalErrorRates, computeCellScore } from "../src/scorer.mjs";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCENARIO_SET = "steerbench-work-2026-05";
const SCENARIO_SET_DIR = "scenario-sets/steerbench-work-2026-05";
const CANONICAL_BASE = "runs/canonical-multi-trial";
const SITE_DETAIL = "../steerbench-site/src/data/scenarios-detail.json";
const N_TRIALS = 5;

const SIX = new Set([
  "apple-card-mirror-credit-extension-tier-b-004",
  "calendar-invite-prompt-injection-004",
  "deposition-statute-of-limitations-003",
  "executive-impersonation-wire-fraud-005",
  "patient-records-employer-disclosure-002",
  "telehealth-marketing-pixel-disclosure-001"
]);

function parseFlags() {
  const a = process.argv.slice(2);
  const get = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
  return { out: get("--out"), repairRoot: get("--repair-root"), noop: a.includes("--noop") };
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function readJsonOrNull(p) { try { return readJson(p); } catch { return null; } }
const round4 = (x) => (x == null ? null : Number(x.toFixed(4)));

// prompt_sha256 of the run that produced a given source root, cached per root.
const rootPromptCache = new Map();
function promptShaForRoot(rootDir) {
  if (!rootPromptCache.has(rootDir)) {
    const plan = readJsonOrNull(path.join(rootDir, "RUN_PLAN.json"));
    rootPromptCache.set(rootDir, plan?.prompt_sha256 ?? null);
  }
  return rootPromptCache.get(rootDir);
}

// Recompute the runner's summary scoring fields from a set of cells. Verified
// bit-identical to the runner's own summary.json across all 27 locked variants.
function recomputeSummary(cells) {
  const scored = cells.filter((c) => c.expected_action != null && c.provider_filtered !== true);
  const correctModal = scored.filter((c) => c.modal_correct === true).length;
  const correctPassAll = scored.filter((c) => c.pass_all_trials === true).length;
  const total = scored.length;
  const sev = weightedSeverity(scored);
  const tr = directionalErrorRates(scored);
  return {
    n_scenarios: cells.length,
    n_provider_filtered: cells.filter((c) => c.provider_filtered === true).length,
    modal_score: `${correctModal}/${total}`,
    modal_accuracy: total > 0 ? Number((correctModal / total).toFixed(4)) : null,
    pass_all_trials_score: `${correctPassAll}/${total}`,
    pass_all_trials_rate: total > 0 ? Number((correctPassAll / total).toFixed(4)) : null,
    weighted_possible_total: sev.weighted_possible_total,
    weighted_miss_total: sev.weighted_miss_total,
    weighted_miss_rate: round4(sev.weighted_miss_rate),
    weighted_modal_accuracy: round4(sev.weighted_modal_accuracy),
    under_refusal_count: tr.under_refusal_count,
    under_refusal_possible: tr.under_refusal_possible,
    under_refusal_rate: round4(tr.under_refusal_rate),
    over_refusal_count: tr.over_refusal_count,
    over_refusal_possible: tr.over_refusal_possible,
    over_refusal_rate: round4(tr.over_refusal_rate)
  };
}

function main() {
  const { out, repairRoot, noop } = parseFlags();
  if (!out) { console.error("Usage: --out <dir> (--noop | --repair-root <path>)"); process.exit(1); }
  if (!noop && !repairRoot) { console.error("Provide --noop or --repair-root <path>"); process.exit(1); }

  const specs = readJson(path.join(runnerRoot, SITE_DETAIL)).built_from; // {run_root, variant, label}
  const currentManifest = buildScenarioManifest({ scenarioSet: SCENARIO_SET, scenarioSetDir: SCENARIO_SET_DIR });
  const currentHashById = new Map(currentManifest.scenarios.map((s) => [s.id, s.sha256]));
  const allIds = currentManifest.scenarios.map((s) => s.id);

  const outAbs = path.resolve(runnerRoot, out);
  fs.mkdirSync(outAbs, { recursive: true });

  const problems = [];
  const provenanceAll = {};
  let modelsBuilt = 0;

  for (const spec of specs) {
    const origVariantDir = path.resolve(runnerRoot, CANONICAL_BASE, spec.run_root, spec.variant);
    const repairVariantDir = repairRoot ? path.resolve(runnerRoot, repairRoot, spec.variant) : null;
    const sourceForId = (id) => (SIX.has(id) ? (noop ? origVariantDir : repairVariantDir) : origVariantDir);

    const overlayRootDir = path.join(outAbs, spec.run_root);
    const overlayVariantDir = path.join(overlayRootDir, spec.variant);
    fs.mkdirSync(overlayVariantDir, { recursive: true });

    const cells = [];
    const cellSources = {};
    for (const id of allIds) {
      const srcDir = sourceForId(id);
      const srcRootDir = path.dirname(srcDir);
      const srcScenarioDir = path.join(srcDir, id);
      const cell = readJsonOrNull(path.join(srcScenarioDir, "cell.json"));
      if (!cell) { problems.push(`${spec.variant}/${id}: missing cell.json`); continue; }

      const curHash = currentHashById.get(id);
      const kind = SIX.has(id) ? (noop ? "original" : "repair") : "original";

      // PUBLISH CLAIM: the cell must have scored the CURRENT file bytes.
      if (cell.scenario_sha256 !== curHash) {
        problems.push(`${spec.variant}/${id}: cell scenario_sha256 ${String(cell.scenario_sha256).slice(0, 12)} != current file hash ${String(curHash).slice(0, 12)}`);
      }
      // Completeness + read trials.
      const trials = [];
      for (let t = 1; t <= N_TRIALS; t += 1) {
        const tr = readJsonOrNull(path.join(srcScenarioDir, `trial-${t}.json`));
        if (tr) trials.push(tr);
      }
      if (trials.length !== N_TRIALS) problems.push(`${spec.variant}/${id}: ${trials.length}/${N_TRIALS} trials present`);
      // Scoring recomputes from the trial files (same scorer as the runner).
      if (trials.length === N_TRIALS) {
        const rc = computeCellScore(trials, cell.expected_action);
        for (const f of ["modal_commit_permission", "modal_correct", "n_correct_trials", "pass_all_trials"]) {
          if (JSON.stringify(rc[f]) !== JSON.stringify(cell[f])) {
            problems.push(`${spec.variant}/${id}: cell.${f} diverges from trial recompute (cell=${JSON.stringify(cell[f])} trials=${JSON.stringify(rc[f])})`);
          }
        }
      }

      cells.push(cell);
      // Per-cell chain of evidence: which root, which run, which hashes.
      cellSources[id] = {
        source_kind: kind,
        source_root: path.relative(runnerRoot, srcRootDir),
        source_run_id: cell.run_id ?? null,
        scenario_sha256_used: cell.scenario_sha256 ?? null,
        current_file_sha256: curHash ?? null,
        hash_matches_current: cell.scenario_sha256 === curHash,
        prompt_sha256: promptShaForRoot(srcRootDir),
        variant_config_hash: cell.variant_config_hash ?? null
      };

      // Symlink the overlay scenario dir to the real source dir (no copy, no rewrite).
      const link = path.join(overlayVariantDir, id);
      if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(srcScenarioDir, link, "dir");
    }

    const origSummary = readJsonOrNull(path.join(origVariantDir, "summary.json")) || {};
    const recomputed = recomputeSummary(cells);
    const overlaySummary = {
      overlay: true,
      schema_version: "steerbench.overlay_summary.v1",
      variant: spec.variant,
      label: spec.label || origSummary.label || spec.variant,
      reasoning_label: origSummary.reasoning_label ?? null,
      n_trials_per_cell: N_TRIALS,
      cell_sources: cellSources,
      repaired_scenarios: [...SIX].filter((id) => allIds.includes(id)),
      repair_source: noop ? "noop-original" : path.relative(runnerRoot, path.resolve(runnerRoot, repairRoot)),
      ...recomputed
    };
    fs.writeFileSync(path.join(overlayVariantDir, "summary.json"), JSON.stringify(overlaySummary, null, 2));
    fs.writeFileSync(path.join(overlayVariantDir, "cells.json"), JSON.stringify(cells, null, 2));
    provenanceAll[spec.variant] = cellSources;
    modelsBuilt += 1;

    // Overlay manifest per root (current hashes + current taxonomy). Idempotent.
    fs.writeFileSync(path.join(overlayRootDir, "SCENARIO_MANIFEST.json"), JSON.stringify(currentManifest, null, 2));
  }

  // Top-level overlay artifacts.
  const report = {
    schema_version: "steerbench.overlay_report.v1",
    mode: noop ? "noop" : "repair",
    repair_root: noop ? null : path.relative(runnerRoot, path.resolve(runnerRoot, repairRoot)),
    out: path.relative(runnerRoot, outAbs),
    models_built: modelsBuilt,
    scenario_count: allIds.length,
    repaired_scenarios: [...SIX],
    pass: problems.length === 0,
    problems
  };
  fs.writeFileSync(path.join(outAbs, "overlay-validator-report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outAbs, "PROVENANCE.json"), JSON.stringify({
    schema_version: "steerbench.overlay_provenance.v1",
    mode: noop ? "noop" : "repair",
    by_variant: provenanceAll
  }, null, 2));

  console.log(`overlay built: ${modelsBuilt} models, ${allIds.length} scenarios each, mode=${noop ? "noop" : "repair"}`);
  console.log(`  out: ${report.out}`);
  if (problems.length) {
    console.log(`  OVERLAY VALIDATOR: ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 20)) console.log(`    x ${p}`);
    process.exit(2);
  }
  console.log(`  OVERLAY VALIDATOR PASS: every cell hash-matches the current file; 106x${N_TRIALS} complete.`);
}

main();
