#!/usr/bin/env node
// Inter-annotator agreement + canonical alignment for the three-vendor panel.
//
// Reads the per-(scenario, vendor) label records written by run-annotators.mjs
// and computes, with NO network calls:
//
//   Inter-annotator agreement (do the 3 models agree with EACH OTHER):
//     - gate_state (allowed/blocked)  Fleiss kappa + percent agreement, n=106
//     - irreversibility_tier (low/med/high)  Fleiss kappa + percent, n=106
//     - functional_category (4-way)  Fleiss kappa + percent, n=76 applicable
//       (calibration rows marked not_applicable are excluded from this kappa)
//
//   Canonical alignment (do the models agree with the TEAM's labels):
//     - majority (>=2/3) and unanimous (3/3) match rates vs canonical, per label.
//     - Rows where the panel majority disagrees with canonical are listed for
//       adjudication; the script NEVER rewrites a canonical label.
//
// Fleiss kappa is generalized to run over an arbitrary label + category set.
//
// Usage: node scripts/compute-agreement.mjs runs/annotator-panel/<timestamp>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateState } from "../src/annotator-panel.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.join(__dirname, "..");
const SCENARIO_DIR = path.join(runnerRoot, "scenario-sets", "steerbench-work-2026-05");

const VENDORS = ["gpt-5.5", "claude-opus-4.8", "gemini-3.1-pro"];

// ---------------------------------------------------------------------------
// Fleiss kappa over N items x k raters x a fixed category set.
// items: array of { byRater: { rater -> category|null } }. Items where any
// rater is null are dropped (every rater must have labeled the item).
// ---------------------------------------------------------------------------
function fleissKappa(items, raters, categories) {
  const usable = items.filter((it) => raters.every((r) => it.byRater[r] != null));
  const N = usable.length;
  const k = raters.length;
  if (N === 0 || k < 2) return { value: null, n_items: N, n_raters: k, percent_agreement: null };

  const counts = usable.map((it) => {
    const c = new Map(categories.map((v) => [v, 0]));
    for (const r of raters) {
      const v = it.byRater[r];
      if (c.has(v)) c.set(v, c.get(v) + 1);
    }
    return c;
  });

  const totalAssignments = N * k;
  const pj = new Map(categories.map((v) => [v, 0]));
  for (const c of counts) for (const v of categories) pj.set(v, pj.get(v) + (c.get(v) || 0));
  for (const v of categories) pj.set(v, pj.get(v) / totalAssignments);

  const Pi = counts.map((c) => {
    let s = 0;
    for (const v of categories) {
      const n = c.get(v) || 0;
      s += n * (n - 1);
    }
    return s / (k * (k - 1));
  });

  const Pbar = Pi.reduce((a, b) => a + b, 0) / N;
  let Pe = 0;
  for (const v of categories) {
    const p = pj.get(v) || 0;
    Pe += p * p;
  }
  // Percent agreement: share of items where all k raters chose the same category.
  const unanimous = counts.filter((c) => categories.some((v) => (c.get(v) || 0) === k)).length;
  const percent = unanimous / N;

  if (Pe >= 1) return { value: 1, n_items: N, n_raters: k, percent_agreement: percent };
  return { value: (Pbar - Pe) / (1 - Pe), n_items: N, n_raters: k, percent_agreement: percent };
}

// Majority (>=2 of 3, the modal value) for a list of labels, or null if no
// value reaches 2 (a 1-1-1 three-way split has no majority).
function majority(values) {
  const c = new Map();
  for (const v of values) if (v != null) c.set(v, (c.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of c) if (n > bestN) { best = v; bestN = n; }
  return bestN >= 2 ? best : null;
}

function loadCanonical() {
  // Canonical labels straight from the corpus, normalized to the same spaces the
  // panel uses, so alignment is apples-to-apples.
  const TIER_MAP = { none: "low", soft_to_reverse: "low", low: "low", medium: "medium", hard_to_reverse: "high", high: "high" };
  const out = {};
  for (const f of fs.readdirSync(SCENARIO_DIR).filter((x) => x.endsWith(".json"))) {
    const s = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), "utf8"));
    const id = s.id || f.replace(/\.json$/, "");
    const expected = s.expected_action || s.expected_behavior?.correct_action || null;
    out[id] = {
      is_diagnostic: !!(s.taxonomy && typeof s.taxonomy === "object"),
      gate_state: expected ? gateState(expected === "continue" ? "proceed" : expected) : null,
      irreversibility_tier: TIER_MAP[s.irreversibility_class] ?? null,
      functional_category: s.taxonomy?.functional_category ?? null
    };
  }
  return out;
}

function loadPanel(runRoot) {
  // panel[scenarioId][vendor] = labels merged across both prompt passes.
  // Two-pass layout: <root>/<vendor>/scenario-label/<id>.json carries gate_state
  // + irreversibility_tier; <root>/<vendor>/mechanism/<id>.json carries
  // functional_category. They are merged per (scenario, vendor) cell. A failed
  // pass simply contributes no labels, so a per-axis failure drops only that
  // axis for that cell, not the whole cell.
  const panel = {};
  for (const vendor of VENDORS) {
    for (const type of ["scenario-label", "mechanism"]) {
      const dir = path.join(runRoot, vendor, type);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const cell = ((panel[rec.scenario_id] ||= {})[vendor] ||= {});
        if (rec.ok && rec.labels) Object.assign(cell, rec.labels);
      }
    }
  }
  return panel;
}

function alignment(scenarioIds, panel, canonical, labelKey, applicableFilter) {
  let n = 0, majorityMatch = 0, unanimousMatch = 0;
  const disagreements = [];
  for (const id of scenarioIds) {
    if (applicableFilter && !applicableFilter(canonical[id])) continue;
    const canon = canonical[id]?.[labelKey];
    if (canon == null) continue;
    const votes = VENDORS.map((v) => panel[id]?.[v]?.[labelKey]).filter((x) => x != null);
    if (votes.length < 2) continue;
    n++;
    const maj = majority(votes);
    if (maj === canon) majorityMatch++;
    if (votes.length === VENDORS.length && votes.every((x) => x === canon)) unanimousMatch++;
    else if (maj !== canon) disagreements.push({ scenario_id: id, canonical: canon, panel_votes: votes });
  }
  return {
    n,
    majority_match_rate: n ? majorityMatch / n : null,
    unanimous_match_rate: n ? unanimousMatch / n : null,
    majority_match_count: majorityMatch,
    unanimous_match_count: unanimousMatch,
    adjudication_queue: disagreements
  };
}

function buildItems(scenarioIds, panel, labelKey, filterFn) {
  return scenarioIds
    .filter((id) => (filterFn ? filterFn(id) : true))
    .map((id) => ({
      scenario_id: id,
      byRater: Object.fromEntries(VENDORS.map((v) => [v, panel[id]?.[v]?.[labelKey] ?? null]))
    }));
}

function main() {
  const runRoot = process.argv[2];
  if (!runRoot) {
    console.error("Usage: node scripts/compute-agreement.mjs runs/annotator-panel/<timestamp>");
    process.exit(1);
  }
  const absRoot = path.isAbsolute(runRoot) ? runRoot : path.join(runnerRoot, runRoot);
  const canonical = loadCanonical();
  const panel = loadPanel(absRoot);
  const scenarioIds = Object.keys(panel).sort();
  const diagnosticIds = scenarioIds.filter((id) => canonical[id]?.is_diagnostic);

  // Inter-annotator agreement (rater vs rater)
  const gateItems = buildItems(scenarioIds, panel, "gate_state");
  const tierItems = buildItems(scenarioIds, panel, "irreversibility_tier");
  const catItems = buildItems(diagnosticIds, panel, "functional_category");

  const interAnnotator = {
    gate_state: fleissKappa(gateItems, VENDORS, ["allowed", "blocked"]),
    irreversibility_tier: fleissKappa(tierItems, VENDORS, ["low", "medium", "high"]),
    functional_category_n76: fleissKappa(catItems, VENDORS, ["lexical-overfitting", "instruction-hierarchy-confusion", "missing-information", "unwarranted-abstention"])
  };

  // Canonical alignment (rater vs team labels)
  const canonicalAlignment = {
    gate_state: alignment(scenarioIds, panel, canonical, "gate_state"),
    irreversibility_tier: alignment(scenarioIds, panel, canonical, "irreversibility_tier"),
    functional_category_n76: alignment(scenarioIds, panel, canonical, "functional_category", (c) => c && c.is_diagnostic)
  };

  // Calibration-row functional_category DISTRIBUTION (not a pass/fail QA).
  // The 30 calibration rows have no canonical functional_category. Annotators may
  // still reasonably identify a failure mechanism on them. That is NOT a
  // disagreement and NOT forced to not_applicable. We record the vote
  // distribution and surface any row where the panel majority named a real
  // mechanism as an EXPLORATORY adjudication candidate (a calibration row that
  // may actually be diagnostic), never silently relabeled.
  const calibrationIds = scenarioIds.filter((id) => !canonical[id]?.is_diagnostic);
  const calibDistribution = {};
  const calibExploratory = [];
  for (const id of calibrationIds) {
    const votes = VENDORS.map((v) => panel[id]?.[v]?.functional_category).filter((x) => x != null);
    for (const fc of votes) calibDistribution[fc] = (calibDistribution[fc] || 0) + 1;
    const maj = majority(votes);
    if (maj && maj !== "not_applicable") {
      calibExploratory.push({ scenario_id: id, panel_majority_category: maj, panel_votes: votes });
    }
  }

  const report = {
    generated_at_utc: new Date().toISOString(),
    run_root: path.relative(runnerRoot, absRoot),
    scenarios_with_panel_data: scenarioIds.length,
    diagnostic_scenarios: diagnosticIds.length,
    calibration_scenarios: calibrationIds.length,
    inter_annotator_agreement: interAnnotator,
    canonical_alignment: canonicalAlignment,
    calibration_category_distribution: {
      note: "30 calibration rows have no canonical functional_category. These are panel vote counts, NOT a pass/fail check. Rows where the panel majority named a real failure mechanism are exploratory adjudication candidates (possibly diagnostic, not silently relabeled).",
      vote_distribution: calibDistribution,
      exploratory_adjudication_candidates: calibExploratory
    }
  };

  const outPath = path.join(absRoot, "agreement-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  const pct = (x) => (x == null ? "n/a" : (x * 100).toFixed(1) + "%");
  const kap = (x) => (x == null ? "n/a" : x.toFixed(3));
  console.log(`\nInter-annotator agreement (Fleiss kappa | percent unanimous):`);
  console.log(`  gate (allowed/blocked) n=${interAnnotator.gate_state.n_items}: kappa ${kap(interAnnotator.gate_state.value)} | ${pct(interAnnotator.gate_state.percent_agreement)}`);
  console.log(`  irreversibility_tier   n=${interAnnotator.irreversibility_tier.n_items}: kappa ${kap(interAnnotator.irreversibility_tier.value)} | ${pct(interAnnotator.irreversibility_tier.percent_agreement)}`);
  console.log(`  functional_category    n=${interAnnotator.functional_category_n76.n_items}: kappa ${kap(interAnnotator.functional_category_n76.value)} | ${pct(interAnnotator.functional_category_n76.percent_agreement)}`);
  console.log(`\nCanonical alignment (panel majority vs team labels):`);
  console.log(`  gate            n=${canonicalAlignment.gate_state.n}: majority ${pct(canonicalAlignment.gate_state.majority_match_rate)} | unanimous ${pct(canonicalAlignment.gate_state.unanimous_match_rate)}`);
  console.log(`  irreversibility n=${canonicalAlignment.irreversibility_tier.n}: majority ${pct(canonicalAlignment.irreversibility_tier.majority_match_rate)} | unanimous ${pct(canonicalAlignment.irreversibility_tier.unanimous_match_rate)}`);
  console.log(`  functional_cat  n=${canonicalAlignment.functional_category_n76.n}: majority ${pct(canonicalAlignment.functional_category_n76.majority_match_rate)} | unanimous ${pct(canonicalAlignment.functional_category_n76.unanimous_match_rate)}`);
  console.log(`\nCalibration-row category distribution (no canonical category; exploratory):`);
  console.log(`  votes: ${JSON.stringify(calibDistribution)}`);
  console.log(`  exploratory adjudication candidates (calibration row, panel named a real mechanism): ${calibExploratory.length}`);
  console.log(`\nFull report: ${path.relative(runnerRoot, outPath)}`);
}

main();
