#!/usr/bin/env node
/**
 * @fileoverview Human-gold aggregator for the verdict validation pass.
 * @module scripts/compute-human-gold
 *
 * Reads the per-rater verdict records the labelers write to
 * runs/human-labels/<rater>/<scenario>.json and produces the human-validation
 * artifact the release requires:
 *   - majority-vote gold per axis (>= 2 of the raters who actually voted)
 *   - an adjudication queue (no majority, or any rater flagged that axis)
 *   - inter-annotator agreement: Fleiss kappa + exact agreement per axis,
 *     over the scenarios every rater labeled
 *   - alignment of the human majority to the benchmark-owner canonical label
 *
 * A flag is an abstention, never a vote. functional_category agreement is
 * computed over diagnostic scenarios only (baselines are auto not_applicable,
 * decided by source_basis via isDiagnostic, the same rule the labeler uses).
 * No network calls. Never rewrites a canonical label.
 *
 * Usage:
 *   node scripts/compute-human-gold.mjs [--labels runs/human-labels]
 *     [--out results/v2026-05/human-validation] [--raters rater_1,rater_2,rater_3]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGoldScenarios, isDiagnostic } from "../src/gold-scenarios.mjs";
import { gateState } from "../src/annotator-panel.mjs";

const runnerRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The three scored axes, their valid categories, and whether they are diagnostic-only. */
export const AXES = [
  { key: "gate_state", categories: ["allowed", "blocked"], diagnosticOnly: false },
  { key: "irreversibility_tier", categories: ["low", "medium", "high"], diagnosticOnly: false },
  {
    key: "functional_category",
    categories: ["lexical-overfitting", "instruction-hierarchy-confusion", "missing-information", "unwarranted-abstention"],
    diagnosticOnly: true
  }
];

/**
 * Fleiss kappa over items x raters x a fixed category set, plus the exact
 * (unanimous) agreement rate. Items where any rater is null, or voted outside
 * the category set, are dropped (every rater must have a valid label).
 */
export function fleissKappa(items, raters, categories) {
  const usable = items.filter((it) => raters.every((r) => it.byRater[r] != null && categories.includes(it.byRater[r])));
  const N = usable.length;
  const k = raters.length;
  if (N === 0 || k < 2) return { value: null, n_items: N, n_raters: k, exact_agreement: null };

  const counts = usable.map((it) => {
    const c = Object.fromEntries(categories.map((v) => [v, 0]));
    for (const r of raters) c[it.byRater[r]] += 1;
    return c;
  });
  const total = N * k;
  const pj = Object.fromEntries(categories.map((v) => [v, 0]));
  for (const c of counts) for (const v of categories) pj[v] += c[v];
  for (const v of categories) pj[v] /= total;

  const Pi = counts.map((c) => {
    let s = 0;
    for (const v of categories) s += c[v] * (c[v] - 1);
    return s / (k * (k - 1));
  });
  const Pbar = Pi.reduce((a, b) => a + b, 0) / N;
  let Pe = 0;
  for (const v of categories) Pe += pj[v] * pj[v];
  const exact = counts.filter((c) => categories.some((v) => c[v] === k)).length / N;
  const value = Pe >= 1 ? 1 : (Pbar - Pe) / (1 - Pe);
  return { value: Number(value.toFixed(4)), n_items: N, n_raters: k, exact_agreement: Number(exact.toFixed(4)) };
}

/** Majority value among non-null votes (>= 2), or null on a tie/no-majority. */
export function majority(values) {
  const c = new Map();
  for (const v of values) if (v != null) c.set(v, (c.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of c) if (n > bestN) { best = v; bestN = n; }
  return bestN >= 2 ? best : null;
}

/** Auto-discovers rater_* folders under a labels directory, sorted. */
export function discoverRaters(labelsDir) {
  if (!fs.existsSync(labelsDir)) return [];
  return fs
    .readdirSync(labelsDir)
    .filter((d) => /^rater_/.test(d) && fs.statSync(path.join(labelsDir, d)).isDirectory())
    .sort();
}

/** Loads runs/human-labels/<rater>/*.json into { rater: { scenario_id: record } }. */
export function loadRaters(labelsDir, raters) {
  const out = {};
  for (const rater of raters) {
    const dir = path.join(labelsDir, rater);
    const recs = {};
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json") || f.startsWith("_")) continue;
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (r?.scenario_id) recs[r.scenario_id] = r;
        } catch {
          // skip unreadable record
        }
      }
    }
    out[rater] = recs;
  }
  return out;
}

/** A rater's vote on an axis: the value, or null when absent or flagged (a flag abstains). */
function vote(record, axisKey) {
  if (!record || !record.labels) return null;
  if (record.labels.flagged && record.labels.flagged[axisKey] === true) return null;
  return record.labels[axisKey] ?? null;
}

/** Computes gold + adjudication + IAA + canonical alignment for one axis. */
export function computeAxis(axis, scenarioIds, raterData, raters, canonical) {
  const ids = axis.diagnosticOnly ? scenarioIds.filter((id) => canonical[id]?.is_diagnostic) : scenarioIds;
  const items = ids.map((id) => ({
    scenario_id: id,
    byRater: Object.fromEntries(raters.map((r) => [r, vote(raterData[r]?.[id], axis.key)]))
  }));

  const gold = {};
  const adjudication = [];
  let aligned = 0;
  let alignedTotal = 0;
  for (const it of items) {
    const votes = raters.map((r) => it.byRater[r]).filter((v) => v != null);
    const flagged = raters.some((r) => raterData[r]?.[it.scenario_id]?.labels?.flagged?.[axis.key] === true);
    const maj = majority(votes);
    if (maj != null) gold[it.scenario_id] = maj;
    if (maj == null || flagged) {
      adjudication.push({ scenario_id: it.scenario_id, votes: it.byRater, flagged, reason: maj == null ? "no_majority" : "flagged" });
    }
    const canon = canonical[it.scenario_id]?.[axis.key];
    if (maj != null && canon != null) {
      alignedTotal += 1;
      if (maj === canon) aligned += 1;
    }
  }
  return {
    iaa: fleissKappa(items, raters, axis.categories),
    gold,
    adjudication_queue: adjudication,
    canonical_alignment: { n: alignedTotal, match: aligned, match_rate: alignedTotal ? Number((aligned / alignedTotal).toFixed(4)) : null }
  };
}

/** Builds canonical (benchmark-owner) labels from the scenario set, for alignment + diagnostic split. */
function loadCanonical(scenarios) {
  const TIER = { none: "low", soft_to_reverse: "low", low: "low", medium: "medium", hard_to_reverse: "high", high: "high" };
  const out = {};
  for (const s of scenarios) {
    const expected = s.expected_action || s.expected_behavior?.correct_action || null;
    out[s.id] = {
      is_diagnostic: isDiagnostic(s),
      gate_state: expected ? gateState(expected === "continue" ? "proceed" : expected) : null,
      irreversibility_tier: TIER[s.irreversibility_class] ?? null,
      functional_category: s.taxonomy?.functional_category ?? null
    };
  }
  return out;
}

/** Computes the full human-gold result (IAA, majority gold, adjudication, alignment) per axis. */
export function buildHumanGold({ labelsDir, raters, scenarios }) {
  const canonical = loadCanonical(scenarios);
  const raterData = loadRaters(labelsDir, raters);
  const scenarioIds = scenarios.map((s) => s.id);
  const axes = {};
  for (const axis of AXES) axes[axis.key] = computeAxis(axis, scenarioIds, raterData, raters, canonical);
  const rater_record_counts = Object.fromEntries(raters.map((r) => [r, Object.keys(raterData[r] || {}).length]));
  return { raters, rater_record_counts, axes };
}

function parseArgs(argv) {
  const a = {
    labels: path.join(runnerRoot, "runs", "human-labels"),
    out: path.join(runnerRoot, "results", "v2026-05", "human-validation"),
    raters: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--labels") a.labels = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--raters") a.raters = argv[++i].split(",");
    else if (argv[i] === "--help" || argv[i] === "-h") a.help = true;
  }
  return a;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/compute-human-gold.mjs [--labels <dir>] [--out <dir>] [--raters rater_1,rater_2,rater_3]");
    process.exit(0);
  }
  const raters = args.raters || discoverRaters(args.labels);
  if (raters.length < 2) {
    console.error(`Need at least 2 rater folders under ${args.labels}; found: ${raters.join(", ") || "none"}`);
    process.exit(1);
  }
  const scenarios = loadGoldScenarios();
  const result = buildHumanGold({ labelsDir: args.labels, raters, scenarios });

  const goldLabels = {};
  for (const axis of AXES) {
    for (const [id, v] of Object.entries(result.axes[axis.key].gold)) (goldLabels[id] ||= {})[axis.key] = v;
  }
  const generated_at_utc = new Date().toISOString();
  const report = {
    generated_at_utc,
    raters: result.raters,
    rater_record_counts: result.rater_record_counts,
    inter_annotator_agreement: Object.fromEntries(AXES.map((ax) => [ax.key, result.axes[ax.key].iaa])),
    canonical_alignment: Object.fromEntries(AXES.map((ax) => [ax.key, result.axes[ax.key].canonical_alignment])),
    adjudication_queue: Object.fromEntries(AXES.map((ax) => [ax.key, result.axes[ax.key].adjudication_queue]))
  };
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, "agreement-report.json"), JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(args.out, "gold-labels.json"), JSON.stringify({ generated_at_utc, raters, labels: goldLabels }, null, 2) + "\n");

  const pct = (x) => (x == null ? "n/a" : (x * 100).toFixed(1) + "%");
  console.log(`Human-gold over raters: ${raters.join(", ")}`);
  for (const r of raters) console.log(`  ${r}: ${result.rater_record_counts[r]} records`);
  console.log(`\nInter-annotator agreement (Fleiss kappa | exact, over scenarios every rater labeled):`);
  for (const ax of AXES) {
    const a = result.axes[ax.key].iaa;
    console.log(`  ${ax.key}: kappa ${a.value ?? "n/a"} | ${pct(a.exact_agreement)} (n=${a.n_items})`);
  }
  console.log(`\nMajority gold + adjudication queue:`);
  for (const ax of AXES) {
    console.log(`  ${ax.key}: ${Object.keys(result.axes[ax.key].gold).length} gold, ${result.axes[ax.key].adjudication_queue.length} to adjudicate`);
  }
  console.log(`\nWritten: ${path.relative(runnerRoot, args.out)}/agreement-report.json + gold-labels.json`);
}
