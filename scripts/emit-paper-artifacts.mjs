#!/usr/bin/env node
// Paper-artifact emitter: regenerate every number the manuscript and the site
// prose cite, directly from the frozen release bundle, with NO network calls.
//
// Reads results/<release>/leaderboard.json and scenarios-detail.json and writes
// to --out:
//
//   numbers.json       every headline number with provenance (input sha256s)
//   leaderboard.tex    booktabs table of all conditions, primary-rank order
//   patterns.tex       construction-pattern difficulty table
//   directional.dat    per-condition over/under-refusal rates (pgfplots scatter)
//   anchor-mirror.dat  per-condition anchor vs mirror modal accuracy (pgfplots)
//
// Self-verifying: every per-row statistic is recomputed from scenarios-detail
// and compared against the published leaderboard.json strings before anything
// is written. A mismatch aborts the run. This means a manuscript built from
// these artifacts cannot cite a number that disagrees with the release.
//
// Percentages are computed from raw counts and rounded once, matching
// verify-published-numbers.mjs. Derived differences (for example the
// anchor-minus-mirror gap) are computed from the raw fractions and rounded
// once, NOT taken as a difference of two already-rounded numbers.
//
// Usage: node scripts/emit-paper-artifacts.mjs --out <dir> [--release v2026-05]

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.join(__dirname, "..");

export const EMITTER_VERSION = "paper-artifacts/0.1.0";

/** Same expected-verb to gate-state mapping the scorer publishes. */
export const EXPECTED_TO_PERMISSION = Object.freeze({
  continue: "allowed",
  proceed: "allowed",
  block: "blocked",
  request_approval: "blocked",
  escalate: "blocked",
  ask_clarification: "blocked"
});

/** Display order and labels for the construction-pattern table. */
const PATTERN_LABELS = Object.freeze({
  clean_control: "Clean control",
  calibration_control: "Calibration control",
  public_harm_anchor: "Public-harm anchor",
  risk_resolved: "Risk-resolved commit",
  detector_conflict: "Detector conflict",
  incident_mirror: "Incident mirror",
  adversarial_control: "Adversarial control",
  risk_unresolved: "Risk-unresolved hold"
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** One-decimal percent from raw counts; integers drop the decimal (site style). */
function pct1(count, possible) {
  const x = (count / possible) * 100;
  return x % 1 === 0 ? x.toFixed(0) : x.toFixed(1);
}

/** "gemini-3.1-flash-lite (minimal)" label used by scenarios-detail verdicts. */
function detailLabel(row) {
  const setting = String(row.reasoning || "").startsWith("on") ? "on" : row.reasoning;
  return `${row.model} (${setting})`;
}

/**
 * Recompute one condition's published statistics from per-scenario verdicts.
 * Mirrors scenarioDetailSummary in verify-published-numbers.mjs: skip logic
 * must stay identical or the recomputed denominators drift from the release.
 */
export function conditionStats(modelLabel, scenarios) {
  const out = {
    modal_correct: 0, modal_possible: 0, pass_all: 0,
    mean_correct: 0, mean_possible: 0,
    under_count: 0, under_possible: 0,
    over_count: 0, over_possible: 0
  };
  for (const scenario of scenarios) {
    const v = (scenario.model_verdicts || []).find((x) => x.model === modelLabel);
    if (!v || v.provider_filtered) continue;
    if (v.expected != null) {
      out.modal_possible += 1;
      if (v.correct === true) out.modal_correct += 1;
      if (v.pass_all === true) out.pass_all += 1;
      if (typeof v.n_correct === "number" && typeof v.n_trials === "number") {
        out.mean_correct += v.n_correct;
        out.mean_possible += v.n_trials;
      }
    }
    const required = EXPECTED_TO_PERMISSION[v.expected];
    if (!required || !v.modal_decision) continue;
    if (required === "blocked") {
      out.under_possible += 1;
      if (v.modal_decision === "allowed") out.under_count += 1;
    } else {
      out.over_possible += 1;
      if (v.modal_decision === "blocked") out.over_count += 1;
    }
  }
  return out;
}

/** Aggregate directional misses over every (scenario, condition) cell. */
export function directionalAggregate(scenarios) {
  let over = 0, overPossible = 0, under = 0, underPossible = 0;
  for (const s of scenarios) {
    for (const v of s.model_verdicts || []) {
      if (v.provider_filtered) continue;
      const required = EXPECTED_TO_PERMISSION[v.expected];
      if (!required || !v.modal_decision) continue;
      if (required === "blocked") {
        underPossible += 1;
        if (v.modal_decision === "allowed") under += 1;
      } else {
        overPossible += 1;
        if (v.modal_decision === "blocked") over += 1;
      }
    }
  }
  return { over, overPossible, under, underPossible };
}

/** Modal accuracy per construction pattern, across all conditions. */
export function patternTable(scenarios) {
  const byPattern = new Map();
  for (const s of scenarios) {
    const key = s.boundary_pattern;
    if (!byPattern.has(key)) byPattern.set(key, { rows: 0, correct: 0, cells: 0 });
    const p = byPattern.get(key);
    p.rows += 1;
    for (const v of s.model_verdicts || []) {
      if (v.provider_filtered) continue;
      p.cells += 1;
      if (v.correct === true) p.correct += 1;
    }
  }
  return [...byPattern.entries()]
    .map(([pattern, p]) => ({
      pattern,
      label: PATTERN_LABELS[pattern] || pattern,
      rows: p.rows,
      cells: p.cells,
      correct: p.correct,
      modal_pct: Number(((p.correct / p.cells) * 100).toFixed(1))
    }))
    .sort((a, b) => b.modal_pct - a.modal_pct || a.pattern.localeCompare(b.pattern));
}

/**
 * Compare recomputed stats against the published leaderboard row strings.
 * Any mismatch is a fabrication-gate failure and aborts the emit.
 */
function verifyRow(row, d) {
  const problems = [];
  const checks = [
    ["modal_accuracy", row.modal_accuracy, `${(d.modal_correct / d.modal_possible * 100).toFixed(1)}% (${d.modal_correct}/${d.modal_possible})`],
    ["mean_trial_accuracy", row.mean_trial_accuracy, `${(d.mean_correct / d.mean_possible * 100).toFixed(1)}%`],
    ["pass5", row.pass5, `${(d.pass_all / d.modal_possible * 100).toFixed(1)}%`],
    ["under_refusal", row.under_refusal, `${pct1(d.under_count, d.under_possible)}% (${d.under_count}/${d.under_possible})`],
    ["over_refusal", row.over_refusal, `${pct1(d.over_count, d.over_possible)}% (${d.over_count}/${d.over_possible})`]
  ];
  for (const [field, published, recomputed] of checks) {
    if (String(published) !== String(recomputed)) {
      problems.push(`${detailLabel(row)} ${field}: published "${published}" != recomputed "${recomputed}"`);
    }
  }
  return problems;
}

const texEscape = (s) => String(s).replace(/%/g, "\\%");
const stripPct = (s) => String(s).replace(/%/g, "");

function generatedHeader(release, comment) {
  return `${comment} GENERATED by scripts/emit-paper-artifacts.mjs (${EMITTER_VERSION}) from results/${release}. Do not edit by hand; re-run the emitter.\n`;
}

/**
 * Compute and write every artifact. Returns the numbers object.
 *
 * @param {object} opts
 * @param {string} opts.resultsDir - directory holding leaderboard.json + scenarios-detail.json
 * @param {string} opts.outDir - output directory (created if missing)
 * @param {string} opts.release - release tag recorded in provenance
 * @throws if any recomputed statistic disagrees with the published row strings
 */
export function emitPaperArtifacts({ resultsDir, outDir, release }) {
  const lbPath = path.join(resultsDir, "leaderboard.json");
  const detailPath = path.join(resultsDir, "scenarios-detail.json");
  const lb = readJson(lbPath);
  const detail = readJson(detailPath);
  const scenarios = detail.scenarios || [];
  const live = (lb.rows || []).filter((r) => !r.archived);

  // Fabrication gate: recompute every row before writing anything.
  const rows = [];
  const problems = [];
  for (const row of live) {
    const d = conditionStats(detailLabel(row), scenarios);
    problems.push(...verifyRow(row, d));
    rows.push({ row, d });
  }
  if (problems.length) {
    throw new Error(`fabrication gate failed, nothing written:\n  ${problems.join("\n  ")}`);
  }

  // Primary rank: mean trial accuracy desc, then pass^5, then label (deterministic).
  rows.sort((a, b) =>
    b.d.mean_correct / b.d.mean_possible - a.d.mean_correct / a.d.mean_possible ||
    b.d.pass_all - a.d.pass_all ||
    detailLabel(a.row).localeCompare(detailLabel(b.row))
  );

  const agg = directionalAggregate(scenarios);
  const patterns = patternTable(scenarios);
  const anchor = patterns.find((p) => p.pattern === "public_harm_anchor");
  const mirror = patterns.find((p) => p.pattern === "incident_mirror");
  // Gap from raw fractions, rounded once. NOT a difference of rounded numbers.
  const anchorMirrorGap = Number(
    ((anchor.correct / anchor.cells - mirror.correct / mirror.cells) * 100).toFixed(1)
  );

  const leader = rows[0];
  const numbers = {
    version: EMITTER_VERSION,
    release,
    input: {
      leaderboard: { path: `results/${release}/leaderboard.json`, sha256: sha256(lbPath) },
      scenarios_detail: { path: `results/${release}/scenarios-detail.json`, sha256: sha256(detailPath) }
    },
    scenario_count: detail.scenario_count ?? scenarios.length,
    condition_count: live.length,
    trials_per_cell: 5,
    leader: {
      model: leader.row.model,
      reasoning: leader.row.reasoning,
      mean_trial_accuracy: leader.row.mean_trial_accuracy,
      mean_trial_accuracy_ci95: leader.row.mean_trial_accuracy_ci95,
      pass5: leader.row.pass5
    },
    directional: {
      over_refusal: { count: agg.over, possible: agg.overPossible, rate_pct: Number(pct1(agg.over, agg.overPossible)) },
      under_refusal: { count: agg.under, possible: agg.underPossible, rate_pct: Number(pct1(agg.under, agg.underPossible)) },
      raw_ratio: Number((agg.over / agg.under).toFixed(1)),
      rate_ratio: Number(((agg.over / agg.overPossible) / (agg.under / agg.underPossible)).toFixed(1))
    },
    anchor_mirror: {
      anchor_pct: anchor.modal_pct,
      anchor_counts: `${anchor.correct}/${anchor.cells}`,
      mirror_pct: mirror.modal_pct,
      mirror_counts: `${mirror.correct}/${mirror.cells}`,
      gap_points: anchorMirrorGap,
      note: "gap computed from raw fractions and rounded once"
    },
    patterns
  };

  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, "numbers.json"), `${JSON.stringify(numbers, null, 2)}\n`);

  const lbTex = [
    generatedHeader(release, "%"),
    "\\begin{tabular}{llrrrrrr}",
    "\\toprule",
    "Model & Reasoning & Mean trial \\% & 95\\% CI & Modal-of-5 \\% & pass\\textsuperscript{5} \\% & Under-refusal & Over-refusal \\\\",
    "\\midrule",
    ...rows.map(({ row }) =>
      [
        texEscape(row.model),
        texEscape(row.reasoning),
        stripPct(row.mean_trial_accuracy),
        stripPct(row.mean_trial_accuracy_ci95),
        stripPct(String(row.modal_accuracy).split(" ")[0]),
        stripPct(row.pass5),
        texEscape(row.under_refusal),
        texEscape(row.over_refusal)
      ].join(" & ") + " \\\\"
    ),
    "\\bottomrule",
    "\\end{tabular}",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "leaderboard.tex"), lbTex);

  const patTex = [
    generatedHeader(release, "%"),
    "\\begin{tabular}{lrrr}",
    "\\toprule",
    "Construction pattern & Scenarios & Cells & Modal accuracy \\% \\\\",
    "\\midrule",
    ...patterns.map((p) => `${texEscape(p.label)} & ${p.rows} & ${p.cells} & ${p.modal_pct} \\\\`),
    "\\bottomrule",
    "\\end{tabular}",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "patterns.tex"), patTex);

  const dirDat = [
    generatedHeader(release, "#"),
    "# label overRefusalPct underRefusalPct meanTrialPct",
    ...rows.map(({ row, d }) =>
      [
        `${row.model}(${row.reasoning})`.replace(/\s+/g, ""),
        (d.over_count / d.over_possible * 100).toFixed(1),
        (d.under_count / d.under_possible * 100).toFixed(1),
        (d.mean_correct / d.mean_possible * 100).toFixed(1)
      ].join(" ")
    ),
    ""
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "directional.dat"), dirDat);

  const anchorIds = new Set(scenarios.filter((s) => s.boundary_pattern === "public_harm_anchor").map((s) => s.id));
  const mirrorIds = new Set(scenarios.filter((s) => s.boundary_pattern === "incident_mirror").map((s) => s.id));
  const amDat = [
    generatedHeader(release, "#"),
    "# label anchorModalPct mirrorModalPct",
    ...rows.map(({ row }) => {
      const label = detailLabel(row);
      let aC = 0, aT = 0, mC = 0, mT = 0;
      for (const s of scenarios) {
        const v = (s.model_verdicts || []).find((x) => x.model === label);
        if (!v || v.provider_filtered) continue;
        if (anchorIds.has(s.id)) { aT += 1; if (v.correct === true) aC += 1; }
        if (mirrorIds.has(s.id)) { mT += 1; if (v.correct === true) mC += 1; }
      }
      return [
        `${row.model}(${row.reasoning})`.replace(/\s+/g, ""),
        (aC / aT * 100).toFixed(1),
        (mC / mT * 100).toFixed(1)
      ].join(" ");
    }),
    ""
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "anchor-mirror.dat"), amDat);

  return numbers;
}

function parseArgs(argv) {
  const args = { release: "v2026-05" };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--out") args.out = value;
    else if (flag === "--release") args.release = value;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!args.out) throw new Error("--out <dir> is required");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsDir = path.join(runnerRoot, "results", args.release);
  const numbers = emitPaperArtifacts({
    resultsDir,
    outDir: path.resolve(args.out),
    release: args.release
  });
  console.log(`fabrication gate passed: ${numbers.condition_count} conditions recomputed and matched.`);
  console.log(`leader: ${numbers.leader.model} (${numbers.leader.reasoning}) ${numbers.leader.mean_trial_accuracy}`);
  console.log(`directional: over ${numbers.directional.over_refusal.count}/${numbers.directional.over_refusal.possible} (${numbers.directional.over_refusal.rate_pct}%), under ${numbers.directional.under_refusal.count}/${numbers.directional.under_refusal.possible} (${numbers.directional.under_refusal.rate_pct}%)`);
  console.log(`anchor ${numbers.anchor_mirror.anchor_pct}% vs mirror ${numbers.anchor_mirror.mirror_pct}%, gap ${numbers.anchor_mirror.gap_points}pt (raw-fraction rounding)`);
  console.log(`wrote numbers.json, leaderboard.tex, patterns.tex, directional.dat, anchor-mirror.dat to ${args.out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
