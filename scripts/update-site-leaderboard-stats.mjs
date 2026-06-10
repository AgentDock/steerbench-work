// MAINTAINER-ONLY. Not part of the public runner surface: this script reads and
// writes the neighboring steerbench-site repo (../steerbench-site/...) and only
// runs in the monorepo checkout, not in a standalone clone of this repo.
//
// Recompute site leaderboard derived stats from the per-scenario trial data.
//
// Inputs:
//   ../steerbench-site/src/data/leaderboard.json
//   ../steerbench-site/src/data/scenarios-detail.json
//
// Outputs:
//   leaderboard.json with mean_trial_accuracy and Wilson 95% CI fields:
//     mean_trial_accuracy_ci95
//     modal_accuracy_ci95
//     pass5_ci95
//
// This keeps display-only site fields tied to the same validated trial records
// that power the matrix and scenario pages.

import fs from "node:fs";

const LEADERBOARD = "../steerbench-site/src/data/leaderboard.json";
const SCENARIOS = "../steerbench-site/src/data/scenarios-detail.json";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function siteModelLabel(row) {
  const setting = String(row.reasoning || "").startsWith("on") ? "on" : row.reasoning;
  return `${row.model} (${setting})`;
}

function pct1(n, d) {
  return `${((n / d) * 100).toFixed(1)}%`;
}

function wilson(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    low: Math.max(0, center - spread),
    high: Math.min(1, center + spread),
  };
}

function ciString(successes, total) {
  const ci = wilson(successes, total);
  if (!ci) return "—";
  return `[${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]`;
}

function countsFor(label, scenarios) {
  const out = {
    meanCorrect: 0,
    meanTotal: 0,
    modalCorrect: 0,
    modalTotal: 0,
    pass5Correct: 0,
  };

  for (const scenario of scenarios) {
    const v = (scenario.model_verdicts || []).find((x) => x.model === label);
    if (!v || v.provider_filtered) continue;
    if (v.expected == null) continue;

    out.modalTotal += 1;
    if (v.correct === true) out.modalCorrect += 1;
    if (v.pass_all === true) out.pass5Correct += 1;

    if (typeof v.n_correct === "number" && typeof v.n_trials === "number") {
      out.meanCorrect += v.n_correct;
      out.meanTotal += v.n_trials;
    }
  }

  return out;
}

const leaderboard = readJson(LEADERBOARD);
const scenarioDetail = readJson(SCENARIOS);

for (const row of leaderboard.rows || []) {
  if (row.archived) continue;
  const label = siteModelLabel(row);
  const counts = countsFor(label, scenarioDetail.scenarios || []);
  if (!counts.modalTotal || !counts.meanTotal) {
    throw new Error(`No scenario-detail counts for ${row.model}|${row.reasoning} (${label})`);
  }

  row.mean_trial_accuracy = pct1(counts.meanCorrect, counts.meanTotal);
  row.mean_trial_accuracy_ci95 = ciString(counts.meanCorrect, counts.meanTotal);
  row.modal_accuracy_ci95 = ciString(counts.modalCorrect, counts.modalTotal);
  row.pass5_ci95 = ciString(counts.pass5Correct, counts.modalTotal);
}

fs.writeFileSync(LEADERBOARD, `${JSON.stringify(leaderboard, null, 2)}\n`);
console.log(`updated ${LEADERBOARD} with mean accuracy and Wilson 95% CI fields`);
